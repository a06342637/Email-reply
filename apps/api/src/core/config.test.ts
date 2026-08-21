import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  AppConfig,
  contentSecurityPolicyDirectives,
  normalizePublicUrl,
  requestPublicOrigin,
} from "./config.js";

describe("normalizePublicUrl", () => {
  it("accepts an HTTPS origin and removes a trailing slash", () => {
    expect(normalizePublicUrl(" https://mail.example.com/ ")).toBe(
      "https://mail.example.com",
    );
    expect(normalizePublicUrl("https://mail.example.com:8443")).toBe(
      "https://mail.example.com:8443",
    );
  });

  it("allows an empty value before Microsoft OAuth is configured", () => {
    expect(normalizePublicUrl("   ")).toBe("");
  });

  it.each([
    "http://mail.example.com",
    "https://user@mail.example.com",
    "https://mail.example.com/base",
    "https://mail.example.com?next=/",
    "https://mail.example.com/#callback",
  ])("rejects a non-origin public URL: %s", (value) => {
    expect(() => normalizePublicUrl(value)).toThrow(
      "PUBLIC_URL must be a valid HTTPS origin",
    );
  });
});

describe("contentSecurityPolicyDirectives", () => {
  it("never sends upgrade-insecure-requests so plain HTTP access keeps working", () => {
    // Helmet keeps upgrade-insecure-requests through useDefaults. On an IP-only
    // deployment it rewrites the same-origin bundle requests to an HTTPS port
    // that does not exist, which leaves the operator with a blank page. The
    // frontend only loads same-origin relative assets, so the directive has no
    // mixed content to protect when the console is opened over HTTPS.
    const directives = contentSecurityPolicyDirectives();
    expect(directives.upgradeInsecureRequests).toBeNull();
    expect(directives.scriptSrc).toEqual(["'self'"]);
    expect(directives.frameAncestors).toEqual(["'none'"]);
    expect(directives.objectSrc).toEqual(["'none'"]);
  });
});

describe("requestPublicOrigin", () => {
  const request = (headers: Record<string, string>, secure = false): Request =>
    ({
      secure,
      header: (name: string) => headers[name.toLowerCase()],
    }) as unknown as Request;

  it("derives the origin a reverse proxy or tunnel forwarded", () => {
    expect(
      requestPublicOrigin(
        request({
          host: "mail.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://mail.example.com");
  });

  it("prefers the forwarded host and keeps a non-default port", () => {
    expect(
      requestPublicOrigin(
        request({
          host: "127.0.0.1:8080",
          "x-forwarded-host": "mail.example.com:8443",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://mail.example.com:8443");
  });

  it("reads only the first hop of a forwarded header chain", () => {
    expect(
      requestPublicOrigin(
        request({
          host: "mail.example.com",
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "mail.example.com, inner.internal",
        }),
      ),
    ).toBe("https://mail.example.com");
  });

  it("accepts a direct TLS connection without forwarded headers", () => {
    expect(
      requestPublicOrigin(request({ host: "mail.example.com" }, true)),
    ).toBe("https://mail.example.com");
  });

  it("refuses to derive an origin from plain HTTP access", () => {
    // OAuth callbacks must never fall back to an http:// redirect URI.
    expect(requestPublicOrigin(request({ host: "203.0.113.10:8080" }))).toBe(
      "",
    );
    expect(
      requestPublicOrigin(
        request({ host: "mail.example.com", "x-forwarded-proto": "http" }),
      ),
    ).toBe("");
  });

  it("returns an empty origin when no host is present", () => {
    expect(requestPublicOrigin(request({ "x-forwarded-proto": "https" }))).toBe(
      "",
    );
  });
});

describe("AppConfig proxy defaults", () => {
  it("does not trust forwarded headers unless explicitly configured", () => {
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      expect(new AppConfig().trustProxy).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = previous;
    }
  });

  it("derives a migration-safe updater token when an older env has no token", () => {
    const previousKey = process.env.INSTANCE_KEY;
    const previousToken = process.env.UPDATER_TOKEN;
    process.env.INSTANCE_KEY = Buffer.alloc(32, 7).toString("base64");
    delete process.env.UPDATER_TOKEN;
    try {
      expect(new AppConfig().updaterToken).toMatch(/^[a-f0-9]{64}$/);
      process.env.UPDATER_TOKEN = "x".repeat(64);
      expect(new AppConfig().updaterToken).toBe("x".repeat(64));
    } finally {
      if (previousKey === undefined) delete process.env.INSTANCE_KEY;
      else process.env.INSTANCE_KEY = previousKey;
      if (previousToken === undefined) delete process.env.UPDATER_TOKEN;
      else process.env.UPDATER_TOKEN = previousToken;
    }
  });
});
