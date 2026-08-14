import { Injectable } from "@nestjs/common";
import { PrismaService } from "../core/prisma.js";
import { AppError } from "../core/http.js";
import { GmailTransportService } from "../google/gmail-transport.service.js";
import { MailTransportService } from "../microsoft/mail-transport.service.js";
import type {
  CreateReplyDraftInput,
  CreateTestDraftInput,
  TransportMessage,
} from "./mail-provider.types.js";
import type { TemplateAsset } from "@prisma/client";

@Injectable()
export class MailProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly microsoft: MailTransportService,
    private readonly google: GmailTransportService,
  ) {}

  async createReplyDraft(
    input: CreateReplyDraftInput,
  ): Promise<TransportMessage> {
    return (await this.provider(input.mailboxId)) === "GOOGLE"
      ? this.google.createReplyDraft(input)
      : this.microsoft.createReplyDraft(input);
  }

  async createTestDraft(
    input: CreateTestDraftInput,
  ): Promise<TransportMessage> {
    return (await this.provider(input.mailboxId)) === "GOOGLE"
      ? this.google.createTestDraft(input)
      : this.microsoft.createTestDraft(input);
  }

  async uploadAssets(
    mailboxId: string,
    draftId: string,
    assets: TemplateAsset[],
  ): Promise<void> {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.uploadAssets(mailboxId, draftId, assets);
    return this.microsoft.uploadAssets(mailboxId, draftId, assets);
  }

  async listAttachments(
    mailboxId: string,
    draftId: string,
  ): Promise<
    Array<{ name?: string; size?: number; contentId?: string | null }>
  > {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.listAttachments();
    return this.microsoft.listAttachments(mailboxId, draftId);
  }

  async sendDraft(mailboxId: string, draftId: string): Promise<void> {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.sendDraft(mailboxId, draftId);
    return this.microsoft.sendDraft(mailboxId, draftId);
  }

  async getMessage(
    mailboxId: string,
    messageId: string,
  ): Promise<TransportMessage | null> {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.getMessage(mailboxId, messageId);
    return this.microsoft.getMessage(mailboxId, messageId);
  }

  async findDraftByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<TransportMessage | null> {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.findDraftByTracking(
        mailboxId,
        trackingId,
        conversationId,
        since,
      );
    return this.microsoft.findDraftByTracking(
      mailboxId,
      trackingId,
      conversationId,
      since,
    );
  }

  async findSentByTracking(
    mailboxId: string,
    trackingId: string,
    conversationId?: string | null,
    since?: Date | null,
  ): Promise<TransportMessage | null> {
    if ((await this.provider(mailboxId)) === "GOOGLE")
      return this.google.findSentByTracking(
        mailboxId,
        trackingId,
        conversationId,
        since,
      );
    return this.microsoft.findSentByTracking(
      mailboxId,
      trackingId,
      conversationId,
      since,
    );
  }

  private async provider(mailboxId: string) {
    const mailbox = await this.prisma.mailbox.findUnique({
      where: { id: mailboxId },
      select: { provider: true },
    });
    if (!mailbox) throw new AppError("MAILBOX_NOT_FOUND", "邮箱不存在", 404);
    return mailbox.provider;
  }
}
