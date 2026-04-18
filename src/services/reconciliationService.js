"use strict";

const botActionsService = require("./botActionsService");
const exceptionsService = require("./exceptionsService");

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
const {
  emitPaymentConfirmed,
  emitPaymentManualReview,
  emitPaymentOverdue,
} = require("./sseService");

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

  // Órdenes pendientes · solo canales de pago bancario (CH-2 WA/redes, CH-5 fuerza ventas).
  // Comparar total_amount_bs (VES canónico, ADR-008) contra bank_statements.amount (siempre VES).
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.total_amount_bs AS total_orden, so.notes,
           so.created_at, so.payment_method, so.wa_payment_reminder_at,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.payment_status = 'pending'
      AND so.channel_id IN (2, 5)
      AND so.total_amount_bs IS NOT NULL
      AND so.total_amount_bs > 0
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
      `UPDATE sales_orders
       SET status         = 'paid',
           payment_status = 'approved',
           updated_at     = NOW()
       WHERE id = $1`,
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

    // Notificar frontend en tiempo real — después del COMMIT (no afecta la transacción)
    emitPaymentConfirmed({
      orderId:       order.id,
      customerId:    order.customer_id,
      amountBs:      order.total_orden,
      matchLevel:    match.level,
      source:        match.sourceType,
      customerPhone: order.customer_phone,
    });

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
          messageType: "CRITICAL",
          customerId: order.customer_id != null ? Number(order.customer_id) : undefined,
        }).catch((e) => log.error({ err: e.message }, "reconciliation: WA notify post-match falló"));
      }
    }
  } catch (_) { /* notificación WA opcional */ }

  try {
    const { rows: deliveryRows } = await pool.query(
      `SELECT ds.id, ds.provider_amount_bs, ds.status, dp.name AS provider_name
       FROM delivery_services ds
       LEFT JOIN delivery_providers dp ON dp.id = ds.provider_id
       WHERE ds.order_id = $1
       LIMIT 1`,
      [order.id]
    );
    if (deliveryRows.length) {
      const d = deliveryRows[0];
      log.info(
        {
          orderId: order.id,
          deliveryId: d.id,
          deliveryStatus: d.status,
          providerOwed_bs: d.provider_amount_bs,
          providerName: d.provider_name,
        },
        "reconciliation: orden conciliada incluye delivery"
      );
    }
  } catch (_) {
    /* delivery opcional */
  }

  // Log de trazabilidad (Paso 2 · fire-and-forget, no revierte el match)
  botActionsService.log({
    chatId:       null,
    orderId:      order.id,
    actionType:   "payment_reconciled",
    inputContext: {
      matchLevel:  match.level,
      sourceType:  match.sourceType,
      sourceRowId: match.row.id,
      diff:        match.diff,
      tolerance:   match.tolerance,
    },
    outputResult: { payment_status: "approved", total_amount_bs: order.total_orden },
    provider:     "rule_engine",
    confidence:   match.score,
  }).catch((err) => log.warn({ err: err.message }, "reconciliation: bot_action log falló (no crítico)"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Revisión manual (L3)
// ─────────────────────────────────────────────────────────────────────────────

async function applyManualReview(order, match) {
  // L3: marcar la orden como pendiente de aprobación humana.
  // Usamos approval_status (workflow de revisión) en lugar de payment_status (estado del dinero).
  // Decisión 2026-04-20: ver ADR-006 amendment nota 2. payment_status permanece 'pending'.
  await pool.query(
    `UPDATE sales_orders
     SET approval_status = 'pending',
         updated_at = NOW()
     WHERE id = $1`,
    [order.id]
  );

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

  emitPaymentManualReview({
    orderId:    order.id,
    customerId: order.customer_id,
    amountBs:   order.total_orden,
    source:     match.sourceType,
  });

  // Registrar excepción + bot_action para vista supervisor (Paso 4 · fire-and-forget)
  Promise.all([
    exceptionsService.raise({
      entityType: "payment",
      entityId:   order.id,
      reason:     "payment_no_match",
      severity:   "medium",
      context:    {
        matchLevel:  match.level,
        score:       match.score,
        sourceType:  match.sourceType,
        sourceRowId: match.row.id,
        diff:        match.diff,
      },
      chatId: null,
    }),
    botActionsService.log({
      chatId:       null,
      orderId:      order.id,
      actionType:   "manual_review_required",
      inputContext: { matchLevel: match.level, score: match.score, sourceType: match.sourceType },
      outputResult: { approval_status: "pending" },
      provider:     "rule_engine",
      confidence:   match.score,
    }),
  ]).catch((err) => log.warn({ err: err.message }, "reconciliation: L3 logging falló (no crítico)"));
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
    emitPaymentOverdue({
      orderId:    order.id,
      customerId: order.customer_id,
      amountBs:   order.total_orden,
      hoursOld:   Math.round(hoursOld),
    });
    return;
  }

  // Recordatorios deshabilitados hasta nuevo aviso.
  // Para reactivar: RECONCILIATION_WA_REMINDERS_ENABLED=1
  if (process.env.RECONCILIATION_WA_REMINDERS_ENABLED === "1" && hoursOld >= 6 && order.customer_phone) {
    // Dedup: solo enviar recordatorio si nunca se envió O si han pasado >= 6h desde el último
    const lastReminder = order.wa_payment_reminder_at
      ? (Date.now() - new Date(order.wa_payment_reminder_at)) / 3_600_000
      : null;

    const shouldSend = lastReminder === null || lastReminder >= 6;

    if (shouldSend) {
      try {
        const { sendWasenderTextMessage } = require("../../wasender-client");
        const apiKey     = process.env.WASENDER_API_KEY;
        const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
        if (apiKey) {
          const totalFmt = Number(order.total_orden).toLocaleString("es-VE");
          let waRes;
          try {
            waRes = await sendWasenderTextMessage({
              apiKey,
              apiBaseUrl,
              to:   `+${String(order.customer_phone).replace(/\D/g, "")}`,
              text: `⏳ Hola, aún no hemos recibido tu pago de la orden *#${order.id}*.\nMonto: *Bs ${totalFmt}*\nPor favor envía tu comprobante cuando puedas. 📸`,
              messageType: "REMINDER",
              customerId: order.customer_id != null ? Number(order.customer_id) : undefined,
            });
          } catch (e) {
            log.error({ err: e.message }, "reconciliation: recordatorio WA falló");
            waRes = { ok: false };
          }

          if (waRes && waRes.ok) {
            await pool.query(
              `UPDATE sales_orders SET wa_payment_reminder_at = NOW() WHERE id = $1`,
              [order.id]
            );
            log.info({ orderId: order.id }, "reconciliation: recordatorio WA enviado");
          } else if (waRes && waRes.status === "blocked" && waRes.reason) {
            log.warn({ orderId: order.id, reason: waRes.reason }, "reconciliation: recordatorio WA bloqueado (anti-spam)");
          }
        }
      } catch (_) { /* notificación opcional */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger 1 — event-driven: conciliar solo statements bancarios recién insertados
// Llamado por banescoService.runCycle() con los IDs del lote actual.
// ─────────────────────────────────────────────────────────────────────────────

async function reconcileStatements(bankStatementIds) {
  if (!Array.isArray(bankStatementIds) || bankStatementIds.length === 0) return;

  // Solo statements CREDIT sin conciliar del lote recién insertado
  const { rows: statements } = await pool.query(
    `SELECT id, tx_date, reference_number, description, amount, payment_type
     FROM bank_statements
     WHERE id = ANY($1::bigint[])
       AND tx_type = 'CREDIT'
       AND reconciliation_status = 'UNMATCHED'`,
    [bankStatementIds]
  );

  if (!statements.length) return;

  // Órdenes pendientes · solo canales bancarios (CH-2, CH-5) · total_amount_bs canónico (ADR-008)
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.total_amount_bs AS total_orden, so.notes,
           so.created_at, so.payment_method, so.wa_payment_reminder_at,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.payment_status = 'pending'
      AND so.channel_id IN (2, 5)
      AND so.total_amount_bs IS NOT NULL
      AND so.total_amount_bs > 0
    ORDER BY so.created_at ASC
  `);

  if (!orders.length) return;

  // Pool mutable en memoria: evita conciliar la misma orden o el mismo statement dos veces en el lote
  const stmtPool  = [...statements];
  const orderPool = [...orders];

  for (const order of orderPool) {
    if (!stmtPool.length) break;
    try {
      // findBestMatch(order, rows, tolerance, sourceType) — busca en rows el mejor match para order
      const match = findBestMatch(order, stmtPool, TOLERANCE.BANK_STATEMENT, "bank");
      if (!match) continue;

      if (match.level === 1 || match.level === 2) {
        await applyMatch(order, match);
        // Evitar reusar el mismo statement para otra orden
        const idx = stmtPool.findIndex((s) => s.id === match.row.id);
        if (idx !== -1) stmtPool.splice(idx, 1);
        log.info({ orderId: order.id, statementId: match.row.id, level: match.level },
          "reconcileStatements: MATCH aplicado");
      } else {
        await applyManualReview(order, match);
        log.warn({ orderId: order.id, statementId: match.row.id },
          "reconcileStatements: enviado a revisión manual");
      }
    } catch (err) {
      log.error({ err: err.message, orderId: order.id },
        "reconcileStatements: error procesando orden");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger 2 — event-driven: conciliar un payment_attempt recién insertado
// Llamado por media.js inmediatamente después de INSERT INTO payment_attempts.
// ─────────────────────────────────────────────────────────────────────────────

async function reconcileAttempt(paymentAttemptId) {
  if (!paymentAttemptId) return;

  const { rows: attempts } = await pool.query(
    `SELECT id, customer_id, extracted_reference,
            extracted_amount_bs, extracted_date, extraction_confidence
     FROM payment_attempts
     WHERE id = $1
       AND reconciliation_status = 'pending'
       AND extracted_amount_bs IS NOT NULL`,
    [paymentAttemptId]
  );

  if (!attempts.length) return;
  const attempt = attempts[0];

  // Órdenes pendientes · solo canales bancarios (CH-2, CH-5) · total_amount_bs canónico (ADR-008)
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.total_amount_bs AS total_orden, so.notes,
           so.created_at, so.payment_method, so.wa_payment_reminder_at,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.payment_status = 'pending'
      AND so.channel_id IN (2, 5)
      AND so.total_amount_bs IS NOT NULL
      AND so.total_amount_bs > 0
    ORDER BY so.created_at ASC
  `);

  if (!orders.length) return;

  // findBestMatch espera (order, rows[], tolerance, sourceType).
  // Para un solo attempt: pasar [attempt] como pool y buscar para cada orden cuál es mejor match.
  let matched = false;
  try {
    for (const order of orders) {
      const match = findBestMatch(order, [attempt], TOLERANCE.PAYMENT_ATTEMPT, "attempt");
      if (!match) continue;

      matched = true;
      if (match.level === 1 || match.level === 2) {
        await applyMatch(order, match);
        log.info({ attemptId: attempt.id, orderId: order.id, level: match.level },
          "reconcileAttempt: MATCH aplicado");
      } else {
        await applyManualReview(order, match);
        log.warn({ attemptId: attempt.id, orderId: order.id },
          "reconcileAttempt: enviado a revisión manual");
      }
      // Solo una orden puede conciliarse con este attempt
      break;
    }

    // Ninguna orden tuvo monto dentro de la tolerancia ±0.01 Bs
    if (!matched) {
      await pool.query(
        `UPDATE payment_attempts
         SET reconciliation_status = 'no_match', reconciled_at = NOW()
         WHERE id = $1`,
        [attempt.id]
      );
      log.warn({
        attemptId:     attempt.id,
        amount_bs:     attempt.extracted_amount_bs,
        reference:     attempt.extracted_reference,
        bank:          attempt.extracted_bank,
        ordersChecked: orders.length,
        tolerance_bs:  TOLERANCE.PAYMENT_ATTEMPT,
      }, "reconcileAttempt: sin match de monto — attempt marcado no_match");
    }
  } catch (err) {
    log.error({ err: err.message, attemptId: attempt.id },
      "reconcileAttempt: error procesando attempt");
  }
}

module.exports = { runReconciliation, reconcileStatements, reconcileAttempt, TOLERANCE };
