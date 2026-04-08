"use strict";

const { pool } = require("../../db");
const { CustomerModel, rowToCustomerApi, mapSchemaError } = require("./crmIdentityService");

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

    let customer = null;
    let vehicles = [];
    if (chat.customer_id) {
      const withV = await CustomerModel.getWithVehicles(chat.customer_id);
      if (withV) {
        const { vehicles: v, ...cust } = withV;
        customer = rowToCustomerApi(cust);
        vehicles = Array.isArray(v) ? v : [];
      }
    }

    return { chat, customer, vehicles };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function listMessages(chatId, { before_id, limit }) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
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
    const { rows } = await pool.query(
      `SELECT * FROM crm_messages WHERE ${cond} ORDER BY id DESC LIMIT $${limPos}`,
      [...params, lim]
    );
    const next_before_id = rows.length ? rows[rows.length - 1].id : null;
    return {
      data: rows.reverse(),
      meta: { limit: lim, before_id: before, next_before_id },
    };
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
  patchChat,
  getWaStatus,
};
