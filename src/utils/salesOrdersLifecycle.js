"use strict";

let _checked = false;
let _has = false;

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

module.exports = { salesOrdersHasLifecycleColumns };
