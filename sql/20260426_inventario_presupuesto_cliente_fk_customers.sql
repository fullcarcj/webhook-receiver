-- Reemplaza FK legada Django: cliente_id → auth_user por cliente_id → customers.
-- El POST /api/inbox/quotations valida cliente_id contra la tabla customers (CRM).
-- Idempotente. Ejecutar: npm run db:presupuesto-cliente-fk

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class tbl ON c.conrelid = tbl.oid
    JOIN pg_namespace n ON tbl.relnamespace = n.oid
    JOIN pg_class ref ON c.confrelid = ref.oid
    JOIN pg_namespace rn ON ref.relnamespace = rn.oid
    WHERE n.nspname = 'public'
      AND tbl.relname = 'inventario_presupuesto'
      AND ref.relname = 'auth_user'
      AND c.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.inventario_presupuesto DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped FK % referencing auth_user', r.conname;
  END LOOP;
END $$;

-- Evitar fallo al crear la nueva FK si hay IDs que no existen en customers (solo si la columna admite NULL)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventario_presupuesto'
      AND column_name = 'cliente_id'
      AND is_nullable = 'YES'
  ) THEN
    UPDATE inventario_presupuesto ip
    SET cliente_id = NULL
    WHERE ip.cliente_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = ip.cliente_id);
  END IF;
END $$;

ALTER TABLE inventario_presupuesto
  DROP CONSTRAINT IF EXISTS inventario_presupuesto_cliente_id_baf9f76d_fk_auth_user_id;

ALTER TABLE inventario_presupuesto
  DROP CONSTRAINT IF EXISTS inventario_presupuesto_cliente_id_fkey;

ALTER TABLE inventario_presupuesto
  ADD CONSTRAINT inventario_presupuesto_cliente_id_fkey
  FOREIGN KEY (cliente_id) REFERENCES customers (id) ON DELETE SET NULL;
