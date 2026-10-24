ALTER TABLE onboarding_checkout_attempts
  ADD COLUMN email_sent_at TIMESTAMPTZ(6),
  ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN email_lease_until TIMESTAMPTZ(6),
  ADD COLUMN email_next_attempt_at TIMESTAMPTZ(6),
  ADD COLUMN email_error_code TEXT;

CREATE INDEX onboarding_checkout_attempts_email_pending_idx
  ON onboarding_checkout_attempts (email_next_attempt_at, email_lease_until)
  WHERE state = 'created' AND checkout_link IS NOT NULL AND email_sent_at IS NULL;
