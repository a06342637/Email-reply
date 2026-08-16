import { describe, expect, it, vi } from "vitest";
import { MailboxService } from "./mailbox.service.js";

describe("MailboxService list", () => {
  it("hides a soft-deleted task so the mailbox can create a new one", async () => {
    const rows = [
      {
        id: "mailbox-1",
        email: "one@example.com",
        task: { status: "DELETED" },
      },
      {
        id: "mailbox-2",
        email: "two@example.com",
        task: { status: "RUNNING" },
      },
    ];
    const prisma = {
      mailbox: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const service = new MailboxService(prisma as never, {} as never);

    const result = await service.list();

    expect(result[0]?.task).toBeNull();
    expect(result[1]?.task).toEqual({ status: "RUNNING" });
  });
});

describe("MailboxService resume", () => {
  it("rebuilds Microsoft delta cursors from before the pause without changing activation time", async () => {
    const task = {
      id: "task-1",
      mailboxId: "mailbox-1",
      status: "PAUSED",
      activationAt: new Date("2026-08-01T00:00:00.000Z"),
      pausedAt: new Date("2026-08-16T00:00:00.000Z"),
      sendTransport: "MAILBOX_API",
      smtpConfigId: null,
      smtpConfig: null,
      mailbox: { status: "CONNECTED", provider: "MICROSOFT" },
      defaultTemplate: { publishedRevisionId: "revision-1" },
    };
    const tx = {
      autoReplyTask: { update: vi.fn().mockResolvedValue(task) },
      folderCursor: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      gmailCursor: { updateMany: vi.fn() },
    };
    const prisma = {
      autoReplyTask: { findUniqueOrThrow: vi.fn().mockResolvedValue(task) },
      folderCursor: {
        count: vi.fn().mockResolvedValue(2),
        findFirst: vi.fn().mockResolvedValue({
          lastSuccessfulAt: new Date("2026-08-15T12:00:00.000Z"),
        }),
      },
      messageReceipt: { findMany: vi.fn().mockResolvedValue([]) },
      transactionalOutbox: { create: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new MailboxService(prisma as never, {} as never);

    await service.resumeTask("task-1");

    expect(tx.autoReplyTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "RUNNING",
        activationAt: task.activationAt,
        pausedAt: null,
      }),
    });
    expect(tx.folderCursor.updateMany).toHaveBeenCalledWith({
      where: { mailboxId: "mailbox-1" },
      data: expect.objectContaining({
        deltaLinkEncrypted: null,
        nextLinkEncrypted: null,
        initializedAt: null,
        highWaterAt: new Date("2026-08-15T11:58:00.000Z"),
      }),
    });
    expect(tx.gmailCursor.updateMany).not.toHaveBeenCalled();
  });

  it("rebuilds the Gmail history cursor from before the pause", async () => {
    const task = {
      id: "task-google-1",
      mailboxId: "mailbox-google-1",
      status: "PAUSED",
      activationAt: new Date("2026-08-01T00:00:00.000Z"),
      pausedAt: new Date("2026-08-16T00:00:00.000Z"),
      sendTransport: "MAILBOX_API",
      smtpConfigId: null,
      smtpConfig: null,
      mailbox: { status: "CONNECTED", provider: "GOOGLE" },
      defaultTemplate: { publishedRevisionId: "revision-1" },
    };
    const tx = {
      autoReplyTask: { update: vi.fn().mockResolvedValue(task) },
      folderCursor: { updateMany: vi.fn() },
      gmailCursor: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      autoReplyTask: { findUniqueOrThrow: vi.fn().mockResolvedValue(task) },
      gmailCursor: {
        findFirst: vi.fn().mockResolvedValue({ id: "cursor-1" }),
        findUnique: vi.fn().mockResolvedValue({
          lastSuccessfulAt: new Date("2026-08-15T12:00:00.000Z"),
        }),
      },
      messageReceipt: { findMany: vi.fn().mockResolvedValue([]) },
      transactionalOutbox: { create: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new MailboxService(prisma as never, {} as never);

    await service.resumeTask("task-google-1");

    expect(tx.gmailCursor.updateMany).toHaveBeenCalledWith({
      where: { mailboxId: "mailbox-google-1" },
      data: expect.objectContaining({
        historyIdEncrypted: null,
        pageTokenEncrypted: null,
        initializedAt: null,
        highWaterAt: new Date("2026-08-15T11:58:00.000Z"),
      }),
    });
    expect(tx.folderCursor.updateMany).not.toHaveBeenCalled();
  });
});
