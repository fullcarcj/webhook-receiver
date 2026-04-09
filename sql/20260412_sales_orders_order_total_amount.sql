-- Renombra sales_orders.total_amount_usd → order_total_amount
-- (total en moneda de la orden: VES/Bs en MLV, USD en otros sitios; no implica conversión a USD.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
  ) THEN
    ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_total_amount_usd_positive;
    ALTER TABLE sales_orders RENAME COLUMN total_amount_usd TO order_total_amount;
    ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_order_total_positive CHECK (order_total_amount > 0);
  END IF;
END $$;

COMMENT ON COLUMN sales_orders.order_total_amount IS 'Total del pedido en moneda de la orden (p. ej. VES en ML Venezuela; alineado con order.total_amount de la API ML).';
