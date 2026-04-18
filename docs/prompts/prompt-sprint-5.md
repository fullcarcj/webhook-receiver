# Prompt · Sprint 5 · v3 · Conciliación omnicanal sobre motor existente

**Destinatario:** Cursor Backend + Frontend
**Duración:** 2 semanas
**Pre-requisitos:** Sprint 4 completado. **ADR-006 + amendment, ADR-007 + amendment, ADR-008** firmados y commiteados. ADR-002 firmado antes del día 3.

**Versión:** v3 · incorpora motor existente + moneda canónica + segregación de aprobación + política omnicanal. Reemplaza v2.

---

## Filosofía del sprint · tres verdades no negociables

1. **Conservar lo que funciona.** `reconciliationService.js` con L1/L2/L3 + `payment_attempts` con Gemini + `reconciliationWorker.js` event-driven se **preservan**. No se reescriben.

2. **Agregar quirúrgicamente lo que falta.** Moneda canónica (BE-5.0), filtros de canal (BE-5.10), gate de caja solo en L3 (BE-5.8), alertas post-match (BE-5.11).

3. **No construir lo que no cabe.** Divisa automatizada queda fuera. Backfill histórico solo CH-3 (trivial). Split payment se apoya en `sale_payments` existente.

---

## Reglas duras

1. **No tocar lógica core de `reconciliationService.js`** más allá de lo especificado. L1/L2/L3 siguen como están.
2. **`total_amount_bs` es la moneda canónica** (ADR-008). Nunca comparar `order_total_amount` directamente contra banco.
3. **`channel_id IN (2, 5)`** es el filtro obligatorio del motor (ADR-007 regla 1).
4. **L1 y L2 auto-aprueban, L3 pasa por caja** (ADR-006 amendment).
5. Migraciones aditivas con `IF NOT EXISTS`. Reversibles.
6. Si algo del repo contradice un prompt, parar y preguntar.

---

## Ticket BE-5.0 · Moneda canónica (pre-requisito · 2 días)

**Este ticket bloquea todos los demás del sprint.** Si `total_amount_bs` no es canónico, nada del resto tiene sentido.

### Tarea 1 · Backfill

```sql
BEGIN;

-- Verificación previa
SELECT channel_id, COUNT(*) AS orders_sin_total_bs
FROM sales_orders
WHERE total_amount_bs IS NULL
GROUP BY channel_id;

-- Backfill CH-3 (ML Venezuela, ya está en VES)
UPDATE sales_orders
SET total_amount_bs = order_total_amount,
    exchange_rate_bs_per_usd = COALESCE(exchange_rate_bs_per_usd, 1),
    rate_date = COALESCE(rate_date, DATE(created_at))
WHERE channel_id = 3
  AND total_amount_bs IS NULL
  AND order_total_amount IS NOT NULL;

-- Verificación post-backfill
SELECT channel_id, COUNT(*) FILTER (WHERE total_amount_bs IS NULL) AS sin_bs,
                    COUNT(*) AS total
FROM sales_orders
GROUP BY channel_id;

COMMIT;
```

**Si el count post-backfill muestra órdenes sin `total_amount_bs` en canales 1/2/4/5**, significa que hay datos históricos no esperados. Parar y documentar antes de continuar.

### Tarea 2 · Populate al crear órdenes

Modificar los handlers de creación en cada canal:

**CH-3 ML webhook** (probablemente `src/handlers/mlWebhookHandler.js` o similar):

```javascript
// Al crear sales_order desde webhook ML
const order = {
  // ...campos existentes
  order_total_amount: mlData.total_amount,  // ya es VES
  total_amount_bs: mlData.total_amount,     // mismo valor (es VES nativo)
  exchange_rate_bs_per_usd: 1,              // ML Venezuela = Bs
  rate_date: new Date().toISOString().split('T')[0]
};
```

**CH-2 WhatsApp manual + CH-5 Fuerza de ventas** (donde el vendedor ingresa la orden):

```javascript
// El vendedor ingresa monto + moneda
// Si moneda = 'USD', convertir; si moneda = 'VES', copiar directo

async function createManualOrder({ totalAmount, currency, ...rest }) {
  let totalAmountBs, exchangeRate;

  if (currency === 'VES' || currency === 'Bs') {
    totalAmountBs = totalAmount;
    exchangeRate = 1;
  } else if (currency === 'USD' || !currency) {  // default USD
    exchangeRate = await getCurrentBcvRate();
    totalAmountBs = totalAmount * exchangeRate;
  } else {
    throw new Error(`Moneda no soportada: ${currency}`);
  }

  return db.query(`
    INSERT INTO sales_orders
      (..., order_total_amount, total_amount_bs, exchange_rate_bs_per_usd, rate_date)
    VALUES (..., $N, $N+1, $N+2, CURRENT_DATE)
  `, [..., totalAmount, totalAmountBs, exchangeRate]);
}
```

**CH-1 Mostrador** (POS): ajustar el punto de creación al cerrar venta para poblar las 3 columnas.

**Helper común:** crear `src/lib/currency.js` con `getCurrentBcvRate()` que lee de `daily_exchange_rates` la tasa del día actual.

### Tarea 3 · Modificar motor de conciliación

Archivo: `src/services/reconciliationService.js`

Cambiar la consulta inicial de órdenes candidatas:

```sql
-- Antes:
WHERE so.status = 'pending'
  AND so.order_total_amount IS NOT NULL
  AND so.order_total_amount > 0

-- Después:
WHERE so.payment_status = 'pending'
  AND so.channel_id IN (2, 5)              -- ADR-007 regla 1
  AND so.total_amount_bs IS NOT NULL        -- ADR-008 regla 6
  AND so.total_amount_bs > 0
```

Cambiar cada `findBestMatch` / `checkAmount` para comparar contra `total_amount_bs` en lugar de `order_total_amount`:

```javascript
// Antes:
const amountDiff = Math.abs(order.total_orden - bankStatement.amount);

// Después:
const amountDiff = Math.abs(order.total_amount_bs - bankStatement.amount);
```

### Tarea 4 · Tests

```javascript
describe('BE-5.0 moneda canónica', () => {
  test('orden CH-3 ML (VES nativo) matchea directo', () => {
    // total_amount_bs = order_total_amount = 6633.98
    // bank_amount = 6633.98 → L1 match
  });

  test('orden CH-5 USD convertida matchea banco Bs equivalente', () => {
    // order_total_amount = 100 USD, exchange_rate = 34.5
    // total_amount_bs = 3450
    // bank_amount = 3450 → L1 match
  });

  test('orden con total_amount_bs = NULL no es candidata', () => {
    // no entra en el query
  });

  test('orden CH-3 (canal no whitelist) no es candidata', () => {
    // filtro channel_id IN (2, 5) la excluye
  });
});
```

**Criterios:**
- [ ] Backfill exitoso para CH-3
- [ ] Órdenes nuevas se crean con `total_amount_bs` poblado en todos los canales
- [ ] Motor usa `total_amount_bs` y filtra por canal
- [ ] Tests pasan
- [ ] Smoke test: crear orden simulada USD 100, transacción Bs 3450 → matchea L1

---

## Ticket BE-5.8 · Gate de caja en L3 (2 días)

### Tabla `payment_match_proposals`

```sql
BEGIN;

CREATE TYPE payment_proposal_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE IF NOT EXISTS payment_match_proposals (
  id BIGSERIAL PRIMARY KEY,
  bank_statement_id BIGINT REFERENCES bank_statements(id) ON DELETE CASCADE,
  payment_attempt_id BIGINT REFERENCES payment_attempts(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  proposed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_note TEXT,
  status payment_proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  previous_proposal_id BIGINT REFERENCES payment_match_proposals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (bank_statement_id IS NOT NULL OR payment_attempt_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_proposals_one_pending_per_statement
  ON payment_match_proposals (bank_statement_id)
  WHERE status = 'pending' AND bank_statement_id IS NOT NULL;

CREATE UNIQUE INDEX idx_proposals_one_pending_per_attempt
  ON payment_match_proposals (payment_attempt_id)
  WHERE status = 'pending' AND payment_attempt_id IS NOT NULL;

CREATE INDEX idx_proposals_pending_by_date
  ON payment_match_proposals (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX idx_proposals_by_proposer
  ON payment_match_proposals (proposed_by, created_at DESC);

COMMIT;
```

**Nota:** la propuesta referencia **bank_statement o payment_attempt** (uno u otro, depende de la fuente). El CHECK garantiza que al menos uno esté poblado.

### Columna `approval_state` en `bank_statements` y `payment_attempts`

```sql
BEGIN;

ALTER TABLE bank_statements
  ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'unmatched';

ALTER TABLE bank_statements
  DROP CONSTRAINT IF EXISTS bank_statements_approval_state_check;

ALTER TABLE bank_statements
  ADD CONSTRAINT bank_statements_approval_state_check
  CHECK (approval_state IN (
    'unmatched', 'auto_approved', 'pending_approval', 'approved', 'rejected_cycle'
  ));

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'unmatched';

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_approval_state_check;

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_approval_state_check
  CHECK (approval_state IN (
    'unmatched', 'auto_approved', 'pending_approval', 'approved', 'rejected_cycle'
  ));

COMMIT;
```

**Pre-verificación obligatoria antes de ejecutar:**

```sql
-- ¿La columna ya existe con otros valores?
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('bank_statements', 'payment_attempts')
  AND column_name = 'approval_state';

-- Si existe, ver valores actuales
SELECT DISTINCT approval_state FROM bank_statements;
SELECT DISTINCT approval_state FROM payment_attempts;
```

Si hay valores fuera del enum propuesto, migrar antes.

### Integración con motor existente

Modificar `reconciliationService.js`: cuando el motor clasifica un match como `L3 / manual_review`, además de escribir en `reconciliation_log`:

```javascript
// Al clasificar como L3:
await client.query(`
  UPDATE bank_statements
  SET approval_state = 'pending_approval'
  WHERE id = $1
`, [bankStatementId]);

// O si la fuente es payment_attempt:
await client.query(`
  UPDATE payment_attempts
  SET approval_state = 'pending_approval'
  WHERE id = $1
`, [paymentAttemptId]);
```

Los matches L1/L2 pasan a `approval_state = 'auto_approved'` y la orden a `payment_status = 'approved'` (comportamiento actual preservado).

### Endpoints

```
POST /api/sales/payments/propose-match
  Body: {
    bank_statement_id?: number,
    payment_attempt_id?: number,
    order_id: number,
    note?: string
  }
  Auth: permiso 'sales.propose_match'

GET  /api/sales/payment-proposals?status=pending&limit=50
  Auth: permiso 'finance.approve_payment' o 'sales.propose_match'

GET  /api/sales/payment-proposals/:id
  Auth: mismo que GET list

POST /api/sales/payment-proposals/:id/approve
  Auth: permiso 'finance.approve_payment'

POST /api/sales/payment-proposals/:id/reject
  Body: { reason: string (min 10 chars) }
  Auth: permiso 'finance.approve_payment'
```

**Lógica de `propose-match`:**

```javascript
async function proposeMatch(req, res) {
  const { bank_statement_id, payment_attempt_id, order_id, note } = req.body;
  const userId = req.user.id;

  if (!bank_statement_id && !payment_attempt_id) {
    return sendError(res, 400, 'Debe especificar bank_statement_id o payment_attempt_id');
  }
  if (!await hasPermission(userId, 'sales.propose_match')) {
    return sendError(res, 403);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validar que la fuente está unmatched
    if (bank_statement_id) {
      const bs = await client.query(
        `SELECT approval_state FROM bank_statements WHERE id = $1`,
        [bank_statement_id]
      );
      if (bs.rows[0]?.approval_state !== 'unmatched') {
        return sendError(res, 409, `Statement en estado ${bs.rows[0]?.approval_state}`);
      }
    }
    // (similar para payment_attempt_id)

    // Crear propuesta
    const p = await client.query(`
      INSERT INTO payment_match_proposals
        (bank_statement_id, payment_attempt_id, order_id, proposed_by, proposed_note, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING id
    `, [bank_statement_id, payment_attempt_id, order_id, userId, note]);

    // Marcar fuente como pending_approval
    if (bank_statement_id) {
      await client.query(
        `UPDATE bank_statements SET approval_state = 'pending_approval' WHERE id = $1`,
        [bank_statement_id]
      );
    }
    if (payment_attempt_id) {
      await client.query(
        `UPDATE payment_attempts SET approval_state = 'pending_approval' WHERE id = $1`,
        [payment_attempt_id]
      );
    }

    // Log en bot_actions
    await botActionsService.log({
      chatId: null,
      actionType: 'payment_proposal_created',
      inputContext: { bank_statement_id, payment_attempt_id, order_id },
      outputResult: { proposalId: p.rows[0].id, proposedBy: userId },
      provider: 'human'
    }, client);

    await client.query('COMMIT');
    return sendSuccess(res, {
      proposalId: p.rows[0].id,
      status: 'pending',
      message: 'Propuesta enviada a caja'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

**Lógica de `approve` y `reject`:** similar al Sprint 5 v2 pero adaptada para referenciar `bank_statements` o `payment_attempts` según la propuesta. Ver v2 como referencia, mantener el espíritu (approve pasa orden a approved si full match, reject vuelve fuente a unmatched + notifica vendedor + crea excepción).

**Criterios:**
- [ ] Tabla + columnas creadas
- [ ] Motor marca `pending_approval` en L3
- [ ] Endpoints funcionan con permisos correctos
- [ ] Unique index previene 2 propuestas pending para misma fuente
- [ ] Tests de approve + reject + casos borde

---

## Ticket BE-5.9 · Permisos (0.5 día)

Seeds en la tabla canónica del repo (según el backend: `role_permissions`, no `user_permissions`):

```sql
-- Verificar estructura real primero
SELECT table_name FROM information_schema.tables
WHERE table_name ILIKE '%permission%' OR table_name ILIKE '%role%';
```

Luego seeds según el schema real:

```sql
BEGIN;

INSERT INTO permissions (key, description) VALUES
  ('sales.propose_match', 'Proponer asociación de pago a orden'),
  ('finance.approve_payment', 'Aprobar o rechazar propuestas de pago')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'sales.propose_match' FROM roles WHERE key IN ('seller', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'finance.approve_payment' FROM roles WHERE key IN ('admin')
-- Si no existe rol 'cashier' aún, asignar solo a admin temporalmente
ON CONFLICT DO NOTHING;

COMMIT;
```

Documentar en `docs/PERMISSIONS.md`.

**Criterios:**
- [ ] Permisos creados
- [ ] Asignados a roles correctos
- [ ] `hasPermission(userId, key)` los reconoce

---

## Ticket BE-5.10 · Filtro de canal ya aplicado (0 días)

El filtro `channel_id IN (2, 5)` ya está en BE-5.0 tarea 3. Este ticket no existe como separado, se hace con BE-5.0. Se deja mencionado explícitamente en el prompt para trazabilidad con ADR-007 regla 1.

---

## Ticket BE-5.11 · Alertas post-match L1/L2 (1 día)

**Objetivo:** cuando L1 o L2 auto-aprueban, alertar a vendedor asignado + caja (sin mensaje al cliente).

### Tabla de notificaciones in-app

Si no existe, crear:

```sql
CREATE TABLE IF NOT EXISTS in_app_notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  related_entity_type TEXT,
  related_entity_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_unread
  ON in_app_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
```

### Modificación al motor · post L1/L2

```javascript
// En reconciliationService.js, después de aplicar match L1/L2 exitoso:

// 1. Identificar destinatarios
const order = await getOrder(orderId);
const sellerId = order.seller_id;
const cashierIds = await getUsersByPermission('finance.approve_payment');
const recipients = new Set([sellerId, ...cashierIds].filter(Boolean));

// 2. Enviar notificación
for (const userId of recipients) {
  await client.query(`
    INSERT INTO in_app_notifications
      (user_id, type, title, body, related_entity_type, related_entity_id)
    VALUES ($1, $2, $3, $4, 'sales_order', $5)
  `, [
    userId,
    'match_auto_approved',
    `Pago conciliado automáticamente (${matchLevel})`,
    `Orden #${orderId} · ${formatMoney(order.total_amount_bs)} Bs`,
    orderId
  ]);
}
```

### Endpoints de notificaciones

```
GET  /api/notifications?unread=true
POST /api/notifications/:id/read
POST /api/notifications/read-all
```

**Criterios:**
- [ ] Tabla creada
- [ ] Vendedor asignado recibe notificación
- [ ] Cada usuario con `finance.approve_payment` recibe notificación
- [ ] Cliente NO recibe mensaje automático (confirmar en tests)

---

## Ticket BE-5.12 · Channel payment config (0.5 día)

Ventanas configurables por canal:

```sql
CREATE TABLE IF NOT EXISTS channel_payment_config (
  channel_id SMALLINT PRIMARY KEY REFERENCES sales_channels(id),
  matching_window_days SMALLINT NOT NULL DEFAULT 3,
  enabled_for_reconciliation BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeds según ADR-007
INSERT INTO channel_payment_config
  (channel_id, matching_window_days, enabled_for_reconciliation)
VALUES
  (2, 3, TRUE),   -- CH-02 WhatsApp/Redes
  (5, 7, TRUE)    -- CH-05 Fuerza de ventas
ON CONFLICT (channel_id) DO NOTHING;
```

El motor lee `matching_window_days` según el `channel_id` de la orden para aplicar ventana correspondiente en lugar del hardcoded `2 días`.

**Criterios:**
- [ ] Tabla + seeds
- [ ] Motor lee ventana del channel correcto
- [ ] Test: orden CH-5 aún matchea 7 días después; orden CH-2 no matchea después de 3 días

---

## Ticket BE-5.13 · `channel_id` en `payment_attempts` (0.5 día)

Columna + populate en `media.js`:

```sql
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS channel_id SMALLINT REFERENCES sales_channels(id);

-- Backfill: todos los histórico son CH-02 (Wasender-only pipeline)
UPDATE payment_attempts
SET channel_id = 2
WHERE channel_id IS NULL;
```

En `media.js` al crear un `payment_attempt`:

```javascript
// Simplificación: hoy todos vienen de CH-02 (Wasender)
const channelId = 2;

await db.query(`
  INSERT INTO payment_attempts (..., channel_id)
  VALUES (..., $N)
`, [..., channelId]);
```

Si en el futuro llega un webhook ML con comprobante, agregar lógica de identificación.

**Criterios:**
- [ ] Columna creada y backfilleada
- [ ] Código populla correctamente
- [ ] Motor filtra compatible con `channel_id IN (2, 5)` también en payment_attempts

---

## Tickets frontend

### FE-5.1 · Vista `/ventas/conciliacion` · adaptada (2 días)

Lista de `bank_statements` + `payment_attempts` sin match (donde `approval_state = 'unmatched'`), con filtros.

**Badges por estado:**

- `unmatched` → gris "Sin asociar"
- `auto_approved` → morado "🔄 Auto-aprobada"
- `pending_approval` → naranja "⏳ En revisión caja"
- `approved` (matched manual) → azul "👤 Aprobada por caja"
- `rejected_cycle` → rojo "✗ Rechazada, reasignable"

**Acción "Proponer match"** en items `unmatched`: abre modal (FE-5.2).

### FE-5.2 · Modal "Proponer a caja" (1.5 días)

- Título: **"Proponer asociación a caja"**
- Texto: "Esta propuesta será revisada por caja antes de aprobar."
- Botón: **"Proponer a caja"** (no "Confirmar match")
- Búsqueda de orden candidata (filtro `channel_id IN (2, 5)`, `payment_status = 'pending'`)
- Tras envío: toast "Propuesta enviada" + refrescar lista

### FE-5.3 · Indicadores de match (0.5 día)

Los 5 badges arriba, aplicados en:
- Listado de conciliación
- Ficha de orden
- Kanban cards

### FE-5.4 · Health de adaptadores (1 día)

Sin cambios respecto a v2. Indicador de salud de Banesco monitor.

### FE-5.5 · Vista `/ventas/aprobacion-pagos` (2 días)

Para usuarios con permiso `finance.approve_payment`. Lista de propuestas `pending`:

- Tarjetas con info completa: propuesta + statement/attempt + orden + vendedor + nota
- Link "Ver chat" → `/bandeja?chat={conversation_id}`
- Botón **Aprobar** (one-click)
- Botón **Rechazar** (abre modal para ingresar razón, min 10 chars)
- Polling cada 30s

### FE-5.6 · Notificaciones in-app (1 día)

Campana de notificaciones en topbar de `/bandeja` (y eventualmente global):

- Badge con contador no leídas
- Dropdown con lista
- Tipos soportados: `match_auto_approved`, `proposal_approved`, `proposal_rejected`
- Al click en rechazada → abrir modal pre-populado para re-proponer

---

## Criterios de aceptación globales · Sprint 5 v3

- [ ] **Backend BE-5.0:** motor usa `total_amount_bs`, backfill CH-3 ejecutado, populate en todos los canales
- [ ] **Backend BE-5.8:** tabla proposals + approval_state + endpoints funcionan
- [ ] **Backend BE-5.9:** permisos creados y asignados
- [ ] **Backend BE-5.11:** alertas post-match L1/L2 a vendedor + caja (cliente NO recibe mensaje)
- [ ] **Backend BE-5.12:** ventana configurable por canal
- [ ] **Backend BE-5.13:** `channel_id` en `payment_attempts`
- [ ] **Frontend:** los 6 tickets completos
- [ ] **Smoke test A (L1 auto):** crear orden CH-5 USD 100 → transacción Banesco Bs 3450 → L1 match → notificación a vendedor + caja, cliente no recibe mensaje automático
- [ ] **Smoke test B (L3 manual):** comprobante WA sin match → aparece en `/ventas/conciliacion` → vendedor propone → aparece en `/ventas/aprobacion-pagos` → caja aprueba → orden pasa a payment_status=approved
- [ ] **Smoke test C (rechazo):** propuesta → caja rechaza con razón → statement vuelve unmatched + notificación al vendedor + excepción creada
- [ ] **Smoke test D (filtro canal):** orden CH-3 ML nunca es candidata del motor (test explícito)
- [ ] **Smoke test E (split payment):** orden total_amount_bs = 6900, llega banco Bs 3450 (50%), queda como parcial, vendedor registra Zelle USD 50 manualmente, caja aprueba, orden cierra

---

## Orden sugerido

Día 1-2: **BE-5.0** (bloquea todo lo demás)
Día 3: BE-5.9 + BE-5.12 + BE-5.13 (infraestructura)
Día 4-5: BE-5.8 (propuestas + approval_state + endpoints)
Día 6: BE-5.11 (alertas)
Día 7-8: FE-5.1 + FE-5.3 + FE-5.4
Día 9: FE-5.2 + FE-5.5
Día 10: FE-5.6 + tests + smoke + docs

---

## Al cerrar Sprint 5 v3

Pasar a `prompt-sprint-6.md` con dos ajustes de referencia:
- El dashboard supervisor consume métricas desde `payment_match_proposals` (proposals pending, rejection rate)
- La ficha 360° del cliente muestra pagos históricos con `total_amount_bs` para suma homogénea en Bs, opcional `order_total_amount` + moneda para ver original

---

## Cambios respecto a Sprint 5 v2

**Tickets eliminados:** BE-5.1 (interfaz bank source), BE-5.2 (BDV adapter fuera de scope v3), BE-5.4 completo (matching nuevo), BE-5.5 (orquestador) — **todos ya existen en el motor actual**.

**Tickets nuevos:** BE-5.0 (moneda canónica), BE-5.11 (alertas), BE-5.12 (config por canal), BE-5.13 (channel_id en attempts).

**Tickets modificados:** BE-5.3 ampliado a `approval_state` en ambas tablas + tabla proposals, BE-5.6 absorbido en BE-5.8, BE-5.8 refinado.

**Resultado:** menos código nuevo, más preciso en cómo integrar con lo existente.
