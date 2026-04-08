"use strict";

const pino = require("pino");
const { pool, getMlBuyer, updateMlBuyerPhones } = require("../../db");
const { normalizePhone } = require("../utils/phoneNormalizer");
const { normalizePhoneToE164 } = require("../../ml-whatsapp-phone");
const { trySendWhatsappTipoEForOrder } = require("../../ml-whatsapp-tipo-ef");
const { ensureCustomerAndLinkMlBuyer } = require("./salesService");
const { customersHasPhone2Column } = require("../utils/customersPhone2");
const { sanitizeWaPersonName } = require("../whatsapp/waNameCandidate");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "waMlBuyerMatchTipoE" });

function nameTokenSignature(s) {
  if (!s || typeof s !== "string") return "";
  const d = s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return d
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function digitsCore(s) {
  return String(s || "").replace(/\D/g, "");
}

/**
 * Órdenes ML con fila en ventas (`sales_orders`), sin feedback persistido en ambos lados,
 * nombre del comprador en ML que coincide con el nombre escrito (orden de palabras indistinto).
 * @param {string} fullName — nombre tal como lo dio el cliente por WA
 * @returns {Promise<Array<{ ml_user_id: number, order_id: number, buyer_id: number }>>}
 */
async function findMlOrdersSalesPendingFeedbackByName(fullName, client = null) {
  const sig = nameTokenSignature(fullName);
  if (!sig) return [];

  const executor = client || pool;
  const { rows } = await executor.query(
    `SELECT mo.ml_user_id, mo.order_id, mb.buyer_id, mb.nombre_apellido
     FROM ml_orders mo
     INNER JOIN ml_buyers mb ON mb.buyer_id = mo.buyer_id
     INNER JOIN sales_orders so
       ON so.source = 'mercadolibre'
      AND so.external_order_id = (mo.ml_user_id::text || '-' || mo.order_id::text)
     WHERE mo.feedback_purchase IS NULL
       AND mo.feedback_sale IS NULL
       AND mo.buyer_id IS NOT NULL
       AND mb.nombre_apellido IS NOT NULL
       AND TRIM(mb.nombre_apellido) <> ''
       AND (mo.status IS NULL OR LOWER(TRIM(mo.status)) NOT IN ('cancelled', 'invalid'))`
  );

  return rows.filter((r) => nameTokenSignature(r.nombre_apellido) === sig);
}

function capitalizeFullName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Actualiza teléfonos del buyer en la misma transacción que el CRM (FOR UPDATE).
 * @param {import("pg").PoolClient} conn
 */
async function assignWaPhoneToBuyerOnClient(conn, buyerId, waPhoneDigits) {
  const e164Digits = normalizePhone(waPhoneDigits);
  if (!e164Digits) return;

  const { rows } = await conn.query(
    `SELECT phone_1, phone_2 FROM ml_buyers WHERE buyer_id = $1 FOR UPDATE`,
    [buyerId]
  );
  if (!rows.length) return;
  const b = rows[0];

  const target = normalizePhoneToE164(e164Digits, "58");
  const tCore = target ? digitsCore(target) : "";
  const p1e = normalizePhoneToE164(b.phone_1, "58");
  const p2e = normalizePhoneToE164(b.phone_2, "58");
  if (tCore && (digitsCore(p1e) === tCore || digitsCore(p2e) === tCore)) {
    return;
  }

  const p1 = b.phone_1 != null && String(b.phone_1).trim() !== "";
  const p2 = b.phone_2 != null && String(b.phone_2).trim() !== "";
  let next1 = b.phone_1;
  let next2 = b.phone_2;
  if (!p1) {
    next1 = e164Digits;
  } else if (!p2) {
    next2 = e164Digits;
  } else {
    next2 = e164Digits;
  }

  await conn.query(
    `UPDATE ml_buyers SET phone_1 = $2, phone_2 = $3, updated_at = NOW() WHERE buyer_id = $1`,
    [buyerId, next1, next2]
  );
}

/**
 * Antes de INSERT de cliente WA “genérico”: si el nombre coincide con un buyer con orden en sales
 * y feedback NULL/NULL, enlaza a ese comprador ML (no crea fila draft duplicada).
 * @param {import("pg").PoolClient} conn
 * @returns {Promise<null | { customerId: number, displayFullName: string, orderRows: object[], buyerId: number, isNewCustomer: boolean }>}
 */
async function tryWhatsappSalesNameMatchBeforeNewCustomer(conn, { normalizedPhone, fullNameRaw, normalizedExternalId }) {
  const raw = fullNameRaw != null ? String(fullNameRaw).trim() : "";
  const sanitized = sanitizeWaPersonName(raw);
  if (!sanitized) return null;
  if (!normalizedPhone) return null;

  const rows = await findMlOrdersSalesPendingFeedbackByName(sanitized, conn);
  if (!rows.length) return null;

  const buyerIds = [...new Set(rows.map((r) => Number(r.buyer_id)))].sort((a, b) => a - b);
  const buyerId = buyerIds[0];
  const orderRowsForBuyer = rows.filter((r) => Number(r.buyer_id) === buyerId);

  const { rows: hadBefore } = await conn.query(
    `SELECT id FROM customers WHERE primary_ml_buyer_id = $1 LIMIT 1`,
    [buyerId]
  );
  const hadCustomer = hadBefore.rows.length > 0;

  await assignWaPhoneToBuyerOnClient(conn, buyerId, normalizedPhone);

  const customerId = await ensureCustomerAndLinkMlBuyer(conn, buyerId);
  if (!customerId) return null;

  const displayName = capitalizeFullName(sanitized);
  const hasP2 = await customersHasPhone2Column(conn);
  if (hasP2) {
    await conn.query(
      `UPDATE customers SET
         full_name = $2,
         phone = COALESCE(NULLIF(TRIM(phone), ''), $3::text),
         updated_at = NOW()
       WHERE id = $1`,
      [customerId, displayName, normalizedPhone]
    );
  } else {
    await conn.query(
      `UPDATE customers SET
         full_name = $2,
         phone = COALESCE(NULLIF(TRIM(phone), ''), $3::text),
         updated_at = NOW()
       WHERE id = $1`,
      [customerId, displayName, normalizedPhone]
    );
  }

  await conn.query(
    `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
     VALUES ($1, 'whatsapp'::crm_identity_source, $2, TRUE)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [customerId, normalizedExternalId]
  );

  log.info(
    { customerId, buyerId, orders: orderRowsForBuyer.length },
    "whatsapp: precheck ML sales + buyer antes de crear cliente draft"
  );

  return {
    customerId: Number(customerId),
    displayFullName: displayName,
    orderRows: orderRowsForBuyer,
    buyerId,
    isNewCustomer: !hadCustomer,
  };
}

async function assignWaPhoneToBuyer(buyerId, waPhoneDigits) {
  const e164Digits = normalizePhone(waPhoneDigits);
  if (!e164Digits) return;
  const b = await getMlBuyer(buyerId);
  if (!b) return;

  const target = normalizePhoneToE164(e164Digits, "58");
  const tCore = target ? digitsCore(target) : "";

  const p1e = normalizePhoneToE164(b.phone_1, "58");
  const p2e = normalizePhoneToE164(b.phone_2, "58");
  if (tCore && (digitsCore(p1e) === tCore || digitsCore(p2e) === tCore)) {
    return;
  }

  const p1 = b.phone_1 != null && String(b.phone_1).trim() !== "";
  const p2 = b.phone_2 != null && String(b.phone_2).trim() !== "";

  if (!p1) {
    await updateMlBuyerPhones(buyerId, { phone_1: e164Digits });
  } else if (!p2) {
    await updateMlBuyerPhones(buyerId, { phone_2: e164Digits });
  } else {
    await updateMlBuyerPhones(buyerId, { phone_2: e164Digits });
  }
}

async function linkCustomerToMlBuyer(customerId, buyerId) {
  await pool.query(
    `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
    [customerId, buyerId]
  );
  await pool.query(
    `UPDATE customers
     SET primary_ml_buyer_id = COALESCE(primary_ml_buyer_id, $1::bigint),
         updated_at = NOW()
     WHERE id = $2`,
    [buyerId, customerId]
  );
}

/**
 * Tras registrar nombre real por WhatsApp: si coincide con un comprador ML con venta en `sales_orders`
 * y sin feedback en `ml_orders`, guarda el celular en `ml_buyers` y dispara tipo E por orden.
 * @param {{ fullName: string, waPhoneE164: string, customerId: number }} p
 */
async function runWaMlBuyerMatchTipoE(p) {
  const waPhoneE164 = p.waPhoneE164 != null ? String(p.waPhoneE164).trim() : "";
  const customerId = Number(p.customerId);
  if (!waPhoneE164 || !Number.isFinite(customerId) || customerId <= 0) {
    return { ok: false, reason: "bad_args" };
  }

  if (p.precheckDone && Array.isArray(p.orderRows) && p.orderRows.length > 0) {
    const seenOrder = new Set();
    for (const r of p.orderRows) {
      const key = `${r.ml_user_id}-${r.order_id}`;
      if (seenOrder.has(key)) continue;
      seenOrder.add(key);
      try {
        const res = await trySendWhatsappTipoEForOrder({
          mlUserId: Number(r.ml_user_id),
          orderId: Number(r.order_id),
          overridePhoneRaw: waPhoneE164,
          tipoEActivationSource: "wa_name_match_sales",
        });
        log.info(
          {
            ml_user_id: r.ml_user_id,
            order_id: r.order_id,
            buyer_id: r.buyer_id,
            outcome: res && res.outcome,
            ok: res && res.ok,
          },
          "tipo E tras precheck nombre WA (sin crear cliente draft)"
        );
      } catch (e) {
        log.error({ err: e, ml_user_id: r.ml_user_id, order_id: r.order_id }, "trySendWhatsappTipoEForOrder precheck");
      }
    }
    return { ok: true, matched: p.orderRows.length, precheck: true };
  }

  const fullName = p.fullName != null ? String(p.fullName).trim() : "";
  if (!fullName) {
    return { ok: false, reason: "bad_args" };
  }

  let rows;
  try {
    rows = await findMlOrdersSalesPendingFeedbackByName(fullName);
  } catch (e) {
    log.error({ err: e }, "findMlOrdersSalesPendingFeedbackByName");
    return { ok: false, reason: "query_error" };
  }

  if (!rows.length) {
    log.debug({ fullName }, "sin coincidencia ML + sales + feedback null");
    return { ok: true, matched: 0, orders: 0 };
  }

  const byBuyer = new Map();
  for (const r of rows) {
    const bid = Number(r.buyer_id);
    if (!byBuyer.has(bid)) byBuyer.set(bid, []);
    byBuyer.get(bid).push(r);
  }

  for (const [buyerId, list] of byBuyer) {
    try {
      await assignWaPhoneToBuyer(buyerId, waPhoneE164);
      await linkCustomerToMlBuyer(customerId, buyerId);
    } catch (e) {
      log.error({ err: e, buyerId }, "assign/link buyer");
    }

    const seenOrder = new Set();
    for (const r of list) {
      const key = `${r.ml_user_id}-${r.order_id}`;
      if (seenOrder.has(key)) continue;
      seenOrder.add(key);
      try {
        const res = await trySendWhatsappTipoEForOrder({
          mlUserId: Number(r.ml_user_id),
          orderId: Number(r.order_id),
          overridePhoneRaw: waPhoneE164,
          tipoEActivationSource: "wa_name_match_sales",
        });
        log.info(
          {
            ml_user_id: r.ml_user_id,
            order_id: r.order_id,
            buyer_id: buyerId,
            outcome: res && res.outcome,
            ok: res && res.ok,
          },
          "tipo E tras match nombre WA"
        );
      } catch (e) {
        log.error({ err: e, ml_user_id: r.ml_user_id, order_id: r.order_id }, "trySendWhatsappTipoEForOrder");
      }
    }
  }

  return { ok: true, matched: rows.length, buyers: byBuyer.size };
}

module.exports = {
  runWaMlBuyerMatchTipoE,
  nameTokenSignature,
  findMlOrdersSalesPendingFeedbackByName,
  tryWhatsappSalesNameMatchBeforeNewCustomer,
};
