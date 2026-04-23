-- Agrega updated_at a payment_attempts (faltaba en el DDL original)
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
