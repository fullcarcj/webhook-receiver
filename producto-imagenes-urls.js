/**
 * Construye las URLs de imagen expuestas en la API a partir de **datos ya guardados en BD** (`sku`, `imagenes_cantidad`).
 * Máximo **9** URLs por SKU (índices 1…N).
 *
 * Modos:
 * - **Firebase** (recomendado si subiste con `upload-firebase-webp`): definí `PRODUCT_IMAGE_FIREBASE_BUCKET` (ej. `xxx.firebasestorage.app`)
 *   y opcional `PRODUCT_IMAGE_OBJECT_PREFIX` (default `productos`). Misma forma que Storage: `…/o/{encode(path)}?alt=media`.
 * - **CDN plano**: solo `PRODUCT_IMAGE_BASE_URL` + `{sku}_{n}{ext}` en la raíz del base (compatibilidad previa).
 *
 * Sincronizar conteos desde `urls_imagenes.json`: `npm run sync-imagenes-cantidad-json` (actualiza `imagenes_cantidad` en BD).
 */

function normalizeImageBaseUrl(u) {
  if (u == null || u === "") return "";
  const s = String(u).trim();
  return s.replace(/\/+$/, "");
}

/** URL pública Firebase Storage (igual que `scripts/upload-firebase-webp.js`). */
function firebasePublicUrl(bucketName, objectPath) {
  const b = String(bucketName || "").trim();
  if (!b) return "";
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(b)}/o/${encodeURIComponent(
    objectPath
  )}?alt=media`;
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
  const extRaw = process.env.PRODUCT_IMAGE_EXT;
  const ext = extRaw != null && String(extRaw).trim() !== "" ? String(extRaw).trim() : ".webp";
  const extNorm = ext.startsWith(".") ? ext : `.${ext}`;
  const n = Math.min(9, Math.max(0, Math.floor(Number(cantidad) || 0)));
  const part = skuParaNombreArchivo(sku);
  if (!part || n === 0) return [];

  const fbBucket =
    process.env.PRODUCT_IMAGE_FIREBASE_BUCKET != null &&
    String(process.env.PRODUCT_IMAGE_FIREBASE_BUCKET).trim() !== ""
      ? String(process.env.PRODUCT_IMAGE_FIREBASE_BUCKET).trim()
      : "";
  const objectPrefix = (process.env.PRODUCT_IMAGE_OBJECT_PREFIX || "productos")
    .replace(/^\/+|\/+$/g, "")
    .trim();

  const out = [];
  if (fbBucket) {
    for (let i = 1; i <= n; i++) {
      const objectPath = objectPrefix
        ? `${objectPrefix}/${part}_${i}${extNorm}`
        : `${part}_${i}${extNorm}`;
      out.push(firebasePublicUrl(fbBucket, objectPath));
    }
    return out;
  }

  const base = normalizeImageBaseUrl(process.env.PRODUCT_IMAGE_BASE_URL);
  if (!base) return [];
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
  firebasePublicUrl,
};
