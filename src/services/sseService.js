"use strict";

/**
 * Servicio SSE (Server-Sent Events) — Singleton de clientes y emisor de eventos.
 *
 * Patrón: Set en memoria con un objeto { res, userId, connectedAt } por cliente.
 * Suficiente para una sola instancia en Render; si escala a múltiples → Redis pub/sub.
 *
 * Emite en broadcast (todos) o por userId específico.
 * Clientes muertos (desconexión abrupta) se detectan en el write() y se limpian.
 */

const pino = require("pino");
const log  = pino({ level: process.env.LOG_LEVEL || "info", name: "sse" });

// ─── Tipos de eventos del sistema ────────────────────────────────────────────

const SSE_EVENTS = {
  PAYMENT_CONFIRMED:    "payment_confirmed",
  /** Comprobante matcheado contra cotización (sin orden ERP aún). */
  QUOTATION_RECEIPT_MATCHED: "quotation_receipt_matched",
  PAYMENT_MANUAL:       "payment_manual_review",
  PAYMENT_OVERDUE:      "payment_overdue",
  RECEIPT_DETECTED:     "receipt_detected",
  WA_SESSION_STATUS:    "wa_session_status",
  ORDER_STATUS_CHANGED: "order_status_changed",
  CASH_PAYMENT_SUBMITTED: "cash_payment_submitted",
  CASH_PAYMENT_APPROVED:  "cash_payment_approved",
  CASH_PAYMENT_REJECTED:  "cash_payment_rejected",
  CASH_LOSS_ALERT:        "cash_loss_alert",
};

// ─── Registro de clientes activos ────────────────────────────────────────────

const clients         = new Set();
let   totalConnections = 0;

function addClient(res, userId = "anonymous") {
  const client = { res, userId, connectedAt: Date.now() };
  clients.add(client);
  totalConnections++;
  log.info({ userId, total: clients.size }, "sse: cliente conectado");
  return client;
}

function removeClient(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  log.info({
    userId:   client.userId,
    duration: `${Math.round((Date.now() - client.connectedAt) / 1000)}s`,
    total:    clients.size,
  }, "sse: cliente desconectado");
}

// ─── Broadcast a todos los clientes ──────────────────────────────────────────

function emit(eventType, payload) {
  if (clients.size === 0) return;

  const data    = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  const message = `event: ${eventType}\ndata: ${data}\n\n`;
  const dead    = [];

  for (const client of clients) {
    try {
      client.res.write(message);
    } catch (_) {
      dead.push(client);
    }
  }

  for (const client of dead) removeClient(client);

  if (dead.length === 0) {
    log.debug({ eventType, clients: clients.size }, "sse: evento emitido");
  }
}

// ─── Emit a un usuario específico ────────────────────────────────────────────

function emitToUser(userId, eventType, payload) {
  const data    = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  const message = `event: ${eventType}\ndata: ${data}\n\n`;

  for (const client of clients) {
    if (client.userId === userId) {
      try { client.res.write(message); } catch (_) {}
    }
  }
}

// ─── Helpers tipados por evento de negocio ────────────────────────────────────

function emitPaymentConfirmed({ orderId, customerId, amountBs, matchLevel, source, customerPhone }) {
  emit(SSE_EVENTS.PAYMENT_CONFIRMED, {
    order_id:       orderId,
    customer_id:    customerId,
    amount_bs:      amountBs,
    match_level:    matchLevel,
    matched_via:    source,
    customer_phone: customerPhone,
  });
}

/** Comprobante alineado a cotización del mismo chat (listo para “crear orden CH-2”). */
function emitQuotationReceiptMatched({
  quotationId,
  chatId,
  attemptId,
  amountBs,
  reference,
}) {
  emit(SSE_EVENTS.QUOTATION_RECEIPT_MATCHED, {
    quotation_id: quotationId,
    chat_id:      chatId,
    attempt_id:   attemptId,
    amount_bs:    amountBs,
    reference:    reference || null,
    message:      "Comprobante conciliado con cotización — pendiente crear orden",
  });
}

function emitPaymentManualReview({ orderId, customerId, amountBs, source }) {
  emit(SSE_EVENTS.PAYMENT_MANUAL, {
    order_id:    orderId,
    customer_id: customerId,
    amount_bs:   amountBs,
    matched_via: source,
    message:     "Requiere verificación manual en cobranza",
  });
}

function emitPaymentOverdue({ orderId, customerId, amountBs, hoursOld }) {
  emit(SSE_EVENTS.PAYMENT_OVERDUE, {
    order_id:    orderId,
    customer_id: customerId,
    amount_bs:   amountBs,
    hours_old:   hoursOld,
    message:     "Orden sin pago después de 24 horas",
  });
}

function emitReceiptDetected({ customerId, chatId, amountBs, reference, bank, confidence }) {
  emit(SSE_EVENTS.RECEIPT_DETECTED, {
    customer_id: customerId,
    chat_id:     chatId,
    amount_bs:   amountBs,
    reference,
    bank,
    confidence,
    message:     "Comprobante detectado — conciliación en proceso",
  });
}

function emitWaSessionStatus({ status, isCritical }) {
  emit(SSE_EVENTS.WA_SESSION_STATUS, {
    status,
    is_critical: isCritical,
    message: isCritical
      ? "Sesión WhatsApp caída — acción requerida"
      : `Sesión WhatsApp: ${status}`,
  });
}

function emitOrderStatusChanged({ orderId, fromStatus, toStatus, changedBy }) {
  emit(SSE_EVENTS.ORDER_STATUS_CHANGED, {
    order_id:    orderId,
    from_status: fromStatus,
    to_status:   toStatus,
    changed_by:  changedBy,
  });
}

// ─── Estadísticas del servicio ────────────────────────────────────────────────

function getStats() {
  return {
    connected_clients:  clients.size,
    total_connections:  totalConnections,
    clients: [...clients].map((c) => ({
      userId:      c.userId,
      connected_s: Math.round((Date.now() - c.connectedAt) / 1000),
    })),
  };
}

module.exports = {
  SSE_EVENTS,
  addClient,
  removeClient,
  emit,
  emitToUser,
  emitPaymentConfirmed,
  emitQuotationReceiptMatched,
  emitPaymentManualReview,
  emitPaymentOverdue,
  emitReceiptDetected,
  emitWaSessionStatus,
  emitOrderStatusChanged,
  getStats,
};
