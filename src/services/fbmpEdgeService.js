"use strict";

const pino = require("pino");
const { pool } = require("../../db");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "fbmp_edge" });

/**
 * Upsert de hilo + crm_chat asociado.
 * Si ya existe el thread, actualiza participant_name y last_scraped_at.
 * Si no existe el crm_chat, lo crea con source_type = 'fbmp_edge'.
 *
 * @param {object} params
 * @param {string} params.externalThreadId — ID o slug de la URL del hilo
 * @param {string} [params.participantName]
 * @param {string} [params.participantFbId]
 * @returns {Promise<{ threadId: number, chatId: number, created: boolean }>}
 */
async function upsertThread({ externalThreadId, participantName, participantFbId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Buscar hilo existente
    const { rows: existing } = await client.query(
      `SELECT id, chat_id FROM fbmp_edge_threads WHERE external_thread_id = $1 LIMIT 1`,
      [externalThreadId]
    );

    let threadId, chatId, created;

    if (existing.length) {
      threadId = existing[0].id;
      chatId   = existing[0].chat_id;
      created  = false;
      await client.query(
        `UPDATE fbmp_edge_threads
         SET participant_name  = COALESCE($2, participant_name),
             participant_fb_id = COALESCE($3, participant_fb_id),
             last_scraped_at   = NOW(),
             updated_at        = NOW()
         WHERE id = $1`,
        [threadId, participantName ?? null, participantFbId ?? null]
      );
    } else {
      // Crear crm_chat con phone ficticio único basado en externalThreadId
      const syntheticPhone = `fbmp_${String(externalThreadId).replace(/\W/g, "").slice(0, 40)}`;
      const { rows: chatRows } = await client.query(
        `INSERT INTO crm_chats
           (phone, source_type, last_message_at, created_at, updated_at)
         VALUES ($1, 'fbmp_edge', NOW(), NOW(), NOW())
         ON CONFLICT (phone) DO UPDATE
           SET updated_at = NOW()
         RETURNING id`,
        [syntheticPhone]
      );
      chatId = chatRows[0].id;

      const { rows: threadRows } = await client.query(
        `INSERT INTO fbmp_edge_threads
           (external_thread_id, participant_name, participant_fb_id, chat_id, last_scraped_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
         RETURNING id`,
        [externalThreadId, participantName ?? null, participantFbId ?? null, chatId]
      );
      threadId = threadRows[0].id;
      created  = true;

      log.info({ threadId, chatId, externalThreadId }, "fbmp_edge: hilo nuevo creado");
    }

    await client.query("COMMIT");
    return { threadId, chatId, created };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ingesta batch de mensajes de la extensión Chrome.
 * Inserta en fbmp_edge_raw_ingest con dedupe, luego promueve a crm_messages.
 *
 * @param {object} params
 * @param {number} params.threadId
 * @param {number} params.chatId
 * @param {Array<{ direction: string, body: string, dedupe_key: string, occurred_at?: string }>} params.messages
 * @returns {Promise<{ inserted: number, duplicates: number, errors: number }>}
 */
async function ingestMessages({ threadId, chatId, messages }) {
  let inserted = 0, duplicates = 0, errors = 0;

  for (const msg of messages) {
    if (!msg.body || !msg.dedupe_key || !msg.direction) {
      errors++;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: rawRows } = await client.query(
        `INSERT INTO fbmp_edge_raw_ingest
           (thread_id, direction, body, dedupe_key, occurred_at, processed, created_at)
         VALUES ($1, $2, $3, $4, $5, FALSE, NOW())
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [
          threadId,
          msg.direction,
          String(msg.body).slice(0, 4096),
          msg.dedupe_key,
          msg.occurred_at ? new Date(msg.occurred_at) : null,
        ]
      );

      if (!rawRows.length) {
        duplicates++;
        await client.query("ROLLBACK");
        continue;
      }

      const rawId = rawRows[0].id;

      // Promover a crm_messages
      const extMsgId = `fbmp_${msg.dedupe_key}`;
      const content  = JSON.stringify({ text: String(msg.body).slice(0, 4096) });
      const { rows: crmRows } = await client.query(
        `INSERT INTO crm_messages
           (chat_id, external_message_id, direction, type, content, is_read, created_at)
         VALUES ($1, $2, $3, 'text', $4::jsonb, $5, COALESCE($6::timestamptz, NOW()))
         ON CONFLICT (external_message_id) DO NOTHING
         RETURNING id`,
        [
          chatId,
          extMsgId,
          msg.direction,
          content,
          msg.direction === "outbound",
          msg.occurred_at ? new Date(msg.occurred_at) : null,
        ]
      );

      const crmMsgId = crmRows[0]?.id ?? null;

      // Marcar raw como procesado
      await client.query(
        `UPDATE fbmp_edge_raw_ingest
         SET processed = TRUE, processed_at = NOW(), crm_message_id = $2
         WHERE id = $1`,
        [rawId, crmMsgId]
      );

      // Actualizar crm_chat con último mensaje
      await client.query(
        `UPDATE crm_chats
         SET last_message_at   = NOW(),
             last_message_text = $2,
             unread_count      = CASE WHEN $3::text = 'inbound' THEN unread_count + 1 ELSE unread_count END,
             updated_at        = NOW()
         WHERE id = $1`,
        [chatId, String(msg.body).slice(0, 120), msg.direction]
      );

      await client.query("COMMIT");
      inserted++;
    } catch (err) {
      await client.query("ROLLBACK");
      log.error({ err: err.message, dedupe_key: msg.dedupe_key }, "fbmp_edge: error insertando mensaje");
      errors++;
    } finally {
      client.release();
    }
  }

  return { inserted, duplicates, errors };
}

/**
 * Obtiene mensajes pendientes de envío para un hilo (la extensión los recoge vía polling).
 * @param {string} externalThreadId
 * @returns {Promise<Array>}
 */
async function getPendingOutbox(externalThreadId) {
  const { rows } = await pool.query(
    `SELECT ob.id, ob.body, ob.created_at
     FROM fbmp_edge_outbox ob
     JOIN fbmp_edge_threads t ON t.id = ob.thread_id
     WHERE t.external_thread_id = $1
       AND ob.status = 'queued'
     ORDER BY ob.created_at ASC
     LIMIT 20`,
    [externalThreadId]
  );
  return rows;
}

/**
 * Obtiene todos los mensajes pendientes para cualquier hilo (la extensión puede pedirlos todos).
 * @returns {Promise<Array>}
 */
async function getAllPendingOutbox() {
  const { rows } = await pool.query(
    `SELECT ob.id, ob.body, ob.created_at, t.external_thread_id
     FROM fbmp_edge_outbox ob
     JOIN fbmp_edge_threads t ON t.id = ob.thread_id
     WHERE ob.status = 'queued'
     ORDER BY ob.created_at ASC
     LIMIT 50`
  );
  return rows;
}

/**
 * Encola un mensaje de salida desde el ERP.
 * @param {object} params
 * @param {number} params.threadId
 * @param {string} params.body
 * @param {string} [params.sentBy]
 * @param {number} [params.userId]
 * @returns {Promise<number>} id del registro en outbox
 */
async function enqueueOutbox({ threadId, body, sentBy, userId }) {
  const { rows } = await pool.query(
    `INSERT INTO fbmp_edge_outbox (thread_id, body, status, sent_by, created_by_user_id, created_at)
     VALUES ($1, $2, 'queued', $3, $4, NOW())
     RETURNING id`,
    [threadId, String(body).slice(0, 4096), sentBy ?? null, userId ?? null]
  );
  return rows[0].id;
}

/**
 * Ack: la extensión confirmó que envió el mensaje.
 * @param {number} outboxId
 * @returns {Promise<boolean>}
 */
async function ackOutboxMessage(outboxId) {
  const { rowCount } = await pool.query(
    `UPDATE fbmp_edge_outbox
     SET status = 'sent', sent_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [outboxId]
  );
  return rowCount > 0;
}

/**
 * Marca un mensaje de outbox como fallido.
 * @param {number} outboxId
 * @param {string} [errorMessage]
 */
async function failOutboxMessage(outboxId, errorMessage) {
  await pool.query(
    `UPDATE fbmp_edge_outbox
     SET status = 'failed', failed_at = NOW(), error_message = $2
     WHERE id = $1 AND status = 'queued'`,
    [outboxId, errorMessage ?? null]
  );
}

/**
 * Listado de hilos para la vista admin.
 * @param {{ limit?: number, offset?: number }} opts
 */
async function listThreads({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT
       t.id, t.external_thread_id, t.participant_name, t.participant_fb_id,
       t.chat_id, t.customer_id, t.last_scraped_at, t.created_at,
       c.full_name AS customer_name,
       ch.unread_count, ch.last_message_text, ch.last_message_at
     FROM fbmp_edge_threads t
     LEFT JOIN customers c  ON c.id  = t.customer_id
     LEFT JOIN crm_chats ch ON ch.id = t.chat_id
     ORDER BY t.last_scraped_at DESC NULLS LAST, t.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

/**
 * Stats rápidas del módulo.
 */
async function getStats() {
  const [threads, pendingIngest, pendingOutbox] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM fbmp_edge_threads`),
    pool.query(`SELECT COUNT(*)::int AS c FROM fbmp_edge_raw_ingest WHERE processed = FALSE`),
    pool.query(`SELECT COUNT(*)::int AS c FROM fbmp_edge_outbox WHERE status = 'queued'`),
  ]).catch(() => [{ rows: [{ c: 0 }] }, { rows: [{ c: 0 }] }, { rows: [{ c: 0 }] }]);

  return {
    threads:        threads.rows[0]?.c  ?? 0,
    pendingIngest:  pendingIngest.rows[0]?.c  ?? 0,
    pendingOutbox:  pendingOutbox.rows[0]?.c  ?? 0,
    enabled:        process.env.FBMP_EDGE_ENABLED === "1",
  };
}

module.exports = {
  upsertThread,
  ingestMessages,
  getPendingOutbox,
  getAllPendingOutbox,
  enqueueOutbox,
  ackOutboxMessage,
  failOutboxMessage,
  listThreads,
  getStats,
};
