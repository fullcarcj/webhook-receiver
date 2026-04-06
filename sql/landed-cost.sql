-- Archivo creado para consolidar cambios del módulo landed cost + shipping dinámico.
-- Si ya tienes un DDL previo en otro entorno, aplica únicamente este bloque ALTER al final.

ALTER TABLE import_shipment_lines
  ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT
    REFERENCES shipping_categories(id),
  ADD COLUMN IF NOT EXISTS volume_cbm_used NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS freight_line_usd NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS rate_snapshot_cbm NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS freight_source TEXT;

