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

export const GRAPH_SCOPES = ["User.Read", "Mail.ReadWrite", "Mail.Send"];

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
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
    const app = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: "singleton" },
    });
    if (!app)
      throw new AppError(
        "MICROSOFT_NOT_CONFIGURED",
        "请先配置 Microsoft Client ID 和 Client Secret",
        409,
      );

    const cca = await this.createClient(
      app.clientId,
      app.clientSecretEncrypted,
    );
    const cache = cca.getTokenCache();
    const serialized = await this.crypto.decryptString(
      mailbox.tokenCacheEncrypted,
      `msal:${mailbox.id}`,
    );
    cache.deserialize(serialized);
    const account = await cache.getAccountByHomeId(mailbox.homeAccountId);
    if (!account) {
      await this.requireAuthorization(
        mailbox.id,
        "MSAL_ACCOUNT_MISSING",
        "授权缓存中找不到邮箱账户",
      );
      throw new AppError("MAILBOX_AUTH_REQUIRED", "邮箱需要重新授权", 409);
    }

    try {
      const result = await cca.acquireTokenSilent({
        account,
        scopes: GRAPH_SCOPES,
        forceRefresh,
      });
      const updatedCache = cache.serialize();
      const encryptedCache = await this.crypto.encryptString(
        updatedCache,
        `msal:${mailbox.id}`,
      );
      const persisted = await this.prisma.mailbox.updateMany({
        where: {
          id: mailbox.id,
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
      if (!persisted.count) {
        // Polling and sending can acquire a token at the same time. Never
        // overwrite a newer cache written by the other process; only refresh
        // non-sensitive status metadata when the mailbox is still connected.
        await this.prisma.mailbox.updateMany({
          where: { id: mailbox.id, status: "CONNECTED" },
          data: {
            lastTokenRefreshAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
      }
      return result.accessToken;
    } catch (error) {
      const code = this.errorCode(error);
      const message =
        error instanceof Error ? error.message : "Token refresh failed";
      if (this.isAuthorizationFailure(error)) {
        await this.requireAuthorization(mailbox.id, code, message);
        throw new AppError(
          "MAILBOX_AUTH_REQUIRED",
          "Microsoft 授权已失效，请重新连接邮箱",
          409,
        );
      }
      throw new GraphError(0, code, message);
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
    while (true) {
      const url = this.graphUrl(pathOrUrl);
      const token = await this.accessToken(mailboxId);
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
      if (
        response.status === 401 ||
        (response.status === 403 &&
          /InvalidAuthenticationToken|ErrorAccessDenied/i.test(code))
      ) {
        await this.requireAuthorization(mailboxId, code, message);
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

  async profile(accessToken: string): Promise<{
    id: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  }> {
    const response = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new AppError(
        "MICROSOFT_PROFILE_FAILED",
        "无法读取 Microsoft 邮箱资料",
        502,
      );
    return response.json() as Promise<{
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    }>;
  }

  async requireAuthorization(
    mailboxId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.prisma.mailbox
      .update({
        where: { id: mailboxId },
        data: {
          status: "AUTH_REQUIRED",
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 1000),
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
    const receiptIds = await this.prisma.messageReceipt
      .findMany({ where: { mailboxId }, select: { id: true } })
      .then((rows) => rows.map((row) => row.id))
      .catch(() => [] as string[]);
    if (receiptIds.length) {
      await this.prisma.transactionalOutbox
        .deleteMany({
          where: {
            aggregateId: { in: receiptIds },
            kind: { in: ["PROCESS_MESSAGE", "VERIFY_SEND"] },
          },
        })
        .catch(() => undefined);
    }
    await this.alerts.open({
      fingerprint: `mailbox-auth:${mailboxId}`,
      type: "MAILBOX_AUTH_REQUIRED",
      severity: "CRITICAL",
      title: "邮箱需要重新授权",
      message: "Microsoft 授权已失效，自动回复已暂停。",
      metadata: { mailboxId, code },
    });
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
    if (typeof error === "object" && error && "errorCode" in error)
      return String((error as { errorCode: unknown }).errorCode);
    return "MSAL_REFRESH_FAILED";
  }

  private isAuthorizationFailure(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as {
      errorCode?: unknown;
      subError?: unknown;
      errorMessage?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const text = [
      candidate.errorCode,
      candidate.subError,
      candidate.errorMessage,
      candidate.message,
      candidate.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /interaction_required|consent_required|login_required|invalid_grant|invalid_client|unauthorized_client|client_secret|no_tokens_found|token_refresh_required|account.*missing/.test(
      text,
    );
  }
}
