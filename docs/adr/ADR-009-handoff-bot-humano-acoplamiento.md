# ADR-009 · Acoplamiento handoff bot↔humano con state machine omnicanal

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-20
- **Dueño:** Backend lead (Javier)
- **Relacionados:** ADR-006 (segregación aprobación pagos), prompt-sprint-2.md, Bloque 1 motor omnicanal

---

## Contexto

El Bloque 1 entregó una máquina de estados en `crm_chats.status` con cuatro valores
(`UNASSIGNED`, `PENDING_RESPONSE`, `ATTENDED`, `RE_OPENED`) gestionada por
`src/services/crmChatStateMachine.js`. Las transiciones se aplican en
`src/handlers/inboxOmnichannelHandler.js` (`POST /api/inbox/chats/:chatId/take` y
`POST /api/inbox/chats/:chatId/release`) con `FOR UPDATE` y SSE.

El Sprint 1 entregó `bot_handoffs` (`sql/20260419_sprint1_bot_handoffs.sql`) con endpoints
`POST /api/sales/chats/:chatId/take-over` y `POST /api/sales/chats/:chatId/return-to-bot`
en `src/handlers/salesApiHandler.js` para gestionar el control bot↔humano.

Durante la Fase 0 del Bloque 2 se detectó que ambos sistemas evolucionan de forma
**independiente**: `take-over` insertaba en `bot_handoffs` sin disparar `transition(TAKE)` en
la state machine. Esto produce inconsistencias visibles al vendedor (chat `UNASSIGNED` en el
status de la bandeja con un humano activo en `bot_handoffs`).

---

## Decisión

### 1. Acoplamiento en una sola transacción

`take-over` y `return-to-bot` sincronizan `bot_handoffs` y `crm_chats` en la misma
transacción PostgreSQL, con este orden estricto:

```
a) SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE   ← bloqueo pesimista
b) transition(chat, event, ctx)                        ← función pura, puede lanzar
c) UPDATE crm_chats SET status, assigned_to, ...       ← aplica resultado de b)
d) INSERT/UPDATE bot_handoffs                          ← dentro de la misma tx
e) INSERT crm_messages type='system'                   ← mensaje de auditoría en DB
f) COMMIT
g) sseBroker.broadcast(...)                            ← post-commit, fuera de tx
h) slaTimerManager.schedule/cancel(...)                ← post-commit
```

Si `transition()` lanza `INVALID_TRANSITION`, la transacción hace ROLLBACK y
`bot_handoffs` **no se toca**. No existe estado inconsistente.

### 2. Extensión de crmChatStateMachine

`transition(TAKE)` acepta `ATTENDED` como origen válido además de `UNASSIGNED` y
`RE_OPENED`. Semántica: un humano puede retomar un chat que el bot ya respondió, sin
necesidad de que llegue un mensaje inbound nuevo.

Resultado: `ATTENDED → PENDING_RESPONSE` con `assigned_to = userId` y
`sla_deadline_at = NOW() + 120s`.

### 3. return-to-bot: semántica y estados válidos

`return-to-bot` exige `crm_chats.status = PENDING_RESPONSE` como precondición. Cualquier
otro estado devuelve `400 HANDOFF_INVALID_STATE`. El endpoint aplica directamente la
transición a `UNASSIGNED` sin pasar el check de `assigned_to === userId` (cualquier usuario
con permiso `ventas` puede devolver, no solo quien tomó).

### 4. bot_actions como log de automatización

La tabla `bot_actions` (referenciada en el comentario del SQL de `bot_handoffs` como
"ADR-009") alimenta el "Log de automatización" del mockup de bandeja:
- El guard `shouldSkipBotReply()` en `src/middleware/handoffGuard.js` registra
  `action_type = 'handoff_triggered'` con `fire-and-forget` cuando el bot se bloquea.
- El supervisor puede marcar acciones como correctas o incorrectas vía
  `PATCH /api/sales/bot-actions/:id/review`.

### 5. exceptions como sección supervisora

La tabla `exceptions` alimenta la pestaña "Excepciones" del mockup. Ver catálogo completo
en `docs/EXCEPTION_CODES.md`.

---

## Endpoints adoptados (Tarea 7 · Caso A)

`GET /api/sales/supervisor/exceptions` ya existe en `salesApiHandler.js` y es consumido por el
frontend (`useSupervisorExceptions.ts` referenciado en `docs/prompts/prompt-dashboard-observacion.md`
como `fetch /api/ventas/supervisor/exceptions`). **Nota:** el frontend usa el path `/api/ventas/`
pero el backend expone `/api/sales/` (ADR-004). Verificar que el proxy/BFF del frontend mapee
correctamente.

## Endpoints deprecados (Tarea 7 · Caso B)

`GET /api/sales/chats/:chatId/handoff-status` — ningún consumidor detectado. Marcado con
`logger.warn('DEPRECATED')`. Remover en Sprint 5.

---

## Consecuencias

- **Invariante extendido:** un chat con `bot_handoffs.ended_at IS NULL` tiene
  `crm_chats.status = PENDING_RESPONSE`.
- El AI Responder sigue protegido por `handoffGuard.shouldSkipBotReply()` que consulta
  `bot_handoffs WHERE ended_at IS NULL` — no se ve afectado por este acoplamiento.
- Los eventos SSE `chat_taken` y `chat_released` son las señales canónicas de cambio de
  control para el frontend.
- La state machine gana una transición: `ATTENDED + TAKE → PENDING_RESPONSE`.
- `bot_handoffs` gana la columna `ended_by INTEGER` vía migración aditiva
  `sql/20260421_bot_handoffs_ended_by.sql`.

## Deuda técnica documentada

### DT-1 · return-to-bot aplica UPDATE directo, no pasa por `transition(RELEASE)`

`take-over` llama `smTransition(chat, TAKE, { userId })` antes de escribir en `crm_chats`.
`return-to-bot` aplica `UPDATE crm_chats SET status='UNASSIGNED' ...` directamente, sin
llamar `transition(RELEASE, { userId })`.

**Por qué es asimétrico:** `transition(RELEASE)` valida que `assigned_to === userId`,
es decir, solo el vendedor que tomó el chat puede liberarlo. La decisión de negocio para
`return-to-bot` es diferente: **cualquier vendedor con permiso `ventas` puede devolver**
(caso de uso: el vendedor que tomó se desconecta; un supervisor o compañero devuelve).

Para honrar esa política sin hackear la state machine (pasarle un `userId` falso), se aplicó
el UPDATE directamente. El resultado es el mismo que `transition(RELEASE)` produce:
`status = 'UNASSIGNED'`, `assigned_to = NULL`, `sla_deadline_at = NULL`.

**Invariante mantenido:** la state machine sigue siendo la autoridad para `take-over`.
Solo `return-to-bot` bypasea la validación de autoría, y lo hace con precondición explícita
(`status === 'PENDING_RESPONSE'` chequeada antes del UPDATE).

**Si en el futuro se quiere restringir** quién puede devolver, el cambio correcto es:
- Agregar un evento `FORCE_RELEASE` a la state machine con semántica "cualquier usuario",
- o agregar `overrideUserId` en el `ctx` de `transition(RELEASE)`.
- No "arreglar" el UPDATE directo sin leer este ADR.

## Alternativas descartadas

- **Sistemas paralelos con dos indicadores en UI:** descartada por confusión al vendedor.
- **Deprecar bot_handoffs en favor de `bot_paused_at` en crm_chats:** destructivo sobre Sprint 1.
- **Delegar en inboxOmnichannelHandler:** los endpoints de inbox no escriben en bot_handoffs,
  lo que dejaría al guard sin información.

## Referencias

- `src/services/crmChatStateMachine.js`
- `src/handlers/inboxOmnichannelHandler.js` (patrón FOR UPDATE + SSE)
- `src/handlers/salesApiHandler.js`
- `sql/20260419_sprint1_bot_handoffs.sql`
- `sql/20260420_crm_chats_omnichannel_states.sql`
- `src/middleware/handoffGuard.js`
- `docs/prompts/prompt-sprint-2.md`
