-- Bloque 3 · Fase 0 · Marca temporal de respuesta a pregunta ML (sin nuevo status global)
-- Idempotente. Ejecutar: npm run db:crm-ml-question-answered-at

BEGIN;

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS ml_question_answered_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN crm_chats.ml_question_answered_at IS
  'Momento en que el vendedor envió respuesta vía API ML (/answers). Usado para filtrar '
  'bandeja omnicanal vs vista "preguntas respondidas ML" sin tocar crm_chats.status.';

CREATE INDEX IF NOT EXISTS idx_crm_chats_ml_q_answered
  ON crm_chats (ml_question_answered_at DESC)
  WHERE ml_question_answered_at IS NOT NULL;

COMMIT;
