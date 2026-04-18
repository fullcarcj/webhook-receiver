"use strict";

const { pool } = require("../../db");

/**
 * Verifica si un chat tiene handoff humano activo.
 * Activo = existe fila en bot_handoffs con ended_at IS NULL.
 *
 * @param {number} chatId
 * @param {Object} [client] - pg client opcional para transacción externa
 * @returns {Promise<{active: boolean, handoff: Object|null}>}
 */
async function isHandedOver(chatId, client = null) {
  if (!chatId) return { active: false, handoff: null };

  const db = client || pool;
  const { rows, rowCount } = await db.query(
    `SELECT id, chat_id, to_user_id, started_at, ended_at, reason
     FROM bot_handoffs
     WHERE chat_id = $1
       AND ended_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1`,
    [chatId]
  );

  if (rowCount === 0) return { active: false, handoff: null };
  return { active: true, handoff: rows[0] };
}

/**
 * Registra la apertura de un handoff (bot → vendedor).
 * Usado por el endpoint BE-1.6 take-over.
 */
async function openHandoff({ chatId, toUserId, reason = null }, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `INSERT INTO bot_handoffs (chat_id, to_user_id, reason)
     VALUES ($1, $2, $3)
     RETURNING id, chat_id, to_user_id, started_at`,
    [chatId, toUserId, reason]
  );
  return rows[0];
}

/**
 * Cierra el handoff activo de un chat (vendedor → bot).
 * Usado por el endpoint BE-1.7 return-to-bot.
 */
async function closeHandoff(chatId, client = null) {
  const db = client || pool;
  const { rows, rowCount } = await db.query(
    `UPDATE bot_handoffs
     SET ended_at = NOW()
     WHERE chat_id = $1
       AND ended_at IS NULL
     RETURNING id, chat_id, ended_at`,
    [chatId]
  );
  return rowCount > 0 ? rows[0] : null;
}

module.exports = { isHandedOver, openHandoff, closeHandoff };
