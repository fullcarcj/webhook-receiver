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

  console.log("-- Query 1: tables ILIKE %product%");
  const r1 = await c.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name ILIKE '%product%'
    ORDER BY table_name
  `);
  for (const row of r1.rows) console.log(row.table_name);
  if (!r1.rows.length) console.log("(no rows)");

  console.log("\n-- Query 2: crm_chats columns");
  const r2 = await c.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'crm_chats'
      AND column_name IN (
        'source_type','ml_order_id','ml_buyer_id',
        'ml_question_id','identity_status','assigned_to'
      )
    ORDER BY column_name
  `);
  if (!r2.rows.length) {
    const chk = await c.query("SELECT to_regclass('public.crm_chats') AS reg");
    console.log("(no matching columns)");
    console.log("to_regclass(public.crm_chats):", chk.rows[0].reg);
  } else {
    for (const row of r2.rows) {
      console.log(row.column_name + "\t" + row.data_type);
    }
  }

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
