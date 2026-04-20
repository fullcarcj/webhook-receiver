-- Omnicanal Bloque 1 — estados de conversación + SLA (crm_chats)
-- Idempotente. Comando: node scripts/run-sql-file-pg.js sql/20260420_crm_chats_omnichannel_states.sql
-- IMPORTANTE: requiere columna assigned_to (sql/20260422_omnichannel_extend.sql). Aplicar esa migración antes si aún no existe.

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'UNASSIGNED';

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ NULL;

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMPTZ NULL;

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  ALTER TABLE crm_chats
    ADD CONSTRAINT crm_chats_status_chk
    CHECK (status IN ('UNASSIGNED','PENDING_RESPONSE','ATTENDED','RE_OPENED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE crm_chats c
SET status = 'ATTENDED', last_outbound_at = sub.last_out
FROM (
  SELECT chat_id, MAX(created_at) AS last_out
  FROM crm_messages
  WHERE direction = 'outbound'
  GROUP BY chat_id
) sub
WHERE c.id = sub.chat_id
  AND c.status = 'UNASSIGNED';

UPDATE crm_chats c
SET last_inbound_at = sub.last_in
FROM (
  SELECT chat_id, MAX(created_at) AS last_in
  FROM crm_messages
  WHERE direction = 'inbound'
  GROUP BY chat_id
) sub
WHERE c.id = sub.chat_id;

CREATE INDEX IF NOT EXISTS idx_crm_chats_status_updated
  ON crm_chats (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_chats_assigned_status
  ON crm_chats (assigned_to, status)
  WHERE status = 'PENDING_RESPONSE';

CREATE INDEX IF NOT EXISTS idx_crm_chats_sla_deadline
  ON crm_chats (sla_deadline_at)
  WHERE sla_deadline_at IS NOT NULL;

-- ROLLBACK sugerido (no ejecutar en prod sin backup):
-- DROP INDEX IF EXISTS idx_crm_chats_sla_deadline;
-- DROP INDEX IF EXISTS idx_crm_chats_assigned_status;
-- DROP INDEX IF EXISTS idx_crm_chats_status_updated;
-- ALTER TABLE crm_chats DROP CONSTRAINT IF EXISTS crm_chats_status_chk;
-- ALTER TABLE crm_chats DROP COLUMN IF EXISTS last_inbound_at;
-- ALTER TABLE crm_chats DROP COLUMN IF EXISTS last_outbound_at;
-- ALTER TABLE crm_chats DROP COLUMN IF EXISTS sla_deadline_at;
-- ALTER TABLE crm_chats DROP COLUMN IF EXISTS status;
