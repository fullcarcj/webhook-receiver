-- Vista unificada: ventas POS (tabla sales) + pedidos omnicanal (sales_orders).
-- Prerrequisitos: public.sales, public.sales_orders, public.reconciliation_log.
-- Ejecutar: npm run db:v-sales-unified

-- Alineado con sql/20260411_sales_orders_rate_snapshot.sql (entornos sin migración previa).
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS rate_type TEXT,
  ADD COLUMN IF NOT EXISTS rate_date DATE;

DROP VIEW IF EXISTS v_sales_unified;

CREATE VIEW v_sales_unified AS
SELECT
  'pos-' || s.id::text AS id,
  s.id AS source_id,
  'sales'::text AS source_table,
  'mostrador'::text AS source,
  NULL::text AS external_order_id,
  s.customer_id,
  CASE upper(trim(s.status::text))
    WHEN 'PAID' THEN 'paid'
    WHEN 'PENDING' THEN 'pending'
    WHEN 'CANCELLED' THEN 'cancelled'
    WHEN 'REFUNDED' THEN 'refunded'
    ELSE lower(trim(s.status::text))
  END AS status,
  s.total_usd AS order_total_amount,
  s.total_usd AS total_usd,
  0::integer AS loyalty_points_earned,
  s.notes,
  NULL::text AS sold_by,
  s.created_at,
  NULL::bigint AS reconciled_statement_id,
  s.rate_applied AS exchange_rate_bs_per_usd,
  s.rate_type::text AS rate_type,
  s.igtf_usd,
  s.company_id
FROM sales s

UNION ALL

SELECT
  'so-' || so.id::text AS id,
  so.id AS source_id,
  'sales_orders'::text AS source_table,
  coalesce(so.source, 'desconocido')::text AS source,
  so.external_order_id,
  so.customer_id,
  so.status::text,
  so.order_total_amount,
  so.order_total_amount AS total_usd,
  so.loyalty_points_earned,
  so.notes,
  so.sold_by,
  so.created_at,
  (
    SELECT r.bank_statement_id
    FROM reconciliation_log r
    WHERE r.order_id = so.id
      AND r.bank_statement_id IS NOT NULL
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  ) AS reconciled_statement_id,
  so.exchange_rate_bs_per_usd,
  so.rate_type::text,
  NULL::numeric AS igtf_usd,
  1::integer AS company_id
FROM sales_orders so;

COMMENT ON VIEW v_sales_unified IS 'Unión de sales (POS) y sales_orders (omnicanal) para listados GET /api/sales';
