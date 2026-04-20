/**
 * MENSAJE TIPO B (`MESSAGE_TYPE_B` en ml-message-types.js): recordatorio para ir a la tienda / despacho.
 *
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
 * Horarios en GitHub Actions: cron en UTC en .github/workflows/retiro-broadcast-*.yml (mañana ≈ 7:30 Caracas, tarde ≈ 14:20).
 * Hora local esperada (referencia; igual que documentás el cron del recordatorio C en rating-request-daily.yml):
 *   ML_RETIRO_MORNING_SEND_AT=07:30
 *   ML_RETIRO_AFTERNOON_SEND_AT=14:20
 * Si cambiás la hora, recalculá el cron UTC y actualizá esas variables. Opcional: ML_RETIRO_ENFORCE_SEND_AT=1 para no enviar
 * si el reloj local (ML_RETIRO_TIMEZONE) no está cerca de esa hora (útil si el job corre cada X minutos).
 *
 * Env:
 *   ML_RETIRO_ENABLED=1
 *   ML_RETIRO_SLOT=morning|afternoon   — obligatorio (o --slot=…)
 *   ML_RETIRO_LOOKBACK_DAYS=14          — órdenes con date_created en ventana
 *   ML_RETIRO_ORDER_STATUS=confirmed  — opcional (filtra ml_orders.status)
 *   ML_RETIRO_TIMEZONE=America/Caracas — día civil para deduplicar
 *   ML_RETIRO_MORNING_SEND_AT / ML_RETIRO_AFTERNOON_SEND_AT — HH:MM hora local de referencia (documentación; ver ENFORCE)
 *   ML_RETIRO_ENFORCE_SEND_AT=0|1      — si 1, sale sin enviar si la hora local no cae en la ventana (±ML_RETIRO_SEND_AT_WINDOW_MINUTES)
 *   ML_RETIRO_SEND_AT_WINDOW_MINUTES=8 — ventana alrededor de la hora esperada del slot
 *   ML_RETIRO_DELAY_MS=400
 *   ML_RETIRO_OPTION_ID=OTHER         — tipo B (OTHER o SEND_INVOICE_LINK; independiente de ML_POST_SALE_OPTION_ID)
 *   ML_RETIRO_SKIP_SUNDAYS=1          — por defecto (o ausente): no envía domingo según ML_RETIRO_TIMEZONE. Pon 0 para permitir domingo (p. ej. pruebas).
 *   ML_RETIRO_SUNDAY_DEFER_TO_MONDAY=1 — si 1 (default): en domingo encola elegibles en BD para enviar el lunes en slot mañana. Pon 0 para no encolar (solo no enviar domingo).
 *
 * Uso:
 *   ML_RETIRO_ENABLED=1 ML_RETIRO_SLOT=morning node ml-retiro-broadcast.js --all
 *   node ml-retiro-broadcast.js --slot=afternoon --user=ML_USER_ID
 *   node ml-retiro-broadcast.js --print-templates
 */
require("./load-env-local");

const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const { applyPostSalePlaceholders, MAX_OTHER } = require("./ml-post-sale-send");
const { getAutoMessageBudgetForBuyerToday } = require("./ml-auto-message-cap");
const {
  listMlAccounts,
  listMlOrdersEligibleForRetiroBroadcast,
  insertMlRetiroBroadcastSent,
  insertMlRetiroBroadcastLog,
  insertMlMessageKindSendLog,
  wasRetiroBroadcastSentToBuyerTodaySlot,
  getCaracasNextCalendarDateYmd,
  getCaracasTodayYmd,
  insertMlRetiroSundayDeferred,
  listMlRetiroSundayDeferredPending,
  markMlRetiroSundayDeferredProcessed,
} = require("./db");

/** Mañana: ya puede retirar el producto ofertado. */
const RETIRO_MORNING_BODIES = Object.freeze([
  "¡Hola! Tu compra ya está lista: puedes pasar a retirar el producto ofertado cuando te quede cómodo. ¡Gracias por elegirnos!",
  "Buen día: ya puedes retirar tu producto. Te esperamos; avísanos si vienes para tenerlo listo.",
  "Hola, buenos días. Tu pedido está disponible para retiro. Pasa cuando puedas por el punto acordado.",
  "Buen día. El producto de tu compra ya está para retirar. Cualquier duda, escríbenos por aquí.",
  "¡Hola! Ya puedes pasar a buscar tu producto ofertado. Gracias por la compra.",
  "Buenos días: tu orden está lista para retiro. Te esperamos en el horario habitual.",
  "Hola. Ya está listo tu producto para retiro. Avísanos cuando vengas y te lo entregamos.",
  "Buen día, gracias por tu compra. Puedes retirar el producto ofertado; coordinamos si lo necesitas.",
  "¡Hola! Tu compra está disponible para retiro. Pasa cuando te quede bien.",
  "Buenos días: recuerda que ya puedes retirar tu producto. ¡Gracias por confiar en nosotros!",
]);

/** Tarde: seguimos despachando; retiro hasta 17:00; delivery y pago a tasa BCV. */
const RETIRO_AFTERNOON_BODIES = Object.freeze([
  "Buenas tardes: seguimos despachando. Puedes retirar hasta las 5:00 p. m. Tenemos delivery y puedes pagar a tasa BCV.",
  "Hola, buenas tardes. Aún estamos despachando; puedes retirar hasta las 17:00. Delivery disponible y pago a tasa BCV.",
  "Buenas tardes. Seguimos en despacho: retiros hasta las 5 p. m. Recuerda que tenemos delivery y aceptamos pago a tasa BCV.",
  "Hola: por la tarde seguimos despachando. Retiro en local hasta las 17:00. Delivery y pago BCV disponibles.",
  "Buenas tardes. Te recordamos que despachamos hasta las 5 p. m.; también delivery. Pagos a tasa BCV.",
  "Buenas: aún despachando. Puedes pasar a retirar hasta las 17:00 o pedir delivery. Pago a tasa BCV.",
  "Hola, buenas tardes. Seguimos operando: retiro hasta las 5 p. m., delivery y opción de pago a tasa BCV.",
  "Buenas tardes. Seguimos con despachos; retiros hasta las 17:00. Consulta por delivery y tasa BCV.",
  "Hola. Por la tarde seguimos despachando hasta las 5 p. m. Delivery disponible; puedes pagar a tasa BCV.",
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

function parseHHMM(s) {
  const t = String(s || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function getLocalMinutesFromMidnight(tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hp = parts.find((p) => p.type === "hour");
  const mp = parts.find((p) => p.type === "minute");
  if (!hp || !mp) return null;
  const h = parseInt(hp.value, 10);
  const m = parseInt(mp.value, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function circularDiffMinutes(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 1440 - d);
}

/**
 * Día civil local en `tz` (p. ej. America/Caracas) — domingo = true.
 * Usa `weekday: "short"` ("Sun") como comprobación principal: en algunos runtimes
 * `formatToParts` no incluye `weekday` y antes fallábamos abierto (se enviaba en domingo).
 * @param {string} tz IANA
 */
function isLocalSundayInTimezone(tz) {
  const zone = tz != null && String(tz).trim() !== "" ? String(tz).trim() : "America/Caracas";
  try {
    const short = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" })
      .format(new Date())
      .trim();
    if (short === "Sun") return true;

    const longStr = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" })
      .format(new Date())
      .trim();
    if (/^Sunday$/i.test(longStr)) return true;

    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" })
      .formatToParts(new Date())
      .find((p) => p.type === "weekday")?.value;
    return part === "Sunday";
  } catch (e) {
    console.warn("[retiro-broadcast] isLocalSundayInTimezone: tz inválido (%s): %s", zone, e.message);
    return false;
  }
}

/**
 * Si ML_RETIRO_SKIP_SUNDAYS no es "0", no se envía retiro en domingo (hora local del timezone ML).
 */
function shouldSkipRetiroDueToSunday(tz) {
  if (process.env.ML_RETIRO_SKIP_SUNDAYS === "0") return false;
  return isLocalSundayInTimezone(tz);
}

/** Si distinto de "0", los elegibles del domingo se guardan para el lunes (slot mañana). Default: activo. */
function sundayDeferToMondayEnabled() {
  return process.env.ML_RETIRO_SUNDAY_DEFER_TO_MONDAY !== "0";
}

/**
 * Domingo sin envío: misma elegibilidad que el flujo normal; inserta filas para target_date = lunes.
 * @returns {Promise<{ eligible: number, inserted: number, target_date: string|null }>}
 */
async function enqueueSundayDeferralsForUser(mlUserId, slot, orderStatusRaw) {
  const mlUid = Number(mlUserId);
  const tz = defaultTimezone();
  const targetDate = await getCaracasNextCalendarDateYmd(tz);
  if (!targetDate) {
    console.warn("[retiro-broadcast] defer domingo: no se pudo calcular fecha objetivo (tz=%s).", tz);
    return { eligible: 0, inserted: 0, target_date: null };
  }
  const rows = await listMlOrdersEligibleForRetiroBroadcast(
    mlUid,
    sinceIso(),
    orderStatusRaw,
    slot,
    tz
  );
  const buyersSeen = new Set();
  let inserted = 0;
  for (const o of rows) {
    const orderId = o.order_id != null ? Number(o.order_id) : NaN;
    const buyerId = o.buyer_id != null ? Number(o.buyer_id) : NaN;
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(buyerId) || buyerId <= 0) {
      continue;
    }
    if (buyersSeen.has(buyerId)) continue;
    if (await wasRetiroBroadcastSentToBuyerTodaySlot(mlUid, buyerId, slot, tz)) continue;
    if ((await getAutoMessageBudgetForBuyerToday(mlUid, buyerId)) <= 0) continue;
    const newId = await insertMlRetiroSundayDeferred({
      ml_user_id: mlUid,
      buyer_id: buyerId,
      order_id: orderId,
      original_slot: slot,
      target_date: targetDate,
    });
    if (newId != null) {
      inserted++;
      buyersSeen.add(buyerId);
      console.log(
        "[retiro-broadcast] domingo → cola lunes %s order_id=%s buyer_id=%s (slot orig.=%s)",
        targetDate,
        orderId,
        buyerId,
        slot
      );
    }
  }
  return { eligible: rows.length, inserted, target_date: targetDate };
}

/**
 * Lunes (u otro día) slot mañana: envía pendientes con fecha objetivo = hoy (cola domingo).
 * @returns {Promise<number>} cantidad enviados con éxito
 */
async function processSundayDeferredSendsForUser(mlUserId, tz) {
  const mlUid = Number(mlUserId);
  const todayYmd = await getCaracasTodayYmd(tz);
  if (!todayYmd) return 0;
  const pending = await listMlRetiroSundayDeferredPending(mlUid, todayYmd, tz);
  if (!pending.length) return 0;
  const bodies = poolForSlot("morning");
  if (bodies.length === 0) return 0;
  const delayMs = defaultDelayMs();
  let sent = 0;
  const buyersMessaged = new Set();
  let lastPoolIndex = null;

  for (const row of pending) {
    const rowId = row.id != null ? Number(row.id) : NaN;
    const orderId = row.order_id != null ? Number(row.order_id) : NaN;
    const buyerId = row.buyer_id != null ? Number(row.buyer_id) : NaN;
    if (!Number.isFinite(rowId) || rowId <= 0) continue;
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(buyerId) || buyerId <= 0) {
      await markMlRetiroSundayDeferredProcessed([rowId]);
      continue;
    }

    if (buyersMessaged.has(buyerId)) {
      await markMlRetiroSundayDeferredProcessed([rowId]);
      continue;
    }

    if (await wasRetiroBroadcastSentToBuyerTodaySlot(mlUid, buyerId, "morning", tz)) {
      await markMlRetiroSundayDeferredProcessed([rowId]);
      continue;
    }

    if ((await getAutoMessageBudgetForBuyerToday(mlUid, buyerId)) <= 0) {
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
      text = text.slice(0, MAX_OTHER);
    }

    const res = await sendRetiroBroadcastMessage(mlUid, orderId, buyerId, text);
    const now = new Date().toISOString();

    if (res.ok) {
      await insertMlRetiroBroadcastLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        slot: "morning",
        outcome: "success",
        template_index: picked.index,
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
      });
      await insertMlMessageKindSendLog({
        message_kind: "B",
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        outcome: "success",
        http_status: res.status,
        detail: "slot=morning deferred_from_sunday",
        created_at: now,
      });
      await insertMlRetiroBroadcastSent({
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        slot: "morning",
        sent_at: now,
        http_status: res.status,
        template_index: picked.index,
      });
      await markMlRetiroSundayDeferredProcessed([rowId]);
      buyersMessaged.add(buyerId);
      sent++;
      console.log(
        "[retiro-broadcast] tipo=B (cola domingo→lunes) enviado order_id=%s ml_user_id=%s",
        orderId,
        mlUid
      );
    } else {
      await insertMlRetiroBroadcastLog({
        created_at: now,
        ml_user_id: mlUid,
        order_id: orderId,
        buyer_id: buyerId,
        slot: "morning",
        outcome: "api_error",
        template_index: picked.index,
        http_status: res.status,
        request_path: res.path != null ? String(res.path) : null,
        response_body: responseBodyForLog(res),
        error_message: mlRetiroApiErrorLine(res.data) || `HTTP ${res.status}`,
      });
      await insertMlMessageKindSendLog({
        message_kind: "B",
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        outcome: "api_error",
        skip_reason: mlRetiroApiErrorLine(res.data) || `HTTP ${res.status}`,
        http_status: res.status,
        detail: "slot=morning deferred_from_sunday",
        created_at: now,
      });
      console.warn(
        "[retiro-broadcast] tipo=B cola domingo fallo order_id=%s HTTP %s",
        orderId,
        res.status
      );
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return sent;
}

/**
 * Si ML_RETIRO_ENFORCE_SEND_AT=1 y hay HH:MM para el slot, devuelve true cuando NO debe enviarse (salir 0).
 * @param {'morning'|'afternoon'} slot
 * @param {string} tz
 */
function shouldSkipDueToSendAtEnforcement(slot, tz) {
  if (process.env.ML_RETIRO_ENFORCE_SEND_AT !== "1") return false;
  const raw =
    slot === "morning"
      ? process.env.ML_RETIRO_MORNING_SEND_AT
      : slot === "afternoon"
        ? process.env.ML_RETIRO_AFTERNOON_SEND_AT
        : null;
  if (raw == null || String(raw).trim() === "") return false;
  const target = parseHHMM(raw);
  if (target == null) {
    console.warn("[retiro-broadcast] ML_RETIRO_*_SEND_AT inválido, se ignora ENFORCE:", raw);
    return false;
  }
  const winRaw = Number(process.env.ML_RETIRO_SEND_AT_WINDOW_MINUTES);
  const windowMin = Number.isFinite(winRaw) && winRaw >= 1 && winRaw <= 180 ? winRaw : 8;
  const now = getLocalMinutesFromMidnight(tz);
  if (now == null) {
    console.warn("[retiro-broadcast] No se pudo leer hora local para tz=", tz);
    return false;
  }
  const diff = circularDiffMinutes(now, target);
  if (diff > windowMin) {
    console.log(
      "[retiro-broadcast] ENFORCE_SEND_AT: omitido (slot=%s). Hora local en %s no está cerca de %s (±%s min; ahora≈%s min desde medianoche, objetivo=%s).",
      slot,
      tz,
      String(raw).trim(),
      windowMin,
      now,
      target
    );
    return true;
  }
  return false;
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
  /** Solo `ML_RETIRO_*` (no se reutiliza `ML_POST_SALE_OPTION_ID` del tipo A). */
  const optionId = (process.env.ML_RETIRO_OPTION_ID || "OTHER").trim();
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

  const orderStatusRaw =
    options.orderStatus != null && String(options.orderStatus).trim() !== ""
      ? String(options.orderStatus).trim()
      : null;

  const tz = defaultTimezone();

  if (shouldSkipRetiroDueToSunday(tz)) {
    if (sundayDeferToMondayEnabled()) {
      const enq = await enqueueSundayDeferralsForUser(mlUid, slot, orderStatusRaw);
      console.log(
        "[retiro-broadcast] Domingo %s: encolados %s / elegibles %s → target_date=%s",
        tz,
        enq.inserted,
        enq.eligible,
        enq.target_date || "?"
      );
      return {
        ok: true,
        eligible: enq.eligible,
        sent: 0,
        failed: 0,
        skipped_sunday: true,
        deferred_inserted: enq.inserted,
        deferred_target_date: enq.target_date,
        skipped_buyer: 0,
        skipped_auto_cap_day: 0,
        order_status_filter: orderStatusRaw,
        slot,
        error: null,
      };
    }
    console.log(
      "[retiro-broadcast] Domingo (%s): sin envíos tipo B (ML_RETIRO_SKIP_SUNDAYS distinto de 0).",
      tz
    );
    return {
      ok: true,
      eligible: 0,
      sent: 0,
      failed: 0,
      skipped_sunday: true,
      error: null,
      order_status_filter: orderStatusRaw,
      slot,
    };
  }

  let deferredSent = 0;
  if (slot === "morning" && sundayDeferToMondayEnabled()) {
    deferredSent = await processSundayDeferredSendsForUser(mlUid, tz);
  }

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
        "[retiro-broadcast] tipo=B order_id=%s texto truncado de %s a %s chars",
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
      await insertMlMessageKindSendLog({
        message_kind: "B",
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        outcome: "success",
        http_status: res.status,
        detail: `slot=${slot}`,
        created_at: now,
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
      console.log(
        "[retiro-broadcast] tipo=B enviado slot=%s order_id=%s ml_user_id=%s",
        slot,
        orderId,
        mlUid
      );
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
      await insertMlMessageKindSendLog({
        message_kind: "B",
        ml_user_id: mlUid,
        buyer_id: buyerId,
        order_id: orderId,
        outcome: "api_error",
        skip_reason: mlRetiroApiErrorLine(res.data) || `HTTP ${res.status}`,
        http_status: res.status,
        detail: `slot=${slot}`,
        created_at: now,
      });
      failed++;
      console.warn(
        "[retiro-broadcast] tipo=B fallo slot=%s order_id=%s HTTP %s",
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
    sent: sent + deferredSent,
    deferred_from_sunday_sent: deferredSent,
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
    "[retiro-broadcast] tipo=B slot=%s tz=%s lookback_days=%s since>=%s enabled=%s order_status=%s",
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

  const tzLog = defaultTimezone();
  const weekdayShort = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tzLog, weekday: "short" }).format(new Date()).trim();
    } catch {
      return "?";
    }
  })();
  const skipSundayEnv = process.env.ML_RETIRO_SKIP_SUNDAYS;
  console.log(
    "[retiro-broadcast] Calendario local: tz=%s weekday=%s ML_RETIRO_SKIP_SUNDAYS=%s",
    tzLog,
    weekdayShort,
    skipSundayEnv === undefined || skipSundayEnv === "" ? "(omitir domingo si weekday=Sun)" : JSON.stringify(skipSundayEnv)
  );
  if (shouldSkipRetiroDueToSunday(tzLog)) {
    console.log(
      "[retiro-broadcast] Domingo en %s: sin envío directo (ML_RETIRO_SKIP_SUNDAYS≠0).%s",
      tzLog,
      sundayDeferToMondayEnabled()
        ? " Elegibles se pueden encolar para el lunes (slot mañana)."
        : " Sin cola diferida (ML_RETIRO_SUNDAY_DEFER_TO_MONDAY=0)."
    );
  }

  const sendAtRef =
    slot === "morning" ? process.env.ML_RETIRO_MORNING_SEND_AT : process.env.ML_RETIRO_AFTERNOON_SEND_AT;
  if (sendAtRef != null && String(sendAtRef).trim() !== "") {
    console.log(
      "[retiro-broadcast] Hora local de referencia (%s): ML_RETIRO_%s_SEND_AT=%s (ENFORCE=%s)",
      tzLog,
      slot === "morning" ? "MORNING" : "AFTERNOON",
      String(sendAtRef).trim(),
      process.env.ML_RETIRO_ENFORCE_SEND_AT === "1" ? "1" : "0"
    );
  }

  if (!shouldSkipRetiroDueToSunday(tzLog) && shouldSkipDueToSendAtEnforcement(slot, tzLog)) {
    process.exit(0);
  }

  const results = [];
  for (const uid of targets) {
    const r = await runRetiroBroadcastForUser(uid, { orderStatus, slot });
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[retiro-broadcast] tipo=B ml_user_id=%s eligible=%s sent=%s deferred_dom→lun=%s skipped_mismo_comprador=%s skipped_auto_cap_dia=%s failed=%s err=%s",
      uid,
      r.eligible,
      r.sent,
      r.deferred_from_sunday_sent ?? r.deferred_inserted ?? 0,
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
  enqueueSundayDeferralsForUser,
  processSundayDeferredSendsForUser,
  sundayDeferToMondayEnabled,
  RETIRO_MORNING_BODIES,
  RETIRO_AFTERNOON_BODIES,
  lookbackDays,
  parseHHMM,
  shouldSkipDueToSendAtEnforcement,
  shouldSkipRetiroDueToSunday,
  isLocalSundayInTimezone,
  sinceIso,
  pickRandomTemplate,
};
