"use strict";

const { pool } = require("../../db");

/**
 * Registra una excepción detectada por el bot o el sistema.
 * Alimenta la vista supervisor (Paso 4) y el contador de /api/inbox/counts.
 *
 * Valores convencionales de reason:
 *   'payment_no_match' | 'stock_zero_no_supplier' | 'unhappy_customer'
 *   'ambiguity_unresolved' | 'high_amount_policy' | 'product_not_found'
 */
async function raise({
  entityType,
  entityId,
  reason,
  severity = "medium",
  context  = null,
  chatId   = null,
}, client = null) {
  const db = client || pool;
  const res = await db.query(
    `INSERT INTO exceptions
       (entity_type, entity_id, reason, severity, context, chat_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [entityType, entityId, reason, severity,
     context ? JSON.stringify(context) : null, chatId]
  );
  return res.rows[0].id;
}

async function resolve(exceptionId, { resolvedBy, resolutionNote }, client = null) {
  const db = client || pool;
  const res = await db.query(
    `UPDATE exceptions
     SET status          = 'resolved',
         resolved_by     = $1,
         resolved_at     = NOW(),
         resolution_note = $2
     WHERE id = $3
       AND status IN ('open', 'in_progress')
     RETURNING id`,
    [resolvedBy, resolutionNote, exceptionId]
  );
  return res.rowCount > 0;
}

async function list({ status = "open", limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, entity_type, entity_id, reason, severity, context,
            status, resolved_by, resolved_at, resolution_note,
            chat_id, created_at, updated_at
     FROM exceptions
     WHERE status = $1
     ORDER BY
       CASE severity
         WHEN 'critical' THEN 1
         WHEN 'high'     THEN 2
         WHEN 'medium'   THEN 3
         ELSE 4
       END,
       created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  return rows;
}

async function countOpen() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM exceptions WHERE status = 'open'`
  );
  return rows[0].n;
}

module.exports = { raise, resolve, list, countOpen };
