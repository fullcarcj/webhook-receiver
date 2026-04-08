-- WhatsApp Hub: chats + mensajes + eventos de sesión (tras customer-wallet + crm-solomotor3k + loyalty).
-- Ejecutar: npm run db:whatsapp-hub

CREATE TABLE IF NOT EXISTS crm_chats (
  id                BIGSERIAL PRIMARY KEY,
  customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  phone             TEXT NOT NULL,
  last_message_at   TIMESTAMPTZ,
  last_message_text TEXT,
  last_message_type TEXT DEFAULT 'text',
  unread_count      INT NOT NULL DEFAULT 0,
  needs_followup    BOOLEAN NOT NULL DEFAULT FALSE,
  is_ai_generating  BOOLEAN NOT NULL DEFAULT FALSE,
  wa_session_ok     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_crm_chats_phone UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS idx_crm_chats_customer
  ON crm_chats (customer_id);

CREATE INDEX IF NOT EXISTS idx_crm_chats_updated
  ON crm_chats (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_chats_followup
  ON crm_chats (needs_followup, last_message_at DESC)
  WHERE needs_followup = TRUE;

CREATE TABLE IF NOT EXISTS crm_messages (
  id                  BIGSERIAL PRIMARY KEY,
  chat_id             BIGINT NOT NULL REFERENCES crm_chats(id) ON DELETE CASCADE,
  customer_id         BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  external_message_id TEXT,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type                TEXT NOT NULL DEFAULT 'text',
  content             JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_by             TEXT,
  is_read             BOOLEAN NOT NULL DEFAULT FALSE,
  read_at             TIMESTAMPTZ,
  is_edited           BOOLEAN NOT NULL DEFAULT FALSE,
  is_priority         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_crm_messages_external UNIQUE (external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_messages_chat_time
  ON crm_messages (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_messages_customer
  ON crm_messages (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_messages_external_id
  ON crm_messages (external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_messages_priority
  ON crm_messages (is_priority, created_at DESC)
  WHERE is_priority = TRUE;

CREATE TABLE IF NOT EXISTS crm_system_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_events_type_time
  ON crm_system_events (event_type, created_at DESC);

CREATE OR REPLACE FUNCTION touch_crm_chats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_chats_updated_at ON crm_chats;
CREATE TRIGGER trg_crm_chats_updated_at
  BEFORE UPDATE ON crm_chats
  FOR EACH ROW
  EXECUTE PROCEDURE touch_crm_chats_updated_at();
