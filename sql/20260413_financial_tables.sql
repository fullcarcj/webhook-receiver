-- Módulo Analytics ERP/CRM + Control Financiero Multi-Moneda
-- Tablas: expense_categories, debit_justifications, manual_transactions, exchange_rates

-- ── Catálogo de conceptos de gasto ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('gasto','inversion','devolucion','nomina')),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO expense_categories (name, type) VALUES
  ('ADELANTOS SUELDOS',              'nomina'),
  ('COMISION BANCARIA',              'gasto'),
  ('COMPRA ARTICULOS CASA',          'gasto'),
  ('COMPRA MATERIALES MANTENIMIENTO','inversion'),
  ('CONSUMIBLES',                    'gasto'),
  ('DEVOLUCION',                     'devolucion'),
  ('DOLARES',                        'inversion'),
  ('ENTRETENIMIENTO',                'gasto'),
  ('ESCOLARES',                      'gasto'),
  ('FAMILIAR',                       'gasto'),
  ('FARMATODO',                      'gasto'),
  ('GASOLINA',                       'gasto'),
  ('MERCADO',                        'gasto'),
  ('MERCADOLIBRE',                   'gasto'),
  ('PAGO A PROVEEDOR',               'gasto'),
  ('SERVICIOS DE COMIDA Y TAXI',     'gasto')
ON CONFLICT (name) DO NOTHING;

-- ── Justificación de débitos de bank_statements ───────────────────────────────
CREATE TABLE IF NOT EXISTS debit_justifications (
  id                  BIGSERIAL PRIMARY KEY,
  bank_statement_id   BIGINT NOT NULL UNIQUE REFERENCES bank_statements(id),
  expense_category_id BIGINT NOT NULL REFERENCES expense_categories(id),
  justification_note  TEXT,
  justified_by        TEXT NOT NULL,
  justified_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debit_just_statement
  ON debit_justifications(bank_statement_id);
CREATE INDEX IF NOT EXISTS idx_debit_just_category
  ON debit_justifications(expense_category_id, justified_at DESC);

-- ── Transacciones manuales en monedas externas ────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_currency') THEN
    CREATE TYPE transaction_currency AS ENUM
      ('BS','USD','ZELLE','BINANCE','EFECTIVO','EFECTIVO_BS','CREDITO','PANAMA');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS manual_transactions (
  id                  BIGSERIAL PRIMARY KEY,
  type                TEXT NOT NULL CHECK (type IN ('ingreso','egreso','inversion')),
  currency            transaction_currency NOT NULL,
  amount              NUMERIC(14,4) NOT NULL CHECK (amount > 0),
  amount_usd_equiv    NUMERIC(14,4),
  exchange_rate_used  NUMERIC(10,4),
  expense_category_id BIGINT REFERENCES expense_categories(id),
  description         TEXT NOT NULL,
  reference           TEXT,
  tx_date             DATE NOT NULL DEFAULT CURRENT_DATE,
  registered_by       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manual_tx_date
  ON manual_transactions(tx_date DESC, currency);
CREATE INDEX IF NOT EXISTS idx_manual_tx_type
  ON manual_transactions(type, currency, tx_date DESC);
CREATE INDEX IF NOT EXISTS idx_manual_tx_category
  ON manual_transactions(expense_category_id, tx_date DESC);

-- ── Tasas de cambio históricas ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchange_rates (
  id            BIGSERIAL PRIMARY KEY,
  rate_date     DATE NOT NULL UNIQUE,
  bs_per_usd    NUMERIC(10,4) NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  registered_by TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_date
  ON exchange_rates(rate_date DESC);

COMMENT ON TABLE expense_categories   IS 'Catálogo de conceptos de gasto para justificar débitos bancarios y transacciones manuales.';
COMMENT ON TABLE debit_justifications IS 'Justificación de cada débito de bank_statements — enlaza al gasto contable.';
COMMENT ON TABLE manual_transactions  IS 'Transacciones en monedas externas (Zelle, Binance, Efectivo, etc.) no capturadas por Banesco.';
COMMENT ON TABLE exchange_rates       IS 'Tasas de cambio Bs/USD por día para conversión de montos.';
