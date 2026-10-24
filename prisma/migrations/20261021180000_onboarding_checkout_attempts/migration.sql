CREATE TABLE onboarding_checkout_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cadastro_id UUID NOT NULL,
    invitation_id UUID NOT NULL,
    state TEXT NOT NULL DEFAULT 'requested',
    price_cents INTEGER NOT NULL DEFAULT 6990,
    currency TEXT NOT NULL DEFAULT 'BRL',
    billing_type TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    cycle TEXT NOT NULL DEFAULT 'MONTHLY',
    next_due_date DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date),
    checkout_id TEXT,
    checkout_link TEXT,
    safe_error_code TEXT,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT onboarding_checkout_attempts_state_ck
      CHECK (state IN ('requested', 'dispatching', 'created', 'rejected', 'unknown')),
    CONSTRAINT onboarding_checkout_attempts_price_ck CHECK (price_cents = 6990),
    CONSTRAINT onboarding_checkout_attempts_currency_ck CHECK (currency = 'BRL'),
    CONSTRAINT onboarding_checkout_attempts_billing_type_ck CHECK (billing_type = 'CREDIT_CARD'),
    CONSTRAINT onboarding_checkout_attempts_cycle_ck CHECK (cycle = 'MONTHLY'),
    CONSTRAINT onboarding_checkout_attempts_safe_error_ck
      CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$'),
    CONSTRAINT onboarding_checkout_attempts_invitation_uk UNIQUE (invitation_id),
    CONSTRAINT onboarding_checkout_attempts_checkout_id_uk UNIQUE (checkout_id),
    CONSTRAINT onboarding_checkout_attempts_cadastro_fk
      FOREIGN KEY (cadastro_id) REFERENCES cadastros(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT onboarding_checkout_attempts_invitation_fk
      FOREIGN KEY (invitation_id) REFERENCES onboarding_invitations(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX onboarding_checkout_attempts_active_cadastro_uk
  ON onboarding_checkout_attempts (cadastro_id)
  WHERE state IN ('requested', 'dispatching', 'created', 'unknown');
CREATE INDEX onboarding_checkout_attempts_queue_idx
  ON onboarding_checkout_attempts (state, created_at)
  WHERE state = 'requested';
