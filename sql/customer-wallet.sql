-- ════════════════════════════════════════════════════════
-- Ferrari ERP — Customer Wallet
-- Saldos a favor por buyer_id (devoluciones, RMA, créditos)
--
-- Principio: el saldo desnormalizado en customer_wallets se actualiza
-- por trigger; la fuente de verdad es wallet_transactions (CONFIRMED).
-- Solo se permiten UPDATE en wallet_transactions para cambios de estado
-- (PENDING→CONFIRMED, CONFIRMED→CANCELLED); el resto es append-only.
-- ════════════════════════════════════════════════════════
--
-- Prerrequisitos: ml_buyers(buyer_id), set_updated_at() (shipping-providers.sql o wms-bins.sql).
--

-- ─────────────────────────────────────────────────────
-- 1. ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_tx_type AS ENUM (
    'CREDIT_RETURN',
    'CREDIT_RMA',
    'CREDIT_ADJUSTMENT',
    'CREDIT_OVERPAYMENT',
    'DEBIT_PURCHASE',
    'DEBIT_ADJUSTMENT',
    'DEBIT_REFUND_CASH'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_tx_status AS ENUM (
    'PENDING',
    'CONFIRMED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_currency AS ENUM (
    'USD',
    'VES'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─────────────────────────────────────────────────────
-- 2. customers
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL DEFAULT 1,

  full_name       TEXT    NOT NULL,
  id_type         TEXT,
  id_number       TEXT,
  email           TEXT,
  phone           TEXT,

  primary_ml_buyer_id BIGINT REFERENCES ml_buyers(buyer_id) ON DELETE SET NULL,

  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_customer_id_doc UNIQUE (company_id, id_type, id_number),
  CONSTRAINT chk_id_type CHECK (
    id_type IS NULL OR id_type IN ('V','E','J','G','P')
  )
);

CREATE INDEX IF NOT EXISTS idx_customers_ml_buyer
  ON customers (primary_ml_buyer_id)
  WHERE primary_ml_buyer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_phone
  ON customers (phone)
  WHERE phone IS NOT NULL;

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─────────────────────────────────────────────────────
-- 3. customer_ml_buyers — N:N customer ↔ ml_buyers
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_ml_buyers (
  customer_id     BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ml_buyer_id     BIGINT NOT NULL REFERENCES ml_buyers(buyer_id) ON DELETE CASCADE,
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, ml_buyer_id)
);

CREATE INDEX IF NOT EXISTS idx_cml_buyer
  ON customer_ml_buyers (ml_buyer_id);


-- ─────────────────────────────────────────────────────
-- 4. customer_wallets
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_wallets (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT          NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  currency        wallet_currency NOT NULL DEFAULT 'USD',
  balance         NUMERIC(15,4)   NOT NULL DEFAULT 0,
  last_movement_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wallet_customer_currency UNIQUE (customer_id, currency),
  CONSTRAINT chk_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallets_customer
  ON customer_wallets (customer_id);

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON customer_wallets;
CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON customer_wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─────────────────────────────────────────────────────
-- 5. wallet_transactions — libro mayor
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              BIGSERIAL PRIMARY KEY,
  wallet_id       BIGINT             NOT NULL REFERENCES customer_wallets(id) ON DELETE RESTRICT,
  customer_id     BIGINT             NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  tx_type         wallet_tx_type     NOT NULL,
  status          wallet_tx_status   NOT NULL DEFAULT 'PENDING',
  currency        wallet_currency    NOT NULL DEFAULT 'USD',

  amount          NUMERIC(15,4) NOT NULL,

  rate_applied    NUMERIC(15,6),
  rate_source     TEXT,
  amount_ves      NUMERIC(15,2),

  reference_type  TEXT,
  reference_id    TEXT,

  approved_by     INTEGER,
  approved_at     TIMESTAMPTZ,
  cancelled_by    INTEGER,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,

  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_amount_not_zero CHECK (amount != 0),
  CONSTRAINT chk_credit_positive CHECK (
    tx_type::text NOT LIKE 'CREDIT%' OR amount > 0
  ),
  CONSTRAINT chk_debit_negative CHECK (
    tx_type::text NOT LIKE 'DEBIT%' OR amount < 0
  ),
  CONSTRAINT chk_approved_confirmed CHECK (
    status != 'CONFIRMED'
    OR approved_by IS NOT NULL
    OR tx_type IN ('DEBIT_PURCHASE', 'DEBIT_REFUND_CASH')
  )
);

CREATE INDEX IF NOT EXISTS idx_wtx_wallet
  ON wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wtx_customer
  ON wallet_transactions (customer_id, status);
CREATE INDEX IF NOT EXISTS idx_wtx_reference
  ON wallet_transactions (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_wtx_pending
  ON wallet_transactions (status, created_at)
  WHERE status = 'PENDING';


-- ─────────────────────────────────────────────────────
-- 6. Trigger: balance en customer_wallets
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_wallet_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'CONFIRMED' THEN
    UPDATE customer_wallets
      SET balance          = balance + NEW.amount,
          last_movement_at = now()
    WHERE id = NEW.wallet_id;

  ELSIF TG_OP = 'UPDATE'
    AND OLD.status = 'PENDING'
    AND NEW.status = 'CONFIRMED' THEN
    UPDATE customer_wallets
      SET balance          = balance + NEW.amount,
          last_movement_at = now()
    WHERE id = NEW.wallet_id;

  ELSIF TG_OP = 'UPDATE'
    AND OLD.status = 'CONFIRMED'
    AND NEW.status = 'CANCELLED' THEN
    UPDATE customer_wallets
      SET balance          = balance - OLD.amount,
          last_movement_at = now()
    WHERE id = OLD.wallet_id;
  END IF;

  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM 1 FROM customer_wallets
    WHERE id = NEW.wallet_id AND balance < 0;
    IF FOUND THEN
      RAISE EXCEPTION
        'Balance negativo detectado en wallet_id=%. Operación revertida.',
        NEW.wallet_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_balance ON wallet_transactions;
CREATE TRIGGER trg_wallet_balance
  AFTER INSERT OR UPDATE OF status
  ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_wallet_balance();


-- ─────────────────────────────────────────────────────
-- 7. Vista resumen
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_customer_wallet_summary AS
SELECT
  c.id              AS customer_id,
  c.full_name,
  c.primary_ml_buyer_id,
  cw.id             AS wallet_id,
  cw.currency,
  cw.balance        AS balance_current,
  COALESCE(SUM(wt.amount) FILTER (
    WHERE wt.status = 'CONFIRMED'
  ), 0)             AS balance_calculated,
  cw.balance - COALESCE(SUM(wt.amount) FILTER (
    WHERE wt.status = 'CONFIRMED'
  ), 0)             AS balance_drift,
  COUNT(*) FILTER (WHERE wt.status = 'PENDING')    AS pending_count,
  COUNT(*) FILTER (WHERE wt.status = 'CONFIRMED')  AS confirmed_count,
  cw.last_movement_at
FROM customers c
JOIN customer_wallets    cw ON cw.customer_id = c.id
LEFT JOIN wallet_transactions wt ON wt.wallet_id = cw.id
GROUP BY c.id, c.full_name, c.primary_ml_buyer_id,
         cw.id, cw.currency, cw.balance, cw.last_movement_at;


-- ════════════════════════════════════════════════════════
-- Referencia (psql): consultas y prueba manual
-- ════════════════════════════════════════════════════════
--
-- Saldo por buyer ML:
-- SELECT cw.balance, cw.currency, cw.last_movement_at
-- FROM customer_wallets cw
-- JOIN customer_ml_buyers cmb ON cmb.customer_id = cw.customer_id
-- WHERE cmb.ml_buyer_id = $1 AND cw.currency = 'USD';
--
-- Historial de movimientos:
-- SELECT wt.created_at, wt.tx_type, wt.status, wt.amount, wt.reference_type, wt.reference_id
-- FROM wallet_transactions wt WHERE wt.customer_id = $1 ORDER BY wt.created_at DESC LIMIT 50;
--
-- Prueba trigger (sustituir ids; ROLLBACK al final):
-- BEGIN;
-- INSERT INTO customers (full_name) VALUES ('Cliente Test') RETURNING id;
-- INSERT INTO customer_wallets (customer_id, currency) VALUES (<id>, 'USD') RETURNING id;
-- INSERT INTO wallet_transactions (wallet_id, customer_id, tx_type, status, amount, approved_by, reference_type, reference_id)
-- VALUES (<wallet_id>, <customer_id>, 'CREDIT_RETURN', 'CONFIRMED', 100.00, 1, 'ml_order', 'ML-001');
-- SELECT balance FROM customer_wallets WHERE id = <wallet_id>;
-- INSERT INTO wallet_transactions (wallet_id, customer_id, tx_type, status, amount, reference_type)
-- VALUES (<wallet_id>, <customer_id>, 'DEBIT_PURCHASE', 'CONFIRMED', -200.00, 'purchase');
-- ROLLBACK;
