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
