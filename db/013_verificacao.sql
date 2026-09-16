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
