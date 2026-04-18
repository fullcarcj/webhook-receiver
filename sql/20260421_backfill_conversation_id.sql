-- =============================================================
-- Backfill conversation_id en sales_orders (Parte A)
-- Análisis previo (2026-04-21):
--   173 órdenes sin link (todas channel_id=3 ML)
--   8  con match_claro por customer_id (1 chat único)
--   165 sin ningún chat CRM del mismo customer (correcto → quedan NULL)
-- =============================================================

BEGIN;

-- 1 · Snapshot previo (tabla temporal para rollback limpio)
CREATE TABLE IF NOT EXISTS sales_orders_pre_backfill_20260421 AS
SELECT id, conversation_id FROM sales_orders;

-- 2 · Reporte estado previo
SELECT
  COUNT(*) FILTER (WHERE conversation_id IS NOT NULL) AS con_link_previo,
  COUNT(*) FILTER (WHERE conversation_id IS NULL)     AS sin_link_previo
FROM sales_orders;

-- 3 · Aplicar solo matches claros: customer_id con EXACTAMENTE 1 chat en crm_chats
--     Elegir el chat más reciente en caso de haber varios (por seguridad, aunque
--     la condición filtra exactamente 1).
UPDATE sales_orders so
SET conversation_id = (
  SELECT cc.id
  FROM crm_chats cc
  WHERE cc.customer_id = so.customer_id
  ORDER BY cc.updated_at DESC NULLS LAST, cc.id DESC
  LIMIT 1
)
WHERE so.conversation_id IS NULL
  AND so.customer_id IS NOT NULL
  AND (
    SELECT COUNT(*) FROM crm_chats cc WHERE cc.customer_id = so.customer_id
  ) = 1;

-- 4 · Reporte post-update
SELECT
  COUNT(*) FILTER (WHERE conversation_id IS NOT NULL) AS con_link_ahora,
  COUNT(*) FILTER (WHERE conversation_id IS NULL)     AS sigue_null
FROM sales_orders;

-- 5 · Detalle de las órdenes actualizadas
SELECT so.id AS order_id, so.customer_id, so.conversation_id, so.created_at::date AS order_date
FROM sales_orders so
INNER JOIN sales_orders_pre_backfill_20260421 snap ON snap.id = so.id
WHERE snap.conversation_id IS NULL
  AND so.conversation_id IS NOT NULL
ORDER BY so.id;

COMMIT;

-- =============================================================
-- ROLLBACK (ejecutar solo si algo salió mal):
-- BEGIN;
-- UPDATE sales_orders so
-- SET conversation_id = snap.conversation_id
-- FROM sales_orders_pre_backfill_20260421 snap
-- WHERE so.id = snap.id;
-- COMMIT;
-- DROP TABLE IF EXISTS sales_orders_pre_backfill_20260421;
-- =============================================================
