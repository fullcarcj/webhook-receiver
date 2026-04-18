-- =============================================================
-- Smoke tests · Fix conversation_id (Parte C)
-- Ejecutar contra BD real para verificar el fix de creación.
-- =============================================================

-- Smoke 1 · Confirmar columna y FK intactos
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sales_orders' AND column_name = 'conversation_id';
-- Esperado: bigint, YES

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'sales_orders'::regclass AND conname LIKE '%conversation%';
-- Esperado: FK a crm_chats(id) ON DELETE SET NULL

-- Smoke 2 · Órdenes recientes · columna conversation_id visible
SELECT id, channel_id, conversation_id, created_at
FROM sales_orders
WHERE created_at > NOW() - INTERVAL '2 hours'
ORDER BY created_at DESC
LIMIT 10;
-- Si hay órdenes recientes de tipo WA/manual con chat, deben tener conversation_id poblado.
-- Las ML nuevas lo tendrán si hay crm_chat del buyer en BD.

-- Smoke 3 · Ratio evolución en los últimos 7 días (util para monitorear después del deploy)
SELECT
  DATE(created_at)                                                  AS dia,
  channel_id,
  COUNT(*)                                                          AS total,
  COUNT(conversation_id)                                            AS con_link,
  ROUND((COUNT(conversation_id)::numeric / NULLIF(COUNT(*),0)) * 100, 1) AS pct_con_link
FROM sales_orders
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at), channel_id
ORDER BY dia DESC, channel_id;
-- Día del deploy en adelante: pct_con_link debe subir para channel_id=3 (ML) cuando hay buyer con phone/customer en crm_chats.

-- Smoke 4 · Verificar que órdenes sin conversation_id (NULL) siguen existiendo (sin regresión)
SELECT COUNT(*) AS ordenes_sin_link
FROM sales_orders
WHERE conversation_id IS NULL;
-- Debe devolver número > 0 (las históricas); si devuelve 0 algo raro pasó.

-- Smoke 5 · Verificar lookupMlConversation estrategia 1 (customer_id → crm_chats)
-- ¿Cuántos buyers ML tienen customer vinculado y ese customer tiene chat?
SELECT
  COUNT(DISTINCT mb.buyer_id)                                       AS buyers_ml_total,
  COUNT(DISTINCT c.id)                                              AS buyers_con_customer,
  COUNT(DISTINCT cc.id)                                             AS buyers_con_chat
FROM ml_buyers mb
LEFT JOIN customers c  ON c.id IN (
    SELECT customer_id FROM ml_orders WHERE buyer_id = mb.buyer_id::text LIMIT 1
)
LEFT JOIN crm_chats cc ON cc.customer_id = c.id
LIMIT 1;
-- Orientativo: cuántos buyers ML ya tienen chat en CRM → esos tendrán conversation_id en próximas importaciones.
