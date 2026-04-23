"use strict";

const {
  sanitizeWaPersonName,
  isLikelyChatNotName,
  isWaContactNameBlockedForFullName,
} = require("../whatsapp/waNameCandidate");

/**
 * Heurística local (sin Groq) para auditar `customers.full_name`.
 * @param {string|null|undefined} fullName
 * @returns {{ level: string, reasons: string[], sanitized_preview: string|null }}
 */
function auditCustomerFullName(fullName) {
  const reasons = [];
  const s = String(fullName ?? "").trim();
  if (!s) {
    return { level: "empty", reasons: ["nombre_vacío"], sanitized_preview: null };
  }
  if (isLikelyChatNotName(s)) reasons.push("texto_tipo_chat_o_consulta");
  if (isWaContactNameBlockedForFullName(s)) reasons.push("denylist_marca_contacto");
  const lower = s.toLowerCase();
  if (/^cliente(\s+whatsapp)?$/i.test(lower)) reasons.push("placeholder_cliente_whatsapp");
  if (/^wa-/i.test(s.trim())) reasons.push("prefijo_WA");
  if (/\d{5,}/.test(s.replace(/\s/g, ""))) reasons.push("muchos_dígitos");
  if (/\d/.test(s) && !/^\+?\d[\d\s\-+]{6,}$/.test(s)) {
    const digitRatio = ((s.match(/\d/g) || []).length / Math.max(s.length, 1));
    if (digitRatio > 0.15) reasons.push("dígitos_mezclados_en_nombre");
  }
  const words = s.split(/\s+/).filter(Boolean);
  const sanitized = sanitizeWaPersonName(s);
  if (words.length >= 2 && sanitized == null) reasons.push("sanitize_rechaza_forma_persona");

  const compact = s.replace(/\s/g, "");
  if (/^[A-Za-z]{1,4}\d{10,}$/.test(compact)) reasons.push("prefijo_letras_id_numerico_largo");
  if (/\d{12,}/.test(compact)) reasons.push("cadena_12_digitos_tipo_fecha_id");
  if (/^[A-Za-z]{5,}\d{4,}[A-Za-z0-9]*$/i.test(compact) && /\d/.test(compact) && compact.length >= 10) {
    reasons.push("mezcla_letras_digitos_tipo_codigo");
  }
  if (words.length === 1 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{15,}$/.test(compact)) {
    reasons.push("una_sola_palabra_muy_larga_sin_espacios");
  }
  if (/_/g.test(s) && !/\s/.test(s)) reasons.push("guion_bajo_sin_espacios_tipo_handle");

  let level = "ok";
  if (
    reasons.some(
      (r) =>
        r.startsWith("placeholder") ||
        r === "denylist_marca_contacto" ||
        r === "texto_tipo_chat_o_consulta"
    )
  ) {
    level = "alto";
  } else if (reasons.length) {
    level = "medio";
  }

  return { level, reasons, sanitized_preview: sanitized };
}

module.exports = { auditCustomerFullName };
