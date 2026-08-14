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

  it("rebuilds verification when an interrupted receipt reaches a process job", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      messageReceipt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "receipt-1",
          state: "SENDING",
          attempts: [
            {
              id: "attempt-1",
              draftMessageId: "draft-1",
              verificationPhase: null,
              verificationStage: 0,
            },
          ],
        }),
      },
      transactionalOutbox: { upsert },
    };
    const service = new OutboxDispatcherService(prisma as never, {} as never);

    await expect(service.recoverInterruptedReceipt("receipt-1")).resolves.toBe(
      true,
    );
    expect(upsert).toHaveBeenCalledWith({
      where: { dedupeKey: "verify:attempt-1:0:SEND" },
      create: expect.objectContaining({
        kind: "VERIFY_SEND",
        aggregateId: "receipt-1",
        dedupeKey: "verify:attempt-1:0:SEND",
        payload: {
          receiptId: "receipt-1",
          attemptId: "attempt-1",
          stage: 0,
          phase: "SEND",
        },
        availableAt: expect.any(Date),
      }),
      update: {},
    });
  });

  it("uses a successor key when an interrupted receipt has no attempt", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      messageReceipt: {
        findUnique: vi.fn().mockResolvedValue({
          id: "receipt-1",
          state: "CREATING_DRAFT",
          attempts: [],
        }),
        updateMany,
      },
      transactionalOutbox: { upsert },
      $transaction: vi.fn((operations) => Promise.all(operations)),
    };
    const service = new OutboxDispatcherService(prisma as never, {} as never);

    await expect(
      service.recoverInterruptedReceipt("receipt-1", "current-outbox"),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      where: {
        dedupeKey: "recovery-process:receipt-1:current-outbox",
      },
      create: {
        kind: "PROCESS_MESSAGE",
        aggregateId: "receipt-1",
        dedupeKey: "recovery-process:receipt-1:current-outbox",
        payload: { receiptId: "receipt-1" },
      },
      update: {},
    });
  });
});
