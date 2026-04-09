#!/usr/bin/env node
"use strict";

require("../load-env-local");

const { pool } = require("../db");

function parseArg(name) {
  const full = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(full));
  if (!hit) return null;
  return String(hit).slice(full.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const deleteAll = hasFlag("all");
  const dryRun = hasFlag("dry-run");
  const hoursArg = parseArg("older-than-hours");
  const ttlHours =
    hoursArg != null
      ? Number.parseInt(hoursArg, 10)
      : Number.parseInt(String(process.env.CRM_CHAT_STATE_TTL_SECONDS || 7 * 24 * 3600), 10) / 3600;

  if (!deleteAll && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
    console.error("Uso inválido. Ejemplos:");
    console.error("  npm run crm-chat-states:cleanup");
    console.error("  npm run crm-chat-states:cleanup -- --older-than-hours=24");
    console.error("  npm run crm-chat-states:cleanup -- --all");
    process.exit(1);
  }

  const whereSql = deleteAll ? "TRUE" : "updated_at < NOW() - ($1 * INTERVAL '1 hour')";
  const params = deleteAll ? [] : [ttlHours];
  const label = deleteAll ? "ALL" : `older-than-hours=${ttlHours}`;

  try {
    const countQ = await pool.query(`SELECT COUNT(*)::int AS n FROM crm_chat_states WHERE ${whereSql}`, params);
    const totalQ = await pool.query(`SELECT COUNT(*)::int AS n FROM crm_chat_states`);
    const target = Number(countQ.rows[0]?.n || 0);
    const totalBefore = Number(totalQ.rows[0]?.n || 0);

    if (dryRun) {
      console.log(`[crm-chat-states:cleanup] dry-run mode`);
      console.log(`[crm-chat-states:cleanup] criterio=${label} candidatos=${target} total=${totalBefore}`);
      return;
    }

    const delQ = await pool.query(`DELETE FROM crm_chat_states WHERE ${whereSql}`, params);
    const deleted = Number(delQ.rowCount || 0);
    const totalAfterQ = await pool.query(`SELECT COUNT(*)::int AS n FROM crm_chat_states`);
    const totalAfter = Number(totalAfterQ.rows[0]?.n || 0);

    console.log(`[crm-chat-states:cleanup] criterio=${label}`);
    console.log(`[crm-chat-states:cleanup] deleted=${deleted} total_before=${totalBefore} total_after=${totalAfter}`);
  } catch (e) {
    console.error("[crm-chat-states:cleanup] error:", e.message);
    if (e && e.code === "42P01") {
      console.error("La tabla crm_chat_states no existe. Ejecuta: npm run db:crm-chat-states");
    }
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch (_e) {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error("[crm-chat-states:cleanup] fatal:", e.message);
  process.exit(1);
});
