/**
 * Export Netscape (curl -b), JSON (Cookie-Editor / extensiones) o "Header String" → cabecera Cookie para dominios Mercado Libre.
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

function mapToCookieHeader(map) {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * @param {string} lines — contenido Netscape (líneas tabuladas).
 */
function buildCookieHeaderFromNetscapeLines(lines) {
  const nowSec = Math.floor(Date.now() / 1000);
  const map = new Map();
  const parts = String(lines).split(/\r?\n/);
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const domain = cols[0];
    const expiry = cols[4];
    const name = cols[5];
    const value = cols.slice(6).join("\t");
    if (!name) continue;
    if (!isMercadoLibreDomain(domain)) continue;
    const expNum = Number(expiry);
    if (Number.isFinite(expNum) && expNum > 0 && expNum < nowSec) continue;
    map.set(name, value);
  }
  return mapToCookieHeader(map);
}

/**
 * JSON: `[{name,value,domain?,...}]` o `{ "cookies": [ ... ] }` o un solo `{name,value}`.
 * expirationDate / expires / expiry en segundos o milisegundos (Chrome).
 */
function buildCookieHeaderFromJsonExport(trimmed) {
  const data = JSON.parse(trimmed);
  const arr = Array.isArray(data)
    ? data
    : data && Array.isArray(data.cookies)
      ? data.cookies
      : data && typeof data.name === "string"
        ? [data]
        : null;
  if (!arr || arr.length === 0) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const map = new Map();
  for (const c of arr) {
    if (!c || typeof c.name !== "string") continue;
    const domain =
      c.domain != null ? String(c.domain) : c.host != null ? String(c.host) : "";
    if (domain && !isMercadoLibreDomain(domain)) continue;
    const exp = c.expirationDate ?? c.expires ?? c.expiry;
    if (exp != null) {
      let sec = Number(exp);
      if (sec > 1e12) sec = Math.floor(sec / 1000);
      if (Number.isFinite(sec) && sec > 0 && sec < nowSec) continue;
    }
    map.set(c.name, c.value != null ? String(c.value) : "");
  }
  if (map.size === 0) return null;
  return mapToCookieHeader(map);
}

function looksLikeJsonCookieExport(trimmed) {
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length === 0 || typeof parsed[0] === "object";
    if (parsed && Array.isArray(parsed.cookies)) return true;
    if (parsed && typeof parsed.name === "string") return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Cookie-Editor "Header String": `a=b; c=d` (opcional prefijo `Cookie:`). Sin dominio: se usa tal cual (filtra el export en la extensión).
 */
function buildCookieHeaderFromHeaderString(trimmed) {
  if (trimmed.includes("\t")) return null;
  let s = trimmed.replace(/^Cookie:\s*/i, "").replace(/\s*\r?\n\s*/g, " ").trim();
  if (s.startsWith("#")) return null;
  if (!s.includes("=")) return null;
  const parts = s.split(";").map((x) => x.trim()).filter(Boolean);
  const map = new Map();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (name) map.set(name, value);
  }
  return map.size > 0 ? mapToCookieHeader(map) : null;
}

/**
 * @param {string} fileContent — Netscape, JSON o Header String (Cookie-Editor).
 * @returns {string} — valor para cabecera `Cookie: ...`
 */
function buildCookieHeaderFromNetscapeFile(fileContent) {
  const raw = fileContent != null ? String(fileContent) : "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const fromJson = buildCookieHeaderFromJsonExport(trimmed);
      if (fromJson != null && String(fromJson).trim() !== "") return fromJson;
      if (looksLikeJsonCookieExport(trimmed)) return "";
    } catch {
      /* sigue como Netscape por si el contenido es raro */
    }
  }
  const fromHeader = buildCookieHeaderFromHeaderString(trimmed);
  if (fromHeader != null && String(fromHeader).trim() !== "") return fromHeader;
  return buildCookieHeaderFromNetscapeLines(raw);
}

module.exports = {
  buildCookieHeaderFromNetscapeFile,
  isMercadoLibreDomain,
};
