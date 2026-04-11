-- Ferrari ERP — IGTF 3% (pagos en divisas; absorción interna)
-- Requiere: set_updated_at(), sales, daily_exchange_rates (para close_igtf_period).
-- Idempotente. Orden sugerido: exchange-rates.sql → este archivo.
-- psql $DATABASE_URL -f sql/igtf.sql

-- ─────────────────────────────────────────────────────
-- payment_methods
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_methods (
  id             SERIAL  PRIMARY KEY,
  code           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  currency       TEXT    NOT NULL,
  generates_igtf BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_methods_code
  ON payment_methods (code);

INSERT INTO payment_methods
  (code, name, currency, generates_igtf, sort_order)
VALUES
  ('USD_CASH',     'Dólares en efectivo',  'USD', TRUE,  10),
  ('USD_TRANSFER', 'Transferencia USD',    'USD', TRUE,  20),
  ('ZELLE',        'Zelle',                'USD', TRUE,  30),
  ('EUR_CASH',     'Euros en efectivo',    'EUR', TRUE,  40),
  ('BS_TRANSFER',  'Transferencia Bs',     'VES', FALSE, 50),
  ('PAGO_MOVIL',   'Pago Móvil',           'VES', FALSE, 60),
  ('BS_CASH',      'Bolívares efectivo',   'VES', FALSE, 70),
  ('PUNTO_DEBITO', 'Punto de débito Bs',   'VES', FALSE, 80)
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- igtf_config
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS igtf_config (
  id             SERIAL       PRIMARY KEY,
  rate_pct       NUMERIC(5,4) NOT NULL,
  effective_from DATE         NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_igtf_cfg_rate CHECK (rate_pct > 0 AND rate_pct < 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_igtf_config_effective_from
  ON igtf_config (effective_from);

INSERT INTO igtf_config (rate_pct, effective_from, notes)
VALUES (
  0.0300,
  '2022-03-04'::date,
  'Decreto constituyente IGTF 3% sobre pagos en divisas'
)
ON CONFLICT (effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION get_igtf_rate(p_date DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC(5,4) LANGUAGE sql STABLE AS $$
  SELECT rate_pct FROM igtf_config
  WHERE effective_from <= p_date
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

-- ─────────────────────────────────────────────────────
-- sales — absorción interna (no se suma al total del cliente)
-- ─────────────────────────────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS total_igtf_usd NUMERIC(15,4) NOT NULL DEFAULT 0;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_total_igtf_lte_total;
ALTER TABLE sales ADD CONSTRAINT chk_sales_total_igtf_lte_total
  CHECK (total_igtf_usd >= 0 AND total_igtf_usd <= total_usd);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'total_net_usd'
  ) THEN
    ALTER TABLE sales
      ADD COLUMN total_net_usd NUMERIC(15,4)
      GENERATED ALWAYS AS (total_usd - total_igtf_usd) STORED;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────
-- sale_payments
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_payments (
  id                   BIGSERIAL PRIMARY KEY,
  sale_id              BIGINT        NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  payment_method_code  TEXT          NOT NULL REFERENCES payment_methods(code),

  amount_currency      NUMERIC(15,6) NOT NULL,
  amount_usd           NUMERIC(15,4) NOT NULL,

  generates_igtf       BOOLEAN       NOT NULL DEFAULT FALSE,
  igtf_rate_pct        NUMERIC(5,4),
  igtf_amount_usd      NUMERIC(15,4) NOT NULL DEFAULT 0,

  exchange_rate_used   NUMERIC(15,6),

  notes                TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT chk_sp_amount_pos   CHECK (amount_currency > 0),
  CONSTRAINT chk_sp_amount_usd   CHECK (amount_usd > 0),
  CONSTRAINT chk_sp_igtf_amount  CHECK (igtf_amount_usd >= 0),
  CONSTRAINT chk_sp_igtf_rate    CHECK (
    igtf_rate_pct IS NULL OR (igtf_rate_pct > 0 AND igtf_rate_pct < 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_sp_sale
  ON sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_sp_igtf
  ON sale_payments (generates_igtf, created_at)
  WHERE generates_igtf = TRUE;

-- ─────────────────────────────────────────────────────
-- igtf_declarations
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS igtf_declarations (
  id                BIGSERIAL    PRIMARY KEY,
  company_id        INTEGER      NOT NULL DEFAULT 1,
  period_year       INTEGER      NOT NULL,
  period_month      INTEGER      NOT NULL,
  total_taxable_usd NUMERIC(15,4) NOT NULL DEFAULT 0,
  total_igtf_usd    NUMERIC(15,4) NOT NULL DEFAULT 0,
  total_taxable_bs  NUMERIC(18,2),
  total_igtf_bs     NUMERIC(18,2),
  rate_pct_used     NUMERIC(5,4) NOT NULL,
  payment_count     INTEGER      NOT NULL DEFAULT 0,
  status            TEXT         NOT NULL DEFAULT 'DRAFT',
  filed_at          TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_igtf_decl_month CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT chk_igtf_decl_year  CHECK (period_year >= 2022)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_igtf_decl_period
  ON igtf_declarations (company_id, period_year, period_month);

DROP TRIGGER IF EXISTS trg_igtf_decl_updated_at ON igtf_declarations;
CREATE TRIGGER trg_igtf_decl_updated_at
  BEFORE UPDATE ON igtf_declarations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- calculate_igtf (una fila; método desconocido → sin IGTF)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_igtf(
  p_amount_usd            NUMERIC(15,4),
  p_payment_method_code   TEXT,
  p_date                  DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  generates_igtf  BOOLEAN,
  igtf_rate_pct     NUMERIC(5,4),
  igtf_amount_usd   NUMERIC(15,4),
  net_amount_usd    NUMERIC(15,4)
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(pm.generates_igtf, FALSE) AS generates_igtf,
    CASE WHEN COALESCE(pm.generates_igtf, FALSE)
      THEN get_igtf_rate(p_date)
    END AS igtf_rate_pct,
    CASE WHEN COALESCE(pm.generates_igtf, FALSE)
      THEN ROUND(p_amount_usd * COALESCE(get_igtf_rate(p_date), 0::numeric), 4)
      ELSE 0::numeric
    END AS igtf_amount_usd,
    CASE WHEN COALESCE(pm.generates_igtf, FALSE)
      THEN ROUND(p_amount_usd * (1::numeric - COALESCE(get_igtf_rate(p_date), 0::numeric)), 4)
      ELSE p_amount_usd
    END AS net_amount_usd
  FROM (SELECT 1) AS _x
  LEFT JOIN payment_methods pm ON pm.code = p_payment_method_code;
$$;

-- ─────────────────────────────────────────────────────
-- close_igtf_period
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_igtf_period(
  p_year       INTEGER,
  p_month      INTEGER,
  p_company_id INTEGER DEFAULT 1
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_taxable_usd  NUMERIC(15,4);
  v_igtf_usd     NUMERIC(15,4);
  v_count        INTEGER;
  v_rate         NUMERIC(5,4);
  v_last_rate    NUMERIC(15,6);
  v_period_start DATE;
  v_period_end   DATE;
BEGIN
  v_period_start := make_date(p_year, p_month, 1);
  v_period_end   := (v_period_start + INTERVAL '1 month - 1 day')::date;

  v_rate := get_igtf_rate(v_period_end);

  SELECT d.active_rate INTO v_last_rate
  FROM daily_exchange_rates d
  WHERE d.company_id = p_company_id
    AND d.rate_date <= v_period_end
    AND d.active_rate IS NOT NULL
  ORDER BY d.rate_date DESC
  LIMIT 1;

  SELECT
    COALESCE(SUM(sp.amount_usd), 0),
    COALESCE(SUM(sp.igtf_amount_usd), 0),
    COUNT(*)::integer
  INTO v_taxable_usd, v_igtf_usd, v_count
  FROM sale_payments sp
  JOIN sales s ON s.id = sp.sale_id
  WHERE sp.generates_igtf = TRUE
    AND s.company_id = p_company_id
    AND s.sale_date >= v_period_start
    AND s.sale_date <= v_period_end
    AND s.status IS DISTINCT FROM 'CANCELLED';

  INSERT INTO igtf_declarations (
    company_id, period_year, period_month,
    total_taxable_usd, total_igtf_usd,
    total_taxable_bs, total_igtf_bs,
    rate_pct_used, payment_count
  ) VALUES (
    p_company_id, p_year, p_month,
    v_taxable_usd, v_igtf_usd,
    CASE WHEN v_last_rate IS NOT NULL
      THEN ROUND(v_taxable_usd * v_last_rate, 2) END,
    CASE WHEN v_last_rate IS NOT NULL
      THEN ROUND(v_igtf_usd * v_last_rate, 2) END,
    v_rate, v_count
  )
  ON CONFLICT (company_id, period_year, period_month)
  DO UPDATE SET
    total_taxable_usd = EXCLUDED.total_taxable_usd,
    total_igtf_usd    = EXCLUDED.total_igtf_usd,
    total_taxable_bs  = EXCLUDED.total_taxable_bs,
    total_igtf_bs     = EXCLUDED.total_igtf_bs,
    rate_pct_used     = EXCLUDED.rate_pct_used,
    payment_count     = EXCLUDED.payment_count,
    updated_at        = now()
  WHERE igtf_declarations.status = 'DRAFT';

  RETURN jsonb_build_object(
    'period',            p_year::text || '-' || lpad(p_month::text, 2, '0'),
    'total_taxable_usd', v_taxable_usd,
    'total_igtf_usd',    v_igtf_usd,
    'total_igtf_bs',     ROUND(v_igtf_usd * COALESCE(v_last_rate, 0), 2),
    'payment_count',     v_count,
    'rate_pct',          v_rate
  );
END;
$$;

-- ─────────────────────────────────────────────────────
-- Vista resumen por período
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_igtf_by_period AS
SELECT
  date_trunc('month', s.sale_date::timestamp)::date AS period,
  s.company_id,
  COUNT(DISTINCT sp.sale_id)             AS sales_with_igtf,
  SUM(sp.amount_usd)                     AS total_taxable_usd,
  SUM(sp.igtf_amount_usd)                AS total_igtf_absorbed_usd,
  MAX(sp.igtf_rate_pct)                  AS rate_pct,
  SUM(sp.amount_usd) FILTER (
    WHERE sp.payment_method_code IN ('USD_CASH', 'USD_TRANSFER', 'ZELLE')
  )                                      AS taxable_usd,
  SUM(sp.amount_usd) FILTER (
    WHERE sp.payment_method_code LIKE 'EUR%'
  )                                      AS taxable_eur
FROM sale_payments sp
JOIN sales s ON s.id = sp.sale_id
WHERE sp.generates_igtf = TRUE
  AND s.status IS DISTINCT FROM 'CANCELLED'
GROUP BY date_trunc('month', s.sale_date::timestamp)::date, s.company_id
ORDER BY period DESC;
