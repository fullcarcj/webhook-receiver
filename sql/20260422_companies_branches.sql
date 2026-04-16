-- Ferrari ERP — Módulo Configuración de Negocio
-- Tablas: companies, branches, currencies
-- Requiere: set_updated_at() de currency-management.sql
-- Idempotente. Ejecutar: npm run db:business-config
-- NOTA: company_id=1 ya existe en todo el sistema. El seed lo ancla
--       con ON CONFLICT DO NOTHING para no romper datos existentes.

-- ─────────────────────────────────────────────────────────────────────
-- companies
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                 SERIAL      PRIMARY KEY,
  name               TEXT        NOT NULL,
  rif                TEXT        NOT NULL,
  address            TEXT,
  phone              TEXT,
  email              TEXT,
  base_currency_code TEXT        NOT NULL DEFAULT 'USD',
  fiscal_year_start  SMALLINT    NOT NULL DEFAULT 1
    CONSTRAINT chk_companies_fiscal_month CHECK (fiscal_year_start BETWEEN 1 AND 12),
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_companies_rif UNIQUE (rif)
);

CREATE INDEX IF NOT EXISTS idx_companies_active
  ON companies (is_active) WHERE is_active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_companies_updated_at'
  ) THEN
    CREATE TRIGGER trg_companies_updated_at
      BEFORE UPDATE ON companies
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Anclar company_id=1 — ya referenciado en daily_exchange_rates, products, etc.
INSERT INTO companies (id, name, rif, base_currency_code, fiscal_year_start)
VALUES (1, 'Empresa Principal', 'J-00000000-0', 'USD', 1)
ON CONFLICT (id) DO NOTHING;

-- Adelantar la secuencia para que el próximo INSERT no choque con id=1
SELECT setval(
  pg_get_serial_sequence('companies', 'id'),
  GREATEST(1, (SELECT MAX(id) FROM companies))
);

-- ─────────────────────────────────────────────────────────────────────
-- branches — sucursales / puntos de venta
-- Inventario y caja se aíslan por branch_id
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id             SERIAL      PRIMARY KEY,
  company_id     INTEGER     NOT NULL DEFAULT 1
    REFERENCES companies(id) ON DELETE RESTRICT,
  name           TEXT        NOT NULL,
  code           TEXT        NOT NULL,
  address        TEXT,
  phone          TEXT,
  is_main_branch BOOLEAN     NOT NULL DEFAULT FALSE,
  has_warehouse  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_branches_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_branches_company
  ON branches (company_id, is_active);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_branches_updated_at'
  ) THEN
    CREATE TRIGGER trg_branches_updated_at
      BEFORE UPDATE ON branches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

INSERT INTO branches (company_id, name, code, is_main_branch, has_warehouse)
VALUES (1, 'Sede Principal', 'MAIN', TRUE, TRUE)
ON CONFLICT (company_id, code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- currencies — catálogo de monedas (referencia; NO reemplaza daily_exchange_rates)
-- REGLA: nunca borrar una moneda; usar is_active=false
-- REGLA: solo una moneda puede ser is_base_currency=true
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS currencies (
  code             TEXT     PRIMARY KEY,
  name             TEXT     NOT NULL,
  symbol           TEXT     NOT NULL DEFAULT '',
  decimal_places   SMALLINT NOT NULL DEFAULT 2
    CONSTRAINT chk_currencies_dec CHECK (decimal_places BETWEEN 0 AND 8),
  is_base_currency BOOLEAN  NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN  NOT NULL DEFAULT TRUE
);

-- Solo una moneda base (USD)
CREATE UNIQUE INDEX IF NOT EXISTS uq_currencies_one_base
  ON currencies (is_base_currency)
  WHERE is_base_currency = TRUE;

-- VES es el código ISO 4217 correcto para el Bolívar Soberano/Digital
INSERT INTO currencies (code, name, symbol, decimal_places, is_base_currency) VALUES
  ('USD', 'Dólar Estadounidense',  '$',   2, TRUE),
  ('VES', 'Bolívar Soberano',      'Bs.', 2, FALSE),
  ('EUR', 'Euro',                  '€',   2, FALSE)
ON CONFLICT (code) DO NOTHING;
