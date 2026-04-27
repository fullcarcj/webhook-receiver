-- Ventas globales omnicanal (v2): estados, montos USD/Bs, método de pago, CRM identities extendidas.
-- Prerrequisitos: sql/20260408_sales_orders.sql, sql/20260408_sales_orders_ml.sql, sql/crm-solomotor3k.sql
-- Ejecutar: npm run db:sales-global

DO $$ BEGIN
  ALTER TYPE crm_identity_source ADD VALUE 'ecommerce';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE crm_identity_source ADD VALUE 'social_media';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS total_amount_usd NUMERIC(12, 2);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS total_amount_bs NUMERIC(14, 2);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS exchange_rate_bs_per_usd NUMERIC(14, 6);

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS payment_method TEXT;

-- Copia legacy total_usd → total_amount_usd. Usar EXECUTE: en PL/pgSQL el cuerpo se compila
-- entero; un UPDATE estático que nombra total_usd falla si esa columna ya no existe aunque el IF sea falso.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_usd'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
  ) THEN
    EXECUTE $dyn$
      UPDATE sales_orders SET total_amount_usd = total_usd WHERE total_amount_usd IS NULL
    $dyn$;
  END IF;
END $$;

-- Sin total_usd pero con order_total_amount (rename 20260412 aplicado antes que este script):
-- rellenar total_amount_usd huérfano para poder cumplir NOT NULL abajo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'order_total_amount'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_usd'
  ) THEN
    EXECUTE $dyn$
      UPDATE sales_orders
      SET total_amount_usd = order_total_amount
      WHERE total_amount_usd IS NULL AND order_total_amount IS NOT NULL
    $dyn$;
  END IF;
END $$;

UPDATE sales_orders SET status = 'pending' WHERE status = 'pending_payment';
UPDATE sales_orders SET status = 'cancelled' WHERE status = 'refunded';
UPDATE sales_orders SET status = 'shipped' WHERE status = 'delivered';

-- Valores que no entran en el CHECK (p. ej. typos o estados viejos) → pending (idempotente).
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

-- Re-ejecución: misma lista que sql/20260417_dispatch_flow.sql (chk_sales_orders_status) para no
-- romper filas con ready_to_ship / dispatched / pending_cash_approval si dispatch-flow corrió antes.
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_orders_status;

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_usd'
  ) THEN
    EXECUTE 'ALTER TABLE sales_orders DROP COLUMN total_usd';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
  ) THEN
    ALTER TABLE sales_orders ALTER COLUMN total_amount_usd SET NOT NULL;
  END IF;
EXCEPTION
  WHEN not_null_violation THEN
    RAISE NOTICE 'sales_global: total_amount_usd queda nullable (hay filas con NULL)';
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
  ) THEN
    ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_total_amount_usd_positive CHECK (total_amount_usd > 0);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN sales_orders.total_amount_bs IS 'Equivalente en Bs según exchange_rate_bs_per_usd al crear la orden';
COMMENT ON COLUMN sales_orders.payment_method IS 'Medio de cobro registrado en mostrador/ecommerce/redes';
