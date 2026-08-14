export type ApiError = {
  error?: { code?: string; message?: string; requestId?: string };
};

const initialCsrf = document.cookie.match(
  /(?:^|; )autoreply_csrf=([^;]+)/,
)?.[1];
let csrfToken = initialCsrf ? decodeURIComponent(initialCsrf) : "";

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
    const body = contentType.includes("json")
      ? ((await response.json()) as ApiError)
      : null;
    const error = new Error(
      body?.error?.message || `请求失败（HTTP ${response.status}）`,
    ) as Error & { code?: string; status?: number };
    error.code = body?.error?.code;
    error.status = response.status;
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
