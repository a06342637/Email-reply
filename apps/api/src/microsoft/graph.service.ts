import { Injectable } from "@nestjs/common";
import {
  ConfidentialClientApplication,
  type Configuration,
} from "@azure/msal-node";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppError } from "../core/http.js";
import { AlertService } from "../observability/alert.service.js";
import { ProviderApiError } from "../providers/provider-api.error.js";

export const GRAPH_SCOPES = ["User.Read", "Mail.ReadWrite", "Mail.Send"];
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const REFRESH_TOKEN_SCOPES = ["offline_access", ...GRAPH_SCOPES];

export type MicrosoftRefreshTokenCache = {
  version: 1;
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
  scope: string;
  tokenType?: string;
};

type MicrosoftTokenResponse = {
  token_type?: string;
  scope?: string;
  expires_in?: number;
  ext_expires_in?: number;
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

/** Options used by short-lived, user-facing Microsoft requests. */
export type MicrosoftGraphRequestOptions = {
  /** An optional signal shared by all steps of one user-facing operation. */
  signal?: AbortSignal;
  /** Per-request timeout. The caller may still impose a shorter total budget. */
  timeoutMs?: number;
  /** Retries for transient failures. Interactive imports normally use zero. */
  maxRetries?: number;
};

type MicrosoftMailboxTokenRecord = {
  id: string;
  provider: "MICROSOFT" | "GOOGLE";
  status: "CONNECTED" | "AUTH_REQUIRED" | "DISABLED" | "REMOVED";
  microsoftAuthMode: "MSAL_OAUTH" | "CLIENT_ID_REFRESH_TOKEN";
  microsoftClientId: string | null;
  microsoftAppConfigId: string | null;
  homeAccountId: string;
  tokenCacheEncrypted: string;
};

type MicrosoftCredentialSnapshot = Pick<
  MicrosoftMailboxTokenRecord,
  | "id"
  | "provider"
  | "status"
  | "microsoftAuthMode"
  | "microsoftClientId"
  | "microsoftAppConfigId"
  | "homeAccountId"
  | "tokenCacheEncrypted"
>;

type MicrosoftAccessTokenContext = {
  accessToken: string;
  credential: MicrosoftCredentialSnapshot;
};

export class GraphError extends ProviderApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
    responseBody?: unknown,
  ) {
    super("MICROSOFT", status, code, message, retryAfterSeconds, responseBody);
    this.name = "GraphError";
  }
}

@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly alerts: AlertService,
  ) {}

  async accessToken(mailboxId: string, forceRefresh = false): Promise<string> {
    return (await this.accessTokenContext(mailboxId, forceRefresh)).accessToken;
  }

  private async accessTokenContext(
    mailboxId: string,
    forceRefresh = false,
  ): Promise<MicrosoftAccessTokenContext> {
    const mailbox = await this.prisma.mailbox.findUnique({
      where: { id: mailboxId },
    });
    if (!mailbox || mailbox.status !== "CONNECTED") {
      throw new AppError(
        "MAILBOX_NOT_CONNECTED",
        "邮箱未连接或需要重新授权",
        409,
      );
    }
    if (mailbox.provider && mailbox.provider !== "MICROSOFT")
      throw new AppError(
        "MAILBOX_PROVIDER_MISMATCH",
        "该邮箱不是 Microsoft 邮箱",
        409,
      );
    return mailbox.microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
      ? this.refreshTokenAccessToken(mailbox, forceRefresh)
      : this.msalAccessToken(mailbox, forceRefresh);
  }

  async exchangeImportedRefreshToken(
    clientId: string,
    refreshToken: string,
    options: MicrosoftGraphRequestOptions = {},
  ): Promise<MicrosoftRefreshTokenCache> {
    const response = await this.requestRefreshToken(
      clientId.trim(),
      refreshToken.trim(),
      options,
    );
    if (!response.access_token)
      throw new GraphError(
        502,
        "MICROSOFT_TOKEN_EMPTY",
        "Microsoft 刷新令牌响应缺少 access_token",
      );
    const cache = this.refreshTokenCache(
      response,
      response.refresh_token || refreshToken.trim(),
    );
    this.assertRequiredScopes(cache.scope);
    return cache;
  }

  tokenIdentity(accessToken: string): {
    tenantId?: string;
    objectId?: string;
  } {
    const claims = this.jwtClaims(accessToken);
    return {
      tenantId: typeof claims?.tid === "string" ? claims.tid : undefined,
      objectId:
        typeof claims?.oid === "string"
          ? claims.oid
          : typeof claims?.sub === "string"
            ? claims.sub
            : undefined,
    };
  }

  private async msalAccessToken(
    mailbox: MicrosoftMailboxTokenRecord,
    forceRefresh: boolean,
  ): Promise<MicrosoftAccessTokenContext> {
    try {
      const app = await this.prisma.microsoftAppConfig.findUnique({
        where: { id: mailbox.microsoftAppConfigId || "singleton" },
      });
      if (!app)
        throw new AppError(
          "MICROSOFT_APP_NOT_FOUND",
          "邮箱绑定的 Microsoft 应用不存在，请重新授权",
          409,
        );
      const cca = await this.createClient(
        app.clientId,
        app.clientSecretEncrypted,
      );
      const cache = cca.getTokenCache();
      let serializedCache: string;
      try {
        serializedCache = await this.crypto.decryptString(
          mailbox.tokenCacheEncrypted,
          `msal:${mailbox.id}`,
        );
        cache.deserialize(serializedCache);
      } catch {
        throw new AppError(
          "MSAL_TOKEN_CACHE_INVALID",
          "Microsoft OAuth 授权缓存无法读取",
          409,
        );
      }
      const account = await cache.getAccountByHomeId(mailbox.homeAccountId);
      if (!account)
        throw new AppError(
          "MSAL_ACCOUNT_MISSING",
          "授权缓存中找不到邮箱账户",
          409,
        );
      const result = await cca.acquireTokenSilent({
        account,
        scopes: GRAPH_SCOPES,
        forceRefresh,
      });
      if (!result?.accessToken)
        throw new GraphError(
          502,
          "MSAL_TOKEN_EMPTY",
          "Microsoft 未返回有效访问令牌",
        );
      const updatedSerializedCache = cache.serialize();
      if (updatedSerializedCache === serializedCache)
        return {
          accessToken: result.accessToken,
          credential: this.credentialSnapshot(mailbox),
        };
      const encryptedCache = await this.crypto.encryptString(
        updatedSerializedCache,
        `msal:${mailbox.id}`,
      );
      const persisted = await this.persistTokenCache(mailbox, encryptedCache);
      if (!persisted) return this.accessTokenContext(mailbox.id, false);
      return {
        accessToken: result.accessToken,
        credential: this.credentialSnapshot(mailbox, encryptedCache),
      };
    } catch (error) {
      return this.handleTokenFailure(
        mailbox,
        error,
        "MSAL token refresh failed",
      );
    }
  }

  private async refreshTokenAccessToken(
    mailbox: MicrosoftMailboxTokenRecord,
    forceRefresh: boolean,
  ): Promise<MicrosoftAccessTokenContext> {
    try {
      if (!mailbox.microsoftClientId)
        throw new AppError(
          "MICROSOFT_CLIENT_ID_MISSING",
          "该邮箱的 Client ID 缺失",
          409,
        );
      const cached = await this.readRefreshTokenCache(mailbox);
      if (
        !forceRefresh &&
        cached.accessToken &&
        (cached.expiresAt ?? 0) > Date.now() + 60_000
      )
        return {
          accessToken: cached.accessToken,
          credential: this.credentialSnapshot(mailbox),
        };
      const response = await this.requestRefreshToken(
        mailbox.microsoftClientId,
        cached.refreshToken,
      );
      if (!response.access_token)
        throw new GraphError(
          502,
          "MICROSOFT_TOKEN_EMPTY",
          "Microsoft 刷新令牌响应缺少 access_token",
        );
      const updated = this.refreshTokenCache(
        response,
        response.refresh_token || cached.refreshToken,
        cached,
      );
      this.assertRequiredScopes(updated.scope);
      const encryptedCache = await this.crypto.encryptString(
        JSON.stringify(updated),
        `msal:${mailbox.id}`,
      );
      const persisted = await this.persistTokenCache(mailbox, encryptedCache);
      if (!persisted) return this.accessTokenContext(mailbox.id, false);
      return {
        accessToken: updated.accessToken!,
        credential: this.credentialSnapshot(mailbox, encryptedCache),
      };
    } catch (error) {
      return this.handleTokenFailure(
        mailbox,
        error,
        "Microsoft refresh token exchange failed",
      );
    }
  }

  private async persistTokenCache(
    mailbox: MicrosoftMailboxTokenRecord,
    encryptedCache: string,
  ): Promise<boolean> {
    const persisted = await this.prisma.mailbox.updateMany({
      where: {
        id: mailbox.id,
        provider: "MICROSOFT",
        microsoftAuthMode: mailbox.microsoftAuthMode,
        microsoftAppConfigId: mailbox.microsoftAppConfigId,
        status: "CONNECTED",
        tokenCacheEncrypted: mailbox.tokenCacheEncrypted,
      },
      data: {
        tokenCacheEncrypted: encryptedCache,
        lastTokenRefreshAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    return Boolean(persisted.count);
  }

  private async handleTokenFailure(
    mailbox: MicrosoftMailboxTokenRecord,
    error: unknown,
    fallbackMessage: string,
  ): Promise<MicrosoftAccessTokenContext> {
    const code = this.errorCode(error);
    const message = error instanceof Error ? error.message : fallbackMessage;
    if (this.isAuthorizationFailure(error)) {
      const marked = await this.requireAuthorization(
        mailbox.id,
        code,
        message,
        this.credentialSnapshot(mailbox),
      );
      if (!marked) return this.accessTokenContext(mailbox.id, false);
      throw new AppError(
        "MAILBOX_AUTH_REQUIRED",
        "Microsoft 授权已失效，请重新登录或重新导入 Refresh Token",
        409,
      );
    }
    if (error instanceof AppError || error instanceof GraphError) throw error;
    throw new GraphError(0, code, message);
  }

  async request<T>(
    mailboxId: string,
    pathOrUrl: string,
    init: RequestInit = {},
    options: { maxRetries?: number; expected?: number[] } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const expected = options.expected ?? [200];
    let attempt = 0;
    let refreshedAfterUnauthorized = false;
    let retriedAfterCredentialChange = false;
    let forceRefresh = false;
    while (true) {
      const url = this.graphUrl(pathOrUrl);
      const tokenContext = await this.accessTokenContext(
        mailboxId,
        forceRefresh,
      );
      const token = tokenContext.accessToken;
      forceRefresh = false;
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(45_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            Prefer: 'IdType="ImmutableId"',
            ...init.headers,
          },
        });
      } catch (error) {
        if (attempt++ < maxRetries) {
          await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
          continue;
        }
        throw new GraphError(
          0,
          "GRAPH_NETWORK_ERROR",
          error instanceof Error ? error.message : "Network error",
        );
      }

      if (expected.includes(response.status)) {
        if (
          response.status === 204 ||
          response.status === 202 ||
          response.headers.get("content-length") === "0"
        )
          return undefined as T;
        const contentType = response.headers.get("content-type") ?? "";
        return (
          contentType.includes("json")
            ? await response.json()
            : await response.text()
        ) as T;
      }

      const retryAfter = this.retryAfter(response);
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        await response.arrayBuffer().catch(() => undefined);
        refreshedAfterUnauthorized = true;
        forceRefresh = true;
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt++ < maxRetries
      ) {
        await sleep((retryAfter ?? Math.min(60, 2 ** attempt)) * 1_000);
        continue;
      }

      const bodyText = await response.text();
      let body: unknown = bodyText;
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Keep raw text for diagnostics.
      }
      const graphBody = body as { error?: { code?: string; message?: string } };
      const code = graphBody?.error?.code ?? `HTTP_${response.status}`;
      const message =
        graphBody?.error?.message ??
        `Microsoft Graph request failed (${response.status})`;
      if (this.isGraphAuthorizationFailure(response.status, code, message)) {
        const marked = await this.requireAuthorization(
          mailboxId,
          code,
          message,
          tokenContext.credential,
        );
        if (!marked && !retriedAfterCredentialChange) {
          retriedAfterCredentialChange = true;
          refreshedAfterUnauthorized = false;
          forceRefresh = false;
          continue;
        }
      }
      throw new GraphError(response.status, code, message, retryAfter, body);
    }
  }

  private graphUrl(pathOrUrl: string): string {
    if (!pathOrUrl.startsWith("https://")) {
      if (!pathOrUrl.startsWith("/"))
        throw new GraphError(
          0,
          "GRAPH_URL_REJECTED",
          "Microsoft Graph 路径格式无效",
        );
      return `https://graph.microsoft.com/v1.0${pathOrUrl}`;
    }
    let parsed: URL;
    try {
      parsed = new URL(pathOrUrl);
    } catch {
      throw new GraphError(
        0,
        "GRAPH_URL_REJECTED",
        "Microsoft Graph URL 格式无效",
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "graph.microsoft.com" ||
      parsed.username ||
      parsed.password
    )
      throw new GraphError(
        0,
        "GRAPH_URL_REJECTED",
        "拒绝向非 Microsoft Graph 主机发送邮箱授权",
      );
    return parsed.toString();
  }

  async createClient(
    clientId: string,
    encryptedSecret: string,
  ): Promise<ConfidentialClientApplication> {
    const secret = await this.crypto.decryptString(
      encryptedSecret,
      "microsoft-client-secret",
    );
    const configuration: Configuration = {
      auth: {
        clientId,
        clientSecret: secret,
        authority: "https://login.microsoftonline.com/common",
      },
    };
    return new ConfidentialClientApplication(configuration);
  }

  async profile(
    accessToken: string,
    options: MicrosoftGraphRequestOptions = {},
  ): Promise<{
    id: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  }> {
    const profile = await this.verificationRequest<{
      id?: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    }>(
      "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
      accessToken,
      "PROFILE",
      options,
    );
    if (!profile?.id)
      throw new GraphError(
        502,
        "MICROSOFT_PROFILE_INVALID",
        "Microsoft 返回的邮箱资料无效",
      );
    return profile as {
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    };
  }

  async validateMailboxReadAccess(
    accessToken: string,
    options: MicrosoftGraphRequestOptions = {},
  ): Promise<void> {
    // Inbox and junk-email checks are independent. Running them together keeps
    // a slow folder endpoint from doubling the time of an interactive import.
    await Promise.all(
      ["inbox", "junkemail"].map((folder) =>
        this.verificationRequest(
          `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}?$select=id`,
          accessToken,
          "MAILBOX_ACCESS",
          options,
        ),
      ),
    );
  }

  private async readRefreshTokenCache(
    mailbox: MicrosoftMailboxTokenRecord,
  ): Promise<MicrosoftRefreshTokenCache> {
    try {
      const plain = await this.crypto.decryptString(
        mailbox.tokenCacheEncrypted,
        `msal:${mailbox.id}`,
      );
      const parsed = JSON.parse(plain) as MicrosoftRefreshTokenCache;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.refreshToken !== "string" ||
        !parsed.refreshToken ||
        typeof parsed.scope !== "string"
      )
        throw new Error("invalid Microsoft refresh token cache");
      return parsed;
    } catch {
      throw new AppError(
        "MICROSOFT_REFRESH_TOKEN_CACHE_INVALID",
        "Microsoft Refresh Token 授权缓存无法读取",
        409,
      );
    }
  }

  private refreshTokenCache(
    response: MicrosoftTokenResponse,
    refreshToken: string,
    previous?: MicrosoftRefreshTokenCache,
  ): MicrosoftRefreshTokenCache {
    const expiresIn =
      typeof response.expires_in === "number" &&
      Number.isFinite(response.expires_in)
        ? response.expires_in
        : 3_600;
    const scope =
      response.scope?.trim() ||
      this.accessTokenScope(response.access_token) ||
      previous?.scope ||
      "";
    return {
      version: 1,
      accessToken: response.access_token,
      refreshToken,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
      scope,
      tokenType: response.token_type || previous?.tokenType || "Bearer",
    };
  }

  private async requestRefreshToken(
    clientId: string,
    refreshToken: string,
    options: MicrosoftGraphRequestOptions = {},
  ): Promise<MicrosoftTokenResponse> {
    if (!clientId || !refreshToken)
      throw new AppError(
        "MICROSOFT_REFRESH_IMPORT_INVALID",
        "Client ID 和 Refresh Token 不能为空",
        400,
      );
    const maxRetries = options.maxRetries ?? 2;
    const timeoutMs = options.timeoutMs ?? 30_000;
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await fetch(MICROSOFT_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
            scope: REFRESH_TOKEN_SCOPES.join(" "),
          }),
          signal: this.requestSignal(timeoutMs, options.signal),
        });
      } catch (error) {
        if (options.signal?.aborted)
          throw new GraphError(
            0,
            "MICROSOFT_OAUTH_TIMEOUT",
            "Microsoft OAuth 令牌验证超过总时间限制",
          );
        if (attempt++ < maxRetries) {
          await this.retrySleep(
            Math.min(8_000, 1_000 * 2 ** attempt),
            options.signal,
          );
          continue;
        }
        throw new GraphError(
          0,
          this.isAbortError(error)
            ? "MICROSOFT_OAUTH_TIMEOUT"
            : "MICROSOFT_OAUTH_NETWORK_ERROR",
          this.isAbortError(error)
            ? "Microsoft OAuth 令牌请求超时"
            : "无法连接 Microsoft OAuth 令牌服务",
        );
      }
      let result: MicrosoftTokenResponse;
      try {
        result = (await response.json()) as MicrosoftTokenResponse;
      } catch (error) {
        if (options.signal?.aborted)
          throw new GraphError(
            0,
            "MICROSOFT_OAUTH_TIMEOUT",
            "Microsoft OAuth 令牌响应读取超时",
          );
        if (attempt++ < maxRetries) {
          await this.retrySleep(
            Math.min(8_000, 1_000 * 2 ** attempt),
            options.signal,
          );
          continue;
        }
        if (this.isAbortError(error))
          throw new GraphError(
            0,
            "MICROSOFT_OAUTH_TIMEOUT",
            "Microsoft OAuth 令牌响应读取超时",
          );
        if (response.ok)
          throw new GraphError(
            502,
            "MICROSOFT_OAUTH_INVALID_RESPONSE",
            "Microsoft OAuth 返回了无法解析的令牌响应",
          );
        result = {};
      }
      if (response.ok) return result;
      const retryAfter = this.retryAfter(response);
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt++ < maxRetries
      ) {
        await this.retrySleep(
          (retryAfter ?? Math.min(8, 2 ** attempt)) * 1_000,
          options.signal,
        );
        continue;
      }
      throw new GraphError(
        response.status,
        result.error || `HTTP_${response.status}`,
        (result.error_description || "Microsoft OAuth token request failed")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 1_000),
        retryAfter,
      );
    }
  }

  private assertRequiredScopes(scope: string): void {
    const granted = new Set(
      scope
        .split(/\s+/)
        .filter(Boolean)
        .map((item) => item.toLowerCase()),
    );
    const missing = GRAPH_SCOPES.filter(
      (item) => !granted.has(item.toLowerCase()),
    );
    if (missing.length)
      throw new AppError(
        "MICROSOFT_SCOPES_MISSING",
        "Refresh Token 未授予完整的 Microsoft 邮件读取和发送权限",
        409,
        { missing },
      );
  }

  private accessTokenScope(accessToken?: string): string {
    const claims = accessToken ? this.jwtClaims(accessToken) : undefined;
    return typeof claims?.scp === "string" ? claims.scp : "";
  }

  private jwtClaims(token: string): Record<string, unknown> | undefined {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async requireAuthorization(
    mailboxId: string,
    code: string,
    message: string,
    expected?: MicrosoftCredentialSnapshot,
  ): Promise<boolean> {
    const credential =
      expected ??
      (await this.prisma.mailbox.findUnique({ where: { id: mailboxId } }));
    if (
      !credential ||
      credential.provider !== "MICROSOFT" ||
      credential.status !== "CONNECTED"
    )
      return false;
    const marked = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mailbox.updateMany({
        where: {
          id: mailboxId,
          provider: "MICROSOFT",
          status: "CONNECTED",
          microsoftAuthMode: credential.microsoftAuthMode,
          microsoftClientId: credential.microsoftClientId,
          microsoftAppConfigId: credential.microsoftAppConfigId,
          homeAccountId: credential.homeAccountId,
          tokenCacheEncrypted: credential.tokenCacheEncrypted,
        },
        data: {
          status: "AUTH_REQUIRED",
          lastErrorCode: code.slice(0, 200),
          lastErrorMessage: message.slice(0, 1000),
        },
      });
      if (!updated.count) return false;
      await tx.autoReplyTask.updateMany({
        where: {
          mailboxId,
          status: { in: ["RUNNING", "INITIALIZING"] },
        },
        data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
      });
      await tx.$executeRaw`
        DELETE FROM "TransactionalOutbox" AS outbox
        USING "MessageReceipt" AS receipt
        WHERE outbox."aggregateId" = receipt."id"
          AND receipt."mailboxId" = ${mailboxId}
          AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
      `;
      return true;
    });
    if (!marked) return false;
    await this.alerts.open({
      fingerprint: `mailbox-auth:${mailboxId}`,
      type: "MAILBOX_AUTH_REQUIRED",
      severity: "CRITICAL",
      title: "邮箱需要重新授权",
      message: "Microsoft 授权已失效，自动回复已暂停。",
      metadata: { mailboxId, code },
    });
    const current = await this.prisma.mailbox.findUnique({
      where: { id: mailboxId },
      select: { status: true, lastErrorCode: true },
    });
    if (
      current?.status !== "AUTH_REQUIRED" ||
      current.lastErrorCode !== code.slice(0, 200)
    )
      await this.alerts
        .resolve(`mailbox-auth:${mailboxId}`)
        .catch(() => undefined);
    return true;
  }

  private credentialSnapshot(
    mailbox: MicrosoftMailboxTokenRecord,
    tokenCacheEncrypted = mailbox.tokenCacheEncrypted,
  ): MicrosoftCredentialSnapshot {
    return {
      id: mailbox.id,
      provider: mailbox.provider,
      status: mailbox.status,
      microsoftAuthMode: mailbox.microsoftAuthMode,
      microsoftClientId: mailbox.microsoftClientId,
      microsoftAppConfigId: mailbox.microsoftAppConfigId,
      homeAccountId: mailbox.homeAccountId,
      tokenCacheEncrypted,
    };
  }

  private async verificationRequest<T>(
    url: string,
    accessToken: string,
    operation: "PROFILE" | "MAILBOX_ACCESS",
    options: MicrosoftGraphRequestOptions,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Prefer: 'IdType="ImmutableId"',
        },
        signal: this.requestSignal(options.timeoutMs ?? 20_000, options.signal),
      });
    } catch (error) {
      const timeout = options.signal?.aborted || this.isAbortError(error);
      throw new GraphError(
        0,
        `MICROSOFT_${operation}_${timeout ? "TIMEOUT" : "NETWORK_ERROR"}`,
        timeout
          ? "Microsoft Graph 邮箱验证请求超时"
          : "无法连接 Microsoft Graph 验证邮箱",
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      const timeout = options.signal?.aborted || this.isAbortError(error);
      throw new GraphError(
        0,
        `MICROSOFT_${operation}_${timeout ? "TIMEOUT" : "NETWORK_ERROR"}`,
        timeout
          ? "Microsoft Graph 邮箱验证响应读取超时"
          : "读取 Microsoft Graph 邮箱验证响应失败",
      );
    }
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = bodyText;
    }
    if (!response.ok) {
      const graphBody = body as {
        error?: { code?: string; message?: string };
      };
      throw new GraphError(
        response.status,
        graphBody?.error?.code ?? `HTTP_${response.status}`,
        (
          graphBody?.error?.message ??
          `Microsoft Graph verification failed (${response.status})`
        )
          .replace(/[\r\n]+/g, " ")
          .slice(0, 1_000),
        this.retryAfter(response),
      );
    }
    return body as T;
  }

  private requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  private async retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
    try {
      await sleep(ms, undefined, signal ? { signal } : undefined);
    } catch (error) {
      if (signal?.aborted)
        throw new GraphError(
          0,
          "MICROSOFT_OAUTH_TIMEOUT",
          "Microsoft OAuth 令牌验证超过总时间限制",
        );
      throw error;
    }
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const name = "name" in error ? String(error.name) : "";
    return name === "AbortError" || name === "TimeoutError";
  }

  private retryAfter(response: Response): number | undefined {
    const value = response.headers.get("retry-after");
    if (!value) return undefined;
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds)) return Math.max(1, seconds);
    const date = Date.parse(value);
    return Number.isFinite(date)
      ? Math.max(1, Math.ceil((date - Date.now()) / 1000))
      : undefined;
  }

  private errorCode(error: unknown): string {
    if (error instanceof ProviderApiError || error instanceof AppError)
      return error.code;
    if (typeof error === "object" && error && "errorCode" in error)
      return String((error as { errorCode: unknown }).errorCode);
    if (typeof error === "object" && error && "code" in error)
      return String((error as { code: unknown }).code);
    return "MSAL_REFRESH_FAILED";
  }

  private isGraphAuthorizationFailure(
    status: number,
    code: string,
    message: string,
  ): boolean {
    if (status === 401) return true;
    if (status !== 403) return false;
    return /InvalidAuthenticationToken|AuthenticationError|InvalidToken|TokenExpired|token.+(?:expired|invalid|revoked)|(?:expired|invalid|revoked).+token/i.test(
      `${code} ${message}`,
    );
  }

  private isAuthorizationFailure(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as {
      code?: unknown;
      errorCode?: unknown;
      subError?: unknown;
      errorMessage?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const text = [
      candidate.code,
      candidate.errorCode,
      candidate.subError,
      candidate.errorMessage,
      candidate.message,
      candidate.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /interaction_required|consent_required|login_required|invalid_grant|invalid_client|unauthorized_client|client_secret|no_tokens_found|token_refresh_required|account.*missing|token_cache_invalid|scopes_missing|client_id_missing/.test(
      text,
    );
  }
}
