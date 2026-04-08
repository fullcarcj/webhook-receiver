"use strict";

/**
 * Limpia nombre/apellido para CRM: quita palabras solo numéricas, trozos tipo teléfono/orden
 * y rechaza cadenas con secuencias largas de dígitos.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function sanitizeWaPersonName(raw) {
  if (raw == null) return null;
  let s = String(raw).normalize("NFC").trim();
  if (!s) return null;
  if (/https?:\/\/|www\./i.test(s)) return null;
  // Solo dígitos, puntos, comas y espacios (p. ej. "123 456 7890")
  if (/^[\d\s.,;:+-]+$/.test(s)) return null;

  const words = s.split(/\s+/).filter((w) => {
    if (!w) return false;
    const core = w.replace(/[.,;:]/g, "");
    if (/^\d+$/.test(core)) return false;
    // Trozo largo de dígitos dentro de la “palabra” (teléfono pegado sin espacio)
    if (/\d{5,}/.test(core)) return false;
    const digits = (core.match(/\d/g) || []).length;
    if (digits > 0 && core.length > 0 && digits >= core.length * 0.5) return false;
    return true;
  });

  let out = words.join(" ").trim().replace(/\s+/g, " ");
  if (/\d{5,}/.test(out)) return null;
  if (out.length < 3) return null;
  const wordList = out.split(/\s+/).filter(Boolean);
  if (wordList.length < 2) return null;
  if (out.length > 60) return out.slice(0, 60).trim();
  return out;
}

/**
 * Texto que claramente no es “solo nombre y apellido” (consulta de producto, etc.).
 * Evita pasar el mensaje entero como `data.name` y romper flujos tipo minibot/CRM.
 */
function isLikelyChatNotName(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/[¿?]/.test(s)) return true;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 6) return true;
  const lower = s.toLowerCase();
  return /\b(tienen|hay|precio|disponible|cuánto|cuanto|necesito|busco|venden|filtro|repuestos?|stock|envío|envio|delivery|comprar|pedido|orden)\b/i.test(
    lower
  );
}

/**
 * Nombre “completo” plausible para CRM / match ML.
 * @param {string} text
 * @returns {boolean}
 */
/**
 * Nombre legible desde el perfil de WhatsApp cuando no hay nombre/apellido válido en el mensaje.
 * Permite una sola palabra (p. ej. "Carlos"); rechaza teléfonos, URLs y texto tipo consulta.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function sanitizeContactDisplayName(raw) {
  if (raw == null) return null;
  let s = String(raw).normalize("NFC").trim();
  if (!s) return null;
  if (/https?:\/\/|www\./i.test(s)) return null;
  if (/^[\d\s.,;:+-]+$/.test(s)) return null;
  if (/^wa[-\s]?\d+$/i.test(s)) return null;
  const words = s.split(/\s+/).filter((w) => {
    const core = w.replace(/[.,;:]/g, "");
    if (!core) return false;
    if (/^\d+$/.test(core)) return false;
    if (/\d{5,}/.test(core)) return false;
    const digits = (core.match(/\d/g) || []).length;
    if (digits > 0 && core.length > 0 && digits >= core.length * 0.5) return false;
    return true;
  });
  let out = words.join(" ").trim().replace(/\s+/g, " ");
  if (/\d{5,}/.test(out)) return null;
  if (out.length < 2) return null;
  if (out.length > 60) out = out.slice(0, 60).trim();
  if (isLikelyChatNotName(out)) return null;
  if (!/[a-záéíóúñü]/i.test(out)) return null;
  return out;
}

function isValidFullName(text) {
  const sanitized = sanitizeWaPersonName(text);
  if (!sanitized) return false;
  const clean = sanitized;
  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return false;
  if (clean.length < 5) return false;
  const noiseWords = [
    "hola",
    "hello",
    "hi",
    "buenas",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "ok",
    "si",
    "no",
  ];
  if (noiseWords.includes(clean.toLowerCase())) return false;
  return true;
}

/**
 * Prioriza el texto del mensaje; si no sirve, el nombre de perfil del contacto.
 * @param {object} normalized — payload normalizado del webhook WA
 * @returns {{ name?: string }}
 */
function pickWaFullNameCandidate(normalized) {
  const t = normalized.content?.text != null ? String(normalized.content.text).trim() : "";
  if (t && !isLikelyChatNotName(t) && isValidFullName(t)) return { name: sanitizeWaPersonName(t) };
  const cn = normalized.contactName != null ? String(normalized.contactName).trim() : "";
  if (cn && !isLikelyChatNotName(cn) && isValidFullName(cn)) return { name: sanitizeWaPersonName(cn) };
  return {};
}

module.exports = {
  isValidFullName,
  pickWaFullNameCandidate,
  sanitizeWaPersonName,
  isLikelyChatNotName,
  sanitizeContactDisplayName,
};
