"use strict";

const { pool } = require("../../db");
const { normalizePhone } = require("../utils/phoneNormalizer");

function normDocKey(idType, idNumber) {
  if (idType == null || idNumber == null) return null;
  const t = String(idType).trim().toUpperCase();
  const n = String(idNumber)
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .toUpperCase();
  if (!t || !n) return null;
  return `${t}|${n}`;
}

function normEmail(e) {
  if (e == null || String(e).trim() === "") return null;
  return String(e).trim().toLowerCase();
}

/**
 * @param {object} p
 * @param {number} p.nameSim similarity 0..1 desde SQL (pg_trgm)
 * @param {boolean} p.sharedMlBuyer
 */
function calcularScore(p) {
  const docA = normDocKey(p.idTypeA, p.idNumberA);
  const docB = normDocKey(p.idTypeB, p.idNumberB);
  const sameDoc = docA != null && docA === docB;
  const phoneA = normalizePhone(p.phoneA);
  const phoneB = normalizePhone(p.phoneB);
  const samePhone = phoneA != null && phoneB != null && phoneA === phoneB;
  const sameEmail = normEmail(p.emailA) != null && normEmail(p.emailA) === normEmail(p.emailB);
  const sharedMlBuyer = Boolean(p.sharedMlBuyer);

  const nameSim = Number(p.nameSim) || 0;
  const nameStrong = nameSim > 0.8;

  let score = 0;
  const breakdown = {};
  if (sameDoc && samePhone) {
    breakdown.doc_and_phone = 150;
    score += 150;
  } else {
    if (sameDoc) {
      breakdown.same_doc = 100;
      score += 100;
    }
    if (samePhone) {
      breakdown.phone = 50;
      score += 50;
    }
  }
  if (sharedMlBuyer) {
    breakdown.shared_ml_buyer = 100;
    score += 100;
  }
  if (sameEmail) {
    breakdown.email = 40;
    score += 40;
  }
  if (nameStrong) {
    breakdown.name_similarity = 30;
    score += 30;
  }

  const hardAnchor = sameDoc || sharedMlBuyer;

  let action = "discard";
  if (score < 60) {
    action = "discard";
  } else if (!hardAnchor) {
    action = "pending";
  } else if (score >= 100) {
    action = "auto_merge";
  } else {
    action = "pending";
  }

  return { score, breakdown, action, sameDoc, samePhone, sharedMlBuyer, hardAnchor };
}

async function mergeLoyalty(client, loserId, winnerId) {
  const { rows: sums } = await client.query(
    `SELECT COALESCE(SUM(points_balance), 0)::int AS pts FROM loyalty_accounts WHERE customer_id = $1`,
    [loserId]
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
  await client.query(`DELETE FROM loyalty_accounts WHERE customer_id = $1`, [loserId]);
}

async function mergeWallets(client, loserId, winnerId) {
  const { rows: lw } = await client.query(
    `SELECT id, customer_id, currency, balance FROM customer_wallets WHERE customer_id = $1`,
    [loserId]
  );
  for (const w of lw) {
    const { rows: target } = await client.query(
      `SELECT id FROM customer_wallets WHERE customer_id = $1 AND currency = $2`,
      [winnerId, w.currency]
    );
    if (target.length) {
      await client.query(`UPDATE wallet_transactions SET wallet_id = $1 WHERE wallet_id = $2`, [
        target[0].id,
        w.id,
      ]);
      await client.query(
        `UPDATE customer_wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [w.balance, target[0].id]
      );
      await client.query(`DELETE FROM customer_wallets WHERE id = $1`, [w.id]);
    } else {
      await client.query(`UPDATE customer_wallets SET customer_id = $1 WHERE id = $2`, [winnerId, w.id]);
    }
  }
  await client.query(`DELETE FROM customer_wallets WHERE customer_id = $1`, [loserId]);
}

function snapshotRow(row) {
  if (!row) return null;
  const o = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v != null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      o[k] = v;
    } else {
      o[k] = v instanceof Date ? v.toISOString() : v;
    }
  }
  return o;
}

async function enrichCustomerFromDropped(client, keepId, dropId) {
  const { rows } = await client.query(`SELECT * FROM customers WHERE id = ANY($1::bigint[])`, [
    [keepId, dropId],
  ]);
  const kept = rows.find((r) => Number(r.id) === Number(keepId));
  const dropped = rows.find((r) => Number(r.id) === Number(dropId));
  if (!kept || !dropped) return;

  const patches = [];
  const vals = [];
  let i = 1;

  const nullish = (v) => v == null || v === "";
  const waName = (n) => n != null && String(n).startsWith("WA-");

  if (waName(kept.full_name) && dropped.full_name && !waName(dropped.full_name)) {
    patches.push(`full_name = $${i++}`);
    vals.push(dropped.full_name);
  }

  const copyIfEmpty = (col) => {
    if (nullish(kept[col]) && !nullish(dropped[col])) {
      patches.push(`${col} = $${i++}`);
      vals.push(dropped[col]);
    }
  };

  copyIfEmpty("phone");
  copyIfEmpty("email");
  copyIfEmpty("id_type");
  copyIfEmpty("id_number");
  copyIfEmpty("address");
  copyIfEmpty("city");
  copyIfEmpty("notes");
  if (kept.primary_ml_buyer_id == null && dropped.primary_ml_buyer_id != null) {
    patches.push(`primary_ml_buyer_id = $${i++}`);
    vals.push(dropped.primary_ml_buyer_id);
  }
  if ((!kept.tags || kept.tags.length === 0) && dropped.tags && dropped.tags.length) {
    patches.push(`tags = $${i++}`);
    vals.push(dropped.tags);
  }

  if (!patches.length) return;

  vals.push(keepId);
  await client.query(`UPDATE customers SET ${patches.join(", ")}, updated_at = NOW() WHERE id = $${i}`, vals);
}

/**
 * @param {number|string} keepId
 * @param {number|string} dropId
 * @param {object} [options]
 * @param {import("pg").PoolClient} [options.dbClient] transacción externa (no release)
 */
async function mergeCustomers(keepId, dropId, options = {}) {
  const triggeredBy = options.triggeredBy || "manual";
  const score = options.score != null ? Number(options.score) : null;
  const scoreBreakdown = options.scoreBreakdown != null ? options.scoreBreakdown : null;
  const dryRun = Boolean(options.dryRun);
  const externalClient = options.dbClient || null;
  if (externalClient && dryRun) {
    throw Object.assign(new Error("DRY_RUN_REQUIRES_INTERNAL_POOL"), { code: "DRY_RUN_REQUIRES_INTERNAL_POOL" });
  }

  const kId = Number(keepId);
  const dId = Number(dropId);
  if (!Number.isFinite(kId) || !Number.isFinite(dId)) {
    throw Object.assign(new Error("INVALID_IDS"), { code: "INVALID_IDS" });
  }
  if (kId === dId) {
    throw Object.assign(new Error("SAME_CUSTOMER"), { code: "SAME_CUSTOMER" });
  }

  const rowsAffected = {
    crm_identities: 0,
    crm_vehicles: 0,
    ml_buyers: 0,
    crm_chats: 0,
    crm_messages: 0,
    whatsapp_logs: 0,
    sales_orders: 0,
    wallets: 0,
    loyalty_accounts: 0,
  };

  const client = externalClient || (await pool.connect());
  const ownClient = !externalClient;
  try {
    if (ownClient) await client.query("BEGIN");

    const { rows: both } = await client.query(
      `SELECT * FROM customers WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[kId, dId]]
    );
    if (both.length !== 2) {
      if (ownClient) await client.query("ROLLBACK");
      throw Object.assign(new Error("CUSTOMER_NOT_FOUND"), { code: "CUSTOMER_NOT_FOUND" });
    }
    const keptRow = both.find((r) => Number(r.id) === kId);
    const droppedRow = both.find((r) => Number(r.id) === dId);
    const companyId = Number(keptRow.company_id);

    const snapshotKept = snapshotRow(keptRow);
    const snapshotDropped = snapshotRow(droppedRow);

    const dupDel = await client.query(
      `DELETE FROM crm_customer_identities a
       WHERE a.customer_id = $1
         AND EXISTS (
           SELECT 1 FROM crm_customer_identities b
           WHERE b.customer_id = $2 AND b.source = a.source AND b.external_id = a.external_id
         )`,
      [dId, kId]
    );
    rowsAffected.crm_identities += dupDel.rowCount || 0;

    const idMove = await client.query(
      `UPDATE crm_customer_identities
       SET customer_id = $1, is_primary = FALSE
       WHERE customer_id = $2`,
      [kId, dId]
    );
    rowsAffected.crm_identities += idMove.rowCount || 0;

    try {
      const vehIns = await client.query(
        `INSERT INTO crm_customer_vehicles (customer_id, generation_id, plate, color, notes, added_at)
         SELECT $1, v.generation_id, v.plate, v.color, v.notes, COALESCE(v.added_at, NOW())
         FROM crm_customer_vehicles v
         WHERE v.customer_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM crm_customer_vehicles x
             WHERE x.customer_id = $1
               AND x.generation_id = v.generation_id
               AND COALESCE(x.plate, '') = COALESCE(v.plate, '')
           )`,
        [kId, dId]
      );
      rowsAffected.crm_vehicles += vehIns.rowCount || 0;
      const vehDel = await client.query(`DELETE FROM crm_customer_vehicles WHERE customer_id = $1`, [dId]);
      rowsAffected.crm_vehicles += vehDel.rowCount || 0;
    } catch (e) {
      if (e && e.code !== "42P01") throw e;
    }

    const mbDup = await client.query(
      `DELETE FROM customer_ml_buyers
       WHERE customer_id = $1
         AND ml_buyer_id IN (SELECT ml_buyer_id FROM customer_ml_buyers WHERE customer_id = $2)`,
      [dId, kId]
    );
    rowsAffected.ml_buyers += mbDup.rowCount || 0;
    const mbUp = await client.query(
      `UPDATE customer_ml_buyers SET customer_id = $1 WHERE customer_id = $2`,
      [kId, dId]
    );
    rowsAffected.ml_buyers += mbUp.rowCount || 0;

    const ch = await client.query(`UPDATE crm_chats SET customer_id = $1 WHERE customer_id = $2`, [kId, dId]);
    rowsAffected.crm_chats += ch.rowCount || 0;

    const msg = await client.query(`UPDATE crm_messages SET customer_id = $1 WHERE customer_id = $2`, [kId, dId]);
    rowsAffected.crm_messages += msg.rowCount || 0;

    try {
      const wa = await client.query(
        `UPDATE crm_whatsapp_logs SET customer_id = $1 WHERE customer_id = $2`,
        [kId, dId]
      );
      rowsAffected.whatsapp_logs += wa.rowCount || 0;
    } catch (e) {
      if (e && e.code !== "42P01") throw e;
    }

    try {
      const so = await client.query(`UPDATE sales_orders SET customer_id = $1 WHERE customer_id = $2`, [kId, dId]);
      rowsAffected.sales_orders += so.rowCount || 0;
    } catch (e) {
      if (e && (e.code === "23503" || e.code === "23505")) {
        const err = new Error("SALES_REASSIGN_CONFLICT");
        err.code = "SALES_REASSIGN_CONFLICT";
        throw err;
      }
      throw e;
    }

    try {
      const wt = await client.query(
        `UPDATE wallet_transactions SET customer_id = $1 WHERE customer_id = $2`,
        [kId, dId]
      );
      rowsAffected.wallets += wt.rowCount || 0;
    } catch (e) {
      if (e && e.code !== "42P01") throw e;
    }

    try {
      await mergeLoyalty(client, dId, kId);
    } catch (e) {
      if (e && e.code !== "42P01") throw e;
    }

    try {
      await mergeWallets(client, dId, kId);
    } catch (e) {
      if (e && e.code !== "42P01") throw e;
    }

    await enrichCustomerFromDropped(client, kId, dId);

    await client.query(`DELETE FROM customers WHERE id = $1`, [dId]);

    await client.query(
      `INSERT INTO customer_merge_log (
        company_id, kept_id, dropped_id, triggered_by, score, score_breakdown,
        snapshot_kept, snapshot_dropped, rows_affected
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
      [
        companyId,
        kId,
        dId,
        triggeredBy,
        score,
        scoreBreakdown != null ? JSON.stringify(scoreBreakdown) : null,
        JSON.stringify(snapshotKept),
        JSON.stringify(snapshotDropped),
        JSON.stringify(rowsAffected),
      ]
    );

    if (ownClient) {
      if (dryRun) {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
    }

    return {
      merged: true,
      dryRun,
      keptId: kId,
      droppedId: dId,
      rowsAffected,
    };
  } catch (e) {
    if (ownClient) {
      try {
        await client.query("ROLLBACK");
      } catch (_e) {
        /* ignore */
      }
    }
    throw e;
  } finally {
    if (ownClient) client.release();
  }
}

module.exports = {
  mergeCustomers,
  calcularScore,
  normDocKey,
  normalizePhone,
};
