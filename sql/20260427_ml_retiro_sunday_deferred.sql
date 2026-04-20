-- Tipo B (retiro ML): cola cuando no se envía domingo y se difiere al lunes (slot mañana).
-- Idempotente (IF NOT EXISTS). También se crea en runtime vía ensureSchema en db-postgres.js;
-- este archivo permite aplicar la DDL en despliegues con psql sin depender del arranque del servidor.

CREATE TABLE IF NOT EXISTS ml_retiro_sunday_deferred (
  id BIGSERIAL PRIMARY KEY,
  ml_user_id BIGINT NOT NULL,
  buyer_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  original_slot TEXT NOT NULL,
  target_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT chk_ml_retiro_def_slot CHECK (original_slot IN ('morning','afternoon'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_retiro_def_key
  ON ml_retiro_sunday_deferred (ml_user_id, buyer_id, target_date, order_id);

CREATE INDEX IF NOT EXISTS idx_ml_retiro_def_pending
  ON ml_retiro_sunday_deferred (ml_user_id, target_date) WHERE processed_at IS NULL;
