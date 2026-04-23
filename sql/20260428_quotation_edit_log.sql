-- Auditoría de ediciones de cotización (inventario_presupuesto).
-- Idempotente. Ejecutar: npm run db:quotation-edit-log

CREATE TABLE IF NOT EXISTS quotation_edit_log (
  id               BIGSERIAL PRIMARY KEY,
  presupuesto_id   BIGINT NOT NULL REFERENCES inventario_presupuesto(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_total   NUMERIC,
  new_total        NUMERIC,
  items_snapshot   JSONB
);

CREATE INDEX IF NOT EXISTS idx_quotation_edit_log_presupuesto
  ON quotation_edit_log (presupuesto_id, created_at DESC);

COMMENT ON TABLE quotation_edit_log IS
  'Registro de cambios de ítems/total en cotizaciones inbox (PATCH presupuesto/items).';
