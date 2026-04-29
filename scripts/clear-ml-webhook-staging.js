#!/usr/bin/env node
"use strict";
/**
 * Vacía la tabla `ml_webhook_staging` (buffer de webhooks ML).
 *
 * Uso:
 *   npm run staging:ml-clear:dry   ← solo cuenta filas, no borra
 *   npm run staging:ml-clear       ← DELETE de todas las filas
 *   node scripts/clear-ml-webhook-staging.js --dry-run
 *
 * Requiere DATABASE_URL (oauth-env.json / env). Equivale a
 * DELETE /admin/ml-webhook-staging?delete_all=1 con admin en HTTP.
 */
require("../load-env-local");
const { countMlWebhookStaging, deleteAllMlWebhookStaging } = require("../db");

async function main() {
  const dry = process.argv.includes("--dry-run");
  const before = await countMlWebhookStaging();
  if (dry) {
    console.log(`[dry-run] ml_webhook_staging: ${before} fila(s). No se borró nada.`);
    return;
  }
  const deleted = await deleteAllMlWebhookStaging();
  console.log(`ml_webhook_staging: eliminadas ${deleted} fila(s) (antes: ${before}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
