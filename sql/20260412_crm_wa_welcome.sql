-- Bienvenida automática CRM (Wasender): una vez por chat (wa_welcome_sent_at).
-- Ejecutar: npm run db:crm-wa-welcome

ALTER TABLE crm_chats ADD COLUMN IF NOT EXISTS wa_welcome_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_chats_wa_welcome_sent
  ON crm_chats (wa_welcome_sent_at)
  WHERE wa_welcome_sent_at IS NOT NULL;

-- Tras pedir nombre (wa_welcome_pending_name = TRUE), al tener nombre válido en customers se envía un saludo con nombre y se pone FALSE.
ALTER TABLE crm_chats ADD COLUMN IF NOT EXISTS wa_welcome_pending_name BOOLEAN NOT NULL DEFAULT FALSE;
