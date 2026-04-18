"use strict";

/**
 * Vista Supervisor (Paso 5 · secuencia de 5 pasos).
 *
 * Alimenta la página /ventas/tablero del frontend.
 * Las 3 funciones devuelven datos alineados con src/types/supervisor.ts del FE.
 *
 * Adaptaciones vs. prompt original (schema real de sales_orders):
 *   - sales_orders.chat_id NO existe → se omite en KPI y se devuelve null en waiting.
 *   - sales_orders.rating NO existe → rating siempre 0; no aparece en waiting.
 *   - status es TEXT, valores: 'pending','paid','completed'. No hay 'quoted','approved','delivered'.
 *   - fulfillment_status ENUM con valor actual solo 'pending'; delivery stage siempre 0 por ahora.
 */

const { pool } = require("../../db");
const exceptionsService = require("./exceptionsService");

// ─────────────────────────────────────────────────────────────────────────────
// KPIs globales del tablero
// ─────────────────────────────────────────────────────────────────────────────
async function getSupervisorKPIs() {
  // KPI 1 · Bot resolvió = órdenes cerradas hoy sin excepción asociada
  const botResolvedQuery = `
    WITH today_orders AS (
      SELECT so.id, so.status, so.payment_status
      FROM sales_orders so
      WHERE DATE(so.updated_at) = CURRENT_DATE
    )
    SELECT
      COUNT(*) FILTER (
        WHERE t.status IN ('paid','completed')
          AND t.payment_status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM exceptions ex
            WHERE ex.entity_type = 'order'
              AND ex.entity_id = t.id
              AND ex.status != 'ignored'
          )
      )::int AS bot_resolved_today,
      COUNT(*)::int AS total_today
    FROM today_orders t
  `;
  const { bot_resolved_today, total_today } = (await pool.query(botResolvedQuery)).rows[0];
  const percentage = total_today > 0 ? Math.round((bot_resolved_today / total_today) * 100) : 0;

  // KPI 2 · Esperando comprador, desglosado por etapa
  // Schema real: no hay columnas 'rating' ni estados 'quoted'/'approved'/'delivered'.
  // Aproximación: todo lo 'pending' se clasifica por payment_status y fulfillment_status.
  const waitingQuery = `
    SELECT
      0::int                                                                          AS approval,
      COUNT(*) FILTER (
        WHERE so.status = 'pending' AND so.payment_status = 'pending'
      )::int                                                                          AS payment,
      COUNT(*) FILTER (
        WHERE so.status = 'paid' AND so.fulfillment_status = 'pending'
      )::int                                                                          AS delivery,
      0::int                                                                          AS rating
    FROM sales_orders so
    WHERE so.status IN ('pending','paid')
  `;
  const { approval, payment, delivery, rating } = (await pool.query(waitingQuery)).rows[0];
  const waitingCount = approval + payment + delivery + rating;

  // KPI 3 · Excepciones abiertas (reusa Paso 2)
  const exceptionsCount = await exceptionsService.countOpen().catch(() => 0);

  // KPI 4 · Cerradas hoy
  const closedQuery = `
    SELECT COUNT(*)::int                                        AS count,
           COALESCE(SUM(so.order_total_amount), 0)::numeric     AS amount_total
    FROM sales_orders so
    WHERE DATE(so.updated_at) = CURRENT_DATE
      AND so.status IN ('paid','completed')
      AND so.payment_status = 'approved'
  `;
  const { count: closedCount, amount_total } = (await pool.query(closedQuery)).rows[0];

  return {
    bot_resolved: {
      percentage,
      count_today:       bot_resolved_today,
      count_total_today: total_today,
    },
    waiting_buyer: {
      count: waitingCount,
      by_stage: { approval, payment, delivery, rating },
    },
    exceptions:   { count: exceptionsCount },
    closed_today: { count: closedCount, amount_usd: Math.round(Number(amount_total)) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lista de "esperando comprador"
// ─────────────────────────────────────────────────────────────────────────────
function initialsFromName(name) {
  const parts = String(name || "Cliente Desconocido").trim().split(/\s+/);
  const first = parts[0]?.[0] || "N";
  const second = parts[1]?.[0] || parts[0]?.[1] || "N";
  return (first + second).toUpperCase();
}

async function getSupervisorWaiting() {
  const sql = `
    SELECT
      so.id                  AS order_id,
      so.customer_id,
      c.full_name            AS customer_name,
      so.order_total_amount  AS amount,
      so.updated_at          AS since,
      so.status,
      so.payment_status,
      so.fulfillment_status,
      CASE
        WHEN so.status = 'pending' AND so.payment_status = 'pending' THEN 'payment'
        WHEN so.status = 'paid'    AND so.fulfillment_status = 'pending' THEN 'delivery'
        ELSE NULL
      END                    AS stage_reason,
      (
        SELECT ba.output_result::text
        FROM bot_actions ba
        WHERE ba.order_id = so.id
        ORDER BY ba.created_at DESC
        LIMIT 1
      )                      AS last_bot_action
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.status IN ('pending','paid')
      AND (
        (so.status = 'pending' AND so.payment_status = 'pending')
        OR (so.status = 'paid' AND so.fulfillment_status = 'pending')
      )
    ORDER BY so.updated_at DESC
    LIMIT 50
  `;
  const { rows } = await pool.query(sql);

  const descByStage = {
    payment:  "Pago pendiente · esperando comprobante",
    delivery: "Pago aprobado · preparando despacho",
  };

  return rows
    .filter(r => r.stage_reason !== null)
    .map(r => ({
      id:                 Number(r.order_id),
      order_id:           Number(r.order_id),
      chat_id:            null, // sales_orders no tiene chat_id en el schema real
      customer_name:      r.customer_name || "Cliente sin nombre",
      customer_initials:  initialsFromName(r.customer_name),
      stage_reason:       r.stage_reason,
      stage_description:  descByStage[r.stage_reason] || "En progreso",
      bot_log:            r.last_bot_action || "Bot esperando acción del comprador",
      amount_usd:         Math.round(Number(r.amount) || 0),
      since_iso:          r.since,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Lista de excepciones abiertas mapeadas al shape del mockup
// ─────────────────────────────────────────────────────────────────────────────
const KIND_MAPPING = {
  payment_no_match:         "payment_no_match",
  stock_zero_no_supplier:   "stock_zero_no_supplier",
  stock_zero:               "stock_zero_no_supplier",
  unhappy_customer:         "unhappy_customer",
  ambiguity_unresolved:     "ambiguity_unresolved",
  ambiguity:                "ambiguity_unresolved",
  high_amount_policy:       "high_amount_policy",
  high_amount:              "high_amount_policy",
  manual_review_required:   "payment_no_match",
};

const ACTIONS_BY_KIND = {
  payment_no_match: {
    primary_action:   { label: "REVISAR", kind: "primary" },
    secondary_action: { label: "CHAT",    kind: "secondary" },
  },
  stock_zero_no_supplier: {
    primary_action:   { label: "RESOLVER", kind: "primary" },
  },
  unhappy_customer: {
    primary_action:   { label: "LLAMAR", kind: "primary" },
    secondary_action: { label: "CHAT",   kind: "secondary" },
  },
  ambiguity_unresolved: {
    primary_action:   { label: "VER FOTO", kind: "secondary" },
  },
  high_amount_policy: {
    primary_action:   { label: "APROBAR", kind: "secondary" },
    secondary_action: { label: "EDITAR",  kind: "secondary" },
  },
};

function mapExceptionForSupervisor(exc) {
  const kind = KIND_MAPPING[exc.reason] || "payment_no_match";

  const ctx = exc.context || {};
  const customer = ctx.customer_name;
  const amount = ctx.amount;
  let title;
  if (customer && amount) title = `${customer} · $ ${amount}`;
  else if (customer)      title = customer;
  else                    title = `${exc.entity_type} #${exc.entity_id}`;

  const actions = ACTIONS_BY_KIND[kind] || { primary_action: { label: "REVISAR", kind: "primary" } };

  return {
    id:               Number(exc.id),
    kind,
    title,
    detail:           ctx.detail || exc.reason || "Excepción detectada por el bot",
    primary_action:   actions.primary_action,
    secondary_action: actions.secondary_action || null,
    chat_id:          exc.chat_id,
    order_id:         exc.entity_type === "order" || exc.entity_type === "payment" ? Number(exc.entity_id) : null,
    created_at:       exc.created_at,
  };
}

async function getSupervisorExceptions() {
  const raw = await exceptionsService.list({ status: "open", limit: 50 });
  return raw.map(mapExceptionForSupervisor);
}

module.exports = {
  getSupervisorKPIs,
  getSupervisorWaiting,
  getSupervisorExceptions,
};
