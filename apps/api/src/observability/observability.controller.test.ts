import { describe, expect, it, vi } from "vitest";
import { ObservabilityController } from "./observability.controller.js";

describe("ObservabilityController pagination", () => {
  it("paginates alerts with caller-selected page size", async () => {
    const prisma = {
      alert: {
        findMany: vi.fn().mockResolvedValue([{ id: "alert-21" }]),
        count: vi.fn().mockResolvedValue(101),
      },
      $transaction: vi.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    };
    const controller = new ObservabilityController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.alerts("3", "10", "OPEN");

    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "OPEN" },
        skip: 20,
        take: 10,
      }),
    );
    expect(result).toEqual({
      items: [{ id: "alert-21" }],
      total: 101,
      page: 3,
      pageSize: 10,
    });
  });

  it("caps audit log page size at 100", async () => {
    const prisma = {
      auditLog: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    };
    const controller = new ObservabilityController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.auditLogs("2", "500");

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 100 }),
    );
    expect(result.pageSize).toBe(100);
  });
});
