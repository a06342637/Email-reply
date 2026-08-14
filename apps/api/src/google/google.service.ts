import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppConfig, normalizePublicUrl } from "../core/config.js";
import { AppError } from "../core/http.js";
import { AlertService } from "../observability/alert.service.js";
import { GMAIL_REQUIRED_SCOPES, GmailApiService } from "./gmail-api.service.js";

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  ...GMAIL_REQUIRED_SCOPES,
];

@Injectable()
export class GoogleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
    private readonly gmail: GmailApiService,
    private readonly alerts: AlertService,
  ) {}

  async getConfig() {
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id: "singleton" },
    });
    const publicUrl = await this.publicUrl();
    return {
      configured: Boolean(app),
      clientId: app?.clientId ?? "",
      hasClientSecret: Boolean(app?.clientSecretEncrypted),
      publicUrl,
      callbackUrl: `${publicUrl || "https://your-domain.example"}/api/v1/google/oauth/callback`,
      scopes: GOOGLE_OAUTH_SCOPES,
    };
  }

  async saveConfig(input: { clientId: string; clientSecret?: string }) {
    const clientId = input.clientId.trim();
    const existing = await this.prisma.googleAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!existing && !input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "首次配置必须填写 Google Client Secret",
        400,
      );
    if (existing && existing.clientId !== clientId && !input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "更换 Google Client ID 时必须同时填写对应的 Client Secret",
        400,
      );
    const encrypted = input.clientSecret
      ? await this.crypto.encryptString(
          input.clientSecret,
          "google-client-secret",
        )
      : existing!.clientSecretEncrypted;
    const clientChanged = Boolean(existing && existing.clientId !== clientId);
    const write = {
      where: { id: "singleton" },
      create: {
        id: "singleton",
        clientId,
        clientSecretEncrypted: encrypted,
      },
      update: { clientId, clientSecretEncrypted: encrypted },
    };
    const saved = clientChanged
      ? await this.prisma.$transaction(async (tx) => {
          const row = await tx.googleAppConfig.upsert(write);
          await tx.mailbox.updateMany({
            where: { provider: "GOOGLE", status: { not: "REMOVED" } },
            data: {
              status: "AUTH_REQUIRED",
              lastErrorCode: "CLIENT_ID_CHANGED",
              lastErrorMessage: "Google Client ID 已更改，需要重新授权邮箱",
            },
          });
          await tx.autoReplyTask.updateMany({
            where: {
              status: { in: ["RUNNING", "INITIALIZING"] },
              mailbox: { provider: "GOOGLE" },
            },
            data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
          });
          await tx.$executeRaw`
            DELETE FROM "TransactionalOutbox" AS outbox
            USING "MessageReceipt" AS receipt, "Mailbox" AS mailbox
            WHERE outbox."aggregateId" = receipt."id"
              AND receipt."mailboxId" = mailbox."id"
              AND mailbox."provider" = 'GOOGLE'::"MailProvider"
              AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
          `;
          return row;
        })
      : await this.prisma.googleAppConfig.upsert(write);

    if (clientChanged) {
      const affected = await this.prisma.mailbox.findMany({
        where: { provider: "GOOGLE", status: "AUTH_REQUIRED" },
        select: { id: true },
      });
      for (const mailbox of affected)
        await this.alerts.open({
          fingerprint: `mailbox-auth:${mailbox.id}`,
          type: "MAILBOX_AUTH_REQUIRED",
          severity: "CRITICAL",
          title: "邮箱需要重新授权",
          message: "Google Client ID 已更改，自动回复已暂停。",
          metadata: { mailboxId: mailbox.id, code: "CLIENT_ID_CHANGED" },
        });
    }

    let refreshAttempted = 0;
    let refreshFailed = 0;
    if (existing && input.clientSecret && !clientChanged) {
      const mailboxes = await this.prisma.mailbox.findMany({
        where: { provider: "GOOGLE", status: "CONNECTED" },
        select: { id: true },
      });
      refreshAttempted = mailboxes.length;
      for (const mailbox of mailboxes) {
        try {
          await this.gmail.accessToken(mailbox.id, true);
        } catch {
          refreshFailed += 1;
        }
      }
    }
    return {
      clientId: saved.clientId,
      clientChanged,
      refreshAttempted,
      refreshFailed,
    };
  }

  async startOAuth(
    redirectAfter = "/mailboxes",
  ): Promise<{ authorizationUrl: string }> {
    const publicUrl = await this.publicUrl();
    if (!publicUrl || !publicUrl.startsWith("https://"))
      throw new AppError(
        "PUBLIC_URL_REQUIRED",
        "连接 Gmail 前必须配置 HTTPS 公开地址",
        409,
      );
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!app)
      throw new AppError(
        "GOOGLE_NOT_CONFIGURED",
        "请先配置 Google Client ID 和 Client Secret",
        409,
      );
    const rawState = this.crypto.randomToken(32);
    const verifier = this.crypto.randomToken(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const id = randomUUID();
    await this.prisma.oAuthState.create({
      data: {
        id,
        provider: "GOOGLE",
        stateHash: this.crypto.hmac(rawState),
        verifierEncrypted: await this.crypto.encryptString(
          verifier,
          `oauth:${id}`,
        ),
        redirectAfter: /^\/(?!\/)/.test(redirectAfter)
          ? redirectAfter
          : "/mailboxes",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: `${publicUrl}/api/v1/google/oauth/callback`,
      response_type: "code",
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: `${id}.${rawState}`,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    };
  }

  async setPublicUrl(value: string): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizePublicUrl(value);
    } catch {
      throw new AppError(
        "PUBLIC_URL_INVALID",
        "公开地址必须是纯 HTTPS 域名，不能包含路径、查询参数或账号信息",
        400,
      );
    }
    await this.prisma.systemSetting.upsert({
      where: { key: "publicUrl" },
      create: { key: "publicUrl", value: normalized },
      update: { value: normalized },
    });
  }

  async finishOAuth(
    code: string,
    combinedState: string,
  ): Promise<{ redirectTo: string; mailboxId: string }> {
    const separator = combinedState.indexOf(".");
    if (separator < 1)
      throw new AppError("OAUTH_STATE_INVALID", "Google 授权状态无效", 400);
    const id = combinedState.slice(0, separator);
    const rawState = combinedState.slice(separator + 1);
    const state = await this.prisma.oAuthState.findUnique({ where: { id } });
    if (
      !state ||
      state.provider !== "GOOGLE" ||
      state.expiresAt < new Date() ||
      !this.crypto.safeEqual(state.stateHash, this.crypto.hmac(rawState))
    )
      throw new AppError(
        "OAUTH_STATE_INVALID",
        "Google 授权已过期，请重新连接",
        400,
      );
    const publicUrl = await this.publicUrl();
    const verifier = await this.crypto.decryptString(
      state.verifierEncrypted,
      `oauth:${id}`,
    );
    const token = await this.gmail.exchangeAuthorizationCode(
      code,
      verifier,
      `${publicUrl}/api/v1/google/oauth/callback`,
    );
    const [profile, user] = await Promise.all([
      this.gmail.gmailProfile(token.accessToken!),
      this.gmail.userInfo(token.accessToken!),
    ]);
    const email = (profile.emailAddress || user.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@"))
      throw new AppError(
        "MAILBOX_ADDRESS_MISSING",
        "Google 账户没有可用的 Gmail 邮箱地址",
        409,
      );
    const existing = await this.prisma.mailbox.findUnique({ where: { email } });
    if (existing && existing.provider !== "GOOGLE")
      throw new AppError(
        "MAILBOX_PROVIDER_CONFLICT",
        "该邮箱地址已经通过 Microsoft 提供商连接，不能重复连接",
        409,
      );
    if (!existing || existing.status === "REMOVED") {
      const activeCount = await this.prisma.mailbox.count({
        where: { status: { not: "REMOVED" } },
      });
      if (activeCount >= 10)
        throw new AppError(
          "MAILBOX_LIMIT_REACHED",
          "当前版本最多连接 10 个邮箱，请先移除不再使用的邮箱",
          409,
        );
    }
    const mailboxId = existing?.id ?? randomUUID();
    const accountType = /@(gmail\.com|googlemail\.com)$/i.test(email)
      ? "GMAIL_PERSONAL"
      : "GOOGLE_WORKSPACE";
    const encryptedToken = await this.crypto.encryptString(
      JSON.stringify(token),
      `google-token:${mailboxId}`,
    );
    const mailbox = await this.prisma.mailbox.upsert({
      where: { email },
      create: {
        id: mailboxId,
        email,
        provider: "GOOGLE",
        displayName: user.name || email,
        tenantId: null,
        accountType,
        homeAccountId: user.sub || email,
        tokenCacheEncrypted: encryptedToken,
        status: "CONNECTED",
        lastTokenRefreshAt: new Date(),
      },
      update: {
        provider: "GOOGLE",
        displayName: user.name || email,
        tenantId: null,
        accountType,
        homeAccountId: user.sub || email,
        tokenCacheEncrypted: encryptedToken,
        status: "CONNECTED",
        lastTokenRefreshAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await this.prisma.oAuthState.delete({ where: { id } });
    await this.alerts.resolve(`mailbox-auth:${mailbox.id}`);
    return {
      redirectTo: state.redirectAfter || "/mailboxes",
      mailboxId: mailbox.id,
    };
  }

  async publicUrl(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "publicUrl" },
    });
    const value =
      typeof setting?.value === "string"
        ? setting.value
        : this.config.publicUrl;
    try {
      return normalizePublicUrl(value);
    } catch {
      return "";
    }
  }
}
