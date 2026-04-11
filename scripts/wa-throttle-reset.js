#!/usr/bin/env node
"use strict";
/**
 * Resetea el contador diario del throttle para uno o todos los teléfonos.
 *
 * Uso:
 *   node scripts/wa-throttle-reset.js +584242701513   ← reset de un número
 *   node scripts/wa-throttle-reset.js --all           ← reset de todos hoy
 *   npm run wa-throttle-reset -- +584242701513
 *
 * Requiere DATABASE_URL.
 */
require("../load-env-local");
const { pool } = require("../db");

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Uso: node scripts/wa-throttle-reset.js +584242701513 | --all");
    process.exit(1);
  }

  try {
    if (arg === "--all") {
      const r = await pool.query(
        `DELETE FROM wa_throttle
         WHERE sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date`
      );
      console.log(`Throttle reseteado — ${r.rowCount} filas eliminadas (todos los números de hoy).`);
    } else {
      const phone = String(arg).replace(/\s/g, "");
      const r = await pool.query(
        `DELETE FROM wa_throttle
         WHERE phone_e164 = $1
           AND sent_date = (NOW() AT TIME ZONE 'America/Caracas')::date`,
        [phone]
      );
      if (r.rowCount > 0) {
        console.log(`Throttle reseteado para ${phone} (${r.rowCount} fila eliminada).`);
      } else {
        console.log(`Sin fila de throttle hoy para ${phone} — ya estaba en 0 o el número no coincide.`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
