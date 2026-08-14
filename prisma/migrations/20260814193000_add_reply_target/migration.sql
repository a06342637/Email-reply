-- Preserve the authenticated From/Sender identity separately from the
-- address used by an ordinary Reply when a valid Reply-To header is present.
ALTER TABLE "MessageReceipt" ADD COLUMN "replyToEmail" TEXT;
