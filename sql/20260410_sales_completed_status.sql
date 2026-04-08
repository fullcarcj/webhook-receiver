-- Estado "completed" para ventas ML cerradas tras calificación positiva del vendedor (feedback_sale).
-- Ejecutar: npm run db:sales-completed  (o incluido en npm run db:sales-all si añadiste el paso)

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check CHECK (
  status IN ('pending', 'paid', 'shipped', 'cancelled', 'completed')
);

COMMENT ON COLUMN sales_orders.status IS 'ML mercadolibre: completed = calificación positiva del vendedor (feedback_sale) registrada; no listado por defecto en GET /api/sales';
