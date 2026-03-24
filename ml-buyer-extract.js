/**
 * Extrae datos del comprador desde el JSON de GET /orders/{id} (Mercado Libre).
 */

function normalizePhone(p) {
  if (p == null) return null;
  if (typeof p === "string") {
    const s = p.trim();
    return s !== "" ? s : null;
  }
  if (typeof p === "object") {
    const n = p.number != null ? String(p.number) : "";
    const ac = p.area_code != null ? String(p.area_code) : "";
    const ext = p.extension != null ? String(p.extension) : "";
    const joined = `${ac}${n}${ext}`.replace(/\s+/g, "").trim();
    return joined !== "" ? joined : null;
  }
  return null;
}

/**
 * @returns {{ buyer_id: number, nickname: string|null, phone_1: string|null, phone_2: string|null } | null}
 */
function extractBuyerFromOrderPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const b = data.buyer;
  if (!b || typeof b !== "object") return null;
  const rawId = b.id;
  if (rawId == null || !Number.isFinite(Number(rawId))) return null;
  const buyerId = Number(rawId);

  const nickname = b.nickname != null && String(b.nickname).trim() !== "" ? String(b.nickname) : null;

  const phones = [];
  const pushUnique = (val) => {
    const n = normalizePhone(val);
    if (n && !phones.includes(n)) phones.push(n);
  };

  pushUnique(b.phone);
  pushUnique(b.alternative_phone);

  if (Array.isArray(b.phones)) {
    for (const x of b.phones) pushUnique(x);
  }

  return {
    buyer_id: buyerId,
    nickname,
    phone_1: phones[0] || null,
    phone_2: phones[1] || null,
  };
}

/**
 * Id del comprador para post-venta (orden GET /orders, orden anidada, o hilo de mensajes).
 * @param {object} data
 * @param {number} [sellerUserId] — si viene, en payloads `from`/`to` se elige el otro usuario.
 * @returns {number|null}
 */
function extractBuyerIdForPostSale(data, sellerUserId) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fromOrder = extractBuyerFromOrderPayload(data);
  if (fromOrder) return fromOrder.buyer_id;
  if (data.order && typeof data.order === "object") {
    const nested = extractBuyerFromOrderPayload(data.order);
    if (nested) return nested.buyer_id;
  }
  const sid =
    sellerUserId != null && Number.isFinite(Number(sellerUserId))
      ? Number(sellerUserId)
      : null;
  if (sid != null && sid > 0) {
    const fromUid = readParticipantUserId(data.from);
    const toUidVal = readParticipantUserId(data.to);
    if (fromUid && toUidVal && fromUid !== toUidVal) {
      if (fromUid === sid) return toUidVal;
      if (toUidVal === sid) return fromUid;
    }
  }
  return null;
}

function readParticipantUserId(part) {
  if (!part || typeof part !== "object") return null;
  const raw = part.user_id ?? part.id;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { extractBuyerFromOrderPayload, extractBuyerIdForPostSale };
