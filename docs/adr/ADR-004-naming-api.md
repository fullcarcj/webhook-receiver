# ADR-004 · Nomenclatura API: `/api/sales` vs `/api/ventas`

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-18
- **Dueño:** Tech lead (Javier)
- **Relacionados:** todos los tickets de backend (desde S1), ADR-001 (cotizaciones)

---

## Contexto

El plan v1 mezclaba prefijos `/api/sales` y `/api/ventas`. El código actual del backend usa **`/api/sales`** (p. ej. `salesApiHandler.js`). La UI del frontend puede usar rutas en español (`/ventas/pedidos`, `/ventas/tablero`).

La pregunta es: **¿qué convención se sigue para evitar duplicación y confusión?**

## Principio de base

- **API:** audiencia técnica; convención en inglés (`/api/sales/...`) es habitual.
- **UI:** audiencia de usuario; rutas en español son aceptables.

## Opciones

### Opción A · Todo en inglés (backend + URLs UI)

**Contras:** poco alineado con usuarios hispanohablantes en URLs de producto.

### Opción B · Backend inglés, UI español (recomendado)

- Backend: `/api/sales/...`
- UI: `/ventas/...`
- Los clientes llaman `fetch('/api/sales/...')` con credenciales actuales.

### Opción C · Todo en español en API

**Contras:** breaking change masivo frente a `salesApiHandler` y clientes existentes.

## Decisión

**Opción B — Backend en inglés (`/api/sales/*`), frontend en español (`/ventas/*`).**

Esta decisión formaliza la convención que el código ya sigue de facto. No introduce cambios breaking: solo aclara la regla para endpoints nuevos y para cualquier dev/Cursor que trabaje en el repo.

Los puntos firmes:

1. Todos los endpoints nuevos del módulo de ventas se montan bajo `/api/sales/...`.
2. No se monta ningún alias en español (`/api/ventas/*`) para evitar duplicación.
3. Las rutas de UI de Next.js (`/ventas/tablero`, `/ventas/pedidos`) permanecen en español porque son visibles al usuario final.
4. Los componentes del frontend llaman a `fetch('/api/sales/...')` sin capa de traducción intermedia.
5. Nombres del código (funciones, clases, variables) en inglés: `SalesOrder`, `createQuote`, `salesApiHandler`.
6. Strings visibles al usuario (labels, tooltips, errores) en español.

### Sobre el endpoint actual `GET /api/sales`

El listado principal de órdenes hoy vive en `GET /api/sales` (no en `/api/sales/orders`, que era la convención aspiracional). Para respetar "no breaking change":

- La ruta `GET /api/sales` se mantiene funcionando indefinidamente.
- En el momento en que se implemente el Kanban (Sprint 3 · BE-3.2), se agrega `GET /api/sales/orders` como alias apuntando al mismo handler.
- La ruta vieja queda marcada como deprecated en documentación pero operativa.
- No hay fecha forzada de retirada. Se retira solo cuando se confirme cero consumidores.

Ver tabla de endpoints aspiracional en la sección "Convenciones dentro de `/api/sales`" del ADR.

## Consecuencias

### Inmediatas

- Cero cambios de código requeridos por este ADR.
- Documentación de handlers existentes debe incluir comentario aclarando la regla (cuando se toquen por otro motivo, no ahora).

### En cada sprint siguiente

- Cualquier endpoint nuevo que se proponga bajo `/api/ventas/*` se rechaza en PR review citando este ADR.
- Alias nuevos para rutas existentes se agregan con convención `/api/sales/<recurso>` como se definió en la tabla del ADR.

### Interacción con ADR-001

- El endpoint histórico `GET /api/inbox/quotations` sigue vivo y funcional. En Sprint 2 o 3 se agrega alias `GET /api/sales/quotes` apuntando al mismo handler, sin breaking change.
- Nunca duplicar escritura: si el frontend migra a `/api/sales/quotes`, el handler sigue siendo el mismo código.

### Decisiones que quedan abiertas (NO parte de este ADR)

- Cuándo retirar `GET /api/inbox/quotations` como ruta pública. Depende de que frontend y cualquier integración externa migren a `/api/sales/quotes`.
- Política de versionado de API (`/api/v1/sales`, `/api/v2/sales`). No se adopta hoy. Si aparece necesidad de breaking change mayor, se hace ADR nuevo.
- Internacionalización futura de UI (inglés, portugués). Si se adopta, las rutas de UI pueden cambiar con i18n routing de Next.js. La API queda estable.

## Convenciones dentro de `/api/sales`

Tabla de referencia (objetivo / roadmap). **Rutas ya existentes** pueden diferir; antes de implementar, contrastar con `server.js` + `salesApiHandler.js`.

| Verbo | Ruta | Significado |
|-------|------|-------------|
| `GET` | `/api/sales` | **Hoy:** listado principal de órdenes (legacy). Ver handler. |
| `GET` | `/api/sales/pipeline` | Kanban (Sprint 3) |
| `GET` | `/api/sales/orders` | Lista REST explícita *(introducir sin romper `GET /api/sales` o documentar alias)* |
| `GET` | `/api/sales/orders/:id` | Detalle de orden |
| `PATCH` | `/api/sales/orders/:id/advance-stage` | Transición manual de etapa |
| `POST` | `/api/sales/orders/:id/cancel-by-buyer` | Cancelación desde bot |
| `POST` | `/api/sales/orders/:id/cancel-by-operator` | Cancelación por operador auditada |
| `GET` | `/api/sales/quotes` | Lista de cotizaciones |
| `POST` | `/api/sales/quotes` | Crear cotización |
| `PATCH` | `/api/sales/quotes/:id/approve` | Aprobar |
| `GET` | `/api/sales/exceptions` | Excepciones |
| `PATCH` | `/api/sales/exceptions/:id/resolve` | Resolver |
| `POST` | `/api/sales/chats/:id/take-over` | Tomar chat |
| `POST` | `/api/sales/chats/:id/return-to-bot` | Devolver al bot |
| `POST` | `/api/sales/payments/match-manual` | Matching bancario manual |

**Nota:** Mantener una sola forma de listar órdenes en el corto plazo (evitar dos GET distintos con el mismo significado). Si se añade `GET /api/sales/orders`, definir si `GET /api/sales` queda deprecado o son filtros distintos.

## Notas

- Endpoints no-sales (`/api/inbox/*`, Banesco, etc.) siguen sus propias convenciones.
