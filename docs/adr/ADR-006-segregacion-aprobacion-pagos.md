# ADR-006 · Segregación de aprobación de pagos (vendedor ≠ caja)

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-18
- **Dueño:** Tech lead (Javier)
- **Relacionados:** ADR-002 (conciliación bancaria), Sprint 5 (matching + aprobación), Sprint 6 (dashboard supervisor)

---

## Contexto

Durante la planificación del Sprint 5 (conciliación bancaria) se identificó que el diseño original aprobaba el pago inmediatamente cuando el vendedor hacía match manual de una transacción huérfana. Esto mezcla dos responsabilidades:

1. **Vendedor** conoce el contexto del cliente y puede asociar una transacción a una orden con criterio
2. **Caja/finanzas** tiene responsabilidad fiduciaria de confirmar que el dinero efectivamente está en la cuenta, cumple con formalidades, y libera la orden para despacho

En comercio real, **no es prudente que la misma persona que vende confirme que el pago entró**. Mezclar roles habilita errores (genuinos) y oportunidades de fraude (malintencionados). La segregación de funciones es práctica estándar.

### Realidad operativa de Solomotorx

- Vendedor en WhatsApp recibe aviso "transferí tu orden, aquí la captura"
- Vendedor ve la transacción en `/ventas/conciliacion` sin match automático
- Vendedor **propone** asociación a la orden del cliente
- Caja/finanzas revisa movimientos bancarios oficiales y **confirma o rechaza**
- Solo tras confirmación, el cliente recibe "pago aprobado" y la orden avanza a despacho

### Lo que NO queremos

- Que el vendedor apruebe su propia venta (conflicto de rol)
- Que el matching automático de alta confianza también pase por caja (burocracia innecesaria, mata el tiempo de respuesta del bot)
- Que el cliente reciba "pago en verificación" y después tenga que recibir "no, lo rechazamos" (walk-back que daña confianza)

## Decisión

**Implementar un workflow de aprobación de pagos de dos pasos para matches manuales**, con las siguientes reglas:

### Regla 1 · Gate por origen del match

| Origen del match | Camino |
|---|---|
| Automático de **alta confianza** | Aprobación directa. El bot notifica al cliente. |
| Automático de baja confianza (múltiples candidatos, monto aproximado) | Excepción `payment_no_match` → vendedor asocia → caja aprueba |
| Manual del vendedor (transacción huérfana) | Siempre requiere aprobación de caja |
| Manual de caja/admin (directo) | Aprobación directa (caja es el rol final) |

### Regla 2 · Definición dura de "alta confianza"

Un match automático pasa directo sin aprobación si y solo si cumple **las 4 condiciones**:

1. **Un solo candidato** en la búsqueda de órdenes compatibles
2. **Monto exacto** (tolerancia ≤ $0.50, no $1 como tolerancia general del matching)
3. **Ventana temporal estrecha** (transacción ≤ 2h después del mensaje de pago del cliente)
4. **Banco en whitelist** (inicialmente solo Banesco con monitor Playwright, porque es ingesta automática en vivo; BDV CSV queda fuera de whitelist por ser importación humana)

Si falla cualquiera de las 4 → el match se registra pero queda `pending` de aprobación por caja.

### Regla 3 · Roles y permisos

Se introducen dos permisos nuevos en el sistema (como **convención de producto**; el mapeo a `role_permissions` — `module`/`action` o filas nuevas — es tarea de Sprint 5):

- `sales.propose_match` → puede proponer asociación de transacción a orden (vendedores)
- `finance.approve_payment` → puede aprobar/rechazar propuestas y ver movimientos bancarios (caja/finanzas/admin)

Un usuario puede tener ambos permisos (ejemplo: admin). Pero la operación cotidiana separa los dos.

> **Alineación repo `webhook-receiver`:** hoy existen `user_role` y `role_permissions` (no una tabla `user_permissions` con strings arbitrarios). Al implementar, mapear estos permisos a filas en `role_permissions` o a convención documentada en el mismo sprint.

### Regla 4 · Comunicación al cliente

El cliente **no recibe mensaje intermedio** "pago en verificación". Recibe confirmación solo cuando el pago queda efectivamente aprobado (sea por match automático directo o por ciclo vendedor→caja completo).

Razón: si el cliente recibiera "pago recibido, en verificación" y caja después rechazara, el walk-back es "disculpe, en realidad no encontramos su pago". Eso genera fricción y desconfianza. Mejor silencio operativo hasta tener certeza.

**Excepción razonable:** si la propuesta del vendedor queda pendiente de caja por más de 4 horas, el sistema puede enviar al cliente un "estamos procesando tu pago, te confirmamos pronto". Eso es comunicación de espera, no de incertidumbre. Lo dejamos como mejora de Sprint 6, no en Sprint 5.

### Regla 5 · Rechazo de caja

Cuando caja rechaza una propuesta del vendedor:

1. La transacción bancaria **vuelve a huérfana** (sin vínculo definitivo a orden)
2. La propuesta queda registrada con `rejected_at`, `rejected_by`, `rejection_reason`
3. Se genera notificación in-app al vendedor que hizo la propuesta
4. Se crea nueva excepción `payment_no_match` con `context.previous_rejection_id` apuntando a la propuesta rechazada (para que el vendedor sepa que ya intentó y ajuste criterio)

El vendedor puede re-proponer con otra orden tras corregir.

## Consecuencias

### Tabla nueva · `payment_match_proposals`

> **Alineación repo:** los movimientos bancarios canónicos viven en `bank_statements` (`sql/bank-reconciliation.sql`, servicios Banesco/reconciliación). El DDL de ejemplo usa `bank_statement_id` → `bank_statements(id)`, no `bank_transactions`.

```sql
CREATE TYPE payment_proposal_status AS ENUM (
  'pending',
  'approved',
  'rejected'
);

CREATE TABLE payment_match_proposals (
  id BIGSERIAL PRIMARY KEY,
  bank_statement_id BIGINT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  proposed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_note TEXT,
  status payment_proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  previous_proposal_id BIGINT REFERENCES payment_match_proposals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_proposals_pending
  ON payment_match_proposals (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX idx_payment_proposals_by_proposer
  ON payment_match_proposals (proposed_by, created_at DESC);
```

### Cambios en `bank_statements`

Agregar columna de estado de aprobación (validar nombre de tabla y migraciones existentes antes de aplicar):

```sql
ALTER TABLE bank_statements
  ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'unmatched';

ALTER TABLE bank_statements
  ADD CONSTRAINT bank_statements_approval_state_check
  CHECK (approval_state IN ('unmatched', 'auto_approved', 'pending_approval', 'approved', 'rejected_cycle'));
```

Transiciones legales:

- `unmatched` → `auto_approved` (matching automático alta confianza)
- `unmatched` → `pending_approval` (vendedor propone)
- `pending_approval` → `approved` (caja aprueba)
- `pending_approval` → `unmatched` (caja rechaza, se reinicia)

### Permisos y roles

Documentar qué rol tiene cada permiso (p. ej. nota en este ADR o en `CLAUDE.md` sección permisos cuando exista el mapeo).

### Impacto en Sprint 5

**BE-5.4 · Motor de matching (modificado):**

- Solo aprueba directo si cumple las 4 condiciones de alta confianza
- Si no, crea transacción con `approval_state = 'pending_approval'` **y** propuesta automática en `payment_match_proposals` con `proposed_by = 'system'` (user especial) — o deja la transacción como `unmatched` y genera excepción para que un vendedor humano proponga

**Decisión de diseño:** mejor la segunda opción. Es más limpia: el matching automático solo decide `auto_approved` (si es alta confianza) o `unmatched` (si no). Las propuestas son siempre humanas. Menos ambigüedad.

**BE-5.6 · Match manual (modificado):**

- Ya no aprueba el pago directamente
- Inserta propuesta en `payment_match_proposals` con status `pending`
- Deja transacción en `approval_state = 'pending_approval'`
- No toca `payment_status` de la orden
- Requiere permiso `sales.propose_match`

**BE-5.8 · Nuevo ticket · Endpoint de aprobación/rechazo de propuestas:**

```
POST /api/sales/payment-proposals/:id/approve
POST /api/sales/payment-proposals/:id/reject
GET  /api/sales/payment-proposals?status=pending
```

Requiere permiso `finance.approve_payment`.

Aprobar:

- Marca propuesta `approved`
- Transacción → `approval_state = 'approved'`
- Orden: `payment_status = 'approved'`
- Audit en `sales_order_history`
- Dispara mensaje al cliente vía bot (o notifica para que bot lo dispare)

Rechazar:

- Marca propuesta `rejected` con razón
- Transacción → `approval_state = 'unmatched'` (vuelve a huérfana)
- Orden: `payment_status` **no cambia** (sigue `pending`)
- Notifica al vendedor que propuso
- Crea excepción nueva con referencia a la propuesta rechazada

### Impacto en Sprint 5 FE

**FE-5.2 · Modal de matching manual (modificado):**

- Cambiar etiqueta del botón "Confirmar match" → **"Proponer a caja"**
- Tras submit exitoso, mostrar toast "Propuesta enviada a caja para aprobación"
- No esperar "pago aprobado" inmediato

**FE-5.5 · Nuevo ticket · Vista de aprobación para caja**

Ruta: `/ventas/aprobacion-pagos`

- Solo accesible con permiso `finance.approve_payment`
- Lista de propuestas `pending` con información del vendedor, orden, transacción
- Botones aprobar/rechazar con modal de razón
- Contador "pendientes de aprobar" en sidebar si rol aplica

**FE-5.6 · Nuevo ticket · Notificación in-app de rechazo al vendedor**

Cuando caja rechaza, el vendedor ve (en `/bandeja` o área personal):

- Badge rojo "1 propuesta rechazada"
- Click muestra la propuesta + razón + botón "Re-proponer"

### Impacto en Sprint 6

**Dashboard supervisor:**

- KPI nuevo: `payment_proposals_pending_count`
- KPI nuevo: `payment_proposals_rejected_rate_7d` (alerta si > 20%)
- Alerta: si una propuesta lleva > 6h pendiente, notificación al supervisor

## Relación con ADR-002

ADR-002 decide **cómo** ingieren los bancos. Este ADR decide **quién aprueba** el vínculo pago–orden. Al firmar ADR-002, el texto debe ser compatible con ADR-006.

## Decisiones que quedan abiertas

- **Mensaje al cliente tras 4h pendiente:** acordado como mejora de Sprint 6, no crítico para Sprint 5
- **Qué pasa si caja nunca revisa (propuesta huérfana):** política de "auto-aprobar" tras N días o escalamiento. Decidir en Sprint 6 con datos de operación real
- **Múltiples propuestas para la misma transacción:** ¿permitir que 2 vendedores propongan órdenes distintas simultáneamente para la misma transacción? Decisión: **no**, índice único garantiza una sola propuesta `pending` por `bank_statement_id` a la vez. Si el vendedor se equivocó, cancela la suya primero (endpoint adicional) y propone de nuevo.
- **Rol "admin" como override:** un admin puede aprobar directo sin pasar por caja en emergencias. Implementación: permiso `finance.approve_payment` + flag "override" que queda auditado. Sprint 6.

## Criterios de éxito

- [ ] Tabla `payment_match_proposals` creada con índices
- [ ] `bank_statements.approval_state` agregado (o equivalente acordado con schema actual)
- [ ] Permisos `sales.propose_match` y `finance.approve_payment` definidos y mapeados a roles
- [ ] Matching automático solo auto-aprueba bajo las 4 condiciones
- [ ] Match manual = crear propuesta, nunca aprobar directo
- [ ] Endpoints de aprobación/rechazo funcionan
- [ ] UI de vendedor muestra estado "en espera de caja"
- [ ] UI de caja muestra lista de pendientes con toda la info necesaria
- [ ] Audit log completo: quién propuso, quién aprobó/rechazó, cuándo, por qué
- [ ] Cliente recibe mensaje de aprobación solo al final (no intermedio)

## Observaciones

- Este ADR **no retrasa** Sprint 5: los tickets adicionales (BE-5.8, FE-5.5, FE-5.6) caben en 1-2 días extra dentro de las 2 semanas del sprint.
- Es **reversible**: si en operación real la carga de caja es insostenible, se puede relajar bajando a "solo montos > X USD requieren aprobación". Pero esa decisión solo con datos de producción.
- La regla 4 (no avisar al cliente intermedio) **protege la confianza** pero asume que caja responde rápido. Si caja tarda horas sistemáticamente, el cliente igual nota el retraso. Es un tema operativo, no técnico.

## Estado de revisión

- **Trigger de revisión:** cambio regulatorio (obligatoriedad de doble firma para todos los montos), o evidencia de falsos positivos/negativos masivos en auto-aprobación.
