"use strict";

const pino = require("pino");
const sseBroker = require("../realtime/sseBroker");
const slaTimerManager = require("./slaTimerManager");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "omnichannel_outbound",
});

/**
 * Tras insert outbound en crm_messages y actualizar last_message_* del chat.
 * @param {import('pg').Pool} pool
 * @param {number} chatId
 */
async function applyOutboundOmnichannelHook(pool, chatId) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  try {
    const { rows } = await pool.query(
      `SELECT status, assigned_to FROM crm_chats WHERE id = $1`,
      [cid]
    );
    const currentStatus = rows[0]?.status;
    if (currentStatus === "PENDING_RESPONSE" || currentStatus === "RE_OPENED") {
      await pool.query(
        `UPDATE crm_chats
         SET status = 'ATTENDED',
             last_outbound_at = NOW(),
             sla_deadline_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [cid]
      );
      slaTimerManager.cancel(cid);
      sseBroker.broadcast("chat_attended", {
        chat_id: cid,
        user_id:
          rows[0].assigned_to != null ? Number(rows[0].assigned_to) : null,
      });
    } else {
      await pool.query(`UPDATE crm_chats SET last_outbound_at = NOW() WHERE id = $1`, [cid]);
    }
  } catch (e) {
    logger.error({ err: e }, "[omnichannel] outbound hook error");
  }
}

module.exports = { applyOutboundOmnichannelHook };
