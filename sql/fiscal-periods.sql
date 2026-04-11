-- Ferrari ERP — Períodos fiscales, settings_tax, retenciones declarativas.
-- Requiere: set_updated_at(), daily_exchange_rates, sales(id), purchases(id) (exchange-rates.sql + igtf.sql).
-- Idempotente. Orden sugerido: exchange-rates.sql → igtf.sql → este archivo.
-- psql $DATABASE_URL -f sql/fiscal-periods.sql
--   o: npm run db:fiscal-periods

-- ─────────────────────────────────────────────────────
-- ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE tax_type AS ENUM (
    'IVA','ISLR','IGTF',
    'IVA_RETENIDO','ISLR_RETENIDO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE period_frequency AS ENUM (
    'MONTHLY','BIMONTHLY','QUARTERLY','ANNUAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE period_status AS ENUM (
    'OPEN','CLOSED','FILED','PAID'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE retention_role AS ENUM ('AGENT','SUBJECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────
-- settings_tax — configuración fiscal dinámica
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings_tax (
  id             SERIAL      PRIMARY KEY,
  company_id     INTEGER     NOT NULL DEFAULT 1,
  key            TEXT        NOT NULL,
  value          TEXT        NOT NULL,
  value_type     TEXT        NOT NULL DEFAULT 'string',
  description    TEXT,
  allowed_values TEXT,
  effective_from DATE        NOT NULL DEFAULT CURRENT_DATE,
  updated_by     INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_st_key UNIQUE (company_id, key, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_st_company_key
  ON settings_tax (company_id, key, effective_from DESC);

INSERT INTO settings_tax
  (company_id, key, value, value_type, description, allowed_values, effective_from)
VALUES
  (1,'iva_rate_pct',        '16',      'number',
   'Tasa IVA general %', NULL, DATE '2020-01-01'),
  (1,'iva_reduced_rate_pct','8',       'number',
   'Tasa IVA reducida %', NULL, DATE '2020-01-01'),
  (1,'iva_luxury_rate_pct', '15',      'number',
   'Alícuota adicional bienes de lujo %', NULL, DATE '2020-01-01'),
  (1,'iva_frequency',       'MONTHLY', 'enum',
   'Frecuencia declaración IVA', 'MONTHLY,BIMONTHLY,QUARTERLY,ANNUAL', DATE '2020-01-01'),
  (1,'iva_retention_pct',   '75',      'number',
   '% retención sobre IVA (0 = no retiene)', NULL, DATE '2020-01-01'),
  (1,'islr_frequency',      'ANNUAL',  'enum',
   'Frecuencia declaración ISLR', 'ANNUAL,QUARTERLY', DATE '2020-01-01'),
  (1,'islr_retention_pct',  '3',       'number',
   '% retención ISLR honorarios (0 = no retiene)', NULL, DATE '2020-01-01'),
  (1,'islr_freight_pct',    '1',       'number',
   '% retención ISLR fletes (0 = no retiene)', NULL, DATE '2020-01-01'),
  (1,'is_retention_agent',  '1',       'boolean',
   '¿Es agente de retención SENIAT? 1=sí 0=no', NULL, DATE '2020-01-01'),
  (1,'igtf_rate_pct',       '3',       'number',
   'Tasa IGTF % sobre pagos en divisas', NULL, DATE '2020-01-01'),
  (1,'igtf_absorbed_by',    'COMPANY', 'enum',
   'Quién asume el IGTF', 'COMPANY,CLIENT', DATE '2020-01-01'),
  (1,'fiscal_year_start',   '1',       'number',
   'Mes inicio año fiscal', NULL, DATE '2020-01-01'),
  (1,'rif',                 '',        'string',
   'RIF de la empresa', NULL, DATE '2020-01-01'),
  (1,'razon_social',        '',        'string',
   'Razón social legal', NULL, DATE '2020-01-01'),
  (1,'domicilio_fiscal',    '',        'string',
   'Dirección fiscal ante SENIAT', NULL, DATE '2020-01-01')
ON CONFLICT (company_id, key, effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION get_tax_setting(
  p_key        TEXT,
  p_company_id INTEGER DEFAULT 1,
  p_date       DATE    DEFAULT CURRENT_DATE
)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT value FROM settings_tax
  WHERE company_id   = p_company_id
    AND key          = p_key
    AND effective_from <= p_date
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_tax_setting_num(
  p_key TEXT, p_company_id INTEGER DEFAULT 1, p_date DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT NULLIF(trim(get_tax_setting(p_key, p_company_id, p_date)), '')::NUMERIC;
$$;

CREATE OR REPLACE FUNCTION get_tax_setting_bool(
  p_key TEXT, p_company_id INTEGER DEFAULT 1, p_date DATE DEFAULT CURRENT_DATE
)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT get_tax_setting(p_key, p_company_id, p_date) = '1';
$$;

-- ─────────────────────────────────────────────────────
-- fiscal_periods
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fiscal_periods (
  id                    BIGSERIAL        PRIMARY KEY,
  company_id            INTEGER          NOT NULL DEFAULT 1,
  tax_type              tax_type         NOT NULL,
  frequency             period_frequency NOT NULL,
  period_year           INTEGER          NOT NULL,
  period_month          INTEGER,
  period_label          TEXT             NOT NULL,
  date_from             DATE             NOT NULL,
  date_to               DATE             NOT NULL,
  status                period_status    NOT NULL DEFAULT 'OPEN',

  iva_ventas_base_usd   NUMERIC(15,4),
  iva_ventas_usd        NUMERIC(15,4),
  iva_compras_base_usd  NUMERIC(15,4),
  iva_compras_usd       NUMERIC(15,4),
  iva_retenido_usd      NUMERIC(15,4),
  iva_soportado_usd     NUMERIC(15,4),
  iva_a_pagar_usd       NUMERIC(15,4),

  settings_snapshot     JSONB,
  rate_closing          NUMERIC(15,6),

  closed_at             TIMESTAMPTZ,
  closed_by             INTEGER,
  filed_at              TIMESTAMPTZ,
  filed_ref             TEXT,
  paid_at               TIMESTAMPTZ,
  paid_amount_usd       NUMERIC(15,4),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_fp_dates CHECK (date_to >= date_from)
);

-- PG15+: un solo período anual con period_month NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'fiscal_periods' AND c.conname = 'uq_fiscal_period'
  ) THEN
    ALTER TABLE fiscal_periods DROP CONSTRAINT IF EXISTS uq_fiscal_period;
  END IF;
END $$;

ALTER TABLE fiscal_periods
  ADD CONSTRAINT uq_fiscal_period
  UNIQUE NULLS NOT DISTINCT (company_id, tax_type, period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_fp_company_type_status
  ON fiscal_periods (company_id, tax_type, status);

DROP TRIGGER IF EXISTS trg_fp_updated_at ON fiscal_periods;
CREATE TRIGGER trg_fp_updated_at
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- tax_transactions — hechos imponibles (append-only en app)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_transactions (
  id               BIGSERIAL    PRIMARY KEY,
  company_id       INTEGER      NOT NULL DEFAULT 1,
  fiscal_period_id BIGINT       NOT NULL
                     REFERENCES fiscal_periods(id),
  tax_type         tax_type     NOT NULL,
  source_type      TEXT         NOT NULL,
  source_id        BIGINT       NOT NULL,
  transaction_date DATE         NOT NULL,
  base_amount_usd  NUMERIC(15,4) NOT NULL,
  tax_rate_pct     NUMERIC(7,4)  NOT NULL,
  tax_amount_usd   NUMERIC(15,4) NOT NULL,
  retention_role   retention_role,
  rate_applied     NUMERIC(15,6),
  base_amount_bs   NUMERIC(18,2),
  tax_amount_bs    NUMERIC(18,2),
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_tt_base CHECK (
    (source_type = 'adjustment' AND base_amount_usd <> 0)
    OR (source_type <> 'adjustment' AND base_amount_usd > 0)
  ),
  CONSTRAINT chk_tt_rate CHECK (tax_rate_pct > 0)
);

CREATE INDEX IF NOT EXISTS idx_tt_period
  ON tax_transactions (fiscal_period_id, tax_type);
CREATE INDEX IF NOT EXISTS idx_tt_source
  ON tax_transactions (source_type, source_id);

-- ─────────────────────────────────────────────────────
-- retentions
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retentions (
  id                   BIGSERIAL      PRIMARY KEY,
  company_id           INTEGER        NOT NULL DEFAULT 1,
  fiscal_period_id     BIGINT         NOT NULL
                         REFERENCES fiscal_periods(id),
  retention_role       retention_role NOT NULL,
  counterpart_name     TEXT           NOT NULL,
  counterpart_rif      TEXT,
  comprobante_number   TEXT,
  retention_date       DATE           NOT NULL,
  tax_type             tax_type       NOT NULL,
  base_amount_usd      NUMERIC(15,4)  NOT NULL,
  retention_rate_pct   NUMERIC(7,4)   NOT NULL,
  retention_amount_usd NUMERIC(15,4)  NOT NULL,
  rate_applied         NUMERIC(15,6),
  retention_amount_bs  NUMERIC(18,2),
  purchase_id          BIGINT REFERENCES purchases(id),
  sale_id              BIGINT REFERENCES sales(id),
  status               TEXT    NOT NULL DEFAULT 'PENDING',
  notes                TEXT,
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT chk_ret_base   CHECK (base_amount_usd > 0),
  CONSTRAINT chk_ret_amount CHECK (retention_amount_usd > 0)
);

CREATE INDEX IF NOT EXISTS idx_ret_period
  ON retentions (fiscal_period_id);

DROP TRIGGER IF EXISTS trg_ret_updated_at ON retentions;
CREATE TRIGGER trg_ret_updated_at
  BEFORE UPDATE ON retentions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- open_fiscal_period()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION open_fiscal_period(
  p_tax_type   TEXT,
  p_year       INTEGER,
  p_month      INTEGER  DEFAULT NULL,
  p_company_id INTEGER  DEFAULT 1
)
RETURNS fiscal_periods LANGUAGE plpgsql AS $$
DECLARE
  v_period  fiscal_periods%ROWTYPE;
  v_from    DATE;
  v_to      DATE;
  v_label   TEXT;
  v_freq    period_frequency;
  v_setting TEXT;
  v_freq_key TEXT;
BEGIN
  v_freq_key := CASE upper(trim(p_tax_type))
    WHEN 'IVA'  THEN 'iva_frequency'
    WHEN 'ISLR' THEN 'islr_frequency'
    ELSE lower(trim(p_tax_type)) || '_frequency'
  END;

  v_setting := get_tax_setting(v_freq_key, p_company_id);

  v_freq := COALESCE(
    NULLIF(trim(v_setting), '')::period_frequency,
    CASE upper(trim(p_tax_type)) WHEN 'ISLR' THEN 'ANNUAL'::period_frequency ELSE 'MONTHLY'::period_frequency END
  );

  IF v_freq IN ('MONTHLY','BIMONTHLY') AND p_month IS NOT NULL THEN
    v_from  := make_date(p_year, p_month, 1);
    v_to    := (v_from + INTERVAL '1 month - 1 day')::DATE;
    IF v_freq = 'BIMONTHLY' THEN
      v_to := (v_from + INTERVAL '2 month - 1 day')::DATE;
    END IF;
    v_label := upper(trim(p_tax_type)) || ' '
               || p_year || '-'
               || LPAD(p_month::TEXT, 2, '0');
  ELSE
    v_from  := make_date(p_year, 1, 1);
    v_to    := make_date(p_year, 12, 31);
    v_label := upper(trim(p_tax_type)) || ' ' || p_year;
  END IF;

  INSERT INTO fiscal_periods (
    company_id, tax_type, frequency,
    period_year, period_month, period_label,
    date_from, date_to
  ) VALUES (
    p_company_id, upper(trim(p_tax_type))::tax_type, v_freq,
    p_year, p_month, v_label, v_from, v_to
  )
  ON CONFLICT (company_id, tax_type, period_year, period_month)
  DO NOTHING
  RETURNING * INTO v_period;

  IF v_period.id IS NULL THEN
    SELECT * INTO v_period FROM fiscal_periods
    WHERE company_id = p_company_id
      AND tax_type = upper(trim(p_tax_type))::tax_type
      AND period_year    = p_year
      AND (period_month IS NOT DISTINCT FROM p_month);
  END IF;

  RETURN v_period;
END;
$$;

-- ─────────────────────────────────────────────────────
-- close_fiscal_period()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_fiscal_period(
  p_period_id  BIGINT,
  p_user_id    INTEGER DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_period      fiscal_periods%ROWTYPE;
  v_rate        NUMERIC(15,6);
  v_iva_debito  NUMERIC(15,4) := 0;
  v_iva_credito NUMERIC(15,4) := 0;
  v_iva_ret_em  NUMERIC(15,4) := 0;
  v_iva_ret_rec NUMERIC(15,4) := 0;
  v_iva_pagar   NUMERIC(15,4) := 0;
  v_snapshot    JSONB;
BEGIN
  SELECT * INTO v_period
  FROM fiscal_periods WHERE id = p_period_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Período % no encontrado', p_period_id;
  END IF;
  IF v_period.status != 'OPEN' THEN
    RAISE EXCEPTION 'Período % ya está %',
      p_period_id, v_period.status;
  END IF;

  v_snapshot := jsonb_build_object(
    'iva_rate_pct',       get_tax_setting('iva_rate_pct', v_period.company_id, v_period.date_to),
    'iva_retention_pct',  get_tax_setting('iva_retention_pct', v_period.company_id, v_period.date_to),
    'is_retention_agent', get_tax_setting('is_retention_agent', v_period.company_id, v_period.date_to),
    'igtf_rate_pct',      get_tax_setting('igtf_rate_pct', v_period.company_id, v_period.date_to)
  );

  SELECT active_rate INTO v_rate
  FROM daily_exchange_rates
  WHERE company_id  = v_period.company_id
    AND rate_date  <= v_period.date_to
    AND active_rate IS NOT NULL
  ORDER BY rate_date DESC LIMIT 1;

  SELECT COALESCE(SUM(tax_amount_usd), 0) INTO v_iva_debito
  FROM tax_transactions WHERE fiscal_period_id = p_period_id
    AND tax_type = 'IVA' AND source_type = 'sale';

  SELECT COALESCE(SUM(tax_amount_usd), 0) INTO v_iva_credito
  FROM tax_transactions WHERE fiscal_period_id = p_period_id
    AND tax_type = 'IVA' AND source_type = 'purchase';

  SELECT COALESCE(SUM(retention_amount_usd), 0) INTO v_iva_ret_em
  FROM retentions WHERE fiscal_period_id = p_period_id
    AND tax_type = 'IVA_RETENIDO' AND retention_role = 'AGENT';

  SELECT COALESCE(SUM(retention_amount_usd), 0) INTO v_iva_ret_rec
  FROM retentions WHERE fiscal_period_id = p_period_id
    AND tax_type = 'IVA_RETENIDO' AND retention_role = 'SUBJECT';

  v_iva_pagar := v_iva_debito - v_iva_credito - v_iva_ret_rec;

  UPDATE fiscal_periods SET
    status               = 'CLOSED',
    iva_ventas_base_usd  = (
      SELECT COALESCE(SUM(base_amount_usd),0)
      FROM tax_transactions WHERE fiscal_period_id = p_period_id
        AND tax_type = 'IVA' AND source_type = 'sale'),
    iva_ventas_usd       = v_iva_debito,
    iva_compras_base_usd = (
      SELECT COALESCE(SUM(base_amount_usd),0)
      FROM tax_transactions WHERE fiscal_period_id = p_period_id
        AND tax_type = 'IVA' AND source_type = 'purchase'),
    iva_compras_usd      = v_iva_credito,
    iva_retenido_usd     = v_iva_ret_em,
    iva_soportado_usd    = v_iva_ret_rec,
    iva_a_pagar_usd      = v_iva_pagar,
    settings_snapshot    = v_snapshot,
    rate_closing         = v_rate,
    closed_at            = now(),
    closed_by            = p_user_id,
    updated_at           = now()
  WHERE id = p_period_id;

  RETURN jsonb_build_object(
    'period_id',         p_period_id,
    'period_label',      v_period.period_label,
    'iva_debito_usd',    v_iva_debito,
    'iva_credito_usd',   v_iva_credito,
    'iva_retenido_usd',  v_iva_ret_em,
    'iva_soportado_usd', v_iva_ret_rec,
    'iva_a_pagar_usd',   v_iva_pagar,
    'iva_a_pagar_bs',    ROUND(v_iva_pagar
                           * COALESCE(v_rate, 0), 2),
    'settings_snapshot', v_snapshot,
    'rate_closing',      v_rate
  );
END;
$$;

-- ─────────────────────────────────────────────────────
-- Vista resumen
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_fiscal_periods_summary AS
SELECT
  fp.id, fp.company_id, fp.tax_type,
  fp.period_label, fp.date_from, fp.date_to,
  fp.status, fp.frequency,
  fp.iva_ventas_usd, fp.iva_compras_usd,
  fp.iva_retenido_usd, fp.iva_soportado_usd,
  fp.iva_a_pagar_usd,
  ROUND(fp.iva_a_pagar_usd
    * COALESCE(fp.rate_closing, 0), 2)  AS iva_a_pagar_bs,
  COUNT(tt.id)                          AS transaction_count,
  fp.settings_snapshot,
  fp.filed_ref, fp.filed_at, fp.paid_at
FROM fiscal_periods fp
LEFT JOIN tax_transactions tt ON tt.fiscal_period_id = fp.id
GROUP BY fp.id
ORDER BY fp.period_year DESC,
         fp.period_month DESC NULLS LAST;

-- Fuente de verdad IGTF: settings_tax (porcentaje, p. ej. 3 → 0.03).
-- Fallback a igtf_config si no hay valor en settings_tax.
CREATE OR REPLACE FUNCTION get_igtf_rate(p_date DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC(5,4) LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN v > 1 THEN LEAST(1::numeric, v / 100.0)
        ELSE LEAST(1::numeric, GREATEST(0::numeric, v))
      END
      FROM (
        SELECT get_tax_setting_num('igtf_rate_pct', 1, p_date) AS v
      ) s
      WHERE v IS NOT NULL AND v > 0
    ),
    (
      SELECT rate_pct FROM igtf_config
      WHERE effective_from <= p_date
      ORDER BY effective_from DESC
      LIMIT 1
    )
  );
$$;
