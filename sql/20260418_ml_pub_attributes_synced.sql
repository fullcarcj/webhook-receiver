-- ============================================================
-- Módulo: Sincronización de atributos ML
-- Agrega columna attributes_synced a ml_publications para
-- rastrear qué publicaciones tienen sus atributos de
-- compatibilidad vehicular sincronizados con ML.
-- Idempotente (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE ml_publications
  ADD COLUMN IF NOT EXISTS attributes_synced     BOOLEAN   DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS attributes_synced_at  TIMESTAMPTZ;

COMMENT ON COLUMN ml_publications.attributes_synced
  IS 'TRUE si los atributos de compatibilidad vehicular ya fueron enviados a ML vía PUT /items/:id';
COMMENT ON COLUMN ml_publications.attributes_synced_at
  IS 'Timestamp de la última sincronización de atributos a ML';

CREATE INDEX IF NOT EXISTS idx_ml_pub_attrs_not_synced
  ON ml_publications (ml_item_id, attributes_synced)
  WHERE attributes_synced IS DISTINCT FROM TRUE;
