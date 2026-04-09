"use strict";

const crypto = require("crypto");
const { pool } = require("../../db");
const loyaltyService = require("./loyaltyService");
const { getTodayRate } = require("./currencyService");
const { CustomerModel } = require("./crmIdentityService");
const { customersHasPhone2Column } = require("../utils/customersPhone2");
const { salesOrdersHasLifecycleColumns } = require("../utils/salesOrdersLifecycle");

const MANUAL_SOURCES = new Set(["mostrador", "social_media"]);

function isSchemaMissing(err) {
  const c = err && err.code;
  return c === "42P01" || c === "42P04";
}

function mapErr(err) {
  if (isSchemaMissing(err)) {
    const e = new Error("sales_schema_missing");
    e.code = "SALES_SCHEMA_MISSING";
    e.cause = err;
    return e;
  }
  return err;
}

/** Punto 8 / kits: `atributos.kit_components` = [{ sku, qty_per_unit }] por unidad vendida del kit. */
function parseKitComponents(atributos) {
  if (!atributos || typeof atributos !== "object") return null;
  const raw = atributos.kit_components;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const sku = String(x.sku || "").trim();
    if (!sku) continue;
    const q = Number(x.qty_per_unit != null ? x.qty_per_unit : x.qty);
    out.push({ sku, qty_per_unit: Number.isFinite(q) && q > 0 ? q : 1 });
  }
  return out.length ? out : null;
}

function mapSourceToCrmIdentitySource(source) {
  const s = String(source || "").toLowerCase();
  if (s === "mercadolibre") return "mercadolibre";
  if (s === "mostrador") return "mostrador";
  if (s === "ecommerce") return "ecommerce";
  if (s === "social_media") return "social_media";
  return "mostrador";
}

async function resolveSaleLinesAndStock(client, items) {
  const linesForInsert = [];
  const stockDecrements = [];
  for (const it of items) {
    const sku = String(it.sku || "").trim();
    if (!sku) {
      const e = new Error("sku requerido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const qty = Number(it.quantity);
    const unit = Number(it.unit_price_usd);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unit) || unit <= 0) {
      const e = new Error("cantidad o precio inválido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    const pr = await client.query(
      `SELECT id, sku, stock, atributos FROM productos WHERE sku = $1 FOR UPDATE`,
      [sku]
    );
    if (!pr.rows.length) {
      const e = new Error(`SKU no encontrado: ${sku}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    const row = pr.rows[0];
    const lineTotal = Number((qty * unit).toFixed(2));
    linesForInsert.push({
      product_id: row.id,
      sku: row.sku,
      quantity: qty,
      unit_price_usd: unit,
      line_total_usd: lineTotal,
    });

    const kit = parseKitComponents(row.atributos);
    if (kit && kit.length) {
      for (const comp of kit) {
        const cr = await client.query(`SELECT id, sku, stock FROM productos WHERE sku = $1 FOR UPDATE`, [
          comp.sku,
        ]);
        if (!cr.rows.length) {
          const e = new Error(`Kit ${sku}: componente no encontrado (${comp.sku})`);
          e.code = "NOT_FOUND";
          throw e;
        }
        const need = qty * comp.qty_per_unit;
        if (Number(cr.rows[0].stock) < need) {
          const e = new Error(
            `Stock insuficiente para componente ${comp.sku} del kit ${sku} (disponible ${cr.rows[0].stock}, necesario ${need})`
          );
          e.code = "INSUFFICIENT_STOCK";
          throw e;
        }
        stockDecrements.push({ product_id: cr.rows[0].id, sku: cr.rows[0].sku, quantity: need });
      }
    } else {
      if (Number(row.stock) < qty) {
        const e = new Error(`Stock insuficiente para ${sku} (disponible ${row.stock}, pedido ${qty})`);
        e.code = "INSUFFICIENT_STOCK";
        throw e;
      }
      stockDecrements.push({ product_id: row.id, sku: row.sku, quantity: qty });
    }
  }
  return { linesForInsert, stockDecrements };
}

function sumLineTotals(linesForInsert) {
  let t = 0;
  for (const it of linesForInsert) t += it.line_total_usd;
  return Number(t.toFixed(2));
}

async function decrementStock(client, resolvedItems) {
  for (const it of resolvedItems) {
    if (it.product_id == null) continue;
    const u = await client.query(
      `UPDATE productos SET stock = stock - $2, updated_at = NOW()
       WHERE id = $1 AND stock >= $2 RETURNING stock`,
      [it.product_id, it.quantity]
    );
    if (!u.rows.length) {
      const e = new Error(`Stock insuficiente al reservar SKU ${it.sku}`);
      e.code = "INSUFFICIENT_STOCK";
      throw e;
    }
  }
}

async function incrementStock(client, resolvedItems) {
  for (const it of resolvedItems) {
    if (it.product_id == null) continue;
    await client.query(`UPDATE productos SET stock = stock + $2, updated_at = NOW() WHERE id = $1`, [
      it.product_id,
      it.quantity,
    ]);
  }
}

/** Repone stock al anular venta; respeta kits (mismas reglas que al vender). */
async function incrementStockFromOrderLines(client, orderLines) {
  for (const it of orderLines) {
    if (it.product_id == null) continue;
    const pr = await client.query(`SELECT id, sku, atributos FROM productos WHERE id = $1 FOR UPDATE`, [
      it.product_id,
    ]);
    if (!pr.rows.length) continue;
    const kit = parseKitComponents(pr.rows[0].atributos);
    if (kit && kit.length) {
      for (const comp of kit) {
        const cr = await client.query(`SELECT id FROM productos WHERE sku = $1 FOR UPDATE`, [comp.sku]);
        if (!cr.rows.length) continue;
        const add = it.quantity * comp.qty_per_unit;
        await client.query(`UPDATE productos SET stock = stock + $2, updated_at = NOW() WHERE id = $1`, [
          cr.rows[0].id,
          add,
        ]);
      }
    } else {
      await client.query(`UPDATE productos SET stock = stock + $2, updated_at = NOW() WHERE id = $1`, [
        it.product_id,
        it.quantity,
      ]);
    }
  }
}

async function insertItems(client, salesOrderId, resolvedItems) {
  for (const it of resolvedItems) {
    await client.query(
      `INSERT INTO sales_order_items (sales_order_id, product_id, sku, quantity, unit_price_usd, line_total_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        salesOrderId,
        it.product_id,
        it.sku,
        it.quantity,
        it.unit_price_usd,
        it.line_total_usd,
      ]
    );
  }
}

async function fetchOrderItems(client, salesOrderId) {
  const { rows } = await client.query(
    `SELECT product_id, sku, quantity, unit_price_usd, line_total_usd
     FROM sales_order_items WHERE sales_order_id = $1 ORDER BY id`,
    [salesOrderId]
  );
  return rows.map((r) => ({
    product_id: r.product_id,
    sku: r.sku,
    quantity: r.quantity,
    unit_price_usd: Number(r.unit_price_usd),
    line_total_usd: Number(r.line_total_usd),
  }));
}

/**
 * Venta omnicanal (transacción): orden + ítems + stock (kits vía atributos) + caja + fidelidad opcional.
 * @param {object} p
 * @param {'mostrador'|'social_media'} p.source
 * @param {number|undefined|null} [p.customerId] — omitir = consumidor final (sin puntos)
 * @param {Array<{sku:string,quantity:number,unit_price_usd:number}>} p.items
 * @param {string} [p.notes]
 * @param {string} [p.soldBy]
 * @param {'pending'|'paid'} [p.status]
 * @param {string} [p.externalOrderId]
 * @param {'cash'|'card'|'transfer'|'mercadopago'|'pago_movil'|'other'|'unknown'} [p.paymentMethod]
 * @param {string} [p.identityExternalId] — clave en crm_customer_identities (default: external_order_id)
 * @param {number} [p.companyId] — tasas Bs (currency)
 */
async function createOrder({
  source,
  customerId,
  items,
  notes,
  soldBy,
  status,
  externalOrderId,
  paymentMethod,
  identityExternalId,
  companyId,
}) {
  if (!MANUAL_SOURCES.has(source)) {
    const e = new Error("source no permitido para creación manual");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const st =
    status === "pending" || status === "pending_payment" ? "pending" : "paid";
  let cid = null;
  if (customerId != null && customerId !== "") {
    const n = Number(customerId);
    if (!Number.isFinite(n) || n <= 0) {
      const e = new Error("customer_id inválido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    cid = n;
  }

  const extId =
    externalOrderId != null && String(externalOrderId).trim() !== ""
      ? String(externalOrderId).trim().slice(0, 200)
      : `local-${crypto.randomUUID()}`;

  const pay =
    paymentMethod != null && String(paymentMethod).trim() !== ""
      ? String(paymentMethod).trim()
      : st === "paid"
        ? "unknown"
        : null;

  const compId = Number(companyId || process.env.SALES_CURRENCY_COMPANY_ID || "1") || 1;
  let rate = null;
  let totalBs = null;
  try {
    const rateRow = await getTodayRate(compId);
    rate = rateRow && rateRow.active_rate != null ? Number(rateRow.active_rate) : null;
  } catch (_e) {
    rate = null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dup = await client.query(
      `SELECT id FROM sales_orders WHERE source = $1 AND external_order_id = $2`,
      [source, extId]
    );
    if (dup.rows.length) {
      await client.query("ROLLBACK");
      const existing = await getSalesOrderById(dup.rows[0].id);
      return { ...existing, idempotent: true };
    }

    if (cid != null) {
      const cex = await client.query(`SELECT 1 FROM customers WHERE id = $1`, [cid]);
      if (!cex.rows.length) {
        await client.query("ROLLBACK");
        const e = new Error("NOT_FOUND");
        e.code = "NOT_FOUND";
        throw e;
      }
    }

    const { linesForInsert, stockDecrements } = await resolveSaleLinesAndStock(client, items);
    const totalAmountUsd = sumLineTotals(linesForInsert);
    if (rate != null && Number.isFinite(rate) && rate > 0) {
      totalBs = Number((totalAmountUsd * rate).toFixed(2));
    }

    const ins = await client.query(
      `INSERT INTO sales_orders (
         source, external_order_id, customer_id, status,
         order_total_amount, total_amount_bs, exchange_rate_bs_per_usd, payment_method,
         notes, sold_by, applies_stock, records_cash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, TRUE)
       RETURNING id, created_at`,
      [
        source,
        extId,
        cid,
        st,
        totalAmountUsd.toFixed(2),
        totalBs != null ? totalBs.toFixed(2) : null,
        rate != null && Number.isFinite(rate) ? rate : null,
        pay,
        notes ?? null,
        soldBy ?? null,
      ]
    );
    const orderId = ins.rows[0].id;

    await insertItems(client, orderId, linesForInsert);
    await decrementStock(client, stockDecrements);

    let pointsEarned = 0;
    if (st === "paid") {
      if (cid != null) {
        const earn = await loyaltyService.earnFromMlOrder({
          customerId: cid,
          orderId: `SALES-${orderId}`,
          amountUsd: totalAmountUsd,
          source,
          client,
        });
        pointsEarned = earn.points_earned || 0;
      }
      await client.query(
        `UPDATE sales_orders SET loyalty_points_earned = $1, updated_at = NOW() WHERE id = $2`,
        [pointsEarned, orderId]
      );
      await client.query(
        `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type) VALUES ($1, $2, 'sale')`,
        [orderId, totalAmountUsd.toFixed(2)]
      );
    }

    await client.query("COMMIT");

    if (cid != null) {
      const extForCrm = identityExternalId != null && String(identityExternalId).trim() !== "" ? String(identityExternalId).trim() : extId;
      try {
        await CustomerModel.link({
          customerId: cid,
          source: mapSourceToCrmIdentitySource(source),
          externalId: extForCrm,
          isPrimary: false,
          metadata: { sales_order_id: orderId, source },
        });
      } catch (_crm) {
        /* CRM opcional si enum/migración no alineados */
      }
    }

    const out = await getSalesOrderById(orderId);
    return { ...out, idempotent: false };
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

/** @deprecated usar createOrder */
const createSalesOrder = createOrder;

async function getSalesOrderById(id) {
  const oid = Number(id);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const hasLifecycle = await salesOrdersHasLifecycleColumns(pool);
    const lifecycleCols = hasLifecycle
      ? `,
              lifecycle_status, ml_status, motivo_anulacion, tipo_calificacion_ml,
              aprobado_por_user_id, es_pago_auto_banesco, metodo_despacho, calificacion_ml,
              rating_deadline_at, is_rating_alert`
      : "";
    const { rows: orows } = await pool.query(
      `SELECT id, source, external_order_id, customer_id, status,
              order_total_amount,
              total_amount_bs, exchange_rate_bs_per_usd, payment_method,
              loyalty_points_earned,
              notes, sold_by, created_at, updated_at,
              COALESCE(applies_stock, TRUE) AS applies_stock,
              COALESCE(records_cash, TRUE) AS records_cash,
              ml_user_id
              ${lifecycleCols}
       FROM sales_orders WHERE id = $1`,
      [oid]
    );
    if (!orows.length) {
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      throw e;
    }
    const o = orows[0];
    const { rows: irows } = await pool.query(
      `SELECT id, product_id, sku, quantity, unit_price_usd, line_total_usd
       FROM sales_order_items WHERE sales_order_id = $1 ORDER BY id`,
      [oid]
    );
    const tot = Number(o.order_total_amount);
    return {
      id: o.id,
      source: o.source,
      external_order_id: o.external_order_id,
      customer_id: o.customer_id,
      status: o.status,
      order_total_amount: tot,
      total_amount_usd: tot,
      total_usd: tot,
      total_amount_bs: o.total_amount_bs != null ? Number(o.total_amount_bs) : null,
      exchange_rate_bs_per_usd:
        o.exchange_rate_bs_per_usd != null ? Number(o.exchange_rate_bs_per_usd) : null,
      payment_method: o.payment_method,
      loyalty_points_earned: o.loyalty_points_earned,
      notes: o.notes,
      sold_by: o.sold_by,
      applies_stock: o.applies_stock,
      records_cash: o.records_cash,
      ml_user_id: o.ml_user_id,
      lifecycle_status: hasLifecycle ? o.lifecycle_status : null,
      ml_status: hasLifecycle ? o.ml_status : null,
      motivo_anulacion: hasLifecycle ? o.motivo_anulacion : null,
      tipo_calificacion_ml: hasLifecycle ? o.tipo_calificacion_ml : null,
      aprobado_por_user_id: hasLifecycle ? o.aprobado_por_user_id : null,
      es_pago_auto_banesco: hasLifecycle ? o.es_pago_auto_banesco : null,
      metodo_despacho: hasLifecycle ? o.metodo_despacho : null,
      calificacion_ml: hasLifecycle ? o.calificacion_ml : null,
      rating_deadline_at: hasLifecycle ? o.rating_deadline_at : null,
      is_rating_alert: hasLifecycle ? o.is_rating_alert : null,
      created_at: o.created_at,
      updated_at: o.updated_at,
      items: irows.map((r) => {
        const sub = Number(r.line_total_usd);
        return {
          id: r.id,
          product_id: r.product_id,
          sku: r.sku,
          quantity: r.quantity,
          unit_price_usd: Number(r.unit_price_usd),
          line_total_usd: sub,
          subtotal_usd: sub,
        };
      }),
    };
  } catch (e) {
    throw mapErr(e);
  }
}

async function listSalesOrders({
  limit = 50,
  offset = 0,
  source,
  status,
  from,
  to,
  /** Sin `status` explícito: oculta ventas ML ya cerradas por feedback (`completed`). `include_completed=1` en API. */
  excludeCompleted = true,
}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const cond = [];
  const params = [];
  let n = 1;
  const explicitStatus = status != null && String(status).trim() !== "";
  if (excludeCompleted && !explicitStatus) {
    cond.push(`status <> $${n++}`);
    params.push("completed");
  }
  if (source) {
    cond.push(`source = $${n++}`);
    params.push(source);
  }
  if (explicitStatus) {
    cond.push(`status = $${n++}`);
    params.push(status);
  }
  if (from) {
    cond.push(`created_at >= $${n++}`);
    params.push(from);
  }
  if (to) {
    cond.push(`created_at <= $${n++}`);
    params.push(to);
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  params.push(lim, off);
  try {
    const { rows } = await pool.query(
      `SELECT id, source, external_order_id, customer_id, status, order_total_amount, loyalty_points_earned,
              notes, sold_by, created_at
       FROM sales_orders ${where}
       ORDER BY created_at DESC
       LIMIT $${n++} OFFSET $${n}`,
      params
    );
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::bigint AS c FROM sales_orders ${where}`, params.slice(0, -2));
    return {
      rows: rows.map((o) => {
        const tot = Number(o.order_total_amount);
        return {
        id: o.id,
        source: o.source,
        external_order_id: o.external_order_id,
        customer_id: o.customer_id,
        status: o.status,
        order_total_amount: tot,
        total_amount_usd: tot,
        total_usd: tot,
        loyalty_points_earned: o.loyalty_points_earned,
        notes: o.notes,
        sold_by: o.sold_by,
        created_at: o.created_at,
      };
      }),
      total: Number(countRows[0].c),
      limit: lim,
      offset: off,
    };
  } catch (e) {
    throw mapErr(e);
  }
}

async function getSalesStats({ from, to }) {
  const cond = [];
  const params = [];
  let n = 1;
  if (from) {
    cond.push(`created_at >= $${n++}`);
    params.push(from);
  }
  if (to) {
    cond.push(`created_at <= $${n++}`);
    params.push(to);
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  try {
    const { rows } = await pool.query(
      `SELECT source,
              COUNT(*)::bigint AS order_count,
              COALESCE(SUM(order_total_amount), 0)::numeric AS order_total_sum,
              COALESCE(SUM(total_amount_bs), 0)::numeric AS total_amount_bs
       FROM sales_orders
       ${where}
       GROUP BY source
       ORDER BY source`,
      params
    );
    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(order_total_amount), 0)::numeric AS order_total_sum,
              COALESCE(SUM(total_amount_bs), 0)::numeric AS total_amount_bs,
              COUNT(*)::bigint AS order_count
       FROM sales_orders ${where}`,
      params
    );
    return {
      by_source: rows.map((r) => {
        const s = Number(r.order_total_sum);
        return {
        source: r.source,
        order_count: Number(r.order_count),
        order_total_amount: s,
        total_amount_usd: s,
        total_usd: s,
        total_amount_bs: r.total_amount_bs != null ? Number(r.total_amount_bs) : null,
      };
      }),
      total_orders: Number(sumRows[0].order_count),
      order_total_amount: Number(sumRows[0].order_total_sum),
      total_amount_usd: Number(sumRows[0].order_total_sum),
      total_usd: Number(sumRows[0].order_total_sum),
      total_amount_bs: sumRows[0].total_amount_bs != null ? Number(sumRows[0].total_amount_bs) : null,
    };
  } catch (e) {
    throw mapErr(e);
  }
}

/**
 * @param {number} orderId
 * @param {'paid'|'cancelled'|'shipped'} newStatus
 */
async function patchSalesOrderStatus(orderId, newStatus) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: orows } = await client.query(
      `SELECT id, source, customer_id, status, order_total_amount, loyalty_points_earned,
              COALESCE(applies_stock, TRUE) AS applies_stock,
              COALESCE(records_cash, TRUE) AS records_cash
       FROM sales_orders WHERE id = $1 FOR UPDATE`,
      [oid]
    );
    if (!orows.length) {
      await client.query("ROLLBACK");
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      throw e;
    }
    const order = orows[0];
    const cur = order.status;
    const appliesStock = order.applies_stock !== false;
    const recordsCash = order.records_cash !== false;
    const items = await fetchOrderItems(client, oid);
    const totalAmt = Number(order.order_total_amount);

    if (newStatus === "paid") {
      if (cur !== "pending") {
        await client.query("ROLLBACK");
        const e = new Error("transición inválida");
        e.code = "INVALID_TRANSITION";
        throw e;
      }
      if (order.customer_id == null) {
        await client.query("ROLLBACK");
        const e = new Error("customer_id requerido para marcar pagada");
        e.code = "BAD_REQUEST";
        throw e;
      }
      const cid = Number(order.customer_id);
      const earn = await loyaltyService.earnFromMlOrder({
        customerId: cid,
        orderId: `SALES-${oid}`,
        amountUsd: totalAmt,
        source: order.source,
        client,
      });
      const pts = earn.points_earned || 0;
      await client.query(
        `UPDATE sales_orders SET status = 'paid', loyalty_points_earned = $1, updated_at = NOW() WHERE id = $2`,
        [pts, oid]
      );
      if (recordsCash) {
        await client.query(
          `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type) VALUES ($1, $2, 'sale')`,
          [oid, totalAmt.toFixed(2)]
        );
      }
    } else if (newStatus === "shipped") {
      if (cur !== "paid") {
        await client.query("ROLLBACK");
        const e = new Error("transición inválida");
        e.code = "INVALID_TRANSITION";
        throw e;
      }
      await client.query(`UPDATE sales_orders SET status = 'shipped', updated_at = NOW() WHERE id = $1`, [oid]);
    } else if (newStatus === "cancelled") {
      if (cur === "pending") {
        if (appliesStock) {
          await incrementStockFromOrderLines(client, items);
        }
        await client.query(`UPDATE sales_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [oid]);
      } else if (cur === "paid" || cur === "shipped") {
        const pts = Number(order.loyalty_points_earned) || 0;
        if (appliesStock) {
          await incrementStockFromOrderLines(client, items);
        }
        if (recordsCash) {
          await client.query(
            `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type) VALUES ($1, $2, 'refund')`,
            [oid, (-totalAmt).toFixed(2)]
          );
        }
        if (pts > 0) {
          if (order.customer_id == null) {
            await client.query("ROLLBACK");
            const e = new Error("customer_id requerido para revertir puntos");
            e.code = "BAD_REQUEST";
            throw e;
          }
          const cid = Number(order.customer_id);
          await loyaltyService.adjustPointsWithClient(
            client,
            cid,
            -pts,
            `Anulación venta omnicanal #${oid}`
          );
        }
        await client.query(
          `UPDATE sales_orders SET status = 'cancelled', loyalty_points_earned = 0, updated_at = NOW() WHERE id = $1`,
          [oid]
        );
      } else {
        await client.query("ROLLBACK");
        const e = new Error("transición inválida");
        e.code = "INVALID_TRANSITION";
        throw e;
      }
    } else {
      await client.query("ROLLBACK");
      const e = new Error("estado no soportado");
      e.code = "BAD_REQUEST";
      throw e;
    }

    await client.query("COMMIT");
    return getSalesOrderById(oid);
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

async function resolveCustomerIdFromMlBuyer(client, buyerId) {
  const bid = Number(buyerId);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  const r1 = await client.query(`SELECT id FROM customers WHERE primary_ml_buyer_id = $1 LIMIT 1`, [bid]);
  if (r1.rows.length) return Number(r1.rows[0].id);
  try {
    const r2 = await client.query(
      `SELECT customer_id FROM customer_ml_buyers WHERE ml_buyer_id = $1 LIMIT 1`,
      [bid]
    );
    if (r2.rows.length) return Number(r2.rows[0].customer_id);
  } catch (e) {
    if (e && e.code !== "42P01") throw e;
  }
  return null;
}

function normMlBuyerPhone(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Crea o actualiza `customers` como tabla maestra: vincula `buyer_id` ML (`primary_ml_buyer_id` + `customer_ml_buyers`)
 * y copia `phone_1`/`phone_2` desde `ml_buyers` → `phone`/`phone_2` (si existe columna; si no, el 2º va en `notes`).
 * Requiere fila en `ml_buyers`. Opcional: migración `phone_2` en `customers` (npm run db:customers-phone2).
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number|null>} customer id o null si no hay buyer en ml_buyers
 */
async function ensureCustomerAndLinkMlBuyer(client, buyerId) {
  const bid = Number(buyerId);
  if (!Number.isFinite(bid) || bid <= 0) return null;

  const { rows: br } = await client.query(
    `SELECT phone_1, phone_2, nombre_apellido, nickname FROM ml_buyers WHERE buyer_id = $1`,
    [bid]
  );
  if (!br.length) return null;
  const b = br[0];
  const p1 = normMlBuyerPhone(b.phone_1);
  const p2 = normMlBuyerPhone(b.phone_2);
  const nameFromMl =
    (b.nombre_apellido && String(b.nombre_apellido).trim()) ||
    (b.nickname && String(b.nickname).trim()) ||
    `Comprador ML ${bid}`;

  const hasPhone2Col = await customersHasPhone2Column(client);
  const notesBase = `Auto ML buyer_id=${bid}`;
  const notesWithAlt = p2 && !hasPhone2Col ? `${notesBase} | tel2 ML: ${p2}` : notesBase;

  let cid = await resolveCustomerIdFromMlBuyer(client, bid);
  if (cid != null) {
    if (hasPhone2Col) {
      await client.query(
        `UPDATE customers SET
           phone = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE phone END,
           phone_2 = CASE WHEN $3::text IS NOT NULL THEN $3::text ELSE phone_2 END,
           full_name = CASE
             WHEN COALESCE(TRIM(full_name), '') = '' THEN $4::text
             ELSE full_name
           END,
           primary_ml_buyer_id = COALESCE(primary_ml_buyer_id, $5::bigint),
           updated_at = NOW()
         WHERE id = $1`,
        [cid, p1, p2, nameFromMl, bid]
      );
    } else {
      await client.query(
        `UPDATE customers SET
           phone = CASE WHEN $2::text IS NOT NULL THEN $2::text ELSE phone END,
           full_name = CASE
             WHEN COALESCE(TRIM(full_name), '') = '' THEN $3::text
             ELSE full_name
           END,
           primary_ml_buyer_id = COALESCE(primary_ml_buyer_id, $4::bigint),
           updated_at = NOW()
         WHERE id = $1`,
        [cid, p1, nameFromMl, bid]
      );
    }
    await client.query(
      `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
      [cid, bid]
    );
    return cid;
  }

  let ins;
  if (hasPhone2Col) {
    ins = await client.query(
      `INSERT INTO customers (company_id, full_name, primary_ml_buyer_id, phone, phone_2, notes)
       VALUES (1, $1, $2, $3, $4, $5)
       RETURNING id`,
      [nameFromMl, bid, p1, p2, notesBase]
    );
  } else {
    ins = await client.query(
      `INSERT INTO customers (company_id, full_name, primary_ml_buyer_id, phone, notes)
       VALUES (1, $1, $2, $3, $4)
       RETURNING id`,
      [nameFromMl, bid, p1, notesWithAlt]
    );
  }
  cid = Number(ins.rows[0].id);
  await client.query(
    `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
    [cid, bid]
  );
  return cid;
}

function mlStatusToSalesStatus(mlStatus) {
  const s = String(mlStatus || "")
    .toLowerCase()
    .trim();
  if (s === "cancelled" || s === "invalid") return "cancelled";
  if (s === "paid") return "paid";
  if (s === "refunded" || s === "partially_refunded") return "cancelled";
  return "pending";
}

/** Alineado con backfill en `sql/20260411_orders_lifecycle.sql`. */
function lifecycleStatusFromSalesStatus(st) {
  const s = String(st || "")
    .toLowerCase()
    .trim();
  if (s === "paid") return "pagada";
  if (s === "cancelled") return "anulada";
  return "pendiente";
}

/**
 * Copia una fila de `ml_orders` a `sales_orders` (sin tocar stock ni caja).
 * Activa con `SALES_ML_IMPORT_ENABLED=1`. Puntos opcionales: `SALES_ML_IMPORT_LOYALTY=1` (idempotente con /api/crm/loyalty/earn).
 *
 * @param {{ mlUserId: number, orderId: number }} p
 */
async function importSalesOrderFromMlOrder({ mlUserId, orderId }) {
  if (process.env.SALES_ML_IMPORT_ENABLED !== "1") {
    const e = new Error("Import ML desactivado (SALES_ML_IMPORT_ENABLED=1)");
    e.code = "IMPORT_DISABLED";
    throw e;
  }
  const mUid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(mUid) || mUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    const e = new Error("ml_user_id u order_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const extId = `${mUid}-${oid}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: mrows } = await client.query(
      `SELECT ml_user_id, order_id, status, total_amount, buyer_id FROM ml_orders WHERE ml_user_id = $1 AND order_id = $2`,
      [mUid, oid]
    );
    if (!mrows.length) {
      await client.query("ROLLBACK");
      const e = new Error("Orden ML no encontrada en ml_orders");
      e.code = "NOT_FOUND";
      throw e;
    }
    const ml = mrows[0];
    const customerId = await ensureCustomerAndLinkMlBuyer(client, ml.buyer_id);

    const dup = await client.query(
      `SELECT id FROM sales_orders WHERE source = 'mercadolibre' AND external_order_id = $1`,
      [extId]
    );
    if (dup.rows.length) {
      await client.query("COMMIT");
      const existing = await getSalesOrderById(dup.rows[0].id);
      return { ...existing, idempotent: true, import: "ml" };
    }
    let totalUsd = Number(ml.total_amount);
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      totalUsd = 0.01;
    }
    const st = mlStatusToSalesStatus(ml.status);
    const lifecycle = lifecycleStatusFromSalesStatus(st);
    const mlStatusRaw = String(ml.status || "").trim() || null;
    const ratingDays = Math.max(1, parseInt(process.env.ML_RATING_DEADLINE_DAYS || "30", 10) || 30);
    const notes = `Import ml_orders ml_user_id=${mUid} order_id=${oid}`;

    let loyaltyPoints = 0;
    const earnLoyalty = process.env.SALES_ML_IMPORT_LOYALTY === "1";
    if (earnLoyalty && customerId && st === "paid") {
      const earn = await loyaltyService.earnFromMlOrder({
        customerId,
        orderId: String(oid),
        amountUsd: totalUsd,
        source: "mercadolibre",
        client,
      });
      loyaltyPoints = earn.points_earned || 0;
    }

    const hasLifecycle = await salesOrdersHasLifecycleColumns(client);
    let ins;
    if (hasLifecycle) {
      ins = await client.query(
        `INSERT INTO sales_orders (source, external_order_id, customer_id, status, order_total_amount, notes, sold_by,
          applies_stock, records_cash, ml_user_id, loyalty_points_earned,
          lifecycle_status, ml_status, rating_deadline_at)
         VALUES ('mercadolibre', $1, $2, $3, $4, $5, NULL, FALSE, FALSE, $6, $7,
          $8, $9, NOW() + ($10::text || ' days')::interval)
         RETURNING id`,
        [extId, customerId, st, totalUsd.toFixed(2), notes, mUid, loyaltyPoints, lifecycle, mlStatusRaw, String(ratingDays)]
      );
    } else {
      ins = await client.query(
        `INSERT INTO sales_orders (source, external_order_id, customer_id, status, order_total_amount, notes, sold_by,
          applies_stock, records_cash, ml_user_id, loyalty_points_earned)
         VALUES ('mercadolibre', $1, $2, $3, $4, $5, NULL, FALSE, FALSE, $6, $7)
         RETURNING id`,
        [extId, customerId, st, totalUsd.toFixed(2), notes, mUid, loyaltyPoints]
      );
    }
    const salesId = ins.rows[0].id;

    await client.query("COMMIT");
    try {
      const out = await getSalesOrderById(salesId);
      return { ...out, idempotent: false, import: "ml" };
    } catch (readErr) {
      let fr;
      try {
        const r = await pool.query(`SELECT * FROM sales_orders WHERE id = $1`, [salesId]);
        fr = r.rows;
      } catch {
        throw mapErr(readErr);
      }
      if (!fr.length) throw mapErr(readErr);
      const o = fr[0];
      const tot = Number(o.order_total_amount);
      return {
        id: o.id,
        source: o.source,
        external_order_id: o.external_order_id,
        customer_id: o.customer_id,
        status: o.status,
        order_total_amount: tot,
        total_amount_usd: tot,
        total_usd: tot,
        total_amount_bs: o.total_amount_bs != null ? Number(o.total_amount_bs) : null,
        exchange_rate_bs_per_usd:
          o.exchange_rate_bs_per_usd != null ? Number(o.exchange_rate_bs_per_usd) : null,
        payment_method: o.payment_method,
        loyalty_points_earned: o.loyalty_points_earned,
        notes: o.notes,
        sold_by: o.sold_by,
        applies_stock: o.applies_stock,
        records_cash: o.records_cash,
        ml_user_id: o.ml_user_id,
        lifecycle_status: o.lifecycle_status,
        ml_status: o.ml_status,
        created_at: o.created_at,
        updated_at: o.updated_at,
        items: [],
        idempotent: false,
        import: "ml",
        warning:
          "La orden se guardó; el detalle completo falló al leer (revisá migraciones: npm run db:sales-all, db:orders-lifecycle).",
      };
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    if (e && e.code === "23505") {
      const r = await pool.query(
        `SELECT id FROM sales_orders WHERE source = 'mercadolibre' AND external_order_id = $1`,
        [extId]
      );
      if (r.rows.length) {
        const existing = await getSalesOrderById(r.rows[0].id);
        return { ...existing, idempotent: true, import: "ml" };
      }
    }
    throw mapErr(e);
  } finally {
    client.release();
  }
}

/**
 * En API ML, `feedback.sale` es la calificación **del vendedor hacia el comprador** (texto `positive`, etc.).
 */
function isMlFeedbackSalePositive(s) {
  return String(s || "").trim().toLowerCase() === "positive";
}

/**
 * Tras cambios en `ml_orders` (webhook, sync órdenes/feedback): asegura fila en `sales_orders` y
 * marca `completed` cuando el vendedor dejó calificación positiva (`feedback_sale`).
 * Requiere migración `completed` en CHECK de `sales_orders` y `SALES_ML_IMPORT_ENABLED=1`.
 */
async function syncMercadolibreSalesAfterMlOrderChange({ mlUserId, orderId }) {
  if (process.env.SALES_ML_IMPORT_ENABLED !== "1") {
    return { skipped: true, reason: "SALES_ML_IMPORT_DISABLED" };
  }
  const mUid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(mUid) || mUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return { skipped: true, reason: "bad_ids" };
  }
  const extId = `${mUid}-${oid}`;

  const mr = await pool.query(
    `SELECT feedback_sale FROM ml_orders WHERE ml_user_id = $1 AND order_id = $2`,
    [mUid, oid]
  );
  if (!mr.rows.length) {
    return { skipped: true, reason: "no_ml_order" };
  }
  const feedbackSale = mr.rows[0].feedback_sale;

  try {
    const ex = await pool.query(
      `SELECT id FROM sales_orders WHERE source = 'mercadolibre' AND external_order_id = $1`,
      [extId]
    );
    if (!ex.rows.length) {
      await importSalesOrderFromMlOrder({ mlUserId: mUid, orderId: oid });
    }
  } catch (e) {
    if (e && e.code === "IMPORT_DISABLED") return { skipped: true };
    console.error("[syncMercadolibreSalesAfterMlOrderChange]", e.message || e);
    return { error: e.message || String(e) };
  }

  if (!isMlFeedbackSalePositive(feedbackSale)) {
    return { ok: true, completed: false };
  }

  const hasLifecycle = await salesOrdersHasLifecycleColumns(pool);
  const upd = hasLifecycle
    ? await pool.query(
        `UPDATE sales_orders
         SET status = 'completed',
             lifecycle_status = 'archivado',
             updated_at = NOW()
         WHERE source = 'mercadolibre'
           AND external_order_id = $1
           AND status <> 'cancelled'`,
        [extId]
      )
    : await pool.query(
        `UPDATE sales_orders
         SET status = 'completed',
             updated_at = NOW()
         WHERE source = 'mercadolibre'
           AND external_order_id = $1
           AND status <> 'cancelled'`,
        [extId]
      );
  return { ok: true, completed: true, updated: upd.rowCount };
}

/**
 * `ml_orders.feedback_purchase` / `feedback_sale` reflejan calificaciones ML (comprador ↔ vendedor).
 * En BD lo relevante es si ya hay dato: **NULL** = calificación aún no persistida (no confundir con el
 * estado "pending" que muestra la web si la fila nunca se sincronizó con detalle de feedback).
 */
function sqlFeedbackPurchaseUnset() {
  return `(feedback_purchase IS NULL)`;
}

function sqlFeedbackSaleUnset() {
  return `(feedback_sale IS NULL)`;
}

/**
 * Fila donde la API/ETL guardó literalmente el texto `pending` (caso raro; la regla de negocio normal es NULL).
 */
function sqlFeedbackPurchaseStrictPending() {
  return `(LOWER(TRIM(COALESCE(feedback_purchase, ''))) = 'pending')`;
}

function sqlFeedbackSaleStrictPending() {
  return `(LOWER(TRIM(COALESCE(feedback_sale, ''))) = 'pending')`;
}

/**
 * Condición en `ml_orders` según `feedback_sale` / `feedback_purchase`.
 * - `feedback_purchase_pending`: comprador aún sin calificación persistida (columna NULL).
 * - `feedback_sale_pending`: vendedor aún sin calificación persistida (columna NULL).
 * - `feedback_any_pending`: falta al menos una de las dos calificaciones (cualquier columna NULL).
 * - `feedback_both_pending`: **ambas** calificaciones NULL (comprador y vendedor sin rating en BD).
 * - `*_strict`: solo filas con texto `pending` en columna (no usa la semántica NULL).
 */
function mlOrdersFeedbackPendingSql(filter) {
  const f = filter != null && String(filter).trim() !== "" ? String(filter).trim() : "none";
  if (f === "none") return { clause: "", params: [] };
  const pp = sqlFeedbackPurchaseUnset();
  const ps = sqlFeedbackSaleUnset();
  const ppS = sqlFeedbackPurchaseStrictPending();
  const psS = sqlFeedbackSaleStrictPending();
  if (f === "feedback_purchase_pending") {
    return { clause: ` AND ${pp}`, params: [] };
  }
  if (f === "feedback_sale_pending") {
    return { clause: ` AND ${ps}`, params: [] };
  }
  if (f === "feedback_any_pending") {
    return { clause: ` AND (${pp} OR ${ps})`, params: [] };
  }
  if (f === "feedback_both_pending") {
    return { clause: ` AND (${pp} AND ${ps})`, params: [] };
  }
  if (f === "feedback_purchase_strict") {
    return { clause: ` AND ${ppS}`, params: [] };
  }
  if (f === "feedback_sale_strict") {
    return { clause: ` AND ${psS}`, params: [] };
  }
  if (f === "feedback_any_strict") {
    return { clause: ` AND (${ppS} OR ${psS})`, params: [] };
  }
  if (f === "feedback_both_strict") {
    return { clause: ` AND (${ppS} AND ${psS})`, params: [] };
  }
  const e = new Error("ml_feedback_filter inválido");
  e.code = "BAD_REQUEST";
  throw e;
}

const ML_ORDERS_REGISTERED_ACCOUNTS_SQL = `ml_user_id IN (SELECT ml_user_id FROM ml_accounts)`;

/**
 * Diagnóstico para scripts / soporte: cuántas filas hay y cuántas coinciden el filtro.
 * @param {{ mlUserId?: number, allAccounts?: boolean, mlFeedbackFilter?: string }} p
 *   `allAccounts: true` → todas las cuentas en `ml_accounts` (no pasar `mlUserId`).
 */
async function previewMlOrdersImport({ mlUserId, allAccounts = false, mlFeedbackFilter = "none" }) {
  const { clause } = mlOrdersFeedbackPendingSql(mlFeedbackFilter);
  let whereSql;
  const params = [];
  if (allAccounts) {
    whereSql = ML_ORDERS_REGISTERED_ACCOUNTS_SQL;
  } else {
    const mUid = Number(mlUserId);
    if (!Number.isFinite(mUid) || mUid <= 0) {
      const e = new Error("ml_user_id inválido (o usá allAccounts: true)");
      e.code = "BAD_REQUEST";
      throw e;
    }
    whereSql = `ml_user_id = $1`;
    params.push(mUid);
  }
  const qBase = `FROM ml_orders WHERE ${whereSql}`;
  const { rows: t } = await pool.query(`SELECT COUNT(*)::bigint AS n ${qBase}`, params);
  const { rows: m } = await pool.query(`SELECT COUNT(*)::bigint AS n ${qBase}${clause}`, params);
  const sampleSelect = allAccounts
    ? `SELECT ml_user_id, order_id, feedback_sale, feedback_purchase, status ${qBase}${clause} ORDER BY id DESC LIMIT 8`
    : `SELECT order_id, feedback_sale, feedback_purchase, status ${qBase}${clause} ORDER BY id DESC LIMIT 8`;
  const { rows: samp } = await pool.query(sampleSelect, params);
  return {
    scope: allAccounts ? "all_accounts" : "single",
    ml_user_id: allAccounts ? null : Number(mlUserId),
    ml_feedback_filter: mlFeedbackFilter || "none",
    total_ml_orders: Number(t[0].n),
    matching_filter: Number(m[0].n),
    sample: samp,
  };
}

/**
 * Importa por lotes filas de `ml_orders` (más recientes primero).
 * @param {{ mlUserId?: number, allAccounts?: boolean, limit?: number, offset?: number, mlFeedbackFilter?: string }} p
 *   Una cuenta: `mlUserId`. Todas las cuentas registradas: `allAccounts: true` (solo órdenes con `ml_user_id` en `ml_accounts`).
 */
async function importSalesOrdersFromMlTable({
  mlUserId,
  allAccounts = false,
  limit = 50,
  offset = 0,
  mlFeedbackFilter = "none",
}) {
  if (process.env.SALES_ML_IMPORT_ENABLED !== "1") {
    const e = new Error("Import ML desactivado (SALES_ML_IMPORT_ENABLED=1)");
    e.code = "IMPORT_DISABLED";
    throw e;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const { clause } = mlOrdersFeedbackPendingSql(mlFeedbackFilter);
  let whereSql;
  let mUidSingle;
  if (allAccounts) {
    whereSql = ML_ORDERS_REGISTERED_ACCOUNTS_SQL;
  } else {
    mUidSingle = Number(mlUserId);
    if (!Number.isFinite(mUidSingle) || mUidSingle <= 0) {
      const e = new Error("ml_user_id inválido (o usá allAccounts: true)");
      e.code = "BAD_REQUEST";
      throw e;
    }
    whereSql = `ml_user_id = $1`;
  }
  const limitOffset = allAccounts ? `LIMIT $1 OFFSET $2` : `LIMIT $2 OFFSET $3`;
  const qParams = allAccounts ? [lim, off] : [mUidSingle, lim, off];
  const { rows } = await pool.query(
    `SELECT ml_user_id, order_id FROM ml_orders WHERE ${whereSql}${clause} ORDER BY id DESC ${limitOffset}`,
    qParams
  );
  const summary = {
    imported: 0,
    idempotent: 0,
    rows_in_batch: rows.length,
    errors: [],
    ml_feedback_filter: mlFeedbackFilter || "none",
    scope: allAccounts ? "all_accounts" : "single",
    ml_user_id: allAccounts ? null : Number(mlUserId),
  };
  for (const r of rows) {
    try {
      const out = await importSalesOrderFromMlOrder({ mlUserId: r.ml_user_id, orderId: r.order_id });
      if (out.idempotent) summary.idempotent++;
      else summary.imported++;
    } catch (err) {
      summary.errors.push({
        ml_user_id: r.ml_user_id,
        order_id: r.order_id,
        message: String(err && err.message),
        code: err && err.code,
      });
    }
  }
  return summary;
}

module.exports = {
  createOrder,
  createSalesOrder,
  getSalesOrderById,
  listSalesOrders,
  getSalesStats,
  patchSalesOrderStatus,
  importSalesOrderFromMlOrder,
  importSalesOrdersFromMlTable,
  previewMlOrdersImport,
  syncMercadolibreSalesAfterMlOrderChange,
  ensureCustomerAndLinkMlBuyer,
  mapErr,
  incrementStockFromOrderLines,
  fetchOrderItems,
};
