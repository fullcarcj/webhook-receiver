/**
 * Mensajería post-venta (ML): recordatorios de retiro por la mañana y de despacho por la tarde.
 * En cada envío se elige una plantilla al azar entre 10 (pool mañana o pool tarde).
 *
 * Elegibilidad (órdenes en ml_orders):
 *   - Calificación **pendiente del vendedor al comprador (sale)** y **pendiente del comprador al vendedor (purchase)** a la vez.
 *   - En `ml_order_feedback`, “ya calificado” = rating positive|neutral|negative (el texto `pending` no cuenta como calificación).
 *   - Resumen en `ml_orders`: sin positive/neutral/negative en sale/purchase y `feedback_purchase_value` NULL.
 *   - No se envía si cualquier lado ya tiene calificación concreta.
 *
 * Límite por franja: como máximo **un** recordatorio por comprador y cuenta en la **mañana** y **otro** en la **tarde**
 * (día civil según ML_RETIRO_TIMEZONE).
 * Además, regla global: no más de **ML_AUTO_MESSAGE_MAX** mensajes automáticos al mismo comprador el **mismo día**
 * (post-venta + calificación + retiro; ver `ml-auto-message-cap.js`).
 *
 * Horarios programados (Venezuela, America/Caracas): 7:30 y 14:30 — ver .github/workflows/retiro-broadcast-*.yml.
 *
 * Env:
 *   ML_RETIRO_ENABLED=1
 *   ML_RETIRO_SLOT=morning|afternoon   — obligatorio (o --slot=…)
 *   ML_RETIRO_LOOKBACK_DAYS=14          — órdenes con date_created en ventana
 *   ML_RETIRO_ORDER_STATUS=confirmed  — opcional (filtra ml_orders.status)
 *   ML_RETIRO_TIMEZONE=America/Caracas — día civil para deduplicar
 *   ML_RETIRO_DELAY_MS=400
 *   ML_RETIRO_OPTION_ID=OTHER         — igual post-venta (OTHER o SEND_INVOICE_LINK)
 *
 * Uso:
 *   ML_RETIRO_ENABLED=1 ML_RETIRO_SLOT=morning node ml-retiro-broadcast.js --all
 *   node ml-retiro-broadcast.js --slot=afternoon --user=ML_USER_ID
 *   node ml-retiro-broadcast.js --print-templates
 */
require("./load-env-local");

const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { applyPostSalePlaceholders, MAX_OTHER } = require("./ml-post-sale-send");
const {
  listMlAccounts,
  listMlOrdersEligibleForRetiroBroadcast,
  insertMlRetiroBroadcastSent,
  insertMlRetiroBroadcastLog,
  wasRetiroBroadcastSentToBuyerTodaySlot,
} = require("./db");

/** Mañana: ya puede retirar el producto ofertado. */
const RETIRO_MORNING_BODIES = Object.freeze([
  "¡Hola! Tu compra ya está lista: podés pasar a retirar el producto ofertado cuando te quede cómodo. ¡Gracias por elegirnos!",
  "Buen día: ya podés retirar tu producto. Te esperamos; avísanos si venís para tenerlo listo.",
  "Hola, buenos días. Tu pedido está disponible para retiro. Pasá cuando puedas por el punto acordado.",
  "Buen día. El producto de tu compra ya está para retirar. Cualquier duda, escribinos por acá.",
  "¡Hola! Ya podés pasar a buscar tu producto ofertado. Gracias por la compra.",
  "Buenos días: tu orden está lista para retiro. Te esperamos en el horario habitual.",
  "Hola. Ya está listo tu producto para retiro. Avisanos cuando vengas y te lo entregamos.",
  "Buen día, gracias por tu compra. Podés retirar el producto ofertado; coordinamos si lo necesitás.",
  "¡Hola! Tu compra está disponible para retiro. Pasá cuando te quede bien.",
  "Buenos días: recordá que ya podés retirar tu producto. ¡Gracias por confiar en nosotros!",
]);

/** Tarde: seguimos despachando; retiro hasta 17:00; delivery y pago a tasa BCV. */
const RETIRO_AFTERNOON_BODIES = Object.freeze([
  "Buenas tardes: seguimos despachando. Podés retirar hasta las 5:00 p. m. Tenemos delivery y podés pagar a tasa BCV.",
  "Hola, buenas tardes. Aún estamos despachando; podés retirar hasta las 17:00. Delivery disponible y pago a tasa BCV.",
  "Buenas tardes. Seguimos en despacho: retiros hasta las 5 p. m. Recordá que tenemos delivery y aceptamos pago a tasa BCV.",
  "Hola: por la tarde seguimos despachando. Retiro en local hasta las 17:00. Delivery y pago BCV disponibles.",
  "Buenas tardes. Te recordamos que despachamos hasta las 5 p. m.; también delivery. Pagos a tasa BCV.",
  "Buenas: aún despachando. Podés pasar a retirar hasta las 17:00 o pedir delivery. Pago a tasa BCV.",
  "Hola, buenas tardes. Seguimos operando: retiro hasta las 5 p. m., delivery y opción de pago a tasa BCV.",
  "Buenas tardes. Seguimos con despachos; retiros hasta las 17:00. Consultá por delivery y tasa BCV.",
  "Hola. Por la tarde seguimos despachando hasta las 5 p. m. Delivery disponible; podés pagar a tasa BCV.",
  "Buenas tardes: aún despachamos. Retiro hasta las 17:00. Tenemos delivery y pago a tasa BCV cuando lo necesites.",
]);

function poolForSlot(slot) {
  const s = slot != null ? String(slot).trim().toLowerCase() : "";
  if (s === "morning") return RETIRO_MORNING_BODIES;
  if (s === "afternoon") return RETIRO_AFTERNOON_BODIES;
  return [];
}

function pickRandomTemplate(bodies, lastIndex) {
  const n = bodies.length;
  if (n === 0) return { template: "", index: -1 };
  if (n === 1) return { template: bodies[0], index: 0 };
  let idx = Math.floor(Math.random() * n);
  if (lastIndex != null && lastIndex >= 0 && lastIndex < n) {
    let guard = 0;
    while (idx === lastIndex && guard++ < 64) {
      idx = Math.floor(Math.random() * n);
    }
  }
  return { template: bodies[idx], index: idx };
}

function mlRetiroApiErrorLine(data) {
  if (data == null || typeof data !== "object") return null;
  const c = data.cause;
  const m = data.message;
  const parts = [];
  if (typeof m === "string" && m.trim()) parts.push(m.trim());
  if (typeof c === "string" && c.trim()) parts.push(`cause: ${c.trim()}`);
  return parts.length ? parts.join(" · ").slice(0, 4000) : null;
}

function responseBodyForLog(res) {
  if (res.rawText != null && String(res.rawText).trim()) {
    return String(res.rawText).slice(0, 8000);
  }
  if (res.data != null && typeof res.data === "object") {
    try {
      return JSON.stringify(res.data).slice(0, 8000);
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r));
}

function lookbackDays() {
  const n = Number(process.env.ML_RETIRO_LOOKBACK_DAYS || 14);
  if (!Number.isFinite(n) || n <= 0) return 14;
  return Math.min(90, Math.floor(n));
}

function sinceIso() {
  return new Date(Date.now() - lookbackDays() * 86400000).toISOString();
}

function defaultDelayMs() {
  const n = Number(process.env.ML_RETIRO_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 400;
}

function defaultTimezone() {
  const t = process.env.ML_RETIRO_TIMEZONE;
  return t != null && String(t).trim() !== "" ? String(t).trim() : "America/Caracas";
}

/**
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {number} buyerId
 * @param {string} text
 */
async function sendRetiroBroadcastMessage(mlUserId, orderId, buyerId, text) {
  const appId = String(
    process.env.ML_APPLICATION_ID || process.env.OAUTH_CLIENT_ID || "1837222235616049"
  ).trim();
  const q = new URLSearchParams({
    application_id: appId,
    tag: "post_sale",
  });
  const path = `/messages/packs/${orderId}/sellers/${mlUserId}?${q.toString()}`;
  const optionId = (
    process.env.ML_RETIRO_OPTION_ID ||
    process.env.ML_RATING_REQUEST_OPTION_ID ||
    process.env.ML_POST_SALE_OPTION_ID ||
    "OTHER"
  ).trim();
  if (optionId !== "OTHER" && optionId !== "SEND_INVOICE_LINK") {
    return {
      ok: false,
      status: 0,
      path,
      data: { message: "ML_RETIRO_OPTION_ID debe ser OTHER o SEND_INVOICE_LINK" },
      rawText: "",
    };
  }
  return mercadoLibrePostJsonForUser(mlUserId, path, {
    from: { user_id: mlUserId },
    to: { user_id: buyerId },
    option_id: optionId,
    text,
  });
}

/**
 * @param {number} mlUserId
 * @param {{ orderStatus?: string|null, slot: 'morning'|'afternoon' }} options
 */
async function runRetiroBroadcastForUser(mlUserId, options = {}) {
  const mlUid = Number(mlUserId);
  const slot = options.slot != null ? String(options.slot).trim().toLowerCase() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    return { ok: false, eligible: 0, sent: 0, failed: 0, error: "ml_user_id inválido" };
  }
  if (slot !== "morning" && slot !== "afternoon") {
    return { ok: false, eligible: 0, sent: 0, failed: 0, error: "slot debe ser morning o afternoon" };
  }

  if (process.env.ML_RETIRO_ENABLED !== "1") {
    return {
      ok: false,
      eligible: 0,
      sent: 0,
      failed: 0,
      error: "ML_RETIRO_ENABLED!=1",
    };
  }

  const tz = defaultTimezone();
  const orderStatusRaw =
    options.orderStatus != null && String(options.orderStatus).trim() !== ""
      ? String(options.orderStatus).trim()
      : null;

  const rows = await listMlOrdersEligibleForRetiroBroadcast(
    mlUid,
    sinceIso(),
    orderStatusRaw,
    slot,
    tz
  );
  const bodies = poolForSlot(slot);
  if (bodies.length === 0) {
    return { ok: false, eligible: 0, sent: 0, failed: 0, error: "pool de plantillas vacío" };
  }

  const delayMs = defaultDelayMs();
  let sent = 0;
  let failed = 0;
  let skippedBuyer = 0;
  let skippedAutoCapDay = 0;
  const buyersMessaged = new Set();
  let lastPoolIndex = null;

  for (const o of rows) {
    const orderId = o.order_id != null ? Number(o.order_id) : NaN;
    const buyerId = o.buyer_id != null ? Number(o.buyer_id) : NaN;
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(buyerId) || buyerId <= 0) {
      failed++;
      continue;
    }

    if (buyersMessaged.has(buyerId)) {
      skippedBuyer++;
      continue;
    }

    if (await wasRetiroBroadcastSentToBuyerTodaySlot(mlUid, buyerId, slot, tz)) {
      skippedBuyer++;
      continue;
    }

    const picked = pickRandomTemplate(bodies, lastPoolIndex);
    lastPoolIndex = picked.index;
    let text = applyPostSalePlaceholders(picked.template, {
      orderId,
      buyerId,
      sellerId: mlUid,
    });
    text = String(text).trim();
    if (text.length > MAX_OTHER) {
      console.warn(
        "[retiro-broadcast] order_id=%s texto truncado de %s a %s chars",
        orderId,
        text.length,
        MAX_OTHER
      );
      text = text.slice(0, MAX_OTHER);
    }

    if (await wasRetiroBroadcastSentToBuyerTodaySlot(mlUid, buyerId, slot, tz)) {
      skippedBuyer++;
      continue;
    }

    if ((await getAutoMessageBudgetForBuyerToday(mlUid, buyerId)) <= 0) {
      skippedAutoCapDay++;
      continue;
    }

    const res = await sendRetiroBroadcastMessage(mlUid, orderId, buyerId, text);
    const now = new Date().toISOString();

    if (res.ok) {
      await insertMlRetiroBroadcastLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        slot,
        outcome: "success",
        template_index: picked.index,
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
      });
      await insertMlRetiroBroadcastSent({
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        slot,
        sent_at: now,
        http_status: res.status,
        template_index: picked.index,
      });
      buyersMessaged.add(buyerId);
      sent++;
      console.log("[retiro-broadcast] enviado slot=%s order_id=%s ml_user_id=%s", slot, orderId, mlUid);
    } else {
      await insertMlRetiroBroadcastLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        slot,
        outcome: "api_error",
        template_index: picked.index,
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
        error_message: mlRetiroApiErrorLine(res.data) || `HTTP ${res.status}`,
      });
      failed++;
      console.warn(
        "[retiro-broadcast] fallo slot=%s order_id=%s HTTP %s",
        slot,
        orderId,
        res.status
      );
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    ok: true,
    eligible: rows.length,
    sent,
    failed,
    skipped_buyer: skippedBuyer,
    skipped_auto_cap_day: skippedAutoCapDay,
    order_status_filter: orderStatusRaw,
    slot,
  };
}

function parseArgs(argv) {
  let userId =
    process.env.ML_RETIRO_USER_ID != null ? Number(process.env.ML_RETIRO_USER_ID) : null;
  let all = process.env.ML_RETIRO_ALL === "1" || process.env.ML_RETIRO_ALL === "true";
  let orderStatus =
    process.env.ML_RETIRO_ORDER_STATUS != null
      ? String(process.env.ML_RETIRO_ORDER_STATUS).trim()
      : null;
  if (orderStatus === "") orderStatus = null;
  let slot =
    process.env.ML_RETIRO_SLOT != null ? String(process.env.ML_RETIRO_SLOT).trim().toLowerCase() : null;
  if (slot === "") slot = null;
  let printTemplates = false;
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (const a of cleaned) {
    const lower = a.toLowerCase();
    if (lower === "--all" || lower === "-a") all = true;
    else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    } else if (a.startsWith("--status=")) {
      const s = a.slice(9).trim();
      orderStatus = s || null;
    } else if (a.startsWith("--order-status=")) {
      const s = a.slice(15).trim();
      orderStatus = s || null;
    } else if (a.startsWith("--slot=")) {
      const s = a.slice(7).trim().toLowerCase();
      slot = s === "morning" || s === "afternoon" ? s : null;
    } else if (lower === "--print-templates" || lower === "--print-message") {
      printTemplates = true;
    }
  }
  return { userId, all, orderStatus, slot, printTemplates };
}

function printTemplatePools() {
  console.log("[retiro-broadcast] Mañana (%s plantillas):", RETIRO_MORNING_BODIES.length);
  RETIRO_MORNING_BODIES.forEach((t, i) => console.log("  %s. %s", i + 1, t));
  console.log("[retiro-broadcast] Tarde (%s plantillas):", RETIRO_AFTERNOON_BODIES.length);
  RETIRO_AFTERNOON_BODIES.forEach((t, i) => console.log("  %s. %s", i + 1, t));
}

async function main() {
  const { userId, all, orderStatus, slot: slotArg, printTemplates } = parseArgs(process.argv.slice(2));

  if (printTemplates) {
    printTemplatePools();
    process.exit(0);
  }

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[retiro-broadcast] DATABASE_URL no definida.");
    process.exit(1);
  }

  const slot = slotArg;
  if (slot !== "morning" && slot !== "afternoon") {
    console.error(
      "[retiro-broadcast] Indicá ML_RETIRO_SLOT=morning|afternoon o --slot=morning|afternoon"
    );
    process.exit(1);
  }

  const accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[retiro-broadcast] No hay cuentas en ml_accounts.");
    process.exit(1);
  }

  let targets = [];
  if (all) {
    targets = accounts.map((a) => Number(a.ml_user_id));
  } else if (userId != null && Number.isFinite(userId) && userId > 0) {
    targets = [userId];
  } else {
    targets = [Number(accounts[0].ml_user_id)];
    console.log("[retiro-broadcast] Sin --user ni --all: usando primera cuenta %s", targets[0]);
  }

  console.log(
    "[retiro-broadcast] slot=%s tz=%s lookback_days=%s since>=%s enabled=%s order_status=%s",
    slot,
    defaultTimezone(),
    lookbackDays(),
    sinceIso(),
    process.env.ML_RETIRO_ENABLED === "1" ? "1" : "0",
    orderStatus != null ? orderStatus : "(ninguno)"
  );

  if (process.env.ML_RETIRO_ENABLED !== "1") {
    console.error("[retiro-broadcast] Define ML_RETIRO_ENABLED=1 para enviar mensajes.");
    process.exit(1);
  }

  const results = [];
  for (const uid of targets) {
    const r = await runRetiroBroadcastForUser(uid, { orderStatus, slot });
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[retiro-broadcast] ml_user_id=%s eligible=%s sent=%s skipped_mismo_comprador=%s skipped_tope_3_dia=%s failed=%s err=%s",
      uid,
      r.eligible,
      r.sent,
      r.skipped_buyer ?? 0,
      r.skipped_auto_cap_day ?? 0,
      r.failed,
      r.error || "—"
    );
  }

  const bad = results.filter((x) => !x.ok);
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[retiro-broadcast]", e);
    process.exit(1);
  });
}

module.exports = {
  runRetiroBroadcastForUser,
  sendRetiroBroadcastMessage,
  RETIRO_MORNING_BODIES,
  RETIRO_AFTERNOON_BODIES,
  lookbackDays,
  sinceIso,
  pickRandomTemplate,
};
