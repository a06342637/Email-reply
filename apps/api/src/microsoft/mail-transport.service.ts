import { Injectable } from "@nestjs/common";
import type { TemplateAsset } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { GraphService, GraphError } from "./graph.service.js";
import { AppError } from "../core/http.js";

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  isDraft?: boolean;
  createdDateTime?: string;
  sentDateTime?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  extensions?: Array<Record<string, unknown>>;
};

type GraphMessagePage = {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
};

const TRACKING_EXTENSION = "Com.MailPilot.AutoReply";
const TRACKING_LOOKUP_WINDOW_MS = 15 * 60_000;
const TRACKING_LOOKUP_MAX_PAGES = 20;

@Injectable()
export class MailTransportService {
  constructor(private readonly graph: GraphService) {}

  async createReplyDraft(input: {
    mailboxId: string;
    sourceMessageId: string;
    mailboxEmail: string;
    recipient: string;
    subject: string;
    html: string;
    text: string;
    trackingId: string;
    instanceId: string;
  }): Promise<GraphMessage> {
    // Graph accepts MIME when creating a reply draft.  This is important here:
    // internetMessageHeaders is a create-only property and cannot be added by
    // PATCH after a JSON createReply call.  The endpoint still supplies the
    // original conversation/Reply-To relationship for us.
    const mime = this.replyMime(
      input.mailboxEmail,
      input.recipient,
      input.subject,
      input.text,
      input.html,
      input.trackingId,
      input.instanceId,
    );
    const draft = await this.graph.request<GraphMessage>(
      input.mailboxId,
      `/me/messages/${encodeURIComponent(input.sourceMessageId)}/createReply`,
      {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: mime,
      },
      { maxRetries: 0, expected: [201] },
    );
    await this.addTrackingExtension(
      input.mailboxId,
      draft.id,
      input.trackingId,
      input.instanceId,
    ).catch(() => {
      // The MIME headers are already persisted with the draft.  Extensions
      // improve lookup, but a failure here must never turn a created draft
      // into a second send attempt or leak Graph response data to logs.
    });
    return draft;
  }

  async createTestDraft(input: {
    mailboxId: string;
    recipient: string;
    subject: string;
    html: string;
    trackingId: string;
    instanceId: string;
  }): Promise<GraphMessage> {
    return this.graph.request<GraphMessage>(
      input.mailboxId,
      "/me/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: `[自动回复模板测试] ${input.subject}`,
          body: { contentType: "HTML", content: input.html },
          toRecipients: [{ emailAddress: { address: input.recipient } }],
          internetMessageHeaders: this.trackingHeaders(
            input.trackingId,
            input.instanceId,
          ),
        }),
      },
      { maxRetries: 0, expected: [201] },
    );
  }

  async uploadAssets(
    mailboxId: string,
    draftId: string,
    assets: TemplateAsset[],
  ): Promise<void> {
    const existing = await this.listAttachments(mailboxId, draftId);
    const matchedExisting = new Set<number>();
    for (const asset of assets) {
      const existingIndex = existing.findIndex(
        (item, index) =>
          !matchedExisting.has(index) &&
          item.name === asset.fileName &&
          item.size === asset.size &&
          (item.contentId || null) === (asset.contentId || null),
      );
      if (existingIndex >= 0) {
        matchedExisting.add(existingIndex);
        continue;
      }
      if (asset.size <= 3 * 1024 * 1024)
        await this.uploadSmallAsset(mailboxId, draftId, asset);
      else await this.uploadLargeAsset(mailboxId, draftId, asset);
    }
  }

  async listAttachments(
    mailboxId: string,
    draftId: string,
  ): Promise<
    Array<{ name?: string; size?: number; contentId?: string | null }>
  > {
    const result = await this.graph.request<{
      value: Array<{ name?: string; size?: number; contentId?: string | null }>;
    }>(
      mailboxId,
      `/me/messages/${encodeURIComponent(draftId)}/attachments?$select=name,size,contentId`,
      {},
      { maxRetries: 1, expected: [200] },
    );
    return result.value ?? [];
  }

  async sendDraft(mailboxId: string, draftId: string): Promise<void> {
    await this.graph.request(
      mailboxId,
      `/me/messages/${encodeURIComponent(draftId)}/send`,
      { method: "POST", headers: { "content-length": "0" } },
      { maxRetries: 0, expected: [202] },
    );
  }

  async getMessage(
    mailboxId: string,
    messageId: string,
  ): Promise<GraphMessage | null> {
    try {
      return await this.graph.request<GraphMessage>(
        mailboxId,
        `/me/messages/${encodeURIComponent(messageId)}?$select=id,isDraft,internetMessageId,conversationId,subject,createdDateTime,sentDateTime,internetMessageHeaders&$expand=extensions`,
        {},
        { maxRetries: 1, expected: [200] },
      );
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
  }

  async findDraftByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<GraphMessage | null> {
    return this.findByTracking(
      mailboxId,
      "/me/mailFolders/drafts/messages?$top=50&$orderby=createdDateTime%20desc&$select=id,isDraft,internetMessageId,conversationId,subject,createdDateTime,internetMessageHeaders&$expand=extensions",
      trackingId,
      conversationId,
      "createdDateTime",
      since,
    );
  }

  async findSentByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<GraphMessage | null> {
    return this.findByTracking(
      mailboxId,
      "/me/mailFolders/sentitems/messages?$top=50&$orderby=sentDateTime%20desc&$select=id,isDraft,internetMessageId,conversationId,subject,sentDateTime,internetMessageHeaders&$expand=extensions",
      trackingId,
      conversationId,
      "sentDateTime",
      since,
    );
  }

  private async findByTracking(
    mailboxId: string,
    initialUrl: string,
    trackingId: string,
    conversationId: string | null | undefined,
    dateField: "createdDateTime" | "sentDateTime",
    since?: Date | null,
  ): Promise<GraphMessage | null> {
    const lowerBound = new Date(
      Math.max(0, (since?.getTime() ?? Date.now()) - TRACKING_LOOKUP_WINDOW_MS),
    );
    let url: string | undefined = initialUrl;
    let pages = 0;
    while (url && pages++ < TRACKING_LOOKUP_MAX_PAGES) {
      const page: GraphMessagePage = await this.graph.request<GraphMessagePage>(
        mailboxId,
        url,
        {},
        { maxRetries: 1, expected: [200] },
      );
      for (const message of page.value ?? []) {
        const messageDate = message[dateField];
        if (messageDate) {
          const timestamp = Date.parse(messageDate);
          if (Number.isFinite(timestamp) && timestamp < lowerBound.getTime())
            return null;
        }
        if (
          conversationId &&
          message.conversationId &&
          message.conversationId !== conversationId
        )
          continue;
        if (this.hasTrackingExtension(message, trackingId)) return message;
      }
      url = page["@odata.nextLink"];
    }
    return null;
  }

  private async uploadSmallAsset(
    mailboxId: string,
    draftId: string,
    asset: TemplateAsset,
  ): Promise<void> {
    await this.graph.request(
      mailboxId,
      `/me/messages/${encodeURIComponent(draftId)}/attachments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: asset.fileName,
          contentType: asset.contentType,
          size: asset.size,
          isInline: asset.inline,
          contentId: asset.contentId,
          contentBytes: Buffer.from(asset.data).toString("base64"),
        }),
      },
      // Attachment creation is not idempotent. If the response is lost, the
      // processor verifies the draft and lists existing attachments before
      // retrying, which avoids adding the same file twice.
      { maxRetries: 0, expected: [201] },
    );
  }

  private async uploadLargeAsset(
    mailboxId: string,
    draftId: string,
    asset: TemplateAsset,
  ): Promise<void> {
    const session = await this.graph.request<{
      uploadUrl: string;
      expirationDateTime: string;
    }>(
      mailboxId,
      `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: "file",
            name: asset.fileName,
            size: asset.size,
            contentType: asset.contentType,
            isInline: asset.inline,
            contentId: asset.contentId,
          },
        }),
      },
      { maxRetries: 0, expected: [200, 201] },
    );
    const bytes = Buffer.from(asset.data);
    const chunkSize = 3_276_800;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.length);
      const response = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "content-length": String(end - offset),
          "content-range": `bytes ${offset}-${end - 1}/${bytes.length}`,
          "content-type": "application/octet-stream",
        },
        body: bytes.subarray(offset, end),
        signal: AbortSignal.timeout(120_000),
      });
      if (![200, 201, 202].includes(response.status)) {
        throw new AppError(
          "ATTACHMENT_UPLOAD_FAILED",
          `大附件上传失败（HTTP ${response.status}）`,
          502,
        );
      }
    }
  }

  private hasTrackingExtension(
    message: GraphMessage,
    trackingId: string,
  ): boolean {
    const extensionMatch =
      message.extensions?.some(
        (extension) =>
          extension.extensionName === TRACKING_EXTENSION &&
          extension.trackingId === trackingId,
      ) ?? false;
    if (extensionMatch) return true;
    return (message.internetMessageHeaders ?? []).some(
      (header) =>
        header.name.toLowerCase() === "x-autoreply-tracking" &&
        header.value === trackingId,
    );
  }

  private async addTrackingExtension(
    mailboxId: string,
    messageId: string,
    trackingId: string,
    instanceId: string,
  ): Promise<void> {
    await this.graph.request(
      mailboxId,
      `/me/messages/${encodeURIComponent(messageId)}/extensions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "@odata.type": "microsoft.graph.openTypeExtension",
          extensionName: TRACKING_EXTENSION,
          trackingId,
          instanceId,
        }),
      },
      { maxRetries: 0, expected: [201] },
    );
  }

  private trackingHeaders(trackingId: string, instanceId: string) {
    return [
      { name: "Auto-Submitted", value: "auto-replied" },
      { name: "X-Auto-Response-Suppress", value: "All" },
      { name: "X-AutoReply-Tracking", value: trackingId },
      { name: "X-AutoReply-Instance", value: instanceId },
    ];
  }

  private replyMime(
    mailboxEmail: string,
    recipient: string,
    subject: string,
    text: string,
    html: string,
    trackingId: string,
    instanceId: string,
  ): string {
    const boundary = `=_MailPilot_${randomUUID().replace(/-/g, "")}`;
    const safeHeader = (value: string) => value.replace(/[\r\n]/g, " ");
    const encodePart = (value: string) => {
      const encoded = Buffer.from(value, "utf8").toString("base64");
      return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
    };
    const mime = [
      `From: ${safeHeader(mailboxEmail)}`,
      `To: ${safeHeader(recipient)}`,
      `Subject: ${this.mimeSubject(subject)}`,
      "MIME-Version: 1.0",
      "Auto-Submitted: auto-replied",
      "X-Auto-Response-Suppress: All",
      `X-AutoReply-Tracking: ${safeHeader(trackingId)}`,
      `X-AutoReply-Instance: ${safeHeader(instanceId)}`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodePart(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodePart(html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return Buffer.from(mime, "utf8").toString("base64");
  }

  private mimeSubject(subject: string): string {
    const normalized = subject.replace(/[\r\n]+/g, " ").trim();
    const replySubject = Array.from(
      /^(re|回复):/i.test(normalized) ? normalized : `Re: ${normalized}`,
    )
      .slice(0, 900)
      .join("");
    if (
      Array.from(replySubject).every(
        (character) => (character.codePointAt(0) ?? 0) <= 0x7f,
      )
    )
      return replySubject;
    const chunks: string[] = [];
    let current = "";
    for (const character of replySubject) {
      if (current && Buffer.byteLength(current + character, "utf8") > 30) {
        chunks.push(current);
        current = character;
      } else current += character;
    }
    if (current) chunks.push(current);
    return chunks
      .map(
        (value) =>
          `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`,
      )
      .join("\r\n ");
  }
}
