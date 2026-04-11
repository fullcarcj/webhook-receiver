# Endpoints y módulos cubiertos (webhook-receiver)

**Actualizado:** 2026-04-11  
**Copia de trabajo Banesco (local, no versionada):** `data/BANESCO/endpoints-cubiertos-hasta-hoy.md` — misma versión que este archivo al generar/exportar.

**Nota:** Muchas rutas admin usan `X-Admin-Secret` o `?k=` / `?secret=` (ver `src/middleware/adminAuth.js`). API pública catálogo: `FRONTEND_API_KEY` en `/api/v1/*`.

---

## Resumen por prefijo

| Prefijo / área | Handler principal | Cobertura |
|----------------|-------------------|-----------|
| `/api/v1/*` | `public-frontend-api.js` | Catálogo, health, compat motor |
| `/api/currency/*` | `src/routes/currency.js` | Tasas, override, fetch BCV |
| `/api/shipping/*` | `src/routes/shipping.js` | Flete, categorías |
| `/api/wms/*` | `src/routes/wms.js` | Bins, stock, picking, reservas ML |
| `/api/lots/*` | `src/routes/lots.js` | Lotes / shelf-life (recepción, despacho, alertas, expire diario) |
| `/api/wallet/*` | `src/routes/wallet.js` | Billetera cliente |
| `/api/sales/*` | `salesApiHandler.js` | Ventas globales, import ML, quotes, alerts |
| `/api/bundles/*`, `/api/price-review/*` | `bundleApiHandler.js` | Kits, alternativas, cola revisión precios |
| `/api/delivery/*` | `deliveryApiHandler.js` | Zonas, órdenes delivery |
| `/api/price/*` | `priceEngineApiHandler.js` | Motor precios dinámico |
| `/api/ml/*` | `mlApiHandler.js` | Publicaciones ML (según rutas montadas) |
| `/api/media/*` | `mediaApiHandler.js` | Media CRM/WhatsApp |
| `/api/customers/*` | `routes/customers.js` | Clientes, historial, loyalty |
| `/api/chat/*` | `chatApiHandler.js` | Chats CRM |
| `/api/stats/*` | `statsApiHandler.js` | Estadísticas (incl. resumen throttle WA) |
| `/api/inventory/*` | `inventoryApiHandler.js` | Inventario inteligente (products/inventory) |
| `/api/crm/*` | `routes/crm.js` | CRM |
| `/api/cash/*`, `/api/finance-settings/*` | `cashApiHandler.js` | Caja / ajustes financieros (admin) |
| `/api/bank/*` | `bankStatements.js`, `bankBanesco.js` | Extractos, Banesco JSON |
| `/api/ai-responder/*` | `aiResponderApiHandler.js` | Piloto Tipo M: stats, log, pending, approve/override (JSON + auth) |
| `/sse`, `/api/sse/*`, `/api/events` | `sseApiHandler.js` | Server-Sent Events |
| `/api/vehicle/*` | `vehicleApiHandler.js` | Catálogo vehículos / compat |
| `/api/purchase/*` | `purchaseApiHandler.js` | Órdenes de compra |
| `/api/provider/*` | `providerApiHandler.js` | Proveedores IA / ajustes |

---

## AI Responder — Tipo M (piloto CRM WhatsApp)

- **`GET /ai-responder?k=ADMIN_SECRET`** — dashboard HTML (stats, cola, log últimos 80 con columna teléfono `chat_phone`, revisión humana).
- **`GET /api/ai-responder/stats?k=`** — JSON métricas (worker, GROQ, FORCE, hoy).
- **`GET /api/ai-responder/log?k=&limit=`** — JSON `ai_response_log` + `chat_phone` (join `crm_chats`).
- **`GET /api/ai-responder/pending?k=&limit=`** — JSON mensajes `needs_human_review`.
- **`POST /api/ai-responder/:id/approve?k=`** — enviar sugerencia IA manualmente.
- **`POST /api/ai-responder/:id/override?k=`** — override con cuerpo JSON.

Código: `src/handlers/aiResponderApiHandler.js`, `src/services/aiResponder.js`, `src/workers/aiResponderWorker.js`. Migración: `npm run db:ai-responder`.

---

## Banesco / banca (lectura y estado)

- `GET /banesco`, `GET /banesco?format=json` — HTML o JSON estado (query `k=`)
- `GET /banesco-connection` — alias JSON conexión
- `GET /api/bank/banesco/connection`, `GET /api/bank/banesco/status`
- `GET /api/bank/statements` — listado extractos
- `GET /statements?k=…` — tabla HTML; `?format=json` mismo listado

---

## Core y utilidades

- `GET /`, `GET /health`, `GET /api/health`
- `POST /webhook` — Mercado Libre (config `WEBHOOK_PATH`)
- Wasender: `POST` en rutas configuradas (`/webhook` compartido o dedicadas, p. ej. `/api/wasender/webhook` — ver `server.js` y `WASENDER_WEBHOOK_*`)
- `GET /monitor` — monitor SSE (HTML embebido)
- Admin: `/admin/ml-accounts`, `/admin/oauth-exchange`, `/admin/ml-web-cookies`, `/admin/topic-fetches`, `/admin/ml-questions-pending`, etc. (ver `server.js`)

---

## Páginas HTML embebidas (legacy admin en `server.js`)

Incluyen `/hooks`, `/wasender-webhooks`, `/preguntas-ml`, `/ordenes-ml`, `/envios-*`, `/payment-attempts`, `/sales`, etc. — candidatas a sustituir por SPA cuando arranque el frontend.

---

## Scripts npm relacionados (operación, no HTTP)

| Script | Uso breve |
|--------|-----------|
| `npm run wa-throttle-reset` | Reset contador diario `wa_throttle` por número o `--all` |
| `npm run purge:ai-responder-error-log` | Borrar filas `ai_response_log` con `action_taken=error` (requiere `CONFIRM_PURGE_AI_ERROR_LOGS=1`) |
| `npm run test-wasender-text` | Prueba envío texto Wasender (`RUN_WA_TEST_CONFIRM=1`) |

---

## Migraciones recientes relevantes

- Ventas globales, CRM, WMS, currency, shipping, **kits/bundles** (`npm run db:kits-bundles`), conciliación, anti-spam Wasender (`wa_sent_messages_log`, `wa_throttle`), **AI Responder** (`npm run db:ai-responder`), etc.

---

*Inventario orientativo; la fuente de verdad del comportamiento es el código (`server.js` + handlers bajo `src/`).*
