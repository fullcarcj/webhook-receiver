/**
 * Mensaje tipo G: disparado por POST desde FileMaker (JSON).
 * Rutas: `POST /filemaker/tipo-g` o `POST /mensajes-tipo-g` (mismo cuerpo y `FILEMAKER_TIPO_G_SECRET`).
 * Actualiza `ml_buyers` (teléfono, preferencia de retiro) y dispara tipo E (WhatsApp) con la misma
 * lógica que el resto del sistema (incl. tope semanal por E.164 en `trySendWhatsappTipoEForOrder`).
 */

const db = require("./db");
const { trySendWhatsappTipoEForOrder } = require("./ml-whatsapp-tipo-ef");
const { normalizeBuyerPrefEntrega } = require("./ml-buyer-pref");

function normalizePayloadKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const nk = String(k).trim().toLowerCase().replace(/\s+/g, "_");
    out[nk] = v;
  }
  return out;
}

function parsePositiveId(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/**
 * @param {unknown} body - JSON del POST FileMaker
 * @returns {Promise<{ httpStatus: number, json: object }>}
 */
async function processFilemakerTipoGPost(body) {
  const n = normalizePayloadKeys(body);
  const orderId = parsePositiveId(n.orden_id ?? n.order_id);
  const buyerId = parsePositiveId(n.buyer_id ?? n.byer_id);
  const phoneRaw =
    n.phone != null
      ? String(n.phone).trim()
      : n.phone_1 != null
        ? String(n.phone_1).trim()
        : "";
  const tipoRetiroRaw =
    n.tipo_de_retiro ??
    n.tipo_retiro ??
    n.pref_entrega ??
    n.tipo_retiro_fm ??
    n["tipo_de_retiro"] ??
    null;
  const tipoRetiroStr =
    tipoRetiroRaw != null && String(tipoRetiroRaw).trim() !== ""
      ? String(tipoRetiroRaw).trim()
      : null;

  let requestJson = "";
  try {
    requestJson = JSON.stringify(body ?? {}).slice(0, 32000);
  } catch {
    requestJson = "";
  }

  async function saveLog(partial) {
    await db.insertFilemakerTipoGLog({
      order_id: partial.order_id ?? orderId,
      buyer_id: partial.buyer_id ?? buyerId,
      ml_user_id: partial.ml_user_id ?? null,
      phone_in: partial.phone_in ?? phoneRaw,
      tipo_retiro: partial.tipo_retiro ?? tipoRetiroStr,
      outcome: partial.outcome,
      skip_reason: partial.skip_reason ?? null,
      tipo_e_detail: partial.tipo_e_detail ?? null,
      request_json: requestJson,
    });
  }

  if (!orderId || !buyerId) {
    await saveLog({
      outcome: "error",
      skip_reason: "Faltan orden_id u order_id, y buyer_id (o byer_id) numéricos válidos",
    });
    return {
      httpStatus: 400,
      json: {
        ok: false,
        error: "invalid_payload",
        detail: "Se requieren orden_id (u order_id) y buyer_id (o byer_id) numéricos positivos",
      },
    };
  }

  if (!phoneRaw) {
    await saveLog({
      order_id: orderId,
      buyer_id: buyerId,
      outcome: "error",
      skip_reason: "phone vacío",
    });
    return {
      httpStatus: 400,
      json: { ok: false, error: "invalid_payload", detail: "phone es obligatorio y no puede estar vacío" },
    };
  }

  const order = await db.getMlOrderByOrderId(orderId);
  if (!order || order.buyer_id == null) {
    await saveLog({
      order_id: orderId,
      buyer_id: buyerId,
      ml_user_id: order && order.ml_user_id != null ? Number(order.ml_user_id) : null,
      outcome: "error",
      skip_reason: "Orden no encontrada en ml_orders o sin buyer_id",
    });
    return {
      httpStatus: 404,
      json: { ok: false, error: "order_not_found", detail: "No hay orden en BD con ese order_id (sync órdenes previo)" },
    };
  }

  const orderBuyerId = Number(order.buyer_id);
  if (orderBuyerId !== buyerId) {
    await saveLog({
      order_id: orderId,
      buyer_id: buyerId,
      ml_user_id: Number(order.ml_user_id),
      outcome: "error",
      skip_reason: `buyer_id del JSON (${buyerId}) no coincide con ml_orders.buyer_id (${orderBuyerId})`,
    });
    return {
      httpStatus: 400,
      json: {
        ok: false,
        error: "buyer_mismatch",
        detail: "El buyer_id del cuerpo no coincide con el comprador de la orden en BD",
        order_buyer_id: orderBuyerId,
      },
    };
  }

  const mlUserId = Number(order.ml_user_id);
  const prefNorm = tipoRetiroStr != null ? normalizeBuyerPrefEntrega(tipoRetiroStr) : null;

  try {
    const existing = await db.getMlBuyer(buyerId);
    if (existing) {
      const patch = { phone_1: phoneRaw };
      if (prefNorm != null) patch.pref_entrega = prefNorm;
      await db.updateMlBuyerPhones(buyerId, patch);
    } else {
      await db.upsertMlBuyer({
        buyer_id: buyerId,
        phone_1: phoneRaw,
        pref_entrega: prefNorm != null ? prefNorm : undefined,
      });
    }
  } catch (e) {
    await saveLog({
      order_id: orderId,
      buyer_id: buyerId,
      ml_user_id: mlUserId,
      outcome: "error",
      skip_reason: `Error al actualizar buyer: ${e.message || String(e)}`,
    });
    return {
      httpStatus: 500,
      json: { ok: false, error: "buyer_update_failed", detail: e.message || String(e) },
    };
  }

  let tipoEResult;
  try {
    tipoEResult = await trySendWhatsappTipoEForOrder({ mlUserId, orderId });
  } catch (e) {
    await saveLog({
      order_id: orderId,
      buyer_id: buyerId,
      ml_user_id: mlUserId,
      outcome: "error",
      skip_reason: `Excepción tipo E: ${e.message || String(e)}`,
      tipo_e_detail: safeJson({ exception: e.message || String(e) }),
    });
    return {
      httpStatus: 500,
      json: { ok: false, error: "tipo_e_exception", detail: e.message || String(e) },
    };
  }

  const tipoEDetail = safeJson(tipoEResult).slice(0, 16000);
  const eOk = tipoEResult && tipoEResult.ok === true;
  const eOutcome = tipoEResult && tipoEResult.outcome != null ? String(tipoEResult.outcome) : "";

  let logOutcome = "success";
  let skipReason = null;
  if (!eOk) {
    logOutcome = "skipped";
    skipReason = tipoEResult.detail || tipoEResult.outcome || "tipo E no enviado";
  }

  await saveLog({
    order_id: orderId,
    buyer_id: buyerId,
    ml_user_id: mlUserId,
    outcome: logOutcome,
    skip_reason: skipReason,
    tipo_e_detail: tipoEDetail,
  });

  return {
    httpStatus: 200,
    json: {
      ok: true,
      buyer_updated: true,
      tipo_e: {
        sent: eOk,
        outcome: tipoEResult.outcome,
        detail: tipoEResult.detail,
      },
    },
  };
}

module.exports = {
  processFilemakerTipoGPost,
  normalizePayloadKeys,
};
