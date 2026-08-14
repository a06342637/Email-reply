import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { ResponseMode } from "@azure/msal-node";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppConfig, normalizePublicUrl } from "../core/config.js";
import { AppError } from "../core/http.js";
import {
  GraphError,
  GraphService,
  GRAPH_SCOPES,
  type MicrosoftRefreshTokenCache,
} from "./graph.service.js";
import { AlertService } from "../observability/alert.service.js";

const OAUTH_SCOPES = ["openid", "profile", "offline_access", ...GRAPH_SCOPES];

@Injectable()
export class MicrosoftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
    private readonly graph: GraphService,
    private readonly alerts: AlertService,
  ) {}

  async getConfig() {
    const app = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: "singleton" },
    });
    return {
      configured: Boolean(app),
      clientId: app?.clientId ?? "",
      hasClientSecret: Boolean(app?.clientSecretEncrypted),
      secretExpiresAt: app?.secretExpiresAt,
      publicUrl: await this.publicUrl(),
      callbackUrl: `${(await this.publicUrl()) || "https://your-domain.example"}/api/v1/microsoft/oauth/callback`,
      scopes: OAUTH_SCOPES,
    };
  }

  async saveConfig(input: {
    clientId: string;
    clientSecret?: string;
    secretExpiresAt?: string | null;
  }) {
    const clientId = input.clientId.trim();
    const existing = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!existing && !input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "首次配置必须填写 Client Secret",
        400,
      );
    if (existing && existing.clientId !== clientId && !input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "更换 Client ID 时必须同时填写对应的 Client Secret",
        400,
      );
    const encrypted = input.clientSecret
      ? await this.crypto.encryptString(
          input.clientSecret,
          "microsoft-client-secret",
        )
      : existing!.clientSecretEncrypted;
    const clientChanged = Boolean(existing && existing.clientId !== clientId);
    const configWrite = {
      where: { id: "singleton" },
      create: {
        id: "singleton",
        clientId,
        clientSecretEncrypted: encrypted,
        secretExpiresAt: input.secretExpiresAt
          ? new Date(input.secretExpiresAt)
          : null,
      },
      update: {
        clientId,
        clientSecretEncrypted: encrypted,
        secretExpiresAt: input.secretExpiresAt
          ? new Date(input.secretExpiresAt)
          : null,
      },
    };
    const saved = clientChanged
      ? await this.prisma.$transaction(async (tx) => {
          const row = await tx.microsoftAppConfig.upsert(configWrite);
          await tx.mailbox.updateMany({
            where: {
              provider: "MICROSOFT",
              microsoftAuthMode: "MSAL_OAUTH",
              status: { not: "REMOVED" },
            },
            data: {
              status: "AUTH_REQUIRED",
              lastErrorCode: "CLIENT_ID_CHANGED",
              lastErrorMessage: "Microsoft Client ID 已更改，需要重新授权邮箱",
            },
          });
          await tx.autoReplyTask.updateMany({
            where: {
              status: { in: ["RUNNING", "INITIALIZING"] },
              mailbox: {
                provider: "MICROSOFT",
                microsoftAuthMode: "MSAL_OAUTH",
              },
            },
            data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
          });
          await tx.$executeRaw`
            DELETE FROM "TransactionalOutbox" AS outbox
            USING "MessageReceipt" AS receipt, "Mailbox" AS mailbox
            WHERE outbox."aggregateId" = receipt."id"
              AND receipt."mailboxId" = mailbox."id"
              AND mailbox."provider" = 'MICROSOFT'::"MailProvider"
              AND mailbox."microsoftAuthMode" = 'MSAL_OAUTH'::"MicrosoftAuthMode"
              AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
          `;
          return row;
        })
      : await this.prisma.microsoftAppConfig.upsert(configWrite);
    if (clientChanged) {
      const affected = await this.prisma.mailbox.findMany({
        where: {
          provider: "MICROSOFT",
          microsoftAuthMode: "MSAL_OAUTH",
          status: "AUTH_REQUIRED",
        },
        select: { id: true },
      });
      for (const mailbox of affected)
        await this.alerts.open({
          fingerprint: `mailbox-auth:${mailbox.id}`,
          type: "MAILBOX_AUTH_REQUIRED",
          severity: "CRITICAL",
          title: "邮箱需要重新授权",
          message: "Microsoft Client ID 已更改，自动回复已暂停。",
          metadata: { mailboxId: mailbox.id, code: "CLIENT_ID_CHANGED" },
        });
    }
    let refreshAttempted = 0;
    let refreshFailed = 0;
    if (existing && input.clientSecret && !clientChanged) {
      const mailboxes = await this.prisma.mailbox.findMany({
        where: {
          provider: "MICROSOFT",
          microsoftAuthMode: "MSAL_OAUTH",
          status: "CONNECTED",
        },
        select: { id: true },
      });
      refreshAttempted = mailboxes.length;
      for (const mailbox of mailboxes) {
        try {
          await this.graph.accessToken(mailbox.id, true);
        } catch {
          refreshFailed += 1;
        }
      }
    }
    return {
      clientId: saved.clientId,
      secretExpiresAt: saved.secretExpiresAt,
      clientChanged,
      refreshAttempted,
      refreshFailed,
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

  async startOAuth(
    redirectAfter = "/mailboxes",
  ): Promise<{ authorizationUrl: string }> {
    const publicUrl = await this.publicUrl();
    if (!publicUrl || !publicUrl.startsWith("https://")) {
      throw new AppError(
        "PUBLIC_URL_REQUIRED",
        "连接 Microsoft 前必须配置 HTTPS 公开地址",
        409,
      );
    }
    const app = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!app)
      throw new AppError(
        "MICROSOFT_NOT_CONFIGURED",
        "请先配置 Microsoft Client ID 和 Client Secret",
        409,
      );
    const rawState = this.crypto.randomToken(32);
    const verifier = this.crypto.randomToken(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const id = randomUUID();
    await this.prisma.oAuthState.create({
      data: {
        id,
        provider: "MICROSOFT",
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
    const cca = await this.graph.createClient(
      app.clientId,
      app.clientSecretEncrypted,
    );
    const authorizationUrl = await cca.getAuthCodeUrl({
      scopes: OAUTH_SCOPES,
      redirectUri: `${publicUrl}/api/v1/microsoft/oauth/callback`,
      responseMode: ResponseMode.QUERY,
      state: `${id}.${rawState}`,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      prompt: "select_account",
    });
    return { authorizationUrl };
  }

  async finishOAuth(
    code: string,
    combinedState: string,
  ): Promise<{ redirectTo: string; mailboxId: string }> {
    const separator = combinedState.indexOf(".");
    if (separator < 1)
      throw new AppError("OAUTH_STATE_INVALID", "Microsoft 授权状态无效", 400);
    const id = combinedState.slice(0, separator);
    const rawState = combinedState.slice(separator + 1);
    const state = await this.prisma.oAuthState.findUnique({ where: { id } });
    if (
      !state ||
      state.provider !== "MICROSOFT" ||
      state.expiresAt < new Date() ||
      !this.crypto.safeEqual(state.stateHash, this.crypto.hmac(rawState))
    ) {
      throw new AppError(
        "OAUTH_STATE_INVALID",
        "Microsoft 授权已过期，请重新连接",
        400,
      );
    }
    const app = await this.prisma.microsoftAppConfig.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    const publicUrl = await this.publicUrl();
    const verifier = await this.crypto.decryptString(
      state.verifierEncrypted,
      `oauth:${id}`,
    );
    const cca = await this.graph.createClient(
      app.clientId,
      app.clientSecretEncrypted,
    );
    const result = await cca.acquireTokenByCode({
      code,
      codeVerifier: verifier,
      scopes: OAUTH_SCOPES,
      redirectUri: `${publicUrl}/api/v1/microsoft/oauth/callback`,
    });
    if (!result?.account || !result.accessToken)
      throw new AppError(
        "OAUTH_TOKEN_FAILED",
        "Microsoft 未返回有效账户授权",
        502,
      );
    const profile = await this.graph.profile(result.accessToken);
    await this.graph.validateMailboxReadAccess(result.accessToken);
    const email = (
      profile.mail ||
      profile.userPrincipalName ||
      result.account.username
    )
      .trim()
      .toLowerCase();
    if (!email.includes("@"))
      throw new AppError(
        "MAILBOX_ADDRESS_MISSING",
        "Microsoft 账户没有可用的邮箱地址",
        409,
      );
    const serializedCache = cca.getTokenCache().serialize();
    const existing = await this.prisma.mailbox.findUnique({ where: { email } });
    if (
      existing &&
      existing.provider !== "MICROSOFT" &&
      existing.status !== "REMOVED"
    )
      throw new AppError(
        "MAILBOX_PROVIDER_CONFLICT",
        "该邮箱地址已经通过 Gmail 提供商连接，不能重复连接",
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
    const encryptedCache = await this.crypto.encryptString(
      serializedCache,
      `msal:${mailboxId}`,
    );
    const mailbox = await this.prisma.mailbox.upsert({
      where: { email },
      create: {
        id: mailboxId,
        email,
        provider: "MICROSOFT",
        microsoftAuthMode: "MSAL_OAUTH",
        microsoftClientId: null,
        displayName: profile.displayName || result.account.name || email,
        tenantId: result.account.tenantId,
        accountType:
          result.account.tenantId &&
          result.account.tenantId !== "9188040d-6c67-4c5b-b112-36a304b66dad"
            ? "MICROSOFT_365"
            : "PERSONAL",
        homeAccountId: result.account.homeAccountId,
        tokenCacheEncrypted: encryptedCache,
        status: "CONNECTED",
        lastTokenRefreshAt: new Date(),
      },
      update: {
        provider: "MICROSOFT",
        microsoftAuthMode: "MSAL_OAUTH",
        microsoftClientId: null,
        displayName: profile.displayName || result.account.name || email,
        tenantId: result.account.tenantId,
        accountType:
          result.account.tenantId &&
          result.account.tenantId !== "9188040d-6c67-4c5b-b112-36a304b66dad"
            ? "MICROSOFT_365"
            : "PERSONAL",
        homeAccountId: result.account.homeAccountId,
        tokenCacheEncrypted: encryptedCache,
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

  async importRefreshToken(input: {
    clientId: string;
    refreshToken: string;
  }): Promise<{
    mailboxId: string;
    email: string;
    displayName: string;
    authMode: "CLIENT_ID_REFRESH_TOKEN";
  }> {
    const clientId = input.clientId.trim();
    const refreshToken = input.refreshToken.trim();
    let token: MicrosoftRefreshTokenCache;
    try {
      token = await this.graph.exchangeImportedRefreshToken(
        clientId,
        refreshToken,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof GraphError) {
        if (
          [400, 401].includes(error.status) &&
          /invalid_grant|invalid_client|unauthorized_client|interaction_required|consent_required/i.test(
            `${error.code} ${error.message}`,
          )
        )
          throw new AppError(
            "MICROSOFT_REFRESH_TOKEN_INVALID",
            "Refresh Token 无效、已撤销、不属于该 Client ID，或此应用不允许无 Client Secret 刷新",
            400,
          );
        if (error.status === 429)
          throw new AppError(
            "MICROSOFT_TOKEN_RATE_LIMITED",
            "Microsoft 暂时限制了令牌验证，请稍后重试",
            429,
            { retryAfterSeconds: error.retryAfterSeconds },
          );
      }
      throw new AppError(
        "MICROSOFT_REFRESH_TOKEN_VERIFY_FAILED",
        "暂时无法向 Microsoft 验证 Refresh Token，请稍后重试",
        502,
      );
    }

    const accessToken = token.accessToken;
    if (!accessToken)
      throw new AppError(
        "MICROSOFT_TOKEN_EMPTY",
        "Microsoft 未返回有效访问令牌",
        502,
      );
    const profile = await this.graph.profile(accessToken);
    await this.graph.validateMailboxReadAccess(accessToken);
    const email = (profile.mail || profile.userPrincipalName || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@"))
      throw new AppError(
        "MAILBOX_ADDRESS_MISSING",
        "Microsoft 账户没有可用的邮箱地址",
        409,
      );
    const existing = await this.prisma.mailbox.findUnique({ where: { email } });
    if (
      existing &&
      existing.provider !== "MICROSOFT" &&
      existing.status !== "REMOVED"
    )
      throw new AppError(
        "MAILBOX_PROVIDER_CONFLICT",
        "该邮箱地址已经通过 Gmail 提供商连接，不能重复连接",
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
    const identity = this.graph.tokenIdentity(accessToken);
    const accountType = identity.tenantId
      ? identity.tenantId === "9188040d-6c67-4c5b-b112-36a304b66dad"
        ? "PERSONAL"
        : "MICROSOFT_365"
      : "UNKNOWN";
    const encryptedCache = await this.crypto.encryptString(
      JSON.stringify(token),
      `msal:${mailboxId}`,
    );
    const mailbox = await this.prisma.mailbox.upsert({
      where: { email },
      create: {
        id: mailboxId,
        email,
        provider: "MICROSOFT",
        microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
        microsoftClientId: clientId,
        displayName: profile.displayName || email,
        tenantId: identity.tenantId,
        accountType,
        homeAccountId: `refresh:${identity.objectId || profile.id}`,
        tokenCacheEncrypted: encryptedCache,
        status: "CONNECTED",
        lastTokenRefreshAt: new Date(),
      },
      update: {
        provider: "MICROSOFT",
        microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
        microsoftClientId: clientId,
        displayName: profile.displayName || email,
        tenantId: identity.tenantId,
        accountType,
        homeAccountId: `refresh:${identity.objectId || profile.id}`,
        tokenCacheEncrypted: encryptedCache,
        status: "CONNECTED",
        lastTokenRefreshAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await this.alerts
      .resolve(`mailbox-auth:${mailbox.id}`)
      .catch(() => undefined);
    return {
      mailboxId: mailbox.id,
      email: mailbox.email,
      displayName: mailbox.displayName,
      authMode: "CLIENT_ID_REFRESH_TOKEN",
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
