"use strict";

const { pool } = require("../../db");
const { resolveCustomer } = require("./resolveCustomer");
const { pickMlBuyerLegalNameFromOrder, preferRicherLegalName } = require("../../ml-buyer-extract");
const { normalizeNombreApellido } = require("../../ml-buyer-pref");

/**
 * Nombre legible desde `order.buyer`: nombre/apellido del payload si no es solo eco del nickname;
 * si no, `ML-{id}`, nickname o "Cliente".
 */
function buildBuyerNameFromOrderBuyer(buyer, buyerIdStr) {
  const nick =
    buyer && typeof buyer === "object" && buyer.nickname != null
      ? String(buyer.nickname).trim()
      : "";
  if (!buyer || typeof buyer !== "object") {
    return (buyerIdStr ? `ML-${buyerIdStr}` : "") || nick || "Cliente";
  }
  const fn = buyer.first_name != null ? String(buyer.first_name).trim() : "";
  const ln = buyer.last_name != null ? String(buyer.last_name).trim() : "";
  const composed = [fn, ln].filter(Boolean).join(" ").trim();
  if (composed) {
    const nickL = nick.toLowerCase();
    if (!nickL || composed.toLowerCase() !== nickL) {
      return composed;
    }
  }
  const idLabel = buyerIdStr ? `ML-${buyerIdStr}` : "";
  return idLabel || nick || "Cliente";
}

async function fetchNombreApellidoFromMlBuyers(buyerIdNum) {
  const { rows } = await pool.query(
    `SELECT nombre_apellido FROM ml_buyers WHERE buyer_id = $1 LIMIT 1`,
    [buyerIdNum]
  );
  const raw = rows[0] && rows[0].nombre_apellido != null ? String(rows[0].nombre_apellido).trim() : "";
  return raw ? normalizeNombreApellido(raw) : null;
}

/**
 * Resuelve o enriquece customer desde payload GET /orders/{id} (ML).
 * Usa resolveCustomer unificado (identidad ML + teléfonos normalizados).
 */
async function resolveMLCustomerFromOrder(orderPayload) {
  if (!orderPayload || typeof orderPayload !== "object") return null;
  const buyer = orderPayload.buyer;
  if (!buyer || buyer.id == null) return null;
  const buyerId = String(buyer.id).trim();
  const buyerIdNum = Number(buyer.id);

  let fromDb = null;
  if (Number.isFinite(buyerIdNum) && buyerIdNum > 0) {
    try {
      fromDb = await fetchNombreApellidoFromMlBuyers(buyerIdNum);
    } catch (_e) {
      fromDb = null;
    }
  }

  const fromOrderLegal = pickMlBuyerLegalNameFromOrder(orderPayload);
  const legalMerged = preferRicherLegalName(fromDb, fromOrderLegal);
  const fallback = buildBuyerNameFromOrderBuyer(buyer, buyerId);
  const buyerName = legalMerged || fallback;
  const ml_replace_full_name = Boolean(legalMerged);

  const phone1 = buyer.phone && buyer.phone.number ? String(buyer.phone.number).trim() : null;
  const phone2 =
    buyer.alternative_phone && buyer.alternative_phone.number
      ? String(buyer.alternative_phone.number).trim()
      : null;

  try {
    const r = await resolveCustomer({
      source: "mercadolibre",
      external_id: buyerId,
      data: { name: buyerName, phone: phone1, phone2, ml_replace_full_name },
    });
    return r.customerId;
  } catch (e) {
    if (e && e.code === "42P01") {
      return null;
    }
    throw e;
  }
}

module.exports = { resolveMLCustomerFromOrder };
