# Prompt · Sprint 3 · Kanban de pipeline + correcciones del supervisor

**Destinatario:** Cursor Backend + Frontend
**Duración:** 2 semanas
**Pre-requisitos:** Sprint 2 completado.

---

## Objetivo del sprint

1. **Vista `/ventas/tablero` con Kanban** usando `sales_orders` reales y los enums existentes
2. **Drag-and-drop** para mover órdenes entre etapas, con validación de transiciones legales
3. **Tabla `bot_corrections`** para que el supervisor marque errores estructurados y los use como feedback

El Kanban es la vista del supervisor/vendedor para ver el estado global del pipeline. Las correcciones alimentan el aprendizaje del sistema.

---

## Decisión arquitectónica previa

**No inventamos columna `stage` en `sales_orders`.** La etapa se **calcula** a partir de los campos reales que ya existen:

- `payment_status` (enum: not_required, pending, approved, rejected, refunded, waived)
- `fulfillment_status` (enum: not_required, pending, preparing, ready, shipped, delivered, failed, cancelled)
- `approval_status` (enum: not_required, pending, approved, rejected)
- `lifecycle_status` (text, varios valores)
- Presencia de orden (vs solo cotización en `inventario_presupuesto`)

Se implementa como **vista SQL `v_sales_pipeline`** que es fuente de verdad del Kanban.

---

## Tickets backend

### BE-3.1 · Vista SQL `v_sales_pipeline` (2 días)

**Archivo:** `sql/20260517_sprint3_v_sales_pipeline.sql`

**Mapa de etapas (6 columnas del Kanban):**

| Columna | Condición |
|---------|-----------|
| `conversation` | Hay chat sin cotización activa ni orden |
| `quote` | Existe cotización enviada, no aprobada |
| `approved` | Cotización aprobada, sin orden aún; O orden con `payment_status = 'pending'` |
| `payment` | Orden con `payment_status = 'pending'` y abono parcial detectado |
| `dispatch` | `payment_status = 'approved'` y `fulfillment_status IN ('preparing','ready','shipped')` |
| `closed` | `fulfillment_status IN ('delivered')` y `approval_status <> 'rejected'` |

**Definición de la vista** (placeholder: ajustar según campos reales revelados en BE-1.1/BE-3.1-spike):

```sql
CREATE OR REPLACE VIEW v_sales_pipeline AS
WITH chat_quotes AS (
  SELECT
    ip.chat_id,
    MAX(ip.id) AS latest_quote_id,
    MAX(ip.status) AS latest_quote_status
  FROM inventario_presupuesto ip
  WHERE ip.chat_id IS NOT NULL
    AND ip.status IN ('draft', 'sent', 'approved')
  GROUP BY ip.chat_id
),
chat_orders AS (
  SELECT
    so.conversation_id AS chat_id,
    so.id AS order_id,
    so.payment_status,
    so.fulfillment_status,
    so.approval_status,
    so.order_total_amount AS total_usd,
    so.channel_id,
    so.customer_id,
    so.seller_id
  FROM sales_orders so
  WHERE so.conversation_id IS NOT NULL
)
SELECT
  c.id AS chat_id,
  c.customer_name,
  c.phone,
  c.source_type,
  COALESCE(co.channel_id, cq.channel_id) AS channel_id,
  COALESCE(co.customer_id, c.customer_id) AS customer_id,
  co.seller_id,
  co.order_id,
  cq.latest_quote_id,
  co.total_usd,
  co.payment_status,
  co.fulfillment_status,
  co.approval_status,
  c.last_message_at,
  CASE
    WHEN co.fulfillment_status = 'delivered'
         AND co.approval_status <> 'rejected' THEN 'closed'
    WHEN co.payment_status = 'approved'
         AND co.fulfillment_status IN ('preparing','ready','shipped') THEN 'dispatch'
    WHEN co.payment_status = 'pending' AND co.order_id IS NOT NULL THEN 'payment'
    WHEN cq.latest_quote_status = 'approved' AND co.order_id IS NULL THEN 'approved'
    WHEN cq.latest_quote_status IN ('draft','sent') THEN 'quote'
    ELSE 'conversation'
  END AS stage
FROM crm_chats c
LEFT JOIN chat_quotes cq ON cq.chat_id = c.id
LEFT JOIN chat_orders co ON co.chat_id = c.id
WHERE c.id IS NOT NULL;
```

**Validar contra datos reales** antes de usar. Si la lógica de etapas no encaja, ajustar CASE sin mover el patrón de vista.

**Criterios:**
- [ ] Vista se crea sin errores
- [ ] Cada chat aparece una sola vez
- [ ] Cada chat tiene una sola etapa calculada
- [ ] Performance < 500ms para 1000 chats

---

### BE-3.2 · Endpoint `GET /api/sales/pipeline` (1.5 días)

**Ruta:**

```
GET /api/sales/pipeline?channel=wa&seller=3&from=2026-04-01&to=2026-04-30
```

**Response:**

```json
{
  "columns": [
    { "key": "conversation", "name": "Conversación", "count": 8, "total_usd": 4820 },
    { "key": "quote",        "name": "Cotización",   "count": 14, "total_usd": 8340 },
    { "key": "approved",     "name": "Aprobada",     "count": 9, "total_usd": 2890 },
    { "key": "payment",      "name": "Conciliar pago", "count": 7, "total_usd": 1640 },
    { "key": "dispatch",     "name": "Despacho",     "count": 5, "total_usd": 1200 },
    { "key": "closed",       "name": "Cerradas",     "count": 12, "total_usd": 3120 }
  ],
  "cards": [
    {
      "chat_id": 101,
      "stage": "approved",
      "customer_name": "Yorman Cuadra",
      "phone": "+58 414...",
      "channel_id": 2,
      "source_type": "wa_inbound",
      "order_id": 79416,
      "latest_quote_id": 412,
      "total_usd": 191,
      "seller_id": 3,
      "last_message_at": "2026-04-18T18:04:00Z",
      "has_active_exception": false,
      "payment_status": "pending",
      "fulfillment_status": "not_required"
    },
    ...
  ]
}
```

**Lógica:**

```javascript
async function getPipeline(req, res) {
  const { channel, seller, from, to } = req.query;

  const params = [];
  const where = ['1=1'];

  if (channel) {
    params.push(channel);
    where.push(`channel_id = $${params.length}`);
  }
  if (seller) {
    params.push(parseInt(seller));
    where.push(`seller_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`last_message_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`last_message_at <= $${params.length}`);
  }

  const cardsQuery = `
    SELECT
      vp.*,
      EXISTS (
        SELECT 1 FROM exceptions e
        WHERE e.chat_id = vp.chat_id AND e.resolved_at IS NULL
      ) AS has_active_exception
    FROM v_sales_pipeline vp
    WHERE ${where.join(' AND ')}
    ORDER BY last_message_at DESC
    LIMIT 500
  `;

  const cards = await pool.query(cardsQuery, params);

  // Agrupar por stage
  const byStage = {};
  for (const card of cards.rows) {
    byStage[card.stage] ??= [];
    byStage[card.stage].push(card);
  }

  const columns = [
    { key: 'conversation', name: 'Conversación' },
    { key: 'quote',        name: 'Cotización' },
    { key: 'approved',     name: 'Aprobada' },
    { key: 'payment',      name: 'Conciliar pago' },
    { key: 'dispatch',     name: 'Despacho' },
    { key: 'closed',       name: 'Cerradas' }
  ].map(col => ({
    ...col,
    count: (byStage[col.key] || []).length,
    total_usd: (byStage[col.key] || []).reduce((sum, c) => sum + (parseFloat(c.total_usd) || 0), 0)
  }));

  return sendSuccess(res, { columns, cards: cards.rows });
}
```

**Criterios:**
- [ ] Filtros combinables
- [ ] Respuesta < 300ms con 1000 órdenes
- [ ] Tests

---

### BE-3.3 · Máquina de transiciones + endpoint `advance-stage` (2 días)

**Objetivo:** permitir al vendedor/supervisor forzar transición manual cuando el flujo natural falla.

**Regla:** transiciones naturales (bot concilia pago → `payment_status = approved`) siguen siendo automáticas. Este endpoint es para casos de excepción.

**Transiciones legales:**

```javascript
const LEGAL_TRANSITIONS = {
  conversation: ['quote'],
  quote: ['approved', 'conversation'],  // puede retroceder si cliente rechaza
  approved: ['payment', 'conversation'], // retroceder = cliente canceló
  payment: ['dispatch', 'approved'],
  dispatch: ['closed', 'payment'],       // retroceder = devolución
  closed: []  // terminal
};
```

**Endpoint:**

```
PATCH /api/sales/orders/:orderId/advance-stage
Body: { "to_stage": "dispatch", "reason": "Pago confirmado manualmente" }
```

**Lógica:**

```javascript
async function advanceStage(req, res) {
  const { orderId } = req.params;
  const { to_stage, reason } = req.body;
  const userId = req.user.id;

  if (!reason) return sendError(res, 400, 'reason obligatorio');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener estado actual
    const current = await client.query(
      `SELECT stage FROM v_sales_pipeline WHERE order_id = $1`, [orderId]
    );
    if (current.rowCount === 0) {
      return sendError(res, 404, 'Orden no encontrada');
    }
    const fromStage = current.rows[0].stage;

    // 2. Validar transición
    if (!LEGAL_TRANSITIONS[fromStage]?.includes(to_stage)) {
      return sendError(res, 400,
        `Transición inválida: ${fromStage} → ${to_stage}`);
    }

    // 3. Aplicar cambio (depende del to_stage)
    // Esto mapea to_stage a cambios en payment_status/fulfillment_status/approval_status
    const changes = mapStageToChanges(to_stage);
    const setClauses = Object.keys(changes)
      .map((k, i) => `${k} = $${i + 2}`)
      .join(', ');

    await client.query(
      `UPDATE sales_orders SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
      [orderId, ...Object.values(changes)]
    );

    // 4. Auditar en sales_order_history (tabla existente)
    await client.query(
      `INSERT INTO sales_order_history
       (order_id, from_status, to_status, changed_by, motivo, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orderId,
        fromStage,
        to_stage,
        userId.toString(),
        reason,
        JSON.stringify({ actor: 'operator', source: 'kanban_manual' })
      ]
    );

    await client.query('COMMIT');
    return sendSuccess(res, { advanced: true, from: fromStage, to: to_stage });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function mapStageToChanges(toStage) {
  // Mapa stage virtual → columnas reales
  // Ajustar según lógica real del negocio
  switch (toStage) {
    case 'payment':
      return { payment_status: 'pending' };
    case 'dispatch':
      return { payment_status: 'approved', fulfillment_status: 'preparing' };
    case 'closed':
      return { fulfillment_status: 'delivered' };
    case 'conversation':
    case 'approved':
    case 'quote':
      throw new Error(`Retroceso a ${toStage} requiere lógica manual adicional`);
    default:
      throw new Error(`Stage no mapeado: ${toStage}`);
  }
}
```

**Criterios:**
- [ ] Transiciones legales permitidas, ilegales rechazadas con 400
- [ ] Audit log en `sales_order_history` siempre
- [ ] Retrocesos (stage, conversation) quedan como `TODO` para Sprint 4-5
- [ ] Tests de happy path + transición inválida

---

### BE-3.4 · Tabla `bot_corrections` (correcciones estructuradas) (1 día)

**Objetivo:** separar "marcar acción incorrecta" (flag simple) de "corrección estructurada" (qué debió hacer el bot).

**Archivo:** `sql/20260517_sprint3_bot_corrections.sql`

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS bot_corrections (
  id BIGSERIAL PRIMARY KEY,
  bot_action_id BIGINT NOT NULL REFERENCES bot_actions(id) ON DELETE CASCADE,
  supervisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  correction_type TEXT NOT NULL,
  -- valores: 'intent_wrong', 'entities_wrong', 'response_wrong',
  --         'should_have_handed_off', 'cotizacion_wrong',
  --         'payment_match_wrong', 'other'
  original_output JSONB NOT NULL,
  -- snapshot de lo que el bot hizo (copia del output_result)
  corrected_output JSONB NOT NULL,
  -- lo que el supervisor dice que debió hacer
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_corrections_action
  ON bot_corrections (bot_action_id);

CREATE INDEX IF NOT EXISTS idx_bot_corrections_type
  ON bot_corrections (correction_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_corrections_recent
  ON bot_corrections (created_at DESC);

COMMIT;
```

**Uso esperado:**

Cuando el supervisor marca una acción como incorrecta (BE-2.6 de Sprint 2), si además quiere dejar "la corrección buena", crea un registro en `bot_corrections`. Ejemplo:

```javascript
// Acción original del bot
{
  action_type: 'message_classified',
  output_result: {
    intent: 'saludo',
    confidence: 0.7
  }
}

// Corrección del supervisor
{
  correction_type: 'intent_wrong',
  original_output: { intent: 'saludo', confidence: 0.7 },
  corrected_output: { intent: 'consulta_producto', confidence: 1.0 },
  note: 'El mensaje "hola tienen pastillas?" es consulta clara, no saludo'
}
```

**Este dataset** se usa en Sprint 6 y futuros re-evaluaciones de ADR-003 para medir calidad real del bot.

**Criterios:**
- [ ] Tabla creada
- [ ] Relación con `bot_actions` garantizada

---

### BE-3.5 · Endpoint `POST /api/sales/bot-actions/:id/correct` (1 día)

**Ruta:**

```
POST /api/sales/bot-actions/:id/correct
Body: {
  "correction_type": "intent_wrong",
  "corrected_output": { "intent": "consulta_producto", "confidence": 1.0 },
  "note": "Era consulta, no saludo"
}
```

**Lógica:**

```javascript
async function correctBotAction(req, res) {
  const { id } = req.params;
  const { correction_type, corrected_output, note } = req.body;
  const supervisorId = req.user.id;

  // Validar que la acción existe
  const action = await pool.query(
    'SELECT id, output_result FROM bot_actions WHERE id = $1', [id]
  );
  if (action.rowCount === 0) return sendError(res, 404);

  // Insertar corrección
  await pool.query(
    `INSERT INTO bot_corrections
     (bot_action_id, supervisor_id, correction_type, original_output, corrected_output, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, supervisorId, correction_type, action.rows[0].output_result, corrected_output, note]
  );

  // Marcar la acción como incorrecta también
  await pool.query(
    `UPDATE bot_actions
     SET is_reviewed = TRUE, is_correct = FALSE,
         reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2`,
    [supervisorId, id]
  );

  return sendSuccess(res, { corrected: true });
}
```

**Criterios:**
- [ ] Corrección persiste correctamente
- [ ] La acción queda marcada como incorrecta
- [ ] Tests

---

### BE-3.6 · Performance · índices en `sales_orders` (0.5 día)

**Objetivo:** asegurar que el Kanban responde rápido con volumen real.

```sql
BEGIN;

CREATE INDEX IF NOT EXISTS idx_sales_orders_channel_updated
  ON sales_orders (channel_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_orders_seller_updated
  ON sales_orders (seller_id, updated_at DESC)
  WHERE seller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_conversation
  ON sales_orders (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_payment_fulfillment
  ON sales_orders (payment_status, fulfillment_status);

COMMIT;
```

**Criterios:**
- [ ] Índices creados sin bloquear producción
- [ ] `EXPLAIN` del query del Kanban usa los índices

---

## Tickets frontend

### FE-3.1 · Página `/ventas/tablero` + layout (1 día)

**Ruta:** `src/app/(features)/ventas/tablero/page.tsx`

**Layout:**
- Header con título "Tablero de ventas"
- Toolbar con filtros (canal, vendedor, período)
- Tablero Kanban (grid de 6 columnas)
- Lateral opcional: panel de detalle al hacer clic en tarjeta

**Auth:** respetar `FeaturesAuthGate` existente.

---

### FE-3.2 · Componente `<KanbanBoard>` reutilizable (2 días)

**Archivo:** `src/components/kanban/KanbanBoard.tsx`

**Dependencia:** `@hello-pangea/dnd` (ya está en package.json según auditoría; si no, agregar).

**API del componente:**

```tsx
interface KanbanBoardProps<T> {
  columns: { key: string; name: string; count: number; total_usd?: number }[];
  cards: T[];
  getCardKey: (card: T) => string;
  getCardColumn: (card: T) => string;
  onCardMove: (card: T, fromColumn: string, toColumn: string) => Promise<void>;
  renderCard: (card: T) => React.ReactNode;
}

export function KanbanBoard<T>({ columns, cards, getCardKey, getCardColumn, onCardMove, renderCard }: KanbanBoardProps<T>) {
  // ... DragDropContext de @hello-pangea/dnd
}
```

**Criterios:**
- [ ] Drag funciona en desktop
- [ ] En mobile, fallback = tap en card + bottom sheet con lista de columnas destino
- [ ] Accesibilidad: keyboard navigation funcional

---

### FE-3.3 · Componente `<SalesCard>` (1.5 días)

**Tarjeta para el Kanban:**

```tsx
<SalesCard>
  <Header>
    <ChannelBadge channel={card.source_type} />
    <OrderId>#CJ-{card.order_id || card.latest_quote_id}</OrderId>
    {card.has_active_exception && <ExceptionBadge severity="high" />}
  </Header>
  <Customer>
    <Avatar initials={initials(card.customer_name)} />
    <Name>{card.customer_name}</Name>
  </Customer>
  <Amount>USD {card.total_usd}</Amount>
  <Footer>
    <Seller>{card.seller_name || 'Sin asignar'}</Seller>
    <TimeAgo>{card.last_message_at}</TimeAgo>
  </Footer>
</SalesCard>
```

**Estilos por estado:**
- Tarjeta normal: borde gris
- Con excepción: borde rojo
- Stage `closed`: opacity 60%

**Criterios:**
- [ ] Renderiza todos los datos del card
- [ ] Click abre panel de detalle
- [ ] Badge de canal con color correcto

---

### FE-3.4 · Toolbar de filtros (1 día)

**Chips:**
- Canal (todos · WhatsApp · MercadoLibre · E-commerce · Mostrador · Fuerza de venta)
- Vendedor (todos · [lista de usuarios])
- Período (hoy · 7 días · 30 días · custom)

**Sincronización con URL:**

```
/ventas/tablero?channel=wa&seller=3&from=2026-04-01
```

Al cambiar filtros, la URL se actualiza (sharable).

**Criterios:**
- [ ] Filtros funcionan y combinables
- [ ] URL sharable
- [ ] Al cargar con URL de filtros, se aplican al inicio

---

### FE-3.5 · Optimistic UI + rollback (1 día)

**Flujo:**

1. Usuario arrastra card de "Aprobada" a "Despacho"
2. Card se mueve visualmente inmediatamente
3. Mientras tanto, `PATCH /api/sales/orders/:id/advance-stage`
4. Si 200: actualizar datos del card con response
5. Si 400/500: revertir posición + toast con error

**Criterios:**
- [ ] UX sin latencia aparente (optimistic)
- [ ] Rollback correcto si backend falla
- [ ] Toast explicativo si transición ilegal

---

### FE-3.6 · Panel lateral de detalle del card (1.5 días)

**Al clic en card del Kanban, abrir panel derecho con:**

1. Info completa del cliente
2. Timeline de la orden (de `sales_order_history`)
3. Items de la orden
4. Acciones rápidas:
   - "Abrir chat" → navega a `/bandeja?chat=X`
   - "Forzar etapa" → modal con select de etapas legales
   - "Ver ficha del cliente" → navega a `/clientes/[id]/360` (Sprint 6)

**Criterios:**
- [ ] Panel slide-in desde la derecha
- [ ] Datos cargan < 500ms
- [ ] Cerrar con ESC o click fuera

---

### FE-3.7 · Polling del pipeline (0.5 día)

**Frecuencia:** cada 30 segundos.

**Pausar cuando pestaña no visible** (Page Visibility API):

```typescript
useEffect(() => {
  let intervalId: NodeJS.Timeout | null = null;

  function start() {
    intervalId = setInterval(fetchPipeline, 30000);
  }
  function stop() {
    if (intervalId) clearInterval(intervalId);
  }

  function onVisibilityChange() {
    if (document.hidden) stop();
    else start();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  start();
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stop();
  };
}, []);
```

**Criterios:**
- [ ] Actualiza cada 30s cuando pestaña activa
- [ ] Pausa cuando oculta
- [ ] No genera requests innecesarios

---

### FE-3.8 · Botón "Corregir" en panel de acciones del bot (1 día)

**Objetivo:** en el panel lateral de acciones del bot (FE-2.4 de Sprint 2), agregar botón "Corregir" que abra modal estructurado.

**Modal:**

```tsx
<CorrectActionModal action={action}>
  <Select name="correction_type">
    <option value="intent_wrong">Intención incorrecta</option>
    <option value="entities_wrong">Datos extraídos incorrectos</option>
    <option value="response_wrong">Respuesta incorrecta</option>
    <option value="should_have_handed_off">Debió pasar a humano</option>
    <option value="cotizacion_wrong">Cotización incorrecta</option>
    <option value="other">Otro</option>
  </Select>

  {/* Según correction_type, renderizar editor apropiado */}
  {correctionType === 'intent_wrong' && (
    <IntentEditor
      original={action.output_result.intent}
      onChange={setCorrectedIntent}
    />
  )}

  <Textarea
    placeholder="Nota explicativa (opcional)"
    value={note}
    onChange={e => setNote(e.target.value)}
  />

  <Button onClick={submit}>Enviar corrección</Button>
</CorrectActionModal>
```

**Submit:**

```
POST /api/sales/bot-actions/:id/correct
```

**Criterios:**
- [ ] Modal se abre desde el panel de acciones
- [ ] Cada tipo de corrección tiene editor apropiado
- [ ] Al enviar, la acción queda marcada como incorrecta y aparece la corrección guardada

---

## Criterios de aceptación globales del Sprint 3

- [ ] Backend: 6 tickets completados
- [ ] Frontend: 8 tickets completados
- [ ] Smoke: un vendedor ve el Kanban con órdenes reales, arrastra una de Aprobada a Despacho, cambio persiste, historial se registra
- [ ] Smoke supervisor: supervisor marca una acción del bot como incorrecta con corrección estructurada, queda en `bot_corrections`
- [ ] Performance: Kanban carga < 500ms con 500 tarjetas

---

## Orden sugerido

Día 1-2: BE-3.1 (vista) + BE-3.6 (índices)
Día 3: BE-3.2 (endpoint pipeline)
Día 4: BE-3.3 (advance-stage) + FE-3.1 (página base)
Día 5-6: FE-3.2 (KanbanBoard) + FE-3.3 (SalesCard)
Día 7: FE-3.4 + FE-3.5 + FE-3.7
Día 8: BE-3.4 + BE-3.5 (corrections)
Día 9: FE-3.6 (panel detalle) + FE-3.8 (botón corregir)
Día 10: tests + docs + demo

---

## Al cerrar Sprint 3

Pasar a `prompt-sprint-4.md`. Los tickets de automatización de cotización se apoyan fuertemente en la infraestructura que construiste aquí.
