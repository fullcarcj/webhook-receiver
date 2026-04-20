#!/usr/bin/env node
"use strict";
/**
 * Comprueba migración AI Responder (columnas crm_messages + tabla ai_response_log).
 * Uso: npm run verify:ai-responder (requiere DATABASE_URL).
 */
require("../load-env-local");
const { pool } = require("../db");

async function main() {
  const issues = [];
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL no definida");
    process.exit(1);
  }
  try {
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'crm_messages'
         AND column_name = ANY($1::text[])`,
      [["ai_reply_status", "receipt_data", "ai_processed_at", "ai_reply_updated_at"]]
    );
    const have = new Set(cols.map((c) => c.column_name));
    for (const c of ["ai_reply_status", "receipt_data", "ai_processed_at", "ai_reply_updated_at"]) {
      if (!have.has(c)) issues.push(`crm_messages.${c} ausente`);
    }
    const { rows: tab } = await pool.query(
      `SELECT to_regclass('public.ai_response_log')::text AS name`
    );
    if (!tab[0] || tab[0].name === "") issues.push("tabla ai_response_log ausente");
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
  if (issues.length) {
    console.error("❌ AI Responder — migración incompleta:");
    for (const i of issues) console.error("   -", i);
    console.error("   Ejecutar: npm run db:ai-responder");
    process.exit(1);
  }
  const on = String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
  console.log("✅ AI Responder — esquema OK");
  console.log(`   AI_RESPONDER_ENABLED=${on ? "1 (worker arranca al iniciar servidor)" : "off (poner 1 para piloto)"}`);
  console.log("   Monitoreo: GET /ai-responder?k=ADMIN_SECRET");
  process.exit(0);
}

main();
