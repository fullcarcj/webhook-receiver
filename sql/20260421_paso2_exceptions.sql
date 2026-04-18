-- Paso 2 · Tabla exceptions · casos que requieren revisión humana
-- Reemplaza el placeholder exceptions: 0 de inboxService.js (BE-1.8).
-- Idempotente. Ejecutar: npm run db:exceptions

BEGIN;

CREATE TABLE IF NOT EXISTS exceptions (
  id              BIGSERIAL    PRIMARY KEY,
  entity_type     TEXT         NOT NULL,
  entity_id       BIGINT       NOT NULL,
  reason          TEXT         NOT NULL,
  severity        TEXT         NOT NULL DEFAULT 'medium',
  context         JSONB,
  status          TEXT         NOT NULL DEFAULT 'open',
  resolved_by     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  chat_id         BIGINT       REFERENCES crm_chats(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_entity_type_check;
ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_entity_type_check
  CHECK (entity_type IN ('chat', 'order', 'payment', 'quote', 'product_match'));

ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_severity_check;
ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_severity_check
  CHECK (severity IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE exceptions DROP CONSTRAINT IF EXISTS exceptions_status_check;
ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_status_check
  CHECK (status IN ('open', 'in_progress', 'resolved', 'ignored'));

-- Optimizados para la vista supervisor (Paso 4)
CREATE INDEX IF NOT EXISTS idx_exceptions_open_by_severity
  ON exceptions (severity, created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_exceptions_chat_id
  ON exceptions (chat_id, created_at DESC)
  WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exceptions_entity
  ON exceptions (entity_type, entity_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION exceptions_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exceptions_update_timestamp_trigger ON exceptions;
CREATE TRIGGER exceptions_update_timestamp_trigger
  BEFORE UPDATE ON exceptions
  FOR EACH ROW
  EXECUTE FUNCTION exceptions_update_timestamp();

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS exceptions CASCADE;
-- DROP FUNCTION IF EXISTS exceptions_update_timestamp() CASCADE;
-- COMMIT;
