/**
 * Si existe oauth-env.json en esta carpeta, carga variables (solo las que no vengan ya en process.env).
 * Asi puedes ejecutar "node test-conexion.js" sin hacer . .\oauth-credentials.ps1 en cada ventana.
 * Copia oauth-env.json.example -> oauth-env.json y rellena (no subas oauth-env.json a git).
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "oauth-env.json");
if (fs.existsSync(file)) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(j)) {
      if (v != null && v !== "" && process.env[k] === undefined) {
        process.env[k] = String(v);
      }
    }
  } catch (e) {
    console.error("[oauth-env.json]", e.message);
  }
}
