export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type RuleConditions = {
  folders?: Array<"inbox" | "junkemail">;
  senderAddresses?: string[];
  senderDomains?: string[];
  subjectContains?: string[];
  subjectNotContains?: string[];
  subjectPrefixes?: string[];
};

export type TemplateVariables = {
  sender: { name: string; email: string };
  mailbox: { name: string; email: string };
  message: { subject: string; received_at: string; folder: string };
  rule: { name: string };
  system: {
    current_date: string;
    current_time: string;
    current_datetime: string;
  };
};

export const MESSAGE_STATES = [
  "DISCOVERED",
  "FILTERED",
  "QUEUED",
  "CREATING_DRAFT",
  "DRAFT_READY",
  "SENDING",
  "SENT",
  "FAILED_CONFIRMED",
  "UNCERTAIN",
] as const;

export const TEMPLATE_VARIABLES = [
  "sender.name",
  "sender.email",
  "mailbox.name",
  "mailbox.email",
  "message.subject",
  "message.received_at",
  "message.folder",
  "rule.name",
  "system.current_date",
  "system.current_time",
  "system.current_datetime",
] as const;
