-- Auditoría post-migración: sql/20260422_omnichannel_extend.sql
-- Ejecutar con: node scripts/run-omnichannel-audit.js
--    o: psql $DATABASE_URL -f sql/20260422_omnichannel_audit.sql (solo si el cliente ejecuta múltiples statements)

-- ═══ QUERY 1 — Columnas nuevas en crm_chats (omnicanal) ═══
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'crm_chats'
  AND column_name IN (
    'source_type', 'ml_order_id', 'ml_buyer_id', 'ml_question_id',
    'ml_pack_id', 'identity_status', 'assigned_to'
  )
ORDER BY column_name;

-- ═══ QUERY 2 — Columnas omnicanal en sales_orders ═══
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'sales_orders'
  AND column_name IN (
    'conversation_id', 'fulfillment_type', 'channel_id', 'seller_id',
    'approved_by', 'approved_at', 'payment_status', 'fulfillment_status', 'approval_status'
  )
ORDER BY column_name;

-- ═══ QUERY 3 — Tablas nuevas + órdenes (totales / channel_id nulo) ═══
SELECT 'ml_webhooks_logs' AS metric, count(*)::bigint AS n FROM ml_webhooks_logs
UNION ALL SELECT 'ml_sku_mapping', count(*)::bigint FROM ml_sku_mapping
UNION ALL SELECT 'ml_sync_log', count(*)::bigint FROM ml_sync_log
UNION ALL SELECT 'ml_alerts', count(*)::bigint FROM ml_alerts
UNION ALL SELECT 'sales_orders_total', count(*)::bigint FROM sales_orders
UNION ALL SELECT 'sales_orders_channel_id_null', count(*)::bigint FROM sales_orders WHERE channel_id IS NULL
UNION ALL
SELECT 'sales_orders_by_channel_' || coalesce(channel_id::text, 'null'), count(*)::bigint
FROM sales_orders
GROUP BY channel_id;

-- ═══ QUERY 4 — Índices relevantes (nuevas tablas + extensiones) ═══
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'ml_webhooks_logs', 'ml_sku_mapping', 'ml_sync_log', 'ml_alerts',
    'crm_chats', 'sales_orders'
  )
  AND (
    indexname LIKE 'idx_ml_%'
    OR indexname LIKE 'idx_crm_chats_ml%'
    OR indexname LIKE 'idx_crm_chats_source%'
    OR indexname LIKE 'idx_so_%'
  )
ORDER BY tablename, indexname;

-- ═══ QUERY 5 — Restricciones UNIQUE / CHECK clave (idempotencia + FK chat) ═══
SELECT c.conrelid::regclass::text AS rel_table,
       c.conname,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = 'public'
  AND c.conrelid::regclass::text IN (
    'ml_webhooks_logs', 'ml_sku_mapping', 'sales_orders', 'crm_chats'
  )
  AND c.contype IN ('u', 'f', 'c')
ORDER BY 1, c.conname;

-- ═══ QUERY 6 — Catálogo sales_channels (FK de sales_orders.channel_id) ═══
SELECT id, code, name, is_active
FROM sales_channels
ORDER BY id;
