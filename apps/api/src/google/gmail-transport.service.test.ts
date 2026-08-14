import { describe, expect, it, vi } from "vitest";
import { GoogleApiError } from "./gmail-api.service.js";
import { GmailTransportService } from "./gmail-transport.service.js";

describe("GmailTransportService", () => {
  it("creates a threaded MIME reply with tracking headers and attachments", async () => {
    const request = vi.fn().mockResolvedValue({
      id: "draft-1",
      message: { id: "message-2", threadId: "thread-1" },
    });
    const service = new GmailTransportService({ request } as never);

    await expect(
      service.createReplyDraft({
        mailboxId: "mailbox-1",
        sourceMessageId: "source-1",
        sourceInternetMessageId: "<source@example.com>",
        conversationId: "thread-1",
        mailboxEmail: "owner@gmail.com",
        recipient: "sender@example.net",
        subject: "客户咨询",
        html: '<p><img src="cid:logo-1">您好</p>',
        text: "您好",
        trackingId: "tracking-1",
        instanceId: "instance-1",
        assets: [
          {
            id: "asset-1",
            revisionId: "revision-1",
            fileName: "logo.png",
            contentType: "image/png",
            size: 3,
            inline: true,
            contentId: "logo-1",
            data: Buffer.from([1, 2, 3]),
            createdAt: new Date(),
          },
        ],
      }),
    ).resolves.toMatchObject({ id: "draft-1", isDraft: true });

    const body = JSON.parse(request.mock.calls[0]![2].body as string);
    expect(body.message.threadId).toBe("thread-1");
    const mime = Buffer.from(body.message.raw, "base64url").toString("utf8");
    expect(mime).toContain("In-Reply-To: <source@example.com>");
    expect(mime).toContain("X-AutoReply-Tracking: tracking-1");
    expect(mime).toContain("Content-ID: <logo-1>");
    expect(mime).toContain("Content-Disposition: inline");
    expect(request.mock.calls[0]![3]).toMatchObject({ maxRetries: 0 });
  });

  it("sends drafts without blind POST retries", async () => {
    const request = vi.fn().mockResolvedValue({ id: "sent-1" });
    const service = new GmailTransportService({ request } as never);

    await service.sendDraft("mailbox-1", "draft-1");

    expect(request).toHaveBeenCalledWith(
      "mailbox-1",
      "/drafts/send",
      expect.objectContaining({ method: "POST" }),
      { maxRetries: 0, expected: [200] },
    );
  });

  it("safely retries without threadId after Gmail confirms a thread binding error", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GoogleApiError(400, "invalidArgument", "Invalid threadId"),
      )
      .mockResolvedValueOnce({
        id: "draft-2",
        message: { id: "message-2", threadId: "new-thread" },
      });
    const service = new GmailTransportService({ request } as never);

    await expect(
      service.createReplyDraft({
        mailboxId: "mailbox-1",
        sourceMessageId: "source-1",
        sourceInternetMessageId: "<source@example.com>",
        conversationId: "original-thread",
        mailboxEmail: "owner@gmail.com",
        recipient: "sender@example.net",
        subject: "自定义回复主题",
        html: "<p>您好</p>",
        text: "您好",
        trackingId: "tracking-2",
        instanceId: "instance-1",
        assets: [],
      }),
    ).resolves.toMatchObject({ id: "draft-2", isDraft: true });

    const first = JSON.parse(request.mock.calls[0]![2].body as string);
    const second = JSON.parse(request.mock.calls[1]![2].body as string);
    expect(first.message.threadId).toBe("original-thread");
    expect(second.message.threadId).toBeUndefined();
    expect(request.mock.calls[0]![3]).toMatchObject({ maxRetries: 0 });
    expect(request.mock.calls[1]![3]).toMatchObject({ maxRetries: 0 });
  });
});
