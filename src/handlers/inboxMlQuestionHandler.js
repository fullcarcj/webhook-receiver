"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool, upsertMlListing, upsertMlQuestionPending } = require("../../db");
const { upsertMlQuestionChat } = require("../services/mlInboxBridge");
const { mercadoLibrePostJsonForUser, mercadoLibreFetchForUser } = require("../../oauth-token");
const { listingRowFromMlItemApi } = require("../../ml-listing-map");
const { refreshMlQuestionFromApi } = require("../../ml-question-refresh");

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
 * POST /api/inbox/ml-question/artificial — pregunta de prueba en BD + CRM sin SSE ni sonido (ingesta silenciosa)
 * @returns {Promise<boolean>}
 */
async function handleInboxMlQuestionRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const isArtificial = pathname === "/api/inbox/ml-question/artificial";

  const mGet = pathname.match(/^\/api\/inbox\/(\d+)\/ml-question$/);
  const mPost = pathname.match(/^\/api\/inbox\/(\d+)\/ml-question\/answer$/);
  if (!isArtificial && !mGet && !mPost) return false;

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  if (isArtificial) {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (_e) {
      writeJson(res, 400, { error: "invalid_json" });
      return true;
    }
    const mlQuestionId = Number(body.ml_question_id);
    const mlUserId = Number(body.ml_user_id);
    if (!Number.isFinite(mlQuestionId) || mlQuestionId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "ml_question_id entero positivo requerido" });
      return true;
    }
    if (!Number.isFinite(mlUserId) || mlUserId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "ml_user_id entero positivo requerido" });
      return true;
    }
    const questionText =
      body.question_text != null && String(body.question_text).trim() !== ""
        ? String(body.question_text).trim()
        : "Pregunta artificial (sin aviso en vivo).";
    const itemId =
      body.item_id != null && String(body.item_id).trim() !== ""
        ? String(body.item_id).trim()
        : null;
    const buyerIdRaw = body.buyer_id;
    const buyerId =
      buyerIdRaw != null && String(buyerIdRaw).trim() !== "" && Number.isFinite(Number(buyerIdRaw))
        ? Number(buyerIdRaw)
        : null;
    const dateCreated =
      body.date_created != null && String(body.date_created).trim() !== ""
        ? String(body.date_created).trim()
        : new Date().toISOString();
    const createdBy =
      user.id != null
        ? `user_id:${user.id}`
        : user.username != null
          ? String(user.username)
          : user.email != null
            ? String(user.email)
            : "unknown";
    const iaDetail = JSON.stringify({
      route: "artificial_silent",
      human:
        "Ingreso vía POST /api/inbox/ml-question/artificial: sin broadcast SSE, unread_count sin incremento por ingesta, excluida de IA automática POST /answers.",
      created_by: createdBy,
      created_at_utc: new Date().toISOString(),
    });
    const pendingRow = {
      ml_question_id: mlQuestionId,
      ml_user_id: mlUserId,
      item_id: itemId,
      buyer_id: buyerId,
      question_text: questionText,
      ml_status: "UNANSWERED",
      date_created: dateCreated,
      raw_json: JSON.stringify({
        id: mlQuestionId,
        status: "UNANSWERED",
        text: questionText,
        artificial: true,
        silent_ingest: true,
      }),
      notification_id: "artificial",
      ia_auto_route_detail: iaDetail,
    };
    try {
      await upsertMlQuestionPending(pendingRow);
      const { chatId } = await upsertMlQuestionChat(pendingRow, null, { silent: true });
      if (!chatId) {
        writeJson(res, 422, {
          error: "chat_not_created",
          message: "No se creó chat (p. ej. whitelist de teléfono o datos inválidos).",
        });
        return true;
      }
      logger.info(
        { ml_question_id: mlQuestionId, ml_user_id: mlUserId, chat_id: chatId, created_by: createdBy },
        "inbox_ml_question: artificial silent creada"
      );
      writeJson(res, 201, {
        ok: true,
        ml_question_id: mlQuestionId,
        chat_id: chatId,
        silent: true,
      });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      logger.error({ err: msg, mlQuestionId, mlUserId }, "inbox_ml_question: artificial falló");
      writeJson(res, 500, { error: "server_error", message: msg.slice(0, 2000) });
    }
    return true;
  }

  const chatId = Number((mGet || mPost)[1]);

  try {
    if (req.method === "GET" && mGet) {
      const mqJoinSql = `
        SELECT
           mq.ml_question_id,
           mq.ml_user_id,
           mq.item_id,
           mq.question_text,
           mq.ml_status,
           mq.ia_auto_route_detail,
           mq.buyer_id,
           mq.date_created,
           li.title           AS item_title,
           li.price           AS item_price,
           li.currency_id     AS item_currency,
           li.status          AS item_status,
           li.available_quantity AS item_stock,
           li.sold_quantity   AS item_sold,
           li.permalink       AS item_permalink,
           li.thumbnail       AS item_thumbnail,
           li.category_id     AS item_category
         FROM (
           SELECT ml_question_id, ml_user_id, item_id, question_text, ml_status,
                  ia_auto_route_detail, buyer_id, date_created
             FROM ml_questions_pending
           UNION ALL
           SELECT ml_question_id, ml_user_id, item_id, question_text, ml_status,
                  NULL AS ia_auto_route_detail, buyer_id, date_created
             FROM ml_questions_answered
         ) mq
         JOIN crm_chats cc ON cc.ml_question_id = mq.ml_question_id
         LEFT JOIN ml_listings li ON li.item_id = mq.item_id
         WHERE cc.id = $1
         ORDER BY mq.ml_question_id DESC
         LIMIT 1`;
      let { rows } = await pool.query(mqJoinSql, [chatId]);
      if (!rows.length) {
        const { rows: chatRows } = await pool.query(
          `SELECT ml_question_id FROM crm_chats WHERE id = $1`, [chatId]
        );
        if (!chatRows.length || chatRows[0].ml_question_id == null) {
          writeJson(res, 200, null);
          return true;
        }
        const mlQid = Number(chatRows[0].ml_question_id);
        let bootstrap = { reason: "no_question_row_in_db", ml_question_id: mlQid };
        try {
          const fr = await refreshMlQuestionFromApi({ mlQuestionId: mlQid });
          bootstrap.refresh = {
            ok: fr.ok,
            action: fr.action,
            error: fr.error,
            http_status: fr.http_status,
            skipped: fr.skipped,
            probe_accounts_tried: fr.probe_accounts_tried,
            ml_accounts_count: fr.ml_accounts_count,
            hinted_ml_user_ids: fr.hinted_ml_user_ids,
            hinted_missing_from_ml_accounts: fr.hinted_missing_from_ml_accounts,
          };
          if (fr.ok) {
            const r2 = await pool.query(mqJoinSql, [chatId]);
            rows = r2.rows;
          }
        } catch (e) {
          bootstrap.sync_error = e && e.message ? String(e.message) : String(e);
          bootstrap.refresh = { ok: false, error: bootstrap.sync_error };
          logger.warn({ err: bootstrap.sync_error, chatId, mlQid }, "inbox_ml_question: sync pregunta ML falló");
        }
        if (!rows.length) {
          writeJson(res, 200, {
            question_id: mlQid,
            item_id: null,
            question_text: null,
            ml_status: null,
            buyer_id: null,
            date_created: null,
            ia_already_answered: false,
            ia_detail: null,
            item_listing: null,
            _sync_debug: {
              attempted: true,
              reason: "no_question_row_in_db",
              ...bootstrap,
            },
          });
          return true;
        }
      }
      const mq = rows[0];
      const iaDetail = mq.ia_auto_route_detail;

      // Si la publicación no está en ml_listings, descargarla desde ML y guardarla
      let itemListing = mq.item_title != null
        ? {
            title:     mq.item_title,
            price:     mq.item_price != null ? Number(mq.item_price) : null,
            currency:  mq.item_currency,
            status:    mq.item_status,
            stock:     mq.item_stock != null ? Number(mq.item_stock) : null,
            sold:      mq.item_sold  != null ? Number(mq.item_sold)  : null,
            permalink: mq.item_permalink,
            thumbnail: mq.item_thumbnail,
            category:  mq.item_category,
          }
        : null;

      let listingSyncDebug = null;
      if (itemListing === null && mq.item_id && mq.ml_user_id) {
        const itemIdStr = String(mq.item_id).trim();
        try {
          const mlRes = await mercadoLibreFetchForUser(
            Number(mq.ml_user_id),
            `/items/${itemIdStr}`
          );
          listingSyncDebug = { attempted: true, status: mlRes.status, ok: mlRes.ok };
          if (mlRes.ok && mlRes.data && typeof mlRes.data === "object") {
            const row = listingRowFromMlItemApi(Number(mq.ml_user_id), mlRes.data);
            if (row) {
              await upsertMlListing(row);
              itemListing = {
                title:     row.title,
                price:     row.price != null ? Number(row.price) : null,
                currency:  row.currency_id,
                status:    row.status,
                stock:     row.available_quantity != null ? Number(row.available_quantity) : null,
                sold:      row.sold_quantity != null ? Number(row.sold_quantity) : null,
                permalink: row.permalink,
                thumbnail: row.thumbnail,
                category:  row.category_id,
              };
              listingSyncDebug.saved = true;
            } else {
              listingSyncDebug.error = "listingRowFromMlItemApi returned null";
            }
          } else {
            const snippet = mlRes.rawText ? String(mlRes.rawText).slice(0, 300) : "(sin body)";
            listingSyncDebug.error = `ML HTTP ${mlRes.status}: ${snippet}`;
            logger.warn(
              { itemId: itemIdStr, mlUserId: mq.ml_user_id, status: mlRes.status, body: snippet },
              "inbox_ml_question: no se pudo descargar la publicación desde ML"
            );
          }
        } catch (fetchErr) {
          listingSyncDebug = { attempted: true, error: fetchErr.message };
          logger.warn(
            { err: fetchErr.message, itemId: itemIdStr },
            "inbox_ml_question: error descargando publicación ML"
          );
        }
      } else if (itemListing === null) {
        listingSyncDebug = { attempted: false, reason: !mq.item_id ? "no_item_id" : "no_ml_user_id" };
      }

      writeJson(res, 200, {
        question_id: Number(mq.ml_question_id),
        item_id: mq.item_id,
        question_text: mq.question_text,
        ml_status: mq.ml_status,
        buyer_id: mq.buyer_id != null ? Number(mq.buyer_id) : null,
        date_created: mq.date_created ?? null,
        ia_already_answered: iaDetail != null,
        ia_detail: iaDetail,
        _sync_debug: listingSyncDebug,
        item_listing: itemListing,
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
      // answered_by puede ser user_id numérico o rol/username string
      const answeredByRaw = body.answered_by != null ? String(body.answered_by).trim() : "";
      if (!answerText) {
        writeJson(res, 400, { error: "bad_request", message: "answer_text requerido" });
        return true;
      }
      if (!answeredByRaw) {
        writeJson(res, 400, { error: "bad_request", message: "answered_by requerido" });
        return true;
      }
      // Para la llamada a ML necesitamos el ml_user_id numérico de la cuenta vendedora (no del agente)
      const answeredBy = answeredByRaw;

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
