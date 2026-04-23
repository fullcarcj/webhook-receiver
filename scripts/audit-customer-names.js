#!/usr/bin/env node
"use strict";
/**
 * Audita full_name de los últimos N clientes (heurística local, sin Groq).
 *
 * Uso:
 *   npm run audit:customer-names
 *   npm run audit:customer-names -- --limit=200
 *   npm run audit:customer-names -- --solo=medio,alto
 *   npm run audit:customer-names -- --json
 *
 * Requiere: DATABASE_URL
 */
require("../load-env-local");
const { pool } = require("../db");
const { auditCustomerFullName } = require("../src/utils/customerNameAudit");

function parseArgs() {
  const out = { limit: 100, json: false, solo: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--json") out.json = true;
    const m = a.match(/^--limit=(\d+)$/);
    if (m) out.limit = Math.min(5000, Math.max(1, parseInt(m[1], 10)));
    const s = a.match(/^--solo=([\w,]+)$/);
    if (s) {
      out.solo = s[1]
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return out;
}

async function main() {
  const { limit, json, solo } = parseArgs();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL requerida.");
    process.exit(1);
  }

  let rows;
  try {
    const r = await pool.query(
      `SELECT c.id, c.full_name, c.phone, c.created_at::text AS created_at
       FROM customers c
       ORDER BY c.id DESC
       LIMIT $1`,
      [limit]
    );
    rows = r.rows;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }

  const enriched = rows.map((row) => {
    const a = auditCustomerFullName(row.full_name);
    return {
      id: String(row.id),
      full_name: row.full_name,
      phone: row.phone,
      created_at: row.created_at,
      nivel: a.level,
      motivos: a.reasons,
      sanitize_ok: a.sanitized_preview != null,
    };
  });

  const countsAll = { ok: 0, medio: 0, alto: 0, empty: 0 };
  for (const e of enriched) {
    countsAll[e.nivel] = (countsAll[e.nivel] || 0) + 1;
  }

  let list = enriched;
  if (solo && solo.length) {
    const set = new Set(solo);
    list = enriched.filter((e) => set.has(e.nivel));
  }

  if (json) {
    const counts = { ...countsAll };
    if (solo && solo.length) {
      counts.filtro_solo = solo;
      counts.mostrados = list.length;
    }
    console.log(JSON.stringify({ limit, counts, rows: list }, null, 2));
    process.exit(0);
  }

  console.log(`Auditoría de nombres — últimos ${limit} clientes (ORDER BY id DESC)\n`);
  console.log("Resumen (todos):", countsAll);
  if (solo && solo.length) {
    console.log(`Filtro --solo=${solo.join(",")} → ${list.length} fila(s)\n`);
  } else {
    console.log("");
  }
  for (const e of list) {
    const flag = e.nivel === "ok" ? "  " : e.nivel === "medio" ? "!!" : "XX";
    const mot = e.motivos.length ? e.motivos.join(", ") : "—";
    console.log(`${flag} id=${e.id}  [${e.nivel}]  ${JSON.stringify(e.full_name)}`);
    console.log(`      tel=${e.phone || "—"}  creado=${e.created_at}`);
    console.log(`      motivos: ${mot}  sanitize_ok=${e.sanitize_ok}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
