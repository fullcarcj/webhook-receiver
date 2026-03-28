/**
 * Respuestas automáticas a preguntas ML (POST /answers) con plantillas tipo tienda.
 *
 * Flujo en tres pasos (webhook `questions` + ML_WEBHOOK_FETCH_RESOURCE=1 → GET /questions/{id}):
 *
 *   1) Recibir el hook y tener el JSON de la pregunta (estado UNANSWERED o ya respondida).
 *
 *   2) Según estado: si UNANSWERED → mirar hora/ventana IA; si toca automático, intentar POST /answers
 *      (sin insertar pending antes si va bien). Si no toca ventana o falla el POST → guardar/actualizar
 *      ml_questions_pending (cola local para manual o reintento).
 *
 *   3) Si la pregunta queda respondida en ML (automático exitoso o ya estaba ANSWERED en el GET):
 *      upsert ml_questions_answered y delete de ml_questions_pending para ese ml_question_id.
 *
 * Detalle UNANSWERED + IA:
 *   · Ventana activa + POST OK (o ya enviada) → solo paso 3 hacia answered; **no** fila en pending.
 *   · Ventana activa pero falla el POST → pending con diagnóstico; poll/retry después.
 *   · Ventana inactiva → solo pending hasta que abra la ventana o respondas en ML.
 *
 * El poll (ML_QUESTIONS_IA_AUTO_POLL_MS) es respaldo sobre pending cuando la ventana se abre después.
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
 * Sin límite de horario (solo si IA habilitada):
 *   ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW=1  — ignora START/END/DAYS; intenta POST /answers siempre.
 *
 * Polling (pending antiguos o sin webhook reciente):
 *   ML_QUESTIONS_IA_AUTO_POLL_MS=300000  — cada 5 min (mín. 60000) intenta POST /answers sobre pending si la ventana IA está activa (o IGNORE_WINDOW).
 *   ML_QUESTIONS_IA_AUTO_POLL_LIMIT=40    — máx. filas por ciclo.
 *
 *   ML_QUESTIONS_IA_MAX_CHARS=2000
 */
const { mercadoLibrePostJsonForUser } = require("./oauth-token");
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
 * @param {Date} [atDate] - instante usado para la ventana (por defecto: ahora).
 * @returns {{ active: boolean, outcome: string, reason_detail: string|null }}
 */
function getQuestionsIaAutoWindowEvaluation(atDate) {
  const ref =
    atDate instanceof Date && !Number.isNaN(atDate.getTime()) ? atDate : new Date();
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    return { active: false, outcome: "skip_disabled", reason_detail: null };
  }

  if (process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW === "1") {
    return {
      active: true,
      outcome: "ok",
      reason_detail: "ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW=1 (sin filtro horario/día)",
    };
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
    const { minutes: nowMin, weekday } = getLocalMinutesAndWeekdayInTz(ref, tz);
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
  if (ref.getTime() >= end) {
    return { active: false, outcome: "until_expired", reason_detail: new Date(end).toISOString() };
  }
  return { active: true, outcome: "ok", reason_detail: null };
}

/** Máx. caracteres guardados en ml_questions_pending.ia_auto_route_detail */
const IA_AUTO_ROUTE_DETAIL_MAX = 12000;

/**
 * Desglose legible de la comparación horaria (misma lógica que la ventana IA).
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
  const base = {
    reference_utc: ref.toISOString(),
    timezone: tz,
    local_hhmm: localHhmm,
    minutes_since_midnight: nowMin,
    weekday_0_6: weekday,
    ia_enabled: process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1",
    ignore_window: process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW === "1",
  };

  if (!base.ia_enabled) {
    return {
      ...base,
      summary:
        "No hay comparación de ventana: ML_QUESTIONS_IA_AUTO_ENABLED distinto de 1 (respuesta automática desactivada).",
    };
  }
  if (base.ignore_window) {
    return {
      ...base,
      summary:
        "Sin desglose aritmético de franja: ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW=1 (intento automático sin filtro horario).",
    };
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
        ...base,
        window_start_raw: String(ws),
        window_end_raw: String(we),
        summary: "WINDOW_START/WINDOW_END no parseables como HH:MM; no se puede evaluar la franja.",
      };
    }
    const startMin = pStart.h * 60 + pStart.m;
    const endMin = pEnd.h * 60 + pEnd.m;
    const overnight = startMin > endMin;
    let minuteMatch = false;
    let comparisonLines;
    if (startMin === endMin) {
      comparisonLines = [
        "startMin === endMin → la ventana está vacía (siempre fuera).",
        `Valores: startMin=${startMin}, endMin=${endMin}, nowMin=${nowMin}.`,
      ];
    } else if (!overnight) {
      minuteMatch = nowMin >= startMin && nowMin < endMin;
      comparisonLines = [
        "Modo mismo día: activo si nowMin ∈ [startMin, endMin) (incluye inicio, excluye fin).",
        `(${nowMin} >= ${startMin}) && (${nowMin} < ${endMin}) → ${minuteMatch}`,
      ];
    } else {
      minuteMatch = nowMin >= startMin || nowMin < endMin;
      comparisonLines = [
        "Modo cruza medianoche: activo si nowMin >= startMin OR nowMin < endMin.",
        `(${nowMin} >= ${startMin}) || (${nowMin} < ${endMin}) → ${minuteMatch}`,
      ];
    }

    const allowed = parseAllowedWeekdays();
    let dayMatch = true;
    let dayLine = "Días: sin restricción (ML_QUESTIONS_IA_AUTO_DAYS vacío).";
    if (allowed) {
      dayMatch = weekday != null && allowed.has(weekday);
      dayLine = `Día semana=${weekday} permitidos=[${[...allowed].sort((a, b) => a - b).join(",")}] → ${dayMatch}`;
    }
    if (weekday == null) {
      dayLine = "No se pudo resolver weekday (Intl); la evaluación falla.";
      dayMatch = false;
    }

    const windowActive = minuteMatch && dayMatch && weekday != null;

    return {
      ...base,
      window_start_hhmm: String(ws).trim(),
      window_end_hhmm: String(we).trim(),
      window_start_minutes: startMin,
      window_end_minutes: endMin,
      overnight,
      comparison_lines: comparisonLines,
      day_line: dayLine,
      resultado_minutos_dentro_franja: minuteMatch,
      resultado_dia_permitido: dayMatch,
      resultado_ventana_ia_activa: windowActive,
      summary: windowActive
        ? "Dentro de la franja horaria y día; la evaluación IA de ventana sería activa (si no hubo otro bloqueo)."
        : "Fuera de la franja automática por minutos y/o día: la pregunta va a pending si no hay otro camino.",
    };
  }

  const until = process.env.ML_QUESTIONS_IA_AUTO_UNTIL;
  if (until == null || String(until).trim() === "") {
    return {
      ...base,
      summary:
        "Sin ML_QUESTIONS_IA_AUTO_WINDOW_START/END ni ML_QUESTIONS_IA_AUTO_UNTIL: ventana IA inactiva (skip_no_until).",
    };
  }
  const endMs = Date.parse(String(until).trim());
  if (!Number.isFinite(endMs)) {
    return {
      ...base,
      until_raw: String(until).trim().slice(0, 200),
      summary: "ML_QUESTIONS_IA_AUTO_UNTIL no parseable.",
    };
  }
  const beforeUntil = ref.getTime() < endMs;
  return {
    ...base,
    until_iso: new Date(endMs).toISOString(),
    comparison_lines: [
      "Modo UNTIL: activo si instante_referencia < hasta.",
      `ref.getTime()=${ref.getTime()} < until=${endMs} → ${beforeUntil}`,
    ],
    resultado_ventana_ia_activa: beforeUntil,
    summary: beforeUntil
      ? "Dentro del período UNTIL."
      : "UNTIL vencido: fuera de ventana automática.",
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
  } else if (process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW === "1") {
    prueba =
      "IGNORE_WINDOW=1: no se aplica horario ni días; con fetch ON el webhook intenta POST /answers siempre. Pending viejo: /preguntas-ia-auto-retry?k=…";
  } else if (!ev.active) {
    prueba = `Fuera de ventana (${ev.outcome}). Cuando modo sea automatica: webhook questions + fetch; o GET /preguntas-ia-auto-retry?k=… sobre pending. O poné ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW=1 para no depender del reloj.`;
  } else if (process.env.ML_WEBHOOK_FETCH_RESOURCE !== "1") {
    prueba =
      "Ventana OK pero ML_WEBHOOK_FETCH_RESOURCE≠1: no se hace GET /questions ni tryQuestionIaAutoAnswer al recibir webhook. Poné =1 y reiniciá.";
  } else {
    prueba =
      "Ventana OK y fetch ON: al llegar webhook topic questions, debería intentarse POST /answers. Pending viejo: /preguntas-ia-auto-retry?k=…";
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
      ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW: process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW || "",
      ML_QUESTIONS_IA_AUTO_POLL_MS: process.env.ML_QUESTIONS_IA_AUTO_POLL_MS || "",
      ML_QUESTIONS_IA_AUTO_POLL_LIMIT: process.env.ML_QUESTIONS_IA_AUTO_POLL_LIMIT || "",
      ML_QUESTIONS_IA_AUTO_WINDOW_START: process.env.ML_QUESTIONS_IA_AUTO_WINDOW_START || "",
      ML_QUESTIONS_IA_AUTO_WINDOW_END: process.env.ML_QUESTIONS_IA_AUTO_WINDOW_END || "",
      ML_QUESTIONS_IA_AUTO_DAYS: process.env.ML_QUESTIONS_IA_AUTO_DAYS || "",
      ML_WEBHOOK_FETCH_RESOURCE: process.env.ML_WEBHOOK_FETCH_RESOURCE || "",
    },
    checks: {
      ia_enabled: process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1",
      ignore_window: process.env.ML_QUESTIONS_IA_AUTO_IGNORE_WINDOW === "1",
      poll_ms:
        Number(process.env.ML_QUESTIONS_IA_AUTO_POLL_MS || 0) >= 60000
          ? Number(process.env.ML_QUESTIONS_IA_AUTO_POLL_MS)
          : 0,
      webhook_fetch_resource: process.env.ML_WEBHOOK_FETCH_RESOURCE === "1",
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
 * Tras guardar pending (en el mismo paso que el webhook recibe la pregunta).
 * Aquí se mira la hora/ventana: si toca automático → POST /answers; si no → no envía (manual en ML o retry/poll cuando entre la ventana).
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
    return { ok: true, skip: "window_off", ia_outcome: win.outcome };
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

  console.log("[questions ia-auto] intento POST /answers question_id=%s ml_user_id=%s", qid, mlUid);

  const { text, index } = pickRandomIaBody(null);
  const maxC = getQuestionsIaMaxChars();
  let body = String(text).trim();
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
 * Reintenta POST /answers para filas en ml_questions_pending (p. ej. cron en ventana tras haber hecho skip por horario al llegar el webhook).
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
      r && r.ok === true && (r.question_id != null || r.skip === "already_sent");
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
 * Temporizador: mientras la ventana IA esté activa (o IGNORE_WINDOW), reintenta pending periódicamente.
 * Requiere ML_QUESTIONS_IA_AUTO_ENABLED=1 y ML_QUESTIONS_IA_AUTO_POLL_MS>=60000.
 */
function startQuestionsIaAutoPoll() {
  const ms = Number(process.env.ML_QUESTIONS_IA_AUTO_POLL_MS || 0);
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (ms < 60000) {
    console.warn(
      "[questions ia-auto poll] ML_QUESTIONS_IA_AUTO_POLL_MS debe ser >= 60000 (1 min); poll no iniciado"
    );
    return;
  }
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED !== "1") {
    console.warn("[questions ia-auto poll] ignorado: ML_QUESTIONS_IA_AUTO_ENABLED≠1");
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
      if (out.pending_seen > 0) {
        console.log(
          "[questions ia-auto poll] revisadas=%s respondidas_ok=%s",
          out.pending_seen,
          answered
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
    "[questions ia-auto poll] cada %s ms · hasta %s pending/ciclo (solo con ventana activa o IGNORE_WINDOW)",
    ms,
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
  parseHHMM,
  QUESTION_IA_BODIES,
  pickRandomIaBody,
};
