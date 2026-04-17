#!/usr/bin/env node
"use strict";

require("../../load-env-local");
const { pool } = require("../../db");
const { calcularScore, mergeCustomers } = require("../services/customerMergeService");

function envInt(name, def) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return def;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

async function upsertMergeCandidate(client, { companyId, idA, idB, score, breakdown, status }) {
  const a = Math.min(idA, idB);
  const b = Math.max(idA, idB);
  const { rows } = await client.query(
    `SELECT id, status FROM merge_candidates WHERE customer_id_a = $1 AND customer_id_b = $2`,
    [a, b]
  );
  if (!rows.length) {
    await client.query(
      `INSERT INTO merge_candidates (company_id, customer_id_a, customer_id_b, score, score_breakdown, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [companyId, a, b, score, JSON.stringify(breakdown), status]
    );
    return "inserted";
  }
  const st = rows[0].status;
  if (st === "pending" || st === "auto_approved") {
    await client.query(
      `UPDATE merge_candidates
       SET score = $1, score_breakdown = $2::jsonb, status = $3, updated_at = now()
       WHERE id = $4`,
      [score, JSON.stringify(breakdown), status, rows[0].id]
    );
    return "updated";
  }
  return "skipped";
}

async function run() {
  const companyId = envInt("DEDUP_COMPANY_ID", 1);
  const lookbackDays = envInt("DEDUP_LOOKBACK_DAYS", 7);
  const dryRun = envBool("DEDUP_DRY_RUN", false);

  const out = {
    pairs_evaluated: 0,
    auto_merged: 0,
    pending_created: 0,
    discarded: 0,
    errors: [],
  };

  const client = await pool.connect();
  let locked = false;
  try {
    const { rows: lk } = await client.query(
      `SELECT pg_try_advisory_lock((abs(hashtext('dedup_worker'::text)))::bigint) AS locked`
    );
    locked = Boolean(lk[0] && lk[0].locked);
    if (!locked) {
      console.log("[dedup-worker]", { message: "already running", exit: 0 });
      return;
    }

    const { rows: pairs } = await client.query(
      `
      SELECT
        c1.id AS id_a,
        c1.full_name AS full_name_a,
        c1.phone AS phone_a,
        c1.id_type AS id_type_a,
        c1.id_number AS id_number_a,
        c1.email AS email_a,
        c1.company_id,
        c2.id AS id_b,
        c2.full_name AS full_name_b,
        c2.phone AS phone_b,
        c2.id_type AS id_type_b,
        c2.id_number AS id_number_b,
        c2.email AS email_b,
        similarity(
          lower(coalesce(c1.full_name, '')),
          lower(coalesce(c2.full_name, ''))
        ) AS name_sim,
        EXISTS (
          SELECT 1
          FROM customer_ml_buyers m1
          INNER JOIN customer_ml_buyers m2 ON m1.ml_buyer_id = m2.ml_buyer_id
          WHERE m1.customer_id = c1.id AND m2.customer_id = c2.id
        ) AS shared_ml_buyer
      FROM customers c1
      JOIN customers c2
        ON c2.id > c1.id AND c2.company_id = c1.company_id
      WHERE c1.company_id = $1
        AND (
          c1.updated_at >= now() - ($2::integer * interval '1 day')
          OR c2.updated_at >= now() - ($2::integer * interval '1 day')
        )
      `,
      [companyId, lookbackDays]
    );

    for (const row of pairs) {
      out.pairs_evaluated++;
      const cs = calcularScore({
        idTypeA: row.id_type_a,
        idNumberA: row.id_number_a,
        phoneA: row.phone_a,
        emailA: row.email_a,
        idTypeB: row.id_type_b,
        idNumberB: row.id_number_b,
        phoneB: row.phone_b,
        emailB: row.email_b,
        nameSim: row.name_sim,
        sharedMlBuyer: row.shared_ml_buyer,
      });

      if (cs.action === "discard") {
        out.discarded++;
        continue;
      }

      if (dryRun) {
        if (cs.action === "pending") out.pending_created += 1;
        if (cs.action === "auto_merge") out.auto_merged += 1;
        continue;
      }

      const st = cs.action === "auto_merge" ? "auto_approved" : "pending";

      try {
        await client.query("BEGIN");
        const up = await upsertMergeCandidate(client, {
          companyId: row.company_id,
          idA: row.id_a,
          idB: row.id_b,
          score: cs.score,
          breakdown: cs.breakdown,
          status: st,
        });
        if (up !== "skipped" && st === "pending") out.pending_created++;

        if (cs.action === "auto_merge") {
          if (up === "skipped") {
            await client.query("ROLLBACK");
            continue;
          }
          const keepId = Math.min(Number(row.id_a), Number(row.id_b));
          const dropId = Math.max(Number(row.id_a), Number(row.id_b));
          await mergeCustomers(keepId, dropId, {
            triggeredBy: "auto_worker",
            score: cs.score,
            scoreBreakdown: cs.breakdown,
            dbClient: client,
          });
          out.auto_merged++;
        }

        await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_r) {
          /* ignore */
        }
        out.errors.push({ pair: [row.id_a, row.id_b], message: String(e && e.message), code: e && e.code });
      }
    }

    console.log("[dedup-worker]", out);
  } catch (e) {
    console.error("[dedup-worker] fatal", e);
    process.exitCode = 1;
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock((abs(hashtext('dedup_worker'::text)))::bigint)`);
      } catch (_e) {
        /* ignore */
      }
    }
    client.release();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { run };
