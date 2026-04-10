-- Columnas de enriquecimiento WhatsApp en customers
-- Ejecutar: psql $DATABASE_URL -f sql/20260410_customers_wa_enrichment.sql

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS wa_notify         TEXT,
  ADD COLUMN IF NOT EXISTS wa_is_business    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wa_verified_name  TEXT,
  ADD COLUMN IF NOT EXISTS wa_status         TEXT,
  ADD COLUMN IF NOT EXISTS client_segment    TEXT NOT NULL DEFAULT 'personal'
    CHECK (client_segment IN ('personal','business','enterprise')),
  ADD COLUMN IF NOT EXISTS last_wa_seen      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_enriched_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_segment
  ON customers(client_segment)
  WHERE client_segment != 'personal';

CREATE INDEX IF NOT EXISTS idx_customers_business
  ON customers(wa_is_business)
  WHERE wa_is_business = TRUE;
