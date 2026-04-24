-- fbmp_edge — Facebook Marketplace Personal (extensión Chrome en borde)
-- Canal distinto de fb_page (Pages API). No usa FB_PAGE_ACCESS_TOKEN ni fb_psid.
-- Idempotente. Ejecutar: npm run db:fbmp-edge
-- Requiere: 20260502_crm_chats_facebook.sql (fuente del CHECK source_type)

-- 1. Ampliar el CHECK de source_type en crm_chats
ALTER TABLE crm_chats
  DROP CONSTRAINT IF EXISTS chk_crm_chats_source_type;

ALTER TABLE crm_chats
  ADD CONSTRAINT chk_crm_chats_source_type
  CHECK (source_type IN (
    'wa_inbound',
    'ml_question',
    'ml_message',
    'wa_ml_linked',
    'fb_page',
    'fbmp_edge'
  ));

-- 2. Tabla de hilos scrapeados (un registro por conversación de Marketplace)
CREATE TABLE IF NOT EXISTS fbmp_edge_threads (
  id                  BIGSERIAL   PRIMARY KEY,
  external_thread_id  TEXT        NOT NULL,
  participant_name    TEXT,
  participant_fb_id   TEXT,
  chat_id             BIGINT      REFERENCES crm_chats(id) ON DELETE SET NULL,
  customer_id         BIGINT      REFERENCES customers(id) ON DELETE SET NULL,
  last_scraped_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fbmp_edge_thread UNIQUE (external_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_fbmp_threads_chat
  ON fbmp_edge_threads (chat_id)
  WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fbmp_threads_customer
  ON fbmp_edge_threads (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fbmp_threads_scraped
  ON fbmp_edge_threads (last_scraped_at DESC NULLS LAST);

-- 3. Cola de ingest crudo (buffer antes de pasar a crm_messages)
--    dedupe_key: hash estable por mensaje (thread+timestamp+body_prefix), evita
--    duplicados si el MutationObserver dispara o Wasender reintenta el webhook.
CREATE TABLE IF NOT EXISTS fbmp_edge_raw_ingest (
  id              BIGSERIAL   PRIMARY KEY,
  thread_id       BIGINT      REFERENCES fbmp_edge_threads(id) ON DELETE CASCADE,
  direction       TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body            TEXT        NOT NULL,
  dedupe_key      TEXT        NOT NULL,
  occurred_at     TIMESTAMPTZ,
  processed       BOOLEAN     NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  crm_message_id  BIGINT      REFERENCES crm_messages(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fbmp_edge_raw_dedupe UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_fbmp_raw_thread
  ON fbmp_edge_raw_ingest (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fbmp_raw_pending
  ON fbmp_edge_raw_ingest (processed, created_at DESC)
  WHERE processed = FALSE;

-- 4. Cola de salida (ERP → extensión → Facebook)
CREATE TABLE IF NOT EXISTS fbmp_edge_outbox (
  id                  BIGSERIAL   PRIMARY KEY,
  thread_id           BIGINT      NOT NULL REFERENCES fbmp_edge_threads(id) ON DELETE CASCADE,
  body                TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  sent_by             TEXT,
  created_by_user_id  BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_fbmp_outbox_thread_queued
  ON fbmp_edge_outbox (thread_id, status, created_at ASC)
  WHERE status = 'queued';

COMMENT ON TABLE fbmp_edge_threads IS
  'Hilos de Marketplace personal de Facebook scrapeados por la extensión Chrome fbmp_edge. '
  'Aislado de fb_page (Pages API). source_type = fbmp_edge en crm_chats.';

COMMENT ON TABLE fbmp_edge_raw_ingest IS
  'Buffer de mensajes crudos enviados por la extensión Chrome. '
  'Dedupe por dedupe_key antes de promover a crm_messages.';

COMMENT ON TABLE fbmp_edge_outbox IS
  'Cola de mensajes a enviar desde el ERP hacia Facebook vía la extensión Chrome. '
  'La extensión hace polling y simula escritura humana en el DOM.';
