"use strict";

const botActionsService = require("./botActionsService");
const exceptionsService = require("./exceptionsService");

/**
 * Servicio de Conciliación Automática de Pagos.
 *
 * Cruza bank_statements (API Banesco cada 30s) + payment_attempts (comprobantes WA)
 * contra sales_orders pendientes y, si no hay orden, contra inventario_presupuesto del mismo chat
 * (monto en Bs con tasa del día + misma conversación WA), aplicando tolerancias distintas por fuente:
 *
 *   BANK_STATEMENT:  ±0.05 Bs  (redondeo bancario) — referencia: match PARCIAL (contains)
 *   PAYMENT_ATTEMPT: tolerancia por env `RECONCILIATION_ATTEMPT_TOLERANCE_BS` (default ±0,50 Bs)
 *   Cotización (Bs): `toleranceBsForQuotationPayment` — mín. 100 VES y 0,5 % del monto (Banesco vs tasa cotización)
 *
 * Niveles de match:
 *   NIVEL 1 — monto + referencia + fecha (−1 a +1 día)  → confidence 1.00 → auto-aprobado
 *   NIVEL 2 — monto + fecha (−2 a +2 días)              → confidence 0.85/0.78 → auto-aprobado
 *   NIVEL 3 — monto + fecha fuera de ventana            → confidence 0.60 → revisión manual
 *
 * Ventana negativa (−2 días): el cliente transfiere antes de que se genere la orden (flujo cotización/proforma).
 *
 * Recordatorio WA si no hay match (entre 6 h y 24 h desde la orden): RECONCILIATION_WA_REMINDERS_ENABLED=1 (por defecto apagado).
 *
 * Educación “ingreso detectado en banco, envía comprobante” (L3 desde extracto): RECONCILIATION_BANK_PROOF_EDUCATION_ENABLED=1.
 * Dedup: columna sales_orders.wa_bank_proof_education_at (ADD COLUMN IF NOT EXISTS en runtime).
 */

const { pool } = require("../../db");
const pino     = require("pino");
const log      = pino({ level: process.env.LOG_LEVEL || "info", name: "reconciliation" });
const {
  emitPaymentConfirmed,
  emitPaymentManualReview,
  emitPaymentOverdue,
} = require("./sseService");
const { toleranceBsForQuotationPayment } = require("./quotationPaymentSettlementService");

// Tolerancia de monto por fuente.
// PAYMENT_ATTEMPT puede ser mayor a 0.01 porque la tasa de cambio con la que el cliente calculó
// puede diferir ligeramente de la usada al generar la orden (redondeos, deslizamiento intradía).
// Se puede sobreescribir con RECONCILIATION_ATTEMPT_TOLERANCE_BS en el entorno (ej. "0.5").
const _attemptTolEnv = parseFloat(process.env.RECONCILIATION_ATTEMPT_TOLERANCE_BS || "");
const TOLERANCE = {
  BANK_STATEMENT:  0.05,
  PAYMENT_ATTEMPT: Number.isFinite(_attemptTolEnv) && _attemptTolEnv > 0 ? _attemptTolEnv : 0.50,
};

function fmtDateLong(iso) {
  if (iso == null || String(iso).trim() === "") return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString("es-VE", { day: "2-digit", month: "long", year: "numeric" });
  } catch {
    return String(iso).slice(0, 10);
  }
}

/** Texto WA post-conciliación exitosa (extracto o comprobante IA). */
function buildPaymentConfirmedWaMessage(order, match) {
  const orderId = order.id;
  const totalFmt = Number(order.total_orden).toLocaleString("es-VE");
  let amountBsFmt;
  let refFull;
  let dateStr;
  let sourceHuman;
  if (match.sourceType === "bank") {
    const r = match.row;
    const amt = r.amount != null ? Number(r.amount) : Number(order.total_orden);
    amountBsFmt = Number(amt).toLocaleString("es-VE");
    refFull =
      r.reference_number != null && String(r.reference_number).trim() !== ""
        ? String(r.reference_number).trim()
        : r.description != null && String(r.description).trim() !== ""
          ? String(r.description).trim().slice(0, 120)
          : "—";
    dateStr = fmtDateLong(r.tx_date);
    sourceHuman = "movimiento en el extracto bancario";
  } else {
    const r = match.row;
    const amt = r.extracted_amount_bs != null ? Number(r.extracted_amount_bs) : Number(order.total_orden);
    amountBsFmt = Number(amt).toLocaleString("es-VE");
    refFull =
      r.extracted_reference != null && String(r.extracted_reference).trim() !== ""
        ? String(r.extracted_reference).trim()
        : "—";
    dateStr = fmtDateLong(r.extracted_date);
    sourceHuman = "comprobante enviado por WhatsApp";
  }
  return (
    `✅ *Pago confirmado*\n\n` +
    `Tu pago de *Bs ${amountBsFmt}* con referencia *${refFull}* ` +
    `(fecha del comprobante o del banco: *${dateStr}*) quedó conciliado correctamente ` +
    `con la orden *#${orderId}* mediante ${sourceHuman}.\n\n` +
    `El monto registrado en la orden es *Bs ${totalFmt}*. ` +
    `Tu pedido *pasará a la etapa de despacho* cuando el sistema tenga el tipo de entrega configurado; ` +
    `un operador puede coordinar contigo por este canal.`
  );
}

async function resolveWaNotifyPhone(order, chatId) {
  // Prioridad 1: teléfono del chat explícito (conversación activa).
  if (chatId != null && Number.isFinite(Number(chatId)) && Number(chatId) > 0) {
    const { rows } = await pool.query(`SELECT phone FROM crm_chats WHERE id = $1 LIMIT 1`, [
      Number(chatId),
    ]);
    if (rows[0]?.phone && String(rows[0].phone).replace(/\D/g, "").length >= 10) {
      return String(rows[0].phone);
    }
  }

  // Prioridad 2: cuando el match fue por extracto bancario (chatId null) y la orden tiene
  // customer_id, buscar si hay un payment_attempt reciente del mismo cliente con chat_id →
  // ese chat es quien envió el comprobante y espera la confirmación.
  if ((chatId == null) && order.customer_id != null) {
    const { rows: paRows } = await pool.query(
      `SELECT cc.phone
       FROM payment_attempts pa
       JOIN crm_chats cc ON cc.id = pa.chat_id
       WHERE pa.customer_id = $1
         AND pa.chat_id IS NOT NULL
         AND cc.phone IS NOT NULL
       ORDER BY pa.created_at DESC
       LIMIT 1`,
      [order.customer_id]
    );
    if (paRows[0]?.phone && String(paRows[0].phone).replace(/\D/g, "").length >= 10) {
      return String(paRows[0].phone);
    }
  }

  // Prioridad 3: teléfono del cliente registrado en la orden.
  let phone = order.customer_phone;
  if (phone && String(phone).replace(/\D/g, "").length >= 10) return String(phone);
  if (order.customer_id != null) {
    const { rows } = await pool.query(`SELECT phone FROM customers WHERE id = $1 LIMIT 1`, [
      order.customer_id,
    ]);
    if (rows[0]?.phone && String(rows[0].phone).replace(/\D/g, "").length >= 10) {
      return String(rows[0].phone);
    }
  }
  return null;
}

/** Referencia humana de cotización (alineado a inboxQuotationHandler.buildReference). */
function presupuestoReference(channelId, id) {
  const ch = Number(channelId);
  if (ch === 2) return `COT-WA-${id}`;
  if (ch === 3) return `COT-ML-${id}`;
  return `COT-${id}`;
}

/**
 * Si no hubo match con sales_orders: misma conversación (chat_id), cotización sent|approved,
 * monto comprobante ≈ total USD × tasa, y cliente_id coherente cuando ambos existen.
 * @returns {Promise<boolean>}
 */
async function maybeMatchQuotationFromAttempt(attempt, attemptChatId, attemptCustomerId) {
  if (!attemptChatId) return false;

  const { rows: chk } = await pool.query(`SELECT id FROM crm_chats WHERE id = $1 LIMIT 1`, [
    attemptChatId,
  ]);
  if (!chk.length) return false;

  const { getTodayRate } = require("./currencyService");
  const rateRow = await getTodayRate(1).catch(() => null);
  const rate = rateRow && Number(rateRow.active_rate) > 0 ? Number(rateRow.active_rate) : null;
  if (!rate) {
    log.warn({ attemptId: attempt.id }, "reconcileAttempt: match cotización omitido (sin tasa del día)");
    return false;
  }

  const ext = Number(attempt.extracted_amount_bs);
  if (!Number.isFinite(ext)) return false;

  const { rows: quotes } = await pool.query(
    `SELECT id, channel_id, cliente_id, total::numeric AS total_usd,
            lower(status::text) AS st
       FROM inventario_presupuesto
      WHERE chat_id = $1
        AND lower(status::text) NOT IN ('converted', 'expired', 'rejected')
      ORDER BY fecha_creacion DESC
      LIMIT 30`,
    [attemptChatId]
  );

  let best = null;
  let bestDiff = Infinity;
  for (const q of quotes) {
    const st = String(q.st || "").trim();
    if (!["sent", "approved"].includes(st)) continue;
    if (
      attemptCustomerId != null &&
      q.cliente_id != null &&
      Number(q.cliente_id) !== Number(attemptCustomerId)
    ) {
      continue;
    }
    const qBs = Number(q.total_usd) * rate;
    const tol = toleranceBsForQuotationPayment(qBs);
    const diff = Math.abs(ext - qBs);
    if (diff <= tol && diff < bestDiff) {
      bestDiff = diff;
      best = q;
    }
  }

  if (!best) return false;

  const ref = presupuestoReference(best.channel_id, best.id);

  let upd;
  const settlementSvc = require("./quotationPaymentSettlementService");
  const useAlloc = await settlementSvc.allocationTableExists(null).catch(() => false);

  if (useAlloc) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      upd = await client.query(
        `UPDATE payment_attempts
           SET reconciliation_status = 'matched',
               reconciled_quotation_id = $2,
               reconciled_order_id = NULL,
               reconciled_at = NOW()
         WHERE id = $1
           AND reconciliation_status = 'pending'
         RETURNING id`,
        [attempt.id, best.id]
      );
      if (!upd.rows.length) {
        await client.query("ROLLBACK");
        return false;
      }
      try {
        await settlementSvc.insertAllocation(client, {
          quotationId:      best.id,
          paymentAttemptId: attempt.id,
          sourceCurrency:   "VES",
          amountOriginal:   ext,
          fxRateBsPerUsd:   rate,
          userId:           null,
        });
        await settlementSvc.assertAllocationTotalsWithinTolerance(client, best.id);
      } catch (allocErr) {
        await client.query("ROLLBACK");
        if (allocErr && allocErr.code === "23505") {
          log.info({ attemptId: attempt.id, quotationId: best.id }, "reconcileAttempt: imputación duplicada; rollback");
          return false;
        }
        if (allocErr && String(allocErr.code) === "OVER_ALLOCATED") {
          log.warn({ attemptId: attempt.id, quotationId: best.id }, "reconcileAttempt: imputación excede total; rollback");
          return false;
        }
        throw allocErr;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e && e.code === "42703") {
        log.warn(
          { attemptId: attempt.id },
          "reconcileAttempt: falta columna reconciled_quotation_id — ejecutar sql/20260426_payment_attempts_reconciled_quotation.sql"
        );
        return false;
      }
      throw e;
    } finally {
      client.release();
    }
  } else {
    try {
      upd = await pool.query(
        `UPDATE payment_attempts
           SET reconciliation_status = 'matched',
               reconciled_quotation_id = $2,
               reconciled_order_id = NULL,
               reconciled_at = NOW()
         WHERE id = $1
           AND reconciliation_status = 'pending'
         RETURNING id`,
        [attempt.id, best.id]
      );
    } catch (e) {
      if (e && e.code === "42703") {
        log.warn(
          { attemptId: attempt.id },
          "reconcileAttempt: falta columna reconciled_quotation_id — ejecutar sql/20260426_payment_attempts_reconciled_quotation.sql"
        );
        return false;
      }
      throw e;
    }
    if (!upd.rows.length) return false;
  }

  const { emitQuotationReceiptMatched } = require("./sseService");
  emitQuotationReceiptMatched({
    quotationId: best.id,
    chatId:       attemptChatId,
    attemptId:    attempt.id,
    amountBs:     ext,
    reference:    ref,
  });

  const waOrderLite = { customer_phone: null, customer_id: attemptCustomerId };
  await maybeSendQuotationReceiptWa(waOrderLite, attemptChatId, ref, ext);

  log.info(
    { attemptId: attempt.id, quotationId: best.id, reference: ref, diff_bs: bestDiff },
    "reconcileAttempt: MATCH contra cotización (mismo chat + monto)"
  );
  return true;
}

async function maybeSendQuotationReceiptWa(orderLite, chatId, quotationRef, amountBs) {
  try {
    const { sendWasenderTextMessage } = require("../../wasender-client");
    const apiKey = process.env.WASENDER_API_KEY;
    const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
    if (!apiKey) return;
    const toPhone = await resolveWaNotifyPhone(orderLite, chatId);
    if (!toPhone) return;
    const amtFmt = Number(amountBs).toLocaleString("es-VE");
    const text =
      `✅ *Recibimos tu comprobante*\n\n` +
      `El monto de *Bs ${amtFmt}* coincide con la cotización *${quotationRef}* de esta conversación. ` +
      `En breve el equipo registrará tu *orden de compra* y te avisará por aquí.`;
    await sendWasenderTextMessage({
      apiKey,
      apiBaseUrl,
      to: `+${String(toPhone).replace(/\D/g, "")}`,
      text,
      messageType: "CRITICAL",
      customerId: orderLite.customer_id != null ? Number(orderLite.customer_id) : undefined,
    }).catch((e) => log.error({ err: e.message }, "reconciliation: WA cotización-match falló"));
  } catch (_) { /* opcional */ }
}

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

  // Órdenes pendientes · canales de pago bancario (CH-2 WA/redes, CH-3 cotizaciones ML, CH-5 fuerza ventas).
  // Comparar total_amount_bs (VES canónico, ADR-008) contra bank_statements.amount (siempre VES).
  // conversation_id: vínculo al crm_chat — usado para avanzar el pipeline tras conciliar.
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.total_amount_bs AS total_orden, so.notes,
           so.created_at, so.payment_method, so.wa_payment_reminder_at,
           so.conversation_id,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.payment_status = 'pending'
      AND so.channel_id IN (2, 3, 5)
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

      const orderChatId = order.conversation_id != null ? Number(order.conversation_id) : null;

      if (best.level === 1 || best.level === 2) {
        await applyMatch(order, best, orderChatId);
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
        await applyManualReview(order, best, orderChatId);
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
    // Ventana simétrica: el pago puede llegar hasta 2 días ANTES de la orden (cotización/proforma)
    // o hasta 2 días DESPUÉS (acreditación diferida). daysDiff = fecha_pago − fecha_orden.
    const inRange  = daysDiff >= -2 && daysDiff <= 1;
    const extended = daysDiff >= -2 && daysDiff <= 2;

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

async function applyMatch(order, match, chatId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Actualizar la orden: approved + vincular al chat si la orden no tiene conversation_id aún
    await client.query(
      `UPDATE sales_orders
       SET status         = 'paid',
           payment_status = 'approved',
           conversation_id = COALESCE(conversation_id, $2),
           updated_at     = NOW()
       WHERE id = $1`,
      [order.id, chatId ?? null]
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
      chatId,
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
    const { sendWasenderTextMessage } = require("../../wasender-client");
    const apiKey     = process.env.WASENDER_API_KEY;
    const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
    if (apiKey) {
      const toPhone = await resolveWaNotifyPhone(order, chatId);
      if (toPhone) {
        const text = buildPaymentConfirmedWaMessage(order, match);
        const waResult = await sendWasenderTextMessage({
          apiKey,
          apiBaseUrl,
          to:   `+${String(toPhone).replace(/\D/g, "")}`,
          text,
          messageType: "CRITICAL",
          customerId: order.customer_id != null ? Number(order.customer_id) : undefined,
        }).catch((e) => {
          log.error({ err: e.message, orderId: order.id }, "reconciliation: WA notify post-match falló");
          return null;
        });
        if (waResult && !waResult.ok) {
          log.warn({
            orderId:    order.id,
            to:         toPhone,
            chatId,
            httpStatus: waResult.status,
            throttled:  waResult.throttled,
            quiet:      waResult.quiet_hours,
            blocked:    waResult.reason,
          }, "reconciliation: WA notify no entregado");
        }
      } else {
        log.warn({ orderId: order.id, chatId }, "reconciliation: WA notify omitido (sin teléfono)");
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
    chatId:       chatId ?? null,
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
// WA educativo: ingreso en extracto coincide (L3) → pedir comprobante para cerrar rápido
// ─────────────────────────────────────────────────────────────────────────────

let waBankProofColumnPromise = null;
function ensureWaBankProofEducationColumn() {
  if (!waBankProofColumnPromise) {
    waBankProofColumnPromise = pool
      .query(
        `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS wa_bank_proof_education_at TIMESTAMPTZ`
      )
      .catch((err) => {
        log.warn({ err: err.message }, "reconciliation: ALTER wa_bank_proof_education_at falló");
      });
  }
  return waBankProofColumnPromise;
}

/**
 * Solo si el match problemático viene del **banco** (hay movimiento CREDIT relacionado por monto).
 * No enviar si el cliente ya subió algún comprobante tras crear la orden, ni si mandamos el mismo aviso hace menos de 7 días.
 */
async function maybeSendBankProofEducationWa(order, match) {
  if (match.sourceType !== "bank") return;
  if (process.env.RECONCILIATION_BANK_PROOF_EDUCATION_ENABLED !== "1") return;

  await ensureWaBankProofEducationColumn();

  let phone = order.customer_phone;
  if (!phone && order.customer_id) {
    const { rows } = await pool.query(`SELECT phone FROM customers WHERE id = $1 LIMIT 1`, [
      order.customer_id,
    ]);
    phone = rows[0]?.phone;
  }
  if (!phone || String(phone).replace(/\D/g, "").length < 10) {
    log.warn({ orderId: order.id }, "reconciliation: bank_proof_education sin teléfono cliente");
    return;
  }

  const { rows: attemptRows } = await pool.query(
    `SELECT 1 FROM payment_attempts
     WHERE customer_id = $1 AND created_at >= $2
     LIMIT 1`,
    [order.customer_id, order.created_at]
  );
  if (attemptRows.length) {
    log.info({ orderId: order.id }, "reconciliation: bank_proof_education omitido (ya hay comprobante WA)");
    return;
  }

  const { rows: soRows } = await pool.query(
    `SELECT wa_bank_proof_education_at FROM sales_orders WHERE id = $1`,
    [order.id]
  );
  const last = soRows[0]?.wa_bank_proof_education_at;
  if (last) {
    const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (hours < 168) {
      log.info({ orderId: order.id, hoursSince: Math.round(hours) }, "reconciliation: bank_proof_education omitido (cooldown 7d)");
      return;
    }
  }

  const apiKey = process.env.WASENDER_API_KEY;
  const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
  if (!apiKey) return;

  const totalFmt = Number(order.total_orden).toLocaleString("es-VE");
  const amtBank = Number(match.row.amount != null ? match.row.amount : order.total_orden).toLocaleString("es-VE");
  const text =
    `Detectamos un ingreso en el banco por *Bs ${amtBank}* que coincide con tu orden *#${order.id}* (monto orden *Bs ${totalFmt}*).\n` +
    `Para que la conciliación sea automática y tu pedido avance más rápido, envíanos una *foto legible del comprobante* (captura o print) por aquí.`;

  try {
    const { sendWasenderTextMessage } = require("../../wasender-client");
    const waRes = await sendWasenderTextMessage({
      apiKey,
      apiBaseUrl,
      to: `+${String(phone).replace(/\D/g, "")}`,
      text,
      messageType: "REMINDER",
      customerId: order.customer_id != null ? Number(order.customer_id) : undefined,
    });
    if (waRes && waRes.ok) {
      await pool.query(
        `UPDATE sales_orders SET wa_bank_proof_education_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [order.id]
      );
      log.info({ orderId: order.id }, "reconciliation: bank_proof_education WA enviado");
    } else if (waRes && waRes.status === "blocked" && waRes.reason) {
      log.warn({ orderId: order.id, reason: waRes.reason }, "reconciliation: bank_proof_education bloqueado");
    }
  } catch (e) {
    log.error({ err: e.message, orderId: order.id }, "reconciliation: bank_proof_education WA falló");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Revisión manual (L3)
// ─────────────────────────────────────────────────────────────────────────────

async function applyManualReview(order, match, chatId = null) {
  // L3: marcar la orden como pendiente de aprobación humana.
  // Usamos approval_status (workflow de revisión) en lugar de payment_status (estado del dinero).
  // Decisión 2026-04-20: ver ADR-006 amendment nota 2. payment_status permanece 'pending'.
  await pool.query(
    `UPDATE sales_orders
     SET approval_status = 'pending',
         conversation_id = COALESCE(conversation_id, $2),
         updated_at = NOW()
     WHERE id = $1`,
    [order.id, chatId ?? null]
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
      chatId: chatId ?? null,
    }),
    botActionsService.log({
      chatId:       chatId ?? null,
      orderId:      order.id,
      actionType:   "manual_review_required",
      inputContext: { matchLevel: match.level, score: match.score, sourceType: match.sourceType },
      outputResult: { approval_status: "pending" },
      provider:     "rule_engine",
      confidence:   match.score,
    }),
  ]).catch((err) => log.warn({ err: err.message }, "reconciliation: L3 logging falló (no crítico)"));

  maybeSendBankProofEducationWa(order, match).catch((err) =>
    log.warn({ err: err.message, orderId: order.id }, "reconciliation: bank_proof_education async falló")
  );
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

  // Refuerzo por WA (comprobante): solo si RECONCILIATION_WA_REMINDERS_ENABLED=1 en el servidor.
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
              text: `⏳ Hola, aún no registramos el pago de tu orden *#${order.id}*.\nMonto: *Bs ${totalFmt}*\nPara conciliar, envía una *foto legible del comprobante* (captura de pantalla o foto del print) por aquí. 📸`,
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

  // Órdenes pendientes · canales bancarios (CH-2, CH-3 cotizaciones ML, CH-5) · total_amount_bs canónico (ADR-008)
  const { rows: orders } = await pool.query(`
    SELECT so.id, so.source, so.external_order_id,
           so.customer_id, so.total_amount_bs AS total_orden, so.notes,
           so.created_at, so.payment_method, so.wa_payment_reminder_at,
           so.conversation_id,
           c.phone AS customer_phone
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.payment_status = 'pending'
      AND so.channel_id IN (2, 3, 5)
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
    const orderChatId = order.conversation_id != null ? Number(order.conversation_id) : null;
    try {
      // findBestMatch(order, rows, tolerance, sourceType) — busca en rows el mejor match para order
      const match = findBestMatch(order, stmtPool, TOLERANCE.BANK_STATEMENT, "bank");
      if (!match) continue;

      if (match.level === 1 || match.level === 2) {
        await applyMatch(order, match, orderChatId);
        // Evitar reusar el mismo statement para otra orden
        const idx = stmtPool.findIndex((s) => s.id === match.row.id);
        if (idx !== -1) stmtPool.splice(idx, 1);
        log.info({ orderId: order.id, statementId: match.row.id, level: match.level, chatId: orderChatId },
          "reconcileStatements: MATCH aplicado");
      } else {
        await applyManualReview(order, match, orderChatId);
        log.warn({ orderId: order.id, statementId: match.row.id, chatId: orderChatId },
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
    `SELECT id, customer_id, chat_id, extracted_reference,
            extracted_amount_bs, extracted_date, extraction_confidence
     FROM payment_attempts
     WHERE id = $1
       AND reconciliation_status = 'pending'
       AND extracted_amount_bs IS NOT NULL`,
    [paymentAttemptId]
  );

  if (!attempts.length) return;
  const attempt = attempts[0];

  const attemptCustomerId = attempt.customer_id != null ? Number(attempt.customer_id) : null;
  const attemptChatId     = attempt.chat_id     != null ? Number(attempt.chat_id)     : null;

  // ── Paso 1: buscar órdenes directamente vinculadas al chat del attempt ───────
  // La cotización y/o la orden pueden tener conversation_id = chat_id → prioridad máxima.
  let chatLinkedOrderIds = new Set();
  if (attemptChatId) {
    const { rows: chatOrders } = await pool.query(
      `SELECT so.id
       FROM sales_orders so
       WHERE so.payment_status = 'pending'
         AND so.channel_id IN (2, 3, 5)
         AND so.total_amount_bs IS NOT NULL
         AND so.total_amount_bs > 0
         AND (
           so.conversation_id = $1
           OR so.id IN (
             SELECT ip.order_id FROM inventario_presupuesto ip
             WHERE ip.chat_id = $1 AND ip.order_id IS NOT NULL
           )
         )`,
      [attemptChatId]
    );
    for (const r of chatOrders) chatLinkedOrderIds.add(Number(r.id));
  }

  // ── Paso 2: todas las órdenes elegibles, ordenadas: chat-linked → mismo customer → resto ──
  const { rows: orders } = await pool.query(
    `SELECT so.id, so.source, so.external_order_id,
            so.customer_id, so.total_amount_bs AS total_orden, so.notes,
            so.created_at, so.payment_method, so.wa_payment_reminder_at,
            so.conversation_id,
            c.phone AS customer_phone
     FROM sales_orders so
     LEFT JOIN customers c ON c.id = so.customer_id
     WHERE so.payment_status = 'pending'
       AND so.channel_id IN (2, 3, 5)
       AND so.total_amount_bs IS NOT NULL
       AND so.total_amount_bs > 0
     ORDER BY
       CASE WHEN so.conversation_id = $1 THEN 0
            WHEN so.id = ANY($2::int[]) THEN 0
            ELSE 1 END,
       CASE WHEN so.customer_id = $3    THEN 0
            ELSE 1 END,
       so.created_at ASC`,
    [
      attemptChatId    ?? 0,
      chatLinkedOrderIds.size ? [...chatLinkedOrderIds] : [0],
      attemptCustomerId ?? 0,
    ]
  );

  let matched = false;
  try {
    for (const order of orders) {
      const match = findBestMatch(order, [attempt], TOLERANCE.PAYMENT_ATTEMPT, "attempt");
      if (!match) continue;

      // Determinar chatId efectivo: del attempt, o del vínculo de la orden
      const effectiveChatId =
        attemptChatId ??
        (order.conversation_id != null ? Number(order.conversation_id) : null);

      matched = true;
      if (match.level === 1 || match.level === 2) {
        await applyMatch(order, match, effectiveChatId);
        log.info({
          attemptId: attempt.id, orderId: order.id, level: match.level,
          chatId: effectiveChatId, customerId: attemptCustomerId,
        }, "reconcileAttempt: MATCH aplicado");
      } else {
        await applyManualReview(order, match, effectiveChatId);
        log.warn({ attemptId: attempt.id, orderId: order.id, chatId: effectiveChatId },
          "reconcileAttempt: enviado a revisión manual");
      }
      break;
    }

    if (!matched) {
      const qOk = await maybeMatchQuotationFromAttempt(attempt, attemptChatId, attemptCustomerId);
      if (qOk) matched = true;
    }

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
        customerId:    attemptCustomerId,
        chatId:        attemptChatId,
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
