-- BE-5.0 · Backfill total_amount_bs para órdenes CH-3 (ML Venezuela)
-- ML Venezuela guarda order_total_amount en VES nativo.
-- El populate original en importSalesOrderFromMlOrder multiplicó por BCV incorrectamente
-- (totalUsd * rateApplied), produciendo valores ~34x mayores al real.
-- Corrección: total_amount_bs = order_total_amount, rate = 1.
-- Ver ADR-008 regla 5. Idempotente (sobreescribe sin filtro IS NULL a propósito).
-- Ejecutar: npm run db:be50-backfill-ch3

BEGIN;

-- Pre-verificación: muestra cuántas filas tienen ratio incorrecto
-- (dejar comentado y pegar resultado en el PR)
-- SELECT COUNT(*) AS n_con_bug
-- FROM sales_orders
-- WHERE channel_id = 3
--   AND total_amount_bs IS NOT NULL
--   AND order_total_amount IS NOT NULL
--   AND ABS(total_amount_bs - order_total_amount) > 0.01;

UPDATE sales_orders
SET total_amount_bs         = order_total_amount,
    exchange_rate_bs_per_usd = 1,
    rate_date               = COALESCE(rate_date, DATE(created_at)),
    rate_type               = COALESCE(rate_type, 'NATIVE_VES')
WHERE channel_id = 3
  AND order_total_amount IS NOT NULL;

COMMIT;

-- Post-verificación (correr tras aplicar):
-- SELECT channel_id,
--        COUNT(*) AS n,
--        ROUND(AVG(total_amount_bs / NULLIF(order_total_amount, 0))::numeric, 4) AS ratio
-- FROM sales_orders
-- WHERE channel_id = 3
-- GROUP BY channel_id;
-- Debe devolver ratio = 1.0000

-- Rollback (solo si hay problemas):
-- BEGIN;
-- UPDATE sales_orders
-- SET total_amount_bs = NULL, exchange_rate_bs_per_usd = NULL
-- WHERE channel_id = 3;
-- COMMIT;
