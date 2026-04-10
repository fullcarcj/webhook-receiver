"use strict";

/**
 * Carril 2: pagos en moneda extranjera / no Banesco — aprobación manual en caja.
 * Carril 1 (transfer / pago_movil Bs) sigue en reconciliationService solo con status = pending.
 */

const pino = require("pino");
const { pool } = require("../../db");
const sseService = require("./sseService");
const loyaltyService = require("./loyaltyService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "cash_approval" });

// DECISIÓN: solo transferencia y pago móvil Bs van a conciliación automática Banesco.
const BS_AUTO_RECONCILIATION_METHODS = new Set(["transfer", "pago_movil"]);

const DEFAULT_TOLERANCE = 0.01;

function isCashApprovalPaymentMethod(paymentMethod) {
  if (paymentMethod == null || String(paymentMethod).trim() === "") return false;
  const u = String(paymentMethod).toLowerCase().trim();
  return !BS_AUTO_RECONCILIATION_METHODS.has(u);
}

function mapPaymentMethodToCurrency(paymentMethod) {
  const u = String(paymentMethod || "").toLowerCase().trim();
  const map = {
    zelle: "ZELLE",
    binance: "BINANCE",
    usd: "USD",
    usd_cash: "USD",
    cash: "EFECTIVO",
    efectivo: "EFECTIVO",
    efectivo_bs: "EFECTIVO_BS",
    panama: "PANAMA",
    credito: "CREDITO",
    mercadopago: "CREDITO",
    card: "USD",
    other: "USD",
    unknown: "USD",
  };
  return map[u] || "USD";
}

async function getToleranceUsd(client) {
  const q = client || pool;
  try {
    const { rows } = await q.query(
      `SELECT setting_value FROM finance_settings WHERE setting_key = 'CASH_APPROVAL_TOLERANCE_USD' LIMIT 1`
    );
    if (rows.length) {
      const n = Number(rows[0].setting_value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch (_e) {
    /* sin migración */
  }
  return DEFAULT_TOLERANCE;
}

async function getFinanceSettings() {
  const { rows } = await pool.query(
    "SELECT setting_key, setting_value, value_type FROM finance_settings ORDER BY setting_key"
  );
  const settings = {};
  for (const r of rows) {
    switch (r.value_type) {
      case "number":
        settings[r.setting_key] = Number(r.setting_value);
        break;
      case "boolean":
        settings[r.setting_key] = r.setting_value === "true";
        break;
      default:
        settings[r.setting_key] = r.setting_value;
    }
  }
  return settings;
}

async function updateFinanceSetting({ key, value, updatedBy }) {
  const { rows } = await pool.query(
    `UPDATE finance_settings
     SET setting_value = $1, updated_by = $2, updated_at = NOW()
     WHERE setting_key = $3
     RETURNING setting_key, setting_value, value_type, description, updated_at`,
    [String(value), updatedBy || null, key]
  );
  if (!rows.length) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    e.status = 404;
    throw e;
  }
  return rows[0];
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * Monto del pago en USD equivalente para comparar con order_total_amount (USD en ventas manuales).
 */
function computePaymentUsd({ currencyEnum, amount, exchangeRate }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (currencyEnum === "EFECTIVO_BS" || currencyEnum === "BS") {
    const rate = exchangeRate != null ? Number(exchangeRate) : null;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return 0;
    return round4(amt / rate);
  }
  return round4(amt);
}

/**
 * Tras crear la orden (misma transacción): inserta manual_transaction + log.
 * La orden ya debe tener status pending_cash_approval y total actualizado (delivery).
 */
async function recordNewSaleCashPayment(client, params) {
  const {
    orderId,
    paymentMethod,
    paymentAmount,
    exchangeRate,
    proofUrl,
    soldBy,
    description,
  } = params;

  const { rows: orderRows } = await client.query(
    `SELECT id, order_total_amount, status
     FROM sales_orders WHERE id = $1 FOR UPDATE`,
    [orderId]
  );
  if (!orderRows.length) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    e.status = 404;
    throw e;
  }
  const order = orderRows[0];
  if (order.status === "pending") {
    await client.query(
      `UPDATE sales_orders SET status = 'pending_cash_approval', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );
  } else if (order.status !== "pending_cash_approval") {
    const e = new Error("orden no está en pending ni pending_cash_approval");
    e.code = "INVALID_ORDER_STATUS";
    e.status = 422;
    throw e;
  }

  const dup = await client.query(
    `SELECT id FROM manual_transactions
     WHERE order_id = $1 AND approval_status = 'pending'`,
    [orderId]
  );
  if (dup.rows.length) {
    const e = new Error("ya existe un pago manual pendiente para esta orden");
    e.code = "DUPLICATE_PENDING_TX";
    e.status = 409;
    throw e;
  }

  const orderAmountUsd = Number(order.order_total_amount ?? 0);
  const currencyEnum = mapPaymentMethodToCurrency(paymentMethod);
  let rateUsed = exchangeRate != null ? Number(exchangeRate) : null;
  if ((currencyEnum === "EFECTIVO_BS" || currencyEnum === "BS") && !rateUsed) {
    const { rows: rateRows } = await client.query(
      `SELECT bs_per_usd FROM exchange_rates ORDER BY rate_date DESC LIMIT 1`
    );
    rateUsed = rateRows[0]?.bs_per_usd != null ? Number(rateRows[0].bs_per_usd) : null;
  }

  const payAmt = paymentAmount != null ? Number(paymentAmount) : orderAmountUsd;
  const paymentUsd = computePaymentUsd({ currencyEnum, amount: payAmt, exchangeRate: rateUsed });
  const tolerance = await getToleranceUsd(client);
  const discrepancyUsd = round4(paymentUsd - orderAmountUsd);
  const hasDiscrepancy = Math.abs(discrepancyUsd) > tolerance;

  const desc =
    description || `Pago ${String(paymentMethod)} orden #${orderId}`;

  const { rows: txRows } = await client.query(
    `INSERT INTO manual_transactions
      (type, currency, amount, amount_usd_equiv, exchange_rate_used,
       description, registered_by, order_id, approval_status,
       submitted_by, submitted_at, proof_url,
       discrepancy_usd, discrepancy_flag, tx_date)
     VALUES
      ('ingreso', $1::transaction_currency, $2, $3, $4, $5, $6, $7, 'pending',
       $6, NOW(), $8, $9, $10, CURRENT_DATE)
     RETURNING id`,
    [
      currencyEnum,
      payAmt,
      paymentUsd,
      rateUsed,
      desc,
      soldBy,
      orderId,
      proofUrl ?? null,
      discrepancyUsd,
      hasDiscrepancy,
    ]
  );

  const txId = txRows[0].id;

  await client.query(
    `INSERT INTO cash_approval_log
      (manual_tx_id, order_id, action, action_by, amount_usd, discrepancy_usd)
     VALUES ($1, $2, 'submitted', $3, $4, $5)`,
    [txId, orderId, soldBy, paymentUsd, discrepancyUsd]
  );

  return {
    tx_id: txId,
    approval_status: "pending",
    discrepancy_usd: discrepancyUsd,
    has_discrepancy: hasDiscrepancy,
    amount_usd_equiv: paymentUsd,
    amount: payAmt,
  };
}

function emitCashSubmitted(payload) {
  sseService.emit(sseService.SSE_EVENTS.CASH_PAYMENT_SUBMITTED, payload);
}

async function submitPayment({
  orderId,
  currency,
  amount,
  submittedBy,
  exchangeRate,
  proofUrl,
  description,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: orderRows } = await client.query(
      `SELECT id, order_total_amount, status
       FROM sales_orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (!orderRows.length) {
      const e = new Error("NOT_FOUND");
      e.code = "ORDER_NOT_FOUND";
      e.status = 404;
      throw e;
    }
    const order = orderRows[0];

    if (order.status === "paid") {
      const e = new Error("Esta orden ya fue pagada y conciliada");
      e.code = "ORDER_ALREADY_PAID";
      e.status = 409;
      throw e;
    }
    if (!["pending", "pending_cash_approval"].includes(order.status)) {
      const e = new Error(`No se puede registrar pago para orden en status: ${order.status}`);
      e.code = "INVALID_ORDER_STATUS";
      e.status = 422;
      throw e;
    }

    const dup = await client.query(
      `SELECT id FROM manual_transactions
       WHERE order_id = $1 AND approval_status = 'pending'`,
      [orderId]
    );
    if (dup.rows.length) {
      const e = new Error("ya existe un pago pendiente para esta orden");
      e.code = "DUPLICATE_PENDING_TX";
      e.status = 409;
      throw e;
    }

    const out = await recordNewSaleCashPayment(client, {
      orderId,
      paymentMethod: currency,
      paymentAmount: amount,
      exchangeRate,
      proofUrl,
      soldBy: submittedBy,
      description: description || `Pago ${currency} orden #${orderId}`,
    });

    await client.query("COMMIT");

    emitCashSubmitted({
      tx_id: out.tx_id,
      order_id: orderId,
      currency,
      amount,
      amount_usd: out.amount_usd_equiv,
      submitted_by: submittedBy,
      discrepancy_usd: out.discrepancy_usd,
      has_discrepancy: out.has_discrepancy,
      message: out.has_discrepancy
        ? `Discrepancia USD ${Math.abs(out.discrepancy_usd).toFixed(4)} — verificar`
        : `Pago ${currency} — verificar en caja`,
    });

    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function approvePayment({ txId, approvedBy, notes }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: txRows } = await client.query(
      `SELECT mt.*, so.order_total_amount AS order_amount_usd,
              COALESCE(so.records_cash, TRUE) AS records_cash,
              so.customer_id, so.source
       FROM manual_transactions mt
       JOIN sales_orders so ON so.id = mt.order_id
       WHERE mt.id = $1 AND mt.approval_status = 'pending'
       FOR UPDATE`,
      [txId]
    );

    if (!txRows.length) {
      const e = new Error("transacción no encontrada o no pendiente");
      e.code = "TX_NOT_FOUND_OR_NOT_PENDING";
      e.status = 404;
      throw e;
    }
    const tx = txRows[0];

    const { rows: oc } = await client.query(`SELECT status FROM sales_orders WHERE id = $1`, [
      tx.order_id,
    ]);
    if (oc[0]?.status === "paid") {
      const e = new Error("La orden ya fue conciliada por otro medio");
      e.code = "ORDER_ALREADY_PAID";
      e.status = 409;
      throw e;
    }

    await client.query(
      `UPDATE manual_transactions
       SET approval_status = 'approved',
           approved_by = $1,
           approved_at = NOW()
       WHERE id = $2`,
      [approvedBy, txId]
    );

    const orderId = tx.order_id;
    const totalAmt = Number(tx.order_amount_usd ?? 0);

    await client.query(
      `UPDATE sales_orders SET status = 'paid', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    let pointsEarned = 0;
    if (tx.customer_id != null) {
      const earn = await loyaltyService.earnFromMlOrder({
        customerId: tx.customer_id,
        orderId: `SALES-${orderId}`,
        amountUsd: totalAmt,
        source: tx.source || "mostrador",
        client,
      });
      pointsEarned = earn.points_earned || 0;
    }
    await client.query(
      `UPDATE sales_orders SET loyalty_points_earned = $1, updated_at = NOW() WHERE id = $2`,
      [pointsEarned, orderId]
    );

    if (tx.records_cash !== false) {
      await client.query(
        `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type)
         VALUES ($1, $2, 'sale')`,
        [orderId, totalAmt.toFixed(2)]
      );
    }

    await client.query(
      `INSERT INTO cash_approval_log
        (manual_tx_id, order_id, action, action_by, amount_usd, discrepancy_usd, notes)
       VALUES ($1, $2, 'approved', $3, $4, $5, $6)`,
      [
        txId,
        orderId,
        approvedBy,
        tx.amount_usd_equiv,
        tx.discrepancy_usd,
        notes ?? null,
      ]
    );

    await client.query("COMMIT");

    const settings = await getFinanceSettings().catch(() => ({}));
    const threshold = settings.CASH_ALERT_LOSS_THRESHOLD_USD ?? 20;
    const disc = tx.discrepancy_usd != null ? Number(tx.discrepancy_usd) : 0;

    if (disc < -threshold) {
      log.error(
        { txId, orderId, loss: Math.abs(disc), threshold },
        "ALERTA L3 — pérdida mayor al umbral"
      );
      sseService.emit(sseService.SSE_EVENTS.CASH_LOSS_ALERT, {
        tx_id: txId,
        order_id: orderId,
        loss_usd: Math.abs(disc),
        threshold,
        approved_by: approvedBy,
        severity: "critical",
        message: `Pérdida de $${Math.abs(disc).toFixed(2)} aprobada por ${approvedBy}`,
      });
    }

    sseService.emit(sseService.SSE_EVENTS.CASH_PAYMENT_APPROVED, {
      tx_id: txId,
      order_id: orderId,
      approved_by: approvedBy,
      submitted_by: tx.submitted_by,
      message: `Caja aprobó el pago — orden #${orderId} pagada`,
    });

    sseService.emitOrderStatusChanged({
      orderId,
      fromStatus: "pending_cash_approval",
      toStatus: "paid",
      changedBy: approvedBy,
    });

    return { tx_id: txId, order_id: orderId, status: "approved" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rejectPayment({ txId, rejectedBy, reason }) {
  if (!reason || String(reason).trim().length < 5) {
    const e = new Error("El motivo de rechazo es obligatorio (mínimo 5 caracteres)");
    e.code = "REJECTION_REASON_REQUIRED";
    e.status = 400;
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE manual_transactions
       SET approval_status = 'rejected',
           rejected_by = $1,
           rejected_at = NOW(),
           rejection_reason = $2
       WHERE id = $3 AND approval_status = 'pending'
       RETURNING order_id, submitted_by, amount, currency, resubmit_count`,
      [rejectedBy, reason, txId]
    );

    if (!rows.length) {
      const e = new Error("transacción no encontrada o no pendiente");
      e.code = "TX_NOT_FOUND_OR_NOT_PENDING";
      e.status = 404;
      throw e;
    }
    const row = rows[0];

    await client.query(
      `UPDATE sales_orders SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [row.order_id]
    );

    await client.query(
      `INSERT INTO cash_approval_log (manual_tx_id, order_id, action, action_by, notes)
       VALUES ($1, $2, 'rejected', $3, $4)`,
      [txId, row.order_id, rejectedBy, reason]
    );

    await client.query("COMMIT");

    sseService.emit(sseService.SSE_EVENTS.CASH_PAYMENT_REJECTED, {
      tx_id: txId,
      order_id: row.order_id,
      rejected_by: rejectedBy,
      submitted_by: row.submitted_by,
      reason,
      message: `Caja rechazó el pago (${row.currency}) — ${reason}`,
    });

    return {
      tx_id: txId,
      order_id: row.order_id,
      status: "rejected",
      reason,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function resubmitPayment({ txId, submittedBy, newAmount, newProofUrl, notes }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: txRows } = await client.query(
      `SELECT mt.*, so.order_total_amount AS order_usd
       FROM manual_transactions mt
       JOIN sales_orders so ON so.id = mt.order_id
       WHERE mt.id = $1 AND mt.approval_status = 'rejected'
       FOR UPDATE`,
      [txId]
    );
    if (!txRows.length) {
      const e = new Error("transacción no encontrada o no rechazada");
      e.code = "TX_NOT_FOUND_OR_NOT_REJECTED";
      e.status = 404;
      throw e;
    }
    const tx = txRows[0];
    if (String(tx.submitted_by || "").trim() !== String(submittedBy || "").trim()) {
      const e = new Error("solo el vendedor que registró puede reenviar");
      e.code = "FORBIDDEN_RESUBMIT";
      e.status = 403;
      throw e;
    }

    const currencyEnum = String(tx.currency);
    const payAmt = newAmount != null ? Number(newAmount) : Number(tx.amount);
    let rateUsed =
      tx.exchange_rate_used != null ? Number(tx.exchange_rate_used) : null;
    if ((currencyEnum === "EFECTIVO_BS" || currencyEnum === "BS") && !rateUsed) {
      const { rows: rateRows } = await client.query(
        `SELECT bs_per_usd FROM exchange_rates ORDER BY rate_date DESC LIMIT 1`
      );
      rateUsed = rateRows[0]?.bs_per_usd != null ? Number(rateRows[0].bs_per_usd) : null;
    }

    const orderUsd = Number(tx.order_usd ?? 0);
    const paymentUsd = computePaymentUsd({
      currencyEnum,
      amount: payAmt,
      exchangeRate: rateUsed,
    });
    const tolerance = await getToleranceUsd(client);
    const discrepancyUsd = round4(paymentUsd - orderUsd);
    const hasDiscrepancy = Math.abs(discrepancyUsd) > tolerance;

    await client.query(
      `UPDATE manual_transactions
       SET approval_status = 'pending',
           amount = $1,
           amount_usd_equiv = $2,
           discrepancy_usd = $3,
           discrepancy_flag = $4,
           proof_url = COALESCE($5, proof_url),
           submitted_at = NOW(),
           rejected_by = NULL,
           rejected_at = NULL,
           rejection_reason = NULL,
           resubmit_count = resubmit_count + 1
       WHERE id = $6`,
      [payAmt, paymentUsd, discrepancyUsd, hasDiscrepancy, newProofUrl ?? null, txId]
    );

    await client.query(
      `UPDATE sales_orders SET status = 'pending_cash_approval', updated_at = NOW() WHERE id = $1`,
      [tx.order_id]
    );

    await client.query(
      `INSERT INTO cash_approval_log (manual_tx_id, order_id, action, action_by, notes)
       VALUES ($1, $2, 'resubmitted', $3, $4)`,
      [txId, tx.order_id, submittedBy, notes ?? null]
    );

    await client.query("COMMIT");

    emitCashSubmitted({
      tx_id: txId,
      order_id: tx.order_id,
      currency: tx.currency,
      amount: payAmt,
      submitted_by: submittedBy,
      is_resubmit: true,
      message: `${submittedBy} corrigió y reenvió pago — orden #${tx.order_id}`,
    });

    return { tx_id: txId, status: "pending" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getPendingPayments(filters = {}) {
  const currency = filters.currency || null;
  const submittedBy = filters.submittedBy || null;
  const onlyDiscrepancies = filters.onlyDiscrepancies === true ? true : null;

  const { rows } = await pool.query(
    `SELECT
       mt.id, mt.order_id, mt.currency, mt.amount,
       mt.amount_usd_equiv, mt.discrepancy_usd, mt.discrepancy_flag,
       mt.submitted_by, mt.submitted_at, mt.resubmit_count,
       mt.proof_url, mt.rejection_reason,
       so.order_total_amount AS order_amount_usd,
       so.total_amount_bs AS order_amount_bs,
       so.source AS order_source,
       so.external_order_id,
       c.full_name AS customer_name,
       c.phone AS customer_phone,
       EXTRACT(EPOCH FROM (NOW() - mt.submitted_at)) / 3600 AS hours_waiting
     FROM manual_transactions mt
     JOIN sales_orders so ON so.id = mt.order_id
     LEFT JOIN customers c ON c.id = so.customer_id
     WHERE mt.approval_status = 'pending'
       AND mt.order_id IS NOT NULL
       AND ($1::text IS NULL OR mt.currency::text = $1)
       AND ($2::text IS NULL OR mt.submitted_by = $2)
       AND ($3::boolean IS NULL OR mt.discrepancy_flag = $3)
     ORDER BY mt.discrepancy_flag DESC, mt.submitted_at ASC`,
    [currency, submittedBy, onlyDiscrepancies]
  );

  return {
    pending_count: rows.length,
    with_discrepancy: rows.filter((r) => r.discrepancy_flag).length,
    total_pending_usd: rows.reduce((s, r) => s + Number(r.amount_usd_equiv ?? 0), 0),
    payments: rows,
  };
}

async function getMyPending(submittedBy) {
  return getPendingPayments({ submittedBy });
}

async function getCashLogByOrderId(orderId) {
  const oid = Number(orderId);
  const { rows } = await pool.query(
    `SELECT l.*, mt.currency AS mt_currency
     FROM cash_approval_log l
     LEFT JOIN manual_transactions mt ON mt.id = l.manual_tx_id
     WHERE l.order_id = $1
     ORDER BY l.action_at DESC`,
    [oid]
  );
  return rows;
}

module.exports = {
  isCashApprovalPaymentMethod,
  mapPaymentMethodToCurrency,
  recordNewSaleCashPayment,
  emitCashSubmitted,
  submitPayment,
  approvePayment,
  rejectPayment,
  resubmitPayment,
  getPendingPayments,
  getMyPending,
  getCashLogByOrderId,
  getFinanceSettings,
  updateFinanceSetting,
  getToleranceUsd,
};
