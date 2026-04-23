"use strict";

/**
 * Resolución de orden ML vinculada al chat (misma lógica que GET /api/inbox/:chatId/ml-order):
 * 1) crm_chats.ml_order_id
 * 2) teléfono mlm:{ml_user_id}:{order_id}
 * 3) sales_orders.external_order_id por conversation_id
 */

async function resolveLinkedMlOrderId(pool, chatId) {
  const { rows: chatRows } = await pool.query(
    `SELECT ml_order_id, phone FROM crm_chats WHERE id = $1`,
    [chatId]
  );
  if (!chatRows.length) return null;
  let mlOrderId = chatRows[0].ml_order_id;
  if (mlOrderId == null && chatRows[0].phone) {
    const m = String(chatRows[0].phone).match(/^mlm:\d+:(\d+)$/);
    if (m) mlOrderId = m[1];
  }
  if (mlOrderId == null) {
    const { rows: soRows } = await pool.query(
      `SELECT external_order_id::text AS eid
         FROM sales_orders
        WHERE conversation_id = $1 AND external_order_id IS NOT NULL
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1`,
      [chatId]
    );
    if (soRows.length && soRows[0].eid) mlOrderId = soRows[0].eid;
  }
  if (mlOrderId == null) return null;
  const s = String(mlOrderId).trim();
  return s || null;
}

/**
 * Total en Bs. de referencia para conciliación (sin cotización ERP).
 * Orden: ml_orders (VES/USD×tasa) → sales_orders.total_amount_bs → order_total_amount×tasa snapshot o activeRate.
 *
 * @param {import('pg').Pool} pool
 * @param {number} chatId
 * @param {number} activeRate tasa del día (Bs/USD), p.ej. daily_exchange_rates.active_rate
 * @returns {Promise<{ referenceBs: number, meta: object } | { referenceBs: NaN, meta: null, ml_order_id: string|null }>}
 */
async function resolveMlOrderReferenceBs(pool, chatId, activeRate) {
  const oid = await resolveLinkedMlOrderId(pool, chatId);
  if (!oid) return { referenceBs: NaN, meta: null, ml_order_id: null };

  const { rows: moR } = await pool.query(
    `SELECT total_amount::numeric AS total_amount, currency_id::text AS currency_id
       FROM ml_orders WHERE order_id::text = $1 LIMIT 1`,
    [oid]
  );
  if (moR.length) {
    const mo = moR[0];
    const cur = String(mo.currency_id || "").toUpperCase();
    const ta = mo.total_amount != null ? Number(mo.total_amount) : NaN;
    if (Number.isFinite(ta)) {
      if (cur === "VES" || cur === "VEF") {
        return {
          referenceBs: ta,
          meta: {
            type: "ml_order",
            ml_order_id: oid,
            currency_id: cur,
            source: "ml_orders",
          },
          ml_order_id: oid,
        };
      }
      if ((cur === "USD" || cur === "US$") && Number.isFinite(activeRate) && activeRate > 0) {
        return {
          referenceBs: ta * activeRate,
          meta: {
            type: "ml_order",
            ml_order_id: oid,
            currency_id: cur,
            source: "ml_orders",
          },
          ml_order_id: oid,
        };
      }
    }
  }

  let soRows;
  try {
    const r = await pool.query(
      `SELECT total_amount_bs::numeric AS total_amount_bs,
              order_total_amount::numeric AS order_total_amount,
              exchange_rate_bs_per_usd::numeric AS rate
         FROM sales_orders
        WHERE conversation_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1`,
      [chatId]
    );
    soRows = r.rows;
  } catch {
    soRows = [];
  }
  const so = soRows[0];
  if (so) {
    const tbs = so.total_amount_bs != null ? Number(so.total_amount_bs) : NaN;
    if (Number.isFinite(tbs) && tbs > 0) {
      return {
        referenceBs: tbs,
        meta: {
          type: "ml_order",
          ml_order_id: oid,
          source: "sales_orders_total_bs",
        },
        ml_order_id: oid,
      };
    }
    const ousd = so.order_total_amount != null ? Number(so.order_total_amount) : NaN;
    const snap = so.rate != null ? Number(so.rate) : NaN;
    const rUsd = Number.isFinite(snap) && snap > 0 ? snap : activeRate;
    if (Number.isFinite(ousd) && Number.isFinite(rUsd) && rUsd > 0) {
      return {
        referenceBs: ousd * rUsd,
        meta: {
          type: "ml_order",
          ml_order_id: oid,
          source: "sales_orders_usd_times_rate",
        },
        ml_order_id: oid,
      };
    }
  }

  return { referenceBs: NaN, meta: null, ml_order_id: oid };
}

module.exports = {
  resolveLinkedMlOrderId,
  resolveMlOrderReferenceBs,
};
