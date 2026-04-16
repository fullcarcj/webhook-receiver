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
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("NO DATABASE_URL");
    process.exit(1);
  }
  const c = new Client({ connectionString: url, ssl: poolSslOption() });
  await c.connect();

  console.log("=== A) crm_chats columns (ordinal_position) ===\n");
  const cols = await c.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crm_chats'
    ORDER BY ordinal_position
  `);
  if (!cols.rows.length) {
    console.log("(no rows: table crm_chats not in information_schema as public.crm_chats)");
  } else {
    for (const row of cols.rows) {
      console.log(row.column_name + "\t" + row.data_type);
    }
  }

  console.log("\n=== B) public tables (full list) ===\n");
  const tabs = await c.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  for (const row of tabs.rows) console.log(row.table_name);

  console.log("\n=== C) row counts productos vs products ===\n");
  for (const t of ["productos", "products"]) {
    try {
      const r = await c.query(`SELECT COUNT(*)::bigint AS c FROM ${t}`);
      console.log(t + "\t" + r.rows[0].c);
    } catch (e) {
      console.log(t + "\tERROR: " + e.message);
    }
  }

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
