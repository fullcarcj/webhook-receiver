/**
 * Carpeta de archivos .txt con cookies de sesión web Mercado Libre (una cuenta = un archivo).
 * Variable: ML_COOKIES_DIR (absoluta o relativa al directorio del proyecto).
 * Archivos: {ml_user_id}.txt — mismo id que en ml_accounts.
 */
const fs = require("fs");
const path = require("path");

function getMlCookiesDir() {
  const raw = process.env.ML_COOKIES_DIR || "data";
  return path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
}

/**
 * Ruta del .txt de cookies para una cuenta ML.
 * @param {number|string} mlUserId
 * @returns {string|null}
 */
function getMlAccountCookiesFilePath(mlUserId) {
  const id = Number(mlUserId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return path.join(getMlCookiesDir(), `${id}.txt`);
}

function ensureMlCookiesDir() {
  const d = getMlCookiesDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  getMlCookiesDir,
  getMlAccountCookiesFilePath,
  ensureMlCookiesDir,
};
