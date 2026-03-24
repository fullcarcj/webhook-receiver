/**
 * Archivo estilo Netscape (curl -b) → cabecera Cookie para dominios Mercado Libre.
 */

function isMercadoLibreDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  const d = domain.toLowerCase().trim();
  return (
    d.includes("mercadolibre") &&
    !d.includes("mercadopago") &&
    !d.includes("mercadoshops")
  );
}

/**
 * @param {string} fileContent — contenido del .txt exportado (Netscape).
 * @returns {string} — valor para cabecera `Cookie: ...`
 */
function buildCookieHeaderFromNetscapeFile(fileContent) {
  const nowSec = Math.floor(Date.now() / 1000);
  const map = new Map();
  const lines = fileContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0];
    const expiry = parts[4];
    const name = parts[5];
    const value = parts.slice(6).join("\t");
    if (!name) continue;
    if (!isMercadoLibreDomain(domain)) continue;
    const expNum = Number(expiry);
    if (Number.isFinite(expNum) && expNum > 0 && expNum < nowSec) continue;
    map.set(name, value);
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

module.exports = { buildCookieHeaderFromNetscapeFile, isMercadoLibreDomain };
