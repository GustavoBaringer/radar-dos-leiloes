ALTER TABLE asaas_webhook_inbox
  ADD COLUMN reconciliation_attempted_at TIMESTAMPTZ(6);

CREATE INDEX asaas_webhook_inbox_queue_idx
  ON asaas_webhook_inbox (kind, reconciliation_attempted_at, received_at)
  WHERE kind = 'payment' AND status IN ('pending_reconciliation', 'reconciled');
