-- BE-5.0 · Smoke tests · Moneda canónica
-- Ejecutar tras aplicar: npm run db:be50-backfill-ch3 y deployar salesService.js + reconciliationService.js

-- ─────────────────────────────────────────────────────────────────────────────
-- TEST 1 · Backfill CH-3: ratio debe ser 1.0000
-- Verifica que las órdenes ML Venezuela tienen total_amount_bs = order_total_amount
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  channel_id,
  COUNT(*) AS n_total,
  COUNT(total_amount_bs) AS n_con_bs,
  COUNT(*) FILTER (WHERE total_amount_bs IS NULL) AS n_sin_bs,
  ROUND(AVG(total_amount_bs / NULLIF(order_total_amount, 0))::numeric, 4) AS ratio_bs_vs_total
FROM sales_orders
WHERE channel_id = 3
GROUP BY channel_id;
-- ESPERADO: ratio_bs_vs_total = 1.0000, n_sin_bs = 0

-- ─────────────────────────────────────────────────────────────────────────────
-- TEST 2 · CH-3 ya no aparece como candidata del motor
-- Las órdenes ML no deben ser elegibles para conciliación bancaria
-- ─────────────────────────────────────────────────────────────────────────────
SELECT id, channel_id, payment_status, total_amount_bs
FROM sales_orders
WHERE payment_status = 'pending'
  AND channel_id IN (2, 5)
  AND total_amount_bs IS NOT NULL
  AND total_amount_bs > 0
LIMIT 10;
-- ESPERADO: ninguna fila con channel_id = 3
-- (Las órdenes CH-3 tienen payment_status = 'approved' tras webhook ML o
--  quedan fuera del whitelist channel_id IN (2, 5))

-- ─────────────────────────────────────────────────────────────────────────────
-- TEST 3 · Regresión: órdenes CH-3 existentes no fueron afectadas en payment_status
-- El backfill solo tocó total_amount_bs, exchange_rate_bs_per_usd, rate_type
-- ─────────────────────────────────────────────────────────────────────────────
SELECT channel_id, payment_status, COUNT(*) AS n
FROM sales_orders
WHERE channel_id = 3
GROUP BY channel_id, payment_status
ORDER BY payment_status;
-- ESPERADO: distribución igual a la pre-migración
-- (ningún registro con payment_status cambiado inesperadamente)

-- ─────────────────────────────────────────────────────────────────────────────
-- TEST 4 · Crear orden CH-2 de prueba y verificar match (opcional, requiere customer_id real)
-- Descomentar y ajustar <customer_id> antes de ejecutar
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
--
-- INSERT INTO sales_orders (
--   channel_id, payment_status, approval_status, status,
--   order_total_amount, total_amount_bs, exchange_rate_bs_per_usd, rate_type, rate_date,
--   customer_id, source, created_at
-- ) VALUES (
--   2, 'pending', 'not_required', 'pending',
--   100.00, 3450.00, 34.5, 'BCV', CURRENT_DATE,
--   <customer_id_real>, 'manual', NOW()
-- ) RETURNING id;  -- Anotar el id, ej: 999
--
-- INSERT INTO bank_statements (
--   bank, reference_number, amount, tx_date, description, tx_type, reconciliation_status
-- ) VALUES (
--   'banesco', 'SMOKE-BE50-001', 3450.00, CURRENT_DATE, 'Test BE-5.0', 'CREDIT', 'UNMATCHED'
-- ) RETURNING id;  -- Anotar el id
--
-- ROLLBACK;  -- No persistir datos de prueba en producción

-- Post-match (ejecutar después de triggear el motor con los IDs anotados):
-- SELECT rl.*, so.payment_status, so.status, so.approval_status
-- FROM reconciliation_log rl
-- JOIN sales_orders so ON so.id = rl.order_id
-- WHERE rl.order_id = <id_orden_prueba>
-- ORDER BY rl.created_at DESC LIMIT 1;
-- ESPERADO: match_level L1 o L2, so.payment_status = 'approved', so.status = 'paid'

-- ─────────────────────────────────────────────────────────────────────────────
-- TEST 5 · Verificar L3 marca approval_status = 'pending'
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT id, payment_status, approval_status, status
-- FROM sales_orders
-- WHERE approval_status = 'pending'
-- ORDER BY updated_at DESC LIMIT 5;
-- ESPERADO tras un caso L3: payment_status = 'pending', approval_status = 'pending'
