#!/usr/bin/env node
/**
 * Importa órdenes desde ml_orders hacia sales_orders (sin stock/caja).
 * Requiere: SALES_ML_IMPORT_ENABLED=1, migraciones db:sales y db:sales-ml.
 *
 * Una orden: node scripts/importMlOrdersToSales.js --ml-user-id=123 --order-id=456789
 * Lote:       node scripts/importMlOrdersToSales.js --ml-user-id=123 --limit=50 --offset=0
 */
"use strict";

require("../load-env-local");
const salesService = require("../src/services/salesService");

function parseArg(name) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit != null ? hit.slice(p.length) : null;
}

async function main() {
  const mlUserId = Number(parseArg("ml-user-id") || process.env.ML_USER_ID);
  const orderIdRaw = parseArg("order-id") || process.env.ORDER_ID;
  const limit = parseArg("limit") != null ? Number(parseArg("limit")) : Number(process.env.LIMIT || "50");
  const offset = parseArg("offset") != null ? Number(parseArg("offset")) : Number(process.env.OFFSET || "0");

  if (!Number.isFinite(mlUserId) || mlUserId <= 0) {
    console.error("Indicar --ml-user-id=N (o ML_USER_ID)");
    process.exit(1);
  }

  if (orderIdRaw != null && String(orderIdRaw).trim() !== "") {
    const orderId = Number(orderIdRaw);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      console.error("order_id inválido");
      process.exit(1);
    }
    const data = await salesService.importSalesOrderFromMlOrder({ mlUserId, orderId });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const data = await salesService.importSalesOrdersFromMlTable({
    mlUserId,
    limit,
    offset,
  });
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
