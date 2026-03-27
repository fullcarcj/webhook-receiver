/**
 * Tras GET de orden (orders_v2): crea buyer o actualiza; si ya existía y ML trae datos distintos, rellena cambio_datos.
 */
const { getMlBuyer, upsertMlBuyer } = require("./db");
const { normalizeCambioDatos, normalizeNombreApellido } = require("./ml-buyer-pref");

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
 * Texto para ml_buyers.cambio_datos cuando ML devuelve datos distintos a los guardados.
 * @param {{ nickname?: string|null, phone_1?: string|null, phone_2?: string|null }} existing
 * @param {{ nickname?: string|null, phone_1?: string|null, phone_2?: string|null }} incoming
 */
function buildCambioDatosFromDiff(existing, incoming) {
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
  const raw = `Orden ML ${stamp}. ${parts.join("; ")}`;
  return normalizeCambioDatos(raw);
}

/**
 * @param {{ buyer_id: number, nickname?: string|null, phone_1?: string|null, phone_2?: string|null }} buyer
 */
async function upsertBuyerFromOrdersV2Webhook(buyer) {
  if (!buyer || buyer.buyer_id == null) return;
  const existing = await getMlBuyer(buyer.buyer_id);
  if (!existing) {
    await upsertMlBuyer(buyer);
    return;
  }
  if (!buyerCoreFieldsDiffer(existing, buyer)) {
    await upsertMlBuyer(buyer);
    return;
  }
  const note = buildCambioDatosFromDiff(existing, buyer);
  await upsertMlBuyer({
    ...buyer,
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
  });
}

module.exports = {
  upsertBuyerFromOrdersV2Webhook,
  buyerCoreFieldsDiffer,
  buildCambioDatosFromDiff,
  mergeNombreApellidoFromVentasDetalle,
};
