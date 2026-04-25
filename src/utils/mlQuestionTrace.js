"use strict";

function parseIdSet(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const out = new Set(
    String(raw)
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  return out.size > 0 ? out : null;
}

function isEnabled() {
  return process.env.ML_QUESTION_TRACE === "1";
}

function shouldLogForQuestionId(questionId) {
  const set = parseIdSet(process.env.ML_QUESTION_TRACE_IDS);
  if (!set) return true;
  const qid = Number(questionId);
  return Number.isFinite(qid) && set.has(qid);
}

function traceMlQuestion(stage, payload) {
  if (!isEnabled()) return;
  const qid = payload && payload.ml_question_id != null ? Number(payload.ml_question_id) : null;
  if (qid != null && !shouldLogForQuestionId(qid)) return;
  const line = {
    tag: "ml_question_trace",
    stage: String(stage || "unknown"),
    at: new Date().toISOString(),
    ...(payload && typeof payload === "object" ? payload : {}),
  };
  try {
    console.log(JSON.stringify(line));
  } catch (_e) {
    console.log("[ml_question_trace]", stage, payload);
  }
}

module.exports = {
  traceMlQuestion,
};

