"use strict";

const { pool } = require("../../db");
const loyaltyService = require("./loyaltyService");

/**
 * Registra venta mostrador + puntos en una sola transacción.
 */
async function registerMostradorPurchase({ customerId, items, notes, soldBy }) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_customer_id");
    e.code = "BAD_REQUEST";
    throw e;
  }

  let total = 0;
  for (const it of items) {
    total += Number(it.quantity) * Number(it.unit_price_usd);
  }
  if (!Number.isFinite(total) || total <= 0) {
    const e = new Error("invalid_total");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ex = await client.query(`SELECT 1 FROM customers WHERE id = $1`, [cid]);
    if (!ex.rows.length) {
      await client.query("ROLLBACK");
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      throw e;
    }

    const itemsJson = JSON.stringify(items);
    const ins = await client.query(
      `INSERT INTO crm_mostrador_orders (customer_id, total_amount_usd, items_json, notes, sold_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, created_at`,
      [cid, total.toFixed(2), itemsJson, notes ?? null, soldBy ?? null]
    );
    const orderRowId = ins.rows[0].id;

    const earn = await loyaltyService.earnFromMlOrder({
      customerId: cid,
      orderId: `MOST-${orderRowId}`,
      amountUsd: total,
      source: "mostrador",
      client,
    });

    await client.query("COMMIT");

    const summary = await loyaltyService.getLoyaltySummary(cid);
    return {
      order_id: orderRowId,
      customer_id: cid,
      total_amount_usd: Number(total.toFixed(2)),
      points_earned: earn.points_earned,
      new_loyalty_balance: summary.points_balance,
      new_level: summary.level,
      items,
      loyalty_idempotent: earn.idempotent === true,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { registerMostradorPurchase };
