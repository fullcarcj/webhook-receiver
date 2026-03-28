/**
 * Respuestas automáticas a preguntas ML (POST /answers) con plantillas tipo tienda.
 *
 * Modo A — ventana diaria recurrente (recomendado):
 *   ML_QUESTIONS_IA_AUTO_ENABLED=1
 *   ML_QUESTIONS_IA_AUTO_TIMEZONE=America/Caracas
 *   ML_QUESTIONS_IA_AUTO_WINDOW_START=00:00
 *   ML_QUESTIONS_IA_AUTO_WINDOW_END=07:00
 *   ML_QUESTIONS_IA_AUTO_DAYS=0,1,2,3,4,5,6   — 0=domingo … 6=sábado (vacío = todos los días)
 *
 * Modo B — corte único en el tiempo (retrocompatibilidad):
 *   ML_QUESTIONS_IA_AUTO_UNTIL=2026-03-28T11:00:00.000Z
 *
 * Si WINDOW_START y WINDOW_END están definidos (no vacíos), tienen prioridad sobre ML_QUESTIONS_IA_AUTO_UNTIL.
 *
 * Ventana mismo día: [START, END) en hora local. Si START > END, cruza medianoche (ej. 22:00–07:00).
 *
 *   ML_QUESTIONS_IA_MAX_CHARS=2000
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const {
  computeResponseTimeSec,
  extractQuestionDateCreatedIso,
} = require("./ml-question-sync");
const {
  wasMlQuestionsIaAutoSent,
  insertMlQuestionsIaAutoSent,
  insertMlQuestionsIaAutoLog,
  deleteMlQuestionPending,
  upsertMlQuestionAnswered,
} = require("./db");

const QUESTION_IA_BODIES = Object.freeze([
  "Hola. Si el producto que buscás es el de la publicación, lo más probable es que esté disponible y el precio sea el publicado. Aceptamos tasa BCV. Somos tienda física; mañana abrimos de 9:00 a 16:00. Este mensaje fue generado por una IA; mañana habrá una persona para ayudarte.",
  "Buenas. Si la publicación coincide con lo que necesitás, en general el artículo está y el precio es el que ves publicado. Trabajamos a tasa BCV. Tienda física. Mañana atendemos de 9 a 16 h. Respuesta automática por IA; mañana te atiende un humano.",
  "Hola, gracias por escribir. Si buscás exactamente lo publicado, lo más probable es que haya stock y el monto sea el del aviso. Aceptamos tasa BCV. Somos tienda física; mañana de 9:00 a 16:00. Aviso: mensaje automático (IA); mañana podés hablar con alguien del equipo.",
  "Buen día. Si tu consulta es sobre la publicación que estás viendo, lo habitual es que el producto esté y el precio sea el publicado. Cobramos a tasa BCV. Tienda física; mañana abrimos 9–16 h. Generado por IA; mañana hay atención humana.",
  "Hola. Para la publicación que mirás: lo más probable es disponibilidad y precio según lo publicado. Aceptamos tasa BCV. Somos tienda física; mañana de 9 a 16. Este texto es automático (IA); mañana te ayuda una persona.",
  "Buenas tardes/noches. Si coincide con el aviso, el precio suele ser el publicado y el producto suele estar. Tasa BCV. Local físico; mañana 9:00–16:00. Mensaje de sistema (IA); mañana atención humana.",
  "Hola. Si es el ítem de la publicación, lo más probable es que esté y el valor sea el publicado. Trabajamos con tasa BCV. Tienda física; mañana abrimos de 9 a 16 h. Respuesta automática por IA; mañana podés consultar con el local.",
  "Gracias por tu pregunta. Si te referís a lo publicado, lo normal es que el precio sea el del aviso y que haya unidad. Aceptamos BCV. Somos tienda física; mañana 9:00 a 16:00. Generado por IA; mañana hay personal disponible.",
  "Hola. Publicación = precio publicado en lo posible y disponibilidad habitual. Cobro a tasa BCV. Tienda física; mañana de 9 a 16. Aviso: IA; mañana te responde un humano.",
  "Buenas. Si buscás el producto del aviso, lo más probable es que el precio sea el publicado y que podamos atenderte. Tasa BCV. Local físico; mañana 9–16 h. Mensaje automático (IA); mañana atención personal.",
]);

function getQuestionsIaMaxChars() {
  const n = Number(process.env.ML_QUESTIONS_IA_MAX_CHARS || 2000);
  if (!Number.isFinite(n) || n < 100) return 2000;
  return Math.min(4000, Math.floor(n));
}

function getQuestionsIaTimezone() {
  const a = process.env.ML_QUESTIONS_IA_AUTO_TIMEZONE;
  const b = process.env.ML_AUTO_MESSAGE_TIMEZONE;
  const c = process.env.ML_RETIRO_TIMEZONE;
  const t =
    a != null && String(a).trim() !== ""
      ? String(a).trim()
      : b != null && String(b).trim() !== ""
        ? String(b).trim()
        : c;
  return t != null && String(t).trim() !== "" ? String(t).trim() : "America/Caracas";
}

/** @returns {{ minutes: number, weekday: number|null }} weekday 0=domingo … 6=sábado */
function getLocalMinutesAndWeekdayInTz(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  let h = 0;
  let m = 0;
  let wdStr = "";
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
    if (p.type === "weekday") wdStr = p.value;
  }
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdStr && dayMap[wdStr] !== undefined ? dayMap[wdStr] : null;
  return { minutes: h * 60 + m, weekday };
}

/** @returns {{ h: number, m: number }|null} */
function parseHHMM(str) {
  if (str == null || String(str).trim() === "") return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;
  return { h: hh, m: mm };
}

function parseAllowedWeekdays() {
  const raw = process.env.ML_QUESTIONS_IA_AUTO_DAYS;
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  const set = new Set();
  for (const part of String(raw).split(",")) {
    const n = parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set.size > 0 ? set : null;
}

/**
 * ¿Dentro de [startMin, endMin) mismo día, o overnight si startMin > endMin?
 * Mismo día: start <= now < end
 * Cruzado: now >= start || now < end
 */
function isMinuteWithinWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * @returns {{ active: boolean, outcome: string, reason_detail: string|null }}
 */
function getQuestionsIaAutoWindowEvaluation() {
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    return { active: false, outcome: "skip_disabled", reason_detail: null };
  }

  const ws = process.env.ML_QUESTIONS_IA_AUTO_WINDOW_START;
  const we = process.env.ML_QUESTIONS_IA_AUTO_WINDOW_END;
  const hasStart = ws != null && String(ws).trim() !== "";
  const hasEnd = we != null && String(we).trim() !== "";

  if (hasStart && hasEnd) {
    const pStart = parseHHMM(ws);
    const pEnd = parseHHMM(we);
    if (!pStart || !pEnd) {
      return {
        active: false,
        outcome: "bad_window_parse",
        reason_detail: `WINDOW_START=${String(ws).slice(0, 16)} WINDOW_END=${String(we).slice(0, 16)}`,
      };
    }
    const startMin = pStart.h * 60 + pStart.m;
    const endMin = pEnd.h * 60 + pEnd.m;
    const tz = getQuestionsIaTimezone();
    const { minutes: nowMin, weekday } = getLocalMinutesAndWeekdayInTz(new Date(), tz);
    if (weekday == null) {
      return { active: false, outcome: "bad_weekday", reason_detail: `tz=${tz}` };
    }
    const allowed = parseAllowedWeekdays();
    if (allowed && !allowed.has(weekday)) {
      return {
        active: false,
        outcome: "skip_day",
        reason_detail: `weekday=${weekday} allowed=${[...allowed].sort((a, b) => a - b).join(",")}`,
      };
    }
    if (!isMinuteWithinWindow(nowMin, startMin, endMin)) {
      const detail = JSON.stringify({ tz, nowMin, startMin, endMin, weekday });
      return { active: false, outcome: "skip_window", reason_detail: detail };
    }
    return { active: true, outcome: "ok", reason_detail: null };
  }

  const until = process.env.ML_QUESTIONS_IA_AUTO_UNTIL;
  if (until == null || String(until).trim() === "") {
    return { active: false, outcome: "skip_no_until", reason_detail: null };
  }
  const end = Date.parse(String(until).trim());
  if (!Number.isFinite(end)) {
    return {
      active: false,
      outcome: "bad_until_parse",
      reason_detail: String(until).trim().slice(0, 200),
    };
  }
  if (Date.now() >= end) {
    return { active: false, outcome: "until_expired", reason_detail: new Date(end).toISOString() };
  }
  return { active: true, outcome: "ok", reason_detail: null };
}

function isQuestionsIaAutoWindowActive() {
  return getQuestionsIaAutoWindowEvaluation().active;
}

function pickRandomIaBody(lastIndex) {
  const n = QUESTION_IA_BODIES.length;
  if (n === 0) return { text: "", index: -1 };
  if (n === 1) return { text: QUESTION_IA_BODIES[0], index: 0 };
  let idx = Math.floor(Math.random() * n);
  if (lastIndex != null && lastIndex >= 0 && lastIndex < n) {
    let g = 0;
    while (idx === lastIndex && g++ < 64) {
      idx = Math.floor(Math.random() * n);
    }
  }
  return { text: QUESTION_IA_BODIES[idx], index: idx };
}

/**
 * Tras guardar pending: intenta POST /answers si la ventana IA está activa.
 * @param {{ mlUserId: number, pendingRow: object, parsed: object, notifId: string|null }} args
 */
async function tryQuestionIaAutoAnswer(args) {
  const mlUid = Number(args.mlUserId);
  const pendingRow = args.pendingRow;
  const parsed = args.parsed;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !pendingRow || !parsed) return { ok: false, skip: "bad_args" };

  const win = getQuestionsIaAutoWindowEvaluation();
  if (!win.active) {
    try {
      await insertMlQuestionsIaAutoLog({
        ml_user_id: mlUid,
        ml_question_id: pendingRow.ml_question_id,
        item_id: pendingRow.item_id,
        buyer_id: pendingRow.buyer_id,
        outcome: win.outcome,
        reason_detail: win.reason_detail,
        notification_id: pendingRow.notification_id,
      });
    } catch (e) {
      console.error("[questions ia-auto] ml_questions_ia_auto_log:", e.message || e);
    }
    return { ok: true, skip: "window_off", ia_outcome: win.outcome };
  }

  const qid = Number(pendingRow.ml_question_id);
  if (!Number.isFinite(qid) || qid <= 0) return { ok: false, skip: "bad_qid" };

  if (await wasMlQuestionsIaAutoSent(qid)) {
    return { ok: true, skip: "already_sent" };
  }

  const { text, index } = pickRandomIaBody(null);
  const maxC = getQuestionsIaMaxChars();
  let body = String(text).trim();
  if (body.length > maxC) {
    body = body.slice(0, maxC);
  }

  const res = await mercadoLibrePostJsonForUser(mlUid, "/answers", {
    question_id: qid,
    text: body,
  });

  const nowIso = new Date().toISOString();

  if (!res.ok) {
    console.error(
      "[questions ia-auto] fallo HTTP %s question_id=%s %s",
      res.status,
      qid,
      (res.rawText || "").slice(0, 400)
    );
    return { ok: false, status: res.status, data: res.data };
  }

  await insertMlQuestionsIaAutoSent({
    ml_question_id: qid,
    ml_user_id: mlUid,
    sent_at: nowIso,
    http_status: res.status,
    template_index: index,
    answer_preview: body.slice(0, 500),
  });

  const merged = { ...parsed };
  merged.status = "ANSWERED";
  merged.answer = { text: body, date_created: nowIso };
  let rawJson;
  try {
    rawJson = JSON.stringify(merged);
  } catch {
    rawJson = pendingRow.raw_json || "{}";
  }

  const answeredRow = {
    ml_question_id: qid,
    ml_user_id: mlUid,
    item_id: pendingRow.item_id,
    buyer_id: pendingRow.buyer_id,
    question_text: pendingRow.question_text,
    answer_text: body,
    ml_status: "ANSWERED",
    date_created: pendingRow.date_created || extractQuestionDateCreatedIso(parsed),
    raw_json: rawJson,
    notification_id: pendingRow.notification_id,
    pending_internal_id: null,
    answered_at: nowIso,
    moved_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
    response_time_sec: computeResponseTimeSec(merged),
  };

  await upsertMlQuestionAnswered(answeredRow);
  await deleteMlQuestionPending(qid);

  console.log("[questions ia-auto] respondida question_id=%s ml_user_id=%s plantilla=%s", qid, mlUid, index + 1);
  return { ok: true, question_id: qid, template_index: index };
}

module.exports = {
  tryQuestionIaAutoAnswer,
  isQuestionsIaAutoWindowActive,
  getQuestionsIaAutoWindowEvaluation,
  getQuestionsIaTimezone,
  getLocalMinutesAndWeekdayInTz,
  parseHHMM,
  QUESTION_IA_BODIES,
  pickRandomIaBody,
};
