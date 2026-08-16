import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { TemplateAsset } from "@prisma/client";
import { AppError } from "../core/http.js";
import {
  SmtpConfigService,
  type ResolvedSmtpConfig,
} from "./smtp-config.service.js";

export class SmtpDeliveryError extends AppError {
  constructor(
    code: string,
    message: string,
    status: number,
    readonly uncertain: boolean,
    details?: unknown,
  ) {
    super(code, message, status, details);
  }
}

type SendReplyInput = {
  smtpConfigId: string;
  recipient: string;
  replyToFallback: string;
  subject: string;
  html: string;
  text: string;
  assets: TemplateAsset[];
  sourceInternetMessageId?: string | null;
  trackingId: string;
  instanceId: string;
};

@Injectable()
export class SmtpDeliveryService {
  constructor(private readonly configs: SmtpConfigService) {}

  async verify(configId: string): Promise<{ verified: true }> {
    const config = await this.configs.resolve(configId);
    const transport = this.transport(config);
    try {
      await transport.verify();
      return { verified: true };
    } catch (error) {
      throw this.normalizeError(error, false);
    } finally {
      transport.close();
    }
  }

  async sendTest(configId: string, recipient: string) {
    const config = await this.configs.resolve(configId);
    const transport = this.transport(config);
    try {
      const info = await transport.sendMail({
        from: this.from(config),
        to: recipient,
        replyTo: config.replyToEmail || config.fromEmail,
        subject: "[MailPilot SMTP 测试] SMTP 配置验证",
        text: "这是一封 MailPilot SMTP 配置测试邮件。收到此邮件表示 SMTP 服务器已接受发送请求。",
        html: "<p>这是一封 <strong>MailPilot SMTP 配置测试邮件</strong>。</p><p>收到此邮件表示 SMTP 服务器已接受发送请求。</p>",
        headers: {
          "Auto-Submitted": "auto-generated",
          "X-Auto-Response-Suppress": "All",
          "X-MailPilot-SMTP-Test": "true",
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      this.assertAccepted(info, recipient);
      return { accepted: true, messageId: info.messageId };
    } catch (error) {
      if (error instanceof SmtpDeliveryError) throw error;
      throw this.normalizeError(error, false);
    } finally {
      transport.close();
    }
  }

  async sendReply(input: SendReplyInput) {
    const config = await this.configs.resolve(input.smtpConfigId);
    const transport = this.transport(config);
    const messageId = this.messageId(input.trackingId, config.fromEmail);
    try {
      const info = await transport.sendMail({
        from: this.from(config),
        to: input.recipient,
        replyTo: config.replyToEmail || input.replyToFallback,
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId,
        inReplyTo: input.sourceInternetMessageId || undefined,
        references: input.sourceInternetMessageId
          ? [input.sourceInternetMessageId]
          : undefined,
        headers: {
          "Auto-Submitted": "auto-replied",
          "X-Auto-Response-Suppress": "All",
          "X-AutoReply-Tracking": input.trackingId,
          "X-AutoReply-Instance": input.instanceId,
        },
        attachments: input.assets.map((asset) => ({
          filename: asset.fileName,
          content: Buffer.from(asset.data),
          contentType: asset.contentType,
          cid: asset.inline ? asset.contentId || undefined : undefined,
          contentDisposition: asset.inline ? "inline" : "attachment",
        })),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      this.assertAccepted(info, input.recipient);
      return { accepted: true, messageId: info.messageId || messageId };
    } catch (error) {
      if (error instanceof SmtpDeliveryError) throw error;
      throw this.normalizeError(error, true);
    } finally {
      transport.close();
    }
  }

  private transport(config: ResolvedSmtpConfig) {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === "TLS",
      requireTLS: config.security === "STARTTLS",
      auth: { user: config.username, pass: config.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  }

  private from(config: ResolvedSmtpConfig) {
    return config.fromName
      ? { name: config.fromName, address: config.fromEmail }
      : config.fromEmail;
  }

  private assertAccepted(
    info: SMTPTransport.SentMessageInfo,
    recipient: string,
  ): void {
    const accepted = (info.accepted ?? []).map(String);
    if (
      !accepted.some((value) => value.toLowerCase() === recipient.toLowerCase())
    )
      throw new SmtpDeliveryError(
        "SMTP_RECIPIENT_REJECTED",
        "SMTP 服务器没有接受目标收件地址",
        409,
        false,
        { rejected: (info.rejected ?? []).length },
      );
  }

  private normalizeError(error: unknown, sending: boolean): SmtpDeliveryError {
    const candidate = (error && typeof error === "object" ? error : {}) as {
      code?: unknown;
      command?: unknown;
      responseCode?: unknown;
      message?: unknown;
    };
    const code = String(candidate.code || "SMTP_ERROR");
    const command = String(candidate.command || "").toUpperCase();
    const responseCode = Number(candidate.responseCode || 0);
    const details = {
      command: command || undefined,
      responseCode: responseCode || undefined,
    };
    if (responseCode === 535 || /EAUTH|AUTH/i.test(`${code} ${command}`))
      return new SmtpDeliveryError(
        "SMTP_AUTH_FAILED",
        "SMTP 用户名、密码或应用专用密码验证失败",
        409,
        false,
        details,
      );
    if (/CERT|TLS|SSL/i.test(`${code} ${String(candidate.message || "")}`))
      return new SmtpDeliveryError(
        "SMTP_TLS_FAILED",
        "SMTP TLS 证书或加密握手失败，请检查主机名和 TLS 模式",
        409,
        false,
        details,
      );
    if (responseCode >= 500)
      return new SmtpDeliveryError(
        "SMTP_REJECTED",
        `SMTP 服务器拒绝发送（${responseCode}）`,
        409,
        false,
        details,
      );
    const networkInterrupted =
      /ETIMEDOUT|ECONNECTION|ECONNRESET|ESOCKET|EPIPE/i.test(code);
    const definitelyBeforeData =
      /^(?:CONN|CONNECT|EHLO|HELO|AUTH|MAIL FROM|RCPT TO)$/i.test(command);
    const uncertain =
      sending &&
      (command === "DATA" || (networkInterrupted && !definitelyBeforeData));
    if (uncertain)
      return new SmtpDeliveryError(
        "SMTP_SEND_STATUS_UNCERTAIN",
        "SMTP 连接在发送阶段中断，无法确认服务器是否已经接受邮件，系统不会自动重发",
        502,
        true,
        details,
      );
    return new SmtpDeliveryError(
      "SMTP_CONNECTION_FAILED",
      "无法连接或使用 SMTP 服务器，请检查主机、端口、TLS 模式和网络放行",
      502,
      false,
      details,
    );
  }

  private messageId(trackingId: string, fromEmail: string): string {
    const domain =
      fromEmail.split("@")[1]?.replace(/[^a-z0-9.-]/gi, "") ||
      "mailpilot.local";
    return `<mailpilot.${trackingId.replace(/[^a-z0-9-]/gi, "")}@${domain}>`;
  }
}
