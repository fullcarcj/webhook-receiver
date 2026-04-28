"use strict";

const crypto = require("crypto");
const { pool } = require("../../db");
const loyaltyService = require("./loyaltyService");
const { getTodayRate } = require("./currencyService");
const { CustomerModel } = require("./crmIdentityService");
const { customersHasPhone2Column } = require("../utils/customersPhone2");
const {
  salesOrdersHasLifecycleColumns,
  salesOrdersHasTotalAmountUsdColumn,
} = require("../utils/salesOrdersLifecycle");
const bundleService = require("./bundleService");
const { V_SALES_UNIFIED_BS_AMOUNT } = require("../utils/statsHelpers");
const { normalizePhone } = require("../utils/phoneNormalizer");

const MANUAL_SOURCES = new Set(["mostrador", "social_media", "ecommerce", "fuerza_ventas"]);

/** Mapa source → channel_id (catálogo sales_channels) */
const SOURCE_TO_CHANNEL = {
  mostrador:      1,
  social_media:   2,
  mercadolibre:   3,
  ecommerce:      4,
  fuerza_ventas:  5,
};

/** payment_status inicial por canal (post-migración) */
const CHANNEL_PAYMENT_STATUS = {
  1: 'not_required', // MOSTRADOR: cobrado en caja
  2: 'pending',      // WHATSAPP: transferencia diferida
  3: 'pending',      // ML: esperar payment_approved webhook
  4: 'pending',      // ECOMMERCE: esperar webhook pasarela
  5: 'pending',      // FUERZA_VENTAS: crédito o efectivo diferido
};

/** fulfillment_status inicial por canal */
const CHANNEL_FULFILLMENT_STATUS = {
  1: 'not_required', // MOSTRADOR: retiro en el acto
  2: 'pending',
  3: 'pending',
  4: 'pending',
  5: 'pending',
};
const DEFAULT_ML_ACTIVE_MAX_DAYS = 10;

/** Etapas de ciclo ML (feedback en `ml_orders`; NULL = pendiente). */
const LIFECYCLE_STAGE_VALUES = new Set([
  "waiting_buyer_feedback",
  "waiting_seller_feedback",
  "feedback_complete",
  "unknown",
]);

function resolveMlActiveMaxDays() {
  const raw = Number(process.env.SALES_ML_ACTIVE_MAX_DAYS || DEFAULT_ML_ACTIVE_MAX_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ML_ACTIVE_MAX_DAYS;
  return Math.max(1, Math.floor(raw));
}

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

    // Kits en BD (product_bundles + alternativas) tienen prioridad sobre kit_components JSON.
    if (await bundleService.hasDbBundlesForParent(row.id, client)) {
      const dec = await bundleService.buildStockDecrementsForDbKit(
        client,
        row.id,
        qty,
        Array.isArray(it.selected_components) ? it.selected_components : []
      );
      for (const d of dec) {
        stockDecrements.push(d);
      }
      continue;
    }

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
    if (await bundleService.hasDbBundlesForParent(it.product_id, client)) {
      const { rows: comps } = await client.query(
        `SELECT component_product_id, quantity FROM product_bundles
         WHERE parent_product_id = $1 AND is_active = TRUE`,
        [it.product_id]
      );
      for (const c of comps) {
        const add = Number(c.quantity) * it.quantity;
        await client.query(`UPDATE productos SET stock = stock + $2, updated_at = NOW() WHERE id = $1`, [
          c.component_product_id,
          add,
        ]);
      }
      continue;
    }
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
 * @param {number|undefined|null} [p.customerId] — sin cliente en mostrador: doc+teléfono o `consumidor_final` (ver evaluateMostradorIdentity)
 * @param {Array<{sku:string,quantity:number,unit_price_usd:number}>} p.items
 * @param {string} [p.notes]
 * @param {string} [p.soldBy]
 * @param {'pending'|'paid'} [p.status]
 * @param {string} [p.externalOrderId]
 * @param {'cash'|'card'|'transfer'|'mercadopago'|'pago_movil'|'other'|'unknown'|string} [p.paymentMethod]
 * @param {string} [p.identityExternalId] — clave en crm_customer_identities (default: external_order_id)
 * @param {number} [p.companyId] — tasas Bs (currency)
 * @param {number|undefined|null} [p.zoneId] — zona delivery (opcional)
 * @param {number|undefined|null} [p.deliveryClientPriceBs] — costo carrera al cliente en Bs.; con `zoneId` pisa el precio de lista de la zona
 * @param {number} [p.paymentAmount] — monto cobrado (USD o Bs según medio; opcional, default total orden)
 * @param {number} [p.exchangeRate] — tasa Bs/USD para EFECTIVO_BS (opcional)
 * @param {string} [p.proofUrl] — URL comprobante (opcional)
 * @param {string} [p.id_type] — V/E/J/G/P (mostrador sin customer_id)
 * @param {string} [p.id_number]
 * @param {string} [p.phone] — teléfono contacto (mostrador sin customer_id)
 * @param {boolean} [p.consumidor_final]
 */
async function createOrder({
  source,
  channelId,
  sellerId,
  customerId,
  items,
  notes,
  soldBy,
  status,
  externalOrderId,
  paymentMethod,
  identityExternalId,
  companyId,
  zoneId,
  deliveryClientPriceBs,
  paymentAmount,
  exchangeRate,
  proofUrl,
  id_type,
  id_number,
  phone,
  consumidor_final,
  conversationId = null,
}) {
  if (!MANUAL_SOURCES.has(source)) {
    const e = new Error("source no permitido para creación manual");
    e.code = "BAD_REQUEST";
    throw e;
  }

  // Inferir channel_id desde source si no se provee explícitamente
  const resolvedChannelId = channelId != null
    ? Number(channelId)
    : (SOURCE_TO_CHANNEL[source] ?? null);

  // CH-05 fuerza_ventas: seller_id obligatorio
  if (source === 'fuerza_ventas' && !sellerId) {
    const e = new Error("seller_id es obligatorio para órdenes de fuerza_ventas (CH-05)");
    e.code = "BAD_REQUEST";
    throw e;
  }

  // CH-02 whatsapp/redes: cliente obligatorio
  if (source === 'social_media' && !customerId) {
    const e = new Error("customer_id es obligatorio para órdenes de WhatsApp/redes (CH-02)");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const resolvedSellerId = sellerId != null ? Number(sellerId) : null;
  const paymentSt  = CHANNEL_PAYMENT_STATUS[resolvedChannelId]  ?? 'pending';
  const fulfillSt  = CHANNEL_FULFILLMENT_STATUS[resolvedChannelId] ?? 'pending';
  const st =
    status === "pending" || status === "pending_payment" ? "pending" : "paid";
  const cashApprovalService = require("./cashApprovalService");
  let cid = null;
  let zId = null;
  if (customerId != null && customerId !== "") {
    const n = Number(customerId);
    if (!Number.isFinite(n) || n <= 0) {
      const e = new Error("customer_id inválido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    cid = n;
  }
  if (zoneId != null && zoneId !== "") {
    const z = Number(zoneId);
    if (!Number.isFinite(z) || z <= 0) {
      const e = new Error("zone_id inválido");
      e.code = "BAD_REQUEST";
      throw e;
    }
    zId = z;
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

  const needsCashApproval = cashApprovalService.isCashApprovalPaymentMethod(pay);
  if (needsCashApproval && st === "paid") {
    const e = new Error(
      "Medio de cobro distinto de transferencia/pago móvil requiere aprobación de caja; enviar status pending o pending_payment"
    );
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (needsCashApproval && (!soldBy || String(soldBy).trim() === "")) {
    const e = new Error("sold_by es obligatorio cuando el cobro requiere aprobación de caja");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const insertStatus = needsCashApproval ? "pending_cash_approval" : st;

  let orderNotes = notes;
  if (source === "mostrador") {
    const { evaluateMostradorIdentity } = require("../utils/mostradorIdentityGate");
    const gate = evaluateMostradorIdentity({
      customerId: cid,
      id_type,
      id_number,
      phone,
      consumidor_final,
      notes: orderNotes,
    });
    if (!gate.ok) {
      const e = new Error(gate.message || gate.reason || "identidad");
      e.code = gate.code;
      if (gate.reason) e.reason = gate.reason;
      throw e;
    }
    orderNotes = gate.notes;
  }

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
  /** @type {null | { tx_id: number, discrepancy_usd: number, has_discrepancy: boolean, amount_usd_equiv: number }} */
  let cashSsePayload = null;
  try {
    await client.query("BEGIN");

    const dup = await client.query(
      `SELECT id FROM sales_orders WHERE source = $1 AND external_order_id = $2`,
      [source, extId]
    );
    if (dup.rows.length) {
      await client.query("ROLLBACK");
      const existing = await fetchSalesOrderOmnichannelDetail(dup.rows[0].id);
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

    const convId =
      conversationId != null && Number.isFinite(Number(conversationId)) && Number(conversationId) > 0
        ? Number(conversationId)
        : null;

    const orderTotalStr = totalAmountUsd.toFixed(2);
    const hasLegacyTotalUsd = await salesOrdersHasTotalAmountUsdColumn(client);
    const ins = await client.query(
      hasLegacyTotalUsd
        ? `INSERT INTO sales_orders (
         source, channel_id, seller_id, external_order_id, customer_id, status,
         order_total_amount, total_amount_usd, total_amount_bs, exchange_rate_bs_per_usd, payment_method,
         payment_status, fulfillment_status,
         notes, sold_by, conversation_id, applies_stock, records_cash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, TRUE)
       RETURNING id, created_at`
        : `INSERT INTO sales_orders (
         source, channel_id, seller_id, external_order_id, customer_id, status,
         order_total_amount, total_amount_bs, exchange_rate_bs_per_usd, payment_method,
         payment_status, fulfillment_status,
         notes, sold_by, conversation_id, applies_stock, records_cash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, TRUE)
       RETURNING id, created_at`,
      [
        source,
        resolvedChannelId,
        resolvedSellerId,
        extId,
        cid,
        insertStatus,
        orderTotalStr,
        totalBs != null ? totalBs.toFixed(2) : null,
        rate != null && Number.isFinite(rate) ? rate : null,
        pay,
        paymentSt,
        fulfillSt,
        orderNotes ?? null,
        soldBy ?? null,
        convId,
      ]
    );
    const orderId = ins.rows[0].id;

    await insertItems(client, orderId, linesForInsert);
    await decrementStock(client, stockDecrements);

    // Delivery opcional: suma al total de la orden y crea la carrera en la misma transacción.
    if (zId != null) {
      const { rows: zrows } = await client.query(
        `SELECT id, zone_name, base_cost_bs, client_price_bs, currency_pago
         FROM delivery_zones
         WHERE id = $1 AND is_active = TRUE`,
        [zId]
      );
      if (!zrows.length) {
        await client.query("ROLLBACK");
        const e = new Error(`Zona de delivery ${zId} no existe o está inactiva`);
        e.code = "ZONE_NOT_FOUND";
        throw e;
      }
      const zone = zrows[0];
      const listClientBs = Number(zone.client_price_bs || 0);
      let clientBs = listClientBs;
      if (deliveryClientPriceBs != null && deliveryClientPriceBs !== "") {
        const o = Number(deliveryClientPriceBs);
        if (Number.isFinite(o) && o > 0) clientBs = o;
      }
      const deliveryAddedBs = clientBs;
      if (deliveryAddedBs > 0) {
        if (hasLegacyTotalUsd) {
          await client.query(
            `UPDATE sales_orders
           SET order_total_amount = order_total_amount + $1,
               total_amount_usd = total_amount_usd + $1,
               total_amount_bs = COALESCE(total_amount_bs, 0) + $1,
               zone_id = $2,
               has_delivery = TRUE,
               updated_at = NOW()
           WHERE id = $3`,
            [deliveryAddedBs, zId, orderId]
          );
        } else {
          await client.query(
            `UPDATE sales_orders
           SET order_total_amount = order_total_amount + $1,
               total_amount_bs = COALESCE(total_amount_bs, 0) + $1,
               zone_id = $2,
               has_delivery = TRUE,
               updated_at = NOW()
           WHERE id = $3`,
            [deliveryAddedBs, zId, orderId]
          );
        }
      } else {
        await client.query(
          `UPDATE sales_orders
           SET zone_id = $1,
               has_delivery = TRUE,
               updated_at = NOW()
           WHERE id = $2`,
          [zId, orderId]
        );
      }
      const deliveryService = require("./deliveryService");
      const zoneForSvc = Object.assign({}, zone, { client_price_bs: clientBs });
      await deliveryService.createDeliveryService(client, {
        orderId,
        zoneId: zId,
        zone: zoneForSvc,
      });
    }

    if (needsCashApproval) {
      cashSsePayload = await cashApprovalService.recordNewSaleCashPayment(client, {
        orderId,
        paymentMethod: pay,
        paymentAmount: paymentAmount != null ? Number(paymentAmount) : null,
        exchangeRate: exchangeRate != null ? Number(exchangeRate) : null,
        proofUrl: proofUrl != null ? String(proofUrl) : null,
        soldBy,
        description: orderNotes || `Venta ${source}`,
      });
    }

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

    if (cashSsePayload && needsCashApproval) {
      cashApprovalService.emitCashSubmitted({
        tx_id: cashSsePayload.tx_id,
        order_id: orderId,
        currency: pay,
        amount: cashSsePayload.amount,
        amount_usd: cashSsePayload.amount_usd_equiv,
        submitted_by: soldBy,
        discrepancy_usd: cashSsePayload.discrepancy_usd,
        has_discrepancy: cashSsePayload.has_discrepancy,
        message: cashSsePayload.has_discrepancy
          ? `Pago ${pay} con discrepancia USD ${Math.abs(cashSsePayload.discrepancy_usd).toFixed(4)}`
          : `Pago ${pay} registrado — revisar en caja`,
      });
    }

    // Revisión de precios / rotación (no bloquea respuesta; falla silenciosa si no hay migración).
    setImmediate(() => {
      const priceReviewService = require("./priceReviewService");
      (async () => {
        try {
          for (const line of linesForInsert) {
            const { rows: ar } = await pool.query(`SELECT atributos FROM productos WHERE id = $1`, [
              line.product_id,
            ]);
            const at = ar[0]?.atributos;
            const dbKit = await bundleService.hasDbBundlesForParent(line.product_id, pool);
            const jsonKit = !!parseKitComponents(at);
            if (!dbKit && !jsonKit) {
              await priceReviewService.enqueueComponentPricing(line.product_id).catch(() => {});
            }
            await priceReviewService.checkHighRotation(line.product_id).catch(() => {});
          }
        } catch (_e) {
          /* opcional */
        }
      })();
    });

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

    const out = await fetchSalesOrderOmnichannelDetail(orderId);
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

/**
 * Detalle omnicanal desde `sales_orders` + ítems (ids numéricos legacy).
 * @param {number} oid
 * @param {{ responseId?: string }} [opts] Si `responseId` (p.ej. `so-42`), se devuelve como `id` en el JSON.
 */
async function fetchSalesOrderOmnichannelDetail(oid, opts) {
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
      `SELECT so.id, so.source, so.external_order_id, so.customer_id, so.status,
              so.order_total_amount,
              so.total_amount_bs, so.exchange_rate_bs_per_usd, so.payment_method,
              so.loyalty_points_earned,
              so.notes, so.sold_by, so.created_at, so.updated_at,
              so.conversation_id,
              COALESCE(so.applies_stock, TRUE) AS applies_stock,
              COALESCE(so.records_cash, TRUE) AS records_cash,
              so.ml_user_id,
              so.fulfillment_type::text AS fulfillment_type,
              rl.bank_statement_id AS reconciled_statement_id
              ${lifecycleCols}
       FROM sales_orders so
       LEFT JOIN LATERAL (
         SELECT r.bank_statement_id
         FROM reconciliation_log r
         WHERE r.order_id = so.id
           AND r.bank_statement_id IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1
       ) rl ON TRUE
       WHERE so.id = $1`,
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

    // Preview de ítems para órdenes ML: extraer de ml_orders.raw_json -> order_items.
    // sales_order_items siempre está vacío en importaciones ML (applies_stock=FALSE).
    let itemsPreview = null;
    if (o.source === "mercadolibre" && o.external_order_id) {
      try {
        const extParts = String(o.external_order_id).split("-");
        if (extParts.length === 2) {
          const mlUserId = Number(extParts[0]);
          const mlOrderId = Number(extParts[1]);
          if (Number.isFinite(mlUserId) && Number.isFinite(mlOrderId)) {
            const { rows: mlRows } = await pool.query(
              `SELECT mo.raw_json,
                      json_agg(
                        json_build_object(
                          'sku',       COALESCE(
                                         NULLIF(item_el #>> '{item,seller_sku}', ''),
                                         NULLIF(item_el #>> '{item,seller_custom_field}', ''),
                                         item_el #>> '{item,id}'
                                       ),
                          'name',      COALESCE(
                                         NULLIF(TRIM(item_el #>> '{item,title}'), ''),
                                         item_el #>> '{item,id}'
                                       ),
                          'qty',       CASE
                                         WHEN (item_el ->> 'quantity') ~ '^[0-9]+(\\.[0-9]+)?$'
                                         THEN (item_el ->> 'quantity')::numeric
                                         ELSE 1
                                       END,
                          'unit_price_usd', NULL,
                          'image_url', COALESCE(
                                         NULLIF(TRIM(ml_th.thumbnail), ''),
                                         NULLIF(item_el #>> '{item,thumbnail}', ''),
                                         NULLIF(item_el #>> '{item,secure_thumbnail}', '')
                                       )
                        ) ORDER BY t.ord
                      ) AS preview
               FROM ml_orders mo,
                    json_array_elements((mo.raw_json::json) -> 'order_items')
                      WITH ORDINALITY AS t(item_el, ord)
               LEFT JOIN ml_listings ml_th
                 ON ml_th.item_id = NULLIF(TRIM(t.item_el #>> '{item,id}'), '')
               WHERE mo.ml_user_id = $1 AND mo.order_id = $2
               GROUP BY mo.raw_json`,
              [mlUserId, mlOrderId]
            );
            if (mlRows.length && Array.isArray(mlRows[0].preview)) {
              itemsPreview = mlRows[0].preview;
            }
          }
        }
      } catch (_previewErr) {
        // No bloquear si ml_orders no existe o raw_json está vacío
      }
    }

    const tot = Number(o.order_total_amount);
    const responseId = opts && opts.responseId != null ? opts.responseId : o.id;
    return {
      id: responseId,
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
      fulfillment_type:
        o.fulfillment_type != null && String(o.fulfillment_type).trim() !== ""
          ? String(o.fulfillment_type).trim()
          : null,
      calificacion_ml: hasLifecycle ? o.calificacion_ml : null,
      rating_deadline_at: hasLifecycle ? o.rating_deadline_at : null,
      is_rating_alert: hasLifecycle ? o.is_rating_alert : null,
      created_at: o.created_at,
      updated_at: o.updated_at,
      reconciled_statement_id:
        o.reconciled_statement_id != null ? Number(o.reconciled_statement_id) : null,
      chat_id:
        o.conversation_id != null && String(o.conversation_id).trim() !== ""
          ? Number(o.conversation_id)
          : null,
      items_preview: itemsPreview,
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

/**
 * Detalle venta POS (`sales` + `sale_lines`).
 * @param {number} saleId
 * @param {{ responseId?: string }} [opts]
 */
async function getPosSaleUnifiedDetail(saleId, opts) {
  const sid = Number(saleId);
  if (!Number.isFinite(sid) || sid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows: srows } = await pool.query(`SELECT * FROM sales WHERE id = $1`, [sid]);
    if (!srows.length) {
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      throw e;
    }
    const s = srows[0];
    const { rows: irows } = await pool.query(
      `SELECT sl.id,
              p.id AS product_id,
              sl.product_sku AS sku,
              sl.quantity,
              sl.unit_price_usd,
              sl.line_total_usd
       FROM sale_lines sl
       LEFT JOIN products p ON p.sku = sl.product_sku
       WHERE sl.sale_id = $1
       ORDER BY sl.id`,
      [sid]
    );
    let paymentMethod = null;
    try {
      const { rows: pm } = await pool.query(
        `SELECT string_agg(DISTINCT payment_method_code, ', ' ORDER BY payment_method_code) AS pm
         FROM sale_payments WHERE sale_id = $1`,
        [sid]
      );
      paymentMethod = pm[0] && pm[0].pm ? String(pm[0].pm) : null;
    } catch (pe) {
      if (pe && pe.code !== "42P01") throw mapErr(pe);
    }
    const st = String(s.status || "").toUpperCase().trim();
    let statusApi = String(s.status || "").toLowerCase();
    if (st === "PAID") statusApi = "paid";
    else if (st === "PENDING") statusApi = "pending";
    else if (st === "CANCELLED") statusApi = "cancelled";
    else if (st === "REFUNDED") statusApi = "refunded";

    const tot = Number(s.total_usd);
    const totalBs =
      s.total_bs != null && s.total_bs !== ""
        ? Number(s.total_bs)
        : s.rate_applied != null && Number.isFinite(Number(s.rate_applied))
          ? Number((tot * Number(s.rate_applied)).toFixed(2))
          : null;
    const responseId = opts && opts.responseId != null ? opts.responseId : `pos-${sid}`;
    return {
      id: responseId,
      source: "mostrador",
      external_order_id: null,
      customer_id: s.customer_id != null ? Number(s.customer_id) : null,
      status: statusApi,
      order_total_amount: tot,
      total_amount_usd: tot,
      total_usd: tot,
      total_amount_bs: totalBs,
      exchange_rate_bs_per_usd: s.rate_applied != null ? Number(s.rate_applied) : null,
      payment_method: paymentMethod,
      loyalty_points_earned: 0,
      notes: s.notes,
      sold_by: null,
      applies_stock: true,
      records_cash: true,
      ml_user_id: null,
      lifecycle_status: null,
      ml_status: null,
      motivo_anulacion: null,
      tipo_calificacion_ml: null,
      aprobado_por_user_id: null,
      es_pago_auto_banesco: null,
      metodo_despacho: null,
      fulfillment_type: null,
      calificacion_ml: null,
      rating_deadline_at: null,
      is_rating_alert: null,
      created_at: s.created_at,
      updated_at: s.updated_at,
      reconciled_statement_id: null,
      items: irows.map((r) => {
        const sub = Number(r.line_total_usd);
        return {
          id: r.id,
          product_id: r.product_id != null ? Number(r.product_id) : null,
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

/** Valores CHECK `sales_orders.fulfillment_type` (sql/20260422_omnichannel_extend.sql). */
const SALES_ORDER_FULFILLMENT_TYPES = new Set([
  "retiro_tienda",
  "envio_propio",
  "mercado_envios",
  "entrega_vendedor",
  "retiro_acordado",
  "desde_bodega",
]);

/** Alineado a `paymentMethodEnum` en `salesApiHandler.js` (POST ventas). */
const SALES_ORDER_PAYMENT_METHOD_CODES = new Set([
  "cash",
  "card",
  "transfer",
  "mercadopago",
  "pago_movil",
  "other",
  "unknown",
  "zelle",
  "binance",
  "usd",
  "efectivo",
  "efectivo_bs",
  "panama",
  "credito",
  "ves_banesco",
  "ves_bdv",
]);

/**
 * Actualiza `fulfillment_type` en `sales_orders` (ventas omnicanal, no POS).
 * @param {string} rawId `so-N` o `N`
 * @param {string|null|undefined} fulfillmentType valor permitido o null para limpiar
 */
async function patchSalesOrderFulfillmentType(rawId, fulfillmentType) {
  const s = rawId != null ? String(rawId).trim() : "";
  if (/^pos-/i.test(s)) {
    const e = new Error("No aplica a ventas POS (pos-*)");
    e.code = "BAD_REQUEST";
    throw e;
  }
  let oid = NaN;
  if (/^so-\d+$/i.test(s)) oid = Number(s.slice(3));
  else if (/^\d+$/.test(s)) oid = Number(s);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const rawFt =
    fulfillmentType == null || String(fulfillmentType).trim() === ""
      ? null
      : String(fulfillmentType).trim();
  if (rawFt != null && !SALES_ORDER_FULFILLMENT_TYPES.has(rawFt)) {
    const e = new Error(
      `fulfillment_type inválido: use ${Array.from(SALES_ORDER_FULFILLMENT_TYPES).join(", ")} o null`
    );
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rowCount } = await pool.query(
    `UPDATE sales_orders
     SET fulfillment_type = $1::text,
         updated_at = NOW()
     WHERE id = $2`,
    [rawFt, oid]
  );
  if (!rowCount) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    throw e;
  }

  return getSalesOrderById(`so-${oid}`);
}

/**
 * Actualiza `payment_method` en `sales_orders` (omnicanal; mismos códigos que alta de venta).
 * @param {string} rawId `so-N` o `N`
 * @param {string|null|undefined} paymentMethod código permitido o null para limpiar
 */
async function patchSalesOrderPaymentMethod(rawId, paymentMethod) {
  const s = rawId != null ? String(rawId).trim() : "";
  if (/^pos-/i.test(s)) {
    const e = new Error("No aplica a ventas POS (pos-*)");
    e.code = "BAD_REQUEST";
    throw e;
  }
  let oid = NaN;
  if (/^so-\d+$/i.test(s)) oid = Number(s.slice(3));
  else if (/^\d+$/.test(s)) oid = Number(s);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const rawPm =
    paymentMethod == null || String(paymentMethod).trim() === ""
      ? null
      : String(paymentMethod).trim().toLowerCase();
  if (rawPm != null && !SALES_ORDER_PAYMENT_METHOD_CODES.has(rawPm)) {
    const e = new Error(
      `payment_method inválido: use ${Array.from(SALES_ORDER_PAYMENT_METHOD_CODES).sort().join(", ")} o null`
    );
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rowCount } = await pool.query(
    `UPDATE sales_orders
     SET payment_method = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [rawPm, oid]
  );
  if (!rowCount) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    throw e;
  }

  return getSalesOrderById(`so-${oid}`);
}

/**
 * GET /api/sales/:id — acepta id numérico (sales_orders), `so-N` o `pos-N` (vista unificada).
 */
async function getSalesOrderById(rawId) {
  const s = rawId != null ? String(rawId).trim() : "";
  if (!s) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (/^pos-\d+$/i.test(s)) {
    const num = Number(s.slice(4));
    return getPosSaleUnifiedDetail(num, { responseId: s });
  }
  if (/^so-\d+$/i.test(s)) {
    const num = Number(s.slice(3));
    return fetchSalesOrderOmnichannelDetail(num, { responseId: s });
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return fetchSalesOrderOmnichannelDetail(n, {});
  }
  const e = new Error("id inválido");
  e.code = "BAD_REQUEST";
  throw e;
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
  /** Filtro opcional por etapa ML (`ml_orders` vía JOIN). Vacío = todas. */
  lifecycleStage,
}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const lcRaw = lifecycleStage != null ? String(lifecycleStage).trim() : "";
  let lifecycleFilterParam = null;
  if (lcRaw !== "") {
    if (!LIFECYCLE_STAGE_VALUES.has(lcRaw)) {
      const e = new Error(
        `lifecycle_stage inválido: use ${Array.from(LIFECYCLE_STAGE_VALUES).join(", ")}`
      );
      e.code = "BAD_REQUEST";
      throw e;
    }
    lifecycleFilterParam = lcRaw;
  }

  const cond = [];
  const params = [];
  let n = 1;
  const explicitStatus = status != null && String(status).trim() !== "";
  if (excludeCompleted && !explicitStatus) {
    cond.push(`vu.status <> $${n++}`);
    params.push("completed");
  }
  if (source) {
    cond.push(`vu.source = $${n++}`);
    params.push(source);
  }
  if (explicitStatus) {
    cond.push(`vu.status = $${n++}`);
    params.push(status);
  }
  if (from) {
    cond.push(`vu.created_at >= $${n++}`);
    params.push(from);
  }
  if (to) {
    cond.push(`vu.created_at <= $${n++}`);
    params.push(to);
  }
  // Ventana ML: por defecto oculta órdenes con `created_at` (fecha compra ML) muy antigua.
  // Incluye filas cuya fila ERP se actualizó recientemente (`sales_orders.updated_at`): import tardío,
  // webhook o sync — evita que pedidos "nuevos" en ERP queden fuera del listado.
  const mlActiveDays = resolveMlActiveMaxDays();
  const mlDaysParamIdx = n++;
  params.push(String(mlActiveDays));
  cond.push(
    `(vu.source <> 'mercadolibre' OR (
      vu.created_at >= (NOW() - ($${mlDaysParamIdx}::text || ' days')::interval)
      OR (
        vu.source_table = 'sales_orders'
        AND EXISTS (
          SELECT 1 FROM sales_orders so_ml
          WHERE so_ml.id = vu.source_id
            AND so_ml.source = 'mercadolibre'
            AND so_ml.updated_at >= (NOW() - ($${mlDaysParamIdx}::text || ' days')::interval)
        )
      )
    ))`
  );
  const whereVu = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

  const lifecycleStageExpr = `
    CASE
      WHEN vu.source_table = 'sales_orders'
       AND so.source = 'mercadolibre'
       AND mo.order_id IS NOT NULL THEN
        CASE
          WHEN mo.feedback_sale IS NOT NULL AND mo.feedback_purchase IS NULL
            THEN 'waiting_buyer_feedback'
          WHEN mo.feedback_sale IS NULL
            THEN 'waiting_seller_feedback'
          WHEN mo.feedback_sale IS NOT NULL AND mo.feedback_purchase IS NOT NULL
            THEN 'feedback_complete'
          ELSE 'unknown'
        END
      ELSE NULL
    END`;

  const waitingBuyerExpr = `
    CASE
      WHEN vu.source_table = 'sales_orders'
       AND so.source = 'mercadolibre'
       AND mo.order_id IS NOT NULL
       AND mo.feedback_sale IS NOT NULL
       AND mo.feedback_purchase IS NULL
      THEN true ELSE false
    END`;

  const enrichedFrom = `
    FROM v_sales_unified vu
    LEFT JOIN sales_orders so
      ON vu.source_table = 'sales_orders'
     AND vu.source_id = so.id
    LEFT JOIN ml_accounts ma
      ON ma.ml_user_id = so.ml_user_id
    LEFT JOIN ml_orders mo
      ON so.source = 'mercadolibre'
     AND so.ml_user_id IS NOT NULL
     AND so.external_order_id ~ '^[0-9]+-[0-9]+$'
     AND mo.ml_user_id = so.ml_user_id
     AND mo.order_id = split_part(so.external_order_id, '-', 2)::bigint
    LEFT JOIN customers cust ON cust.id = vu.customer_id
    ${whereVu}`;

  const enrichedCte = `
    enriched AS (
      SELECT vu.id, vu.source, vu.external_order_id, vu.customer_id, vu.status,
             vu.order_total_amount, vu.loyalty_points_earned,
             vu.notes, vu.sold_by, vu.created_at,
             so.updated_at AS sales_order_updated_at,
             vu.reconciled_statement_id,
             so.ml_user_id AS ml_user_id,
             ma.nickname AS ml_account_nickname,
             so.fulfillment_type::text AS fulfillment_type,
             so.conversation_id AS chat_id,
             so.rate_type::text AS rate_type,
             so.total_amount_bs,
             so.exchange_rate_bs_per_usd,
             so.payment_method::text AS payment_method,
             CASE
               WHEN vu.source_table = 'sales_orders' THEN (
                 SELECT jsonb_build_object(
                   'source', r.source,
                   'match_level', r.match_level,
                   'resolved_by', r.resolved_by,
                   'created_at', r.created_at,
                   'bank_statement_id', r.bank_statement_id,
                   'payment_attempt_id', r.payment_attempt_id,
                   'bank', CASE WHEN bs.id IS NOT NULL THEN jsonb_build_object(
                     'tx_date', bs.tx_date,
                     'amount', bs.amount,
                     'description', bs.description,
                     'reference_number', bs.reference_number,
                     'payment_type', bs.payment_type
                   ) END,
                   'payment_attempt', CASE WHEN pa.id IS NOT NULL THEN jsonb_build_object(
                     'firebase_url', pa.firebase_url,
                     'extracted_amount_bs', pa.extracted_amount_bs,
                     'extracted_date', pa.extracted_date,
                     'extracted_reference', pa.extracted_reference,
                     'extracted_bank', pa.extracted_bank,
                     'extracted_payment_type', pa.extracted_payment_type
                   ) END
                 )
                 FROM reconciliation_log r
                 LEFT JOIN bank_statements bs ON bs.id = r.bank_statement_id
                 LEFT JOIN payment_attempts pa ON pa.id = r.payment_attempt_id
                 WHERE r.order_id = vu.source_id
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT 1
               )
               ELSE NULL::jsonb
             END AS payment_reconciliation_json,
             COALESCE(
               cust.full_name,
               CASE WHEN mo.raw_json IS NOT NULL
                 THEN NULLIF(TRIM(
                   COALESCE(NULLIF(TRIM(mo.raw_json::json #>> '{buyer,first_name}'), ''), '') ||
                   CASE WHEN NULLIF(TRIM(mo.raw_json::json #>> '{buyer,last_name}'), '') IS NOT NULL
                        THEN ' ' || TRIM(mo.raw_json::json #>> '{buyer,last_name}')
                        ELSE '' END
                 ), '')
                 ELSE NULL END,
               CASE WHEN mo.raw_json IS NOT NULL
                 THEN mo.raw_json::json #>> '{buyer,nickname}'
                 ELSE NULL END
             ) AS customer_name,
             NULLIF(
               TRIM(
                 CONCAT_WS(
                   ' / ',
                   NULLIF(TRIM(cust.phone), ''),
                   NULLIF(TRIM(cust.phone_2), ''),
                   NULLIF(TRIM(cust.alternative_phone), '')
                 )
               ),
               ''
             ) AS customer_phones_line,
             cust.primary_ml_buyer_id AS customer_primary_ml_buyer_id,
             (${lifecycleStageExpr}) AS lifecycle_stage,
             (${waitingBuyerExpr}) AS waiting_buyer_feedback,
             -- Preview de ítems (máx 3):
             --   ML raw_json (inmediato desde webhook) > sales_order_items (ERP omnichannel) > sale_lines (POS)
             CASE
               -- ML: extraer ítems directamente del raw_json (misma técnica que linkable-orders)
               WHEN vu.source_table = 'sales_orders' AND mo.raw_json IS NOT NULL
               THEN (
                 SELECT json_agg(
                   json_build_object(
                     'sku',       COALESCE(
                                    NULLIF(item_el #>> '{item,seller_sku}', ''),
                                    NULLIF(item_el #>> '{item,seller_custom_field}', ''),
                                    item_el #>> '{item,id}'
                                  ),
                     'name',      COALESCE(
                                    NULLIF(TRIM(item_el #>> '{item,title}'), ''),
                                    item_el #>> '{item,id}'
                                  ),
                     'qty',       CASE
                                    WHEN (item_el ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
                                    THEN (item_el ->> 'quantity')::numeric
                                    ELSE 1
                                  END,
                     'unit_price_usd', NULL,
                     'image_url', COALESCE(
                                    NULLIF(TRIM(ml_th.thumbnail), ''),
                                    NULLIF(item_el #>> '{item,thumbnail}', ''),
                                    NULLIF(item_el #>> '{item,secure_thumbnail}', '')
                                  )
                   ) ORDER BY t.ord
                 )
                 FROM json_array_elements((mo.raw_json::json) -> 'order_items')
                      WITH ORDINALITY AS t(item_el, ord)
                 LEFT JOIN ml_listings ml_th
                   ON ml_th.item_id = NULLIF(TRIM(t.item_el #>> '{item,id}'), '')
                 WHERE t.ord <= 3
               )
               -- ERP omnicanal: sales_order_items (POS social, mostrador omnichannel)
               WHEN vu.source_table = 'sales_orders'
                AND EXISTS (SELECT 1 FROM sales_order_items WHERE sales_order_id = vu.source_id LIMIT 1)
               THEN (
                 SELECT json_agg(
                   json_build_object(
                     'sku', soi.sku, 'name', COALESCE(p.name, soi.sku),
                     'qty', soi.quantity, 'unit_price_usd', soi.unit_price_usd,
                     'image_url', mll.thumbnail
                   ) ORDER BY soi.id
                 )
                 FROM (SELECT * FROM sales_order_items WHERE sales_order_id = vu.source_id ORDER BY id LIMIT 3) soi
                 LEFT JOIN products p ON p.sku = soi.sku
                 LEFT JOIN ml_publications mpub ON mpub.product_id = p.id
                 LEFT JOIN ml_listings mll ON mll.item_id = mpub.ml_item_id
               )
               -- POS mostrador: sale_lines
               WHEN vu.source_table = 'sales'
               THEN (
                 SELECT json_agg(
                   json_build_object(
                     'sku', sl.product_sku, 'name', COALESCE(p.name, sl.product_sku),
                     'qty', sl.quantity, 'unit_price_usd', sl.unit_price_usd,
                     'image_url', NULL
                   ) ORDER BY sl.id
                 )
                 FROM (SELECT * FROM sale_lines WHERE sale_id = vu.source_id ORDER BY id LIMIT 3) sl
                 LEFT JOIN products p ON p.sku = sl.product_sku
               )
               ELSE NULL
             END AS items_preview_json,
             -- Cotización activa vinculada (solo sales_orders)
             CASE
               WHEN vu.source_table = 'sales_orders'
               THEN (
                 SELECT json_build_object(
                   'id', ip.id,
                   'total', ip.total,
                   'status', ip.status,
                   'items_count', (
                     SELECT COUNT(*)::int FROM inventario_detallepresupuesto WHERE presupuesto_id = ip.id
                   ),
                   'items_preview', (
                     SELECT json_agg(
                       json_build_object(
                         'sku', COALESCE(p2.sku, ''),
                         'name', COALESCE(p2.name, ''),
                         'qty', idp.cantidad,
                         'unit_price_usd', idp.precio_unitario,
                         'image_url', mll2.thumbnail
                       ) ORDER BY idp.id
                     )
                     FROM (
                       SELECT * FROM inventario_detallepresupuesto
                       WHERE presupuesto_id = ip.id ORDER BY id LIMIT 3
                     ) idp
                     LEFT JOIN products p2 ON p2.id = idp.producto_id
                     LEFT JOIN ml_publications mpub2 ON mpub2.product_id = p2.id
                     LEFT JOIN ml_listings mll2 ON mll2.item_id = mpub2.ml_item_id
                   )
                 )
                 FROM inventario_presupuesto ip
                 WHERE ip.sales_order_id = vu.source_id
                   AND ip.status NOT IN ('converted', 'expired')
                 ORDER BY ip.fecha_creacion DESC
                 LIMIT 1
               )
               ELSE NULL
             END AS quote_preview_json,
             CASE
               WHEN vu.source_table = 'sales_orders'
                AND so.source = 'mercadolibre'
                AND so.external_order_id ~ '^[0-9]+-[0-9]+$'
               THEN split_part(so.external_order_id, '-', 2)::bigint
               ELSE NULL
             END AS ml_api_order_id,
             mo.feedback_sale AS ml_feedback_sale,
             mo.feedback_purchase AS ml_feedback_purchase,
             mo.raw_json::json->>'site_id' AS ml_site_id
      ${enrichedFrom}
    )`;

  const lcIdx = n;
  const filteredCte = `
    filtered AS (
      SELECT * FROM enriched e
      WHERE ($${lcIdx}::text IS NULL OR trim(COALESCE($${lcIdx}::text, '')) = '' OR e.lifecycle_stage = $${lcIdx}::text)
    )`;

  const baseParams = params.slice();
  const paramsWithLc = [...baseParams, lifecycleFilterParam];
  const limitIdx = lcIdx + 1;
  const offsetIdx = lcIdx + 2;
  const paramsList = [...paramsWithLc, lim, off];

  try {
    const { rows } = await pool.query(
      `WITH ${enrichedCte},
            ${filteredCte}
       SELECT e.id, e.source, e.external_order_id, e.customer_id, e.status,
              e.order_total_amount, e.loyalty_points_earned,
              e.notes, e.sold_by, e.created_at,
              e.reconciled_statement_id,
              e.ml_user_id,
              e.ml_account_nickname,
              e.fulfillment_type,
              e.chat_id,
              e.rate_type,
              e.total_amount_bs,
              e.exchange_rate_bs_per_usd,
              e.payment_method,
              e.payment_reconciliation_json,
              e.customer_name,
              e.customer_phones_line,
              e.customer_primary_ml_buyer_id,
              e.lifecycle_stage,
              e.waiting_buyer_feedback,
              e.items_preview_json,
              e.quote_preview_json,
              e.ml_api_order_id,
              e.ml_feedback_sale,
              e.ml_feedback_purchase,
              e.ml_site_id
       FROM filtered e
       ORDER BY e.created_at DESC NULLS LAST, e.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      paramsList
    );
    const { rows: countRows } = await pool.query(
      `WITH ${enrichedCte},
            ${filteredCte}
       SELECT COUNT(*)::bigint AS c FROM filtered`,
      paramsWithLc
    );
    const { rows: sumRows } = await pool.query(
      `WITH ${enrichedCte}
       SELECT
         COALESCE(SUM(CASE WHEN e.lifecycle_stage = 'waiting_buyer_feedback' THEN 1 ELSE 0 END), 0)::int
           AS waiting_buyer_feedback,
         COALESCE(SUM(CASE WHEN e.lifecycle_stage = 'waiting_seller_feedback' THEN 1 ELSE 0 END), 0)::int
           AS waiting_seller_feedback,
         COALESCE(SUM(CASE WHEN e.lifecycle_stage = 'feedback_complete' THEN 1 ELSE 0 END), 0)::int
           AS feedback_complete
       FROM enriched e
       WHERE e.lifecycle_stage IS NOT NULL`,
      baseParams
    );
    const s0 = sumRows[0] || {};
    const wbf = Number(s0.waiting_buyer_feedback) || 0;
    const wsf = Number(s0.waiting_seller_feedback) || 0;
    const fc = Number(s0.feedback_complete) || 0;
    const lifecycle_summary = {
      waiting_buyer_feedback: wbf,
      waiting_seller_feedback: wsf,
      feedback_complete: fc,
      total_active: wbf + wsf + fc,
    };

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
          reconciled_statement_id:
            o.reconciled_statement_id != null ? Number(o.reconciled_statement_id) : null,
          payment_reconciliation: (() => {
            const j = o.payment_reconciliation_json;
            if (j == null) return null;
            if (typeof j === "string") {
              try {
                return JSON.parse(j);
              } catch {
                return null;
              }
            }
            return typeof j === "object" ? j : null;
          })(),
          ml_user_id:
            o.ml_user_id != null && Number.isFinite(Number(o.ml_user_id))
              ? Number(o.ml_user_id)
              : null,
          ml_account_nickname:
            o.ml_account_nickname != null && String(o.ml_account_nickname).trim() !== ""
              ? String(o.ml_account_nickname).trim()
              : null,
          lifecycle_stage: o.lifecycle_stage != null ? String(o.lifecycle_stage) : null,
          waiting_buyer_feedback: Boolean(o.waiting_buyer_feedback),
          fulfillment_type:
            o.fulfillment_type != null && String(o.fulfillment_type).trim() !== ""
              ? String(o.fulfillment_type).trim()
              : null,
          chat_id:
            o.chat_id != null && String(o.chat_id).trim() !== ""
              ? Number(o.chat_id)
              : null,
          rate_type: o.rate_type != null ? String(o.rate_type) : null,
          total_amount_bs:
            o.total_amount_bs != null && Number.isFinite(Number(o.total_amount_bs))
              ? Number(o.total_amount_bs)
              : null,
          exchange_rate_bs_per_usd:
            o.exchange_rate_bs_per_usd != null && Number.isFinite(Number(o.exchange_rate_bs_per_usd))
              ? Number(o.exchange_rate_bs_per_usd)
              : null,
          payment_method:
            o.payment_method != null && String(o.payment_method).trim() !== ""
              ? String(o.payment_method).trim().toLowerCase()
              : null,
          customer_name:
            o.customer_name != null && String(o.customer_name).trim() !== ""
              ? String(o.customer_name).trim()
              : null,
          customer_phones_line:
            o.customer_phones_line != null && String(o.customer_phones_line).trim() !== ""
              ? String(o.customer_phones_line).trim()
              : null,
          customer_primary_ml_buyer_id:
            o.customer_primary_ml_buyer_id != null &&
            Number.isFinite(Number(o.customer_primary_ml_buyer_id)) &&
            Number(o.customer_primary_ml_buyer_id) > 0
              ? Number(o.customer_primary_ml_buyer_id)
              : null,
          items_preview: Array.isArray(o.items_preview_json)
            ? o.items_preview_json
            : (o.items_preview_json != null ? o.items_preview_json : null),
          quote_preview: o.quote_preview_json != null ? o.quote_preview_json : null,
          ml_api_order_id:
            o.ml_api_order_id != null && Number.isFinite(Number(o.ml_api_order_id))
              ? Number(o.ml_api_order_id)
              : null,
          ml_feedback_sale:
            o.ml_feedback_sale != null && String(o.ml_feedback_sale).trim() !== ""
              ? String(o.ml_feedback_sale).trim()
              : null,
          ml_feedback_purchase:
            o.ml_feedback_purchase != null && String(o.ml_feedback_purchase).trim() !== ""
              ? String(o.ml_feedback_purchase).trim()
              : null,
          ml_site_id:
            o.ml_site_id != null && String(o.ml_site_id).trim() !== ""
              ? String(o.ml_site_id).trim().toUpperCase()
              : null,
        };
      }),
      total: Number(countRows[0].c),
      limit: lim,
      offset: off,
      lifecycle_summary,
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
              COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0)::numeric AS order_total_sum,
              COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0)::numeric AS total_amount_bs
       FROM v_sales_unified
       ${where}
       GROUP BY source
       ORDER BY source`,
      params
    );
    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0)::numeric AS order_total_sum,
              COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0)::numeric AS total_amount_bs,
              COUNT(*)::bigint AS order_count
       FROM v_sales_unified ${where}`,
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
      if (cur === "pending_cash_approval") {
        await client.query(
          `UPDATE manual_transactions
           SET approval_status = 'cancelled'
           WHERE order_id = $1 AND approval_status = 'pending'`,
          [oid]
        );
        if (appliesStock) {
          await incrementStockFromOrderLines(client, items);
        }
        await client.query(`UPDATE sales_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [oid]);
      } else if (cur === "pending") {
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
    return fetchSalesOrderOmnichannelDetail(oid);
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
  const r1 = await client.query(
    `SELECT id FROM customers WHERE primary_ml_buyer_id = $1 AND is_active = TRUE LIMIT 1`,
    [bid]
  );
  if (r1.rows.length) return Number(r1.rows[0].id);
  try {
    const r2 = await client.query(
      `SELECT cmb.customer_id
       FROM customer_ml_buyers cmb
       INNER JOIN customers c ON c.id = cmb.customer_id AND c.is_active = TRUE
       WHERE cmb.ml_buyer_id = $1
       LIMIT 1`,
      [bid]
    );
    if (r2.rows.length) return Number(r2.rows[0].customer_id);
  } catch (e) {
    if (e && e.code !== "42P01") throw e;
  }
  return null;
}

/**
 * Cumple `chk_phone_format` en `customers.phone` / `phone_2`: solo dígitos, 7–15.
 * Si ML trae formato no normalizable, devuelve null (se inserta sin teléfono; el buyer_id queda en notes).
 */
function sanitizeMlBuyerPhoneForCustomers(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const viaNorm = normalizePhone(s);
  if (viaNorm && viaNorm.length >= 7 && viaNorm.length <= 15) return viaNorm;
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length >= 7 && digits.length <= 15) return digits;
  return null;
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
  const p1 = sanitizeMlBuyerPhoneForCustomers(b.phone_1);
  const p2 = sanitizeMlBuyerPhoneForCustomers(b.phone_2);
  const nameFromMl =
    (b.nombre_apellido && String(b.nombre_apellido).trim()) ||
    (b.nickname && String(b.nickname).trim()) ||
    `Comprador ML ${bid}`;

  const hasPhone2Col = await customersHasPhone2Column(client);
  const raw2 = b.phone_2 != null ? String(b.phone_2).trim() : "";
  const notesBase = `Auto ML buyer_id=${bid}`;
  let notesWithAlt = notesBase;
  if (!hasPhone2Col) {
    if (p2) notesWithAlt = `${notesBase} | tel2 ML: ${p2}`;
    else if (raw2) notesWithAlt = `${notesBase} | tel2 ML (sin formato BD): ${raw2.slice(0, 120)}`;
  }

  const linkMlBuyerRow = async (existingCid) => {
    await client.query(
      `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
      [existingCid, bid]
    );
  };

  const upsertExistingCustomer = async (existingCid) => {
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
        [existingCid, p1, p2, nameFromMl, bid]
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
        [existingCid, p1, nameFromMl, bid]
      );
    }
    await linkMlBuyerRow(existingCid);
  };

  let cid = await resolveCustomerIdFromMlBuyer(client, bid);
  if (cid != null) {
    await upsertExistingCustomer(cid);
    return cid;
  }

  let ins;
  try {
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
  } catch (e) {
    if (e && e.code === "23505") {
      cid = await resolveCustomerIdFromMlBuyer(client, bid);
      if (cid != null) {
        await upsertExistingCustomer(cid);
        return cid;
      }
    }
    throw e;
  }
  cid = Number(ins.rows[0].id);
  await linkMlBuyerRow(cid);
  return cid;
}

/**
 * Extrae los fees de una orden ML desde su raw_json.
 * Los campos son opcionales — ML no siempre los incluye según el tipo de envío y cuenta.
 *
 * @param {string|object|null} rawJson  Texto JSON o objeto ya parseado de ml_orders.raw_json.
 * @returns {{ saleFee, shippingCost, taxes, payout }|null}  null si no parseable.
 */
function extractMlOrderFees(rawJson) {
  if (!rawJson) return null;
  try {
    const order = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    const payment = Array.isArray(order.payments) ? order.payments[0] : null;

    // Comisión ML: buscar en fee_details (ml_fee) o en sale_fee directo del payment
    const feeDetails = Array.isArray(payment?.fee_details) ? payment.fee_details : [];
    const feeEntry = feeDetails.find((f) => f.type === "ml_fee" || f.type === "coupon");
    const saleFee =
      feeEntry?.amount != null
        ? Number(feeEntry.amount)
        : payment?.sale_fee != null
          ? Number(payment.sale_fee)
          : null;

    // Envío cobrado al vendedor
    const shippingRaw = order.shipping?.cost;
    const shippingCost = shippingRaw != null ? Number(shippingRaw) : null;

    // Retenciones fiscales
    const taxesRaw = order.taxes?.amount;
    const taxes = taxesRaw != null ? Number(taxesRaw) : null;

    // Neto: lo que efectivamente paga ML al vendedor
    const totalPaid =
      payment?.total_paid_amount != null
        ? Number(payment.total_paid_amount)
        : Number(order.total_amount ?? 0);

    const payout =
      totalPaid - (saleFee ?? 0) - (shippingCost ?? 0) - (taxes ?? 0);

    return {
      saleFee:      saleFee      != null && Number.isFinite(saleFee)      ? saleFee      : null,
      shippingCost: shippingCost != null && Number.isFinite(shippingCost) ? shippingCost : null,
      taxes:        taxes        != null && Number.isFinite(taxes)        ? taxes        : null,
      payout:       Number.isFinite(payout) ? Number(payout.toFixed(2)) : null,
    };
  } catch (_) {
    return null;
  }
}

function mlStatusToSalesStatus(mlStatus, feedbackSale = null, dateCreated = null) {
  const s = String(mlStatus || "")
    .toLowerCase()
    .trim();
  if (["cancelled", "invalid", "refunded", "partially_refunded"].includes(s)) {
    return "cancelled";
  }
  if (s === "confirmed") {
    const isPositive = String(feedbackSale || "")
      .toLowerCase()
      .trim() === "positive";
    if (isPositive) return "completed";
    const isOld = dateCreated
      ? Date.now() - new Date(dateCreated).getTime() > 10 * 24 * 60 * 60 * 1000
      : false;
    return isOld ? "completed" : "paid";
  }
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
/**
 * @param {{ mlUserId: number, orderId: number, force?: boolean }} p
 *   `force = true` omite el corte de antigüedad (`too_old_ml_order`). Usar siempre que el origen
 *   sea un evento activo de ML (webhook `orders_v2`, feedback, reconciliación explícita) para evitar
 *   órdenes huérfanas cuando la orden tiene más días que `SALES_ML_ACTIVE_MAX_DAYS`.
 */
async function importSalesOrderFromMlOrder({ mlUserId, orderId, force = false }) {
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
      `SELECT ml_user_id, order_id, status, total_amount, buyer_id, date_created, feedback_sale, raw_json
       FROM ml_orders WHERE ml_user_id = $1 AND order_id = $2`,
      [mUid, oid]
    );
    if (!mrows.length) {
      await client.query("ROLLBACK");
      const e = new Error("Orden ML no encontrada en ml_orders");
      e.code = "NOT_FOUND";
      throw e;
    }
    const ml = mrows[0];
    // El corte de antigüedad solo aplica al import automático/en lote.
    // Con force=true (webhook activo, reconciliación explícita) se importa siempre.
    if (!force && ml.date_created) {
      const mlActiveDays = resolveMlActiveMaxDays();
      const ageMs = Date.now() - new Date(ml.date_created).getTime();
      const maxMs = mlActiveDays * 24 * 60 * 60 * 1000;
      if (Number.isFinite(ageMs) && ageMs > maxMs) {
        await client.query("ROLLBACK");
        return {
          skipped: true,
          reason: "too_old_ml_order",
          max_days: mlActiveDays,
          ml_user_id: mUid,
          order_id: oid,
          date_created: ml.date_created,
        };
      }
    }
    const customerId = await ensureCustomerAndLinkMlBuyer(client, ml.buyer_id);

    const dup = await client.query(
      `SELECT id FROM sales_orders WHERE source = 'mercadolibre' AND external_order_id = $1`,
      [extId]
    );
    if (dup.rows.length) {
      await client.query("COMMIT");
      const existing = await fetchSalesOrderOmnichannelDetail(dup.rows[0].id);
      return { ...existing, idempotent: true, import: "ml" };
    }
    let totalUsd = Number(ml.total_amount);
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      totalUsd = 0.01;
    }
    const st = mlStatusToSalesStatus(ml.status, ml.feedback_sale, ml.date_created);
    const lifecycle = lifecycleStatusFromSalesStatus(st);
    const mlStatusRaw = String(ml.status || "").trim() || null;
    const ratingDays = Math.max(1, parseInt(process.env.ML_RATING_DEADLINE_DAYS || "30", 10) || 30);
    const notes = `Import ml_orders ml_user_id=${mUid} order_id=${oid}`;

    const mlOrderDate = ml.date_created
      ? new Date(ml.date_created).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // CH-3 ML Venezuela: total_amount ya está en VES nativo (pese al nombre "totalUsd").
    // total_amount_bs = valor directo, rate = 1, sin multiplicar por BCV.
    // ADR-008 regla 3. Para futuros canales ML en USD, agregar lógica de BCV aquí.
    const rateApplied = 1;
    const rateType    = "NATIVE_VES";
    const rateDate    = mlOrderDate;
    const totalBs     = Number(totalUsd.toFixed(2));

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

    const channelId = SOURCE_TO_CHANNEL["mercadolibre"] || 3;

    // Lookup best-effort de chat CRM vinculado al comprador ML
    const mlConvId = await lookupMlConversation({ buyerId: ml.buyer_id, customerId });

    const hasLifecycle = await salesOrdersHasLifecycleColumns(client);
    const hasLegacyTotalUsd = await salesOrdersHasTotalAmountUsdColumn(client);
    const amtPairCols =
      "order_total_amount" + (hasLegacyTotalUsd ? ", total_amount_usd,\n          " : ",\n          ");
    const amtPairVals =
      (hasLegacyTotalUsd ? "$5, $5,\n          " : "$5,\n          ");
    let ins;
    const mlCreatedAt = ml.date_created || null;
    if (hasLifecycle) {
      ins = await client.query(
        `INSERT INTO sales_orders (source, external_order_id, customer_id, channel_id, status, ${amtPairCols}total_amount_bs, exchange_rate_bs_per_usd, rate_type, rate_date,
          notes, sold_by, applies_stock, records_cash, ml_user_id, loyalty_points_earned,
          lifecycle_status, ml_status, rating_deadline_at, conversation_id, created_at, fulfillment_type)
         VALUES ('mercadolibre', $1, $2, $3, $4, ${amtPairVals}$6, $7, $8, $9::date,
          $10, NULL, FALSE, FALSE, $11, $12,
          $13, $14, NOW() + ($15::text || ' days')::interval, $16, COALESCE($17::timestamptz, NOW()), 'retiro_tienda')
         RETURNING id`,
        [
          extId,
          customerId,
          channelId,
          st,
          totalUsd.toFixed(2),
          totalBs != null ? totalBs.toFixed(2) : null,
          rateApplied,
          rateType,
          rateDate,
          notes,
          mUid,
          loyaltyPoints,
          lifecycle,
          mlStatusRaw,
          String(ratingDays),
          mlConvId,
          mlCreatedAt,
        ]
      );
    } else {
      ins = await client.query(
        `INSERT INTO sales_orders (source, external_order_id, customer_id, channel_id, status, ${amtPairCols}total_amount_bs, exchange_rate_bs_per_usd, rate_type, rate_date,
          notes, sold_by, applies_stock, records_cash, ml_user_id, loyalty_points_earned,
          conversation_id, created_at, fulfillment_type)
         VALUES ('mercadolibre', $1, $2, $3, $4, ${amtPairVals}$6, $7, $8, $9::date,
          $10, NULL, FALSE, FALSE, $11, $12,
          $13, COALESCE($14::timestamptz, NOW()), 'retiro_tienda')
         RETURNING id`,
        [
          extId,
          customerId,
          channelId,
          st,
          totalUsd.toFixed(2),
          totalBs != null ? totalBs.toFixed(2) : null,
          rateApplied,
          rateType,
          rateDate,
          notes,
          mUid,
          loyaltyPoints,
          mlConvId,
          mlCreatedAt,
        ]
      );
    }
    const salesId = ins.rows[0].id;

    await client.query("COMMIT");

    // ── Best-effort: poblar fees ML (columnas pueden no existir aún si la migración no corrió) ──
    try {
      const fees = extractMlOrderFees(ml.raw_json);
      if (fees) {
        await pool.query(
          `UPDATE sales_orders
           SET ml_sale_fee_usd      = $1,
               ml_shipping_cost_usd = $2,
               ml_taxes_usd         = $3,
               ml_payout_usd        = $4
           WHERE id = $5`,
          [fees.saleFee, fees.shippingCost, fees.taxes, fees.payout, salesId]
        );
      }
    } catch (_feesErr) {
      // Columnas no existen aún → ejecutar: npm run db:ml-order-fees
    }

    try {
      const out = await fetchSalesOrderOmnichannelDetail(salesId);
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
        const existing = await fetchSalesOrderOmnichannelDetail(r.rows[0].id);
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

function mlFeedbackPostErrorMessage(mlRes) {
  const d = mlRes && mlRes.data;
  if (d && typeof d === "object") {
    if (d.message != null) return String(d.message);
    if (d.error != null) return String(d.error);
    if (d.cause && typeof d.cause === "object" && d.cause.message != null) {
      return String(d.cause.message);
    }
  }
  const t = mlRes && typeof mlRes.rawText === "string" ? mlRes.rawText : "";
  return t ? t.slice(0, 400) : mlRes && mlRes.status != null ? `HTTP ${mlRes.status}` : "Error ML";
}

/**
 * POST `…/orders/{id}/feedback` — calificación del **vendedor hacia el comprador** (API ML).
 *
 * @param {{ mlUserId: number, orderId: number, fulfilled?: boolean, rating?: string, message: string, reason?: string, restock_item?: boolean }} p
 */
async function postMlSellerOrderFeedback({
  mlUserId,
  orderId,
  fulfilled = true,
  rating = "positive",
  message,
  reason,
  restock_item,
}) {
  const uid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    const e = new Error("ml_user_id y order_id deben ser números válidos");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const msg = message != null ? String(message).trim() : "";
  if (msg.length < 1 || msg.length > 160) {
    const e = new Error("message: requerido, entre 1 y 160 caracteres");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const f = Boolean(fulfilled);
  const r = String(rating || "positive").trim().toLowerCase();
  if (f && r !== "positive") {
    const e = new Error("Si la venta se cumplió (fulfilled: true), la calificación debe ser positive");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (!f && !["neutral", "negative"].includes(r)) {
    const e = new Error("Si fulfilled es false, rating debe ser neutral o negative");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const body = { fulfilled: f, rating: r, message: msg };
  if (!f) {
    const rs = reason != null ? String(reason).trim() : "";
    if (rs.length < 1) {
      const e = new Error(
        "reason es obligatoria cuando fulfilled es false (p. ej. OUT_OF_STOCK según documentación ML)"
      );
      e.code = "BAD_REQUEST";
      throw e;
    }
    body.reason = rs;
    body.restock_item = Boolean(restock_item);
  }

  const { mercadoLibrePostJsonForUser } = require("../../oauth-token");
  const mlRes = await mercadoLibrePostJsonForUser(uid, `/orders/${oid}/feedback`, body);
  if (!mlRes.ok) {
    const m = mlFeedbackPostErrorMessage(mlRes);
    const e = new Error(m || "Error al enviar calificación a Mercado Libre");
    e.code = "ML_HTTP";
    e.httpStatus =
      Number(mlRes.status) >= 400 && Number(mlRes.status) < 600 ? Number(mlRes.status) : 502;
    e.detail = {
      path: mlRes.path,
      http_status: mlRes.status,
      body_preview: typeof mlRes.rawText === "string" ? mlRes.rawText.slice(0, 800) : null,
    };
    throw e;
  }

  const { fetchAndUpsertOrderFeedback } = require("../../ml-order-feedback-sync");
  const fetchedAt = new Date().toISOString();
  let feedbackRefresh = { ok: false };
  try {
    feedbackRefresh = await fetchAndUpsertOrderFeedback(uid, oid, fetchedAt);
  } catch (fbErr) {
    console.error("[postMlSellerOrderFeedback] fetch feedback post-submit", fbErr);
    feedbackRefresh = {
      ok: false,
      err: fbErr && fbErr.message ? fbErr.message : String(fbErr),
    };
  }

  let salesSync = null;
  try {
    salesSync = await syncMercadolibreSalesAfterMlOrderChange({
      mlUserId: uid,
      orderId: oid,
      force: true,
    });
  } catch (syncErr) {
    console.error("[postMlSellerOrderFeedback] sales sync", syncErr);
    salesSync = { error: syncErr && syncErr.message ? syncErr.message : String(syncErr) };
  }

  return {
    ok: true,
    ml_response: mlRes.data,
    feedback_refresh: feedbackRefresh,
    sales_sync: salesSync,
  };
}

/**
 * Tras cambios en `ml_orders` (webhook, sync órdenes/feedback): asegura fila en `sales_orders` y
 * marca `completed` cuando el vendedor dejó calificación positiva (`feedback_sale`).
 * Requiere migración `completed` en CHECK de `sales_orders` y `SALES_ML_IMPORT_ENABLED=1`.
 */
/**
 * @param {{ mlUserId: number, orderId: number, force?: boolean }} p
 *   `force` se propaga a `importSalesOrderFromMlOrder` para no descartar la orden por antigüedad.
 */
async function syncMercadolibreSalesAfterMlOrderChange({ mlUserId, orderId, force = false }) {
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
    `SELECT feedback_sale, raw_json FROM ml_orders WHERE ml_user_id = $1 AND order_id = $2`,
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
      const imported = await importSalesOrderFromMlOrder({ mlUserId: mUid, orderId: oid, force });
      if (imported && !imported.idempotent) {
        try {
          const sseBroker = require("../realtime/sseBroker");
          sseBroker.broadcast("new_sale", {
            sales_order_id: imported.id,
            ml_user_id: mUid,
            order_id: oid,
            external_order_id:
              imported.external_order_id != null
                ? String(imported.external_order_id)
                : extId,
            source: "ml_orders_webhook_sync",
          });
        } catch (_sse) {
          /* no crítico */
        }
      }
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
  // ── Best-effort: refrescar fees ML en la orden (cubre órdenes ya importadas) ──
  try {
    const fees = extractMlOrderFees(mr.rows[0].raw_json);
    if (fees) {
      await pool.query(
        `UPDATE sales_orders
         SET ml_sale_fee_usd      = $1,
             ml_shipping_cost_usd = $2,
             ml_taxes_usd         = $3,
             ml_payout_usd        = $4
         WHERE source = 'mercadolibre' AND external_order_id = $5`,
        [fees.saleFee, fees.shippingCost, fees.taxes, fees.payout, extId]
      );
    }
  } catch (_) {}

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
  const mlActiveDays = resolveMlActiveMaxDays();
  let whereSql;
  const params = [String(mlActiveDays)];
  if (allAccounts) {
    whereSql = `${ML_ORDERS_REGISTERED_ACCOUNTS_SQL}
      AND (NULLIF(TRIM(date_created::text), '')::timestamptz) >= (NOW() - ($1::text || ' days')::interval)`;
  } else {
    const mUid = Number(mlUserId);
    if (!Number.isFinite(mUid) || mUid <= 0) {
      const e = new Error("ml_user_id inválido (o usá allAccounts: true)");
      e.code = "BAD_REQUEST";
      throw e;
    }
    whereSql = `ml_user_id = $2
      AND (NULLIF(TRIM(date_created::text), '')::timestamptz) >= (NOW() - ($1::text || ' days')::interval)`;
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
    ml_active_max_days: mlActiveDays,
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
  const mlActiveDays = resolveMlActiveMaxDays();
  let whereSql;
  let mUidSingle;
  if (allAccounts) {
    whereSql = `${ML_ORDERS_REGISTERED_ACCOUNTS_SQL}
      AND (NULLIF(TRIM(date_created::text), '')::timestamptz) >= (NOW() - ($1::text || ' days')::interval)`;
  } else {
    mUidSingle = Number(mlUserId);
    if (!Number.isFinite(mUidSingle) || mUidSingle <= 0) {
      const e = new Error("ml_user_id inválido (o usá allAccounts: true)");
      e.code = "BAD_REQUEST";
      throw e;
    }
    whereSql = `ml_user_id = $2
      AND (NULLIF(TRIM(date_created::text), '')::timestamptz) >= (NOW() - ($1::text || ' days')::interval)`;
  }
  const limitOffset = allAccounts ? `LIMIT $2 OFFSET $3` : `LIMIT $3 OFFSET $4`;
  const qParams = allAccounts
    ? [String(mlActiveDays), lim, off]
    : [String(mlActiveDays), mUidSingle, lim, off];
  const { rows } = await pool.query(
    `SELECT ml_user_id, order_id FROM ml_orders WHERE ${whereSql}${clause} ORDER BY id DESC ${limitOffset}`,
    qParams
  );
  const summary = {
    imported: 0,
    idempotent: 0,
    skipped: 0,
    rows_in_batch: rows.length,
    errors: [],
    ml_feedback_filter: mlFeedbackFilter || "none",
    ml_active_max_days: mlActiveDays,
    scope: allAccounts ? "all_accounts" : "single",
    ml_user_id: allAccounts ? null : Number(mlUserId),
  };
  for (const r of rows) {
    try {
      const out = await importSalesOrderFromMlOrder({ mlUserId: r.ml_user_id, orderId: r.order_id });
      if (out && out.skipped) {
        summary.skipped++;
      } else if (out && out.idempotent) {
        summary.idempotent++;
      } else {
        summary.imported++;
      }
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

/**
 * Encuentra filas de `ml_orders` que no tienen `sales_orders` correspondiente e importa cada una.
 *
 * Casos cubiertos que el import automático por webhook podría haber perdido:
 *  - Servidor caído durante el webhook.
 *  - `SALES_ML_IMPORT_ENABLED` no estaba activo al momento del hook.
 *  - Orden descartada por `too_old_ml_order` en el import automático.
 *  - Error en el import que dejó la orden sin fila en ERP.
 *
 * @param {{ mlUserId?: number, allAccounts?: boolean, dryRun?: boolean, limit?: number, verbose?: boolean, onProgress?: (p: { current: number, total: number, ml_user_id: number, order_id: number|string }) => void }} p
 *   - `allAccounts: true` procesa todas las cuentas registradas en `ml_accounts`.
 *   - `dryRun: true` solo lista los huérfanos sin importar.
 *   - `limit` máximo de órdenes a procesar por llamada (default 200, máx 1000).
 *   - `verbose` / `onProgress`: feedback durante el import (CLI); en HTTP suele ir en false.
 */
async function reconcileMlSalesOrphans({
  mlUserId,
  allAccounts = false,
  dryRun = false,
  limit = 200,
  verbose = false,
  onProgress,
} = {}) {
  if (!dryRun && process.env.SALES_ML_IMPORT_ENABLED !== "1") {
    const e = new Error("Import ML desactivado (SALES_ML_IMPORT_ENABLED=1)");
    e.code = "IMPORT_DISABLED";
    throw e;
  }
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  let whereSql;
  const qParams = [];
  let n = 1;

  if (allAccounts) {
    whereSql = `${ML_ORDERS_REGISTERED_ACCOUNTS_SQL}`;
  } else {
    const mUid = Number(mlUserId);
    if (!Number.isFinite(mUid) || mUid <= 0) {
      const e = new Error("ml_user_id inválido (o usá allAccounts: true)");
      e.code = "BAD_REQUEST";
      throw e;
    }
    whereSql = `ml_user_id = $${n++}`;
    qParams.push(mUid);
  }

  // Busca órdenes en ml_orders sin fila correspondiente en sales_orders.
  // external_order_id en sales_orders = "{ml_user_id}-{order_id}".
  const { rows: orphans } = await pool.query(
    `SELECT mo.ml_user_id, mo.order_id, mo.status, mo.date_created
     FROM ml_orders mo
     WHERE ${whereSql}
       AND NOT EXISTS (
         SELECT 1 FROM sales_orders so
         WHERE so.source = 'mercadolibre'
           AND so.external_order_id = (mo.ml_user_id::text || '-' || mo.order_id::text)
       )
       AND mo.status IS NOT NULL
       AND mo.status NOT IN ('cancelled', 'invalid')
     ORDER BY mo.id DESC
     LIMIT $${n++}`,
    [...qParams, lim]
  );

  const summary = {
    orphans_found: orphans.length,
    imported: 0,
    skipped: 0,
    errors: [],
    dry_run: dryRun,
    scope: allAccounts ? "all_accounts" : "single",
    ml_user_id: allAccounts ? null : Number(mlUserId),
  };

  if (dryRun) {
    summary.sample = orphans.slice(0, 20).map((r) => ({
      ml_user_id: r.ml_user_id,
      order_id: r.order_id,
      status: r.status,
      date_created: r.date_created,
    }));
    return summary;
  }

  const total = orphans.length;
  let sseBroker = null;
  try {
    sseBroker = require("../realtime/sseBroker");
  } catch (_) {
    /* sin SSE en scripts / tests */
  }

  for (let i = 0; i < orphans.length; i++) {
    const r = orphans[i];
    const current = i + 1;
    const prog = { current, total, ml_user_id: r.ml_user_id, order_id: r.order_id };
    if (typeof onProgress === "function") {
      try {
        onProgress(prog);
      } catch (_p) {}
    } else if (verbose) {
      const line = `[reconcile] (${current}/${total}) importando ml_user_id=${r.ml_user_id} order_id=${r.order_id}`;
      if (typeof process !== "undefined" && process.stdout && process.stdout.isTTY) {
        process.stdout.write(`\r${line.padEnd(88)}`);
      } else {
        console.log(line);
      }
    }
    try {
      const out = await importSalesOrderFromMlOrder({
        mlUserId: r.ml_user_id,
        orderId: r.order_id,
        force: true,
      });
      if (out && out.skipped) {
        summary.skipped++;
      } else {
        summary.imported++;
        if (sseBroker && typeof sseBroker.broadcast === "function") {
          try {
            sseBroker.broadcast("new_sale", {
              sales_order_id: out.id,
              ml_user_id: r.ml_user_id,
              order_id: r.order_id,
              external_order_id: `${r.ml_user_id}-${r.order_id}`,
              source: "ml_reconcile_orphans",
            });
          } catch (_) {}
        }
      }
    } catch (err) {
      // NOT_FOUND en ml_orders (borrada?) o error de constraint: anotar y continuar.
      summary.errors.push({
        ml_user_id: r.ml_user_id,
        order_id: r.order_id,
        message: String(err && err.message),
        code: err && err.code,
      });
    }
  }
  if (verbose && total > 0 && typeof process !== "undefined" && process.stdout && process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  return summary;
}

/**
 * Intenta vincular una orden ML a un crm_chat existente.
 *
 * Estrategia (en orden de preferencia):
 * 1. customer_id directo en crm_chats (más confiable)
 * 2. Fallback por phone: ml_buyers.phone_1 normalizado a E.164 Venezuela (+58XXXXXXXXX)
 *    vs crm_chats.phone  (solo si Estrategia 1 falla)
 *
 * Retorna null si no encuentra match · nunca lanza excepción.
 *
 * @param {{ buyerId: string|number|null, customerId: number|null }} param
 * @returns {Promise<number|null>}
 */
async function lookupMlConversation({ buyerId, customerId }) {
  try {
    // Estrategia 1 · customer_id directo (más preciso)
    if (customerId) {
      const r1 = await pool.query(
        `SELECT id FROM crm_chats
         WHERE customer_id = $1
         ORDER BY updated_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [customerId]
      );
      if (r1.rowCount > 0) return r1.rows[0].id;
    }

    // Estrategia 2 · phone de ml_buyers normalizado a E.164 Venezuela
    if (buyerId) {
      const buyerIdNum = Number(buyerId);
      const rBuyer = Number.isFinite(buyerIdNum)
        ? await pool.query(
            `SELECT phone_1 FROM ml_buyers WHERE buyer_id = $1 AND phone_1 IS NOT NULL LIMIT 1`,
            [buyerIdNum]
          )
        : { rowCount: 0, rows: [] };
      if (rBuyer.rowCount > 0) {
        const raw = String(rBuyer.rows[0].phone_1 || "").replace(/\D/g, "");
        // Normalizar 04XXXXXXXXX → +584XXXXXXXXX
        const e164 =
          raw.length === 11 && raw.startsWith("0")
            ? `+58${raw.slice(1)}`
            : raw.length === 10
            ? `+58${raw}`
            : raw.startsWith("58") && raw.length === 12
            ? `+${raw}`
            : null;
        if (e164) {
          const r2 = await pool.query(
            `SELECT id FROM crm_chats
             WHERE phone = $1
             ORDER BY updated_at DESC NULLS LAST, id DESC
             LIMIT 1`,
            [e164]
          );
          if (r2.rowCount > 0) return r2.rows[0].id;
        }
      }
    }
  } catch (err) {
    // Lookup no debe bloquear la creación de la orden
    console.warn("[lookupMlConversation] error:", err.message);
  }
  return null;
}

module.exports = {
  LIFECYCLE_STAGE_VALUES,
  createOrder,
  createSalesOrder,
  getSalesOrderById,
  listSalesOrders,
  getSalesStats,
  patchSalesOrderStatus,
  patchSalesOrderFulfillmentType,
  patchSalesOrderPaymentMethod,
  importSalesOrderFromMlOrder,
  importSalesOrdersFromMlTable,
  reconcileMlSalesOrphans,
  previewMlOrdersImport,
  postMlSellerOrderFeedback,
  syncMercadolibreSalesAfterMlOrderChange,
  ensureCustomerAndLinkMlBuyer,
  mapErr,
  incrementStockFromOrderLines,
  fetchOrderItems,
};
