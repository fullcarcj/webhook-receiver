-- BE-1.4: inventario_detallepresupuesto → products FK + columnas canónicas
-- Decisión: producto_id conserva su nombre (el handler ya hace JOIN products ON p.id = idp.producto_id).
--           Renombrar a product_id es Sprint 4 (requiere actualizar handler y API a la vez).
-- Idempotente. Ejecutar: npm run db:detallepresupuesto-products-fk

BEGIN;

-- Pre-verificación: tabla debe estar vacía tras el borrado del dato de prueba (COUNT = 1 confirmado)
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM inventario_detallepresupuesto) > 0 THEN
    RAISE EXCEPTION
      'inventario_detallepresupuesto no está vacía (% filas). Revisar antes de migrar FK.',
      (SELECT COUNT(*) FROM inventario_detallepresupuesto);
  END IF;
END $$;

-- Paso 1: eliminar dinámicamente cualquier FK Django que producto_id tenga hacia inventario_producto.
--         Mismo patrón que 20260426_inventario_presupuesto_cliente_fk_customers.sql
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
    WHERE n.nspname = 'public'
      AND tbl.relname = 'inventario_detallepresupuesto'
      AND ref.relname = 'inventario_producto'
      AND c.contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.inventario_detallepresupuesto DROP CONSTRAINT %I',
      r.conname
    );
    RAISE NOTICE 'Dropped FK % (inventario_detallepresupuesto.producto_id → inventario_producto)', r.conname;
  END LOOP;
END $$;

-- Paso 2: eliminar también cualquier FK genérica de producto_id que no sea hacia products
--         (por si la BD ya había tenido una FK con nombre distinto al Django estándar).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class tbl ON c.conrelid = tbl.oid
    JOIN pg_namespace n ON tbl.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    JOIN pg_class ref ON c.confrelid = ref.oid
    WHERE n.nspname = 'public'
      AND tbl.relname = 'inventario_detallepresupuesto'
      AND a.attname = 'producto_id'
      AND ref.relname <> 'products'
      AND c.contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.inventario_detallepresupuesto DROP CONSTRAINT %I',
      r.conname
    );
    RAISE NOTICE 'Dropped FK % (no apuntaba a products)', r.conname;
  END LOOP;
END $$;

-- Paso 3: agregar FK producto_id → products si no existe ya.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class tbl ON c.conrelid = tbl.oid
    JOIN pg_class ref ON c.confrelid = ref.oid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE tbl.relname = 'inventario_detallepresupuesto'
      AND ref.relname = 'products'
      AND a.attname = 'producto_id'
      AND c.contype = 'f'
  ) THEN
    ALTER TABLE inventario_detallepresupuesto
      ADD CONSTRAINT inventario_detallepresupuesto_producto_id_fkey
      FOREIGN KEY (producto_id) REFERENCES products(id) ON DELETE RESTRICT;
    RAISE NOTICE 'FK producto_id → products agregada.';
  ELSE
    RAISE NOTICE 'FK producto_id → products ya existía; sin cambios.';
  END IF;
END $$;

-- Paso 4: columnas canónicas (nullable — el handler las popula a partir de Sprint 4).
ALTER TABLE inventario_detallepresupuesto
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS unit_price_usd NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS line_total_usd NUMERIC(12,2);

COMMIT;

-- Rollback documentado (ver sql/rollbacks/20260419_rollback_BE-1-4.sql)

-- Smoke test (correr tras aplicar):
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'inventario_detallepresupuesto'
-- ORDER BY ordinal_position;
-- Debe incluir: sku (nullable), unit_price_usd (nullable), line_total_usd (nullable).
-- FK: SELECT conname, confrelid::regclass
--     FROM pg_constraint
--     WHERE conrelid = 'inventario_detallepresupuesto'::regclass AND contype = 'f';
-- Debe mostrar FK hacia products (no inventario_producto).
