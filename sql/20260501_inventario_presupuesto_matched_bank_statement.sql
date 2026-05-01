-- Vista unificada: incluye reconciled_statement_id para órdenes social_media CH-2
-- con fallback desde inventario_presupuesto.matched_bank_statement_id.
-- Prerrequisito: 20260417_v_sales_unified.sql, 20260425_quotation_sales_order_link.sql
-- Ejecutar: npm run db:v-sales-unified

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
    WHEN 'PAID'      THEN 'paid'
    WHEN 'PENDING'   THEN 'pending'
    WHEN 'CANCELLED' THEN 'cancelled'
    WHEN 'REFUNDED'  THEN 'refunded'
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
  -- Prioridad 1: reconciliation_log (conciliación bancaria vinculada directamente al pedido).
  -- Prioridad 2: matched_bank_statement_id de la cotización que originó este pedido (CH-2 auto).
  COALESCE(
    (
      SELECT r.bank_statement_id
      FROM reconciliation_log r
      WHERE r.order_id = so.id
        AND r.bank_statement_id IS NOT NULL
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1
    ),
    (
      SELECT ip.matched_bank_statement_id
      FROM inventario_presupuesto ip
      WHERE ip.conversion_document_id = 'SALES_ORDER_' || so.id::text
        AND ip.matched_bank_statement_id IS NOT NULL
      LIMIT 1
    )
  ) AS reconciled_statement_id,
  so.exchange_rate_bs_per_usd,
  so.rate_type::text,
  NULL::numeric AS igtf_usd,
  1::integer AS company_id
FROM sales_orders so;

COMMENT ON VIEW v_sales_unified IS
  'Unión de sales (POS mostrador) y sales_orders (omnicanal). '
  'reconciled_statement_id: reconciliation_log primero; fallback inventario_presupuesto.matched_bank_statement_id para CH-2 automáticas.';
