-- Paso 2 · Tabla bot_actions · log auditable de acciones automáticas del bot
-- Alimenta el "Log de automatización" del mockup (ADR-009).
-- Idempotente. Ejecutar: npm run db:bot-actions

BEGIN;

CREATE TABLE IF NOT EXISTS bot_actions (
  id             BIGSERIAL    PRIMARY KEY,
  chat_id        BIGINT       REFERENCES crm_chats(id)    ON DELETE SET NULL,
  order_id       BIGINT       REFERENCES sales_orders(id) ON DELETE SET NULL,
  action_type    TEXT         NOT NULL,
  input_context  JSONB,
  output_result  JSONB,
  provider       TEXT,
  confidence     NUMERIC(3,2),
  duration_ms    INTEGER,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE bot_actions
  ADD CONSTRAINT bot_actions_action_type_check
  CHECK (action_type IN (
    'message_replied',
    'quote_generated',
    'payment_reminder_sent',
    'receipt_requested',
    'payment_matched',
    'payment_reconciled',
    'order_created',
    'handoff_triggered',
    'exception_raised',
    'manual_review_required'
  ));

CREATE INDEX IF NOT EXISTS idx_bot_actions_chat_id_created_at
  ON bot_actions (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_actions_order_id_created_at
  ON bot_actions (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_actions_type_created_at
  ON bot_actions (action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_actions_correlation_id
  ON bot_actions (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;

-- Rollback: BEGIN; DROP TABLE IF EXISTS bot_actions CASCADE; COMMIT;
