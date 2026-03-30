/**
 * Envío automático del texto de post_sale_messages vía API ML.
 * POST .../messages/packs/{order_id}/sellers/{seller_id}?application_id=...&tag=post_sale
 * Body: from.user_id = vendedor, to.user_id = comprador (buyer_id).
 *
 * Varias plantillas: filas en post_sale_messages ordenadas por id (1.º = principal, 2.º y 3.º opcionales).
 * ML_POST_SALE_TOTAL_MESSAGES=1|2|3 (por defecto 1). ML_POST_SALE_EXTRA_DELAY_MS entre envíos (default 1500).
 * Antiduplicado: cola por order_id + reserva atómica en BD (tryClaim) + log de éxito el mismo día (zona ML_AUTO_MESSAGE_TIMEZONE).
 * Placeholders en el texto: {{order_id}}, {{buyer_id}}, {{seller_id}}, {{ml_user_id}}
 */
const { mercadoLibrePostJsonForUser, mercadoLibreFetchForUser } = require("./oauth-token");
const {
  extractOrderIdFromOrder,
  extractOrderIdFromMessage,
  extractOrderIdFromResource,
} = require("./ml-pack-extract");
const { extractBuyerIdForPostSale } = require("./ml-buyer-extract");
const {
  listPostSaleMessages,
  wasPostSaleSent,
  markPostSaleSent,
  markPostSaleStepSent,
  isPostSaleStepSent,
  tryClaimPostSaleStepForSend,
  releasePostSaleStepClaim,
  hasPostSaleSuccessForStepToday,
  insertPostSaleAutoSendLog,
} = require("./db");
const { getAutoMessageBudgetForBuyerToday, getMlAutoMessageTimezone } = require("./ml-auto-message-cap");

const MAX_OTHER = Number(process.env.ML_POST_SALE_MAX_CHARS || 350);

let warnedDisableDedupOnce = false;

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

/**
 * Persiste en ml_post_sale_auto_send_log para topic orders_v2 (success, skipped, api_error).
 * Omite solo already_sent para no llenar la tabla en reintentos del mismo pedido.
 */
async function logAutoSend(row) {
  const t = row.topic != null ? String(row.topic).trim() : "";
  if (t !== "orders_v2") return;
  if (String(row.skip_reason || "") === "already_sent") return;
  try {
    await insertPostSaleAutoSendLog(row);
  } catch (e) {
    console.error("[post-sale log DB]", e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Evita condición de carrera: ML envía varias notificaciones por la misma orden; en paralelo ambas pasaban wasPostSaleSent antes del INSERT en ml_post_sale_steps_sent. */
const postSaleSerialChains = new Map();
function runPostSaleSerializedForOrder(orderId, fn) {
  const key = String(orderId);
  const prev = postSaleSerialChains.get(key) || Promise.resolve();
  const current = prev.then(() => fn());
  postSaleSerialChains.set(key, current);
  return current.finally(() => {
    if (postSaleSerialChains.get(key) === current) {
      postSaleSerialChains.delete(key);
    }
  });
}

/**
 * Si el payload no trae comprador, intenta GET /orders/{id} para completar JSON (p. ej. tras fallo del fetch del webhook).
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {object|null} payload
 * @returns {Promise<object|null>}
 */
async function ensureOrderPayloadForPostSale(mlUserId, orderId, payload) {
  if (payload && extractBuyerIdForPostSale(payload, mlUserId)) return payload;
  const path = `/orders/${orderId}`;
  const r = await mercadoLibreFetchForUser(mlUserId, path);
  if (!r.ok || r.data == null) return payload;
  let d = r.data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return payload;
    }
  }
  if (d && typeof d === "object" && !Array.isArray(d)) return d;
  return payload;
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
 * @param {{ mlUserId: number, topic: string|null, payload?: object|null, resource?: string|null, notificationId?: string|null }} args
 */
async function trySendDefaultPostSaleMessage(args) {
  let topicTrim = args.topic != null ? String(args.topic).trim() : "";
  const resourceEarly = args.resource != null ? String(args.resource).trim() : "";
  if (!topicTrim && resourceEarly) {
    if (/\/orders\/\d/i.test(resourceEarly)) topicTrim = "orders_v2";
    else if (/\/messages\//i.test(resourceEarly)) topicTrim = "messages";
  }
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

  let payload =
    args.payload != null && typeof args.payload === "object" && !Array.isArray(args.payload)
      ? args.payload
      : null;
  const resourceStr = args.resource != null ? String(args.resource).trim() : "";

  if (!payload && resourceStr && (topic === "orders_v2" || String(topic).startsWith("orders"))) {
    const oid = extractOrderIdFromResource(resourceStr);
    if (oid) payload = { id: oid };
  }

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
    orderId = extractOrderIdFromOrder(payload) || extractOrderIdFromResource(resourceStr);
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

  return runPostSaleSerializedForOrder(orderId, async () => {
    if (topic === "orders_v2" || String(topic).startsWith("orders")) {
      const enriched = await ensureOrderPayloadForPostSale(args.mlUserId, orderId, payload);
      if (enriched) payload = enriched;
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

    /** Solo pruebas: sin deduplicación ni marcas en BD; puede repetir envíos al comprador. */
    const disableDedup = process.env.ML_POST_SALE_DISABLE_DEDUP === "1";
    if (disableDedup && !warnedDisableDedupOnce) {
      warnedDisableDedupOnce = true;
      console.warn(
        "[post-sale] ML_POST_SALE_DISABLE_DEDUP=1: deduplicación desactivada (no se usa ml_post_sale_sent/steps_sent)."
      );
    }

    if (!disableDedup && (await wasPostSaleSent(orderId, totalSteps))) {
      return { skipped: true, reason: "already_sent", order_id: orderId };
    }

    let remainingAuto = await getAutoMessageBudgetForBuyerToday(args.mlUserId, buyerId);
    if (remainingAuto <= 0) {
      await logAutoSend({
        ...base,
        order_id: orderId,
        outcome: "skipped",
        skip_reason: "auto_message_cap_day",
      });
      return { skipped: true, reason: "auto_message_cap_day", order_id: orderId };
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
    const capTz = getMlAutoMessageTimezone();

    let lastResult = { ok: false, status: 0, order_id: orderId, data: null };
    let stoppedByAutoCap = false;

    for (let step = 0; step < totalSteps; step++) {
      if (remainingAuto <= 0) {
        stoppedByAutoCap = true;
        break;
      }
      if (!disableDedup && (await hasPostSaleSuccessForStepToday(orderId, step, capTz))) {
        await logAutoSend({
          ...base,
          order_id: orderId,
          outcome: "skipped",
          skip_reason: `post_sale_same_day_log_step=${step}`,
        });
        continue;
      }
      if (disableDedup) {
        if (await isPostSaleStepSent(orderId, step)) {
          continue;
        }
      } else {
        const claimed = await tryClaimPostSaleStepForSend(orderId, step);
        if (!claimed) {
          continue;
        }
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
        if (disableDedup) {
          await markPostSaleStepSent(orderId, step);
        }
        remainingAuto--;
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
        if (!disableDedup) {
          await releasePostSaleStepClaim(orderId, step);
        }
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

    if (!disableDedup && !stoppedByAutoCap) {
      await markPostSaleSent(orderId);
    }
    return lastResult;
  });
}

module.exports = { trySendDefaultPostSaleMessage, MAX_OTHER, applyPostSalePlaceholders };
