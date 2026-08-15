import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  latestReleaseTag,
  normalizeRepositoryUrl,
  parseReleaseVersion,
  releaseVersionFromTag,
  replaceEnvValue,
  sanitizeUpdaterLog,
} from "./updater-core.js";

describe("updater version helpers", () => {
  it("parses the public two-part version scheme", () => {
    expect(parseReleaseVersion("v0.07")).toEqual({
      major: 0,
      minor: 7,
      normalized: "0.07",
    });
    expect(parseReleaseVersion("1.12")?.normalized).toBe("1.12");
    expect(parseReleaseVersion("0.0.7")).toBeNull();
    expect(parseReleaseVersion("release-1")).toBeNull();
  });

  it("sorts numeric release tags instead of comparing strings", () => {
    expect(latestReleaseTag(["v0.09", "v0.10", "invalid", "v0.07"])).toBe(
      "v0.10",
    );
    expect(compareReleaseVersions("0.10", "0.09")).toBeGreaterThan(0);
    expect(releaseVersionFromTag("v2.03")).toBe("2.03");
  });
});

describe("updater safety helpers", () => {
  it("normalizes supported GitHub remote formats", () => {
    expect(
      normalizeRepositoryUrl("git@github.com:a06342637/Email-reply.git"),
    ).toBe("https://github.com/a06342637/email-reply");
    expect(
      normalizeRepositoryUrl("https://github.com/a06342637/Email-reply.git/"),
    ).toBe("https://github.com/a06342637/email-reply");
  });

  it("updates one dotenv key without duplicating it", () => {
    expect(
      replaceEnvValue("A=1\nAPP_VERSION=0.06\n", "APP_VERSION", "0.07"),
    ).toBe("A=1\nAPP_VERSION=0.07\n");
    expect(replaceEnvValue("A=1\n", "PROJECT_DIR", "/opt/app")).toBe(
      "A=1\nPROJECT_DIR=/opt/app\n",
    );
  });

  it("redacts suspicious command output", () => {
    expect(sanitizeUpdaterLog("Build completed")).toBe("Build completed");
    expect(sanitizeUpdaterLog("TOKEN=abc")).toContain("已隐藏");
  });
});
