'use strict';

/**
 * Throttle global de mensajes WhatsApp salientes.
 *
 * Límite: `WA_DAILY_CAP` mensajes por número de teléfono por día calendario
 * (zona horaria America/Caracas). **Default: 5 en producción.**
 *
 * Para pruebas/desarrollo: subir `WA_DAILY_CAP=999` (o cualquier número alto).
 * En producción: bajar a 5-10 según política.
 *
 * Reset manual del contador de un número sin esperar a mañana:
 *   `npm run wa-throttle-reset -- +584242701513`
 *
 * Aplica a TODOS los tipos de mensaje salientes (A, B, C, E, F, G, M, etc.).
 * Se llama desde wasender-client.js antes de cada envío.
 *
 * Tabla: wa_throttle (phone_e164, sent_date DATE, daily_count INT)
 * La operación es atómica (UPSERT con WHERE en el DO UPDATE) — segura ante concurrencia.
 */

const MAX_DEFAULT = 5;

/**
 * Verifica e incrementa el contador diario del teléfono.
 *
 * @param {string} phone   – número en formato E.164 (con o sin +)
 * @param {object} pool    – instancia pg Pool
 * @param {object} [opts]
 * @param {boolean} [opts.skipThrottle=false] – si true, cuenta el envío pero no bloquea
 * @returns {Promise<{ allowed: boolean, count: number, cap: number }>}
 */
async function checkWaSendCap(phone, pool, opts = {}) {
  const cap = Number(process.env.WA_DAILY_CAP || MAX_DEFAULT);
  const normalized = String(phone || '').replace(/\s/g, '');

  if (!normalized) return { allowed: false, count: 0, cap };

  try {
    // Intento atómico: INSERT si no existe la fila del día, UPDATE si ya existe
    // La condición WHERE en DO UPDATE impide incrementar si ya se alcanzó el cap.
    // Si la condición no se cumple, el RETURNING no devuelve filas → blocked.
    const { rows } = await pool.query(`
      INSERT INTO wa_throttle (phone_e164, sent_date, daily_count)
      VALUES (
        $1,
        (NOW() AT TIME ZONE 'America/Caracas')::date,
        1
      )
      ON CONFLICT (phone_e164, sent_date) DO UPDATE
        SET daily_count = wa_throttle.daily_count + 1
        WHERE wa_throttle.daily_count < $2
      RETURNING daily_count
    `, [normalized, cap]);

    if (rows.length) {
      // INSERT o UPDATE exitoso → permitido
      return { allowed: true, count: rows[0].daily_count, cap };
    }

    // UPDATE bloqueado por WHERE → cap alcanzado
    // Leer el valor real para el log
    const { rows: cur } = await pool.query(`
      SELECT daily_count FROM wa_throttle
      WHERE phone_e164 = $1
        AND sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date
    `, [normalized]);

    const count = cur[0]?.daily_count ?? cap;
    if (opts.skipThrottle) {
      // Modo bypass: registrar el envío pero permitirlo igual
      await pool.query(`
        UPDATE wa_throttle
        SET daily_count = daily_count + 1
        WHERE phone_e164 = $1
          AND sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date
      `, [normalized]);
    }
    return { allowed: !!opts.skipThrottle, count, cap };

  } catch (err) {
    // Si la tabla no existe o hay error de BD, NO bloquear el envío (fail-open)
    // para no interrumpir mensajes críticos si el schema no está migrado aún.
    console.warn('[waThrottle] Error verificando cap — permitiendo envío:', err.message);
    return { allowed: true, count: 0, cap };
  }
}

/**
 * Consulta el uso actual del día sin modificar el contador.
 * Útil para endpoints de monitoreo.
 *
 * @param {string} phone
 * @param {object} pool
 */
async function getWaDailyUsage(phone, pool) {
  const cap = Number(process.env.WA_DAILY_CAP || MAX_DEFAULT);
  const normalized = String(phone || '').replace(/\s/g, '');
  try {
    const { rows } = await pool.query(`
      SELECT daily_count FROM wa_throttle
      WHERE phone_e164 = $1
        AND sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date
    `, [normalized]);
    return { count: rows[0]?.daily_count ?? 0, cap, remaining: cap - (rows[0]?.daily_count ?? 0) };
  } catch (_) {
    return { count: 0, cap, remaining: cap };
  }
}

/**
 * Resumen del throttle para el día actual — para panel de monitoreo.
 * @param {object} pool
 */
async function getWaThrottleSummary(pool) {
  const cap = Number(process.env.WA_DAILY_CAP || MAX_DEFAULT);
  try {
    const { rows } = await pool.query(`
      SELECT
        phone_e164,
        daily_count,
        CASE WHEN daily_count >= $1 THEN TRUE ELSE FALSE END AS capped
      FROM wa_throttle
      WHERE sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date
      ORDER BY daily_count DESC
      LIMIT 200
    `, [cap]);
    const total_blocked  = rows.filter(r => r.capped).length;
    const total_active   = rows.length;
    const total_messages = rows.reduce((s, r) => s + Number(r.daily_count), 0);
    return { date: new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas' }), cap, total_active, total_blocked, total_messages, phones: rows };
  } catch (_) {
    return { cap, total_active: 0, total_blocked: 0, total_messages: 0, phones: [] };
  }
}

module.exports = { checkWaSendCap, getWaDailyUsage, getWaThrottleSummary };
