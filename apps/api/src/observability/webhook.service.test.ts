import { describe, expect, it, vi } from "vitest";
import { WebhookService } from "./webhook.service.js";

describe("WebhookService", () => {
  it("fans one alert out into endpoint-specific durable jobs", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      transactionalOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "outbox-parent",
          kind: "WEBHOOK",
          availableAt: new Date("2026-08-14T09:00:00.000Z"),
          payload: { event: "TASK_CIRCUIT_OPEN", alertId: "alert-1" },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      alert: {
        findUnique: vi.fn().mockResolvedValue({
          id: "alert-1",
          severity: "CRITICAL",
          status: "OPEN",
          title: "Task stopped",
          message: "Polling failed",
          lastSeenAt: new Date("2026-08-14T10:00:00.000Z"),
        }),
      },
      webhookEndpoint: {
        findMany: vi.fn().mockResolvedValue([
          { id: "endpoint-1", eventTypes: ["*"] },
          { id: "endpoint-2", eventTypes: ["TASK_CIRCUIT_OPEN"] },
          { id: "endpoint-3", eventTypes: ["OTHER_EVENT"] },
        ]),
      },
      $transaction: vi.fn(async (action: (tx: unknown) => Promise<void>) =>
        action({ transactionalOutbox: { upsert, deleteMany } }),
      ),
    };
    const service = new WebhookService(prisma as never, {} as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await service.deliver("outbox-parent");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({ endpointId: "endpoint-1" }),
        }),
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({ endpointId: "endpoint-2" }),
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "outbox-parent" } });
    fetchSpy.mockRestore();
  });
});
