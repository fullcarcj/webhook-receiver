/**
 * Envío automático del texto de post_sale_messages vía API ML.
 * POST .../messages/packs/{order_id}/sellers/{seller_id}?application_id=...&tag=post_sale
 * Body: from.user_id = vendedor, to.user_id = comprador (buyer_id).
 *
 * Varias plantillas: filas en post_sale_messages ordenadas por id (1.º = principal, 2.º y 3.º opcionales).
 * ML_POST_SALE_TOTAL_MESSAGES=1|2|3 (por defecto 1). ML_POST_SALE_EXTRA_DELAY_MS entre envíos (default 1500).
 * Placeholders en el texto: {{order_id}}, {{buyer_id}}, {{seller_id}}, {{ml_user_id}}
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { extractOrderIdFromOrder, extractOrderIdFromMessage } = require("./ml-pack-extract");
const { extractBuyerIdForPostSale } = require("./ml-buyer-extract");
const {
  listPostSaleMessages,
  wasPostSaleSent,
  markPostSaleSent,
  markPostSaleStepSent,
  isPostSaleStepSent,
  insertPostSaleAutoSendLog,
} = require("./db");

const MAX_OTHER = Number(process.env.ML_POST_SALE_MAX_CHARS || 350);

/** Solo se persiste en BD el intento asociado al paso 0 (primer mensaje). */
const POST_SALE_LOG_SKIP_REASON_STEP0 = "message_step=0";

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

/** Solo persiste en ml_post_sale_auto_send_log cuando el webhook es orders_v2; no guarda si ya se envió (already_sent). */
async function logAutoSend(row) {
  const t = row.topic != null ? String(row.topic).trim() : "";
  if (t !== "orders_v2") return;
  if (String(row.skip_reason || "") === "already_sent") return;
  const oc = String(row.outcome || "");
  if (oc === "success" || oc === "skipped") return;
  if (String(row.skip_reason || "").trim() !== POST_SALE_LOG_SKIP_REASON_STEP0) return;
  try {
    await insertPostSaleAutoSendLog(row);
  } catch (e) {
    console.error("[post-sale log DB]", e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} text
 * @param {{ orderId: number, buyerId: number, sellerId: number }} ctx
 */
function applyPostSalePlaceholders(text, ctx) {
  if (text == null) return "";
  let s = String(text);
  const orderId = ctx.orderId != null ? String(ctx.orderId) : "";
  const buyerId = ctx.buyerId != null ? String(ctx.buyerId) : "";
  const sellerId = ctx.sellerId != null ? String(ctx.sellerId) : "";
  const map = [
    ["{{order_id}}", orderId],
    ["{{buyer_id}}", buyerId],
    ["{{seller_id}}", sellerId],
    ["{{ml_user_id}}", sellerId],
  ];
  for (const [k, v] of map) {
    s = s.split(k).join(v);
  }
  return s;
}

async function computePostSaleBodiesAndSteps() {
  const rows = await listPostSaleMessages();
  const bodies = rows
    .map((r) => (r.body != null ? String(r.body).trim() : ""))
    .filter(Boolean);
  const maxFromEnv = Math.min(Math.max(parseInt(process.env.ML_POST_SALE_TOTAL_MESSAGES || "1", 10) || 1, 1), 3);
  const totalSteps = Math.min(maxFromEnv, bodies.length);
  return { totalSteps, bodies };
}

/**
 * @param {{ mlUserId: number, topic: string|null, payload: object, notificationId?: string|null }} args
 */
async function trySendDefaultPostSaleMessage(args) {
  const topicTrim = args.topic != null ? String(args.topic).trim() : "";
  const orderLike =
    topicTrim && (topicTrim === "orders_v2" || String(topicTrim).startsWith("orders"));
  const messagesTopic = topicTrim === "messages";
  /** Evita cualquier log o lógica para topics tipo items, questions, stock-locations, etc. */
  if (topicTrim && !orderLike && !messagesTopic) {
    return { skipped: true, reason: "topic_not_for_post_sale" };
  }

  const base = {
    ml_user_id: args.mlUserId,
    topic: topicTrim || null,
    notification_id: args.notificationId != null ? String(args.notificationId) : null,
  };

  if (process.env.ML_AUTO_SEND_POST_SALE !== "1") {
    await logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: "ML_AUTO_SEND_POST_SALE!=1",
    });
    return { skipped: true, reason: "ML_AUTO_SEND_POST_SALE!=1" };
  }

  const topicList = parseTopicsEnv();
  const topic = topicTrim;
  if (!topic || !topicList.includes(topic)) {
    /** No registrar en BD el skip "topic no listado" salvo para orders_v2 (config mal armada). */
    if (topic === "orders_v2") {
      await logAutoSend({
        ...base,
        outcome: "skipped",
        skip_reason: `topic no listado (ML_AUTO_SEND_TOPICS=${process.env.ML_AUTO_SEND_TOPICS || "orders_v2"})`,
      });
    }
    return { skipped: true, reason: "topic" };
  }

  const payload = args.payload;
  if (!payload || typeof payload !== "object") {
    await logAutoSend({
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
    await logAutoSend({
      ...base,
      outcome: "skipped",
      skip_reason: "no_order_id",
    });
    return { skipped: true, reason: "no_order_id" };
  }

  const buyerId = extractBuyerIdForPostSale(payload, args.mlUserId);
  if (!buyerId) {
    await logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "no_buyer_id",
    });
    return { skipped: true, reason: "no_buyer_id", order_id: orderId };
  }

  const { totalSteps, bodies } = await computePostSaleBodiesAndSteps();
  if (totalSteps === 0) {
    await logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "no_template",
    });
    return { skipped: true, reason: "no_template" };
  }

  if (await wasPostSaleSent(orderId, totalSteps)) {
    return { skipped: true, reason: "already_sent", order_id: orderId };
  }

  const optionId = (process.env.ML_POST_SALE_OPTION_ID || "OTHER").trim();
  if (optionId !== "OTHER" && optionId !== "SEND_INVOICE_LINK") {
    console.error(
      "[post-sale] ML_POST_SALE_OPTION_ID debe ser OTHER o SEND_INVOICE_LINK para texto de plantilla"
    );
    await logAutoSend({
      ...base,
      order_id: orderId,
      outcome: "skipped",
      skip_reason: "bad_option",
      option_id: optionId,
    });
    return { skipped: true, reason: "bad_option" };
  }

  const appId = String(
    process.env.ML_APPLICATION_ID || process.env.OAUTH_CLIENT_ID || "1837222235616049"
  ).trim();
  const q = new URLSearchParams({
    application_id: appId,
    tag: "post_sale",
  });
  const path = `/messages/packs/${orderId}/sellers/${args.mlUserId}?${q.toString()}`;
  const delayMs = Math.max(0, Number(process.env.ML_POST_SALE_EXTRA_DELAY_MS) || 1500);
  const ctx = { orderId, buyerId, sellerId: args.mlUserId };

  let lastResult = { ok: false, status: 0, order_id: orderId, data: null };

  for (let step = 0; step < totalSteps; step++) {
    if (await isPostSaleStepSent(orderId, step)) {
      continue;
    }
    if (step > 0) {
      await sleep(delayMs);
    }

    let text = applyPostSalePlaceholders(bodies[step], ctx);
    text = String(text).trim();
    if (text.length > MAX_OTHER) {
      console.warn(
        `[post-sale] paso ${step} (${text.length} chars) truncado a ${MAX_OTHER} (límite API ML).`
      );
      text = text.slice(0, MAX_OTHER);
    }

    const result = await mercadoLibrePostJsonForUser(args.mlUserId, path, {
      from: { user_id: args.mlUserId },
      to: { user_id: buyerId },
      option_id: optionId,
      text,
    });

    lastResult = { ok: result.ok, status: result.status, order_id: orderId, data: result.data };

    if (result.ok) {
      await markPostSaleStepSent(orderId, step);
      console.log("[post-sale] enviado order_id=%s step=%s option=%s", orderId, step, optionId);
      const resp =
        result.data != null
          ? typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data)
          : null;
      await logAutoSend({
        ...base,
        order_id: orderId,
        outcome: "success",
        http_status: result.status,
        option_id: optionId,
        request_path: result.path,
        response_body: resp,
        skip_reason: `message_step=${step}`,
      });
    } else {
      const mlCause = mercadoLibreErrorCause(result.data);
      const mlMsg = mercadoLibreErrorMessage(result.data);
      const preview = (result.rawText || "").slice(0, 400);
      console.error(
        "[post-sale] fallo HTTP %s order_id=%s step=%s%s: %s",
        result.status,
        orderId,
        step,
        mlCause ? ` cause=${mlCause}` : "",
        preview
      );
      const errMsg =
        mlCause != null
          ? `HTTP ${result.status} · ${mlCause}`
          : mlMsg != null
            ? `HTTP ${result.status} · ${mlMsg}`
            : `HTTP ${result.status}`;
      await logAutoSend({
        ...base,
        order_id: orderId,
        outcome: "api_error",
        skip_reason: `message_step=${step}`,
        http_status: result.status,
        option_id: optionId,
        request_path: result.path,
        response_body: result.rawText ? String(result.rawText).slice(0, 8000) : null,
        error_message: errMsg,
      });
      return { ok: false, status: result.status, order_id: orderId, data: result.data, step };
    }
  }

  await markPostSaleSent(orderId);
  return lastResult;
}

module.exports = { trySendDefaultPostSaleMessage, MAX_OTHER, applyPostSalePlaceholders };
