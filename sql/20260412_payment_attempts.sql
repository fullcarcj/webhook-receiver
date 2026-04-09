-- Módulo de Conciliación Automática — Tabla de Comprobantes de Pago
-- Ejecutar ANTES de 20260412_reconciliation_log.sql

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                      BIGSERIAL PRIMARY KEY,
  customer_id             BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  chat_id                 BIGINT REFERENCES crm_chats(id) ON DELETE SET NULL,
  firebase_url            TEXT NOT NULL,

  -- Extraído por GPT-4o Vision
  extracted_reference     TEXT,
  extracted_amount_bs     NUMERIC(14,2),
  extracted_date          DATE,
  extracted_bank          TEXT,
  extracted_payment_type  TEXT
    CHECK (extracted_payment_type IN ('PAGO_MOVIL','TRANSFERENCIA','OTRO')),
  extraction_confidence   NUMERIC(4,2),

  -- Prefiltro visual (sharp)
  is_receipt              BOOLEAN NOT NULL DEFAULT FALSE,
  prefiler_score          NUMERIC(4,2),

  -- Conciliación
  reconciliation_status   TEXT NOT NULL DEFAULT 'pending'
    CHECK (reconciliation_status IN
      ('pending','matched','no_match','manual_review','rejected')),
  reconciled_order_id     BIGINT REFERENCES sales_orders(id),
  reconciled_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pa_status
  ON payment_attempts(reconciliation_status, created_at DESC)
  WHERE reconciliation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pa_reference
  ON payment_attempts(extracted_reference)
  WHERE extracted_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pa_amount
  ON payment_attempts(extracted_amount_bs)
  WHERE extracted_amount_bs IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pa_customer
  ON payment_attempts(customer_id, created_at DESC);

COMMENT ON TABLE payment_attempts IS 'Comprobantes de pago recibidos por WhatsApp — extraídos por GPT-4o Vision y cruzados con bank_statements/sales_orders.';
