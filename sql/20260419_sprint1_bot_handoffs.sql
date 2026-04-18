-- BE-1.5 · Sprint 1 · Tabla bot_handoffs
-- Infraestructura de handoff bot ↔ humano (vendedor toma/devuelve conversación).
-- Pre-requisito: sql/users.sql (tabla users), sql/crm-solomotor3k.sql (crm_chats)
-- Idempotente. Ejecutar: npm run db:bot-handoffs

BEGIN;

CREATE TABLE IF NOT EXISTS bot_handoffs (
  id          BIGSERIAL   PRIMARY KEY,
  chat_id     BIGINT      NOT NULL REFERENCES crm_chats(id) ON DELETE CASCADE,
  from_bot    BOOLEAN     NOT NULL DEFAULT TRUE,
  to_user_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);

-- Solo UN handoff activo por chat a la vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_handoffs_active_unique
  ON bot_handoffs (chat_id)
  WHERE ended_at IS NULL;

-- Auditoría por chat (historial de tomas/devoluciones)
CREATE INDEX IF NOT EXISTS idx_bot_handoffs_chat
  ON bot_handoffs (chat_id, started_at DESC);

-- Buscar chats activos por agente asignado
CREATE INDEX IF NOT EXISTS idx_bot_handoffs_user_active
  ON bot_handoffs (to_user_id, started_at DESC)
  WHERE ended_at IS NULL;

COMMENT ON TABLE bot_handoffs IS
  'Registro de tomas y devoluciones de conversaciones entre bot y vendedores humanos. '
  'ended_at IS NULL = handoff activo. Índice único garantiza un solo handoff activo por chat.';

COMMIT;
