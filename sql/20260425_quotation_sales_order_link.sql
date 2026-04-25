-- Vincula inventario_presupuesto con sales_orders (FK opcional).
-- La cotización le pertenece a la TRANSACCIÓN, no al canal de comunicación.
-- Ejecutar: npm run db:quotation-sales-link
--
-- Regla de negocio:
--   sales_order_id NOT NULL  → cotización anclada a una venta ERP (ML u otro canal).
--   sales_order_id NULL      → cotización "en frío" (lead, WA sin orden, mostrador sin venta).

ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS sales_order_id BIGINT
    REFERENCES sales_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventario_presupuesto_sales_order_id
  ON inventario_presupuesto(sales_order_id)
  WHERE sales_order_id IS NOT NULL;

COMMENT ON COLUMN inventario_presupuesto.sales_order_id IS
  'FK a sales_orders. Permite lookup cross-chat: cualquier chat de la misma transacción ve la cotización. NULL para cotizaciones sin orden asociada.';
