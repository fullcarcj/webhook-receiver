"use strict";

const { normalizePhone } = require("../utils/phoneNormalizer");
const { sendChatMessage } = require("./chatMessageService");

/** Actividad reciente en el hilo WA (mensajes o timestamps del chat). */
async function isRecentWaActivity(pool, chatId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM crm_chats c
     WHERE c.id = $1
       AND (
         c.last_message_at >= NOW() - INTERVAL '30 days'
         OR c.last_inbound_at >= NOW() - INTERVAL '30 days'
         OR c.last_outbound_at >= NOW() - INTERVAL '30 days'
         OR EXISTS (
           SELECT 1 FROM crm_messages m
            WHERE m.chat_id = c.id
              AND m.created_at >= NOW() - INTERVAL '30 days'
         )
       )
     LIMIT 1`,
    [chatId]
  );
  return rows.length > 0;
}

function buildDefaultGreeting(customerName) {
  const raw = process.env.INBOX_WA_OUTREACH_GREETING;
  const first =
    customerName && String(customerName).trim()
      ? String(customerName).trim().split(/\s+/)[0]
      : "";
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).replace(/\{\{NOMBRE\}\}/gi, first).trim();
  }
  if (first) {
    return `Hola ${first}, te escribimos para ayudarte con tu consulta. ¿Podemos continuar por aquí?`;
  }
  return "Hola, te escribimos para ayudarte con tu consulta. ¿Podemos continuar por aquí?";
}

/**
 * Localiza o crea el hilo CRM por teléfono (WA) y, si no hubo actividad reciente,
 * envía un saludo outbound vía Wasender para reactivar el contacto.
 *
 * @param {import("pg").Pool} pool
 * @param {{ phoneRaw: string, customerId?: number|null, customerName?: string|null, sentBy: string }} opts
 * @returns {Promise<{ chat_id: number, greeting_sent: boolean, had_recent_activity: boolean }>}
 */
async function ensureWaChatFromCustomerPhone(pool, opts) {
  const { phoneRaw, customerId, customerName, sentBy } = opts;
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    const e = new Error("Teléfono inválido o vacío");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rows: existing } = await pool.query(
    `SELECT c.id, c.source_type
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE COALESCE(c.source_type, 'wa_inbound') IN ('wa_inbound', 'wa_ml_linked')
        AND (
          regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $1
          OR (
            cu.phone IS NOT NULL
            AND btrim(cu.phone) <> ''
            AND regexp_replace(COALESCE(cu.phone, ''), '[^0-9]', '', 'g') = $1
          )
        )
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT 1`,
    [phone]
  );

  let chatId;
  if (!existing.length) {
    const cid =
      customerId != null && Number.isFinite(Number(customerId)) && Number(customerId) > 0
        ? Number(customerId)
        : null;
    try {
      const ins = await pool.query(
        `INSERT INTO crm_chats (
           customer_id, phone, source_type, identity_status,
           unread_count, last_message_text, last_message_at, created_at, updated_at
         ) VALUES ($1, $2, 'wa_inbound', 'declared', 0, NULL, NULL, NOW(), NOW())
         RETURNING id`,
        [cid, phone]
      );
      chatId = Number(ins.rows[0].id);
    } catch (err) {
      if (err && err.code === "23505") {
        const r2 = await pool.query(
          `SELECT id FROM crm_chats WHERE phone = $1 LIMIT 1`,
          [phone]
        );
        if (!r2.rows.length) throw err;
        chatId = Number(r2.rows[0].id);
      } else {
        throw err;
      }
    }
  } else {
    chatId = Number(existing[0].id);
    if (customerId != null && Number.isFinite(Number(customerId)) && Number(customerId) > 0) {
      await pool.query(
        `UPDATE crm_chats
            SET customer_id = COALESCE(customer_id, $2::bigint),
                updated_at = NOW()
          WHERE id = $1`,
        [chatId, Number(customerId)]
      );
    }
  }

  const hadRecentActivity = await isRecentWaActivity(pool, chatId);
  let greetingSent = false;
  if (!hadRecentActivity) {
    const text = buildDefaultGreeting(customerName);
    await sendChatMessage(chatId, text, sentBy, { skipThrottle: true });
    greetingSent = true;
  }

  return { chat_id: chatId, greeting_sent: greetingSent, had_recent_activity: hadRecentActivity };
}

/**
 * Solo lectura: devuelve el `crm_chats.id` de un hilo WA existente para el teléfono normalizado.
 * No crea chat ni envía mensajes (para «Ir a Chat» sin efectos secundarios).
 *
 * @param {import("pg").Pool} pool
 * @param {string} phoneRaw
 * @returns {Promise<{ chat_id: number }>}
 */
async function findWaChatIdByPhone(pool, phoneRaw) {
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    const e = new Error("Teléfono inválido o vacío");
    e.code = "BAD_REQUEST";
    throw e;
  }
  /**
   * Coincidencia por dígitos (crm_chats.phone a veces vacío pero customer.phone coincide)
   * y tolera formatos con espacios/guiones en BD.
   */
  const { rows } = await pool.query(
    `SELECT c.id
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE COALESCE(c.source_type, 'wa_inbound') IN ('wa_inbound', 'wa_ml_linked')
        AND (
          regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $1
          OR (
            cu.phone IS NOT NULL
            AND btrim(cu.phone) <> ''
            AND regexp_replace(COALESCE(cu.phone, ''), '[^0-9]', '', 'g') = $1
          )
        )
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT 1`,
    [phone]
  );
  if (!rows.length) {
    const e = new Error(
      "No hay un chat de WhatsApp en la bandeja para este número. Debe existir un hilo previo o usar la opción de retomar contacto."
    );
    e.code = "NOT_FOUND";
    throw e;
  }
  return { chat_id: Number(rows[0].id) };
}

module.exports = {
  ensureWaChatFromCustomerPhone,
  findWaChatIdByPhone,
  buildDefaultGreeting,
  isRecentWaActivity,
};
