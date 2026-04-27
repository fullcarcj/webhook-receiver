-- Estado "completed" para ventas ML cerradas tras calificación positiva del vendedor (feedback_sale).
-- Ejecutar: npm run db:sales-completed  (o incluido en npm run db:sales-all si añadiste el paso)

-- Misma lista extendida que sql/20260409_sales_global.sql (re-ejecución idempotente sin violar filas).
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_orders_status;

UPDATE sales_orders SET status = 'pending' WHERE status = 'pending_payment';
UPDATE sales_orders SET status = 'cancelled' WHERE status = 'refunded';
UPDATE sales_orders SET status = 'shipped' WHERE status = 'delivered';
UPDATE sales_orders SET status = 'pending'
WHERE status IS NOT NULL
  AND trim(status) <> ''
  AND status NOT IN (
    'pending',
    'pending_payment',
    'pending_cash_approval',
    'paid',
    'ready_to_ship',
    'shipped',
    'dispatched',
    'cancelled',
    'refunded',
    'completed',
    'payment_overdue'
  );

ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check CHECK (
  status IN (
    'pending',
    'pending_payment',
    'pending_cash_approval',
    'paid',
    'ready_to_ship',
    'shipped',
    'dispatched',
    'cancelled',
    'refunded',
    'completed',
    'payment_overdue'
  )
);

COMMENT ON COLUMN sales_orders.status IS 'ML mercadolibre: completed = calificación positiva del vendedor (feedback_sale) registrada; no listado por defecto en GET /api/sales';
