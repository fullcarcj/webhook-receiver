"use strict";

const pino = require("pino");
const { pool } = require("../../../db");
const { normalizePhoneDigits } = require("./_shared");
const {
  sanitizeWaPersonName,
  sanitizeContactDisplayName,
  isWaContactNameBlockedForFullName,
} = require("../waNameCandidate");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "contacts_processor" });

// ── Palabras clave que indican cliente B2B ────────────────────────────────────
const B2B_KEYWORDS = [
  "taller", "mecánico", "mecánica", "repuesto", "repuestera",
  "autopartes", "concesionario", "servicio", "técnico", "técnica",
  "garage", "garaje", "motor", "automóvil", "automotriz",
  "carrocería", "rectificadora", "empresa", "c.a.", "s.a.", "compañía",
];

function detectB2BFromText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return B2B_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Enriquecimiento comercial post-actualización de nombre ────────────────────
// Fire-and-forget: nunca bloquear el flujo principal
async function enrichContactCommercially(contact, customerId) {
  try {
    const {
      notify,
      verifiedName,
      status,
      isBusiness,
      isEnterprise,
    } = contact;

    // Determinar segmento comercial
    let segment = "personal";
    if (isEnterprise || verifiedName) {
      segment = "enterprise";
    } else if (
      isBusiness ||
      detectB2BFromText(verifiedName) ||
      detectB2BFromText(status) ||
      detectB2BFromText(notify)
    ) {
      segment = "business";
    }

    // Construir UPDATE dinámico — solo campos presentes en el payload
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (notify !== undefined) {
      updates.push(`wa_notify = $${idx++}`);
      values.push(notify ?? null);
    }

    if (isBusiness !== undefined) {
      updates.push(`wa_is_business = $${idx++}`);
      values.push(!!isBusiness);
    }

    if (verifiedName !== undefined) {
      updates.push(`wa_verified_name = $${idx++}`);
      values.push(verifiedName ?? null);
    }

    if (status !== undefined) {
      updates.push(`wa_status = $${idx++}`);
      values.push(status ?? null);
    }

    // Siempre actualizar last_wa_seen y wa_enriched_at
    updates.push(`last_wa_seen = NOW()`);
    updates.push(`wa_enriched_at = NOW()`);

    // NO degradar: si ya es 'business' no bajar a 'personal'
    if (segment !== "personal") {
      updates.push(`client_segment = $${idx++}`);
      values.push(segment);
    }

    if (!updates.length) return;

    values.push(customerId);
    await pool.query(
      `UPDATE customers SET ${updates.join(", ")} WHERE id = $${idx}`,
      values
    );

    // Notificar via SSE si es cliente B2B recién detectado
    if (segment === "business" || segment === "enterprise") {
      const { rows } = await pool.query(
        "SELECT full_name, phone FROM customers WHERE id = $1",
        [customerId]
      );
      // DECISIÓN: path corregido — desde src/whatsapp/processors/ sube dos niveles a src/services/
      const { emit } = require("../../services/sseService");
      emit("business_customer_detected", {
        customer_id:   customerId,
        full_name:     rows[0]?.full_name,
        phone:         rows[0]?.phone,
        segment,
        verified_name: verifiedName ?? null,
        wa_status:     status ?? null,
        message: `Cliente B2B detectado: ${rows[0]?.full_name ?? "Sin nombre"} — ${verifiedName ?? status ?? "WA Business"}`,
      });
      log.info({ customerId, segment, verifiedName, isBusiness, notify }, "cliente B2B detectado via contacts.update");
    }
  } catch (err) {
    log.error({ err: err.message, customerId }, "error en enriquecimiento comercial contacts.update");
  }
}

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
           AND c.is_active = TRUE
           AND (c.full_name LIKE 'WA-%' OR TRIM(c.full_name) IN ('Cliente WhatsApp', 'Cliente'))`,
        [safeName, phone]
      );
    }
  }

  // ── Enriquecimiento comercial (B2B / wa_notify / wa_status / etc.) ──────────
  // Solo para contacts.update; fire-and-forget para no bloquear el pipeline.
  if (ev === "contacts.update") {
    // Resolver customerId via identidad WhatsApp (SELECT separado — no modifica lógica existente)
    let customerId = null;
    try {
      const idRow = await pool.query(
        `SELECT ci.customer_id
         FROM crm_customer_identities ci
         INNER JOIN customers c ON c.id = ci.customer_id AND c.is_active = TRUE
         WHERE ci.source = 'whatsapp'::crm_identity_source
           AND ci.external_id = $1
         LIMIT 1`,
        [phone]
      );
      customerId = idRow.rows[0]?.customer_id ?? null;
    } catch (err) {
      log.warn({ err: err.message, phone }, "contacts.update: no se pudo resolver customerId para enriquecimiento");
    }

    if (customerId) {
      // Extraer campos comerciales del payload crudo de Wasender/Baileys
      const rawBody     = normalized.rawPayload || {};
      const rawData     = rawBody.data != null ? rawBody.data : rawBody;
      const rawContacts = Array.isArray(rawData.contacts) ? rawData.contacts : [];
      // DECISIÓN: fallback a rawData si contacts[] vacío (variantes de payload Wasender)
      const rawContact  = rawContacts[0] || rawData;

      const contact = {
        notify:       rawContact.notify       != null ? String(rawContact.notify)       : undefined,
        verifiedName: rawContact.verifiedName != null ? String(rawContact.verifiedName) : undefined,
        status:       rawContact.status       != null ? String(rawContact.status)       : undefined,
        isBusiness:   rawContact.isBusiness   !== undefined ? rawContact.isBusiness     : undefined,
        isEnterprise: rawContact.isEnterprise !== undefined ? rawContact.isEnterprise   : undefined,
        imgUrl:       rawContact.imgUrl       != null ? String(rawContact.imgUrl)       : undefined,
      };

      enrichContactCommercially(contact, customerId).catch((err) =>
        log.error({ err: err.message }, "enrichContactCommercially falló")
      );
    }
  }
}

module.exports = { handle };
