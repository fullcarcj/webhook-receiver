/**
 * URLs de imágenes por SKU: prefijo en env + patrón `{sku}_{1..N}.ext` (N ≤ 9).
 * No usar DATABASE_URL (eso es PostgreSQL); usar PRODUCT_IMAGE_BASE_URL.
 */

function normalizeImageBaseUrl(u) {
  if (u == null || u === "") return "";
  const s = String(u).trim();
  return s.replace(/\/+$/, "");
}

/** SKU en nombre de archivo: sin barras; espacios colapsados. */
function skuParaNombreArchivo(sku) {
  return String(sku || "")
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} sku
 * @param {number} cantidad 0–9 (cuántas imágenes existen: 1..cantidad)
 * @returns {string[]} hasta 9 URLs
 */
function buildProductoImagenesUrls(sku, cantidad) {
  const base = normalizeImageBaseUrl(process.env.PRODUCT_IMAGE_BASE_URL);
  const extRaw = process.env.PRODUCT_IMAGE_EXT;
  const ext = extRaw != null && String(extRaw).trim() !== "" ? String(extRaw).trim() : ".webp";
  const extNorm = ext.startsWith(".") ? ext : `.${ext}`;
  const n = Math.min(9, Math.max(0, Math.floor(Number(cantidad) || 0)));
  const part = skuParaNombreArchivo(sku);
  if (!base || !part || n === 0) return [];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const file = `${encodeURIComponent(part)}_${i}${extNorm}`;
    out.push(`${base}/${file}`);
  }
  return out;
}

function enrichProductoConImagenesUrls(row) {
  if (!row || typeof row !== "object") return row;
  const cant = row.imagenes_cantidad != null ? Number(row.imagenes_cantidad) : 0;
  return {
    ...row,
    imagenes_urls: buildProductoImagenesUrls(row.sku, cant),
  };
}

module.exports = {
  buildProductoImagenesUrls,
  enrichProductoConImagenesUrls,
  normalizeImageBaseUrl,
  skuParaNombreArchivo,
};
