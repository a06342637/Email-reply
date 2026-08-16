import { describe, expect, it } from "vitest";
import { isFinishedUpdatePhase, shouldReloadAfterUpdate } from "./update-state";

describe("online update page refresh state", () => {
  it("reloads only after the version started by this browser succeeds", () => {
    expect(shouldReloadAfterUpdate("SUCCEEDED", "0.18", "0.18")).toBe(true);
    expect(shouldReloadAfterUpdate("SUCCEEDED", "0.17", "0.18")).toBe(false);
    expect(shouldReloadAfterUpdate("FAILED", "0.17", "0.18")).toBe(false);
    expect(shouldReloadAfterUpdate("SUCCEEDED", "0.18", null)).toBe(false);
  });

  it("clears pending browser state after every terminal result", () => {
    expect(isFinishedUpdatePhase("SUCCEEDED")).toBe(true);
    expect(isFinishedUpdatePhase("FAILED")).toBe(true);
    expect(isFinishedUpdatePhase("ROLLED_BACK")).toBe(true);
    expect(isFinishedUpdatePhase("HEALTH_CHECK")).toBe(false);
  });
});
