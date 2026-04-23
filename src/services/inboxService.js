"use strict";

const { pool } = require("../../db");
const { mapSchemaError } = require("./crmIdentityService");
const exceptionsService = require("./exceptionsService");

const FILTERS = new Set(["unread", "payment_pending", "quote", "dispatch"]);
const SRCS = new Set(["wa", "ml", "ml_question", "ml_message", "wa_ml_linked"]);

/** Filtro de resultado comercial (última orden por chat, alias `sol`). */
const RESULTS = new Set(["no_conversion", "converted", "in_progress"]);

/**
 * Etapas canónicas del pipeline de un chat (7 valores).
 * Distinto de LIFECYCLE_STAGE_VALUES (salesService.js) que es feedback ML post-venta.
 *
 * Orden de avance:
 *   contact → quote → order → payment → dispatch → closed  (6 etapas)
 *
 * Mensajes pack ML (`ml_message`): order/payment/dispatch si `sol`/`so` enlazan una
 * `sales_orders` (por `conversation_id`, por PK erróneo legacy, o por `ml_order_id` ML =
 * segmento de `external_order_id` mercadolibre). Sin orden importada → contact.
 *
 * Pregunta ML: no hay etapa "Resp. ML". Sin respuesta en ML → contact; respondida
 * en ML → quote (siguiente paso operativo: cotización formal en ERP).
 *
 * 'order': cotización aprobada (quote_status=approved) O existe orden activa en ERP.
 *          Unifica las antiguas etapas 'approved' y 'order' en una sola.
 */
const CHAT_STAGE_VALUES = new Set([
  "contact",
  "quote",
  "order",
  "payment",
  "dispatch",
  "closed",
]);

/**
 * Orden activa por chat (excluye completed/cancelled — usada para filtros de lista).
 * Busca por conversation_id primero; si el chat tiene ml_order_id lo usa como fallback.
 *
 * Para chats ml_question: se omite el match por conversation_id porque lookupMlConversation
 * asigna automáticamente conversation_id durante la importación de órdenes, lo que generaría
 * falsos positivos de pipeline. Para esos chats solo se acepta cc.ml_order_id (vínculo
 * explícito vía "Vincular Orden ML").
 *
 * Para chats ml_message: `cc.ml_order_id` es el order_id de Mercado Libre (no PK de
 * sales_orders). Se enlaza por `external_order_id` tipo `ml_user_id-order_id` (misma
 * lógica que GET /api/sales/resolve-ml-order).
 */
const JOIN_ORDER = `
  LEFT JOIN LATERAL (
    SELECT so2.id, so2.payment_status, so2.fulfillment_type, so2.channel_id, so2.status
    FROM sales_orders so2
    WHERE (
      (cc.source_type != 'ml_question' AND so2.conversation_id = cc.id)
      OR (cc.ml_order_id IS NOT NULL AND so2.id = cc.ml_order_id)
      OR (
        cc.source_type = 'ml_message'
        AND cc.ml_order_id IS NOT NULL
        AND so2.source = 'mercadolibre'
        AND so2.external_order_id ~ '^[0-9]+-[0-9]+$'
        AND split_part(so2.external_order_id, '-', 2)::bigint = cc.ml_order_id::bigint
      )
    )
      AND so2.status NOT IN ('completed', 'cancelled')
    ORDER BY
      CASE
        WHEN cc.source_type = 'ml_message'
          AND cc.ml_order_id IS NOT NULL
          AND so2.source = 'mercadolibre'
          AND so2.external_order_id ~ '^[0-9]+-[0-9]+$'
          AND split_part(so2.external_order_id, '-', 2)::bigint = cc.ml_order_id::bigint
          THEN 0
        WHEN cc.ml_order_id IS NOT NULL AND so2.id = cc.ml_order_id THEN 1
        WHEN cc.source_type != 'ml_question' AND so2.conversation_id = cc.id THEN 2
        ELSE 3
      END,
      so2.created_at DESC NULLS LAST
    LIMIT 1
  ) so ON true
`;

/**
 * Orden más reciente por chat sin filtro de estado — usada solo para calcular chat_stage.
 * Igual que JOIN_ORDER pero sin excluir completed/cancelled para detectar 'closed'.
 * Aplica la misma exclusión de conversation_id para ml_question.
 */
const JOIN_ORDER_LATEST = `
  LEFT JOIN LATERAL (
    SELECT so3.id, so3.payment_status, so3.fulfillment_type, so3.status
    FROM sales_orders so3
    WHERE (
      (cc.source_type != 'ml_question' AND so3.conversation_id = cc.id)
      OR (cc.ml_order_id IS NOT NULL AND so3.id = cc.ml_order_id)
      OR (
        cc.source_type = 'ml_message'
        AND cc.ml_order_id IS NOT NULL
        AND so3.source = 'mercadolibre'
        AND so3.external_order_id ~ '^[0-9]+-[0-9]+$'
        AND split_part(so3.external_order_id, '-', 2)::bigint = cc.ml_order_id::bigint
      )
    )
    ORDER BY
      CASE
        WHEN cc.source_type = 'ml_message'
          AND cc.ml_order_id IS NOT NULL
          AND so3.source = 'mercadolibre'
          AND so3.external_order_id ~ '^[0-9]+-[0-9]+$'
          AND split_part(so3.external_order_id, '-', 2)::bigint = cc.ml_order_id::bigint
          THEN 0
        WHEN cc.ml_order_id IS NOT NULL AND so3.id = cc.ml_order_id THEN 1
        WHEN cc.source_type != 'ml_question' AND so3.conversation_id = cc.id THEN 2
        ELSE 3
      END,
      so3.created_at DESC NULLS LAST
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

/** Último mensaje del hilo (dirección + instante); fuente de verdad para “pendiente vendedor” vs atendido. */
const JOIN_LAST_MESSAGE = `
  LEFT JOIN LATERAL (
    SELECT m.direction::text AS direction,
           m.created_at AS msg_created_at
    FROM crm_messages m
    WHERE m.chat_id = cc.id
    ORDER BY m.created_at DESC NULLS LAST, m.id DESC
    LIMIT 1
  ) last_msg ON true
`;

/**
 * Pendiente de respuesta del vendedor (badge “1” / filtro Sin atender):
 * último mensaje inbound y sin override manual vigente (marked_attended_at).
 */
const PENDING_REPLY_EXPR = `(
  last_msg.direction = 'inbound'
  AND (
    cc.marked_attended_at IS NULL
    OR last_msg.msg_created_at > cc.marked_attended_at
  )
)`;

/**
 * ¿Respondida? Hay fila en `ml_questions_answered` (webhook/refresh/POST answer) o en
 * `ml_questions_pending` con `ml_status = 'ANSWERED'` (transición al persistir respuesta).
 */
const JOIN_ML_QUESTION_ANSWERED = `
  LEFT JOIN LATERAL (
    SELECT TRUE AS answered
    FROM (
      SELECT 1 FROM ml_questions_answered mqa
      WHERE mqa.ml_question_id = cc.ml_question_id
      UNION ALL
      SELECT 1 FROM ml_questions_pending p
      WHERE p.ml_question_id = cc.ml_question_id AND p.ml_status = 'ANSWERED'
    ) x
    LIMIT 1
  ) mlq_ans ON true
`;

const CRM_IDENTITY_RECOGNIZED_SQL = `(cc.customer_id IS NOT NULL OR cc.identity_status IN ('auto_matched', 'manual_linked', 'declared'))`;

/**
 * Hilo de pregunta ML ya respondida en BD y sin cliente identificado: ocultar sin `?src=`.
 * Importante: `syncAnsweredMlQuestionToCrm` pasa `source_type` a `ml_message`; `ml_question_id`
 * sigue en `crm_chats`, por eso el criterio es `ml_question_id IS NOT NULL`, no solo `ml_question`.
 */
const EXCLUDE_ANSWERED_ML_QUESTION_IDLE_SQL = `NOT (
  cc.ml_question_id IS NOT NULL
  AND mlq_ans.answered IS TRUE
  AND NOT (${CRM_IDENTITY_RECOGNIZED_SQL})
)`;

/**
 * Expresión SQL que calcula el chat_stage.
 * Requiere sol, iq, mlq_ans (JOIN_ORDER_LATEST, JOIN_QUOTE_ACTIVE, JOIN_ML_QUESTION_ANSWERED).
 * Prioridad: closed → dispatch → payment → order → quote (ERP) →
 *   ml_question respondida en ML → quote | ml_question sin respuesta → contact |
 *   ml_message: etapa comercial (order/payment/dispatch/closed) si hay `sol` enlazada;
 *   no exige identidad CRM si hay `ml_order_id` (el hilo post-venta ML ya ancla la venta).
 *   else contact.
 *
 * 'approved' (cotización aprobada) ahora se mapea a 'order' — mismo estado visual.
 */
const CHAT_STAGE_EXPR = `
  CASE
    WHEN sol.status IN ('completed', 'cancelled')                                       THEN 'closed'
    WHEN sol.payment_status = 'approved' AND sol.fulfillment_type IS NOT NULL           THEN 'dispatch'
    WHEN sol.payment_status = 'pending'                                                 THEN 'payment'
    WHEN sol.id IS NOT NULL
      AND (
        cc.source_type NOT IN ('ml_message', 'ml_question')
        OR (${CRM_IDENTITY_RECOGNIZED_SQL})
        OR (cc.source_type = 'ml_message' AND cc.ml_order_id IS NOT NULL)
      )                                                                                 THEN 'order'
    WHEN iq.quote_status = 'approved'
      AND (
        cc.source_type NOT IN ('ml_message', 'ml_question')
        OR (${CRM_IDENTITY_RECOGNIZED_SQL})
        OR (cc.source_type = 'ml_message' AND cc.ml_order_id IS NOT NULL)
      )                                                                                 THEN 'order'
    WHEN iq.quote_status IN ('draft', 'borrador', 'sent')                               THEN 'quote'
    WHEN cc.source_type = 'ml_question' AND mlq_ans.answered IS TRUE                    THEN 'quote'
    WHEN cc.source_type = 'ml_question'                                                 THEN 'contact'
    ELSE 'contact'
  END
`;

/**
 * Canal de venta ERP (sales_channels.id) alineado a órdenes activas: si hay `so` de JOIN_ORDER,
 * usa `so.channel_id`; si no, infiere solo por hilo (ML → 3, WA / WA+ML → 2).
 * Debe coincidir con la intención de columnas `order.channel_id` en GET /api/inbox.
 */
const INFERRED_SALES_CHANNEL_SQL = `
  CASE
    WHEN cc.source_type IN ('ml_question', 'ml_message') THEN 3::smallint
    WHEN cc.source_type IN ('wa_inbound', 'wa_ml_linked') THEN 2::smallint
    ELSE NULL::smallint
  END
`;

const RESOLVED_SALES_CHANNEL_SQL = `COALESCE(so.channel_id, (${INFERRED_SALES_CHANNEL_SQL}))`;

/** Misma base de JOIN que listInbox para totales por faceta comparables con `?src=` / `?stage=`. */
const FACET_FROM = `
  FROM crm_chats cc
  ${JOIN_ORDER}
  ${JOIN_ORDER_LATEST}
  ${JOIN_QUOTE_ACTIVE}
  ${JOIN_ML_QUESTION_ANSWERED}
  WHERE ${EXCLUDE_ANSWERED_ML_QUESTION_IDLE_SQL}
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

/**
 * @param {string|null} srcRaw
 * @returns {string[]|null} tokens válidos o null si vacío
 */
function parseSrcList(srcRaw) {
  if (srcRaw == null || String(srcRaw).trim() === "") return null;
  const parts = String(srcRaw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  for (const s of parts) {
    if (!SRCS.has(s)) return null;
  }
  return parts;
}

/**
 * @param {string|null} stageRaw
 * @returns {string[]|null}
 */
function parseStageList(stageRaw) {
  if (stageRaw == null || String(stageRaw).trim() === "") return null;
  const parts = String(stageRaw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  for (const s of parts) {
    if (!CHAT_STAGE_VALUES.has(s)) return null;
  }
  return parts;
}

/**
 * @param {string[]} srcParts
 */
function pushSrcOrConds(conds, srcParts) {
  if (!srcParts || !srcParts.length) return;
  const branches = [];
  for (const src of srcParts) {
    if (src === "wa") {
      branches.push(`cc.source_type = 'wa_inbound'`);
    } else if (src === "ml") {
      branches.push(`cc.source_type IN ('ml_question','ml_message','wa_ml_linked')`);
    } else if (src === "ml_question") {
      branches.push(`cc.source_type = 'ml_question'`);
    } else if (src === "ml_message") {
      branches.push(`cc.source_type = 'ml_message'`);
    } else if (src === "wa_ml_linked") {
      branches.push(`cc.source_type = 'wa_ml_linked'`);
    }
  }
  if (!branches.length) return;
  if (branches.length === 1) {
    conds.push(branches[0]);
  } else {
    conds.push(`(${branches.join(" OR ")})`);
  }
}

/**
 * @param {string|null} filter
 * @param {string[]|null} srcParts
 * @param {string|null} search
 * @param {string|null} cursorIso
 * @param {string[]|null} stageList
 * @param {string|null} result
 * @param {boolean} [hideAnsweredIdleMlQuestion] vista “Todas” sin ?src=
 */
function buildFilters(filter, srcParts, search, cursorIso, stageList, result, hideAnsweredIdleMlQuestion) {
  const conds = [];
  const params = [];
  let p = 1;

  if (filter === "unread") {
    // P1/A2 + override manual: “Sin atender” alineado a `customer_waiting_reply` en listInbox.
    conds.push(`(${PENDING_REPLY_EXPR})`);
  } else if (filter === "payment_pending") {
    conds.push(`so.payment_status = 'pending'::payment_status_enum`);
  } else if (filter === "quote") {
    conds.push(`so.id IS NULL`);
  } else if (filter === "dispatch") {
    conds.push(`so.payment_status = 'approved'::payment_status_enum`);
    conds.push(`so.fulfillment_type IS NOT NULL`);
  }

  pushSrcOrConds(conds, srcParts);

  if (stageList && stageList.length) {
    conds.push(`((${CHAT_STAGE_EXPR}))::text = ANY($${p}::text[])`);
    params.push(stageList);
    p += 1;
  }

  if (result === "no_conversion") {
    conds.push(`sol.id IS NULL`);
  } else if (result === "converted") {
    conds.push(`sol.id IS NOT NULL`);
  } else if (result === "in_progress") {
    conds.push(
      `((${CHAT_STAGE_EXPR}))::text IN ('quote','order','payment','dispatch')`
    );
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

  if (hideAnsweredIdleMlQuestion) {
    conds.push(EXCLUDE_ANSWERED_ML_QUESTION_IDLE_SQL);
  }

  const where = conds.length ? `AND ${conds.join(" AND ")}` : "";
  return { where, params };
}

/**
 * @param {object} opts
 * @param {string|null} [opts.filter]
 * @param {string|null} [opts.src] coma-separado, p. ej. wa,ml_question
 * @param {string|null} [opts.search]
 * @param {string|null} [opts.cursor]
 * @param {string|null} [opts.stage] coma-separado (valores CHAT_STAGE_VALUES)
 * @param {string|null} [opts.result] no_conversion | converted | in_progress
 * @param {number} [opts.limit]
 */
async function listInbox(opts) {
  const limit = clampLimit(opts.limit);
  const filter = opts.filter && FILTERS.has(String(opts.filter)) ? String(opts.filter) : null;
  const srcParts = opts.src != null && String(opts.src).trim() !== "" ? parseSrcList(String(opts.src).trim()) : null;
  const search =
    opts.search != null && String(opts.search).trim() !== "" ? String(opts.search).trim() : null;
  const cursorIso = opts.cursor ? parseCursor(opts.cursor) : null;
  const stageList =
    opts.stage != null && String(opts.stage).trim() !== ""
      ? parseStageList(String(opts.stage).trim())
      : null;
  const result =
    opts.result != null && RESULTS.has(String(opts.result).trim())
      ? String(opts.result).trim()
      : null;

  const hideAnsweredIdleMl = !srcParts || srcParts.length === 0;
  const { where, params } = buildFilters(
    filter,
    srcParts,
    search,
    cursorIso,
    stageList,
    result,
    hideAnsweredIdleMl
  );

  // COUNT y SELECT comparten los mismos JOIN (incl. sol/iq) para filtros por etapa/resultado.
  const fromCommon = `
    FROM crm_chats cc
    LEFT JOIN customers c ON cc.customer_id = c.id
    ${JOIN_ORDER}
    ${JOIN_ORDER_LATEST}
    ${JOIN_QUOTE_ACTIVE}
    ${JOIN_ML_QUESTION_ANSWERED}
    ${JOIN_LAST_MESSAGE}
    WHERE 1=1
    ${where}
  `;

  try {
    const countSql = `SELECT COUNT(*)::bigint AS n ${fromCommon}`;
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
        cc.ml_question_id,
        cc.customer_id,
        cc.assigned_to,
        cc.status,
        cc.sla_deadline_at,
        cc.last_inbound_at,
        cc.last_outbound_at,
        last_msg.direction AS last_message_direction,
        (${PENDING_REPLY_EXPR}) AS customer_waiting_reply,
        COALESCE(cc.is_operational, FALSE) AS is_operational,
        c.full_name AS customer_name,
        so.id AS order_id,
        so.payment_status::text AS payment_status,
        so.fulfillment_type,
        so.channel_id,
        (${CHAT_STAGE_EXPR}) AS chat_stage,
        EXISTS (
          SELECT 1 FROM exceptions ex
          WHERE ex.chat_id = cc.id AND ex.status = 'open'
        ) AS has_active_exception,
        (
          SELECT ex2.reason FROM exceptions ex2
          WHERE ex2.chat_id = cc.id AND ex2.status = 'open'
          ORDER BY ex2.created_at DESC LIMIT 1
        ) AS top_exception_reason
      ${fromCommon}
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
        ml_question_id: r.ml_question_id != null ? Number(r.ml_question_id) : null,
        customer_id: r.customer_id != null ? Number(r.customer_id) : null,
        assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null,
        customer_name: r.customer_name || null,
        order,
        chat_stage: r.chat_stage || "contact",
        status: r.status != null ? String(r.status) : "UNASSIGNED",
        sla_deadline_at:
          r.sla_deadline_at != null ? new Date(r.sla_deadline_at).toISOString() : null,
        last_inbound_at:
          r.last_inbound_at != null ? new Date(r.last_inbound_at).toISOString() : null,
        last_outbound_at:
          r.last_outbound_at != null ? new Date(r.last_outbound_at).toISOString() : null,
        last_message_direction:
          r.last_message_direction != null ? String(r.last_message_direction) : null,
        /** Último mensaje es del cliente/comprador: pendiente respuesta vendedor (p. ej. badge “abandonado” rojo). */
        customer_waiting_reply: r.customer_waiting_reply === true,
        has_active_exception: r.has_active_exception === true,
        top_exception_reason: r.top_exception_reason || null,
        top_exception_code: r.top_exception_reason || null,
        is_operational: r.is_operational === true,
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

/**
 * Totales por faceta con los mismos JOIN que `listInbox` (etapa, ML respondida, cotización activa).
 * Sirve para badges de filtros alineados a `GET /api/inbox?src=&stage=`.
 * @param {import('pg').QueryResultRow} fr
 */
function buildInboxFacetsPayload(fr) {
  const waIn = Number(fr.src_wa_inbound) || 0;
  const waLk = Number(fr.src_wa_ml_linked) || 0;
  const mq = Number(fr.src_ml_question) || 0;
  const mm = Number(fr.src_ml_message) || 0;
  return {
    by_source_type: {
      wa_inbound: waIn,
      wa_ml_linked: waLk,
      ml_question: mq,
      ml_message: mm,
    },
    ml_question: {
      unanswered: Number(fr.ml_question_unanswered) || 0,
      answered: Number(fr.ml_question_answered) || 0,
    },
    /** Catálogo `sales_channels.id`: 1 Mostrador, 2 WA/Redes, 3 ML, 4 E-com, 5 Fuerza ventas. */
    by_sales_channel_id: {
      "1": Number(fr.sc_1) || 0,
      "2": Number(fr.sc_2) || 0,
      "3": Number(fr.sc_3) || 0,
      "4": Number(fr.sc_4) || 0,
      "5": Number(fr.sc_5) || 0,
      null: Number(fr.sc_null) || 0,
    },
    by_chat_stage: {
      contact: Number(fr.st_contact) || 0,
      quote: Number(fr.st_quote) || 0,
      order: Number(fr.st_order) || 0,
      payment: Number(fr.st_payment) || 0,
      dispatch: Number(fr.st_dispatch) || 0,
      closed: Number(fr.st_closed) || 0,
    },
    /** Alineado a tokens `src` de listInbox (`wa` = solo wa_inbound; `ml` = ml_* + wa_ml_linked). */
    src_compound: {
      wa: waIn,
      ml: mq + mm + waLk,
    },
    /** Hilos “WhatsApp” en sentido amplio (incluye unificados WA+ML). */
    whatsapp_threads: waIn + waLk,
    /** Alineado a `GET /api/inbox?result=` (última orden por chat = `sol`). */
    by_result: {
      no_conversion: Number(fr.res_no_conversion) || 0,
      converted: Number(fr.res_converted) || 0,
      in_progress: Number(fr.res_in_progress) || 0,
    },
  };
}

async function fetchInboxFacets() {
  const facetSql = `
    SELECT
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.source_type = 'wa_inbound') AS src_wa_inbound,
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.source_type = 'wa_ml_linked') AS src_wa_ml_linked,
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.source_type = 'ml_question') AS src_ml_question,
      COUNT(DISTINCT cc.id) FILTER (WHERE cc.source_type = 'ml_message') AS src_ml_message,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE cc.source_type = 'ml_question' AND (mlq_ans.answered IS NOT TRUE)
      ) AS ml_question_unanswered,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE cc.source_type = 'ml_question' AND mlq_ans.answered IS TRUE
      ) AS ml_question_answered,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL})::int = 1) AS sc_1,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL})::int = 2) AS sc_2,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL})::int = 3) AS sc_3,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL})::int = 4) AS sc_4,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL})::int = 5) AS sc_5,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${RESOLVED_SALES_CHANNEL_SQL}) IS NULL) AS sc_null,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'contact') AS st_contact,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'quote') AS st_quote,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'order') AS st_order,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'payment') AS st_payment,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'dispatch') AS st_dispatch,
      COUNT(DISTINCT cc.id) FILTER (WHERE ((${CHAT_STAGE_EXPR}))::text = 'closed') AS st_closed,
      COUNT(DISTINCT cc.id) FILTER (WHERE sol.id IS NULL) AS res_no_conversion,
      COUNT(DISTINCT cc.id) FILTER (WHERE sol.id IS NOT NULL) AS res_converted,
      COUNT(DISTINCT cc.id) FILTER (
        WHERE ((${CHAT_STAGE_EXPR}))::text IN ('quote', 'order', 'payment', 'dispatch')
      ) AS res_in_progress
    ${FACET_FROM}
  `;
  const { rows } = await pool.query(facetSql);
  return buildInboxFacetsPayload(rows[0] || {});
}

/**
 * Totales de bandeja alineados a `listInbox` (mismos JOIN + WHERE base sin `filter` ni cursor).
 * Opcional `src`, `stage`, `result`, `search` — mismos query params que `GET /api/inbox`.
 * Así el badge "Sin leer" coincide con la lista cuando hay filtro de etapa/origen/etc.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.src] compuesto validado (p. ej. `wa,ml`) o null
 * @param {string|null} [opts.stage] compuesto validado o null
 * @param {string|null} [opts.result] o null
 * @param {string|null} [opts.search] o null
 */
async function getInboxCounts(opts = {}) {
  const srcParts =
    opts.src != null && String(opts.src).trim() !== ""
      ? parseSrcList(String(opts.src).trim())
      : null;
  const search =
    opts.search != null && String(opts.search).trim() !== ""
      ? String(opts.search).trim()
      : null;
  const stageList =
    opts.stage != null && String(opts.stage).trim() !== ""
      ? parseStageList(String(opts.stage).trim())
      : null;
  const result =
    opts.result != null && RESULTS.has(String(opts.result).trim())
      ? String(opts.result).trim()
      : null;

  const hideAnsweredIdleMl = !srcParts || srcParts.length === 0;
  const { where, params } = buildFilters(
    null,
    srcParts,
    search,
    null,
    stageList,
    result,
    hideAnsweredIdleMl
  );

  const fromCommon = `
    FROM crm_chats cc
    LEFT JOIN customers c ON cc.customer_id = c.id
    ${JOIN_ORDER}
    ${JOIN_ORDER_LATEST}
    ${JOIN_QUOTE_ACTIVE}
    ${JOIN_ML_QUESTION_ANSWERED}
    ${JOIN_LAST_MESSAGE}
    WHERE 1=1
    ${where}
  `;

  const sql = `
    SELECT
      COUNT(DISTINCT cc.id) AS total,
      COUNT(DISTINCT cc.id) FILTER (WHERE (${PENDING_REPLY_EXPR})) AS unread,
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
    ${fromCommon}
  `;

  // BE-1.8: chats con handoff activo en este momento
  // Tabla bot_handoffs creada en BE-1.5 (npm run db:bot-handoffs).
  // Si aún no existe, retorna 0 sin romper el endpoint.
  const handoffSql = `
    SELECT COUNT(DISTINCT chat_id) AS handed_over
    FROM bot_handoffs
    WHERE ended_at IS NULL
  `;

  // BE-2.8: acciones del bot sin revisar en las últimas 48h (supervisor backlog)
  const unreviewedSql = `
    SELECT COUNT(*)::int AS bot_actions_unreviewed
    FROM bot_actions
    WHERE is_reviewed = FALSE
      AND created_at > NOW() - INTERVAL '48 hours'
  `;

  // BE-2.8: acciones marcadas incorrectas hoy
  const incorrectTodaySql = `
    SELECT COUNT(*)::int AS bot_actions_incorrect_today
    FROM bot_actions
    WHERE is_correct = FALSE
      AND created_at > CURRENT_DATE
  `;

  try {
    const [mainRes, facets, handoffResult, unreviewedResult, incorrectResult, exceptionsCount] =
      await Promise.all([
        pool.query(sql, [...params]),
        fetchInboxFacets(),
        pool.query(handoffSql).catch((err) => {
          // Tabla bot_handoffs aún no migrada — degradar a 0 sin error
          if (err.code === "42P01") return { rows: [{ handed_over: "0" }] };
          throw err;
        }),
        // Columna is_reviewed añadida en db:bot-actions-review — degradar si aún no existe
        pool.query(unreviewedSql).catch((err) => {
          if (err.code === "42703" || err.code === "42P01") return { rows: [{ bot_actions_unreviewed: 0 }] };
          throw err;
        }),
        pool.query(incorrectTodaySql).catch((err) => {
          if (err.code === "42703" || err.code === "42P01") return { rows: [{ bot_actions_incorrect_today: 0 }] };
          throw err;
        }),
        exceptionsService.countOpen().catch(() => 0),
      ]);
    const r = mainRes.rows[0] || {};
    const h = handoffResult.rows[0] || {};
    const u = unreviewedResult.rows[0] || {};
    const ic = incorrectResult.rows[0] || {};
    return {
      total: Number(r.total) || 0,
      unread: Number(r.unread) || 0,
      payment_pending: Number(r.payment_pending) || 0,
      quote: Number(r.quote) || 0,
      dispatch: Number(r.dispatch) || 0,
      wa: Number(r.wa) || 0,
      ml: Number(r.ml) || 0,
      // BE-1.8
      handed_over: Number(h.handed_over) || 0,
      exceptions: Number(exceptionsCount) || 0,
      // BE-2.8
      bot_actions_unreviewed: Number(u.bot_actions_unreviewed) || 0,
      bot_actions_incorrect_today: Number(ic.bot_actions_incorrect_today) || 0,
      facets,
    };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

/**
 * Pone unread_count en 0 en todos los hilos (control operativo de bandeja).
 * @returns {Promise<{ chats_reset: number }>}
 */
async function resetAllChatsUnread() {
  try {
    const r = await pool.query(
      `UPDATE crm_chats SET unread_count = 0, updated_at = NOW() WHERE unread_count > 0`
    );
    return { chats_reset: Number(r.rowCount) || 0 };
  } catch (err) {
    throw mapSchemaError(err);
  }
}

module.exports = {
  listInbox,
  getInboxCounts,
  resetAllChatsUnread,
  FILTERS,
  SRCS,
  CHAT_STAGE_VALUES,
  RESULTS,
};
