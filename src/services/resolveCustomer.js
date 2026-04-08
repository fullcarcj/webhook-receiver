"use strict";

const { z } = require("zod");
const pino = require("pino");
const { pool } = require("../../db");
const { normalizePhone } = require("../utils/phoneNormalizer");
const { customersHasPhone2Column } = require("../utils/customersPhone2");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "resolveCustomer" });

const identitySchema = z.object({
  source: z.enum(["whatsapp", "mercadolibre", "mostrador"]),
  external_id: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  data: z
    .object({
      name: z.string().optional(),
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

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2) {
  const name = data.name && String(data.name).trim() ? String(data.name).trim() : null;
  const email = data.email ? String(data.email).toLowerCase().trim() : null;
  const hasP2 = await customersHasPhone2Column(db);

  if (hasP2) {
    await db.query(
      `UPDATE customers SET
         full_name = CASE
           WHEN $2::text IS NOT NULL AND full_name LIKE 'WA-%' AND $2::text NOT LIKE 'WA-%'
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
      ]
    );
  } else {
    await db.query(
      `UPDATE customers SET
         full_name = CASE
           WHEN $2::text IS NOT NULL AND full_name LIKE 'WA-%' AND $2::text NOT LIKE 'WA-%'
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
      [customerId, name, normalizedPhone, email, data.id_type ?? null, data.id_number ?? null]
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

  const { source, external_id: extRaw, data } = parsed.data;
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
    await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2);
    return {
      customerId,
      isNew: false,
      matchLevel: "identity",
      healed: false,
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
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2);
      log.info({ customerId, source, external_id: normalizedExternalId }, "resolveCustomer: healing por teléfono");
      return { customerId, isNew: false, matchLevel: "phone", healed: true };
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
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2);
      return { customerId, isNew: false, matchLevel: "document", healed: true };
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
      await enrichCustomer(db, customerId, data, normalizedPhone, normalizedPhone2);
      return { customerId, isNew: false, matchLevel: "email", healed: true };
    }
  }

  const client = options.client;
  const ownClient = !client;
  const conn = client || (await pool.connect());

  try {
    if (ownClient) await conn.query("BEGIN");

    const fullName =
      data.name && !String(data.name).startsWith("WA-")
        ? String(data.name).trim()
        : normalizedPhone
          ? `WA-${normalizedPhone}`
          : `${source}-${normalizedExternalId}`;

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
    return { customerId, isNew: true, matchLevel: "created", healed: false };
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

module.exports = { resolveCustomer, identitySchema };
