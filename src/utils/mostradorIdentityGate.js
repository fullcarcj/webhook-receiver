"use strict";

const CHANNEL_POLICY = require("../config/channelDataPolicy");
const { validateVenezuelanId } = require("./validateVenezuelanId");

const MSG_MISSING =
  "Debe proveer cédula/RIF o teléfono, o marcar consumidor_final: true";

/**
 * Substring escrito en `sales.notes` / `sales_orders.notes` cuando la venta es anónima explícita.
 * Frontend / reportes: `notes.includes('[consumidor_final]')` — corchetes ASCII, sin tilde, minúsculas.
 * @type {string}
 */
const CONSUMIDOR_FINAL_NOTES_TAG = "[consumidor_final]";

function hasPositiveCustomerId(customerId) {
  if (customerId == null || customerId === "") return false;
  const n = Number(customerId);
  return Number.isFinite(n) && n > 0;
}

function phoneNonEmpty(phone) {
  if (phone == null || phone === "") return false;
  return String(phone).trim() !== "";
}

function mergeConsumidorFinal(notes) {
  const base = notes != null && String(notes).trim() !== "" ? String(notes).trim() : "";
  return base ? `${base} ${CONSUMIDOR_FINAL_NOTES_TAG}` : CONSUMIDOR_FINAL_NOTES_TAG;
}

/**
 * Cuerpo JSON estable para HTTP 422 cuando falta identidad en mostrador (integraciones + documentación implícita).
 * @returns {object}
 */
function buildMissingMostradorIdentity422Body() {
  return {
    code: "MISSING_IDENTITY_MOSTRADOR",
    message: MSG_MISSING,
    s1_identity_required: {
      summary:
        "Desde S1, con source mostrador y sin customer_id debe enviarse en el body exactamente una de estas opciones:",
      any_of: [
        {
          option: "document",
          body_fields: { id_type: "V | E | J | G | P", id_number: "string" },
          description: "cédula/RIF con formato válido",
        },
        {
          option: "phone",
          body_fields: { phone: "string no vacío (tras trim)" },
          description: "teléfono de contacto",
        },
        {
          option: "anonymous",
          body_fields: { consumidor_final: true },
          description: "venta anónima explícita (se guarda el tag en notes, ver consumidor_final_notes_tag)",
        },
      ],
    },
    consumidor_final_notes_tag: CONSUMIDOR_FINAL_NOTES_TAG,
  };
}

/**
 * Implementa CHANNEL_POLICY.mostrador (doc: required_or_consumidor_final).
 * @param {object} input
 * @param {unknown} [input.customerId]
 * @param {unknown} [input.id_type]
 * @param {unknown} [input.id_number]
 * @param {unknown} [input.phone]
 * @param {unknown} [input.consumidor_final]
 * @param {unknown} [input.notes]
 * @returns {{ ok: true, notes: string|null } | { ok: false, code: string, message?: string, reason?: string }}
 */
function evaluateMostradorIdentity(input) {
  if (CHANNEL_POLICY.mostrador.doc !== "required_or_consumidor_final") {
    const e = new Error("channelDataPolicy.mostrador incompatible con mostradorIdentityGate");
    e.code = "POLICY_CONFIG_ERROR";
    throw e;
  }

  if (hasPositiveCustomerId(input.customerId)) {
    const n = input.notes != null ? String(input.notes) : null;
    return { ok: true, notes: n };
  }

  const idt = input.id_type != null ? String(input.id_type).trim().toUpperCase() : "";
  const idn = input.id_number != null ? String(input.id_number).trim() : "";
  const phoneOk = phoneNonEmpty(input.phone);

  if (idt && !idn) {
    const v = validateVenezuelanId(idt, idn);
    return { ok: false, code: "INVALID_ID_FORMAT", reason: v.reason || "id_number requerido" };
  }
  if (!idt && idn) {
    return { ok: false, code: "INVALID_ID_FORMAT", reason: "id_type requerido" };
  }

  if (idt && idn) {
    const v = validateVenezuelanId(idt, idn);
    if (!v.valid) {
      return { ok: false, code: "INVALID_ID_FORMAT", reason: v.reason || "documento inválido" };
    }
    let notes = input.notes != null ? String(input.notes) : null;
    if (input.consumidor_final === true) {
      notes = mergeConsumidorFinal(notes);
    }
    return { ok: true, notes };
  }

  if (phoneOk) {
    let notes = input.notes != null ? String(input.notes) : null;
    if (input.consumidor_final === true) {
      notes = mergeConsumidorFinal(notes);
    }
    return { ok: true, notes };
  }

  if (input.consumidor_final === true) {
    const notes = mergeConsumidorFinal(input.notes != null ? String(input.notes) : null);
    return { ok: true, notes };
  }

  return { ok: false, code: "MISSING_IDENTITY_MOSTRADOR", message: MSG_MISSING };
}

module.exports = {
  evaluateMostradorIdentity,
  mergeConsumidorFinal,
  CONSUMIDOR_FINAL_NOTES_TAG,
  buildMissingMostradorIdentity422Body,
};
