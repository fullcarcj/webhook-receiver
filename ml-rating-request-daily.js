/**
 * Job diario (cron): envía un mensaje post-venta pidiendo calificación al comprador
 * solo si vos ya calificaste (lado sale) y el comprador aún no (purchase pendiente),
 * y la orden está en la ventana de días configurada.
 *
 * REGLA (inviolable): como máximo UN mensaje de recordatorio por comprador y por cuenta
 * vendedora (ml_user_id) por día civil en UTC. Se aplica en tres capas:
 *   1) consulta SQL (excluye compradores que ya recibieron envío hoy según ml_rating_request_sent),
 *   2) wasRatingRequestSentToBuyerToday + Set en memoria en esta corrida,
 *   3) comprobación final justo antes del POST por si hubo otra ejecución en paralelo.
 * Si el mismo comprador tiene varias órdenes elegibles el mismo día, solo la primera en
 * procesarse recibe mensaje; el resto cuenta como skipped_mismo_comprador_hoy.
 *
 * Configuración:
 *   ML_RATING_REQUEST_ENABLED=1          — obligatorio para enviar
 *   ML_RATING_REQUEST_LOOKBACK_DAYS=6    — órdenes con date_created >= ahora − N días (por defecto 6)
 *   ML_RATING_REQUEST_ORDER_STATUS=      — opcional: filtra ml_orders.status (ej. confirmed). También --status=confirmed
 *   ML_RATING_REQUEST_DELAY_MS=400       — pausa entre envíos
 *   ML_RATING_REQUEST_BODY="..."         — texto (máx. 350 chars API ML). Placeholders: {{order_id}} {{buyer_id}} {{seller_id}} {{ml_user_id}}
 *   ML_RATING_REQUEST_OPTION_ID=OTHER    — igual que post-venta (OTHER o SEND_INVOICE_LINK)
 *
 * Mensajes predeterminados: 10 plantillas distintas (RATING_REQUEST_BODIES); en cada envío se elige una al azar
 * para variar el texto (sin repetir consecutivamente en la misma corrida). Si definís ML_RATING_REQUEST_BODY,
 * se usa solo ese texto y no el pool.
 * Para listar plantillas y un ejemplo aleatorio: node ml-rating-request-daily.js --print-message
 *
 * Uso manual (ejemplo: todas las cuentas, 6 días atrás, solo órdenes confirmed):
 *   ML_RATING_REQUEST_ENABLED=1 ML_RATING_REQUEST_LOOKBACK_DAYS=6 ML_RATING_REQUEST_ORDER_STATUS=confirmed node ml-rating-request-daily.js --all
 *
 * Uso manual:
 *   node ml-rating-request-daily.js
 *   node ml-rating-request-daily.js --user=ML_USER_ID
 *   node ml-rating-request-daily.js --all
 *   node ml-rating-request-daily.js --all --status=confirmed
 *
 * Automático 10:00 UTC: ver .github/workflows/rating-request-daily.yml y RECORDATORIO-CALIFICACION.md
 * Cron (ejemplo servidor propio, 10:00 UTC):
 *   0 10 * * * cd /ruta && ML_RATING_REQUEST_ENABLED=1 node ml-rating-request-daily.js --all
 */
require("./load-env-local");

const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { applyPostSalePlaceholders, MAX_OTHER } = require("./ml-post-sale-send");
const {
  listMlAccounts,
  listMlOrdersEligibleForRatingRequest,
  insertMlRatingRequestSent,
  wasRatingRequestSentToBuyerToday,
  insertMlRatingRequestLog,
} = require("./db");

/**
 * Diez mensajes equivalentes (pedir calificación tras la compra), redacción distinta.
 * | # | Enfoque |
 * |---|---------|
 * | 1 | Agradecimiento directo + calificación si ya recibió |
 * | 2 | Elegirnos + calificación cuando pueda |
 * | 3 | Opinión + invitación si el producto llegó |
 * | 4 | Todo llegó bien + reseña en la orden |
 * | 5 | Esperamos que guste + calificar desde la orden |
 * | 6 | Confianza + mejorar con calificación |
 * | 7 | Saludo + invitación al recibir |
 * | 8 | Envío en manos + valoración |
 * | 9 | Compra + calificación visible para otros |
 * | 10 | Gracias por elegirnos + calificar cuando quiera |
 */
const RATING_REQUEST_BODIES = Object.freeze([
  "Gracias por tu compra. Si ya recibiste el producto, te agradeceríamos dejar tu calificación en la compra.",
  "Hola, gracias por elegirnos. Cuando puedas, dejanos tu calificación en la compra; nos ayuda muchísimo.",
  "Tu opinión nos importa. Si el producto ya llegó, te invitamos a calificar la compra cuando tengas un momento.",
  "Gracias por la compra. Si todo llegó bien, te agradeceríamos dejar tu reseña en la orden.",
  "Esperamos que el producto te haya gustado. Si ya lo recibiste, podés calificar la compra desde la orden.",
  "Muchas gracias por confiar en nosotros. Si ya tenés el producto, calificar la compra nos ayuda a seguir mejorando.",
  "Un saludo y gracias por tu pedido. Cuando recibas el producto, te invitamos a dejar tu calificación en Mercado Libre.",
  "Gracias por tu compra. Si el envío ya está en tus manos, te agradecemos dejar tu valoración en la compra.",
  "Apreciamos tu compra. Si el producto ya llegó, dejanos tu calificación en la orden para que otros compradores también lo vean.",
  "Te damos las gracias por elegirnos. Si ya recibiste el pedido, podés calificar la compra cuando quieras.",
]);

/** Primera plantilla del pool (compatibilidad con código que esperaba un solo DEFAULT_BODY). */
const DEFAULT_BODY = RATING_REQUEST_BODIES[0];

/**
 * Elige una plantilla al azar; en la misma corrida evita repetir la misma que la anterior (si hay más de una).
 * @param {number|null|undefined} lastIndex
 * @returns {{ template: string, index: number }}
 */
function pickRandomRatingBodyTemplate(lastIndex) {
  const n = RATING_REQUEST_BODIES.length;
  if (n === 0) return { template: "", index: -1 };
  if (n === 1) return { template: RATING_REQUEST_BODIES[0], index: 0 };
  let idx = Math.floor(Math.random() * n);
  if (lastIndex != null && lastIndex >= 0 && lastIndex < n) {
    let guard = 0;
    while (idx === lastIndex && guard++ < 64) {
      idx = Math.floor(Math.random() * n);
    }
  }
  return { template: RATING_REQUEST_BODIES[idx], index: idx };
}

function mlRatingApiErrorLine(data) {
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
  const n = Number(process.env.ML_RATING_REQUEST_LOOKBACK_DAYS || 6);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(90, Math.floor(n));
}

function sinceIso() {
  return new Date(Date.now() - lookbackDays() * 86400000).toISOString();
}

/** Inicio [incl.] y fin [excl.) del día civil en UTC (para deduplicar por comprador). */
function utcDayBoundsUtc() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  return { dayStartIso: start.toISOString(), dayEndIso: end.toISOString() };
}

function defaultDelayMs() {
  const n = Number(process.env.ML_RATING_REQUEST_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 400;
}

/**
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {number} buyerId
 * @param {string} text
 */
async function sendRatingRequestMessage(mlUserId, orderId, buyerId, text) {
  const appId = String(
    process.env.ML_APPLICATION_ID || process.env.OAUTH_CLIENT_ID || "1837222235616049"
  ).trim();
  const q = new URLSearchParams({
    application_id: appId,
    tag: "post_sale",
  });
  const path = `/messages/packs/${orderId}/sellers/${mlUserId}?${q.toString()}`;
  const optionId = (
    process.env.ML_RATING_REQUEST_OPTION_ID ||
    process.env.ML_POST_SALE_OPTION_ID ||
    "OTHER"
  ).trim();
  if (optionId !== "OTHER" && optionId !== "SEND_INVOICE_LINK") {
    return {
      ok: false,
      status: 0,
      path,
      data: { message: "ML_RATING_REQUEST_OPTION_ID debe ser OTHER o SEND_INVOICE_LINK" },
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
 * @param {{ orderStatus?: string|null }} [options]
 * @returns {Promise<{ ok: boolean, eligible: number, sent: number, failed: number, skipped_buyer_day?: number, error?: string, order_status_filter?: string|null }>}
 */
async function runRatingRequestDailyForUser(mlUserId, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    return { ok: false, eligible: 0, sent: 0, failed: 0, error: "ml_user_id inválido" };
  }

  if (process.env.ML_RATING_REQUEST_ENABLED !== "1") {
    return {
      ok: false,
      eligible: 0,
      sent: 0,
      failed: 0,
      error: "ML_RATING_REQUEST_ENABLED!=1",
    };
  }

  const orderStatusRaw =
    options.orderStatus != null && String(options.orderStatus).trim() !== ""
      ? String(options.orderStatus).trim()
      : null;

  const { dayStartIso, dayEndIso } = utcDayBoundsUtc();
  const rows = await listMlOrdersEligibleForRatingRequest(
    mlUid,
    sinceIso(),
    dayStartIso,
    dayEndIso,
    orderStatusRaw
  );
  const delayMs = defaultDelayMs();
  const useCustomBody =
    process.env.ML_RATING_REQUEST_BODY != null &&
    String(process.env.ML_RATING_REQUEST_BODY).trim() !== "";

  let sent = 0;
  let failed = 0;
  let skippedBuyerDay = 0;
  /** Evita dos envíos al mismo comprador en una misma ejecución (varias órdenes elegibles). */
  const buyersMessagedThisRun = new Set();
  /** Último índice del pool usado en esta corrida (evita dos mensajes idénticos seguidos). */
  let lastPoolIndex = null;

  for (const o of rows) {
    const orderId = o.order_id != null ? Number(o.order_id) : NaN;
    const buyerId = o.buyer_id != null ? Number(o.buyer_id) : NaN;
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(buyerId) || buyerId <= 0) {
      failed++;
      continue;
    }

    if (buyersMessagedThisRun.has(buyerId)) {
      skippedBuyerDay++;
      continue;
    }

    if (await wasRatingRequestSentToBuyerToday(mlUid, buyerId, dayStartIso, dayEndIso)) {
      skippedBuyerDay++;
      continue;
    }

    let bodyTemplate;
    if (useCustomBody) {
      bodyTemplate = process.env.ML_RATING_REQUEST_BODY;
    } else {
      const picked = pickRandomRatingBodyTemplate(lastPoolIndex);
      bodyTemplate = picked.template;
      lastPoolIndex = picked.index;
    }

    let text = applyPostSalePlaceholders(bodyTemplate, {
      orderId,
      buyerId,
      sellerId: mlUid,
    });
    text = String(text).trim();
    if (text.length > MAX_OTHER) {
      console.warn(
        "[rating-request] order_id=%s texto truncado de %s a %s chars",
        orderId,
        text.length,
        MAX_OTHER
      );
      text = text.slice(0, MAX_OTHER);
    }

    // Límite 1 comprador/día (UTC): re-chequeo por si otra instancia del job envió entre medias.
    if (await wasRatingRequestSentToBuyerToday(mlUid, buyerId, dayStartIso, dayEndIso)) {
      skippedBuyerDay++;
      continue;
    }

    const res = await sendRatingRequestMessage(mlUid, orderId, buyerId, text);
    const now = new Date().toISOString();

    if (res.ok) {
      await insertMlRatingRequestLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        outcome: "success",
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
      });
      await insertMlRatingRequestSent({
        order_id: orderId,
        ml_user_id: mlUid,
        buyer_id: buyerId,
        sent_at: now,
        http_status: res.status,
      });
      buyersMessagedThisRun.add(buyerId);
      sent++;
      console.log("[rating-request] enviado order_id=%s ml_user_id=%s", orderId, mlUid);
    } else {
      await insertMlRatingRequestLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        outcome: "api_error",
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
        error_message: mlRatingApiErrorLine(res.data) || `HTTP ${res.status}`,
      });
      failed++;
      const preview = (res.rawText || "").slice(0, 300);
      console.warn(
        "[rating-request] fallo order_id=%s HTTP %s %s",
        orderId,
        res.status,
        preview
      );
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    ok: true,
    eligible: rows.length,
    sent,
    failed,
    skipped_buyer_day: skippedBuyerDay,
    order_status_filter: orderStatusRaw,
  };
}

function parseArgs(argv) {
  let userId =
    process.env.ML_RATING_REQUEST_USER_ID != null
      ? Number(process.env.ML_RATING_REQUEST_USER_ID)
      : null;
  let all =
    process.env.ML_RATING_REQUEST_ALL === "1" ||
    process.env.ML_RATING_REQUEST_ALL === "true";
  let orderStatus =
    process.env.ML_RATING_REQUEST_ORDER_STATUS != null
      ? String(process.env.ML_RATING_REQUEST_ORDER_STATUS).trim()
      : null;
  if (orderStatus === "") orderStatus = null;
  let printMessage = false;
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
    } else if (lower === "--print-message" || lower === "--show-config") {
      printMessage = true;
    }
  }
  return { userId, all, orderStatus, printMessage };
}

function printRatingRequestConfig() {
  const useCustom =
    process.env.ML_RATING_REQUEST_BODY != null &&
    String(process.env.ML_RATING_REQUEST_BODY).trim() !== "";
  console.log("[rating-request] Pool de %s plantillas (elección aleatoria por envío si no usás ML_RATING_REQUEST_BODY):", RATING_REQUEST_BODIES.length);
  RATING_REQUEST_BODIES.forEach((t, i) => console.log("  %s. %s", i + 1, t));
  if (useCustom) {
    console.log("[rating-request] ML_RATING_REQUEST_BODY (anula el pool):");
    console.log(process.env.ML_RATING_REQUEST_BODY);
  } else {
    const ex = pickRandomRatingBodyTemplate(null);
    console.log("[rating-request] Ejemplo aleatorio (cada envío puede ser cualquiera del 1–%s):", RATING_REQUEST_BODIES.length);
    console.log(ex.template);
  }
  console.log(
    "[rating-request] ML_RATING_REQUEST_BODY definido en env: %s",
    useCustom ? "sí" : "no"
  );
  console.log("[rating-request] lookback_days=%s since_iso>=%s", lookbackDays(), sinceIso());
}

async function main() {
  const { userId, all, orderStatus, printMessage } = parseArgs(process.argv.slice(2));

  if (printMessage) {
    printRatingRequestConfig();
    process.exit(0);
  }

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[rating-request] DATABASE_URL no definida.");
    process.exit(1);
  }

  const accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[rating-request] No hay cuentas en ml_accounts.");
    process.exit(1);
  }

  let targets = [];
  if (all) {
    targets = accounts.map((a) => Number(a.ml_user_id));
  } else if (userId != null && Number.isFinite(userId) && userId > 0) {
    targets = [userId];
  } else {
    targets = [Number(accounts[0].ml_user_id)];
    console.log("[rating-request] Sin --user ni --all: usando primera cuenta %s", targets[0]);
  }

  const bounds = utcDayBoundsUtc();
  console.log(
    "[rating-request] lookback_days=%s since>=%s día_UTC=[%s .. %s) enabled=%s order_status=%s",
    lookbackDays(),
    sinceIso(),
    bounds.dayStartIso,
    bounds.dayEndIso,
    process.env.ML_RATING_REQUEST_ENABLED === "1" ? "1" : "0",
    orderStatus != null ? orderStatus : "(ninguno)"
  );

  if (process.env.ML_RATING_REQUEST_ENABLED !== "1") {
    console.error("[rating-request] Define ML_RATING_REQUEST_ENABLED=1 para enviar mensajes.");
    process.exit(1);
  }

  const results = [];
  for (const uid of targets) {
    const r = await runRatingRequestDailyForUser(uid, { orderStatus });
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[rating-request] ml_user_id=%s eligible=%s sent=%s skipped_mismo_comprador_hoy=%s failed=%s err=%s",
      uid,
      r.eligible,
      r.sent,
      r.skipped_buyer_day ?? 0,
      r.failed,
      r.error || "—"
    );
  }

  const bad = results.filter((x) => !x.ok);
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[rating-request]", e);
    process.exit(1);
  });
}

module.exports = {
  runRatingRequestDailyForUser,
  sendRatingRequestMessage,
  lookbackDays,
  sinceIso,
  utcDayBoundsUtc,
  DEFAULT_BODY,
  RATING_REQUEST_BODIES,
  pickRandomRatingBodyTemplate,
};
