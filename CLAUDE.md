# CLAUDE.md — Contexto del proyecto `webhook-receiver`

Documento de contexto persistente para asistentes de IA y desarrolladores. Convención: actualizarlo cuando cambien flujos críticos, variables de entorno o despliegue.

## Qué es este repo

Receptor HTTP de webhooks de Mercado Libre (órdenes, mensajes, preguntas, ítems, etc.) y orquestador de automatizaciones: post-venta por API ML, respuestas automáticas a preguntas (IA/plantillas), WhatsApp vía Wasender (tipos E/F), integración FileMaker, inventario/catálogo y jobs programados (GitHub Actions).

- **Runtime principal:** `node server.js` (HTTP).
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

## Variables de entorno (referencia rápida)

Agrupadas por tema; la fuente de verdad detallada está en comentarios de `load-env-local.js` y en los módulos citados.

| Área | Variables relevantes |
|------|----------------------|
| App / admin | `PORT`, `ADMIN_SECRET` (rutas admin sin clave → 503) |
| OAuth ML | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`; tokens por cuenta en `ml_accounts` |
| DB | `DATABASE_URL` (obligatoria) |
| Webhooks | `WEBHOOK_SAVE_DB`, `ML_WEBHOOK_FETCH_RESOURCE`, `ML_WEBHOOK_FETCH_VENTAS_DETALLE` |
| Preguntas IA | `ML_QUESTIONS_IA_AUTO_ENABLED`, ventana/horario en `ML_QUESTIONS_IA_AUTO_*` |
| WhatsApp | `WASENDER_ENABLED`, `WASENDER_API_KEY`, `WASENDER_API_BASE_URL`, `ML_WHATSAPP_TIPO_F_ENABLED`, plantillas E/F en BD o env |
| Post-venta A | `ML_AUTO_SEND_POST_SALE`, `ML_AUTO_SEND_TOPICS`, `ML_POST_SALE_*` |
| Retiro B | `ML_RETIRO_ENABLED`, `ML_RETIRO_SLOT`, `ML_RETIRO_TIMEZONE`, … |
| Calificación C | `ML_RATING_REQUEST_ENABLED`, `ML_RATING_REQUEST_LOOKBACK_DAYS`, … |
| FileMaker | `FILEMAKER_TIPO_G_SECRET`, `FILEMAKER_INVENTARIO_PRODUCTOS_SECRET` |
| API pública catálogo | `FRONTEND_API_KEY`, `FRONTEND_CORS_ORIGINS`, rate limit |

**Producción (p. ej. Render):** replicar las mismas claves que en local para el comportamiento esperado; el servidor no lee `oauth-env.json` en el cloud salvo que se suba (no recomendado).

## Directrices para cambios de código

- Mantener estilo y patrones existentes; tocar solo lo necesario para la tarea.
- No añadir documentación markdown salvo que se pida explícitamente (este archivo es la excepción de contexto).
- No commitear `oauth-env.json`, `firebase-key.json`, ni credenciales.
- Tras cambios en workflows, recordar que los **secrets** deben existir en el repo de GitHub.

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

---

*Última revisión orientativa: mantener alineado con `package.json` y workflows en `.github/workflows/`.*
