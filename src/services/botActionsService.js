"use strict";

const { pool } = require("../../db");

/**
 * Registra una acción automática del bot para auditoría y trazabilidad.
 * Alimenta el "Log de automatización" del mockup (ADR-009).
 *
 * @param {Object} params
 * @param {number|null}  params.chatId
 * @param {number|null}  params.orderId
 * @param {string}       params.actionType   - uno de los valores del CHECK
 * @param {Object|null}  params.inputContext
 * @param {Object|null}  params.outputResult
 * @param {string|null}  params.provider     - 'groq-llama' | 'rule_engine' | 'human' | etc
 * @param {number|null}  params.confidence   - 0.00 a 1.00
 * @param {number|null}  params.durationMs
 * @param {string|null}  params.correlationId
 * @param {Object}       [client]            - pg client opcional para transacción externa
 * @returns {Promise<number>} id de la acción registrada
 */
async function log({
  chatId       = null,
  orderId      = null,
  actionType,
  inputContext = null,
  outputResult = null,
  provider     = null,
  confidence   = null,
  durationMs   = null,
  correlationId = null,
}, client = null) {
  const db = client || pool;
  const res = await db.query(
    `INSERT INTO bot_actions
       (chat_id, order_id, action_type, input_context, output_result,
        provider, confidence, duration_ms, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      chatId,
      orderId,
      actionType,
      inputContext  ? JSON.stringify(inputContext)  : null,
      outputResult  ? JSON.stringify(outputResult)  : null,
      provider,
      confidence,
      durationMs,
      correlationId,
    ]
  );
  return res.rows[0].id;
}

async function getByChat(chatId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, chat_id, order_id, action_type, input_context, output_result,
            provider, confidence, duration_ms, correlation_id, created_at
     FROM bot_actions
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [chatId, limit, offset]
  );
  return rows;
}

async function getByOrder(orderId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, chat_id, order_id, action_type, input_context, output_result,
            provider, confidence, duration_ms, correlation_id, created_at
     FROM bot_actions
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orderId, limit, offset]
  );
  return rows;
}

module.exports = { log, getByChat, getByOrder };
