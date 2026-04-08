"use strict";

const { pool } = require("../../../db");
const { findOrCreateCustomer } = require("../../services/crmIdentityService");
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
    try {
      const cn = normalized.contactName ? sanitizeWaPersonName(String(normalized.contactName)) : null;
      const disp = normalized.contactName ? sanitizeContactDisplayName(String(normalized.contactName)) : null;
      const label =
        cn ||
        (disp && !isWaContactNameBlockedForFullName(disp) ? disp : null) ||
        "Cliente WhatsApp";
      await findOrCreateCustomer({
        phoneNumber: phone,
        fullName: label,
        messageId: `contact-${phone}-${Date.now()}`,
        rawPayload: normalized.rawPayload || {},
        fuzzyThreshold: 0.35,
      });
    } catch (_e) {
      /* ignore */
    }
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
