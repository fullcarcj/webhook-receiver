"use strict";

const { resolveCustomer } = require("./resolveCustomer");

/**
 * Resuelve o enriquece customer desde payload GET /orders/{id} (ML).
 * Usa resolveCustomer unificado (identidad ML + teléfonos normalizados).
 */
async function resolveMLCustomerFromOrder(orderPayload) {
  if (!orderPayload || typeof orderPayload !== "object") return null;
  const buyer = orderPayload.buyer;
  if (!buyer || buyer.id == null) return null;
  const buyerId = String(buyer.id).trim();
  const buyerName =
    (buyer.nickname && String(buyer.nickname).trim()) ||
    (buyer.first_name && `${buyer.first_name} ${buyer.last_name || ""}`.trim()) ||
    `ML-${buyerId}`;
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
