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
