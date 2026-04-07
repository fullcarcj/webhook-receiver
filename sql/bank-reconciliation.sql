-- Ferrari ERP — Conciliación bancaria (Banesco CSV + facturas)
-- Idempotente: re-ejecutar es seguro
-- Si ya ejecutaste shipping-providers.sql o currency-management.sql, set_updated_at() ya existe;
-- aquí se define igual para poder aplicar solo este archivo.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────
-- ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE bank_currency AS ENUM ('USD','VES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE statement_tx_type AS ENUM ('CREDIT','DEBIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reconciliation_status AS ENUM (
    'MATCHED',
    'SUGGESTED',
    'CONFIRMED',
    'UNMATCHED',
    'IGNORED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────
-- bank_accounts
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER       NOT NULL DEFAULT 1,
  bank_name        TEXT          NOT NULL DEFAULT 'Banesco',
  account_number   TEXT          NOT NULL,
  account_alias    TEXT,
  currency         bank_currency NOT NULL DEFAULT 'VES',
  session_cookies  TEXT,
  session_saved_at TIMESTAMPTZ,
  is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_bank_account
    UNIQUE (company_id, bank_name, account_number)
);

INSERT INTO bank_accounts
  (company_id, bank_name, account_number, account_alias, currency)
VALUES
  (1, 'Banesco', 'V017488886', 'Banesco VES principal', 'VES'::bank_currency)
ON CONFLICT (company_id, bank_name, account_number) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- bank_statements
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_statements (
  id                    BIGSERIAL         PRIMARY KEY,
  bank_account_id       BIGINT            NOT NULL
                          REFERENCES bank_accounts(id),
  tx_date               DATE              NOT NULL,
  reference_number      TEXT,
  description           TEXT              NOT NULL DEFAULT '',
  tx_type               statement_tx_type NOT NULL DEFAULT 'CREDIT',
  amount                NUMERIC(15,4)     NOT NULL,
  balance_after         NUMERIC(15,4),
  payment_type          TEXT,
  reconciliation_status reconciliation_status NOT NULL DEFAULT 'UNMATCHED',
  row_hash              TEXT              NOT NULL,
  created_at            TIMESTAMPTZ       NOT NULL DEFAULT now(),
  CONSTRAINT uq_row_hash    UNIQUE (row_hash),
  CONSTRAINT chk_amount_pos CHECK  (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_bs_account_date
  ON bank_statements (bank_account_id, tx_date DESC);

CREATE INDEX IF NOT EXISTS idx_bs_reference
  ON bank_statements (reference_number)
  WHERE reference_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bs_unmatched
  ON bank_statements (reconciliation_status)
  WHERE reconciliation_status IN ('UNMATCHED','SUGGESTED');

CREATE INDEX IF NOT EXISTS idx_bs_payment_type
  ON bank_statements (payment_type)
  WHERE payment_type IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- invoices
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                 BIGSERIAL     PRIMARY KEY,
  company_id         INTEGER       NOT NULL DEFAULT 1,
  customer_id        BIGINT,
  invoice_number     TEXT          NOT NULL,
  invoice_date       DATE          NOT NULL,
  due_date           DATE,
  currency           bank_currency NOT NULL DEFAULT 'VES',
  amount_total       NUMERIC(15,4) NOT NULL,
  amount_paid        NUMERIC(15,4) NOT NULL DEFAULT 0,
  amount_pending     NUMERIC(15,4) GENERATED ALWAYS AS
                       (amount_total - amount_paid) STORED,
  expected_reference TEXT,
  source_type        TEXT,
  source_id          TEXT,
  status             TEXT          NOT NULL DEFAULT 'PENDING',
  notes              TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_number
    UNIQUE (company_id, invoice_number),
  CONSTRAINT chk_total
    CHECK (amount_total > 0),
  CONSTRAINT chk_paid
    CHECK (amount_paid >= 0 AND amount_paid <= amount_total)
);

CREATE INDEX IF NOT EXISTS idx_invoices_pending
  ON invoices (status, due_date)
  WHERE status IN ('PENDING','PARTIAL');

CREATE INDEX IF NOT EXISTS idx_invoices_reference
  ON invoices (expected_reference)
  WHERE expected_reference IS NOT NULL;

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- payment_reconciliations
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_reconciliations (
  id                   BIGSERIAL PRIMARY KEY,
  bank_statement_id    BIGINT    NOT NULL
                         REFERENCES bank_statements(id),
  invoice_id           BIGINT
                         REFERENCES invoices(id),
  status               reconciliation_status NOT NULL,
  match_method         TEXT,
  confidence_pct       NUMERIC(5,2),
  amount_difference    NUMERIC(15,4),
  date_difference_days INTEGER,
  amount_applied       NUMERIC(15,4),
  confirmed_by         INTEGER,
  confirmed_at         TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_statement_recon
    UNIQUE (bank_statement_id)
);

CREATE INDEX IF NOT EXISTS idx_recon_invoice
  ON payment_reconciliations (invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recon_status
  ON payment_reconciliations (status, created_at);

-- ─────────────────────────────────────────────────────
-- run_reconciliation()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_reconciliation(
  p_account_id BIGINT,
  p_from_date  DATE DEFAULT NULL,
  p_to_date    DATE DEFAULT NULL
)
RETURNS TABLE (
  matched_exact INT,
  matched_fuzzy INT,
  unmatched     INT,
  already_done  INT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_exact INT := 0;
  v_fuzzy INT := 0;
  v_none  INT := 0;
  v_done  INT := 0;
  rec     RECORD;
  inv     RECORD;
  v_company_id INTEGER;
  v_apply NUMERIC(15,4);
  v_conf NUMERIC(5,2);
BEGIN
  SELECT company_id INTO v_company_id
  FROM bank_accounts WHERE id = p_account_id;

  FOR rec IN
    SELECT bs.*
    FROM bank_statements bs
    WHERE bs.bank_account_id = p_account_id
      AND bs.tx_type = 'CREDIT'::statement_tx_type
      AND bs.reconciliation_status = 'UNMATCHED'::reconciliation_status
      AND (p_from_date IS NULL OR bs.tx_date >= p_from_date)
      AND (p_to_date   IS NULL OR bs.tx_date <= p_to_date)
      AND NOT EXISTS (
        SELECT 1 FROM payment_reconciliations pr
        WHERE pr.bank_statement_id = bs.id
      )
  LOOP
    SELECT * INTO inv
    FROM invoices
    WHERE company_id = v_company_id
      AND expected_reference = rec.reference_number
      AND status IN ('PENDING','PARTIAL')
    LIMIT 1;

    IF FOUND THEN
      v_apply := LEAST(rec.amount, inv.amount_pending);

      INSERT INTO payment_reconciliations (
        bank_statement_id, invoice_id, status,
        match_method, confidence_pct,
        amount_difference, amount_applied, confirmed_at
      ) VALUES (
        rec.id, inv.id, 'MATCHED'::reconciliation_status,
        'EXACT_REFERENCE', 100.00,
        rec.amount - inv.amount_pending,
        v_apply,
        now()
      );

      UPDATE invoices SET
        amount_paid = amount_paid + v_apply,
        status = CASE
          WHEN amount_paid + v_apply >= amount_total THEN 'PAID'
          WHEN amount_paid + v_apply > 0 THEN 'PARTIAL'
          ELSE status
        END
      WHERE id = inv.id;

      UPDATE bank_statements
        SET reconciliation_status = 'MATCHED'::reconciliation_status
      WHERE id = rec.id;

      v_exact := v_exact + 1;
    END IF;
  END LOOP;

  FOR rec IN
    SELECT bs.*
    FROM bank_statements bs
    WHERE bs.bank_account_id = p_account_id
      AND bs.tx_type = 'CREDIT'::statement_tx_type
      AND bs.reconciliation_status = 'UNMATCHED'::reconciliation_status
      AND (p_from_date IS NULL OR bs.tx_date >= p_from_date)
      AND (p_to_date   IS NULL OR bs.tx_date <= p_to_date)
      AND NOT EXISTS (
        SELECT 1 FROM payment_reconciliations pr
        WHERE pr.bank_statement_id = bs.id
      )
  LOOP
    SELECT * INTO inv
    FROM invoices
    WHERE company_id = v_company_id
      AND status IN ('PENDING','PARTIAL')
      AND ABS(amount_pending - rec.amount)
            / NULLIF(amount_pending, 0) <= 0.02
      AND ABS(invoice_date - rec.tx_date) <= 3
    ORDER BY
      ABS(amount_pending - rec.amount) ASC,
      ABS(invoice_date   - rec.tx_date) ASC
    LIMIT 1;

    IF FOUND THEN
      v_apply := LEAST(rec.amount, inv.amount_pending);
      v_conf := GREATEST(
        100.0
        - (ABS(rec.amount - inv.amount_pending)
           / NULLIF(inv.amount_pending, 0) * 100)
        - (ABS(rec.tx_date - inv.invoice_date) * 5),
        50.0
      );

      INSERT INTO payment_reconciliations (
        bank_statement_id, invoice_id, status,
        match_method, confidence_pct,
        amount_difference, date_difference_days,
        amount_applied
      ) VALUES (
        rec.id, inv.id, 'SUGGESTED'::reconciliation_status,
        'FUZZY_AMOUNT_DATE',
        v_conf,
        rec.amount - inv.amount_pending,
        (rec.tx_date - inv.invoice_date),
        v_apply
      );

      UPDATE bank_statements
        SET reconciliation_status = 'SUGGESTED'::reconciliation_status
      WHERE id = rec.id;

      v_fuzzy := v_fuzzy + 1;
    ELSE
      v_none := v_none + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_exact, v_fuzzy, v_none, v_done;
END;
$$;
