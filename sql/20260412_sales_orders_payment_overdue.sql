-- Módulo de Conciliación — Agregar estado 'payment_overdue' a sales_orders.status
-- Se aplica como DO idempotente para no fallar si ya existe.

DO $$
BEGIN
  -- Eliminar constraint existente si usa CHECK (con nombre conocido o sin nombre explícito)
  -- y recrear incluyendo payment_overdue
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'sales_orders'
      AND column_name  = 'status'
  ) THEN
    -- Eliminar constraints de check en status (puede haber varios de revisiones anteriores)
    DECLARE
      v_constraint TEXT;
    BEGIN
      FOR v_constraint IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class cls ON cls.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
        WHERE nsp.nspname = 'public'
          AND cls.relname  = 'sales_orders'
          AND con.contype  = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS %I', v_constraint);
      END LOOP;
    END;

    ALTER TABLE sales_orders
      ADD CONSTRAINT chk_sales_orders_status
      CHECK (status IN (
        'pending','pending_payment','paid','shipped',
        'cancelled','refunded','completed','payment_overdue'
      ));
  END IF;
END $$;

COMMENT ON COLUMN sales_orders.status IS 'Estado del pedido: pending/paid/shipped/cancelled/refunded/completed/payment_overdue';
