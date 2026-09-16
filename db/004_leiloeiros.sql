-- Catálogo de leiloeiros para DESCOBERTA de fontes novas.
-- Só o necessário para achar e priorizar um site: nada de e-mail, telefone
-- ou endereço, que são dado pessoal do leiloeiro e não servem ao produto.
CREATE TABLE IF NOT EXISTS auctioneers (
  id            BIGSERIAL PRIMARY KEY,
  registry      TEXT NOT NULL,              -- de onde veio o cadastro (fenalei)
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  matricula     TEXT,
  junta         TEXT,
  uf            TEXT,
  situacao      TEXT,
  domain        TEXT,
  domain_origin TEXT,                       -- 'declarado' | 'email' | null
  blocked       BOOLEAN NOT NULL DEFAULT FALSE,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registry, external_id)
);
CREATE INDEX IF NOT EXISTS auctioneers_domain ON auctioneers (domain);
CREATE INDEX IF NOT EXISTS auctioneers_situacao ON auctioneers (situacao);

-- Um domínio pode pertencer a vários leiloeiros (mesmo site, várias juntas).
CREATE TABLE IF NOT EXISTS discovered_sites (
  domain        TEXT PRIMARY KEY,
  auctioneers   INT NOT NULL DEFAULT 1,
  ufs           TEXT[],
  http_status   INT,
  has_lots      BOOLEAN,
  platform      TEXT,
  connector_id  TEXT REFERENCES sources(id), -- preenchido quando já coletamos
  title         TEXT,
  checked_at    TIMESTAMPTZ,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS sites_platform ON discovered_sites (platform);
CREATE INDEX IF NOT EXISTS sites_haslots ON discovered_sites (has_lots);
