-- Ferrari ERP — exchange_rates + snapshots en sales/purchases
-- Catálogo canónico: products (unit_price_usd, description).
-- Prerrequisitos: tabla products; customers(id); currency-management o este archivo para daily_exchange_rates.
-- sale_lines.lot_id / bin_id y purchases.import_shipment_id son BIGINT sin FK (podés añadir FKs en entorno completo).
-- Orden sugerido: currency-management → inventory_extensions (products) → este archivo; WMS/lotes/import al integrar POS.
-- psql $DATABASE_URL -f sql/exchange-rates.sql

-- ─────────────────────────────────────────────────────
-- 0. Trigger helper (idempotente; coincide con wms/currency)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────
-- 1. ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE rate_type AS ENUM ('BCV', 'BINANCE', 'ADJUSTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────
-- 1b. products.company_id (vista y LATERAL por empresa)
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS company_id INTEGER NOT NULL DEFAULT 1;

-- ─────────────────────────────────────────────────────
-- 2. daily_exchange_rates — una fila por día
-- REGLA de negocio (app): no sobrescribir día existente salvo política de fetch;
--   is_manual_override = TRUE bloquea upsert automático (ver currencyService).
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_exchange_rates (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER   NOT NULL DEFAULT 1,
  rate_date        DATE      NOT NULL,

  bcv_rate         NUMERIC(15,6),
  binance_rate     NUMERIC(15,6),
  adjusted_rate    NUMERIC(15,6),

  active_rate_type rate_type NOT NULL DEFAULT 'BCV',
  active_rate      NUMERIC(15,6) GENERATED ALWAYS AS (
    CASE active_rate_type
      WHEN 'BCV'      THEN bcv_rate
      WHEN 'BINANCE'  THEN binance_rate
      WHEN 'ADJUSTED' THEN adjusted_rate
    END
  ) STORED,

  is_manual_override     BOOLEAN     NOT NULL DEFAULT FALSE,
  overridden_by_user_id  INTEGER,
  overridden_at          TIMESTAMPTZ,
  override_reason        TEXT,

  bcv_fetched_at         TIMESTAMPTZ,
  bcv_source_url         TEXT,
  binance_fetched_at     TIMESTAMPTZ,
  binance_source_url     TEXT,

  spread_alert_pct       NUMERIC(5,2)  NOT NULL DEFAULT 20.00,
  spread_current_pct     NUMERIC(5,2)  GENERATED ALWAYS AS (
    CASE WHEN bcv_rate > 0
      THEN ROUND(((binance_rate - bcv_rate) / bcv_rate) * 100, 2)
    END
  ) STORED,
  spread_alert_triggered BOOLEAN GENERATED ALWAYS AS (
    binance_rate IS NOT NULL AND bcv_rate > 0 AND
    ((binance_rate - bcv_rate) / bcv_rate * 100) > spread_alert_pct
  ) STORED,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_company_rate_date UNIQUE (company_id, rate_date),
  CONSTRAINT chk_bcv_positive
    CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  CONSTRAINT chk_binance_positive
    CHECK (binance_rate IS NULL OR binance_rate > 0),
  CONSTRAINT chk_adjusted_positive
    CHECK (adjusted_rate IS NULL OR adjusted_rate > 0)
);

CREATE INDEX IF NOT EXISTS idx_der_company_date
  ON daily_exchange_rates (company_id, rate_date DESC);

CREATE INDEX IF NOT EXISTS idx_der_company_date_valid
  ON daily_exchange_rates (company_id, rate_date DESC)
  WHERE active_rate IS NOT NULL;

DROP TRIGGER IF EXISTS trg_der_updated_at ON daily_exchange_rates;
CREATE TRIGGER trg_der_updated_at
  BEFORE UPDATE ON daily_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- 3. exchange_rate_audit_log
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchange_rate_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  rate_id       BIGINT    REFERENCES daily_exchange_rates(id),
  action        TEXT      NOT NULL,
  field_changed TEXT,
  old_value     NUMERIC(15,6),
  new_value     NUMERIC(15,6),
  performed_by  INTEGER,
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB
);

CREATE INDEX IF NOT EXISTS idx_eral_rate_id
  ON exchange_rate_audit_log (rate_id);
CREATE INDEX IF NOT EXISTS idx_eral_action
  ON exchange_rate_audit_log (action, performed_at DESC);

-- ─────────────────────────────────────────────────────
-- 4. Vista: products con precio Bs (runtime; no toca 18k filas)
-- precio_usd / descripcion: alias compatibles con API histórica
-- ─────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_product_prices_bs;
CREATE OR REPLACE VIEW v_product_prices_bs AS
SELECT
  p.id,
  p.sku,
  COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
  COALESCE(p.unit_price_usd, 0::numeric)                 AS precio_usd,
  p.company_id,
  der.rate_date,
  der.active_rate_type,
  der.active_rate,
  der.spread_alert_triggered,
  ROUND(COALESCE(p.unit_price_usd, 0) * der.active_rate, 2)              AS price_bs,
  ROUND(COALESCE(p.unit_price_usd, 0) * COALESCE(der.bcv_rate, der.active_rate), 2)       AS price_bs_bcv,
  ROUND(COALESCE(p.unit_price_usd, 0) * COALESCE(der.binance_rate, der.active_rate), 2) AS price_bs_binance,
  ROUND(COALESCE(p.unit_price_usd, 0) * COALESCE(der.adjusted_rate, der.active_rate), 2) AS price_bs_adjusted,
  ROUND(COALESCE(p.unit_price_usd, 0) * 1.03, 4)                         AS price_usd_igtf
FROM products p
CROSS JOIN LATERAL (
  SELECT
    rate_date, active_rate_type, active_rate,
    bcv_rate, binance_rate, adjusted_rate,
    spread_alert_triggered
  FROM daily_exchange_rates
  WHERE company_id = p.company_id
    AND rate_date <= CURRENT_DATE
    AND active_rate IS NOT NULL
  ORDER BY rate_date DESC
  LIMIT 1
) der;

-- ─────────────────────────────────────────────────────
-- 5. Snapshots POS: sales / sale_lines / purchases
-- Convención: tabla public.sales (no confundir con sales_orders omnicanal).
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER   NOT NULL DEFAULT 1,
  customer_id      BIGINT    REFERENCES customers(id),
  ml_order_id      BIGINT,
  sale_date        DATE      NOT NULL DEFAULT CURRENT_DATE,

  rate_applied     NUMERIC(15,6) NOT NULL,
  rate_type        rate_type     NOT NULL,
  rate_date        DATE          NOT NULL,

  subtotal_usd     NUMERIC(15,4) NOT NULL,
  igtf_usd         NUMERIC(15,4) NOT NULL DEFAULT 0,
  total_usd        NUMERIC(15,4) NOT NULL,
  total_bs         NUMERIC(18,2) GENERATED ALWAYS AS
                     (ROUND(total_usd * rate_applied, 2)) STORED,

  status           TEXT NOT NULL DEFAULT 'PENDING',

  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_rate_positive     CHECK (rate_applied > 0),
  CONSTRAINT chk_subtotal_positive CHECK (subtotal_usd > 0),
  CONSTRAINT chk_igtf_positive     CHECK (igtf_usd >= 0),
  CONSTRAINT chk_total_positive    CHECK (total_usd > 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_customer
  ON sales (customer_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_ml_order
  ON sales (ml_order_id)
  WHERE ml_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_status
  ON sales (status, sale_date DESC);

DROP TRIGGER IF EXISTS trg_sales_updated_at ON sales;
CREATE TRIGGER trg_sales_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS sale_lines (
  id               BIGSERIAL PRIMARY KEY,
  sale_id          BIGINT        NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_sku      TEXT          NOT NULL REFERENCES products(sku),
  lot_id           BIGINT,
  bin_id           BIGINT,

  quantity         NUMERIC(12,3) NOT NULL,
  unit_price_usd   NUMERIC(15,6) NOT NULL,

  landed_cost_usd  NUMERIC(15,6),

  line_total_usd   NUMERIC(15,4) GENERATED ALWAYS AS
                     (quantity * unit_price_usd) STORED,
  margin_usd       NUMERIC(15,4) GENERATED ALWAYS AS (
    CASE WHEN landed_cost_usd IS NOT NULL
      THEN ROUND((unit_price_usd - landed_cost_usd) * quantity, 4)
    END
  ) STORED,

  CONSTRAINT chk_sl_qty   CHECK (quantity > 0),
  CONSTRAINT chk_sl_price CHECK (unit_price_usd > 0),
  CONSTRAINT chk_sl_cost  CHECK (landed_cost_usd IS NULL OR landed_cost_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sl_sale ON sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS idx_sl_sku  ON sale_lines (product_sku);
CREATE INDEX IF NOT EXISTS idx_sl_lot  ON sale_lines (lot_id)
  WHERE lot_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS purchases (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           INTEGER   NOT NULL DEFAULT 1,
  import_shipment_id   BIGINT,
  purchase_date        DATE      NOT NULL DEFAULT CURRENT_DATE,

  rate_applied     NUMERIC(15,6) NOT NULL,
  rate_type        rate_type     NOT NULL,
  rate_date        DATE          NOT NULL,

  subtotal_usd     NUMERIC(15,4) NOT NULL,
  total_usd        NUMERIC(15,4) NOT NULL,
  total_bs         NUMERIC(18,2) GENERATED ALWAYS AS
                     (ROUND(total_usd * rate_applied, 2)) STORED,

  status           TEXT NOT NULL DEFAULT 'PENDING',
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_pur_rate     CHECK (rate_applied > 0),
  CONSTRAINT chk_pur_subtotal CHECK (subtotal_usd > 0),
  CONSTRAINT chk_pur_total    CHECK (total_usd > 0)
);

CREATE INDEX IF NOT EXISTS idx_purchases_shipment
  ON purchases (import_shipment_id)
  WHERE import_shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_date
  ON purchases (purchase_date DESC);

DROP TRIGGER IF EXISTS trg_purchases_updated_at ON purchases;
CREATE TRIGGER trg_purchases_updated_at
  BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─────────────────────────────────────────────────────
-- 5b. purchase_lines (POS compras; catálogo products.sku)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_lines (
  id               BIGSERIAL PRIMARY KEY,
  purchase_id      BIGINT        NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_sku      TEXT          NOT NULL REFERENCES products(sku),
  lot_id           BIGINT,
  bin_id           BIGINT,

  quantity         NUMERIC(12,3) NOT NULL,
  unit_cost_usd    NUMERIC(15,6) NOT NULL,

  landed_cost_usd  NUMERIC(15,6),

  line_total_usd   NUMERIC(15,4) GENERATED ALWAYS AS
                     (quantity * unit_cost_usd) STORED,

  CONSTRAINT chk_pl_qty   CHECK (quantity > 0),
  CONSTRAINT chk_pl_cost  CHECK (unit_cost_usd > 0),
  CONSTRAINT chk_pl_landed CHECK (landed_cost_usd IS NULL OR landed_cost_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pl_purchase
  ON purchase_lines (purchase_id);
CREATE INDEX IF NOT EXISTS idx_pl_sku
  ON purchase_lines (product_sku);
CREATE INDEX IF NOT EXISTS idx_pl_lot
  ON purchase_lines (lot_id)
  WHERE lot_id IS NOT NULL;


-- ─────────────────────────────────────────────────────
-- 6. Vista: margen real por venta (POS sales)
-- ─────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_sale_margins;
CREATE OR REPLACE VIEW v_sale_margins AS
SELECT
  s.id            AS sale_id,
  s.sale_date,
  s.rate_applied,
  s.rate_type,
  sl.product_sku,
  COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
  sl.quantity,
  sl.unit_price_usd,
  sl.landed_cost_usd,
  sl.line_total_usd,
  sl.margin_usd,
  CASE WHEN sl.line_total_usd > 0 AND sl.margin_usd IS NOT NULL
    THEN ROUND(sl.margin_usd / NULLIF(sl.line_total_usd, 0) * 100, 2)
  END             AS margin_pct,
  ROUND(sl.line_total_usd * s.rate_applied, 2) AS line_total_bs,
  s.customer_id,
  s.ml_order_id
FROM sales       s
JOIN sale_lines  sl ON sl.sale_id = s.id
JOIN products    p  ON p.sku     = sl.product_sku
WHERE s.status <> 'CANCELLED';

-- ─────────────────────────────────────────────────────
-- 7. Verificación (solo lectura; no inserta datos)
-- ─────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'daily_exchange_rates','exchange_rate_audit_log',
--     'sales','sale_lines','purchases')
-- ORDER BY table_name;
--
-- SELECT viewname FROM pg_views
-- WHERE schemaname = 'public'
--   AND viewname IN ('v_product_prices_bs','v_sale_margins')
-- ORDER BY viewname;
