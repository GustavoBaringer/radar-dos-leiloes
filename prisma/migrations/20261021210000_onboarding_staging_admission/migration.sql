CREATE TABLE onboarding_staging_admission (
  id INTEGER PRIMARY KEY,
  issuer TEXT NOT NULL,
  initialized_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  baseline_initialized BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT onboarding_staging_admission_singleton_ck CHECK (id = 1),
  CONSTRAINT onboarding_staging_admission_initialized_ck CHECK (baseline_initialized)
);

CREATE TABLE onboarding_staging_baseline_users (
  user_id BIGINT PRIMARY KEY,
  policy_id INTEGER NOT NULL DEFAULT 1,
  marked_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_staging_baseline_users_policy_ck CHECK (policy_id = 1),
  CONSTRAINT onboarding_staging_baseline_users_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT onboarding_staging_baseline_users_policy_fk
    FOREIGN KEY (policy_id) REFERENCES onboarding_staging_admission(id) ON DELETE CASCADE ON UPDATE NO ACTION
);
