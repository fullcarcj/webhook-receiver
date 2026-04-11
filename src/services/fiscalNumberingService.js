"use strict";

const { pool } = require("../../db-postgres");

const COMPANY_ID_DEFAULT = 1;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeCompanyId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : COMPANY_ID_DEFAULT;
}

// ── Helper: método de emisión desde settings_tax ─────────────────────
async function getEmissionMethod(companyId = COMPANY_ID_DEFAULT) {
  try {
    const { rows } = await pool.query(
      `SELECT get_tax_setting('fiscal_emission_method', $1) AS method`,
      [normalizeCompanyId(companyId)]
    );
    const m = rows[0] && rows[0].method ? String(rows[0].method).trim().toUpperCase() : "";
    return m || "FORMA_LIBRE";
  } catch (_) {
    return "FORMA_LIBRE";
  }
}

// ── Helper: tasa IVA vigente desde settings_tax ───────────────────────
async function getIvaRate(companyId = COMPANY_ID_DEFAULT) {
  try {
    const { rows } = await pool.query(
      `SELECT get_tax_setting_num('iva_rate_pct', $1) AS rate`,
      [normalizeCompanyId(companyId)]
    );
    const r = rows[0] && rows[0].rate != null ? parseFloat(rows[0].rate) : NaN;
    return Number.isFinite(r) && r >= 0 ? r : 16;
  } catch (_) {
    return 16;
  }
}

// ── issueInvoice ────────────────────────────────────────────────────────
/**
 * Emite una FACTURA. Llama a issue_fiscal_document() en la BD.
 * @param {{
 *   companyId?: number,
 *   saleId?: number|string|null,
 *   issueDate?: string|null,
 *   receptorRif?: string|null,
 *   receptorName?: string|null,
 *   receptorAddress?: string|null,
 *   baseImponibleUsd: number|string,
 *   igtfUsd?: number|string|null,
 *   notes?: string|null,
 * }} p
 */
async function issueInvoice(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const method = await getEmissionMethod(companyId);
  const ivaRate = await getIvaRate(companyId);
  const issueDate = p.issueDate && String(p.issueDate).trim() !== "" ? String(p.issueDate).trim().slice(0, 10) : todayStr();
  const base = Number(p.baseImponibleUsd);
  if (!Number.isFinite(base) || base <= 0) {
    throw Object.assign(new Error("base_imponible_usd debe ser > 0"), { status: 400, code: "INVALID_BASE" });
  }
  const igtf = Number(p.igtfUsd) || 0;
  const saleId = p.saleId != null && String(p.saleId).trim() !== "" ? Number(p.saleId) : null;

  const { rows } = await pool.query(
    `SELECT * FROM issue_fiscal_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      companyId,
      "FACTURA",
      method,
      issueDate,
      p.receptorRif || null,
      p.receptorName || null,
      p.receptorAddress || null,
      base,
      ivaRate,
      igtf,
      Number.isFinite(saleId) && saleId > 0 ? saleId : null,
      null, // purchase_id
      null, // retention_id
      null, // related_doc_id
      null, // related_doc_reason
      p.notes || null,
    ]
  );
  return rows[0];
}

// ── issueCreditNote ─────────────────────────────────────────────────────
/**
 * @param {{
 *   companyId?: number,
 *   relatedDocId: number|string,
 *   receptorRif?: string|null,
 *   receptorName?: string|null,
 *   receptorAddress?: string|null,
 *   baseImponibleUsd: number|string,
 *   reason: string,
 *   notes?: string|null,
 * }} p
 */
async function issueCreditNote(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const relatedDocId = Number(p.relatedDocId);
  if (!Number.isFinite(relatedDocId) || relatedDocId <= 0) {
    throw Object.assign(new Error("related_doc_id requerido"), { status: 400, code: "INVALID_RELATED_DOC_ID" });
  }
  // Verificar que el documento original existe y está ISSUED
  const { rows: origRows } = await pool.query(
    `SELECT id, status, company_id FROM fiscal_documents WHERE id = $1`,
    [relatedDocId]
  );
  if (!origRows.length) {
    throw Object.assign(new Error(`Documento original ${relatedDocId} no encontrado`), {
      status: 422,
      code: "INVALID_RELATED_DOC",
    });
  }
  if (String(origRows[0].status || "").toUpperCase() !== "ISSUED") {
    throw Object.assign(
      new Error(`Documento original ${relatedDocId} no está en estado ISSUED (actual: ${origRows[0].status})`),
      { status: 422, code: "INVALID_RELATED_DOC" }
    );
  }

  const method = await getEmissionMethod(companyId);
  const ivaRate = await getIvaRate(companyId);
  const base = Number(p.baseImponibleUsd);
  if (!Number.isFinite(base) || base <= 0) {
    throw Object.assign(new Error("base_imponible_usd debe ser > 0"), { status: 400, code: "INVALID_BASE" });
  }
  const reason = String(p.reason || "").trim();
  if (!reason) {
    throw Object.assign(new Error("reason requerido para nota de crédito"), { status: 400, code: "REASON_REQUIRED" });
  }

  const { rows } = await pool.query(
    `SELECT * FROM issue_fiscal_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      companyId,
      "NOTA_CREDITO",
      method,
      todayStr(),
      p.receptorRif || null,
      p.receptorName || null,
      p.receptorAddress || null,
      base,
      ivaRate,
      0, // igtf_usd
      null, // sale_id
      null, // purchase_id
      null, // retention_id
      relatedDocId,
      reason,
      p.notes || null,
    ]
  );
  return rows[0];
}

// ── issueDebitNote ──────────────────────────────────────────────────────
/**
 * @param {{
 *   companyId?: number,
 *   relatedDocId: number|string,
 *   receptorRif?: string|null,
 *   receptorName?: string|null,
 *   receptorAddress?: string|null,
 *   baseImponibleUsd: number|string,
 *   reason: string,
 *   notes?: string|null,
 * }} p
 */
async function issueDebitNote(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const relatedDocId = Number(p.relatedDocId);
  if (!Number.isFinite(relatedDocId) || relatedDocId <= 0) {
    throw Object.assign(new Error("related_doc_id requerido"), { status: 400, code: "INVALID_RELATED_DOC_ID" });
  }

  const { rows: origRows } = await pool.query(
    `SELECT id, status FROM fiscal_documents WHERE id = $1`,
    [relatedDocId]
  );
  if (!origRows.length) {
    throw Object.assign(new Error(`Documento original ${relatedDocId} no encontrado`), {
      status: 422,
      code: "INVALID_RELATED_DOC",
    });
  }
  if (String(origRows[0].status || "").toUpperCase() !== "ISSUED") {
    throw Object.assign(
      new Error(`Documento original ${relatedDocId} no está en estado ISSUED`),
      { status: 422, code: "INVALID_RELATED_DOC" }
    );
  }

  const method = await getEmissionMethod(companyId);
  const ivaRate = await getIvaRate(companyId);
  const base = Number(p.baseImponibleUsd);
  if (!Number.isFinite(base) || base <= 0) {
    throw Object.assign(new Error("base_imponible_usd debe ser > 0"), { status: 400, code: "INVALID_BASE" });
  }
  const reason = String(p.reason || "").trim();
  if (!reason) {
    throw Object.assign(new Error("reason requerido para nota de débito"), { status: 400, code: "REASON_REQUIRED" });
  }

  const { rows } = await pool.query(
    `SELECT * FROM issue_fiscal_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      companyId,
      "NOTA_DEBITO",
      method,
      todayStr(),
      p.receptorRif || null,
      p.receptorName || null,
      p.receptorAddress || null,
      base,
      ivaRate,
      0,
      null,
      null,
      null,
      relatedDocId,
      reason,
      p.notes || null,
    ]
  );
  return rows[0];
}

// ── issueRetentionCertificate ───────────────────────────────────────────
/**
 * @param {{
 *   companyId?: number,
 *   retentionId?: number|string|null,
 *   counterpartRif?: string|null,
 *   counterpartName?: string|null,
 *   counterpartAddress?: string|null,
 *   baseImponibleUsd: number|string,
 *   retentionAmountUsd?: number|string|null,
 *   notes?: string|null,
 * }} p
 */
async function issueRetentionCertificate(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const method = await getEmissionMethod(companyId);
  const base = Number(p.baseImponibleUsd);
  if (!Number.isFinite(base) || base <= 0) {
    throw Object.assign(new Error("base_imponible_usd debe ser > 0"), { status: 400, code: "INVALID_BASE" });
  }
  const retentionId =
    p.retentionId != null && String(p.retentionId).trim() !== "" ? Number(p.retentionId) : null;

  // iva_rate_pct = 0 → no se registra en tax_transactions (la retención ya está en retentions)
  const { rows } = await pool.query(
    `SELECT * FROM issue_fiscal_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      companyId,
      "COMPROBANTE_RETENCION",
      method,
      todayStr(),
      p.counterpartRif || null,
      p.counterpartName || null,
      p.counterpartAddress || null,
      base,
      0, // iva_rate_pct = 0 para comprobante retención
      0, // igtf_usd = 0
      null, // sale_id
      null, // purchase_id
      Number.isFinite(retentionId) && retentionId > 0 ? retentionId : null,
      null, // related_doc_id
      null, // related_doc_reason
      p.notes || null,
    ]
  );
  return rows[0];
}

// ── cancelDocument ──────────────────────────────────────────────────────
/**
 * @param {{ docId: number|string, userId?: number|null, reason: string }} p
 */
async function cancelDocument(p) {
  const docId = Number(p.docId);
  if (!Number.isFinite(docId) || docId <= 0) {
    throw Object.assign(new Error("docId inválido"), { status: 400, code: "INVALID_DOC_ID" });
  }
  const reason = String(p.reason || "").trim();
  if (!reason) {
    throw Object.assign(new Error("reason requerido para anular"), { status: 400, code: "REASON_REQUIRED" });
  }
  const userId = p.userId != null && String(p.userId).trim() !== "" ? Number(p.userId) : null;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM cancel_fiscal_document($1, $2, $3)`,
      [docId, userId, reason]
    );
    return rows[0];
  } catch (err) {
    const msg = (err && err.message) || "";
    if (/ya está anulado/i.test(msg) || /already cancelled/i.test(msg)) {
      throw Object.assign(new Error(msg), { status: 422, code: "ALREADY_CANCELLED" });
    }
    if (/DRAFT/i.test(msg)) {
      throw Object.assign(new Error(msg), { status: 422, code: "CANT_CANCEL_DRAFT" });
    }
    if (/no encontrado/i.test(msg) || /not found/i.test(msg)) {
      throw Object.assign(new Error(msg), { status: 404, code: "NOT_FOUND" });
    }
    throw err;
  }
}

// ── confirmExternalNumber ───────────────────────────────────────────────
/**
 * Para MAQUINA_FISCAL y PORTAL_SENIAT: confirmar el número externo.
 * @param {{ docId: number|string, externalNumber: string }} p
 */
async function confirmExternalNumber(p) {
  const docId = Number(p.docId);
  const extNum = String(p.externalNumber || "").trim();
  if (!Number.isFinite(docId) || docId <= 0) {
    throw Object.assign(new Error("docId inválido"), { status: 400, code: "INVALID_DOC_ID" });
  }
  if (!extNum) {
    throw Object.assign(new Error("external_number requerido"), { status: 400, code: "EXTERNAL_NUMBER_REQUIRED" });
  }

  const { rows: checkRows } = await pool.query(
    `SELECT id, status, emission_method FROM fiscal_documents WHERE id = $1`,
    [docId]
  );
  if (!checkRows.length) {
    throw Object.assign(new Error(`Documento ${docId} no encontrado`), { status: 404, code: "NOT_FOUND" });
  }
  const doc = checkRows[0];
  if (String(doc.status || "").toUpperCase() !== "DRAFT") {
    throw Object.assign(
      new Error(`El documento ${docId} no está en DRAFT (status actual: ${doc.status})`),
      { status: 409, code: "NOT_DRAFT" }
    );
  }
  if (String(doc.emission_method || "").toUpperCase() === "FORMA_LIBRE") {
    throw Object.assign(
      new Error("El método FORMA_LIBRE genera números definitivos automáticamente; no requiere confirmación externa"),
      { status: 422, code: "INVALID_EMISSION_METHOD" }
    );
  }

  const { rows } = await pool.query(
    `UPDATE fiscal_documents
     SET external_number = $2,
         status = 'ISSUED'::fiscal_doc_status,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [docId, extNum]
  );
  return rows[0];
}

// ── getDocument ─────────────────────────────────────────────────────────
/**
 * @param {number|string} docId
 */
async function getDocument(docId) {
  const id = Number(docId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error("docId inválido"), { status: 400, code: "INVALID_DOC_ID" });
  }
  const { rows } = await pool.query(
    `SELECT fd.*,
            fs.serie, fs.control_prefix, fs.doc_prefix
     FROM fiscal_documents fd
     LEFT JOIN fiscal_sequences fs ON fs.id = fd.sequence_id
     WHERE fd.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ── listDocuments ───────────────────────────────────────────────────────
/**
 * @param {{
 *   companyId?: number,
 *   docType?: string|null,
 *   status?: string|null,
 *   periodId?: number|string|null,
 *   receptorRif?: string|null,
 *   dateFrom?: string|null,
 *   dateTo?: string|null,
 *   limit?: number,
 *   offset?: number,
 * }} p
 */
async function listDocuments(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 500);
  const offset = Math.max(Number(p.offset) || 0, 0);

  const params = [companyId];
  let where = `WHERE fd.company_id = $1`;

  if (p.docType != null && String(p.docType).trim() !== "") {
    params.push(String(p.docType).trim().toUpperCase());
    where += ` AND fd.doc_type = $${params.length}::fiscal_doc_type`;
  }
  if (p.status != null && String(p.status).trim() !== "") {
    params.push(String(p.status).trim().toUpperCase());
    where += ` AND fd.status = $${params.length}::fiscal_doc_status`;
  }
  if (p.periodId != null && String(p.periodId).trim() !== "") {
    const pid = Number(p.periodId);
    if (Number.isFinite(pid) && pid > 0) {
      params.push(pid);
      where += ` AND fd.fiscal_period_id = $${params.length}`;
    }
  }
  if (p.receptorRif != null && String(p.receptorRif).trim() !== "") {
    params.push(String(p.receptorRif).trim());
    where += ` AND fd.receptor_rif = $${params.length}`;
  }
  if (p.dateFrom != null && String(p.dateFrom).trim() !== "") {
    params.push(String(p.dateFrom).trim().slice(0, 10));
    where += ` AND fd.issue_date >= $${params.length}::date`;
  }
  if (p.dateTo != null && String(p.dateTo).trim() !== "") {
    params.push(String(p.dateTo).trim().slice(0, 10));
    where += ` AND fd.issue_date <= $${params.length}::date`;
  }

  const countParams = [...params];
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS n FROM fiscal_documents fd ${where}`,
    countParams
  );
  const total = parseInt(countRows[0].n, 10) || 0;

  params.push(limit, offset);
  const { rows: docs } = await pool.query(
    `SELECT fd.*, fs.serie, fs.doc_prefix
     FROM fiscal_documents fd
     LEFT JOIN fiscal_sequences fs ON fs.id = fd.sequence_id
     ${where}
     ORDER BY fd.issue_date DESC, fd.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { docs, total, limit, offset };
}

// ── getLibroVentasTotales ───────────────────────────────────────────────
/**
 * @param {{ companyId?: number, year: number, month: number }} p
 */
async function getLibroVentasTotales(p) {
  const companyId = normalizeCompanyId(p.companyId);
  const year = Number(p.year);
  const month = Number(p.month);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw Object.assign(new Error("year y month (1-12) son obligatorios"), { status: 400 });
  }
  const { rows } = await pool.query(
    `SELECT * FROM v_libro_ventas_totales
     WHERE company_id = $1
       AND period_month = make_date($2::int, $3::int, 1)`,
    [companyId, Math.trunc(year), Math.trunc(month)]
  );
  return rows[0] || null;
}

// ── getSequences ────────────────────────────────────────────────────────
/**
 * @param {number} [companyId]
 */
async function getSequences(companyId = COMPANY_ID_DEFAULT) {
  const { rows } = await pool.query(
    `SELECT *,
            (control_max - control_current) AS remaining,
            CASE WHEN (control_max - control_current) < 1000
              THEN TRUE ELSE FALSE END AS alert_low
     FROM fiscal_sequences
     WHERE company_id = $1
     ORDER BY doc_type, serie`,
    [normalizeCompanyId(companyId)]
  );
  return rows;
}

// ── updateSequence ──────────────────────────────────────────────────────
/**
 * PELIGROSO: resetea el correlativo a 0 para un nuevo talonario SENIAT.
 * Solo permitir con header X-Confirm: reset-sequence (validar en la capa HTTP).
 * @param {{ sequenceId: number|string, controlPrefix: string, serie: string, companyId?: number }} p
 */
async function updateSequence(p) {
  const sequenceId = Number(p.sequenceId);
  if (!Number.isFinite(sequenceId) || sequenceId <= 0) {
    throw Object.assign(new Error("sequenceId inválido"), { status: 400 });
  }
  const companyId = normalizeCompanyId(p.companyId);
  const controlPrefix = String(p.controlPrefix || "").trim();
  const serie = String(p.serie || "").trim().toUpperCase();

  if (!controlPrefix) {
    throw Object.assign(new Error("control_prefix requerido"), { status: 400 });
  }
  if (!serie) {
    throw Object.assign(new Error("serie requerida"), { status: 400 });
  }

  // Verificar que la secuencia existe y pertenece a la empresa
  const { rows: cur } = await pool.query(
    `SELECT id, serie, doc_type FROM fiscal_sequences WHERE id = $1 AND company_id = $2`,
    [sequenceId, companyId]
  );
  if (!cur.length) {
    throw Object.assign(new Error(`Secuencia ${sequenceId} no encontrada para empresa ${companyId}`), {
      status: 404,
    });
  }
  if (String(cur[0].serie || "").toUpperCase() === serie) {
    throw Object.assign(
      new Error(`La serie ${serie} ya es la activa para esta secuencia. Usar una serie diferente (p. ej. 'B').`),
      { status: 400, code: "SAME_SERIE" }
    );
  }

  // Marcar la secuencia vieja como inactiva e insertar nueva
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE fiscal_sequences SET is_active = FALSE, updated_at = now() WHERE id = $1`,
      [sequenceId]
    );

    const { rows } = await client.query(
      `INSERT INTO fiscal_sequences
         (company_id, doc_type, control_prefix, doc_prefix, serie,
          control_current, control_max, is_active)
       SELECT company_id, doc_type, $2, doc_prefix, $3,
              0, 99999999, TRUE
       FROM fiscal_sequences WHERE id = $1
       RETURNING *`,
      [sequenceId, controlPrefix, serie]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  issueInvoice,
  issueCreditNote,
  issueDebitNote,
  issueRetentionCertificate,
  cancelDocument,
  confirmExternalNumber,
  getDocument,
  listDocuments,
  getLibroVentasTotales,
  getSequences,
  updateSequence,
  getEmissionMethod,
  getIvaRate,
};
