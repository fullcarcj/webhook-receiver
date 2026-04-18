-- Paso 5 · Smoke tests · endpoints supervisor
-- Sin migraciones DDL. Validar contratos contra datos reales.

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 1 · KPIs · contadores manuales vs salida del endpoint
-- Comparar con: GET /api/sales/supervisor/kpis
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  -- bot_resolved.count_today
  COUNT(*) FILTER (
    WHERE so.status IN ('paid','completed')
      AND so.payment_status = 'approved'
      AND DATE(so.updated_at) = CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM exceptions ex
        WHERE ex.entity_type = 'order' AND ex.entity_id = so.id AND ex.status != 'ignored'
      )
  )::int                                                                     AS bot_resolved_today,
  -- bot_resolved.count_total_today
  COUNT(*) FILTER (WHERE DATE(so.updated_at) = CURRENT_DATE)::int             AS total_today,
  -- waiting_buyer.by_stage.payment
  COUNT(*) FILTER (
    WHERE so.status = 'pending' AND so.payment_status = 'pending'
  )::int                                                                     AS waiting_payment,
  -- waiting_buyer.by_stage.delivery
  COUNT(*) FILTER (
    WHERE so.status = 'paid' AND so.fulfillment_status = 'pending'
  )::int                                                                     AS waiting_delivery,
  -- closed_today.count
  COUNT(*) FILTER (
    WHERE DATE(so.updated_at) = CURRENT_DATE
      AND so.status IN ('paid','completed')
      AND so.payment_status = 'approved'
  )::int                                                                     AS closed_today,
  -- closed_today.amount_usd (agregado)
  ROUND(COALESCE(SUM(so.order_total_amount) FILTER (
    WHERE DATE(so.updated_at) = CURRENT_DATE
      AND so.status IN ('paid','completed')
      AND so.payment_status = 'approved'
  ), 0))::int                                                                AS closed_amount_usd
FROM sales_orders so;

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 2 · Waiting · preview de los 5 primeros items del endpoint
-- Comparar con: GET /api/sales/supervisor/waiting
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  so.id                  AS order_id,
  c.full_name            AS customer_name,
  so.order_total_amount  AS amount,
  so.updated_at          AS since,
  CASE
    WHEN so.status = 'pending' AND so.payment_status = 'pending' THEN 'payment'
    WHEN so.status = 'paid'    AND so.fulfillment_status = 'pending' THEN 'delivery'
    ELSE NULL
  END                    AS stage_reason
FROM sales_orders so
LEFT JOIN customers c ON c.id = so.customer_id
WHERE so.status IN ('pending','paid')
  AND (
    (so.status = 'pending' AND so.payment_status = 'pending')
    OR (so.status = 'paid' AND so.fulfillment_status = 'pending')
  )
ORDER BY so.updated_at DESC
LIMIT 5;

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 3 · Exceptions · solo status='open' aparecen en supervisor
-- Comparar con: GET /api/sales/supervisor/exceptions
-- ─────────────────────────────────────────────────────────────────────────────
SELECT id, entity_type, entity_id, reason, severity, status, created_at
FROM exceptions
WHERE status = 'open'
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high'     THEN 2
    WHEN 'medium'   THEN 3
    ELSE 4
  END,
  created_at DESC
LIMIT 5;

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 4 · Tests HTTP (ejecutar manualmente)
-- ─────────────────────────────────────────────────────────────────────────────
-- curl -H "X-Admin-Secret: $ADMIN_SECRET" http://localhost:3000/api/sales/supervisor/kpis | jq .
-- curl -H "X-Admin-Secret: $ADMIN_SECRET" http://localhost:3000/api/sales/supervisor/waiting | jq .
-- curl -H "X-Admin-Secret: $ADMIN_SECRET" http://localhost:3000/api/sales/supervisor/exceptions | jq .
--
-- Verificar:
--   - /kpis devuelve { bot_resolved, waiting_buyer, exceptions, closed_today }
--   - /waiting devuelve array (puede ser vacío)
--   - /exceptions devuelve array (puede ser vacío)
--   - Sin auth → 401/403
