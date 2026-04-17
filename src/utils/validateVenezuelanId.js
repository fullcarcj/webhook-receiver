"use strict";

const ALLOWED_TYPES = new Set(["V", "E", "J", "G", "P"]);

/**
 * @param {string|null|undefined} id_type
 * @param {string|null|undefined} id_number
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateVenezuelanId(id_type, id_number) {
  const t = id_type != null ? String(id_type).trim().toUpperCase() : "";
  if (!ALLOWED_TYPES.has(t)) {
    return { valid: false, reason: "id_type inválido" };
  }
  if (id_number == null || String(id_number).trim() === "") {
    return { valid: false, reason: "id_number requerido" };
  }
  const n = String(id_number).trim();

  if (t === "V" || t === "E") {
    if (!/^\d+$/.test(n)) {
      return { valid: false, reason: "cédula: solo dígitos" };
    }
    if (n.length < 6 || n.length > 8) {
      return { valid: false, reason: "cédula: debe tener entre 6 y 8 dígitos" };
    }
    return { valid: true };
  }

  if (t === "J" || t === "G") {
    if (!/^\d+$/.test(n)) {
      return { valid: false, reason: "RIF: solo dígitos" };
    }
    if (n.length < 8 || n.length > 9) {
      return { valid: false, reason: "RIF: debe tener entre 8 y 9 dígitos" };
    }
    return { valid: true };
  }

  if (t === "P") {
    if (!/^[A-Za-z0-9]{5,20}$/.test(n)) {
      return {
        valid: false,
        reason: "pasaporte: 5 a 20 caracteres alfanuméricos",
      };
    }
    return { valid: true };
  }

  return { valid: false, reason: "id_type inválido" };
}

module.exports = { validateVenezuelanId };
