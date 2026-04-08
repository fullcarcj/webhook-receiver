-- Bienvenida automática CRM (Wasender): una vez por chat (wa_welcome_sent_at).
-- Ejecutar: npm run db:crm-wa-welcome

ALTER TABLE crm_chats ADD COLUMN IF NOT EXISTS wa_welcome_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_chats_wa_welcome_sent
  ON crm_chats (wa_welcome_sent_at)
  WHERE wa_welcome_sent_at IS NOT NULL;
