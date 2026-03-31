/**
 * Normaliza teléfonos de `ml_buyers.phone_1` / `phone_2` a formato E.164 para Wasender (`to`).
 * Por defecto país Venezuela (58) si falta prefijo internacional.
 *
 * @param {string|null|undefined} raw
 * @param {string} [defaultCountryDigits] — sin +, p. ej. "58"
 * @returns {string|null}
 */
function normalizePhoneToE164(raw, defaultCountryDigits = "58") {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, "");
  const cc = String(defaultCountryDigits || "58").replace(/\D/g, "") || "58";
  if (s.startsWith("+")) {
    const digits = "+" + s.slice(1).replace(/\D/g, "");
    return digits.length >= 11 ? digits : null;
  }
  let d = s.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.startsWith(cc)) return "+" + d;
  if (d.length >= 8 && d.length <= 11) return "+" + cc + d;
  if (d.length >= 12) return "+" + d;
  return null;
}

module.exports = {
  normalizePhoneToE164,
};
