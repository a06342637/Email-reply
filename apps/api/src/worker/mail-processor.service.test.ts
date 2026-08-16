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
  internetMessageId: "<source@example.net>",
  trackingId: "tracking-1",
  templateRevisionId: "revision-1",
  task: {
    status: "RUNNING",
    sendTransport: "MAILBOX_API",
    smtpConfigId: null,
  },
  mailbox: {
    id: "mailbox-1",
    status: "CONNECTED",
    provider: "MICROSOFT",
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
      update: vi.fn().mockResolvedValue({}),
    },
    processingLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    messageReceipt: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    replyAttempt: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    transactionalOutbox: { upsert: vi.fn().mockResolvedValue({}) },
    autoReplyTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
  const alerts = { resolve: vi.fn(), open: vi.fn() };
  const smtp = { sendReply: vi.fn() };
  const service = new MailProcessorService(
    prisma as never,
    { timezone: "Asia/Shanghai" } as never,
    templates as never,
    transport as never,
    alerts as never,
    { assertOpen: vi.fn().mockResolvedValue(undefined) } as never,
    smtp as never,
  );
  return { service, prisma, templates, transport, alerts, smtp, tx };
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

  it("does not report SENT until the provider supplies an actual sent timestamp", async () => {
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
    transport.getMessage.mockResolvedValue({
      id: "draft-1",
      isDraft: false,
      sentDateTime: undefined,
    });

    await service.verify(baseReceipt.id, "attempt-1", 0, "SEND");

    expect(prisma.messageReceipt.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "SENT" }),
      }),
    );
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

  it("writes the sent state and processing log only once across duplicate verifications", async () => {
    const { service, prisma, alerts, tx } = fixture([], async () => ({}));
    prisma.messageReceipt.findUniqueOrThrow.mockResolvedValue(baseReceipt);
    tx.messageReceipt.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const markSent = (
      service as unknown as {
        markSent: (
          receiptId: string,
          attemptId: string,
          internetId?: string,
        ) => Promise<void>;
      }
    ).markSent.bind(service);

    await markSent(baseReceipt.id, "attempt-1", "<sent@example.com>");
    await markSent(baseReceipt.id, "attempt-1", "<sent@example.com>");

    expect(tx.replyAttempt.update).toHaveBeenCalledTimes(1);
    expect(tx.processingLog.create).toHaveBeenCalledTimes(1);
    expect(alerts.resolve).toHaveBeenCalledTimes(1);
  });

  it("sends through SMTP with Reply-To and marks the provider-accepted message sent", async () => {
    const smtpReceipt = {
      ...baseReceipt,
      task: {
        status: "RUNNING",
        sendTransport: "SMTP",
        smtpConfigId: "smtp-1",
      },
    };
    const { service, prisma, smtp, transport, tx } = fixture(
      [
        smtpReceipt,
        smtpReceipt,
        { task: { status: "RUNNING" }, mailbox: { status: "CONNECTED" } },
      ],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );
    prisma.messageReceipt.findUniqueOrThrow.mockResolvedValue(smtpReceipt);
    smtp.sendReply.mockResolvedValue({ messageId: "<sent@example.com>" });

    await service.process(baseReceipt.id);

    expect(smtp.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        smtpConfigId: "smtp-1",
        recipient: "case-123@replies.example.net",
        sourceInternetMessageId: "<source@example.net>",
      }),
    );
    expect(transport.createReplyDraft).not.toHaveBeenCalled();
    expect(tx.processingLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SENT",
          reason: expect.stringContaining("SMTP"),
        }),
      }),
    );
  });

  it("keeps a DATA-stage SMTP timeout uncertain instead of retrying it", async () => {
    const smtpReceipt = {
      ...baseReceipt,
      task: {
        status: "RUNNING",
        sendTransport: "SMTP",
        smtpConfigId: "smtp-1",
      },
    };
    const { service, prisma, smtp } = fixture(
      [
        smtpReceipt,
        smtpReceipt,
        { task: { status: "RUNNING" }, mailbox: { status: "CONNECTED" } },
        smtpReceipt,
      ],
      async () => ({
        subject: "Re: Order question",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
      }),
    );
    const { SmtpDeliveryError } =
      await import("../smtp/smtp-delivery.service.js");
    smtp.sendReply.mockRejectedValue(
      new SmtpDeliveryError(
        "SMTP_SEND_STATUS_UNCERTAIN",
        "Connection lost during DATA",
        502,
        true,
      ),
    );

    await service.process(baseReceipt.id);

    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "UNCERTAIN" }),
      }),
    );
    expect(prisma.transactionalOutbox.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ kind: "PROCESS_MESSAGE" }),
      }),
    );
  });

  it("marks an interrupted in-flight SMTP attempt uncertain on worker recovery", async () => {
    const smtpReceipt = {
      ...baseReceipt,
      task: {
        status: "RUNNING",
        sendTransport: "SMTP",
        smtpConfigId: "smtp-1",
      },
    };
    const { service, prisma, smtp } = fixture(
      [smtpReceipt, smtpReceipt],
      async () => ({}),
    );
    prisma.replyAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      receiptId: baseReceipt.id,
      state: "SENDING",
      transport: "SMTP",
      smtpSendStartedAt: new Date("2026-08-16T10:00:00.000Z"),
    });

    await service.verify(baseReceipt.id, "attempt-1", 0, "SEND");

    expect(smtp.sendReply).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "UNCERTAIN" }),
      }),
    );
  });
});
