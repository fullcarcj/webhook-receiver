-- Proyecto Ferrari — Currency Management Module
-- Ejecutar en orden.

-- 1a. ENUM de tipo de tasa activa
CREATE TYPE rate_type AS ENUM ('BCV', 'BINANCE', 'ADJUSTED');

-- 1b. Tabla principal de tasas diarias
CREATE TABLE daily_exchange_rates (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL DEFAULT 1,
  rate_date        DATE    NOT NULL,
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
  is_manual_override BOOLEAN NOT NULL DEFAULT FALSE,
  spread_alert_pct   NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  spread_current_pct NUMERIC(5,2) GENERATED ALWAYS AS (
    CASE WHEN bcv_rate > 0
      THEN ROUND(((binance_rate - bcv_rate) / bcv_rate) * 100, 2)
    END
  ) STORED,
  spread_alert_triggered BOOLEAN GENERATED ALWAYS AS (
    binance_rate IS NOT NULL AND bcv_rate > 0 AND
    ((binance_rate - bcv_rate) / bcv_rate * 100) > spread_alert_pct
  ) STORED,
  bcv_fetched_at     TIMESTAMPTZ,
  bcv_source_url     TEXT,
  binance_fetched_at TIMESTAMPTZ,
  binance_source_url TEXT,
  overridden_by_user_id INTEGER REFERENCES users(id),
  overridden_at         TIMESTAMPTZ,
  override_reason       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_rate_date UNIQUE (company_id, rate_date),
  CONSTRAINT chk_bcv_positive      CHECK (bcv_rate     IS NULL OR bcv_rate > 0),
  CONSTRAINT chk_binance_positive   CHECK (binance_rate IS NULL OR binance_rate > 0),
  CONSTRAINT chk_adjusted_positive  CHECK (adjusted_rate IS NULL OR adjusted_rate > 0)
);

CREATE INDEX idx_der_company_date ON daily_exchange_rates (company_id, rate_date DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_der_updated_at
  BEFORE UPDATE ON daily_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 1c. Log de auditoría inmutable (append-only)
CREATE TABLE exchange_rate_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  rate_id       BIGINT NOT NULL REFERENCES daily_exchange_rates(id),
  action        TEXT NOT NULL,
  field_changed TEXT,
  old_value     NUMERIC(15,6),
  new_value     NUMERIC(15,6),
  performed_by  INTEGER REFERENCES users(id),
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB
);

CREATE INDEX idx_eral_rate_id ON exchange_rate_audit_log (rate_id);

-- 1d. Vista de productos con precio Bs dinámico
CREATE OR REPLACE VIEW v_product_prices_bs AS
SELECT
  p.id,
  p.sku,
  p.name,
  p.price_usd,
  p.company_id,
  der.rate_date,
  der.active_rate_type,
  der.active_rate,
  der.spread_alert_triggered,
  ROUND(p.price_usd * der.active_rate, 2)          AS price_bs,
  ROUND(p.price_usd * der.bcv_rate, 2)             AS price_bs_bcv,
  ROUND(p.price_usd * COALESCE(der.binance_rate,
        der.bcv_rate), 2)                           AS price_bs_binance,
  ROUND(p.price_usd * COALESCE(der.adjusted_rate,
        der.active_rate), 2)                        AS price_bs_adjusted,
  ROUND(p.price_usd * 1.03, 4)                     AS price_usd_with_igtf
FROM products p
JOIN daily_exchange_rates der
  ON der.company_id = p.company_id
  AND der.rate_date = CURRENT_DATE;

