#!/usr/bin/env node
/**
 * FASE 1 — Deduplicación de customers por teléfono normalizado.
 * Ejecutar DESPUÉS de: npm run db:phone-normalization
 * UNA VEZ en ventana de baja actividad.
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");
const { normalizePhone } = require("../src/utils/phoneNormalizer");
const pino = require("pino");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "dedupeCustomers" });

function pickWinner(rows) {
  const list = rows.map((r) => ({
    id: Number(r.id),
    full_name: r.full_name,
    created_at: r.created_at,
  }));
  const real = list.filter((r) => r.full_name && !String(r.full_name).startsWith("WA-"));
  const poolPick = real.length ? real : list;
  poolPick.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return poolPick[0].id;
}

async function mergeLoyalty(client, loserIds, winnerId) {
  const { rows: sums } = await client.query(
    `SELECT COALESCE(SUM(points_balance), 0)::int AS pts FROM loyalty_accounts WHERE customer_id = ANY($1::bigint[])`,
    [loserIds]
  );
  const addPts = sums[0] ? Number(sums[0].pts) : 0;
  if (addPts > 0) {
    await client.query(
      `INSERT INTO loyalty_accounts (customer_id, points_balance) VALUES ($1, $2)
       ON CONFLICT (customer_id) DO UPDATE SET
         points_balance = loyalty_accounts.points_balance + EXCLUDED.points_balance`,
      [winnerId, addPts]
    );
  }
  await client.query(`DELETE FROM loyalty_accounts WHERE customer_id = ANY($1::bigint[])`, [loserIds]);
}

async function mergeWallets(client, loserIds, winnerId) {
  const { rows: lw } = await client.query(
    `SELECT id, customer_id, currency, balance FROM customer_wallets WHERE customer_id = ANY($1::bigint[])`,
    [loserIds]
  );
  for (const w of lw) {
    const { rows: target } = await client.query(
      `SELECT id FROM customer_wallets WHERE customer_id = $1 AND currency = $2`,
      [winnerId, w.currency]
    );
    if (target.length) {
      await client.query(`UPDATE wallet_transactions SET wallet_id = $1 WHERE wallet_id = $2`, [target[0].id, w.id]);
      await client.query(
        `UPDATE customer_wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [w.balance, target[0].id]
      );
      await client.query(`DELETE FROM customer_wallets WHERE id = $1`, [w.id]);
    } else {
      await client.query(`UPDATE customer_wallets SET customer_id = $1 WHERE id = $2`, [winnerId, w.id]);
    }
  }
  await client.query(`DELETE FROM customer_wallets WHERE customer_id = ANY($1::bigint[])`, [loserIds]);
}

async function reassignFks(client, loserIds, winnerId) {
  await client.query(
    `DELETE FROM crm_customer_identities a
     WHERE a.customer_id = ANY($1::bigint[])
       AND EXISTS (
         SELECT 1 FROM crm_customer_identities b
         WHERE b.customer_id = $2 AND b.source = a.source AND b.external_id = a.external_id
       )`,
    [loserIds, winnerId]
  );

  const tables = [
    ["crm_customer_identities", "customer_id"],
    ["crm_customer_vehicles", "customer_id"],
    ["crm_whatsapp_logs", "customer_id"],
    ["crm_messages", "customer_id"],
    ["crm_chats", "customer_id"],
    ["sales_orders", "customer_id"],
    ["customer_ml_buyers", "customer_id"],
    ["loyalty_movements", "customer_id"],
  ];

  for (const [tbl, col] of tables) {
    try {
      await client.query(`UPDATE ${tbl} SET ${col} = $1 WHERE ${col} = ANY($2::bigint[])`, [
        winnerId,
        loserIds,
      ]);
    } catch (e) {
      if (e && e.code === "42P01") {
        log.warn({ tbl }, "tabla omitida (no existe)");
      } else {
        throw e;
      }
    }
  }

  try {
    await client.query(
      `UPDATE wallet_transactions SET customer_id = $1 WHERE customer_id = ANY($2::bigint[])`,
      [winnerId, loserIds]
    );
  } catch (e) {
    if (e && e.code !== "42P01") throw e;
  }

  try {
    await mergeLoyalty(client, loserIds, winnerId);
  } catch (e) {
    if (e && e.code !== "42P01") throw e;
  }
  try {
    await mergeWallets(client, loserIds, winnerId);
  } catch (e) {
    if (e && e.code !== "42P01") throw e;
  }
}

async function deduplicateCustomers() {
  const report = {
    groups_found: 0,
    customers_merged: 0,
    identities_reassigned: 0,
    merges: [],
    errors: [],
  };

  const { rows: all } = await pool.query(
    `SELECT id, full_name, phone, created_at FROM customers WHERE phone IS NOT NULL AND TRIM(phone) <> ''`
  );

  const byNorm = new Map();
  for (const r of all) {
    const n = normalizePhone(r.phone);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(r);
  }

  for (const [phoneNorm, group] of byNorm) {
    if (group.length < 2) continue;
    report.groups_found++;

    const winnerId = pickWinner(group);
    const loserIds = group.map((g) => Number(g.id)).filter((id) => id !== winnerId);
    if (!loserIds.length) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM customers WHERE id = $1 FOR UPDATE`, [winnerId]);
      for (const lid of loserIds) {
        await client.query(`SELECT id FROM customers WHERE id = $1 FOR UPDATE`, [lid]);
      }

      const cntRows = await client.query(
        `SELECT COUNT(*)::int AS c FROM crm_customer_identities WHERE customer_id = ANY($1::bigint[])`,
        [loserIds]
      );

      await reassignFks(client, loserIds, winnerId);

      const bestName = group
        .map((g) => g.full_name)
        .find((n) => n && !String(n).startsWith("WA-"));
      const { rows: wrow } = await client.query(`SELECT full_name FROM customers WHERE id = $1`, [winnerId]);
      if (bestName && wrow.length && String(wrow[0].full_name || "").startsWith("WA-")) {
        await client.query(`UPDATE customers SET full_name = $1, updated_at = NOW() WHERE id = $2`, [
          bestName,
          winnerId,
        ]);
      }

      await client.query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [loserIds]);

      await client.query("COMMIT");

      report.customers_merged += loserIds.length;
      report.identities_reassigned += Number(cntRows.rows[0].c);
      report.merges.push({
        phone_norm: phoneNorm,
        winner_id: winnerId,
        merged_ids: loserIds,
      });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_r) {
        /* ignore */
      }
      report.errors.push({ phone_norm: phoneNorm, message: String(e.message), code: e.code });
      log.error({ err: e, phoneNorm }, "merge falló");
    } finally {
      client.release();
    }
  }

  console.log("=== REPORTE DE DEDUPLICACIÓN ===");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  deduplicateCustomers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { deduplicateCustomers, pickWinner };
