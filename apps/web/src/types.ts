export type Admin = {
  id: string;
  username: string;
  mustChangePassword: boolean;
  theme: "dark" | "light" | "system";
  totpEnabled: boolean;
};
export type UiSettings = {
  siteName: string;
  timezone: string;
};
export type Task = {
  id: string;
  name: string;
  status: string;
  pollIntervalSeconds: number;
  backlogPerMinute: number;
  defaultTemplateId?: string;
  averagePollLatencyMs?: number;
  nextPollAt?: string;
  lastPollCompletedAt?: string;
  graphBackoffUntil?: string;
  _count?: { receipts: number };
  rules: Rule[];
  defaultTemplate?: { id: string; name: string; publishedRevisionId?: string };
};
export type Rule = {
  id?: string;
  name: string;
  enabled: boolean;
  templateId: string;
  priority?: number;
  conditions: Record<string, string[]>;
  template?: { name: string };
};
export type Mailbox = {
  id: string;
  email: string;
  provider: "MICROSOFT" | "GOOGLE";
  displayName: string;
  tenantId?: string;
  accountType?: string;
  status: string;
  lastTokenRefreshAt?: string;
  lastErrorMessage?: string;
  task?: Task;
  cursors: Array<{
    folder: string;
    lastSuccessfulAt?: string;
    initializedAt?: string;
  }>;
  gmailCursor?: {
    lastSuccessfulAt?: string;
    initializedAt?: string;
    highWaterAt?: string;
  };
};
export type Template = {
  id: string;
  name: string;
  description?: string;
  publishedRevisionId?: string;
  publishedRevision?: { id: string; version: number };
  revisions: Array<{
    id: string;
    version: number;
    subjectTemplate?: string;
    htmlContent?: string;
    textContent?: string;
    sanitizedHtml?: string;
    createdAt?: string;
    publishedAt?: string;
    assets?: Asset[];
  }>;
  _count?: { rules: number; defaultForTasks: number };
};
export type Asset = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  inline: boolean;
  contentId?: string;
};
export type ProcessingLog = {
  id: string;
  occurredAt: string;
  mailboxEmail: string;
  senderEmail?: string;
  subject?: string;
  folder?: string;
  event: string;
  status?: string;
  reason?: string;
  errorCode?: string;
  receiptId?: string;
};
export type SystemLog = {
  id: string;
  occurredAt: string;
  level: string;
  component: string;
  event: string;
  message: string;
  requestId?: string;
  metadata?: unknown;
};
