-- Tipo do imóvel, espelhando o que vehicle_type faz para veículo.
-- Medido em 15/09/2026: 83% dos imóveis já vêm com categoria da fonte
-- (Caixa normaliza em 5 valores, Superbid tem taxonomia de 20+), mas vlance
-- publica só "imovel" e leilaopro não publica nada — esses dependem do título.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS property_type TEXT;
CREATE INDEX IF NOT EXISTS lots_property_type ON lots (property_type) WHERE property_type IS NOT NULL;
