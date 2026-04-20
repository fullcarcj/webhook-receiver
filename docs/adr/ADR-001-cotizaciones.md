# ADR-001 · Cotizaciones: unificar con `inventario_presupuesto` o crear modelo paralelo

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-18
- **Dueño:** Backend lead (Javier)
- **Auditoría previa:** [ADR-001-auditoria-estructural-2026-04-18.md](./ADR-001-auditoria-estructural-2026-04-18.md)
- **Relacionados:** ADR-004 (naming API), Sprint 1 (migraciones), Sprint 4 (cotización automática)

---

## Contexto

El repo `webhook-receiver` ya tiene un flujo de cotizaciones operativo:

- Endpoint: `GET /api/inbox/quotations` (`src/handlers/inboxQuotationHandler.js`)
- Tablas: `inventario_presupuesto`, `inventario_detallepresupuesto`, etc.
- **Ya existen en esquema (no asumir greenfield):**
  - Migración `sql/20260423_presupuesto_inbox.sql`: columnas `chat_id`, `channel_id`, `created_by`, `updated_at` sobre `inventario_presupuesto`.
  - Columnas de negocio previas: `status` (p. ej. `draft`, `sent`, `borrador`), `fecha_vencimiento`, totales, etc.

Uso actual: _(completar: volumen de registros, % ligados a `chat_id`, reglas de negocio legacy)._

El nuevo módulo unificado de ventas necesita además (donde falte):

- Vínculo claro a `crm_chats` cuando aplique (parte ya cubierta por `chat_id` si la migración está aplicada)
- Estados de flujo alineados con el mockup: p. ej. `approved`, `expired`, `cancelled_by_buyer` (validar contra valores ya usados en código)
- Flag `created_by_bot: boolean` para cotizaciones automáticas
- Items con snapshot de precio y SKU al momento de la cotización
- Auditoría: canal, usuario/bot

La pregunta es: **¿se completa el camino sobre `inventario_presupuesto` (opción A), o se bifurca a `sales_quotes` (opción B)?**

**Importante:** cualquier `ALTER` debe partir de `information_schema` / `docs/SCHEMA_ACTUAL.md`. No ejecutar el SQL de ejemplo sin verificar columnas existentes.

## Opciones

### Opción A · Extender `inventario_presupuesto` (y detalle existente)

**Estado real en repo (referencia):** ya hay `chat_id`, `channel_id`, `status`, `fecha_vencimiento`, etc. La opción A consiste en **añadir solo lo que falte**, por ejemplo:

```sql
-- EJEMPLO: verificar nombres antes de ejecutar. Posibles añadidos:
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS created_by_bot BOOLEAN NOT NULL DEFAULT FALSE;
-- Valores de status nuevos vía CHECK/ENUM solo tras revisar DISTINCT status en BD.
```

**Pros:**

- No duplicar entidad si el inbox ya lee/escribe aquí
- `GET /api/inbox/quotations` evoluciona de forma incremental
- Menor superficie de tablas nuevas

**Contras:**

- Tabla compartida entre “presupuesto inventario” y “cotización venta” → condicionales y nullables
- Cambios de dominio ventas pueden afectar módulo inventario

### Opción B · Crear `sales_quotes` paralela

Nueva tabla dedicada al dominio de ventas (esquema ejemplo en v1 del plan; ajustar tipos y FKs a `docs/SCHEMA_ACTUAL.md`).

`inventario_presupuesto` queda para flujo legacy / interno; el inbox puede unificar lectura con vista o migración posterior.

**Pros:** separación limpia de dominios. **Contras:** dos fuentes de verdad o trabajo de migración/unificación.

### Opción C · Vista unificada sobre ambas

Mantener dos tablas y exponer `v_quotations_unified` para lecturas. **Contras:** deuda de escritura (“¿dónde inserto?”). Solo si A y B son inviables.

## Decisión

**Opción A — Completar la extensión de `inventario_presupuesto`.**

La auditoría estructural del 18 de abril confirmó que:

1. El único código que lee/escribe la tabla es `src/handlers/inboxQuotationHandler.js` (flujo de ventas omnicanal). No hay otros módulos competidores en el repo.
2. Las migraciones `20260423_presupuesto_inbox.sql` y `20260426_inventario_presupuesto_cliente_fk_customers.sql` ya anclaron la tabla al dominio de ventas (`chat_id` → `crm_chats`, `channel_id` → `sales_channels`, `cliente_id` → `customers`). Ese compromiso arquitectónico ya existe.
3. La tabla ya tiene columna `venta_id` (actualmente en NULL al crear) que indica que la conversión a orden estaba prevista en el diseño original.
4. Crear `sales_quotes` paralela introduciría temporalmente dos fuentes de verdad, con riesgo de divergencia durante semanas mientras se migran consumidores.

El único argumento fuerte pro-B era el nombre (`inventario_*` sugiere pertenencia a inventario, no a ventas). Se considera cosmético y se resuelve con una vista alias sin renombrar la tabla física.

## Trigger de revisión

Este ADR se reabre si al ejecutar la auditoría de datos post-migración desde FileMaker se encuentra:

- Registros de `inventario_presupuesto` que NO correspondan a flujo de venta (por ejemplo: presupuestos internos de compras, cotizaciones a proveedores, presupuestos de mantenimiento interno)
- Dependencias de otros módulos (jobs, integraciones, reportes) que asuman que `inventario_presupuesto` es puramente inventario

Si alguna de esas condiciones aparece, revisar la opción con los datos reales y actualizar el ADR antes de continuar Sprint 1.

## Consecuencias

### Inmediatas (Sprint 0 / Sprint 1)

1. **Antes de cualquier migración de Sprint 1, ejecutar las queries pendientes de la auditoría** (`information_schema.columns`, `pg_constraint`, `pg_indexes`) y pegar resultados literales en `docs/adr/ADR-001-auditoria-estructural-2026-04-18.md`. Esto cierra el gap entre evidencia de código y evidencia de schema real.

2. **Migraciones aditivas en Sprint 1** (solo si las columnas no existen ya, usar `IF NOT EXISTS`):

   - `created_by_bot BOOLEAN DEFAULT FALSE` — para distinguir cotizaciones generadas automáticamente
   - `CHECK constraint` sobre `status` con valores canónicos: `draft | sent | approved | expired | cancelled_by_buyer | cancelled_by_operator | converted`
   - Nada más. No agregar columnas que no se usen en Sprint 1.

3. **`venta_id` se mantiene** como campo existente. En Sprint 1-2 no se renombra ni se refuerza su FK; se cablea cuando se implemente la conversión cotización → orden en Sprint 4.

### Mediano plazo (Sprint 4)

4. **Motor de cotización automática (`autoQuoteService`)** escribe en `inventario_presupuesto` con `created_by_bot=true`. No requiere tabla nueva.

5. **Snapshots de items.** La tabla `inventario_detallepresupuesto` actualmente hace JOIN con catálogo vivo. En Sprint 4 se agrega migración complementaria para snapshot de nombre y precio al momento de cotizar:

   ```sql
   ALTER TABLE inventario_detallepresupuesto
     ADD COLUMN IF NOT EXISTS nombre_snapshot VARCHAR(255),
     ADD COLUMN IF NOT EXISTS sku_snapshot VARCHAR(100);
   ```

   Esto protege las cotizaciones de cambios de catálogo posteriores.

### Largo plazo (roadmap, no en los 12 sprints)

6. **Vista alias `v_sales_quotes`.** Si a futuro es cómodo para integraciones o reportes tener un nombre en dominio de ventas, crear vista sin renombrar tabla física:

   ```sql
   CREATE VIEW v_sales_quotes AS
     SELECT * FROM inventario_presupuesto
     WHERE chat_id IS NOT NULL OR channel_id IS NOT NULL;
   ```

   Opcional, no planificado.

7. **Rename físico a `sales_quotes`.** Si más adelante hay consenso de que el nombre legacy estorba, se planifica como migración con aliasing progresivo. No antes de Sprint 6.

### Impacto sobre otros ADRs

- **ADR-004 (naming API):** `GET /api/inbox/quotations` se mantiene como ruta existente. En Sprint 2-3 se agrega alias `GET /api/sales/quotes` apuntando al mismo handler, marcando la ruta vieja como deprecated sin breaking change.

- **ADR-002 (conciliación bancaria):** sin impacto directo. La conciliación enlaza con `sales_orders`, no con cotizaciones.

- **ADR-003 (IA):** sin impacto directo. El motor NLU de Sprint 4 escribe cotizaciones en la tabla decidida aquí.

### Decisiones que quedan abiertas (NO parte de este ADR)

- ¿Se elimina o se mantiene la lectura del catálogo vivo en `inventario_detallepresupuesto` una vez que haya snapshots? → Decisión de Sprint 4.
- ¿Cómo se maneja la transición de estados `sent → approved → converted`? → Parte del Sprint 3 (máquina de estados).
- ¿Qué pasa con cotizaciones legadas sin `chat_id` al migrar FileMaker? → Decisión de la auditoría de datos post-migración.

## Criterio para desempatar si el equipo está dividido

1. ¿`inventario_presupuesto` se usa activamente para algo que no es venta? → Si sí, inclina a **B**.
2. ¿Roadmap divergente (firma digital, aprobaciones internas)? → Inclina a **B**.
3. ¿Volumen grande y acoplado al inbox actual? → Inclina a **A** si el código ya centraliza aquí.
4. Criterio del autor del handler actual: peso alto.

## Notas al implementar

- Antes de cualquier migración: `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventario_presupuesto'`.
- Revisar triggers y `inboxQuotationHandler` para no romper `status` / inserts.
- Documentar en `docs/SCHEMA_ACTUAL.md` qué tabla es fuente de verdad tras la decisión.
