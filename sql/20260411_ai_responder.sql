-- AI Auto-Responder — piloto Fase 1 (crm_messages + auditoría)
-- Ejecutar: npm run db:ai-responder

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS ai_reply_status TEXT
    CHECK (ai_reply_status IS NULL OR ai_reply_status IN (
      'pending_ai_reply',
      'pending_receipt_confirm',
      'processing',
      'ai_replied',
      'needs_human_review',
      'human_replied',
      'skipped'
    )),
  ADD COLUMN IF NOT EXISTS ai_confidence    SMALLINT,
  ADD COLUMN IF NOT EXISTS ai_reply_text    TEXT,
  ADD COLUMN IF NOT EXISTS ai_reasoning     TEXT,
  ADD COLUMN IF NOT EXISTS ai_tokens_used   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_provider      TEXT,
  ADD COLUMN IF NOT EXISTS ai_processed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_data     JSONB;

CREATE INDEX IF NOT EXISTS idx_crm_msg_ai_pending
  ON crm_messages(ai_reply_status, created_at ASC)
  WHERE ai_reply_status IN ('pending_ai_reply', 'pending_receipt_confirm');

CREATE INDEX IF NOT EXISTS idx_crm_msg_ai_review
  ON crm_messages(ai_reply_status, created_at DESC)
  WHERE ai_reply_status = 'needs_human_review';

CREATE TABLE IF NOT EXISTS ai_response_log (
  id                BIGSERIAL PRIMARY KEY,
  crm_message_id    BIGINT REFERENCES crm_messages(id) ON DELETE SET NULL,
  customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  chat_id           BIGINT,
  input_text        TEXT,
  receipt_data      JSONB,
  reply_text        TEXT,
  confidence        SMALLINT,
  reasoning         TEXT,
  provider_used     TEXT,
  tokens_used       INT NOT NULL DEFAULT 0,
  action_taken      TEXT NOT NULL
    CHECK (action_taken IN (
      'sent',
      'queued_review',
      'approved_by_human',
      'overridden',
      'skipped_inbound',
      'skipped_disabled',
      'skipped_expired',
      'skipped_empty',
      'error'
    )),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_log_customer
  ON ai_response_log(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_log_action
  ON ai_response_log(action_taken, created_at DESC);

COMMENT ON COLUMN crm_messages.ai_reply_status IS 'Cola respuesta automática IA — worker con FOR UPDATE SKIP LOCKED';
