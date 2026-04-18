# Prompt · Sprint 2 BE · bot_actions + exceptions + handoffGuard + bandeja pulida

**Destinatario:** Cursor backend · `webhook-receiver`
**Pre-requisitos:** Sprint 1 BE cerrado 7/9 · ADRs 001, 004, 005, 006, 007, 008 firmados
**Paralelismo:** arranca junto con Sprint 2 FE (ver prompt FE separado)

> **Revisión 2026-04-18:** corrige errores de schema encontrados al auditar el repo:
> - `bot_handoffs` usa `ended_at IS NULL` (activo), no `status = 'active'`; columnas `to_user_id` / `started_at` (no `taken_over_by` / `taken_over_at`)
> - `require` relativo → `../../db` (patrón del repo)
> - Prerequisito actualizado a 7/9 (BE-1.1 y BE-1.2 pendientes de BD)
> - Endpoint resolve: PATCH (no POST)
> - Comandos terminal: usar `rg` o `Select-String` en PowerShell

---

## Filosofía del sprint

Sprint 1 construyó los cimientos del módulo de ventas omnicanal: schema, handoff bot↔humano, chat_stage. Sprint 2 **agrega las capas de supervisión y resiliencia** que ADR-006 asume como existentes:

1. **`bot_actions`** · log de cada acción automática del bot para auditoría y supervisión
2. **`exceptions`** · tabla que reemplaza el hardcoded `exceptions: 0` de BE-1.8 con datos reales
3. **`handoffGuard`** · middleware que previene que el bot responda en chats donde un humano tomó el control
4. **Bandeja pulida** · ajustes sobre `/api/inbox` y servicios consumidos por `/bandeja` para integrar los 3 puntos anteriores

Al cerrar el sprint: cada acción del bot es rastreable, las excepciones tienen UI real, y el handoff humano se respeta sistemáticamente.

---

## Reglas duras

1. **No tocar `reconciliationService.js`** · ese código queda intacto hasta BE-5.0 (ADR-006 amendment firmado)
2. **No tocar `/api/inbox/counts`** · BE-1.8 ya lo extendió. Solo se pobla de datos reales lo que antes era placeholder (`exceptions: 0`)
3. **No romper contratos existentes** · todo cambio en endpoints es aditivo, nunca destructivo
4. **Permisos `sales.propose_match` / `finance.approve_payment`** · NO crearlos en este sprint (BE-5.0 lo hace)
5. **Template de código delicado aplica** · cada modificación de archivo existente cita path + línea + snippet actual + propuesto
6. **Si aparece discrepancia entre prompt y código real, stop-and-report** · nunca improvisar

---

## Tarea 0 · Verificación inicial (bloqueante · 20 min)

Antes de ejecutar cualquier ticket, confirmar 3 cosas contra el código real. Pegar resultados en el PR.

### 0.1 · Schema real de `bot_handoffs` (BE-1.5 commit `6f90923`)

```bash
# PowerShell / Git Bash
cat sql/20260419_sprint1_bot_handoffs.sql
```

Pegar contenido literal. El schema es:
- Activo = `ended_at IS NULL` (no existe columna `status`)
- Columnas: `id`, `chat_id`, `from_bot`, `to_user_id`, `reason`, `started_at`, `ended_at`
- Índice único: `idx_bot_handoffs_active_unique ON bot_handoffs (chat_id) WHERE ended_at IS NULL`

### 0.2 · Handler de auth · patrón canónico

```bash
# rg (ripgrep) — disponible en el repo
rg "req\._authUser|req\.user|req\.jwtUser|req\._user" src/middleware/authMiddleware.js
rg "requireAdminOrPermission" src/middleware/authMiddleware.js
```

**Decisión a tomar:** cuál es el nombre canónico del objeto de usuario autenticado.
Documentar en comentario del handler (o en `docs/BACKEND_CONVENTIONS.md` si ya existe).
Todos los handlers nuevos de Sprint 2 usan ese nombre canónico.

### 0.3 · Tabla `crm_chats` · estructura para `handoffGuard`

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'crm_chats'
ORDER BY ordinal_position;
```

Pegar resultado. Si algún campo esperado falta, parar y consultar antes de implementar.

---

## Tickets backend

### BE-2.1 · Tabla `bot_actions` · registro de acciones automáticas (1.5 días)

**Objetivo:** cada acción automática del bot queda registrada con input, output, provider, confianza y timestamp.

#### Migración

Archivo: `sql/20260501_sprint2_bot_actions.sql`

**Pre-verificación:**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'bot_actions';
```

**DDL:**

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS bot_actions (
  id             BIGSERIAL    PRIMARY KEY,
  chat_id        BIGINT       REFERENCES crm_chats(id) ON DELETE SET NULL,
  order_id       BIGINT       REFERENCES sales_orders(id) ON DELETE SET NULL,
  action_type    TEXT         NOT NULL,
  input_context  JSONB,
  output_result  JSONB,
  provider       TEXT,
  confidence     NUMERIC(3,2),
  duration_ms    INTEGER,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE bot_actions
  ADD CONSTRAINT bot_actions_action_type_check
  CHECK (action_type IN (
    'message_replied',
    'quote_generated',
    'payment_reminder_sent',
    'receipt_requested',
    'payment_matched',
    'payment_reconciled',
    'order_created',
    'handoff_triggered',
    'exception_raised',
    'payment_proposal_created'
  ));

CREATE INDEX IF NOT EXISTS idx_bot_actions_chat_id_created_at
  ON bot_actions (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_actions_order_id_created_at
  ON bot_actions (order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_actions_type_created_at
  ON bot_actions (action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_actions_correlation_id
  ON bot_actions (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
```

**Rollback:**
```sql
BEGIN;
DROP TABLE IF EXISTS bot_actions CASCADE;
COMMIT;
```

**Notas del schema:**
- `action_type`: enum extensible. Incluye `payment_proposal_created` y `payment_reconciled` para que BE-5.0 pueda loguear sin modificar schema.
- `correlation_id`: trazabilidad de cadenas de acciones (ej: webhook → nlu → quote = 3 filas con mismo `correlation_id`).
- `confidence`: NULL si no aplica.

#### Servicio `botActionsService.js`

Archivo: `src/services/botActionsService.js` (nuevo)

```javascript
"use strict";
const { pool } = require("../../db");

async function log({
  chatId = null,
  orderId = null,
  actionType,
  inputContext = null,
  outputResult = null,
  provider = null,
  confidence = null,
  durationMs = null,
  correlationId = null,
}, client = null) {
  const executor = client || pool;
  const res = await executor.query(`
    INSERT INTO bot_actions
      (chat_id, order_id, action_type, input_context, output_result,
       provider, confidence, duration_ms, correlation_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [chatId, orderId, actionType, inputContext, outputResult,
      provider, confidence, durationMs, correlationId]);
  return res.rows[0].id;
}

async function getByChat(chatId, { limit = 50, offset = 0 } = {}) {
  const res = await pool.query(`
    SELECT id, chat_id, order_id, action_type, input_context, output_result,
           provider, confidence, duration_ms, correlation_id, created_at
    FROM bot_actions WHERE chat_id = $1
    ORDER BY created_at DESC LIMIT $2 OFFSET $3
  `, [chatId, limit, offset]);
  return res.rows;
}

async function getByOrder(orderId, { limit = 50, offset = 0 } = {}) {
  const res = await pool.query(`
    SELECT id, chat_id, order_id, action_type, input_context, output_result,
           provider, confidence, duration_ms, correlation_id, created_at
    FROM bot_actions WHERE order_id = $1
    ORDER BY created_at DESC LIMIT $2 OFFSET $3
  `, [orderId, limit, offset]);
  return res.rows;
}

module.exports = { log, getByChat, getByOrder };
```

#### Endpoints de consulta

```
GET /api/sales/bot-actions?chat_id=N&limit=50
GET /api/sales/bot-actions?order_id=N&limit=50
```

Auth: usuario autenticado (patrón canónico identificado en Tarea 0.2).

**Criterios BE-2.1:**
- [ ] Tabla creada con índices y CHECK
- [ ] Servicio exporta `log()`, `getByChat()`, `getByOrder()`
- [ ] Endpoints GET funcionan
- [ ] Smoke: INSERT directo y verificar que `log()` devuelve id correcto

---

### BE-2.2 · Tabla `exceptions` · reemplazar placeholder de BE-1.8 (1.5 días)

**Objetivo:** tabla de excepciones reales que alimenta el count `exceptions` (hoy hardcoded en `0` en `inboxService.js`).

#### Migración

Archivo: `sql/20260501_sprint2_exceptions.sql`

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS exceptions (
  id              BIGSERIAL    PRIMARY KEY,
  entity_type     TEXT         NOT NULL,
  entity_id       BIGINT       NOT NULL,
  reason          TEXT         NOT NULL,
  severity        TEXT         NOT NULL DEFAULT 'medium',
  context         JSONB,
  status          TEXT         NOT NULL DEFAULT 'open',
  resolved_by     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  chat_id         BIGINT       REFERENCES crm_chats(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_entity_type_check
  CHECK (entity_type IN ('chat', 'order', 'payment', 'quote', 'product_match'));

ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_severity_check
  CHECK (severity IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE exceptions
  ADD CONSTRAINT exceptions_status_check
  CHECK (status IN ('open', 'in_progress', 'resolved', 'ignored'));

CREATE INDEX IF NOT EXISTS idx_exceptions_open
  ON exceptions (created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_exceptions_chat_id
  ON exceptions (chat_id, created_at DESC)
  WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exceptions_entity
  ON exceptions (entity_type, entity_id);

COMMIT;
```

**Rollback:**
```sql
BEGIN;
DROP TABLE IF EXISTS exceptions CASCADE;
COMMIT;
```

**Notas:**
- `reason` es texto libre (sin CHECK) — es diagnóstico y crece con el tiempo.
- `entity_type + entity_id` traza la excepción a cualquier entidad.
- `chat_id` desnormaliza para que la UI filtre por chat sin JOINs complejos.

#### Servicio `exceptionsService.js`

Archivo: `src/services/exceptionsService.js` (nuevo)

```javascript
"use strict";
const { pool } = require("../../db");

async function raise({ entityType, entityId, reason, severity = 'medium', context = null, chatId = null }, client = null) {
  const executor = client || pool;
  const res = await executor.query(`
    INSERT INTO exceptions (entity_type, entity_id, reason, severity, context, chat_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [entityType, entityId, reason, severity, context, chatId]);
  return res.rows[0].id;
}

async function resolve(exceptionId, { resolvedBy, resolutionNote }, client = null) {
  const executor = client || pool;
  await executor.query(`
    UPDATE exceptions
    SET status = 'resolved', resolved_by = $1, resolved_at = NOW(),
        resolution_note = $2, updated_at = NOW()
    WHERE id = $3 AND status IN ('open', 'in_progress')
  `, [resolvedBy, resolutionNote, exceptionId]);
}

async function list({ status = 'open', limit = 50, offset = 0 } = {}) {
  const res = await pool.query(`
    SELECT id, entity_type, entity_id, reason, severity, context,
           status, resolved_by, resolved_at, resolution_note,
           chat_id, created_at, updated_at
    FROM exceptions WHERE status = $1
    ORDER BY
      CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
        WHEN 'medium' THEN 3 ELSE 4 END,
      created_at DESC
    LIMIT $2 OFFSET $3
  `, [status, limit, offset]);
  return res.rows;
}

async function countOpen() {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM exceptions WHERE status = 'open'`
  );
  return res.rows[0].n;
}

module.exports = { raise, resolve, list, countOpen };
```

#### Endpoints

```
GET  /api/sales/exceptions?status=open&limit=50
PATCH /api/sales/exceptions/:id/resolve
      Body: { resolution_note: string }
```

Auth: usuario autenticado con el patrón canónico.

#### Integración con `/api/inbox/counts` (cierra deuda BE-1.8)

**Localizar placeholder:**
```bash
rg "exceptions:" src/services/inboxService.js
```

**Línea actual** (según BE-1.8):
```javascript
// Backlog: reemplazar con conteo real cuando exista tabla exceptions
exceptions: 0,
```

**Cambio propuesto:**
```javascript
const exceptionsService = require('./exceptionsService');
// ... al inicio del archivo

// En getInboxCounts(), reemplazar la línea de placeholder por:
exceptions: await exceptionsService.countOpen().catch(() => 0),
```

El `.catch(() => 0)` garantiza degradación si la tabla aún no existe (mismo patrón que `bot_handoffs` en BE-1.8).

**Criterios BE-2.2:**
- [ ] Tabla + servicio + endpoints funcionan
- [ ] `/api/inbox/counts.exceptions` devuelve número real
- [ ] Smoke: `raise()` crea excepción → aparece en `list()` → `countOpen()` la cuenta
- [ ] `resolve()` la saca del count

---

### BE-2.3 · Middleware `handoffGuard` (2 días)

**Objetivo:** prevenir que el bot responda automáticamente a un chat donde un humano ejecutó take-over (BE-1.6).

**Schema real de `bot_handoffs`** (verificado en Tarea 0.1):
- **Activo:** `ended_at IS NULL`
- Columnas relevantes: `id`, `chat_id`, `to_user_id`, `started_at`

#### Archivo nuevo

Archivo: `src/middleware/handoffGuard.js`

```javascript
"use strict";
const { pool } = require("../../db");
const botActionsService = require("../services/botActionsService");

/**
 * Verifica si un chat tiene handoff humano activo (ended_at IS NULL).
 * No es Express middleware — es un helper llamado explícitamente por pipelines del bot.
 */
async function checkHandoff(chatId) {
  if (!chatId) return { isHandedOver: false, handoff: null };

  const res = await pool.query(`
    SELECT id, chat_id, to_user_id, reason, started_at
    FROM bot_handoffs
    WHERE chat_id = $1
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `, [chatId]);

  if (res.rowCount === 0) return { isHandedOver: false, handoff: null };
  return { isHandedOver: true, handoff: res.rows[0] };
}

/**
 * Combina checkHandoff + logging.
 * Retorna true si el pipeline del bot debe saltar la respuesta automática.
 */
async function shouldSkipBotReply(chatId, { correlationId = null } = {}) {
  const { isHandedOver, handoff } = await checkHandoff(chatId);

  if (isHandedOver) {
    await botActionsService.log({
      chatId,
      actionType: 'handoff_triggered',
      inputContext: { reason: 'active_human_handoff' },
      outputResult: {
        handoffId: handoff.id,
        toUserId: handoff.to_user_id,
        startedAt: handoff.started_at,
      },
      provider: 'handoff_guard',
      correlationId,
    }).catch(() => {}); // log es best-effort; no frenar el flujo si falla
    return true;
  }

  return false;
}

module.exports = { checkHandoff, shouldSkipBotReply };
```

#### Integración en pipelines existentes

**Identificar puntos de respuesta automática:**
```bash
rg "sendAutoReply|generateReply|sendWAMessage|maybeQueueInbound" src/ --include="*.js"
```

Pegar resultados y **confirmar con Javier** dónde intercalar el guard antes de tocar código existente. La integración es estratégica: puede haber múltiples puntos de entrada.

**Patrón de integración:**
```javascript
const { shouldSkipBotReply } = require('../middleware/handoffGuard');

async function handleIncomingMessage(webhookPayload) {
  const chatId = /* obtener de payload */;

  if (await shouldSkipBotReply(chatId, { correlationId: webhookPayload.id })) {
    return { skipped: true, reason: 'handoff_active' };
  }

  // Flujo normal del bot ...
}
```

**Criterios BE-2.3:**
- [ ] `handoffGuard.js` con `checkHandoff` y `shouldSkipBotReply`
- [ ] Integración ejecutada en al menos 1 pipeline real (documentar cuál)
- [ ] Smoke: chat con handoff activo (`ended_at IS NULL`) → guard retorna `true` + registra `bot_action`
- [ ] Smoke: chat sin handoff → guard retorna `false` sin efectos secundarios
- [ ] Logs con `correlation_id`

---

### BE-2.4 · Bandeja pulida · campos `handoff_active` y `exceptions_count` (1 día)

**Objetivo:** agregar al listado de `/api/inbox` un flag de handoff activo y el count de excepciones abiertas por chat, sin N+1 queries.

#### Pre-verificación

```bash
rg "chat_stage|LIFECYCLE_STAGE|JOIN" src/services/inboxService.js | head -20
```

Identificar exactamente dónde BE-1.9 agregó `chat_stage`. Los campos nuevos siguen el mismo patrón aditivo.

#### Modificación SQL (en `inboxService.js`)

Agregar al SELECT principal (mantener orden de columnas existente):

```sql
EXISTS (
  SELECT 1 FROM bot_handoffs bh
  WHERE bh.chat_id = cc.id
    AND bh.ended_at IS NULL
) AS handoff_active,

COALESCE((
  SELECT COUNT(*)::int FROM exceptions ex
  WHERE ex.chat_id = cc.id AND ex.status = 'open'
), 0) AS exceptions_count
```

> Los índices `idx_bot_handoffs_active_unique` y `idx_exceptions_chat_id` ya cubren estas subqueries.

#### Modificación del mapper

```javascript
// Aditivo sobre el shape existente:
{
  // ... campos anteriores ...
  chat_stage: r.chat_stage || "contact",
  handoff_active: Boolean(r.handoff_active),
  exceptions_count: Number(r.exceptions_count) || 0,
}
```

**Criterios BE-2.4:**
- [ ] Query extendido con 2 campos nuevos
- [ ] Mapper extendido; shape anterior intacto
- [ ] Smoke: chat con handoff activo → `handoff_active: true`
- [ ] Smoke: chat con 2 excepciones open → `exceptions_count: 2`
- [ ] Smoke: chat limpio → `false` / `0`

---

### BE-2.5 · Logging `bot_actions` en flujos críticos existentes (0.5 día)

**Regla dura:** NO refactorizar lógica de negocio. Solo agregar llamadas a `botActionsService.log()` en puntos clave. Si un cambio requiere más que 3-5 líneas extra, parar y documentar como ticket separado.

**Identificar candidatos:**
```bash
rg "sendWhatsappText|sendWAMessage|replyTo" src/services/ --include="*.js"
rg "generateQuote|createQuote|sendReminder" src/services/ --include="*.js"
```

**Puntos sugeridos:**

| Flujo | `action_type` | Dónde |
|---|---|---|
| Bot responde mensaje automático | `message_replied` | tras llamada WA/ML |
| Bot solicita comprobante | `receipt_requested` | tras enviar mensaje |
| Bot envía recordatorio de pago | `payment_reminder_sent` | tras envío |
| Bot genera cotización | `quote_generated` | tras crear presupuesto |
| Handoff activado | `handoff_triggered` | YA en BE-2.3 |

**Patrón de integración mínima:**
```javascript
// Fire-and-forget: nunca debe tirar excepción que propague
botActionsService.log({
  chatId,
  actionType: 'message_replied',
  inputContext: { msgId: msg.id, text: (msg.text || '').substring(0, 200) },
  outputResult: { sentText: reply.substring(0, 200) },
  provider: 'groq-llama',
  confidence: nluConfidence || null,
  durationMs: Date.now() - startTime,
  correlationId: msg.id,
}).catch((err) => logger.warn({ err }, 'bot_action log failed'));
```

**Criterios BE-2.5:**
- [ ] Mínimo 3 puntos de logging agregados
- [ ] Ningún log rompe el flujo existente (todos con `.catch()`)
- [ ] Registros aparecen en BD tras smoke de cada flujo

---

## Criterios globales de aceptación

- [ ] **BE-2.1:** `bot_actions` creada; servicio y endpoints GET funcionan
- [ ] **BE-2.2:** `exceptions` creada; `/api/inbox/counts.exceptions` devuelve número real
- [ ] **BE-2.3:** `handoffGuard` integrado en al menos 1 pipeline real; tests pasan
- [ ] **BE-2.4:** `/api/inbox` devuelve `handoff_active` y `exceptions_count` por chat
- [ ] **BE-2.5:** al menos 3 flujos del bot registran `bot_actions`
- [ ] **Smoke E2E:** chat con handoff activo → bot NO responde + `bot_actions` registra intento bloqueado
- [ ] **Sin regresión:** `/api/sales/*`, `/api/inbox/*` siguen con mismo shape

---

## Orden sugerido

```
Día 1:   Tarea 0 · BE-2.1 DDL + servicio
Día 2:   BE-2.1 endpoints · BE-2.2 DDL
Día 3:   BE-2.2 servicio + endpoints + integración counts
Días 4-5: BE-2.3 handoffGuard + integración pipeline
Día 6:   BE-2.4 payload inbox
Día 7:   BE-2.5 logging flujos existentes
Días 8-9: Smoke E2E + ajustes
Día 10:  Reporte de cierre
```

---

## Si aparece algo no previsto

Aplicar **stop-and-report**:
1. Parar
2. Documentar con código real (path + línea + snippet)
3. Proponer 2-3 opciones
4. Esperar decisión

Casos especiales:
- Pipeline del bot con estructura distinta a la esperada
- `bot_handoffs` con campos adicionales no documentados
- Regresión en endpoint de Sprint 1 al agregar campos nuevos

---

## Reporte de cierre esperado

```markdown
# Reporte de cierre Sprint 2 BE

## Tickets cerrados
| Ticket | Descripción | SHA |
|---|---|---|
| BE-2.1 | bot_actions + servicio | <SHA> |
| ...    | ...                   | ...   |

## Tarea 0 · Verificación inicial
<resumen de lo encontrado>

## Sorpresas
<lo que apareció que no estaba en el prompt>

## Smoke tests ejecutados
<cada smoke con resultado>

## Deuda documentada
<qué no se pudo hacer y por qué>
```
