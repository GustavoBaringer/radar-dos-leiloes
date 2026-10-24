CREATE TABLE onboarding_activation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id UUID NOT NULL,
  cadastro_id UUID NOT NULL,
  state_hash TEXT NOT NULL,
  browser_token_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  encrypted_verifier BYTEA,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  consumed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_activation_intents_state_ck
    CHECK (state IN ('pending', 'exchanging', 'bound', 'failed')),
  CONSTRAINT onboarding_activation_intents_hash_ck
    CHECK (state_hash ~ '^[0-9a-f]{64}$' AND browser_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT onboarding_activation_intents_nonce_ck
    CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT onboarding_activation_intents_verifier_ck
    CHECK (encrypted_verifier IS NULL OR (octet_length(encrypted_verifier)=72 AND get_byte(encrypted_verifier, 0)=1)),
  CONSTRAINT onboarding_activation_intents_terminal_ck CHECK (
    (state IN ('pending', 'exchanging') AND encrypted_verifier IS NOT NULL AND consumed_at IS NULL)
    OR (state IN ('bound', 'failed') AND encrypted_verifier IS NULL AND consumed_at IS NOT NULL)
  ),
  CONSTRAINT onboarding_activation_intents_invitation_uk UNIQUE (invitation_id),
  CONSTRAINT onboarding_activation_intents_cadastro_uk UNIQUE (cadastro_id),
  CONSTRAINT onboarding_activation_intents_state_hash_uk UNIQUE (state_hash),
  CONSTRAINT onboarding_activation_intents_browser_hash_uk UNIQUE (browser_token_hash),
  CONSTRAINT onboarding_activation_intents_cadastro_fk
    FOREIGN KEY (cadastro_id) REFERENCES cadastros(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_activation_intents_invitation_fk
    FOREIGN KEY (invitation_id) REFERENCES onboarding_invitations(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX onboarding_activation_intents_state_idx ON onboarding_activation_intents (state, expires_at);

CREATE TABLE onboarding_identity_bindings (
  cadastro_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  intent_id UUID NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  bound_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_identity_bindings_user_uk UNIQUE (user_id),
  CONSTRAINT onboarding_identity_bindings_intent_uk UNIQUE (intent_id),
  CONSTRAINT onboarding_identity_bindings_issuer_subject_uk UNIQUE (issuer, subject),
  CONSTRAINT onboarding_identity_bindings_cadastro_fk
    FOREIGN KEY (cadastro_id) REFERENCES cadastros(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT onboarding_identity_bindings_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT onboarding_identity_bindings_intent_fk
    FOREIGN KEY (intent_id) REFERENCES onboarding_activation_intents(id) ON DELETE CASCADE ON UPDATE NO ACTION
);
