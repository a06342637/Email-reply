import { describe, expect, it, vi } from "vitest";
import { OutboxDispatcherService } from "./queue.service.js";

describe("OutboxDispatcherService acknowledgement", () => {
  it("does not acknowledge the current verify row as its own successor", async () => {
    const prisma = {
      messageReceipt: {
        findUnique: vi.fn().mockResolvedValue({ state: "SENDING" }),
      },
      transactionalOutbox: {
        count: vi
          .fn()
          .mockImplementation(({ where }) =>
            where.id?.not === "verify-current" ? 0 : 1,
          ),
      },
    };
    const service = new OutboxDispatcherService(prisma as never, {} as never);

    const acknowledged = await (service as any).canAcknowledge({
      kind: "VERIFY_SEND",
      aggregateId: "receipt-1",
      outboxId: "verify-current",
    });

    expect(acknowledged).toBe(false);
    expect(prisma.transactionalOutbox.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "verify-current" } }),
      }),
    );
  });

  it("acknowledges outbox work for terminal receipts", async () => {
    const prisma = {
      messageReceipt: {
        findUnique: vi.fn().mockResolvedValue({ state: "SENT" }),
      },
    };
    const service = new OutboxDispatcherService(prisma as never, {} as never);

    await expect(
      (service as any).canAcknowledge({
        kind: "PROCESS_MESSAGE",
        aggregateId: "receipt-1",
        outboxId: "process-current",
      }),
    ).resolves.toBe(true);
  });
});
