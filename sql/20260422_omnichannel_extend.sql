-- Ferrari ERP — Extensión Omnicanal (Tablas y columnas nuevas)
-- Requiere: 20260410_whatsapp_hub.sql, 20260408_sales_orders.sql,
--           20260422_sales_channels.sql, users.sql
-- Idempotente. Ejecutar: npm run db:omnichannel
--
-- NOTA: conversations → NO se crea. Se extiende crm_chats existente.
--       whatsapp_messages → NO se crea. Usar crm_messages.
--       ml_tokens → NO se crea. Usar ml_accounts.
--       channel_id y seller_id en sales_orders → ya existen (20260422_sales_channels.sql)
--       PKs: BIGSERIAL (no UUID) — consistente con el resto del sistema.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Extender crm_chats con vínculos ML
--    (en lugar de crear tabla conversations paralela)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE crm_chats
  -- Origen del hilo: wa_inbound = solo WA; ml_question = pregunta ML;
  -- ml_message = mensaje post-venta ML; wa_ml_linked = hilo unificado WA+ML
  ADD COLUMN IF NOT EXISTS source_type    TEXT NOT NULL DEFAULT 'wa_inbound'
    CONSTRAINT chk_crm_chats_source_type
    CHECK (source_type IN ('wa_inbound','ml_question','ml_message','wa_ml_linked')),
  -- IDs de MercadoLibre para unificar contexto
  ADD COLUMN IF NOT EXISTS ml_order_id    BIGINT,
  ADD COLUMN IF NOT EXISTS ml_buyer_id    BIGINT,
  ADD COLUMN IF NOT EXISTS ml_question_id BIGINT,
  ADD COLUMN IF NOT EXISTS ml_pack_id     BIGINT,
  -- Estado de identificación del contacto
  ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'unknown'
    CONSTRAINT chk_crm_chats_identity
    CHECK (identity_status IN ('unknown','auto_matched','manual_linked','declared')),
  -- Agente asignado (FK a users)
  ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_chats_ml_order
  ON crm_chats (ml_order_id) WHERE ml_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_chats_ml_buyer
  ON crm_chats (ml_buyer_id) WHERE ml_buyer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_chats_source_type
  ON crm_chats (source_type);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Extender sales_orders — columnas que faltan
--    (channel_id, seller_id, approved_by, approved_at ya existen)
-- ─────────────────────────────────────────────────────────────────────

-- Vincular orden con hilo de CRM (crm_chats, no "conversations")
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS conversation_id BIGINT REFERENCES crm_chats(id) ON DELETE SET NULL;

-- Tipo de despacho — CÓMO se entrega (distinto de fulfillment_status = en qué estado está)
-- CH-01: retiro_tienda | CH-02: envio_propio o retiro_acordado
-- CH-03: mercado_envios | CH-04: envio_propio o retiro_tienda
-- CH-05: entrega_vendedor o desde_bodega
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS fulfillment_type TEXT
    CONSTRAINT chk_so_fulfillment_type
    CHECK (fulfillment_type IN (
      'retiro_tienda','envio_propio',
      'mercado_envios','entrega_vendedor','retiro_acordado','desde_bodega'
    ));

CREATE INDEX IF NOT EXISTS idx_so_conversation
  ON sales_orders (conversation_id) WHERE conversation_id IS NOT NULL;

-- Comentarios de reglas de negocio por canal (documentados aquí, no hardcodeados)
COMMENT ON COLUMN sales_orders.channel_id IS
  'CH 1=MOSTRADOR: payment_status=not_required inmediato. '
  'CH 2=WHATSAPP: pending hasta confirmar Banesco/transferencia. '
  'CH 3=MERCADOLIBRE: pending hasta webhook payment:approved MP. '
  'CH 4=ECOMMERCE: pending hasta webhook pasarela. '
  'CH 5=FUERZA_VENTAS: puede requerir approved_by supervisor.';

COMMENT ON COLUMN sales_orders.fulfillment_type IS
  'HOW se entrega. Complementa fulfillment_status (estado actual del despacho).';

COMMENT ON COLUMN sales_orders.conversation_id IS
  'Hilo CRM (crm_chats) asociado. Principalmente CH-02 y CH-03.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. ml_webhooks_logs — Idempotencia garantizada para webhooks ML
--    ml_event_id UNIQUE es la clave de idempotencia (CH-03)
--    NO reemplaza webhook_events (genérico) ni ml_topic_fetches (trazas GET)
--    ESTE es el log de procesamiento con reintentos y dead-letter
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_webhooks_logs (
  id            BIGSERIAL   PRIMARY KEY,
  ml_user_id    BIGINT,
  ml_event_id   TEXT        NOT NULL,
  topic         TEXT,
  resource_id   TEXT,
  raw_payload   JSONB,
  status        TEXT        NOT NULL DEFAULT 'received'
    CONSTRAINT chk_ml_wh_status
    CHECK (status IN ('received','queued','processing','done','failed','dead_letter')),
  retry_count   INT         NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  CONSTRAINT uq_ml_webhooks_event UNIQUE (ml_event_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_wh_status
  ON ml_webhooks_logs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_wh_user_topic
  ON ml_webhooks_logs (ml_user_id, topic, created_at DESC);

COMMENT ON TABLE ml_webhooks_logs IS
  'Log de webhooks ML con idempotencia por ml_event_id. '
  'Dead-letter: filas con retry_count >= 5 y status=failed.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. ml_sku_mapping — SSOT master_sku ↔ publicación ML
--    master_sku es la Fuente Única de Verdad
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_sku_mapping (
  id                   BIGSERIAL   PRIMARY KEY,
  master_sku           TEXT        NOT NULL,
  seller_custom_field  TEXT        NOT NULL,
  ml_item_id           TEXT,
  ml_user_id           BIGINT,
  sync_status          TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_ml_sku_sync
    CHECK (sync_status IN ('pending','synced','error','paused')),
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ml_sku_seller UNIQUE (master_sku, ml_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_master
  ON ml_sku_mapping (master_sku);

CREATE INDEX IF NOT EXISTS idx_ml_sku_item
  ON ml_sku_mapping (ml_item_id) WHERE ml_item_id IS NOT NULL;

COMMENT ON TABLE ml_sku_mapping IS
  'Mapeo entre master_sku (SSOT) y publicación ML (ml_item_id). '
  'Nunca vincular por ID de BD — siempre por master_sku.';

-- ─────────────────────────────────────────────────────────────────────
-- 5. ml_sync_log — Log ligero de acciones de sincronización
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_sync_log (
  id          BIGSERIAL   PRIMARY KEY,
  entity_type TEXT        NOT NULL,  -- 'order' | 'item' | 'question' | 'message'
  entity_id   TEXT        NOT NULL,
  action      TEXT        NOT NULL,  -- 'import' | 'update' | 'skip' | 'error'
  status      TEXT        NOT NULL,
  ml_user_id  BIGINT,
  error       TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sync_entity
  ON ml_sync_log (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_sync_status
  ON ml_sync_log (status, created_at DESC)
  WHERE status IN ('error', 'skip');

-- ─────────────────────────────────────────────────────────────────────
-- 6. ml_alerts — Alertas operativas del sistema
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_alerts (
  id           BIGSERIAL   PRIMARY KEY,
  alert_type   TEXT        NOT NULL,
  message      TEXT        NOT NULL,
  reference_id TEXT,
  ml_user_id   BIGINT,
  severity     TEXT        NOT NULL DEFAULT 'warning'
    CONSTRAINT chk_ml_alert_severity
    CHECK (severity IN ('info','warning','critical')),
  resolved     BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_alerts_unresolved
  ON ml_alerts (alert_type, created_at DESC)
  WHERE resolved = FALSE;
