#!/usr/bin/env node
"use strict";
/**
 * Marca toda la bandeja como leída: pone unread_count = 0 en crm_chats
 * (misma lógica que POST /api/inbox/reset-unread y markChatRead por chat).
 *
 * Uso:
 *   npm run inbox:mark-all-read:dry    ← solo muestra conteos, no escribe
 *   npm run inbox:mark-all-read        ← ejecuta el UPDATE
 *   node scripts/inbox-mark-all-read.js --dry-run
 *
 * Requiere DATABASE_URL (y load-env-local / oauth-env.json si aplica en local).
 */
require("../load-env-local");
const { pool } = require("../db");
const { resetAllChatsUnread } = require("../src/services/inboxService");

async function stats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE unread_count > 0)::int AS chats_con_no_leidos,
      COALESCE(SUM(unread_count), 0)::bigint AS suma_contadores
    FROM crm_chats
  `);
  return rows[0] || {};
}

async function main() {
  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }

  const dry = process.argv.includes("--dry-run");
  const s = await stats();
  const chats = Number(s.chats_con_no_leidos) || 0;
  const suma = String(s.suma_contadores ?? "0");

  if (dry) {
    console.log("[dry-run] Chats con unread_count > 0:", chats);
    console.log("[dry-run] Suma de unread_count en todos los chats:", suma);
    console.log("[dry-run] No se escribió nada. Quita --dry-run para aplicar.");
    return;
  }

  const out = await resetAllChatsUnread();
  console.log("Listo. Filas actualizadas (chats que tenían unread > 0):", out.chats_reset);
  const after = await stats();
  console.log(
    "Tras el UPDATE — chats con no leídos:",
    Number(after.chats_con_no_leidos) || 0,
    "| suma contadores:",
    String(after.suma_contadores ?? "0")
  );
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
