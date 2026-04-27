#!/usr/bin/env node
/**
 * Detecta órdenes en ml_orders sin fila en sales_orders e importa las que faltan.
 *
 * Uso:
 *   node scripts/reconcile-ml-sales-orphans.js --ml-user-id=12345
 *   node scripts/reconcile-ml-sales-orphans.js --all-accounts
 *   node scripts/reconcile-ml-sales-orphans.js --all-accounts --dry-run
 *   node scripts/reconcile-ml-sales-orphans.js --all-accounts --limit=500
 *
 * Requiere: DATABASE_URL, SALES_ML_IMPORT_ENABLED=1 (en oauth-env.json o env).
 */
"use strict";

require("../load-env-local");

const salesService = require("../src/services/salesService");

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const arg = (name) => {
    const entry = args.find((a) => a.startsWith(`--${name}=`));
    return entry ? entry.split("=").slice(1).join("=") : null;
  };

  const dryRun = flag("dry-run");
  const allAccounts = flag("all-accounts");
  const rawUid = arg("ml-user-id");
  const rawLimit = arg("limit");
  const mlUserId = rawUid != null ? Number(rawUid) : undefined;
  const limit = rawLimit != null ? Number(rawLimit) : undefined;

  if (!allAccounts && (mlUserId == null || !Number.isFinite(mlUserId) || mlUserId <= 0)) {
    console.error(
      "[reconcile] Error: indica --ml-user-id=<número> o --all-accounts\n" +
      "  Ejemplo: node scripts/reconcile-ml-sales-orphans.js --all-accounts --dry-run"
    );
    process.exit(1);
  }

  if (!dryRun && process.env.SALES_ML_IMPORT_ENABLED !== "1") {
    console.error(
      "[reconcile] SALES_ML_IMPORT_ENABLED no es '1'. " +
      "Definilo en oauth-env.json o en el entorno antes de continuar."
    );
    process.exit(1);
  }

  const scope = allAccounts ? "todas las cuentas" : `ml_user_id=${mlUserId}`;
  console.log(`[reconcile] Iniciando${dryRun ? " (DRY-RUN)" : ""} — scope: ${scope}`);
  if (!dryRun) {
    const limHint = limit != null && Number.isFinite(limit) ? String(limit) : "200 (default, máx 1000)";
    console.log(
      `[reconcile] Hasta ${limHint} huérfanos por ejecución. Cada uno corre un import completo (cliente, líneas, etc.); ` +
        "puede tardar varios minutos. Verás progreso (1/N) en esta consola."
    );
  }

  try {
    const result = await salesService.reconcileMlSalesOrphans({
      mlUserId,
      allAccounts,
      dryRun,
      limit,
      verbose: !dryRun,
    });

    console.log(`[reconcile] Huérfanos encontrados : ${result.orphans_found}`);
    if (!dryRun) {
      console.log(`[reconcile] Importadas           : ${result.imported}`);
      console.log(`[reconcile] Omitidas (skipped)   : ${result.skipped}`);
      console.log(`[reconcile] Errores               : ${result.errors.length}`);
      if (result.errors.length) {
        console.error("[reconcile] Detalle de errores:");
        for (const e of result.errors) {
          console.error(`  ml_user_id=${e.ml_user_id} order_id=${e.order_id} — [${e.code}] ${e.message}`);
        }
      }
    } else {
      console.log(`[reconcile] (dry-run) Muestra de huérfanos:`);
      for (const r of result.sample ?? []) {
        console.log(
          `  ml_user_id=${r.ml_user_id} order_id=${r.order_id} status=${r.status} date_created=${r.date_created}`
        );
      }
    }
  } catch (err) {
    console.error("[reconcile] Error:", err.message || err);
    process.exit(1);
  }

  process.exit(0);
}

main();
