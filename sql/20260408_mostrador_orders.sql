-- Ventas mostrador (tras customer-wallet, crm-solomotor3k, 20260408_loyalty.sql)

CREATE TABLE IF NOT EXISTS crm_mostrador_orders (
  id               BIGSERIAL PRIMARY KEY,
  customer_id      BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  total_amount_usd NUMERIC(12,2) NOT NULL CHECK (total_amount_usd > 0),
  items_json       JSONB NOT NULL DEFAULT '[]',
  notes            TEXT,
  sold_by          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mostrador_orders_customer
  ON crm_mostrador_orders(customer_id, created_at DESC);
