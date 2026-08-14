import { describe, expect, it, vi } from "vitest";
import { GoogleApiError } from "../google/gmail-api.service.js";
import { GmailPollService } from "./gmail-poll.service.js";

function task() {
  return {
    id: "task-1",
    mailboxId: "mailbox-1",
    status: "RUNNING",
    pollIntervalSeconds: 10,
    averagePollLatencyMs: null,
    consecutiveFailures: 0,
    activationAt: new Date("2026-08-15T00:00:00.000Z"),
    mailbox: {
      id: "mailbox-1",
      provider: "GOOGLE",
      status: "CONNECTED",
      email: "owner@gmail.com",
    },
    defaultTemplate: {
      id: "template-1",
      name: "默认模板",
      publishedRevisionId: "revision-1",
      publishedRevision: { id: "revision-1" },
    },
    rules: [],
  };
}

function fixture(options: {
  initialized: boolean;
  withMessage?: boolean;
  withPageToken?: boolean;
}) {
  const currentTask = task();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ status: "RUNNING" }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    messageReceipt: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: "receipt-1",
          subject: data.subject,
          state: data.state,
        }),
      ),
    },
    processingLog: { create: vi.fn().mockResolvedValue({}) },
    transactionalOutbox: { create: vi.fn().mockResolvedValue({}) },
    gmailCursor: {
      findUnique: vi.fn().mockResolvedValue({ highWaterAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    autoReplyTask: {
      findUnique: vi.fn().mockResolvedValue(currentTask),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    gmailCursor: {
      upsert: vi.fn().mockResolvedValue(
        options.initialized
          ? {
              mailboxId: "mailbox-1",
              historyIdEncrypted: "encrypted-history",
              pageTokenEncrypted: options.withPageToken
                ? "encrypted-page"
                : null,
              initializedAt: new Date(),
              lastSuccessfulAt: new Date(),
            }
          : {
              mailboxId: "mailbox-1",
              historyIdEncrypted: null,
              pageTokenEncrypted: null,
              initializedAt: null,
              lastSuccessfulAt: null,
            },
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    mailbox: { findUnique: vi.fn().mockResolvedValue({ status: "CONNECTED" }) },
    $transaction: vi.fn((callback) => callback(tx)),
  };
  const crypto = {
    encryptString: vi.fn((value: string, context: string) =>
      Promise.resolve(`encrypted:${context}:${value}`),
    ),
    decryptString: vi.fn().mockResolvedValue("100"),
  };
  const gmail = {
    request: vi.fn().mockImplementation((_id, path: string) => {
      if (path === "/profile")
        return Promise.resolve({
          emailAddress: "owner@gmail.com",
          historyId: "100",
        });
      if (path.startsWith("/history"))
        return Promise.resolve({
          historyId: "101",
          history: options.withMessage
            ? [{ messagesAdded: [{ message: { id: "message-1" } }] }]
            : [],
        });
      if (path.startsWith("/messages/message-1"))
        return Promise.resolve({
          id: "message-1",
          threadId: "thread-1",
          labelIds: ["SPAM"],
          internalDate: String(new Date("2026-08-15T00:01:00.000Z").getTime()),
          payload: {
            headers: [
              { name: "Message-ID", value: "<message-1@example.net>" },
              { name: "From", value: "Customer <customer@example.net>" },
              { name: "Subject", value: "Need help" },
              { name: "Return-Path", value: "<customer@example.net>" },
            ],
          },
        });
      if (path.startsWith("/messages?"))
        return Promise.resolve({ messages: [] });
      throw new Error(`Unexpected Gmail path: ${path}`);
    }),
  };
  const filters = {
    evaluate: vi.fn().mockResolvedValue({
      senderName: "Customer",
      senderEmail: "customer@example.net",
      replyToEmail: "customer@example.net",
    }),
    matchRule: vi.fn().mockReturnValue(false),
  };
  const alerts = {
    open: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new GmailPollService(
      prisma as never,
      crypto as never,
      gmail as never,
      filters as never,
      alerts as never,
    ),
    prisma,
    tx,
    crypto,
    gmail,
  };
}

describe("GmailPollService", () => {
  it("establishes a Gmail History baseline without replying to older mail", async () => {
    const { service, prisma, tx, crypto } = fixture({ initialized: false });

    await service.pollTask("task-1");

    expect(prisma.gmailCursor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ initializedAt: null }),
      }),
    );
    expect(crypto.encryptString).toHaveBeenCalledWith(
      "100",
      "gmail-history:mailbox-1",
    );
    expect(tx.messageReceipt.create).not.toHaveBeenCalled();
    expect(prisma.autoReplyTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RUNNING" }),
      }),
    );
  });

  it("maps Gmail SPAM history messages into the shared junk-email queue", async () => {
    const { service, tx } = fixture({ initialized: true, withMessage: true });

    await service.pollTask("task-1");

    expect(tx.messageReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          graphMessageId: "message-1",
          folder: "JUNKEMAIL",
          state: "QUEUED",
          templateRevisionId: "revision-1",
        }),
      }),
    );
    expect(tx.transactionalOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "PROCESS_MESSAGE" }),
      }),
    );
  });

  it("keeps the original recovery query window while a page token is pending", async () => {
    const { service, tx } = fixture({ initialized: true });

    await (service as any).ingestPage(
      task(),
      [
        {
          folder: "INBOX",
          message: {
            id: "message-recovery-1",
            receivedDateTime: "2026-08-15T00:02:00.000Z",
            from: {
              emailAddress: {
                name: "Customer",
                address: "customer@example.net",
              },
            },
            subject: "Recovery page",
          },
        },
      ],
      {
        pageTokenEncrypted: "encrypted-next-page",
        recoveryScan: true,
      },
    );

    expect(tx.gmailCursor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ highWaterAt: undefined }),
      }),
    );
  });

  it("restarts History pagination when a persisted page token has expired", async () => {
    const { service, gmail, prisma } = fixture({
      initialized: true,
      withPageToken: true,
    });
    gmail.request.mockRejectedValueOnce(
      new GoogleApiError(400, "invalidArgument", "Invalid page token"),
    );

    await service.pollTask("task-1");

    const historyPaths = gmail.request.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => path.startsWith("/history?"));
    expect(historyPaths).toHaveLength(2);
    expect(historyPaths[0]).toContain("pageToken=100");
    expect(historyPaths[1]).not.toContain("pageToken=");
    expect(prisma.gmailCursor.update).toHaveBeenCalledWith({
      where: { mailboxId: "mailbox-1" },
      data: { pageTokenEncrypted: null },
    });
  });

  it("restarts a recovery scan when its persisted page token has expired", async () => {
    const { service, gmail, prisma } = fixture({ initialized: true });
    gmail.request.mockRejectedValueOnce(
      new GoogleApiError(400, "invalidArgument", "Invalid page token"),
    );

    await (service as any).scanWindow(
      task(),
      new Date("2026-08-15T00:00:00.000Z"),
      "200",
      "encrypted-page",
    );

    const messagePaths = gmail.request.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => path.startsWith("/messages?"));
    expect(messagePaths).toHaveLength(2);
    expect(messagePaths[0]).toContain("pageToken=100");
    expect(messagePaths[1]).not.toContain("pageToken=");
    expect(prisma.gmailCursor.update).toHaveBeenCalledWith({
      where: { mailboxId: "mailbox-1" },
      data: { pageTokenEncrypted: null },
    });
  });

  it("advances the cursor without causing a transaction error for a duplicate message", async () => {
    const { service, tx } = fixture({ initialized: true, withMessage: true });
    tx.messageReceipt.findFirst.mockResolvedValueOnce({
      id: "existing-receipt",
    });

    await service.pollTask("task-1");

    expect(tx.messageReceipt.create).not.toHaveBeenCalled();
    expect(tx.gmailCursor.update).toHaveBeenCalled();
  });
});
