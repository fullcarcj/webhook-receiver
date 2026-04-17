"use strict";

/**
 * Puente ML → crm_chats / crm_messages para bandeja omnicanal.
 * Sin índices UNIQUE parciales en crm_chats: SELECT + INSERT/UPDATE.
 */

const { pool } = require("../../db");

function q(client) {
  return client && typeof client.query === "function" ? client : pool;
}

function parseTs(v) {
  if (v == null || String(v).trim() === "") return new Date();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * @param {object} questionRow — fila alineada a ml_questions_pending (buildQuestionPendingRow)
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<{ chatId: number|null, isNew: boolean }>}
 */
async function upsertMlQuestionChat(questionRow, client) {
  const db = q(client);
  const mlQid = Number(questionRow.ml_question_id);
  if (!Number.isFinite(mlQid) || mlQid <= 0) {
    return { chatId: null, isNew: false };
  }

  const buyerId = questionRow.buyer_id != null ? Number(questionRow.buyer_id) : null;
  const qtext =
    questionRow.question_text != null && String(questionRow.question_text).trim() !== ""
      ? String(questionRow.question_text)
      : "";
  const lastAt = parseTs(questionRow.date_created);
  const phone = `mlq:${mlQid}`;

  const { rows: existing } = await db.query(
    `SELECT id FROM crm_chats WHERE source_type = 'ml_question' AND ml_question_id = $1 LIMIT 1`,
    [mlQid]
  );

  let chatId;
  let isNew = false;

  if (existing.length) {
    chatId = Number(existing[0].id);
    await db.query(
      `UPDATE crm_chats SET
         last_message_text = $2,
         last_message_at = $3::timestamptz,
         unread_count = crm_chats.unread_count + 1,
         ml_buyer_id = COALESCE($4::bigint, ml_buyer_id),
         updated_at = NOW()
       WHERE id = $1`,
      [chatId, qtext, lastAt, Number.isFinite(buyerId) && buyerId > 0 ? buyerId : null]
    );
  } else {
    isNew = true;
    const ins = await db.query(
      `INSERT INTO crm_chats (
         customer_id,
         phone,
         source_type,
         ml_question_id,
         ml_buyer_id,
         last_message_text,
         last_message_at,
         unread_count,
         identity_status,
         last_message_type,
         created_at,
         updated_at
       ) VALUES (
         NULL,
         $1,
         'ml_question',
         $2,
         $3,
         $4,
         $5::timestamptz,
         1,
         'unknown',
         'text',
         NOW(),
         NOW()
       )
       RETURNING id`,
      [
        phone,
        mlQid,
        Number.isFinite(buyerId) && buyerId > 0 ? buyerId : null,
        qtext,
        lastAt,
      ]
    );
    chatId = Number(ins.rows[0].id);
  }

  await db.query(
    `INSERT INTO crm_messages (
       chat_id, external_message_id, direction, type, content,
       sent_by, is_read, created_at
     ) VALUES (
       $1, $2, 'inbound', 'text', $3::jsonb,
       'buyer', false, $4::timestamptz
     )
     ON CONFLICT (external_message_id) DO NOTHING`,
    [chatId, `ml_q_${mlQid}`, JSON.stringify({ text: qtext }), lastAt]
  );

  if (Number.isFinite(buyerId) && buyerId > 0) {
    try {
      const { rows: cmb } = await db.query(
        `SELECT customer_id FROM customer_ml_buyers WHERE ml_buyer_id = $1 LIMIT 1`,
        [buyerId]
      );
      if (cmb.length && cmb[0].customer_id != null) {
        await db.query(
          `UPDATE crm_chats SET
             customer_id = $1,
             identity_status = 'auto_matched',
             updated_at = NOW()
           WHERE id = $2`,
          [Number(cmb[0].customer_id), chatId]
        );
      }
    } catch (_e) {
      /* tabla opcional en entornos sin CRM wallet */
    }
  }

  return { chatId, isNew };
}

/**
 * @param {object} messageRow — fila ml_order_pack_messages (snake_case desde PG)
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<{ chatId: number|null, isNew: boolean, skipped?: boolean }>}
 */
async function upsertMlMessageChat(messageRow, client) {
  const db = q(client);
  const mlUid = Number(messageRow.ml_user_id);
  const orderId = Number(messageRow.order_id);
  const fromUid =
    messageRow.from_user_id != null && messageRow.from_user_id !== ""
      ? Number(messageRow.from_user_id)
      : NaN;

  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
    return { chatId: null, isNew: false, skipped: true };
  }

  if (Number.isFinite(fromUid) && fromUid === mlUid) {
    return { chatId: null, isNew: false, skipped: true };
  }

  const mlMid =
    messageRow.ml_message_id != null ? String(messageRow.ml_message_id).trim() : "";
  if (!mlMid) {
    return { chatId: null, isNew: false, skipped: true };
  }

  const msgText =
    messageRow.message_text != null && String(messageRow.message_text).trim() !== ""
      ? String(messageRow.message_text)
      : "";
  const lastAt = parseTs(messageRow.date_created);
  const packId =
    messageRow.ml_pack_id != null && messageRow.ml_pack_id !== ""
      ? Number(messageRow.ml_pack_id)
      : orderId;

  const buyerIdForLink = Number.isFinite(fromUid) && fromUid > 0 ? fromUid : null;
  const phone = `mlm:${mlUid}:${orderId}`;

  const { rows: existing } = await db.query(
    `SELECT id FROM crm_chats
     WHERE source_type = 'ml_message'
       AND ml_order_id = $1
       AND phone = $2
     LIMIT 1`,
    [orderId, phone]
  );

  let chatId;
  let isNew = false;

  if (existing.length) {
    chatId = Number(existing[0].id);
    await db.query(
      `UPDATE crm_chats SET
         last_message_text = $2,
         last_message_at = $3::timestamptz,
         unread_count = crm_chats.unread_count + 1,
         ml_buyer_id = COALESCE($4::bigint, ml_buyer_id),
         ml_pack_id = $5::bigint,
         updated_at = NOW()
       WHERE id = $1`,
      [chatId, msgText, lastAt, buyerIdForLink, packId]
    );
  } else {
    isNew = true;
    const ins = await db.query(
      `INSERT INTO crm_chats (
         customer_id,
         phone,
         source_type,
         ml_order_id,
         ml_pack_id,
         ml_buyer_id,
         last_message_text,
         last_message_at,
         unread_count,
         identity_status,
         last_message_type,
         created_at,
         updated_at
       ) VALUES (
         NULL,
         $1,
         'ml_message',
         $2,
         $3::bigint,
         $4,
         $5,
         $6::timestamptz,
         1,
         'unknown',
         'text',
         NOW(),
         NOW()
       )
       RETURNING id`,
      [phone, orderId, packId, buyerIdForLink, msgText, lastAt]
    );
    chatId = Number(ins.rows[0].id);
  }

  await db.query(
    `INSERT INTO crm_messages (
       chat_id, external_message_id, direction, type, content,
       sent_by, is_read, created_at
     ) VALUES (
       $1, $2, 'inbound', 'text', $3::jsonb,
       'buyer', false, $4::timestamptz
     )
     ON CONFLICT (external_message_id) DO NOTHING`,
    [chatId, `ml_msg_${mlMid}`, JSON.stringify({ text: msgText }), lastAt]
  );

  if (buyerIdForLink != null) {
    try {
      const { rows: cmb } = await db.query(
        `SELECT customer_id FROM customer_ml_buyers WHERE ml_buyer_id = $1 LIMIT 1`,
        [buyerIdForLink]
      );
      if (cmb.length && cmb[0].customer_id != null) {
        await db.query(
          `UPDATE crm_chats SET
             customer_id = $1,
             identity_status = 'auto_matched',
             updated_at = NOW()
           WHERE id = $2`,
          [Number(cmb[0].customer_id), chatId]
        );
      }
    } catch (_e) {
      /* opcional */
    }
  }

  return { chatId, isNew };
}

module.exports = {
  upsertMlQuestionChat,
  upsertMlMessageChat,
};
