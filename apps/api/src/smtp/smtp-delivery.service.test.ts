import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  verify: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));
const createTransport = vi.hoisted(() => vi.fn(() => transport));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

import {
  SmtpDeliveryError,
  SmtpDeliveryService,
} from "./smtp-delivery.service.js";

const config = {
  id: "smtp-1",
  name: "Primary",
  host: "smtp.example.com",
  port: 587,
  security: "STARTTLS" as const,
  username: "service@example.com",
  password: "app-password",
  fromEmail: "service@example.com",
  fromName: "Service",
  replyToEmail: null,
};

describe("SmtpDeliveryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses authenticated TLS, reply threading headers and shared template assets", async () => {
    transport.sendMail.mockResolvedValue({
      accepted: ["buyer@example.net"],
      rejected: [],
      messageId: "<accepted@example.com>",
    });
    const service = new SmtpDeliveryService({
      resolve: vi.fn().mockResolvedValue(config),
    } as never);

    const result = await service.sendReply({
      smtpConfigId: "smtp-1",
      recipient: "buyer@example.net",
      replyToFallback: "inbox@example.com",
      subject: "Re: Order",
      html: "<p>Received</p>",
      text: "Received",
      assets: [
        {
          id: "asset-1",
          revisionId: "revision-1",
          fileName: "logo.png",
          contentType: "image/png",
          size: 3,
          inline: true,
          contentId: "logo@example.com",
          data: Buffer.from("png"),
          createdAt: new Date(),
        },
      ],
      sourceInternetMessageId: "<source@example.net>",
      trackingId: "tracking-1",
      instanceId: "instance-1",
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: "service@example.com", pass: "app-password" },
        tls: expect.objectContaining({
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
        }),
      }),
    );
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.net",
        inReplyTo: "<source@example.net>",
        references: ["<source@example.net>"],
        headers: expect.objectContaining({
          "Auto-Submitted": "auto-replied",
          "X-Auto-Response-Suppress": "All",
        }),
        attachments: [
          expect.objectContaining({
            filename: "logo.png",
            cid: "logo@example.com",
            contentDisposition: "inline",
          }),
        ],
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(result).toEqual({
      accepted: true,
      messageId: "<accepted@example.com>",
    });
    expect(transport.close).toHaveBeenCalled();
  });

  it("marks a connection loss during DATA as uncertain", async () => {
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("socket reset"), {
        code: "ECONNRESET",
        command: "DATA",
      }),
    );
    const service = new SmtpDeliveryService({
      resolve: vi.fn().mockResolvedValue(config),
    } as never);

    const error = await service
      .sendReply({
        smtpConfigId: "smtp-1",
        recipient: "buyer@example.net",
        replyToFallback: "inbox@example.com",
        subject: "Re: Order",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
        trackingId: "tracking-1",
        instanceId: "instance-1",
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error).toMatchObject({
      code: "SMTP_SEND_STATUS_UNCERTAIN",
      uncertain: true,
    });
  });

  it("reports authentication rejection as a confirmed failure", async () => {
    transport.verify.mockRejectedValue(
      Object.assign(new Error("auth failed"), {
        code: "EAUTH",
        command: "AUTH",
        responseCode: 535,
      }),
    );
    const service = new SmtpDeliveryService({
      resolve: vi.fn().mockResolvedValue(config),
    } as never);

    const error = await service.verify("smtp-1").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "SMTP_AUTH_FAILED",
      uncertain: false,
      status: 409,
    });
  });

  it("keeps a connection failure before DATA retryable as a confirmed failure", async () => {
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error("connection timed out"), {
        code: "ETIMEDOUT",
        command: "CONN",
      }),
    );
    const service = new SmtpDeliveryService({
      resolve: vi.fn().mockResolvedValue(config),
    } as never);

    const error = await service
      .sendReply({
        smtpConfigId: "smtp-1",
        recipient: "buyer@example.net",
        replyToFallback: "inbox@example.com",
        subject: "Re: Order",
        html: "<p>Received</p>",
        text: "Received",
        assets: [],
        trackingId: "tracking-1",
        instanceId: "instance-1",
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      code: "SMTP_CONNECTION_FAILED",
      uncertain: false,
    });
  });
});
