import { Injectable } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppError } from "../core/http.js";
import { AlertService } from "../observability/alert.service.js";
import { ProviderApiError } from "../providers/provider-api.error.js";

export type GoogleTokenCache = {
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  idToken?: string;
};

export const GMAIL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export class GoogleApiError extends ProviderApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
    responseBody?: unknown,
  ) {
    super("GOOGLE", status, code, message, retryAfterSeconds, responseBody);
    this.name = "GoogleApiError";
  }
}

@Injectable()
export class GmailApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly alerts: AlertService,
  ) {}

  async exchangeAuthorizationCode(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<GoogleTokenCache> {
    const app = await this.config();
    const clientSecret = await this.crypto.decryptString(
      app.clientSecretEncrypted,
      "google-client-secret",
    );
    const body = new URLSearchParams({
      client_id: app.clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const response = await this.tokenRequest(body);
    if (!response.access_token)
      throw new AppError(
        "GOOGLE_TOKEN_FAILED",
        "Google 未返回有效访问令牌",
        502,
      );
    if (!response.refresh_token)
      throw new AppError(
        "GOOGLE_REFRESH_TOKEN_MISSING",
        "Google 未返回刷新令牌，请撤销旧授权后重新连接，并确认授权页已允许离线访问",
        409,
      );
    if (response.scope) {
      const granted = new Set(response.scope.split(/\s+/).filter(Boolean));
      const missing = GMAIL_REQUIRED_SCOPES.filter(
        (scope) => !granted.has(scope),
      );
      if (missing.length)
        throw new AppError(
          "GOOGLE_SCOPES_MISSING",
          "Google 未授予完整的 Gmail 读取和草稿发送权限，请重新授权并勾选全部权限",
          409,
          { missing },
        );
    }
    return this.tokenCache(response, response.refresh_token);
  }

  async accessToken(mailboxId: string, forceRefresh = false): Promise<string> {
    const mailbox = await this.prisma.mailbox.findUnique({
      where: { id: mailboxId },
    });
    if (!mailbox || mailbox.status !== "CONNECTED")
      throw new AppError(
        "MAILBOX_NOT_CONNECTED",
        "邮箱未连接或需要重新授权",
        409,
      );
    if (mailbox.provider !== "GOOGLE")
      throw new AppError(
        "MAILBOX_PROVIDER_MISMATCH",
        "该邮箱不是 Gmail 邮箱",
        409,
      );

    const cached = await this.readToken(
      mailbox.id,
      mailbox.tokenCacheEncrypted,
    );
    if (
      !forceRefresh &&
      cached.accessToken &&
      (cached.expiresAt ?? 0) > Date.now() + 60_000
    )
      return cached.accessToken;
    if (!cached.refreshToken) {
      await this.requireAuthorization(
        mailbox.id,
        "GOOGLE_REFRESH_TOKEN_MISSING",
        "Google 授权缓存缺少刷新令牌",
      );
      throw new AppError("MAILBOX_AUTH_REQUIRED", "邮箱需要重新授权", 409);
    }

    const app = await this.config();
    const clientSecret = await this.crypto.decryptString(
      app.clientSecretEncrypted,
      "google-client-secret",
    );
    try {
      const response = await this.tokenRequest(
        new URLSearchParams({
          client_id: app.clientId,
          client_secret: clientSecret,
          refresh_token: cached.refreshToken,
          grant_type: "refresh_token",
        }),
      );
      if (!response.access_token)
        throw new GoogleApiError(
          502,
          "GOOGLE_TOKEN_EMPTY",
          "Google 刷新令牌响应缺少 access_token",
        );
      const updated = this.tokenCache(
        response,
        response.refresh_token || cached.refreshToken,
        cached,
      );
      const encrypted = await this.crypto.encryptString(
        JSON.stringify(updated),
        `google-token:${mailbox.id}`,
      );
      const persisted = await this.prisma.mailbox.updateMany({
        where: {
          id: mailbox.id,
          provider: "GOOGLE",
          status: "CONNECTED",
          tokenCacheEncrypted: mailbox.tokenCacheEncrypted,
        },
        data: {
          tokenCacheEncrypted: encrypted,
          lastTokenRefreshAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!persisted.count)
        await this.prisma.mailbox.updateMany({
          where: { id: mailbox.id, provider: "GOOGLE", status: "CONNECTED" },
          data: {
            lastTokenRefreshAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
      return updated.accessToken!;
    } catch (error) {
      if (this.isAuthorizationFailure(error)) {
        const code = this.errorCode(error);
        const message =
          error instanceof Error
            ? error.message
            : "Google token refresh failed";
        await this.requireAuthorization(mailbox.id, code, message);
        throw new AppError(
          "MAILBOX_AUTH_REQUIRED",
          "Google 授权已失效，请重新连接邮箱",
          409,
        );
      }
      if (error instanceof GoogleApiError) throw error;
      throw new GoogleApiError(
        0,
        this.errorCode(error),
        error instanceof Error ? error.message : "Google token refresh failed",
      );
    }
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
    let forceRefresh = false;
    while (true) {
      const url = this.gmailUrl(pathOrUrl);
      const token = await this.accessToken(mailboxId, forceRefresh);
      forceRefresh = false;
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(45_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...init.headers,
          },
        });
      } catch (error) {
        if (attempt++ < maxRetries) {
          await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
          continue;
        }
        throw new GoogleApiError(
          0,
          "GOOGLE_NETWORK_ERROR",
          error instanceof Error ? error.message : "Network error",
        );
      }

      if (expected.includes(response.status)) {
        if (
          response.status === 204 ||
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

      const bodyText = await response.text();
      let body: unknown = bodyText;
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Preserve the non-sensitive response text as structured diagnostics.
      }
      const detail = body as {
        error?: {
          code?: number;
          message?: string;
          status?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
      const reason =
        detail.error?.errors?.[0]?.reason ||
        detail.error?.status ||
        `HTTP_${response.status}`;
      const message =
        detail.error?.message ||
        detail.error?.errors?.[0]?.message ||
        `Gmail API request failed (${response.status})`;
      const retryAfter = this.retryAfter(response);
      const throttled =
        response.status === 429 ||
        /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason);

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        forceRefresh = true;
        continue;
      }
      if ((throttled || response.status >= 500) && attempt++ < maxRetries) {
        await sleep((retryAfter ?? Math.min(60, 2 ** attempt)) * 1_000);
        continue;
      }
      if (
        response.status === 401 ||
        (response.status === 403 &&
          /authError|insufficientPermissions|invalidCredentials|unauthorized/i.test(
            reason,
          ))
      )
        await this.requireAuthorization(mailboxId, reason, message);
      throw new GoogleApiError(
        throttled ? 429 : response.status,
        reason,
        message,
        retryAfter,
        body,
      );
    }
  }

  async gmailProfile(accessToken: string): Promise<{
    emailAddress: string;
    historyId: string;
    messagesTotal?: number;
    threadsTotal?: number;
  }> {
    return this.publicRequest(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      accessToken,
      "GOOGLE_GMAIL_PROFILE_FAILED",
      "无法读取 Gmail 邮箱资料",
    );
  }

  async userInfo(accessToken: string): Promise<{
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  }> {
    return this.publicRequest(
      "https://openidconnect.googleapis.com/v1/userinfo",
      accessToken,
      "GOOGLE_USERINFO_FAILED",
      "无法读取 Google 账户资料",
    );
  }

  async requireAuthorization(
    mailboxId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.prisma.mailbox
      .updateMany({
        where: { id: mailboxId, provider: "GOOGLE" },
        data: {
          status: "AUTH_REQUIRED",
          lastErrorCode: code.slice(0, 200),
          lastErrorMessage: message.slice(0, 1_000),
        },
      })
      .catch(() => undefined);
    await this.prisma.autoReplyTask
      .updateMany({
        where: {
          mailboxId,
          status: { in: ["RUNNING", "INITIALIZING"] },
        },
        data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
      })
      .catch(() => undefined);
    await this.prisma.$executeRaw`
      DELETE FROM "TransactionalOutbox" AS outbox
      USING "MessageReceipt" AS receipt
      WHERE outbox."aggregateId" = receipt."id"
        AND receipt."mailboxId" = ${mailboxId}
        AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
    `.catch(() => undefined);
    await this.alerts.open({
      fingerprint: `mailbox-auth:${mailboxId}`,
      type: "MAILBOX_AUTH_REQUIRED",
      severity: "CRITICAL",
      title: "邮箱需要重新授权",
      message: "Google 授权已失效，自动回复已暂停。",
      metadata: { mailboxId, code },
    });
  }

  private async config() {
    const app = await this.prisma.googleAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!app)
      throw new AppError(
        "GOOGLE_NOT_CONFIGURED",
        "请先配置 Google Client ID 和 Client Secret",
        409,
      );
    return app;
  }

  private async readToken(
    mailboxId: string,
    encrypted: string,
  ): Promise<GoogleTokenCache> {
    try {
      const parsed = JSON.parse(
        await this.crypto.decryptString(encrypted, `google-token:${mailboxId}`),
      ) as GoogleTokenCache;
      if (!parsed || typeof parsed !== "object")
        throw new Error("invalid token");
      return parsed;
    } catch {
      await this.requireAuthorization(
        mailboxId,
        "GOOGLE_TOKEN_CACHE_INVALID",
        "Google 授权缓存无法读取",
      );
      throw new AppError("MAILBOX_AUTH_REQUIRED", "邮箱需要重新授权", 409);
    }
  }

  private tokenCache(
    response: GoogleTokenResponse,
    refreshToken: string,
    previous?: GoogleTokenCache,
  ): GoogleTokenCache {
    return {
      accessToken: response.access_token,
      refreshToken,
      expiresAt:
        Date.now() + Math.max(60, response.expires_in ?? 3_600) * 1_000,
      scope: response.scope ?? previous?.scope,
      tokenType: response.token_type ?? previous?.tokenType,
      idToken: response.id_token ?? previous?.idToken,
    };
  }

  private async tokenRequest(
    body: URLSearchParams,
  ): Promise<GoogleTokenResponse> {
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new GoogleApiError(
        0,
        "GOOGLE_OAUTH_NETWORK_ERROR",
        error instanceof Error ? error.message : "Google OAuth network error",
      );
    }
    const result = (await response
      .json()
      .catch(() => ({}))) as GoogleTokenResponse;
    if (!response.ok)
      throw new GoogleApiError(
        response.status,
        result.error || `HTTP_${response.status}`,
        result.error_description || "Google OAuth token request failed",
        this.retryAfter(response),
      );
    return result;
  }

  private async publicRequest<T>(
    url: string,
    accessToken: string,
    code: string,
    message: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new GoogleApiError(
        0,
        code,
        error instanceof Error ? error.message : message,
      );
    }
    if (!response.ok) throw new AppError(code, message, 502);
    return response.json() as Promise<T>;
  }

  private gmailUrl(pathOrUrl: string): string {
    if (!pathOrUrl.startsWith("https://")) {
      if (!pathOrUrl.startsWith("/"))
        throw new GoogleApiError(
          0,
          "GOOGLE_URL_REJECTED",
          "Gmail API 路径格式无效",
        );
      return `https://gmail.googleapis.com/gmail/v1/users/me${pathOrUrl}`;
    }
    let parsed: URL;
    try {
      parsed = new URL(pathOrUrl);
    } catch {
      throw new GoogleApiError(
        0,
        "GOOGLE_URL_REJECTED",
        "Gmail API URL 格式无效",
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "gmail.googleapis.com" ||
      parsed.username ||
      parsed.password
    )
      throw new GoogleApiError(
        0,
        "GOOGLE_URL_REJECTED",
        "拒绝向非 Gmail API 主机发送邮箱授权",
      );
    return parsed.toString();
  }

  private retryAfter(response: Response): number | undefined {
    const value = response.headers.get("retry-after");
    if (!value) return undefined;
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds)) return Math.max(1, seconds);
    const date = Date.parse(value);
    return Number.isFinite(date)
      ? Math.max(1, Math.ceil((date - Date.now()) / 1_000))
      : undefined;
  }

  private errorCode(error: unknown): string {
    if (error instanceof ProviderApiError) return error.code;
    if (typeof error === "object" && error && "code" in error)
      return String((error as { code: unknown }).code);
    return error instanceof Error ? error.name : "GOOGLE_REFRESH_FAILED";
  }

  private isAuthorizationFailure(error: unknown): boolean {
    if (error instanceof ProviderApiError)
      return (
        [400, 401].includes(error.status) &&
        /invalid_grant|invalid_client|unauthorized_client|invalid_token/i.test(
          `${error.code} ${error.message}`,
        )
      );
    return false;
  }
}
