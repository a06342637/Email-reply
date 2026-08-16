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

  it("paginates processing logs without loading the full result set", async () => {
    const prisma = {
      processingLog: {
        findMany: vi.fn().mockResolvedValue([{ id: "log-91" }]),
        count: vi.fn().mockResolvedValue(240),
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

    const result = await controller.processingLogs("4", "30");

    expect(prisma.processingLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 90, take: 30 }),
    );
    expect(result).toEqual({
      items: [{ id: "log-91" }],
      total: 240,
      page: 4,
      pageSize: 30,
    });
  });

  it("paginates system logs while keeping filter metadata available", async () => {
    const prisma = {
      systemLog: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "system-log-101" }])
          .mockResolvedValueOnce([{ component: "worker" }]),
        count: vi.fn().mockResolvedValue(205),
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

    const result = await controller.systemLogs("2", "100");

    expect(prisma.systemLog.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ skip: 100, take: 100 }),
    );
    expect(result).toEqual({
      items: [{ id: "system-log-101" }],
      total: 205,
      page: 2,
      pageSize: 100,
      components: ["worker"],
    });
  });
});
