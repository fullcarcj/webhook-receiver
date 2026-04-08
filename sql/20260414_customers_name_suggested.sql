-- Valor opcional de pushName/notify (Wasender/Baileys) por mensaje; no participa en lógica CRM actual.
-- Ejecutar: npm run db:customers-name-suggested

ALTER TABLE customers ADD COLUMN IF NOT EXISTS name_suggested TEXT;

COMMENT ON COLUMN customers.name_suggested IS 'Último pushName/notify WA recibido (solo referencia futura; no usar en resolveCustomer/bienvenida).';
