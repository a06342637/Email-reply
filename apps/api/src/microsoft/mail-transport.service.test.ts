import { describe, expect, it, vi } from "vitest";
import { MailTransportService } from "./mail-transport.service.js";

describe("MailTransportService", () => {
  it("creates a MIME reply draft with loop-prevention tracking headers", async () => {
    const request = vi.fn().mockResolvedValue({
      id: "draft-1",
      internetMessageId: "<draft@example.com>",
    });
    const service = new MailTransportService({ request } as never);

    await service.createReplyDraft({
      mailboxId: "mailbox-1",
      sourceMessageId: "source/1",
      mailboxEmail: "owner@example.com",
      recipient: "sender@example.net",
      subject: "订单咨询",
      html: "<p>已收到</p>",
      text: "已收到",
      trackingId: "tracking-1",
      instanceId: "instance-1",
    });

    const [, path, init, options] = request.mock.calls[0]!;
    expect(path).toContain("source%2F1/createReply");
    expect(options).toEqual({ maxRetries: 0, expected: [201] });
    const mime = Buffer.from(String(init.body), "base64").toString("utf8");
    expect(mime).toContain("Auto-Submitted: auto-replied");
    expect(mime).toContain("X-Auto-Response-Suppress: All");
    expect(mime).toContain("X-AutoReply-Tracking: tracking-1");
    expect(mime).toContain("X-AutoReply-Instance: instance-1");
    expect(mime).toContain("Content-Type: multipart/alternative");
    const encodedWords = mime.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
    expect(encodedWords.length).toBeGreaterThan(0);
    expect(encodedWords.every((word) => word.length <= 75)).toBe(true);
  });

  it("continues paging until a tracked sent message is found", async () => {
    const now = new Date().toISOString();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        value: [
          {
            id: "unrelated",
            sentDateTime: now,
            extensions: [],
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
      })
      .mockResolvedValueOnce({
        value: [
          {
            id: "sent-1",
            isDraft: false,
            sentDateTime: now,
            extensions: [
              {
                extensionName: "Com.MailPilot.AutoReply",
                trackingId: "tracking-1",
              },
            ],
          },
        ],
      });
    const service = new MailTransportService({ request } as never);

    const message = await service.findSentByTracking(
      "mailbox-1",
      "tracking-1",
      null,
      new Date(),
    );

    expect(message?.id).toBe("sent-1");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("matches existing duplicate attachments by count during recovery", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        value: [{ name: "guide.pdf", size: 3, contentId: null }],
      })
      .mockResolvedValue({ id: "attachment-2" });
    const service = new MailTransportService({ request } as never);
    const asset = {
      id: "asset-1",
      revisionId: "revision-1",
      fileName: "guide.pdf",
      contentType: "application/pdf",
      size: 3,
      inline: false,
      contentId: null,
      data: Buffer.from("pdf"),
      createdAt: new Date(),
    };

    await service.uploadAssets("mailbox-1", "draft-1", [
      asset as never,
      { ...asset, id: "asset-2" } as never,
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toContain("/attachments");
    expect(request.mock.calls[1]?.[3]).toEqual({
      maxRetries: 0,
      expected: [201],
    });
  });
});
