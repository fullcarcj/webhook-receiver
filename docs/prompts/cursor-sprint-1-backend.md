# Prompt Cursor · Sprint 1 (backend) — condicional por ADR-001

> **Prompt definitivo Sprint 1** (8 tickets backend + 2 frontend, SQL ejecutable, orden día a día): **[`prompt-sprint-1.md`](./prompt-sprint-1.md)** — usar ese archivo como fuente principal cuando ADR-001, ADR-004 y ADR-005 estén aceptados.

Copiar este documento en Cursor (modo agente) para implementar **Sprint 1** del plan `docs/plan-sprints-v2-ventas-omnicanal.md`. **No ejecutar migraciones sobre cotizaciones hasta tener ADR-001 firmado** (ramas abajo).

---

## Objetivo del sprint

1. Documentar el esquema real: `docs/SCHEMA_ACTUAL.md`.
2. Migraciones **aditivas** mínimas para handoff + bandeja (y cotizaciones **solo según ADR-001**).
3. Endpoints piloto: `POST /api/sales/chats/:id/take-over` y `POST /api/sales/chats/:id/return-to-bot`.
4. Extender `GET /api/inbox/counts` con `exceptions` y `handed_over` (o nombres alineados al plan).

---

## Reglas operacionales (obligatorias)

1. **Nunca** aplicar `ALTER` ciego: comparar con `information_schema` / `\d+ tabla` y con migraciones existentes (`sql/20260423_presupuesto_inbox.sql`, etc.).
2. **ADR-002 no pide cambios de esquema en S1** — conciliación bancaria es Sprint 5.
3. Nuevos endpoints bajo **`/api/sales/...`** según `docs/adr/ADR-004-naming-api.md`; no duplicar rutas ya servidas por `salesApiHandler.js` (p. ej. listado principal es `GET /api/sales`, no renombrar sin alias).
4. Mantener **CORS y auth** igual que el resto de API CRM/ventas (`requireAdminOrPermission`, `applyCrmApiCorsHeaders` donde aplique).
5. Si `crm_messages.type` no admite `system`, **migración aditiva** de enum/tipo antes de insertar mensajes de sistema (puede delegarse al inicio de S2 si S1 solo prepara backend de handoff sin insertar aún).
6. Tests manuales: Postman/Thunder; **cero regresión** en `GET /api/inbox` y `GET /api/sales`.

---

## Ticket BE-1.1 · `docs/SCHEMA_ACTUAL.md`

Auditar y documentar columnas relevantes (lista mínima):

- `crm_chats`, `crm_messages` (tipos de `type` / enum si existe)
- `sales_orders`, `sales_order_items`, `sales_channels`
- `customers`, `ml_orders`
- `inventario_presupuesto` + detalle (y nota de migración `20260423`)
- `bank_statements` (solo lectura; sin cambios en S1)
- Tablas de producto/inventario usadas por cotizaciones

Entregable: un solo markdown claro, sin valores secretos.

---

## Ticket BE-1.2 · Migraciones aditivas

### Siempre (independiente de ADR-001)

- `crm_chats`: `is_exception` BOOLEAN NOT NULL DEFAULT false, `exception_reason` TEXT NULL (si no existen).
- Tabla nueva `bot_handoffs` con **a lo sumo un handoff activo por chat** (UNIQUE parcial o validación en código + constraint razonable).
- Índices necesarios para listar handoffs por `chat_id`.

### Cotizaciones — elegir **una** rama según ADR-001 firmado

#### Rama A — ADR-001 = extender `inventario_presupuesto`

_Solo si el ADR firma A._ Añadir columnas que **falten** tras auditoría (ej. `created_by_bot`), sin duplicar `chat_id` / `status` si ya existen. Incluir comentarios SQL `ADD COLUMN IF NOT EXISTS` donde sea idempotente.

#### Rama B — ADR-001 = `sales_quotes` + ítems

_Solo si el ADR firma B._ Crear tablas `sales_quotes` / `sales_quote_items` (o nombres acordados en ADR) con FKs a `crm_chats`, `customers`, `sales_channels`.

#### Rama bloqueada

Si ADR-001 **no está firmado**: implementar solo la sección “Siempre” y dejar **TODO comentado** o issue enlazado para migración de presupuestos.

---

## Tickets BE-1.3 y BE-1.4 · Handoff

- Montar en **`salesApiHandler.js`** (o subhandler requerido desde `server.js` **sin romper** el orden de rutas existentes):
  - `POST /api/sales/chats/:chatId/take-over`
  - `POST /api/sales/chats/:chatId/return-to-bot`
- Validar permisos (mismo criterio que ventas/crm).
- Persistir en `bot_handoffs` y actualizar estado derivado en `crm_chats` si el plan lo define (ej. flags o join a handoff activo).
- Respuestas JSON coherentes con el front (`src/types/sales.ts` en el repo Next.js cuando exista).

---

## Ticket BE-1.5 · `/api/inbox/counts`

- Extender `getInboxCounts` en `src/services/inboxService.js` (o capa adecuada) con contadores acordados en el plan v2.
- No romper el shape actual: añadir claves nuevas.

---

## Verificación final

- [ ] Migraciones aplican en entorno de prueba sin error
- [ ] Endpoints piloto responden 200/4xx esperados
- [ ] `GET /api/inbox` y `GET /api/inbox/counts` sin regresiones
- [ ] Documentación actualizada

---

## Referencias en repo

- Plan: `docs/plan-sprints-v2-ventas-omnicanal.md`
- ADRs: `docs/adr/ADR-001` … `ADR-004`
- Ventas actuales: `src/handlers/salesApiHandler.js`
- Inbox: `src/services/inboxService.js`, `src/handlers/inboxApiHandler.js`
