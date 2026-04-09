"use strict";

/**
 * Servicio de Conciliación Automática de Pagos.
 *
 * Cruza bank_statements (API Banesco cada 30s) + payment_attempts (comprobantes WA)
 * contra sales_orders pendientes, aplicando tolerancias distintas por fuente:
 *
 *   BANK_STATEMENT:  ±0.05 Bs  (redondeo bancario) — referencia: match PARCIAL (contains)
 *   PAYMENT_ATTEMPT: ±0.01 Bs  (IA lee print exacto) — referencia: match EXACTA (===)
 *
 * Niveles de match:
 *   NIVEL 1 — monto + referencia + fecha (0–1 día) → confidence 1.00 → auto-aprobado
 *   NIVEL 2 — monto + fecha (0–2 días)             → confidence 0.85 → auto-aprobado
 *   NIVEL 3 — monto + fecha > 2 días               → confidence 0.60 → revisión manual
 */

const { pool } = require("../../db");
const pino     = require("pino");
const log      = pino({ level: process.env.LOG_LEVEL || "info", name: "reconciliation" });

const TOLERANCE = {
  BANK_STATEMENT:  0.05,
  PAYMENT_ATTEMPT: 0.01,
};

// ─────────────────────────────────────────────────────────────────────────────
// Función principal — llamada por el worker cada 30s
// ─────────────────────────────────────────────────────────────────────────────

async function runReconciliation() {
  const stats = {
    processed: 0,
    bank_l1:   0, bank_l2:    0,
    attempt_l1: 0, attempt_l2: 0,
    manual:    0, no_match:   0, errors: 0,
  };

  // Órdenes pendientes con datos del cliente (order_total_amount = monto en moneda de la orden)
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.order_total_amount AS total_orden, so.notes,
           so.created_at, so.payment_method,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.status = 'pending'
      AND so.order_total_amount IS NOT NULL
      AND so.order_total_amount > 0
    ORDER BY so.created_at ASC
  `);

  if (!orders.length) return stats;

  // Bank statements UNMATCHED CREDIT — últimos 3 días
  const { rows: bankRows } = await pool.query(`
    SELECT id, tx_date, reference_number, description,
           amount, payment_type
    FROM bank_statements
    WHERE tx_type = 'CREDIT'
      AND reconciliation_status = 'UNMATCHED'
      AND tx_date >= CURRENT_DATE - INTERVAL '3 days'
    ORDER BY tx_date DESC, amount DESC
  `);

  // Payment attempts pendientes — últimos 3 días
  const { rows: attemptRows } = await pool.query(`
    SELECT id, customer_id, extracted_reference,
           extracted_amount_bs, extracted_date, extraction_confidence
    FROM payment_attempts
    WHERE reconciliation_status = 'pending'
      AND extracted_amount_bs IS NOT NULL
      AND created_at >= NOW() - INTERVAL '3 days'
    ORDER BY created_at DESC
  `);

  // Clonar arrays para poder spliceearlos en memoria sin afectar la fuente original
  const bankPool    = [...bankRows];
  const attemptPool = [...attemptRows];

  for (const order of orders) {
    stats.processed++;
    try {
      const bankMatch    = findBestMatch(order, bankPool,    TOLERANCE.BANK_STATEMENT,  "bank");
      const attemptMatch = findBestMatch(order, attemptPool, TOLERANCE.PAYMENT_ATTEMPT, "attempt");
      const best         = chooseBest(bankMatch, attemptMatch);

      if (!best) {
        await handleNoMatch(order);
        stats.no_match++;
        continue;
      }

      if (best.level === 1 || best.level === 2) {
        await applyMatch(order, best);
        if (best.sourceType === "bank") {
          best.level === 1 ? stats.bank_l1++ : stats.bank_l2++;
          // Eliminar del pool en memoria para que no concilie dos órdenes
          const idx = bankPool.findIndex((b) => b.id === best.row.id);
          if (idx !== -1) bankPool.splice(idx, 1);
        } else {
          best.level === 1 ? stats.attempt_l1++ : stats.attempt_l2++;
          const idx = attemptPool.findIndex((a) => a.id === best.row.id);
          if (idx !== -1) attemptPool.splice(idx, 1);
        }
      } else {
        await applyManualReview(order, best);
        stats.manual++;
      }
    } catch (err) {
      stats.errors++;
      log.error({ err: err.message, orderId: order.id }, "reconciliation: error procesando orden");
    }
  }

  log.info(stats, "reconciliation: ciclo completado");
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de matching
// ─────────────────────────────────────────────────────────────────────────────

function findBestMatch(order, rows, tolerance, sourceType) {
  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    const amount   = Number(sourceType === "bank" ? row.amount : row.extracted_amount_bs);
    const diff     = Math.abs(amount - Number(order.total_orden));
    if (diff > tolerance) continue;

    const refField  = sourceType === "bank" ? row.reference_number : row.extracted_reference;
    const dateField = sourceType === "bank" ? row.tx_date          : row.extracted_date;

    const refMatch = checkReference(refField, order, sourceType);
    const daysDiff = getDaysDiff(dateField, order.created_at);
    const inRange  = daysDiff >= 0 && daysDiff <= 1;
    const extended = daysDiff >= 0 && daysDiff <= 2;

    let level, score;
    if (refMatch && inRange) { level = 1; score = 1.00; }
    else if (inRange)        { level = 2; score = 0.85; }
    else if (extended)       { level = 2; score = 0.78; }
    else                     { level = 3; score = 0.60; }

    if (score > bestScore) {
      bestScore = score;
      best = { level, score, row, diff, refMatch, sourceType, tolerance };
    }
  }

  return best;
}

function checkReference(refField, order, sourceType) {
  if (!refField) return false;
  const ref      = String(refField).toLowerCase().trim();
  const searchIn = [order.external_order_id ?? "", order.notes ?? ""]
    .join(" ").toLowerCase();
  // Bank: coincidencia parcial (los bancos truncan referencias)
  // Attempt: coincidencia exacta (la IA lee el número completo del print)
  return sourceType === "attempt"
    ? (searchIn.includes(ref) || ref === String(order.id))
    : (searchIn.includes(ref) ||
       ref.includes((order.external_order_id ?? "").toLowerCase()));
}

function getDaysDiff(dateField, createdAt) {
  if (!dateField) return 999;
  const d1 = new Date(dateField).setHours(0, 0, 0, 0);
  const d2 = new Date(createdAt).setHours(0, 0, 0, 0);
  return Math.floor((d1 - d2) / 86400000);
}

function chooseBest(bankMatch, attemptMatch) {
  if (!bankMatch && !attemptMatch) return null;
  if (!bankMatch)    return attemptMatch;
  if (!attemptMatch) return bankMatch;
  return bankMatch.score >= attemptMatch.score ? bankMatch : attemptMatch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aplicar conciliación exitosa (L1 o L2)
// ─────────────────────────────────────────────────────────────────────────────

async function applyMatch(order, match) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE sales_orders SET status = 'paid', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );

    if (match.sourceType === "bank") {
      await client.query(
        `UPDATE bank_statements SET reconciliation_status = 'MATCHED' WHERE id = $1`,
        [match.row.id]
      );
    } else {
      await client.query(
        `UPDATE payment_attempts
         SET reconciliation_status = 'matched',
             reconciled_order_id   = $1,
             reconciled_at         = NOW()
         WHERE id = $2`,
        [order.id, match.row.id]
      );
    }

    await client.query(
      `INSERT INTO reconciliation_log
         (order_id, bank_statement_id, payment_attempt_id, source,
          match_level, confidence_score, amount_order_bs, amount_source_bs,
          amount_diff_bs, tolerance_used_bs, reference_matched, date_matched, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,'auto_matched')`,
      [
        order.id,
        match.sourceType === "bank"    ? match.row.id : null,
        match.sourceType === "attempt" ? match.row.id : null,
        match.sourceType === "bank" ? "bank_statement" : "payment_attempt",
        match.level,
        match.score,
        order.total_orden,
        match.sourceType === "bank" ? match.row.amount : match.row.extracted_amount_bs,
        match.diff,
        match.tolerance,
        match.refMatch,
      ]
    );

    await client.query("COMMIT");

    log.info({
      orderId:    order.id,
      source:     match.sourceType,
      level:      match.level,
      score:      match.score,
      diff:       match.diff,
      tolerance:  match.tolerance,
    }, `reconciliation: NIVEL ${match.level} aprobado`);

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Efectos post-match fuera de transacción — errores no revierten la conciliación
  try {
    if (order.customer_id) {
      const loyaltyService = require("./loyaltyService");
      await loyaltyService.earnFromMlOrder({
        customerId: order.customer_id,
        orderId:    `RECON-${order.id}`,
        amountUsd:  0,
        source:     order.source,
      }).catch((e) => log.error({ err: e.message }, "reconciliation: earnPoints post-match falló"));
    }
  } catch (_) { /* loyalty opcional */ }

  try {
    if (order.customer_phone) {
      const { sendWasenderTextMessage } = require("../../wasender-client");
      const apiKey     = process.env.WASENDER_API_KEY;
      const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
      if (apiKey) {
        const sourceLabel = match.sourceType === "bank" ? "estado de cuenta" : "comprobante enviado";
        const totalFmt    = Number(order.total_orden).toLocaleString("es-VE");
        await sendWasenderTextMessage({
          apiKey,
          apiBaseUrl,
          to:   `+${String(order.customer_phone).replace(/\D/g, "")}`,
          text: `✅ *¡Pago confirmado!*\n\nTu orden *#${order.id}* fue conciliada vía ${sourceLabel}.\nMonto: *Bs ${totalFmt}*\n\nEn breve coordinamos la entrega. 🔧`,
        }).catch((e) => log.error({ err: e.message }, "reconciliation: WA notify post-match falló"));
      }
    }
  } catch (_) { /* notificación WA opcional */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Revisión manual (L3)
// ─────────────────────────────────────────────────────────────────────────────

async function applyManualReview(order, match) {
  if (match.sourceType === "bank") {
    await pool.query(
      `UPDATE bank_statements SET reconciliation_status = 'MANUAL_REVIEW' WHERE id = $1`,
      [match.row.id]
    );
  } else {
    await pool.query(
      `UPDATE payment_attempts SET reconciliation_status = 'manual_review' WHERE id = $1`,
      [match.row.id]
    );
  }

  await pool.query(
    `INSERT INTO reconciliation_log
       (order_id, bank_statement_id, payment_attempt_id, source,
        match_level, confidence_score, amount_order_bs, amount_source_bs,
        amount_diff_bs, tolerance_used_bs, status)
     VALUES ($1,$2,$3,$4,3,0.60,$5,$6,$7,$8,'manual_review')`,
    [
      order.id,
      match.sourceType === "bank"    ? match.row.id : null,
      match.sourceType === "attempt" ? match.row.id : null,
      match.sourceType === "bank" ? "bank_statement" : "payment_attempt",
      order.total_orden,
      match.sourceType === "bank" ? match.row.amount : match.row.extracted_amount_bs,
      match.diff,
      match.tolerance,
    ]
  );

  log.warn({ orderId: order.id, sourceType: match.sourceType },
    "reconciliation: orden enviada a revisión manual");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sin match — recordatorio 6h y expiración 24h
// ─────────────────────────────────────────────────────────────────────────────

async function handleNoMatch(order) {
  const hoursOld = (Date.now() - new Date(order.created_at)) / 3_600_000;

  if (hoursOld >= 24) {
    await pool.query(
      `UPDATE sales_orders SET status = 'payment_overdue', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );
    log.warn({ orderId: order.id, hoursOld: Math.round(hoursOld) }, "reconciliation: orden → payment_overdue");
    return;
  }

  if (hoursOld >= 6 && order.customer_phone) {
    // Solo enviar recordatorio si no existe ningún log previo para esta orden
    const { rows } = await pool.query(
      `SELECT id FROM reconciliation_log WHERE order_id = $1 LIMIT 1`,
      [order.id]
    );
    if (!rows.length) {
      try {
        const { sendWasenderTextMessage } = require("../../wasender-client");
        const apiKey     = process.env.WASENDER_API_KEY;
        const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
        if (apiKey) {
          const totalFmt = Number(order.total_orden).toLocaleString("es-VE");
          await sendWasenderTextMessage({
            apiKey,
            apiBaseUrl,
            to:   `+${String(order.customer_phone).replace(/\D/g, "")}`,
            text: `⏳ Hola, aún no hemos recibido tu pago de la orden *#${order.id}*.\nMonto: *Bs ${totalFmt}*\nPor favor envía tu comprobante cuando puedas. 📸`,
          }).catch((e) => log.error({ err: e.message }, "reconciliation: recordatorio WA falló"));
        }
      } catch (_) { /* notificación opcional */ }
    }
  }
}

module.exports = { runReconciliation, TOLERANCE };
