-- Ferrari ERP — Retenciones IVA (fracción del IVA devengado, ej. 75%) e ISLR por método de pago
-- Requiere: tabla public.sales (exchange-rates.sql) para sale_payments; set_updated_at() si triggers igtf.
-- Si aún no corriste igtf.sql, este archivo crea payment_methods + semilla (compatible con igtf.sql).
-- Convención: amount_usd del pago se trata como base imponible en USD equivalente para aplicar alícuota IVA.
-- Idempotente. Orden recomendado: exchange-rates → igtf → tax-retentions (o exchange-rates → tax-retentions).
-- psql $DATABASE_URL -f sql/tax-retentions.sql

-- ─────────────────────────────────────────────────────
-- 0. payment_methods (bootstrap si no existe — mismo contrato que sql/igtf.sql)
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
-- Parámetros globales (alícuota IVA y fracción retenida del IVA)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_retention_globals (
  id                            SERIAL PRIMARY KEY,
  effective_from                DATE         NOT NULL,
  vat_aliquota_pct              NUMERIC(5,4) NOT NULL DEFAULT 0.16,
  iva_retained_fraction_of_vat  NUMERIC(5,4) NOT NULL DEFAULT 0.75,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_trg_vat_ali    CHECK (vat_aliquota_pct >= 0 AND vat_aliquota_pct < 1),
  CONSTRAINT chk_trg_iva_frac CHECK (
    iva_retained_fraction_of_vat >= 0 AND iva_retained_fraction_of_vat <= 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_retention_globals_from
  ON tax_retention_globals (effective_from);

INSERT INTO tax_retention_globals (
  effective_from,
  vat_aliquota_pct,
  iva_retained_fraction_of_vat,
  notes
) VALUES (
  '2022-01-01'::date,
  0.1600,
  0.7500,
  'IVA general 16%; retención 75% del IVA devengado (ajustar según normativa vigente)'
)
ON CONFLICT (effective_from) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- payment_methods — flags por método
-- ─────────────────────────────────────────────────────
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS iva_retention_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS islr_retention_pct NUMERIC(8,6) NOT NULL DEFAULT 0;

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS chk_pm_islr_pct;
ALTER TABLE payment_methods ADD CONSTRAINT chk_pm_islr_pct
  CHECK (islr_retention_pct >= 0 AND islr_retention_pct < 1);

-- Por defecto: divisas sin retención IVA/ISLR en este modelo; VES con retención IVA típica
UPDATE payment_methods SET iva_retention_enabled = FALSE, islr_retention_pct = 0
WHERE code IN ('USD_CASH', 'USD_TRANSFER', 'ZELLE', 'EUR_CASH');

UPDATE payment_methods SET iva_retention_enabled = TRUE, islr_retention_pct = 0
WHERE code IN ('BS_TRANSFER', 'PAGO_MOVIL', 'BS_CASH', 'PUNTO_DEBITO');

-- ─────────────────────────────────────────────────────
-- sale_payments — montos retenidos por línea (solo si la tabla ya existe; la crea igtf.sql)
-- ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sale_payments'
  ) THEN
    ALTER TABLE sale_payments
      ADD COLUMN IF NOT EXISTS iva_retention_usd NUMERIC(15,4) NOT NULL DEFAULT 0;
    ALTER TABLE sale_payments
      ADD COLUMN IF NOT EXISTS islr_retention_usd NUMERIC(15,4) NOT NULL DEFAULT 0;
    ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS chk_sp_iva_ret;
    ALTER TABLE sale_payments ADD CONSTRAINT chk_sp_iva_ret CHECK (iva_retention_usd >= 0);
    ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS chk_sp_islr_ret;
    ALTER TABLE sale_payments ADD CONSTRAINT chk_sp_islr_ret CHECK (islr_retention_usd >= 0);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────
-- Función: retenciones por pago (lectura)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_payment_tax_retentions(
  p_amount_usd            NUMERIC(15,4),
  p_payment_method_code   TEXT,
  p_date                  DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  iva_retention_enabled       BOOLEAN,
  vat_aliquota_pct            NUMERIC(5,4),
  iva_retained_fraction_of_vat NUMERIC(5,4),
  iva_retention_usd           NUMERIC(15,4),
  islr_retention_pct          NUMERIC(8,6),
  islr_retention_usd          NUMERIC(15,4)
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(pm.iva_retention_enabled, FALSE) AS iva_retention_enabled,
    COALESCE(g.vat_aliquota_pct, 0.16::numeric) AS vat_aliquota_pct,
    COALESCE(g.iva_retained_fraction_of_vat, 0.75::numeric) AS iva_retained_fraction_of_vat,
    CASE WHEN COALESCE(pm.iva_retention_enabled, FALSE)
      THEN ROUND(
        p_amount_usd
        * COALESCE(g.vat_aliquota_pct, 0.16)
        * COALESCE(g.iva_retained_fraction_of_vat, 0.75),
        4
      )
      ELSE 0::numeric
    END AS iva_retention_usd,
    COALESCE(pm.islr_retention_pct, 0::numeric) AS islr_retention_pct,
    ROUND(p_amount_usd * COALESCE(pm.islr_retention_pct, 0::numeric), 4) AS islr_retention_usd
  FROM (SELECT 1) AS _x
  LEFT JOIN LATERAL (
    SELECT vat_aliquota_pct, iva_retained_fraction_of_vat
    FROM tax_retention_globals
    WHERE effective_from <= p_date
    ORDER BY effective_from DESC
    LIMIT 1
  ) g ON TRUE
  LEFT JOIN payment_methods pm ON pm.code = p_payment_method_code;
$$;
