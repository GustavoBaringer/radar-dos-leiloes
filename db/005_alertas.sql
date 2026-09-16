-- Alertas por busca salva: o usuário descreve o que procura e é avisado quando
-- um lote novo casa. O casamento roda na INGESTÃO, contra os lotes que acabaram
-- de entrar, e não numa varredura do índice inteiro.
CREATE TABLE IF NOT EXISTS alerts (
  id           BIGSERIAL PRIMARY KEY,
  label        TEXT NOT NULL,
  q            TEXT,
  filters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  channels     TEXT[] NOT NULL DEFAULT ARRAY['sino'],
  email        TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at  TIMESTAMPTZ
);

-- Um disparo por (alerta, lote): o UNIQUE é o que impede avisar duas vezes o
-- mesmo lote quando a coleta seguinte o traz de novo.
CREATE TABLE IF NOT EXISTS alert_hits (
  id         BIGSERIAL PRIMARY KEY,
  alert_id   BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  lot_id     BIGINT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  seen       BOOLEAN NOT NULL DEFAULT FALSE,
  notified   TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id, lot_id)
);
CREATE INDEX IF NOT EXISTS alert_hits_novos ON alert_hits (seen, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failures   INT NOT NULL DEFAULT 0
);
