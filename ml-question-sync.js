/**
 * Flujo: webhook topic `questions` → (ml_topic_fetches) GET mismo path que el resource, p. ej. `/questions/13552014761`
 * → `UNANSWERED` → ml_questions_pending; respondida/cerrada/borrada (estado en JSON) → borrar pending y upsert answered.
 * Si el GET devuelve 404/410 (pregunta eliminada en ML), `refreshMlQuestionFromApi` y el fetch del webhook borran pending.
 * @see https://developers.mercadolibre.com.ar/es_ar/gestiona-preguntas
 */

/**
 * @param {string} resourceStr
 * @returns {number|null}
 */
function extractQuestionIdFromResource(resourceStr) {
  if (resourceStr == null || typeof resourceStr !== "string") return null;
  const s = resourceStr.trim();
  if (!s) return null;
  const m1 = s.match(/\/questions\/(\d+)/i);
  if (m1) return Number(m1[1]);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

/** Texto de la respuesta del vendedor en el JSON de GET /questions/{id}. */
function extractAnswerText(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const a = parsed.answer;
  if (a == null) return "";
  if (typeof a === "object" && a.text != null) return String(a.text).trim();
  if (typeof a === "string") return a.trim();
  return "";
}

/**
 * ISO de ML (sobre todo api_version=4) puede traer fracciones con más de 3 dígitos (nanosegundos);
 * Date.parse suele devolver NaN. Truncamos a milisegundos.
 * @param {unknown} raw
 * @returns {number}
 */
function parseMlIsoTimestampMs(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  s = s.replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(s);
}

/** Primera fecha no vacía entre alias usados por ML en distintas versiones. */
function pickIsoDate(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/** `date_created` de la pregunta en el JSON de ML (ISO), o null. */
function extractQuestionDateCreatedIso(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  let q = pickIsoDate(parsed, ["date_created", "creation_date", "date_creation"]);
  if (q == null) q = pickIsoDate(parsed, ["last_updated"]);
  if (q == null) return null;
  const s = String(q).trim();
  return s || null;
}

/**
 * Segundos entre creación de la pregunta y de la respuesta (fechas ISO de ML; independiente del huso mostrado).
 * @param {object} parsed - JSON GET /questions/{id}
 * @returns {number|null}
 */
/** Delta en segundos entre dos ISO (misma semántica que computeResponseTimeSec). */
function computeResponseTimeSecFromQuestionAndAnswerIso(questionIso, answerIso) {
  if (questionIso == null || answerIso == null) return null;
  const tQ = parseMlIsoTimestampMs(questionIso);
  const tA = parseMlIsoTimestampMs(answerIso);
  if (!Number.isFinite(tQ) || !Number.isFinite(tA)) return null;
  const sec = Math.floor((tA - tQ) / 1000);
  if (!Number.isFinite(sec)) return null;
  if (sec >= 0) return sec;
  if (sec >= -120) return 0;
  return null;
}

function computeResponseTimeSec(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  let qRaw = pickIsoDate(parsed, ["date_created", "creation_date", "date_creation"]);
  if (qRaw == null) {
    qRaw = pickIsoDate(parsed, ["last_updated"]);
  }
  const aRaw =
    parsed.answer && typeof parsed.answer === "object"
      ? pickIsoDate(parsed.answer, ["date_created", "creation_date", "date_creation"])
      : null;
  if (qRaw == null || aRaw == null) return null;
  return computeResponseTimeSecFromQuestionAndAnswerIso(String(qRaw).trim(), String(aRaw).trim());
}

/**
 * Fecha de creación de la pregunta guardada en pending (columna o raw_json antiguo sin columna).
 * @param {object|null|undefined} pendingSnap
 * @returns {string|null}
 */
function extractQuestionDateCreatedFromPendingSnapshot(pendingSnap) {
  if (!pendingSnap || typeof pendingSnap !== "object") return null;
  const col = pendingSnap.date_created;
  if (col != null && String(col).trim() !== "") return String(col).trim();
  const raw = pendingSnap.raw_json;
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const o = JSON.parse(String(raw));
    return extractQuestionDateCreatedIso(o);
  } catch {
    return null;
  }
}

/**
 * Tras buildQuestionAnsweredRow: rellena date_created desde pending si el GET actual no lo trae,
 * y recalcula response_time_sec (antes quedaba null porque se calculó solo con el JSON incompleto).
 * @param {object} answeredRow
 * @param {object|null|undefined} pendingSnap
 * @param {object|null|undefined} parsed - mismo JSON del GET usado en buildQuestionAnsweredRow
 */
function enrichAnsweredRowFromPendingSnapshot(answeredRow, pendingSnap, parsed) {
  if (!answeredRow || typeof answeredRow !== "object") return answeredRow;
  const hasDc = answeredRow.date_created != null && String(answeredRow.date_created).trim() !== "";
  if (!hasDc) {
    const pendDc = extractQuestionDateCreatedFromPendingSnapshot(pendingSnap);
    if (pendDc) {
      answeredRow.date_created = pendDc;
    } else {
      try {
        const o = JSON.parse(String(answeredRow.raw_json || "{}"));
        const d = extractQuestionDateCreatedIso(o);
        if (d) answeredRow.date_created = d;
      } catch {
        /* ignore */
      }
    }
  }
  const qIso =
    answeredRow.date_created != null && String(answeredRow.date_created).trim() !== ""
      ? String(answeredRow.date_created).trim()
      : null;
  let aIso = null;
  if (parsed && typeof parsed === "object" && parsed.answer && typeof parsed.answer === "object") {
    const a = pickIsoDate(parsed.answer, ["date_created", "creation_date", "date_creation"]);
    if (a != null && String(a).trim() !== "") aIso = String(a).trim();
  }
  if (aIso == null && answeredRow.answered_at != null && String(answeredRow.answered_at).trim() !== "") {
    aIso = String(answeredRow.answered_at).trim();
  }
  const rtsMissing =
    answeredRow.response_time_sec == null || !Number.isFinite(Number(answeredRow.response_time_sec));
  if (rtsMissing && qIso && aIso) {
    const r = computeResponseTimeSecFromQuestionAndAnswerIso(qIso, aIso);
    if (r != null) answeredRow.response_time_sec = r;
  }
  return answeredRow;
}

/**
 * Fila para ml_questions_answered (requiere answer_text NOT NULL en BD).
 * @param {object} parsed
 * @param {number} mlUserId
 * @param {string|null} notificationId
 */
function buildQuestionAnsweredRow(parsed, mlUserId, notificationId) {
  const base = buildQuestionPendingRow(parsed, mlUserId, notificationId);
  if (!base) return null;
  let answerText = extractAnswerText(parsed);
  if (!answerText) answerText = "(sin texto en API)";
  const now = new Date().toISOString();
  let answeredAt = now;
  if (parsed.answer && typeof parsed.answer === "object") {
    const ac = pickIsoDate(parsed.answer, ["date_created", "creation_date", "date_creation"]);
    if (ac != null) answeredAt = String(ac).trim() || now;
  }
  return {
    ml_question_id: base.ml_question_id,
    ml_user_id: base.ml_user_id,
    item_id: base.item_id,
    buyer_id: base.buyer_id,
    question_text: base.question_text,
    answer_text: answerText,
    ml_status: base.ml_status,
    date_created: base.date_created,
    raw_json: base.raw_json,
    notification_id: base.notification_id,
    pending_internal_id: null,
    answered_at: answeredAt,
    moved_at: now,
    created_at: now,
    updated_at: now,
    response_time_sec: computeResponseTimeSec(parsed),
  };
}

function buildQuestionPendingRow(parsed, mlUserId, notificationId) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const id = Number(parsed.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  let buyerId = null;
  if (parsed.from && typeof parsed.from === "object" && parsed.from.id != null) {
    const b = Number(parsed.from.id);
    if (Number.isFinite(b) && b > 0) buyerId = b;
  }
  const itemId = parsed.item_id != null ? String(parsed.item_id) : null;
  const text = parsed.text != null ? String(parsed.text) : null;
  const st = parsed.status != null ? String(parsed.status) : null;
  let rawJson;
  try {
    rawJson = JSON.stringify(parsed);
  } catch {
    rawJson = "{}";
  }
  return {
    ml_question_id: id,
    ml_user_id: mlUserId,
    item_id: itemId,
    buyer_id: buyerId,
    question_text: text,
    ml_status: st,
    date_created: extractQuestionDateCreatedIso(parsed),
    raw_json: rawJson,
    notification_id: notificationId != null ? String(notificationId) : null,
  };
}

function normalizeQuestionStatus(s) {
  if (s == null || String(s).trim() === "") return "";
  return String(s).trim().toUpperCase();
}

/** Solo estas filas deben vivir en ml_questions_pending (estado en API ML). */
function isQuestionUnansweredStatus(status) {
  return normalizeQuestionStatus(status) === "UNANSWERED";
}

/** Si la pregunta ya fue respondida o cerrada en ML, no debe quedar en pending local. */
function isQuestionAnsweredOrClosedStatus(status) {
  const s = normalizeQuestionStatus(status);
  return s === "ANSWERED" || s === "CLOSED" || s === "BANNED" || s === "DELETED" || s === "DISABLED";
}

/**
 * Normaliza topic del webhook: ML suele usar "questions".
 * @param {string|null|undefined} topic
 */
function normalizeQuestionsTopic(topic) {
  if (topic == null) return null;
  const t = String(topic).trim();
  if (t === "question") return "questions";
  return t;
}

module.exports = {
  extractQuestionIdFromResource,
  buildQuestionPendingRow,
  buildQuestionAnsweredRow,
  enrichAnsweredRowFromPendingSnapshot,
  computeResponseTimeSec,
  extractQuestionDateCreatedIso,
  extractAnswerText,
  isQuestionUnansweredStatus,
  isQuestionAnsweredOrClosedStatus,
  normalizeQuestionsTopic,
};
