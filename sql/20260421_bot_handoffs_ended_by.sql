-- Migración aditiva · bot_handoffs.ended_by (D2 · ADR-009)
-- Agrega columna para registrar qué usuario devolvió la conversación al bot.
-- Idempotente. Ejecutar: npm run db:bot-handoffs-ended-by

BEGIN;

ALTER TABLE bot_handoffs
  ADD COLUMN IF NOT EXISTS ended_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN bot_handoffs.ended_by IS
  'ID del usuario que ejecutó return-to-bot. NULL si el handoff terminó por SLA o sistema.';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE bot_handoffs DROP COLUMN IF EXISTS ended_by;
-- COMMIT;
