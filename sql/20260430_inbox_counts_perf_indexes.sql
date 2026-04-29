-- Índices para acelerar GET /api/inbox/counts (JOIN LATERAL en inboxService.js).
-- Ejecutar: npm run db:inbox-counts-perf
-- Idempotente (IF NOT EXISTS). Sin CONCURRENTLY para compatibilidad con run-sql-file-pg.

-- Último mensaje por chat (JOIN_LAST_MESSAGE: ORDER BY created_at DESC LIMIT 1)
CREATE INDEX IF NOT EXISTS idx_crm_messages_chat_created_id_desc
  ON public.crm_messages (chat_id, created_at DESC, id DESC);

-- Orden activa por conversación (JOIN_ORDER: conversation_id + status + created_at)
CREATE INDEX IF NOT EXISTS idx_sales_orders_conv_status_created
  ON public.sales_orders (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL
    AND status NOT IN ('completed', 'cancelled');

-- Cotizaciones activas por chat (JOIN_QUOTE_ACTIVE / JOIN_QUOTE_WINDOW_START)
CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_chat_status_fecha
  ON public.inventario_presupuesto (chat_id, fecha_creacion DESC)
  WHERE chat_id IS NOT NULL
    AND status NOT IN ('converted', 'expired');

COMMENT ON INDEX idx_crm_messages_chat_created_id_desc IS
  'Bandeja counts / listInbox: último mensaje por chat_id.';
COMMENT ON INDEX idx_sales_orders_conv_status_created IS
  'Bandeja counts: primera orden activa por conversation_id.';
COMMENT ON INDEX idx_inv_presupuesto_chat_status_fecha IS
  'Bandeja counts: cotización activa más reciente por chat_id.';
