/**
 * MENSAJE TIPO D (`MESSAGE_TYPE_D` en `ml-message-types.js`): respuestas automáticas a preguntas ML (POST /answers).
 *
 * Activación: ML_QUESTIONS_IA_AUTO_ENABLED=1 (cualquier otro valor = apagado).
 *
 * Ventana (opcional): si están definidos **ambos** ML_QUESTIONS_IA_AUTO_WINDOW_START y
 * ML_QUESTIONS_IA_AUTO_WINDOW_END (HH:mm en ML_QUESTIONS_IA_AUTO_TIMEZONE), solo se intenta POST
 * dentro de esa franja. Si inicio > fin, cruza medianoche (ej. 17:20–07:00).
 * ML_QUESTIONS_IA_AUTO_DAYS=0,1,…,6 (0=dom … 6=sáb) restringe días; vacío = todos los días.
 * **Domingo (0):** por defecto la franja START/END **no aplica** (tipo D permitido las 24 h ese día),
 * siempre que el domingo esté permitido en ML_QUESTIONS_IA_AUTO_DAYS (o días vacío).
 * Con `ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW=0` el domingo usa la misma franja que el resto.
 * ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW=1 o ML_QUESTIONS_IA_AUTO_FORCE=1 ignora la franja horaria todos los días.
 * ML_QUESTIONS_IA_AUTO_UNTIL=ISO UTC: tras esa fecha/hora no se envía.
 *
 * Polling: ML_QUESTIONS_IA_AUTO_POLL_MS vacío → 60000; 0 = sin poll. Respeta la misma ventana.
 *
 * Antigüedad máx. para intentar POST /answers: ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS (ms). Vacío → 1800000 (30 min).
 * Con valor 0 o negativo no hay tope por edad (comportamiento anterior). Compara con `date_created` de la pregunta (ML).
 *
 * Texto extra (opcional): ML_QUESTIONS_IA_AUTO_EXTRA_LINE se añade al final de la plantilla elegida
 * (p. ej. avisos de Semana Santa). Vacío = no se añade nada. Cuenta para ML_QUESTIONS_IA_MAX_CHARS.
 *
 * Importante en producción: las variables deben estar en el **servidor** (p. ej. Render). `oauth-env.json`
 * solo aplica en local si el archivo existe; no sustituye env del panel si allí sigue ENABLED=1.
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
const handoffGuard = require("./src/middleware/handoffGuard");
const { pool } = require("./db");
const {
  computeResponseTimeSec,
  extractQuestionDateCreatedIso,
  isQuestionUnansweredStatus,
} = require("./ml-question-sync");
const {
  wasMlQuestionsIaAutoSent,
  getMlQuestionsIaAutoSentIdSet,
  insertMlQuestionsIaAutoSent,
  insertMlQuestionsIaAutoLog,
  deleteMlQuestionPending,
  upsertMlQuestionAnswered,
  upsertMlQuestionPending,
  listMlQuestionsPending,
  hasMlQuestionsPending,
} = require("./db");

/** Intervalo por defecto del poll de reintentos (1 min). */
const DEFAULT_IA_AUTO_POLL_MS = 60_000;

/** Por defecto: ventana de 30 min desde la creación de la pregunta en ML para aplicar respuesta automática. */
const DEFAULT_IA_AUTO_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Tope de antigüedad de la pregunta para intentar IA automática. `null` = sin límite.
 * @returns {number|null}
 */
function resolveQuestionsIaAutoPendingMaxAgeMs() {
  const raw = process.env.ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS;
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_IA_AUTO_PENDING_MAX_AGE_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(n)));
}

/**
 * @param {object} pendingRow
 * @param {object} parsed
 * @param {Date} evalAt
 * @returns {number|null} ms desde creación en ML, o null si no hay fecha
 */
function getQuestionAgeMsForIaAuto(pendingRow, parsed, evalAt) {
  const iso =
    (pendingRow && pendingRow.date_created != null && String(pendingRow.date_created).trim() !== ""
      ? String(pendingRow.date_created).trim()
      : null) || extractQuestionDateCreatedIso(parsed);
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return evalAt.getTime() - t;
}

/**
 * ms efectivos para el poll: vacío/no definido → 1 min; "0" → desactivado.
 * @returns {number}
 */
function resolveQuestionsIaAutoPollMs() {
  const raw = process.env.ML_QUESTIONS_IA_AUTO_POLL_MS;
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_IA_AUTO_POLL_MS;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const QUESTION_IA_BODIES = Object.freeze([
  "Hola. Si el producto que buscas es el de la publicación, lo más probable es que esté disponible y el precio sea el publicado. Aceptamos tasa BCV. Somos tienda física; mañana abrimos de 9:00 a 16:00. Este mensaje fue generado por una IA; mañana habrá una persona para ayudarte.",
  "Buenas. Si la publicación coincide con lo que necesitas, en general el artículo está y el precio es el que ves publicado. Trabajamos a tasa BCV. Tienda física. Mañana atendemos de 9 a 16 h. Respuesta automática por IA; mañana te atiende un humano.",
  "Hola, gracias por escribir. Si buscas exactamente lo publicado, lo más probable es que haya stock y el monto sea el del aviso. Aceptamos tasa BCV. Somos tienda física; mañana de 9:00 a 16:00. Aviso: mensaje automático (IA); mañana puedes hablar con alguien del equipo.",
  "Buen día. Si tu consulta es sobre la publicación que estás viendo, lo habitual es que el producto esté y el precio sea el publicado. Cobramos a tasa BCV. Tienda física; mañana abrimos 9–16 h. Generado por IA; mañana hay atención humana.",
  "Hola. Para la publicación que miras: lo más probable es disponibilidad y precio según lo publicado. Aceptamos tasa BCV. Somos tienda física; mañana de 9 a 16. Este texto es automático (IA); mañana te ayuda una persona.",
  "Buenas tardes/noches. Si coincide con el aviso, el precio suele ser el publicado y el producto suele estar. Tasa BCV. Local físico; mañana 9:00–16:00. Mensaje de sistema (IA); mañana atención humana.",
  "Hola. Si es el ítem de la publicación, lo más probable es que esté y el valor sea el publicado. Trabajamos con tasa BCV. Tienda física; mañana abrimos de 9 a 16 h. Respuesta automática por IA; mañana puedes consultar con el local.",
  "Gracias por tu pregunta. Si te referís a lo publicado, lo normal es que el precio sea el del aviso y que haya unidad. Aceptamos BCV. Somos tienda física; mañana 9:00 a 16:00. Generado por IA; mañana hay personal disponible.",
  "Hola. Publicación = precio publicado en lo posible y disponibilidad habitual. Cobro a tasa BCV. Tienda física; mañana de 9 a 16. Aviso: IA; mañana te responde un humano.",
  "Buenas. Si buscas el producto del aviso, lo más probable es que el precio sea el publicado y que podamos atenderte. Tasa BCV. Local físico; mañana 9–16 h. Mensaje automático (IA); mañana atención personal.",
]);

function getQuestionsIaMaxChars() {
  const n = Number(process.env.ML_QUESTIONS_IA_MAX_CHARS || 2000);
  if (!Number.isFinite(n) || n < 100) return 2000;
  return Math.min(4000, Math.floor(n));
}

/** Aviso temporal (p. ej. Semana Santa); vacío = omitir. */
function getQuestionsIaAutoExtraLine() {
  const raw = process.env.ML_QUESTIONS_IA_AUTO_EXTRA_LINE;
  if (raw == null || String(raw).trim() === "") return "";
  return String(raw).trim();
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

/** @param {string|null|undefined} s - "17:20", "7:00" */
function parseQuestionsIaWindowHHMM(s) {
  if (s == null || String(s).trim() === "") return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * @param {Date} [atDate]
 * @returns {{ active: boolean, outcome: string, reason_detail: string|null }}
 */
function getQuestionsIaAutoWindowEvaluation(atDate) {
  const ref =
    atDate instanceof Date && !Number.isNaN(atDate.getTime()) ? atDate : new Date();

  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    return { active: false, outcome: "skip_disabled", reason_detail: null };
  }

  const untilRaw = process.env.ML_QUESTIONS_IA_AUTO_UNTIL;
  if (untilRaw != null && String(untilRaw).trim() !== "") {
    const u = new Date(String(untilRaw).trim());
    if (!Number.isNaN(u.getTime()) && ref.getTime() > u.getTime()) {
      return {
        active: false,
        outcome: "expired_until",
        reason_detail: `ML_QUESTIONS_IA_AUTO_UNTIL ya pasó (${String(untilRaw).trim()})`,
      };
    }
  }

  const ignoreWindow =
    process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW === "1" ||
    process.env.ML_QUESTIONS_IA_AUTO_FORCE === "1";

  const tz = getQuestionsIaTimezone();
  const { minutes: nowMin, weekday } = getLocalMinutesAndWeekdayInTz(ref, tz);
  if (weekday == null) {
    return {
      active: false,
      outcome: "timezone_error",
      reason_detail: `No se pudo resolver día/hora en ${tz}`,
    };
  }

  const daysRaw = process.env.ML_QUESTIONS_IA_AUTO_DAYS;
  if (daysRaw != null && String(daysRaw).trim() !== "") {
    const allowed = new Set(
      String(daysRaw)
        .split(",")
        .map((x) => parseInt(String(x).trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6)
    );
    if (allowed.size > 0 && !allowed.has(weekday)) {
      return {
        active: false,
        outcome: "wrong_weekday",
        reason_detail: `Día local ${weekday} no está en ML_QUESTIONS_IA_AUTO_DAYS`,
      };
    }
  }

  const startRaw = process.env.ML_QUESTIONS_IA_AUTO_WINDOW_START;
  const endRaw = process.env.ML_QUESTIONS_IA_AUTO_WINDOW_END;
  const hasStart = startRaw != null && String(startRaw).trim() !== "";
  const hasEnd = endRaw != null && String(endRaw).trim() !== "";

  const sundayBypassWindow =
    weekday === 0 &&
    process.env.ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW !== "0";

  if (!ignoreWindow && hasStart && hasEnd && !sundayBypassWindow) {
    const startMin = parseQuestionsIaWindowHHMM(startRaw);
    const endMin = parseQuestionsIaWindowHHMM(endRaw);
    if (startMin == null || endMin == null) {
      return {
        active: false,
        outcome: "bad_window_config",
        reason_detail: "ML_QUESTIONS_IA_AUTO_WINDOW_START/END deben ser HH:mm (ej. 17:20)",
      };
    }
    let inWindow = false;
    if (startMin < endMin) {
      inWindow = nowMin >= startMin && nowMin < endMin;
    } else if (startMin > endMin) {
      inWindow = nowMin >= startMin || nowMin < endMin;
    } else {
      inWindow = false;
    }
    if (!inWindow) {
      return {
        active: false,
        outcome: "outside_window",
        reason_detail: `Hora local fuera de ventana ${String(startRaw).trim()}–${String(endRaw).trim()} (${tz})`,
      };
    }
  }

  return {
    active: true,
    outcome: "ok",
    reason_detail: ignoreWindow
      ? "IGNORE_WINDOW o FORCE: sin filtro horario"
      : sundayBypassWindow && hasStart && hasEnd
        ? "Domingo: tipo D permitido 24 h (franja START/END no aplica; ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW≠0)"
        : hasStart && hasEnd
          ? "Dentro de ventana configurada"
          : "Sin ventana START/END: permitido 24h (solo ENABLED + días/UNTIL)",
  };
}

/** Máx. caracteres guardados en ml_questions_pending.ia_auto_route_detail */
const IA_AUTO_ROUTE_DETAIL_MAX = 12000;

/**
 * Diagnóstico para pending (hora local + resultado de getQuestionsIaAutoWindowEvaluation).
 * @param {Date} [atDate]
 * @returns {Record<string, unknown>}
 */
function getQuestionsIaAutoWindowArithmeticBreakdown(atDate) {
  const ref =
    atDate instanceof Date && !Number.isNaN(atDate.getTime()) ? atDate : new Date();
  const tz = getQuestionsIaTimezone();
  const { minutes: nowMin, weekday } = getLocalMinutesAndWeekdayInTz(ref, tz);
  const hh = Math.floor(nowMin / 60);
  const mm = nowMin % 60;
  const localHhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const ev = getQuestionsIaAutoWindowEvaluation(ref);
  const base = {
    reference_utc: ref.toISOString(),
    timezone: tz,
    local_hhmm: localHhmm,
    minutes_since_midnight: nowMin,
    weekday_0_6: weekday,
    ia_enabled: process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1",
    plantillas_disponibles: QUESTION_IA_BODIES.length,
    evaluation: ev,
  };

  if (!base.ia_enabled) {
    return {
      ...base,
      summary: "ML_QUESTIONS_IA_AUTO_ENABLED distinto de 1: no hay respuesta automática.",
    };
  }
  return {
    ...base,
    summary: ev.active
      ? `IA automática permitida ahora: ${ev.reason_detail || ev.outcome}`
      : `IA bloqueada ahora: ${ev.outcome}${ev.reason_detail ? ` — ${ev.reason_detail}` : ""}`,
  };
}

/**
 * Serializa el motivo por el que la pregunta quedó en pending (JSON truncado).
 * @param {Record<string, unknown>} obj
 * @returns {string|null}
 */
function serializeIaAutoPendingRouteDetail(obj) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= IA_AUTO_ROUTE_DETAIL_MAX) return s;
    return `${s.slice(0, IA_AUTO_ROUTE_DETAIL_MAX - 1)}…`;
  } catch {
    return '{"error":"serialize_failed"}';
  }
}

function isQuestionsIaAutoWindowActive() {
  return getQuestionsIaAutoWindowEvaluation().active;
}

const WEEKDAY_NAMES_ES = Object.freeze([
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
]);

/**
 * Estado verificable para pruebas: hora local, modo manual/automático, env efectivo y comprobaciones.
 */
function getQuestionsIaAutoDiagnostics() {
  const tz = getQuestionsIaTimezone();
  const now = new Date();
  const { minutes: nowMin, weekday } = getLocalMinutesAndWeekdayInTz(now, tz);
  const hh = Math.floor(nowMin / 60);
  const mm = nowMin % 60;
  const localTimeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const wdName = weekday != null && weekday >= 0 && weekday <= 6 ? WEEKDAY_NAMES_ES[weekday] : "?";
  const ev = getQuestionsIaAutoWindowEvaluation();
  const modo = ev.active ? "automatica" : "manual";
  let prueba;
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    prueba =
      "Poné ML_QUESTIONS_IA_AUTO_ENABLED=1 y reiniciá. Sin eso no hay intentos de POST /answers.";
  } else if (process.env.ML_WEBHOOK_FETCH_RESOURCE !== "1") {
    prueba =
      "ENABLED=1 pero ML_WEBHOOK_FETCH_RESOURCE≠1: no se hace GET /questions ni respuesta automática al recibir webhook. Poné =1 y reiniciá.";
  } else {
    prueba = `ENABLED=1 y fetch ON: al llegar webhook questions con UNANSWERED se intenta POST /answers de inmediato con texto aleatorio entre ${QUESTION_IA_BODIES.length} plantillas (QUESTION_IA_BODIES). Pending viejo: /preguntas-ia-auto-retry?k=…`;
  }

  return {
    ok: true,
    prueba,
    modo,
    modo_confirmacion: ev.active ? "AUTOMATICA" : "MANUAL",
    timezone: tz,
    hora_local: `${localTimeStr} (${wdName})`,
    minutos_desde_medianoche: nowMin,
    weekday_0_dom_6_sab: weekday,
    env: {
      ML_QUESTIONS_IA_AUTO_ENABLED: process.env.ML_QUESTIONS_IA_AUTO_ENABLED || "",
      ML_QUESTIONS_IA_AUTO_TIMEZONE: process.env.ML_QUESTIONS_IA_AUTO_TIMEZONE || "",
      ML_QUESTIONS_IA_AUTO_WINDOW_START: process.env.ML_QUESTIONS_IA_AUTO_WINDOW_START || "",
      ML_QUESTIONS_IA_AUTO_WINDOW_END: process.env.ML_QUESTIONS_IA_AUTO_WINDOW_END || "",
      ML_QUESTIONS_IA_AUTO_DAYS: process.env.ML_QUESTIONS_IA_AUTO_DAYS || "",
      ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW: process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW || "",
      ML_QUESTIONS_IA_AUTO_FORCE: process.env.ML_QUESTIONS_IA_AUTO_FORCE || "",
      ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW:
        process.env.ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW != null &&
        String(process.env.ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW).trim() !== ""
          ? process.env.ML_QUESTIONS_IA_AUTO_SUNDAY_IGNORE_WINDOW
          : "(vacío→1 domingo 24h si hay ventana)",
      ML_QUESTIONS_IA_AUTO_UNTIL: process.env.ML_QUESTIONS_IA_AUTO_UNTIL || "",
      ML_QUESTIONS_IA_AUTO_POLL_MS:
        process.env.ML_QUESTIONS_IA_AUTO_POLL_MS != null && String(process.env.ML_QUESTIONS_IA_AUTO_POLL_MS).trim() !== ""
          ? process.env.ML_QUESTIONS_IA_AUTO_POLL_MS
          : `(vacío→${DEFAULT_IA_AUTO_POLL_MS})`,
      ML_QUESTIONS_IA_AUTO_POLL_LIMIT: process.env.ML_QUESTIONS_IA_AUTO_POLL_LIMIT || "",
      ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS:
        process.env.ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS != null &&
        String(process.env.ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS).trim() !== ""
          ? process.env.ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS
          : `(vacío→${DEFAULT_IA_AUTO_PENDING_MAX_AGE_MS} = 30 min; 0 = sin tope)`,
      ML_QUESTIONS_IA_AUTO_EXTRA_LINE:
        process.env.ML_QUESTIONS_IA_AUTO_EXTRA_LINE != null &&
        String(process.env.ML_QUESTIONS_IA_AUTO_EXTRA_LINE).trim() !== ""
          ? String(process.env.ML_QUESTIONS_IA_AUTO_EXTRA_LINE).trim()
          : "",
      ML_WEBHOOK_FETCH_RESOURCE: process.env.ML_WEBHOOK_FETCH_RESOURCE || "",
    },
    checks: {
      ia_enabled: process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1",
      plantillas_ia: QUESTION_IA_BODIES.length,
      poll_ms_efectivo: (() => {
        const ms = resolveQuestionsIaAutoPollMs();
        if (ms <= 0) return 0;
        return ms >= DEFAULT_IA_AUTO_POLL_MS ? ms : 0;
      })(),
      webhook_fetch_resource: process.env.ML_WEBHOOK_FETCH_RESOURCE === "1",
      pending_max_age_ms_efectivo: resolveQuestionsIaAutoPendingMaxAgeMs(),
    },
    evaluation: ev,
    server_time_utc: now.toISOString(),
    urls_prueba: {
      status: "GET /preguntas-ia-auto-status?k=ADMIN_SECRET",
      log_omitidos: "GET /preguntas-ia-auto-log?k=ADMIN_SECRET&format=json",
      retry_pending: "GET /preguntas-ia-auto-retry?k=ADMIN_SECRET",
    },
  };
}

/**
 * Errores de POST /answers en los que ML indica que no tiene sentido seguir con esa fila en pending:
 * pregunta ya no UNANSWERED, recurso inexistente, o ítem pausado (ML no permite contestar hasta reactivar).
 */
function mlAnswersPostErrorMeansDropLocalPending(httpStatus, rawText, data) {
  const st = Number(httpStatus);
  let blob = rawText != null ? String(rawText) : "";
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    try {
      for (const k of ["message", "error", "cause"]) {
        const v = data[k];
        if (v == null) continue;
        blob += typeof v === "string" ? v : JSON.stringify(v);
      }
    } catch {
      /* ignore */
    }
  }
  const low = blob.toLowerCase();
  if (low.includes("not_unanswered_question")) return true;
  if (low.includes("not_active_item")) return true;
  if (low.includes("item must be active")) return true;
  if (st === 404) return true;
  return false;
}

function mlAnswersPostErrorDropReasonLog(httpStatus, rawText, data) {
  let blob = rawText != null ? String(rawText) : "";
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    try {
      for (const k of ["message", "error"]) {
        const v = data[k];
        if (v == null) continue;
        blob += typeof v === "string" ? v : JSON.stringify(v);
      }
    } catch {
      /* ignore */
    }
  }
  const low = blob.toLowerCase();
  if (low.includes("not_active_item") || low.includes("item must be active")) {
    return "publicación pausada o no activa; ML no acepta respuestas hasta reactivar la publicación";
  }
  if (low.includes("not_unanswered_question")) {
    return "pregunta ya no UNANSWERED o no admite respuesta en ML";
  }
  if (Number(httpStatus) === 404) return "recurso no encontrado en ML";
  return "error permanente según API ML; pending local retirado";
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
 * Si ML_QUESTIONS_IA_AUTO_ENABLED=1: POST /answers con plantilla aleatoria; éxito → answered + borrar pending.
 * @param {{ mlUserId: number, pendingRow: object, parsed: object, notifId: string|null, iaAutoSentCache?: Set<number>, evalAt?: Date }} args
 */
async function tryQuestionIaAutoAnswer(args) {
  const mlUid = Number(args.mlUserId);
  const pendingRow = args.pendingRow;
  const parsed = args.parsed;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !pendingRow || !parsed) return { ok: false, skip: "bad_args" };

  const evalAt =
    args.evalAt instanceof Date && !Number.isNaN(args.evalAt.getTime()) ? args.evalAt : new Date();
  const win = getQuestionsIaAutoWindowEvaluation(evalAt);
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
    const skip = win.outcome === "skip_disabled" ? "disabled" : "window_off";
    return { ok: true, skip, ia_outcome: win.outcome };
  }

  const maxAgeMs = resolveQuestionsIaAutoPendingMaxAgeMs();
  if (maxAgeMs != null) {
    const rawAge = getQuestionAgeMsForIaAuto(pendingRow, parsed, evalAt);
    const ageMs = rawAge == null ? null : Math.max(0, rawAge);
    if (ageMs != null && ageMs > maxAgeMs) {
      const detail = `Pregunta ${Math.round(ageMs / 60000)} min de antigüedad > máximo ${Math.round(maxAgeMs / 60000)} min (ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS); no se envía POST /answers automático.`;
      try {
        await insertMlQuestionsIaAutoLog({
          ml_user_id: mlUid,
          ml_question_id: pendingRow.ml_question_id,
          item_id: pendingRow.item_id,
          buyer_id: pendingRow.buyer_id,
          outcome: "pending_too_old",
          reason_detail: detail,
          notification_id: pendingRow.notification_id,
        });
      } catch (e) {
        console.error("[questions ia-auto] ml_questions_ia_auto_log:", e.message || e);
      }
      return { ok: true, skip: "pending_too_old", ia_outcome: "pending_too_old" };
    }
  }

  const qid = Number(pendingRow.ml_question_id);
  if (!Number.isFinite(qid) || qid <= 0) return { ok: false, skip: "bad_qid" };

  if (args.iaAutoSentCache instanceof Set) {
    if (args.iaAutoSentCache.has(qid)) {
      return { ok: true, skip: "already_sent" };
    }
  } else if (await wasMlQuestionsIaAutoSent(qid)) {
    return { ok: true, skip: "already_sent" };
  }

  // Guard: si el comprador tiene un chat WA activo con handoff humano, no responder automáticamente.
  // Lookup: buyer_id → ml_buyers.phone_1 → crm_chats.phone (puede ser null si no hay chat vinculado).
  try {
    const { rows: chatRows } = await pool.query(
      `SELECT c.id FROM crm_chats c
       INNER JOIN ml_buyers b ON b.phone_1 = c.phone
       WHERE b.buyer_id = $1
       LIMIT 1`,
      [pendingRow.buyer_id]
    );
    const linkedChatId = chatRows[0]?.id || null;
    if (linkedChatId) {
      const skip = await handoffGuard.shouldSkipBotReply({
        chatId: linkedChatId,
        correlationId: String(qid),
      });
      if (skip) {
        console.log("[questions ia-auto] skipped by handoff guard: question_id=%s chat_id=%s", qid, linkedChatId);
        return { ok: true, skip: "handoff_active", ia_outcome: "handoff_active" };
      }
    }
  } catch (guardErr) {
    // Si el lookup falla (ej: tabla no migrada), seguir con respuesta normal — no bloquear
    console.warn("[questions ia-auto] handoff guard lookup falló (no crítico):", guardErr.message);
  }

  console.log("[questions ia-auto] intento POST /answers question_id=%s ml_user_id=%s", qid, mlUid);

  const { text, index } = pickRandomIaBody(null);
  const maxC = getQuestionsIaMaxChars();
  let body = String(text).trim();
  const extraLine = getQuestionsIaAutoExtraLine();
  if (extraLine) {
    body = `${body} ${extraLine}`;
  }
  if (body.length > maxC) {
    body = body.slice(0, maxC);
  }

  let res;
  try {
    res = await mercadoLibrePostJsonForUser(mlUid, "/answers", {
      question_id: qid,
      text: body,
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    console.error("[questions ia-auto] excepción POST /answers question_id=%s ml_user_id=%s %s", qid, mlUid, msg);
    try {
      await insertMlQuestionsIaAutoLog({
        ml_user_id: mlUid,
        ml_question_id: qid,
        item_id: pendingRow.item_id,
        buyer_id: pendingRow.buyer_id,
        outcome: "exception",
        reason_detail: msg.slice(0, 8000),
        notification_id: pendingRow.notification_id,
      });
    } catch (logErr) {
      console.error("[questions ia-auto] log exception:", logErr.message || logErr);
    }
    return { ok: false, skip: "exception", error: msg };
  }

  const nowIso = new Date().toISOString();

  if (!res.ok) {
    const errSnippet = (res.rawText || "").slice(0, 2000);
    console.error(
      "[questions ia-auto] fallo HTTP %s question_id=%s %s",
      res.status,
      qid,
      (res.rawText || "").slice(0, 400)
    );
    try {
      await insertMlQuestionsIaAutoLog({
        ml_user_id: mlUid,
        ml_question_id: qid,
        item_id: pendingRow.item_id,
        buyer_id: pendingRow.buyer_id,
        outcome: "api_error",
        reason_detail: `HTTP ${res.status} ${errSnippet}`,
        notification_id: pendingRow.notification_id,
      });
    } catch (e) {
      console.error("[questions ia-auto] log api_error:", e.message || e);
    }
    if (mlAnswersPostErrorMeansDropLocalPending(res.status, res.rawText, res.data)) {
      try {
        await deleteMlQuestionPending(qid);
        console.warn(
          "[questions ia-auto] pending local eliminado question_id=%s (POST /answers HTTP %s; %s)",
          qid,
          res.status,
          mlAnswersPostErrorDropReasonLog(res.status, res.rawText, res.data)
        );
      } catch (eDel) {
        console.error("[questions ia-auto] delete pending tras error ML:", eDel.message || eDel);
      }
      return { ok: true, skip: "dropped_stale_pending", status: res.status };
    }
    return { ok: false, status: res.status, data: res.data, skip: "api_error" };
  }

  await insertMlQuestionsIaAutoSent({
    ml_question_id: qid,
    ml_user_id: mlUid,
    sent_at: nowIso,
    http_status: res.status,
    template_index: index,
    answer_preview: body.slice(0, 500),
  });
  if (args.iaAutoSentCache instanceof Set) {
    args.iaAutoSentCache.add(qid);
  }

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

/**
 * Reintenta POST /answers para filas en ml_questions_pending (p. ej. tras fallo de red o ENABLED apagado antes).
 * @param {{ limit?: number }} [opts]
 */
async function retryPendingQuestionsIaAuto(opts) {
  const cap = opts && opts.limit != null ? Number(opts.limit) : 50;
  const n = Math.min(Math.max(Number.isFinite(cap) ? cap : 50, 1), 200);
  const rows = await listMlQuestionsPending(n, 200);
  if (rows.length === 0) {
    return { ok: true, pending_seen: 0, results: [] };
  }
  const qidsForSent = [];
  for (const row of rows) {
    if (!isQuestionUnansweredStatus(row.ml_status)) continue;
    const q = Number(row.ml_question_id);
    if (Number.isFinite(q) && q > 0) qidsForSent.push(q);
  }
  const sentSet = await getMlQuestionsIaAutoSentIdSet(qidsForSent);
  const results = [];
  for (const row of rows) {
    const qid = row.ml_question_id;
    if (!isQuestionUnansweredStatus(row.ml_status)) {
      results.push({ ml_question_id: qid, skip: "not_unanswered" });
      continue;
    }
    let parsed;
    try {
      parsed = row.raw_json ? JSON.parse(row.raw_json) : null;
    } catch {
      results.push({ ml_question_id: qid, skip: "bad_raw_json" });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      results.push({ ml_question_id: qid, skip: "no_parsed" });
      continue;
    }
    const mlUserId = Number(row.ml_user_id);
    const evalAt = new Date();
    const win = getQuestionsIaAutoWindowEvaluation(evalAt);
    const arithmetic = getQuestionsIaAutoWindowArithmeticBreakdown(evalAt);
    const r = await tryQuestionIaAutoAnswer({
      mlUserId,
      pendingRow: row,
      parsed,
      notifId: row.notification_id,
      iaAutoSentCache: sentSet,
      evalAt,
    });
    const resueltaAuto =
      r &&
      r.ok === true &&
      (r.question_id != null ||
        r.skip === "already_sent" ||
        r.skip === "dropped_stale_pending" ||
        r.skip === "pending_too_old");
    if (!resueltaAuto) {
      try {
        await upsertMlQuestionPending({
          ...row,
          ia_auto_route_detail: serializeIaAutoPendingRouteDetail({
            route: "pending_after_retry_attempt",
            evaluated_at_utc: evalAt.toISOString(),
            question_date_created_ml: row.date_created || null,
            evaluation: {
              active: win.active,
              outcome: win.outcome,
              reason_detail: win.reason_detail,
            },
            arithmetic_breakdown: arithmetic,
            try_result: {
              ok: r && r.ok,
              skip: r && r.skip,
              http_status: r && r.status,
              error: r && r.error != null ? String(r.error).slice(0, 4000) : null,
            },
            human:
              "Intento vía GET /preguntas-ia-auto-retry o poll (ML_QUESTIONS_IA_AUTO_POLL_MS). Si sigue en pending, revisá try_result, token o permisos POST /answers.",
          }),
        });
      } catch (eUp) {
        console.error("[questions ia-auto retry] upsert ia_auto_route_detail:", eUp.message || eUp);
      }
    }
    results.push({ ml_question_id: qid, ...r });
  }
  return { ok: true, pending_seen: rows.length, results };
}

/**
 * Temporizador: con ML_QUESTIONS_IA_AUTO_ENABLED=1 reintenta pending cada minuto por defecto
 * (POLL_MS vacío = 60000). POLL_MS=0 desactiva el poll.
 */
function startQuestionsIaAutoPoll() {
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    console.warn("[questions ia-auto poll] ignorado: ML_QUESTIONS_IA_AUTO_ENABLED≠1");
    return;
  }
  const ms = resolveQuestionsIaAutoPollMs();
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  if (ms < DEFAULT_IA_AUTO_POLL_MS) {
    console.warn(
      "[questions ia-auto poll] ML_QUESTIONS_IA_AUTO_POLL_MS debe ser >= %s (1 min); poll no iniciado",
      DEFAULT_IA_AUTO_POLL_MS
    );
    return;
  }

  const limit = Math.min(
    200,
    Math.max(1, Number(process.env.ML_QUESTIONS_IA_AUTO_POLL_LIMIT || 40) || 40)
  );
  let running = false;

  async function tick() {
    if (running) return;
    const ev = getQuestionsIaAutoWindowEvaluation();
    if (!ev.active) return;
    running = true;
    try {
      const out = await retryPendingQuestionsIaAuto({ limit });
      const answered = (out.results || []).filter((r) => r.ok === true && r.question_id != null).length;
      const dropped = (out.results || []).filter((r) => r.skip === "dropped_stale_pending").length;
      if (out.pending_seen > 0) {
        console.log(
          "[questions ia-auto poll] revisadas=%s respondidas_ok=%s stale_pending_borrados=%s",
          out.pending_seen,
          answered,
          dropped
        );
      }
    } catch (e) {
      console.error("[questions ia-auto poll]", e.message || e);
    } finally {
      running = false;
    }
  }

  setInterval(tick, ms);
  setTimeout(tick, 15_000);
  console.log(
    "[questions ia-auto poll] cada %s ms (~%s min) · hasta %s pending/ciclo (ENABLED=1)",
    ms,
    (ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 2),
    limit
  );
}

module.exports = {
  tryQuestionIaAutoAnswer,
  retryPendingQuestionsIaAuto,
  startQuestionsIaAutoPoll,
  isQuestionsIaAutoWindowActive,
  getQuestionsIaAutoWindowEvaluation,
  getQuestionsIaAutoWindowArithmeticBreakdown,
  serializeIaAutoPendingRouteDetail,
  IA_AUTO_ROUTE_DETAIL_MAX,
  getQuestionsIaAutoDiagnostics,
  getQuestionsIaTimezone,
  getLocalMinutesAndWeekdayInTz,
  QUESTION_IA_BODIES,
  pickRandomIaBody,
};
