CREATE TABLE onboarding_paid_access_payments (
  payment_id TEXT PRIMARY KEY,
  initial_payment_id UUID NOT NULL,
  source_event_id TEXT NOT NULL,
  confirmed_date DATE NOT NULL,
  starts_at TIMESTAMPTZ(6) NOT NULL,
  ends_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_paid_access_payments_period_ck CHECK (ends_at > starts_at),
  CONSTRAINT onboarding_paid_access_payments_event_uk UNIQUE (source_event_id),
  CONSTRAINT onboarding_paid_access_payments_initial_fk
    FOREIGN KEY (initial_payment_id) REFERENCES onboarding_initial_payments(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_paid_access_payments_event_fk
    FOREIGN KEY (source_event_id) REFERENCES asaas_webhook_inbox(event_id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX onboarding_paid_access_payments_owner_date_idx
  ON onboarding_paid_access_payments (initial_payment_id, confirmed_date, payment_id);
