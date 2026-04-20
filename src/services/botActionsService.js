"use strict";

const { pool } = require("../../db");

/**
 * Registra una acción automática del bot para auditoría y trazabilidad.
 * Alimenta el "Log de automatización" del mockup definido en ADR-009
 * (docs/adr/ADR-009-handoff-bot-humano-acoplamiento.md).
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

const SELECT_COLS = `
  id, chat_id, order_id, action_type, input_context, output_result,
  provider, confidence, duration_ms, correlation_id,
  is_reviewed, is_correct, reviewed_by, reviewed_at,
  created_at
`;

async function getByChat(chatId, {
  limit = 50,
  offset = 0,
  reviewed = null,
  since = null,
  actionType = null,
} = {}) {
  const params = [chatId];
  const conds  = [`chat_id = $1`];
  let p = 2;

  if (reviewed !== null) {
    conds.push(`is_reviewed = $${p++}`);
    params.push(reviewed);
  }
  if (since) {
    conds.push(`created_at >= $${p++}`);
    params.push(since);
  }
  if (actionType) {
    conds.push(`action_type = $${p++}`);
    params.push(actionType);
  }

  params.push(Math.min(limit, 200), offset);

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM bot_actions
     WHERE ${conds.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${p++} OFFSET $${p}`,
    params
  );
  return rows;
}

async function getByOrder(orderId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM bot_actions
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orderId, limit, offset]
  );
  return rows;
}

/**
 * Marca una acción del bot como revisada por el supervisor (BE-2.6).
 * @param {number} id
 * @param {{ isCorrect: boolean, reviewedBy: number|null, note: string|null }} params
 * @returns {Promise<boolean>} true si la fila fue actualizada
 */
async function review(id, { isCorrect, reviewedBy, note }, client = null) {
  const db = client || pool;

  const { rowCount } = await db.query(
    `UPDATE bot_actions
     SET is_reviewed = TRUE,
         is_correct  = $1,
         reviewed_by = $2,
         reviewed_at = NOW()
     WHERE id = $3`,
    [isCorrect, reviewedBy, id]
  );

  if (rowCount > 0 && isCorrect === false && note) {
    await db.query(
      `UPDATE bot_actions
       SET output_result = COALESCE(output_result, '{}'::jsonb)
                        || jsonb_build_object('supervisor_note', $1)
       WHERE id = $2`,
      [note, id]
    );
  }

  return rowCount > 0;
}

/**
 * Cola de revisión del supervisor: acciones sin revisar en las últimas N horas.
 * BE-2.6 / Tarea 5.
 */
async function listUnreviewed({ limit = 50, since = null } = {}) {
  const sinceTs = since || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM bot_actions
     WHERE is_reviewed = FALSE
       AND created_at >= $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sinceTs, Math.min(limit, 200)]
  );
  return rows;
}

module.exports = { log, getByChat, getByOrder, review, listUnreviewed };
