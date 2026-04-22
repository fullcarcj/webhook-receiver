"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const { mergeCustomers } = require("../services/customerMergeService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_identity_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function normalizePath(pathname) {
  const raw = String(pathname || "").replace(/\/{2,}/g, "/");
  return raw.replace(/\/+$/, "") || "/";
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 512 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function enrichCandidates(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch (_e) {
      return null;
    }
  }
  const phoneMatches = Array.isArray(obj.phoneMatches)
    ? obj.phoneMatches.map((r) => ({ ...r, match_type: "phone" }))
    : [];
  const mlBuyerMatches = Array.isArray(obj.mlBuyerMatches)
    ? obj.mlBuyerMatches.map((r) => ({ ...r, match_type: "ml_buyer" }))
    : [];
  return {
    phoneMatches,
    mlBuyerMatches,
    keywordHint: Boolean(obj.keywordHint),
  };
}

/**
 * GET  /api/inbox/:chatId/identity-candidates
 * GET  /api/inbox/:chatId/linkable-orders
 * POST /api/inbox/:chatId/link-customer
 * POST /api/inbox/:chatId/link-ml-order
 * @returns {Promise<boolean>}
 */
async function handleInboxIdentityRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const m = pathname.match(/^\/api\/inbox\/(\d+)\/(identity-candidates|link-customer|link-ml-order|linkable-orders)$/);
  if (!m) return false;

  applyCrmApiCorsHeaders(req, res);

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const chatId = Number(m[1]);
  const sub = m[2];
  const isDev = process.env.NODE_ENV !== "production";

  try {
    if (req.method === "GET" && sub === "identity-candidates") {
      const { rows } = await pool.query(
        `SELECT identity_status, identity_candidates, customer_id, ml_buyer_id, source_type
         FROM crm_chats WHERE id = $1`,
        [chatId]
      );
      if (!rows.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      const row = rows[0];
      const candidates = enrichCandidates(row.identity_candidates);
      writeJson(res, 200, {
        identity_status: row.identity_status,
        customer_id: row.customer_id,
        ml_buyer_id: row.ml_buyer_id,
        source_type: row.source_type,
        candidates: candidates,
      });
      return true;
    }

    if (req.method === "POST" && sub === "link-customer") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const customerId = body.customer_id != null ? Number(body.customer_id) : NaN;
      const confirmedByRaw = body.confirmed_by != null ? Number(body.confirmed_by) : user.userId;
      const confirmedBy = Number.isFinite(confirmedByRaw) ? confirmedByRaw : user.userId;
      const linkType = body.link_type != null ? String(body.link_type) : "";
      if (!Number.isFinite(customerId) || customerId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "customer_id inválido" });
        return true;
      }
      if (!["phone", "ml_buyer", "manual"].includes(linkType)) {
        writeJson(res, 400, { error: "bad_request", message: "link_type inválido" });
        return true;
      }

      const cust = await pool.query(
        `SELECT id, full_name FROM customers WHERE id = $1 AND is_active = true`,
        [customerId]
      );
      if (!cust.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Cliente no encontrado o inactivo" });
        return true;
      }
      const fullName = String(cust.rows[0].full_name || "");

      const chatR = await pool.query(
        `SELECT phone, ml_buyer_id FROM crm_chats WHERE id = $1`,
        [chatId]
      );
      if (!chatR.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Chat no encontrado" });
        return true;
      }
      const chatPhone = chatR.rows[0].phone;
      const mlBuyerIdChat = chatR.rows[0].ml_buyer_id;
      const digits = chatPhone ? String(chatPhone).replace(/\D/g, "") : "";

      await pool.query(
        `UPDATE crm_chats SET
           customer_id = $1,
           identity_status = 'manual_linked',
           identity_candidates = NULL,
           updated_at = NOW()
         WHERE id = $2`,
        [customerId, chatId]
      );

      let source = "whatsapp";
      let externalId = `manual:${chatId}`;
      if (linkType === "ml_buyer") {
        source = "mercadolibre";
        externalId =
          mlBuyerIdChat != null ? String(mlBuyerIdChat) : String(chatId);
      } else if (linkType === "phone") {
        source = "whatsapp";
        externalId = digits || String(chatId);
      }

      const metadata = {
        confirmed_by: Number.isFinite(confirmedBy) ? confirmedBy : null,
        chat_id: chatId,
        link_type: linkType,
      };

      await pool.query(
        `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary, metadata)
         VALUES ($1, $2::crm_identity_source, $3, false, $4::jsonb)
         ON CONFLICT (source, external_id) DO NOTHING`,
        [customerId, source, externalId, JSON.stringify(metadata)]
      );

      const extMsg = `out-${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO crm_messages (
           chat_id, customer_id, direction, type, content, sent_by,
           external_message_id, is_read, ai_reply_status
         ) VALUES (
           $1, $2, 'outbound', 'text', $3::jsonb,
           $4, $5, true, NULL
         )`,
        [
          chatId,
          customerId,
          JSON.stringify({ text: `Cliente vinculado: ${fullName}` }),
          String(confirmedBy),
          extMsg,
        ]
      );

      const { rows: outRows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [chatId]);
      writeJson(res, 200, { chat: outRows[0] });
      return true;
    }

    if (req.method === "POST" && sub === "link-ml-order") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const mlOrderId = body.ml_order_id != null ? Number(body.ml_order_id) : NaN;
      const confirmedByRaw = body.confirmed_by != null ? Number(body.confirmed_by) : user.userId;
      const confirmedBy = Number.isFinite(confirmedByRaw) ? confirmedByRaw : user.userId;
      if (!Number.isFinite(mlOrderId) || mlOrderId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "ml_order_id inválido" });
        return true;
      }

      const ord = await pool.query(
        `SELECT so.id, so.external_order_id, so.payment_status::text AS payment_status,
                so.order_total_amount, so.conversation_id, so.customer_id AS order_customer_id,
                cc2.source_type AS linked_chat_source_type
         FROM sales_orders so
         LEFT JOIN crm_chats cc2 ON cc2.id = so.conversation_id
         WHERE so.id = $1`,
        [mlOrderId]
      );
      if (!ord.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Orden no encontrada" });
        return true;
      }
      const ordRow = ord.rows[0];
      const existingConvId = ordRow.conversation_id != null ? Number(ordRow.conversation_id) : null;

      // Conflict: la orden ya apunta a OTRO chat que NO sea un chat ML auto-asignado.
      // Los chats ml_message/ml_question se asignan automáticamente al importar; en ese caso
      // el agente puede reasignar libremente al chat WA del mismo cliente.
      const isAutoMlConv = ["ml_message", "ml_question"].includes(ordRow.linked_chat_source_type ?? "");
      if (existingConvId != null && existingConvId !== chatId && !isAutoMlConv) {
        writeJson(res, 409, {
          error: "conflict",
          message: `La orden ya está vinculada al chat #${existingConvId}`,
        });
        return true;
      }

      // Obtener customer_id del chat para detectar posible fusión post-vinculación
      const chatQ = await pool.query(`SELECT customer_id FROM crm_chats WHERE id = $1`, [chatId]);
      const chatCustomerId = chatQ.rows[0]?.customer_id != null
        ? Number(chatQ.rows[0].customer_id)
        : null;
      const orderCustomerId = ordRow.order_customer_id != null
        ? Number(ordRow.order_customer_id)
        : null;

      // ¿Hay dos clientes distintos? → preparar fusión después del link principal.
      const needsMerge =
        chatCustomerId != null &&
        orderCustomerId != null &&
        chatCustomerId !== orderCustomerId;

      let mergeResult = null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE crm_chats SET
             ml_order_id = $1,
             identity_status = 'manual_linked',
             source_type = 'wa_ml_linked',
             identity_candidates = NULL,
             updated_at = NOW()
           WHERE id = $2`,
          [mlOrderId, chatId]
        );

        // CLAVE: vincular la orden al chat para que CHAT_STAGE_EXPR herede el ciclo de vida.
        // Permite sobreescribir si el conversation_id previo era un chat ML auto-asignado.
        await client.query(
          `UPDATE sales_orders
           SET conversation_id = $1, updated_at = NOW()
           WHERE id = $2
             AND (
               conversation_id IS NULL
               OR conversation_id = $1
               OR (SELECT source_type FROM crm_chats WHERE id = conversation_id)
                  IN ('ml_message', 'ml_question')
             )`,
          [chatId, mlOrderId]
        );

        const extMsg = `out-${crypto.randomUUID()}`;
        const orderLabel = ordRow.external_order_id
          ? ` (${ordRow.external_order_id})`
          : ` #${mlOrderId}`;
        await client.query(
          `INSERT INTO crm_messages (
             chat_id, customer_id, direction, type, content, sent_by,
             external_message_id, is_read, ai_reply_status
           ) VALUES (
             $1,
             (SELECT customer_id FROM crm_chats WHERE id = $1),
             'outbound', 'text', $2::jsonb,
             $3, $4, true, NULL
           )`,
          [
            chatId,
            JSON.stringify({ text: `Orden ML${orderLabel} vinculada a esta conversación` }),
            String(confirmedBy),
            extMsg,
          ]
        );

        await client.query("COMMIT");

      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      // Fusión de clientes: política "mínima pérdida de información".
      // Se hace FUERA de la transacción principal para que un error en merge
      // no revierta el vínculo ya confirmado. Si falla, se loguea y se continúa.
      if (needsMerge) {
        try {
          const custQ = await pool.query(
            `SELECT id, full_name, phone, email, id_number, primary_ml_buyer_id,
                    address, city, notes
             FROM customers
             WHERE id = ANY($1::bigint[])`,
            [[chatCustomerId, orderCustomerId]]
          );

          const scoreCustomer = (row) => {
            if (!row) return 0;
            const waName = String(row.full_name ?? "").startsWith("WA-");
            let s = 0;
            if (!waName) s += 2;
            if (row.phone)               s += 2;
            if (row.email)               s += 1;
            if (row.id_number)           s += 2;
            if (row.primary_ml_buyer_id) s += 2;
            if (row.address)             s += 1;
            return s;
          };

          const chatCust  = custQ.rows.find((r) => Number(r.id) === chatCustomerId);
          const orderCust = custQ.rows.find((r) => Number(r.id) === orderCustomerId);

          if (chatCust && orderCust) {
            const chatScore  = scoreCustomer(chatCust);
            const orderScore = scoreCustomer(orderCust);
            const keepId = chatScore > orderScore ? chatCustomerId : orderCustomerId;
            const dropId = keepId === chatCustomerId ? orderCustomerId : chatCustomerId;

            mergeResult = await mergeCustomers(keepId, dropId, {
              triggeredBy: "link_ml_order",
            });
          }
        } catch (mergeErr) {
          logger.warn({ mergeErr, chatCustomerId, orderCustomerId }, "link_ml_order: merge skipped");
        }
      }

      const { rows: outRows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [chatId]);
      writeJson(res, 200, {
        chat: outRows[0],
        merged: mergeResult
          ? { keptId: mergeResult.keptId, droppedId: mergeResult.droppedId }
          : null,
      });
      return true;
    }

    if (req.method === "GET" && sub === "linkable-orders") {
      // Todas las órdenes ML activas del universo (no filtradas por cliente del chat).
      // Condiciones: ≤10 días + feedback_sale IS NULL o 'pending' (vendedor sin calificar).
      // El agente selecciona manualmente la orden correcta para vincularla al chat.
      /* external_order_id suele ser "{ml_user_id}-{order_id}" → hay que unir ml_orders por
         split_part(...,2)::bigint (igual que salesApiHandler / importSalesOrderFromMlOrder). */
      const { rows: orders } = await pool.query(
        `SELECT
           so.id,
           so.external_order_id,
           so.payment_status::text AS payment_status,
           so.fulfillment_type,
           so.order_total_amount,
           so.status::text AS status,
           so.created_at,
           so.conversation_id,
           so.channel_id,
           cc2.source_type AS linked_chat_source_type,
           COALESCE(
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,title}'), ''),
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{items,0,title}'), ''),
             moi_first.title
           ) AS first_item_title,
           COALESCE(
             CASE
               WHEN (mo.raw_json::jsonb) #>> '{order_items,0,quantity}' ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN ((mo.raw_json::jsonb) #>> '{order_items,0,quantity}')::numeric
               ELSE NULL
             END,
             CASE
               WHEN (mo.raw_json::jsonb) #>> '{items,0,quantity}' ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN ((mo.raw_json::jsonb) #>> '{items,0,quantity}')::numeric
               ELSE NULL
             END,
             moi_first.quantity::numeric
           ) AS first_item_quantity,
           COALESCE(
             NULLIF(TRIM(ml_thumb.thumbnail), ''),
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,thumbnail}'), ''),
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,secure_thumbnail}'), ''),
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,pictures,0,secure_url}'), ''),
             NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,pictures,0,url}'), '')
           ) AS first_item_thumbnail,
           cust.full_name  AS buyer_name,
           cust.phone      AS buyer_phone
         FROM sales_orders so
         LEFT JOIN crm_chats cc2  ON cc2.id = so.conversation_id
         LEFT JOIN ml_orders mo
           ON so.source = 'mercadolibre'
          AND mo.order_id = (
               CASE
                 WHEN so.external_order_id ~ '^[0-9]+-[0-9]+$'
                   THEN split_part(so.external_order_id, '-', 2)::bigint
                 WHEN so.external_order_id ~ '^[0-9]+$'
                   THEN so.external_order_id::bigint
                 ELSE NULL
               END
             )
          AND (
               so.external_order_id IS NULL
               OR so.external_order_id !~ '^[0-9]+-[0-9]+$'
               OR mo.ml_user_id = split_part(so.external_order_id, '-', 1)::bigint
             )
         LEFT JOIN LATERAL (
           SELECT moi.quantity, moi.ml_item_id, moi.title
           FROM ml_order_items moi
           WHERE moi.order_id = (
             CASE
               WHEN so.external_order_id ~ '^[0-9]+-[0-9]+$'
                 THEN split_part(so.external_order_id, '-', 2)::bigint
               WHEN so.external_order_id ~ '^[0-9]+$'
                 THEN so.external_order_id::bigint
               ELSE NULL
             END
           )
           ORDER BY moi.id ASC
           LIMIT 1
         ) moi_first ON TRUE
         LEFT JOIN ml_listings ml_thumb ON ml_thumb.item_id = COALESCE(
           NULLIF(TRIM((mo.raw_json::jsonb) #>> '{order_items,0,item,id}'), ''),
           NULLIF(TRIM(moi_first.ml_item_id::text), '')
         )
         LEFT JOIN customers cust ON cust.id = so.customer_id
         WHERE so.source = 'mercadolibre'
           AND so.status::TEXT NOT IN ('cancelled', 'completed')
           AND COALESCE(mo.date_created::TIMESTAMPTZ, so.created_at) >= NOW() - INTERVAL '10 days'
           AND (
             mo.order_id IS NULL
             OR mo.feedback_sale IS NULL
             OR mo.feedback_sale::TEXT = 'pending'
           )
         ORDER BY COALESCE(mo.date_created::TIMESTAMPTZ, so.created_at) DESC
         LIMIT 40`,
        []
      );
      writeJson(res, 200, { orders });
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    logger.error({ err }, "inbox_identity_error");
    writeJson(res, 500, {
      error: "error",
      message: isDev && err && err.message ? String(err.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleInboxIdentityRequest };
