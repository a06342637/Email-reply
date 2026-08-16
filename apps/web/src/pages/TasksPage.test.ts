import { describe, expect, it } from "vitest";
import { writableRules } from "./task-utils";

describe("task rule payload", () => {
  it("strips database-only fields before saving a task", () => {
    const result = writableRules([
      {
        id: "rule-1",
        name: "Priority",
        enabled: true,
        templateId: "template-1",
        priority: 0,
        conditions: { folders: ["inbox"] },
        template: { name: "Default" },
        taskId: "task-1",
        createdAt: "2026-08-16T00:00:00.000Z",
      } as never,
    ]);

    expect(result).toEqual([
      {
        id: "rule-1",
        name: "Priority",
        enabled: true,
        templateId: "template-1",
        conditions: { folders: ["inbox"] },
      },
    ]);
  });
});
