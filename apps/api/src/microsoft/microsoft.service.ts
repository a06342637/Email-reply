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
const MICROSOFT_IMPORT_TOTAL_TIMEOUT_MS = 25_000;
const MICROSOFT_IMPORT_TOKEN_TIMEOUT_MS = 12_000;
const MICROSOFT_IMPORT_GRAPH_TIMEOUT_MS = 10_000;

type MicrosoftImportStage = "TOKEN_EXCHANGE" | "PROFILE" | "MAILBOX_ACCESS";

class MicrosoftImportStageError extends Error {
  constructor(
    readonly stage: MicrosoftImportStage,
    readonly originalError: unknown,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Microsoft import stage failed",
    );
    this.name = "MicrosoftImportStageError";
  }
}

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
    const [apps, publicUrl] = await Promise.all([
      this.prisma.microsoftAppConfig.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          _count: {
            select: {
              mailboxes: { where: { status: { not: "REMOVED" } } },
            },
          },
        },
      }),
      this.publicUrl(),
    ]);
    const first = apps[0];
    return {
      configured: apps.length > 0,
      apps: apps.map((app) => this.appView(app)),
      // Legacy fields keep an older cached admin page functional during an
      // online upgrade. New clients use the apps array exclusively.
      clientId: first?.clientId ?? "",
      hasClientSecret: Boolean(first?.clientSecretEncrypted),
      secretExpiresAt: first?.secretExpiresAt,
      publicUrl,
      callbackUrl: `${publicUrl || "https://your-domain.example"}/api/v1/microsoft/oauth/callback`,
      scopes: OAUTH_SCOPES,
    };
  }

  async createApp(input: {
    name: string;
    clientId: string;
    clientSecret?: string;
    secretExpiresAt?: string | null;
  }) {
    if (!input.clientSecret)
      throw new AppError(
        "CLIENT_SECRET_REQUIRED",
        "新增 Microsoft 应用必须填写 Client Secret",
        400,
      );
    const row = await this.prisma.microsoftAppConfig.create({
      data: {
        name: this.appName(input.name),
        clientId: input.clientId.trim(),
        clientSecretEncrypted: await this.crypto.encryptString(
          input.clientSecret,
          "microsoft-client-secret",
        ),
        secretExpiresAt: input.secretExpiresAt
          ? new Date(input.secretExpiresAt)
          : null,
      },
      include: { _count: { select: { mailboxes: true } } },
    });
    return this.appView(row);
  }

  async updateApp(
    id: string,
    input: {
      name: string;
      clientId: string;
      clientSecret?: string;
      secretExpiresAt?: string | null;
    },
  ) {
    const existing = await this.prisma.microsoftAppConfig.findUnique({
      where: { id },
    });
    if (!existing)
      throw new AppError(
        "MICROSOFT_APP_NOT_FOUND",
        "Microsoft 应用不存在或已删除",
        404,
      );
    const clientId = input.clientId.trim();
    const clientChanged = existing.clientId !== clientId;
    if (clientChanged && !input.clientSecret)
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
      : existing.clientSecretEncrypted;
    const data = {
      name: this.appName(input.name),
      clientId,
      clientSecretEncrypted: encrypted,
      secretExpiresAt: input.secretExpiresAt
        ? new Date(input.secretExpiresAt)
        : null,
    };
    const saved = clientChanged
      ? await this.prisma.$transaction(async (tx) => {
          const row = await tx.microsoftAppConfig.update({
            where: { id },
            data,
          });
          await tx.mailbox.updateMany({
            where: {
              microsoftAppConfigId: id,
              status: { not: "REMOVED" },
            },
            data: {
              status: "AUTH_REQUIRED",
              lastErrorCode: "CLIENT_ID_CHANGED",
              lastErrorMessage:
                "所选 Microsoft 应用的 Client ID 已更改，需要重新授权邮箱",
            },
          });
          await tx.autoReplyTask.updateMany({
            where: {
              status: { in: ["RUNNING", "INITIALIZING"] },
              mailbox: { microsoftAppConfigId: id },
            },
            data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
          });
          await tx.$executeRaw`
            DELETE FROM "TransactionalOutbox" AS outbox
            USING "MessageReceipt" AS receipt, "Mailbox" AS mailbox
            WHERE outbox."aggregateId" = receipt."id"
              AND receipt."mailboxId" = mailbox."id"
              AND mailbox."microsoftAppConfigId" = ${id}
              AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
          `;
          return row;
        })
      : await this.prisma.microsoftAppConfig.update({ where: { id }, data });
    if (clientChanged) {
      const affected = await this.prisma.mailbox.findMany({
        where: { microsoftAppConfigId: id, status: "AUTH_REQUIRED" },
        select: { id: true },
      });
      for (const mailbox of affected)
        await this.alerts.open({
          fingerprint: `mailbox-auth:${mailbox.id}`,
          type: "MAILBOX_AUTH_REQUIRED",
          severity: "CRITICAL",
          title: "邮箱需要重新授权",
          message: "Microsoft Client ID 已更改，自动回复已暂停。",
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
          microsoftAppConfigId: id,
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
      ...this.appView(saved),
      clientChanged,
      refreshAttempted,
      refreshFailed,
    };
  }

  async deleteApp(id: string): Promise<{ name: string }> {
    const app = await this.prisma.microsoftAppConfig.findUnique({
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
        "MICROSOFT_APP_NOT_FOUND",
        "Microsoft 应用不存在或已删除",
        404,
      );
    if (app._count.mailboxes)
      throw new AppError(
        "MICROSOFT_APP_IN_USE",
        "仍有邮箱使用此 Microsoft 应用，请先移除邮箱或改用其他应用重新授权",
        409,
        { mailboxes: app._count.mailboxes },
      );
    await this.prisma.$transaction([
      this.prisma.mailbox.updateMany({
        where: { microsoftAppConfigId: id, status: "REMOVED" },
        data: { microsoftAppConfigId: null },
      }),
      this.prisma.oAuthState.deleteMany({
        where: { microsoftAppConfigId: id },
      }),
      this.prisma.microsoftAppConfig.delete({ where: { id } }),
    ]);
    for (const suffix of ["30", "7", "1", "expired"])
      await this.alerts
        .resolve(`microsoft-secret:${id}:${suffix}`)
        .catch(() => undefined);
    return { name: app.name };
  }

  async saveConfig(input: {
    clientId: string;
    clientSecret?: string;
    secretExpiresAt?: string | null;
  }) {
    const existing = await this.prisma.microsoftAppConfig.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return existing
      ? this.updateApp(existing.id, { ...input, name: existing.name })
      : this.createApp({ ...input, name: "默认 Microsoft 应用" });
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
    appConfigId: string,
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
      where: { id: appConfigId },
    });
    if (!app)
      throw new AppError(
        "MICROSOFT_APP_NOT_FOUND",
        "所选 Microsoft 应用不存在，请重新选择",
        404,
      );
    const rawState = this.crypto.randomToken(32);
    const verifier = this.crypto.randomToken(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const id = randomUUID();
    await this.prisma.oAuthState.create({
      data: {
        id,
        provider: "MICROSOFT",
        microsoftAppConfigId: app.id,
        googleAppConfigId: null,
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
    const app = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: state.microsoftAppConfigId || "singleton" },
    });
    if (!app)
      throw new AppError(
        "MICROSOFT_APP_NOT_FOUND",
        "授权使用的 Microsoft 应用已被删除，请重新连接",
        409,
      );
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
    let profile: {
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    };
    const mailboxVerificationController = new AbortController();
    try {
      [profile] = await Promise.all([
        this.runImportStage("PROFILE", () =>
          this.graph.profile(result.accessToken, {
            signal: mailboxVerificationController.signal,
          }),
        ),
        this.runImportStage("MAILBOX_ACCESS", () =>
          this.graph.validateMailboxReadAccess(result.accessToken, {
            signal: mailboxVerificationController.signal,
          }),
        ),
      ]);
    } catch (error) {
      mailboxVerificationController.abort();
      const staged =
        error instanceof MicrosoftImportStageError
          ? error
          : new MicrosoftImportStageError("PROFILE", error);
      throw this.mapImportFailure(staged.stage, staged.originalError);
    }
    mailboxVerificationController.abort();
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
        microsoftAppConfigId: app.id,
        googleAppConfigId: null,
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
        microsoftAppConfigId: app.id,
        googleAppConfigId: null,
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

  async importRefreshToken(
    input: {
      appConfigId?: string;
      clientId?: string;
      refreshToken: string;
    },
    context: { requestId?: string } = {},
  ): Promise<{
    mailboxId: string;
    email: string;
    displayName: string;
    authMode: "CLIENT_ID_REFRESH_TOKEN";
  }> {
    const appConfigId = input.appConfigId?.trim() || null;
    const selectedApp = appConfigId
      ? await this.prisma.microsoftAppConfig.findUnique({
          where: { id: appConfigId },
        })
      : null;
    if (appConfigId && !selectedApp)
      throw new AppError(
        "MICROSOFT_APP_NOT_FOUND",
        "所选 Microsoft 应用不存在，请重新选择",
        404,
      );
    const suppliedClientId = input.clientId?.trim() || "";
    if (
      selectedApp &&
      suppliedClientId &&
      suppliedClientId !== selectedApp.clientId
    )
      throw new AppError(
        "MICROSOFT_CLIENT_ID_MISMATCH",
        "填写的 Client ID 与所选 Microsoft 应用不一致",
        400,
      );
    const clientId = selectedApp?.clientId || suppliedClientId;
    if (!clientId)
      throw new AppError(
        "MICROSOFT_CLIENT_ID_REQUIRED",
        "请选择 Microsoft 应用或填写 Client ID",
        400,
      );
    const refreshToken = input.refreshToken.trim();
    const startedAt = Date.now();
    const operationController = new AbortController();
    const operationSignal = AbortSignal.any([
      operationController.signal,
      AbortSignal.timeout(MICROSOFT_IMPORT_TOTAL_TIMEOUT_MS),
    ]);
    let token: MicrosoftRefreshTokenCache;
    try {
      token = await this.graph.exchangeImportedRefreshToken(
        clientId,
        refreshToken,
        {
          signal: operationSignal,
          timeoutMs: MICROSOFT_IMPORT_TOKEN_TIMEOUT_MS,
          // This is an interactive request. Returning a precise failure is
          // safer than stacking retries until the reverse proxy times out.
          maxRetries: 0,
        },
      );
    } catch (error) {
      operationController.abort();
      throw await this.importFailure(
        "TOKEN_EXCHANGE",
        startedAt,
        error,
        context.requestId,
      );
    }

    const accessToken = token.accessToken;
    if (!accessToken)
      throw new AppError(
        "MICROSOFT_TOKEN_EMPTY",
        "Microsoft 未返回有效访问令牌",
        502,
      );
    let profile: {
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    };
    try {
      [profile] = await Promise.all([
        this.runImportStage("PROFILE", () =>
          this.graph.profile(accessToken, {
            signal: operationSignal,
            timeoutMs: MICROSOFT_IMPORT_GRAPH_TIMEOUT_MS,
          }),
        ),
        this.runImportStage("MAILBOX_ACCESS", () =>
          this.graph.validateMailboxReadAccess(accessToken, {
            signal: operationSignal,
            timeoutMs: MICROSOFT_IMPORT_GRAPH_TIMEOUT_MS,
          }),
        ),
      ]);
    } catch (error) {
      operationController.abort();
      const staged =
        error instanceof MicrosoftImportStageError
          ? error
          : new MicrosoftImportStageError("PROFILE", error);
      throw await this.importFailure(
        staged.stage,
        startedAt,
        staged.originalError,
        context.requestId,
      );
    }
    operationController.abort();
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
        microsoftAppConfigId: selectedApp?.id ?? null,
        googleAppConfigId: null,
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
        microsoftAppConfigId: selectedApp?.id ?? null,
        googleAppConfigId: null,
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

  private async runImportStage<T>(
    stage: MicrosoftImportStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new MicrosoftImportStageError(stage, error);
    }
  }

  private async importFailure(
    stage: MicrosoftImportStage,
    startedAt: number,
    error: unknown,
    requestId?: string,
  ): Promise<AppError> {
    const mapped = this.mapImportFailure(stage, error);
    const metadata: Record<string, string | number> = {
      stage,
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: mapped.code,
      httpStatus: mapped.status,
    };
    if (error instanceof GraphError) {
      metadata.upstreamCode = error.code.slice(0, 200);
      if (error.status > 0) metadata.upstreamStatus = error.status;
      if (error.retryAfterSeconds)
        metadata.retryAfterSeconds = error.retryAfterSeconds;
    }
    const systemLog = (
      this.prisma as unknown as {
        systemLog?: {
          create(args: unknown): Promise<unknown>;
        };
      }
    ).systemLog;
    if (systemLog)
      await systemLog
        .create({
          data: {
            level: mapped.status >= 500 ? "ERROR" : "WARN",
            component: "microsoft",
            event: "MICROSOFT_REFRESH_TOKEN_IMPORT_FAILED",
            message: `Microsoft Refresh Token 导入失败（${stage}）：${mapped.code}`,
            requestId,
            metadata,
          },
        })
        .catch(() => undefined);
    return mapped;
  }

  private mapImportFailure(
    stage: MicrosoftImportStage,
    error: unknown,
  ): AppError {
    if (error instanceof AppError) return error;
    if (!(error instanceof GraphError))
      return new AppError(
        "MICROSOFT_REFRESH_TOKEN_VERIFY_FAILED",
        "Microsoft 邮箱验证出现未知错误，请根据请求 ID 查看系统日志",
        502,
        { stage },
      );

    const details = this.importErrorDetails(stage, error);
    const errorText = `${error.code} ${error.message}`;
    const timedOut = /TIMEOUT/i.test(error.code);

    if (stage === "TOKEN_EXCHANGE") {
      if (
        [400, 401].includes(error.status) &&
        /invalid_scope|consent_required|AADSTS65001|one or more scopes requested are unauthorized|must first sign in and grant/i.test(
          errorText,
        )
      )
        return new AppError(
          "MICROSOFT_GRAPH_SCOPES_REQUIRED",
          "Refresh Token 未授予 Microsoft Graph 的 User.Read、Mail.ReadWrite 和 Mail.Send，请重新授权并生成新的 Refresh Token",
          400,
          {
            ...details,
            requiredScopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
          },
        );
      if (
        [400, 401].includes(error.status) &&
        /invalid_grant|invalid_client|unauthorized_client|interaction_required/i.test(
          errorText,
        )
      )
        return new AppError(
          "MICROSOFT_REFRESH_TOKEN_INVALID",
          "Refresh Token 无效、已撤销、不属于该 Client ID，或此应用不允许无 Client Secret 刷新",
          400,
          details,
        );
      if (error.status === 429)
        return new AppError(
          "MICROSOFT_TOKEN_RATE_LIMITED",
          "Microsoft 暂时限制了令牌验证，请按提示稍后重试",
          429,
          details,
        );
      if (timedOut)
        return new AppError(
          "MICROSOFT_TOKEN_TIMEOUT",
          "连接 Microsoft Token Endpoint 超时，系统已停止等待；请检查服务器出网、DNS 和代理后重试",
          504,
          details,
        );
      if (error.status >= 500)
        return new AppError(
          "MICROSOFT_TOKEN_UPSTREAM_ERROR",
          "Microsoft Token Endpoint 暂时不可用，请稍后重试",
          502,
          details,
        );
      if (error.status === 0)
        return new AppError(
          "MICROSOFT_TOKEN_NETWORK_ERROR",
          "服务器无法连接 Microsoft Token Endpoint，请检查出网、DNS、IPv6 和防火墙",
          502,
          details,
        );
      if (error.status >= 400 && error.status < 500)
        return new AppError(
          "MICROSOFT_TOKEN_REQUEST_REJECTED",
          "Microsoft 拒绝了令牌请求，请检查 Client ID、Refresh Token 来源、委托权限和应用类型",
          400,
          details,
        );
      return new AppError(
        "MICROSOFT_REFRESH_TOKEN_VERIFY_FAILED",
        "Microsoft 拒绝了 Refresh Token 验证，请检查 Client ID、Token 来源和应用类型",
        502,
        details,
      );
    }

    if (error.status === 401 || error.status === 403)
      return new AppError(
        "MICROSOFT_GRAPH_PERMISSION_DENIED",
        "Microsoft 拒绝读取邮箱，请确认 Token 已授予 User.Read、Mail.ReadWrite、Mail.Send 委托权限，并确认账户已开通 Outlook/Exchange 邮箱",
        409,
        details,
      );
    if (stage === "MAILBOX_ACCESS" && error.status === 404)
      return new AppError(
        "MICROSOFT_MAILBOX_NOT_AVAILABLE",
        "Microsoft 账户中找不到可用的收件箱或垃圾箱，请确认邮箱服务已开通",
        409,
        details,
      );
    if (error.status === 429)
      return new AppError(
        "MICROSOFT_GRAPH_RATE_LIMITED",
        "Microsoft Graph 暂时限流，请按提示稍后重试",
        429,
        details,
      );
    if (timedOut)
      return new AppError(
        "MICROSOFT_GRAPH_TIMEOUT",
        "Microsoft Graph 邮箱验证超时，系统已停止等待；请检查服务器到 graph.microsoft.com 的网络",
        504,
        details,
      );
    if (error.status === 0)
      return new AppError(
        "MICROSOFT_GRAPH_UNAVAILABLE",
        "服务器无法连接 Microsoft Graph，请检查出网、DNS、IPv6 和防火墙",
        502,
        details,
      );
    if (error.code === "MICROSOFT_PROFILE_INVALID")
      return new AppError(
        "MICROSOFT_PROFILE_INVALID",
        "Microsoft 返回的邮箱资料无效，无法确认邮箱身份",
        502,
        details,
      );
    if (error.status >= 500)
      return new AppError(
        "MICROSOFT_GRAPH_UPSTREAM_ERROR",
        "Microsoft Graph 暂时不可用，请稍后重试",
        502,
        details,
      );
    return new AppError(
      stage === "PROFILE"
        ? "MICROSOFT_PROFILE_FAILED"
        : "MICROSOFT_MAILBOX_ACCESS_FAILED",
      stage === "PROFILE"
        ? "无法读取 Microsoft 邮箱资料，请确认 User.Read 委托权限"
        : "无法读取 Microsoft 收件箱或垃圾箱，请确认 Mail.ReadWrite 委托权限和邮箱状态",
      409,
      details,
    );
  }

  private importErrorDetails(
    stage: MicrosoftImportStage,
    error: GraphError,
  ): Record<string, string | number> {
    const details: Record<string, string | number> = {
      stage,
      upstreamCode: error.code.slice(0, 200),
    };
    if (error.status > 0) details.upstreamStatus = error.status;
    if (error.retryAfterSeconds)
      details.retryAfterSeconds = error.retryAfterSeconds;
    return details;
  }

  private appName(value: string): string {
    const name = value.trim();
    if (!name)
      throw new AppError(
        "MICROSOFT_APP_NAME_REQUIRED",
        "Microsoft 应用名称不能为空",
        400,
      );
    return name;
  }

  private appView(app: {
    id: string;
    name: string;
    clientId: string;
    clientSecretEncrypted: string;
    secretExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    _count?: { mailboxes: number };
  }) {
    return {
      id: app.id,
      name: app.name,
      clientId: app.clientId,
      hasClientSecret: Boolean(app.clientSecretEncrypted),
      secretExpiresAt: app.secretExpiresAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      mailboxCount: app._count?.mailboxes ?? 0,
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
