"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { pool } = require("../../db");
const { mercadoLibrePostJsonForUser } = require("../../oauth-token");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const {
  listInbox,
  getInboxCounts,
  FILTERS,
  SRCS,
  CHAT_STAGE_VALUES,
  RESULTS,
} = require("../services/inboxService");
const { getTodayRate } = require("../services/currencyService");
const exceptionsService = require("../services/exceptionsService");
const { ensureWaChatFromCustomerPhone } = require("../services/inboxWaContactService");

function validateSrcCompound(src) {
  if (src == null || src === "") return { ok: true, value: null };
  const parts = String(src)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!SRCS.has(part)) {
      return { ok: false, message: `src inválido: ${part}` };
    }
  }
  return { ok: true, value: parts.length ? parts.join(",") : null };
}

function validateStageCompound(stage) {
  if (stage == null || stage === "") return { ok: true, value: null };
  const parts = String(stage)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!CHAT_STAGE_VALUES.has(part)) {
      return { ok: false, message: `stage inválido: ${part}` };
    }
  }
  return { ok: true, value: parts.length ? parts.join(",") : null };
}

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBodyInbox(req) {
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

/**
 * Inbox unificado CRM + órdenes: GET /api/inbox, GET /api/inbox/counts
 * (`counts` incluye `facets`: totales por source_type, sales_channel_id, chat_stage y result,
 *  calculados con los mismos JOIN que la lista para badges coherentes con `?src=&stage=&result=`.)
 * @returns {Promise<boolean>}
 */
async function handleInboxApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/inbox")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  const crmUser = await requireAdminOrPermission(req, res, "crm");
  if (!crmUser) {
    return true;
  }

  try {
    if (req.method === "GET" && pathname === "/api/inbox/counts") {
      const data = await getInboxCounts();
      writeJson(res, 200, data);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/inbox") {
      const filter = url.searchParams.get("filter");
      const src = url.searchParams.get("src");
      const search = url.searchParams.get("search");
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");
      const stage = url.searchParams.get("stage");
      const result = url.searchParams.get("result");

      if (filter != null && filter !== "" && !FILTERS.has(filter)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `filter inválido. Valores: ${[...FILTERS].join(", ")} o vacío`,
        });
        return true;
      }
      const vsrc = validateSrcCompound(src);
      if (!vsrc.ok) {
        writeJson(res, 400, {
          error: "bad_request",
          message: vsrc.message,
        });
        return true;
      }
      const vstage = validateStageCompound(stage);
      if (!vstage.ok) {
        writeJson(res, 400, {
          error: "bad_request",
          message: vstage.message,
        });
        return true;
      }
      if (result != null && result !== "" && !RESULTS.has(result)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `result inválido. Valores: ${[...RESULTS].join(", ")} o vacío`,
        });
        return true;
      }

      const data = await listInbox({
        filter: filter || null,
        src: vsrc.value,
        search: search || null,
        cursor: cursor || null,
        limit,
        stage: vstage.value,
        result: result || null,
      });
      writeJson(res, 200, data);
      return true;
    }

    const normInboxPath = pathname.replace(/\/+$/, "") || pathname;

    /**
     * POST /api/inbox/wa-chat/from-customer-phone
     * Localiza hilo WA por teléfono (crm_chats.phone); si no hay actividad reciente, envía saludo outbound.
     * Body: { phone, customer_id?, customer_name? }
     */
    if (req.method === "POST" && normInboxPath === "/api/inbox/wa-chat/from-customer-phone") {
      let body;
      try {
        body = await parseJsonBodyInbox(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const phoneRaw = body.phone != null ? String(body.phone) : body.customer_phone != null ? String(body.customer_phone) : "";
      const customerIdRaw = body.customer_id;
      const customerName = body.customer_name != null ? String(body.customer_name) : "";
      if (!String(phoneRaw).trim()) {
        writeJson(res, 400, { error: "bad_request", message: "phone es obligatorio" });
        return true;
      }
      const customerId =
        customerIdRaw != null && String(customerIdRaw).trim() !== "" ? Number(customerIdRaw) : null;
      const sentBy = String(crmUser.userId ?? crmUser.username ?? crmUser.email ?? "crm");
      try {
        const out = await ensureWaChatFromCustomerPhone(pool, {
          phoneRaw,
          customerId: Number.isFinite(customerId) && customerId > 0 ? customerId : null,
          customerName,
          sentBy,
        });
        writeJson(res, 200, { ok: true, ...out });
      } catch (e) {
        const code = e && e.code ? String(e.code) : "";
        if (code === "BAD_REQUEST") {
          writeJson(res, 400, { error: "bad_request", message: e.message || "Solicitud inválida" });
          return true;
        }
        if (code === "NOT_FOUND") {
          writeJson(res, 404, { error: "not_found", message: e.message || "No encontrado" });
          return true;
        }
        if (code === "SERVICE_UNAVAILABLE") {
          writeJson(res, 503, { error: "wasender_not_configured", message: e.message || "Wasender no configurado" });
          return true;
        }
        if (code === "WASENDER_ERROR") {
          writeJson(res, e.httpStatus || 502, {
            error: "wasender_error",
            message: e.message || "Error al enviar por Wasender",
          });
          return true;
        }
        logger.error({ err: e }, "wa-chat/from-customer-phone");
        writeJson(res, 500, {
          error: "error",
          message: process.env.NODE_ENV !== "production" && e.message ? String(e.message) : "Internal server error",
        });
      }
      return true;
    }

    /**
     * GET /api/inbox/bank-statements/pending-credits
     * Créditos del extracto (Banesco) sin match automático: UNMATCHED y SUGGESTED.
     */
    if (req.method === "GET" && normInboxPath === "/api/inbox/bank-statements/pending-credits") {
      const rawLim = url.searchParams.get("limit");
      let lim = rawLim != null && String(rawLim).trim() !== "" ? parseInt(String(rawLim).trim(), 10) : 200;
      if (!Number.isFinite(lim) || lim < 1) lim = 200;
      if (lim > 500) lim = 500;

      const { rows } = await pool.query(
        `SELECT bs.id,
                bs.bank_account_id,
                ba.bank_name,
                ba.account_number,
                ba.currency::text AS account_currency,
                bs.tx_date,
                bs.reference_number,
                bs.description,
                bs.tx_type::text AS tx_type,
                bs.amount::text AS amount,
                bs.balance_after::text AS balance_after,
                bs.payment_type,
                bs.reconciliation_status::text AS reconciliation_status,
                rl.order_id AS sales_order_id,
                bs.row_hash,
                bs.created_at
         FROM bank_statements bs
         INNER JOIN bank_accounts ba ON ba.id = bs.bank_account_id
         LEFT JOIN LATERAL (
           SELECT r.order_id
           FROM reconciliation_log r
           WHERE r.bank_statement_id = bs.id
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 1
         ) rl ON TRUE
         WHERE bs.tx_type = 'CREDIT'::statement_tx_type
           AND bs.reconciliation_status IN (
             'UNMATCHED'::reconciliation_status,
             'SUGGESTED'::reconciliation_status
           )
         ORDER BY bs.tx_date DESC NULLS LAST, bs.id DESC
         LIMIT $1`,
        [lim]
      );

      const isoDate = (d) => {
        if (!d) return null;
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        const s = String(d);
        return s.length >= 10 ? s.slice(0, 10) : s;
      };
      const isoTs = (d) => {
        if (!d) return null;
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
        return String(d);
      };

      const items = rows.map((r) => ({
        id: String(r.id),
        bank_account_id: r.bank_account_id != null ? Number(r.bank_account_id) : null,
        bank_name: r.bank_name ?? null,
        account_number: r.account_number ?? null,
        account_currency: r.account_currency ?? null,
        tx_date: isoDate(r.tx_date),
        reference_number: r.reference_number ?? null,
        description: r.description != null ? String(r.description) : "",
        tx_type: r.tx_type ?? "CREDIT",
        amount: r.amount != null ? String(r.amount) : null,
        balance_after: r.balance_after != null ? String(r.balance_after) : null,
        payment_type: r.payment_type ?? null,
        reconciliation_status: r.reconciliation_status ?? null,
        sales_order_id: r.sales_order_id != null ? Number(r.sales_order_id) : null,
        row_hash: r.row_hash ?? null,
        created_at: isoTs(r.created_at),
      }));

      writeJson(res, 200, {
        ok: true,
        items,
        meta: { limit: lim, count: items.length },
      });
      return true;
    }

    /**
     * POST /api/inbox/payment-attempts/:id/link-bank-statement
     * Vincula un comprobante WA a un movimiento de extracto (crédito pendiente).
     * Body: { bank_statement_id: number, chat_id?: number } (chat_id valida pertenencia).
     */
    const paBankLink = normInboxPath.match(/^\/api\/inbox\/payment-attempts\/(\d+)\/link-bank-statement$/);
    if (req.method === "POST" && paBankLink) {
      const paymentAttemptId = Number(paBankLink[1]);
      let body;
      try {
        body = await parseJsonBodyInbox(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const bankStatementId =
        body.bank_statement_id != null ? Number(body.bank_statement_id) : NaN;
      const secChatId = body.chat_id != null ? Number(body.chat_id) : NaN;

      if (!Number.isFinite(paymentAttemptId) || paymentAttemptId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "payment_attempt_id inválido" });
        return true;
      }
      if (!Number.isFinite(bankStatementId) || bankStatementId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "bank_statement_id es obligatorio" });
        return true;
      }

      const { rows: paRows } = await pool.query(
        `SELECT id, chat_id, reconciliation_status, linked_bank_statement_id
         FROM payment_attempts WHERE id = $1`,
        [paymentAttemptId]
      );
      if (!paRows.length) {
        writeJson(res, 404, { error: "not_found", message: "Comprobante no encontrado" });
        return true;
      }
      const pa = paRows[0];
      if (String(pa.reconciliation_status) === "matched") {
        writeJson(res, 409, {
          error: "conflict",
          message: "El comprobante ya está marcado como conciliado",
        });
        return true;
      }
      if (pa.linked_bank_statement_id != null) {
        writeJson(res, 409, {
          error: "conflict",
          message: "Este comprobante ya tiene un movimiento del extracto vinculado",
        });
        return true;
      }
      if (Number.isFinite(secChatId) && secChatId > 0 && pa.chat_id != null && Number(pa.chat_id) !== secChatId) {
        writeJson(res, 403, {
          error: "forbidden",
          message: "El comprobante no pertenece a este chat",
        });
        return true;
      }

      const { rows: bsRows } = await pool.query(
        `SELECT id, tx_type::text AS tx_type, reconciliation_status::text AS reconciliation_status
         FROM bank_statements WHERE id = $1`,
        [bankStatementId]
      );
      if (!bsRows.length) {
        writeJson(res, 404, { error: "not_found", message: "Movimiento de extracto no encontrado" });
        return true;
      }
      const bs = bsRows[0];
      if (String(bs.tx_type || "").toUpperCase() !== "CREDIT") {
        writeJson(res, 400, { error: "bad_request", message: "Solo se pueden vincular abonos (crédito)" });
        return true;
      }
      const st = String(bs.reconciliation_status || "").toUpperCase();
      if (!["UNMATCHED", "SUGGESTED"].includes(st)) {
        writeJson(res, 409, {
          error: "conflict",
          message: "El movimiento ya no está disponible para vinculación manual",
        });
        return true;
      }

      try {
        await pool.query(
          `UPDATE payment_attempts
           SET linked_bank_statement_id = $1
           WHERE id = $2`,
          [bankStatementId, paymentAttemptId]
        );
      } catch (err) {
        const msg = err && err.message ? String(err.message) : "";
        if (msg.includes("linked_bank_statement_id")) {
          writeJson(res, 503, {
            error: "schema_missing",
            message:
              "Falta la columna linked_bank_statement_id en payment_attempts. Ejecutá sql/20260422_payment_attempts_linked_bank_statement.sql",
          });
          return true;
        }
        throw err;
      }

      let mismatchPayload = null;
      try {
        const { rows: snap } = await pool.query(
          `SELECT pa.extracted_amount_bs::text AS extracted_amount_bs,
                  pa.chat_id,
                  bs.amount::text AS stmt_amount
             FROM payment_attempts pa
             CROSS JOIN bank_statements bs
            WHERE pa.id = $1 AND bs.id = $2`,
          [paymentAttemptId, bankStatementId]
        );
        const row0 = snap[0] || {};
        const att = row0.extracted_amount_bs != null ? Number(String(row0.extracted_amount_bs).replace(",", ".")) : NaN;
        const stmtAmt = row0.stmt_amount != null ? Number(String(row0.stmt_amount).replace(",", ".")) : NaN;
        const cidChat = row0.chat_id != null ? Number(row0.chat_id) : null;

        let quoteUsd = NaN;
        let quoteId = null;
        if (Number.isFinite(cidChat) && cidChat > 0) {
          const { rows: qR } = await pool.query(
            `SELECT id, total::numeric AS total, lower(status::text) AS st
               FROM inventario_presupuesto
              WHERE chat_id = $1
                AND status NOT IN ('converted', 'expired')
              ORDER BY fecha_creacion DESC
              LIMIT 20`,
            [cidChat]
          );
          const pick = qR.find((q) => ["sent", "approved", "rejected"].includes(String(q.st || "")));
          if (pick) {
            quoteId = Number(pick.id);
            quoteUsd = Number(pick.total);
          }
        }

        const rateRow = await getTodayRate(1).catch(() => null);
        const activeRate =
          rateRow && rateRow.active_rate != null ? Number(rateRow.active_rate) : NaN;
        const quoteBs =
          Number.isFinite(quoteUsd) && Number.isFinite(activeRate) && activeRate > 0
            ? quoteUsd * activeRate
            : NaN;

        const tolBank = 0.05;
        const tolQuoteVs = (bs) => Math.max(1, Math.abs(bs || 0) * 0.005);

        const warnings = [];
        if (Number.isFinite(att) && Number.isFinite(stmtAmt) && Math.abs(att - stmtAmt) > tolBank) {
          warnings.push({
            kind: "attempt_vs_statement",
            attempt_bs: att,
            statement_bs: stmtAmt,
            diff_bs: Math.abs(att - stmtAmt),
          });
        }
        if (Number.isFinite(att) && Number.isFinite(quoteBs) && Math.abs(att - quoteBs) > tolQuoteVs(quoteBs)) {
          warnings.push({
            kind: "attempt_vs_quotation",
            attempt_bs: att,
            quotation_bs: quoteBs,
            quotation_id: quoteId,
            diff_bs: Math.abs(att - quoteBs),
          });
        }
        if (Number.isFinite(stmtAmt) && Number.isFinite(quoteBs) && Math.abs(stmtAmt - quoteBs) > tolQuoteVs(quoteBs)) {
          warnings.push({
            kind: "statement_vs_quotation",
            statement_bs: stmtAmt,
            quotation_bs: quoteBs,
            quotation_id: quoteId,
            diff_bs: Math.abs(stmtAmt - quoteBs),
          });
        }

        if (warnings.length && Number.isFinite(cidChat) && cidChat > 0) {
          mismatchPayload = {
            warnings,
            payment_attempt_id: paymentAttemptId,
            bank_statement_id: bankStatementId,
          };
          const sev = warnings.some((w) => w.kind !== "attempt_vs_statement") ? "high" : "medium";
          await exceptionsService.raise({
            entityType: "payment",
            entityId: paymentAttemptId,
            reason: "bank_statement_link_amount_mismatch",
            severity: sev,
            context: mismatchPayload,
            chatId: cidChat,
          });
        }
      } catch (svcErr) {
        logger.warn({ err: svcErr && svcErr.message }, "inbox link-bank-statement: mismatch/supervisor notify skipped");
      }

      writeJson(res, 200, {
        ok: true,
        payment_attempt_id: paymentAttemptId,
        bank_statement_id: bankStatementId,
        mismatch: mismatchPayload,
      });
      return true;
    }

    const mlMsgReply = (url.pathname || "").match(/^\/api\/inbox\/(\d+)\/ml-message\/reply\/?$/);
    if (req.method === "POST" && mlMsgReply) {
      const chatId = Number(mlMsgReply[1]);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        writeJson(res, 400, { code: "BAD_REQUEST", message: "chatId inválido" });
        return true;
      }

      let body;
      try {
        body = await parseJsonBodyInbox(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }

      const rawText = body && body.text != null ? String(body.text) : "";
      const text = rawText.trim();
      if (!text) {
        writeJson(res, 400, {
          code: "MISSING_TEXT",
          message: "El texto de respuesta es requerido",
        });
        return true;
      }
      if (text.length > 350) {
        writeJson(res, 400, {
          code: "TEXT_TOO_LONG",
          message: "El texto no puede superar 350 caracteres (límite ML)",
        });
        return true;
      }

      const answeredBy =
        body && body.answered_by != null && String(body.answered_by).trim() !== ""
          ? String(body.answered_by).trim()
          : null;

      const { rows: chatRows } = await pool.query(
        `SELECT
           cc.id,
           cc.source_type,
           cc.ml_order_id,
           cc.ml_buyer_id,
           COALESCE(so.ml_user_id, mo.ml_user_id) AS ml_user_id
         FROM crm_chats cc
         LEFT JOIN sales_orders so ON so.id = cc.ml_order_id
         LEFT JOIN LATERAL (
           SELECT ml_user_id FROM ml_orders
           WHERE order_id = cc.ml_order_id
           ORDER BY updated_at DESC NULLS LAST, id DESC
           LIMIT 1
         ) mo ON true
         WHERE cc.id = $1`,
        [chatId]
      );

      if (!chatRows.length) {
        writeJson(res, 404, { code: "CHAT_NOT_FOUND" });
        return true;
      }

      const cr = chatRows[0];
      if (String(cr.source_type) !== "ml_message") {
        writeJson(res, 422, {
          code: "WRONG_CHAT_TYPE",
          message: "Este chat no es de mensajería ML",
        });
        return true;
      }
      if (cr.ml_order_id == null) {
        writeJson(res, 422, {
          code: "NO_ORDER_LINKED",
          message: "Chat sin orden ML vinculada",
        });
        return true;
      }
      const mlUserResolved = cr.ml_user_id != null ? Number(cr.ml_user_id) : NaN;
      if (!Number.isFinite(mlUserResolved) || mlUserResolved <= 0) {
        writeJson(res, 422, {
          code: "NO_ML_USER",
          message: "No se encontró cuenta ML vendedora",
        });
        return true;
      }
      const mlOrderId = Number(cr.ml_order_id);
      const mlBuyerId =
        cr.ml_buyer_id != null && String(cr.ml_buyer_id).trim() !== ""
          ? Number(cr.ml_buyer_id)
          : NaN;
      if (!Number.isFinite(mlBuyerId) || mlBuyerId <= 0) {
        writeJson(res, 422, {
          code: "NO_BUYER",
          message: "Chat sin comprador ML (ml_buyer_id)",
        });
        return true;
      }

      const appId = String(
        process.env.OAUTH_CLIENT_ID || process.env.ML_APPLICATION_ID || process.env.ML_CLIENT_ID || ""
      ).trim();
      if (!appId) {
        writeJson(res, 503, {
          code: "ML_APP_ID_MISSING",
          message: "Falta OAUTH_CLIENT_ID o ML_APPLICATION_ID",
        });
        return true;
      }

      const q = new URLSearchParams({
        application_id: appId,
        tag: "post_sale",
      });
      const path = `/messages/packs/${mlOrderId}/sellers/${mlUserResolved}?${q.toString()}`;

      const mlRes = await mercadoLibrePostJsonForUser(mlUserResolved, path, {
        from: { user_id: mlUserResolved },
        to: { user_id: mlBuyerId },
        option_id: "OTHER",
        text,
      });

      const okHttp = mlRes.ok && (mlRes.status === 200 || mlRes.status === 201);
      if (!okHttp) {
        console.error("[inbox/ml-reply]", mlRes);
        writeJson(res, 502, {
          code: "ML_SEND_FAILED",
          message: "Error al enviar mensaje por ML",
          ml_status: mlRes.status,
        });
        return true;
      }

      const extId = `ml_reply_${chatId}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
      const sentBy = answeredBy || "agent";

      await pool.query(
        `INSERT INTO crm_messages (
           chat_id, external_message_id, direction, type, content,
           sent_by, is_read, created_at
         ) VALUES (
           $1, $2, 'outbound', 'text', $3::jsonb,
           $4, true, NOW()
         )
         ON CONFLICT (external_message_id) DO NOTHING`,
        [chatId, extId, JSON.stringify({ text }), sentBy]
      );

      await pool.query(
        `UPDATE crm_chats SET
           last_message_text = $1,
           last_message_at = NOW(),
           updated_at = NOW()
         WHERE id = $2`,
        [text, chatId]
      );

      writeJson(res, 200, {
        ok: true,
        chat_id: chatId,
        ml_order_id: mlOrderId,
        text,
      });
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    if (err && err.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: err.message });
      return true;
    }
    if (err && err.code === "CRM_SCHEMA_MISSING") {
      writeJson(res, 503, {
        error: "crm_schema_missing",
        message: err.message || String(err),
      });
      return true;
    }
    logger.error({ err: err.message }, "inbox_api");
    writeJson(res, 500, { error: "internal_error" });
    return true;
  }
}

module.exports = { handleInboxApiRequest };
