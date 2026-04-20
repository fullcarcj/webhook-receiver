-- Sprint 6A — revisión humana: reject + draft (log) + human_rejected
-- Requiere: 20260411_ai_responder.sql aplicada antes.
-- Ejecutar: npm run db:ai-responder

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS ai_reply_updated_at TIMESTAMPTZ;

-- Recrear CHECK de ai_reply_status incluyendo human_rejected
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'crm_messages'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%ai_reply_status%'
  LOOP
    EXECUTE format('ALTER TABLE crm_messages DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE crm_messages ADD CONSTRAINT crm_messages_ai_reply_status_check
  CHECK (ai_reply_status IS NULL OR ai_reply_status IN (
    'pending_ai_reply',
    'pending_receipt_confirm',
    'processing',
    'ai_replied',
    'needs_human_review',
    'human_replied',
    'human_rejected',
    'legacy_archived',
    'skipped'
  ));

-- Ampliar action_taken en ai_response_log
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'ai_response_log'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%action_taken%'
  LOOP
    EXECUTE format('ALTER TABLE ai_response_log DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE ai_response_log ADD CONSTRAINT ai_response_log_action_taken_check
  CHECK (action_taken IN (
    'sent',
    'queued_review',
    'approved_by_human',
    'overridden',
    'skipped_inbound',
    'skipped_disabled',
    'skipped_expired',
    'skipped_empty',
    'error',
    'rejected',
    'draft_saved',
    'legacy_archived'
  ));
