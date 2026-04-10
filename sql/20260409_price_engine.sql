-- Motor de Precios Dinámico + Aprobación de Precios Especiales

CREATE TABLE IF NOT EXISTS dynamic_prices_settings (
  id            BIGSERIAL PRIMARY KEY,
  setting_key   TEXT NOT NULL UNIQUE,
  setting_value NUMERIC(10,4) NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL
    CHECK (category IN ('markup','discount','threshold','config')),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dynamic_prices_settings_history (
  id          BIGSERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL,
  old_value   NUMERIC(10,4) NOT NULL,
  new_value   NUMERIC(10,4) NOT NULL,
  changed_by  TEXT NOT NULL,
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dyn_price_hist_key
  ON dynamic_prices_settings_history(setting_key, changed_at DESC);

INSERT INTO dynamic_prices_settings (setting_key, setting_value, description, category)
VALUES
  ('MARKUP_MOSTRADOR',      0.30, 'Markup canal mostrador (30%)', 'markup'),
  ('MARKUP_ML',             0.18, 'Markup Mercado Libre (18%)', 'markup'),
  ('MARKUP_ECOMMERCE',      0.25, 'Markup canal ecommerce (25%)', 'markup'),
  ('MARKUP_SOCIAL',         0.28, 'Markup redes sociales (28%)', 'markup'),
  ('ML_COMMISSION',         0.13, 'Comisión Mercado Libre (13%)', 'config'),
  ('DISCOUNT_TYPE_A',       0.15, 'Descuento cliente Tipo A (15%)', 'discount'),
  ('DISCOUNT_TYPE_B',       0.08, 'Descuento cliente Tipo B (8%)', 'discount'),
  ('DISCOUNT_TYPE_C',       0.00, 'Descuento cliente Tipo C (0%)', 'discount'),
  ('THRESHOLD_TYPE_A',      10,   'Mínimo compras/mes para Tipo A', 'threshold'),
  ('THRESHOLD_TYPE_B_MIN',  3,    'Mínimo compras/mes para Tipo B', 'threshold'),
  ('THRESHOLD_TYPE_B_MAX',  9,    'Máximo compras/mes para Tipo B', 'threshold'),
  ('OPEX_RISK_FACTOR',      0.02, 'Factor de riesgo operativo (2%)', 'config')
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS price_approval_requests (
  id                  BIGSERIAL PRIMARY KEY,
  quote_id            BIGINT,
  order_id            BIGINT REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id          BIGINT REFERENCES products(id),
  sku                 TEXT NOT NULL,
  product_name        TEXT NOT NULL,
  calculated_price_bs NUMERIC(14,2) NOT NULL,
  requested_price_bs  NUMERIC(14,2) NOT NULL,
  approved_price_bs   NUMERIC(14,2),
  discount_pct        NUMERIC(5,2),
  requested_by        TEXT NOT NULL,
  request_reason      TEXT NOT NULL,
  reviewed_by         TEXT,
  review_comment      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_price_approval_status
  ON price_approval_requests(status, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_price_approval_seller
  ON price_approval_requests(requested_by, created_at DESC);
