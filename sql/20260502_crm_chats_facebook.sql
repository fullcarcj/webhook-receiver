-- Ferrari ERP — Soporte Facebook Messenger (Pages API)
-- Extiende crm_chats con: nuevo valor 'fb_page' en source_type + columna fb_psid.
-- Idempotente. Ejecutar: npm run db:facebook
-- Requiere: 20260422_omnichannel_extend.sql (fuente del CHECK original).

-- 1. Eliminar el CHECK viejo y reemplazarlo incluyendo 'fb_page'
ALTER TABLE crm_chats
  DROP CONSTRAINT IF EXISTS chk_crm_chats_source_type;

ALTER TABLE crm_chats
  ADD CONSTRAINT chk_crm_chats_source_type
  CHECK (source_type IN (
    'wa_inbound',
    'ml_question',
    'ml_message',
    'wa_ml_linked',
    'fb_page'
  ));

-- 2. Page-Scoped User ID de Meta (PSID): identificador externo del hilo FB
ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS fb_psid TEXT;

-- Índice único parcial: un solo hilo por PSID
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_chats_fb_psid
  ON crm_chats (fb_psid)
  WHERE fb_psid IS NOT NULL;

-- 3. Tabla de webhooks Meta (idempotencia por mid de Meta)
CREATE TABLE IF NOT EXISTS fb_webhook_events (
  id          BIGSERIAL   PRIMARY KEY,
  mid         TEXT        NOT NULL,
  page_id     TEXT,
  psid        TEXT,
  raw_payload JSONB,
  status      TEXT        NOT NULL DEFAULT 'received'
    CONSTRAINT chk_fb_wh_status
    CHECK (status IN ('received','processed','skipped','error')),
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT uq_fb_webhook_mid UNIQUE (mid)
);

CREATE INDEX IF NOT EXISTS idx_fb_wh_status
  ON fb_webhook_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fb_wh_psid
  ON fb_webhook_events (psid)
  WHERE psid IS NOT NULL;

COMMENT ON TABLE fb_webhook_events IS
  'Log de webhooks Facebook Messenger con idempotencia por mid. '
  'Equivalente a ml_webhooks_logs para el canal FB.';
