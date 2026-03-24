/**
 * Envío automático del texto de post_sale_messages vía API ML (action_guide).
 * Texto libre: option_id OTHER (o SEND_INVOICE_LINK) — máx. 350 caracteres por defecto.
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { extractPackIdFromOrder, extractPackIdFromMessage } = require("./ml-pack-extract");
const {
  getFirstPostSaleMessageBody,
  wasPostSaleSent,
  markPostSaleSent,
} = require("./db");

const MAX_OTHER = Number(process.env.ML_POST_SALE_MAX_CHARS || 350);

function parseTopicsEnv() {
  return (process.env.ML_AUTO_SEND_TOPICS || "orders_v2")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{ mlUserId: number, topic: string|null, payload: object, notificationId?: string|null }} args
 */
async function trySendDefaultPostSaleMessage(args) {
  if (process.env.ML_AUTO_SEND_POST_SALE !== "1") {
    return { skipped: true, reason: "ML_AUTO_SEND_POST_SALE!=1" };
  }

  const topicList = parseTopicsEnv();
  const topic = args.topic;
  if (!topic || !topicList.includes(topic)) {
    return { skipped: true, reason: "topic" };
  }

  const payload = args.payload;
  if (!payload || typeof payload !== "object") {
    return { skipped: true, reason: "no_payload" };
  }

  let packId = null;
  if (topic === "orders_v2" || String(topic).startsWith("orders")) {
    packId = extractPackIdFromOrder(payload);
  } else if (topic === "messages") {
    packId = extractPackIdFromMessage(payload);
  }

  if (!packId) {
    return { skipped: true, reason: "no_pack_id" };
  }

  if (wasPostSaleSent(packId)) {
    return { skipped: true, reason: "already_sent", pack_id: packId };
  }

  const fullText = getFirstPostSaleMessageBody();
  if (!fullText || !String(fullText).trim()) {
    return { skipped: true, reason: "no_template" };
  }

  let text = String(fullText).trim();
  if (text.length > MAX_OTHER) {
    console.warn(
      `[post-sale] plantilla (${text.length} chars) truncada a ${MAX_OTHER} (límite API ML). Acorta o divide el mensaje.`
    );
    text = text.slice(0, MAX_OTHER);
  }

  const optionId = (process.env.ML_POST_SALE_OPTION_ID || "OTHER").trim();
  if (optionId !== "OTHER" && optionId !== "SEND_INVOICE_LINK") {
    console.error(
      "[post-sale] ML_POST_SALE_OPTION_ID debe ser OTHER o SEND_INVOICE_LINK para texto de plantilla"
    );
    return { skipped: true, reason: "bad_option" };
  }

  const path = `/messages/action_guide/packs/${packId}/option?tag=post_sale`;
  const result = await mercadoLibrePostJsonForUser(args.mlUserId, path, {
    option_id: optionId,
    text,
  });

  if (result.ok) {
    markPostSaleSent(packId);
    console.log("[post-sale] enviado pack_id=%s option=%s", packId, optionId);
  } else {
    console.error(
      "[post-sale] fallo HTTP %s pack_id=%s: %s",
      result.status,
      packId,
      (result.rawText || "").slice(0, 400)
    );
  }

  return { ok: result.ok, status: result.status, pack_id: packId, data: result.data };
}

module.exports = { trySendDefaultPostSaleMessage, MAX_OTHER };
