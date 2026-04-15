-- Políticas de precio y parámetros financieros por empresa.
-- Porcentajes en decimal (0.25 = 25%). Ejecutar: npm run db:pricing-policies
-- Prerrequisitos: products, category_products(id), payment_methods (igtf.sql / tax-retentions.sql).

-- ─────────────────────────────────────
-- 1. financial_settings
-- Parámetros globales operativos — un registro por company_id
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE,

  flete_nacional_pct    NUMERIC NOT NULL DEFAULT 0
    CHECK (flete_nacional_pct >= 0 AND flete_nacional_pct <= 1),
  arancel_pct           NUMERIC NOT NULL DEFAULT 0
    CHECK (arancel_pct >= 0 AND arancel_pct <= 1),
  gasto_admin_pct       NUMERIC NOT NULL DEFAULT 0
    CHECK (gasto_admin_pct >= 0 AND gasto_admin_pct <= 1),

  storage_cost_pct      NUMERIC NOT NULL DEFAULT 0
    CHECK (storage_cost_pct >= 0 AND storage_cost_pct <= 1),

  picking_packing_usd   NUMERIC NOT NULL DEFAULT 0
    CHECK (picking_packing_usd >= 0),

  iva_pct               NUMERIC NOT NULL DEFAULT 0.16
    CHECK (iva_pct >= 0 AND iva_pct <= 1),
  igtf_pct              NUMERIC NOT NULL DEFAULT 0.03
    CHECK (igtf_pct >= 0 AND igtf_pct < 1),

  igtf_absorbed         BOOLEAN NOT NULL DEFAULT TRUE,

  spread_alert_pct      NUMERIC NOT NULL DEFAULT 0.10
    CHECK (spread_alert_pct >= 0 AND spread_alert_pct <= 1),

  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INTEGER
);

INSERT INTO financial_settings (company_id)
VALUES (1)
ON CONFLICT (company_id) DO NOTHING;

-- ─────────────────────────────────────
-- 2. pricing_policies
-- Markup por canal; herencia global → categoría
-- UNIQUE parcial (evita duplicados con NULL en category)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pricing_policies (
  id SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'global',
  category_id BIGINT REFERENCES category_products (id) ON DELETE CASCADE,

  markup_pct          NUMERIC NOT NULL DEFAULT 0.25
    CHECK (markup_pct >= 0 AND markup_pct <= 10),
  commission_pct      NUMERIC NOT NULL DEFAULT 0
    CHECK (commission_pct >= 0 AND commission_pct < 1),
  max_discount_pct    NUMERIC NOT NULL DEFAULT 0
    CHECK (max_discount_pct >= 0 AND max_discount_pct < 1),

  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INTEGER,

  CONSTRAINT chk_pp_level CHECK (level IN ('global', 'category')),
  CONSTRAINT chk_pp_category_consistency CHECK (
    (level = 'global' AND category_id IS NULL)
    OR (level = 'category' AND category_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_policies_global
  ON pricing_policies (company_id, channel)
  WHERE level = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_policies_category
  ON pricing_policies (company_id, channel, category_id)
  WHERE level = 'category';

CREATE INDEX IF NOT EXISTS idx_pricing_policies_company_channel
  ON pricing_policies (company_id, channel)
  WHERE is_active = TRUE;

COMMENT ON TABLE pricing_policies IS 'Markup y comisión por canal; categoría sobreescribe global. Porcentajes en decimal.';

-- Seed idempotente (ON CONFLICT no aplica bien a índices únicos parciales)
INSERT INTO pricing_policies (company_id, channel, level, category_id, markup_pct, commission_pct)
SELECT 1, 'mostrador', 'global', NULL, 0.25, 0
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_policies WHERE company_id = 1 AND channel = 'mostrador' AND level = 'global'
);
INSERT INTO pricing_policies (company_id, channel, level, category_id, markup_pct, commission_pct)
SELECT 1, 'whatsapp', 'global', NULL, 0.20, 0
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_policies WHERE company_id = 1 AND channel = 'whatsapp' AND level = 'global'
);
INSERT INTO pricing_policies (company_id, channel, level, category_id, markup_pct, commission_pct)
SELECT 1, 'ml', 'global', NULL, 0.35, 0.15
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_policies WHERE company_id = 1 AND channel = 'ml' AND level = 'global'
);
INSERT INTO pricing_policies (company_id, channel, level, category_id, markup_pct, commission_pct)
SELECT 1, 'ecommerce', 'global', NULL, 0.30, 0
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_policies WHERE company_id = 1 AND channel = 'ecommerce' AND level = 'global'
);

-- ─────────────────────────────────────
-- 3. payment_method_settings
-- ─────────────────────────────────────
INSERT INTO payment_methods (code, name, currency, generates_igtf, sort_order)
VALUES
  ('BINANCE_P2P', 'Binance P2P', 'USDT', FALSE, 90),
  ('PANAMA_WIRE', 'Transferencia Panamá/Wire', 'USD', FALSE, 100)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_method_settings (
  id SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL,
  payment_code        TEXT NOT NULL,

  rate_source         TEXT NOT NULL DEFAULT 'binance',

  applies_igtf        BOOLEAN NOT NULL DEFAULT FALSE,

  method_commission_pct NUMERIC NOT NULL DEFAULT 0
    CHECK (method_commission_pct >= 0 AND method_commission_pct < 1),

  collection_currency TEXT NOT NULL DEFAULT 'USD',

  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INTEGER,

  UNIQUE (company_id, payment_code),

  CONSTRAINT chk_pms_rate_source CHECK (rate_source IN ('bcv', 'binance', 'adjusted')),
  CONSTRAINT chk_pms_currency CHECK (collection_currency IN ('USD', 'VES', 'USDT'))
);

INSERT INTO payment_method_settings
  (company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency)
VALUES
  (1, 'USD_CASH',    'binance', FALSE, 0,    'USD'),
  (1, 'ZELLE',       'binance', TRUE,  0,    'USD'),
  (1, 'PAGO_MOVIL',  'bcv',     FALSE, 0,    'VES'),
  (1, 'BS_TRANSFER', 'bcv',     FALSE, 0,    'VES'),
  (1, 'BS_CASH',     'bcv',     FALSE, 0,    'VES'),
  (1, 'BINANCE_P2P', 'binance', FALSE, 0,    'USDT'),
  (1, 'PANAMA_WIRE', 'binance', FALSE, 0,    'USD')
ON CONFLICT (company_id, payment_code) DO NOTHING;

COMMENT ON TABLE payment_method_settings IS 'Reglas por método de cobro; rate_source bcv|binance|adjusted.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_financial_settings_updated_at ON financial_settings;
    CREATE TRIGGER trg_financial_settings_updated_at
      BEFORE UPDATE ON financial_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    DROP TRIGGER IF EXISTS trg_pricing_policies_updated_at ON pricing_policies;
    CREATE TRIGGER trg_pricing_policies_updated_at
      BEFORE UPDATE ON pricing_policies
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    DROP TRIGGER IF EXISTS trg_payment_method_settings_updated_at ON payment_method_settings;
    CREATE TRIGGER trg_payment_method_settings_updated_at
      BEFORE UPDATE ON payment_method_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  ELSE
    RAISE NOTICE 'Omitidos triggers updated_at: función set_updated_at no existe.';
  END IF;
END $$;
