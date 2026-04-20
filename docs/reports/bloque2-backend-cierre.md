# Bloque 2 Backend · Reporte de cierre

**Fecha:** 2026-04-20  
**Sprint:** Sprint 2 — Bandeja pulida + handoff bot↔humano  
**Estado:** Completado (sin STOP AND REPORT pendientes)

---

## PRE-0 · Grep de fantasmas (resultados)

```
grep -rn "handoff-status" src/ server.js scripts/
→ src/handlers/salesApiHandler.js:849  (solo definición del endpoint)
→ NINGÚN consumidor fuera del handler

grep -rn "supervisor/exceptions" src/ server.js scripts/
→ src/handlers/salesApiHandler.js:841  (definición)
→ docs/prompts/prompt-dashboard-observacion.md:13
  useSupervisorExceptions.ts → fetch /api/ventas/supervisor/exceptions
```

**Decisión:**
- `handoff-status` → **Caso B** (ningún consumidor activo). Deprecado con `logger.warn`.
- `supervisor/exceptions` → **Caso A** (consumido por frontend en `prompt-dashboard-observacion.md`). Adoptado y documentado en ADR-009.

**Nota:** el frontend referencia `/api/ventas/supervisor/exceptions` pero el backend expone `/api/sales/supervisor/exceptions`. Verificar que el proxy/BFF mapee correctamente.

---

## Tarea 1 · ADR-009

**Archivo creado:** `docs/adr/ADR-009-handoff-bot-humano-acoplamiento.md`

Documenta:
- Decisión de acoplar `bot_handoffs` ↔ `crmChatStateMachine` en una sola transacción (D2).
- Extensión de `transition(TAKE)` para aceptar `ATTENDED` como origen válido.
- Semántica de `return-to-bot`: solo desde `PENDING_RESPONSE`, cualquier vendedor puede devolver.
- Endpoints adoptados (`supervisor/exceptions`) y deprecados (`handoff-status`).
- Resuelve referencia huérfana del comentario SQL de `bot_actions` que citaba "ADR-009" sin archivo.

---

## Tarea 2 · bot_actions service + handlers

### Archivos modificados
- `src/services/botActionsService.js`
  - Corregido comentario de ADR-009 con path real del archivo.
  - Agregada función `listUnreviewed({ limit, since })` → acciones `is_reviewed = FALSE` en las últimas 48h.

### Rutas registradas (dentro de `handleSalesApiRequest`)
```
GET  /api/sales/chats/:chatId/bot-actions
     Filtros: action_type, reviewed, since, limit, offset
     Auth: requireAdminOrPermission("ventas")

GET  /api/sales/bot-actions
     Filtros existentes: chat_id, order_id, reviewed, since, action_type, limit, offset
     (ruta preexistente, solo documentada aquí)
```

### Curls de prueba
```bash
# Listar acciones de un chat
curl -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/sales/chats/1/bot-actions?limit=10'

# Revisar una acción
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isCorrect":false,"note":"el bot envió precio desactualizado"}' \
  'http://localhost:3000/api/sales/bot-actions/42/review'
```

---

## Tarea 3 · exceptions service + handlers + EXCEPTION_CODES.md

### Archivos modificados / creados
- `src/services/exceptionsService.js`
  - Agregada `getActiveExceptionForChat(chatId)` → devuelve la excepción `open` más reciente para un chat.
  - Agregado alias `openException = raise` para compatibilidad con spec BE-2.2.
- `docs/EXCEPTION_CODES.md` — creado con catálogo completo de 7 códigos derivados de `supervisorService.KIND_MAPPING`.

### Rutas registradas
```
GET   /api/sales/exceptions          ?status, limit, offset
PATCH /api/sales/exceptions/:id/resolve
POST  /api/sales/exceptions          (nueva · crear excepción manual desde UI)
```

**Nota sobre CHECK constraint:** la columna `reason` en `exceptions` no tiene CHECK constraint. El catálogo canónico vive en `docs/EXCEPTION_CODES.md` y en `supervisorService.KIND_MAPPING`. Se decidió no agregar CHECK para flexibilidad del bot al registrar razones nuevas sin migración.

### Curls de prueba
```bash
# Listar excepciones abiertas
curl -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/sales/exceptions?status=open'

# Crear excepción manual
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_type":"order","entity_id":123,"reason":"payment_no_match","severity":"medium"}' \
  'http://localhost:3000/api/sales/exceptions'

# Resolver
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resolution_note":"Match confirmado manualmente"}' \
  'http://localhost:3000/api/sales/exceptions/5/resolve'
```

---

## Tarea 4 · inbox extendido (LEFT JOIN LATERAL + top_exception_code)

### Archivo modificado
- `src/services/inboxService.js` (`listInbox`)

### Snippet del JOIN LATERAL ya presente + nueva columna
```sql
EXISTS (
  SELECT 1 FROM exceptions ex
  WHERE ex.chat_id = cc.id AND ex.status = 'open'
) AS has_active_exception,
(
  SELECT ex2.reason FROM exceptions ex2
  WHERE ex2.chat_id = cc.id AND ex2.status = 'open'
  ORDER BY ex2.created_at DESC LIMIT 1
) AS top_exception_reason
```

Response ahora incluye `top_exception_code` (alias de `top_exception_reason`). En el schema actual `reason` es el código canónico; si en el futuro se separan código y descripción, `top_exception_code` no cambia de nombre en la API.

### Curls de prueba
```bash
curl -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/inbox?limit=5'
# Verificar: cada chat tiene has_active_exception (bool) + top_exception_reason + top_exception_code
```

---

## Tarea 5 · Endpoints de revisión supervisor bot-actions

### Ruta registrada
```
GET  /api/sales/supervisor/bot-actions
     Filtros: limit (max 200), since (ISO timestamp)
     Default: acciones is_reviewed=FALSE de las últimas 48h
     Auth: requireAdminOrPermission("ventas")
```

### Curl de prueba
```bash
curl -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/sales/supervisor/bot-actions?limit=20'
```

---

## Tarea 6 · Acoplamiento (state machine ↔ bot_handoffs)

### 6.1 crmChatStateMachine.js — extensión ATTENDED + TAKE
Archivo: `src/services/crmChatStateMachine.js`

```javascript
if (st === STATUS.UNASSIGNED || st === STATUS.RE_OPENED || st === STATUS.ATTENDED) {
  return {
    nextStatus: STATUS.PENDING_RESPONSE,
    assignedTo: userId,
    slaDeadlineAt: new Date(now.getTime() + SLA_MS),
  };
}
```

### 6.2 take-over refactorizado (src/handlers/salesApiHandler.js)

Orden garantizado:
1. `SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE` (bloqueo pesimista)
2. Verificación `PENDING_SLOT_BUSY` (el vendedor ya tiene otro chat en PENDING_RESPONSE)
3. `smTransition(chat, SM_EVENTS.TAKE, { userId })` — puede lanzar INVALID_TRANSITION
4. `UPDATE crm_chats SET status, assigned_to, sla_deadline_at`
5. Verificación de handoff activo duplicado (integridad — cubre carreras de red)
6. `INSERT INTO bot_handoffs (chat_id, from_bot, to_user_id, reason)`
7. `INSERT INTO crm_messages type='system'`
8. `COMMIT`
9. Post-commit: `slaTimerManager.schedule()`, `sseBroker.broadcast("chat_taken")`, `sseBroker.broadcast("sla_started")`

### 6.3 return-to-bot refactorizado

Orden garantizado:
1. `SELECT * FROM crm_chats FOR UPDATE`
2. Validación `status = PENDING_RESPONSE` → si no, `400 HANDOFF_INVALID_STATE`
3. `UPDATE crm_chats SET status='UNASSIGNED', assigned_to=NULL, sla_deadline_at=NULL`
4. `UPDATE bot_handoffs SET ended_at=NOW(), ended_by=$userId WHERE ended_at IS NULL`
5. `INSERT INTO crm_messages type='system'`
6. `COMMIT`
7. Post-commit: `slaTimerManager.cancel()`, `sseBroker.broadcast("chat_released")`

### Nuevos imports en salesApiHandler.js
```javascript
const sseBroker          = require("../realtime/sseBroker");
const slaTimerManager    = require("../services/slaTimerManager");
const { transition: smTransition, EVENTS: SM_EVENTS } = require("../services/crmChatStateMachine");
```

### Script de test
`scripts/tests/handoff_coupling.sh` — prueba secuencial de 7 casos:
1. take-over → 200 + PENDING_RESPONSE + handoff activo
2. return-to-bot → 200 + ended_at + chat_released
3. segundo take-over (mismo chat ahora UNASSIGNED) → 200
4. take-over duplicado → 409
5. return-to-bot desde UNASSIGNED → 400 HANDOFF_INVALID_STATE

---

## Tarea 7 · Adopción/deprecación de fantasmas

| Endpoint | Consumidores encontrados | Decisión |
|----------|--------------------------|----------|
| `GET /api/sales/chats/:chatId/handoff-status` | Ninguno | **Deprecado** · `logger.warn("DEPRECATED...")` añadido. Remover en Sprint 5. |
| `GET /api/sales/supervisor/exceptions` | `docs/prompts/prompt-dashboard-observacion.md` (hook `useSupervisorExceptions.ts`) | **Adoptado** · documentado en ADR-009 sección "Endpoints adoptados". |

---

## Sorpresas encontradas durante ejecución

1. **`inboxOmnichannelHandler.js` ya tenía take/release con state machine y SSE completos** — usé ese código como patrón de referencia exacto para el refactor de take-over/return-to-bot. Evité duplicar la lógica de PENDING_SLOT_BUSY y SSE.

2. **`transition()` es función pura** — no acepta cliente pg (ni lo necesita). La aplico dentro de la transacción manualmente: call → aplico UPDATE. No fue STOP AND REPORT porque no requiere improvisar.

3. **`bot_handoffs` no tenía columna `ended_by`** — migración aditiva `sql/20260421_bot_handoffs_ended_by.sql` creada.

4. **`supervisor/exceptions` referenciado en frontend como `/api/ventas/`** — la ruta real es `/api/sales/`. Diferencia de naming (ADR-004). Documentada en ADR-009, pendiente verificar proxy/BFF del frontend.

5. **`reason` en `exceptions` sin CHECK constraint** — catálogo vive en `docs/EXCEPTION_CODES.md` + `supervisorService.KIND_MAPPING`. No fue STOP AND REPORT porque el catálogo es reconstructible desde código existente.

---

## Migraciones aplicadas / disponibles

| Script npm | Archivo SQL | Descripción |
|-----------|-------------|-------------|
| `npm run db:bot-handoffs` | `sql/20260419_sprint1_bot_handoffs.sql` | Tabla bot_handoffs (Sprint 1) |
| `npm run db:bot-actions` | `sql/20260421_paso2_bot_actions.sql` | Tabla bot_actions |
| `npm run db:bot-actions-review` | `sql/20260421_paso2_bot_actions_review.sql` | Columnas is_reviewed, is_correct, reviewed_by, reviewed_at |
| `npm run db:exceptions` | `sql/20260421_paso2_exceptions.sql` | Tabla exceptions |
| `npm run db:bot-handoffs-ended-by` | `sql/20260421_bot_handoffs_ended_by.sql` | Columna ended_by en bot_handoffs (nueva · Bloque 2) |

**Orden recomendado para DB limpia:**
```bash
npm run db:bot-handoffs
npm run db:bot-actions
npm run db:bot-actions-review
npm run db:exceptions
npm run db:bot-handoffs-ended-by
```

---

## Rutas registradas en server.js (lista completa Bloque 2)

Todas las rutas del Bloque 2 están dentro de `handleSalesApiRequest` ya montado en `server.js`. No se requirió modificar `server.js`.

| Método | Path | Handler | Estado |
|--------|------|---------|--------|
| POST | `/api/sales/chats/:chatId/take-over` | salesApiHandler | Refactorizado (D2) |
| POST | `/api/sales/chats/:chatId/return-to-bot` | salesApiHandler | Refactorizado (D2) |
| GET | `/api/sales/chats/:chatId/bot-actions` | salesApiHandler | Nuevo (BE-2.1) |
| PATCH | `/api/sales/bot-actions/:id/review` | salesApiHandler | Preexistente (BE-2.6) |
| GET | `/api/sales/bot-actions` | salesApiHandler | Preexistente con filtros |
| GET | `/api/sales/supervisor/bot-actions` | salesApiHandler | Nuevo (BE-2.6/T5) |
| GET | `/api/sales/supervisor/exceptions` | salesApiHandler | Adoptado (T7) |
| GET | `/api/sales/exceptions` | salesApiHandler | Preexistente |
| PATCH | `/api/sales/exceptions/:id/resolve` | salesApiHandler | Preexistente |
| POST | `/api/sales/exceptions` | salesApiHandler | Nuevo (BE-2.2 manual) |
| GET | `/api/sales/chats/:chatId/handoff-status` | salesApiHandler | Deprecado (T7) |
