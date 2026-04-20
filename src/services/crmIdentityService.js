"use strict";

const { pool } = require("../../db");
const { normalizePhoneToE164 } = require("../../ml-whatsapp-phone");
const { findCustomerIdByPhoneAndPersonName } = require("./customerDedupPhoneName");

function isSchemaMissing(err) {
  const c = err && err.code;
  // 42P01 undefined_table · 42703 undefined_column · 42704 undefined_object
  return c === "42P01" || c === "42703" || c === "42P04" || c === "42704";
}

function mapSchemaError(err) {
  if (isSchemaMissing(err)) {
    const e = new Error("crm_schema_missing");
    e.code = "CRM_SCHEMA_MISSING";
    e.cause = err;
    return e;
  }
  return err;
}

function parseDocumentForCustomer(documentId) {
  if (documentId == null || String(documentId).trim() === "") {
    return { id_type: null, id_number: null };
  }
  const s = String(documentId).trim();
  const m = /^([VEJGP])[\s\-]?(.+)$/i.exec(s);
  if (m) {
    return { id_type: m[1].toUpperCase(), id_number: m[2].trim() };
  }
  return { id_type: "V", id_number: s };
}

function rowToCustomerApi(row) {
  if (!row) return null;
  const o = { ...row };
  if (o.crm_status != null) {
    o.status = o.crm_status;
  }
  const doc =
    o.id_type && o.id_number != null && String(o.id_number).trim() !== ""
      ? `${o.id_type}-${o.id_number}`
      : null;
  o.document_id = doc;
  return o;
}

class CustomerModel {
  static async findByIdentity(source, externalId) {
    const ext = String(externalId || "").trim();
    if (!ext) return null;
    try {
      const { rows } = await pool.query(
        `SELECT c.*
         FROM customers c
         INNER JOIN crm_customer_identities i ON i.customer_id = c.id
         WHERE i.source = $1::crm_identity_source AND i.external_id = $2
         LIMIT 1`,
        [source, ext]
      );
      return rows[0] || null;
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  static async findByNameFuzzy(fullName, threshold = 0.35, limit = 5) {
    const q = String(fullName || "").trim();
    if (!q) return [];
    const lim = Math.min(Math.max(Number(limit) || 5, 1), 50);
    try {
      const { rows } = await pool.query(
        `SELECT c.*, similarity(LOWER(TRIM(c.full_name)), LOWER($1)) AS sim
         FROM customers c
         WHERE similarity(LOWER(TRIM(c.full_name)), LOWER($1)) > $2
         ORDER BY sim DESC
         LIMIT $3`,
        [q, threshold, lim]
      );
      return rows;
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  /**
   * Búsqueda fuzzy por nombre (pg_trgm). Devuelve clientes con campo `score` (0–1).
   */
  static async searchFuzzy({ q, threshold = 0.35, limit = 10 }) {
    const query = String(q || "").trim();
    if (!query) {
      const e = new Error("q es obligatorio");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const rows = await this.findByNameFuzzy(query, threshold, limit);
    return rows.map((r) => {
      const { sim, ...rest } = r;
      const mapped = rowToCustomerApi(rest);
      return { ...mapped, score: sim != null ? Number(sim) : null };
    });
  }

  static async create({ fullName, documentId, email, status = "draft", phone = null }) {
    const fn = String(fullName || "").trim();
    if (fn.length < 2) {
      const e = new Error("full_name inválido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const { id_type, id_number } = parseDocumentForCustomer(documentId);
    const crm_status = status;
    try {
      const { rows } = await pool.query(
        `INSERT INTO customers (
           company_id, full_name, id_type, id_number, email, phone, crm_status, notes
         ) VALUES (
           1, $1, $2, $3, $4, $5, $6, NULL
         )
         RETURNING *`,
        [fn, id_type, id_number, email != null ? String(email).trim() : null, phone, crm_status]
      );
      return rows[0];
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  static async getWithVehicles(customerId) {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) return null;
    try {
      const { rows: custRows } = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
      const customer = custRows[0];
      if (!customer) return null;

      const { rows: vrows } = await pool.query(
        `SELECT
           cv.*,
           b.name AS brand_name,
           m.name AS model_name,
           g.year_start,
           g.year_end,
           g.engine_info,
           g.body_type
         FROM crm_customer_vehicles cv
         INNER JOIN crm_vehicle_generations g ON g.id = cv.generation_id
         INNER JOIN crm_vehicle_models m ON m.id = g.model_id
         INNER JOIN crm_vehicle_brands b ON b.id = m.brand_id
         WHERE cv.customer_id = $1
         ORDER BY cv.added_at DESC`,
        [id]
      );

      const vehicles = vrows.map((v) => {
        const brand = v.brand_name || "";
        const model = v.model_name || "";
        const ys = v.year_start != null ? String(v.year_start) : "";
        const eng = v.engine_info != null ? String(v.engine_info) : "";
        const label = `${brand} ${model} ${ys} — ${eng}`.trim();
        return {
          ...v,
          label,
        };
      });

      return { ...customer, vehicles };
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  static async list({ search, status, limit = 20, offset = 0 }) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const conds = [];
    const params = [];
    let p = 1;

    if (search != null && String(search).trim() !== "") {
      conds.push(`full_name ILIKE $${p}`);
      params.push(`%${String(search).trim()}%`);
      p += 1;
    }
    if (status != null && String(status).trim() !== "") {
      conds.push(`crm_status = $${p}`);
      params.push(String(status).trim());
      p += 1;
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    try {
      const countSql = `SELECT COUNT(*)::bigint AS n FROM customers ${where}`;
      const { rows: cRows } = await pool.query(countSql, params);
      const total = Number(cRows[0].n) || 0;

      const limitPos = params.length + 1;
      const { rows } = await pool.query(
        `SELECT * FROM customers ${where} ORDER BY id DESC LIMIT $${limitPos} OFFSET $${limitPos + 1}`,
        [...params, lim, off]
      );
      return { rows, total, limit: lim, offset: off };
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  static async update(customerId, patch) {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      const e = new Error("invalid_id");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const sets = [];
    const vals = [];
    let n = 1;

    if (patch.full_name != null) {
      sets.push(`full_name = $${n++}`);
      vals.push(String(patch.full_name).trim());
    }
    if (patch.email !== undefined) {
      sets.push(`email = $${n++}`);
      vals.push(patch.email != null ? String(patch.email).trim() : null);
    }
    if (patch.document_id !== undefined) {
      const { id_type, id_number } = parseDocumentForCustomer(patch.document_id);
      sets.push(`id_type = $${n++}`);
      vals.push(id_type);
      sets.push(`id_number = $${n++}`);
      vals.push(id_number);
    }
    if (patch.status != null) {
      sets.push(`crm_status = $${n++}`);
      vals.push(String(patch.status).trim());
    }

    if (sets.length === 0) {
      const { rows } = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
      return rows[0] || null;
    }

    vals.push(id);
    try {
      const { rows } = await pool.query(
        `UPDATE customers SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`,
        vals
      );
      return rows[0] || null;
    } catch (err) {
      throw mapSchemaError(err);
    }
  }
}

class IdentityModel {
  static async listByCustomerId(customerId) {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      const e = new Error("invalid_id");
      e.code = "BAD_REQUEST";
      throw e;
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, customer_id, source::text AS source, external_id, is_primary, metadata, created_at
         FROM crm_customer_identities
         WHERE customer_id = $1
         ORDER BY is_primary DESC, created_at ASC`,
        [id]
      );
      return rows;
    } catch (err) {
      throw mapSchemaError(err);
    }
  }

  static async link({ customerId, source, externalId, isPrimary = false, metadata = null }) {
    const cid = Number(customerId);
    if (!Number.isFinite(cid) || cid <= 0) {
      const e = new Error("invalid_customer_id");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const ext = String(externalId || "").trim();
    if (!ext) {
      const e = new Error("external_id requerido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO crm_customer_identities (
           customer_id, source, external_id, is_primary, metadata
         ) VALUES ($1, $2::crm_identity_source, $3, $4, $5)
         ON CONFLICT (source, external_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           is_primary = EXCLUDED.is_primary,
           metadata = COALESCE(EXCLUDED.metadata, crm_customer_identities.metadata)
         RETURNING *`,
        [cid, source, ext, !!isPrimary, metadata]
      );
      return rows[0];
    } catch (err) {
      throw mapSchemaError(err);
    }
  }
}

class WhatsAppLogModel {
  static async save({ messageId, customerId, direction = "inbound", payload }) {
    const mid = messageId != null ? String(messageId).trim() : "";
    if (!mid) return null;
    const cid =
      customerId != null && Number.isFinite(Number(customerId)) && Number(customerId) > 0
        ? Number(customerId)
        : null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO crm_whatsapp_logs (message_id, customer_id, direction, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING *`,
        [mid, cid, direction, JSON.stringify(payload != null ? payload : {})]
      );
      return rows[0] || null;
    } catch (_err) {
      return null;
    }
  }
}

async function customerHasMercadolibreLink(customerId) {
  const id = Number(customerId);
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM crm_customer_identities i
         WHERE i.customer_id = $1 AND i.source = 'mercadolibre'
       ) AS ok`,
      [id]
    );
    if (rows[0] && rows[0].ok) return true;
  } catch (err) {
    if (isSchemaMissing(err)) throw mapSchemaError(err);
    throw err;
  }

  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM customer_ml_buyers cmb WHERE cmb.customer_id = $1
       ) AS ok`,
      [id]
    );
    return rows[0] && rows[0].ok;
  } catch (err) {
    if (err && err.code === "42P01") return false;
    throw err;
  }
}

async function findOrCreateCustomer({
  phoneNumber,
  fullName,
  messageId,
  rawPayload,
  fuzzyThreshold = 0.35,
}) {
  const phoneRaw = phoneNumber != null ? String(phoneNumber).trim() : "";
  const normalized = normalizePhoneToE164(phoneRaw) || phoneRaw.replace(/\D/g, "") || phoneRaw;

  const logPayload = async (customerId, matchType, isNew) => {
    await WhatsAppLogModel.save({
      messageId,
      customerId,
      direction: "inbound",
      payload: rawPayload != null ? rawPayload : {},
    });
    const withV = await CustomerModel.getWithVehicles(customerId);
    return {
      customer: withV ? rowToCustomerApi(withV) : null,
      isNew,
      matchType,
      raw: withV,
    };
  };

  if (normalized) {
    const byPhone = await CustomerModel.findByIdentity("whatsapp", normalized);
    if (byPhone) {
      await WhatsAppLogModel.save({
        messageId,
        customerId: byPhone.id,
        direction: "inbound",
        payload: rawPayload != null ? rawPayload : {},
      });
      const withV = await CustomerModel.getWithVehicles(byPhone.id);
      return {
        customer: withV ? rowToCustomerApi(withV) : rowToCustomerApi(byPhone),
        isNew: false,
        matchType: "phone_exact",
        raw: withV,
      };
    }
  }

  const name = fullName != null ? String(fullName).trim() : "";

  if (normalized && name) {
    const dupId = await findCustomerIdByPhoneAndPersonName(pool, normalized, name);
    if (dupId) {
      await IdentityModel.link({
        customerId: dupId,
        source: "whatsapp",
        externalId: normalized,
        isPrimary: true,
        metadata: { linked_via: "phone_name_dedup" },
      });
      return logPayload(dupId, "phone_name_dedup", false);
    }
  }

  const candidates = name ? await CustomerModel.findByNameFuzzy(name, fuzzyThreshold) : [];

  for (const cand of candidates) {
    const hasMl = await customerHasMercadolibreLink(cand.id);
    if (hasMl && normalized) {
      await IdentityModel.link({
        customerId: cand.id,
        source: "whatsapp",
        externalId: normalized,
        isPrimary: false,
        metadata: { linked_via: "fuzzy_name_ml" },
      });
      return logPayload(cand.id, "fuzzy_name_ml", false);
    }
  }

  const created = await CustomerModel.create({
    fullName: name || "Sin nombre",
    documentId: undefined,
    email: undefined,
    status: "draft",
    phone: normalized || null,
  });

  if (normalized) {
    await IdentityModel.link({
      customerId: created.id,
      source: "whatsapp",
      externalId: normalized,
      isPrimary: true,
      metadata: null,
    });
  }

  return logPayload(created.id, "created", true);
}

async function listWhatsappLogs({ customerId, limit = 50, offset = 0 }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const params = [];
  let p = 1;
  if (customerId != null && String(customerId).trim() !== "") {
    const cid = Number(customerId);
    if (!Number.isFinite(cid) || cid <= 0) {
      const e = new Error("invalid_customer_id");
      e.code = "BAD_REQUEST";
      throw e;
    }
    conds.push(`customer_id = $${p}`);
    params.push(cid);
    p += 1;
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  try {
    const { rows } = await pool.query(
      `SELECT * FROM crm_whatsapp_logs ${where}
       ORDER BY received_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, lim, off]
    );
    return { data: rows, meta: { limit: lim, offset: off } };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function insertCustomerVehicle(customerId, body) {
  const cid = Number(customerId);
  const gid = Number(body.generation_id);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(gid) || gid <= 0) {
    const e = new Error("invalid_ids");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO crm_customer_vehicles (customer_id, generation_id, plate, color, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        cid,
        gid,
        body.plate != null ? String(body.plate).trim() : null,
        body.color != null ? String(body.color).trim() : null,
        body.notes != null ? String(body.notes) : null,
      ]
    );
    return rows[0];
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function deleteCustomerVehicle(customerId, vehicleId) {
  const cid = Number(customerId);
  const vid = Number(vehicleId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(vid) || vid <= 0) {
    const e = new Error("invalid_ids");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM crm_customer_vehicles WHERE id = $1 AND customer_id = $2`,
      [vid, cid]
    );
    return rowCount > 0;
  } catch (err) {
    throw mapSchemaError(err);
  }
}

module.exports = {
  CustomerModel,
  IdentityModel,
  WhatsAppLogModel,
  findOrCreateCustomer,
  listWhatsappLogs,
  insertCustomerVehicle,
  deleteCustomerVehicle,
  rowToCustomerApi,
  mapSchemaError,
  parseDocumentForCustomer,
};
