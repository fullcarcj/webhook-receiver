/**
 * Construye las URLs de imagen expuestas en la API a partir de **datos ya guardados en BD** (`sku`, `imagenes_cantidad`).
 * Máximo **9** URLs por SKU (índices 1…N). El cliente iOS / inventario debe usar lo que devuelve la API (`imagenes_urls`), no inventar URLs fuera de este esquema.
 * Prefijo: `PRODUCT_IMAGE_BASE_URL` (no confundir con `DATABASE_URL`). Patrón: `{base}/{sku}_{n}{ext}` alineable con subida masiva Firebase (`upload-firebase-webp`).
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
