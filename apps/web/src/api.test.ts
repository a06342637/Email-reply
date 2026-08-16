import { afterEach, describe, expect, it, vi } from "vitest";

function browserWindow(): Window {
  return new EventTarget() as unknown as Window;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("api authentication handling", () => {
  it("clears CSRF state and announces an expired authenticated session", async () => {
    const mockedWindow = browserWindow();
    vi.stubGlobal("window", mockedWindow);
    vi.stubGlobal("document", { cookie: "autoreply_csrf=csrf-before-expiry" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { api, AUTH_REQUIRED_EVENT, currentCsrf } = await import("./api");
    const listener = vi.fn();
    mockedWindow.addEventListener(AUTH_REQUIRED_EVENT, listener);

    await expect(api("/api/v1/settings")).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });

    expect(currentCsrf()).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not announce expected login credential failures", async () => {
    const mockedWindow = browserWindow();
    vi.stubGlobal("window", mockedWindow);
    vi.stubGlobal("document", { cookie: "autoreply_csrf=login-csrf" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "INVALID_CREDENTIALS" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const { api, AUTH_REQUIRED_EVENT, currentCsrf } = await import("./api");
    const listener = vi.fn();
    mockedWindow.addEventListener(AUTH_REQUIRED_EVENT, listener);

    await expect(
      api("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      }),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });

    expect(currentCsrf()).toBe("login-csrf");
    expect(listener).not.toHaveBeenCalled();
  });
});
