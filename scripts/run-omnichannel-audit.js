#!/usr/bin/env node
/**
 * Ejecuta los 6 bloques de sql/20260422_omnichannel_audit.sql y imprime JSON por bloque.
 * Uso: node scripts/run-omnichannel-audit.js
 * Requiere DATABASE_URL (load-env-local).
 */
"use strict";

require("../load-env-local");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

function splitAuditBlocks(sqlText) {
  const parts = sqlText.split(/^-- ═══ QUERY \d+/m);
  return parts
    .map((p) => p.replace(/^[^\n]*\n/, "").trim()) // título del bloque + salto
    .filter((p) => p.length > 0 && /^SELECT/i.test(p)); // ignorar preámbulo / comentarios
}

async function main() {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url) {
    console.error("DATABASE_URL no definida");
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, "..", "sql", "20260422_omnichannel_audit.sql");
  const full = fs.readFileSync(sqlPath, "utf8");
  const blocks = splitAuditBlocks(full);
  if (blocks.length < 6) {
    console.error(
      `Se esperaban ≥6 bloques en ${sqlPath}, encontrados: ${blocks.length}. Revisar separadores -- ═══ QUERY`
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();

  const out = [];
  try {
    for (let i = 0; i < 6; i++) {
      const label = `QUERY_${i + 1}`;
      const { rows } = await client.query(blocks[i]);
      out.push({ query: label, rowCount: rows.length, rows });
    }
  } finally {
    await client.end();
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("[run-omnichannel-audit]", err.message);
  if (err.detail) console.error("detail:", err.detail);
  process.exit(1);
});
