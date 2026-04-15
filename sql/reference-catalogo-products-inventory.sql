-- ============================================================
-- REFERENCIA: catálogo canónico (products) + stock (inventory)
-- ============================================================
-- En producción, `products` / `inventory` suelen existir ya (legacy +
-- sql/20260409_inventory_extensions.sql). Este archivo sirve para:
--   • documentar el modelo que consume inventoryApiHandler / inventoryService
--   • levantar una BD de prueba desde cero (ajusta extensiones si hace falta)
-- No ejecutar ciegamente sobre una BD con datos sin revisar conflictos.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id               BIGSERIAL PRIMARY KEY,
  sku              TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  description      TEXT,
  category         TEXT,
  brand            TEXT,
  unit_price_usd   NUMERIC(10, 4),
  unit_price_bs    NUMERIC(14, 2),
  source           TEXT        NOT NULL DEFAULT 'manual'
    CHECK (source IN ('productos', 'inventario_producto', 'manual')),
  source_id        BIGINT,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_products_sku UNIQUE (sku)
);

CREATE INDEX IF NOT EXISTS idx_products_source ON products (source, source_id);
CREATE INDEX IF NOT EXISTS idx_products_brand  ON products (brand);

COMMENT ON TABLE products IS 'Catálogo canónico de artículos (SKU único). Precio listado en USD; stock vive en inventory.';

-- Una fila de inventario por producto (modelo actual del ERP inventario).
CREATE TABLE IF NOT EXISTS inventory (
  product_id       BIGINT      NOT NULL
    REFERENCES products (id) ON DELETE CASCADE,
  stock_qty        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  stock_min        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  stock_max        NUMERIC(10, 2),
  stock_alert      BOOLEAN     NOT NULL DEFAULT FALSE,
  lead_time_days   INT         NOT NULL DEFAULT 7,
  safety_factor    NUMERIC(4, 2) NOT NULL DEFAULT 1.5,
  supplier_id      BIGINT,
  last_purchase_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inventory_product UNIQUE (product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory (product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_alert
  ON inventory (stock_alert, stock_qty)
  WHERE stock_alert = TRUE;

COMMENT ON TABLE inventory IS 'Stock y parámetros de reposición por product_id; no duplicar datos de catálogo (nombre, marca, etc.).';
