#!/usr/bin/env node
/**
 * Importa órdenes desde ml_orders hacia sales_orders (sin stock/caja).
 * Requiere: SALES_ML_IMPORT_ENABLED=1, migraciones db:sales y db:sales-ml.
 *
 * Una orden: node scripts/importMlOrdersToSales.js --ml-user-id=123 --order-id=456789
 * Lote una cuenta:  --ml-user-id=123 --limit=50 --offset=0
 * Lote todas las cuentas (ml_accounts): --all-accounts --limit=100 --ml-feedback-filter=feedback_any_pending
 *   PowerShell en Windows: `npm run … -- --flags` suele NO llegar al script; usá `npm.cmd run …` o
 *   `npm run import-ml-sales:all` (LIMIT / ML_FEEDBACK_FILTER por entorno) o `node scripts/importMlOrdersToSales.js …`.
 * Filtro por calificaciones ML en ml_orders (NULL = aún no hay rating en BD):
 *   --ml-feedback-filter=feedback_both_pending  (comprador y vendedor NULL)
 *   Valores: none | feedback_*_pending (solo IS NULL) | feedback_*_strict (texto literal pending)
 * Remoto HTTP (Render): npm run import-ml-sales-http (SALES_IMPORT_BASE_URL, ADMIN_SECRET, ML_USER_ID, …)
 *
 * Bloqueos habituales:
 * - SALES_ML_IMPORT_ENABLED=1 (oauth-env / .env)
 * - Con --all-accounts: solo ml_orders cuyo ml_user_id está en ml_accounts
 * - --ml-feedback-filter distinto de none: solo filas que cumplan (NULL en feedback_*); si matching_filter=0, no hay filas
 * - Sin fila en ml_buyers para buyer_id: customer_id queda null (igual se importa)
 */
"use strict";

require("../load-env-local");
const salesService = require("../src/services/salesService");
const { parseCliOption } = require("./parseCliOption");

async function main() {
  const argv = process.argv;
  const allAccounts =
    argv.includes("--all-accounts") ||
    String(process.env.ML_IMPORT_ALL_ACCOUNTS || "").trim() === "1";
  const mlUserId = Number(parseCliOption(argv, "ml-user-id") || process.env.ML_USER_ID);
  const orderIdRaw = parseCliOption(argv, "order-id") || process.env.ORDER_ID;
  const limitRaw = parseCliOption(argv, "limit");
  const offsetRaw = parseCliOption(argv, "offset");
  const limit =
    limitRaw != null && String(limitRaw).trim() !== ""
      ? Number(limitRaw)
      : Number(process.env.LIMIT || "50");
  const offset =
    offsetRaw != null && String(offsetRaw).trim() !== ""
      ? Number(offsetRaw)
      : Number(process.env.OFFSET || "0");
  const mlFeedbackFilter =
    parseCliOption(argv, "ml-feedback-filter") || process.env.ML_FEEDBACK_FILTER || "none";

  const hasOrder = orderIdRaw != null && String(orderIdRaw).trim() !== "";
  if (hasOrder && (!Number.isFinite(mlUserId) || mlUserId <= 0)) {
    console.error("Con --order-id hace falta --ml-user-id=N (o ML_USER_ID)");
    process.exit(1);
  }
  if (!hasOrder && !allAccounts && (!Number.isFinite(mlUserId) || mlUserId <= 0)) {
    console.error(
      "Indicar --ml-user-id=N (o ML_USER_ID) o --all-accounts (todas las cuentas en ml_accounts)"
    );
    console.error(
      "Si usás PowerShell en Windows y pasaste --all-accounts pero ves este error: el shim npm.ps1 no reenvía los argumentos. Probá: npm.cmd run import-ml-sales -- --all-accounts --limit=100  |  npm run import-ml-sales:all  |  node scripts/importMlOrdersToSales.js --all-accounts --limit=100"
    );
    process.exit(1);
  }

  if (String(process.env.SALES_ML_IMPORT_ENABLED || "").trim() !== "1") {
    console.error(
      "[import-ml-sales] SALES_ML_IMPORT_ENABLED no es 1. Definilo en el entorno o en oauth-env.json y volvé a ejecutar."
    );
    process.exit(1);
  }

  if (hasOrder) {
    const orderId = Number(orderIdRaw);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      console.error("order_id inválido");
      process.exit(1);
    }
    const data = await salesService.importSalesOrderFromMlOrder({ mlUserId, orderId });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const preview = await salesService.previewMlOrdersImport({
    mlUserId: allAccounts ? undefined : mlUserId,
    allAccounts,
    mlFeedbackFilter,
  });
  console.error(
    "[import-ml-sales] diagnóstico:",
    JSON.stringify(preview, null, 2)
  );
  if (preview.matching_filter === 0 && mlFeedbackFilter !== "none") {
    console.error(
      "[import-ml-sales] 0 filas coinciden: el filtro *_pending usa solo feedback_* IS NULL. Probá --ml-feedback-filter=none o feedback_both_pending si buscás órdenes sin ninguna calificación en BD."
    );
  }

  const data = await salesService.importSalesOrdersFromMlTable({
    mlUserId: allAccounts ? undefined : mlUserId,
    allAccounts,
    limit,
    offset,
    mlFeedbackFilter,
  });
  console.log(JSON.stringify(data, null, 2));
  if (data.rows_in_batch === 0) {
    console.error(
      "[import-ml-sales] Ninguna fila de ml_orders en este lote (filtro + límite/offset). Revisá diagnóstico arriba."
    );
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    console.error(
      "[import-ml-sales] Fallos en órdenes (la fila puede haberse insertado igual si el error fue después del COMMIT):",
      data.errors.length
    );
    for (const er of data.errors.slice(0, 15)) {
      console.error(`  order ${er.order_id} (ml_user ${er.ml_user_id}): [${er.code || "?"}] ${er.message}`);
    }
    if (data.errors.length > 15) console.error(`  … y ${data.errors.length - 15} más`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
