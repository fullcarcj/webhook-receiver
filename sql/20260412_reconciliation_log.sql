-- Módulo de Conciliación Automática — Tabla de Auditoría
-- Ejecutar DESPUÉS de 20260412_payment_attempts.sql

CREATE TABLE IF NOT EXISTS reconciliation_log (
  id                  BIGSERIAL PRIMARY KEY,
  order_id            BIGINT NOT NULL REFERENCES sales_orders(id),
  bank_statement_id   BIGINT REFERENCES bank_statements(id),
  payment_attempt_id  BIGINT REFERENCES payment_attempts(id),
  -- Exactamente uno de los dos debe estar presente
  source              TEXT NOT NULL
    CHECK (source IN ('bank_statement','payment_attempt')),
  match_level         INT NOT NULL CHECK (match_level IN (1,2,3)),
  -- 1=triple match auto | 2=double match auto | 3=revisión manual
  confidence_score    NUMERIC(5,2) NOT NULL,
  amount_order_bs     NUMERIC(14,2) NOT NULL,
  amount_source_bs    NUMERIC(14,2) NOT NULL,
  amount_diff_bs      NUMERIC(14,2) NOT NULL,
  tolerance_used_bs   NUMERIC(8,2) NOT NULL,
  -- 0.05 para bank_statement, 0.01 para payment_attempt
  reference_matched   BOOLEAN NOT NULL DEFAULT FALSE,
  date_matched        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by         TEXT NOT NULL DEFAULT 'system',
  status              TEXT NOT NULL DEFAULT 'auto_matched'
    CHECK (status IN ('auto_matched','manual_review','approved','rejected')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_order
  ON reconciliation_log(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recon_manual
  ON reconciliation_log(status, created_at DESC)
  WHERE status = 'manual_review';

CREATE INDEX IF NOT EXISTS idx_recon_source
  ON reconciliation_log(source, created_at DESC);

COMMENT ON TABLE reconciliation_log IS 'Auditoría de conciliaciones automáticas entre bank_statements/payment_attempts y sales_orders.';
