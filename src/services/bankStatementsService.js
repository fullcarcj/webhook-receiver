"use strict";

const { pool } = require("../../db-postgres");

const RECONCILIATION_STATUSES = new Set([
  "MATCHED",
  "SUGGESTED",
  "CONFIRMED",
  "UNMATCHED",
  "IGNORED",
]);

/**
 * @param {{ bankAccountId: number|null, fromDate: string|null, toDate: string|null, reconciliationStatus: string|null }} p
 * @returns {{ whereSql: string, values: unknown[] }}
 */
function buildBankStatementsWhere(p) {
  const where = ["1=1"];
  const values = [];
  let n = 1;

  if (p.bankAccountId != null && Number.isFinite(p.bankAccountId)) {
    where.push(`bs.bank_account_id = $${n++}`);
    values.push(p.bankAccountId);
  }
  if (p.fromDate) {
    where.push(`bs.tx_date >= $${n++}::date`);
    values.push(p.fromDate);
  }
  if (p.toDate) {
    where.push(`bs.tx_date <= $${n++}::date`);
    values.push(p.toDate);
  }
  if (p.reconciliationStatus) {
    where.push(`bs.reconciliation_status = $${n++}::reconciliation_status`);
    values.push(p.reconciliationStatus);
  }

  return { whereSql: where.join(" AND "), values };
}

/**
 * Último `balance_after` por cuenta dentro de los mismos filtros (movimiento más reciente por fecha e id).
 * @param {{ bankAccountId: number|null, fromDate: string|null, toDate: string|null, reconciliationStatus: string|null }} p
 */
async function getLatestBalancesSnapshot(p) {
  const { whereSql, values } = buildBankStatementsWhere(p);
  const r = await pool.query(
    `SELECT DISTINCT ON (bs.bank_account_id)
            bs.bank_account_id,
            ba.account_number,
            ba.currency::text AS account_currency,
            bs.balance_after::text AS balance_after,
            bs.tx_date
     FROM bank_statements bs
     INNER JOIN bank_accounts ba ON ba.id = bs.bank_account_id
     WHERE ${whereSql}
     ORDER BY bs.bank_account_id, bs.tx_date DESC, bs.id DESC`,
    values
  );
  return r.rows;
}

/**
 * Lista movimientos de `bank_statements` con join a `bank_accounts`.
 * @param {{ bankAccountId: number|null, fromDate: string|null, toDate: string|null, reconciliationStatus: string|null, limit: number, offset: number }} p
 */
async function listBankStatements(p) {
  const { whereSql, values } = buildBankStatementsWhere(p);
  let n = values.length + 1;

  const countR = await pool.query(
    `SELECT count(*)::bigint AS c FROM bank_statements bs WHERE ${whereSql}`,
    values
  );
  const total = Number(countR.rows[0].c);

  const lim = p.limit;
  const off = p.offset;
  const dataR = await pool.query(
    `SELECT bs.id,
            bs.bank_account_id,
            ba.bank_name,
            ba.account_number,
            ba.currency::text AS account_currency,
            bs.tx_date,
            bs.reference_number,
            bs.description,
            bs.tx_type::text AS tx_type,
            bs.amount::text AS amount,
            bs.balance_after::text AS balance_after,
            bs.payment_type,
            bs.reconciliation_status::text AS reconciliation_status,
            rl.order_id AS sales_order_id,
            bs.row_hash,
            bs.created_at
     FROM bank_statements bs
     INNER JOIN bank_accounts ba ON ba.id = bs.bank_account_id
     LEFT JOIN LATERAL (
       SELECT r.order_id
       FROM reconciliation_log r
       WHERE r.bank_statement_id = bs.id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 1
     ) rl ON TRUE
     WHERE ${whereSql}
     ORDER BY bs.tx_date DESC, bs.id DESC
     LIMIT $${n++} OFFSET $${n++}`,
    [...values, lim, off]
  );

  return { rows: dataR.rows, total };
}

module.exports = {
  listBankStatements,
  getLatestBalancesSnapshot,
  RECONCILIATION_STATUSES,
};
