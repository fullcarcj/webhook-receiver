-- Normalización de teléfonos en identidades y customers (ejecutar ANTES de scripts/deduplicateCustomers.js).
-- npm run db:phone-normalization

UPDATE crm_customer_identities
SET external_id = REGEXP_REPLACE(external_id, '^\+', '')
WHERE source = 'whatsapp'::crm_identity_source
  AND external_id LIKE '+%';

UPDATE crm_customer_identities
SET external_id = '58' || SUBSTRING(external_id FROM 2)
WHERE source = 'whatsapp'::crm_identity_source
  AND external_id ~ '^0[0-9]'
  AND LENGTH(REGEXP_REPLACE(external_id, '\D', '', 'g')) = 11;

UPDATE customers
SET phone = REGEXP_REPLACE(phone, '^\+', '')
WHERE phone IS NOT NULL
  AND phone LIKE '+%';

UPDATE customers
SET phone = '58' || SUBSTRING(phone FROM 2)
WHERE phone IS NOT NULL
  AND phone ~ '^0[0-9]'
  AND LENGTH(REGEXP_REPLACE(phone, '\D', '', 'g')) = 11;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternative_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_email
  ON customers(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_document
  ON customers(id_type, id_number)
  WHERE id_type IS NOT NULL AND id_number IS NOT NULL;
