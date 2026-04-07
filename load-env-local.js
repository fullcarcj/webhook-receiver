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
 * FRONTEND_CORS_ORIGINS: orígenes CORS extra (coma); http://localhost:5173 viene por defecto.
 * FRONTEND_RATE_LIMIT_MAX: peticiones por ventana e IP en /api/v1/catalog (default 120); 0 = sin límite.
 * FRONTEND_RATE_LIMIT_WINDOW_MS: ventana en ms (default 60000). GET /api/v1/health no cuenta para el límite del catálogo.
 * Wasender webhooks: WASENDER_WEBHOOK_SECRET o WASENDER_X_WEBHOOK_SIGNATURE (= cabecera X-Webhook-Signature); ver wasender-webhook-signature.js.
 * Postgres remoto suele exigir TLS: la app activa ssl en el cliente salvo localhost o PGSSLMODE=disable.
 * Banesco: estado de cuenta vía CSV desde el portal; BANESCO_STATEMENT_CSV_DIR carpeta para esos archivos. Ver src/config/banesco.js y GET /api/bank/banesco/status (X-Admin-Secret).
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
