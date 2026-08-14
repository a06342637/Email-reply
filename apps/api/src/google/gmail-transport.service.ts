import { Injectable } from "@nestjs/common";
import type { TemplateAsset } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  CreateReplyDraftInput,
  CreateTestDraftInput,
  TransportMessage,
} from "../providers/mail-provider.types.js";
import { GmailApiService, GoogleApiError } from "./gmail-api.service.js";

type GmailHeader = { name: string; value: string };
type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};
type GmailDraft = { id: string; message?: GmailMessage };
type GmailDraftPage = {
  drafts?: Array<{ id: string; message?: { id?: string; threadId?: string } }>;
  nextPageToken?: string;
};
type GmailMessagePage = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
};

const TRACKING_LOOKUP_WINDOW_MS = 15 * 60_000;
const TRACKING_LOOKUP_MAX_PAGES = 20;
const LOOKUP_HEADERS = [
  "Message-ID",
  "Subject",
  "X-AutoReply-Tracking",
  "X-AutoReply-Instance",
];

@Injectable()
export class GmailTransportService {
  constructor(private readonly gmail: GmailApiService) {}

  async createReplyDraft(
    input: CreateReplyDraftInput,
  ): Promise<TransportMessage> {
    const raw = this.replyMime(input);
    const threadId =
      input.conversationId && input.sourceInternetMessageId
        ? input.conversationId
        : undefined;
    let draft: GmailDraft;
    try {
      draft = await this.createDraft(input.mailboxId, raw, threadId);
    } catch (error) {
      if (!(
        threadId &&
        error instanceof GoogleApiError &&
        error.status === 400
      ))
        throw error;
      // Gmail requires threadId, matching reply headers and a compatible
      // subject at the same time. A user-defined subject or malformed source
      // Message-ID can make only the thread binding invalid. HTTP 400 confirms
      // that no draft was created, so one threadless retry is safe.
      draft = await this.createDraft(input.mailboxId, raw);
    }
    return {
      id: draft.id,
      conversationId:
        draft.message?.threadId || input.conversationId || undefined,
      isDraft: true,
      createdDateTime: new Date().toISOString(),
    };
  }

  async createTestDraft(
    input: CreateTestDraftInput,
  ): Promise<TransportMessage> {
    const draft = await this.createDraft(
      input.mailboxId,
      this.messageMime({
        from: input.mailboxEmail,
        to: input.recipient,
        subject: `[自动回复模板测试] ${input.subject}`,
        text: input.text,
        html: input.html,
        assets: input.assets,
        trackingId: input.trackingId,
        instanceId: input.instanceId,
        replySubject: false,
      }),
    );
    return {
      id: draft.id,
      conversationId: draft.message?.threadId,
      isDraft: true,
      createdDateTime: new Date().toISOString(),
    };
  }

  async uploadAssets(
    _mailboxId: string,
    _draftId: string,
    _assets: TemplateAsset[],
  ): Promise<void> {
    // Gmail drafts are uploaded as one RFC 5322 MIME message. Attachments are
    // already part of the draft, so this compatibility step is intentionally
    // idempotent and empty.
  }

  async listAttachments(): Promise<
    Array<{ name?: string; size?: number; contentId?: string | null }>
  > {
    return [];
  }

  async sendDraft(mailboxId: string, draftId: string): Promise<void> {
    await this.gmail.request(
      mailboxId,
      "/drafts/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draftId }),
      },
      { maxRetries: 0, expected: [200] },
    );
  }

  async getMessage(
    mailboxId: string,
    draftId: string,
  ): Promise<TransportMessage | null> {
    try {
      const draft = await this.gmail.request<GmailDraft>(
        mailboxId,
        `/drafts/${encodeURIComponent(draftId)}?${this.metadataParams()}`,
        {},
        { maxRetries: 1, expected: [200] },
      );
      return this.fromDraft(draft);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return null;
      throw error;
    }
  }

  async findDraftByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<TransportMessage | null> {
    const lowerBound = new Date(
      Math.max(0, (since?.getTime() ?? Date.now()) - TRACKING_LOOKUP_WINDOW_MS),
    );
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({ maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.gmail.request<GmailDraftPage>(
        mailboxId,
        `/drafts?${params.toString()}`,
        {},
        { maxRetries: 1, expected: [200] },
      );
      const candidates = [...(page.drafts ?? [])].sort(
        (left, right) =>
          Number(right.message?.threadId === conversationId) -
          Number(left.message?.threadId === conversationId),
      );
      for (const item of candidates) {
        const draft = await this.gmail.request<GmailDraft>(
          mailboxId,
          `/drafts/${encodeURIComponent(item.id)}?${this.metadataParams()}`,
          {},
          { maxRetries: 1, expected: [200] },
        );
        const converted = this.fromDraft(draft);
        if (
          converted.createdDateTime &&
          new Date(converted.createdDateTime) < lowerBound
        )
          continue;
        if (this.hasTracking(converted, trackingId)) return converted;
      }
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < TRACKING_LOOKUP_MAX_PAGES);
    return null;
  }

  async findSentByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<TransportMessage | null> {
    const lowerBound = new Date(
      Math.max(0, (since?.getTime() ?? Date.now()) - TRACKING_LOOKUP_WINDOW_MS),
    );
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        maxResults: "100",
        q: `in:sent after:${Math.max(0, Math.floor(lowerBound.getTime() / 1_000) - 1)}`,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.gmail.request<GmailMessagePage>(
        mailboxId,
        `/messages?${params.toString()}`,
        {},
        { maxRetries: 1, expected: [200] },
      );
      const candidates = [...(page.messages ?? [])].sort(
        (left, right) =>
          Number(right.threadId === conversationId) -
          Number(left.threadId === conversationId),
      );
      for (const item of candidates) {
        const message = await this.getGmailMessage(mailboxId, item.id);
        const converted = this.fromMessage(message, false);
        if (this.hasTracking(converted, trackingId)) return converted;
      }
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < TRACKING_LOOKUP_MAX_PAGES);
    return null;
  }

  private async getGmailMessage(
    mailboxId: string,
    messageId: string,
  ): Promise<GmailMessage> {
    return this.gmail.request<GmailMessage>(
      mailboxId,
      `/messages/${encodeURIComponent(messageId)}?${this.metadataParams()}`,
      {},
      { maxRetries: 1, expected: [200] },
    );
  }

  private createDraft(
    mailboxId: string,
    raw: string,
    threadId?: string,
  ): Promise<GmailDraft> {
    return this.gmail.request<GmailDraft>(
      mailboxId,
      "/drafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { raw, ...(threadId ? { threadId } : {}) },
        }),
      },
      { maxRetries: 0, expected: [200] },
    );
  }

  private metadataParams(): string {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of LOOKUP_HEADERS) params.append("metadataHeaders", name);
    return params.toString();
  }

  private fromDraft(draft: GmailDraft): TransportMessage {
    return {
      ...this.fromMessage(draft.message ?? { id: draft.id }, true),
      id: draft.id,
    };
  }

  private fromMessage(
    message: GmailMessage,
    isDraft: boolean,
  ): TransportMessage {
    const headers = message.payload?.headers ?? [];
    const value = (name: string) =>
      headers.find((header) => header.name.toLowerCase() === name.toLowerCase())
        ?.value;
    const timestamp = Number(message.internalDate);
    const date = Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : undefined;
    return {
      id: message.id,
      internetMessageId: value("Message-ID"),
      conversationId: message.threadId,
      subject: value("Subject"),
      isDraft,
      createdDateTime: isDraft ? date : undefined,
      sentDateTime: isDraft ? undefined : date,
      internetMessageHeaders: headers,
    };
  }

  private hasTracking(message: TransportMessage, trackingId: string): boolean {
    return (message.internetMessageHeaders ?? []).some(
      (header) =>
        header.name.toLowerCase() === "x-autoreply-tracking" &&
        header.value === trackingId,
    );
  }

  private replyMime(input: CreateReplyDraftInput): string {
    return this.messageMime({
      from: input.mailboxEmail,
      to: input.recipient,
      subject: input.subject,
      text: input.text,
      html: input.html,
      assets: input.assets,
      trackingId: input.trackingId,
      instanceId: input.instanceId,
      inReplyTo: input.sourceInternetMessageId || undefined,
      references: input.sourceInternetMessageId || undefined,
    });
  }

  private messageMime(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    assets: TemplateAsset[];
    trackingId: string;
    instanceId: string;
    inReplyTo?: string;
    references?: string;
    replySubject?: boolean;
  }): string {
    const safeHeader = (value: string) => value.replace(/[\r\n]/g, " ").trim();
    const encode = (value: string | Uint8Array) => {
      const encoded = Buffer.from(value).toString("base64");
      return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
    };
    const mixed = `=_MailPilot_Mixed_${randomUUID().replace(/-/g, "")}`;
    const alternative = `=_MailPilot_Alt_${randomUUID().replace(/-/g, "")}`;
    const related = `=_MailPilot_Related_${randomUUID().replace(/-/g, "")}`;
    const inlineAssets = input.assets.filter((asset) => asset.inline);
    const attachedAssets = input.assets.filter((asset) => !asset.inline);
    const needsMixed = attachedAssets.length > 0;
    const headers = [
      ...(input.from ? [`From: ${safeHeader(input.from)}`] : []),
      `To: ${safeHeader(input.to)}`,
      `Subject: ${this.mimeSubject(input.subject, input.replySubject !== false)}`,
      "MIME-Version: 1.0",
      "Auto-Submitted: auto-replied",
      "X-Auto-Response-Suppress: All",
      `X-AutoReply-Tracking: ${safeHeader(input.trackingId)}`,
      `X-AutoReply-Instance: ${safeHeader(input.instanceId)}`,
      ...(input.inReplyTo
        ? [`In-Reply-To: ${safeHeader(input.inReplyTo)}`]
        : []),
      ...(input.references
        ? [`References: ${safeHeader(input.references)}`]
        : []),
      `Content-Type: ${needsMixed ? `multipart/mixed; boundary="${mixed}"` : `multipart/alternative; boundary="${alternative}"`}`,
      "",
    ];
    const lines = [...headers];
    if (needsMixed) {
      lines.push(`--${mixed}`);
      lines.push(
        `Content-Type: multipart/alternative; boundary="${alternative}"`,
      );
      lines.push("");
    }
    lines.push(`--${alternative}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(encode(input.text));
    lines.push(`--${alternative}`);
    if (inlineAssets.length) {
      lines.push(`Content-Type: multipart/related; boundary="${related}"`);
      lines.push("");
      lines.push(`--${related}`);
    }
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(encode(input.html));
    for (const asset of inlineAssets) {
      lines.push(`--${related}`);
      lines.push(...this.assetPart(asset, encode, true));
    }
    if (inlineAssets.length) lines.push(`--${related}--`);
    lines.push(`--${alternative}--`);
    for (const asset of attachedAssets) {
      lines.push(`--${mixed}`);
      lines.push(...this.assetPart(asset, encode, false));
    }
    if (needsMixed) lines.push(`--${mixed}--`);
    lines.push("");
    return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
  }

  private assetPart(
    asset: TemplateAsset,
    encode: (value: string | Uint8Array) => string,
    inline: boolean,
  ): string[] {
    const asciiName = asset.fileName
      .replace(/[\r\n"\\]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_")
      .slice(0, 150);
    const encodedName = encodeURIComponent(
      asset.fileName.replace(/[\r\n]/g, " ").slice(0, 240),
    ).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const contentId = (asset.contentId || asset.id).replace(/[<>\r\n]/g, "");
    const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
      asset.contentType,
    )
      ? asset.contentType
      : "application/octet-stream";
    return [
      `Content-Type: ${contentType}; name="${asciiName}"; name*=UTF-8''${encodedName}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      ...(inline ? [`Content-ID: <${contentId}>`] : []),
      "",
      encode(Buffer.from(asset.data)),
    ];
  }

  private mimeSubject(subject: string, ensureReplyPrefix: boolean): string {
    const normalized = subject.replace(/[\r\n]+/g, " ").trim();
    const replySubject = Array.from(
      !ensureReplyPrefix || /^(re|回复):/i.test(normalized)
        ? normalized
        : `Re: ${normalized}`,
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
