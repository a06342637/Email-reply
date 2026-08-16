import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../core/prisma.js";
import { AppError } from "../core/http.js";
import { TemplateService } from "./template.service.js";
import { MailProviderService } from "../providers/mail-provider.service.js";
import type { TemplateVariables } from "@autoreply/shared";
import { AppConfig } from "../core/config.js";
import { SmtpConfigService } from "../smtp/smtp-config.service.js";
import { SmtpDeliveryService } from "../smtp/smtp-delivery.service.js";

@Injectable()
export class TestMailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplateService,
    private readonly transport: MailProviderService,
    private readonly config: AppConfig,
    private readonly smtpConfigs: SmtpConfigService,
    private readonly smtp: SmtpDeliveryService,
  ) {}

  async send(
    templateId: string,
    input: {
      mailboxId?: string;
      smtpConfigId?: string;
      recipient: string;
      custom?: Record<string, unknown>;
    },
  ) {
    const { mailboxId, smtpConfigId, recipient, custom } = input;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
      throw new AppError("EMAIL_INVALID", "测试收件地址无效", 400);
    if (Boolean(mailboxId) === Boolean(smtpConfigId))
      throw new AppError(
        "TEST_SEND_CHANNEL_INVALID",
        "请选择一个邮箱 API 或 SMTP 配置作为测试发件通道",
        400,
      );
    const template = await this.prisma.replyTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });
    if (!template.publishedRevisionId)
      throw new AppError("TEMPLATE_NOT_PUBLISHED", "请先发布模板", 409);
    const mailbox = mailboxId
      ? await this.prisma.mailbox.findUniqueOrThrow({
          where: { id: mailboxId },
        })
      : null;
    const smtpConfig = smtpConfigId
      ? await this.smtpConfigs.resolve(smtpConfigId)
      : null;
    if (mailbox && mailbox.status !== "CONNECTED")
      throw new AppError("MAILBOX_NOT_CONNECTED", "所选邮箱未连接", 409);
    const now = new Date();
    const timeZone = await this.timezone();
    const base: TemplateVariables = {
      sender: { name: "测试发件人", email: "sender@example.com" },
      mailbox: {
        name: mailbox?.displayName || smtpConfig?.fromName || smtpConfig!.name,
        email: mailbox?.email || smtpConfig!.fromEmail,
      },
      message: {
        subject: "这是一封模板测试邮件",
        received_at: now.toISOString(),
        folder: "inbox",
      },
      rule: { name: "模板测试" },
      system: {
        current_date: now.toLocaleDateString("zh-CN", {
          timeZone,
        }),
        current_time: now.toLocaleTimeString("zh-CN", {
          timeZone,
        }),
        current_datetime: now.toLocaleString("zh-CN", {
          timeZone,
        }),
      },
    };
    const variables = this.deepMerge(
      base as unknown as Record<string, unknown>,
      custom ?? {},
    ) as unknown as TemplateVariables;
    const rendered = await this.templates.render(
      template.publishedRevisionId,
      variables,
    );
    const trackingId = `test-${randomUUID()}`;
    const instanceId = await this.instanceId();
    if (smtpConfigId) {
      const result = await this.smtp.sendReply({
        smtpConfigId,
        recipient,
        replyToFallback: smtpConfig!.replyToEmail || smtpConfig!.fromEmail,
        subject: `[自动回复模板测试] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
        assets: rendered.assets,
        trackingId,
        instanceId,
      });
      return {
        ...result,
        trackingId,
        channel: "SMTP",
        warnings: rendered.warnings,
      };
    }
    const draft = await this.transport.createTestDraft({
      mailboxId: mailboxId!,
      mailboxEmail: mailbox!.email,
      recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      assets: rendered.assets,
      trackingId,
      instanceId,
    });
    await this.transport.uploadAssets(mailboxId!, draft.id, rendered.assets);
    await this.transport.sendDraft(mailboxId!, draft.id);
    return {
      accepted: true,
      trackingId,
      channel: "MAILBOX_API",
      warnings: rendered.warnings,
    };
  }

  private async instanceId(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "instanceId" },
    });
    return typeof setting?.value === "string"
      ? setting.value
      : "autoreply-instance";
  }

  private async timezone(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "timezone" },
      select: { value: true },
    });
    const value =
      typeof setting?.value === "string" ? setting.value : this.config.timezone;
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format();
      return value;
    } catch {
      return this.config.timezone;
    }
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = structuredClone(target);
    for (const [key, value] of Object.entries(source)) {
      if (
        !Object.prototype.hasOwnProperty.call(result, key) ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        continue;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === "object"
      ) {
        result[key] = this.deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else result[key] = value;
    }
    return result;
  }
}
