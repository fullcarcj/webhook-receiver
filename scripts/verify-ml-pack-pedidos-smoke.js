/**
 * Smoke: resolveMlPackApplicationId, packMessagesPath, listMlOrderPackMessagesByUser.
 * Uso: node scripts/verify-ml-pack-pedidos-smoke.js
 */
"use strict";

require("../load-env-local");
const {
  resolveMlPackApplicationId,
  packMessagesPath,
} = require("../ml-pack-messages-sync");
const { listMlOrderPackMessagesByUser } = require("../db");

function main() {
  const appId = resolveMlPackApplicationId();
  const path = packMessagesPath(12345, 67890, 0, 10, "post_sale", appId);
  console.log("[ok] resolveMlPackApplicationId length:", appId.length);
  console.log("[ok] packMessagesPath starts with:", path.slice(0, 55) + "…");

  const dbUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!dbUrl) {
    console.log("[skip] DATABASE_URL no definida — sin consulta pg");
    return Promise.resolve();
  }
  const ms = Number(process.env.ML_PACK_SMOKE_DB_TIMEOUT_MS) || 6000;
  const withTimeout = (p, label) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms (BD inaccesible?)`)), ms)
      ),
    ]);
  return (async () => {
    const rows = await withTimeout(
      listMlOrderPackMessagesByUser(1, 3, { order_id: 999999999 }),
      "list con order_id"
    );
    console.log("[ok] listMlOrderPackMessagesByUser filtro order:", rows.length, "filas");
    const r2 = await withTimeout(listMlOrderPackMessagesByUser(1, 3, {}), "list sin order_id");
    console.log("[ok] listMlOrderPackMessagesByUser sin order_id:", r2.length, "filas");
    console.log("[ok] smoke completo");
  })();
}

main().catch((e) => {
  console.error("[fail]", e.message || e);
  process.exit(1);
});
