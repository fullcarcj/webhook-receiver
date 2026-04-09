"use strict";

const { z } = require("zod");
const pino = require("pino");
const { pool } = require("../../db");
const { normalizePhone } = require("../utils/phoneNormalizer");
const { customersHasPhone2Column } = require("../utils/customersPhone2");
const { tryWhatsappSalesNameMatchBeforeNewCustomer } = require("./waMlBuyerMatchTipoE");
const {
  sanitizeWaPersonName,
  sanitizeContactDisplayName,
  isWaContactNameBlockedForFullName,
} = require("../whatsapp/waNameCandidate");
const { findCustomerIdByPhoneAndPersonName } = require("./customerDedupPhoneName");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "resolveCustomer" });

/** Placeholder antiguo `WA-584…` o variante con espacios; no es nombre real. */
function isWaPhonePlaceholderFullName(s) {
  const t = String(s || "").trim();
  return /^WA-\d+$/i.test(t);
}

const identitySchema = z.object({
  source: z.enum(["whatsapp", "mercadolibre", "mostrador"]),
  external_id: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  data: z
    .object({
      name: z.string().optional(),
      /** Nombre de perfil WA (fallback legible si no hay `name` válido). */
      contact_name: z.string().optional(),
      phone: z.string().optional(),
      phone2: z.string().optional(),
      email: z.string().optional(),
      id_type: z.string().optional(),
      id_number: z.string().optional(),
    })
    .optional()
    .default({}),
});

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function linkIdentity(db, customerId, source, externalId) {
  await db.query(
    `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
     VALUES ($1, $2::crm_identity_source, $3, FALSE)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [customerId, source, externalId]
  );
}

/** Tras nombre + teléfono reales por WhatsApp: match opcional con ML + tipo E (ver `waMlBuyerMatchTipoE.js`). */
function buildWaMlBuyerTipoECheck(source, data, normalizedPhone, fullNameInsert) {
  if (source !== "whatsapp") return null;
  const raw =
    (resolveNameForEnrich(data, source) || "").trim() ||
    (fullNameInsert && String(fullNameInsert).trim()) ||
    "";
  if (!raw || isWaPhonePlaceholderFullName(raw) || raw === "Cliente WhatsApp" || raw === "Cliente") return null;
  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return null;
  if (!normalizedPhone) return null;
  return { fullName: raw, waPhoneE164: normalizedPhone };
}

function computeInsertFullName(data, source, normalizedExternalId, normalizedPhone) {
  const trimmedName = data.name != null ? String(data.name).trim() : "";
  if (trimmedName && !isWaPhonePlaceholderFullName(trimmedName)) {
    return trimmedName;
  }
  if (source === "whatsapp") {
    if (data.contact_name) return String(data.contact_name).trim();
    return "Cliente WhatsApp";
  }
  if (normalizedPhone) {
    return "Cliente";
  }
  return `${source}-${normalizedExternalId}`;
}

/**
 * Nombre para UPDATE customers: data.name (texto del mensaje ya validado por pickWaFullNameCandidate)
 * o, en WhatsApp, contact_name (pushName saneado) si no hay name — antes enrich ignoraba contact_name
 * y full_name quedaba en "Cliente WhatsApp" para siempre.
 */
function resolveNameForEnrich(data, source) {
  if (data.name != null && String(data.name).trim() !== "") {
    return String(data.name).trim();
  }
  if (source !== "whatsapp" || data.contact_name == null || String(data.contact_name).trim() === "") {
    return null;
  }
  const cn = String(data.contact_name).trim();
  const asPerson = sanitizeWaPersonName(cn);
  if (asPerson) return asPerson;
  const display = sanitizeContactDisplayName(cn);
  if (display && !isWaContactNameBlockedForFullName(display)) return display;
  return null;
}

/**
 * Permite "subir" full_name cuando el actual es débil (placeholder/1 palabra/no-persona)
 * y llega un nombre+apellido válido desde WhatsApp.
 */
function shouldForceNameUpgrade(currentFullName, incomingName) {
  const nextRaw = incomingName != null ? String(incomingName).trim() : "";
  const nextPerson = nextRaw ? sanitizeWaPersonName(nextRaw) : null;
  if (!nextPerson) return false;

  const cur = currentFullName != null ? String(currentFullName).trim() : "";
  if (!cur) return true;
  if (isWaPhonePlaceholderFullName(cur)) return true;
  if (cur === "Cliente WhatsApp" || cur === "Cliente") return true;

  const curPerson = sanitizeWaPersonName(cur);
  return !curPerson;
}

async function enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2, source = "mercadolibre") {
  const resolved = resolveNameForEnrich(data, source);
  const name = resolved && String(resolved).trim() ? String(resolved).trim() : null;
  const email = data.email ? String(data.email).toLowerCase().trim() : null;
  const hasP2 = await customersHasPhone2Column(db);
  let forceNameUpgrade = false;

  if (name) {
    const { rows: currentRows } = await db.query(`SELECT full_name FROM customers WHERE id = $1`, [customerId]);
    const currentFullName = currentRows[0] ? currentRows[0].full_name : null;
    forceNameUpgrade = shouldForceNameUpgrade(currentFullName, name);
  }

  if (hasP2) {
    await db.query(
      `UPDATE customers SET
         full_name = CASE
           WHEN $8::boolean IS TRUE AND $2::text IS NOT NULL
             THEN $2::text
           WHEN $2::text IS NOT NULL AND full_name LIKE 'WA-%' AND $2::text NOT LIKE 'WA-%'
             THEN $2::text
           WHEN $2::text IS NOT NULL AND TRIM(full_name) = 'Cliente WhatsApp' AND NOT ($2::text LIKE 'WA-%')
             THEN $2::text
           WHEN $2::text IS NOT NULL AND TRIM(full_name) = 'Cliente' AND NOT ($2::text LIKE 'WA-%')
             THEN $2::text
           WHEN $2::text IS NOT NULL AND COALESCE(TRIM(full_name), '') = ''
             THEN $2::text
           ELSE full_name
         END,
         phone = COALESCE(NULLIF(TRIM(phone), ''), $3::text),
         phone_2 = COALESCE(NULLIF(TRIM(phone_2), ''), $4::text),
         email = COALESCE(NULLIF(TRIM(email), ''), $5::text),
         id_type = COALESCE(id_type, $6::text),
         id_number = COALESCE(NULLIF(TRIM(id_number), ''), $7::text),
         updated_at = NOW()
       WHERE id = $1`,
      [
        customerId,
        name,
        normalizedPhone,
        normalizedPhone2 ?? null,
        email,
        data.id_type ?? null,
        data.id_number ?? null,
        forceNameUpgrade,
      ]
    );
  } else {
    await db.query(
      `UPDATE customers SET
         full_name = CASE
           WHEN $7::boolean IS TRUE AND $2::text IS NOT NULL
             THEN $2::text
           WHEN $2::text IS NOT NULL AND full_name LIKE 'WA-%' AND $2::text NOT LIKE 'WA-%'
             THEN $2::text
           WHEN $2::text IS NOT NULL AND TRIM(full_name) = 'Cliente WhatsApp' AND NOT ($2::text LIKE 'WA-%')
             THEN $2::text
           WHEN $2::text IS NOT NULL AND TRIM(full_name) = 'Cliente' AND NOT ($2::text LIKE 'WA-%')
             THEN $2::text
           WHEN $2::text IS NOT NULL AND COALESCE(TRIM(full_name), '') = ''
             THEN $2::text
           ELSE full_name
         END,
         phone = COALESCE(NULLIF(TRIM(phone), ''), $3::text),
         email = COALESCE(NULLIF(TRIM(email), ''), $4::text),
         id_type = COALESCE(id_type, $5::text),
         id_number = COALESCE(NULLIF(TRIM(id_number), ''), $6::text),
         updated_at = NOW()
       WHERE id = $1`,
      [customerId, name, normalizedPhone, email, data.id_type ?? null, data.id_number ?? null, forceNameUpgrade]
    );
  }
}

/**
 * @param {object} identity
 * @param {{ client?: import("pg").PoolClient }} [options] — usar mismo client si hay transacción abierta
 */
async function resolveCustomer(identity, options = {}) {
  const parsed = identitySchema.safeParse(identity);
  if (!parsed.success) {
    const e = new Error("VALIDATION_ERROR");
    e.code = "VALIDATION_ERROR";
    e.details = parsed.error.flatten();
    throw e;
  }

  const { source, external_id: extRaw } = parsed.data;
  let data = { ...(parsed.data.data || {}) };
  if (source === "whatsapp" && data.name != null && String(data.name).trim() !== "") {
    const s = sanitizeWaPersonName(String(data.name));
    if (s) data.name = s;
    else delete data.name;
  }
  if (source === "whatsapp" && data.contact_name != null && String(data.contact_name).trim() !== "") {
    const c = sanitizeContactDisplayName(String(data.contact_name));
    if (c && !isWaContactNameBlockedForFullName(c)) data.contact_name = c;
    else delete data.contact_name;
  }
  const db = options.client || pool;

  let normalizedExternalId = extRaw;
  if (source === "whatsapp") {
    const n = normalizePhone(extRaw);
    if (n) {
      normalizedExternalId = n;
    } else {
      const digits = String(extRaw).replace(/\D/g, "");
      normalizedExternalId = digits || String(extRaw);
    }
  }

  const normalizedPhone = data.phone ? normalizePhone(data.phone) : null;
  const normalizedPhone2 = data.phone2 ? normalizePhone(data.phone2) : null;

  const { rows: identityRows } = await db.query(
    `SELECT customer_id FROM crm_customer_identities
     WHERE source = $1::crm_identity_source AND external_id = $2
     LIMIT 1`,
    [source, normalizedExternalId]
  );

  if (identityRows.length) {
    const customerId = Number(identityRows[0].customer_id);
    await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2, source);
    const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, null);
    return {
      customerId,
      isNew: false,
      matchLevel: "identity",
      healed: false,
      ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
    };
  }

  // DECISIÓN: solo usar external_id como “teléfono” en nivel 2 si la fuente es WhatsApp (evita matchear buyer_id ML como teléfono).
  const phoneToSearch =
    normalizedPhone ?? (source === "whatsapp" ? normalizePhone(extRaw) || String(extRaw).replace(/\D/g, "") : null);

  if (phoneToSearch) {
    const { rows: phoneRows } = await db.query(
      `SELECT c.id AS customer_id
       FROM customers c
       WHERE NULLIF(TRIM(c.phone), '') IS NOT NULL
         AND REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
       UNION
       SELECT ci.customer_id
       FROM crm_customer_identities ci
       WHERE ci.external_id = $1
         AND ci.source IN ('whatsapp'::crm_identity_source, 'mostrador'::crm_identity_source)
       LIMIT 1`,
      [phoneToSearch]
    );

    if (phoneRows.length) {
      const customerId = Number(phoneRows[0].customer_id);
      await linkIdentity(db, customerId, source, normalizedExternalId);
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2, source);
      log.info({ customerId, source, external_id: normalizedExternalId }, "resolveCustomer: healing por teléfono");
      const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, null);
      return {
        customerId,
        isNew: false,
        matchLevel: "phone",
        healed: true,
        ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
      };
    }
  }

  if (data.id_type && data.id_number) {
    const { rows: docRows } = await db.query(
      `SELECT id AS customer_id FROM customers
       WHERE id_type = $1 AND id_number = $2
       LIMIT 1`,
      [data.id_type, data.id_number]
    );

    if (docRows.length) {
      const customerId = Number(docRows[0].customer_id);
      await linkIdentity(db, customerId, source, normalizedExternalId);
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2, source);
      const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, null);
      return {
        customerId,
        isNew: false,
        matchLevel: "document",
        healed: true,
        ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
      };
    }
  }

  if (data.email) {
    const em = String(data.email).toLowerCase().trim();
    const { rows: emailRows } = await db.query(
      `SELECT id AS customer_id FROM customers WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
      [em]
    );

    if (emailRows.length) {
      const customerId = Number(emailRows[0].customer_id);
      await linkIdentity(db, customerId, source, normalizedExternalId);
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2, source);
      const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, null);
      return {
        customerId,
        isNew: false,
        matchLevel: "email",
        healed: true,
        ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
      };
    }
  }

  const client = options.client;
  const ownClient = !client;
  const conn = client || (await pool.connect());

  try {
    if (ownClient) await conn.query("BEGIN");

    if (source === "whatsapp") {
      try {
        const pre = await tryWhatsappSalesNameMatchBeforeNewCustomer(conn, {
          normalizedPhone,
          fullNameRaw:
            (data.name && String(data.name).trim()) ||
            (data.contact_name && String(data.contact_name).trim()) ||
            null,
          normalizedExternalId,
        });
        if (pre) {
          if (ownClient) await conn.query("COMMIT");
          return {
            customerId: pre.customerId,
            isNew: pre.isNewCustomer,
            matchLevel: "ml_sales_name_precheck",
            healed: false,
            waMlBuyerTipoECheck: {
              fullName: pre.displayFullName,
              waPhoneE164: normalizedPhone,
              precheckDone: true,
              orderRows: pre.orderRows,
            },
          };
        }
      } catch (e) {
        log.error({ err: e }, "tryWhatsappSalesNameMatchBeforeNewCustomer: se continúa con alta normal");
      }
    }

    const fullName = computeInsertFullName(data, source, normalizedExternalId, normalizedPhone);

    if (source === "whatsapp" && phoneToSearch) {
      const dupId = await findCustomerIdByPhoneAndPersonName(conn, phoneToSearch, fullName);
      if (dupId) {
        await linkIdentity(conn, dupId, source, normalizedExternalId);
        await enrichCustomer(conn, dupId, data, normalizedPhone, normalizedPhone2, source);
        if (ownClient) await conn.query("COMMIT");
        log.info(
          { customerId: dupId, source, external_id: normalizedExternalId },
          "resolveCustomer: mismo teléfono+nombre — reutiliza cliente"
        );
        const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, null);
        return {
          customerId: dupId,
          isNew: false,
          matchLevel: "phone_name_dedup",
          healed: true,
          ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
        };
      }
    }

    // DECISIÓN: ML desde orden API se creaba como 'active'; WhatsApp/nuevo genérico como 'draft'.
    const crmStatus = source === "mercadolibre" ? "active" : "draft";

    const hasP2 = await customersHasPhone2Column(conn);
    let newRows;
    if (hasP2) {
      newRows = await conn.query(
        `INSERT INTO customers
           (company_id, full_name, phone, phone_2, email, id_type, id_number, crm_status, created_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING id`,
        [
          fullName,
          normalizedPhone,
          normalizedPhone2,
          data.email ? String(data.email).toLowerCase().trim() : null,
          data.id_type ?? null,
          data.id_number ?? null,
          crmStatus,
        ]
      );
    } else {
      newRows = await conn.query(
        `INSERT INTO customers
           (company_id, full_name, phone, email, id_type, id_number, crm_status, created_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING id`,
        [
          fullName,
          normalizedPhone,
          data.email ? String(data.email).toLowerCase().trim() : null,
          data.id_type ?? null,
          data.id_number ?? null,
          crmStatus,
        ]
      );
    }

    const customerId = Number(newRows.rows[0].id);

    await conn.query(
      `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
       VALUES ($1, $2::crm_identity_source, $3, TRUE)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [customerId, source, normalizedExternalId]
    );

    if (ownClient) await conn.query("COMMIT");

    log.info({ customerId, source, fullName }, "resolveCustomer: cliente nuevo");
    const waMlBuyerTipoECheck = buildWaMlBuyerTipoECheck(source, data, normalizedPhone, fullName);
    return {
      customerId,
      isNew: true,
      matchLevel: "created",
      healed: false,
      ...(waMlBuyerTipoECheck ? { waMlBuyerTipoECheck } : {}),
    };
  } catch (err) {
    if (ownClient) {
      try {
        await conn.query("ROLLBACK");
      } catch (_r) {
        /* ignore */
      }
    }
    throw err;
  } finally {
    if (ownClient) conn.release();
  }
}

module.exports = { resolveCustomer, identitySchema, shouldForceNameUpgrade };
