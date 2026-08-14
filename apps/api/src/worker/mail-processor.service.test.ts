import { describe, expect, it, vi } from "vitest";
import { GraphError } from "../microsoft/graph.service.js";
import { MailProcessorService } from "./mail-processor.service.js";

const baseReceipt = {
  id: "receipt-1",
  state: "QUEUED",
  mailboxId: "mailbox-1",
  graphMessageId: "message-1",
  conversationId: "conversation-1",
  senderName: "Buyer",
  senderEmail: "buyer@example.net",
  replyToEmail: "case-123@replies.example.net",
  subject: "Order question",
  receivedAt: new Date("2026-08-14T10:00:00.000Z"),
  folder: "INBOX",
  trackingId: "tracking-1",
  templateRevisionId: "revision-1",
  task: { status: "RUNNING" },
  mailbox: {
    id: "mailbox-1",
    status: "CONNECTED",
    email: "service@example.com",
    displayName: "Service",
  },
  rule: null,
  templateRevision: { template: { name: "Default" } },
};

function fixture(findResults: unknown[], render: () => Promise<unknown>) {
  const tx = {
    messageReceipt: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    replyAttempt: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "attempt-1" }),
    },
  };
  const prisma = {
    messageReceipt: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    replyAttempt: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    transactionalOutbox: { upsert: vi.fn().mockResolvedValue({}) },
    processingLog: { create: vi.fn().mockResolvedValue({}) },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === "function")
        return (input as (client: typeof tx) => Promise<unknown>)(tx);
      return Promise.all(input as Array<Promise<unknown>>);
    }),
  };
  for (const result of findResults)
    prisma.messageReceipt.findUnique.mockResolvedValueOnce(result);
  const templates = { renderForReply: vi.fn(render) };
  const transport = {
    createReplyDraft: vi.fn(),
    uploadAssets: vi.fn(),
    sendDraft: vi.fn(),
    getMessage: vi.fn(),
    findDraftByTracking: vi.fn(),
    findSentByTracking: vi.fn(),
  };
  const service = new MailProcessorService(
    prisma as never,
    { timezone: "Asia/Shanghai" } as never,
    templates as never,
    transport as never,
    { resolve: vi.fn(), open: vi.fn() } as never,
    { assertOpen: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, prisma, templates, transport };
}

describe("MailProcessorService", () => {
  it("turns a deterministic template render failure into a retryable confirmed failure", async () => {
    const { service, prisma, transport } = fixture(
      [baseReceipt, baseReceipt, baseReceipt],
      async () => {
        throw new Error("Liquid render failed");
      },
    );

    await service.process(baseReceipt.id);

    expect(transport.createReplyDraft).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FAILED_CONFIRMED",
          lastErrorCode: "TEMPLATE_RENDER_FAILED",
        }),
      }),
    );
  });

  it("sends an ordinary reply to Reply-To while keeping From as the sender identity", async () => {
    const { service, transport } = fixture(
      [
        baseReceipt,
        baseReceipt,
        { task: { status: "RUNNING" }, mailbox: { status: "CONNECTED" } },
        baseReceipt,
      ],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );
    transport.createReplyDraft.mockRejectedValue(
      new GraphError(400, "ErrorInvalidRequest", "Rejected before send"),
    );

    await service.process(baseReceipt.id);

    expect(transport.createReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: "case-123@replies.example.net",
      }),
    );
  });

  it("keeps a definitely unsent message queued when Microsoft authorization expires", async () => {
    const { service, prisma, transport } = fixture(
      [
        baseReceipt,
        baseReceipt,
        { task: { status: "RUNNING" }, mailbox: { status: "CONNECTED" } },
      ],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );
    transport.createReplyDraft.mockRejectedValue(
      new GraphError(401, "InvalidAuthenticationToken", "Expired"),
    );

    await service.process(baseReceipt.id);

    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "QUEUED" }),
      }),
    );
  });

  it("treats an unrelated Microsoft access denial as a confirmed send failure", async () => {
    const { service, prisma, transport } = fixture(
      [
        baseReceipt,
        baseReceipt,
        { task: { status: "RUNNING" }, mailbox: { status: "CONNECTED" } },
        baseReceipt,
      ],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );
    transport.createReplyDraft.mockRejectedValue(
      new GraphError(
        403,
        "ErrorAccessDenied",
        "Operation is not allowed for this message",
      ),
    );

    await service.process(baseReceipt.id);

    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FAILED_CONFIRMED",
          lastErrorCode: "ErrorAccessDenied",
        }),
      }),
    );
  });

  it("keeps a claimed message queued when the task is paused before draft creation", async () => {
    const pausedReceipt = {
      ...baseReceipt,
      task: { status: "PAUSED" },
    };
    const { service, prisma, transport } = fixture(
      [baseReceipt, pausedReceipt],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );

    await service.process(baseReceipt.id);

    expect(transport.createReplyDraft).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "QUEUED",
          lastErrorCode: "SEND_DEFERRED_INACTIVE",
        }),
      }),
    );
  });

  it("does not send a draft again when a duplicate create verification sees an attempt already sending", async () => {
    const { service, prisma, transport } = fixture([baseReceipt], async () => ({
      subject: "Re: Order question",
      html: "<p>Received</p>",
      text: "Received",
      assets: [],
    }));
    prisma.replyAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      receiptId: baseReceipt.id,
      state: "SENDING",
      draftMessageId: "draft-1",
      sentAcceptedAt: null,
      startedAt: new Date("2026-08-14T10:00:01.000Z"),
      uploadedAssetIds: [],
    });
    transport.getMessage.mockResolvedValue({
      id: "draft-1",
      isDraft: true,
    });

    await service.verify(baseReceipt.id, "attempt-1", 0, "CREATE");

    expect(transport.sendDraft).not.toHaveBeenCalled();
    expect(prisma.transactionalOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({ phase: "SEND", stage: 1 }),
        }),
      }),
    );
  });

  it("preserves a send verification until the mailbox is reauthorized", async () => {
    const { service, prisma, transport } = fixture([baseReceipt], async () => ({
      subject: "Re: Order question",
      html: "<p>Received</p>",
      text: "Received",
      assets: [],
    }));
    prisma.replyAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      receiptId: baseReceipt.id,
      state: "SENDING",
      draftMessageId: "draft-1",
      sentAcceptedAt: new Date("2026-08-14T10:00:02.000Z"),
      startedAt: new Date("2026-08-14T10:00:01.000Z"),
      uploadedAssetIds: [],
    });
    transport.getMessage.mockRejectedValue(
      new GraphError(401, "InvalidAuthenticationToken", "Expired"),
    );

    await service.verify(baseReceipt.id, "attempt-1", 0, "SEND");

    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "InvalidAuthenticationToken",
          completedAt: null,
        }),
      }),
    );
    expect(prisma.messageReceipt.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "UNCERTAIN" }),
      }),
    );
    expect(prisma.transactionalOutbox.upsert).not.toHaveBeenCalled();
  });
});
