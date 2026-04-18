-- BE-1.3 · Sprint 1 · Extensiones aditivas de inventario_presupuesto
-- Pre-requisito: sql/20260423_presupuesto_inbox.sql (chat_id, channel_id, created_by, updated_at)
-- Idempotente. Ejecutar: npm run db:presupuesto-extensions
--
-- Pre-verificación recomendada antes de aplicar:
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'inventario_presupuesto'
--   ORDER BY ordinal_position;
--
--   SELECT DISTINCT status FROM inventario_presupuesto LIMIT 50;
--   (Verificar que los valores existentes estén dentro del CHECK propuesto)

BEGIN;

-- 1. Columna created_by_bot: distingue cotizaciones generadas por el bot vs vendedor humano
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS created_by_bot BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. CHECK constraint canónico de status.
--    IMPORTANTE: antes de aplicar verificar que no hay valores fuera del set.
--    Si la BD tiene valores como 'borrador', mapear a 'draft' antes de activar el constraint.
--
--    Valores aceptados según el flujo de ventas omnicanal:
--      draft              = en edición (bot o vendedor)
--      sent               = enviada al cliente (cotización activa)
--      approved           = cliente aprobó (pasa a crear sales_order)
--      expired            = venció sin respuesta
--      cancelled_by_buyer = cliente rechazó explícitamente
--      cancelled_by_operator = operador la anuló
--      converted          = ya se creó una sales_order desde esta cotización
ALTER TABLE inventario_presupuesto
  DROP CONSTRAINT IF EXISTS inventario_presupuesto_status_check;

ALTER TABLE inventario_presupuesto
  ADD CONSTRAINT inventario_presupuesto_status_check
  CHECK (status IN (
    'draft',
    'sent',
    'approved',
    'expired',
    'cancelled_by_buyer',
    'cancelled_by_operator',
    'converted'
  ));

-- 3. Índice para consulta frecuente "cotizaciones activas por chat" (usada en JOIN_QUOTE_ACTIVE de inboxService)
CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_chat_status
  ON inventario_presupuesto (chat_id, status)
  WHERE chat_id IS NOT NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (ejecutar manualmente si hace falta revertir)
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS idx_inv_presupuesto_chat_status;
-- ALTER TABLE inventario_presupuesto DROP CONSTRAINT IF EXISTS inventario_presupuesto_status_check;
-- ALTER TABLE inventario_presupuesto DROP COLUMN IF EXISTS created_by_bot;
-- COMMIT;
