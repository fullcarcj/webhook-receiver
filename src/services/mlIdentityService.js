"use strict";

const { resolveCustomer } = require("./resolveCustomer");

/**
 * Nombre legible desde `order.buyer`: prioridad nombre/apellido del payload;
 * `nickname` solo si no hay nombre real ni placeholder estable por id.
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
  if (composed) return composed;
  const idLabel = buyerIdStr ? `ML-${buyerIdStr}` : "";
  return idLabel || nick || "Cliente";
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
  const buyerName = buildBuyerNameFromOrderBuyer(buyer, buyerId);
  const phone1 = buyer.phone && buyer.phone.number ? String(buyer.phone.number).trim() : null;
  const phone2 =
    buyer.alternative_phone && buyer.alternative_phone.number
      ? String(buyer.alternative_phone.number).trim()
      : null;

  try {
    const r = await resolveCustomer({
      source: "mercadolibre",
      external_id: buyerId,
      data: { name: buyerName, phone: phone1, phone2 },
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
