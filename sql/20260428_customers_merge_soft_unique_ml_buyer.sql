-- Columnas de auditoría para merge soft (cliente duplicado desactivado, no borrado).
-- El índice único parcial `uq_customers_primary_ml_buyer_active` lo crea el script
-- `npm run merge:customers-ml-buyer-dupes` al finalizar fusiones (evita fallar si aún hay duplicados).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS merged_into_customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

COMMENT ON COLUMN customers.merged_into_customer_id IS 'Cliente canónico tras merge soft-delete; la fila queda is_active=false.';
COMMENT ON COLUMN customers.merged_at IS 'Instante del merge soft (auditoría).';
