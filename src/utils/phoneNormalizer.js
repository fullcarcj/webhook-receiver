"use strict";

/**
 * Normalización a dígitos E.164 sin prefijo "+" (consistente en BD).
 * PHONE_DEFAULT_COUNTRY por defecto 58 (VE).
 */

function normalizePhone(raw) {
  if (raw == null || raw === "") return null;

  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  const defaultCountry = String(process.env.PHONE_DEFAULT_COUNTRY || "58").replace(/\D/g, "") || "58";

  if (digits.startsWith("0")) {
    digits = defaultCountry + digits.slice(1);
  } else if (digits.length === 10 && !digits.startsWith(defaultCountry)) {
    digits = defaultCountry + digits;
  }

  if (digits.length < 10 || digits.length > 15) return null;

  return digits;
}

/**
 * Variantes de solo-dígitos para comparar CRM/WA (internacional) con `customers.phone`
 * guardado a veces como 0414…, 414… o +58… alineado a {@link normalizePhone}.
 *
 * @param {string|null|undefined} normalizedDigits — salida típica de `normalizePhone` (sin "+")
 * @returns {string[]}
 */
function expandPhoneMatchKeys(normalizedDigits) {
  const n = String(normalizedDigits || "").replace(/\D/g, "");
  const out = new Set();
  if (!n) return [];
  out.add(n);
  const cc = String(process.env.PHONE_DEFAULT_COUNTRY || "58").replace(/\D/g, "") || "58";
  if (n.startsWith(cc) && n.length > cc.length) {
    const tail = n.slice(cc.length);
    if (tail) {
      out.add(tail);
      out.add(`0${tail}`);
    }
  }
  if (n.length === 11 && n.startsWith("0")) {
    out.add(cc + n.slice(1));
  }
  if (n.length === 10 && /^\d+$/.test(n) && !n.startsWith(cc)) {
    out.add(cc + n);
  }
  return [...out];
}

function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb;
}

module.exports = { normalizePhone, expandPhoneMatchKeys, phonesMatch };
