# Prompt · Sprint 4 · Motor NLU + cotización automática + supervisor UI

**Destinatario:** Cursor Backend + Frontend
**Duración:** 2 semanas
**Pre-requisitos:** Sprint 3 completado. **ADR-003 firmado** (proveedor IA) antes del día 3 del sprint.

---

## Objetivo del sprint

1. **Servicio NLU** que clasifica cada mensaje entrante (intent + entities + confidence)
2. **Motor de cotización automática** que genera cotizaciones sin intervención humana cuando aplica
3. **Política de umbrales**: montos altos requieren aprobación humana
4. **Motor de recordatorios** que nunca cancela, solo acompaña
5. **UI de supervisión** para que el supervisor vea la clasificación del bot y pueda corregir estructurado

Este es el sprint de mayor valor de negocio y mayor riesgo técnico. Al cerrar, el sistema responde en segundos sin intervención humana en 70%+ de los casos.

---

## Placeholder crítico · ADR-003

Este sprint **depende de ADR-003 firmado** antes del día 3. La decisión define:

- Proveedor: `<<COMPLETAR_ADR_003: groq | claude | híbrido>>`
- Modelo: `<<COMPLETAR_ADR_003: llama-3.3-70b | claude-4.5 | etc>>`
- Fallback: `<<COMPLETAR_ADR_003: cuál modelo usar si el primario falla>>`

Si al día 3 el ADR-003 no está firmado, **parar Sprint 4** y escalar. No improvisar con "cualquier modelo".

**Recomendación de firma rápida basada en eval previo:**
- Eval con `llama-3.1-8b-instant`: 84% intent accuracy, 58% confidence calibration
- Eval con `llama-3.3-70b-versatile`: pendiente
- Si 70B mejora confidence a ≥70%, firmar Opción A (GROQ solo con 70B)
- Si no, firmar Opción B (híbrido: GROQ para clasificación rápida, Claude para casos de confidence baja)

---

## Tickets backend

### BE-4.1 · Servicio NLU base (3 días)

**Archivo:** `src/services/nluService.js`

**Entrada:** mensaje entrante + contexto conversacional (últimos 5 mensajes).

**Salida:**

```json
{
  "intent": "consulta_producto",
  "confidence": 0.87,
  "vehicle": { "make": "Toyota", "model": "Corolla", "year": 2018 },
  "parts": [{ "category": "pastilla_freno", "position": "delantero" }],
  "reply_hint": "cotizar_inmediato",
  "_meta": {
    "provider": "groq",
    "model": "llama-3.3-70b-versatile",
    "latency_ms": 820,
    "tokens_in": 450,
    "tokens_out": 120,
    "cost_usd_estimated": 0.0003
  }
}
```

**System prompt canónico** (usar el del `eval-nlu-v2-spec.md` · sección 3):

```
Eres un clasificador de mensajes entrantes para un sistema de ventas de autopartes en Venezuela.
Tu única tarea es devolver JSON válido siguiendo el schema exacto...
(copiar completo del spec de eval)
```

**Lógica del servicio:**

```javascript
const SYSTEM_PROMPT = `...`; // del spec

async function classifyMessage(chatId, messageText, previousMessages = []) {
  const userPrompt = buildUserPrompt(messageText, previousMessages);
  const start = Date.now();

  // Según ADR-003: elegir proveedor
  const { provider, result, tokens } = await callPrimaryProvider(SYSTEM_PROMPT, userPrompt);
  const latency = Date.now() - start;

  // Extraer JSON (con fallback del spec)
  const parsed = extractJson(result.text);
  if (!parsed) {
    await logFailure('json_fail', { chatId, raw: result.text });
    return fallbackClassification(messageText);
  }

  // Validar schema
  const errors = validateResponse(parsed);
  if (errors.length > 0) {
    await logFailure('validation_fail', { chatId, errors });
    return fallbackClassification(messageText);
  }

  // Registrar en bot_actions
  await botActionsService.log({
    chatId,
    actionType: 'message_classified',
    inputContext: { messageText, previousMessages: previousMessages.slice(-3) },
    outputResult: parsed,
    provider,
    latencyMs: latency,
    tokensUsed: tokens.input + tokens.output,
    costUsdEstimated: estimateCost(tokens, provider)
  });

  return { ...parsed, _meta: { provider, latency_ms: latency, tokens } };
}

function fallbackClassification(messageText) {
  // Si el NLU falla completamente, devolver algo seguro que escale a humano
  return {
    intent: 'otro',
    confidence: 0.0,
    vehicle: null,
    parts: [],
    reply_hint: 'derivar_humano'
  };
}
```

**Umbral de confidence (configurable via env):**

```
NLU_CONFIDENCE_THRESHOLD=0.85
```

Cuando `confidence < NLU_CONFIDENCE_THRESHOLD`, se crea excepción `ambiguity_unresolved` automáticamente.

**Criterios:**
- [ ] Clasifica mensajes con schema validado
- [ ] Registra cada llamada en `bot_actions`
- [ ] Fallback seguro si IA falla
- [ ] Tests con 10 mensajes hardcodeados

---

### BE-4.2 · Motor de cotización automática (3 días)

**Archivo:** `src/services/autoQuoteService.js`

**Precondiciones para disparar cotización automática:**

1. NLU devuelve `intent = 'consulta_producto'`
2. `confidence >= NLU_CONFIDENCE_THRESHOLD`
3. `vehicle` y al menos una `part` extraídos
4. No hay handoff activo en el chat (usar `handoffGuard`)
5. Monto estimado < `AUTO_QUOTE_MAX_AMOUNT` (env, default 2000)

**Flujo:**

```javascript
async function tryAutoQuote(chatId, nluResult) {
  // Guardar con handoff
  return guardAutomations(chatId, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Buscar SKUs matching en products (canónico según ADR-005)
      const matches = await findProductsForRequest(nluResult.vehicle, nluResult.parts);
      if (matches.length === 0) {
        await raiseException(client, chatId, 'ambiguity_unresolved', {
          reason: 'no_matching_products',
          nluResult
        });
        return { skipped: true, reason: 'no_matches' };
      }

      // 2. Agregar productos complementarios según reglas configurables
      const enriched = await addComplementaryProducts(matches, nluResult);

      // 3. Reservar stock por 72h (implementar según sistema de stock existente)
      const reservations = await reserveStock(client, enriched, 72 * 60 * 60);

      // 4. Calcular total
      const totalUsd = enriched.reduce((sum, item) =>
        sum + (item.unitPriceUsd * item.quantity), 0);

      // 5. Verificar umbral de monto
      if (totalUsd > AUTO_QUOTE_MAX_AMOUNT) {
        await raiseException(client, chatId, 'amount_over_threshold', {
          totalUsd,
          threshold: AUTO_QUOTE_MAX_AMOUNT,
          quoteDraft: enriched
        });
        await client.query('COMMIT');
        return { skipped: true, reason: 'amount_over_threshold' };
      }

      // 6. Crear cotización en inventario_presupuesto
      const quoteId = await createQuote(client, {
        chatId,
        totalUsd,
        createdByBot: true,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        items: enriched
      });

      // 7. Registrar en bot_actions
      await botActionsService.log({
        chatId,
        actionType: 'quote_created',
        inputContext: { nluResult },
        outputResult: { quoteId, totalUsd, itemCount: enriched.length }
      }, client);

      await client.query('COMMIT');

      // 8. Enviar cotización al cliente por WhatsApp (o canal correspondiente)
      await sendQuoteToClient(chatId, quoteId);

      return { quoteId, totalUsd };

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
```

**Función `findProductsForRequest`:**

Debe buscar en `products` (NO en `productos` ni `inventario_producto` según ADR-005):

```sql
SELECT p.id, p.sku, p.name, p.price_usd, p.stock_available
FROM products p
WHERE p.is_active = TRUE
  AND p.stock_available > 0
  AND matches_vehicle_compatibility(p, $1 /* vehicle */)
  AND matches_part_category(p, $2 /* part category */)
ORDER BY relevance_score DESC
LIMIT 5;
```

**Ajustar la query** a los campos reales de `products`. Puede que haya una tabla de compatibilidades (`product_compatibility`) o un JSONB con vehículos soportados. Consultar schema real.

**Función `addComplementaryProducts`:**

Reglas configurables en DB (tabla `auto_quote_rules`):

```sql
CREATE TABLE IF NOT EXISTS auto_quote_rules (
  id SERIAL PRIMARY KEY,
  if_part_category TEXT NOT NULL,
  then_suggest_categories TEXT[] NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Ejemplo: si piden pastillas, sugerir disco + líquido
INSERT INTO auto_quote_rules (if_part_category, then_suggest_categories)
VALUES ('pastilla_freno', ARRAY['disco_freno', 'liquido_freno']);
```

Documentar en `docs/COMPLEMENTARY_RULES.md`.

**Criterios:**
- [ ] Cotización automática se crea en casos válidos
- [ ] Excepciones se crean en casos que no aplican
- [ ] Stock se reserva en la misma transacción
- [ ] Tests: caso feliz, sin matches, monto alto, handoff activo

---

### BE-4.3 · Pipeline de clasificación conectado al webhook entrante (1.5 días)

**Objetivo:** cuando llega un mensaje por WhatsApp/ML, el pipeline completo corre automáticamente.

**Modificar:** el handler de webhooks entrantes existente (localizar en código real).

**Pseudocódigo del flujo:**

```javascript
async function onIncomingMessage(chatId, messageText, source) {
  // Guardar mensaje (comportamiento existente)
  await saveMessage(chatId, messageText, source);

  // NUEVA lógica del Sprint 4:
  await guardAutomations(chatId, async () => {
    // 1. Obtener contexto reciente
    const previousMessages = await getRecentMessages(chatId, 5);

    // 2. Clasificar
    const nluResult = await nluService.classifyMessage(chatId, messageText, previousMessages);

    // 3. Si confidence baja, registrar excepción
    if (nluResult.confidence < NLU_CONFIDENCE_THRESHOLD) {
      await raiseException(null, chatId, 'ambiguity_unresolved', {
        nluResult, originalMessage: messageText
      });
      return;
    }

    // 4. Routing por intent
    switch (nluResult.intent) {
      case 'consulta_producto':
        await autoQuoteService.tryAutoQuote(chatId, nluResult);
        break;
      case 'pago_informado':
        // Sprint 5: intentar match en bank_statements
        await paymentMatchingService.tryMatch(chatId, messageText);
        break;
      case 'handoff_humano':
        // Notificar a vendedores (no hacer handoff automático, solo avisar)
        await notifyHandoffRequest(chatId);
        break;
      case 'saludo':
      case 'despedida':
        // Respuesta simple templatizada
        await sendTemplatedReply(chatId, nluResult.intent);
        break;
      case 'queja':
        // Crear excepción customer_complaint
        await raiseException(null, chatId, 'customer_complaint', { messageText });
        break;
      default:
        // 'otro': no hacer nada, esperar
        break;
    }
  });
}
```

**Importante:** `guardAutomations` (de Sprint 2) envuelve TODO. Si hay handoff activo, el bot NO clasifica ni responde.

**Criterios:**
- [ ] Mensaje entrante dispara el pipeline completo
- [ ] Con handoff activo, el bot NO hace nada
- [ ] Cada paso se registra en `bot_actions`
- [ ] Errores no bloquean otros chats (cada uno es independiente)

---

### BE-4.4 · Motor de recordatorios (1.5 días)

**Archivo:** `src/jobs/reminderJob.js`

**Ejecución:** cron cada hora.

**Lógica:**

```javascript
async function runReminderJob() {
  const client = await pool.connect();
  try {
    // 1. Cotizaciones sin aprobar
    const pendingQuotes = await client.query(`
      SELECT id, chat_id, fecha_creacion
      FROM inventario_presupuesto
      WHERE status = 'sent'
        AND chat_id IS NOT NULL
        AND fecha_creacion < NOW() - INTERVAL '6 hours'
        AND NOT EXISTS (
          SELECT 1 FROM bot_actions ba
          WHERE ba.chat_id = inventario_presupuesto.chat_id
            AND ba.action_type = 'reminder_sent'
            AND ba.created_at > NOW() - INTERVAL '6 hours'
        )
    `);

    for (const quote of pendingQuotes.rows) {
      await sendReminderForQuote(quote);
    }

    // 2. Órdenes aprobadas sin pagar
    const unpaidOrders = await client.query(`
      SELECT id, conversation_id
      FROM sales_orders
      WHERE payment_status = 'pending'
        AND conversation_id IS NOT NULL
        AND (wa_payment_reminder_at IS NULL OR wa_payment_reminder_at < NOW() - INTERVAL '12 hours')
        AND approval_status = 'approved'
    `);

    for (const order of unpaidOrders.rows) {
      await sendPaymentReminder(order);
    }

    // 3. NO se cancela nada automáticamente. Solo se acompaña.

  } finally {
    client.release();
  }
}

async function sendReminderForQuote(quote) {
  // Respetar handoff
  return guardAutomations(quote.chat_id, async () => {
    const message = `¿Sigues interesado en la cotización? Estoy aquí cuando decidas 👋`;
    await sendMessage(quote.chat_id, message);

    await botActionsService.log({
      chatId: quote.chat_id,
      actionType: 'reminder_sent',
      inputContext: { quoteId: quote.id, hoursElapsed: 6 },
      outputResult: { message }
    });
  });
}
```

**Regla de oro:** nunca cancelar. Solo enviar mensaje cordial.

**Cuando cliente responde "dame tiempo" o equivalente:** el NLU lo detecta (intent `otro` + contexto) y el bot debería espaciar recordatorios. Implementar:

```javascript
// En bot_actions, al detectar "dame tiempo", registrar:
await botActionsService.log({
  chatId,
  actionType: 'reminder_policy_relaxed',
  outputResult: { nextReminderAt: new Date(Date.now() + 12 * 60 * 60 * 1000) }
});

// En sendReminderForQuote, verificar si hay relajamiento reciente:
const relaxed = await pool.query(`
  SELECT output_result->>'nextReminderAt' AS next_at
  FROM bot_actions
  WHERE chat_id = $1 AND action_type = 'reminder_policy_relaxed'
  ORDER BY created_at DESC LIMIT 1
`, [chatId]);

if (relaxed.rows[0]?.next_at && new Date(relaxed.rows[0].next_at) > new Date()) {
  return { skipped: true, reason: 'policy_relaxed' };
}
```

**Criterios:**
- [ ] Job corre cada hora sin duplicar recordatorios
- [ ] Nunca cancela
- [ ] Respeta handoff
- [ ] Respeta relajamiento de política
- [ ] Tests

---

### BE-4.5 · Endpoint manual de cotización (0.5 día)

**Ruta:**

```
POST /api/sales/quotes
```

**Body:** cotización manual creada por vendedor (no por bot).

Mantener `GET /api/inbox/quotations` existente sin cambios. Solo agregar este endpoint nuevo para crear manualmente.

**Criterios:**
- [ ] Endpoint creado bajo `/api/sales/*` según ADR-004
- [ ] Sin breaking change en `/api/inbox/quotations`

---

### BE-4.6 · Snapshot en items de cotización (0.5 día)

**Objetivo:** cuando el bot o vendedor crea una cotización, los items guardan `sku`, `unit_price_usd` y `line_total_usd` como snapshot (columnas agregadas en Sprint 1 · BE-1.4).

**Modificación:** wherever se escribe a `inventario_detallepresupuesto`, agregar lectura de `products` y guardar snapshot.

```javascript
async function createQuoteItem(client, quoteId, productId, quantity) {
  const product = await client.query(
    'SELECT sku, name, price_usd FROM products WHERE id = $1',
    [productId]
  );
  if (product.rowCount === 0) throw new Error('Producto no encontrado');

  const { sku, name, price_usd } = product.rows[0];
  const lineTotal = price_usd * quantity;

  await client.query(
    `INSERT INTO inventario_detallepresupuesto
     (presupuesto_id, producto_id, cantidad, precio_unitario, subtotal,
      sku, unit_price_usd, line_total_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [quoteId, productId, quantity, price_usd, lineTotal,
     sku, price_usd, lineTotal]
  );
}
```

**Criterios:**
- [ ] Items nuevos guardan snapshot
- [ ] Items viejos (histórico) no se modifican
- [ ] Tests

---

## Tickets frontend

### FE-4.1 · Badge "🤖 BOT" en cotizaciones automáticas (0.5 día)

**Ubicación:** tarjeta de cotización en ChatWindow, cards del Kanban, ficha de orden.

**Lógica:**

```tsx
{quote.created_by_bot && <Badge purple>🤖 BOT</Badge>}
```

**Criterios:**
- [ ] Badge visible donde aplique
- [ ] No aparece en cotizaciones manuales

---

### FE-4.2 · Modal de excepción `amount_over_threshold` (2 días)

**Objetivo:** desde la pestaña de excepciones, cuando el supervisor hace clic en una excepción de tipo `amount_over_threshold`, ver la cotización pre-armada por el bot y decidir qué hacer.

**Modal:**

```tsx
<AmountThresholdModal exception={exc}>
  <Header>
    Cotización pre-armada por el bot
    <Warning>Supera umbral de USD {threshold}</Warning>
  </Header>

  <QuoteEditor
    items={exc.context.quoteDraft}
    onItemEdit={handleEdit}
  />

  <Total>USD {total}</Total>

  <Actions>
    <Button onClick={approve}>✓ Aprobar y enviar</Button>
    <Button onClick={editAndApprove}>Editar y aprobar</Button>
    <Button onClick={reject}>✗ Rechazar (no cotizar)</Button>
  </Actions>
</AmountThresholdModal>
```

**Flujo de aprobación:**

Al aprobar, POST a `/api/sales/quotes` con los items (posiblemente editados) + flag `origin: 'exception_resolved'`. Eso crea la cotización real, envía al cliente, y marca la excepción como resuelta.

**Criterios:**
- [ ] Modal muestra items y totales
- [ ] Supervisor puede editar items antes de aprobar
- [ ] Al aprobar, cotización se crea y excepción se cierra
- [ ] Al rechazar, excepción se cierra con nota "rechazada por supervisor"

---

### FE-4.3 · Timeline de automatización por venta (1.5 días)

**Objetivo:** en el panel de detalle de una orden (FE-3.6 de Sprint 3), agregar sección "Log del bot" que muestra cronológicamente qué hizo el bot.

**Datos:** `GET /api/sales/bot-actions?chat_id={chatId}`

**Render:**

```tsx
<TimelineSection>
  {actions.map(a => (
    <TimelineEntry key={a.id}>
      <Icon type={a.action_type} />
      <Content>
        <Summary>{renderSummary(a)}</Summary>
        <Meta>
          <Provider>{a.provider}</Provider>
          <Latency>{a.latency_ms}ms</Latency>
          {a.is_correct === false && <Tag red>Corregida por supervisor</Tag>}
        </Meta>
      </Content>
      <Timestamp>{formatTime(a.created_at)}</Timestamp>
    </TimelineEntry>
  ))}
</TimelineSection>
```

**Summaries por action_type:**

- `message_classified`: "Clasificó como **{intent}** (confianza {confidence})"
- `quote_created`: "Creó cotización #{quoteId} por USD {total} con {items} items"
- `reminder_sent`: "Envió recordatorio de {tipo} al cliente"
- `payment_reconciled`: "Matchó pago de Banesco {ref} a orden #{orderId}"
- etc.

**Criterios:**
- [ ] Timeline legible, chronological
- [ ] Indica cuáles fueron corregidas
- [ ] Click en entry abre detalle completo

---

### FE-4.4 · Configuración de umbral en settings (0.5 día)

**Ruta:** `/config/ventas/automatizacion`

**Campos editables (solo admin):**

- `AUTO_QUOTE_MAX_AMOUNT` (USD, default 2000)
- `NLU_CONFIDENCE_THRESHOLD` (0-1, default 0.85)
- Toggle global "Cotización automática activa" (on/off)

**Persistencia:** tabla `system_settings` (crear si no existe, o usar existente).

**Criterios:**
- [ ] Admin puede editar valores
- [ ] Cambios se reflejan inmediatamente en el motor (cargar desde DB por llamada, o invalidar caché cada N minutos)
- [ ] Audit log de cambios

---

## Criterios de aceptación globales del Sprint 4

- [ ] Backend: 6 tickets completados
- [ ] Frontend: 4 tickets completados
- [ ] Smoke: mensaje entrante → NLU clasifica → bot cotiza → cliente recibe cotización en <10 seg
- [ ] Smoke: monto alto genera excepción y supervisor aprueba desde modal
- [ ] Smoke: cliente pide tiempo, recordatorios se espacian
- [ ] Métricas: al menos 50% de mensajes entrantes generan cotización automática o excepción bien clasificada
- [ ] Observabilidad: costo diario de IA en dashboard

---

## Orden sugerido

Día 1-2: BE-4.1 (NLU service) — requiere ADR-003 firmado
Día 3-4: BE-4.2 (cotización automática)
Día 5: BE-4.3 (pipeline conectado al webhook)
Día 6: BE-4.4 (recordatorios) + BE-4.6 (snapshots)
Día 7: BE-4.5 + FE-4.1
Día 8: FE-4.2 (modal excepción threshold)
Día 9: FE-4.3 + FE-4.4
Día 10: tests + smoke + demo

---

## Al cerrar Sprint 4

Pasar a `prompt-sprint-5.md`. El motor de conciliación bancaria cierra el ciclo de pago que el Sprint 4 dejó "esperando".
