CREATE TYPE "MailProvider" AS ENUM ('MICROSOFT', 'GOOGLE');

ALTER TABLE "OAuthState"
ADD COLUMN "provider" "MailProvider" NOT NULL DEFAULT 'MICROSOFT';

ALTER TABLE "Mailbox"
ADD COLUMN "provider" "MailProvider" NOT NULL DEFAULT 'MICROSOFT';

CREATE TABLE "GoogleAppConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAppConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GmailCursor" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "historyIdEncrypted" TEXT,
    "pageTokenEncrypted" TEXT,
    "lastSuccessfulAt" TIMESTAMP(3),
    "highWaterAt" TIMESTAMP(3),
    "initializedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GmailCursor_mailboxId_key" ON "GmailCursor"("mailboxId");
CREATE INDEX "Mailbox_provider_status_idx" ON "Mailbox"("provider", "status");

ALTER TABLE "GmailCursor"
ADD CONSTRAINT "GmailCursor_mailboxId_fkey"
FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
