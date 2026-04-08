-- Ventas omnicanal unificadas (tras customers, productos, loyalty).
-- Fuentes: mercadolibre, mostrador, ecommerce, social_media.
-- Dinero en efectivo/venta: sales_cash_movements (no confundir con customer_wallets).

CREATE TABLE IF NOT EXISTS sales_orders (
  id                   BIGSERIAL PRIMARY KEY,
  source               TEXT NOT NULL
    CHECK (source IN ('mercadolibre', 'mostrador', 'ecommerce', 'social_media')),
  external_order_id    TEXT NOT NULL,
  customer_id          BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'cancelled', 'refunded')),
  total_usd            NUMERIC(12, 2) NOT NULL CHECK (total_usd > 0),
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0),
  notes                TEXT,
  sold_by              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sales_orders_source_external UNIQUE (source, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_orders_customer
  ON sales_orders (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_status_created
  ON sales_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_orders_source_created
  ON sales_orders (source, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id               BIGSERIAL PRIMARY KEY,
  sales_order_id   BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id       BIGINT NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
  sku              TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_usd   NUMERIC(12, 4) NOT NULL CHECK (unit_price_usd > 0),
  line_total_usd   NUMERIC(12, 2) NOT NULL CHECK (line_total_usd > 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_order
  ON sales_order_items (sales_order_id);

CREATE TABLE IF NOT EXISTS sales_cash_movements (
  id               BIGSERIAL PRIMARY KEY,
  sales_order_id   BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  amount_usd       NUMERIC(12, 2) NOT NULL,
  movement_type    TEXT NOT NULL
    CHECK (movement_type IN ('sale', 'refund', 'adjustment')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_cash_order
  ON sales_cash_movements (sales_order_id, created_at DESC);
