/**
 * Flujo: webhook topic `questions` → (ml_topic_fetches) GET mismo path que el resource, p. ej. `/questions/13552014761`
 * → `UNANSWERED` → ml_questions_pending; respondida/cerrada → borrar pending y upsert en ml_questions_answered.
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
  if (parsed.answer && typeof parsed.answer === "object" && parsed.answer.date_created != null) {
    answeredAt = String(parsed.answer.date_created).trim() || now;
  }
  return {
    ml_question_id: base.ml_question_id,
    ml_user_id: base.ml_user_id,
    item_id: base.item_id,
    buyer_id: base.buyer_id,
    question_text: base.question_text,
    answer_text: answerText,
    ml_status: base.ml_status,
    raw_json: base.raw_json,
    notification_id: base.notification_id,
    pending_internal_id: null,
    answered_at: answeredAt,
    moved_at: now,
    created_at: now,
    updated_at: now,
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
  extractAnswerText,
  isQuestionUnansweredStatus,
  isQuestionAnsweredOrClosedStatus,
  normalizeQuestionsTopic,
};
