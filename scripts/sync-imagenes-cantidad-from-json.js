#!/usr/bin/env node
/**
 * Lee `urls_imagenes.json` (mapa ruta_relativa → URL) y actualiza `imagenes_cantidad` en `productos`
 * según el máximo índice `_N` por SKU en el nombre de archivo (p. ej. `carpeta/SKU_3.webp` → N=3).
 *
 * No escribe URLs en PostgreSQL: las URLs siguen saliendo de la API vía PRODUCT_IMAGE_FIREBASE_BUCKET + sku.
 *
 * Env:
 *   SYNC_IMAGENES_JSON  ruta al JSON (default: Desktop/lote20_procesadas/urls_imagenes.json)
 */

const fs = require("fs/promises");
const path = require("path");
const { getProductoBySku, updateProducto } = require("../db");

const DEFAULT_JSON = String.raw`C:\Users\Javier\Desktop\lote20_procesadas\urls_imagenes.json`;

const JSON_PATH = process.env.SYNC_IMAGENES_JSON || DEFAULT_JSON;

/** De una clave tipo `sub/SKU_2.webp` obtiene { sku, n }. */
function parseKey(key) {
  const base = path.posix.basename(String(key), ".webp");
  const m = base.match(/^(.+)_(\d+)$/);
  if (!m) return null;
  const sku = m[1].trim();
  const n = Number(m[2]);
  if (!sku || !Number.isFinite(n) || n < 1 || n > 9) return null;
  return { sku, n };
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(JSON_PATH, "utf8");
  } catch (e) {
    console.error(`No se pudo leer ${JSON_PATH}:`, e.message || e);
    process.exit(1);
    return;
  }

  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    console.error("JSON inválido:", e.message || e);
    process.exit(1);
    return;
  }

  /** sku → max índice visto */
  const maxBySku = new Map();
  for (const key of Object.keys(map)) {
    const p = parseKey(key);
    if (!p) continue;
    const prev = maxBySku.get(p.sku) || 0;
    if (p.n > prev) maxBySku.set(p.sku, p.n);
  }

  console.log(`Claves en JSON: ${Object.keys(map).length} | SKUs con patrón *_N.webp: ${maxBySku.size}`);

  let updated = 0;
  let missing = 0;
  let unchanged = 0;
  let errors = 0;

  for (const [sku, maxN] of maxBySku) {
    const cant = Math.min(9, maxN);
    try {
      const row = await getProductoBySku(sku);
      if (!row) {
        missing++;
        continue;
      }
      const cur = row.imagenes_cantidad != null ? Number(row.imagenes_cantidad) : 0;
      if (cur === cant) {
        unchanged++;
        continue;
      }
      await updateProducto(row.id, { imagenes_cantidad: cant });
      updated++;
    } catch (e) {
      errors++;
      console.error(`[error] sku=${sku}:`, e.message || e);
    }
  }

  console.log("---");
  console.log(`Actualizados: ${updated} | Sin cambio: ${unchanged} | SKU no en BD: ${missing} | Errores: ${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
