-- Canonical schema baseline. Data/bootstrap/backfill statements intentionally omitted.
-- Source: 001_schema.sql
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

-- Source: 002_sanidade.sql
-- Lance atípico da FONTE, não do parser: o Kuss publica "15.500.000,00"
-- num Gol 2014 (conferido na API deles). Não escondemos o dado da fonte,
-- marcamos como suspeito para não contaminar ordenação e credibilidade.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS bid_suspect BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS lots_bid_suspect ON lots (bid_suspect);

-- Source: 003_tipos.sql
-- Tipo de leilão (veículo/imóvel) e tipo de veículo.
-- Hoje só há veículo; a coluna nasce agora para o conector de imóvel
-- não exigir migração de dados depois.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS asset_type   TEXT NOT NULL DEFAULT 'veiculo';
ALTER TABLE lots ADD COLUMN IF NOT EXISTS vehicle_type TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS source_category TEXT;

CREATE INDEX IF NOT EXISTS lots_asset_type   ON lots (asset_type);
CREATE INDEX IF NOT EXISTS lots_vehicle_type ON lots (vehicle_type);

-- Source: 004_leiloeiros.sql
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

-- Source: 005_alertas.sql
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

-- Source: 006_fenaju.sql
-- Campos que o cadastro do FENAJU traz e o anterior não tinha.
-- `dominio_leilao` é o subdomínio *.leilao.br que a federação atribui a cada
-- leiloeiro: é um vetor de descoberta que não existia.
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS uf_junta       TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS ano_posse      TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS credenciamento TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS associado      BOOLEAN;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS nivel          TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS dominio_leilao TEXT;
CREATE INDEX IF NOT EXISTS auctioneers_uf ON auctioneers (uf_junta);
CREATE INDEX IF NOT EXISTS auctioneers_dom_leilao ON auctioneers (dominio_leilao);

-- Source: 007_tipo_imovel.sql
-- Tipo do imóvel, espelhando o que vehicle_type faz para veículo.
-- Medido em 15/09/2026: 83% dos imóveis já vêm com categoria da fonte
-- (Caixa normaliza em 5 valores, Superbid tem taxonomia de 20+), mas vlance
-- publica só "imovel" e leilaopro não publica nada — esses dependem do título.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS property_type TEXT;
CREATE INDEX IF NOT EXISTS lots_property_type ON lots (property_type) WHERE property_type IS NOT NULL;

-- Source: 008_cidade.sql
-- Chave de cidade para filtro e agrupamento.
-- Medido em 15/09/2026: 1.971 pares (UF, cidade) no banco colapsam para 1.543
-- quando se ignora caixa e acento — 428 duplicatas. "Curitiba" e "CURITIBA"
-- eram entradas separadas, e filtrar por uma perdia a outra em silêncio.
-- A coluna `city` continua guardando a grafia da fonte; quem filtra é a chave.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS city_key TEXT;
CREATE INDEX IF NOT EXISTS lots_uf_cidade ON lots (state, city_key) WHERE city_key IS NOT NULL;

-- Source: 009_titulo.sql
-- Título de exibição, derivado dos campos normalizados.
-- title_raw continua sendo o que a fonte publicou: é ele que alimenta a busca
-- e é ele que prova o que o leiloeiro escreveu. O de exibição é secundário e
-- pode ser recalculado a qualquer momento.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS title_display TEXT;

-- Source: 010_espera.sql
-- Lista de espera da landing.
--
-- Guardar e-mail de terceiro tem finalidade declarada e prazo: a pessoa pede
-- para ser avisada quando a conta abrir. Por isso a tabela registra o consentimento
-- (o texto que ela leu) junto com o dado, e não só o dado — sem isso não há como
-- provar a base legal depois. `origem` separa quem veio da landing de quem
-- vier de outra campanha.
CREATE TABLE IF NOT EXISTS espera (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL,
  nome          text,
  interesse     text,
  origem        text NOT NULL DEFAULT 'landing',
  consentimento text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- O mesmo e-mail não entra duas vezes: o formulário reenviado é o caso comum,
-- e duplicata vira dois avisos para a mesma pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS espera_email_uk ON espera (lower(email));

-- Source: 011_usuarios.sql
-- Fase 0 da autenticação: dono.
--
-- Antes disto nada tinha dono, porque "usuário" era uma senha compartilhada:
-- quem entrava via e apagava os alertas de todo mundo. Trocar o portão por
-- Keycloak sem esta migração entregaria um sistema multiusuário em que todos
-- leem os alertas dos outros — o provedor de identidade não resolve posse.

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  -- `sub` é o identificador do provedor de identidade (o claim `sub` do OIDC).
  -- Fica NULL para as contas do portão de senha, que não vêm de provedor nenhum.
  -- É o que permite os dois modos coexistirem durante a migração.
  sub         TEXT,
  email       TEXT,
  nome        TEXT,
  papel       TEXT NOT NULL DEFAULT 'comum' CHECK (papel IN ('admin', 'comum')),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  visto_em    TIMESTAMPTZ
);

-- Duas identidades não podem colidir, mas as duas colunas são opcionais:
-- índice parcial, senão vários NULL disputariam a mesma chave.
CREATE UNIQUE INDEX IF NOT EXISTS users_sub_uk ON users (sub) WHERE sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uk ON users (lower(email)) WHERE email IS NOT NULL;

-- Dono nas tabelas que são de alguém.
--
-- `owner_id` entra NULLABLE de propósito: as linhas que já existem precisam de
-- dono antes de a coluna poder ser obrigatória, e o UPDATE abaixo faz isso.
-- Deixar NOT NULL com DEFAULT apontando para o admin seria pior: lote novo
-- gravado sem dono passaria silenciosamente a ser do administrador.
-- ---------------------------------------------------------------------------

ALTER TABLE alerts             ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE saved_searches     ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- As linhas de antes da migração passam a ser do admin do portão: é quem de
-- fato as criou, já que era a única conta com permissão de escrita.

-- Toda consulta dessas tabelas passa a filtrar por dono: o índice é o caminho
-- de acesso normal, não uma otimização posterior.
CREATE INDEX IF NOT EXISTS alerts_owner_idx             ON alerts (owner_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS saved_searches_owner_idx     ON saved_searches (owner_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (owner_id);

-- Source: 012_encerramento.sql
-- Encerramento automático de lote.
--
-- Até aqui NADA fechava lote: o único lugar que escrevia `lots.status` era o
-- upsert da coleta, com o valor que o conector calculou naquele momento. Quando
-- a fonte parava de devolver um lote, a linha nunca mais era tocada e ficava
-- aberta para sempre. Medido no dia desta migração: 3.402 lotes vencidos ainda
-- como abertos/agendados, e o número subia sozinho a cada hora.

-- O limite da coleta separa coleta COMPLETA de refresh quente. Sem ele os dois
-- gravam `job='collect'` e é impossível saber, olhando a telemetria, se o
-- catálogo inteiro foi varrido ou só os 120 lotes que encerram em menos de 1h —
-- e a regra de "não visto na última varredura completa" depende dessa distinção.
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS limite INT;

-- Quem fechou o lote, para a tela poder explicar e para a regra poder ser
-- auditada depois. NULL = veio fechado da própria fonte.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- O job varre por prazo vencido a cada minuto. Sem índice isso é seq scan em
-- 23 mil linhas por minuto — barato hoje, caro na escala que o plano prevê.
CREATE INDEX IF NOT EXISTS lots_encerrar_timer_idx
  ON lots (auction_end_utc)
  WHERE status IN ('aberto','agendado') AND closing_model = 'timer_por_lote';

CREATE INDEX IF NOT EXISTS lots_encerrar_pregao_idx
  ON lots (auction_start_utc)
  WHERE status IN ('aberto','agendado') AND closing_model <> 'timer_por_lote';

-- A regra de ausência varre por fonte + última vez visto.
CREATE INDEX IF NOT EXISTS lots_ausencia_idx
  ON lots (source_id, collected_at)
  WHERE status IN ('aberto','agendado');

-- Source: 013_verificacao.sql
-- Verificação do lote na origem, antes de encerrar.
--
-- A regra de "não apareceu nas últimas varreduras" foi medida e reprovada: em
-- 25 lotes do soleon que ela fecharia, 19 estavam VIVOS. Ausência na nossa
-- varredura mede a COBERTURA DELA, não o estado do lote na fonte. Três causas
-- distintas, todas medidas:
--   soleon — a rota global lista leilão em andamento; lote de leilão por abrir some
--   vlance — 15 hosts com lote no índice estão fora da lista de tenants varridos
--   leilo  — em apuração
--
-- Então o encerramento por ausência passa a ser: a ausência PROPÕE, a origem DECIDE.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS verified_at     TIMESTAMPTZ;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS verify_result   TEXT;
-- Quantas verificações seguidas não conseguiram decidir. Alimenta o recuo: lote
-- que a fonte não sabe responder não pode ser reconsultado a cada ciclo para sempre.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS verify_fails    INT NOT NULL DEFAULT 0;

-- A fila pega candidatos por (fonte, nunca verificado ou verificado há mais tempo).
CREATE INDEX IF NOT EXISTS lots_verificar_idx
  ON lots (source_id, verified_at NULLS FIRST)
  WHERE status IN ('aberto','agendado');

-- Source: 014_favoritos.sql
-- Favoritos: guardar um lote para achar de novo depois, sem precisar de um
-- alerta (que casa por busca, não por lote específico).

CREATE TABLE IF NOT EXISTS favorites (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id     BIGINT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, lot_id)
);

CREATE INDEX IF NOT EXISTS favorites_owner_idx ON favorites (owner_id);

-- Source: 015_cadastros.sql
-- Cadastro de assinante (substitui a lista de espera como CTA da landing).
--
-- Dado de cartão NUNCA entra aqui: o pagamento acontece na fatura/checkout
-- hospedado do ASAAS, e só os ids que ele devolve (customer, subscription)
-- ficam guardados. O consentimento vai junto com o texto que a pessoa leu,
-- pelo mesmo motivo da tabela `espera`: provar a base legal depois.
-- gen_random_uuid() é nativo desde o Postgres 13, sem pgcrypto.
CREATE TABLE IF NOT EXISTS cadastros (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                    text NOT NULL,
  cpf_cnpj                text NOT NULL,
  tipo_documento          text NOT NULL CHECK (tipo_documento IN ('CPF','CNPJ')),
  email                   text NOT NULL,
  celular                 text NOT NULL,
  status                  text NOT NULL DEFAULT 'pendente_pagamento'
    CHECK (status IN ('pendente_pagamento','aguardando_confirmacao','ativo','inadimplente','cancelado','estornado')),
  plano                   text NOT NULL DEFAULT 'mensal',
  valor_mensal            numeric(10,2) NOT NULL DEFAULT 69.90,
  asaas_customer_id       text UNIQUE,
  asaas_subscription_id   text UNIQUE,
  consentimento_termos_em timestamptz NOT NULL,
  consentimento_versao    text NOT NULL,
  consentimento_texto     text NOT NULL,
  consentimento_ip        text,
  consentimento_marketing boolean NOT NULL DEFAULT false,
  origem                  text,
  criado_em               timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cadastros_cpf_cnpj_uk ON cadastros (cpf_cnpj);
CREATE UNIQUE INDEX IF NOT EXISTS cadastros_email_uk ON cadastros (email);
CREATE INDEX IF NOT EXISTS cadastros_status_idx ON cadastros (status);

-- Source: 016_tenant_collection_attempts.sql
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
