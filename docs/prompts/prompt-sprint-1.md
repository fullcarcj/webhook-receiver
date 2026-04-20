# Prompt definitivo · Sprint 1 · Módulo Unificado de Ventas

**Destinatario:** Cursor Backend · repo `webhook-receiver`
**Duración:** 2 semanas
**Pre-requisitos:** ADR-001, ADR-004, ADR-005 firmados (ver `docs/adr/`); leer el plan v2 en `docs/plan-sprints-v2-ventas-omnicanal.md`

---

## Contexto obligatorio

Antes de escribir una línea de código, leé:

1. `docs/adr/ADR-001-cotizaciones.md` · Aceptado, Opción A: extender `inventario_presupuesto`
2. `docs/adr/ADR-004-naming-api.md` · Aceptado: backend `/api/sales/*`, nombres en inglés
3. `docs/adr/ADR-005-catalogo-products-canonico.md` · Aceptado: `products` canónico, migración simple de `inventario_detallepresupuesto` en este sprint
4. `docs/adr/ADR-001-auditoria-estructural-2026-04-18.md` · estructura real del schema
5. `docs/plan-sprints-v2-ventas-omnicanal.md` · sección **SPRINT 1** y *Principios rectores* / changelog v2

Si contradecís alguno, **parás y preguntás**. No improvisas.

## Reglas duras

1. **Nombres reales, no inventados.** Las tablas existentes son: `crm_chats`, `crm_messages`, `inventario_presupuesto`, `inventario_detallepresupuesto`, `sales_orders`, `sales_order_items`, `sales_order_history`, `sales_channels`, `products`, `customers`, `users`. No inventes `sales_quotes`, `chats`, `orders`, etc.

2. **Nada de escritura a catálogos legacy.** Según ADR-005, código nuevo no escribe a `productos` ni a `inventario_producto`. Solo `products`.

3. **Migraciones aditivas.** Usar `IF NOT EXISTS`, `IF EXISTS` y `ALTER ... DROP NOT NULL` siempre que sea posible. Reversibles.

4. **Prefijo API:** `/api/sales/*` en backend (ADR-004). Nunca `/api/ventas/*`.

5. **Sin Prisma, sin Zod generalizado.** El repo usa Node.js HTTP propio + PostgreSQL vía `pg`. Respetar ese estilo.

6. **Si un dato DDL está marcado como `<<COMPLETAR:...>>`, validar en BD antes de ejecutar** corriendo `\d+ tabla` en psql/DBeaver. No adivinar nombres.

---

## Tickets del Sprint 1

### BE-1.1 · Pegar DDL literal en archivo de auditoría (30 min)

**Objetivo:** cerrar el gap documental del ADR-001 antes de migrar nada.

**Pasos:**

1. Abrir `docs/adr/ADR-001-auditoria-estructural-2026-04-18.md`
2. Ejecutar en DBeaver contra la DB local:

```sql
-- Bloque 1
SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'inventario_presupuesto'
ORDER BY ordinal_position;

-- Bloque 2
SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'inventario_presupuesto'::regclass;

-- Bloque 3
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'inventario_presupuesto';

-- Bloque 4 (items)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventario_detallepresupuesto'
ORDER BY ordinal_position;

-- Bloque 5 (constraints de items)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'inventario_detallepresupuesto'::regclass;
```

3. Pegar resultados literales en los bloques `PENDIENTE` del archivo de auditoría.
4. Commit: `docs(adr): cerrar gap DDL de auditoría ADR-001`

**Criterio de éxito:**
- [ ] Los 5 bloques SQL corridos y pegados
- [ ] Cero bloques `PENDIENTE` en el archivo
- [ ] Nombres reales de constraints documentados (necesarios para BE-1.3)

---

### BE-1.2 · Verificar existencia de `crm_messages.type = 'system'` (15 min)

**Objetivo:** confirmar que el enum (o CHECK) de `type` en `crm_messages` permite el valor `system`. Es pre-requisito de BE-1.5.

**Query de verificación:**

```sql
-- ¿Existe columna type?
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'crm_messages' AND column_name = 'type';

-- Si es USER-DEFINED enum:
SELECT t.typname, e.enumlabel
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname LIKE '%message%type%' OR t.typname LIKE '%crm%';

-- Si es text con CHECK:
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'crm_messages'::regclass AND contype = 'c';
```

**3 escenarios posibles:**

- **A.** Existe enum `crm_message_type_enum` con valor `system` → no hace falta migración
- **B.** Existe enum sin valor `system` → migración: `ALTER TYPE crm_message_type_enum ADD VALUE 'system';`
- **C.** Es columna `text` con CHECK → actualizar el CHECK para incluir `'system'`

**Documentar en el archivo de auditoría** cuál escenario aplicó y si se hizo migración.

---

### BE-1.3 · Migraciones aditivas de `inventario_presupuesto` (2 días)

**Objetivo:** agregar lo mínimo necesario para soportar Sprint 2 (cotización con flag bot) y el caso especial del ADR-005.

**Pre-requisito:** BE-1.1 y BE-1.2 completados.

**Archivo nuevo:** `sql/20260419_sprint1_presupuesto_extensions.sql`

```sql
BEGIN;

-- 1. Agregar created_by_bot para distinguir cotizaciones automáticas
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS created_by_bot BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. CHECK constraint en status con valores canónicos del flujo de ventas
-- IMPORTANTE: validar con pg_constraint si ya existe un CHECK de status antes de agregar.
-- Si existe con otros valores, DROP y recrear; si no existe, crear directamente.
ALTER TABLE inventario_presupuesto
  DROP CONSTRAINT IF EXISTS inventario_presupuesto_status_check;

ALTER TABLE inventario_presupuesto
  ADD CONSTRAINT inventario_presupuesto_status_check
  CHECK (status IN (
    'draft',
    'sent',
    'approved',
    'expired',
    'cancelled_by_buyer',
    'cancelled_by_operator',
    'converted'
  ));

-- 3. Índice para consulta frecuente "cotizaciones activas por chat"
CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_chat_status
  ON inventario_presupuesto (chat_id, status)
  WHERE chat_id IS NOT NULL;

COMMIT;
```

**Rollback** (por si hace falta):

```sql
BEGIN;
DROP INDEX IF EXISTS idx_inv_presupuesto_chat_status;
ALTER TABLE inventario_presupuesto DROP CONSTRAINT IF EXISTS inventario_presupuesto_status_check;
ALTER TABLE inventario_presupuesto DROP COLUMN IF EXISTS created_by_bot;
COMMIT;
```

**Criterios de éxito:**
- [ ] Migración corre limpia en dev y staging
- [ ] Código actual del `inboxQuotationHandler` sigue funcionando sin modificación
- [ ] CHECK constraint no rompe inserciones existentes (validar: `SELECT DISTINCT status FROM inventario_presupuesto` antes de aplicar)

---

### BE-1.4 · Caso especial · migrar `inventario_detallepresupuesto` a `products` (1 día)

**Objetivo:** ejecutar la migración simple definida en ADR-005 · sección "Sprint 1 · caso especial".

**Pre-requisito:** confirmar que `inventario_detallepresupuesto` tiene 0 o 1 registro de prueba (sin histórico real).

**Archivo nuevo:** `sql/20260419_sprint1_detallepresupuesto_to_products.sql`

```sql
BEGIN;

-- 1. Borrar dato de prueba (no hay histórico que preservar)
-- SI ESTE CONTEO ES > 1, DETENER Y CONSULTAR ANTES DE CONTINUAR:
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM inventario_detallepresupuesto;
  IF n > 1 THEN
    RAISE EXCEPTION 'Abortando migración: inventario_detallepresupuesto tiene % registros (esperado 0 o 1 de prueba)', n;
  END IF;
END $$;

DELETE FROM inventario_detallepresupuesto;

-- 2. Drop FK legacy hacia inventario_producto
-- IMPORTANTE: el nombre exacto del constraint viene del bloque 5 de BE-1.1.
-- Validar con:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'inventario_detallepresupuesto'::regclass AND contype = 'f'
--     AND pg_get_constraintdef(oid) LIKE '%inventario_producto%';
-- Sustituir el placeholder:

ALTER TABLE inventario_detallepresupuesto
  DROP CONSTRAINT <<COMPLETAR: nombre del constraint FK a inventario_producto>>;

-- 3. Hacer producto_id nullable (patrón sales_order_items.product_id)
ALTER TABLE inventario_detallepresupuesto
  ALTER COLUMN producto_id DROP NOT NULL;

-- 4. Nueva FK hacia products (canónico según ADR-005)
ALTER TABLE inventario_detallepresupuesto
  ADD CONSTRAINT inventario_detallepresupuesto_products_fk
  FOREIGN KEY (producto_id) REFERENCES products(id) ON DELETE RESTRICT;

-- 5. Columnas de snapshot y multi-moneda (alineadas con sales_order_items)
ALTER TABLE inventario_detallepresupuesto
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS unit_price_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS line_total_usd NUMERIC;

COMMIT;
```

**Nota:** `sku`, `unit_price_usd` y `line_total_usd` se crean nullable en este sprint. En Sprint 4 (cuando el motor de cotización empiece a crear items), se agregará `NOT NULL` para los registros nuevos. No ahora porque ya no hay datos que backfillear.

**Criterios de éxito:**
- [ ] La tabla queda con FK hacia `products`, no hacia `inventario_producto`
- [ ] `producto_id` es nullable
- [ ] Las 3 columnas nuevas existen y son nullable
- [ ] El handler actual (`inboxQuotationHandler.js`) sigue funcionando tras un `INSERT` de prueba con los nuevos campos

---

### BE-1.5 · Tabla `bot_handoffs` + mensaje system (1.5 días)

**Objetivo:** crear infraestructura para el handoff bot↔humano que se usa en Sprint 2.

**Pre-requisito:** BE-1.2 completado (soporte de `type = 'system'` confirmado).

**Archivo nuevo:** `sql/20260419_sprint1_bot_handoffs.sql`

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS bot_handoffs (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES crm_chats(id) ON DELETE CASCADE,
  from_bot BOOLEAN NOT NULL DEFAULT TRUE,
  to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- Solo UN handoff activo por chat a la vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_handoffs_active_unique
  ON bot_handoffs (chat_id)
  WHERE ended_at IS NULL;

-- Consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_bot_handoffs_chat
  ON bot_handoffs (chat_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_handoffs_user
  ON bot_handoffs (to_user_id, started_at DESC)
  WHERE ended_at IS NULL;

COMMIT;
```

**Criterios de éxito:**
- [ ] No se pueden crear 2 handoffs activos simultáneos para el mismo chat (el índice único lo impide)
- [ ] Al insertar `ended_at`, el chat queda libre para un nuevo handoff

---

### BE-1.6 · Endpoint `POST /api/sales/chats/:id/take-over` (1.5 días)

**Objetivo:** el vendedor toma una conversación que estaba en manos del bot.

**Archivo nuevo:** `src/handlers/salesChatHandoffHandler.js` (o extensión de `salesApiHandler.js`, según la convención real del repo).

**Montaje de rutas:** en `server.js` (o donde se monten las rutas actuales de `/api/sales`). **No solaparse** con `GET /api/sales` existente.

**Ruta:**
```
POST /api/sales/chats/:chatId/take-over
```

**Auth:** JWT/cookie con permiso `crm` (patrón existente en el repo).

**Body esperado:**
```json
{ "reason": "Cliente pidió hablar con humano" }
```
`reason` es opcional.

**Lógica (pseudocódigo, adaptarse a la convención del repo):**

```javascript
async function handleTakeOver(req, res) {
  const { chatId } = req.params;
  const { reason } = req.body || {};
  const userId = req.user.id; // del JWT decodificado

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verificar que el chat existe
    const chatExists = await client.query(
      'SELECT id FROM crm_chats WHERE id = $1',
      [chatId]
    );
    if (chatExists.rowCount === 0) {
      return sendError(res, 404, 'Chat no encontrado');
    }

    // 2. Verificar que no hay handoff activo (el UNIQUE INDEX lo garantiza, pero dar error amigable)
    const active = await client.query(
      'SELECT id, to_user_id FROM bot_handoffs WHERE chat_id = $1 AND ended_at IS NULL',
      [chatId]
    );
    if (active.rowCount > 0) {
      const holder = active.rows[0].to_user_id;
      return sendError(res, 409, `El chat ya está tomado por usuario ${holder}`);
    }

    // 3. Insertar handoff
    const insert = await client.query(
      `INSERT INTO bot_handoffs (chat_id, from_bot, to_user_id, reason)
       VALUES ($1, TRUE, $2, $3)
       RETURNING id, started_at`,
      [chatId, userId, reason || null]
    );

    // 4. Obtener nombre del usuario para el mensaje system
    const userInfo = await client.query(
      'SELECT name FROM users WHERE id = $1', // ajustar campo al real
      [userId]
    );
    const userName = userInfo.rows[0]?.name || `Usuario ${userId}`;

    // 5. Insertar mensaje system en crm_messages
    //    NOTA: ajustar columnas al schema real de crm_messages
    await client.query(
      `INSERT INTO crm_messages (chat_id, type, content, created_at)
       VALUES ($1, 'system', $2, NOW())`,
      [chatId, `${userName} se unió a la conversación`]
    );

    await client.query('COMMIT');

    return sendSuccess(res, {
      handoffId: insert.rows[0].id,
      chatId: parseInt(chatId),
      takenBy: { id: userId, name: userName },
      startedAt: insert.rows[0].started_at
    });

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('take-over failed', { err, chatId, userId });
    return sendError(res, 500, 'Error al tomar conversación');
  } finally {
    client.release();
  }
}
```

**Criterios de éxito:**
- [ ] Responde 200 con el handoff creado cuando todo OK
- [ ] Responde 404 si el chat no existe
- [ ] Responde 409 si ya hay handoff activo
- [ ] Inserta mensaje `type = 'system'` en `crm_messages`
- [ ] Todo en transacción: si algo falla, nada se persiste
- [ ] Tests unitarios con al menos los 4 casos: success, chat no existe, handoff duplicado, rollback en fallo

---

### BE-1.7 · Endpoint `POST /api/sales/chats/:id/return-to-bot` (0.5 día)

**Ruta:**
```
POST /api/sales/chats/:chatId/return-to-bot
```

**Lógica:**
1. Buscar handoff activo (`ended_at IS NULL`) para el chat
2. Si no existe → 404
3. Si existe pero es de otro usuario → decidir política (opción A: permitir a cualquiera con permiso `crm`; opción B: solo el usuario dueño puede devolver). **Recomendación:** Opción A, pero auditable.
4. Cerrar handoff: `UPDATE bot_handoffs SET ended_at = NOW() WHERE id = $1`
5. Insertar mensaje system: `"<nombre> devolvió la conversación al asistente automático"`
6. Responder 200

**Criterios de éxito:**
- [ ] Cierra handoff activo correctamente
- [ ] Inserta mensaje system
- [ ] Transaccional
- [ ] Tests de los casos borde

---

### BE-1.8 · Extender `/api/inbox/counts` (1 día)

**Objetivo:** agregar 2 contadores nuevos que Sprint 2 necesitará en la bandeja:

- `handed_over` — chats con handoff activo ahora mismo
- `exceptions` — por ahora siempre 0 (la tabla `exceptions` se crea en Sprint 2)

**Ubicación:** `src/services/inboxService.js` (método que arma los counts).

**Query a agregar:**

```sql
SELECT COUNT(DISTINCT chat_id) AS handed_over
FROM bot_handoffs
WHERE ended_at IS NULL;
```

**No romper compatibilidad:** los contadores existentes siguen iguales.

**Criterios de éxito:**
- [ ] `GET /api/inbox/counts` devuelve los contadores existentes + `handed_over` + `exceptions: 0`
- [ ] Sin regresiones en frontend actual
- [ ] Al tomar un chat, el contador `handed_over` sube en 1; al devolver, baja en 1

---

## Tickets frontend (mínimos, solo lo que desbloquea Sprint 2)

### FE-1.1 · Tipos TypeScript para handoff (0.5 día)

**Archivo nuevo:** `src/types/sales.ts`

```typescript
export interface BotHandoff {
  id: number;
  chatId: number;
  fromBot: boolean;
  toUserId: number | null;
  reason: string | null;
  startedAt: string; // ISO
  endedAt: string | null;
}

export interface TakeOverResponse {
  handoffId: number;
  chatId: number;
  takenBy: { id: number; name: string };
  startedAt: string;
}

// Extensión del tipo Chat existente en src/types/inbox.ts
export interface ChatWithHandoff {
  // ...campos existentes
  activeHandoff?: BotHandoff | null;
}
```

**No crear React Query ni nada nuevo.** Respetar el patrón de `fetch` + Redux simple del repo.

---

### FE-1.2 · Wrappers de API (0.5 día)

**Archivo nuevo:** `src/lib/api/sales.ts`

```typescript
export async function takeOverChat(chatId: number, reason?: string): Promise<TakeOverResponse> {
  const res = await fetch(`/api/sales/chats/${chatId}/take-over`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function returnChatToBot(chatId: number): Promise<void> {
  const res = await fetch(`/api/sales/chats/${chatId}/return-to-bot`, {
    method: 'POST',
    credentials: 'include'
  });
  if (!res.ok) throw new Error(await res.text());
}
```

**Nota sobre BFF:** si el frontend Next.js usa BFF proxy (`/api/bandeja/*`), decidir si se pasa por ahí o se apunta directo al backend. Consistencia con patrones existentes.

---

## Criterios de aceptación globales del Sprint 1

Al cerrar las 2 semanas, debe cumplirse:

- [ ] Los 8 tickets de backend completados y mergeados a `main`
- [ ] Los 2 tickets de frontend completados
- [ ] Cero regresiones en `/api/inbox` existente (smoke test con frontend actual)
- [ ] Todas las migraciones ejecutadas en staging con éxito
- [ ] Tests unitarios pasan para los endpoints nuevos (cobertura >= 70% en los nuevos)
- [ ] Documentación actualizada:
  - `docs/SCHEMA_ACTUAL.md` refleja las migraciones aplicadas
  - `docs/API.md` (o equivalente) lista los 2 endpoints nuevos
  - `docs/adr/ADR-001-auditoria-estructural-2026-04-18.md` sin placeholders
- [ ] Smoke test manual: un vendedor puede tomar y devolver un chat vía endpoints, mensaje system aparece en `crm_messages`

---

## Si algo no cuadra

Reglas para cuando encuentres sorpresas:

1. **Si una tabla tiene nombre/columna distinto al asumido:** parar, documentar, preguntar. No improvisar.
2. **Si una migración rompe algo existente:** rollback completo, entender la causa, no "parchear".
3. **Si el schema real contradice un ADR:** el código no gana automáticamente; discutir. Los ADRs son reversibles si hay evidencia suficiente.
4. **Si un endpoint existente se solapa con uno nuevo:** usar alias según ADR-004, no sobrescribir.

---

## Orden sugerido de ejecución

Para maximizar paralelismo y reducir bloqueos:

**Día 1:** BE-1.1 (DDL literales) + BE-1.2 (verificar `system` type)
**Día 2-3:** BE-1.3 (migración presupuesto) + BE-1.4 (migración items) en paralelo
**Día 4:** BE-1.5 (tabla bot_handoffs)
**Día 5-6:** BE-1.6 (take-over endpoint) + FE-1.1 (tipos) en paralelo
**Día 7:** BE-1.7 (return-to-bot)
**Día 8:** BE-1.8 (counts extension) + BE-1.9 (chat_stage en inbox) + FE-1.2 (wrappers) en paralelo
**Día 9:** Tests + fixes
**Día 10:** Docs + smoke test + demo

Si se atrasa un día cualquiera, los días 9-10 absorben el slack.

---

---

### BE-1.9 · Exponer `chat_stage` en `GET /api/inbox` (1 día)

**Origen:** requerimiento del Sprint 1.5 FE — el frontend necesita que el backend calcule la etapa del pipeline de cada chat para evitar lógica duplicada (ver decisión A.1 acordada con el equipo).

**⚠️ Conflicto de nomenclatura a resolver primero:**

`salesService.js` ya usa `lifecycle_stage` para **fases de feedback ML** (valores: `waiting_buyer_feedback`, `waiting_seller_feedback`, `feedback_complete`, `unknown`). Eso **no es** la etapa del pipeline de chat que el frontend pide.

**Nombre de campo a exponer: `chat_stage`** (no `lifecycle_stage`). Evita colisión con el campo ML existente. Si en Sprint 3 al crear `v_sales_pipeline` se decide unificar nombres, se migra allí sin breaking change en el payload del inbox.

**Etapas del pipeline de chat** (acordar con FE si `ml_answer` es la 7ª etapa o se merge con otra):

| `chat_stage` | Condición (en orden de prioridad) |
|---|---|
| `closed` | `so.status IN ('completed','cancelled')` |
| `dispatch` | `so.payment_status = 'approved'` y `so.fulfillment_type IS NOT NULL` |
| `payment` | `so.payment_status = 'pending'` |
| `order` | `so.id IS NOT NULL` (orden existe, payment aún no iniciado) |
| `quote` | No hay orden pero sí cotización activa en `inventario_presupuesto` (`status IN ('draft','sent','approved')`) |
| `ml_answer` | `cc.source_type = 'ml_question'` y no hay orden ni cotización |
| `conversation` | Default (ninguna condición anterior aplica) |

**Implementación — cambios en `src/services/inboxService.js`:**

1. Añadir `JOIN LATERAL` a `inventario_presupuesto` (alias `ip`) para detectar cotización activa:

```javascript
const JOIN_QUOTE = `
  LEFT JOIN LATERAL (
    SELECT ip2.status
    FROM inventario_presupuesto ip2
    WHERE ip2.chat_id = cc.id
      AND ip2.status NOT IN ('expired','converted','cancelled_by_buyer','cancelled_by_operator')
    ORDER BY ip2.fecha_creacion DESC NULLS LAST
    LIMIT 1
  ) ip ON true
`;
```

2. Añadir expresión SQL `chat_stage` en el `SELECT`:

```sql
CASE
  WHEN so.status IN ('completed','cancelled')                                      THEN 'closed'
  WHEN so.payment_status = 'approved' AND so.fulfillment_type IS NOT NULL          THEN 'dispatch'
  WHEN so.payment_status = 'pending'                                               THEN 'payment'
  WHEN so.id IS NOT NULL                                                           THEN 'order'
  WHEN ip.status IS NOT NULL                                                       THEN 'quote'
  WHEN cc.source_type = 'ml_question'                                              THEN 'ml_answer'
  ELSE 'conversation'
END AS chat_stage
```

3. Incluir `r.chat_stage` en el objeto devuelto por `chats.map(...)`.

**No agregar en `getInboxCounts()`** — ese endpoint no necesita el desglose por etapa (lo hará `v_sales_pipeline` en Sprint 3).

**Nota sobre `so.status`:** el `JOIN_ORDER` actual filtra `status NOT IN ('completed','cancelled')`. Para la detección de `closed`, hay que **quitar ese filtro** del lateral o agregar un segundo JOIN que capture la orden más reciente **sin** excluir estados cerrados. Opción simple: cambiar el lateral a ordenar por `updated_at DESC` sin filtro de status, y usar `status` para calcular `chat_stage`.

**Criterios de éxito:**
- [ ] Cada chat en `GET /api/inbox` incluye `chat_stage` con uno de los 7 valores
- [ ] Chatear sin orden muestra `conversation` o `ml_answer`
- [ ] Chat con cotización activa muestra `quote`
- [ ] Chat con orden muestra `order`, `payment`, `dispatch` o `closed` según estado
- [ ] No rompe shape existente del payload (campo nuevo, no reemplaza ninguno)
- [ ] `LIFECYCLE_STAGE_VALUES` / `lifecycle_stage` de `salesService.js` **no se toca** (son para feedback ML, dominio separado)

---

**Fin del prompt.** Preguntar antes de improvisar. La realidad del código gana sobre el plan.
