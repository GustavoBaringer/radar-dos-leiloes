CREATE TABLE IF NOT EXISTS tenant_collection_attempts (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES collection_runs(id) ON DELETE SET NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  domain TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('cron', 'refresh', 'manual', 'unknown')),
  job_id TEXT CHECK (job_id IS NULL OR length(job_id) <= 200),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'completed', 'partial', 'failed')),
  fetched INTEGER NOT NULL DEFAULT 0 CHECK (fetched >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  returned INTEGER NOT NULL DEFAULT 0 CHECK (returned >= 0),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  http_responses INTEGER NOT NULL DEFAULT 0 CHECK (http_responses >= 0),
  error_kind TEXT CHECK (error_kind IS NULL OR error_kind IN ('network', 'parser', 'http', 'budget', 'no_response')),
  CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE INDEX IF NOT EXISTS tenant_attempts_source_domain_started_idx
  ON tenant_collection_attempts (source_id, domain, started_at DESC);
CREATE INDEX IF NOT EXISTS tenant_attempts_unfinished_idx
  ON tenant_collection_attempts (started_at) WHERE state = 'running';
