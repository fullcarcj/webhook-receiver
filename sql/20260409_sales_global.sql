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

UPDATE sales_orders SET total_amount_usd = total_usd
WHERE total_amount_usd IS NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'sales_orders' AND c.column_name = 'total_usd'
  );

UPDATE sales_orders SET status = 'pending' WHERE status = 'pending_payment';
UPDATE sales_orders SET status = 'cancelled' WHERE status = 'refunded';

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check CHECK (
  status IN ('pending', 'paid', 'shipped', 'cancelled')
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_usd'
  ) THEN
    ALTER TABLE sales_orders DROP COLUMN total_usd;
  END IF;
END $$;

ALTER TABLE sales_orders ALTER COLUMN total_amount_usd SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_total_amount_usd_positive CHECK (total_amount_usd > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN sales_orders.total_amount_bs IS 'Equivalente en Bs según exchange_rate_bs_per_usd al crear la orden';
COMMENT ON COLUMN sales_orders.payment_method IS 'Medio de cobro registrado en mostrador/ecommerce/redes';
