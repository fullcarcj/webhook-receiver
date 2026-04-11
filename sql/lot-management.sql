-- Lotes y shelf-life (Ferrari ERP / Solomotor3k)
-- Prerrequisitos: products(sku) — catálogo canónico; bin_stock, warehouse_bins (+ jerarquía WMS), import_shipments(id), set_updated_at()
-- Nota: `productos` es legacy; FKs y flags de lote viven en `products`.
-- Idempotente: IF NOT EXISTS, DO $$ para ENUMs.
-- Si ya ejecutaste una versión anterior que referenciaba productos(sku), corre también:
--   npm run db:lots-management-products-patch

-- ─────────────────────────────────────────────────────
-- 1. Columnas nuevas en products
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS requires_lot_tracking BOOLEAN
    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_shelf_life_days INTEGER;

COMMENT ON COLUMN products.requires_lot_tracking IS 'TRUE = juntas/sellos/filtros; FALSE = válvulas acero (default)';
COMMENT ON COLUMN products.default_shelf_life_days IS 'Vida útil estándar del SKU en días (opcional)';

-- ─────────────────────────────────────────────────────
-- 2. ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE lot_status AS ENUM (
    'ACTIVE',
    'QUARANTINE',
    'EXPIRED',
    'EXHAUSTED',
    'RECALLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lot_movement_type AS ENUM (
    'RECEIPT',
    'DISPATCH',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'RESERVATION',
    'RESERVATION_CANCEL',
    'ADJUSTMENT_UP',
    'ADJUSTMENT_DOWN',
    'QUARANTINE_IN',
    'QUARANTINE_OUT',
    'EXPIRED_WRITEOFF'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────
-- 3. product_lots
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_lots (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           INTEGER    NOT NULL DEFAULT 1,
  producto_sku         TEXT       NOT NULL REFERENCES products(sku),

  lot_number           TEXT       NOT NULL,
  supplier_lot_number  TEXT,

  import_shipment_id   BIGINT
    REFERENCES import_shipments(id),

  manufacture_date     DATE,
  expiration_date      DATE,
  received_date        DATE       NOT NULL DEFAULT CURRENT_DATE,

  status               lot_status NOT NULL DEFAULT 'ACTIVE',
  quarantine_reason    TEXT,

  qty_initial          NUMERIC(18,4) NOT NULL,

  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_lot_number   UNIQUE (company_id, producto_sku, lot_number),
  CONSTRAINT chk_qty_initial CHECK  (qty_initial > 0),
  CONSTRAINT chk_expiry      CHECK  (
    expiration_date IS NULL OR
    manufacture_date IS NULL OR
    expiration_date > manufacture_date
  )
);

CREATE INDEX IF NOT EXISTS idx_lots_sku
  ON product_lots (producto_sku, status);
CREATE INDEX IF NOT EXISTS idx_lots_expiration
  ON product_lots (expiration_date)
  WHERE expiration_date IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_lots_shipment
  ON product_lots (import_shipment_id)
  WHERE import_shipment_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_lots_updated_at ON product_lots;
CREATE TRIGGER trg_lots_updated_at
  BEFORE UPDATE ON product_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- 4. lot_bin_stock
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lot_bin_stock (
  id            BIGSERIAL PRIMARY KEY,
  lot_id        BIGINT        NOT NULL REFERENCES product_lots(id),
  bin_id        BIGINT        NOT NULL REFERENCES warehouse_bins(id),
  producto_sku  TEXT          NOT NULL REFERENCES productos(sku),
  qty_available NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_reserved  NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_total     NUMERIC(18,4) GENERATED ALWAYS AS
                  (qty_available + qty_reserved) STORED,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_lot_bin_sku    UNIQUE (lot_id, bin_id, producto_sku),
  CONSTRAINT chk_lbs_available CHECK  (qty_available >= 0),
  CONSTRAINT chk_lbs_reserved  CHECK  (qty_reserved  >= 0)
);

CREATE INDEX IF NOT EXISTS idx_lbs_lot
  ON lot_bin_stock (lot_id);
CREATE INDEX IF NOT EXISTS idx_lbs_bin_sku
  ON lot_bin_stock (bin_id, producto_sku);
CREATE INDEX IF NOT EXISTS idx_lbs_sku_available
  ON lot_bin_stock (producto_sku)
  WHERE qty_available > 0;

DROP TRIGGER IF EXISTS trg_lbs_updated_at ON lot_bin_stock;
CREATE TRIGGER trg_lbs_updated_at
  BEFORE UPDATE ON lot_bin_stock
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- 5. lot_movements (append-only)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lot_movements (
  id            BIGSERIAL PRIMARY KEY,
  lot_id        BIGINT    NOT NULL REFERENCES product_lots(id),
  bin_id        BIGINT    NOT NULL REFERENCES warehouse_bins(id),
  producto_sku  TEXT      NOT NULL,
  movement_type lot_movement_type NOT NULL,
  qty           NUMERIC(18,4) NOT NULL,
  reference_type TEXT,
  reference_id   TEXT,
  user_id        TEXT,
  notes          TEXT,
  moved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_qty_not_zero CHECK (qty != 0)
);

CREATE INDEX IF NOT EXISTS idx_lmov_lot
  ON lot_movements (lot_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_lmov_sku
  ON lot_movements (producto_sku, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_lmov_reference
  ON lot_movements (reference_type, reference_id);

-- ─────────────────────────────────────────────────────
-- 6. generate_lot_number()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_lot_number(
  p_sku  TEXT,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_seq    INT;
  v_prefix TEXT;
BEGIN
  SELECT COUNT(*)::INT + 1 INTO v_seq
  FROM product_lots
  WHERE producto_sku = p_sku
    AND received_date = p_date;

  v_prefix := UPPER(LEFT(REPLACE(p_sku, '-', ''), 8));

  RETURN v_prefix
    || '-' || TO_CHAR(p_date, 'YYYYMMDD')
    || '-' || LPAD(v_seq::TEXT, 3, '0');
END;
$$;

-- ─────────────────────────────────────────────────────
-- 7. auto_expire_lot()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_expire_lot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expiration_date IS NOT NULL
     AND NEW.expiration_date < CURRENT_DATE
     AND NEW.status = 'ACTIVE' THEN
    NEW.status := 'EXPIRED'::lot_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_expire_lot ON product_lots;
CREATE TRIGGER trg_auto_expire_lot
  BEFORE INSERT OR UPDATE ON product_lots
  FOR EACH ROW EXECUTE FUNCTION auto_expire_lot();

-- ─────────────────────────────────────────────────────
-- 8. expire_lots_daily()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expire_lots_daily()
RETURNS TABLE (expired_count INT, skus_affected TEXT[])
LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
  v_skus  TEXT[];
BEGIN
  WITH upd AS (
    UPDATE product_lots pl
    SET status = 'EXPIRED'::lot_status,
        updated_at = now()
    WHERE pl.expiration_date < CURRENT_DATE
      AND pl.status = 'ACTIVE'::lot_status
    RETURNING pl.producto_sku
  )
  SELECT
    COALESCE((SELECT COUNT(*)::INT FROM upd), 0),
    COALESCE((SELECT ARRAY_AGG(DISTINCT u.producto_sku) FROM upd u), ARRAY[]::TEXT[])
  INTO v_count, v_skus;

  RETURN QUERY SELECT v_count, COALESCE(v_skus, ARRAY[]::TEXT[]);
END;
$$;

-- ─────────────────────────────────────────────────────
-- 9. Vista v_lots_fefo (sugerencia; el operador elige lote)
-- warehouse_bins no tiene status: se filtra bodega activa.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_lots_fefo AS
SELECT
  lbs.producto_sku,
  COALESCE(NULLIF(TRIM(p.description), ''), p.sku) AS descripcion,
  l.lot_number,
  l.supplier_lot_number,
  l.expiration_date,
  l.manufacture_date,
  l.received_date,
  l.status        AS lot_status,
  wb.bin_code,
  wa.aisle_number,
  ws.shelf_number,
  wb.level,
  lbs.bin_id,
  lbs.lot_id,
  lbs.qty_available,
  lbs.qty_reserved,
  CASE
    WHEN l.expiration_date IS NULL THEN NULL
    ELSE l.expiration_date - CURRENT_DATE
  END AS days_until_expiry,
  CASE
    WHEN l.expiration_date IS NULL               THEN 'NO_EXPIRY'
    WHEN l.expiration_date < CURRENT_DATE        THEN 'EXPIRED'
    WHEN l.expiration_date <= CURRENT_DATE + 30  THEN 'CRITICAL'
    WHEN l.expiration_date <= CURRENT_DATE + 90  THEN 'WARNING'
    ELSE 'OK'
  END AS expiry_alert
FROM lot_bin_stock      lbs
JOIN product_lots       l   ON l.id  = lbs.lot_id
JOIN products           p   ON p.sku = lbs.producto_sku
JOIN warehouse_bins     wb  ON wb.id = lbs.bin_id
JOIN warehouse_shelves  ws  ON ws.id = wb.shelf_id
JOIN warehouse_aisles   wa  ON wa.id = ws.aisle_id
JOIN warehouses         w   ON w.id  = wa.warehouse_id
WHERE lbs.qty_available > 0
  AND l.status  = 'ACTIVE'::lot_status
  AND w.is_active = TRUE;

-- ─────────────────────────────────────────────────────
-- 10. Vista v_expiry_alerts
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_expiry_alerts AS
SELECT
  l.id AS lot_id,
  l.producto_sku,
  COALESCE(NULLIF(TRIM(p.description), ''), p.sku) AS descripcion,
  l.lot_number,
  l.expiration_date,
  l.expiration_date - CURRENT_DATE AS days_remaining,
  COALESCE(SUM(lbs.qty_available), 0)::NUMERIC(18,4) AS qty_available,
  CASE
    WHEN l.expiration_date < CURRENT_DATE       THEN 'EXPIRED'
    WHEN l.expiration_date <= CURRENT_DATE + 30 THEN 'CRITICAL'
    WHEN l.expiration_date <= CURRENT_DATE + 90 THEN 'WARNING'
  END AS alert_level
FROM product_lots   l
JOIN products       p   ON p.sku = l.producto_sku
LEFT JOIN lot_bin_stock lbs ON lbs.lot_id = l.id
WHERE l.expiration_date IS NOT NULL
  AND l.expiration_date <= CURRENT_DATE + 90
  AND l.status IN ('ACTIVE'::lot_status,'EXPIRED'::lot_status)
GROUP BY l.id, l.producto_sku, p.description, p.sku, l.lot_number, l.expiration_date, l.status;
