"use strict";

const pino = require("pino");
const { pool } = require("../../../db");
const { resolveCustomerId, upsertChat } = require("./_shared");
const { pickWaFullNameCandidate } = require("../waNameCandidate");
const { runWaMlBuyerMatchTipoE } = require("../../services/waMlBuyerMatchTipoE");
const { trySendCrmWaWelcome, trySendCrmWaWelcomeAfterName } = require("../../services/crmWaWelcome");

const msgLog = pino({ level: process.env.LOG_LEVEL || "info", name: "whatsapp_messages" });

let _nameSuggestedColumnWarned = false;

function isPriority(normalized) {
  const t = normalized.content && normalized.content.text;
  if (!t) return false;
  const text = String(t).toLowerCase();
  const keywords = [
    "precio",
    "pago",
    "urgente",
    "no sirve",
    "roto",
    "cuanto",
    "cuánto",
    "disponible",
    "tienen",
    "hay",
    "cuanto vale",
    "transferencia",
  ];
  return keywords.some((kw) => text.includes(kw));
}

async function handle(normalized) {
  const eventType = normalized.eventType || "messages.received";
  if (!normalized.fromPhone || !normalized.messageId) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const nameExtra = pickWaFullNameCandidate(normalized);
    const extra = {};
    if (nameExtra.name) extra.name = nameExtra.name;
    const cn = normalized.contactName != null ? String(normalized.contactName).trim() : "";
    if (cn) extra.contact_name = cn;
    const { customerId, waMlBuyerTipoECheck } = await resolveCustomerId(client, normalized.fromPhone, extra);

    /* pushName/notify crudo (Wasender): solo almacenaje en customers.name_suggested; no entra en resolveCustomer ni bienvenida. */
    if (cn) {
      const rawPush = cn.slice(0, 500);
      try {
        await client.query(`UPDATE customers SET name_suggested = $1, updated_at = NOW() WHERE id = $2`, [
          rawPush,
          customerId,
        ]);
      } catch (e) {
        if (e && e.code === "42703") {
          if (!_nameSuggestedColumnWarned) {
            _nameSuggestedColumnWarned = true;
            msgLog.warn(
              "customers.name_suggested no existe en la BD; ejecutar en el servidor: npm run db:customers-name-suggested"
            );
          }
        } else {
          throw e;
        }
      }
    }

    const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
    const preview = normalized.content?.text ? String(normalized.content.text).slice(0, 200) : "";

    const chatRow = await upsertChat(client, {
      customerId,
      phone: normalized.fromPhone,
      lastMessageAt: lastAt,
      lastMessageText: preview,
      lastMessageType: normalized.type || "text",
    });
    const chatId = chatRow.id;

    if (eventType === "messages.update" && normalized.messageId) {
      await client.query(
        `UPDATE crm_messages
         SET content = $1::jsonb, is_edited = TRUE
         WHERE external_message_id = $2`,
        [JSON.stringify(normalized.content || {}), normalized.messageId]
      );
    } else {
      const pri = isPriority(normalized);
      const ins = await client.query(
        `INSERT INTO crm_messages
           (chat_id, customer_id, external_message_id, direction, type, content, is_priority, created_at)
         VALUES ($1, $2, $3, 'inbound', $4, $5::jsonb, $6, NOW())
         ON CONFLICT (external_message_id) DO NOTHING
         RETURNING id`,
        [
          chatId,
          customerId,
          normalized.messageId,
          normalized.type || "text",
          JSON.stringify(normalized.content || {}),
          pri,
        ]
      );

      if (ins.rows.length) {
        await client.query(
          `UPDATE crm_chats SET unread_count = unread_count + 1, updated_at = NOW() WHERE id = $1`,
          [chatId]
        );
      }
    }

    await client.query("COMMIT");

    /* Bienvenida: primero saludo/pedido de nombre; si antes se pidió nombre y ahora hay nombre en customers → saludo con nombre. */
    if (eventType === "messages.received" && (normalized.type || "text") !== "reaction") {
      setImmediate(() => {
        Promise.resolve()
          .then(() =>
            trySendCrmWaWelcome({
              chatId,
              customerId,
              phoneRaw: normalized.fromPhone,
            })
          )
          .then(() =>
            trySendCrmWaWelcomeAfterName({
              chatId,
              customerId,
              phoneRaw: normalized.fromPhone,
            })
          )
          .catch((err) => {
            msgLog.error({ err }, "trySendCrmWaWelcome");
          });
      });
    }

    if (waMlBuyerTipoECheck) {
      setImmediate(() => {
        runWaMlBuyerMatchTipoE({
          ...waMlBuyerTipoECheck,
          customerId,
        }).catch((err) => {
          msgLog.error({ err }, "runWaMlBuyerMatchTipoE");
        });
      });
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { handle };
