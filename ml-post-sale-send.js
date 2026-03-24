/**
 * Envío automático del texto de post_sale_messages vía API ML.
 * POST .../messages/packs/{order_id}/sellers/{seller_id}?application_id=...&tag=post_sale
 * Body: from.user_id = vendedor, to.user_id = comprador (buyer_id).
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { extractOrderIdFromOrder, extractOrderIdFromMessage } = require("./ml-pack-extract");
const { extractBuyerIdForPostSale } = require("./ml-buyer-extract");
const {
  getFirstPostSaleMessageBody,
  wasPostSaleSent,
  markPostSaleSent,
  insertPostSaleAutoSendLog,
} = require("./db");

const MAX_OTHER = Number(process.env.ML_POST_SALE_MAX_CHARS || 350);

/** Respuesta JSON de error ML (p. ej. cause: shipment_invalid_to_action_guide). */
function mercadoLibreErrorCause(data) {
  if (data == null || typeof data !== "object") return null;
  const c = data.cause;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

function mercadoLibreErrorMessage(data) {
  if (data == null || typeof data !== "object") return null;
  const m = data.message;
  return typeof m === "string" && m.trim() ? m.trim().slice(0, 500) : null;
}

function parseTopicsEnv() {
  return (process.env.ML_AUTO_SEND_TOPICS || "orders_v2")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function logAutoSend(row) {
  try {
    insertPostSaleAutoSendLog(row);
  } catch (e) {
    console.error("[post-sale log DB]", e.message);
  }
}

/**
 * @param {{ mlUserId: number, topic: string|null, payload: object, notificationId?: string|null }} args
 */
async function trySendDefaultPostSaleMessage(args) {
  const base = {
    ml_user_id: args.mlUserId,
    topic: args.topic,
    notification_id: args.notificationId != null ? String(args.notificationId) : null,
  };

  if (process.env.ML_AUTO_SEND_POST_SALE !== "1") {
    logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: "ML_AUTO_SEND_POST_SALE!=1",
    });
    return { skipped: true, reason: "ML_AUTO_SEND_POST_SALE!=1" };
  }

  const topicList = parseTopicsEnv();
  const topic = args.topic;
  if (!topic || !topicList.includes(topic)) {
    logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: `topic no listado (ML_AUTO_SEND_TOPICS=${process.env.ML_AUTO_SEND_TOPICS || "orders_v2"})`,
    });
    return { skipped: true, reason: "topic" };
  }

  const payload = args.payload;
  if (!payload || typeof payload !== "object") {
    logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: "no_payload",
    });
    return { skipped: true, reason: "no_payload" };
  }

  let orderId = null;
  if (topic === "orders_v2" || String(topic).startsWith("orders")) {
    orderId = extractOrderIdFromOrder(payload);
  } else if (topic === "messages") {
    orderId = extractOrderIdFromMessage(payload);
  }

  if (!orderId) {
    logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: "no_order_id",
    });
    return { skipped: true, reason: "no_order_id" };
  }

  const buyerId = extractBuyerIdForPostSale(payload, args.mlUserId);
  if (!buyerId) {
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "no_buyer_id",
    });
    return { skipped: true, reason: "no_buyer_id", order_id: orderId };
  }

  if (wasPostSaleSent(orderId)) {
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "already_sent",
    });
    return { skipped: true, reason: "already_sent", order_id: orderId };
  }

  const fullText = getFirstPostSaleMessageBody();
  if (!fullText || !String(fullText).trim()) {
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "no_template",
    });
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
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "bad_option",
      option_id: optionId,
    });
    return { skipped: true, reason: "bad_option" };
  }

  const appId = String(
    process.env.ML_APPLICATION_ID ||
      process.env.OAUTH_CLIENT_ID ||
      "1837222235616049"
  ).trim();
  const q = new URLSearchParams({
    application_id: appId,
    tag: "post_sale",
  });
  const path = `/messages/packs/${orderId}/sellers/${args.mlUserId}?${q.toString()}`;
  const result = await mercadoLibrePostJsonForUser(args.mlUserId, path, {
    from: { user_id: args.mlUserId },
    to: { user_id: buyerId },
    option_id: optionId,
    text,
  });

  if (result.ok) {
    markPostSaleSent(orderId);
    console.log("[post-sale] enviado order_id=%s option=%s", orderId, optionId);
    const resp =
      result.data != null
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data)
        : null;
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "success",
      http_status: result.status,
      option_id: optionId,
      request_path: result.path,
      response_body: resp,
    });
  } else {
    const mlCause = mercadoLibreErrorCause(result.data);
    const mlMsg = mercadoLibreErrorMessage(result.data);
    const preview = (result.rawText || "").slice(0, 400);
    console.error(
      "[post-sale] fallo HTTP %s order_id=%s%s: %s",
      result.status,
      orderId,
      mlCause ? ` cause=${mlCause}` : "",
      preview
    );
    const errMsg =
      mlCause != null
        ? `HTTP ${result.status} · ${mlCause}`
        : mlMsg != null
          ? `HTTP ${result.status} · ${mlMsg}`
          : `HTTP ${result.status}`;
    logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "api_error",
      skip_reason:
        mlCause != null ? `ml:${mlCause}` : mlMsg != null ? `ml:${mlMsg.slice(0, 200)}` : null,
      http_status: result.status,
      option_id: optionId,
      request_path: result.path,
      response_body: result.rawText ? String(result.rawText).slice(0, 8000) : null,
      error_message: errMsg,
    });
  }

  return { ok: result.ok, status: result.status, order_id: orderId, data: result.data };
}

module.exports = { trySendDefaultPostSaleMessage, MAX_OTHER };
