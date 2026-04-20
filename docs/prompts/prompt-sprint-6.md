# Prompt · Sprint 6 · Ficha 360° + Dashboard del Supervisor + Hardening

**Destinatario:** Cursor Backend + Frontend
**Duración:** 2 semanas
**Pre-requisitos:** Sprints 1-5 completados.

---

## Objetivo del sprint

1. **Ficha 360° del cliente** — vista completa con KPIs, timeline, vehículos, productos favoritos
2. **Dashboard del supervisor** — vista central para monitorear la calidad del bot y corregir en tiempo real
3. **Suite de tests de integración** — cobertura del happy path de venta completo
4. **Observabilidad** — métricas, dashboards, alertas
5. **Guía de usuario** — documentación para capacitación

Al cerrar, el módulo está listo para producción con clientes reales.

---

## Tickets backend

### BE-6.1 · Endpoint `GET /api/customers/:id/360` (2 días)

**Response:**

```json
{
  "customer": {
    "id": 123,
    "name": "Yorman Cuadra",
    "phone": "+58 414-555-0291",
    "email": "...",
    "rating_average": 4.9,
    "created_at": "2023-04-18T..."
  },
  "kpis": {
    "total_spent_usd": 2487,
    "orders_count": 14,
    "avg_ticket_usd": 178,
    "ltv_estimated_usd": 6200,
    "days_since_first_order": 900,
    "days_since_last_order": 2
  },
  "channels_usage": [
    { "source_type": "wa_inbound", "percentage": 72 },
    { "source_type": "wa_ml_linked", "percentage": 18 },
    { "source_type": "ml_message", "percentage": 10 }
  ],
  "top_products": [
    { "sku": "TOY-BRK-COR18", "name": "Pastillas Corolla", "times_bought": 3 },
    { "sku": "...", "name": "...", "times_bought": 2 }
  ],
  "monthly_activity": [
    { "month": "2025-05", "orders": 1, "total_usd": 120 },
    { "month": "2025-06", "orders": 2, "total_usd": 340 }
  ],
  "timeline": [
    {
      "type": "order",
      "id": 79416,
      "at": "2026-04-18T18:04:00Z",
      "summary": "Cotización aprobada · $191",
      "status": "pending_payment"
    },
    {
      "type": "exception",
      "id": 42,
      "at": "2026-04-15...",
      "summary": "Pago sin match resuelto por Carlos G"
    },
    {
      "type": "rating",
      "id": 18,
      "at": "2026-04-03...",
      "summary": "⭐⭐⭐⭐⭐ — Todo perfecto, volveré"
    },
    ...últimas 50 interacciones
  ],
  "active_vehicles": [
    { "make": "Toyota", "model": "Corolla", "year": 2018, "plate": "AB-4578" }
  ]
}
```

**Query compuesta:**

```sql
-- KPIs
SELECT
  COUNT(*) AS orders_count,
  SUM(order_total_amount) AS total_spent_usd,
  AVG(order_total_amount) AS avg_ticket_usd,
  MIN(created_at) AS first_order_at,
  MAX(created_at) AS last_order_at
FROM sales_orders
WHERE customer_id = $1 AND payment_status = 'approved';

-- Canales usados
SELECT
  c.source_type,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS percentage
FROM sales_orders so
JOIN crm_chats c ON c.id = so.conversation_id
WHERE so.customer_id = $1
GROUP BY c.source_type
ORDER BY COUNT(*) DESC;

-- Top productos (de sales_order_items)
SELECT
  soi.sku,
  p.name,
  COUNT(*) AS times_bought
FROM sales_order_items soi
JOIN sales_orders so ON so.id = soi.sales_order_id
LEFT JOIN products p ON p.id = soi.product_id
WHERE so.customer_id = $1
GROUP BY soi.sku, p.name
ORDER BY times_bought DESC
LIMIT 5;

-- Actividad mensual
SELECT
  TO_CHAR(created_at, 'YYYY-MM') AS month,
  COUNT(*) AS orders,
  SUM(order_total_amount) AS total_usd
FROM sales_orders
WHERE customer_id = $1
  AND created_at >= NOW() - INTERVAL '12 months'
GROUP BY month
ORDER BY month ASC;

-- Timeline (unión de varios eventos)
SELECT 'order' AS type, id, created_at AS at,
  CONCAT('Orden #', id, ' · USD ', order_total_amount) AS summary
FROM sales_orders
WHERE customer_id = $1
UNION ALL
SELECT 'exception' AS type, id, created_at,
  CONCAT('Excepción: ', reason) AS summary
FROM exceptions
WHERE chat_id IN (SELECT id FROM crm_chats WHERE customer_id = $1)
UNION ALL
-- ...más eventos
ORDER BY at DESC
LIMIT 50;
```

**LTV estimado:** fórmula simple = `avg_ticket * orders_per_year * years_expected`. Documentar asunciones.

**Criterios:**
- [ ] Endpoint responde en < 500ms
- [ ] Todos los KPIs calculados correctamente
- [ ] Timeline incluye órdenes, excepciones, calificaciones, correcciones
- [ ] Tests con cliente de ejemplo

---

### BE-6.2 · Endpoint dashboard del supervisor (2 días)

**Ruta:**

```
GET /api/sales/supervisor-dashboard?period=24h
```

**Response:**

```json
{
  "period": "24h",
  "bot_metrics": {
    "actions_total": 450,
    "actions_reviewed": 120,
    "actions_correct": 95,
    "actions_incorrect": 25,
    "correction_rate": 0.208,
    "avg_confidence": 0.87,
    "cost_usd_estimated": 0.42
  },
  "pipeline_metrics": {
    "orders_created": 32,
    "orders_closed": 28,
    "revenue_usd": 4820,
    "exceptions_raised": 8,
    "exceptions_resolved": 5
  },
  "quality_trend": {
    "correction_rate_by_day": [
      { "day": "2026-04-12", "rate": 0.15 },
      { "day": "2026-04-13", "rate": 0.18 },
      ...
    ]
  },
  "top_correction_types": [
    { "type": "intent_wrong", "count": 12 },
    { "type": "entities_wrong", "count": 8 },
    { "type": "response_wrong", "count": 5 }
  ],
  "alerts": [
    {
      "level": "warn",
      "message": "Correction rate subió de 15% a 21% en las últimas 24h",
      "metric": "correction_rate",
      "value": 0.208
    }
  ]
}
```

**Queries:** agregaciones sobre `bot_actions`, `bot_corrections`, `sales_orders`, `exceptions`.

**Alertas:** reglas simples:
- Si correction_rate > 20% → warn
- Si exceptions_raised / orders_created > 0.3 → warn
- Si algún adapter bancario caído → critical
- Si cost_usd_estimated > budget_daily → critical

**Criterios:**
- [ ] Todas las métricas correctas
- [ ] Response < 500ms con caché de 60s
- [ ] Alertas se activan cuando corresponde

---

### BE-6.3 · Suite de tests de integración (3 días)

**Archivo:** `test/integration/happy-paths.test.js`

**Tests obligatorios:**

1. **Happy path WA:**
   - Cliente envía mensaje → NLU clasifica correctamente
   - Bot genera cotización automática
   - Cliente aprueba (simular POST de botón)
   - Transacción bancaria entra
   - Matching automático aprueba pago
   - Despacho se crea (simular motorizado)
   - Rating 5 → orden cierra
   - Verificar audit log completo

2. **Happy path ML:**
   - Similar al anterior pero canal ML
   - Verificar manejo de preguntas de publicación vs. mensajería post-venta

3. **Handoff bot → humano → bot:**
   - Conversación con bot
   - Vendedor toma chat
   - Bot no responde mientras handoff activo
   - Vendedor devuelve al bot
   - Bot retoma

4. **Pago sin match:**
   - Transacción entra sin orden candidata
   - Excepción se crea
   - Supervisor matchea manualmente
   - Excepción se resuelve

5. **Monto sobre umbral:**
   - NLU extrae cotización grande
   - Excepción `amount_over_threshold` se crea
   - Supervisor aprueba desde modal
   - Cotización se envía

6. **Corrección del supervisor:**
   - Bot clasifica mensaje con intent incorrecto
   - Supervisor corrige via `POST /bot-actions/:id/correct`
   - Verificar entry en `bot_corrections`

**Criterios:**
- [ ] Los 6 tests pasan
- [ ] Corren en CI sin flakes
- [ ] Datos limpios entre tests (teardown efectivo)

---

### BE-6.4 · Métricas Prometheus / logs estructurados (2 días)

**Objetivo:** exponer métricas para Grafana/Prometheus o equivalente.

**Métricas clave:**

```
# Counters
solomotorx_messages_total{source}
solomotorx_bot_actions_total{action_type,provider}
solomotorx_quotes_generated_total{created_by_bot}
solomotorx_orders_created_total{channel}
solomotorx_payments_matched_total{method,bank}  # method: auto|manual
solomotorx_exceptions_raised_total{reason,severity}
solomotorx_bot_corrections_total{correction_type}

# Histograms
solomotorx_nlu_latency_ms{provider}
solomotorx_bank_ingestion_duration_ms{bank}

# Gauges
solomotorx_open_exceptions_count
solomotorx_active_handoffs_count
solomotorx_bank_adapter_healthy{bank}  # 1 or 0
solomotorx_cost_usd_per_day  # IA
```

**Exposer en endpoint:**

```
GET /metrics
```

Formato Prometheus texto.

**Logs estructurados:**

Todo lo que se logguee debe tener:
- `correlation_id` (generado por request o heredado)
- `chat_id`, `order_id`, `user_id` cuando aplique
- `component` (nlu, matching, kanban, etc.)
- `level` (info, warn, error)

**Criterios:**
- [ ] `/metrics` devuelve formato Prometheus
- [ ] Logs incluyen correlation_id en toda la cadena
- [ ] Dashboard Grafana básico opcional

---

## Tickets frontend

### FE-6.1 · Página `/clientes/[id]/360` (3 días)

**Layout:**

```
┌───────────────────────────────────────────────────────┐
│ [Avatar] Yorman Cuadra                                │
│         +58 414-555-0291 · Cliente desde 2023         │
│         ⭐⭐⭐⭐⭐ 4.9 · [Nueva venta] [Enviar mensaje]  │
├───────────────────────────────────────────────────────┤
│ KPIs (5 cards en fila)                                │
│ Total: $2,487 · Compras: 14 · Avg: $178 · LTV: $6,200 │
├───────────────┬───────────────────┬───────────────────┤
│ PERFIL        │ TIMELINE          │ MÉTRICAS          │
│ Contacto      │ ● 18/04 Orden...  │ 📊 barras meses   │
│ Vehículos     │ ● 15/04 Corrig... │ 📊 uso por canal  │
│ Preferencias  │ ● 03/04 ⭐⭐⭐⭐⭐   │ 🏆 top productos  │
│ Tags          │ ... (50 eventos)  │                   │
└───────────────┴───────────────────┴───────────────────┘
```

**Datos:** `GET /api/customers/:id/360`

**Criterios:**
- [ ] Layout responsive
- [ ] Timeline infinito scroll o paginado
- [ ] Gráficos con SVG manual (no Chart.js)
- [ ] Botón "Nueva venta" abre modal de cotización manual

---

### FE-6.2 · Dashboard del supervisor `/supervisor` (3 días)

**Layout:**

```
┌───────────────────────────────────────────────────────┐
│ Dashboard del supervisor · 24h                         │
├───────────────────────────────────────────────────────┤
│ Alertas (si las hay)                                  │
│ ⚠ Correction rate subió de 15% a 21% en 24h          │
├──────────┬──────────┬──────────┬──────────────────────┤
│ Bot      │ Pipeline │ Calidad  │ Costo IA             │
│ 450 acc  │ 32 ord   │ 79% ok   │ $0.42 hoy            │
│ 120 rev  │ 28 cer   │ 21 corr  │ $12 mes              │
│ 25 err   │ 8 exc    │ trend↑   │ límite $20           │
├──────────┴──────────┴──────────┴──────────────────────┤
│ Gráficos                                              │
│ • Correction rate últimos 7 días                      │
│ • Top tipos de correcciones                           │
│ • Excepciones por razón                               │
│ • Latencia NLU p50/p95                                │
├───────────────────────────────────────────────────────┤
│ Acciones sin revisar (backlog del supervisor)         │
│ [Lista paginada con preview de cada acción]           │
│ Click → panel detalle con opciones de corrección      │
└───────────────────────────────────────────────────────┘
```

**Datos:** `GET /api/sales/supervisor-dashboard`

**Polling:** cada 60 seg.

**Acciones rápidas:**
- Click en una acción sin revisar → modal con detalle + botones Correcto/Incorrecto/Corregir
- Marcar todas de un tipo como correctas (bulk action)

**Criterios:**
- [ ] KPIs actualizados en tiempo casi real
- [ ] Backlog usable: supervisor puede procesar 50+ acciones/día
- [ ] Alertas visibles sin saturar

---

### FE-6.3 · E2E tests con Playwright (2 días)

**Archivos:** `e2e/` en repo frontend

**3 flujos críticos:**

1. **Vendedor toma conversación y responde:**
   - Login como vendedor
   - Abrir chat en `/bandeja`
   - Click "Tomar"
   - Verificar badge azul "TOMADA"
   - Escribir mensaje
   - Verificar envío
   - Click "Devolver al bot"
   - Verificar badge morado "BOT ACTIVO"

2. **Kanban drag-and-drop:**
   - Login como supervisor
   - Abrir `/ventas/tablero`
   - Localizar card en columna "Aprobada"
   - Arrastrar a "Despacho"
   - Verificar respuesta 200 del PATCH
   - Recargar página
   - Verificar card en "Despacho"

3. **Resolución de excepción:**
   - Login como supervisor
   - Abrir `/bandeja` → pestaña "Excepciones"
   - Seleccionar excepción de tipo `amount_over_threshold`
   - Abrir modal
   - Aprobar cotización
   - Verificar modal cierra
   - Verificar excepción marcada como resuelta

**Criterios:**
- [ ] Tests corren en CI sin flakes
- [ ] Fixtures estables (no dependen de timestamps)
- [ ] Screenshots en fallos

---

### FE-6.4 · Documentación de usuario `docs/GUIA_VENDEDOR.md` (1 día)

**Secciones:**

1. **Para vendedores:**
   - Cómo funciona la bandeja
   - Cuándo tomar una conversación
   - Cómo devolver al bot
   - Cómo ver excepciones y resolverlas

2. **Para supervisores:**
   - Qué es el dashboard del supervisor
   - Cómo marcar acciones como correctas/incorrectas
   - Cómo corregir estructurado (botón "Corregir")
   - Cuándo escalar a admin

3. **Para admins:**
   - Configuración de umbrales
   - Conciliación manual de pagos
   - Gestión de adaptadores bancarios
   - Lectura de métricas

**Formato:** Markdown con screenshots.

**Criterios:**
- [ ] Documento completo
- [ ] Screenshots actualizados
- [ ] Revisado por al menos un vendedor real

---

### FE-6.5 · Onboarding tour (opcional, 1 día)

Tour guiado en primera visita de cada rol, tipo `intro.js` o `shepherd.js`.

Opcional si hay tiempo. Mejora adopción inicial.

---

## Criterios de aceptación globales del Sprint 6

- [ ] Backend: 4 tickets completados
- [ ] Frontend: 4-5 tickets completados (5º es opcional)
- [ ] Tests de integración pasan en CI
- [ ] E2E pasan sin flakes
- [ ] Dashboard del supervisor operativo
- [ ] Ficha 360° con datos reales de cliente
- [ ] Documentación publicada
- [ ] Métricas Prometheus expuestas

---

## Orden sugerido

Día 1-2: BE-6.1 (ficha 360°) + FE-6.1 (página cliente) en paralelo
Día 3-4: BE-6.2 + FE-6.2 (dashboard supervisor)
Día 5-6: BE-6.3 (tests integración)
Día 7: BE-6.4 (métricas)
Día 8: FE-6.3 (E2E)
Día 9: FE-6.4 (docs)
Día 10: demo final + retrospectiva del proyecto

---

## Al cerrar Sprint 6

**El módulo está listo para producción.**

Próximas acciones (post-sprint, no parte del plan de 12 semanas):

1. **Evaluar métricas reales** en semana 14 según tabla del plan v2
2. **Volver a correr eval NLU** con dataset real del inbox (reemplazar sintético)
3. **Firmar ADR-003 definitivamente** con datos de producción
4. **Planear Sprint 7+** según lo que aprendas con usuarios reales

**Retrospectiva recomendada:** dedicar 1 día completo a revisar:
- Qué funcionó
- Qué no funcionó
- Qué decisiones rehacer
- Qué deuda técnica priorizar

---

**Fin del plan de 6 sprints.** 12 semanas desde ADR-001 firmado hasta módulo en producción con supervisor activo.
