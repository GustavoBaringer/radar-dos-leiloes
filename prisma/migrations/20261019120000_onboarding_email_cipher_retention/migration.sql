ALTER TABLE onboarding_email_outbox
  ALTER COLUMN encrypted_token DROP NOT NULL;

ALTER TABLE onboarding_email_outbox
  ADD CONSTRAINT onboarding_email_outbox_cipher_retention_ck CHECK (
    (sent_at IS NOT NULL AND encrypted_token IS NULL)
    OR (sent_at IS NULL AND (encrypted_token IS NOT NULL OR last_error_sanitized IS NOT NULL))
  );
