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

module.exports = { extractBuyerFromOrderPayload };
