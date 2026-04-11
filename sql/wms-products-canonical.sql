-- WMS — Alineación canónica: bin_stock.product_sku → products(sku), qty_total,
-- funciones atómicas reserve/commit/release/adjust, vistas sobre products.
-- Idempotente. Ejecutar DESPUÉS de sql/wms-bins.sql y sql/wms-audit-v2.sql.
-- Tras aplicar: volver a ejecutar sql/cycle-count.sql (o `npm run db:cycle-count`) para
-- funciones PL/pgSQL que leen bin_stock / count_lines con el nombre canónico.
-- npm run db:wms-products-canonical

-- ── warehouses: columnas negocio + un solo default por empresa ───────────
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_default
  ON warehouses (company_id)
  WHERE is_default = TRUE;

UPDATE warehouses SET is_default = TRUE
WHERE company_id = 1
  AND id = (SELECT id FROM warehouses w WHERE w.company_id = 1 ORDER BY w.id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM warehouses w2 WHERE w2.company_id = 1 AND w2.is_default = TRUE);

INSERT INTO warehouses (company_id, code, name, is_default, is_active)
VALUES (1, 'MAIN', 'Almacén Principal', TRUE, TRUE)
ON CONFLICT (company_id, code) DO NOTHING;

-- ── warehouse_bins: estado / tipo (prompt) ────────────────────────────────
ALTER TABLE warehouse_bins
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS bin_type TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS capacity NUMERIC(12,3);

-- ── warehouse_aisles / shelves: flags ─────────────────────────────────────
ALTER TABLE warehouse_aisles
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE warehouse_shelves
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ── bin_stock: qty_total + renombre producto_sku → product_sku (products) ─
DO $$
DECLARE
  fkname TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bin_stock' AND column_name = 'qty_total'
  ) THEN
    ALTER TABLE bin_stock
      ADD COLUMN qty_total NUMERIC(18,4)
      GENERATED ALWAYS AS (qty_available + qty_reserved) STORED;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bin_stock' AND column_name = 'producto_sku'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bin_stock' AND column_name = 'product_sku'
  ) THEN
    SELECT c.conname INTO fkname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'bin_stock' AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) LIKE '%producto_sku%'
    LIMIT 1;
    IF fkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE bin_stock DROP CONSTRAINT %I', fkname);
    END IF;
    ALTER TABLE bin_stock RENAME COLUMN producto_sku TO product_sku;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bin_stock' AND column_name = 'product_sku'
  ) THEN
    ALTER TABLE bin_stock DROP CONSTRAINT IF EXISTS bin_stock_product_sku_fkey;
    ALTER TABLE bin_stock
      ADD CONSTRAINT bin_stock_product_sku_fkey
      FOREIGN KEY (product_sku) REFERENCES products(sku);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_bin_stock_sku;
CREATE INDEX IF NOT EXISTS idx_bin_stock_sku ON bin_stock (product_sku);

-- ── stock_movements_audit: columna product_sku ────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_movements_audit'
      AND column_name = 'producto_sku'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_movements_audit'
      AND column_name = 'product_sku'
  ) THEN
    ALTER TABLE stock_movements_audit RENAME COLUMN producto_sku TO product_sku;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sma_sku_moved ON stock_movements_audit (product_sku, id DESC);

-- ── Trigger auditoría (misma lógica que wms-audit-v2; usa product_sku) ─────
CREATE OR REPLACE FUNCTION audit_bin_stock_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_reason          movement_reason;
  v_reference_id    TEXT;
  v_reference_type  TEXT;
  v_user_id         INTEGER;
  v_notes           TEXT;
  v_raw_reason      TEXT;
  v_old_available   NUMERIC(18,4);
  v_old_reserved    NUMERIC(18,4);
  v_new_available   NUMERIC(18,4);
  v_new_reserved    NUMERIC(18,4);
  v_bin_stock_id    BIGINT;
  v_bin_id          BIGINT;
  v_sku             TEXT;
BEGIN
  v_raw_reason     := current_setting('app.movement_reason', TRUE);
  v_reference_id   := current_setting('app.reference_id', TRUE);
  v_reference_type := current_setting('app.reference_type', TRUE);
  v_user_id        := NULLIF(current_setting('app.user_id', TRUE), '')::INTEGER;
  BEGIN
    v_notes := NULLIF(current_setting('app.movement_notes', TRUE), '');
  EXCEPTION WHEN OTHERS THEN
    v_notes := NULL;
  END;
  IF v_notes IS NULL THEN
    BEGIN
      v_notes := NULLIF(current_setting('app.notes', TRUE), '');
    EXCEPTION WHEN OTHERS THEN
      v_notes := NULL;
    END;
  END IF;

  BEGIN
    v_reason := COALESCE(NULLIF(v_raw_reason, ''), 'ADJUSTMENT_UP')::movement_reason;
  EXCEPTION WHEN invalid_text_representation THEN
    v_reason := 'ADJUSTMENT_UP';
    v_notes  := 'WARN: reason desconocido "' || COALESCE(v_raw_reason, '')
                || '". ' || COALESCE(v_notes, '');
  END;

  IF TG_OP = 'INSERT' THEN
    v_bin_stock_id  := NEW.id;
    v_bin_id        := NEW.bin_id;
    v_sku           := NEW.product_sku;
    v_old_available := 0;
    v_old_reserved  := 0;
    v_new_available := NEW.qty_available;
    v_new_reserved  := NEW.qty_reserved;
    IF NULLIF(v_raw_reason, '') IS NULL THEN
      v_reason := 'PURCHASE_RECEIPT';
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.qty_available IS NOT DISTINCT FROM NEW.qty_available
       AND OLD.qty_reserved IS NOT DISTINCT FROM NEW.qty_reserved
    THEN
      RETURN NEW;
    END IF;

    v_bin_stock_id  := NEW.id;
    v_bin_id        := NEW.bin_id;
    v_sku           := NEW.product_sku;
    v_old_available := OLD.qty_available;
    v_old_reserved  := OLD.qty_reserved;
    v_new_available := NEW.qty_available;
    v_new_reserved  := NEW.qty_reserved;

  ELSIF TG_OP = 'DELETE' THEN
    v_bin_stock_id  := OLD.id;
    v_bin_id        := OLD.bin_id;
    v_sku           := OLD.product_sku;
    v_old_available := OLD.qty_available;
    v_old_reserved  := OLD.qty_reserved;
    v_new_available := 0;
    v_new_reserved  := 0;
    IF NULLIF(v_raw_reason, '') IS NULL THEN
      v_reason := 'SYSTEM_PURGE';
      v_notes  := 'CASCADE desde warehouse_bins. ' || COALESCE(v_notes, '');
    END IF;
    v_notes := 'FILA ELIMINADA. ' || COALESCE(v_notes, '');

  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO stock_movements_audit (
    bin_stock_id, bin_id, product_sku, reason,
    old_qty_available, old_qty_reserved,
    new_qty_available, new_qty_reserved,
    reference_id, reference_type, user_id, notes
  ) VALUES (
    v_bin_stock_id, v_bin_id, v_sku, v_reason,
    v_old_available, v_old_reserved,
    v_new_available, v_new_reserved,
    NULLIF(v_reference_id, ''),
    NULLIF(v_reference_type, ''),
    v_user_id,
    NULLIF(v_notes, '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_bin_stock_change ON bin_stock;
DROP TRIGGER IF EXISTS trg_audit_bin_stock ON bin_stock;
CREATE TRIGGER trg_audit_bin_stock
  AFTER INSERT
     OR UPDATE OF qty_available, qty_reserved
     OR DELETE
  ON bin_stock
  FOR EACH ROW
  EXECUTE FUNCTION audit_bin_stock_change();

-- ── Vistas lectura: products (no productos) ────────────────────────────────
CREATE OR REPLACE VIEW v_stock_by_sku AS
SELECT
  bs.product_sku,
  COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
  w.name                    AS warehouse_name,
  w.id                      AS warehouse_id,
  SUM(bs.qty_available)     AS total_available,
  SUM(bs.qty_reserved)      AS total_reserved,
  SUM(bs.qty_total)         AS total_stock,
  COUNT(DISTINCT bs.bin_id) AS bin_count,
  MAX(COALESCE(p.precio_usd, p.unit_price_usd)) AS precio_usd
FROM bin_stock        bs
JOIN products         p  ON p.sku  = bs.product_sku
JOIN warehouse_bins   wb ON wb.id  = bs.bin_id
JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
JOIN warehouse_aisles  wa ON wa.id = ws.aisle_id
JOIN warehouses        w  ON w.id  = wa.warehouse_id
WHERE bs.qty_total > 0
GROUP BY bs.product_sku, COALESCE(NULLIF(trim(p.description), ''), p.sku::text), w.name, w.id
ORDER BY bs.product_sku;

CREATE OR REPLACE VIEW v_picking_route AS
SELECT
  bs.product_sku,
  w.name           AS warehouse_name,
  w.id             AS warehouse_id,
  wa.aisle_code,
  wa.aisle_number,
  ws.shelf_code,
  ws.shelf_number,
  wb.bin_code,
  wb.level,
  bs.qty_available,
  bs.bin_id,
  (
    COALESCE(wa.aisle_number, 0) * 100000
    + COALESCE(ws.shelf_number, 0) * 1000
    + COALESCE(wb.level, 0)
  )::INTEGER AS picking_order,
  COALESCE(p.precio_usd, p.unit_price_usd) AS precio_usd
FROM bin_stock         bs
JOIN warehouse_bins    wb ON wb.id  = bs.bin_id
JOIN warehouse_shelves ws ON ws.id  = wb.shelf_id
JOIN warehouse_aisles  wa ON wa.id  = ws.aisle_id
JOIN warehouses        w  ON w.id   = wa.warehouse_id
JOIN products          p  ON p.sku  = bs.product_sku
WHERE bs.qty_available > 0
  AND COALESCE(wb.status, 'ACTIVE') = 'ACTIVE'
ORDER BY
  w.id,
  wa.aisle_number,
  CASE WHEN (wa.aisle_number % 2) = 1 THEN wb.level ELSE -wb.level END,
  ws.shelf_number;

-- ── Funciones atómicas (set_config TRUE = sesión transacción) ──────────────
CREATE OR REPLACE FUNCTION reserve_stock(
  p_bin_id   BIGINT,
  p_sku      TEXT,
  p_qty      NUMERIC(12,3),
  p_ref_type TEXT    DEFAULT NULL,
  p_ref_id   TEXT    DEFAULT NULL,
  p_user_id  INTEGER DEFAULT NULL
)
RETURNS bin_stock LANGUAGE plpgsql AS $$
DECLARE v_row bin_stock%ROWTYPE;
BEGIN
  PERFORM set_config('app.movement_reason', 'RESERVATION', TRUE);
  PERFORM set_config('app.reference_type', COALESCE(p_ref_type, ''), TRUE);
  PERFORM set_config('app.reference_id', COALESCE(p_ref_id, ''), TRUE);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::TEXT, ''), TRUE);
  PERFORM set_config('app.movement_notes', '', TRUE);
  PERFORM set_config('app.notes', '', TRUE);

  UPDATE bin_stock SET
    qty_available = qty_available - p_qty,
    qty_reserved  = qty_reserved  + p_qty
  WHERE bin_id      = p_bin_id
    AND product_sku = p_sku
    AND qty_available >= p_qty
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK: SKU=% BIN=% QTY=%', p_sku, p_bin_id, p_qty;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION commit_reservation(
  p_bin_id   BIGINT,
  p_sku      TEXT,
  p_qty      NUMERIC(12,3),
  p_ref_type TEXT    DEFAULT NULL,
  p_ref_id   TEXT    DEFAULT NULL,
  p_user_id  INTEGER DEFAULT NULL
)
RETURNS bin_stock LANGUAGE plpgsql AS $$
DECLARE v_row bin_stock%ROWTYPE;
BEGIN
  PERFORM set_config('app.movement_reason', 'SALE_DISPATCH', TRUE);
  PERFORM set_config('app.reference_type', COALESCE(p_ref_type, ''), TRUE);
  PERFORM set_config('app.reference_id', COALESCE(p_ref_id, ''), TRUE);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::TEXT, ''), TRUE);
  PERFORM set_config('app.movement_notes', '', TRUE);
  PERFORM set_config('app.notes', '', TRUE);

  UPDATE bin_stock SET
    qty_reserved = qty_reserved - p_qty
  WHERE bin_id       = p_bin_id
    AND product_sku  = p_sku
    AND qty_reserved >= p_qty
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_RESERVATION: SKU=% BIN=% QTY=%', p_sku, p_bin_id, p_qty;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION release_reservation(
  p_bin_id   BIGINT,
  p_sku      TEXT,
  p_qty      NUMERIC(12,3),
  p_ref_type TEXT    DEFAULT NULL,
  p_ref_id   TEXT    DEFAULT NULL,
  p_user_id  INTEGER DEFAULT NULL
)
RETURNS bin_stock LANGUAGE plpgsql AS $$
DECLARE v_row bin_stock%ROWTYPE;
BEGIN
  PERFORM set_config('app.movement_reason', 'RESERVATION_CANCEL', TRUE);
  PERFORM set_config('app.reference_type', COALESCE(p_ref_type, ''), TRUE);
  PERFORM set_config('app.reference_id', COALESCE(p_ref_id, ''), TRUE);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::TEXT, ''), TRUE);
  PERFORM set_config('app.movement_notes', '', TRUE);
  PERFORM set_config('app.notes', '', TRUE);

  UPDATE bin_stock SET
    qty_available = qty_available + p_qty,
    qty_reserved  = qty_reserved  - p_qty
  WHERE bin_id       = p_bin_id
    AND product_sku  = p_sku
    AND qty_reserved >= p_qty
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_RESERVATION: SKU=% BIN=% QTY=%', p_sku, p_bin_id, p_qty;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION adjust_stock(
  p_bin_id   BIGINT,
  p_sku      TEXT,
  p_delta    NUMERIC(12,3),
  p_reason   TEXT    DEFAULT 'ADJUSTMENT_UP',
  p_ref_type TEXT    DEFAULT NULL,
  p_ref_id   TEXT    DEFAULT NULL,
  p_user_id  INTEGER DEFAULT NULL,
  p_notes    TEXT    DEFAULT NULL
)
RETURNS bin_stock LANGUAGE plpgsql AS $$
DECLARE v_row bin_stock%ROWTYPE;
BEGIN
  PERFORM set_config('app.movement_reason', COALESCE(NULLIF(p_reason, ''), 'ADJUSTMENT_UP'), TRUE);
  PERFORM set_config('app.reference_type', COALESCE(p_ref_type, ''), TRUE);
  PERFORM set_config('app.reference_id', COALESCE(p_ref_id, ''), TRUE);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::TEXT, ''), TRUE);
  PERFORM set_config('app.movement_notes', COALESCE(p_notes, ''), TRUE);
  PERFORM set_config('app.notes', COALESCE(p_notes, ''), TRUE);

  INSERT INTO bin_stock (bin_id, product_sku, qty_available, qty_reserved)
  VALUES (p_bin_id, p_sku, GREATEST(0, p_delta), 0)
  ON CONFLICT (bin_id, product_sku) DO UPDATE SET
    qty_available = GREATEST(0, bin_stock.qty_available + p_delta),
    updated_at    = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- count_lines: renombre legacy (requiere sql/cycle-count.sql previo)
DO $$
BEGIN
  IF to_regclass('public.count_lines') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'count_lines' AND column_name = 'producto_sku'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'count_lines' AND column_name = 'product_sku'
  ) THEN
    ALTER TABLE count_lines RENAME COLUMN producto_sku TO product_sku;
  END IF;
END $$;
