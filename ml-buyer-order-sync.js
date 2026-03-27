/**
 * Tras GET de orden (orders_v2): crea buyer o actualiza; si ya existía y ML trae datos distintos, rellena cambio_datos.
 *
 * ml_buyers.cambio_datos: **última** anotación de cambio (se sobrescribe en cada actualización con diff),
 * respecto a nickname, nombre_apellido, phone_1 o phone_2 en esa operación. Origen: Orden ML (webhook/API)
 * o Detalle ventas ML (HTML GET detalle).
 */
const { getMlBuyer, upsertMlBuyer } = require("./db");
const { normalizeCambioDatos, normalizeNombreApellido } = require("./ml-buyer-pref");

/** Prefijo en cambio_datos cuando el diff viene del payload de orden / webhook. */
const CAMBIO_SOURCE_ORDEN_ML = "Orden ML";
/** Prefijo cuando el diff viene del parser HTML del detalle de venta. */
const CAMBIO_SOURCE_DETALLE_VENTAS = "Detalle ventas ML";

function normField(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function buyerCoreFieldsDiffer(existing, incoming) {
  if (normField(existing.nickname) !== normField(incoming.nickname)) return true;
  if (normField(existing.phone_1) !== normField(incoming.phone_1)) return true;
  if (normField(existing.phone_2) !== normField(incoming.phone_2)) return true;
  if (
    incoming.nombre_apellido !== undefined &&
    normField(existing.nombre_apellido) !== normField(incoming.nombre_apellido)
  ) {
    return true;
  }
  return false;
}

/**
 * Texto para ml_buyers.cambio_datos: **un** registro por operación (último cambio en esa operación),
 * listando cada campo de core que difiere (nickname, nombre_apellido, phone_1, phone_2).
 * @param {{ nickname?: string|null, nombre_apellido?: string|null, phone_1?: string|null, phone_2?: string|null }} existing
 * @param {{ nickname?: string|null, nombre_apellido?: string|null, phone_1?: string|null, phone_2?: string|null }} incoming
 * @param {{ source?: string }} [opts]
 */
function buildCambioDatosFromDiff(existing, incoming, opts = {}) {
  const source =
    opts.source != null && String(opts.source).trim() !== ""
      ? String(opts.source).trim()
      : CAMBIO_SOURCE_ORDEN_ML;
  const parts = [];
  const pushIf = (label, oldV, newV) => {
    const o = normField(oldV);
    const n = normField(newV);
    if (o !== n) {
      parts.push(`${label}: "${o ?? "—"}" → "${n ?? "—"}"`);
    }
  };
  pushIf("nickname", existing.nickname, incoming.nickname);
  if (incoming.nombre_apellido !== undefined) {
    pushIf("nombre_apellido", existing.nombre_apellido, incoming.nombre_apellido);
  }
  pushIf("phone_1", existing.phone_1, incoming.phone_1);
  pushIf("phone_2", existing.phone_2, incoming.phone_2);
  if (parts.length === 0) return null;
  const stamp = new Date().toISOString();
  const raw = `${source} ${stamp}. ${parts.join("; ")}`;
  return normalizeCambioDatos(raw);
}

/**
 * @param {{ buyer_id: number, nickname?: string|null, phone_1?: string|null, phone_2?: string|null }} buyer
 */
async function upsertBuyerFromOrdersV2Webhook(buyer) {
  if (!buyer || buyer.buyer_id == null) return;
  const { _cambioSource, ...row } = buyer;
  const cambioSource =
    _cambioSource != null && String(_cambioSource).trim() !== ""
      ? String(_cambioSource).trim()
      : CAMBIO_SOURCE_ORDEN_ML;

  const existing = await getMlBuyer(buyer.buyer_id);
  if (!existing) {
    await upsertMlBuyer(row);
    return;
  }
  if (!buyerCoreFieldsDiffer(existing, row)) {
    await upsertMlBuyer(row);
    return;
  }
  const note = buildCambioDatosFromDiff(existing, row, { source: cambioSource });
  await upsertMlBuyer({
    ...row,
    ...(note ? { cambio_datos: note } : {}),
  });
}

/**
 * Tras GET detalle ventas (HTML como RESULTADO_LLAMADA_G): aplica el nombre extraído a ml_buyers.
 * Requiere fila existente (p. ej. ya guardada por GET orden / webhook).
 * @param {number} buyerId
 * @param {string|null|undefined} nombreRaw texto crudo del parser (se normaliza con normalizeNombreApellido)
 */
async function mergeNombreApellidoFromVentasDetalle(buyerId, nombreRaw) {
  const norm = normalizeNombreApellido(nombreRaw);
  if (!norm || buyerId == null || !Number.isFinite(Number(buyerId)) || Number(buyerId) <= 0) return;
  const existing = await getMlBuyer(Number(buyerId));
  if (!existing) return;
  await upsertBuyerFromOrdersV2Webhook({
    buyer_id: Number(buyerId),
    nickname: existing.nickname,
    phone_1: existing.phone_1,
    phone_2: existing.phone_2,
    nombre_apellido: norm,
    _cambioSource: CAMBIO_SOURCE_DETALLE_VENTAS,
  });
}

module.exports = {
  upsertBuyerFromOrdersV2Webhook,
  buyerCoreFieldsDiffer,
  buildCambioDatosFromDiff,
  mergeNombreApellidoFromVentasDetalle,
  CAMBIO_SOURCE_ORDEN_ML,
  CAMBIO_SOURCE_DETALLE_VENTAS,
};
