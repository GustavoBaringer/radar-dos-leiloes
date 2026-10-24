CREATE TABLE onboarding_registrations (
    cadastro_id UUID PRIMARY KEY,
    email_verified_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT onboarding_registrations_cadastro_fk
      FOREIGN KEY (cadastro_id) REFERENCES cadastros(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE onboarding_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cadastro_id UUID NOT NULL,
    purpose TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ(6) NOT NULL,
    consumed_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT onboarding_invitations_token_hash_uk UNIQUE (token_hash),
    CONSTRAINT onboarding_invitations_purpose_ck CHECK (purpose IN ('checkout-invitation', 'activation')),
    CONSTRAINT onboarding_invitations_registration_fk
      FOREIGN KEY (cadastro_id) REFERENCES onboarding_registrations(cadastro_id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX onboarding_invitations_registration_purpose_idx ON onboarding_invitations(cadastro_id, purpose);
CREATE INDEX onboarding_invitations_expires_idx ON onboarding_invitations(expires_at);

CREATE TABLE onboarding_email_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id UUID NOT NULL,
    encrypted_token BYTEA NOT NULL,
    available_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ(6),
    sent_at TIMESTAMPTZ(6),
    last_error_sanitized TEXT,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT onboarding_email_outbox_invitation_uk UNIQUE (invitation_id),
    CONSTRAINT onboarding_email_outbox_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT onboarding_email_outbox_invitation_fk
      FOREIGN KEY (invitation_id) REFERENCES onboarding_invitations(id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX onboarding_email_outbox_pending_idx ON onboarding_email_outbox(available_at, lease_until)
  WHERE sent_at IS NULL;
