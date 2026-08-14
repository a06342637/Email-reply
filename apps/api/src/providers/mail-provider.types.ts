import type { TemplateAsset } from "@prisma/client";

export type TransportMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  isDraft?: boolean;
  createdDateTime?: string;
  sentDateTime?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
};

export type CreateReplyDraftInput = {
  mailboxId: string;
  sourceMessageId: string;
  sourceInternetMessageId?: string | null;
  conversationId?: string | null;
  mailboxEmail: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  assets: TemplateAsset[];
  trackingId: string;
  instanceId: string;
};

export type CreateTestDraftInput = {
  mailboxId: string;
  mailboxEmail: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  assets: TemplateAsset[];
  trackingId: string;
  instanceId: string;
};
