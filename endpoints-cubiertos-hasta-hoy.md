# Endpoints y módulos cubiertos (webhook-receiver)

**Actualizado:** 2026-04-11  
**Copia de trabajo Banesco (local, no versionada):** `data/BANESCO/endpoints-cubiertos-hasta-hoy.md` — misma versión que este archivo al generar/exportar.

**Nota:** Rutas admin aceptan `X-Admin-Secret` o `?k=` / `?secret=` (legado) **o** JWT Bearer/Cookie (nuevo — ver `/api/auth`). Rate limiting: 120 req/min por IP (general) + bloqueo por 5 min tras 10 fallos de auth — `src/utils/rateLimiter.js`. API pública catálogo: `FRONTEND_API_KEY` en `/api/v1/*`.

---

## Resumen por prefijo

| Prefijo / área | Handler principal | Cobertura |
|----------------|-------------------|-----------|
| `/api/auth/*` | `server.js` + `src/utils/authMiddleware.js` | Login JWT, logout, me, change-password |
| `/api/users/*` | `server.js` + `src/services/authService.js` | Gestión usuarios + roles + sesiones |
| `/api/v1/*` | `public-frontend-api.js` | Catálogo, health, compat motor |
| `/api/currency/*` | `src/routes/currency.js` | Tasas, override, fetch BCV |
| `/api/pos/*` | `src/routes/posSales.js` | Ventas POS + Compras POS (snapshot tasa + landed) |
| `/api/shipping/*` | `src/routes/shipping.js` | Flete, categorías |
| `/api/wms/*` | `src/routes/wms.js` | Bins, stock, picking, reservas ML |
| `/api/lots/*` | `src/routes/lots.js` | Lotes / shelf-life (recepción, despacho, alertas, expire diario) |
| `/api/count/*` | `cycleCountService.js` | Conteo cíclico de inventario |
| `/api/catalog/*` | `src/services/compatibilityService.js` | Catálogo técnico motor, compatibilidad N:N, válvulas |
| `/api/wallet/*` | `src/routes/wallet.js` | Billetera cliente |
| `/api/sales/*` | `salesApiHandler.js` | Ventas globales, import ML, quotes, alerts |
| `/api/bundles/*`, `/api/price-review/*` | `bundleApiHandler.js` | Kits, alternativas, cola revisión precios |
| `/api/delivery/*` | `deliveryApiHandler.js` | Zonas, órdenes delivery |
| `/api/price/*` | `priceEngineApiHandler.js` | Motor precios dinámico |
| `/api/ml/*` | `mlApiHandler.js` | Publicaciones ML |
| `/api/media/*` | `mediaApiHandler.js` | Media CRM/WhatsApp |
| `/api/customers/*` | `routes/customers.js` | Clientes, historial, loyalty |
| `/api/chat/*` | `chatApiHandler.js` | Chats CRM |
| `/api/stats/*` | `statsApiHandler.js` | Estadísticas (incl. resumen throttle WA) |
| `/api/inventory/*` | `inventoryApiHandler.js` | Inventario inteligente (products/inventory) |
| `/api/crm/*` | `routes/crm.js` | CRM: customers, ml_buyers, wallet, migración |
| `/api/cash/*`, `/api/finance-settings/*` | `cashApiHandler.js` | Caja / ajustes financieros (admin) |
| `/api/bank/*` | `bankStatements.js`, `bankBanesco.js` | Extractos, Banesco JSON |
| `/api/ai-responder/*` | `aiResponderApiHandler.js` | Piloto Tipo M: stats, log, pending, approve/override |
| `/api/fiscal/*`, `/api/fiscal-documents/*` | `fiscalNumberingService.js` | Numeración fiscal, documentos |
| `/api/igtf/*` | `igtfService.js` | IGTF |
| `/api/tax-retentions/*` | `taxRetentionService.js` | Retenciones IVA/ISLR |
| `/api/wms/ml-order/*` | `src/routes/wms.js` | Reservas ML ↔ bin_stock |
| `/sse`, `/api/sse/*`, `/api/events` | `sseApiHandler.js` | Server-Sent Events |
| `/api/vehicle/*` | `vehicleApiHandler.js` | Catálogo vehículos / compat |
| `/api/purchase/*` | `purchaseApiHandler.js` | Órdenes de compra |
| `/api/provider/*` | `providerApiHandler.js` | Proveedores IA / ajustes |
| `/api/auth/*` | `src/services/authService.js` + `src/utils/authMiddleware.js` | Login JWT, logout, change-password, me |
| `/api/users/*` | `src/services/authService.js` | Gestión de usuarios, roles, sesiones |

---

## Autenticación (`/api/auth`) y Usuarios (`/api/users`)

### Auth — sin autenticación previa

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/auth/login` | POST | — | Login. Body: `{ username, password }`. Responde con JWT en body **y** `Set-Cookie: token=<jwt> HttpOnly`. Lockout a 5 intentos fallidos → `ACCOUNT_LOCKED`. |
| `/api/auth/logout` | POST | JWT/Cookie | Revoca el `jti` en `user_sessions`. Borra la cookie (`Max-Age=0`). |
| `/api/auth/me` | GET | JWT/Cookie | Usuario actual con array de permisos del rol. |
| `/api/auth/change-password` | POST | JWT/Cookie | Cambia contraseña. Body: `{ current_password, new_password }`. Revoca todas las sesiones activas. |

### Usuarios — requieren ADMIN o superior

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/users` | GET | JWT/Secret (ADMIN+) | Lista usuarios. Query: `?role=`, `?status=`. Nunca retorna `password_hash`. |
| `/api/users` | POST | JWT/Secret (ADMIN+) | Crea usuario. Body: `{ username, email, full_name, role, password }`. ADMIN no puede crear SUPERUSER. |
| `/api/users/role-permissions` | GET | Cualquier auth | Permisos fijos por rol agrupados: `{ SUPERUSER:[…], ADMIN:[…], OPERATOR:[…] }`. |
| `/api/users/:id` | GET | JWT/Secret (ADMIN+) | Usuario por ID con `permissions[]`. |
| `/api/users/:id` | PATCH | JWT/Secret (ADMIN+) | Actualiza `full_name`, `email`, `role`, `status`. Cambio de `role` revoca sesiones. |
| `/api/users/:id/reset-password` | POST | JWT/Secret (SUPERUSER) | Reset forzado. Body: `{ new_password }`. Revoca sesiones y desbloquea cuenta. |
| `/api/users/:id/unlock` | POST | JWT/Secret (ADMIN+) | Desbloquea cuenta bloqueada por intentos fallidos. |
| `/api/users/:id/sessions` | GET | ADMIN+ o propio | Sesiones JWT activas del usuario. |
| `/api/users/:id/revoke-sessions` | POST | JWT/Secret (ADMIN+) | Revoca todas las sesiones activas. |

**Tablas:** `users`, `user_sessions`, `role_permissions`. **Roles:** `SUPERUSER(3) > ADMIN(2) > OPERATOR(1)`. **Módulos en permisos:** `wms | ventas | crm | catalog | settings | fiscal`. **Auth dual:** Bearer token + Cookie HttpOnly `SameSite=Strict` (Secure en producción). `checkAdminSecretOrJwt()` acepta ambos + `X-Admin-Secret` / `?k=` (legado). **Migración:** `npm run db:users`.

---

## Core y health

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/` | GET | — | Raíz |
| `/health` | GET | — | Health básico (legacy) |
| `/api/health` | GET | — | **Siempre 200** — heartbeat del sistema. Incluye `inDowntime`, `currentTimeVet`, `minutesUntilRestore`, `db.connected`, `db.latencyMs`, `uptime`. Nunca bloqueado por downtime. |
| `/webhook` | POST | Firma ML | Receptor Mercado Libre (`WEBHOOK_PATH`). Nunca bloqueado por downtime. |
| `/monitor` | GET | — | Monitor SSE (HTML embebido) |

---

## POS — Ventas (`/api/pos/sales`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/pos/sales` | POST | Admin | Crear venta. Body: `lines[]`, `payments[]`, `rate_snapshot?`, `customer_id?`, `ml_order_id?`, `igtf_usd?`, `notes?`. Snapshot de tasa automático o override manual. |
| `/api/pos/sales/:id` | GET | Admin | Venta por ID: cabecera + líneas con `product_description`. |

**Columnas clave en `sales`:** `rate_applied`, `rate_type`, `rate_date`, `total_bs` (generada). `sale_lines.landed_cost_usd` opcional por línea. Migración: `npm run db:exchange-rates`.

---

## POS — Compras (`/api/pos/purchases`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/pos/purchases` | GET | Admin | Listado paginado. Query: `?from=YYYY-MM-DD`, `?to=`, `?status=`, `?limit=` (max 200), `?offset=`, `?company_id=`. Retorna `{ purchases, total, limit, offset }`. |
| `/api/pos/purchases/:id` | GET | Admin | Compra por ID: cabecera + líneas con `product_description`. |
| `/api/pos/purchases` | POST | Admin | Crear compra. Body: `lines[]` (obligatorio, `product_sku`, `quantity`, `unit_cost_usd`), `rate_snapshot?`, `purchase_date?`, `import_shipment_id?`, `company_id?`, `notes?`, `user_id?`. |

**Columnas clave en `purchases`:** `rate_applied`, `rate_type`, `rate_date`, `total_bs` (generada). `purchase_lines.landed_cost_usd`: snapshot de `products.landed_cost_usd` al momento de comprar.

---

## Currency / Tasas (`/api/currency`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/currency/rates` | GET | — | Tasas activas por empresa |
| `/api/currency/rates/history` | GET | — | Historial de tasas |
| `/api/currency/today` | GET | — | Tasa del día |
| `/api/currency/override` | POST | Admin + rate limit | Override manual de tasa (`rate_date`, `field`, `value`, `reason`) |
| `/api/currency/fetch` | POST | Admin o `Authorization: Bearer <CRON_SECRET>` + rate limit | Fetch BCV → guarda en `daily_exchange_rates` |
| `/api/currency/products` | GET | — | Precios en Bs (vista `v_product_prices_bs`) |

---

## Ventas globales (`/api/sales`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/sales` | GET | Admin | Listado paginado (`source`, `status`, `customer_id`, `from`, `to`, `limit`, `offset`) |
| `/api/sales/stats` | GET | Admin | Totales USD/Bs, conteos por estado |
| `/api/sales/:id` | GET | Admin | Orden por ID con ítems y datos Bs |
| `/api/sales/create` | POST | Admin | Crear orden manual (mostrador/ecommerce/social) |
| `/api/sales/import/ml` | POST | Admin | Importar órdenes desde `ml_orders` → `sales_orders`. Rellena `total_amount_bs`, `exchange_rate_bs_per_usd`, `rate_type`, `rate_date` buscando la tasa más cercana a la fecha ML en `daily_exchange_rates`. |
| `/api/sales/:id` | PATCH | Admin | Actualizar estado/notas |
| `/api/quotes/create` | POST | Admin | Cotizador de precios Bs (no persiste orden) |

**Migración:** `npm run db:sales-all` + `npm run db:sales-rate-snapshot` (agrega `rate_type`, `rate_date` a `sales_orders`).

---

## WMS — Bins y Stock (`/api/wms`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/wms/warehouses` | GET | Admin | Listado almacenes |
| `/api/wms/warehouses/:id/bins` | GET | Admin | Bins de un almacén (`?aisle_id=`, `?status=`) |
| `/api/wms/stock/:sku` | GET | Admin | Stock por SKU (`?warehouse_id=`) |
| `/api/wms/bins/:binId/stock` | GET | Admin | Stock de un bin |
| `/api/wms/picking` | GET | Admin | Ruta picking serpentín (`?warehouse_id=`, `?skus=SKU1,SKU2`) |
| `/api/wms/movements` | GET | Admin | Historial de movimientos (`?sku=`, `?bin_id=`, `?reference_type=`, `?limit=`, `?offset=`) |
| `/api/wms/stock/adjust` | POST | Admin | Ajuste directo (delta +/-) |
| `/api/wms/stock/reserve` | POST | Admin | Reservar stock (available → reserved) |
| `/api/wms/stock/commit` | POST | Admin | Confirmar despacho (quitar de reserved) |
| `/api/wms/stock/release` | POST | Admin | Liberar reserva (reserved → available) |
| `/api/wms/ml-order/reserve` | POST | Admin | Reservar stock por orden ML |
| `/api/wms/ml-order/commit` | POST | Admin | Confirmar despacho orden ML |
| `/api/wms/ml-order/release` | POST | Admin | Liberar reserva orden ML |
| `/api/wms/picking-list` | GET | Público | Lista de picking por SKUs (`?skus=SKU-1,SKU-2`, max 200) |

---

## Catálogo técnico motor (`/api/catalog`)

### Público (sin auth)

| Endpoint | Query | Descripción |
|----------|-------|-------------|
| `/api/catalog/makes` | — | Marcas de vehículos |
| `/api/catalog/models` | `?make_id=` | Modelos por marca |
| `/api/catalog/engines` | `?make_id=`, `?model_id=`, `?year=` | Motores filtrados |
| `/api/catalog/search` | `?make_id=`, `?model_id=`, `?year=`, `?engine_code=`, `?position=` | Búsqueda técnica (al menos un filtro obligatorio) |
| `/api/catalog/text-search` | `?q=`, `?limit=` | Búsqueda libre GIN (trgm) |
| `/api/catalog/products/:sku/compatibility` | — | Compatibilidades de un SKU |
| `/api/catalog/products/:sku/valve-specs` | — | Especificaciones de válvula |
| `/api/catalog/products/:sku/equivalences` | `?tolerance_mm=0.5` | Equivalencias ±mm |

### Admin

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/catalog/makes` | POST | Crear/upsert marca |
| `/api/catalog/models` | POST | Crear/upsert modelo |
| `/api/catalog/engines` | POST | Crear/upsert motor |
| `/api/catalog/engines/:engineId/models` | POST | Vincular motor ↔ modelo + rango años |
| `/api/catalog/compatibility` | POST | Agregar compatibilidad SKU ↔ motor |
| `/api/catalog/compatibility` | DELETE | Borrado lógico (is_active=FALSE) |
| `/api/catalog/products/:sku/valve-specs` | POST | Crear/upsert specs de válvula |
| `/api/catalog/import` | POST | Importación masiva desde JSON (máx 1000 filas) |

---

## Shipping / Flete (`/api/shipping`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/shipping/calculate` | POST | — | Calcular flete dinámico CBM |
| `/api/shipping/categories` | GET | — | Categorías de envío |
| `/api/shipping/providers` | GET | Admin | Proveedores de flete |
| `/api/shipping/providers` | POST | Admin | Crear proveedor |
| `/api/shipping/providers/:id` | PATCH | Admin | Actualizar proveedor |
| `/api/shipping/categories/:id/assign` | POST | Admin | Asignar categoría a SKU |

---

## Lotes (`/api/lots`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/lots` | GET | Admin | Listado lotes |
| `/api/lots/:id` | GET | Admin | Lote por ID |
| `/api/lots` | POST | Admin | Crear lote |
| `/api/lots/:id` | PATCH | Admin | Actualizar lote |
| `/api/lots/:id/receive` | POST | Admin | Recepción en bin |
| `/api/lots/:id/dispatch` | POST | Admin | Despacho desde bin |
| `/api/lots/alerts` | GET | Admin | Alertas shelf-life |
| `/api/lots/expire` | POST | Admin | Marcar lotes expirados |

---

## Billetera (`/api/wallet`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/wallet/balance` | GET | Admin | Saldo por `customer_id` o `ml_buyer_id` |
| `/api/wallet/transactions` | GET | Admin | Historial (`?customer_id=` o `?ml_buyer_id=`) |
| `/api/wallet/credit` | POST | Admin | Acreditar saldo |
| `/api/wallet/debit` | POST | Admin | Debitar saldo |
| `/api/wallet/credit-rma` | POST | Admin | Crédito por devolución RMA |
| `/api/wallet/ensure-customer` | POST | Admin | Crear/vincular customer desde ML buyer |

---

## CRM (`/api/crm`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/crm/customers` | GET | Admin | Búsqueda/listado de clientes |
| `/api/crm/customers` | POST | Admin | Crear cliente |
| `/api/crm/customers/:id` | GET | Admin | Cliente por ID |
| `/api/crm/customers/:id` | PATCH | Admin | Actualizar cliente |
| `/api/crm/customers/:id/ml-buyers` | GET | Admin | ML buyers vinculados |
| `/api/crm/customers/:id/link-ml-buyer` | POST | Admin | Vincular ML buyer al cliente |
| `/api/crm/customers/:id/wallet` | GET | Admin | Saldo billetera del cliente |
| `/api/crm/customers/:id/wallet` | POST | Admin | Agregar transacción de billetera |
| `/api/crm/customers/:id/wallet/history` | GET | Admin | Historial de billetera |
| `/api/crm/customers/:id/wallet/summary` | GET | Admin | Resumen billetera (balance + stats) |
| `/api/crm/buyers/:mlBuyerId/customer` | GET | Admin | Customer vinculado a un ML buyer |
| `/api/crm/migrate` | POST | Admin | Migrar `ml_buyers` → `customers` |
| `/api/crm/chats` | GET | Admin | Chats CRM |

---

## AI Responder — Tipo M (`/api/ai-responder`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/ai-responder` | GET | `?k=` | Dashboard HTML: stats, cola, log con `chat_phone` |
| `/api/ai-responder/stats` | GET | `?k=` | JSON métricas worker/GROQ/FORCE/hoy |
| `/api/ai-responder/log` | GET | `?k=&limit=` | JSON `ai_response_log` + `chat_phone` |
| `/api/ai-responder/pending` | GET | `?k=&limit=` | JSON mensajes `needs_human_review` |
| `/api/ai-responder/:id/approve` | POST | `?k=` | Enviar sugerencia IA manualmente |
| `/api/ai-responder/:id/override` | POST | `?k=` | Override con texto personalizado |

Código: `src/handlers/aiResponderApiHandler.js`, `src/services/aiResponder.js`, `src/workers/aiResponderWorker.js`. Migración: `npm run db:ai-responder`.

---

## Banca / Banesco

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/banesco` | GET | `?k=` | Página HTML estado Banesco (`?format=json`) |
| `/banesco-connection` | GET | `?k=` | Alias JSON estado conexión |
| `/statements` | GET | `?k=` | Tabla HTML extractos (`?format=json`) |
| `/api/bank/banesco/connection` | GET | Admin | Estado de conexión JSON |
| `/api/bank/banesco/status` | GET | Admin | Estado detallado |
| `/api/bank/statements` | GET | Admin | Listado extractos (`bank_account_id`, `from`, `to`, `reconciliation_status`, `limit`, `offset`) |

---

## Admin HTML (páginas embebidas en server.js)

`/hooks`, `/wasender-webhooks`, `/preguntas-ml`, `/ordenes-ml`, `/envios-*`, `/payment-attempts`, `/sales`, `/admin/ml-accounts`, `/admin/oauth-exchange`, `/admin/ml-web-cookies`, `/admin/topic-fetches`, `/admin/ml-questions-pending` — candidatas a sustituir por SPA.

---

## Autenticación JWT (`/api/auth`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/auth/login` | POST | — | Login. Body: `{ username, password }`. Responde `{ token, expiresIn, user }` + `Set-Cookie: token=…; HttpOnly; SameSite=Strict`. |
| `/api/auth/logout` | POST | JWT/Cookie | Revoca `jti` en BD + limpia Cookie (`Max-Age=0`). |
| `/api/auth/me` | GET | JWT/Cookie | Usuario actual con permisos del rol. |
| `/api/auth/change-password` | POST | JWT/Cookie | Body: `{ current_password, new_password }`. Revoca todas las sesiones activas. |

---

## Gestión de usuarios (`/api/users`)

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/users` | GET | JWT/Secret (ADMIN+) | Listado. Query: `?role=`, `?status=`. |
| `/api/users/role-permissions` | GET | JWT/Secret (cualquier rol) | Permisos fijos por rol agrupados. |
| `/api/users` | POST | JWT/Secret (ADMIN+) | Crear usuario. Body: `username, email, full_name, role, password`. ADMIN no puede crear SUPERUSER. |
| `/api/users/:id` | GET | JWT/Secret (ADMIN+) | Usuario por ID con permisos del rol. |
| `/api/users/:id` | PATCH | JWT/Secret (ADMIN+) | Actualizar `full_name`, `email`, `role`, `status`. Cambio de rol revoca sesiones. |
| `/api/users/:id/reset-password` | POST | JWT/Secret (SUPERUSER) | Fuerza nueva contraseña y revoca sesiones. |
| `/api/users/:id/unlock` | POST | JWT/Secret (ADMIN+) | Desbloquea cuenta con `status=LOCKED`. |
| `/api/users/:id/sessions` | GET | JWT/Secret (ADMIN+ o propio) | Sesiones activas del usuario. |
| `/api/users/:id/revoke-sessions` | POST | JWT/Secret (ADMIN+) | Revoca todas las sesiones activas. |

**Roles:** `SUPERUSER` (18 permisos) / `ADMIN` (16) / `OPERATOR` (8). Módulos: `wms`, `ventas`, `crm`, `catalog`, `settings`, `fiscal`.  
**Auth dual:** JWT `Authorization: Bearer <token>` **o** Cookie `HttpOnly` (browser) **o** `X-Admin-Secret` (legado).  
**Lockout:** 5 intentos fallidos → `status=LOCKED`. Desbloquear con `/unlock`.  
**Migración:** `npm run db:users`. Contraseña inicial superuser: `Ferrari2026!`.

---

## Downtime — ventana de mantenimiento

**23:30 → 05:00 VET** (UTC-4, Venezuela no tiene DST). Durante downtime:
- Endpoints de escritura (POST/PATCH/PUT/DELETE): `503` con `{ error: "SERVICE_UNAVAILABLE", minutesUntilRestore, retryAfterSeconds }` + header `Retry-After`.
- GET de solo lectura: pasan normalmente.
- `/api/health`: **siempre 200** — heartbeat para auto-refresh del cliente.
- Webhooks ML: **nunca bloqueados**.

Lógica: `src/utils/sessionGuard.js` (`isInDowntime`, `rejectDuringDowntime`, `getDowntimeInfo`, `getVetNow`, `minutesUntilRestore`).

---

## Seguridad — Rate limiting en endpoints admin

`src/utils/rateLimiter.js`:
- `adminRequestLimiter`: 120 peticiones/min por IP — todas las peticiones admin.
- `adminAuthFailLimiter`: 10 fallos de auth / 5 min por IP — bloqueo anti bruta-fuerza.
- `getClientIp(req)`: respeta `X-Forwarded-For` (Render, proxies).
- Respuestas `429` incluyen `retryAfterSeconds` y header `Retry-After`.

Aplicado en: `src/middleware/adminAuth.js` (`ensureAdmin`) + `server.js` (`rejectAdminSecret`).

---

## Scripts npm relacionados (operación, no HTTP)

| Script | Uso breve |
|--------|-----------|
| `npm run wa-throttle-reset` | Reset contador diario `wa_throttle` por número o `--all` |
| `npm run purge:ai-responder-error-log` | Borrar filas `ai_response_log` con `action_taken=error` (requiere `CONFIRM_PURGE_AI_ERROR_LOGS=1`) |
| `npm run test-wasender-text` | Prueba envío texto Wasender (`RUN_WA_TEST_CONFIRM=1`) |
| `npm run db:users` | Tablas `users`, `user_sessions`, `role_permissions`; SUPERUSER inicial |
| `npm run db:wms` | WMS base: warehouses, aisles, shelves, bins, bin_stock, audit |
| `npm run db:wms-audit` | ENUM `movement_reason` + trigger auditoría v2 |
| `npm run db:wms-products-canonical` | Funciones atómicas stock + vistas canónicas sobre `products` |
| `npm run db:wms-all` | Los tres pasos WMS en orden (recomendado en entornos nuevos) |
| `npm run db:exchange-rates` | Migración POS sales/purchases con snapshot de tasa |
| `npm run db:sales-rate-snapshot` | Agrega `rate_type` + `rate_date` a `sales_orders`; backfill desde `daily_exchange_rates` |
| `npm run db:sales-all` | Todas las migraciones de ventas globales |
| `npm run db:catalog` | Migración catálogo motor (tablas + vistas + 18 marcas) |
| `npm run db:search-indexes` | Índices GIN para búsqueda libre en catálogo |
| `npm run db:wms` | Migración WMS (warehouses, bins, bin_stock, funciones stock) |
| `npm run db:cycle-count` | Migración conteo cíclico |
| `npm run db:lots-management` | Migración lotes |
| `npm run db:ai-responder` | Migración AI Responder Tipo M |
| `npm run db:crm-customers` | Migración CRM (columnas extras, vistas, función migración) |

---

## Migraciones recientes relevantes

| Archivo SQL | Script npm | Qué hace |
|-------------|-----------|---------|
| `sql/exchange-rates.sql` | `db:exchange-rates` | POS sales/purchases con triplete de tasa + `total_bs` generada |
| `sql/20260409_sales_global.sql` | `db:sales-global` | Columnas `total_amount_bs`, `exchange_rate_bs_per_usd` en `sales_orders` |
| `sql/20260411_sales_orders_rate_snapshot.sql` | `db:sales-rate-snapshot` | Agrega `rate_type TEXT`, `rate_date DATE`; backfill histórico |
| `sql/20260411_ai_responder.sql` | `db:ai-responder` | Tablas Tipo M (`crm_messages` col `ai_*`, `ai_response_log`) |
| `sql/wms-bins.sql` | `db:wms` | WMS completo (warehouses → bins, funciones atómicas, auditoría) |
| `sql/motor-compatibility.sql` | `db:catalog` | Catálogo técnico motor N:N |
| `sql/search-indexes.sql` | `db:search-indexes` | Índices GIN `pg_trgm` |
| `sql/crm-customers.sql` | `db:crm-customers` | CRM: campos extras, `v_customers_full`, función migración |

---

*Inventario orientativo; la fuente de verdad del comportamiento es el código (`server.js` + handlers bajo `src/`).*
