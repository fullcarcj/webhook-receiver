# Endpoints y módulos cubiertos (webhook-receiver)

**Actualizado:** 2026-04-10  
**Nota:** Muchas rutas admin usan `X-Admin-Secret` o `?k=` / `?secret=` (ver `adminAuth`). API pública catálogo: `FRONTEND_API_KEY` en `/api/v1/*`.

---

## Resumen por prefijo

| Prefijo / área | Handler principal | Cobertura |
|----------------|-------------------|-----------|
| `/api/v1/*` | `public-frontend-api.js` | Catálogo, health, compat motor |
| `/api/currency/*` | `src/routes/currency.js` | Tasas, override, fetch BCV |
| `/api/shipping/*` | `src/routes/shipping.js` | Flete, categorías |
| `/api/wms/*` | `src/routes/wms.js` | Bins, stock, picking, reservas ML |
| `/api/wallet/*` | `src/routes/wallet.js` | Billetera cliente |
| `/api/sales/*` | `salesApiHandler.js` | Ventas globales, import ML, quotes, alerts |
| `/api/bundles/*`, `/api/price-review/*` | `bundleApiHandler.js` | Kits, alternativas, cola revisión precios |
| `/api/delivery/*` | `deliveryApiHandler.js` | Zonas, órdenes delivery |
| `/api/price/*` | `priceEngineApiHandler.js` | Motor precios dinámico |
| `/api/ml/*` | `mlApiHandler.js` | Publicaciones ML (según rutas montadas) |
| `/api/media/*` | `mediaApiHandler.js` | Media CRM/WhatsApp |
| `/api/customers/*` | `routes/customers.js` | Clientes, historial, loyalty |
| `/api/chat/*` | `chatApiHandler.js` | Chats CRM |
| `/api/stats/*` | `statsApiHandler.js` | Estadísticas |
| `/api/inventory/*` | `inventoryApiHandler.js` | Inventario inteligente (products/inventory) |
| `/api/crm/*` | `routes/crm.js` | CRM |
| `/api/bank/*` | `bankStatements.js`, `bankBanesco.js` | Extractos, Banesco JSON |
| `/sse`, `/api/sse/*` | `sseApiHandler.js` | Server-Sent Events |
| `/api/vehicle/*` | `vehicleApiHandler.js` | Catálogo vehículos / compat |
| `/api/purchase/*` | `purchaseApiHandler.js` | Órdenes de compra |

---

## Banesco / banca (lectura y estado)

- `GET /banesco`, `GET /banesco?format=json` — HTML o JSON estado (query `k=`)
- `GET /banesco-connection` — alias JSON conexión
- `GET /api/bank/banesco/connection`, `GET /api/bank/banesco/status`
- `GET /api/bank/statements` — listado extractos
- `GET /statements` — tabla HTML (query `k=`)

---

## Core y utilidades

- `GET /`, `GET /health`, `GET /api/health`
- `POST /webhook` — Mercado Libre (config `WEBHOOK_PATH`)
- Wasender: rutas en `WASENDER_WEBHOOK_*`
- Admin: `/admin/ml-accounts`, `/admin/oauth-exchange`, `/admin/ml-web-cookies`, `/admin/topic-fetches`, etc. (ver `server.js`)

---

## Páginas HTML embebidas (legacy admin en `server.js`)

Incluyen listados de ventas, preguntas ML, hooks, etc. — candidatas a sustituir por SPA cuando arranque el frontend.

---

## Migraciones recientes relevantes

- Ventas globales, CRM, WMS, currency, shipping, **kits/bundles** (`npm run db:kits-bundles`), conciliación, anti-spam Wasender (`wa_sent_messages_log`), etc.

---

*Este archivo es inventario orientativo; la fuente de verdad del comportamiento sigue siendo el código (`server.js` + handlers bajo `src/`).*
