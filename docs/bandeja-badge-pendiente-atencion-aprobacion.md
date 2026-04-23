# Propuesta de aprobación — Badge de fila en Bandeja (“sin atender” vs `unread_count`)

**Estado:** borrador para decisión de producto + implementación  
**Ámbito:** lista de chats (círculo numérico), alineación opcional con pestaña “Sin leer” / campana  
**Fuente actual:** `crm_chats.unread_count` (incrementa con inbound; baja con marcar leído / políticas acordadas).

---

## 1. Problema

El vendedor **interpreta** el número como *“mensajes / pendientes sin atender por mí”*.  
El sistema hoy muestra **`unread_count`**: contador **persistido** que puede ser **13, 18…** aunque la sensación operativa sea “ya respondí” o “no hay tantas burbujas”, porque:

- acumula entradas **sin** reset frecuente;
- no es lo mismo que “pendiente de **última** respuesta del agente”.

Eso genera **desconfianza en la UI** aunque el dato sea “correcto” para el contador.

---

## 2. Objetivo de producto (definición a aprobar)

Elegir **una** de estas definiciones oficiales para el badge de la **fila**:

| ID | Definición | Comportamiento esperado del número |
|----|------------|-------------------------------------|
| **P0** | Mantener `unread_count` | Sin cambio; ajustar solo textos (“Contador CRM”) para no prometer “sin atender”. |
| **P1** | **Pendiente de respuesta (binario)** | “Hay algo esperando mi respuesta” = sí/no; el número no intenta contar 13 mensajes. |
| **P2** | **Pendiente con cantidad exacta** | Número = cantidad de mensajes entrantes **después** del último saliente del agente (o definición equivalente). |

**Recomendación técnica-producto:** **P1 en fase 1**, **P2 en fase 2** si hace falta el “cuántos” literal.

---

## 3. Evidencia en código actual (sin implementar aún)

- `GET /api/inbox` ya expone **`customer_waiting_reply`**: `true` si el **último** mensaje del hilo es **inbound** (`JOIN_LAST_MESSAGE` + dirección).  
  Eso coincide con *“el turno está del lado del vendedor”* en el sentido **último mensaje**.
- **`unread_count`** sigue siendo la fuente de la **campana** (`counts.unread`) y del círculo hoy.

P1 puede alinearse **solo con datos ya devueltos por la API** en la lista (cambio principalmente **frontend** + copy).  
P2 requiere **nuevo cálculo en SQL o columna mantenida** + alinear `GET /api/inbox/counts` con la misma regla.

---

## 4. Opciones de implementación (para aprobar una)

### Opción A — Fase 1 mínima (recomendada para aprobar ya)

- **Lista:** si `customer_waiting_reply` → mostrar **badge “1”** o **punto** (sin 13/18); si `false` → **ocultar** el badge (o 0). Opcional: conservar `unread_count` en tooltip secundario (“Actividad acumulada: N”) para soporte.
- **Campana “Sin leer”:** sub-opciones (aprobar una):
  - **A1:** sin cambio (sigue `unread_count`); desfase temporal posible vs fila.
  - **A2:** contar chats con `customer_waiting_reply` en el mismo `WHERE` que la lista (cambio **backend** en `getInboxCounts` + tests).

### Opción B — Fase 2 (métrica con cantidad)

- Añadir en backend **`pending_inbound_count`** (subquery por chat o trigger al insertar `crm_messages`) y exponerlo en `GET /api/inbox`; el círculo muestra ese valor.
- Actualizar **`GET /api/inbox/counts`** con el mismo criterio para la campana.

### Opción C — Unificar todo en `unread_count`

- Redefinir en servidor **cuándo** se hace `+1` / `=0` para que `unread_count` **igual** P1 o P2.  
- **Riesgo:** regresiones en webhooks, ML, media, integraciones que asumen el comportamiento actual.

---

## 5. Criterios de aceptación (checklist)

- [ ] Definición aprobada: **P0 / P1 / P2** (y si campana es **A1** o **A2**).
- [ ] En hilos de prueba: último mensaje **outbound** → **sin** badge de pendiente (P1).
- [ ] Último mensaje **inbound** → badge visible según diseño (P1: un solo indicador).
- [ ] No regresión en filtros `filter=unread` si se cambia el criterio de counts (**A2**).
- [ ] Copy en español (LATAM neutral): título / `aria-label` alineados a la definición aprobada.

---

## 6. Riesgos y mitigación

| Riesgo | Mitigación |
|--------|------------|
| `customer_waiting_reply` solo mira el **último** mensaje | Aceptado en P1; P2 si se necesita historia completa. |
| Desalineación lista vs campana (A1) | Documentar o ir directo a **A2**. |
| P2 coste SQL | Índices por `chat_id`, `created_at`; evaluar materialización. |

---

## 7. Siguiente paso tras “Aprobado”

1. Marcar en ticket la opción (**A + A1/A2**, o **B**, o **C**).  
2. Implementar en orden: **backend counts** (si A2) → **frontend lista** → **QA** con 3 chats de prueba.  
3. No mezclar con otros cambios de bandeja en el mismo commit si se busca rollback limpio.

---

*Documento preparado para revisión; no implica código desplegado hasta aprobación explícita.*

---

## 8. Implementado (2026-04-23) — P1 + A2

- **Backend** (`inboxService.js`): `filter=unread` y `counts.unread` usan `(last_msg.direction = 'inbound')` en lugar de `cc.unread_count > 0`.
- **Frontend**: badge de fila = `1` si `customer_waiting_reply`, `!` naranja si `isAutoReleased`; pestaña/sidebar “Sin atender”; tipo `InboxChat.customer_waiting_reply`.
