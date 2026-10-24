CREATE TABLE "asaas_webhook_inbox" (
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "provider_created_at" TEXT,
  "kind" TEXT NOT NULL,
  "resource" JSONB,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asaas_webhook_inbox_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "asaas_webhook_inbox_kind_check" CHECK ("kind" IN ('payment', 'subscription', 'checkout', 'unsupported')),
  CONSTRAINT "asaas_webhook_inbox_status_check" CHECK ("status" IN ('pending_reconciliation', 'ignored'))
);

CREATE INDEX "asaas_webhook_inbox_pending_idx" ON "asaas_webhook_inbox"("status", "received_at");
