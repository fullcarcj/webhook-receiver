-- ============================================================
-- INVENTARIO INTELIGENTE — Extensiones al schema existente
-- Ejecutar UNA VEZ contra la BD de producción
-- Fuente real: productos (7120 filas), inventario_producto (394 filas)
-- ============================================================

-- 1. Extender tabla products (skeleton → catálogo completo)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS category        TEXT,
  ADD COLUMN IF NOT EXISTS brand           TEXT,
  ADD COLUMN IF NOT EXISTS unit_price_usd  NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS unit_price_bs   NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS source          TEXT DEFAULT 'productos'
    CHECK (source IN ('productos','inventario_producto','manual')),
  ADD COLUMN IF NOT EXISTS source_id       BIGINT,
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku    ON products(sku);
CREATE INDEX        IF NOT EXISTS idx_products_source ON products(source, source_id);
CREATE INDEX        IF NOT EXISTS idx_products_brand  ON products(brand);

-- 2. Extender tabla inventory (skeleton → inventario completo)
-- Cambiar stock_qty de INTEGER a NUMERIC (tabla vacía, safe)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory' AND column_name = 'stock_qty'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE inventory ALTER COLUMN stock_qty TYPE NUMERIC(10,2) USING stock_qty::NUMERIC;
  END IF;
END$$;

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS stock_min        NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_max        NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS stock_alert      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lead_time_days   INT DEFAULT 7,
  ADD COLUMN IF NOT EXISTS safety_factor    NUMERIC(4,2) DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS supplier_id      BIGINT,
  ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inventory_alert
  ON inventory(stock_alert, stock_qty)
  WHERE stock_alert = TRUE;

CREATE INDEX IF NOT EXISTS idx_inventory_product
  ON inventory(product_id);

-- 3. Proveedores
CREATE TABLE IF NOT EXISTS suppliers (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  country        TEXT DEFAULT 'Venezuela',
  lead_time_days INT  NOT NULL DEFAULT 7,
  currency       TEXT DEFAULT 'USD'
    CHECK (currency IN ('USD','BS','ZELLE','BINANCE','PANAMA')),
  contact_info   JSONB DEFAULT '{}',
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Órdenes de compra sugeridas por el sistema
CREATE TABLE IF NOT EXISTS purchase_orders (
  id           BIGSERIAL PRIMARY KEY,
  supplier_id  BIGINT REFERENCES suppliers(id),
  status       TEXT DEFAULT 'suggested'
    CHECK (status IN ('suggested','approved','ordered','received','cancelled')),
  total_usd    NUMERIC(12,2),
  total_bs     NUMERIC(14,2),
  suggested_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  ordered_at   TIMESTAMPTZ,
  expected_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Ítems de órdenes de compra
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                BIGSERIAL PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id        BIGINT NOT NULL REFERENCES products(id),
  sku               TEXT NOT NULL,
  name              TEXT NOT NULL,
  qty_suggested     NUMERIC(10,2) NOT NULL,
  qty_ordered       NUMERIC(10,2),
  unit_price_usd    NUMERIC(10,4),
  subtotal_usd      NUMERIC(12,2),
  reason            TEXT,
  days_to_stockout  INT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poi_order ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_poi_product ON purchase_order_items(product_id);

-- 6. Historial de movimientos de stock
CREATE TABLE IF NOT EXISTS stock_movements (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  type         TEXT NOT NULL
    CHECK (type IN ('sale','purchase','adjustment','return','sync')),
  qty_before   NUMERIC(10,2) NOT NULL,
  qty_change   NUMERIC(10,2) NOT NULL,
  qty_after    NUMERIC(10,2) NOT NULL,
  reference_id TEXT,
  notes        TEXT,
  created_by   TEXT DEFAULT 'system',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON stock_movements(product_id, created_at DESC);

-- 7. Proyecciones calculadas por el worker nocturno
CREATE TABLE IF NOT EXISTS inventory_projections (
  id                  BIGSERIAL PRIMARY KEY,
  product_id          BIGINT NOT NULL UNIQUE REFERENCES products(id),
  avg_daily_sales     NUMERIC(10,4) DEFAULT 0,
  avg_weekly_sales    NUMERIC(10,4) DEFAULT 0,
  avg_monthly_sales   NUMERIC(10,4) DEFAULT 0,
  days_to_stockout    INT,
  reorder_point       NUMERIC(10,2),
  suggested_order_qty NUMERIC(10,2),
  velocity_trend      TEXT DEFAULT 'stable'
    CHECK (velocity_trend IN ('rising','stable','falling','no_data')),
  last_calculated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projections_stockout
  ON inventory_projections(days_to_stockout ASC)
  WHERE days_to_stockout IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projections_calculated
  ON inventory_projections(last_calculated_at DESC);
