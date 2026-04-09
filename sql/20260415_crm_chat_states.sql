-- Máquina de estados para onboarding CRM vía WhatsApp.
-- AWAITING_NAME: el siguiente mensaje de texto del teléfono se trata como nombre+apellido real.
-- push_name: nombre de perfil WA del primer mensaje (fuente para name_suggested).
-- trigger_message_id: messageId del webhook que creó el estado; evita que un webhook duplicado
--   sobre ese mismo mensaje sea tratado como "nombre enviado" en un segundo procesamiento.
-- Ejecutar: npm run db:crm-chat-states

CREATE TABLE IF NOT EXISTS crm_chat_states (
  id                 SERIAL      PRIMARY KEY,
  phone              TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'AWAITING_NAME',
  push_name          TEXT,
  trigger_message_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_chat_states_phone_uq UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS idx_crm_chat_states_phone ON crm_chat_states (phone);
