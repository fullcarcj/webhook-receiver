# Auditoría estructural · ADR-001

**Fecha:** 2026-04-18  
**Entorno:** Dev local (sesión sin `DATABASE_URL` para volcados SQL literales)  
**Ejecutor:** Cursor Backend (repo `webhook-receiver`)

Este documento respalda la firma de ADR-001. Las secciones marcadas **PENDIENTE** deben completarse ejecutando las queries en Postgres local antes de la primera migración de Sprint 1.

---

## 1. Schema actual · literales SQL

### `inventario_presupuesto`

**PENDIENTE — pegar resultados literales:**

```sql
SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventario_presupuesto'
ORDER BY ordinal_position;

SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'inventario_presupuesto'::regclass;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'inventario_presupuesto';
```

### Tabla de items

- **Nombre:** `inventario_detallepresupuesto`
- **PENDIENTE — estructura literal** (`information_schema.columns` para esa tabla).

### Evidencia ya verificada sin BD

- Migraciones: `sql/20260423_presupuesto_inbox.sql`, `sql/20260426_inventario_presupuesto_cliente_fk_customers.sql`
- Columnas usadas en `src/handlers/inboxQuotationHandler.js` (INSERT/listados): ver informe en chat / ADR-001.

---

## 2. Relaciones · FKs

**PENDIENTE — pegar salida de:**

```sql
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE (conrelid = 'inventario_presupuesto'::regclass OR confrelid = 'inventario_presupuesto'::regclass)
  AND contype = 'f';
```

**Conocido por migraciones en repo:** `chat_id` → `crm_chats`, `channel_id` → `sales_channels`, `created_by` → `users`, `cliente_id` → `customers`.

---

## 3. Código

- Único módulo que referencia `inventario_presupuesto`: `src/handlers/inboxQuotationHandler.js`
- Status usados en API: `draft`, `sent`, `borrador`; exclusiones: `converted`, `expired`

---

## 4. Vecindario de tablas

**PENDIENTE — pegar lista de:**

```sql
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND (tablename LIKE 'sales_%' OR tablename LIKE 'crm_%' OR tablename LIKE 'ml_%' OR tablename LIKE 'inventario_%');
```

---

## Observaciones

- No hay `CREATE TABLE inventario_presupuesto` en el repo; DDL base es externo (p. ej. legacy Django).
- Completar literales antes de migraciones Sprint 1 cierra el gap entre código y schema real.
