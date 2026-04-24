"use strict";

const { pool } = require("../../db");
const { CustomerModel, rowToCustomerApi, mapSchemaError } = require("./crmIdentityService");
const inboxService = require("./inboxService");

/** Límite por defecto al listar mensajes (primera página / scroll); máximo 200 en handler. */
const DEFAULT_MESSAGES_PAGE_LIMIT = 30;

async function listChats({ q, limit, offset, needs_followup }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const params = [];
  let p = 1;

  if (q != null && String(q).trim() !== "") {
    conds.push(`(c.phone ILIKE $${p} OR cu.full_name ILIKE $${p})`);
    params.push(`%${String(q).trim()}%`);
    p += 1;
  }
  if (needs_followup === true || needs_followup === false) {
    conds.push(`c.needs_followup = $${p}`);
    params.push(needs_followup);
    p += 1;
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  try {
    const countSql = `SELECT COUNT(*)::bigint AS n FROM crm_chats c
      LEFT JOIN customers cu ON cu.id = c.customer_id ${where}`;
    const { rows: cRows } = await pool.query(countSql, params);
    const total = Number(cRows[0].n) || 0;

    const limitPos = params.length + 1;
    const offPos = params.length + 2;
    const { rows } = await pool.query(
      `SELECT c.*, cu.full_name AS customer_name, cu.phone AS customer_phone, cu.crm_status AS customer_status
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC
       LIMIT $${limitPos} OFFSET $${offPos}`,
      [...params, lim, off]
    );
    return { data: rows, meta: { total, limit: lim, offset: off } };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

/**
 * Pregunta ML respondida en ML (answered o pending ANSWERED).
 */
async function isMlQuestionAnswered(mlQuestionId) {
  if (mlQuestionId == null) return false;
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM ml_questions_answered WHERE ml_question_id = $1
       UNION ALL
       SELECT 1 FROM ml_questions_pending WHERE ml_question_id = $1 AND ml_status = 'ANSWERED'
       LIMIT 1`,
      [qid]
    );
    return rows.length > 0;
  } catch (_e) {
    return false;
  }
}

/** Alineado a inboxService.js: orden/cotización aprobada no imponen etapa `order` en ML sin identidad. */
function isChatIdentityRecognizedForStage(chat) {
  const cid = chat.customer_id != null ? Number(chat.customer_id) : NaN;
  if (Number.isFinite(cid) && cid > 0) return true;
  const s = String(chat.identity_status || "").trim();
  return s === "auto_matched" || s === "manual_linked" || s === "declared";
}

/**
 * Calcula chat_stage alineado a CHAT_STAGE_EXPR en inboxService.js (6 etapas, sin ml_answer ni approved).
 */
function computeChatStage(chat, order, extra = {}) {
  const quoteStatus =
    extra.quoteStatus != null && String(extra.quoteStatus).trim() !== ""
      ? String(extra.quoteStatus).trim()
      : null;
  const mqAns = extra.mlQuestionAnswered === true;
  const suppressErpOrderStage =
    (chat.source_type === "ml_message" || chat.source_type === "ml_question") &&
    !isChatIdentityRecognizedForStage(chat);

  if (order) {
    const st = order.status;
    if (st === "completed" || st === "cancelled") return "closed";
    if (order.payment_status === "approved" && order.fulfillment_type) return "dispatch";
    if (order.payment_status === "pending") return "payment";
    if (!suppressErpOrderStage) return "order";
  }
  if (quoteStatus === "approved" && !suppressErpOrderStage) return "order";
  if (["draft", "borrador", "sent"].includes(quoteStatus)) return "quote";
  if (chat.source_type === "ml_question") {
    return mqAns ? "quote" : "contact";
  }
  if (chat.source_type === "ml_message") return "contact";
  return "contact";
}

/** Resuelve customers.id a partir de ml_buyers.buyer_id (primary o tabla de vínculo). */
async function findCustomerIdFromMlBuyerId(mlBuyerId) {
  if (mlBuyerId == null) return null;
  const bid = Number(mlBuyerId);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT c.id AS customer_id
       FROM customers c
       WHERE c.primary_ml_buyer_id = $1
       LIMIT 1`,
      [bid]
    );
    if (rows.length) return Number(rows[0].customer_id);
    const r2 = await pool.query(
      `SELECT cmb.customer_id
       FROM customer_ml_buyers cmb
       WHERE cmb.ml_buyer_id = $1
       LIMIT 1`,
      [bid]
    );
    if (r2.rows.length) return Number(r2.rows[0].customer_id);
  } catch (_e) {
    /* tablas opcionales */
  }
  return null;
}

/** buyer_id de la pregunta ML (pending o answered). */
async function findMlQuestionBuyerId(mlQuestionId) {
  if (mlQuestionId == null) return null;
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT buyer_id FROM ml_questions_pending WHERE ml_question_id = $1
       UNION ALL
       SELECT buyer_id FROM ml_questions_answered WHERE ml_question_id = $1
       LIMIT 1`,
      [qid]
    );
    if (!rows.length || rows[0].buyer_id == null) return null;
    const b = Number(rows[0].buyer_id);
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch (_e) {
    return null;
  }
}

async function getChatContext(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [id]);
    if (!rows.length) return null;
    const chat = rows[0];

    // Customer directo del chat + orden vinculada (conversation_id o ml_order_id = sales_orders.id)
    const [customerResult, orderResult] = await Promise.all([
      chat.customer_id
        ? CustomerModel.getWithVehicles(chat.customer_id).catch(() => null)
        : Promise.resolve(null),
      pool.query(
        `SELECT so.id, so.payment_status::text AS payment_status, so.fulfillment_type,
                so.channel_id, so.status, so.customer_id
         FROM sales_orders so
         WHERE (so.conversation_id = $1
                OR ($2::bigint IS NOT NULL AND so.id = $2::bigint))
         ORDER BY
           CASE WHEN so.conversation_id = $1 THEN 0 ELSE 1 END,
           so.created_at DESC NULLS LAST
         LIMIT 1`,
        [id, chat.ml_order_id ?? null]
      ).catch(() => ({ rows: [] })),
    ]);

    let customer = null;
    let vehicles = [];
    if (customerResult) {
      const { vehicles: v, ...cust } = customerResult;
      customer = rowToCustomerApi(cust);
      vehicles = Array.isArray(v) ? v : [];
    }

    let order = null;
    const orderRows = orderResult.rows ?? [];
    if (orderRows.length) {
      const r = orderRows[0];
      order = {
        id: Number(r.id),
        payment_status: r.payment_status,
        fulfillment_type: r.fulfillment_type,
        channel_id: r.channel_id != null ? Number(r.channel_id) : null,
        status: r.status ?? null,
        customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      };
    }

    // Resolver cliente para la ficha aunque crm_chats.customer_id sea NULL:
    // orden ERP → buyer ML del chat → buyer de la pregunta ML.
    let resolvedCustomerId =
      chat.customer_id != null ? Number(chat.customer_id) : null;
    if (!resolvedCustomerId && order && order.customer_id) {
      resolvedCustomerId = order.customer_id;
    }
    if (!resolvedCustomerId && chat.ml_buyer_id != null) {
      resolvedCustomerId = await findCustomerIdFromMlBuyerId(chat.ml_buyer_id);
    }
    if (!resolvedCustomerId && chat.ml_question_id != null) {
      const bid = await findMlQuestionBuyerId(chat.ml_question_id);
      if (bid) resolvedCustomerId = await findCustomerIdFromMlBuyerId(bid);
    }

    if (!customer && resolvedCustomerId) {
      const withV = await CustomerModel.getWithVehicles(resolvedCustomerId).catch(() => null);
      if (withV) {
        const { vehicles: v, ...cust } = withV;
        customer = rowToCustomerApi(cust);
        vehicles = Array.isArray(v) ? v : [];
      }
    }

    const [mlQuestionAnswered, quoteIq, customer_waiting_reply] = await Promise.all([
      chat.source_type === "ml_question" && chat.ml_question_id
        ? isMlQuestionAnswered(chat.ml_question_id)
        : Promise.resolve(false),
      pool
        .query(
          `SELECT ip2.status AS quote_status
           FROM inventario_presupuesto ip2
           WHERE ip2.chat_id = $1 AND ip2.status NOT IN ('converted', 'expired')
           ORDER BY ip2.fecha_creacion DESC NULLS LAST
           LIMIT 1`,
          [id]
        )
        .catch(() => ({ rows: [] })),
      inboxService.getCustomerWaitingReplyForChat(id),
    ]);

    // Ventana de mensajería estándar Facebook (24 h desde último inbound).
    // fb_window_expires_at: ISO timestamp o null; el frontend lo usa para bloquear el input.
    let fb_window_expires_at = null;
    if (chat.source_type === "fb_page" && chat.last_inbound_at) {
      const t = new Date(chat.last_inbound_at);
      if (!Number.isNaN(t.getTime())) {
        fb_window_expires_at = new Date(t.getTime() + 24 * 60 * 60 * 1000).toISOString();
      }
    }

    const chatOut = {
      ...(resolvedCustomerId != null
        ? { ...chat, customer_id: resolvedCustomerId }
        : { ...chat }),
      customer_waiting_reply: customer_waiting_reply === true,
      fb_window_expires_at,
    };
    const quoteStatus = quoteIq.rows?.[0]?.quote_status ?? null;

    const chat_stage = computeChatStage(chat, order, {
      mlQuestionAnswered,
      quoteStatus,
    });

    return { chat: chatOut, chat_stage, customer, vehicles, order };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function listMessages(chatId, { before_id, limit } = {}) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const lim = Math.min(
    Math.max(Number(limit) || DEFAULT_MESSAGES_PAGE_LIMIT, 1),
    200
  );
  const before =
    before_id != null && String(before_id).trim() !== ""
      ? Number(before_id)
      : null;

  try {
    const params = [cid];
    let cond = "chat_id = $1";
    if (before != null && Number.isFinite(before) && before > 0) {
      cond += ` AND id < $2`;
      params.push(before);
    }
    const limPos = params.length + 1;
    const fetchLimit = lim + 1;
    const { rows: rawRows } = await pool.query(
      `SELECT * FROM crm_messages WHERE ${cond} ORDER BY id DESC LIMIT $${limPos}`,
      [...params, fetchLimit]
    );
    const has_more = rawRows.length > lim;
    const rows = has_more ? rawRows.slice(0, lim) : rawRows;
    const next_before_id = rows.length ? rows[rows.length - 1].id : null;
    return {
      data: rows.reverse(),
      meta: {
        limit: lim,
        before_id: before,
        next_before_id: has_more ? next_before_id : null,
        has_more,
      },
    };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

/**
 * Pone unread_count en 0 (p. ej. al abrir el chat y cargar la última página).
 * @param {number|string} chatId
 */
async function markChatRead(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    await pool.query(
      `UPDATE crm_chats SET unread_count = 0, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function patchChat(chatId, patch) {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const sets = [];
  const vals = [];
  let n = 1;

  if (patch.needs_followup !== undefined) {
    sets.push(`needs_followup = $${n++}`);
    vals.push(Boolean(patch.needs_followup));
  }
  if (patch.unread_count !== undefined) {
    sets.push(`unread_count = $${n++}`);
    vals.push(Math.max(0, Number(patch.unread_count) || 0));
  }
  if (patch.is_ai_generating !== undefined) {
    sets.push(`is_ai_generating = $${n++}`);
    vals.push(Boolean(patch.is_ai_generating));
  }

  if (sets.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  vals.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE crm_chats SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${n} RETURNING *`,
      vals
    );
    return rows[0] || null;
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function getWaStatus() {
  try {
    const { rows: s } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_chats,
         COUNT(*) FILTER (WHERE wa_session_ok)::int AS sessions_ok,
         COUNT(*) FILTER (WHERE NOT wa_session_ok)::int AS sessions_down,
         COALESCE(SUM(unread_count), 0)::bigint AS total_unread
       FROM crm_chats`
    );
    const { rows: ev } = await pool.query(
      `SELECT id, event_type, payload, is_critical, created_at
       FROM crm_system_events
       WHERE event_type IN ('session.status', 'processor_error:messages.received')
          OR event_type LIKE 'processor_error:%'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    return {
      summary: s[0] || {},
      recent_events: ev,
    };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

module.exports = {
  listChats,
  getChatContext,
  listMessages,
  markChatRead,
  patchChat,
  getWaStatus,
  DEFAULT_MESSAGES_PAGE_LIMIT,
};
