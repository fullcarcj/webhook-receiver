-- Sprint 6A addendum — estado legacy_archived + acción legacy_archived en log
-- Requiere migraciones AI responder previas (20260411 + 20260420 + 20260420 human_review).
-- Ejecutar: npm run db:ai-responder

-- Recrear CHECK de ai_reply_status incluyendo legacy_archived
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

-- Ampliar action_taken (auditoría bulk archive)
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
