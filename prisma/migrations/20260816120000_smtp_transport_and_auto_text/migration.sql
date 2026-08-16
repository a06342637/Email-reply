-- CreateEnum
CREATE TYPE "SendTransport" AS ENUM ('MAILBOX_API', 'SMTP');

-- CreateEnum
CREATE TYPE "SmtpSecurity" AS ENUM ('TLS', 'STARTTLS');

-- CreateTable
CREATE TABLE "SmtpConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" "SmtpSecurity" NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "replyToEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmtpConfig_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "AutoReplyTask"
ADD COLUMN "sendTransport" "SendTransport" NOT NULL DEFAULT 'MAILBOX_API',
ADD COLUMN "smtpConfigId" TEXT;

-- AlterTable
ALTER TABLE "ReplyAttempt"
ADD COLUMN "transport" "SendTransport" NOT NULL DEFAULT 'MAILBOX_API',
ADD COLUMN "smtpSendStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TemplateRevision"
ADD COLUMN "autoTextContent" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "SmtpConfig_createdAt_idx" ON "SmtpConfig"("createdAt");

-- CreateIndex
CREATE INDEX "AutoReplyTask_smtpConfigId_idx" ON "AutoReplyTask"("smtpConfigId");

-- AddForeignKey
ALTER TABLE "AutoReplyTask" ADD CONSTRAINT "AutoReplyTask_smtpConfigId_fkey"
FOREIGN KEY ("smtpConfigId") REFERENCES "SmtpConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
