"use strict";

const { pool } = require("../../db");
const { mapSchemaError } = require("./crmIdentityService");

const FILTERS = new Set(["unread", "payment_pending", "quote", "dispatch"]);
const SRCS = new Set(["wa", "ml", "ml_question", "ml_message", "wa_ml_linked"]);

/**
 * Etapas canónicas del pipeline de un chat (8 valores).
 * Distinto de LIFECYCLE_STAGE_VALUES (salesService.js) que es feedback ML post-venta.
 *
 * Orden de avance del pipeline:
 *   contact → ml_answer → quote → approved → order → payment → dispatch → closed
 *
 * 'order': orden existe y está activa, pero payment_status no es 'pending' ni
 *          ('approved' con fulfillment_type). Caso típico: pago confirmado pero
 *          fulfillment_type aún sin asignar, u orden recién creada sin payment_status.
 */
const CHAT_STAGE_VALUES = new Set([
  "contact",
  "ml_answer",
  "quote",
  "approved",
  "order",
  "payment",
  "dispatch",
  "closed",
]);

/** Orden activa por chat (excluye completed/cancelled — usada para filtros de lista). */
const JOIN_ORDER = `
  LEFT JOIN LATERAL (
    SELECT so2.id, so2.payment_status, so2.fulfillment_type, so2.channel_id, so2.status
    FROM sales_orders so2
    WHERE so2.conversation_id = cc.id
      AND so2.status NOT IN ('completed', 'cancelled')
    ORDER BY so2.created_at DESC NULLS LAST
    LIMIT 1
  ) so ON true
`;

/** Orden más reciente por chat sin filtro de estado — usada solo para calcular chat_stage. */
const JOIN_ORDER_LATEST = `
  LEFT JOIN LATERAL (
    SELECT so3.id, so3.payment_status, so3.fulfillment_type, so3.status
    FROM sales_orders so3
    WHERE so3.conversation_id = cc.id
    ORDER BY so3.created_at DESC NULLS LAST
    LIMIT 1
  ) sol ON true
`;

/** Cotización activa más reciente por chat — usada solo para calcular chat_stage. */
const JOIN_QUOTE_ACTIVE = `
  LEFT JOIN LATERAL (
    SELECT ip2.status AS quote_status
    FROM inventario_presupuesto ip2
    WHERE ip2.chat_id = cc.id
      AND ip2.status NOT IN ('converted', 'expired')
    ORDER BY ip2.fecha_creacion DESC NULLS LAST
    LIMIT 1
  ) iq ON true
`;

/**
 * Expresión SQL que calcula el chat_stage.
 * Requiere los alias sol (JOIN_ORDER_LATEST) e iq (JOIN_QUOTE_ACTIVE).
 * Prioridad de evaluación (primera rama que aplica gana):
 *   closed → dispatch → payment → order → approved → quote → ml_answer → contact
 *
 * Nota: 'order' se emite cuando hay orden activa pero payment_status no es 'pending'
 * ni ('approved' + fulfillment_type). Ejemplo: pago aprobado sin tipo de despacho aún.
 */
const CHAT_STAGE_EXPR = `
  CASE
    WHEN sol.status IN ('completed', 'cancelled')                                       THEN 'closed'
    WHEN sol.payment_status = 'approved' AND sol.fulfillment_type IS NOT NULL           THEN 'dispatch'
    WHEN sol.payment_status = 'pending'                                                 THEN 'payment'
    WHEN sol.id IS NOT NULL                                                             THEN 'order'
    WHEN iq.quote_status = 'approved'                                                   THEN 'approved'
    WHEN iq.quote_status IN ('draft', 'borrador', 'sent')                               THEN 'quote'
    WHEN cc.source_type = 'ml_question'                                                 THEN 'ml_answer'
    ELSE 'contact'
  END
`;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.floor(n), 100);
}

function parseCursor(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const d = new Date(String(raw).trim());
  if (Number.isNaN(d.getTime())) {
    const e = new Error("invalid_cursor");
    e.code = "BAD_REQUEST";
    throw e;
  }
  return d.toISOString();
}

function buildFilters(filter, src, search, cursorIso) {
  const conds = [];
  const params = [];
  let p = 1;

  if (filter === "unread") {
    conds.push(`cc.unread_count > 0`);
  } else if (filter === "payment_pending") {
    conds.push(`so.payment_status = 'pending'::payment_status_enum`);
  } else if (filter === "quote") {
    conds.push(`so.id IS NULL`);
  } else if (filter === "dispatch") {
    conds.push(`so.payment_status = 'approved'::payment_status_enum`);
    conds.push(`so.fulfillment_type IS NOT NULL`);
  }

  if (src === "wa") {
    conds.push(`cc.source_type = 'wa_inbound'`);
  } else if (src === "ml") {
    conds.push(
      `cc.source_type IN ('ml_question','ml_message','wa_ml_linked')`
    );
  } else if (src === "ml_question") {
    conds.push(`cc.source_type = 'ml_question'`);
  } else if (src === "ml_message") {
    conds.push(`cc.source_type = 'ml_message'`);
  } else if (src === "wa_ml_linked") {
    conds.push(`cc.source_type = 'wa_ml_linked'`);
  }

  if (search) {
    conds.push(`(c.full_name ILIKE $${p} OR cc.phone ILIKE $${p})`);
    params.push(`%${search}%`);
    p += 1;
  }

  if (cursorIso) {
    conds.push(`cc.last_message_at < $${p}::timestamptz`);
    params.push(cursorIso);
    p += 1;
  }

  const where = conds.length ? `AND ${conds.join(" AND ")}` : "";
  return { where, params };
}

/**
 * @param {object} opts
 * @param {string|null} [opts.filter]
 * @param {string|null} [opts.src]
 * @param {string|null} [opts.search]
 * @param {string|null} [opts.cursor]
 * @param {number} [opts.limit]
 */
async function listInbox(opts) {
  const limit = clampLimit(opts.limit);
  const filter = opts.filter && FILTERS.has(String(opts.filter)) ? String(opts.filter) : null;
  const src = opts.src && SRCS.has(String(opts.src)) ? String(opts.src) : null;
  const search =
    opts.search != null && String(opts.search).trim() !== "" ? String(opts.search).trim() : null;
  const cursorIso = opts.cursor ? parseCursor(opts.cursor) : null;

  const { where, params } = buildFilters(filter, src, search, cursorIso);

  // fromSql usa JOIN_ORDER (filtra completed/cancelled) para que los filtros de lista sean correctos.
  const fromSql = `
    FROM crm_chats cc
    LEFT JOIN customers c ON cc.customer_id = c.id
    ${JOIN_ORDER}
    WHERE 1=1
    ${where}
  `;

  // fromExtSql añade los joins adicionales para chat_stage (solo en el SELECT, no en COUNT ni filtros).
  const fromExtSql = `
    FROM crm_chats cc
    LEFT JOIN customers c ON cc.customer_id = c.id
    ${JOIN_ORDER}
    ${JOIN_ORDER_LATEST}
    ${JOIN_QUOTE_ACTIVE}
    WHERE 1=1
    ${where}
  `;

  try {
    const countSql = `SELECT COUNT(*)::bigint AS n ${fromSql}`;
    const { rows: countRows } = await pool.query(countSql, [...params]);
    const total = Number(countRows[0].n) || 0;

    const limPos = params.length + 1;
    const listParams = [...params, limit + 1];
    const sql = `
      SELECT
        cc.id,
        cc.phone,
        cc.source_type,
        cc.identity_status,
        cc.last_message_text,
        cc.last_message_at,
        cc.unread_count,
        cc.ml_order_id,
        cc.assigned_to,
        c.full_name AS customer_name,
        so.id AS order_id,
        so.payment_status::text AS payment_status,
        so.fulfillment_type,
        so.channel_id,
        (${CHAT_STAGE_EXPR}) AS chat_stage
      ${fromExtSql}
      ORDER BY cc.last_message_at DESC NULLS LAST, cc.id DESC
      LIMIT $${limPos}
    `;

    const { rows } = await pool.query(sql, listParams);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const chats = slice.map((r) => {
      const order =
        r.order_id != null
          ? {
              id: Number(r.order_id),
              payment_status: r.payment_status,
              fulfillment_type: r.fulfillment_type,
              channel_id: r.channel_id != null ? Number(r.channel_id) : null,
            }
          : null;
      return {
        id: Number(r.id),
        phone: r.phone,
        source_type: r.source_type,
        identity_status: r.identity_status,
        last_message_text: r.last_message_text,
        last_message_at:
          r.last_message_at != null ? new Date(r.last_message_at).toISOString() : null,
        unread_count: Number(r.unread_count) || 0,
        ml_order_id: r.ml_order_id != null ? String(r.ml_order_id) : null,
        assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null,
        customer_name: r.customer_name || null,
        order,
        chat_stage: r.chat_stage || "contact",
      };
    });

    const last = slice[slice.length - 1];
    const nextCursor =
      hasMore && last && last.last_message_at != null
        ? new Date(last.last_message_at).toISOString()
        : null;

    return { chats, nextCursor, total };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

async function getInboxCounts() {
  const sql = `
    SELECT
      COUNT(DISTINCT cc.id) AS total,
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.unread_count > 0) AS unread,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE so.payment_status = 'pending'::payment_status_enum
      ) AS payment_pending,
      COUNT(DISTINCT cc.id) FILTER (WHERE so.id IS NULL) AS quote,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE so.payment_status = 'approved'::payment_status_enum
          AND so.fulfillment_type IS NOT NULL
      ) AS dispatch,
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.source_type = 'wa_inbound') AS wa,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE cc.source_type IN ('ml_question','ml_message','wa_ml_linked')
      ) AS ml
    FROM crm_chats cc
    ${JOIN_ORDER}
  `;

  // BE-1.8: chats con handoff activo en este momento
  // Tabla bot_handoffs creada en BE-1.5 (npm run db:bot-handoffs).
  // Si aún no existe, retorna 0 sin romper el endpoint.
  const handoffSql = `
    SELECT COUNT(DISTINCT chat_id) AS handed_over
    FROM bot_handoffs
    WHERE ended_at IS NULL
  `;

  try {
    const [{ rows }, handoffResult] = await Promise.all([
      pool.query(sql),
      pool.query(handoffSql).catch((err) => {
        // Tabla bot_handoffs aún no migrada — degradar a 0 sin error
        if (err.code === "42P01") return { rows: [{ handed_over: "0" }] };
        throw err;
      }),
    ]);
    const r = rows[0] || {};
    const h = handoffResult.rows[0] || {};
    return {
      total: Number(r.total) || 0,
      unread: Number(r.unread) || 0,
      payment_pending: Number(r.payment_pending) || 0,
      quote: Number(r.quote) || 0,
      dispatch: Number(r.dispatch) || 0,
      wa: Number(r.wa) || 0,
      ml: Number(r.ml) || 0,
      // BE-1.8: contadores nuevos — compatibles con shape anterior (campos adicionales)
      handed_over: Number(h.handed_over) || 0,
      // Backlog: reemplazar con exceptionsService.countOpen() cuando exista tabla exceptions
      exceptions: 0,
    };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

module.exports = { listInbox, getInboxCounts, FILTERS, SRCS, CHAT_STAGE_VALUES };
