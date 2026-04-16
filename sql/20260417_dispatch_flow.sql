-- Despacho operativo: cola vendedor → almacén → salida física (bin_stock).
-- Requiere: migraciones sales_orders vigentes, public.sales (POS), public.warehouses (WMS).
-- Ejecutar: npm run db:dispatch-flow

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) sales_orders.status — ampliar CHECK (TEXT + chk_sales_orders_status)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  IF to_regclass('public.sales_orders') IS NULL THEN
    RAISE NOTICE 'sales_orders no existe; omitiendo';
    RETURN;
  END IF;

  FOR v_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
    WHERE nsp.nspname = 'public'
      AND cls.relname = 'sales_orders'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS %I', v_constraint);
  END LOOP;

  ALTER TABLE sales_orders
    ADD CONSTRAINT chk_sales_orders_status
    CHECK (status IN (
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
    ));
END $$;

COMMENT ON COLUMN sales_orders.status IS
  'Ciclo venta + despacho: ready_to_ship = solicitud despacho; shipped/dispatched = salida confirmada (según negocio).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) sales (POS) — CHECK de status si no existe; ampliar valores
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.sales') IS NULL THEN
    RAISE NOTICE 'sales no existe; omitiendo';
    RETURN;
  END IF;

  UPDATE sales SET status = upper(trim(status::text)) WHERE status IS NOT NULL;

  ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_status;

  ALTER TABLE sales
    ADD CONSTRAINT chk_sales_status
    CHECK (status IN (
      'PENDING',
      'PAID',
      'READY_TO_SHIP',
      'SHIPPED',
      'CANCELLED',
      'REFUNDED'
    ));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) dispatch_records
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dispatch_records (
  id                BIGSERIAL PRIMARY KEY,
  sale_id           BIGINT NOT NULL,
  sale_table        TEXT NOT NULL
                    CHECK (sale_table IN ('sales', 'sales_orders')),
  channel           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending',
                      'ready_to_ship',
                      'shipped',
                      'cancelled'
                    )),
  requested_by      TEXT,
  requested_at      TIMESTAMPTZ,
  dispatched_by     TEXT,
  dispatched_at     TIMESTAMPTZ,
  notes             TEXT,
  tracking_number   TEXT,
  warehouse_id      BIGINT REFERENCES warehouses (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_sale
  ON dispatch_records (sale_id, sale_table);

CREATE INDEX IF NOT EXISTS idx_dispatch_status
  ON dispatch_records (status);

CREATE INDEX IF NOT EXISTS idx_dispatch_channel
  ON dispatch_records (channel, status);

-- Un solo registro “abierto” por venta (pending o ready_to_ship)
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_open_per_sale
  ON dispatch_records (sale_id, sale_table)
  WHERE status IN ('pending', 'ready_to_ship');

DROP TRIGGER IF EXISTS trg_dispatch_records_updated_at ON dispatch_records;
CREATE TRIGGER trg_dispatch_records_updated_at
  BEFORE UPDATE ON dispatch_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE dispatch_records IS
  'Cola de despacho operativo: vincula sales (POS) u sales_orders (omnicanal) con salida física WMS.';
