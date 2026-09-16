-- Título de exibição, derivado dos campos normalizados.
-- title_raw continua sendo o que a fonte publicou: é ele que alimenta a busca
-- e é ele que prova o que o leiloeiro escreveu. O de exibição é secundário e
-- pode ser recalculado a qualquer momento.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS title_display TEXT;
