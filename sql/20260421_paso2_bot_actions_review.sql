-- Paso 2 · Extensión bot_actions · columnas de revisión por supervisor (BE-2.6 / BE-2.8)
-- Agrega is_reviewed, is_correct, reviewed_by, reviewed_at a bot_actions ya existente.
-- Idempotente. Ejecutar: npm run db:bot-actions-review

BEGIN;

ALTER TABLE bot_actions
  ADD COLUMN IF NOT EXISTS is_reviewed  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_correct   BOOLEAN,
  ADD COLUMN IF NOT EXISTS reviewed_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ;

-- Índice parcial para el contador supervisor backlog (BE-2.8)
CREATE INDEX IF NOT EXISTS idx_bot_actions_unreviewed
  ON bot_actions (created_at DESC)
  WHERE is_reviewed = FALSE;

-- Índice parcial para acciones incorrectas (BE-2.8)
CREATE INDEX IF NOT EXISTS idx_bot_actions_incorrect
  ON bot_actions (created_at DESC)
  WHERE is_correct = FALSE;

COMMENT ON COLUMN bot_actions.is_reviewed IS
  'FALSE = pendiente de revisión por supervisor. TRUE = revisado.';
COMMENT ON COLUMN bot_actions.is_correct IS
  'NULL = no revisado aún. TRUE = supervisor confirmó correcto. FALSE = supervisor marcó como error.';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE bot_actions
--   DROP COLUMN IF EXISTS is_reviewed,
--   DROP COLUMN IF EXISTS is_correct,
--   DROP COLUMN IF EXISTS reviewed_by,
--   DROP COLUMN IF EXISTS reviewed_at;
-- DROP INDEX IF EXISTS idx_bot_actions_unreviewed;
-- DROP INDEX IF EXISTS idx_bot_actions_incorrect;
-- COMMIT;
