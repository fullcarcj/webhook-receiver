-- Repara sales_orders.external_order_id cuando las notas de import ML documentan
-- ml_user_id y order_id correctos pero la columna quedó distinta.
-- Formato canónico: ml_user_id-order_id (salesService.importSalesOrderFromMlOrder).
--
-- Idempotente: solo actualiza filas donde el valor canónico difiere del actual.
-- Ejecutar: node scripts/run-sql-file-pg.js sql/20260425_repair_sales_orders_ml_external_from_import_notes.sql

BEGIN;

WITH parsed AS (
  SELECT
    id,
    (regexp_match(
      notes,
      'Import ml_orders ml_user_id=([0-9]+) order_id=([0-9]+)'
    ))[1] AS u,
    (regexp_match(
      notes,
      'Import ml_orders ml_user_id=([0-9]+) order_id=([0-9]+)'
    ))[2] AS o
  FROM sales_orders
  WHERE source = 'mercadolibre'
    AND notes ~ 'Import ml_orders ml_user_id=[0-9]+ order_id=[0-9]+'
),
canon AS (
  SELECT id, u || '-' || o AS canonical
  FROM parsed
  WHERE u IS NOT NULL AND o IS NOT NULL
)
UPDATE sales_orders so
SET external_order_id = c.canonical,
    updated_at        = NOW()
FROM canon c
WHERE so.id = c.id
  AND so.external_order_id IS DISTINCT FROM c.canonical;

COMMIT;
