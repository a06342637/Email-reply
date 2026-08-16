ALTER TABLE "MicrosoftAppConfig"
  ALTER COLUMN "id" DROP DEFAULT,
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '默认 Microsoft 应用',
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "GoogleAppConfig"
  ALTER COLUMN "id" DROP DEFAULT,
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '默认 Google / Gmail 应用',
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "OAuthState"
  ADD COLUMN "microsoftAppConfigId" TEXT,
  ADD COLUMN "googleAppConfigId" TEXT;

ALTER TABLE "Mailbox"
  ADD COLUMN "microsoftAppConfigId" TEXT,
  ADD COLUMN "googleAppConfigId" TEXT;

UPDATE "OAuthState"
SET "microsoftAppConfigId" = 'singleton'
WHERE "provider" = 'MICROSOFT'
  AND EXISTS (SELECT 1 FROM "MicrosoftAppConfig" WHERE "id" = 'singleton');

UPDATE "OAuthState"
SET "googleAppConfigId" = 'singleton'
WHERE "provider" = 'GOOGLE'
  AND EXISTS (SELECT 1 FROM "GoogleAppConfig" WHERE "id" = 'singleton');

UPDATE "Mailbox"
SET "microsoftAppConfigId" = 'singleton'
WHERE "provider" = 'MICROSOFT'
  AND "microsoftAuthMode" = 'MSAL_OAUTH'
  AND "status" <> 'REMOVED'
  AND EXISTS (SELECT 1 FROM "MicrosoftAppConfig" WHERE "id" = 'singleton');

UPDATE "Mailbox"
SET "googleAppConfigId" = 'singleton'
WHERE "provider" = 'GOOGLE'
  AND "status" <> 'REMOVED'
  AND EXISTS (SELECT 1 FROM "GoogleAppConfig" WHERE "id" = 'singleton');

CREATE INDEX "MicrosoftAppConfig_createdAt_idx" ON "MicrosoftAppConfig"("createdAt");
CREATE INDEX "GoogleAppConfig_createdAt_idx" ON "GoogleAppConfig"("createdAt");
CREATE INDEX "OAuthState_microsoftAppConfigId_idx" ON "OAuthState"("microsoftAppConfigId");
CREATE INDEX "OAuthState_googleAppConfigId_idx" ON "OAuthState"("googleAppConfigId");
CREATE INDEX "Mailbox_microsoftAppConfigId_idx" ON "Mailbox"("microsoftAppConfigId");
CREATE INDEX "Mailbox_googleAppConfigId_idx" ON "Mailbox"("googleAppConfigId");

ALTER TABLE "OAuthState"
  ADD CONSTRAINT "OAuthState_microsoftAppConfigId_fkey"
  FOREIGN KEY ("microsoftAppConfigId") REFERENCES "MicrosoftAppConfig"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OAuthState"
  ADD CONSTRAINT "OAuthState_googleAppConfigId_fkey"
  FOREIGN KEY ("googleAppConfigId") REFERENCES "GoogleAppConfig"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mailbox"
  ADD CONSTRAINT "Mailbox_microsoftAppConfigId_fkey"
  FOREIGN KEY ("microsoftAppConfigId") REFERENCES "MicrosoftAppConfig"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Mailbox"
  ADD CONSTRAINT "Mailbox_googleAppConfigId_fkey"
  FOREIGN KEY ("googleAppConfigId") REFERENCES "GoogleAppConfig"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
