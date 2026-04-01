/**
 * Mensajes internos de orden (tag `internal` en ML): si el texto incluye un móvil VE `04#########` o `04XX-XXXXXXX`,
 * actualizar ml_buyers (si ya hay `phone_1`, el número detectado va a `phone_2`) e invocar envío tipo E (Wasender; log con `tipo_e_activation_source=mensajeria_interna_ord`).
 *
 * ML_INTERNAL_ORDER_MESSAGE_TAG — tag API a considerar (default: internal).
 * ML_WHATSAPP_TIPO_E_INTERNAL_MESSAGE=0 — desactiva este flujo.
 */

const db = require("./db");
const { extractOrderIdFromMessage } = require("./ml-pack-extract");
const { extractBuyerIdForPostSale } = require("./ml-buyer-extract");
const { trySendWhatsappTipoEForOrder } = require("./ml-whatsapp-tipo-ef");

function internalTagFromEnv() {
  const t = (process.env.ML_INTERNAL_ORDER_MESSAGE_TAG || "internal").trim().toLowerCase();
  return t || "internal";
}

function isInternalOrderMessageTag(parsed, resourceStr) {
  const want = internalTagFromEnv();
  const check = (t) => t != null && String(t).trim().toLowerCase() === want;
  if (parsed && typeof parsed === "object") {
    if (check(parsed.tag)) return true;
    if (check(parsed.message_type)) return true;
    if (check(parsed.type)) return true;
    if (String(parsed.visibility || "").trim().toLowerCase() === want) return true;
    const msg = parsed.message;
    if (msg && typeof msg === "object") {
      if (check(msg.tag)) return true;
      if (check(msg.message_type)) return true;
      if (check(msg.type)) return true;
      if (String(msg.visibility || "").trim().toLowerCase() === want) return true;
      if (Array.isArray(msg.tags)) {
        for (const t of msg.tags) {
          if (check(t)) return true;
        }
      }
    }
  }
  const rs = resourceStr != null ? String(resourceStr) : "";
  if (!rs) return false;
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`[?&]tag=${esc}(?:&|$)`, "i");
  if (re.test(rs)) return true;
  try {
    if (re.test(decodeURIComponent(rs))) return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

function extractMessageTextFromMlMessagePayload(data) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (t) parts.push(t);
    } else if (typeof v === "object" && v.text != null) {
      push(String(v.text));
    }
  };
  push(data.text);
  push(data.body);
  push(data.plain_text);
  if (data.text && typeof data.text === "object") {
    push(data.text.plain);
  }
  const msg = data.message;
  if (typeof msg === "string") push(msg);
  else if (msg && typeof msg === "object") {
    push(msg.text);
    push(msg.body);
    push(msg.plain_text);
    if (msg.text && typeof msg.text === "object") {
      push(msg.text.plain);
    }
    if (msg.content && typeof msg.content === "object") {
      push(msg.content.text);
      push(msg.content.plain_text);
    }
  }
  return parts.join("\n");
}

/** @returns {string|null} 11 dígitos 04XXXXXXXXX (acepta también 04XX-XXXXXXX). */
function extractFirstMobile04(text) {
  if (!text || typeof text !== "string") return null;
  const compact = text.replace(/\s+/g, " ");
  const plain = compact.match(/\b04\d{9}\b/);
  if (plain) return plain[0];
  const hy = compact.match(/\b04\d{2}-\d{7}\b/);
  return hy ? hy[0].replace("-", "") : null;
}

function isPhoneSlotEmpty(p) {
  return p == null || String(p).trim() === "";
}

/**
 * Si `phone_1` está vacío → guardar en `phone_1`. Si ya hay `phone_1` → el número detectado va a `phone_2`
 * (sustituye `phone_2` si estaba lleno), para no pisar el contacto principal.
 */
async function applyExtractedPhoneToBuyer(buyerId, digits11) {
  const row = await db.getMlBuyer(buyerId);
  if (!row) {
    await db.upsertMlBuyer({ buyer_id: buyerId, phone_1: digits11, phone_2: null });
    return { updated: true, slot: "phone_1", previous: null };
  }
  if (isPhoneSlotEmpty(row.phone_1)) {
    await db.updateMlBuyerPhones(buyerId, { phone_1: digits11 });
    return { updated: true, slot: "phone_1", previous: row.phone_1 ?? null };
  } else {
    await db.updateMlBuyerPhones(buyerId, { phone_2: digits11 });
    return { updated: true, slot: "phone_2", previous: row.phone_2 ?? null };
  }
}

/**
 * @param {{ mlUserId: number, parsed: object, resourceStr?: string, tipoEActivationSource?: string }} args
 */
async function processOrderMessagePhoneForTipoE(args) {
  const parsed = args.parsed;
  if (!parsed || typeof parsed !== "object") {
    return { skipped: true, reason: "no_payload" };
  }
  const orderId = extractOrderIdFromMessage(parsed);
  const text = extractMessageTextFromMlMessagePayload(parsed);
  const phone = extractFirstMobile04(text);
  if (!orderId || !phone) {
    return { skipped: true, reason: "no_order_or_phone" };
  }

  const buyerId = extractBuyerIdForPostSale(parsed, args.mlUserId);
  if (!buyerId) {
    return { skipped: true, reason: "no_buyer_id" };
  }

  const buyerUpdate = await applyExtractedPhoneToBuyer(buyerId, phone);

  const r = await trySendWhatsappTipoEForOrder({
    mlUserId: args.mlUserId,
    orderId,
    tipoEActivationSource:
      args.tipoEActivationSource != null && String(args.tipoEActivationSource).trim() !== ""
        ? String(args.tipoEActivationSource).trim()
        : "mensajeria_interna_ord",
  });
  return {
    ok: r.ok === true,
    outcome: r.outcome,
    detail: r.detail,
    order_id: orderId,
    buyer_id: buyerId,
    phone,
    buyer_updated: buyerUpdate && buyerUpdate.updated === true,
    buyer_slot: buyerUpdate && buyerUpdate.slot ? buyerUpdate.slot : null,
  };
}

/**
 * @param {{ mlUserId: number, parsed: object, resourceStr?: string }} args
 */
async function maybeProcessInternalOrderMessageForTipoE(args) {
  const off = process.env.ML_WHATSAPP_TIPO_E_INTERNAL_MESSAGE;
  if (off === "0" || off === "false" || off === "off") {
    return { skipped: true, reason: "disabled_env" };
  }
  const parsed = args.parsed;
  if (!parsed || typeof parsed !== "object") {
    return { skipped: true, reason: "no_payload" };
  }
  if (!isInternalOrderMessageTag(parsed, args.resourceStr)) {
    return { skipped: true, reason: "not_internal" };
  }
  return processOrderMessagePhoneForTipoE({
    ...args,
    tipoEActivationSource: "mensajeria_interna_ord",
  });
}

module.exports = {
  maybeProcessInternalOrderMessageForTipoE,
  processOrderMessagePhoneForTipoE,
  isInternalOrderMessageTag,
  extractFirstMobile04,
  extractMessageTextFromMlMessagePayload,
};
