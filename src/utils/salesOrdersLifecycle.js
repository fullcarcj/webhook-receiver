"use strict";

let _checked = false;
let _has = false;

let _checkedTotalAmountUsd = false;
let _hasTotalAmountUsd = false;

/**
 * Indica si existe la columna legacy `sales_orders.total_amount_usd` (antes de renombrar a `order_total_amount`).
 * Si existe y es NOT NULL, los INSERT deben rellenarla con el mismo total que `order_total_amount`.
 * Cache por proceso.
 * @param {import("pg").PoolClient | import("pg").Pool} client
 */
async function salesOrdersHasTotalAmountUsdColumn(client) {
  if (_checkedTotalAmountUsd) return _hasTotalAmountUsd;
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'total_amount_usd'
       LIMIT 1`
    );
    _hasTotalAmountUsd = rows.length > 0;
  } catch {
    _hasTotalAmountUsd = false;
  }
  _checkedTotalAmountUsd = true;
  return _hasTotalAmountUsd;
}

/**
 * Indica si existe `sales_orders.lifecycle_status` (migración `npm run db:orders-lifecycle`).
 * Cache por proceso.
 * @param {import("pg").PoolClient | import("pg").Pool} client
 */
async function salesOrdersHasLifecycleColumns(client) {
  if (_checked) return _has;
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'lifecycle_status'
       LIMIT 1`
    );
    _has = rows.length > 0;
  } catch {
    _has = false;
  }
  _checked = true;
  return _has;
}

module.exports = {
  salesOrdersHasLifecycleColumns,
  salesOrdersHasTotalAmountUsdColumn,
};
