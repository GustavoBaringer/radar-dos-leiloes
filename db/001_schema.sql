-- Modelo canônico do agregador de veículos em leilão.
-- Decisões que o levantamento de fontes impôs (ver plano):
--  * closing_model tem 3 valores porque pregão ao vivo não tem fim por lote.
--  * timestamps sempre UTC + source_tz, porque Copart responde UTC e Superbid BRT.
--  * placa/CPF/licitante nunca entram aqui: mascarados na ingestão.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT,
  method        TEXT NOT NULL,
  tier          SMALLINT NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  site_url      TEXT,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS lots (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES sources(id),
  external_id        TEXT NOT NULL,
  lot_url            TEXT,
  title_raw          TEXT NOT NULL,

  brand              TEXT,
  model              TEXT,
  version            TEXT,
  year_make          INT,
  year_model         INT,
  km                 INT,
  color              TEXT,
  fuel               TEXT,
  plate_masked       TEXT,

  doc_type           TEXT,
  closing_model      TEXT NOT NULL DEFAULT 'pregao_em_horario',
  auction_start_utc  TIMESTAMPTZ,
  auction_end_utc    TIMESTAMPTZ,
  source_tz          TEXT,
  status             TEXT NOT NULL DEFAULT 'sem_data',

  current_bid        NUMERIC(14,2),
  min_bid            NUMERIC(14,2),
  bid_increment      NUMERIC(14,2),
  appraisal          NUMERIC(14,2),
  fees_pct           NUMERIC(6,3),
  fees_amount        NUMERIC(14,2),

  auctioneer_name    TEXT,
  auctioneer_reg     TEXT,
  seller_name        TEXT,
  seller_type        TEXT,

  yard               TEXT,
  city               TEXT,
  state              TEXT,
  lat                DOUBLE PRECISION,
  lon                DOUBLE PRECISION,

  photos             JSONB NOT NULL DEFAULT '[]'::jsonb,
  photo_count        INT NOT NULL DEFAULT 0,
  financeable        BOOLEAN,
  has_report         BOOLEAN,
  raw                JSONB,

  search_text        TEXT NOT NULL DEFAULT '',
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS lots_search_trgm   ON lots USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS lots_brand_model   ON lots (brand, model);
CREATE INDEX IF NOT EXISTS lots_end_at        ON lots (auction_end_utc);
CREATE INDEX IF NOT EXISTS lots_start_at      ON lots (auction_start_utc);
CREATE INDEX IF NOT EXISTS lots_status        ON lots (status);
CREATE INDEX IF NOT EXISTS lots_state         ON lots (state);
CREATE INDEX IF NOT EXISTS lots_price         ON lots (current_bid);

-- Histórico de lance: é o que alimenta o "lance ao vivo" no websocket.
CREATE TABLE IF NOT EXISTS bid_history (
  id          BIGSERIAL PRIMARY KEY,
  lot_id      BIGINT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  bid         NUMERIC(14,2) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_history_lot ON bid_history (lot_id, observed_at DESC);

-- Telemetria de coleta: sem isso não dá para saber que um parser quebrou.
CREATE TABLE IF NOT EXISTS collection_runs (
  id           BIGSERIAL PRIMARY KEY,
  source_id    TEXT NOT NULL,
  job          TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  fetched      INT NOT NULL DEFAULT 0,
  upserted     INT NOT NULL DEFAULT 0,
  skipped      INT NOT NULL DEFAULT 0,
  error        TEXT,
  http_status  INT
);
CREATE INDEX IF NOT EXISTS collection_runs_src ON collection_runs (source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS saved_searches (
  id         BIGSERIAL PRIMARY KEY,
  label      TEXT NOT NULL,
  query      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
