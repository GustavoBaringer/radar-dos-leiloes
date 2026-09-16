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
