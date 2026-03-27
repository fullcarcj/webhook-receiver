/**
 * Producción (p. ej. Render): `data/{ml_user_id}.txt` no viene en git y el disco puede ser efímero.
 * Define en el host una variable por cuenta, con el **contenido completo** del archivo Netscape (mismo formato que curl -b).
 *
 *   ML_COOKIE_NETSCAPE_9309737=<pegar export de cookies>
 *
 * Al arrancar el servidor se escribe `data/9309737.txt` (o la carpeta ML_COOKIES_DIR).
 * Si la variable existe, **sobrescribe** el archivo en disco (útil tras redeploy).
 */
const fs = require("fs");
const path = require("path");
const { getMlCookiesDir, getMlAccountCookiesFilePath } = require("./ml-cookies-path");

const RE_KEY = /^ML_COOKIE_NETSCAPE_(\d+)$/;

/**
 * @returns {{ written: string[], skipped: string[] }}
 */
function writeCookiesFromEnv() {
  const written = [];
  const skipped = [];
  const dir = getMlCookiesDir();
  fs.mkdirSync(dir, { recursive: true });

  for (const key of Object.keys(process.env)) {
    const m = key.match(RE_KEY);
    if (!m) continue;
    const id = m[1];
    const raw = process.env[key];
    if (raw == null || String(raw).trim() === "") {
      skipped.push(key);
      continue;
    }
    const filePath = getMlAccountCookiesFilePath(id);
    if (!filePath) {
      skipped.push(key);
      continue;
    }
    const content = String(raw).replace(/\r\n/g, "\n");
    try {
      fs.writeFileSync(filePath, content, "utf8");
      written.push(path.basename(filePath));
    } catch (e) {
      console.error("[cookies-env] no se pudo escribir %s: %s", filePath, e.message);
      skipped.push(key);
    }
  }
  return { written, skipped };
}

module.exports = { writeCookiesFromEnv, RE_KEY };
