'use strict';

/**
 * Anti-spam / rate limit por destino (teléfono) y tipo de mensaje Wasender.
 *
 * Reglas (evaluateWaSendPolicy):
 * - CHAT: no aplica (mensajes manuales / CRM sin clasificar) — no registra en wa_sent_messages_log.
 * - CRITICAL: omite anti-duplicado y tope de recordatorios; registra el envío si hubo éxito API.
 * - REMINDER / MARKETING: anti-duplicado 24h (mismo SHA-256 del contenido) y tope diario de REMINDER.
 *
 * Env:
 *   WA_PREVENT_DUPLICATES — default true; si false, no bloquea por hash 24h.
 *   WA_MAX_REMINDERS_PER_DAY — default 1; solo message_type REMINDER, día calendario America/Caracas.
 *
 * Mantenimiento BD: la tabla wa_sent_messages_log crece con el tráfico; conviene purgar
 * periódicamente (p. ej. job mensual): DELETE FROM wa_sent_messages_log WHERE sent_at < NOW() - INTERVAL '30 days';
 *
 * @see wasender-client.js
 */

const crypto = require('crypto');

const TYPES = new Set(['REMINDER', 'MARKETING', 'CRITICAL', 'CHAT']);

function normalizeMessageType(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (TYPES.has(s)) return s;
  return 'CHAT';
}

function normalizeTextForHash(s) {
  return String(s || '').replace(/\r\n/g, '\n').trim();
}

function hashContentUtf8(s) {
  return crypto.createHash('sha256').update(normalizeTextForHash(s), 'utf8').digest('hex');
}

function envBool(name, defaultTrue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultTrue;
  const t = String(v).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  return defaultTrue;
}

function maxRemindersPerDay() {
  const n = Number(process.env.WA_MAX_REMINDERS_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/**
 * Validación previa al envío (equivalente a canSendMessage con hash interno).
 *
 * @param {object} pool — pg Pool
 * @param {{ phoneE164: string, customerId?: number|null, messageType?: string, contentHash: string }} params
 * @returns {Promise<{ allowed: boolean, reason?: string, shouldLogAfterSend: boolean }>}
 */
async function evaluateWaSendPolicy(pool, params) {
  const phoneE164 = String(params.phoneE164 || '').replace(/\s/g, '');
  const contentHash = String(params.contentHash || '');
  const messageType = normalizeMessageType(params.messageType);

  if (!phoneE164 || phoneE164.length < 8 || contentHash.length !== 64) {
    return { allowed: true, shouldLogAfterSend: false };
  }

  if (messageType === 'CHAT') {
    return { allowed: true, shouldLogAfterSend: false };
  }

  if (messageType === 'CRITICAL') {
    return { allowed: true, shouldLogAfterSend: true };
  }

  try {
    const preventDup = envBool('WA_PREVENT_DUPLICATES', true);
    if (preventDup) {
      const q1 = await pool.query(
        `SELECT 1 FROM wa_sent_messages_log
         WHERE phone_e164 = $1
           AND content_hash = $2
           AND sent_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [phoneE164, contentHash]
      );
      if (q1.rows.length) {
        return { allowed: false, reason: 'DUPLICATE_24H', shouldLogAfterSend: false };
      }
    }

    if (messageType === 'REMINDER') {
      const cap = maxRemindersPerDay();
      const q2 = await pool.query(
        `SELECT COUNT(*)::int AS c
         FROM wa_sent_messages_log
         WHERE phone_e164 = $1
           AND message_type = 'REMINDER'
           AND sent_at >= (date_trunc('day', (NOW() AT TIME ZONE 'America/Caracas'))) AT TIME ZONE 'America/Caracas'
           AND sent_at < ((date_trunc('day', (NOW() AT TIME ZONE 'America/Caracas')) + INTERVAL '1 day') AT TIME ZONE 'America/Caracas')`,
        [phoneE164]
      );
      const c = q2.rows[0]?.c ?? 0;
      if (c >= cap) {
        return { allowed: false, reason: 'REMINDER_DAILY_CAP', shouldLogAfterSend: false };
      }
    }

    return { allowed: true, shouldLogAfterSend: true };
  } catch (err) {
    console.warn('[waAntiSpam] evaluateWaSendPolicy — permitiendo envío (fail-open):', err.message);
    return { allowed: true, shouldLogAfterSend: false };
  }
}

/**
 * @param {object} pool
 * @param {{ customerId?: number|null, phoneE164: string, text: string, messageType?: string }} params
 */
async function canSendMessage(pool, params) {
  const contentHash = hashContentUtf8(params.text);
  return evaluateWaSendPolicy(pool, {
    phoneE164: params.phoneE164,
    customerId: params.customerId,
    messageType: params.messageType,
    contentHash,
  });
}

/**
 * Tras respuesta exitosa de Wasender (no llamar si CHAT o si shouldLogAfterSend era false).
 *
 * @param {object} pool
 * @param {{ customerId?: number|null, phoneE164: string, messageType?: string, contentHash: string }} row
 */
async function recordWaSentMessage(pool, row) {
  const phoneE164 = String(row.phoneE164 || '').replace(/\s/g, '');
  const contentHash = String(row.contentHash || '');
  const messageType = normalizeMessageType(row.messageType);
  const customerId =
    row.customerId != null && Number.isFinite(Number(row.customerId))
      ? Number(row.customerId)
      : null;

  if (!phoneE164 || contentHash.length !== 64) return;
  if (messageType === 'CHAT') return;

  try {
    await pool.query(
      `INSERT INTO wa_sent_messages_log (customer_id, phone_e164, message_type, content_hash, sent_at)
       VALUES ($1, $2, $3::wa_message_type, $4, NOW())`,
      [customerId, phoneE164, messageType, contentHash]
    );
  } catch (err) {
    console.warn('[waAntiSpam] recordWaSentMessage falló (no se bloquea el flujo):', err.message);
  }
}

module.exports = {
  normalizeMessageType,
  hashContentUtf8,
  evaluateWaSendPolicy,
  canSendMessage,
  recordWaSentMessage,
};
