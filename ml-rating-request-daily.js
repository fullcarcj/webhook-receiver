/**
 * Job diario (cron): envía un mensaje post-venta pidiendo calificación al comprador
 * solo si vos ya calificaste (lado sale) y el comprador aún no (purchase pendiente),
 * y la orden está en la ventana de días configurada.
 * No envía más de un recordatorio por comprador por día (UTC): si hay varias órdenes del mismo
 * comprador, solo la primera del día recibe mensaje.
 *
 * Configuración:
 *   ML_RATING_REQUEST_ENABLED=1          — obligatorio para enviar
 *   ML_RATING_REQUEST_LOOKBACK_DAYS=3    — órdenes con date_created >= ahora − N días (luego podés usar 6)
 *   ML_RATING_REQUEST_DELAY_MS=400       — pausa entre envíos
 *   ML_RATING_REQUEST_BODY="..."         — texto (máx. 350 chars API ML). Placeholders: {{order_id}} {{buyer_id}} {{seller_id}} {{ml_user_id}}
 *   ML_RATING_REQUEST_OPTION_ID=OTHER    — igual que post-venta (OTHER o SEND_INVOICE_LINK)
 *
 * Uso manual:
 *   node ml-rating-request-daily.js
 *   node ml-rating-request-daily.js --user=ML_USER_ID
 *   node ml-rating-request-daily.js --all
 *
 * Cron (ejemplo 10:00 todos los días):
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
} = require("./db");

const DEFAULT_BODY =
  "Gracias por tu compra. Si ya recibiste el producto, te agradeceríamos dejar tu calificación en la compra.";

function sleep(ms) {
  return new Promise((r) => setTimeout(r));
}

function lookbackDays() {
  const n = Number(process.env.ML_RATING_REQUEST_LOOKBACK_DAYS || 3);
  if (!Number.isFinite(n) || n <= 0) return 3;
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
 * @returns {Promise<{ ok: boolean, eligible: number, sent: number, failed: number, skipped_buyer_day?: number, error?: string }>}
 */
async function runRatingRequestDailyForUser(mlUserId) {
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

  const { dayStartIso, dayEndIso } = utcDayBoundsUtc();
  const rows = await listMlOrdersEligibleForRatingRequest(
    mlUid,
    sinceIso(),
    dayStartIso,
    dayEndIso
  );
  const delayMs = defaultDelayMs();
  const bodyTemplate = process.env.ML_RATING_REQUEST_BODY || DEFAULT_BODY;

  let sent = 0;
  let failed = 0;
  let skippedBuyerDay = 0;
  /** Evita dos envíos al mismo comprador en una misma ejecución (varias órdenes elegibles). */
  const buyersMessagedThisRun = new Set();

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

    const res = await sendRatingRequestMessage(mlUid, orderId, buyerId, text);
    const now = new Date().toISOString();

    if (res.ok) {
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

  return { ok: true, eligible: rows.length, sent, failed, skipped_buyer_day: skippedBuyerDay };
}

function parseArgs(argv) {
  let userId =
    process.env.ML_RATING_REQUEST_USER_ID != null
      ? Number(process.env.ML_RATING_REQUEST_USER_ID)
      : null;
  let all =
    process.env.ML_RATING_REQUEST_ALL === "1" ||
    process.env.ML_RATING_REQUEST_ALL === "true";
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (const a of cleaned) {
    const lower = a.toLowerCase();
    if (lower === "--all" || lower === "-a") all = true;
    else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    }
  }
  return { userId, all };
}

async function main() {
  const { userId, all } = parseArgs(process.argv.slice(2));

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
    "[rating-request] lookback_days=%s since>=%s día_UTC=[%s .. %s) enabled=%s",
    lookbackDays(),
    sinceIso(),
    bounds.dayStartIso,
    bounds.dayEndIso,
    process.env.ML_RATING_REQUEST_ENABLED === "1" ? "1" : "0"
  );

  if (process.env.ML_RATING_REQUEST_ENABLED !== "1") {
    console.error("[rating-request] Define ML_RATING_REQUEST_ENABLED=1 para enviar mensajes.");
    process.exit(1);
  }

  const results = [];
  for (const uid of targets) {
    const r = await runRatingRequestDailyForUser(uid);
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
};
