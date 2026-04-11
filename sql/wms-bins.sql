-- WMS — estructura física de almacén (ubicaciones + stock por bin + auditoría)
-- Requiere tabla products(sku). precio_usd / unit_price_usd en vistas de lectura.
-- set_updated_at() suele existir por shipping-providers.sql; se recrea idempotente.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── Jerarquía: warehouse → aisle → shelf → bin ─────────────────────────────

CREATE TABLE IF NOT EXISTS warehouses (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL DEFAULT 1,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_warehouses_company_code UNIQUE (company_id, code)
);

DROP TRIGGER IF EXISTS trg_warehouses_updated_at ON warehouses;
CREATE TRIGGER trg_warehouses_updated_at
  BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS warehouse_aisles (
  id            BIGSERIAL PRIMARY KEY,
  warehouse_id  BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  aisle_code    TEXT NOT NULL,
  aisle_number  INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_aisle_per_wh UNIQUE (warehouse_id, aisle_code)
);

DROP TRIGGER IF EXISTS trg_warehouse_aisles_updated_at ON warehouse_aisles;
CREATE TRIGGER trg_warehouse_aisles_updated_at
  BEFORE UPDATE ON warehouse_aisles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS warehouse_shelves (
  id            BIGSERIAL PRIMARY KEY,
  aisle_id      BIGINT NOT NULL REFERENCES warehouse_aisles(id) ON DELETE CASCADE,
  shelf_code    TEXT NOT NULL,
  shelf_number  INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_shelf_per_aisle UNIQUE (aisle_id, shelf_code)
);

DROP TRIGGER IF EXISTS trg_warehouse_shelves_updated_at ON warehouse_shelves;
CREATE TRIGGER trg_warehouse_shelves_updated_at
  BEFORE UPDATE ON warehouse_shelves
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS warehouse_bins (
  id               BIGSERIAL PRIMARY KEY,
  shelf_id         BIGINT NOT NULL REFERENCES warehouse_shelves(id) ON DELETE CASCADE,
  level            INTEGER NOT NULL CHECK (level >= 1),
  bin_code         TEXT,
  is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
  max_weight_kg    NUMERIC(12,4),
  max_volume_cbm   NUMERIC(12,6),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bin_shelf_level UNIQUE (shelf_id, level)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_bins_bin_code ON warehouse_bins (bin_code) WHERE bin_code IS NOT NULL;

DROP TRIGGER IF EXISTS trg_warehouse_bins_updated_at ON warehouse_bins;
CREATE TRIGGER trg_warehouse_bins_updated_at
  BEFORE UPDATE ON warehouse_bins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- bin_code: si solo hay un almacén activo en la empresa → formato corto A01-E1-N1
-- Si hay más de uno → WH-A01-E1-N1 (prefijo = warehouses.code)
CREATE OR REPLACE FUNCTION warehouse_bins_set_bin_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ws RECORD;
  wa RECORD;
  w RECORD;
  cnt INTEGER;
BEGIN
  IF NEW.bin_code IS NOT NULL AND btrim(NEW.bin_code) <> '' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO ws FROM warehouse_shelves WHERE id = NEW.shelf_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_shelves id=% no existe', NEW.shelf_id;
  END IF;
  SELECT * INTO wa FROM warehouse_aisles WHERE id = ws.aisle_id;
  SELECT * INTO w FROM warehouses WHERE id = wa.warehouse_id;

  SELECT COUNT(*)::INTEGER INTO cnt
  FROM warehouses
  WHERE company_id = w.company_id AND is_active = TRUE;

  IF cnt <= 1 THEN
    NEW.bin_code := wa.aisle_code || '-' || ws.shelf_code || '-N' || NEW.level;
  ELSE
    NEW.bin_code := w.code || '-' || wa.aisle_code || '-' || ws.shelf_code || '-N' || NEW.level;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warehouse_bins_set_code ON warehouse_bins;
CREATE TRIGGER trg_warehouse_bins_set_code
  BEFORE INSERT OR UPDATE OF shelf_id, level ON warehouse_bins
  FOR EACH ROW EXECUTE FUNCTION warehouse_bins_set_bin_code();

-- Stock por SKU y bin
CREATE TABLE IF NOT EXISTS bin_stock (
  id              BIGSERIAL PRIMARY KEY,
  bin_id          BIGINT NOT NULL REFERENCES warehouse_bins(id) ON DELETE CASCADE,
  product_sku     TEXT NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,
  qty_available   NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (qty_available >= 0),
  qty_reserved    NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bin_stock_bin_sku UNIQUE (bin_id, product_sku)
);

CREATE INDEX IF NOT EXISTS idx_bin_stock_sku ON bin_stock (product_sku);

DROP TRIGGER IF EXISTS trg_bin_stock_updated_at ON bin_stock;
CREATE TRIGGER trg_bin_stock_updated_at
  BEFORE UPDATE ON bin_stock
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auditoría de movimientos (append-only)
CREATE TABLE IF NOT EXISTS stock_movements_audit (
  id               BIGSERIAL PRIMARY KEY,
  bin_id           BIGINT NOT NULL REFERENCES warehouse_bins(id) ON DELETE CASCADE,
  product_sku      TEXT NOT NULL,
  delta_available  NUMERIC(18,4) NOT NULL DEFAULT 0,
  delta_reserved   NUMERIC(18,4) NOT NULL DEFAULT 0,
  reason           TEXT,
  reference_id     TEXT,
  reference_type   TEXT,
  user_id          TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sma_sku ON stock_movements_audit (product_sku, id DESC);
CREATE INDEX IF NOT EXISTS idx_sma_bin ON stock_movements_audit (bin_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sma_ref ON stock_movements_audit (reference_id) WHERE reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_bin_stock_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  d_avail NUMERIC(18,4);
  d_res   NUMERIC(18,4);
  r_reason TEXT;
  r_ref_id TEXT;
  r_ref_type TEXT;
  r_user_id TEXT;
  r_notes TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.qty_available, 0) = 0 AND COALESCE(NEW.qty_reserved, 0) = 0 THEN
      RETURN NEW;
    END IF;
    d_avail := NEW.qty_available;
    d_res := NEW.qty_reserved;
  ELSIF TG_OP = 'UPDATE' THEN
    d_avail := NEW.qty_available - OLD.qty_available;
    d_res := NEW.qty_reserved - OLD.qty_reserved;
    IF d_avail = 0 AND d_res = 0 THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN COALESCE(OLD, NEW);
  END IF;

  BEGIN
    r_reason := NULLIF(current_setting('app.movement_reason', true), '');
  EXCEPTION WHEN OTHERS THEN
    r_reason := NULL;
  END;
  BEGIN
    r_ref_id := NULLIF(current_setting('app.reference_id', true), '');
  EXCEPTION WHEN OTHERS THEN
    r_ref_id := NULL;
  END;
  BEGIN
    r_ref_type := NULLIF(current_setting('app.reference_type', true), '');
  EXCEPTION WHEN OTHERS THEN
    r_ref_type := NULL;
  END;
  BEGIN
    r_user_id := NULLIF(current_setting('app.user_id', true), '');
  EXCEPTION WHEN OTHERS THEN
    r_user_id := NULL;
  END;
  BEGIN
    r_notes := NULLIF(current_setting('app.notes', true), '');
  EXCEPTION WHEN OTHERS THEN
    r_notes := NULL;
  END;

  INSERT INTO stock_movements_audit (
    bin_id, product_sku, delta_available, delta_reserved,
    reason, reference_id, reference_type, user_id, notes
  ) VALUES (
    NEW.bin_id, NEW.product_sku, d_avail, d_res,
    r_reason, r_ref_id, r_ref_type, r_user_id, r_notes
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_bin_stock_change ON bin_stock;
CREATE TRIGGER trg_audit_bin_stock_change
  AFTER INSERT OR UPDATE ON bin_stock
  FOR EACH ROW EXECUTE FUNCTION audit_bin_stock_change();

-- Vistas de lectura
-- v_stock_by_sku — stock total por SKU y almacén
-- Columnas que consume wmsService.js: product_sku, warehouse_id, qty_available_total, qty_reserved_total
CREATE OR REPLACE VIEW v_stock_by_sku AS
SELECT
  bs.product_sku,
  w.id    AS warehouse_id,
  w.code  AS warehouse_code,
  COALESCE(SUM(bs.qty_available), 0)::NUMERIC(18,4) AS qty_available_total,
  COALESCE(SUM(bs.qty_reserved),  0)::NUMERIC(18,4) AS qty_reserved_total,
  MAX(COALESCE(p.precio_usd, p.unit_price_usd)) AS precio_usd
FROM bin_stock bs
JOIN warehouse_bins    wb ON wb.id = bs.bin_id
JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
JOIN warehouse_aisles  wa ON wa.id = ws.aisle_id
JOIN warehouses         w ON  w.id = wa.warehouse_id
JOIN products           p ON  p.sku = bs.product_sku
GROUP BY bs.product_sku, w.id, w.code;

-- v_picking_route — orden serpentín para picking
-- Columnas que consume wmsService.js: product_sku, warehouse_id, bin_id, bin_code,
--   aisle_code, aisle_number, shelf_code, shelf_number, picking_order, qty_available
CREATE OR REPLACE VIEW v_picking_route AS
SELECT
  bs.product_sku,
  w.id        AS warehouse_id,
  w.code      AS warehouse_code,
  wb.id       AS bin_id,
  wb.bin_code,
  wb.level,
  wa.aisle_code,
  wa.aisle_number,
  ws.shelf_code,
  ws.shelf_number,
  (
    COALESCE(wa.aisle_number, 0) * 100000
    + COALESCE(ws.shelf_number, 0) * 1000
    + COALESCE(wb.level, 0)
  )::INTEGER  AS picking_order,
  bs.qty_available,
  bs.qty_reserved,
  COALESCE(p.precio_usd, p.unit_price_usd) AS precio_usd
FROM bin_stock bs
JOIN warehouse_bins    wb ON wb.id = bs.bin_id
JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
JOIN warehouse_aisles  wa ON wa.id = ws.aisle_id
JOIN warehouses         w ON  w.id = wa.warehouse_id
JOIN products           p ON  p.sku = bs.product_sku
WHERE bs.qty_available > 0;

-- Verificación post-deploy (ejemplos):
-- Un solo almacén activo → bin_code esperado: 'A01-E1-N1' (sin prefijo de bodega)
-- Varios almacenes activos → 'SM-A01-E1-N1'
--
-- INSERT INTO warehouses (company_id, code, name) VALUES (1, 'SM', 'Solomotor3k')
--   ON CONFLICT (company_id, code) DO NOTHING;
-- INSERT INTO warehouse_aisles (warehouse_id, aisle_code, aisle_number) VALUES (1, 'A01', 1);
-- INSERT INTO warehouse_shelves (aisle_id, shelf_code, shelf_number) VALUES (1, 'E1', 1);
-- INSERT INTO warehouse_bins (shelf_id, level) VALUES (1, 1);
-- SELECT bin_code FROM warehouse_bins WHERE shelf_id = 1 AND level = 1;
