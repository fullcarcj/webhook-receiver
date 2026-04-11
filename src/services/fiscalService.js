"use strict";

const { pool } = require("../../db-postgres");

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

/**
 * @param {number} companyId
 * @returns {Promise<Record<string, string|number|boolean>>}
 */
async function getSettings(companyId = 1) {
  const sql = `
    SELECT DISTINCT ON (key)
      key, value, value_type, description
    FROM settings_tax
    WHERE company_id = $1
      AND effective_from <= CURRENT_DATE
    ORDER BY key, effective_from DESC
  `;
  const { rows } = await pool.query(sql, [companyId]);
  const out = {};
  for (const r of rows) {
    const k = r.key;
    const vt = String(r.value_type || "string");
    const raw = r.value != null ? String(r.value) : "";
    if (vt === "number") {
      const n = parseFloat(raw);
      out[k] = Number.isFinite(n) ? n : raw;
    } else if (vt === "boolean") {
      out[k] = raw === "1";
    } else {
      out[k] = raw;
    }
  }
  return out;
}

/**
 * @param {string} key
 * @param {number} companyId
 * @returns {Promise<string|null>}
 */
async function getSetting(key, companyId = 1) {
  const { rows } = await pool.query(`SELECT get_tax_setting($1::text, $2::int) AS v`, [
    String(key || "").trim(),
    companyId,
  ]);
  const v = rows[0] && rows[0].v;
  return v != null ? String(v) : null;
}

/**
 * @param {{ key: string, value: string, companyId?: number, userId?: number|null, notes?: string|null }} p
 */
async function updateSetting(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const key = String(p.key || "").trim();
  if (!key) throw Object.assign(new Error("key requerido"), { status: 400, code: "BAD_KEY" });

  const { rows: metaRows } = await pool.query(
    `SELECT value_type, allowed_values FROM settings_tax
     WHERE company_id = $1 AND key = $2
     ORDER BY effective_from DESC LIMIT 1`,
    [companyId, key]
  );
  if (!metaRows.length) {
    throw Object.assign(new Error(`Clave fiscal desconocida: ${key}`), { status: 404, code: "UNKNOWN_KEY" });
  }
  const valueType = String(metaRows[0].value_type || "string");
  const allowed = metaRows[0].allowed_values != null ? String(metaRows[0].allowed_values) : "";
  const rawVal = p.value != null ? String(p.value).trim() : "";

  if (valueType === "number") {
    if (rawVal === "" || !Number.isFinite(Number(rawVal))) {
      throw Object.assign(new Error("Valor numérico inválido"), { status: 400, code: "INVALID_NUMBER" });
    }
  } else if (valueType === "boolean") {
    if (rawVal !== "0" && rawVal !== "1") {
      throw Object.assign(new Error("boolean debe ser 0 o 1"), { status: 400, code: "INVALID_BOOLEAN" });
    }
  } else if (valueType === "enum" && allowed) {
    const set = new Set(
      allowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (!set.has(rawVal)) {
      throw Object.assign(
        new Error(`Valor no permitido para ${key}. Opciones: ${allowed}`),
        { status: 400, code: "INVALID_ENUM" }
      );
    }
  }

  const { rows: todayRows } = await pool.query(
    `SELECT id FROM settings_tax
     WHERE company_id = $1 AND key = $2 AND effective_from = CURRENT_DATE`,
    [companyId, key]
  );

  if (todayRows.length) {
    await pool.query(
      `UPDATE settings_tax
       SET value = $1, updated_by = $2, updated_at = now()
       WHERE id = $3`,
      [rawVal, p.userId != null ? Number(p.userId) : null, todayRows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO settings_tax
        (company_id, key, value, value_type, description, allowed_values, effective_from, updated_by)
       SELECT company_id, key, $1::text, value_type, description, allowed_values, CURRENT_DATE, $2::int
       FROM settings_tax
       WHERE company_id = $3 AND key = $4
       ORDER BY effective_from DESC
       LIMIT 1`,
      [rawVal, p.userId != null ? Number(p.userId) : null, companyId, key]
    );
  }

  const fresh = await getSetting(key, companyId);
  const settings = await getSettings(companyId);
  return { key, value: fresh, parsed: settings[key], value_type: valueType };
}

/**
 * @param {{ taxType: string, year: number, month?: number|null, companyId?: number }} p
 */
async function openPeriod(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const taxType = String(p.taxType || "").trim();
  const year = Number(p.year);
  const month = p.month != null && p.month !== "" ? Number(p.month) : null;
  const { rows } = await pool.query(
    `SELECT (open_fiscal_period($1::text, $2::int, $3::int, $4::int)).*`,
    [taxType, year, Number.isFinite(month) ? month : null, companyId]
  );
  return rows[0] || null;
}

/**
 * @param {{ periodId: number|string, userId?: number|null }} p
 */
async function closePeriod(p) {
  const id = Number(p.periodId);
  const { rows } = await pool.query(`SELECT close_fiscal_period($1::bigint, $2::int) AS doc`, [
    id,
    p.userId != null ? Number(p.userId) : null,
  ]);
  return rows[0] && rows[0].doc != null ? rows[0].doc : null;
}

function settingKeyForTaxType(taxType) {
  const t = String(taxType || "").toUpperCase();
  if (t === "IVA") return "iva_rate_pct";
  if (t === "ISLR") return "islr_retention_pct";
  throw Object.assign(new Error(`tax_type no soportado para hecho imponible: ${taxType}`), {
    status: 400,
    code: "UNSUPPORTED_TAX",
  });
}

/**
 * @param {{
 *   companyId?: number,
 *   fiscalPeriodId: number|string,
 *   taxType: string,
 *   sourceType: string,
 *   sourceId: number|string,
 *   transactionDate: string,
 *   baseAmountUsd: number|string,
 *   rateApplied?: number|string|null,
 * }} p
 */
async function recordTaxTransaction(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const fiscalPeriodId = Number(p.fiscalPeriodId);
  const taxType = String(p.taxType || "").trim().toUpperCase();
  const sourceType = String(p.sourceType || "").trim();
  const sourceId = Number(p.sourceId);
  const transactionDate = String(p.transactionDate || "").trim().slice(0, 10);
  const base = Number(p.baseAmountUsd);
  const rateApplied =
    p.rateApplied != null && String(p.rateApplied).trim() !== ""
      ? Number(p.rateApplied)
      : null;

  if (!transactionDate) {
    throw Object.assign(new Error("transaction_date requerido"), { status: 400 });
  }
  if (!Number.isFinite(base) || (sourceType !== "adjustment" && base <= 0) || (sourceType === "adjustment" && base === 0)) {
    throw Object.assign(new Error("base_amount_usd inválido"), { status: 400 });
  }
  if (!Number.isFinite(sourceId)) {
    throw Object.assign(new Error("source_id inválido"), { status: 400 });
  }

  const sk = settingKeyForTaxType(taxType);
  const { rows: rateRows } = await pool.query(
    `SELECT get_tax_setting_num($1::text, $2::int, $3::date) AS r`,
    [sk, companyId, transactionDate]
  );
  const taxRatePct = rateRows[0] && rateRows[0].r != null ? Number(rateRows[0].r) : NaN;
  if (!Number.isFinite(taxRatePct) || taxRatePct <= 0) {
    throw Object.assign(new Error(`Sin tasa vigente en settings_tax para ${sk}`), { status: 400, code: "NO_RATE" });
  }
  const taxAmountUsd = round4((base * taxRatePct) / 100);

  const { rows } = await pool.query(
    `INSERT INTO tax_transactions (
       company_id, fiscal_period_id, tax_type, source_type, source_id,
       transaction_date, base_amount_usd, tax_rate_pct, tax_amount_usd,
       retention_role, rate_applied
     ) VALUES (
       $1, $2, $3::tax_type, $4, $5,
       $6::date, $7, $8, $9,
       NULL, $10
     )
     RETURNING *`,
    [
      companyId,
      fiscalPeriodId,
      taxType,
      sourceType,
      sourceId,
      transactionDate,
      base,
      taxRatePct,
      taxAmountUsd,
      Number.isFinite(rateApplied) && rateApplied > 0 ? rateApplied : null,
    ]
  );
  return rows[0];
}

function retentionSettingKey(taxType) {
  const t = String(taxType || "").toUpperCase();
  if (t === "IVA_RETENIDO") return "iva_retention_pct";
  if (t === "ISLR_RETENIDO") return "islr_retention_pct";
  throw Object.assign(new Error(`tax_type de retención inválido: ${taxType}`), { status: 400 });
}

/**
 * @param {{
 *   companyId?: number,
 *   fiscalPeriodId: number|string,
 *   retentionRole: string,
 *   counterpartName: string,
 *   counterpartRif?: string|null,
 *   comprobante?: string|null,
 *   retentionDate: string,
 *   taxType: string,
 *   baseAmountUsd: number|string,
 *   rateApplied?: number|string|null,
 *   purchaseId?: number|string|null,
 *   saleId?: number|string|null,
 * }} p
 */
async function recordRetention(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const role = String(p.retentionRole || "").trim().toUpperCase();
  if (role === "AGENT") {
    const { rows } = await pool.query(
      `SELECT get_tax_setting_bool('is_retention_agent', $1::int, CURRENT_DATE) AS b`,
      [companyId]
    );
    const ok = rows[0] && rows[0].b === true;
    if (!ok) {
      throw Object.assign(
        new Error("Esta empresa no está configurada como agente de retención"),
        { status: 403, code: "NOT_RETENTION_AGENT" }
      );
    }
  }

  const taxType = String(p.taxType || "").trim().toUpperCase();
  const sk = retentionSettingKey(taxType);
  const retentionDate = String(p.retentionDate || "").trim().slice(0, 10);
  const base = Number(p.baseAmountUsd);
  if (!retentionDate) throw Object.assign(new Error("retention_date requerido"), { status: 400 });
  if (!Number.isFinite(base) || base <= 0) {
    throw Object.assign(new Error("base_amount_usd inválido"), { status: 400 });
  }

  const { rows: rateRows } = await pool.query(
    `SELECT get_tax_setting_num($1::text, $2::int, $3::date) AS r`,
    [sk, companyId, retentionDate]
  );
  const pct = rateRows[0] && rateRows[0].r != null ? Number(rateRows[0].r) : NaN;
  if (!Number.isFinite(pct) || pct <= 0) {
    throw Object.assign(new Error(`Sin tasa de retención en settings_tax para ${sk}`), { status: 400 });
  }
  const retentionAmountUsd = round4((base * pct) / 100);
  const rateApplied =
    p.rateApplied != null && String(p.rateApplied).trim() !== ""
      ? Number(p.rateApplied)
      : null;
  const fiscalPeriodId = Number(p.fiscalPeriodId);
  const counterpartName = String(p.counterpartName || "").trim();
  if (!counterpartName) throw Object.assign(new Error("counterpart_name requerido"), { status: 400 });

  const purchaseId =
    p.purchaseId != null && String(p.purchaseId).trim() !== "" ? Number(p.purchaseId) : null;
  const saleId = p.saleId != null && String(p.saleId).trim() !== "" ? Number(p.saleId) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: retRows } = await client.query(
      `INSERT INTO retentions (
         company_id, fiscal_period_id, retention_role, counterpart_name, counterpart_rif,
         comprobante_number, retention_date, tax_type,
         base_amount_usd, retention_rate_pct, retention_amount_usd,
         rate_applied, purchase_id, sale_id
       ) VALUES (
         $1, $2, $3::retention_role, $4, $5,
         $6, $7::date, $8::tax_type,
         $9, $10, $11,
         $12, $13, $14
       )
       RETURNING *`,
      [
        companyId,
        fiscalPeriodId,
        role,
        counterpartName,
        p.counterpartRif != null ? String(p.counterpartRif).trim() || null : null,
        p.comprobante != null ? String(p.comprobante).trim() || null : null,
        retentionDate,
        taxType,
        base,
        pct,
        retentionAmountUsd,
        Number.isFinite(rateApplied) && rateApplied > 0 ? rateApplied : null,
        Number.isFinite(purchaseId) ? purchaseId : null,
        Number.isFinite(saleId) ? saleId : null,
      ]
    );
    const ret = retRows[0];
    const sourceType = role === "AGENT" ? "retention_issued" : "retention_received";
    await client.query(
      `INSERT INTO tax_transactions (
         company_id, fiscal_period_id, tax_type, source_type, source_id,
         transaction_date, base_amount_usd, tax_rate_pct, tax_amount_usd,
         retention_role, rate_applied
       ) VALUES (
         $1, $2, $3::tax_type, $4, $5,
         $6::date, $7, $8, $9,
         $10::retention_role, $11
       )`,
      [
        companyId,
        fiscalPeriodId,
        taxType,
        sourceType,
        ret.id,
        retentionDate,
        base,
        pct,
        retentionAmountUsd,
        role,
        Number.isFinite(rateApplied) && rateApplied > 0 ? rateApplied : null,
      ]
    );
    await client.query("COMMIT");
    return ret;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {{ taxType: string, year: number, month?: number|null, companyId?: number }} p
 */
async function getPeriod(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const taxType = String(p.taxType || "").trim().toUpperCase();
  const year = Number(p.year);
  const month = p.month != null && p.month !== "" ? Number(p.month) : null;
  const { rows } = await pool.query(
    `SELECT fp.*,
       (SELECT COUNT(*)::int FROM tax_transactions tt WHERE tt.fiscal_period_id = fp.id) AS transaction_count
     FROM fiscal_periods fp
     WHERE fp.company_id = $1
       AND fp.tax_type = $2::tax_type
       AND fp.period_year = $3
       AND (fp.period_month IS NOT DISTINCT FROM $4)`,
    [companyId, taxType, year, Number.isFinite(month) ? month : null]
  );
  return rows[0] || null;
}

/**
 * @param {{ companyId?: number, taxType?: string|null, status?: string|null }} p
 */
async function listPeriods(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const params = [companyId];
  let sql = `SELECT * FROM v_fiscal_periods_summary WHERE company_id = $1`;
  if (p.taxType != null && String(p.taxType).trim() !== "") {
    params.push(String(p.taxType).trim().toUpperCase());
    sql += ` AND tax_type = $${params.length}::tax_type`;
  }
  if (p.status != null && String(p.status).trim() !== "") {
    params.push(String(p.status).trim().toUpperCase());
    sql += ` AND status::text = $${params.length}`;
  }
  sql += ` ORDER BY date_from DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * @param {{ periodId: number|string, filedRef: string, userId?: number|null }} p
 */
async function markFiled(p) {
  const id = Number(p.periodId);
  const filedRef = String(p.filedRef || "").trim();
  if (!filedRef) throw Object.assign(new Error("filed_ref requerido"), { status: 400 });
  const { rowCount } = await pool.query(
    `UPDATE fiscal_periods
     SET status = 'FILED'::period_status,
         filed_at = now(),
         filed_ref = $2,
         updated_at = now()
     WHERE id = $1 AND status = 'CLOSED'::period_status`,
    [id, filedRef]
  );
  if (!rowCount) {
    throw Object.assign(new Error("El período no está cerrado o no existe"), {
      status: 409,
      code: "NOT_CLOSED",
    });
  }
  const { rows } = await pool.query(`SELECT * FROM fiscal_periods WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * @param {{ periodId: number|string, paidAmountUsd: number|string, userId?: number|null }} p
 */
async function markPaid(p) {
  const id = Number(p.periodId);
  const amt = Number(p.paidAmountUsd);
  if (!Number.isFinite(amt) || amt < 0) {
    throw Object.assign(new Error("paid_amount_usd inválido"), { status: 400 });
  }
  const { rowCount } = await pool.query(
    `UPDATE fiscal_periods
     SET status = 'PAID'::period_status,
         paid_at = now(),
         paid_amount_usd = $2,
         updated_at = now()
     WHERE id = $1 AND status = 'FILED'::period_status`,
    [id, amt]
  );
  if (!rowCount) {
    throw Object.assign(new Error("El período no está declarado (FILED) o no existe"), {
      status: 409,
      code: "NOT_FILED",
    });
  }
  const { rows } = await pool.query(`SELECT * FROM fiscal_periods WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Abre período IVA del mes corriente (UTC) y ISLR anual del año corriente.
 * @param {number} [companyId]
 */
async function openCurrentPeriods(companyId = 1) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const iva = await openPeriod({ taxType: "IVA", year: y, month: m, companyId });
  const islr = await openPeriod({ taxType: "ISLR", year: y, month: null, companyId });
  return { iva, islr };
}

module.exports = {
  getSettings,
  getSetting,
  updateSetting,
  openPeriod,
  closePeriod,
  recordTaxTransaction,
  recordRetention,
  getPeriod,
  listPeriods,
  markFiled,
  markPaid,
  openCurrentPeriods,
};
