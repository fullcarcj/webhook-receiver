-- Vinculación manual extracto Banesco ↔ comprobante WA (bandeja operativa).
-- Ejecutar en Postgres después de bank-reconciliation + payment_attempts.

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS linked_bank_statement_id BIGINT REFERENCES bank_statements(id);

COMMENT ON COLUMN payment_attempts.linked_bank_statement_id IS
  'Movimiento de bank_statements vinculado manualmente desde la bandeja (conciliación).';

CREATE INDEX IF NOT EXISTS idx_payment_attempts_linked_bs
  ON payment_attempts(linked_bank_statement_id)
  WHERE linked_bank_statement_id IS NOT NULL;
