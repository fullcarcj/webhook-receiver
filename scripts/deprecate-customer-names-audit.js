#!/usr/bin/env node
"use strict";
/**
 * Deprecación suave de clientes con full_name “obviamente malo” (misma heurística que audit:customer-names).
 *
 * - Marca `is_active = false`, `crm_status = 'blocked'` (si la columna existe).
 * - Borra filas en `crm_customer_identities` fuente whatsapp/mostrador para liberar el teléfono
 *   y permitir que `resolveCustomer` cree/enlace un cliente nuevo.
 * - No borra la fila en `customers` (historial / FKs).
 *
 * Uso:
 *   npm run deprecate:customer-names-audit -- --limit=100
 *   npm run deprecate:customer-names-audit -- --limit=500 --niveles=medio,alto --apply
 *   npm run deprecate:customer-names-audit -- --apply --force   (ignora ventas en sales_orders / mostrador_orders)
 *
 * Por defecto es dry-run (solo imprime). Requiere DATABASE_URL.
 */
require("../load-env-local");
const { pool } = require("../db");
const { auditCustomerFullName } = require("../src/utils/customerNameAudit");

function parseArgs() {
  const out = {
    limit: 100,
    niveles: new Set(["medio", "alto"]),
    apply: false,
    force: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    if (a === "--force") out.force = true;
    const m = a.match(/^--limit=(\d+)$/);
    if (m) out.limit = Math.min(5000, Math.max(1, parseInt(m[1], 10)));
    const n = a.match(/^--niveles=([\w,]+)$/);
    if (n) {
      out.niveles = new Set(
        n[1]
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      );
    }
  }
  return out;
}

async function tableExists(client, name) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`public.${name}`]
  );
  return Boolean(rows[0]?.ok);
}

async function deprecateOne(client, row, reasons, whereExtra) {
  const id = Number(row.id);
  const noteLine = `[deprecado_nombre_audit ${new Date().toISOString().slice(0, 19)}Z] ${reasons.join("; ")}`;

  const params = [id, noteLine];
  const tail = whereExtra || "";

  let upd;
  try {
    upd = await client.query(
      `UPDATE customers c SET
         is_active = false,
         crm_status = 'blocked',
         notes = TRIM(BOTH E'\n' FROM COALESCE(c.notes, '') ||
           CASE WHEN COALESCE(TRIM(c.notes), '') = '' THEN '' ELSE E'\n' END || $2::text),
         updated_at = NOW()
       WHERE c.id = $1
         AND c.is_active = true
         ${tail}
       RETURNING c.id`,
      params
    );
  } catch (e) {
    if (e && e.code === "42703" && String(e.message || "").includes("crm_status")) {
      upd = await client.query(
        `UPDATE customers c SET
           is_active = false,
           notes = TRIM(BOTH E'\n' FROM COALESCE(c.notes, '') ||
             CASE WHEN COALESCE(TRIM(c.notes), '') = '' THEN '' ELSE E'\n' END || $2::text),
           updated_at = NOW()
         WHERE c.id = $1
           AND c.is_active = true
           ${tail}
         RETURNING c.id`,
        params
      );
    } else throw e;
  }

  if (!upd.rowCount) {
    return { skipped: true, reason: "no_match_or_has_orders" };
  }

  const del = await client.query(
    `DELETE FROM crm_customer_identities
     WHERE customer_id = $1
       AND source IN ('whatsapp'::crm_identity_source, 'mostrador'::crm_identity_source)`,
    [id]
  );

  return { skipped: false, identities_removed: del.rowCount };
}

async function main() {
  const { limit, niveles, apply, force } = parseArgs();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL requerida.");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const hasSales = await tableExists(client, "sales_orders");
    const hasMostrador = await tableExists(client, "mostrador_orders");
    const guardParts = [];
    if (hasSales) {
      guardParts.push(`NOT EXISTS (SELECT 1 FROM sales_orders so WHERE so.customer_id = c.id LIMIT 1)`);
    }
    if (hasMostrador) {
      guardParts.push(`NOT EXISTS (SELECT 1 FROM mostrador_orders mo WHERE mo.customer_id = c.id LIMIT 1)`);
    }
    const whereExtra = !force && guardParts.length ? ` AND ${guardParts.join(" AND ")}` : "";
    if (!force && !guardParts.length) {
      console.warn("[warn] No hay tablas sales_orders/mostrador_orders; no se aplica guard de órdenes.");
    }

    const { rows } = await client.query(
      `SELECT c.id, c.full_name, c.phone, c.created_at::text AS created_at, c.is_active
       FROM customers c
       ORDER BY c.id DESC
       LIMIT $1`,
      [limit]
    );

    const targets = [];
    for (const row of rows) {
      const a = auditCustomerFullName(row.full_name);
      if (!niveles.has(a.level)) continue;
      if (a.level === "empty") continue;
      targets.push({ row, audit: a });
    }

    console.log(
      `Candidatos (${targets.length} en últimos ${limit}, niveles=[${[...niveles].join(",")}]): ` +
        `${apply ? "APLICAR" : "DRY-RUN"}` +
        `${force ? " + --force" : ""}\n`
    );

    let applied = 0;
    let skipped = 0;
    let skippedOrders = 0;

    for (const { row, audit } of targets) {
      const id = row.id;
      const mot = audit.reasons.join(", ");
      const line = `id=${id} [${audit.level}] ${JSON.stringify(row.full_name)} tel=${row.phone || "—"} activo=${row.is_active}`;
      if (!apply) {
        console.log(`  would: ${line}`);
        console.log(`         motivos: ${mot}`);
        continue;
      }

      if (!row.is_active) {
        console.log(`  skip (ya inactivo): ${line}`);
        skipped++;
        continue;
      }

      await client.query("BEGIN");
      try {
        const r = await deprecateOne(client, row, audit.reasons, whereExtra);
        if (r.skipped) {
          await client.query("ROLLBACK");
          console.log(`  skip (órdenes o sin fila): ${line}`);
          skippedOrders++;
          continue;
        }
        await client.query("COMMIT");
        applied++;
        console.log(`  ok: ${line} | idents_borrados=${r.identities_removed}`);
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`  error id=${id}:`, e.message);
        skipped++;
      }
    }

    if (apply) {
      console.log(`\nResumen: aplicados=${applied} omitidos=${skipped} omitidos_por_ordenes_o_update=${skippedOrders}`);
    } else {
      console.log(`\nDry-run: ${targets.length} filas. Ejecutar con --apply para escribir en BD.`);
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
