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
 * FRONTEND_API_KEY: solo lectura GET /api/v1/catalog (cabecera X-API-KEY); no sustituye ADMIN_SECRET.
 * ADMIN_SECRET_QUERY_AUTH: si 0 o false, ensureAdmin (src/middleware/adminAuth.js) solo acepta cabecera X-Admin-Secret; si no se define u otro valor, también ?k= / ?secret= (mismo ADMIN_SECRET) para GET en navegador y monitores.
 * Mismo X-API-Key sirve para GET /api/customers/:id/history|loyalty|profile (CORS en /api/customers*).
 * FRONTEND_CORS_ORIGINS (coma) + CRM_FRONTEND_ORIGIN o FRONTEND_ORIGIN: CORS CRM; http://localhost:5173 por defecto en catálogo.
 * Fidelización (sql/20260408_loyalty.sql): LOYALTY_POINTS_PER_USD, LOYALTY_LEVEL_SILVER|GOLD|VIP.
 * FRONTEND_RATE_LIMIT_MAX: peticiones por ventana e IP en /api/v1/catalog (default 120); 0 = sin límite.
 * FRONTEND_RATE_LIMIT_WINDOW_MS: ventana en ms (default 60000). GET /api/v1/health no cuenta para el límite del catálogo.
 * Wasender webhooks: WASENDER_WEBHOOK_SECRET o WASENDER_X_WEBHOOK_SIGNATURE (= cabecera X-Webhook-Signature); ver wasender-webhook-signature.js.
 * WA_CRM_HUB_FROM_WASENDER: si 0, no se reenvía el payload al hub CRM (crm_chats / crm_messages) tras guardar wasender_webhook_events; default distinto de 0 = sí reenviar.
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
