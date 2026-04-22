-- Comprobante conciliado contra cotización (sin sales_orders aún).
-- Ejecutar en Postgres después de 20260412_payment_attempts.sql y migraciones previas de payment_attempts.

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS reconciled_quotation_id BIGINT
    REFERENCES inventario_presupuesto(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_attempts_reconciled_quotation
  ON payment_attempts(reconciled_quotation_id)
  WHERE reconciled_quotation_id IS NOT NULL;

COMMENT ON COLUMN payment_attempts.reconciled_quotation_id IS
  'Cotización (inventario_presupuesto) cuyo total en Bs coincide con el comprobante en el mismo chat WA.';
