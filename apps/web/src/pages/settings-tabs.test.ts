import { describe, expect, it } from "vitest";
import { resolveSettingsTab, settingsTabHref } from "./settings-tabs";

describe("settings tab links", () => {
  it("opens SMTP settings directly from a deep link", () => {
    expect(settingsTabHref("smtp")).toBe("/settings?tab=smtp");
    expect(resolveSettingsTab("smtp")).toBe("smtp");
  });

  it("falls back safely for missing or unknown tabs", () => {
    expect(resolveSettingsTab(null)).toBe("general");
    expect(resolveSettingsTab("unknown")).toBe("general");
    expect(settingsTabHref("general")).toBe("/settings");
  });
});
