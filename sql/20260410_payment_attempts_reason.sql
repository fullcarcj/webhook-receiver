-- Agrega columna prefiler_reason a payment_attempts (motivo del prefiltro visual)
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS prefiler_reason TEXT;

COMMENT ON COLUMN payment_attempts.prefiler_reason IS 'Motivo devuelto por receiptDetector (sharp) al evaluar la imagen';
