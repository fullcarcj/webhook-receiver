# ADR-005 · Catálogo canónico: `products` como fuente de verdad

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-18
- **Dueño:** Tech lead (Javier)
- **Relacionados:** ADR-001 (cotizaciones), Sprint 2-3 (ticket de migración), Sprint 4 (motor de cotización)

---

## Contexto

Durante la auditoría estructural previa al Sprint 1 se encontró que el sistema tiene **tres catálogos de productos con datos activos**:

- **`productos`** (legacy A): ~7120 registros. Catálogo heredado de módulo de ventas/ML, usado por `sales_order_items.product_id`.
- **`inventario_producto`** (legacy B): ~394 registros. Catálogo heredado del módulo de inventario (trae código interno, stock mínimo, etc.), usado por `inventario_detallepresupuesto.producto_id` (FK legacy en BD; el handler de inbox valida contra `products`).
- **`products`** (nuevo canónico): ~7514+ registros. Catálogo moderno con ecosistema alrededor (`product_bundles`, `product_oem_codes`, `product_subcategories`, `product_lots`, `product_prices`).

Las tres tablas representan **el mismo negocio: mercancía vendible**, con distintos formatos históricos.

### La decisión ya estaba tomada en el diseño del schema

El catálogo nuevo `products` fue construido explícitamente como **destino único de consolidación**:

- `products.source` (text) — acepta valores `'productos'`, `'inventario_producto'`, `'manual'`
- `products.source_id` — id en la tabla de origen legacy
- Índice compuesto `(source, source_id)` para consultas de trazabilidad
- Migración SQL: `sql/20260409_inventory_extensions.sql`
- Script ejecutable: `scripts/migrateInventory.js` — vuelca `productos` e `inventario_producto` a `products` con prioridad por SKU + `ON CONFLICT`

**Esto significa:** el diseño original del schema decidió que `products` es el canónico y las dos fuentes legacy son transitorias. Lo que no se ejecutó fue la migración de **consumidores** (tablas que escriben FKs hacia los legacy).

### Dónde quedó la deuda

Las tablas del módulo de ventas **siguen apuntando a los catálogos legacy**:

- `sales_order_items.product_id` → `productos(id)` ON DELETE RESTRICT (migración `sql/20260408_sales_orders.sql`) — datos históricos reales
- `inventario_detallepresupuesto.producto_id` → FK legacy (p. ej. hacia `inventario_producto` en Django) — en entornos auditados, **1 único registro de prueba** (sin histórico que preservar)

Entre las dos fuentes legacy (`productos` e `inventario_producto`) **no existe FK ni tabla puente directa**. El cruce es vía SKU u otra regla de negocio. El mapeo formal vive solo en `products`.

Cada orden nueva que se crea hoy **consolida la dependencia con `productos`**, aumentando el trabajo de migración en el futuro.

## Decisión

**`products` es el catálogo canónico del sistema. `productos` queda en modo legacy solo-lectura para nuevas escrituras.**

Esta decisión formaliza lo que el diseño del schema ya implicaba (con `source`/`source_id` y el script de migración existentes), no inventa una nueva dirección.

### Reglas operativas desde la firma de este ADR

1. **Código nuevo escribe contra `products`.** Ningún `INSERT`, ningún endpoint nuevo debe referenciar `productos.id` ni `inventario_producto.id` directamente.

2. **Código existente que escribe contra legacy** (el endpoint de creación de órdenes actual y, hasta migrar FK, el detalle de presupuesto) se corrige según el calendario de **Consecuencias** (caso especial Sprint 1 + Sprint 2-3).

3. **Lecturas históricas** pueden seguir tocando `productos` hasta que la migración de datos de ventas esté completa. No se prohíbe leer, se prohíbe **escribir** nuevas filas contra catálogo legacy.

4. **El script `scripts/migrateInventory.js`** se considera la autoridad para el mapeo legacy → nuevo. Cualquier duda de correspondencia se resuelve consultando `products.source` + `products.source_id`.

5. **`productos` no se borra** hasta que todas las FKs activas apunten a `products` y no haya código vivo leyendo la tabla legacy. Eso es post-Sprint 6.

## Consecuencias

### Sprint 1 (cabecera presupuesto, sin ítems nuevos por ADR-001)

El bloque de migraciones ADR-001 sobre **`inventario_presupuesto`** (p. ej. `created_by_bot`, CHECK de `status`) **no depende** de tocar el catálogo. Este ADR **no bloquea** esa parte.

### Sprint 1 · caso especial de `inventario_detallepresupuesto`

La tabla `inventario_detallepresupuesto` tiene **1 único registro** que es de prueba, no histórico real. Esto permite una migración simple sin doble escritura:

```sql
BEGIN;

-- Borrar dato de prueba (no hay histórico que preservar)
DELETE FROM inventario_detallepresupuesto;

-- Cambiar FK del catálogo legacy al canónico (verificar nombre real con pg_constraint)
ALTER TABLE inventario_detallepresupuesto
  DROP CONSTRAINT inventario_detallepr_producto_id_af764f79_fk_inventari;

ALTER TABLE inventario_detallepresupuesto
  ALTER COLUMN producto_id DROP NOT NULL;

ALTER TABLE inventario_detallepresupuesto
  ADD CONSTRAINT inventario_detallepresupuesto_product_id_fkey
  FOREIGN KEY (producto_id) REFERENCES products(id) ON DELETE RESTRICT;

-- Alinear estructura con sales_order_items para facilitar conversión cotización→orden
ALTER TABLE inventario_detallepresupuesto
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS unit_price_usd numeric,
  ADD COLUMN IF NOT EXISTS line_total_usd numeric;

COMMIT;
```

Resultado: `inventario_detallepresupuesto` queda alineada con el patrón de líneas de venta (`product_id` + `sku` + `*_usd`), simplificando la conversión futura de cotización a orden.

**Nota:** el nombre de columna **`producto_id` se mantiene** (no se renombra a `product_id`) para no romper el código que escribe hoy. El rename queda en roadmap.

**Nota:** el nombre del `DROP CONSTRAINT` es **ejemplo Django**; obtener el real con `pg_constraint` antes de ejecutar.

### Sprint 2 o 3 · migración de `sales_order_items` (con doble escritura)

A diferencia de `inventario_detallepresupuesto`, esta tabla tiene **datos históricos reales** que no pueden perderse. La migración requiere ceremonia.

Ticket obligatorio con los siguientes sub-pasos:

1. **Verificar integridad del mapeo**

   ```sql
   -- ¿Todos los product_id usados en sales_order_items tienen contraparte en products?
   SELECT COUNT(*) AS huerfanos
   FROM sales_order_items soi
   WHERE NOT EXISTS (
     SELECT 1 FROM products p
     WHERE p.source = 'productos'
       AND p.source_id = soi.product_id
   );
   ```

   Si `huerfanos > 0`, correr `scripts/migrateInventory.js` antes de continuar.

2. **Agregar columna nueva apuntando a `products`**

   ```sql
   ALTER TABLE sales_order_items
     ADD COLUMN IF NOT EXISTS products_id BIGINT REFERENCES products(id);
   ```

3. **Backfill usando `source` + `source_id`**

   ```sql
   UPDATE sales_order_items soi
   SET products_id = p.id
   FROM products p
   WHERE p.source = 'productos'
     AND p.source_id = soi.product_id
     AND soi.products_id IS NULL;
   ```

4. **Doble escritura temporal** (1-2 semanas): el código que crea órdenes escribe en ambas columnas. Ventana de seguridad.

5. **Cambio de código**: todos los INSERTs nuevos pasan a poblar solo `products_id`. La columna `product_id` (legacy) se deja de escribir.

6. **Deprecación de `product_id`**: después de 2 semanas de doble escritura limpia, `product_id` se marca como deprecated en comentarios de schema. No se borra todavía.

*(Tras el caso especial de Sprint 1, `inventario_detallepresupuesto` ya referencia `products`; no repite el mismo plan de doble escritura salvo evolución futura de columnas.)*

### Sprint 4 (motor de cotización automática)

Cuando el motor NLU+cotización empiece a crear items en `inventario_detallepresupuesto`, **ya apunta a `products`** porque el Sprint 1 alineó el schema. Cero rework de FK.

Los items de cotización siguen el patrón de `sales_order_items`:

- `producto_id` nullable (apunta a `products` — **nombre de columna legacy mantenido**)
- `sku` con snapshot al momento de cotizar
- `unit_price_usd` / `line_total_usd` alineados al modelo de línea

### Roadmap post-Sprint 6

- **Eliminar columna legacy** `product_id` de `sales_order_items` y, si aplica tras migración de nombre, `producto_id` de `inventario_detallepresupuesto`.
- **Drop de `productos`** una vez que no haya código leyéndola.
- **Rename de `inventario_detallepresupuesto` a `sales_quote_items`** si el equipo decide alinear nomenclatura (no urgente).

## Observaciones

- Esta deuda técnica **no fue error de diseño**. El schema estaba pensado correctamente; solo no se ejecutó la migración de consumidores. La decisión de este ADR es **ejecutar lo ya diseñado**, no rediseñar.

- **No se necesita debate abierto sobre qué catálogo gana.** La asimetría de recursos (solo `products` tiene OEM codes, subcategories, bundles, lots, prices) confirma que `products` ganó hace tiempo, aunque las ventas no se enteraron.

- **Prohibir escritura nueva contra `productos` e `inventario_producto`** a partir de la firma, incluso si todavía no se ha migrado lo existente, evita que la deuda crezca mientras se ejecuta la migración.

## Criterios de éxito

- [ ] Ningún código nuevo (Sprints 1-6) escribe `productos.id` ni `inventario_producto.id`
- [ ] Sprint 2-3 completa la migración de `sales_order_items.product_id` → `products.id` con doble escritura
- [ ] Sprint 4 del motor de cotización apunta exclusivamente a `products` en ítems
- [ ] Post-Sprint 6: columna legacy removible sin huérfanos

## Decisiones que quedan abiertas

- ¿En qué momento exacto se elimina `productos`? Depende de si hay reportes externos, dashboards u otros sistemas que la consultan. Se define post-Sprint 6 con inventario de consumidores.
- ¿Hay consumidores externos (otros proyectos que comparten DB, dashboards BI) que leen `productos` hoy? Si sí, coordinar con ellos antes de drop.
- Las tablas `product_bundles`, `product_oem_codes`, etc., ¿están pobladas y en uso, o son esqueleto? Esto afecta la calidad real del catálogo nuevo pero no esta decisión.
