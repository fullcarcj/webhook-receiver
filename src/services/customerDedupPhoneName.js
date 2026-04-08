"use strict";

const { sanitizeWaPersonName } = require("../whatsapp/waNameCandidate");

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "") || null;
}

/**
 * Evita altas duplicadas: mismo teléfono (dígitos en customers.phone) y mismo nombre+apellido
 * (según sanitizeWaPersonName en ambos lados).
 *
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {string} phoneDigits - ej. salida de normalizePhone / dígitos del webhook
 * @param {string} fullNameRaw - nombre que se usaría en el INSERT (full_name)
 * @returns {Promise<number|null>} customer id o null
 */
async function findCustomerIdByPhoneAndPersonName(db, phoneDigits, fullNameRaw) {
  const d = digitsOnly(phoneDigits);
  if (!d) return null;
  const target = sanitizeWaPersonName(String(fullNameRaw || ""));
  if (!target) return null;
  const key = target.toLowerCase();
  let rows;
  try {
    const r = await db.query(
      `SELECT id, full_name FROM customers
       WHERE REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $1
          OR REGEXP_REPLACE(COALESCE(phone_2, ''), '\\D', '', 'g') = $1`,
      [d]
    );
    rows = r.rows;
  } catch (e) {
    if (e && e.code === "42703") {
      const r = await db.query(
        `SELECT id, full_name FROM customers
         WHERE REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $1`,
        [d]
      );
      rows = r.rows;
    } else throw e;
  }
  for (const row of rows) {
    const s = sanitizeWaPersonName(String(row.full_name || ""));
    if (s && s.toLowerCase() === key) return Number(row.id);
  }
  return null;
}

module.exports = { findCustomerIdByPhoneAndPersonName, digitsOnly };
