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

-- As contas do portão de senha ganham linha para que o dono das linhas
-- existentes exista de fato. O nome vem do papel, não do .env: usuário e senha
-- não são persistidos aqui em nenhuma hipótese.
INSERT INTO users (nome, papel)
SELECT 'Conta administradora (portão de senha)', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE papel = 'admin' AND sub IS NULL);

INSERT INTO users (nome, papel)
SELECT 'Conta comum (portão de senha)', 'comum'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE papel = 'comum' AND sub IS NULL);

-- ---------------------------------------------------------------------------
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
UPDATE alerts             SET owner_id = (SELECT id FROM users WHERE papel='admin' AND sub IS NULL) WHERE owner_id IS NULL;
UPDATE saved_searches     SET owner_id = (SELECT id FROM users WHERE papel='admin' AND sub IS NULL) WHERE owner_id IS NULL;
UPDATE push_subscriptions SET owner_id = (SELECT id FROM users WHERE papel='admin' AND sub IS NULL) WHERE owner_id IS NULL;

-- Toda consulta dessas tabelas passa a filtrar por dono: o índice é o caminho
-- de acesso normal, não uma otimização posterior.
CREATE INDEX IF NOT EXISTS alerts_owner_idx             ON alerts (owner_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS saved_searches_owner_idx     ON saved_searches (owner_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (owner_id);
