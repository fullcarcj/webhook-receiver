"use strict";

const { pool } = require("../../../db");
const { findOrCreateCustomer } = require("../../services/crmIdentityService");
const { normalizePhoneDigits } = require("./_shared");

async function handle(normalized) {
  const ev = normalized.eventType || "contacts.upsert";
  const phone = normalizePhoneDigits(normalized.fromPhone);
  if (!phone) return;

  if (ev === "contacts.upsert" || ev === "contacts.update") {
    try {
      await findOrCreateCustomer({
        phoneNumber: phone,
        fullName: normalized.contactName || `WA-${phone}`,
        messageId: `contact-${phone}-${Date.now()}`,
        rawPayload: normalized.rawPayload || {},
        fuzzyThreshold: 0.35,
      });
    } catch (_e) {
      /* ignore */
    }
  }

  if (ev === "contacts.update" && normalized.contactName) {
    await pool.query(
      `UPDATE customers c
       SET full_name = $1, updated_at = NOW()
       FROM crm_customer_identities ci
       WHERE ci.customer_id = c.id
         AND ci.source = 'whatsapp'::crm_identity_source
         AND ci.external_id = $2
         AND c.full_name LIKE 'WA-%'`,
      [normalized.contactName, phone]
    );
  }
}

module.exports = { handle };
