"use strict";

const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "wa_name_candidate" });

// DECISIÓN: permite guion y apóstrofe para nombres compuestos (García-López, D'Costa)
const _EMOJI_REGEX = /[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u;
const _SYMBOL_REGEX = /[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s'-]/;

const PRESENTATION_PATTERNS = [
  /^(?:mi nombre es|me llamo|mi nombre[:\s]|nombre[:\s])\s*(.+)$/i,
  /^(?:soy)\s+([A-ZÁÉÍÓÚÜÑ][a-záéíóúüña-zA-Z\s'-]{3,})$/i,
  /^(?:apellido[:\s]|mi apellido es)\s*(.+)$/i,
];

function _extractNameFromPhrase(input) {
  for (const pat of PRESENTATION_PATTERNS) {
    const m = input.trim().match(pat);
    if (m?.[1]?.trim()) {
      log.debug({ input, extracted: m[1].trim() }, "nombre extraído de frase de presentación");
      return m[1].trim();
    }
  }
  return input.trim();
}

/**
 * Misma limpieza y extracción ("mi nombre es…") que usa `isValidFullName` antes de IA/heurística.
 * Sirve para persistir el mismo núcleo que validó la IA (evita guardar la frase completa en `customers`).
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
function prepareOnboardingNameInput(input) {
  if (!input || typeof input !== "string") return null;
  let clean = input.replace(_EMOJI_REGEX, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  clean = _extractNameFromPhrase(clean);
  return clean || null;
}

// Registra en ai_usage_log cuando la heurística evitó la llamada a IA
async function _logSkippedAI(reason) {
  try {
    const { pool } = require("../../db");
    await pool.query(
      `INSERT INTO ai_usage_log
         (provider_id, function_called, tokens_input, tokens_output, latency_ms, success, error_message)
       VALUES ('GROQ_LLAMA', 'name_validation_skipped', 0, 0, 0, TRUE, $1)`,
      [`heurística evitó IA: ${reason}`]
    );
  } catch (_) {}
}

const _NAME_VALIDATION_PROMPT = `Eres un validador de nombres de personas venezolanas.
Tu única tarea: determinar si el texto es un nombre propio de persona.

NOMBRES VÁLIDOS (2-4 palabras):
  "Juan Pérez"           → {"is_name": true,  "reason": "nombre y apellido"}
  "María González"       → {"is_name": true,  "reason": "nombre y apellido"}
  "Carlos De La Cruz"    → {"is_name": true,  "reason": "nombre compuesto"}
  "Ana María Rodríguez"  → {"is_name": true,  "reason": "nombre compuesto"}

NO SON NOMBRES:
  "Debemos esperar"       → {"is_name": false, "reason": "contiene verbos"}
  "verifiquen inventario" → {"is_name": false, "reason": "verbo + sustantivo"}
  "Hola buenos"           → {"is_name": false, "reason": "saludo"}
  "Descargando sistema"   → {"is_name": false, "reason": "gerundio + sustantivo"}
  "Ok perfecto"           → {"is_name": false, "reason": "expresión coloquial"}
  "No puedo"              → {"is_name": false, "reason": "negación + verbo"}
  "Sorry no"              → {"is_name": false, "reason": "disculpa + negación"}

Responde SOLO con JSON válido sin texto adicional ni backticks.`;

async function _validateWithAI(input) {
  try {
    const { callChatBasic } = require("../services/aiGateway");
    const response = await callChatBasic({
      systemPrompt: _NAME_VALIDATION_PROMPT,
      userMessage: input,
      usageFunctionCalled: "wa_name_validation",
      responsePostProcessor: (raw) => {
        try {
          const clean = String(raw || "").replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          if (parsed.is_name !== true && parsed.is_name !== false) {
            return { ok: false, error: "json_invalid_is_name_field" };
          }
          const auditMessage = JSON.stringify({
            entrada: String(input).slice(0, 160),
            is_name: parsed.is_name === true,
            reason: String(parsed.reason || "").slice(0, 200),
          });
          return { ok: true, auditMessage };
        } catch (e) {
          return { ok: false, error: `json_parse: ${e.message}` };
        }
      },
    });
    if (!response) return null;
    const clean = String(response).replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    log.info({ input, is_name: parsed.is_name, reason: parsed.reason }, "nombre validado con IA");
    return parsed.is_name === true;
  } catch (err) {
    log.warn({ err: err.message, input }, "AI name validation falló — usando fallback");
    return null;
  }
}

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
  if (isLikelyChatNotName(s)) return null;
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
  if (
    /\b(tienen|hay|precio|disponible|cuánto|cuanto|necesito|busco|venden|filtro|repuestos?|stock|envío|envio|delivery|comprar|pedido|orden)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  // UI / chat (“Listo copiado gracias”, “muchas gracias”, etc.) — no es nombre de persona
  if (/\bcopiado\b/i.test(lower)) return true;
  const chatMarkers =
    lower.match(
      /\b(listo|lista|listas|gracias|perfecto|saludos|vale|muchas|confirmado|recibido|ok|buenísimo)\b/gi
    ) || [];
  if (chatMarkers.length >= 2) return true;
  if (/\b(muchas\s+gracias|de\s+nada|buen[oa]s?\s+(d[ií]as|tardes|noches)|gracias\s+(mil|todo))\b/i.test(lower)) {
    return true;
  }
  return false;
}

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

/**
 * pushName/notify del webhook Wasender (Baileys) a veces traen el nombre comercial del negocio
 * en lugar del cliente. No usar esos valores como full_name en customers.
 * Override: CRM_WA_CONTACT_NAME_DENYLIST=foo,bar (coma, sin espacios obligatorios).
 */
function normalizeWaContactKey(s) {
  return String(s || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const DEFAULT_CONTACT_NAME_DENYLIST = new Set([
  "solomotor",
  "solomotor3k",
  "solomotor 3k",
]);

function getContactNameDenylistSet() {
  const set = new Set(DEFAULT_CONTACT_NAME_DENYLIST);
  const env = String(process.env.CRM_WA_CONTACT_NAME_DENYLIST || "").trim();
  for (const part of env.split(",")) {
    const p = normalizeWaContactKey(part);
    if (p) set.add(p);
  }
  return set;
}

function isWaContactNameBlockedForFullName(raw) {
  const key = normalizeWaContactKey(raw);
  if (!key) return false;
  const deny = getContactNameDenylistSet();
  if (deny.has(key)) return true;
  for (const w of key.split(/\s+/)) {
    if (deny.has(w)) return true;
  }
  return false;
}

/**
 * Valida si el texto es un nombre propio de persona.
 *
 * Árbol de decisión (en orden estricto):
 *   PASO 1 — Limpieza (emojis, espacios)
 *   PASO 2 — Extracción de frase de presentación ("mi nombre es…")
 *   PASO 3 — Filtros de rechazo inmediato SIN IA (dígitos, URLs, símbolos)
 *   PASO 4 — Decisión por cantidad de palabras SIN IA:
 *              0 o >4 palabras → false; 1 palabra → 'ASK_SURNAME'
 *   PASO 5 — Validación semántica con IA (solo 2-4 palabras)
 *              Si IA falla → por defecto **false** (no guardar nombre dudoso). Opcional: WA_NAME_ALLOW_STATIC_FALLBACK=1
 *              restaura fallback heurístico (isLikelyChatNotName + sanitizeWaPersonName).
 *
 * @returns {Promise<true|false|'ASK_SURNAME'>}
 */
async function isValidFullName(input) {
  if (!input || typeof input !== "string") return false;

  // PASO 1 — Limpieza
  let clean = input.replace(_EMOJI_REGEX, "").replace(/\s+/g, " ").trim();
  if (!clean) return false;

  // PASO 2 — Extraer nombre de frase de presentación
  clean = _extractNameFromPhrase(clean);

  // PASO 3 — Filtros de rechazo sin IA
  if (/\d/.test(clean)) {
    await _logSkippedAI("contains_digits");
    return false;
  }
  if (/https?:\/\/|www\.|\.com|\.net/i.test(clean)) {
    await _logSkippedAI("contains_url");
    return false;
  }
  if (_SYMBOL_REGEX.test(clean)) {
    await _logSkippedAI("contains_symbols");
    return false;
  }

  // PASO 4 — Decisión por cantidad de palabras sin IA
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    await _logSkippedAI("empty_after_clean");
    return false;
  }
  if (words.length === 1) {
    await _logSkippedAI("single_word_ask_surname");
    return "ASK_SURNAME";
  }
  if (words.length > 4) {
    await _logSkippedAI("too_many_words");
    return false;
  }
  if (words.some((w) => w.length < 2)) {
    await _logSkippedAI("word_too_short");
    return false;
  }

  // PASO 5 — Validación semántica con IA (2-4 palabras)
  const aiResult = await _validateWithAI(clean);
  if (aiResult === null) {
    const allowFallback = String(process.env.WA_NAME_ALLOW_STATIC_FALLBACK || "")
      .trim()
      .toLowerCase();
    if (allowFallback === "1" || allowFallback === "true" || allowFallback === "yes" || allowFallback === "on") {
      if (isLikelyChatNotName(clean)) return false;
      const fallback = sanitizeWaPersonName(clean) !== null;
      log.warn({ input: clean, fallback }, "fallback estático (WA_NAME_ALLOW_STATIC_FALLBACK)");
      return fallback;
    }
    await _logSkippedAI("ia_unavailable_strict_reject");
    log.warn({ input: clean }, "validación nombre: IA no disponible — rechazo estricto (sin contaminar customers)");
    return false;
  }
  return aiResult;
}

/**
 * Prioriza el texto del mensaje; si no sirve, el nombre de perfil del contacto.
 * Ahora async por isValidFullName. Solo acepta `true` (no 'ASK_SURNAME') para enriquecer.
 * @param {object} normalized — payload normalizado del webhook WA
 * @returns {Promise<{ name?: string }>}
 */
async function pickWaFullNameCandidate(normalized) {
  const t = normalized.content?.text != null ? String(normalized.content.text).trim() : "";
  if (t && !isLikelyChatNotName(t)) {
    const r = await isValidFullName(t);
    if (r === true) {
      const base = prepareOnboardingNameInput(t) || t;
      const name = sanitizeWaPersonName(base);
      if (name) return { name };
    }
  }
  const cn = normalized.contactName != null ? String(normalized.contactName).trim() : "";
  if (cn && !isLikelyChatNotName(cn)) {
    const r = await isValidFullName(cn);
    if (r === true) {
      const base = prepareOnboardingNameInput(cn) || cn;
      const name = sanitizeWaPersonName(base);
      if (name) return { name };
    }
  }
  return {};
}

module.exports = {
  isValidFullName,
  pickWaFullNameCandidate,
  prepareOnboardingNameInput,
  sanitizeWaPersonName,
  isLikelyChatNotName,
  sanitizeContactDisplayName,
  isWaContactNameBlockedForFullName,
};
