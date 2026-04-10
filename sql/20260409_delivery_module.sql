-- Módulo Delivery Subcontratado y Liquidación de Motorizados
-- Ejecutar después de migraciones de sales_orders y financial tables.

CREATE TABLE IF NOT EXISTS delivery_zones (
  id               BIGSERIAL PRIMARY KEY,
  zone_name        TEXT NOT NULL UNIQUE,
  description      TEXT,
  base_cost_bs     NUMERIC(10,2) NOT NULL,
  client_price_bs  NUMERIC(10,2) NOT NULL,
  base_cost_usd    NUMERIC(10,4),
  currency_pago    TEXT NOT NULL DEFAULT 'BS'
    CHECK (currency_pago IN ('BS','USD','EFECTIVO','EFECTIVO_BS','ZELLE','BINANCE')),
  estimated_minutes INT DEFAULT 30,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_active
  ON delivery_zones(is_active, zone_name)
  WHERE is_active = TRUE;

INSERT INTO delivery_zones (zone_name, base_cost_bs, client_price_bs, currency_pago, estimated_minutes)
VALUES
  ('Valencia Centro', 15.00, 15.00, 'BS', 20),
  ('Naguanagua',      20.00, 20.00, 'BS', 30),
  ('Los Guayos',      25.00, 25.00, 'BS', 40),
  ('Guacara',         30.00, 30.00, 'BS', 45),
  ('San Diego',       25.00, 25.00, 'BS', 35),
  ('Maracay',         60.00, 60.00, 'BS', 90),
  ('Caracas',        150.00,150.00, 'BS', 180)
ON CONFLICT (zone_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS delivery_providers (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  id_document        TEXT,
  preferred_currency TEXT DEFAULT 'BS'
    CHECK (preferred_currency IN ('BS','USD','EFECTIVO','EFECTIVO_BS','ZELLE','BINANCE')),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_providers_active
  ON delivery_providers(is_active);

CREATE TABLE IF NOT EXISTS delivery_services (
  id                       BIGSERIAL PRIMARY KEY,
  order_id                 BIGINT NOT NULL UNIQUE REFERENCES sales_orders(id) ON DELETE RESTRICT,
  zone_id                  BIGINT NOT NULL REFERENCES delivery_zones(id),
  provider_id              BIGINT REFERENCES delivery_providers(id),
  client_amount_bs         NUMERIC(10,2) NOT NULL,
  provider_amount_bs       NUMERIC(10,2) NOT NULL,
  provider_amount_currency NUMERIC(10,4),
  payment_currency         TEXT NOT NULL DEFAULT 'BS'
    CHECK (payment_currency IN ('BS','USD','EFECTIVO','EFECTIVO_BS','ZELLE','BINANCE')),
  status                   TEXT NOT NULL DEFAULT 'pending_assignment'
    CHECK (status IN ('pending_assignment','assigned','delivered','pending_payment','paid','cancelled')),
  statement_id             BIGINT REFERENCES bank_statements(id),
  manual_tx_id             BIGINT REFERENCES manual_transactions(id),
  assigned_at              TIMESTAMPTZ,
  delivered_at             TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_services_order
  ON delivery_services(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_services_provider
  ON delivery_services(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_services_status
  ON delivery_services(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_pending_payment
  ON delivery_services(provider_id, status)
  WHERE status = 'pending_payment';

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS zone_id BIGINT REFERENCES delivery_zones(id),
  ADD COLUMN IF NOT EXISTS has_delivery BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sales_delivery
  ON sales_orders(has_delivery, zone_id)
  WHERE has_delivery = TRUE;

CREATE OR REPLACE FUNCTION touch_delivery_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_delivery_services_updated_at ON delivery_services;
CREATE TRIGGER trg_delivery_services_updated_at
  BEFORE UPDATE ON delivery_services
  FOR EACH ROW EXECUTE FUNCTION touch_delivery_updated_at();
