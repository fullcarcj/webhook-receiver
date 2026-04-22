-- Historial de ajustes de precio de catálogo (unit_price_usd).
-- Cada vez que un supervisor/admin modifica unit_price_usd queda registrado
-- quién lo hizo, cuál era el valor anterior, cuál es el nuevo y la razón.
--
-- Ejecutar: node scripts/run-sql-file-pg.js sql/20260421_product_unit_price_history.sql

CREATE TABLE IF NOT EXISTS product_unit_price_history (
  id               BIGSERIAL PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  price_before     NUMERIC(12, 4),          -- NULL si era NULL antes del primer ajuste
  price_after      NUMERIC(12, 4) NOT NULL,
  changed_by_id    INTEGER,                  -- users.id (NULL si vino de script/CSV)
  changed_by_name  TEXT,                     -- snapshot del username al momento del cambio
  reason           TEXT,                     -- texto libre del supervisor
  source           TEXT NOT NULL DEFAULT 'ui',
    -- valores: 'ui' | 'csv' | 'api'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_puph_product
  ON product_unit_price_history (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_puph_changed_by
  ON product_unit_price_history (changed_by_id, created_at DESC);

COMMENT ON TABLE product_unit_price_history IS
  'Registro inmutable de cada cambio de unit_price_usd en products. '
  'price_before es el valor vigente justo antes del cambio; '
  'reason explica el motivo del ajuste.';
