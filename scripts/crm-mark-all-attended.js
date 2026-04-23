#!/usr/bin/env node
"use strict";
/**
 * Marca todos los hilos CRM como atendidos manualmente: pone `marked_attended_at = NOW()`
 * en todas las filas de `crm_chats` (misma semántica que PATCH …/mark-attended por chat).
 * Oculta el badge “pendiente / sin atender” derivado de esa marca hasta un nuevo inbound.
 *
 * Requiere migración: npm run db:crm-chats-marked-attended
 *
 * Uso:
 *   npm run crm:mark-all-attended:dry
 *   npm run crm:mark-all-attended
 *   node scripts/crm-mark-all-attended.js --dry-run
 *
 * Opcional:
 *   --only-null   solo filas donde marked_attended_at IS NULL (default sin flag: todas las filas)
 */
require("../load-env-local");
const { pool } = require("../db");

async function columnExists() {
  const { rows } = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'crm_chats'
      AND column_name = 'marked_attended_at'
    LIMIT 1
  `);
  return rows.length > 0;
}

async function stats(whereOnlyNull) {
  const w = whereOnlyNull ? "WHERE marked_attended_at IS NULL" : "";
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM crm_chats
    ${w}
    `,
    []
  );
  return Number(rows[0]?.n) || 0;
}

async function main() {
  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("Falta DATABASE_URL.");
    process.exit(1);
  }

  const dry = process.argv.includes("--dry-run");
  const onlyNull = process.argv.includes("--only-null");

  const hasCol = await columnExists();
  if (!hasCol) {
    console.error(
      "La columna crm_chats.marked_attended_at no existe. Ejecutá: npm run db:crm-chats-marked-attended"
    );
    process.exit(1);
  }

  const target = await stats(onlyNull);
  const total = await stats(false);

  if (dry) {
    console.log("[dry-run] Total filas en crm_chats:", total);
    console.log(
      "[dry-run] Filas que se actualizarían:",
      onlyNull ? `${target} (solo marked_attended_at IS NULL)` : `${total} (todas)`
    );
    console.log("[dry-run] No se escribió nada. Sin --dry-run para aplicar.");
    return;
  }

  const where = onlyNull ? "WHERE marked_attended_at IS NULL" : "";
  const r = await pool.query(
    `
    UPDATE crm_chats
    SET marked_attended_at = NOW(),
        updated_at = NOW()
    ${where}
    `,
    []
  );
  console.log(
    "Listo. Filas actualizadas:",
    r.rowCount,
    onlyNull ? "(solo las que tenían marked_attended_at NULL)" : "(todas las filas)"
  );
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
