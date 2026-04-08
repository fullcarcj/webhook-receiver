"use strict";

let _checked = false;
let _has = false;

/**
 * Indica si existe `customers.phone_2` (migración `npm run db:customers-phone2`).
 * Cache por proceso.
 * @param {import("pg").PoolClient | import("pg").Pool} client
 */
async function customersHasPhone2Column(client) {
  if (_checked) return _has;
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone_2'
       LIMIT 1`
    );
    _has = rows.length > 0;
  } catch {
    _has = false;
  }
  _checked = true;
  return _has;
}

module.exports = { customersHasPhone2Column };
