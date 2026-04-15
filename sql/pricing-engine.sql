-- Motor de precios por canal (costo operativo → USD → Bs BCV / Bs Binance).
-- Coexiste con products.unit_price_usd y v_product_prices_bs hasta migrar POS/front.
--
-- Convención: todos los *_pct en rango decimal 0–1 (ej. 0.16 = 16%, 0.03 = 3%).
-- Ejecutar: npm run db:pricing-engine
-- Prerrequisitos: products, category_products, daily_exchange_rates (tasas del día).

-- ── 1. financial_settings — un registro por empresa ─────────────────────────
CREATE TABLE IF NOT EXISTS financial_settings (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL,
  flete_nacional_pct      NUMERIC(8,6)  NOT NULL DEFAULT 0,
  arancel_pct             NUMERIC(8,6)  NOT NULL DEFAULT 0,
  gasto_admin_pct         NUMERIC(8,6)  NOT NULL DEFAULT 0,
  storage_cost_pct        NUMERIC(8,6)  NOT NULL DEFAULT 0,
  picking_packing_usd     NUMERIC(12,4) NOT NULL DEFAULT 0,
  spread_alert_pct        NUMERIC(8,6)  NOT NULL DEFAULT 0.10,
  iva_pct                 NUMERIC(8,6)  NOT NULL DEFAULT 0.16,
  igtf_pct                NUMERIC(8,6)  NOT NULL DEFAULT 0.03,
  igtf_absorbed           BOOLEAN       NOT NULL DEFAULT TRUE,
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by              INTEGER,
  CONSTRAINT chk_fs_flete   CHECK (flete_nacional_pct >= 0 AND flete_nacional_pct <= 2),
  CONSTRAINT chk_fs_arancel CHECK (arancel_pct >= 0 AND arancel_pct <= 2),
  CONSTRAINT chk_fs_admin   CHECK (gasto_admin_pct >= 0 AND gasto_admin_pct <= 2),
  CONSTRAINT chk_fs_storage CHECK (storage_cost_pct >= 0 AND storage_cost_pct <= 2),
  CONSTRAINT chk_fs_picking CHECK (picking_packing_usd >= 0),
  CONSTRAINT chk_fs_spread  CHECK (spread_alert_pct >= 0 AND spread_alert_pct <= 1),
  CONSTRAINT chk_fs_iva     CHECK (iva_pct >= 0 AND iva_pct <= 1),
  CONSTRAINT chk_fs_igtf    CHECK (igtf_pct >= 0 AND igtf_pct < 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_settings_company
  ON financial_settings (company_id);

COMMENT ON TABLE financial_settings IS 'Parámetros globales del motor de precios por empresa; porcentajes en decimal (0.10 = 10%).';
COMMENT ON COLUMN financial_settings.spread_alert_pct IS 'Umbral de brecha (Binance−BCV)/BCV; mismo criterio conceptual que daily_exchange_rates.spread_alert_pct.';
COMMENT ON COLUMN financial_settings.igtf_absorbed IS 'Si true, el IGTF es costo interno (no se suma al precio al cliente en el modelo POS con payments).';

INSERT INTO financial_settings (company_id)
VALUES (1)
ON CONFLICT (company_id) DO NOTHING;

-- ── 2. pricing_policies — UNIQUE parcial (NULL no deduplica en UNIQUE clásico) ─
CREATE TABLE IF NOT EXISTS pricing_policies (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  channel            TEXT NOT NULL,
  level              TEXT NOT NULL DEFAULT 'global',
  category_id        BIGINT REFERENCES category_products (id) ON DELETE CASCADE,
  markup_pct         NUMERIC(8,6)  NOT NULL DEFAULT 0.25,
  commission_pct     NUMERIC(8,6)  NOT NULL DEFAULT 0,
  max_discount_pct   NUMERIC(8,6)  NOT NULL DEFAULT 0,
  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by         INTEGER,
  CONSTRAINT chk_pp_level CHECK (level IN ('global', 'category')),
  CONSTRAINT chk_pp_category_consistency CHECK (
    (level = 'global' AND category_id IS NULL)
    OR (level = 'category' AND category_id IS NOT NULL)
  ),
  CONSTRAINT chk_pp_markup CHECK (markup_pct >= 0 AND markup_pct <= 5),
  CONSTRAINT chk_pp_commission CHECK (commission_pct >= 0 AND commission_pct < 1),
  CONSTRAINT chk_pp_max_disc CHECK (max_discount_pct >= 0 AND max_discount_pct < 1)
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

COMMENT ON TABLE pricing_policies IS 'Markup y comisión por canal; herencia category sobre global. Porcentajes en decimal.';

-- Seed idempotente (UNIQUE parcial no admite ON CONFLICT simple en todos los PG).
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

-- ── 3. payment_method_settings (sin FK a payment_methods: códigos nuevos permitidos) ─
CREATE TABLE IF NOT EXISTS payment_method_settings (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL,
  payment_code            TEXT NOT NULL,
  rate_source             TEXT NOT NULL DEFAULT 'binance',
  applies_igtf            BOOLEAN NOT NULL DEFAULT FALSE,
  method_commission_pct   NUMERIC(8,6) NOT NULL DEFAULT 0,
  collection_currency     TEXT NOT NULL DEFAULT 'USD',
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              INTEGER,
  CONSTRAINT chk_pms_rate_source CHECK (rate_source IN ('bcv', 'binance')),
  CONSTRAINT chk_pms_commission CHECK (method_commission_pct >= 0 AND method_commission_pct < 1),
  CONSTRAINT chk_pms_currency CHECK (collection_currency IN ('USD', 'VES', 'USDT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_method_settings_company_code
  ON payment_method_settings (company_id, payment_code);

INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'USD_CASH', 'binance', FALSE, 0, 'USD'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'USD_CASH');
INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'ZELLE', 'binance', TRUE, 0, 'USD'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'ZELLE');
INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'PAGO_MOVIL', 'bcv', FALSE, 0, 'VES'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'PAGO_MOVIL');
INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'BS_TRANSFER', 'bcv', FALSE, 0, 'VES'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'BS_TRANSFER');
INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'BINANCE_P2P', 'binance', FALSE, 0, 'USDT'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'BINANCE_P2P');
INSERT INTO payment_method_settings (
  company_id, payment_code, rate_source, applies_igtf, method_commission_pct, collection_currency
)
SELECT 1, 'PANAMA_WIRE', 'binance', FALSE, 0, 'USD'
WHERE NOT EXISTS (SELECT 1 FROM payment_method_settings WHERE company_id = 1 AND payment_code = 'PANAMA_WIRE');

-- ── 4. product_prices — price_bs = BCV (etiqueta), price_bs_internal = Binance (gestión) ─
CREATE TABLE IF NOT EXISTS product_prices (
  id                    BIGSERIAL PRIMARY KEY,
  product_id            BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  channel               TEXT NOT NULL,
  company_id            INTEGER NOT NULL,
  landed_cost_usd       NUMERIC(15,6) NOT NULL,
  costo_operativo_usd   NUMERIC(15,6) NOT NULL,
  binance_rate          NUMERIC(15,6) NOT NULL,
  bcv_rate              NUMERIC(15,6) NOT NULL,
  rate_date             DATE NOT NULL,
  price_usd             NUMERIC(15,6) NOT NULL,
  price_bs              NUMERIC(18,2) NOT NULL,
  price_bs_internal     NUMERIC(18,2) NOT NULL,
  markup_applied        NUMERIC(8,6)  NOT NULL,
  commission_applied    NUMERIC(8,6)  NOT NULL,
  margin_usd            NUMERIC(15,6) NOT NULL,
  margin_pct            NUMERIC(12,6) NOT NULL,
  policy_snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_prices_product_channel UNIQUE (product_id, channel),
  CONSTRAINT chk_pp_rates_pos CHECK (binance_rate > 0 AND bcv_rate > 0),
  CONSTRAINT chk_pp_price_usd CHECK (price_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices (product_id);
CREATE INDEX IF NOT EXISTS idx_product_prices_channel ON product_prices (channel);
CREATE INDEX IF NOT EXISTS idx_product_prices_rate_date ON product_prices (rate_date);
CREATE INDEX IF NOT EXISTS idx_product_prices_company ON product_prices (company_id);

COMMENT ON TABLE product_prices IS 'Snapshot por producto y canal; price_bs a tasa BCV, price_bs_internal a tasa Binance.';
COMMENT ON COLUMN product_prices.price_bs IS 'Referencia en Bs a tasa BCV (etiqueta / legal).';
COMMENT ON COLUMN product_prices.price_bs_internal IS 'Referencia en Bs a tasa Binance (gestión / protección).';

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
    RAISE NOTICE 'Omitidos triggers updated_at: función set_updated_at no existe (ej. exchange-rates.sql).';
  END IF;
END $$;
