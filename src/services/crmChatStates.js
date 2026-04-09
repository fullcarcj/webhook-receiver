"use strict";

/**
 * Helpers para la tabla crm_chat_states (máquina de estados de onboarding CRM vía WhatsApp).
 *
 * Estados:
 *   AWAITING_NAME — el siguiente mensaje de texto del teléfono se toma como nombre+apellido real.
 *
 * Todos los métodos aceptan un `db` que puede ser pool o PoolClient (compatible con transacción abierta).
 * Si la tabla no existe todavía (42P01) se devuelve null / se ignora silenciosamente.
 */

const pino = require("pino");
const { normalizePhone } = require("../utils/phoneNormalizer");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "crmChatStates" });

const TABLE_MISSING = "42P01";
const STATE_TTL_SECONDS = Math.max(
  3600,
  Number.parseInt(String(process.env.CRM_CHAT_STATE_TTL_SECONDS || 7 * 24 * 3600), 10) || 7 * 24 * 3600
);
const PRUNE_EVERY_MS = Math.max(
  60 * 1000,
  Number.parseInt(String(process.env.CRM_CHAT_STATE_PRUNE_EVERY_MS || 15 * 60 * 1000), 10) ||
    15 * 60 * 1000
);
let _lastPruneAt = 0;

async function pruneCrmChatStatesIfDue(db) {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_EVERY_MS) return;
  _lastPruneAt = now;
  try {
    const r = await db.query(
      `DELETE FROM crm_chat_states
       WHERE updated_at < NOW() - ($1 * INTERVAL '1 second')`,
      [STATE_TTL_SECONDS]
    );
    if (r.rowCount > 0) {
      log.info(
        { deleted: r.rowCount, ttlSeconds: STATE_TTL_SECONDS },
        "crm_chat_states pruned"
      );
    }
  } catch (e) {
    if (e && e.code === TABLE_MISSING) return;
    throw e;
  }
}

/**
 * Obtiene el estado de onboarding para un teléfono.
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {string} phoneRaw
 * @returns {Promise<{status: string, push_name: string|null, trigger_message_id: string|null}|null>}
 */
async function getCrmChatState(db, phoneRaw) {
  const phone = normalizePhone(phoneRaw) || String(phoneRaw).replace(/\D/g, "");
  if (!phone) return null;
  try {
    await pruneCrmChatStatesIfDue(db);
    const { rows } = await db.query(
      `SELECT status, push_name, trigger_message_id, updated_at
       FROM crm_chat_states
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );
    const row = rows[0] || null;
    if (!row) return null;

    const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const stale = !updatedAtMs || Date.now() - updatedAtMs > STATE_TTL_SECONDS * 1000;
    if (stale) {
      await db.query(`DELETE FROM crm_chat_states WHERE phone = $1`, [phone]);
      log.info({ phone, ttlSeconds: STATE_TTL_SECONDS }, "crm_chat_state expired and removed");
      return null;
    }
    return {
      status: row.status,
      push_name: row.push_name,
      trigger_message_id: row.trigger_message_id,
    };
  } catch (e) {
    if (e && e.code === TABLE_MISSING) return null;
    throw e;
  }
}

/**
 * Crea o actualiza el estado AWAITING_NAME para un teléfono.
 * - push_name: nombre de perfil WA del primer mensaje → se guardará en customers.name_suggested al registrar.
 * - triggerMessageId: messageId del webhook que inicia el estado; sirve para evitar replay.
 *   Si ya existe un estado para ese teléfono, NO sobreescribe push_name ni trigger_message_id anteriores.
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {string} phoneRaw
 * @param {string|null} pushName
 * @param {string|null} [triggerMessageId]
 */
async function upsertCrmChatStateAwaitingName(db, phoneRaw, pushName, triggerMessageId = null) {
  const phone = normalizePhone(phoneRaw) || String(phoneRaw).replace(/\D/g, "");
  if (!phone) return;
  try {
    await pruneCrmChatStatesIfDue(db);
    await db.query(
      `INSERT INTO crm_chat_states (phone, status, push_name, trigger_message_id, created_at, updated_at)
       VALUES ($1, 'AWAITING_NAME', $2, $3, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET
         status             = 'AWAITING_NAME',
         push_name          = COALESCE(crm_chat_states.push_name, EXCLUDED.push_name),
         trigger_message_id = COALESCE(crm_chat_states.trigger_message_id, EXCLUDED.trigger_message_id),
         updated_at         = NOW()`,
      [phone, pushName || null, triggerMessageId || null]
    );
  } catch (e) {
    if (e && e.code === TABLE_MISSING) {
      log.warn("crm_chat_states tabla ausente — ejecutar: npm run db:crm-chat-states");
      return;
    }
    throw e;
  }
}

/**
 * Elimina el estado de onboarding para un teléfono (nombre recibido, onboarding completo).
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {string} phoneRaw
 */
async function deleteCrmChatState(db, phoneRaw) {
  const phone = normalizePhone(phoneRaw) || String(phoneRaw).replace(/\D/g, "");
  if (!phone) return;
  try {
    await db.query(`DELETE FROM crm_chat_states WHERE phone = $1`, [phone]);
  } catch (e) {
    if (e && e.code === TABLE_MISSING) return;
    throw e;
  }
}

module.exports = { getCrmChatState, upsertCrmChatStateAwaitingName, deleteCrmChatState };
