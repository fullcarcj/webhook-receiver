#!/usr/bin/env node
/**
 * verify-fbmp-edge — health check de BD y módulo fbmp_edge.
 * Uso: npm run verify:fbmp-edge  (requiere DATABASE_URL)
 */

"use strict";

require("../load-env-local");
const { pool } = require("../db");

async function run() {
  console.log("\n[fbmp_edge verify]\n");
  const checks = [
    ["fbmp_edge_threads",    `SELECT COUNT(*)::int AS c FROM fbmp_edge_threads`],
    ["fbmp_edge_raw_ingest", `SELECT COUNT(*)::int AS c FROM fbmp_edge_raw_ingest`],
    ["fbmp_edge_raw_pending",`SELECT COUNT(*)::int AS c FROM fbmp_edge_raw_ingest WHERE processed = FALSE`],
    ["fbmp_edge_outbox",     `SELECT COUNT(*)::int AS c FROM fbmp_edge_outbox`],
    ["fbmp_edge_outbox_queued", `SELECT COUNT(*)::int AS c FROM fbmp_edge_outbox WHERE status = 'queued'`],
    ["crm_chats fbmp_edge",  `SELECT COUNT(*)::int AS c FROM crm_chats WHERE source_type = 'fbmp_edge'`],
  ];

  let ok = true;
  for (const [label, sql] of checks) {
    try {
      const { rows } = await pool.query(sql);
      console.log(`  ✓ ${label}: ${rows[0].c}`);
    } catch (err) {
      console.error(`  ✗ ${label}: ${err.message}`);
      ok = false;
    }
  }

  console.log(ok ? "\nTodo OK\n" : "\nHay errores — ejecutá npm run db:fbmp-edge\n");
  await pool.end();
  process.exit(ok ? 0 : 1);
}

run().catch((err) => {
  console.error("[fbmp_edge verify] Error:", err.message);
  process.exit(1);
});
