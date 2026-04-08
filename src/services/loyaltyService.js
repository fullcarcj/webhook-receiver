"use strict";

const { pool } = require("../../db");

function isSchemaMissing(err) {
  const c = err && err.code;
  return c === "42P01" || c === "42P04";
}

function mapErr(err) {
  if (isSchemaMissing(err)) {
    const e = new Error("loyalty_schema_missing");
    e.code = "LOYALTY_SCHEMA_MISSING";
    e.cause = err;
    return e;
  }
  return err;
}

function calcLevel(balance) {
  const vip = parseInt(process.env.LOYALTY_LEVEL_VIP || "5000", 10);
  const gold = parseInt(process.env.LOYALTY_LEVEL_GOLD || "2000", 10);
  const silver = parseInt(process.env.LOYALTY_LEVEL_SILVER || "500", 10);
  const b = Number(balance) || 0;
  if (b >= vip) return "vip";
  if (b >= gold) return "gold";
  if (b >= silver) return "silver";
  return "bronze";
}

function pointsToNextLevel(balance) {
  const levels = [
    { name: "silver", min: parseInt(process.env.LOYALTY_LEVEL_SILVER || "500", 10) },
    { name: "gold", min: parseInt(process.env.LOYALTY_LEVEL_GOLD || "2000", 10) },
    { name: "vip", min: parseInt(process.env.LOYALTY_LEVEL_VIP || "5000", 10) },
  ];
  const b = Number(balance) || 0;
  for (const L of levels) {
    if (b < L.min) {
      return { next_level: L.name, points_to_next_level: L.min - b };
    }
  }
  return { next_level: null, points_to_next_level: 0 };
}

async function ensureAccount(client, customerId) {
  const cid = Number(customerId);
  await client.query(
    `INSERT INTO loyalty_accounts (customer_id, points_balance, level)
     VALUES ($1, 0, 'bronze')
     ON CONFLICT (customer_id) DO NOTHING`,
    [cid]
  );
}

/**
 * @param {object} opts
 * @param {import("pg").PoolClient} [opts.client] — si viene, usa la misma transacción (sin BEGIN/COMMIT aquí).
 * @returns {{ idempotent: boolean, customer_id: number, points_earned: number, new_balance: number, new_level: string }}
 */
async function earnFromMlOrder({ customerId, orderId, amountUsd, source, client: extClient = null }) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_customer_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const ref = `${source || "mercadolibre"}:${String(orderId)}`;
  const rate = parseFloat(process.env.LOYALTY_POINTS_PER_USD || "10");
  const pts = Math.floor(Number(amountUsd) * rate);
  if (!Number.isFinite(pts) || pts <= 0) {
    const e = new Error("invalid_amount");
    e.code = "BAD_REQUEST";
    throw e;
  }

  async function runEarn(client) {
    await ensureAccount(client, cid);

    const accRow = await client.query(
      `SELECT points_balance, level FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`,
      [cid]
    );

    const dup = await client.query(
      `SELECT id FROM loyalty_movements WHERE customer_id = $1 AND reference_id = $2`,
      [cid, ref]
    );
    if (dup.rows.length > 0) {
      return {
        idempotent: true,
        customer_id: cid,
        points_earned: 0,
        new_balance: accRow.rows[0].points_balance,
        new_level: accRow.rows[0].level,
      };
    }

    const reason = `${source || "mercadolibre"} order #${orderId}`;
    await client.query(
      `INSERT INTO loyalty_movements (customer_id, type, points, reason, reference_id)
       VALUES ($1, 'earn', $2, $3, $4)`,
      [cid, pts, reason, ref]
    );

    const prev = accRow.rows[0].points_balance;
    const next = prev + pts;
    const lvl = calcLevel(next);
    await client.query(
      `UPDATE loyalty_accounts SET points_balance = $1, level = $2 WHERE customer_id = $3`,
      [next, lvl, cid]
    );
    return {
      idempotent: false,
      customer_id: cid,
      points_earned: pts,
      new_balance: next,
      new_level: lvl,
    };
  }

  if (extClient) {
    return runEarn(extClient);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await runEarn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw mapErr(e);
  } finally {
    client.release();
  }
}

/** Alias para purchaseService / prompts. */
const earnPoints = earnFromMlOrder;

/**
 * Ajuste de puntos dentro de una transacción externa (p. ej. reembolso en salesService).
 * @param {import("pg").PoolClient} client
 */
async function adjustPointsWithClient(client, customerId, pointsDelta, reason) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_customer_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const delta = Number(pointsDelta);
  if (!Number.isFinite(delta) || delta === 0) {
    const e = new Error("invalid_points");
    e.code = "BAD_REQUEST";
    throw e;
  }
  await ensureAccount(client, cid);
  const accRow = await client.query(
    `SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`,
    [cid]
  );
  const prev = accRow.rows[0].points_balance;
  const next = prev + delta;
  if (next < 0) {
    const e = new Error("INSUFFICIENT_POINTS");
    e.code = "INSUFFICIENT_POINTS";
    throw e;
  }
  const lvl = calcLevel(next);
  await client.query(
    `INSERT INTO loyalty_movements (customer_id, type, points, reason, reference_id)
     VALUES ($1, 'adjust', $2, $3, NULL)`,
    [cid, delta, reason]
  );
  await client.query(
    `UPDATE loyalty_accounts SET points_balance = $1, level = $2 WHERE customer_id = $3`,
    [next, lvl, cid]
  );
}

async function adjustPoints(customerId, pointsDelta, reason) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_customer_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const delta = Number(pointsDelta);
  if (!Number.isFinite(delta) || delta === 0) {
    const e = new Error("invalid_points");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await adjustPointsWithClient(client, cid, delta, reason);
    await client.query("COMMIT");
    return getLoyaltySummary(cid);
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw mapErr(e);
  } finally {
    client.release();
  }
}

async function getLoyaltySummary(customerId) {
  const cid = Number(customerId);
  await pool.query(
    `INSERT INTO loyalty_accounts (customer_id, points_balance, level)
     VALUES ($1, 0, 'bronze')
     ON CONFLICT (customer_id) DO NOTHING`,
    [cid]
  );

  const { rows: accRows } = await pool.query(
    `SELECT customer_id, points_balance, level FROM loyalty_accounts WHERE customer_id = $1`,
    [cid]
  );
  const acc = accRows[0];
  if (!acc) {
    return null;
  }
  const { rows: movRows } = await pool.query(
    `SELECT id, type, points, reason, created_at
     FROM loyalty_movements
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [cid]
  );

  const pb = acc.points_balance;
  const { next_level, points_to_next_level } = pointsToNextLevel(pb);
  const lvl = acc.level;

  return {
    customer_id: cid,
    points_balance: pb,
    level: lvl,
    points_to_next_level,
    next_level,
    movements: movRows.map((m) => ({
      id: m.id,
      type: m.type,
      points: m.points,
      reason: m.reason,
      created_at: m.created_at,
    })),
  };
}

module.exports = {
  calcLevel,
  pointsToNextLevel,
  earnFromMlOrder,
  earnPoints,
  adjustPointsWithClient,
  adjustPoints,
  getLoyaltySummary,
  mapErr,
};
