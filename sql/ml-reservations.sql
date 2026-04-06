-- Reservas de stock por órdenes ML (WMS)
-- Prerequisitos: productos(sku), warehouse_bins(id), sql/wms-bins.sql
-- Nota: no existe `producto_bins` en este repo; la prioridad de bin se resuelve en SQL en reservationService.js (is_primary + qty).

CREATE TABLE IF NOT EXISTS ml_order_reservations (
  id               BIGSERIAL PRIMARY KEY,
  ml_order_id      BIGINT    NOT NULL,
  ml_resource_url  TEXT,
  producto_sku     TEXT      NOT NULL REFERENCES productos(sku),
  bin_id           BIGINT    NOT NULL REFERENCES warehouse_bins(id),
  qty_reserved     NUMERIC(18,4) NOT NULL,
  status           TEXT      NOT NULL DEFAULT 'ACTIVE',
  reserved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  CONSTRAINT uq_order_sku_bin UNIQUE (ml_order_id, producto_sku, bin_id),
  CONSTRAINT chk_qty_positive CHECK (qty_reserved > 0),
  CONSTRAINT chk_status       CHECK (status IN ('ACTIVE','COMMITTED','RELEASED'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_order
  ON ml_order_reservations (ml_order_id);

CREATE INDEX IF NOT EXISTS idx_reservations_sku_active
  ON ml_order_reservations (producto_sku)
  WHERE status = 'ACTIVE';
