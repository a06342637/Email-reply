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
  sendTransport: "MAILBOX_API" | "SMTP";
  smtpConfigId?: string | null;
  smtpConfig?: {
    id: string;
    name: string;
    fromEmail: string;
    fromName?: string | null;
  } | null;
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
  microsoftAuthMode?: "MSAL_OAUTH" | "CLIENT_ID_REFRESH_TOKEN";
  microsoftClientId?: string | null;
  microsoftAppConfigId?: string | null;
  googleAppConfigId?: string | null;
  microsoftAppConfig?: { id: string; name: string } | null;
  googleAppConfig?: { id: string; name: string } | null;
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
export type ProviderAppConfig = {
  id: string;
  name: string;
  clientId: string;
  hasClientSecret: boolean;
  secretExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  mailboxCount: number;
};
export type ProviderConfig = {
  configured: boolean;
  apps: ProviderAppConfig[];
  publicUrl: string;
  publicUrlAutoDetected?: boolean;
  callbackUrl: string;
  scopes: string[];
};
export type SmtpConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  security: "TLS" | "STARTTLS";
  username: string;
  fromEmail: string;
  fromName?: string | null;
  replyToEmail?: string | null;
  hasPassword: boolean;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
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
    autoTextContent?: boolean;
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
