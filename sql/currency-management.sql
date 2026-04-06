-- Proyecto Ferrari — Currency Management Module
-- Ejecutar en orden.

-- 1a. ENUM de tipo de tasa activa
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_type') THEN
    CREATE TYPE rate_type AS ENUM ('BCV', 'BINANCE', 'ADJUSTED');
  END IF;
END $$;

-- 1b. Tabla principal de tasas diarias
CREATE TABLE IF NOT EXISTS daily_exchange_rates (
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
      ELSE NULL
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

-- PARTE 0: corregir active_rate nullable para FETCH_FAILED
DROP VIEW IF EXISTS v_product_prices_bs;
ALTER TABLE daily_exchange_rates DROP COLUMN IF EXISTS active_rate;
ALTER TABLE daily_exchange_rates ADD COLUMN active_rate NUMERIC(15,6)
  GENERATED ALWAYS AS (
    CASE active_rate_type
      WHEN 'BCV'      THEN bcv_rate
      WHEN 'BINANCE'  THEN binance_rate
      WHEN 'ADJUSTED' THEN adjusted_rate
      ELSE NULL
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_der_company_date ON daily_exchange_rates (company_id, rate_date DESC);
CREATE INDEX IF NOT EXISTS idx_der_company_date_valid
  ON daily_exchange_rates (company_id, rate_date DESC)
  WHERE active_rate IS NOT NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_der_updated_at') THEN
    CREATE TRIGGER trg_der_updated_at
      BEFORE UPDATE ON daily_exchange_rates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- 1c. Log de auditoría inmutable (append-only)
CREATE TABLE IF NOT EXISTS exchange_rate_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  rate_id       BIGINT REFERENCES daily_exchange_rates(id),
  action        TEXT NOT NULL,
  field_changed TEXT,
  old_value     NUMERIC(15,6),
  new_value     NUMERIC(15,6),
  performed_by  INTEGER REFERENCES users(id),
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB
);

CREATE INDEX IF NOT EXISTS idx_eral_rate_id ON exchange_rate_audit_log (rate_id);

-- 1d. Vista de productos con fallback al último rate válido
CREATE OR REPLACE VIEW v_product_prices_bs AS
SELECT
  p.sku,
  p.descripcion,
  p.precio_usd AS price_usd,
  last_rate.rate_date,
  last_rate.active_rate_type,
  last_rate.active_rate,
  last_rate.spread_alert_triggered,
  ROUND(p.precio_usd * last_rate.active_rate, 2)                  AS price_bs,
  ROUND(p.precio_usd * COALESCE(last_rate.bcv_rate,
        last_rate.active_rate), 2)                                 AS price_bs_bcv,
  ROUND(p.precio_usd * COALESCE(last_rate.binance_rate,
        last_rate.active_rate), 2)                                 AS price_bs_binance,
  ROUND(p.precio_usd * 1.03, 4)                                    AS price_usd_igtf
FROM productos p
CROSS JOIN LATERAL (
  SELECT rate_date, active_rate_type, active_rate,
         bcv_rate, binance_rate, spread_alert_triggered
  FROM daily_exchange_rates
  WHERE company_id = 1
    AND rate_date <= CURRENT_DATE
    AND active_rate IS NOT NULL
  ORDER BY rate_date DESC
  LIMIT 1
) last_rate;

