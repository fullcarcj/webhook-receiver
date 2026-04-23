"use strict";

/**
 * Puente ML → crm_chats / crm_messages para bandeja omnicanal.
 * Sin índices UNIQUE parciales en crm_chats: SELECT + INSERT/UPDATE.
 */

const { pool } = require("../../db");
const sseBroker = require("../realtime/sseBroker");
const { applyInboundOmnichannelHook } = require("./omnichannelInboundHook");
const { applyOutboundOmnichannelHook } = require("./omnichannelOutboundHook");

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
  // Whitelist operativo: si el número del comprador está en la lista, ignorar
  if (questionRow && questionRow.buyer_phone) {
    const { isPhoneWhitelisted } = require("../handlers/inboxWhitelistHandler");
    if (await isPhoneWhitelisted(questionRow.buyer_phone)) {
      return { chatId: null, isNew: false, skipped: "whitelist" };
    }
  }
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

  const insQ = await db.query(
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

  // Bloque 1 · Motor omnicanal — inbound (omnichannelInboundHook)
  if (insQ.rowCount > 0) {
    await applyInboundOmnichannelHook(db, chatId, {
      sourceType: "ml_question",
      previewText: qtext,
      messageType: "text",
    });
  }

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
 * @returns {Promise<{ chatId: number|null, isNew: boolean, skipped?: boolean|string, direction?: string }>}
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

  const mlMid =
    messageRow.ml_message_id != null ? String(messageRow.ml_message_id).trim() : "";
  if (!mlMid) {
    return { chatId: null, isNew: false, skipped: true };
  }

  const isSellerMessage = Number.isFinite(fromUid) && fromUid === mlUid;
  const msgText =
    messageRow.message_text != null && String(messageRow.message_text).trim() !== ""
      ? String(messageRow.message_text)
      : "";
  const lastAt = parseTs(messageRow.date_created);
  const packId =
    messageRow.ml_pack_id != null && messageRow.ml_pack_id !== ""
      ? Number(messageRow.ml_pack_id)
      : orderId;
  const phone = `mlm:${mlUid}:${orderId}`;

  // --- Rama vendedor: registrar outbound y marcar chat como atendido ---
  if (isSellerMessage) {
    const { rows: existing } = await db.query(
      `SELECT id FROM crm_chats
       WHERE source_type = 'ml_message'
         AND ml_order_id = $1
         AND phone = $2
       LIMIT 1`,
      [orderId, phone]
    );
    // Sin chat previo: el vendedor escribió primero; nada que marcar atendido.
    if (!existing.length) {
      return { chatId: null, isNew: false, skipped: "seller_no_chat" };
    }
    const chatId = Number(existing[0].id);

    const insOut = await db.query(
      `INSERT INTO crm_messages (
         chat_id, external_message_id, direction, type, content,
         sent_by, is_read, created_at
       ) VALUES (
         $1, $2, 'outbound', 'text', $3::jsonb,
         'seller_ml', true, $4::timestamptz
       )
       ON CONFLICT (external_message_id) DO NOTHING`,
      [chatId, `ml_msg_${mlMid}`, JSON.stringify({ text: msgText }), lastAt]
    );

    if (insOut.rowCount > 0) {
      // Actualizar preview del chat solo si el timestamp del vendedor es >= al último registrado.
      await db.query(
        `UPDATE crm_chats
         SET last_message_text = $2,
             last_message_at   = $3::timestamptz,
             updated_at        = NOW()
         WHERE id = $1
           AND (last_message_at IS NULL OR $3::timestamptz >= last_message_at)`,
        [chatId, msgText, lastAt]
      );
      await applyOutboundOmnichannelHook(db, chatId);
      sseBroker.broadcast("clear_notification", { chat_id: chatId });
    }

    return { chatId, isNew: false, direction: "outbound" };
  }

  // --- Rama comprador: flujo inbound original ---
  const buyerIdForLink = Number.isFinite(fromUid) && fromUid > 0 ? fromUid : null;

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

  const insM = await db.query(
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

  // Motor omnicanal — inbound
  if (insM.rowCount > 0) {
    await applyInboundOmnichannelHook(db, chatId, {
      sourceType: "ml_message",
      previewText: msgText,
      messageType: "text",
    });
  }

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

/**
 * Tras insertar/actualizar la respuesta ML en CRM: mismo cierre que un envío agente
 * (PENDING_RESPONSE → ATTENDED, SLA off) + refetch de bandeja sin sonido de mensaje nuevo.
 * @param {import('pg').Pool|import('pg').PoolClient} dbClient
 * @param {number} chatId
 */
async function finalizeAnsweredMlQuestionInCrm(dbClient, chatId) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  try {
    await applyOutboundOmnichannelHook(dbClient, cid);
    sseBroker.broadcast("clear_notification", { chat_id: cid });
  } catch (e) {
    console.error("[mlInboxBridge] finalizeAnsweredMlQuestionInCrm", e && e.message ? e.message : e);
  }
}

/**
 * Tras persistir ml_questions_answered (webhook, refresh, IA auto): refleja la respuesta en
 * crm_messages + crm_chats para que el omnicanal muestre la burbuja aunque nadie usó
 * POST /api/inbox/.../ml-question/answer. Idempotente: no duplica si ya hay outbound con
 * el mismo ml_question_id en content (p. ej. respuesta manual previa).
 *
 * @param {object} answeredRow — misma forma que usa upsertMlQuestionAnswered (answer_text, ml_question_id, …)
 * @param {import('pg').Pool|import('pg').PoolClient|null} [client]
 * @returns {Promise<{ ok: boolean, chat_id?: number, skipped?: string }>}
 */
async function syncAnsweredMlQuestionToCrm(answeredRow, client = null) {
  const db = q(client);
  const mlQid = Number(answeredRow && answeredRow.ml_question_id);
  if (!Number.isFinite(mlQid) || mlQid <= 0) {
    return { ok: false, skipped: "bad_question_id" };
  }
  const answerText =
    answeredRow.answer_text != null && String(answeredRow.answer_text).trim() !== ""
      ? String(answeredRow.answer_text).trim()
      : "";
  if (!answerText) {
    return { ok: false, skipped: "empty_answer" };
  }

  let { rows: chatRows } = await db.query(
    `SELECT id, customer_id FROM crm_chats WHERE ml_question_id = $1 LIMIT 1`,
    [mlQid]
  );

  if (!chatRows.length) {
    const synthetic = {
      ml_question_id: mlQid,
      ml_user_id:
        answeredRow.ml_user_id != null && Number.isFinite(Number(answeredRow.ml_user_id))
          ? Number(answeredRow.ml_user_id)
          : null,
      buyer_id:
        answeredRow.buyer_id != null && Number.isFinite(Number(answeredRow.buyer_id))
          ? Number(answeredRow.buyer_id)
          : null,
      item_id: answeredRow.item_id != null ? String(answeredRow.item_id) : null,
      question_text:
        answeredRow.question_text != null ? String(answeredRow.question_text) : "",
      date_created: answeredRow.date_created != null ? String(answeredRow.date_created) : null,
      notification_id:
        answeredRow.notification_id != null ? String(answeredRow.notification_id) : null,
      raw_json: answeredRow.raw_json != null ? String(answeredRow.raw_json) : "{}",
    };
    const { chatId } = await upsertMlQuestionChat(synthetic, db);
    if (!chatId) {
      return { ok: false, skipped: "no_chat_created" };
    }
    const r2 = await db.query(`SELECT id, customer_id FROM crm_chats WHERE id = $1`, [chatId]);
    chatRows = r2.rows;
  }

  const chatId = Number(chatRows[0].id);
  const customerId =
    chatRows[0].customer_id != null && Number.isFinite(Number(chatRows[0].customer_id))
      ? Number(chatRows[0].customer_id)
      : null;

  const { rows: dup } = await db.query(
    `SELECT 1 FROM crm_messages
     WHERE chat_id = $1
       AND direction = 'outbound'
       AND (
         (content->>'ml_question_id') IS NOT NULL
         AND (content->>'ml_question_id')::bigint = $2::bigint
       )
     LIMIT 1`,
    [chatId, mlQid]
  );
  if (dup.length) {
    await db.query(
      `UPDATE crm_chats SET
         last_message_text = $1,
         last_message_at = NOW(),
         ml_question_answered_at = COALESCE(ml_question_answered_at, NOW()),
         updated_at = NOW()
       WHERE id = $2`,
      [answerText.slice(0, 5000), chatId]
    );
    await finalizeAnsweredMlQuestionInCrm(db, chatId);
    return { ok: true, chat_id: chatId, skipped: "outbound_already_exists" };
  }

  const extId = `ml_out_sync_${mlQid}`;
  await db.query(
    `INSERT INTO crm_messages (
       chat_id, customer_id, direction, type,
       content, sent_by, external_message_id, is_read, created_at
     ) VALUES (
       $1, $2, 'outbound', 'text',
       jsonb_build_object(
         'text', $3::text,
         'ml_question_id', $4::bigint,
         'answer_source', 'ml_sync'
       ),
       'mercadolibre_sync', $5, TRUE, NOW()
     )
     ON CONFLICT (external_message_id) DO NOTHING`,
    [chatId, customerId, answerText, mlQid, extId]
  );

  await db.query(
    `UPDATE crm_chats SET
       source_type = 'ml_message',
       last_message_text = $1,
       last_message_at = NOW(),
       ml_question_answered_at = COALESCE(ml_question_answered_at, NOW()),
       updated_at = NOW()
     WHERE id = $2`,
    [answerText.slice(0, 5000), chatId]
  );

  await finalizeAnsweredMlQuestionInCrm(db, chatId);

  return { ok: true, chat_id: chatId };
}

module.exports = {
  upsertMlQuestionChat,
  upsertMlMessageChat,
  syncAnsweredMlQuestionToCrm,
};
