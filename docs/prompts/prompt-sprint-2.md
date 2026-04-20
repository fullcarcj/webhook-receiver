# Prompt · Sprint 2 · Bandeja omnicanal + capa de supervisión

**Destinatario:** Cursor Backend + Frontend
**Duración:** 2 semanas
**Pre-requisitos:** Sprint 1 completado. ADR-001, 004, 005 firmados.

---

## Objetivo del sprint

Convertir la bandeja actual en la **vista definitiva del vendedor/supervisor** con:

1. Indicador visual claro de cuándo el bot controla vs. cuándo un humano tomó una conversación
2. Pestaña "Excepciones" con casos que requieren atención
3. **Capa de supervisión:** cada acción del bot queda registrada y visible para el supervisor, con opción de marcar errores

Este sprint introduce la infraestructura de supervisión que se extiende durante los sprints siguientes.

---

## Reglas duras (heredadas de Sprint 1)

1. Nombres reales del schema. No inventar tablas ni columnas.
2. Sin Prisma, sin Zod generalizado. Node.js HTTP + `pg`.
3. Prefijo API: `/api/sales/*` en backend, `/ventas/*` o `/bandeja/*` en UI.
4. Migraciones aditivas con `IF NOT EXISTS`.
5. Si contradice un ADR, parar y preguntar.

---

## Tickets backend

### BE-2.1 · Tabla `bot_actions` (capa de supervisión base) (1 día)

**Objetivo:** registrar cada acción que el bot toma automáticamente, con contexto suficiente para que el supervisor entienda y pueda corregir.

**Archivo:** `sql/20260503_sprint2_bot_actions.sql`

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS bot_actions (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT REFERENCES crm_chats(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  -- valores: 'message_classified', 'message_sent', 'quote_created',
  --         'reminder_sent', 'handoff_offered', 'payment_reconciled',
  --         'exception_raised', 'rating_requested', 'order_closed', 'other'
  input_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- qué vio el bot: mensaje entrante, estado del chat, datos relevantes
  output_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- qué decidió: intent, confidence, respuesta enviada, producto sugerido, etc.
  provider TEXT,
  -- de dónde viene la decisión: 'groq', 'claude', 'rule_engine', 'heuristic'
  latency_ms INTEGER,
  tokens_used INTEGER,
  cost_usd_estimated NUMERIC,
  is_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  is_correct BOOLEAN,
  -- NULL = no revisado aún, TRUE = supervisor confirmó, FALSE = supervisor marcó error
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas frecuentes del supervisor
CREATE INDEX IF NOT EXISTS idx_bot_actions_chat_created
  ON bot_actions (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_actions_unreviewed
  ON bot_actions (created_at DESC)
  WHERE is_reviewed = FALSE;

CREATE INDEX IF NOT EXISTS idx_bot_actions_incorrect
  ON bot_actions (created_at DESC)
  WHERE is_correct = FALSE;

CREATE INDEX IF NOT EXISTS idx_bot_actions_type
  ON bot_actions (action_type, created_at DESC);

COMMIT;
```

**Convención de uso:**

Cuando el bot haga CUALQUIER acción, debe insertar en `bot_actions`. Ejemplo en pseudocódigo:

```javascript
await botActionsService.log({
  chatId,
  actionType: 'message_classified',
  inputContext: {
    message: incomingText,
    previousMessages: recentMessages,
    chatState: chatStatus
  },
  outputResult: {
    intent: 'consulta_producto',
    confidence: 0.87,
    entities: { vehicle: {...}, parts: [...] }
  },
  provider: 'groq',
  latencyMs: 820,
  tokensUsed: 450,
  costUsdEstimated: 0.0003
});
```

**Criterios:**
- [ ] Tabla creada con todos los índices
- [ ] Servicio `botActionsService` con método `log()` implementado
- [ ] Unit tests del servicio

---

### BE-2.2 · Tabla `exceptions` + catálogo de códigos (1 día)

**Objetivo:** formalizar las excepciones que el bot no puede resolver y requieren intervención humana.

**Archivo:** `sql/20260503_sprint2_exceptions.sql`

```sql
BEGIN;

-- Enum de razones de excepción
DO $$ BEGIN
  CREATE TYPE exception_reason_enum AS ENUM (
    'payment_no_match',
    'stock_zero',
    'customer_complaint',
    'ambiguity_unresolved',
    'amount_over_threshold',
    'ml_question_complex',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exception_severity_enum AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS exceptions (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  -- 'chat', 'quote', 'order', 'payment'
  entity_id BIGINT NOT NULL,
  chat_id BIGINT REFERENCES crm_chats(id) ON DELETE CASCADE,
  reason exception_reason_enum NOT NULL,
  severity exception_severity_enum NOT NULL DEFAULT 'medium',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exceptions_unresolved
  ON exceptions (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_exceptions_chat
  ON exceptions (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_exceptions_reason
  ON exceptions (reason, created_at DESC)
  WHERE resolved_at IS NULL;

COMMIT;
```

**Documentar en `docs/EXCEPTION_CODES.md`:**

```markdown
# Códigos de excepción

| Código | Descripción | Severidad típica | Quién puede resolver |
|--------|-------------|------------------|----------------------|
| payment_no_match | Comprobante de pago sin match automático en banco | medium | Vendedor/admin |
| stock_zero | Cotización aprobada, SKU sin stock y sin proveedor | high | Admin |
| customer_complaint | Calificación < 3 estrellas o queja explícita | high | Vendedor senior |
| ambiguity_unresolved | Bot no pudo extraer vehículo/pieza después de 2 intentos | low | Cualquier vendedor |
| amount_over_threshold | Cotización > AUTO_QUOTE_MAX_AMOUNT | medium | Vendedor |
| ml_question_complex | Pregunta de MercadoLibre requiere criterio humano | low | Cualquier vendedor |
| other | Caso no clasificable | varía | — |
```

**Criterios:**
- [ ] Tabla y enums creados
- [ ] Doc de códigos en repo

---

### BE-2.3 · Ampliar `/api/inbox` con flags de excepción (0.5 día)

**Objetivo:** el listado de conversaciones devuelve por cada chat si tiene excepción activa.

**Modificación:** `src/services/inboxService.js`

En la query de `listChats`, agregar LEFT JOIN con `exceptions`:

```sql
-- Pseudocódigo de la modificación
SELECT
  c.*,
  EXISTS (
    SELECT 1 FROM exceptions e
    WHERE e.chat_id = c.id AND e.resolved_at IS NULL
  ) AS has_active_exception,
  (
    SELECT e.reason::text FROM exceptions e
    WHERE e.chat_id = c.id AND e.resolved_at IS NULL
    ORDER BY e.created_at DESC LIMIT 1
  ) AS top_exception_reason
FROM crm_chats c
-- ... resto de la query existente
```

**Criterios:**
- [ ] Respuesta de `/api/inbox` incluye `has_active_exception` y `top_exception_reason`
- [ ] Sin regresiones en frontend actual

---

### BE-2.4 · Endpoints de excepciones (1.5 días)

**Rutas:**

```
GET    /api/sales/exceptions?resolved=false&reason=payment_no_match&limit=20
GET    /api/sales/exceptions/:id
PATCH  /api/sales/exceptions/:id/resolve
POST   /api/sales/exceptions  (raise manual, uso raro)
```

**Lógica `GET /api/sales/exceptions`:**

```sql
SELECT
  e.*,
  c.customer_name,
  c.phone,
  c.source_type
FROM exceptions e
LEFT JOIN crm_chats c ON c.id = e.chat_id
WHERE ($1::boolean IS NULL OR (e.resolved_at IS NULL) = ($1 = FALSE))
  AND ($2::text IS NULL OR e.reason::text = $2)
ORDER BY
  CASE e.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  e.created_at DESC
LIMIT $3 OFFSET $4;
```

**Lógica `PATCH /api/sales/exceptions/:id/resolve`:**

```javascript
async function resolveException(req, res) {
  const { id } = req.params;
  const { note } = req.body;
  const userId = req.user.id;

  // Validar que no está resuelta
  const current = await pool.query(
    'SELECT resolved_at FROM exceptions WHERE id = $1', [id]
  );
  if (current.rowCount === 0) return sendError(res, 404, 'No encontrada');
  if (current.rows[0].resolved_at !== null)
    return sendError(res, 409, 'Ya resuelta');

  await pool.query(
    `UPDATE exceptions
     SET resolved_at = NOW(), resolved_by = $1, resolution_note = $2
     WHERE id = $3`,
    [userId, note || null, id]
  );

  return sendSuccess(res, { resolved: true });
}
```

**Criterios:**
- [ ] Listado con filtros funciona
- [ ] Resolve persiste note y user
- [ ] Tests

---

### BE-2.5 · Integración handoff + pausar automatizaciones (1.5 días)

**Objetivo:** cuando un chat tiene `bot_handoffs` activo, el motor de respuestas automáticas **lo ignora completamente**. El vendedor escribe, el cliente recibe sus mensajes como siempre.

**Puntos de código a modificar** (probable lista, validar al implementar):

1. `inboxService` / listener de webhooks entrantes — antes de clasificar con NLU, verificar si hay handoff activo. Si sí, no clasificar.
2. `AI Responder` / generación de respuestas automáticas — mismo gate.
3. Motor de recordatorios (si existe ya en alguna forma) — no enviar recordatorios mientras haya handoff activo.
4. Motor de cotización automática (futuro Sprint 4) — ya queda la regla codificada.

**Servicio común nuevo:** `src/services/handoffGuard.js`

```javascript
async function isHandoffActive(chatId, client = pool) {
  const result = await client.query(
    'SELECT 1 FROM bot_handoffs WHERE chat_id = $1 AND ended_at IS NULL LIMIT 1',
    [chatId]
  );
  return result.rowCount > 0;
}

async function guardAutomations(chatId, fn) {
  if (await isHandoffActive(chatId)) {
    logger.info('Automatización bloqueada por handoff activo', { chatId });
    return { skipped: true, reason: 'handoff_active' };
  }
  return fn();
}
```

**Uso en los puntos de código:**

```javascript
// En lugar de:
const response = await aiResponder.generate(message);

// Ahora:
const result = await guardAutomations(chatId, () => aiResponder.generate(message));
if (result.skipped) return; // el vendedor se encarga
```

**Criterios:**
- [ ] Ningún mensaje automático sale cuando hay handoff activo
- [ ] Tests: con handoff activo, guardAutomations devuelve skipped
- [ ] Tests: sin handoff, guardAutomations ejecuta la función normalmente

---

### BE-2.6 · Endpoint marcar acción del bot como incorrecta (1 día)

**Objetivo:** el supervisor puede marcar una entrada de `bot_actions` como correcta o incorrecta desde la UI.

**Rutas:**

```
PATCH /api/sales/bot-actions/:id/review
```

**Body:**
```json
{
  "isCorrect": true | false,
  "note": "opcional, explicación del supervisor"
}
```

**Lógica:**

```javascript
async function reviewBotAction(req, res) {
  const { id } = req.params;
  const { isCorrect, note } = req.body;
  const userId = req.user.id;

  if (typeof isCorrect !== 'boolean')
    return sendError(res, 400, 'isCorrect debe ser boolean');

  // Actualizar la acción
  await pool.query(
    `UPDATE bot_actions
     SET is_reviewed = TRUE,
         is_correct = $1,
         reviewed_by = $2,
         reviewed_at = NOW()
     WHERE id = $3`,
    [isCorrect, userId, id]
  );

  // Si es incorrecta, agregar nota al contexto (en metadata del output_result)
  if (!isCorrect && note) {
    await pool.query(
      `UPDATE bot_actions
       SET output_result = output_result || jsonb_build_object('supervisor_note', $1)
       WHERE id = $2`,
      [note, id]
    );
  }

  return sendSuccess(res, { reviewed: true });
}
```

**Criterios:**
- [ ] Supervisor puede marcar correct/incorrect
- [ ] Nota se guarda si aplica
- [ ] Tests

---

### BE-2.7 · Endpoint listar acciones del bot (supervisor UI) (1 día)

**Ruta:**

```
GET /api/sales/bot-actions?chat_id=X&reviewed=false&since=...&limit=50
```

**Filtros:**
- `chat_id` · acciones de un chat específico
- `reviewed` · true/false, default false (ver no-revisadas primero)
- `since` · ISO timestamp, default últimas 24h
- `action_type` · filtrar por tipo
- `limit` · default 50, max 200

**Query:**

```sql
SELECT
  ba.*,
  c.customer_name,
  c.phone,
  c.source_type
FROM bot_actions ba
LEFT JOIN crm_chats c ON c.id = ba.chat_id
WHERE ($1::bigint IS NULL OR ba.chat_id = $1)
  AND ($2::boolean IS NULL OR ba.is_reviewed = $2)
  AND ba.created_at >= $3
  AND ($4::text IS NULL OR ba.action_type = $4)
ORDER BY ba.created_at DESC
LIMIT $5;
```

**Criterios:**
- [ ] Filtros funcionan combinados
- [ ] Response incluye info del chat y cliente
- [ ] Performance <200ms con 10000 acciones en tabla

---

### BE-2.8 · Extender `/api/inbox/counts` (0.5 día)

**Agregar contadores:**

```sql
-- Excepciones no resueltas
SELECT COUNT(*) AS exceptions_open
FROM exceptions WHERE resolved_at IS NULL;

-- Acciones del bot sin revisar (supervisor backlog)
SELECT COUNT(*) AS bot_actions_unreviewed
FROM bot_actions
WHERE is_reviewed = FALSE AND created_at > NOW() - INTERVAL '48 hours';

-- Acciones marcadas como incorrectas hoy
SELECT COUNT(*) AS bot_actions_incorrect_today
FROM bot_actions
WHERE is_correct = FALSE AND created_at > CURRENT_DATE;
```

Agregar al objeto devuelto por `/api/inbox/counts`.

**Criterios:**
- [ ] Los 3 contadores aparecen en la respuesta
- [ ] Performance <100ms en total

---

## Tickets frontend

### FE-2.1 · Indicador visual bot vs humano en `ChatWindow` (1.5 días)

**Archivo:** componentes existentes de `/bandeja` (ChatWindow, ChatHeader)

**Lógica:**

En el header del chat abierto:

```tsx
// Pseudocódigo (adaptar al stack real)
{activeHandoff ? (
  <Badge color="blue">
    👤 TOMADA · {activeHandoff.userName}
    <Button onClick={returnToBot}>Devolver al bot</Button>
  </Badge>
) : (
  <Badge color="purple">
    🤖 BOT ACTIVO · respondiendo automáticamente
    <Button onClick={takeOver}>Tomar conversación</Button>
  </Badge>
)}
```

**Datos:** extender `GET /api/inbox/:chatId` o crear endpoint nuevo `GET /api/sales/chats/:id/state` que devuelva si hay handoff activo. Consultar con backend cuál opción prefiere.

**Criterios:**
- [ ] Badge morado cuando no hay handoff
- [ ] Badge azul con nombre del humano cuando sí
- [ ] Botón "Tomar" llama a BE-1.6 (Sprint 1) y refresca
- [ ] Botón "Devolver" llama a BE-1.7 y refresca

---

### FE-2.2 · Banner sistema en lista de mensajes (1 día)

**Objetivo:** cuando un mensaje de `crm_messages` tiene `type = 'system'`, renderizar diferente.

**Lógica:**

```tsx
// Dentro del loop de mensajes
{message.type === 'system' ? (
  <div className="system-banner">— {message.content} —</div>
) : (
  <MessageBubble {...message} />
)}
```

**Estilo sugerido:**
- Centrado horizontalmente
- Texto gris tenue, fondo transparente
- Sin avatar, sin timestamp visible
- Similar a cómo WhatsApp muestra "X cambió el nombre del grupo"

**Criterios:**
- [ ] Mensajes de sistema se ven claramente distintos
- [ ] No se confunden con mensajes normales del cliente o vendedor

---

### FE-2.3 · Pestaña "Excepciones" en la bandeja (2 días)

**Objetivo:** tabs en la parte superior de `/bandeja`:

```
[Todas · 47] [Mías · 8] [Excepciones · 5] [Sin revisar · 23]
```

Los números vienen de `/api/inbox/counts`.

**Vista de excepciones:**

Al clic en la tab, llamar `GET /api/sales/exceptions?resolved=false`. Renderizar cards:

```tsx
<ExceptionCard>
  <Severity: high />
  <Reason: Pago sin match />
  <Customer: Yorman Cuadra />
  <Context: "$ 100 recibido, esperaba $ 191" />
  <Created: hace 2h />
  <Actions>
    <Button>Abrir chat</Button>
    <Button primary>Resolver</Button>
  </Actions>
</ExceptionCard>
```

**Modal "Resolver":**
- Campo de texto para nota (opcional)
- Botón "Marcar como resuelta" → PATCH `/api/sales/exceptions/:id/resolve`

**Criterios:**
- [ ] Tabs muestran contadores actualizados
- [ ] Lista de excepciones carga rápido
- [ ] Resolución funciona end-to-end
- [ ] Orden por severidad + fecha

---

### FE-2.4 · Panel lateral de acciones del bot por chat (1.5 días)

**Objetivo:** cuando el supervisor abre un chat, puede ver (en un panel colapsable) todas las acciones que el bot tomó en esa conversación.

**Ubicación:** sidebar derecho del ChatWindow, colapsable, tab "🤖 Bot".

**Contenido:**

```tsx
<BotActionsPanel chatId={chatId}>
  {actions.map(action => (
    <ActionCard key={action.id}>
      <ActionType>{humanizedType(action.action_type)}</ActionType>
      <Timestamp>{action.created_at}</Timestamp>
      <Summary>
        {renderSummary(action.action_type, action.output_result)}
      </Summary>
      <Footer>
        <Provider>{action.provider}</Provider>
        <Latency>{action.latency_ms}ms</Latency>
        {action.is_reviewed ? (
          action.is_correct
            ? <Tag green>✓ Correcta</Tag>
            : <Tag red>✗ Incorrecta</Tag>
        ) : (
          <ReviewButtons actionId={action.id} />
        )}
      </Footer>
    </ActionCard>
  ))}
</BotActionsPanel>
```

**Datos:** `GET /api/sales/bot-actions?chat_id={chatId}&reviewed=false`.

**Render de summary según action_type:**

- `message_classified`: "Clasificó como `consulta_producto` con confianza 0.87"
- `message_sent`: "Envió: '{primeros 100 chars}'"
- `quote_created`: "Armó cotización #COT-XYZ · $ 191 · 4 items"
- etc.

**Review buttons:**

```tsx
<Button onClick={() => review(id, true)}>✓ Correcta</Button>
<Button onClick={() => review(id, false)}>✗ Incorrecta</Button>
// Al marcar incorrecta, modal para agregar nota
```

**Criterios:**
- [ ] Panel muestra acciones en orden cronológico inverso
- [ ] Summary legible para humano
- [ ] Review marca la acción y refresca
- [ ] Performance: cargar las últimas 50 acciones < 500ms

---

### FE-2.5 · Microcopy en filtros y estados (0.5 día)

**Cambiar:**

- `payment_pending` → "Pago pendiente"
- `quote` → "Cotización"
- `dispatch` → "Despacho"
- `approved` → "Aprobada"
- Tooltips de ayuda en cada filtro

**Criterios:**
- [ ] Todos los textos visibles al usuario en español neutro
- [ ] Tooltips explican claramente qué significa cada estado

---

### FE-2.6 · Estado vacío de la bandeja (0.5 día)

**Cuando `count.total === 0`:**

```tsx
<EmptyState>
  <Icon>🤖</Icon>
  <Title>No hay conversaciones pendientes</Title>
  <Subtitle>El bot está manejando todo bien 👌</Subtitle>
</EmptyState>
```

**Criterios:**
- [ ] Aparece cuando no hay chats en la bandeja actual
- [ ] No aparece mientras carga

---

## Criterios de aceptación globales del Sprint 2

- [ ] Backend: 8 tickets completados y mergeados
- [ ] Frontend: 6 tickets completados
- [ ] Cero regresiones en `/api/inbox`
- [ ] Smoke test: vendedor toma chat, supervisor ve todas las acciones del bot en panel lateral, marca una como incorrecta, excepción aparece en pestaña dedicada, vendedor resuelve
- [ ] Performance: `/api/sales/bot-actions` < 300ms con 10k registros
- [ ] Documentación: `docs/EXCEPTION_CODES.md` publicado

---

## Orden sugerido

Día 1-2: BE-2.1 (bot_actions) + BE-2.2 (exceptions)
Día 3: BE-2.3 (flags en /api/inbox) + BE-2.5 (handoff guard)
Día 4: BE-2.4 (endpoints exceptions) + FE-2.1 (indicador bot/humano)
Día 5: BE-2.6 + BE-2.7 (review + list bot_actions) + FE-2.2 (banner system)
Día 6: BE-2.8 (counts extendidos) + FE-2.3 (pestaña excepciones)
Día 7-8: FE-2.4 (panel acciones del bot por chat) + FE-2.5 + FE-2.6
Día 9: tests + fixes
Día 10: docs + smoke + demo

---

## Al cerrar Sprint 2

Pasar a `prompt-sprint-3.md`. El Kanban se construye sobre lo que hiciste aquí.
