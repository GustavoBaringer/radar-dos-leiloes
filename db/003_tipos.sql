-- Tipo de leilão (veículo/imóvel) e tipo de veículo.
-- Hoje só há veículo; a coluna nasce agora para o conector de imóvel
-- não exigir migração de dados depois.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS asset_type   TEXT NOT NULL DEFAULT 'veiculo';
ALTER TABLE lots ADD COLUMN IF NOT EXISTS vehicle_type TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS source_category TEXT;

CREATE INDEX IF NOT EXISTS lots_asset_type   ON lots (asset_type);
CREATE INDEX IF NOT EXISTS lots_vehicle_type ON lots (vehicle_type);
