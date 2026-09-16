-- Chave de cidade para filtro e agrupamento.
-- Medido em 15/09/2026: 1.971 pares (UF, cidade) no banco colapsam para 1.543
-- quando se ignora caixa e acento — 428 duplicatas. "Curitiba" e "CURITIBA"
-- eram entradas separadas, e filtrar por uma perdia a outra em silêncio.
-- A coluna `city` continua guardando a grafia da fonte; quem filtra é a chave.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS city_key TEXT;
CREATE INDEX IF NOT EXISTS lots_uf_cidade ON lots (state, city_key) WHERE city_key IS NOT NULL;
