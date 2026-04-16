"use strict";
require("../load-env-local");
const { Client } = require("pg");

function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:\/]/i.test(raw) ||
    /@127\.0\.0\.1[:\/]/i.test(raw) ||
    /:\/\/localhost[:\/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:\/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: poolSslOption() });
  await c.connect();
  const r = await c.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ml_order_messages'
    ORDER BY ordinal_position
  `);
  console.log("column_name\tdata_type");
  for (const row of r.rows) {
    console.log(`${row.column_name}\t${row.data_type}`);
  }
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
