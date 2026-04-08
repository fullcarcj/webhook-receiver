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
 * Lista movimientos de `bank_statements` con join a `bank_accounts`.
 * @param {{ bankAccountId: number|null, fromDate: string|null, toDate: string|null, reconciliationStatus: string|null, limit: number, offset: number }} p
 */
async function listBankStatements(p) {
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

  const whereSql = where.join(" AND ");

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
            bs.row_hash,
            bs.created_at
     FROM bank_statements bs
     INNER JOIN bank_accounts ba ON ba.id = bs.bank_account_id
     WHERE ${whereSql}
     ORDER BY bs.tx_date DESC, bs.id DESC
     LIMIT $${n++} OFFSET $${n++}`,
    [...values, lim, off]
  );

  return { rows: dataR.rows, total };
}

module.exports = { listBankStatements, RECONCILIATION_STATUSES };
