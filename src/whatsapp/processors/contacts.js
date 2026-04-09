"use strict";

const { pool } = require("../../../db");
const { normalizePhoneDigits } = require("./_shared");
const {
  sanitizeWaPersonName,
  sanitizeContactDisplayName,
  isWaContactNameBlockedForFullName,
} = require("../waNameCandidate");

async function handle(normalized) {
  const ev = normalized.eventType || "contacts.upsert";
  const phone = normalizePhoneDigits(normalized.fromPhone);
  if (!phone) return;

  if (ev === "contacts.upsert" || ev === "contacts.update") {
    // Tipo H onboarding: no crear customers por eventos de contactos.
    // Este processor solo puede enriquecer nombres de clientes existentes.
  }

  if (ev === "contacts.update" && normalized.contactName) {
    const raw = String(normalized.contactName);
    const safeName = sanitizeWaPersonName(raw) || sanitizeContactDisplayName(raw);
    if (safeName && !isWaContactNameBlockedForFullName(safeName)) {
      await pool.query(
        `UPDATE customers c
         SET full_name = $1, updated_at = NOW()
         FROM crm_customer_identities ci
         WHERE ci.customer_id = c.id
           AND ci.source = 'whatsapp'::crm_identity_source
           AND ci.external_id = $2
           AND (c.full_name LIKE 'WA-%' OR TRIM(c.full_name) IN ('Cliente WhatsApp', 'Cliente'))`,
        [safeName, phone]
      );
    }
  }
}

module.exports = { handle };
