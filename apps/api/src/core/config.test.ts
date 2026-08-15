import { describe, expect, it } from "vitest";
import { AppConfig, normalizePublicUrl } from "./config.js";

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
});
