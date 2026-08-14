-- Outbox recovery, task pause/delete, authorization loss and direct Webhook
-- delivery all locate durable work by its aggregate receipt/alert ID.
CREATE INDEX "TransactionalOutbox_aggregateId_kind_idx"
ON "TransactionalOutbox"("aggregateId", "kind");
