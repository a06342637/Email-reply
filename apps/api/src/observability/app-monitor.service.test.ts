import { describe, expect, it, vi } from "vitest";
import { AppMonitorService } from "./app-monitor.service.js";

describe("AppMonitorService", () => {
  it("skips leased webhook rows so later endpoints are not starved", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "leased-or-failed-endpoint" }])
      .mockResolvedValueOnce([{ id: "next-endpoint" }]);
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("delivery lease unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = new AppMonitorService(
      { transactionalOutbox: { findMany } } as never,
      {} as never,
      {} as never,
      { deliver } as never,
    );

    await (
      service as unknown as { deliverDirect(alertId: string): Promise<void> }
    ).deliverDirect("alert-1");

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        kind: "WEBHOOK",
        aggregateId: "alert-1",
        availableAt: { lte: expect.any(Date) },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    expect(deliver).toHaveBeenNthCalledWith(1, "leased-or-failed-endpoint");
    expect(deliver).toHaveBeenNthCalledWith(2, "next-endpoint");
  });
});
