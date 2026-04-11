"use strict";

const { pool } = require("../../db-postgres");

const MODES = new Set(["BY_AISLE", "BY_SKU", "BY_BIN"]);

function parseOptionalInt(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {object} p
 * @param {'BY_AISLE'|'BY_SKU'|'BY_BIN'} p.mode
 * @param {string} p.referenceName
 * @param {number|string|null} [p.aisleId]
 * @param {string|null} [p.filterSku]
 * @param {number|string|null} [p.filterBinId]
 * @param {number|string|null} [p.createdBy]
 */
async function createSession(p) {
  const mode = String(p.mode || "").trim().toUpperCase();
  if (!MODES.has(mode)) {
    throw Object.assign(new Error("mode debe ser BY_AISLE, BY_SKU o BY_BIN"), { code: "INVALID_MODE" });
  }
  const referenceName = p.referenceName != null ? String(p.referenceName).trim() : "";
  if (!referenceName) {
    throw Object.assign(new Error("reference_name es obligatorio"), { code: "INVALID_REFERENCE" });
  }

  const aisleId = parseOptionalInt(p.aisleId);
  const filterBinId = parseOptionalInt(p.filterBinId);
  const filterSku = p.filterSku != null && String(p.filterSku).trim() !== "" ? String(p.filterSku).trim() : null;
  const createdBy = parseOptionalInt(p.createdBy);

  if (mode === "BY_AISLE" && (aisleId == null || aisleId <= 0)) {
    throw Object.assign(new Error("BY_AISLE requiere aisle_id"), { code: "MISSING_AISLE" });
  }
  if (mode === "BY_SKU" && !filterSku) {
    throw Object.assign(new Error("BY_SKU requiere filter_sku"), { code: "MISSING_SKU" });
  }
  if (mode === "BY_BIN" && (filterBinId == null || filterBinId <= 0)) {
    throw Object.assign(new Error("BY_BIN requiere filter_bin_id"), { code: "MISSING_BIN" });
  }

  const { rows } = await pool.query(
    `INSERT INTO count_sessions (
       mode, reference_name, aisle_id, filter_sku, filter_bin_id, created_by
     ) VALUES (
       $1::count_session_mode, $2, $3, $4, $5, $6
     ) RETURNING *`,
    [mode, referenceName, mode === "BY_AISLE" ? aisleId : null, mode === "BY_SKU" ? filterSku : null, mode === "BY_BIN" ? filterBinId : null, createdBy]
  );
  return rows[0] || null;
}

/**
 * @param {number|string} sessionId
 */
async function startSession(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error("sessionId inválido"), { code: "INVALID_SESSION" });
  }
  const { rows } = await pool.query(`SELECT generate_count_lines($1::bigint) AS total_lines`, [sid]);
  const totalLines = rows[0]?.total_lines != null ? Number(rows[0].total_lines) : 0;
  return { sessionId: sid, totalLines };
}

/**
 * @param {object} p
 * @param {number|string} p.lineId
 * @param {number|string} p.qtyCounted
 * @param {number|string|null} [p.userId]
 */
async function submitLine(p) {
  const lineId = Number(p.lineId);
  const qty = Number(p.qtyCounted);
  if (!Number.isFinite(lineId) || lineId <= 0) {
    throw Object.assign(new Error("lineId inválido"), { code: "INVALID_LINE" });
  }
  if (!Number.isFinite(qty)) {
    throw Object.assign(new Error("qty_counted inválido"), { code: "INVALID_QTY" });
  }
  const userId = parseOptionalInt(p.userId);

  const { rows } = await pool.query(`SELECT submit_count_line($1::bigint, $2::numeric, $3::integer) AS result`, [
    lineId,
    qty,
    userId,
  ]);
  return rows[0]?.result ?? null;
}

/**
 * @param {number|string} sessionId
 */
async function getSessionDetail(sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error("sessionId inválido"), { code: "INVALID_SESSION" });
  }
  const { rows: sRows } = await pool.query(`SELECT * FROM count_sessions WHERE id = $1`, [sid]);
  if (!sRows.length) {
    throw Object.assign(new Error("Sesión no encontrada"), { code: "SESSION_NOT_FOUND" });
  }
  const { rows: lines } = await pool.query(
    `SELECT cl.*, wb.bin_code, p.descripcion AS descripcion
     FROM count_lines cl
     JOIN warehouse_bins wb ON wb.id = cl.bin_id
     LEFT JOIN products p ON p.sku = cl.product_sku
     WHERE cl.session_id = $1
     ORDER BY cl.id`,
    [sid]
  );
  return { session: sRows[0], lines };
}

async function getSessionsPending() {
  const { rows } = await pool.query(
    `SELECT * FROM v_count_sessions_summary
     WHERE status::text IN ('IN_PROGRESS','PENDING_APPROVAL')
     ORDER BY updated_at DESC NULLS LAST, id DESC`
  );
  return rows;
}

/**
 * @param {object} p
 * @param {number|string} p.sessionId
 * @param {number|string|null} [p.userId]
 * @param {string|null} [p.notes]
 */
async function approveSession(p) {
  const sessionId = Number(p.sessionId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    throw Object.assign(new Error("sessionId inválido"), { code: "INVALID_SESSION" });
  }
  const userId = parseOptionalInt(p.userId);
  const notes = p.notes != null ? String(p.notes) : null;

  const { rows } = await pool.query(`SELECT approve_count_session($1::bigint, $2::integer, $3::text) AS result`, [
    sessionId,
    userId,
    notes,
  ]);
  return rows[0]?.result ?? null;
}

async function getConfig() {
  const { rows } = await pool.query(`SELECT * FROM count_config WHERE id = 1`);
  return rows[0] || null;
}

/**
 * @param {object} p
 * @param {string|null|undefined} [p.notes]
 */
async function updateConfig(p) {
  if (!p || typeof p !== "object") {
    throw Object.assign(new Error("body inválido"), { code: "INVALID_BODY" });
  }
  if (p.notes === undefined) {
    return getConfig();
  }
  const notes = p.notes == null ? null : String(p.notes);
  const { rows } = await pool.query(
    `UPDATE count_config SET notes = $1, updated_at = now() WHERE id = 1 RETURNING *`,
    [notes]
  );
  return rows[0] || null;
}

module.exports = {
  createSession,
  startSession,
  submitLine,
  getSessionDetail,
  getSessionsPending,
  approveSession,
  getConfig,
  updateConfig,
};
