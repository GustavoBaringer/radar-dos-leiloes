ALTER TABLE onboarding_checkout_attempts
  ADD COLUMN reconciliation_lease_token UUID,
  ADD COLUMN reconciliation_lease_until TIMESTAMPTZ(6),
  ADD CONSTRAINT onboarding_checkout_attempts_reconciliation_lease_ck
    CHECK ((reconciliation_lease_token IS NULL) = (reconciliation_lease_until IS NULL));

ALTER TABLE asaas_webhook_inbox
  DROP CONSTRAINT asaas_webhook_inbox_status_check,
  ADD CONSTRAINT asaas_webhook_inbox_status_check
    CHECK (status IN ('pending_reconciliation', 'ignored', 'reconciled', 'review'));

CREATE TABLE onboarding_initial_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cadastro_id UUID NOT NULL,
  checkout_attempt_id UUID NOT NULL,
  source_event_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  payment_value NUMERIC(10,2) NOT NULL,
  payment_billing_type TEXT NOT NULL,
  subscription_status TEXT NOT NULL,
  subscription_value NUMERIC(10,2) NOT NULL,
  cycle TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'paid_pending_activation',
  observed_at TIMESTAMPTZ(6) NOT NULL,
  activation_invitation_id UUID,
  CONSTRAINT onboarding_initial_payments_state_ck
    CHECK (state IN ('paid_pending_activation', 'review')),
  CONSTRAINT onboarding_initial_payments_cadastro_uk UNIQUE (cadastro_id),
  CONSTRAINT onboarding_initial_payments_attempt_uk UNIQUE (checkout_attempt_id),
  CONSTRAINT onboarding_initial_payments_event_uk UNIQUE (source_event_id),
  CONSTRAINT onboarding_initial_payments_payment_uk UNIQUE (payment_id),
  CONSTRAINT onboarding_initial_payments_subscription_uk UNIQUE (subscription_id),
  CONSTRAINT onboarding_initial_payments_activation_invitation_uk UNIQUE (activation_invitation_id),
  CONSTRAINT onboarding_initial_payments_cadastro_fk
    FOREIGN KEY (cadastro_id) REFERENCES cadastros(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_initial_payments_attempt_fk
    FOREIGN KEY (checkout_attempt_id) REFERENCES onboarding_checkout_attempts(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_initial_payments_event_fk
    FOREIGN KEY (source_event_id) REFERENCES asaas_webhook_inbox(event_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_initial_payments_activation_invitation_fk
    FOREIGN KEY (activation_invitation_id) REFERENCES onboarding_invitations(id) ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX onboarding_initial_payments_state_idx
  ON onboarding_initial_payments (state, observed_at);

CREATE FUNCTION onboarding_initial_payments_immutable_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.cadastro_id, OLD.checkout_attempt_id, OLD.source_event_id, OLD.payment_id,
         OLD.subscription_id, OLD.checkout_id, OLD.payment_status, OLD.payment_value,
         OLD.payment_billing_type, OLD.subscription_status, OLD.subscription_value,
         OLD.cycle, OLD.observed_at)
     IS DISTINCT FROM
     ROW(NEW.cadastro_id, NEW.checkout_attempt_id, NEW.source_event_id, NEW.payment_id,
         NEW.subscription_id, NEW.checkout_id, NEW.payment_status, NEW.payment_value,
         NEW.payment_billing_type, NEW.subscription_status, NEW.subscription_value,
         NEW.cycle, NEW.observed_at) THEN
    RAISE EXCEPTION 'onboarding initial payment binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER onboarding_initial_payments_immutable_binding_trg
  BEFORE UPDATE ON onboarding_initial_payments
  FOR EACH ROW EXECUTE FUNCTION onboarding_initial_payments_immutable_binding();
