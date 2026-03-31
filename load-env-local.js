/**
 * Si existe oauth-env.json en esta carpeta, carga variables (solo las que no vengan ya en process.env).
 * Asi puedes ejecutar "node test-conexion.js" sin hacer . .\oauth-credentials.ps1 en cada ventana.
 * Copia oauth-env.json.example -> oauth-env.json y rellena (no subas oauth-env.json a git).
 * ML_COOKIES_DIR: carpeta para cookies web por cuenta ({ml_user_id}.txt); ver ml-cookies-path.js.
 * DATABASE_URL: obligatoria para la app; PostgreSQL (Render, Neon, local, etc.).
 * PRODUCT_IMAGE_BASE_URL: prefijo HTTPS para imágenes de inventario (productos): URLs = {base}/{sku}_{1..n}.ext (n≤9); PRODUCT_IMAGE_EXT opcional (default .webp). No confundir con DATABASE_URL.
 * FILEMAKER_INVENTARIO_PRODUCTOS_SECRET: POST desde FileMaker a /filemaker/inventario-productos o /mensajes-inventario-productos (mismo patrón que FILEMAKER_TIPO_G_SECRET).
 * firebase-key.json: service account para scripts (p. ej. npm run upload-firebase-webp); no subir a git.
 * Wasender webhooks: WASENDER_WEBHOOK_SECRET o WASENDER_X_WEBHOOK_SIGNATURE (= cabecera X-Webhook-Signature); ver wasender-webhook-signature.js.
 * Postgres remoto suele exigir TLS: la app activa ssl en el cliente salvo localhost o PGSSLMODE=disable.
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
