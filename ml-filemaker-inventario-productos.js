/**
 * Inventario productos desde FileMaker: POST JSON (misma autenticación que tipo G).
 * Rutas: `POST /filemaker/inventario-productos` o `POST /mensajes-inventario-productos`
 * con `FILEMAKER_INVENTARIO_PRODUCTOS_SECRET` (Bearer, X-Filemaker-Secret o ?secret=).
 * Por defecto hace upsert por `sku`.
 */

const db = require("./db");
const { enrichProductoConImagenesUrls } = require("./producto-imagenes-urls");

function normalizePayloadKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const nk = String(k).trim().toLowerCase().replace(/\s+/g, "_");
    out[nk] = v;
  }
  return out;
}

function strOrEmpty(v) {
  if (v == null) return "";
  return String(v).trim();
}

function strOrNull(v) {
  const s = strOrEmpty(v);
  return s === "" ? null : s;
}

function parseMaybeJsonObject(v) {
  if (v == null) return undefined;
  if (typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return undefined;
    try {
      const j = JSON.parse(t);
      return typeof j === "object" && j !== null && !Array.isArray(j) ? j : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * @param {unknown} body - JSON del POST FileMaker (ya unwrapped en server)
 * @returns {Promise<{ httpStatus: number, json: object }>}
 */
async function processFilemakerInventarioProductosPost(body) {
  const n = normalizePayloadKeys(body);
  const skuRaw = n.sku ?? n.seller_sku ?? n.SKU;
  const sku = skuRaw != null ? String(skuRaw).trim() : "";
  if (!sku) {
    return {
      httpStatus: 400,
      json: {
        ok: false,
        error: "invalid_payload",
        detail: "sku es obligatorio (también se acepta seller_sku)",
      },
    };
  }

  const urlsObj = parseMaybeJsonObject(n.urls);
  const attrObj = parseMaybeJsonObject(n.atributos);

  const row = {
    sku: sku.slice(0, 120),
    cod_producto: strOrNull(n.cod_producto ?? n.cod_producto_fm),
    marca_producto: strOrNull(n.marca_producto),
    proveedor: strOrNull(n.proveedor),
    descripcion: strOrNull(n.descripcion),
    stock: n.stock !== undefined && n.stock !== null && String(n.stock).trim() !== "" ? Number(n.stock) : undefined,
    precio_usd:
      n.precio_usd !== undefined && n.precio_usd !== null && String(n.precio_usd).trim() !== ""
        ? Number(n.precio_usd)
        : undefined,
    oem: strOrNull(n.oem),
    ref_1: strOrNull(n.ref_1 ?? n.ref1),
    ref_2: strOrNull(n.ref_2 ?? n.ref2),
    ref_3: strOrNull(n.ref_3 ?? n.ref3),
    aplicacion_extendida: strOrNull(n.aplicacion_extendida),
    ubicacion: strOrNull(n.ubicacion),
    item_id_ml: strOrNull(n.item_id_ml ?? n.item_id),
    imagenes_cantidad:
      n.imagenes_cantidad !== undefined && n.imagenes_cantidad !== null && String(n.imagenes_cantidad).trim() !== ""
        ? Number(n.imagenes_cantidad)
        : n.imagenes !== undefined
          ? Number(n.imagenes)
          : undefined,
  };

  if (urlsObj !== undefined) row.urls = urlsObj;
  if (attrObj !== undefined) row.atributos = attrObj;

  try {
    const useInsert =
      n.upsert === "0" ||
      n.upsert === false ||
      n.insert_only === "1" ||
      n.insert_only === true ||
      n.solo_insert === "1";
    const producto = useInsert ? await db.insertProducto(row) : await db.upsertProductoBySku(row);
    return {
      httpStatus: 200,
      json: {
        ok: true,
        mode: useInsert ? "insert" : "upsert",
        producto: enrichProductoConImagenesUrls(producto),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      httpStatus: 400,
      json: { ok: false, error: "persist_failed", detail: msg },
    };
  }
}

module.exports = {
  processFilemakerInventarioProductosPost,
};
