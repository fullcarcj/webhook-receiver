#!/usr/bin/env node
/**
 * Concurrencia: N ventas mostrador del mismo SKU (qty 1) y comprobación de stock final.
 * Env: STRESS_SKU, STRESS_CUSTOMER_ID, STRESS_PARALLEL (default 10), STRESS_INITIAL_STOCK (default 3).
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");
const salesService = require("../src/services/salesService");

async function main() {
  const sku = process.env.STRESS_SKU && String(process.env.STRESS_SKU).trim();
  const customerId = Number(process.env.STRESS_CUSTOMER_ID);
  const parallel = Math.max(2, Number(process.env.STRESS_PARALLEL || "10"));
  const initialStock = Math.max(1, Number(process.env.STRESS_INITIAL_STOCK || "3"));

  if (!sku || !Number.isFinite(customerId) || customerId <= 0) {
    console.error("Definir STRESS_SKU y STRESS_CUSTOMER_ID (cliente CRM existente)");
    process.exit(1);
  }

  const ex = await pool.query(`SELECT id, stock FROM productos WHERE sku = $1`, [sku]);
  if (!ex.rows.length) {
    console.error("SKU no existe en productos");
    process.exit(1);
  }

  await pool.query(`UPDATE productos SET stock = $1, updated_at = NOW() WHERE sku = $2`, [initialStock, sku]);

  const results = await Promise.allSettled(
    Array.from({ length: parallel }, () =>
      salesService.createSalesOrder({
        source: "mostrador",
        customerId,
        items: [{ sku, quantity: 1, unit_price_usd: 1 }],
        status: "paid",
      })
    )
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.filter((r) => r.status === "rejected").length;
  const after = await pool.query(`SELECT stock FROM productos WHERE sku = $1`, [sku]);
  const finalStock = Number(after.rows[0].stock);
  const expectedFinal = initialStock - ok;

  const summary = {
    ok,
    fail,
    parallel,
    initialStock,
    finalStock,
    expectedFinal,
    passed: finalStock === expectedFinal,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.passed) {
    console.error("Fallo: stock final no coincide con ventas exitosas");
    process.exit(1);
  }
  if (ok > initialStock) {
    console.error("Fallo: más ventas OK que stock inicial");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
