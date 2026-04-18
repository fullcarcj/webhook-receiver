# Plan de Sprints v2 · Módulo Unificado de Ventas Omnicanal
**Proyecto:** webhook-receiver (backend) + frontend Next.js
**Duración total:** 12 semanas · 6 sprints de 2 semanas
**Última actualización:** 18 · abril · 2026
**Versión:** 2.0 (incorpora auditoría real del repo)

**Prompts ejecutables por sprint** (índice, supervisión transversal, gates ADR): [`docs/prompts/README.md`](./prompts/README.md)

---

## Changelog respecto a v1

El plan v1 asumía un greenfield. Tras auditar el repo real, estos son los cambios críticos:

1. **Nombres de tablas corregidos:** `crm_chats` / `crm_messages` (no `chats`). `sales_orders` ya existe con campos propios. Prefijo API unificado a `/api/sales` (no `/api/ventas`).
2. **Sprint 0 agregado:** ADRs previos sobre cotizaciones (unificar vs paralelo), conciliación bancaria (webhook vs ingesta) y proveedor de IA. Sin estas decisiones, Sprints 1 y 4 se contradicen.
3. **Conciliación bancaria reescrita:** no es webhooks estilo Stripe. Es ingesta CSV/Playwright/cron sobre `bank_statements` (realidad actual).
4. **IA alineada a GROQ existente:** respeta `callChatBasic` y AI Responder ya implementados. Solo se evalúa otro modelo si GROQ no alcanza.
5. **Sprint 1 adelgazado:** solo ADR + migraciones mínimas + 1-2 endpoints piloto. El resto se reparte.
6. **Sprint 4 partido en dos:** automatización se divide entre S4 (cotización auto) y S5 (conciliación). S6 pasa a ser ficha 360° + hardening.
7. **Métricas movidas a semana 14:** 12 semanas (6 sprints × 2 semanas) + 2 semanas de operación real antes de evaluar.

---

## Principios rectores (no negociables)

1. **La venta nunca espera por el vendedor.** Si el sistema espera, espera al comprador.
2. **Solo el comprador cancela.** El sistema no cancela unilateralmente.
3. **El vendedor es supervisor de excepciones.** No operador.
4. **El comprador sabe que puede pedir un humano desde el primer mensaje.**
5. **Construimos sobre lo existente.** Respetamos `inboxService`, `crm_chats`, `sales_orders`, `inventario_presupuesto`, GROQ, Wasender.

---

## Mapa de sprints de un vistazo

| Sprint | Semanas | Foco | Entregable estrella |
|--------|---------|------|---------------------|
| **S0** | 0 | **Decisiones bloqueantes + ADRs** | 4 ADRs firmados |
| **S1** | 1-2 | Schema mínimo + endpoints piloto | Migraciones aditivas + 2 endpoints |
| **S2** | 3-4 | Bandeja pulida + handoff bot↔humano | `/bandeja` con handoff operativo |
| **S3** | 5-6 | Kanban de pipeline | `/ventas/tablero` con drag-and-drop |
| **S4** | 7-8 | Cotización automática | Bot arma y envía cotizaciones vía WA/ML |
| **S5** | 9-10 | Conciliación bancaria (CSV/cron) | Matching automático sobre `bank_statements` |
| **S6** | 11-12 | Ficha 360° + hardening | Ficha cliente + tests + observabilidad |

---

## SPRINT 0 · Decisiones bloqueantes y ADRs
**Semana 0 · Objetivo:** resolver 4 decisiones arquitectónicas que si se dejan para después, obligan a rehacer código.

### Por qué este sprint existe
El plan v1 asumía respuestas a estas preguntas. La auditoría del repo mostró que las suposiciones chocaban con código real. Sin estos ADRs firmados, S1 y S4 se pelean.

### ADRs a producir

**ADR-001 · Cotizaciones: ¿unificar con `inventario_presupuesto` o crear modelo paralelo?**
- **Contexto:** ya existe `GET /api/inbox/quotations` apoyado en tablas de inventario. El mockup habla de "cotizaciones" como entidad del flujo de venta.
- **Opciones:**
  - **A.** Extender `inventario_presupuesto` con campos que **aún falten** (en repo ya existen `chat_id`, `status`, `fecha_vencimiento` vía migraciones previas; ver `sql/20260423_presupuesto_inbox.sql` e `inboxQuotationHandler.js`)
  - **B.** Crear `sales_quotes` paralela y migrar datos gradualmente
  - **C.** Vista materializada que una ambas para el inbox
- **Decisión esperada:** A o B. La C es compromiso que arrastra deuda.
- **Dueño:** backend lead
- **Deadline:** día 2 de la semana 0

**ADR-002 · Conciliación bancaria: ¿webhook de tiempo real o ingesta por archivo?**
- **Contexto:** Banesco hoy se procesa vía monitor Playwright + CSV + tablas de extractos. Los bancos venezolanos no tienen webhooks estándar.
- **Opciones:**
  - **A.** Mantener ingesta CSV/Playwright con cron y matchear contra órdenes
  - **B.** Agregar webhooks donde el banco los ofrezca (pocos) y mantener CSV como fallback
  - **C.** Construir adaptadores por banco con interfaz común (Ports/Adapters)
- **Decisión esperada:** A para S5, C como roadmap. B solo si aparece un banco con API.
- **Dueño:** backend lead
- **Deadline:** día 3 de la semana 0

**ADR-003 · Proveedor de IA: ¿GROQ, Claude, o híbrido?**
- **Contexto:** ya hay `callChatBasic` y AI Responder con GROQ. Agregar Anthropic implica otra facturación, otro SDK, otra operación.
- **Opciones:**
  - **A.** GROQ para todo (clasificación + cotización + respuesta)
  - **B.** GROQ para clasificación barata, Claude para ambigüedades complejas
  - **C.** Claude para todo, deprecar GROQ gradualmente
- **Criterio de decisión:** costo operativo mensual + latencia + calidad medida con eval set de 50 mensajes reales
- **Decisión esperada:** probablemente A o B. La C necesita justificación fuerte.
- **Dueño:** backend lead + PO
- **Deadline:** día 4 de la semana 0

**ADR-004 · Nomenclatura API: `/api/sales` vs `/api/ventas`**
- **Contexto:** el código actual usa `/api/sales/*`. El plan v1 mezclaba con `/api/ventas/*`.
- **Decisión:** **unificar a `/api/sales`** en backend. En frontend las rutas de UI pueden ser en español (`/ventas/tablero`) porque son para humanos, pero las API requests siempre a `/api/sales`.
- **Dueño:** tech lead
- **Deadline:** día 1 de la semana 0 (decisión rápida)

### Estado actual de los ADRs (actualizar en cada firma)

| ADR | Estado | Fecha firma | Decisión |
|-----|--------|-------------|----------|
| ADR-001 Cotizaciones | ✓ Aceptado | 2026-04-18 | Opción A · completar extensión de `inventario_presupuesto` |
| ADR-002 Conciliación bancaria | Propuesta | — | Pendiente |
| ADR-003 IA | Propuesta · datos parciales | — | Eval con `llama-3.1-8b` dio 84% intent / 58% confidence; evaluar modelo más grande o esperar dataset real post-migración |
| ADR-004 Naming API | ✓ Aceptado | 2026-04-18 | Opción B · backend inglés, UI español |
| ADR-005 Catálogo canónico | ✓ Aceptado | 2026-04-18 | `products` canónico; caso Sprint 1 `inventario_detallepresupuesto` · ver [ADR-005](./adr/ADR-005-catalogo-products-canonico.md) |
| ADR-006 Aprobación de pagos | ✓ Aceptado | 2026-04-18 | Alta confianza auto-aprueba; manual → propuesta + caja; ver [ADR-006](./adr/ADR-006-segregacion-aprobacion-pagos.md). Alinea Sprint 5 con ADR-002 |
| ADR-006 amendment (L1/L2 auto · L3 caja) | ✓ Aceptado | 2026-04-18 | Consolidado en segregación + [prompt Sprint 5 v3](./prompts/prompt-sprint-5.md) |
| ADR-007 Política omnicanal pagos | ✓ Aceptado | 2026-04-19 | Whitelist canales, split, pipelines — [ADR-007](./adr/ADR-007-politica-omnicanal-pagos.md) |
| ADR-007 amendment (moneda motor) | ✓ Aceptado | 2026-04-19 | Matching vs `total_amount_bs` — [amendment](./adr/ADR-007-amendment-moneda-canonica.md) |
| ADR-008 Moneda canónica matching | ✓ Aceptado | 2026-04-19 | `total_amount_bs` vs banco; BE-5.0 — [ADR-008](./adr/ADR-008-moneda-canonica-matching.md) |

**Pendiente operativo:** ejecutar queries DDL del archivo `ADR-001-auditoria-estructural-2026-04-18.md` cuando haya `DATABASE_URL` local, antes de la primera migración de Sprint 1.

### Entregables del Sprint 0
- [ ] 4 ADRs escritos, revisados y firmados en `docs/adr/`
- [ ] Spike técnico Wasender: probar envío de `interactive message` real. Documentar si soporta botones o si toca fallback numerado.
- [ ] Revisar si `@hello-pangea/dnd` está en el `package.json` del frontend Next.js. Si no, agregar al plan de S3.
- [ ] Smoke test de costos estimados de IA con 1000 mensajes al día.

### Criterios de éxito
- [ ] Los 4 ADRs tienen opción elegida con justificación
- [ ] El equipo entiende qué se mantiene (GROQ, `inventario_presupuesto`, CSV bancarios) y qué se agrega

---

## SPRINT 1 · Schema mínimo + endpoints piloto
**Semanas 1-2 · Objetivo:** migraciones aditivas sobre el modelo existente + 2 endpoints piloto para desbloquear al frontend. **No más que eso.**

### Por qué adelgazado respecto a v1
El S1 original tenía ADR + migraciones + 6 endpoints + ampliar counts + tipos + wrappers. Imposible en 2 semanas con 1 persona. Ahora el ADR ya está firmado en S0, las migraciones son aditivas mínimas y los endpoints piloto son solo lo que desbloquea el Sprint 2.

### Tickets backend

**BE-1.1 · Auditoría documentada de tablas existentes** (1 día)
Crear `docs/SCHEMA_ACTUAL.md` con los nombres y campos **reales**:
- `crm_chats`, `crm_messages`
- `sales_orders`, `sales_channels` (ids 1-5), `sales_order_items`
- `customers`, `ml_orders`
- `inventario_presupuesto` y relacionadas
- `bank_statements` y tablas de extractos actuales
- Catálogo de productos e inventario

Sin este documento, el equipo asume nombres incorrectos.

**BE-1.2 · Migraciones aditivas según ADR-001** (2 días)

> **Pre-requisito:** cerrar gap DDL del ADR-001. Ejecutar queries `information_schema.columns`, `pg_constraint`, `pg_indexes` contra Postgres local/staging y pegar resultados literales en `docs/adr/ADR-001-auditoria-estructural-2026-04-18.md`. Sin este paso, no ejecutar migraciones.

**Nota:** ADR-002 (conciliación) no exige cambios de esquema en S1; la ingesta/matching vive en S5. Aquí solo lo necesario para S2/S3:

- `crm_chats` + columna `is_exception` (boolean, default false) + `exception_reason` (text, nullable)
- `bot_handoffs` tabla nueva (id, chat_id, from_bot, to_user_id, reason, started_at, ended_at)
- Extensión de `inventario_presupuesto` según ADR-001 (si fue opción A) o creación de `sales_quotes` (si fue B). **El resto de tablas (payments extendido, dispatches, ratings, exceptions) se pospone a los sprints donde se usan.**

Migraciones versionadas y reversibles.

**BE-1.3 · Endpoint piloto: toma manual del chat** (2 días)
`POST /api/sales/chats/:id/take-over` — valida permisos, inserta en `bot_handoffs`, marca chat como tomado, devuelve estado.

**BE-1.4 · Endpoint piloto: devolver al bot** (1 día)
`POST /api/sales/chats/:id/return-to-bot` — cierra el registro de handoff activo.

**BE-1.5 · Extender `/api/inbox/counts`** (1 día)
Agregar solo los contadores que se verán en S2: `exceptions`, `handed_over` (chats actualmente tomados por humano). El resto de contadores se agregan en sus sprints correspondientes.

### Tickets frontend

**FE-1.1 · Tipos TypeScript mínimos** (1 día)
En `src/types/sales.ts` crear solo las interfaces necesarias para S2: `ChatHandoff`, extensión de tipo de chat existente con `is_exception` y `exception_reason`. El resto se agrega cuando haga falta.

**FE-1.2 · Wrappers de API para handoff** (0.5 día)
En `src/lib/api/sales.ts` funciones `takeOverChat(chatId)` y `returnChatToBot(chatId)`. Patrón fetch + cookie igual que el existente.

### Criterios de éxito del Sprint 1
- [ ] `docs/SCHEMA_ACTUAL.md` aprobado por el equipo
- [ ] Migraciones corriendo en staging sin errores y reversibles
- [ ] Endpoints de take-over / return probados con Postman/Thunder
- [ ] Cero regresiones en `/api/inbox`
- [ ] Tipos frontend compilan sin errores

### Riesgos y mitigaciones
- **Riesgo:** ADR-001 no estaba firmado al iniciar S1 → bloqueo total. **Mitigación:** S0 es obligatorio.
- **Riesgo:** migraciones rompen `inventario_presupuesto`. **Mitigación:** solo aditivas, backup previo, staging first.

---

## SPRINT 2 · Bandeja omnicanal + handoff bot↔humano
**Semanas 3-4 · Objetivo:** la bandeja actual se convierte en la vista definitiva del vendedor con indicador claro de cuándo el bot controla vs. cuándo lo toma un humano.

### Tickets backend

**BE-2.1 · Ampliar `/api/inbox` con flag de excepción** (1 día)
El listado incluye `is_exception` y `exception_reason`. Sin cambio de shape mayor.

**BE-2.2 · Endpoint de listado de excepciones** (1.5 días)
- `GET /api/sales/exceptions` lista las activas con paginación
- `PATCH /api/sales/exceptions/:id/resolve` con nota del vendedor
- La tabla `exceptions` se crea en este sprint (pospuesta desde S1)

**BE-2.3 · Integración con respuesta de WhatsApp en chat tomado** (1 día)
Cuando un chat está en `bot_handoffs` activo, el motor de respuestas automáticas lo ignora. El vendedor escribe y el mensaje sale vía Wasender como hoy.

**BE-2.4 · Mensaje de sistema en handoff** (1 día)
Al tomar un chat, se inserta un mensaje tipo `system` en `crm_messages` que renderiza el frontend: "Javier se ha unido a la conversación". Al devolver: "Javier devolvió la conversación al asistente automático".

**BE-2.5 · Catálogo de códigos de excepción** (0.5 día)
Enum documentado en `docs/EXCEPTION_CODES.md`:
- `payment_no_match`
- `stock_zero`
- `customer_complaint`
- `ambiguity_unresolved`
- `amount_over_threshold`
- `ml_question_complex`

**BE-2.6 · Endpoint de cancelación iniciada por comprador** (1 día)
Resuelve la contradicción del v1. Dos endpoints distintos:
- `POST /api/sales/orders/:id/cancel-by-buyer` — invocado por el bot cuando el comprador presiona "Cancelar compra" en WhatsApp. Audit log marca `actor: buyer`.
- `POST /api/sales/orders/:id/cancel-by-operator` — invocado por vendedor con permiso elevado. Audit log marca `actor: operator` + razón obligatoria.

El principio "solo el comprador cancela" sigue vigente para el flujo normal. El endpoint operador existe solo para casos extremos (fraude confirmado, producto descatalogado, etc.) y está audited.

### Tickets frontend

**FE-2.1 · Indicador visual bot vs humano en `ChatWindow`** (1.5 días)
Chip en el header:
- Morado `🤖 BOT ACTIVO` cuando no hay handoff
- Azul `👤 TOMADA · {nombre}` cuando hay handoff activo
- Avatar del humano

**FE-2.2 · Botón "Tomar" / "Devolver al bot"** (1 día)
En `ChatHeader`. Confirm antes de tomar. Llama a endpoint y refresca via polling existente.

**FE-2.3 · Banner sistema en lista de mensajes** (1 día)
Cuando un mensaje de `crm_messages` es tipo `system`, renderizar sin burbuja, texto centrado, gris tenue. Estilo tal como WhatsApp muestra "Este mensaje fue eliminado" o "X cambió el nombre del grupo".

**FE-2.4 · Pestaña "Excepciones" en la bandeja** (2 días)
Tabs superiores: `Todas · Mías · Excepciones (N)`. La N viene de `/api/inbox/counts`. Click en tab de excepciones → listado desde `/api/sales/exceptions` con cards.

**FE-2.5 · Card de excepción con acciones** (1 día)
Cada card muestra: razón (código humanizado), cliente, preview del problema, botones: "Abrir chat", "Resolver", "Escalar". Click en "Resolver" abre modal con campo de nota.

**FE-2.6 · Microcopy en filtros** (0.5 día)
Español neutro: "Pago pendiente", "Cotización", "Despacho", con tooltips de ayuda.

**FE-2.7 · Estado vacío mejorado** (0.5 día)
Cuando no hay conversaciones: "No hay conversaciones pendientes. El bot está manejando todo bien 👌"

### Criterios de éxito del Sprint 2
- [ ] Un vendedor toma un chat, escribe, devuelve al bot sin perder historial
- [ ] El cliente recibe mensajes del sistema claros en los handoffs
- [ ] La pestaña de excepciones lista las 5-6 razones con acciones funcionales
- [ ] Contadores de `/api/inbox/counts` siempre coherentes con la realidad

### Riesgos y mitigaciones
- **Riesgo:** Wasender tarda en enviar mensaje del sistema. **Mitigación:** mostrar optimistic UI, degradar con toast si falla.
- **Riesgo:** dos vendedores toman el mismo chat. **Mitigación:** `bot_handoffs` tiene constraint de unique active handoff por chat.

---

## SPRINT 3 · Kanban de pipeline
**Semanas 5-6 · Objetivo:** `/ventas/tablero` con tablero Kanban por estado de venta usando `sales_orders` reales.

### Tickets backend

**BE-3.1 · Vista o columna de etapa en `sales_orders`** (2 días)
**Decisión importante:** en lugar de inventar `chats.stage`, usar lo que `sales_orders` ya tiene:
- `payment_status`
- `fulfillment_type`
- presencia de orden ligada a chat
- estado de cotización

Crear una **vista SQL `v_sales_pipeline`** que calcula la etapa a partir de esos campos. Esto evita añadir una columna redundante y mantiene consistencia.

Mapa de etapas calculadas:
- `conversation` → chat sin orden ni cotización activa
- `quote` → cotización activa, no aprobada
- `approved` → cotización aprobada, sin pago
- `payment` → `payment_status = pending` con orden
- `dispatch` → `payment_status = approved` + `fulfillment_type` definido
- `closed` → `payment_status = approved` + despacho completado + rating

**BE-3.2 · Endpoint `GET /api/sales/pipeline`** (2 días)
Consume `v_sales_pipeline`. Devuelve columnas + cards. Filtros: `?channel=wa&seller=3&from=2026-04-01`.

**BE-3.3 · Endpoint de transición manual** (1.5 días)
`PATCH /api/sales/orders/:id/advance-stage` — solo para casos donde el vendedor necesita forzar transición por excepción. Valida transiciones legales. Persiste en audit log con razón.

**NO existe "mover hacia atrás" de forma arbitraria.** Regresiones son excepciones formales (cancel, refund).

**BE-3.4 · Índices para performance** (1 día)
Índices en `sales_orders (payment_status, updated_at)` y en la vista si es materializada. Objetivo: `/api/sales/pipeline` responde <200ms con 1000 órdenes.

### Tickets frontend

**FE-3.1 · Página `/ventas/tablero`** (1 día)
Ruta en App Router bajo `(features)/ventas/tablero/page.tsx`. Usa `FeaturesAuthGate` existente.

**FE-3.2 · Instalación y setup de DnD** (1 día)
Verificar si `@hello-pangea/dnd` está en el front Next.js (no confundir con el backend webhook-receiver). Si no, `pnpm add @hello-pangea/dnd`. Prueba de accesibilidad: navegación por teclado funcional.

**FE-3.3 · Componente `<KanbanBoard>` reutilizable** (2 días)
En `src/components/kanban/KanbanBoard.tsx`. Props tipadas. API lista para montar desde `/ventas/tablero` y en el futuro desde `/bandeja` si se decide.

**FE-3.4 · `<SalesCard>` con datos reales** (1.5 días)
Badge de canal (usando `sales_channels.id`), cliente, monto, vendedor, tiempo, pills de alerta.

**FE-3.5 · Toolbar de filtros** (1 día)
Chips de canal, vendedor, período. Sincroniza con query params.

**FE-3.6 · Optimistic UI + rollback** (1 día)
Drag termina → mover card → PATCH → si falla, revertir + toast.

**FE-3.7 · Polling del pipeline** (0.5 día)
Cada 30s. Pausado cuando pestaña no visible (Page Visibility API).

### Criterios de éxito del Sprint 3
- [ ] Vendedor ve 6 columnas con ventas reales de staging
- [ ] Drag de "Aprobada" a "Despacho" persiste y es audit-logeado
- [ ] Filtros compartibles por URL
- [ ] Tablero <300ms con 200+ ventas

---

## SPRINT 4 · Cotización automática
**Semanas 7-8 · Objetivo:** el bot lee mensajes entrantes de WA/ML y genera cotizaciones sin intervención humana cuando la confianza es alta.

### Deuda técnica heredada de Sprint 1

**BE-4.0-pre · Rename `producto_id` → `product_id` en `inventario_detallepresupuesto`** (0.5 día)
Diferido desde BE-1.4 (commit `10255cb`). La FK ya apunta a `products`; solo falta renombrar la columna y actualizar `inboxQuotationHandler.js` (6 ocurrencias: INSERT, SELECT, JOIN, validación). Hacer en el mismo PR que BE-4.2 (motor de cotización) para no abrir el handler dos veces.

### Tickets backend

**BE-4.1 · Servicio NLU con GROQ** (3 días)
Basado en ADR-003. Extender `callChatBasic` existente o crear `src/services/nluService.js`. Entrada: mensaje. Salida:
```json
{
  "intent": "product_inquiry",
  "vehicle": { "make": "Toyota", "model": "Corolla", "year": 2018 },
  "parts": [{ "category": "brake_pad", "position": "front" }],
  "confidence": 0.94
}
```
Si `confidence < 0.85` → crea excepción `ambiguity_unresolved`.

Eval set de 50 mensajes reales para medir accuracy. Baseline antes de medir objetivos.

**BE-4.2 · Motor de cotización automática** (3 días)
`src/services/autoQuoteService.js`. Usa `inventario_presupuesto` o `sales_quotes` según ADR-001. Pasos:
1. Buscar SKUs que matcheen vehículo + pieza
2. Aplicar reglas de productos complementarios (configurables en DB)
3. Calcular precio con márgenes actuales
4. Reservar stock 72h
5. Persistir cotización con `created_by_bot: true`
6. Enviar tarjeta interactiva (botones si Wasender soportó; fallback numerado según spike S0)

**BE-4.3 · Política de umbral de monto** (0.5 día)
Config `AUTO_QUOTE_MAX_AMOUNT=2000` (env var). Cotizaciones sobre ese monto → excepción `amount_over_threshold` → esperan aprobación humana antes de enviar.

**BE-4.4 · Motor de recordatorios (parte 1)** (1.5 días)
Job horario. Para cotizaciones en estado "enviada, no aprobada":
- 6h sin actividad → recordatorio suave
- 24h sin respuesta → recordatorio con botón "¿Necesitas más tiempo?"
- Nunca cancela.
- Si cliente pide tiempo → pausa 12h.

### Tickets frontend

**FE-4.1 · Badge "🤖 BOT" en cotizaciones auto-generadas** (0.5 día)
En `ChatWindow` y en Kanban, cuando `quote.created_by_bot === true`.

**FE-4.2 · Modal de resolución de excepción `amount_over_threshold`** (2 días)
Abre desde pestaña de excepciones. Muestra cotización pre-armada por bot, vendedor puede editar ítems o montos y aprobar. Al aprobar, se envía al cliente y la excepción se cierra.

**FE-4.3 · Timeline de automatizaciones por venta** (1.5 días)
En ficha de orden (sidebar o modal): log cronológico. "09:14 bot detectó pastillas Corolla · 09:14 bot armó cotización $191 · 17:58 cliente aprobó".

### Criterios de éxito del Sprint 4
- [ ] NLU con accuracy medida sobre eval set (objetivo: >80%, baseline real antes de prometer 70%+)
- [ ] Bot envía cotizaciones sin intervención cuando confidence es alta
- [ ] Umbral de monto funciona: sobre $2000 crea excepción, no envía
- [ ] Motor de recordatorios nunca cancela; siempre comunica

### Riesgos y mitigaciones
- **Riesgo:** NLU se equivoca con catálogo sucio. **Mitigación:** eval set antes, prometer % solo después.
- **Riesgo:** costos de IA explotan. **Mitigación:** métricas de tokens por día desde día 1 del sprint.

---

## SPRINT 5 · Conciliación bancaria (realidad venezolana)
**Semanas 9-10 · Objetivo:** matching automático de pagos sobre `bank_statements` existentes. **Sin inventar webhooks que no existen.**

### Por qué este sprint separado
El v1 mezclaba NLU + cotización + webhooks + recordatorios en S4. Imposible. Y los webhooks bancarios no existen en Venezuela como en Stripe. Este sprint se enfoca en lo real.

### Tickets backend

**BE-5.1 · Adaptadores de ingesta bancaria (Ports/Adapters)** (3 días)
Según ADR-002 opción C. Interface:
```typescript
interface IBankStatementSource {
  fetchNew(): Promise<BankTransaction[]>
  getName(): string
}
```
Adaptadores concretos:
- `BanescoPlaywrightAdapter` (existente, solo formalizar interfaz)
- `BDVCsvAdapter` (ingesta por upload manual o cron)
- `MercantilCsvAdapter` (igual)

Cada uno alimenta `bank_statements`.

**BE-5.2 · Motor de matching** (3 días)
`src/services/paymentMatchingService.js`. Para cada transacción nueva en `bank_statements`:
1. Busca órdenes en estado `payment_status=pending` con monto = transacción ± tolerancia $1
2. Filtra por ventana temporal (±30 min del mensaje de pago en WA)
3. Si hay 1 match → enlaza, cambia `payment_status=approved`, dispara evento
4. Si hay abono parcial (monto menor) → enlaza como parcial, orden sigue pending
5. Si hay múltiples candidatos → excepción `payment_no_match` para revisión manual
6. Si no hay match → deja en `bank_statements` sin vincular para revisión

Documentar tasa esperada de match automático: **realista 70-85%, no 95%**. El 15-30% restante son excepciones normales.

**BE-5.3 · Endpoint de matching manual** (1 día)
`POST /api/sales/payments/match-manual` — vendedor elige transacción + orden y los enlaza. Audit log obligatorio.

**BE-5.4 · Motor de recordatorios (parte 2)** (1.5 días)
Para órdenes aprobadas sin pago:
- 6h → recordatorio con datos bancarios
- 24h → botón "Ya pagué, subir comprobante" (si Wasender permite subida de archivos)
- Nunca cancela.

### Tickets frontend

**FE-5.1 · Vista de transacciones sin match** (2 días)
`/finanzas/conciliacion` o integrado en pestaña de excepciones. Lista de transacciones en `bank_statements` sin orden vinculada. Tabla con: banco, monto, referencia, fecha, acciones (buscar orden, marcar como no-venta).

**FE-5.2 · Modal de matching manual** (1.5 días)
Desde la tabla, click → modal busca órdenes candidatas por monto y fecha. Lista sugeridas. Vendedor selecciona y confirma.

**FE-5.3 · Badge de "conciliado por bot" vs "manual"** (0.5 día)
En ficha de orden y Kanban.

### Criterios de éxito del Sprint 5
- [ ] Banesco matchea automáticamente >70% de pagos en staging
- [ ] BDV/Mercantil ingresan por CSV sin errores
- [ ] Transacciones sin match visibles en UI con acciones claras
- [ ] Audit log completo de matching manual

### Riesgos y mitigaciones
- **Riesgo:** Playwright de Banesco falla intermitente. **Mitigación:** monitor existente + alertas tempranas.
- **Riesgo:** referencias bancarias ambiguas. **Mitigación:** tolerancia configurable + UI robusta para resolución manual.

---

## SPRINT 6 · Ficha 360° + hardening
**Semanas 11-12 · Objetivo:** vista completa del cliente + preparar producción.

### Tickets backend

**BE-6.1 · Endpoint de ficha 360°** (2 días)
`GET /api/customers/:id/360` con datos + KPIs + timeline + vehículos + favoritos + canales + saldos.

**BE-6.2 · Suite de tests de integración** (3 días)
- Happy path WA: mensaje → NLU → cotización → aprobación → pago match → cierre
- Happy path ML
- Handoff bot↔humano
- Pago sin match → resolución manual
- Excepción de monto alto → aprobación vendedor

Cobertura objetivo: 70% en servicios críticos, 50% en handlers.

**BE-6.3 · Observabilidad** (2 días)
Métricas (si hay Prometheus; si no, logs estructurados a archivo):
- `inbox_messages_total`
- `quotes_generated_total{by_bot}`
- `payments_matched_total{auto, manual}`
- `exceptions_raised_total{reason}`
- `bot_handoffs_total`

Dashboard con 8-10 paneles. Alertas básicas.

### Tickets frontend

**FE-6.1 · Página `/clientes/[id]/360`** (3 días)
Layout según mockup v2: top bar + 5 KPIs + 3 columnas (contacto/timeline/charts).

**FE-6.2 · Gráficos ligeros (SVG)** (1 día)
Barras de compras/mes y barras de canales. Sin Chart.js.

**FE-6.3 · Tests E2E con Playwright** (2 días)
3 flujos críticos. Fixtures estables.

**FE-6.4 · Guía de usuario en español** (1 día)
`docs/GUIA_VENDEDOR.md` con capturas para capacitación.

### Criterios de éxito del Sprint 6
- [ ] Ficha 360° <500ms
- [ ] Tests de integración pasan en CI
- [ ] Dashboard observabilidad visible
- [ ] Equipo comercial capacitado

---

## Evaluación final · Semana 14

| Métrica | Baseline medida en S0 | Objetivo |
|---------|----------------------|----------|
| Tiempo de primera respuesta | Medir en S0 | <10 seg |
| Ventas sin intervención vendedor | Medir en S0 | Según baseline, objetivo realista +40pp |
| Tasa de match automático de pagos | 0% (no existe hoy) | 70-85% (no 95%) |
| Excepciones resueltas <1h | N/A | >70% |
| NPS post-venta | No medido | Medir desde S2, objetivo progresivo |
| Tiempo admin del vendedor | Medir en S0 | Reducir 40% |

**Principio:** no prometer números sin baseline. Los objetivos se ajustan tras S0 cuando haya datos reales.

---

## Decisiones bloqueantes revisadas (pre-S0)

1. **¿Wasender sigue como provider WhatsApp?** Si hay plan de migrar a Cloud API, afecta spike de botones.
2. **¿Qué bancos entran en scope para S5?** Banesco es seguro. BDV y Mercantil según prioridad negocio.
3. **¿Quién es el PO del negocio?** Decisor de UX.
4. **¿Tenemos 1-2 vendedores reales para beta testing?** Desde S2.
5. **¿Catálogo de productos/inventario limpio?** Si no, S4 se resiente.
6. **¿Hay budget para GROQ/Claude en operación mensual?** Estimado desde S0.

---

## Contradicciones cerradas del v1

| Tema | Problema v1 | Resolución v2 |
|------|-------------|---------------|
| Cotizaciones | Proponía `quotes` nueva ignorando `inventario_presupuesto` | ADR-001 decide antes de migrar |
| Conciliación | "Webhook bancario estilo Stripe" | ADR-002 → ingesta CSV/Playwright real |
| IA | Asumía Claude + Anthropic | ADR-003 → GROQ primero, evaluar complemento |
| API naming | Mezclaba `/api/sales` y `/api/ventas` | ADR-004 → backend `/api/sales`, UI en español OK |
| Cancelación | "Solo comprador cancela" vs endpoint abierto | Dos endpoints: `cancel-by-buyer` y `cancel-by-operator` con audit diferenciado |
| Stage en chats | Inventaba columna nueva | Usar campos reales de `sales_orders` vía vista SQL |
| Nombres de tablas | `chats`, `messages` | `crm_chats`, `crm_messages`, `sales_orders` |
| Timing | 10 sem con S4 sobrecargado | 12 sem con S4 y S5 separados, S0 de ADRs |
| Métricas | Semana 12 para plan de 10 sem | Semana 14 = S6 + 2 sem operación real |

---

**Fin del plan v2.**

Este plan es ejecutable contra el repo real. Si durante la ejecución aparece un desacuerdo entre el plan y la realidad del código, la realidad gana: actualizar el plan primero.

---

## Checks al bajar a tickets (del code review de backend)

Estos no bloquean la aprobación del plan, pero deben validarse al momento de escribir los tickets reales:

| Tema | Qué validar |
|------|-------------|
| `crm_messages.type` | Si el enum actual no tiene valor `system`, hace falta migración antes de BE-2.4. Incluir en migraciones aditivas de S1 o al inicio de S2. |
| `POST /api/sales/chats/...` | Confirmar montaje en `salesApiHandler` / `server.js`. Revisar que no se solape con rutas existentes de `/api/sales`. |
| `v_sales_pipeline` | El mapa de etapas es razonable pero cada regla debe apoyarse en columnas reales. Ejemplo: "rating / cerrado" puede requerir campos nuevos en `sales_orders` o lectura de feedback ML. Validar en BE-3.1. |
| BE-2.3 (pausar IA en handoff) | Pausar automatizaciones cuando hay handoff activo puede tocar varios puntos de entrada (AI Responder, motor de recordatorios, auto-cotización). Si 1 día se queda corto, dividir en sub-tickets dentro de S2. |

---
