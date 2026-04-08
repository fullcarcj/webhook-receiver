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

function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb;
}

module.exports = { normalizePhone, phonesMatch };
