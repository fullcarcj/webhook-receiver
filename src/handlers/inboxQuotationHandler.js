"use strict";

/**
 * Cotizaciones inbox → inventario_presupuesto / inventario_detallepresupuesto.
 *
 * Status en BD (verificación 2026-04-16 contra DATABASE_URL local):
 *   SELECT DISTINCT status FROM inventario_presupuesto → sin filas (tabla vacía o status NULL).
 *   Valores usados por esta API para filas nuevas: 'draft' (borrador) y 'sent' (enviado por WA).
 */

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const { sendChatMessage } = require("../services/chatMessageService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_quotation_api",
});

const STATUS_DRAFT = "draft";
const STATUS_SENT = "sent";

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

function buildReference(channelId, id) {
  const ch = channelId != null ? Number(channelId) : NaN;
  if (ch === 2) return `COT-WA-${id}`;
  if (ch === 3) return `COT-ML-${id}`;
  return `COT-${id}`;
}

function isDraftLike(status) {
  const s = String(status || "").toLowerCase();
  return s === "draft" || s === "borrador";
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toFixed(2);
}

function formatSendMessage(row, reference, items) {
  const lines = [
    `*Cotización ${reference}*`,
    `Total: USD ${money(row.total)}`,
    row.fecha_vencimiento
      ? `Vence: ${String(row.fecha_vencimiento).slice(0, 10)}`
      : "",
    "",
    "*Detalle:*",
  ].filter(Boolean);
  for (const it of items) {
    const name = it.name != null ? String(it.name) : "(producto)";
    lines.push(`• ${name} × ${it.cantidad} — USD ${money(it.subtotal)}`);
  }
  if (row.observaciones && String(row.observaciones).trim()) {
    lines.push("", `Obs.: ${String(row.observaciones).trim()}`);
  }
  return lines.join("\n");
}

/**
 * @returns {Promise<boolean>}
 */
async function handleInboxQuotationRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  if (!pathname.startsWith("/api/inbox/quotations")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const isDev = process.env.NODE_ENV !== "production";

  try {
    const sendMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/send$/);
    if (sendMatch && req.method === "POST") {
      const presupuestoId = Number(sendMatch[1]);
      const { rows } = await pool.query(
        `SELECT ip.*,
           COALESCE(
             json_agg(
               json_build_object(
                 'name', p.name,
                 'cantidad', idp.cantidad,
                 'subtotal', idp.subtotal
               )
             ) FILTER (WHERE idp.id IS NOT NULL),
             '[]'::json
           ) AS items
         FROM inventario_presupuesto ip
         LEFT JOIN inventario_detallepresupuesto idp
           ON idp.presupuesto_id = ip.id
         LEFT JOIN products p
           ON p.id = idp.producto_id
         WHERE ip.id = $1
         GROUP BY ip.id`,
        [presupuestoId]
      );
      if (!rows.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      const ip = rows[0];
      if (!isDraftLike(ip.status)) {
        writeJson(res, 409, {
          error: "conflict",
          message: "Solo se puede enviar un presupuesto en estado borrador.",
          status: ip.status,
        });
        return true;
      }
      if (ip.chat_id == null) {
        writeJson(res, 400, {
          error: "bad_request",
          message: "El presupuesto no tiene chat_id; no se puede enviar por WhatsApp.",
        });
        return true;
      }
      let items = ip.items;
      if (typeof items === "string") items = JSON.parse(items);
      if (!Array.isArray(items)) items = [];
      if (!items.length) {
        writeJson(res, 400, { error: "bad_request", message: "Presupuesto sin líneas." });
        return true;
      }
      const reference = buildReference(ip.channel_id, ip.id);
      const msg = formatSendMessage(ip, reference, items);
      const sentBy = String(user.userId != null ? user.userId : ip.created_by || "quotation-send");
      await sendChatMessage(ip.chat_id, msg, sentBy);
      await pool.query(
        `UPDATE inventario_presupuesto SET
           status = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [presupuestoId, STATUS_SENT]
      );
      writeJson(res, 200, {
        ok: true,
        id: presupuestoId,
        reference,
        status: STATUS_SENT,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/inbox/quotations") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const clienteId = body.cliente_id != null ? Number(body.cliente_id) : NaN;
      if (!Number.isFinite(clienteId)) {
        writeJson(res, 400, { error: "bad_request", message: "cliente_id inválido" });
        return true;
      }
      const chatId =
        body.chat_id != null && body.chat_id !== "" ? Number(body.chat_id) : null;
      const channelId =
        body.channel_id != null && body.channel_id !== ""
          ? Number(body.channel_id)
          : null;
      const createdByBody =
        body.created_by != null && body.created_by !== ""
          ? Number(body.created_by)
          : null;
      const uid = user.userId != null ? Number(user.userId) : NaN;
      const createdBy =
        Number.isFinite(createdByBody) && createdByBody > 0
          ? createdByBody
          : Number.isFinite(uid) && uid > 0
            ? uid
            : null;
      const observaciones =
        body.observaciones != null ? String(body.observaciones) : "";
      const itemsIn = Array.isArray(body.items) ? body.items : [];
      if (!itemsIn.length) {
        writeJson(res, 400, { error: "bad_request", message: "items no puede estar vacío" });
        return true;
      }

      const lines = [];
      const productIds = [];
      for (const it of itemsIn) {
        const pid = it.producto_id != null ? Number(it.producto_id) : NaN;
        const cantidad = it.cantidad != null ? Number(it.cantidad) : NaN;
        const pu = it.precio_unitario != null ? Number(it.precio_unitario) : NaN;
        if (!Number.isFinite(pid) || pid <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "producto_id inválido en items" });
          return true;
        }
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "cantidad inválida en items" });
          return true;
        }
        if (!Number.isFinite(pu) || pu < 0) {
          writeJson(res, 400, { error: "bad_request", message: "precio_unitario inválido en items" });
          return true;
        }
        const subtotal = Math.round(cantidad * pu * 100) / 100;
        productIds.push(pid);
        lines.push({ producto_id: pid, cantidad, precio_unitario: pu, subtotal });
      }

      const uniq = [...new Set(productIds)];
      const chk = await pool.query(
        `SELECT id FROM products
         WHERE id = ANY($1::bigint[]) AND is_active = true`,
        [uniq]
      );
      if (chk.rows.length !== uniq.length) {
        writeJson(res, 400, {
          error: "bad_request",
          message: "Uno o más productos no existen o no están activos.",
        });
        return true;
      }

      let fechaVencimiento = null;
      if (body.fecha_vencimiento != null && String(body.fecha_vencimiento).trim() !== "") {
        const d = new Date(String(body.fecha_vencimiento));
        if (!Number.isFinite(d.getTime())) {
          writeJson(res, 400, { error: "bad_request", message: "fecha_vencimiento inválida" });
          return true;
        }
        fechaVencimiento = d.toISOString().slice(0, 10);
      }

      const total = lines.reduce((acc, L) => acc + L.subtotal, 0);

      const client = await pool.connect();
      let presupuestoId;
      try {
        await client.query("BEGIN");
        const ins = await client.query(
          `INSERT INTO inventario_presupuesto (
             fecha_creacion,
             fecha_vencimiento,
             total,
             observaciones,
             status,
             cliente_id,
             vendedor_id,
             venta_id,
             chat_id,
             channel_id,
             created_by,
             updated_at
           ) VALUES (
             NOW(),
             COALESCE($1::date, (CURRENT_TIMESTAMP + interval '48 hours')::date),
             $2,
             $3,
             $4,
             $5,
             $6,
             NULL,
             $7,
             $8,
             $9,
             NOW()
           )
           RETURNING id`,
          [
            fechaVencimiento,
            total,
            observaciones,
            STATUS_DRAFT,
            clienteId,
            createdBy,
            Number.isFinite(chatId) && chatId > 0 ? chatId : null,
            Number.isFinite(channelId) && channelId > 0 ? channelId : null,
            createdBy,
          ]
        );
        presupuestoId = ins.rows[0].id;
        for (const L of lines) {
          await client.query(
            `INSERT INTO inventario_detallepresupuesto (
               cantidad, precio_unitario, subtotal, producto_id, presupuesto_id
             ) VALUES ($1, $2, $3, $4, $5)`,
            [L.cantidad, L.precio_unitario, L.subtotal, L.producto_id, presupuestoId]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      const det = await pool.query(
        `SELECT id, cantidad, precio_unitario, subtotal, producto_id
         FROM inventario_detallepresupuesto
         WHERE presupuesto_id = $1
         ORDER BY id`,
        [presupuestoId]
      );
      const headRes = await pool.query(
        `SELECT id, fecha_creacion, fecha_vencimiento, total, status,
           cliente_id, chat_id, channel_id, created_by, observaciones
         FROM inventario_presupuesto WHERE id = $1`,
        [presupuestoId]
      );
      const header = headRes.rows[0];
      const reference = buildReference(header.channel_id, presupuestoId);
      writeJson(res, 201, {
        presupuesto: { ...header, reference },
        items: det.rows,
      });
      return true;
    }

    const listMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)$/);
    if (listMatch && req.method === "GET") {
      const chatId = Number(listMatch[1]);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "chatId inválido" });
        return true;
      }
      const { rows } = await pool.query(
        `SELECT id, total, status, fecha_vencimiento, channel_id
         FROM inventario_presupuesto
         WHERE chat_id = $1
           AND status NOT IN ('converted', 'expired')
         ORDER BY fecha_creacion DESC
         LIMIT 5`,
        [chatId]
      );
      writeJson(res, 200, { items: rows });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    if (err && err.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: err.message });
      return true;
    }
    if (err && err.code === "NOT_FOUND") {
      writeJson(res, 404, { error: "not_found" });
      return true;
    }
    if (err && err.code === "SERVICE_UNAVAILABLE") {
      writeJson(res, 503, { error: "wasender_not_configured" });
      return true;
    }
    if (err && err.code === "WASENDER_ERROR") {
      writeJson(res, err.httpStatus || 502, {
        error: "wasender_error",
        message: err.message,
      });
      return true;
    }
    logger.error({ err }, "inbox_quotation_error");
    writeJson(res, 500, {
      error: "error",
      message: isDev && err && err.message ? String(err.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleInboxQuotationRequest };
