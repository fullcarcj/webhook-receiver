"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const { mercadoLibrePostJsonForUser } = require("../../oauth-token");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_ml_question_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function normalizePath(pathname) {
  const raw = String(pathname || "").replace(/\/{2,}/g, "/");
  return raw.replace(/\/+$/, "") || "/";
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 512 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

async function logMlApiCall({
  mlItemId = null,
  action,
  requestBody = null,
  responseCode = null,
  responseBody = null,
  success = false,
  errorMessage = null,
  executedBy = "inbox",
}) {
  try {
    await pool.query(
      `INSERT INTO ml_api_log
        (ml_item_id, action, request_body, response_code, response_body, success, error_message, executed_by)
       VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8)`,
      [
        mlItemId,
        action,
        requestBody != null ? JSON.stringify(requestBody) : null,
        responseCode,
        responseBody != null ? JSON.stringify(responseBody) : null,
        !!success,
        errorMessage,
        executedBy,
      ]
    );
  } catch (err) {
    logger.error({ err: err.message, action }, "inbox_ml_question: error guardando ml_api_log");
  }
}

function computeResponseTimeSec(createdAtText) {
  if (createdAtText == null || String(createdAtText).trim() === "") return null;
  const t = new Date(String(createdAtText)).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 1000);
}

/**
 * GET /api/inbox/:chatId/ml-question
 * POST /api/inbox/:chatId/ml-question/answer
 * @returns {Promise<boolean>}
 */
async function handleInboxMlQuestionRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const mGet = pathname.match(/^\/api\/inbox\/(\d+)\/ml-question$/);
  const mPost = pathname.match(/^\/api\/inbox\/(\d+)\/ml-question\/answer$/);
  if (!mGet && !mPost) return false;

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const chatId = Number((mGet || mPost)[1]);

  try {
    if (req.method === "GET" && mGet) {
      const { rows } = await pool.query(
        `SELECT
           mq.id,
           mq.ml_question_id,
           mq.item_id,
           mq.question_text,
           mq.ml_status,
           mq.ia_auto_route_detail,
           mq.buyer_id
         FROM ml_questions_pending mq
         JOIN crm_chats cc ON cc.ml_question_id = mq.ml_question_id
         WHERE cc.id = $1
         LIMIT 1`,
        [chatId]
      );
      if (!rows.length) {
        writeJson(res, 200, null);
        return true;
      }
      const mq = rows[0];
      const iaDetail = mq.ia_auto_route_detail;
      writeJson(res, 200, {
        question_id: Number(mq.ml_question_id),
        item_id: mq.item_id,
        question_text: mq.question_text,
        ml_status: mq.ml_status,
        buyer_id: mq.buyer_id != null ? Number(mq.buyer_id) : null,
        ia_already_answered: iaDetail != null,
        ia_detail: iaDetail,
      });
      return true;
    }

    if (req.method === "POST" && mPost) {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const answerText =
        body.answer_text != null && String(body.answer_text).trim() !== ""
          ? String(body.answer_text).trim()
          : "";
      const answeredBy = body.answered_by != null ? Number(body.answered_by) : NaN;
      if (!answerText) {
        writeJson(res, 400, { error: "bad_request", message: "answer_text requerido" });
        return true;
      }
      if (!Number.isFinite(answeredBy) || answeredBy <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "answered_by inválido" });
        return true;
      }

      const { rows: pendingRows } = await pool.query(
        `SELECT
           mq.ml_question_id,
           mq.ml_user_id,
           mq.id AS pending_id,
           mq.buyer_id,
           mq.item_id,
           mq.question_text,
           mq.notification_id,
           mq.date_created,
           mq.raw_json,
           mq.created_at
         FROM ml_questions_pending mq
         JOIN crm_chats cc ON cc.ml_question_id = mq.ml_question_id
         WHERE cc.id = $1`,
        [chatId]
      );
      if (!pendingRows.length) {
        writeJson(res, 404, { error: "not_found", message: "No hay pregunta ML vinculada a este chat" });
        return true;
      }
      const mq = pendingRows[0];
      const mlQuestionId = Number(mq.ml_question_id);
      const mlUserId = Number(mq.ml_user_id);
      const itemIdStr = mq.item_id != null ? String(mq.item_id) : null;

      let mlRes;
      try {
        mlRes = await mercadoLibrePostJsonForUser(mlUserId, "/answers", {
          question_id: mlQuestionId,
          text: answerText,
        });
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        logger.error({ err: msg, mlQuestionId, mlUserId }, "inbox_ml_question: excepción POST /answers");
        await logMlApiCall({
          mlItemId: itemIdStr,
          action: "inbox_post_answers",
          requestBody: { question_id: mlQuestionId, text: answerText.slice(0, 500) },
          responseCode: null,
          responseBody: null,
          success: false,
          errorMessage: msg.slice(0, 8000),
          executedBy: String(answeredBy),
        });
        writeJson(res, 502, { error: "ml_api_error", message: msg.slice(0, 2000) });
        return true;
      }

      const okHttp = mlRes.ok && (mlRes.status === 200 || mlRes.status === 201);
      if (!okHttp) {
        const errSnippet = (mlRes.rawText || "").slice(0, 8000);
        await logMlApiCall({
          mlItemId: itemIdStr,
          action: "inbox_post_answers",
          requestBody: { question_id: mlQuestionId, text: answerText.slice(0, 500) },
          responseCode: mlRes.status,
          responseBody: mlRes.data != null ? mlRes.data : mlRes.rawText,
          success: false,
          errorMessage: `HTTP ${mlRes.status} ${errSnippet}`,
          executedBy: String(answeredBy),
        });
        writeJson(res, 502, {
          error: "ml_api_error",
          status: mlRes.status,
          detail: mlRes.data != null ? mlRes.data : mlRes.rawText,
        });
        return true;
      }

      const nowIso = new Date().toISOString();
      const rts = computeResponseTimeSec(mq.created_at);

      const answeredRow = {
        ml_question_id: mlQuestionId,
        ml_user_id: mlUserId,
        item_id: mq.item_id,
        buyer_id: mq.buyer_id,
        question_text: mq.question_text,
        answer_text: answerText,
        ml_status: "ANSWERED",
        date_created: mq.date_created,
        raw_json: mq.raw_json,
        notification_id: mq.notification_id,
        pending_internal_id: mq.pending_id != null ? Number(mq.pending_id) : null,
        answered_at: nowIso,
        moved_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
        response_time_sec: rts,
      };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ml_questions_answered (
             ml_question_id, ml_user_id, item_id, buyer_id, question_text, answer_text, ml_status, date_created, raw_json, notification_id, pending_internal_id, answered_at, moved_at, created_at, updated_at, response_time_sec
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (ml_question_id) DO UPDATE SET
             ml_user_id = EXCLUDED.ml_user_id,
             item_id = EXCLUDED.item_id,
             buyer_id = EXCLUDED.buyer_id,
             question_text = EXCLUDED.question_text,
             answer_text = EXCLUDED.answer_text,
             ml_status = EXCLUDED.ml_status,
             date_created = EXCLUDED.date_created,
             raw_json = EXCLUDED.raw_json,
             notification_id = EXCLUDED.notification_id,
             pending_internal_id = EXCLUDED.pending_internal_id,
             answered_at = EXCLUDED.answered_at,
             moved_at = EXCLUDED.moved_at,
             updated_at = EXCLUDED.updated_at,
             response_time_sec = EXCLUDED.response_time_sec`,
          [
            answeredRow.ml_question_id,
            answeredRow.ml_user_id,
            answeredRow.item_id != null ? String(answeredRow.item_id) : null,
            answeredRow.buyer_id != null ? Number(answeredRow.buyer_id) : null,
            answeredRow.question_text != null ? String(answeredRow.question_text) : null,
            String(answeredRow.answer_text),
            answeredRow.ml_status != null ? String(answeredRow.ml_status) : null,
            answeredRow.date_created != null ? String(answeredRow.date_created) : null,
            answeredRow.raw_json != null ? String(answeredRow.raw_json) : null,
            answeredRow.notification_id != null ? String(answeredRow.notification_id) : null,
            answeredRow.pending_internal_id != null ? Number(answeredRow.pending_internal_id) : null,
            answeredRow.answered_at,
            answeredRow.moved_at,
            answeredRow.created_at,
            answeredRow.updated_at,
            answeredRow.response_time_sec != null && Number.isFinite(Number(answeredRow.response_time_sec))
              ? Math.floor(Number(answeredRow.response_time_sec))
              : null,
          ]
        );
        await client.query(`UPDATE ml_questions_pending SET ml_status = 'ANSWERED', updated_at = $2 WHERE ml_question_id = $1`, [
          mlQuestionId,
          nowIso,
        ]);

        const extId = `out-${crypto.randomUUID()}`;
        const { rows: chatRows } = await client.query(`SELECT customer_id FROM crm_chats WHERE id = $1`, [chatId]);
        const customerId = chatRows[0] && chatRows[0].customer_id != null ? Number(chatRows[0].customer_id) : null;

        await client.query(
          `INSERT INTO crm_messages (
             chat_id, customer_id, direction, type,
             content, sent_by, external_message_id, is_read, ai_reply_status
           ) VALUES (
             $1, $2, 'outbound', 'text',
             jsonb_build_object('text', $3::text, 'ml_question_id', $4::bigint),
             $5::text, $6, TRUE, NULL
           )`,
          [chatId, customerId, answerText, mlQuestionId, String(answeredBy), extId]
        );

        await client.query(
          `UPDATE crm_chats SET
             source_type = 'ml_message',
             last_message_text = $1,
             last_message_at = NOW(),
             ml_question_answered_at = NOW(),
             updated_at = NOW()
           WHERE id = $2`,
          [answerText.slice(0, 5000), chatId]
        );

        await client.query("COMMIT");
      } catch (dbErr) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error({ err: dbErr.message, mlQuestionId, chatId }, "inbox_ml_question: error persistiendo tras ML OK");
        await logMlApiCall({
          mlItemId: itemIdStr,
          action: "inbox_post_answers_db_error",
          requestBody: { question_id: mlQuestionId },
          responseCode: mlRes.status,
          responseBody: { db_error: dbErr.message },
          success: false,
          errorMessage: dbErr.message,
          executedBy: String(answeredBy),
        });
        writeJson(res, 500, { error: "server_error", message: "ML respondió OK pero falló la persistencia local" });
        return true;
      } finally {
        client.release();
      }

      await logMlApiCall({
        mlItemId: itemIdStr,
        action: "inbox_post_answers",
        requestBody: { question_id: mlQuestionId, text: answerText.slice(0, 500) },
        responseCode: mlRes.status,
        responseBody: mlRes.data != null ? mlRes.data : { ok: true },
        success: true,
        errorMessage: null,
        executedBy: String(answeredBy),
      });

      writeJson(res, 200, {
        success: true,
        ml_question_id: mlQuestionId,
        answer_text: answerText,
      });
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    logger.error({ err: err.message }, "inbox_ml_question: error");
    writeJson(res, 500, { error: "server_error" });
    return true;
  }
}

module.exports = { handleInboxMlQuestionRequest };
