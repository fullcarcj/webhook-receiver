-- Fidelización CRM — ejecutar después de customer-wallet.sql y crm-solomotor3k.sql
-- Independiente del wallet de saldos (customer_wallets).

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  points_balance  INT NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  level           TEXT NOT NULL DEFAULT 'bronze'
                    CHECK (level IN ('bronze','silver','gold','vip')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_movements (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('earn','redeem','adjust','expire')),
  points          INT NOT NULL,
  reason          TEXT NOT NULL,
  reference_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotencia por orden: un solo earn por (customer_id, reference_id) cuando reference_id no es NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_movements_customer_ref
  ON loyalty_movements (customer_id, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_movements_customer
  ON loyalty_movements (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_level
  ON loyalty_accounts(level);

CREATE OR REPLACE FUNCTION loyalty_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loyalty_accounts_updated ON loyalty_accounts;
CREATE TRIGGER trg_loyalty_accounts_updated
  BEFORE UPDATE ON loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION loyalty_touch_updated_at();
