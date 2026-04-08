-- Segundo teléfono en customers (alineado con ml_buyers.phone_2). Ejecutar: npm run db:customers-phone2

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_2 TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_phone_2
  ON customers (phone_2)
  WHERE phone_2 IS NOT NULL;

COMMENT ON COLUMN customers.phone IS 'Teléfono principal (p. ej. ML phone_1)';
COMMENT ON COLUMN customers.phone_2 IS 'Teléfono secundario (p. ej. ML phone_2)';
