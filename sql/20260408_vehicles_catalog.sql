-- Compatibilidad repuestos ↔ generación (tras crm-solomotor3k.sql).
-- Tablas crm_vehicle_* ya existen; solo se añade product_compatibility e índices útiles.

CREATE TABLE IF NOT EXISTS product_compatibility (
  id              BIGSERIAL PRIMARY KEY,
  generation_id   BIGINT NOT NULL REFERENCES crm_vehicle_generations(id) ON DELETE CASCADE,
  sku             TEXT NOT NULL,
  part_name       TEXT NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (generation_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_generations_model_year
  ON crm_vehicle_generations(model_id, year_start, year_end);

CREATE INDEX IF NOT EXISTS idx_compatibility_generation
  ON product_compatibility(generation_id);

CREATE INDEX IF NOT EXISTS idx_compatibility_sku
  ON product_compatibility(sku);
