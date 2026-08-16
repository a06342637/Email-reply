export type ApiError = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: unknown;
  };
};

const initialCsrf = document.cookie.match(
  /(?:^|; )autoreply_csrf=([^;]+)/,
)?.[1];
let csrfToken = initialCsrf ? decodeURIComponent(initialCsrf) : "";
export const AUTH_REQUIRED_EVENT = "autoreply:auth-required";

function isLoginRequest(path: string): boolean {
  return path.split(/[?#]/, 1)[0]?.endsWith("/auth/login") ?? false;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  )
    headers.set("content-type", "application/json");
  if (
    !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()) &&
    csrfToken
  )
    headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    if (response.status === 401 && !isLoginRequest(path)) {
      csrfToken = "";
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    const body = contentType.includes("json")
      ? (((await response.json().catch(() => null)) as ApiError | null) ?? null)
      : null;
    const diagnostics = [
      body?.error?.code,
      body?.error?.requestId ? `请求 ID ${body.error.requestId}` : undefined,
    ].filter(Boolean);
    const fallbackMessage = [502, 504].includes(response.status)
      ? `网关未收到应用的有效响应（HTTP ${response.status}），请检查 app 容器、反向代理超时和服务器出网`
      : `请求失败（HTTP ${response.status}）`;
    const error = new Error(
      body?.error?.message
        ? `${body.error.message}${diagnostics.length ? `（${diagnostics.join(" · ")}）` : ""}`
        : fallbackMessage,
    ) as Error & {
      code?: string;
      status?: number;
      requestId?: string;
      details?: unknown;
    };
    error.code = body?.error?.code;
    error.status = response.status;
    error.requestId = body?.error?.requestId;
    error.details = body?.error?.details;
    throw error;
  }
  const value =
    response.status === 204
      ? undefined
      : contentType.includes("json")
        ? await response.json()
        : await response.text();
  if (
    path.endsWith("/auth/login") &&
    typeof value === "object" &&
    value &&
    "csrfToken" in value
  )
    csrfToken = String((value as { csrfToken: unknown }).csrfToken);
  return value as T;
}

export function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function currentCsrf(): string {
  return csrfToken;
}
