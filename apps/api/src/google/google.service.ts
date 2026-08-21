import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import {
  AppConfig,
  normalizePublicUrl,
  requestPublicOrigin,
} from "../core/config.js";
import type { Request } from "express";
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

  async getConfig(req?: Request) {
    const [apps, configuredPublicUrl, effectivePublicUrl] = await Promise.all([
      this.prisma.googleAppConfig.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          _count: {
            select: {
              mailboxes: { where: { status: { not: "REMOVED" } } },
            },
          },
        },
      }),
      this.configuredPublicUrl(),
      this.publicUrl(req),
    ]);
    const first = apps[0];
    return {
      configured: apps.length > 0,
      apps: apps.map((app) => this.appView(app)),
      clientId: first?.clientId ?? "",
      hasClientSecret: Boolean(first?.clientSecretEncrypted),
      // 显式配置值，留空代表按访问地址自动推导。
      publicUrl: configuredPublicUrl,
      publicUrlAutoDetected:
        !configuredPublicUrl && Boolean(effectivePublicUrl),
      callbackUrl: `${effectivePublicUrl || "https://your-domain.example"}/api/v1/google/oauth/callback`,
      scopes: GOOGLE_OAUTH_SCOPES,
    };
  }

  async createApp(input: {
    name: string;
    clientId: string;
    clientSecret?: string;
  }) {
    if (!input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "新增 Google 应用必须填写 Client Secret",
        400,
      );
    const row = await this.prisma.googleAppConfig.create({
      data: {
        name: this.appName(input.name),
        clientId: input.clientId.trim(),
        clientSecretEncrypted: await this.crypto.encryptString(
          input.clientSecret,
          "google-client-secret",
        ),
      },
      include: { _count: { select: { mailboxes: true } } },
    });
    return this.appView(row);
  }

  async updateApp(
    id: string,
    input: { name: string; clientId: string; clientSecret?: string },
  ) {
    const existing = await this.prisma.googleAppConfig.findUnique({
      where: { id },
    });
    if (!existing)
      throw new AppError(
        "GOOGLE_APP_NOT_FOUND",
        "Google 应用不存在或已删除",
        404,
      );
    const clientId = input.clientId.trim();
    const clientChanged = existing.clientId !== clientId;
    if (clientChanged && !input.clientSecret)
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
      : existing.clientSecretEncrypted;
    const data = {
      name: this.appName(input.name),
      clientId,
      clientSecretEncrypted: encrypted,
    };
    const saved = clientChanged
      ? await this.prisma.$transaction(async (tx) => {
          const row = await tx.googleAppConfig.update({ where: { id }, data });
          await tx.mailbox.updateMany({
            where: { googleAppConfigId: id, status: { not: "REMOVED" } },
            data: {
              status: "AUTH_REQUIRED",
              lastErrorCode: "CLIENT_ID_CHANGED",
              lastErrorMessage:
                "所选 Google 应用的 Client ID 已更改，需要重新授权邮箱",
            },
          });
          await tx.autoReplyTask.updateMany({
            where: {
              status: { in: ["RUNNING", "INITIALIZING"] },
              mailbox: { googleAppConfigId: id },
            },
            data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
          });
          await tx.$executeRaw`
            DELETE FROM "TransactionalOutbox" AS outbox
            USING "MessageReceipt" AS receipt, "Mailbox" AS mailbox
            WHERE outbox."aggregateId" = receipt."id"
              AND receipt."mailboxId" = mailbox."id"
              AND mailbox."googleAppConfigId" = ${id}
              AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
          `;
          return row;
        })
      : await this.prisma.googleAppConfig.update({ where: { id }, data });
    if (clientChanged) {
      const affected = await this.prisma.mailbox.findMany({
        where: { googleAppConfigId: id, status: "AUTH_REQUIRED" },
        select: { id: true },
      });
      for (const mailbox of affected)
        await this.alerts.open({
          fingerprint: `mailbox-auth:${mailbox.id}`,
          type: "MAILBOX_AUTH_REQUIRED",
          severity: "CRITICAL",
          title: "邮箱需要重新授权",
          message: "Google Client ID 已更改，自动回复已暂停。",
          metadata: {
            mailboxId: mailbox.id,
            appConfigId: id,
            code: "CLIENT_ID_CHANGED",
          },
        });
    }
    let refreshAttempted = 0;
    let refreshFailed = 0;
    if (input.clientSecret && !clientChanged) {
      const mailboxes = await this.prisma.mailbox.findMany({
        where: {
          googleAppConfigId: id,
          provider: "GOOGLE",
          status: "CONNECTED",
        },
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
      ...this.appView(saved),
      clientChanged,
      refreshAttempted,
      refreshFailed,
    };
  }

  async deleteApp(id: string): Promise<{ name: string }> {
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            mailboxes: { where: { status: { not: "REMOVED" } } },
          },
        },
      },
    });
    if (!app)
      throw new AppError(
        "GOOGLE_APP_NOT_FOUND",
        "Google 应用不存在或已删除",
        404,
      );
    if (app._count.mailboxes)
      throw new AppError(
        "GOOGLE_APP_IN_USE",
        "仍有邮箱使用此 Google 应用，请先移除邮箱或改用其他应用重新授权",
        409,
        { mailboxes: app._count.mailboxes },
      );
    await this.prisma.$transaction([
      this.prisma.mailbox.updateMany({
        where: { googleAppConfigId: id, status: "REMOVED" },
        data: { googleAppConfigId: null },
      }),
      this.prisma.oAuthState.deleteMany({ where: { googleAppConfigId: id } }),
      this.prisma.googleAppConfig.delete({ where: { id } }),
    ]);
    return { name: app.name };
  }

  async saveConfig(input: { clientId: string; clientSecret?: string }) {
    const existing = await this.prisma.googleAppConfig.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return existing
      ? this.updateApp(existing.id, { ...input, name: existing.name })
      : this.createApp({ ...input, name: "默认 Google / Gmail 应用" });
  }

  async startOAuth(
    appConfigId: string,
    redirectAfter = "/mailboxes",
    req?: Request,
  ): Promise<{ authorizationUrl: string }> {
    const publicUrl = await this.publicUrl(req);
    if (!publicUrl || !publicUrl.startsWith("https://"))
      throw new AppError(
        "PUBLIC_URL_REQUIRED",
        "连接 Gmail 需要 HTTPS 公开地址。请通过 HTTPS 域名打开后台后重试，或在设置中手工填写公开地址。",
        409,
      );
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id: appConfigId },
    });
    if (!app)
      throw new AppError(
        "GOOGLE_APP_NOT_FOUND",
        "所选 Google 应用不存在，请重新选择",
        404,
      );
    const rawState = this.crypto.randomToken(32);
    const verifier = this.crypto.randomToken(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const id = randomUUID();
    await this.prisma.oAuthState.create({
      data: {
        id,
        provider: "GOOGLE",
        microsoftAppConfigId: null,
        googleAppConfigId: app.id,
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
    req?: Request,
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
    const publicUrl = await this.publicUrl(req);
    const verifier = await this.crypto.decryptString(
      state.verifierEncrypted,
      `oauth:${id}`,
    );
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id: state.googleAppConfigId || "singleton" },
    });
    if (!app)
      throw new AppError(
        "GOOGLE_APP_NOT_FOUND",
        "授权使用的 Google 应用已被删除，请重新连接",
        409,
      );
    const token = await this.gmail.exchangeAuthorizationCode(
      code,
      verifier,
      `${publicUrl}/api/v1/google/oauth/callback`,
      app.id,
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
    if (
      existing &&
      existing.provider !== "GOOGLE" &&
      existing.status !== "REMOVED"
    )
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
        microsoftAppConfigId: null,
        googleAppConfigId: app.id,
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
        microsoftAuthMode: "MSAL_OAUTH",
        microsoftClientId: null,
        microsoftAppConfigId: null,
        googleAppConfigId: app.id,
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
    await this.alerts
      .resolve(`mailbox-auth:${mailbox.id}`)
      .catch(() => undefined);
    return {
      redirectTo: state.redirectAfter || "/mailboxes",
      mailboxId: mailbox.id,
    };
  }

  private appName(value: string): string {
    const name = value.trim();
    if (!name)
      throw new AppError(
        "GOOGLE_APP_NAME_REQUIRED",
        "Google 应用名称不能为空",
        400,
      );
    return name;
  }

  private appView(app: {
    id: string;
    name: string;
    clientId: string;
    clientSecretEncrypted: string;
    createdAt: Date;
    updatedAt: Date;
    _count?: { mailboxes: number };
  }) {
    return {
      id: app.id,
      name: app.name,
      clientId: app.clientId,
      hasClientSecret: Boolean(app.clientSecretEncrypted),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      mailboxCount: app._count?.mailboxes ?? 0,
    };
  }

  // 管理员显式配置的公开地址，没有配置时为空字符串。设置页用它回填输入框，
  // 留空即代表交给自动推导，不能用推导结果回填，否则一次保存就会把自动模式
  // 固化成硬编码地址。
  private async configuredPublicUrl(): Promise<string> {
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
      // 显式配置留下了无效值时不要卡死连接流程，继续按当前请求推导。
      return "";
    }
  }

  async publicUrl(req?: Request): Promise<string> {
    const configured = await this.configuredPublicUrl();
    if (configured) return configured;
    return req ? requestPublicOrigin(req) : "";
  }
}
