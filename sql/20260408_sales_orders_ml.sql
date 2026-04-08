-- Extensión ventas omnicanal: import ML sin doble descuento de stock/caja.
-- Ejecutar tras 20260408_sales_orders.sql (npm run db:sales && npm run db:sales-ml).

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS applies_stock BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS records_cash BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS ml_user_id BIGINT;

COMMENT ON COLUMN sales_orders.applies_stock IS 'Si false (import ML), no se descuenta/repone productos.stock';
COMMENT ON COLUMN sales_orders.records_cash IS 'Si false (import ML), no se registran movimientos en sales_cash_movements';

ALTER TABLE sales_order_items ALTER COLUMN product_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_ml_user ON sales_orders (ml_user_id) WHERE ml_user_id IS NOT NULL;
