/**
 * Tras GET de orden (orders_v2): crea buyer o actualiza; si ya existía y ML trae datos distintos, rellena cambio_datos.
 */
const { getMlBuyer, upsertMlBuyer } = require("./db");
const { normalizeCambioDatos } = require("./ml-buyer-pref");

function normField(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function buyerCoreFieldsDiffer(existing, incoming) {
  return (
    normField(existing.nickname) !== normField(incoming.nickname) ||
    normField(existing.phone_1) !== normField(incoming.phone_1) ||
    normField(existing.phone_2) !== normField(incoming.phone_2)
  );
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

module.exports = {
  upsertBuyerFromOrdersV2Webhook,
  buyerCoreFieldsDiffer,
  buildCambioDatosFromDiff,
};
