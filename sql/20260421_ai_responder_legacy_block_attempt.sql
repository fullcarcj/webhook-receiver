-- Sprint 6A addendum — action_taken legacy_archived_block_attempt (intentos bloqueados en API)
-- Requiere migraciones AI responder previas hasta 20260420b.
-- Ejecutar: npm run db:ai-responder

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
    'legacy_archived',
    'legacy_archived_block_attempt'
  ));
