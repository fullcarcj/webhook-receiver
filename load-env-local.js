/**
 * Si existe oauth-env.json en esta carpeta, carga variables (solo las que no vengan ya en process.env).
 * Asi puedes ejecutar "node test-conexion.js" sin hacer . .\oauth-credentials.ps1 en cada ventana.
 * Copia oauth-env.json.example -> oauth-env.json y rellena (no subas oauth-env.json a git).
 * ML_COOKIES_DIR: carpeta para cookies web por cuenta ({ml_user_id}.txt); ver ml-cookies-path.js.
 * DATABASE_URL: obligatoria para la app; PostgreSQL (Render, Neon, local, etc.).
 * PRODUCT_IMAGE_BASE_URL: prefijo CDN (sin Firebase): URLs planas {base}/{sku}_{n}.ext.
 * PRODUCT_IMAGE_FIREBASE_BUCKET: nombre del bucket (ej. xxx.firebasestorage.app) para URLs estilo Storage; con PRODUCT_IMAGE_OBJECT_PREFIX (default productos) alinea con upload-firebase-webp.
 * PRODUCT_IMAGE_EXT: extensión (default .webp).
 * FILEMAKER_INVENTARIO_PRODUCTOS_SECRET: POST desde FileMaker a /filemaker/inventario-productos o /mensajes-inventario-productos (mismo patrón que FILEMAKER_TIPO_G_SECRET).
 * firebase-key.json: service account para scripts (p. ej. npm run upload-firebase-webp); no subir a git.
 * Inventario — fabricantes: GET /api/inventory/manufacturers (admin) lista la tabla `manufacturers` en PostgreSQL.
 * Si el listado debe resolverse contra otro backend, define INVENTORY_MANUFACTURERS_PROXY_URL como URL absoluta
 * del endpoint remoto (incluye path, p. ej. https://otro-servicio.com/api/v1/fabricantes). El servidor hace GET
 * a esa URL y devuelve el mismo status y cuerpo JSON. Cabecera al upstream: X-Admin-Secret desde
 * INVENTORY_MANUFACTURERS_PROXY_SECRET si existe; si no, la misma cabecera del cliente o ADMIN_SECRET.
 * FRONTEND_API_KEY: solo lectura GET /api/v1/catalog (cabecera X-API-KEY); no sustituye ADMIN_SECRET.
 * ADMIN_SECRET_QUERY_AUTH: si 0 o false, ensureAdmin (src/middleware/adminAuth.js) solo acepta cabecera X-Admin-Secret; si no se define u otro valor, también ?k= / ?secret= (mismo ADMIN_SECRET) para GET en navegador y monitores.
 * Ventas globales GET /api/sales: sin tablas → error schema_missing; ejecutar npm run db:sales-all (incluye `completed` y `customers.phone_2`) contra DATABASE_URL — scripts usan driver pg (scripts/run-sql-file-pg.js), no requieren psql en PATH.
 * Mismo X-API-Key sirve para GET /api/customers/:id/history|loyalty|profile (CORS en /api/customers*).
 * FRONTEND_CORS_ORIGINS (coma) + CRM_FRONTEND_ORIGIN o FRONTEND_ORIGIN: CORS CRM; http://localhost:5173 por defecto en catálogo.
 * Fidelización (sql/20260408_loyalty.sql): LOYALTY_POINTS_PER_USD, LOYALTY_LEVEL_SILVER|GOLD|VIP.
 * FRONTEND_RATE_LIMIT_MAX: peticiones por ventana e IP en /api/v1/catalog (default 120); 0 = sin límite.
 * FRONTEND_RATE_LIMIT_WINDOW_MS: ventana en ms (default 60000). GET /api/v1/health no cuenta para el límite del catálogo.
 * Wasender — ventana “silenciosa” (regla de negocio / horario incómodo, p. ej. 00:00–05:00 Caracas): WA_QUIET_HOURS_TZ (default America/Caracas), WA_QUIET_HOURS_START / WA_QUIET_HOURS_END en HH:MM (default 00:00 y 05:00; el fin es exclusive). Por defecto no bloquea envíos; con WA_QUIET_HOURS_BLOCK_SEND=1 wasender-client omite la API en esa ventana (ver src/services/waQuietHours.js). skipThrottle en wasender-client también omite ese bloqueo.
 * Wasender — throttle diario: `WA_DAILY_MESSAGE_LIMIT` o `WA_DAILY_CAP` = max mensajes por número por día (América/Caracas). **Default 5** si no hay env. Prioridad: WA_DAILY_MESSAGE_LIMIT. Para pruebas subir a 50–999; en producción suele 5–10. Reset manual: `npm run wa-throttle-reset -- +58…` o `--all`. Tabla `wa_throttle` (phone_e164, sent_date, daily_count; migración `db:wa-anti-spam`).
 * Wasender — HTTP 429 (Account Protection, “1 mensaje cada 5s”): `wasender-client` reintenta el POST automáticamente. `WASENDER_429_MAX_RETRIES` (default 5), `WASENDER_429_MIN_WAIT_MS` (default 5200 — mínimo entre reintentos). Alternativa en panel Wasender: desactivar Account Protection.
 * Wasender — anti-spam (tabla wa_sent_messages_log, migración npm run db:wa-anti-spam): WA_PREVENT_DUPLICATES (default true: mismo texto SHA-256 al mismo teléfono en 24h → bloqueo), WA_MAX_REMINDERS_PER_DAY (default 1, solo messageType REMINDER, día calendario America/Caracas). Tipos en opts.messageType: CHAT (default, sin filtro), REMINDER, MARKETING, CRITICAL (omite duplicado y tope de recordatorios; registra envío). Respuesta bloqueo: { ok:false, status:'blocked', reason:'DUPLICATE_24H'|'REMINDER_DAILY_CAP' }.
 * Conciliación — RECONCILIATION_WA_REMINDERS_ENABLED=1 (orden sin match ≥6 h). RECONCILIATION_BANK_PROOF_EDUCATION_ENABLED=1: si el extracto da match L3 por banco, WA pidiendo comprobante (dedup 7 días, columna sales_orders.wa_bank_proof_education_at vía ALTER IF NOT EXISTS en runtime).
 * AI Responder — **Tipo M** (piloto WhatsApp CRM): plantilla `AI_RESPONDER_GENERIC_TEMPLATE` + `context_line` (GROQ). `AI_RESPONDER_FORCE_SEND` = switch revisión humana: **on** (1/true/yes/on) = sin cola humana antes de enviar; **off** (0/false/no/off o vacío) = revisión humana si aplica. No evita log si Wasender falla. AI_RESPONDER_ENABLED=1 activa cola + worker. **`AI_RESPONDER_SUSPENDED=1`** (true/on/yes): apaga cola + worker **aunque** ENABLED=1 (pausa evaluación/simulación sin quitar el flag). Migración npm run db:ai-responder; verify: npm run verify:ai-responder. Monitoreo GET /ai-responder?k=. GROQ + WASENDER_API_KEY. Opcional **`GROQ_CHAT_MODEL`**: override del modelo chat (`callChatBasic`) si no hay `model_name` en `provider_settings` — p. ej. modelo más pequeño cuando el TPD del 70B en Groq se agota.
 * Wasender webhooks: WASENDER_WEBHOOK_SECRET o WASENDER_X_WEBHOOK_SIGNATURE (= cabecera X-Webhook-Signature); ver wasender-webhook-signature.js.
 * WA_CRM_HUB_FROM_WASENDER: si 0, no se reenvía el payload al hub CRM (crm_chats / crm_messages) tras guardar wasender_webhook_events; default distinto de 0 = sí reenviar.
 * CRM bienvenida WhatsApp: por defecto activa (salvo CRM_WA_WELCOME_ENABLED=0|false|no|off). Requiere migración npm run db:crm-wa-welcome, WASENDER_API_KEY y Wasender habilitado; diagnóstico: npm run diagnose:crm-welcome. El webhook de Wasender debe apuntar a la URL HTTPS del servidor desplegado (p. ej. Render); no hace falta túnel ni escuchar en local. Si WA_CRM_HUB_FROM_WASENDER=0 no corre el hub. Plantillas: CRM_WA_WELCOME_GREETING ({{nombre}}), CRM_WA_WELCOME_ASK_NAME. Opcional CRM_WA_WELCOME_ASK_DEDUP_HOURS (default 72): no repetir el pedido de nombre si ya hubo envío exitoso reciente en ml_whatsapp_wasender_log (evita duplicar CASO 3 ask_name + CASO 1 welcome).
 * CRM_WA_CONTACT_NAME_DENYLIST (opcional, coma): más nombres de marca que no deben guardarse como full_name del cliente (pushName Wasender); por defecto ya se excluye Solomotor, etc. (waNameCandidate.js).
 * Bienvenida CRM: tras pedir nombre, cuando el cliente envía nombre+apellido (guardado en customers vía resolveCustomer), se envía un segundo mensaje de saludo con nombre (crmWaWelcome trySendCrmWaWelcomeAfterName); requiere columna crm_chats.wa_welcome_pending_name (npm run db:crm-wa-welcome).
 * customers.name_suggested: último pushName del webhook Wasender (messages.js); solo referencia futura, no usado en resolveCustomer ni CRM WA. Migración: npm run db:customers-name-suggested (en Render/Postgres; sin columna verás WARN en logs y no se persiste pushName).
 * Wasender entrantes: `messages.received`, `messages-personal.received` o `message.received` (a veces solo en `body.type`) se normalizan al mismo flujo CRM (payloadParser + hookRouter + processors/messages.js). `data.messages` como array; ver tests/wasender-payload-parser.test.js.
 * Deduplicación clientes: mismo número (phone/phone_2, dígitos) + mismo nombre+apellido (sanitizeWaPersonName) → no se INSERT; se enlaza identidad al existente (resolveCustomer, findOrCreateCustomer / customerDedupPhoneName.js).
 * Postgres remoto suele exigir TLS: la app activa ssl en el cliente salvo localhost o PGSSLMODE=disable.
 * Banesco: estado de cuenta vía CSV desde el portal; BANESCO_STATEMENT_CSV_DIR carpeta para esos archivos. Ver src/config/banesco.js y GET /api/bank/banesco/status (X-Admin-Secret).
 * Monitor automático: BANESCO_MONITOR_ENABLED, BANESCO_MONITOR_INTERVAL_SEC (segundos entre descargas, default 60, mín. 15). Ventana horaria portal: BANESCO_MONITOR_WINDOW_ENABLED=1, BANESCO_MONITOR_WINDOW_START/END (ej. 05:00 y 23:00), BANESCO_MONITOR_WINDOW_TZ (default America/Caracas) — fuera de ventana no se hace login/descarga; a las 5:00 el siguiente ciclo vuelve a operar.
 * Monitor solo en producción (RENDER=true o NODE_ENV=production); en local no arranca salvo BANESCO_MONITOR_ALLOW_LOCAL=1 (src/jobs/banescoMonitor.js).
 * Ver ventana del navegador (login + Exportar): BANESCO_HEADLESS=0; por defecto headless.
 * Tras descargar el CSV, re-mostrar el formulario con la misma selección (iframe suele vaciarse al Aceptar): por defecto activo; BANESCO_EXPORT_RESTORE_UI_AFTER_DOWNLOAD=0 lo desactiva. Pausa BANESCO_EXPORT_RESTORE_UI_PAUSE_MS (default 1500).
 * CSV Banesco: delimitador BANESCO_EXPORT_FIELD_DELIMITER; export: BANESCO_MOVIMIENTOS_CUENTA_URL → ddlCuenta → pausa BANESCO_POST_CUENTA_SELECT_MS → espera botón Exportar BANESCO_EXPORTAR_BTN_WAIT_MS (default 25000) → botón Exportar → pausa BANESCO_POST_EXPORTAR_BTN_MS → Exportar.aspx; BANESCO_CUENTA_SELECT_VALUE (ej. 1); BANESCO_SKIP_MOVIMIENTOS_CUENTA=1 salta ese paso. CSV: BANESCO_CSV_DELIMITER.
 * Playwright login: BANESCO_BOTON_ACEPTAR_PASO1_SELECTOR y BANESCO_BOTON_ACEPTAR_PASO2_SELECTOR (CSS) si el clic en Aceptar falla; BANESCO_STEP_SCREENSHOTS / BANESCO_SCREENSHOT_DIR.
 * Exportar movimientos: BANESCO_DOWNLOAD_EVENT_TIMEOUT_MS (ms, default 10000) si waitForEvent download hace timeout.
 * Capturas post-login (Exportar.aspx): BANESCO_EXPORT_STEP_SCREENSHOTS=1 y opcional BANESCO_EXPORT_SCREENSHOT_DIR (default ./banesco-export-debug).
 * Guardar en disco cada descarga exitosa (mismo bytes que el portal): BANESCO_SAVE_DOWNLOAD_DIR=ruta/carpeta → escribe banesco-last-download.txt (sobrescribe).
 * Playwright/Chromium carpeta de descargas: BANESCO_PLAYWRIGHT_DOWNLOADS_DIR o BANESCO_DOWNLOADS_DIR; si no, BANESCO_SAVE_DOWNLOAD_DIR o data/banesco-downloads. Tras abrir la página se envía CDP Browser.setDownloadBehavior (desactivar con BANESCO_SKIP_CDP_DOWNLOAD=1).
 * Playwright: en producción (p. ej. Render) definir PLAYWRIGHT_BROWSERS_PATH=0 para instalar Chromium dentro de node_modules y que el binario viaje en el deploy; si no, suele quedar en ~/.cache y falta en runtime. Sin canal, Playwright usa Chromium del paquete. Chrome/Edge del sistema: BANESCO_PLAYWRIGHT_CHANNEL=chrome o =msedge; si no está instalado en el host, banescoService hace fallback al Chromium embebido.
 * Headless / diálogos: BANESCO_CHROMIUM_DISABLE_SITE_ISOLATION=1 añade --disable-features=IsolateOrigins,site-per-process (solo si hace falta; opt-in).
 * Botón descarga en Exportar: por defecto #ctl00_cp_btnOk; override con BANESCO_EXPORT_BTN_SELECTOR (CSS).
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "oauth-env.json");
if (fs.existsSync(file)) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(j)) {
      if (v == null || v === "") continue;
      const current = process.env[k];
      // Si la variable existe pero está vacía (p. ej. variable de sistema en Windows), usar el JSON.
      const missing = current === undefined || current === "";
      if (missing) {
        process.env[k] = String(v);
      }
    }
  } catch (e) {
    console.error("[oauth-env.json]", e.message);
  }
}
