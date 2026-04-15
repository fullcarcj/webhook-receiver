#!/usr/bin/env node
/**
 * sql/create-product-prices.sql — tabla product_prices (snapshots por canal).
 */
"use strict";

require("../load-env-local");
const path = require("path");
const { Client } = require("pg");
const { runSqlFile, poolSslOption } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "create-product-prices.sql");

const EXPECTED_COLUMNS = [
  "id",
  "product_id",
  "channel",
  "price_usd",
  "price_bs_bcv",
  "price_bs_binance",
  "price_bs_ajuste",
  "landed_cost_usd",
  "costo_operativo_usd",
  "bcv_rate",
  "binance_rate",
  "adjusted_rate",
  "rate_date",
  "margin_usd",
  "margin_pct",
  "policy_snapshot",
  "calculated_at",
];

async function verifyColumns(client) {
  const { rows } = await client.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'product_prices'
     ORDER BY ordinal_position`
  );

  console.log("[db:product-prices] columnas detectadas (information_schema):");
  for (const r of rows) {
    console.log(`  - ${r.column_name} (${r.data_type})`);
  }

  const names = rows.map((r) => r.column_name);
  const missing = EXPECTED_COLUMNS.filter((c) => !names.includes(c));
  const extra = names.filter((c) => !EXPECTED_COLUMNS.includes(c));

  if (missing.length) {
    const msg = `Faltan columnas esperadas: ${missing.join(", ")}. ` +
      (names.length
        ? "La tabla product_prices ya existía con otro esquema; revisar o eliminar/renombrar antes de migrar."
        : "No se encontraron columnas.");
    throw new Error(msg);
  }
  if (extra.length) {
    console.warn("[db:product-prices] aviso: columnas extra no contempladas en la verificación:", extra.join(", "));
  }
}

(async () => {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url) {
    console.error("[db:product-prices] ERROR: DATABASE_URL no definida (entorno u oauth-env.json vía load-env-local).");
    process.exit(1);
  }

  try {
    console.log("[db:product-prices] ejecutando", sqlPath);
    await runSqlFile(sqlPath);
    console.log("[db:product-prices] SQL aplicado.");

    const client = new Client({
      connectionString: url,
      ssl: poolSslOption(),
      connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
    });
    await client.connect();
    try {
      await verifyColumns(client);
    } finally {
      await client.end();
    }

    console.log("[db:product-prices] OK — tabla product_prices verificada.");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:product-prices] ERROR: no existe el archivo SQL:", sqlPath);
      process.exit(1);
    }
    if (e && e.code === "NO_DATABASE_URL") {
      console.error("[db:product-prices] ERROR:", e.message);
      process.exit(1);
    }
    console.error("[db:product-prices] ERROR:", e.message || e);
    if (e && e.detail) console.error("detail:", e.detail);
    if (e && e.hint) console.error("hint:", e.hint);
    process.exit(1);
  }
})();
