-- Lance atípico da FONTE, não do parser: o Kuss publica "15.500.000,00"
-- num Gol 2014 (conferido na API deles). Não escondemos o dado da fonte,
-- marcamos como suspeito para não contaminar ordenação e credibilidade.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS bid_suspect BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS lots_bid_suspect ON lots (bid_suspect);
