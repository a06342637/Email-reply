CREATE TYPE "MicrosoftAuthMode" AS ENUM ('MSAL_OAUTH', 'CLIENT_ID_REFRESH_TOKEN');

ALTER TABLE "Mailbox"
ADD COLUMN "microsoftAuthMode" "MicrosoftAuthMode" NOT NULL DEFAULT 'MSAL_OAUTH',
ADD COLUMN "microsoftClientId" TEXT;

CREATE INDEX "Mailbox_provider_microsoftAuthMode_status_idx"
ON "Mailbox"("provider", "microsoftAuthMode", "status");
