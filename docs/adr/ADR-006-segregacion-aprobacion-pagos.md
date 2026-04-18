# ADR-006 · Segregación de aprobación de pagos (matching automático vs manual)

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-18
- **Dueño:** Tech lead (Javier)
- **Relacionados:** ADR-002 (conciliación bancaria), Sprint 5 (matching + UI caja/vendedor), `sales_orders.payment_status`, bandeja de ventas

---

## Contexto

Sin segregación, el mismo actor que **propone** la asociación pago–orden puede **aprobarla**, lo que abre la puerta a errores operativos y a fraude sistemático (el vendedor o el bot “cierra” su propia venta sin segunda mirada).

Se definieron **cuatro decisiones de negocio** que el sistema debe reflejar:

1. **Roles separados:** vendedor (ventas) y caja/finanzas son **roles distintos** con permisos distintos en el producto.
2. **Match automático de alta confianza** puede **aprobar el pago directamente** (sin paso intermedio de caja).
3. **Match manual** (asociación propuesta por el vendedor ante transacción huérfana o excepción) entra en **pendiente de aprobación de caja** antes de impactar la orden.
4. **El cliente no recibe mensaje intermedio** tipo “pago en verificación” mientras caja decide; la confirmación al cliente ocurre solo cuando el pago queda **definitivamente aprobado**. El vendedor sí recibe feedback in-app si la propuesta es rechazada.

La semántica de “matching automático” **no es equivalente** a “sin revisión”: solo los matches que cumplan reglas **estrictas de alta confianza** escapan la cola humana. El resto pasa por el gate de caja cuando el origen es manual/propuesta.

---

## Decisión

### 1. Dos gates según el origen del match

| Origen | Comportamiento |
|--------|----------------|
| **Automático de alta confianza** | Aprueba el pago y actualiza `sales_orders` (p. ej. `payment_status = 'approved'`) **sin** paso de aprobación de caja. |
| **Manual / baja confianza** | El vendedor **propone** la asociación; el registro entra en estado **pendiente** hasta que un usuario con permiso de caja **aprueba** o **rechaza**. |

### 2. Reglas duras de “alta confianza” (Sprint 5)

Un match automático solo se considera de alta confianza si se cumplen **en conjunto** (ajustar umbrales en configuración si hace falta):

1. **Un solo candidato** de orden/pago en el motor de matching (sin empate ambiguo).
2. **Monto exacto** con tolerancia máxima **≤ 0,50 USD** (o moneda base equivalente), no umbrales laxos tipo 1 USD.
3. **Ventana temporal estrecha:** la transacción bancaria cae dentro de **≤ 2 horas** desde el mensaje de aviso de pago del cliente (o desde el evento de “comprobante recibido” que defina el producto).
4. **Fuente bancaria con confianza operativa:** p. ej. extracto **Banesco** vía pipeline ya automatizado (Playwright/CSV) en **whitelist**; importaciones manuales o bancos sin historial de calidad **no** entran en auto-aprobación por defecto (van a revisión o a propuesta manual según reglas).

Cualquier condición no cumplida → el flujo **no** usa auto-aprobación; sigue el camino de excepción o propuesta.

### 3. Tabla y workflow de propuestas (no reutilizar “exceptions” genérica)

La acción del vendedor “asociar transacción huérfana a una orden” **no** es lo mismo que “resolver una excepción” genérica. Se introduce una entidad dedicada, p. ej. **`payment_match_proposals`** (nombre final en migración Sprint 5), con estados mínimos:

- `pending` → `approved` | `rejected`

Campos típicos (detalle en ticket BE): referencia a transacción bancaria, orden objetivo, usuario que propone, timestamps, usuario que aprueba/rechaza, motivo de rechazo opcional.

Tras **rechazo**, la transacción vuelve a estado **huérfana / unmatched** para que el vendedor pueda reintentar; el cliente **no** fue notificado en el intermedio.

### 4. Permisos y roles

- **Vendedor** (roles con ámbito ventas/crm según `role_permissions`): puede **crear propuestas** de asociación; **no** puede aprobar pagos definitivos salvo que el producto defina una excepción explícita (por defecto: no).
- **Caja / finanzas** (p. ej. rol `CONTADOR` u homónimo dedicado): puede **aprobar o rechazar** propuestas pendientes y, donde aplique, operar la cola de revisión.

Los literales exactos (`module`/`action` en `role_permissions`, o permisos nuevos) se definen en **Sprint 5** al implementar endpoints; este ADR fija la **segregación funcional**, no el nombre SQL del enum hasta que exista la migración.

> **Nota:** Ya existe infraestructura de roles en el repo (`user_role`, `role_permissions`). No hace falta un rol llamado literalmente “caja”; hace falta **permiso explícito de aprobación de pagos** separado del de proponer.

### 5. Comunicación al cliente y al vendedor

- **Cliente:** confirmación de pago recibido / orden actualizada solo cuando el estado del pago es **definitivo** (auto alta confianza o propuesta **aprobada** por caja).
- **Vendedor:** notificación **in-app** (no canal cliente) ante **aprobación** o **rechazo** de su propuesta.

---

## Relación con ADR-002

**ADR-002** sigue decidiendo **cómo** ingieren los bancos (CSV, Playwright, etc.). **ADR-006** decide **quién aprueba** el vínculo pago–orden y **cuándo** el matching automático es suficiente sin humano.

Al firmar ADR-002, su texto debe ser **compatible** con ADR-006: el `paymentMatchingService` y la UI de conciliación implementan las reglas de alta confianza y el workflow de propuestas aquí descritos.

---

## Consecuencias

### Sprint 5 (backend)

- Implementar motor de matching con ramas **auto_aprobado** vs **pendiente_caja** según este ADR.
- Crear tabla `payment_match_proposals` (o nombre acordado) y endpoints de aprobar/rechazar.
- Ajustar tickets existentes del prompt Sprint 5: matching manual ≠ aprobación final; nuevos endpoints para rol caja.

### Sprint 5 (frontend)

- Vista o panel para **proponer** asociación (vendedor).
- Vista para **cola de aprobación** (caja).
- Notificaciones in-app al vendedor en rechazo (y opcionalmente en aprobación).

### Riesgos mitigados

- Doble fuente de verdad “el vendedor cerró solo su venta”.
- Mensajes al cliente que luego hay que retractar si caja rechaza.

### Riesgos residuales

- Definición de whitelist de bancos y mantenimiento de umbrales; deben ser **configurables** donde tenga sentido (env o tabla de settings).

---

## Estado de revisión

- **Trigger de revisión:** cambio regulatorio (obligatoriedad de doble firma para todos los montos), o evidencia de falsos positivos/negativos masivos en auto-aprobación.
