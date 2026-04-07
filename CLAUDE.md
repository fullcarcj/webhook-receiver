# CLAUDE.md — Contexto del proyecto `webhook-receiver`

Documento de contexto persistente para asistentes de IA y desarrolladores. Convención: actualizarlo cuando cambien flujos críticos, variables de entorno o despliegue.

## Qué es este repo

Receptor HTTP de webhooks de Mercado Libre (órdenes, mensajes, preguntas, ítems, etc.) y orquestador de automatizaciones: post-venta por API ML, respuestas automáticas a preguntas (IA/plantillas), WhatsApp vía Wasender (tipos E/F), integración FileMaker, inventario/catálogo, módulo de divisas (currency), módulo de envío/importación (shipping + landed cost), WMS (ubicaciones y stock por bin), con jobs programados (GitHub Actions).

- **Runtime principal:** `node server.js` (HTTP).
- **Estilo del repo:** CommonJS (`require/module.exports`) + rutas en servidor HTTP nativo (sin Express).
- **Base de datos:** solo **PostgreSQL** en producción (`db.js` → `db-postgres.js`). Existe código SQLite histórico (`db-sqlite.js`) pero **no** se usa en runtime si `DATABASE_URL` apunta a Postgres.
- **Carga de entorno:** `load-env-local.js` lee `oauth-env.json` si existe (solo claves no ya definidas en `process.env`). **`oauth-env.json` está en `.gitignore`** — no versionar secretos.

## Archivos de entrada y scripts útiles

| Comando | Uso |
|--------|-----|
| `npm start` / `node server.js` | Servidor |
| `npm run sync-orders` / `sync-listings` / etc. | Sincronización ML |
| `npm run rating-request-daily` | Tipo C (calificación) — también en CI |
| `npm run retiro-broadcast-morning` / `afternoon` | Tipo B — también en CI |
| `npm run whatsapp-tipo-f` | Prueba manual tipo F |
| `npm run fetch-rates` | Job manual de tasas (currency) |
| `node src/scripts/bulkAssignShippingCategories.js --auto` | Onboarding masivo de categorías de envío |

Ver `package.json` para el listado completo.

## Convención de mensajes (negocio)

Definida en `ml-message-types.js` (tags lógicos, no campos de ML):

- **A:** Post-venta automático al recibir orden — `ml-post-sale-send.js`, tabla `post_sale_messages`, log `ml_post_sale_auto_send_log` / `ml_message_kind_send_log`.
- **B:** Recordatorio retiro/despacho — `ml-retiro-broadcast.js`, workflows `.github/workflows/retiro-broadcast-*.yml`.
- **C:** Recordatorio calificación — `ml-rating-request-daily.js`, workflow `rating-request-daily.yml`.
- **D:** Respuestas automáticas a preguntas (`POST /answers`) — `ml-questions-ia-auto.js`.
- **E/F:** WhatsApp Wasender — `ml-whatsapp-tipo-ef.js`; **F** ligado a `ml_question_id`, **E** a orden o seguimiento.
- **G:** FileMaker → buyer + intento tipo E — `ml-filemaker-tipo-g.js`.

## Flujos críticos (resumen)

### Webhook ML → preguntas

Con `ML_WEBHOOK_FETCH_RESOURCE=1` se hace GET del recurso y se actualizan tablas de preguntas. Si la pregunta está `UNANSWERED` y `ML_QUESTIONS_IA_AUTO_ENABLED=1`, se intenta `tryQuestionIaAutoAnswer`. Si no termina OK, la fila queda en `ml_questions_pending` con `ia_auto_route_detail` (p. ej. `route: pending_after_auto_attempt`). Eso documenta el intento de IA, **no** el WhatsApp F.

### WhatsApp tipo F (pregunta)

En `server.js`, solo si **`ML_WHATSAPP_TIPO_F_ENABLED === "1"`** se llama `trySendWhatsappTipoFForQuestion` (vía `setImmediate`). Requiere Wasender habilitado + `WASENDER_API_KEY`, fila de comprador en `ml_buyers` con teléfono normalizable. Log en `ml_whatsapp_wasender_log`. Dedup: éxito previo por pregunta salvo `ML_WHATSAPP_TIPO_F_SKIP_IF_SENT=0`.

### Post-venta tipo A

`trySendDefaultPostSaleMessage` en `ml-post-sale-send.js`. Requiere **`ML_AUTO_SEND_POST_SALE=1`** y topic permitido en `ML_AUTO_SEND_TOPICS` (típico `orders_v2`). No depende de GitHub Actions.

### Jobs B y C (GitHub Actions)

Workflows en `.github/workflows/`. Necesitan:

- `secrets.DATABASE_URL`
- `secrets.OAUTH_CLIENT_ID` y `secrets.OAUTH_CLIENT_SECRET` (refresh de tokens contra cuentas en `ml_accounts`)

Sin OAuth en el job, los POST a la API de ML pueden fallar al renovar token.

**Tipo B (retiro):** `.github/workflows/retiro-broadcast-morning.yml` y `retiro-broadcast-afternoon.yml`. Horarios por defecto (America/Caracas, UTC−4): **mañana 7:30** (`cron` UTC `30 11 * * *`), **tarde 14:20** (`20 18 * * *`). La hora local de referencia se documenta con `ML_RETIRO_MORNING_SEND_AT` / `ML_RETIRO_AFTERNOON_SEND_AT`; si cambiás la hora, recalculá el cron en UTC en el YAML. Opcional `ML_RETIRO_ENFORCE_SEND_AT=1` + `ML_RETIRO_SEND_AT_WINDOW_MINUTES` para que el script no envíe fuera de esa ventana (p. ej. jobs que corren cada pocos minutos).

**Tipo C (calificación):** `rating-request-daily.yml` — por defecto **8:30 Caracas** (`30 12 * * *` UTC). La hora no viene de una variable de entorno; se cambia editando el `cron` del workflow (igual que el retiro respecto al YAML).

### Currency (tasas + catálogo en Bs)

- Servicio: `src/services/currencyService.js`.
- Rutas: `src/routes/currency.js` montadas en `server.js` bajo `/api/currency`.
- SQL: `sql/currency-management.sql` (+ optimización en `sql/currency-optimization.sql`).
- Job/CI: `src/jobs/dailyRatesFetch.js`, workflow `.github/workflows/daily-rates.yml`.
- **`POST /api/currency/fetch`:** en el servidor, auth con `Authorization: Bearer <CRON_SECRET>` **o** cabecera `X-Admin-Secret` (mismo valor que `ADMIN_SECRET`). `CRON_SECRET` debe existir en producción (p. ej. Render) y coincidir con el secret de GitHub si el workflow dispara el endpoint.
- **GitHub → tasas:** el workflow usa `secrets.RENDER_URL` (URL raíz del servicio, sin path), `secrets.CRON_SECRET` y comprueba `secrets.DATABASE_URL`; hace `GET /health` y luego `POST …/api/currency/fetch`. `RENDER_URL` no es variable del proceso Node en cloud; solo secret del repo para el `curl` desde Actions.
- **BCV:** scrape con cliente **HTTPS nativo** (Node), timeout largo por defecto. URL por defecto: página de intervención cambiaria del BCV; override con `BCV_URL`. Opcionales: `BCV_FETCH_TIMEOUT_MS`, `BCV_TLS_INSECURE=1` si falla la verificación TLS del sitio (último recurso).
- Regla operativa: precios en Bs se calculan en runtime (vista/queries), no se persisten por SKU.

### Shipping + Landed Cost (flete dinámico)

- Servicio: `src/services/shippingService.js`.
- Rutas: `src/routes/shipping.js` montadas en `server.js` bajo `/api/shipping`.
- SQL: `sql/shipping-providers.sql` y `sql/landed-cost.sql`.
- Integración landed cost: `src/services/landedCostService.js`.
- Script de carga masiva: `src/scripts/bulkAssignShippingCategories.js`.
- Regla operativa: al calcular flete dinámico CBM se elimina `FREIGHT` manual en `import_expenses` para evitar doble conteo.

### WMS (bins y stock)

- Servicio: `src/services/wmsService.js`.
- Rutas: `src/routes/wms.js` montadas en `server.js` bajo `/api/wms` (lecturas públicas de stock/picking/bin; ajustes y movimientos con `X-Admin-Secret`). Reservas por **orden ML** (tabla `ml_order_reservations`): `POST /api/wms/ml-order/reserve`, `…/commit`, `…/release` (solo admin; no sustituyen al webhook `orders_v2`). **Picking:** `GET /api/wms/picking-list?skus=SKU-1,SKU-2` (opcional `order=`), hasta 200 SKUs por request, respuesta `warehouses` + `missing_stock` (sin error HTTP si falta stock).
- SQL: `sql/wms-bins.sql` (jerarquía warehouse → aisle → shelf → bin, `bin_stock`, `stock_movements_audit`, vistas `v_stock_by_sku` y `v_picking_route`); parche de auditoría avanzada: `sql/wms-audit-v2.sql` (ENUM `movement_reason`, trigger INSERT/UPDATE/DELETE, `delta_*` generados, `last_counted_at`, `app.movement_notes` en sesión).
- `bin_code`: con un solo almacén activo por empresa el código es corto (`A01-E1-N1`); con varios almacenes activos se antepone `warehouses.code` (`SM-A01-E1-N1`).

## Variables de entorno (referencia rápida)

Agrupadas por tema; la fuente de verdad detallada está en comentarios de `load-env-local.js` y en los módulos citados.

| Área | Variables relevantes |
|------|----------------------|
| App / admin | `PORT`, `ADMIN_SECRET` (rutas admin sin clave → 503) |
| OAuth ML | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`; tokens por cuenta en `ml_accounts` |
| DB | `DATABASE_URL` (obligatoria) |
| Webhooks | `WEBHOOK_SAVE_DB`, `ML_WEBHOOK_FETCH_RESOURCE`, `ML_WEBHOOK_FETCH_VENTAS_DETALLE` |
| WMS reservas ML | `ML_WMS_ORDER_RESERVATIONS_ENABLED=1` — tras GET `orders_v2` reserva/libera stock según estado (`src/services/reservationService.js`); requiere migración `sql/ml-reservations.sql`. **API admin (opcional):** `POST /api/wms/ml-order/reserve|commit|release` con `X-Admin-Secret` — mismas funciones que el webhook (pruebas/soporte) |
| Currency | `CRON_SECRET` (`Authorization: Bearer` en `POST /api/currency/fetch`), `ADMIN_SECRET` vía `X-Admin-Secret` en el mismo endpoint; `BCV_URL`, `BCV_FETCH_TIMEOUT_MS`, `BCV_TLS_INSECURE`; en GitHub Actions: secrets `RENDER_URL`, `CRON_SECRET`, `DATABASE_URL` (`daily-rates.yml`); `CURRENCY_COMPANY_IDS` opcional |
| Preguntas IA | `ML_QUESTIONS_IA_AUTO_ENABLED`, ventana/horario en `ML_QUESTIONS_IA_AUTO_*` |
| WhatsApp | `WASENDER_ENABLED`, `WASENDER_API_KEY`, `WASENDER_API_BASE_URL`, `ML_WHATSAPP_TIPO_F_ENABLED`, plantillas E/F en BD o env |
| Post-venta A | `ML_AUTO_SEND_POST_SALE`, `ML_AUTO_SEND_TOPICS`, `ML_POST_SALE_*` |
| Retiro B | `ML_RETIRO_ENABLED`, `ML_RETIRO_SLOT`, `ML_RETIRO_TIMEZONE`, `ML_RETIRO_LOOKBACK_DAYS`, `ML_RETIRO_MORNING_SEND_AT` / `ML_RETIRO_AFTERNOON_SEND_AT` (referencia HH:MM local), `ML_RETIRO_ENFORCE_SEND_AT`, `ML_RETIRO_SEND_AT_WINDOW_MINUTES`; hora real de ejecución = **cron UTC** en los workflows |
| Calificación C | `ML_RATING_REQUEST_ENABLED`, `ML_RATING_REQUEST_LOOKBACK_DAYS`, …; hora diaria = **cron** en `rating-request-daily.yml` |
| FileMaker | `FILEMAKER_TIPO_G_SECRET`, `FILEMAKER_INVENTARIO_PRODUCTOS_SECRET` |
| API pública catálogo | `FRONTEND_API_KEY`, `FRONTEND_CORS_ORIGINS`, rate limit |

**Producción (p. ej. Render):** replicar las mismas claves que en local para el comportamiento esperado; el servidor no lee `oauth-env.json` en el cloud salvo que se suba (no recomendado).

## Directrices para cambios de código

- Mantener estilo y patrones existentes; tocar solo lo necesario para la tarea.
- No añadir documentación markdown salvo que se pida explícitamente (este archivo es la excepción de contexto).
- No commitear `oauth-env.json`, `firebase-key.json`, ni credenciales.
- Tras cambios en workflows, recordar que los **secrets** deben existir en el repo de GitHub.
- Para shipping/landed/currency/WMS en entornos nuevos: ejecutar migraciones en orden (ver `sql/run-migrations.md`).

## Dónde buscar qué

| Tema | Archivos |
|------|----------|
| Rutas HTTP y webhooks | `server.js` |
| OAuth y llamadas ML API | `oauth-token.js` |
| Preguntas pending/answered | `ml-question-sync.js`, `ml-question-refresh.js`, `db-postgres.js` |
| IA automática preguntas | `ml-questions-ia-auto.js` |
| Wasender E/F | `ml-whatsapp-tipo-ef.js`, `wasender-client.js` |
| Post-venta A | `ml-post-sale-send.js` |
| Retiro B / rating C | `ml-retiro-broadcast.js`, `ml-rating-request-daily.js` |
| Currency (tasas) | `src/services/currencyService.js`, `src/routes/currency.js`, `sql/currency-management.sql` |
| Shipping/flete | `src/services/shippingService.js`, `src/routes/shipping.js`, `src/scripts/bulkAssignShippingCategories.js`, `sql/shipping-providers.sql` |
| Landed cost | `src/services/landedCostService.js`, `sql/landed-cost.sql` |
| WMS (ubicaciones / stock) | `src/services/wmsService.js`, `src/routes/wms.js`, `sql/wms-bins.sql` |
| Reservas ML ↔ bin_stock | `src/services/reservationService.js`, `sql/ml-reservations.sql`, enganche en `server.js` (topic `orders_v2` + fetch) |
| Orden de migración SQL | `sql/run-migrations.md` |

---

*Última revisión: 2026-04 — alinear con `package.json`, `ml-retiro-broadcast.js`, `src/services/currencyService.js` y workflows en `.github/workflows/`.*
