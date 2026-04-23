-- Vista por defecto "pipeline ventas": ocultar manualmente hilos de contacto/cotización.
-- Idempotente. Ejecutar: npm run db:crm-sales-default-hidden

BEGIN;

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS sales_default_hidden_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN crm_chats.sales_default_hidden_at IS
  'Si NOT NULL, el hilo no aparece en la lista por defecto con pipeline_default=1 '
  '(contacto no-WA y cotización hasta vencimiento; también oculta antes de tiempo contacto WA). '
  'Orden/pago/despacho ignoran esta columna.';

CREATE INDEX IF NOT EXISTS idx_crm_chats_sales_default_hidden
  ON crm_chats (sales_default_hidden_at)
  WHERE sales_default_hidden_at IS NOT NULL;

COMMIT;
