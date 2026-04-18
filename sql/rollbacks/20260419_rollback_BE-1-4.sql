-- Rollback BE-1.4: inventario_detallepresupuesto → products FK
-- Solo ejecutar si la migración 20260419_sprint1_detallepresupuesto_products_fk.sql causa problemas.
-- Tabla estará vacía tras el rollback (el dato de prueba ya fue eliminado en Paso 0).

BEGIN;

-- Eliminar columnas agregadas
ALTER TABLE inventario_detallepresupuesto
  DROP COLUMN IF EXISTS line_total_usd;
ALTER TABLE inventario_detallepresupuesto
  DROP COLUMN IF EXISTS unit_price_usd;
ALTER TABLE inventario_detallepresupuesto
  DROP COLUMN IF EXISTS sku;

-- Eliminar FK hacia products
ALTER TABLE inventario_detallepresupuesto
  DROP CONSTRAINT IF EXISTS inventario_detallepresupuesto_producto_id_fkey;

-- Recrear columna producto_id sin FK (estado previo al backfill manual si necesario)
-- NOTA: la FK original a inventario_producto ya NO se recrea (tabla legacy, no CRM).
--       Si se requiere restituir el constraint original, hacerlo manualmente con el nombre exacto.

COMMIT;
