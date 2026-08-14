-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('CONNECTED', 'AUTH_REQUIRED', 'DISABLED', 'REMOVED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'INITIALIZING', 'RUNNING', 'PAUSED', 'CIRCUIT_OPEN', 'DELETED');

-- CreateEnum
CREATE TYPE "FolderKind" AS ENUM ('INBOX', 'JUNKEMAIL');

-- CreateEnum
CREATE TYPE "MessageState" AS ENUM ('DISCOVERED', 'FILTERED', 'QUEUED', 'CREATING_DRAFT', 'DRAFT_READY', 'SENDING', 'SENT', 'FAILED_CONFIRMED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('PROCESS_MESSAGE', 'VERIFY_SEND', 'WEBHOOK');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "theme" TEXT NOT NULL DEFAULT 'system',
    "bootstrapLoggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "pendingTotpEncrypted" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpCredential" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "recoveryCodeHashes" JSONB NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MicrosoftAppConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "secretExpiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftAppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "verifierEncrypted" TEXT NOT NULL,
    "redirectAfter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tenantId" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "homeAccountId" TEXT NOT NULL,
    "tokenCacheEncrypted" TEXT NOT NULL,
    "status" "MailboxStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastTokenRefreshAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReplyTask" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT',
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "backlogPerMinute" INTEGER NOT NULL DEFAULT 20,
    "defaultTemplateId" TEXT,
    "activationAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "lastPollStartedAt" TIMESTAMP(3),
    "lastPollCompletedAt" TIMESTAMP(3),
    "averagePollLatencyMs" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitOpenedAt" TIMESTAMP(3),
    "graphBackoffUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AutoReplyTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FolderCursor" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "folder" "FolderKind" NOT NULL,
    "deltaLinkEncrypted" TEXT,
    "nextLinkEncrypted" TEXT,
    "lastSuccessfulAt" TIMESTAMP(3),
    "highWaterAt" TIMESTAMP(3),
    "initializedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FolderCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),
    "publishedRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateRevision" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subjectTemplate" TEXT NOT NULL DEFAULT 'Re: {{ message.subject }}',
    "htmlContent" TEXT NOT NULL,
    "textContent" TEXT NOT NULL,
    "sanitizedHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "TemplateRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateAsset" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "contentId" TEXT,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyRule" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReceipt" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "folder" "FolderKind" NOT NULL,
    "senderName" TEXT,
    "senderEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "state" "MessageState" NOT NULL DEFAULT 'DISCOVERED',
    "filterReason" TEXT,
    "ruleId" TEXT,
    "templateRevisionId" TEXT,
    "trackingId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MessageReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyAttempt" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "MessageState" NOT NULL,
    "draftMessageId" TEXT,
    "draftInternetId" TEXT,
    "uploadedAssetIds" JSONB NOT NULL DEFAULT '[]',
    "verificationPhase" TEXT,
    "verificationStage" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAcceptedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "ReplyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionalOutbox" (
    "id" TEXT NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionalOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT,
    "mailboxEmail" TEXT NOT NULL,
    "receiptId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "event" TEXT NOT NULL,
    "senderEmail" TEXT,
    "subject" TEXT,
    "folder" "FolderKind",
    "ruleName" TEXT,
    "templateName" TEXT,
    "status" "MessageState",
    "reason" TEXT,
    "errorCode" TEXT,
    "requestId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "requestId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventTypes" JSONB NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession"("adminId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TotpCredential_adminId_key" ON "TotpCredential"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_email_key" ON "Mailbox"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AutoReplyTask_mailboxId_key" ON "AutoReplyTask"("mailboxId");

-- CreateIndex
CREATE INDEX "AutoReplyTask_status_nextPollAt_idx" ON "AutoReplyTask"("status", "nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "FolderCursor_mailboxId_folder_key" ON "FolderCursor"("mailboxId", "folder");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyTemplate_publishedRevisionId_key" ON "ReplyTemplate"("publishedRevisionId");

-- CreateIndex
CREATE INDEX "TemplateRevision_templateId_createdAt_idx" ON "TemplateRevision"("templateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateRevision_templateId_version_key" ON "TemplateRevision"("templateId", "version");

-- CreateIndex
CREATE INDEX "ReplyRule_taskId_enabled_priority_idx" ON "ReplyRule"("taskId", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyRule_taskId_priority_key" ON "ReplyRule"("taskId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReceipt_trackingId_key" ON "MessageReceipt"("trackingId");

-- CreateIndex
CREATE INDEX "MessageReceipt_mailboxId_internetMessageId_idx" ON "MessageReceipt"("mailboxId", "internetMessageId");

-- CreateIndex
CREATE INDEX "MessageReceipt_state_createdAt_idx" ON "MessageReceipt"("state", "createdAt");

-- CreateIndex
CREATE INDEX "MessageReceipt_taskId_receivedAt_idx" ON "MessageReceipt"("taskId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReceipt_mailboxId_graphMessageId_key" ON "MessageReceipt"("mailboxId", "graphMessageId");

-- CreateIndex
CREATE INDEX "ReplyAttempt_state_startedAt_idx" ON "ReplyAttempt"("state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyAttempt_receiptId_number_key" ON "ReplyAttempt"("receiptId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionalOutbox_dedupeKey_key" ON "TransactionalOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "TransactionalOutbox_publishedAt_availableAt_idx" ON "TransactionalOutbox"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "ProcessingLog_occurredAt_idx" ON "ProcessingLog"("occurredAt");

-- CreateIndex
CREATE INDEX "ProcessingLog_mailboxId_occurredAt_idx" ON "ProcessingLog"("mailboxId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProcessingLog_status_occurredAt_idx" ON "ProcessingLog"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "SystemLog_occurredAt_idx" ON "SystemLog"("occurredAt");

-- CreateIndex
CREATE INDEX "SystemLog_level_occurredAt_idx" ON "SystemLog"("level", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_adminId_occurredAt_idx" ON "AuditLog"("adminId", "occurredAt");

-- CreateIndex
CREATE INDEX "Alert_fingerprint_status_idx" ON "Alert"("fingerprint", "status");

-- CreateIndex
CREATE INDEX "Alert_status_lastSeenAt_idx" ON "Alert"("status", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotpCredential" ADD CONSTRAINT "TotpCredential_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyTask" ADD CONSTRAINT "AutoReplyTask_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyTask" ADD CONSTRAINT "AutoReplyTask_defaultTemplateId_fkey" FOREIGN KEY ("defaultTemplateId") REFERENCES "ReplyTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderCursor" ADD CONSTRAINT "FolderCursor_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyTemplate" ADD CONSTRAINT "ReplyTemplate_publishedRevisionId_fkey" FOREIGN KEY ("publishedRevisionId") REFERENCES "TemplateRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateRevision" ADD CONSTRAINT "TemplateRevision_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ReplyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateAsset" ADD CONSTRAINT "TemplateAsset_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "TemplateRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyRule" ADD CONSTRAINT "ReplyRule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AutoReplyTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyRule" ADD CONSTRAINT "ReplyRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ReplyTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AutoReplyTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReplyRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_templateRevisionId_fkey" FOREIGN KEY ("templateRevisionId") REFERENCES "TemplateRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyAttempt" ADD CONSTRAINT "ReplyAttempt_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "MessageReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingLog" ADD CONSTRAINT "ProcessingLog_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingLog" ADD CONSTRAINT "ProcessingLog_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "MessageReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
