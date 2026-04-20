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

/** Expresión SQL alineada con buildReference(channel_id, id). */
function sqlReferenceExpr(alias = "p") {
  return `(CASE
    WHEN ${alias}.channel_id = 2 THEN 'COT-WA-' || ${alias}.id::text
    WHEN ${alias}.channel_id = 3 THEN 'COT-ML-' || ${alias}.id::text
    ELSE 'COT-' || ${alias}.id::text
  END)`;
}

/**
 * GET /api/inbox/quotations — listado global paginado.
 * @param {import('url').URL} url
 */
async function handleListQuotations(res, url) {
  const sp = url.searchParams;

  const rawLimit = sp.get("limit");
  const rawOffset = sp.get("offset");
  let limit = 50;
  let offset = 0;
  if (rawLimit != null && String(rawLimit).trim() !== "") {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) {
      writeJson(res, 400, { error: "bad_request", message: "limit debe ser entero entre 1 y 200" });
      return;
    }
    limit = n;
  }
  if (rawOffset != null && String(rawOffset).trim() !== "") {
    const n = Number(rawOffset);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      writeJson(res, 400, { error: "bad_request", message: "offset debe ser entero >= 0" });
      return;
    }
    offset = n;
  }

  const statusRaw = (sp.get("status") || "all").toLowerCase().trim();
  if (!["draft", "sent", "all"].includes(statusRaw)) {
    writeJson(res, 400, {
      error: "bad_request",
      message: "status debe ser draft, sent o all",
    });
    return;
  }

  let clienteId = null;
  const rawCliente = sp.get("cliente_id");
  if (rawCliente != null && String(rawCliente).trim() !== "") {
    const c = Number(rawCliente);
    if (!Number.isFinite(c) || !Number.isInteger(c) || c < 1) {
      writeJson(res, 400, { error: "bad_request", message: "cliente_id inválido" });
      return;
    }
    clienteId = c;
  }

  let channelId = null;
  const rawCh = sp.get("channel_id");
  if (rawCh != null && String(rawCh).trim() !== "") {
    const c = Number(rawCh);
    if (!Number.isFinite(c) || !Number.isInteger(c) || c < 1) {
      writeJson(res, 400, { error: "bad_request", message: "channel_id inválido" });
      return;
    }
    channelId = c;
  }

  const searchRaw = sp.get("search");
  const search =
    searchRaw != null && String(searchRaw).trim() !== ""
      ? String(searchRaw).trim()
      : null;
  if (search != null && search.length > 200) {
    writeJson(res, 400, { error: "bad_request", message: "search demasiado largo" });
    return;
  }

  let fechaDesde = null;
  let fechaHasta = null;
  const fd = sp.get("fecha_desde");
  const fh = sp.get("fecha_hasta");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (fd != null && String(fd).trim() !== "") {
    if (!dateRe.test(String(fd).trim())) {
      writeJson(res, 400, { error: "bad_request", message: "fecha_desde debe ser YYYY-MM-DD" });
      return;
    }
    fechaDesde = String(fd).trim();
  }
  if (fh != null && String(fh).trim() !== "") {
    if (!dateRe.test(String(fh).trim())) {
      writeJson(res, 400, { error: "bad_request", message: "fecha_hasta debe ser YYYY-MM-DD" });
      return;
    }
    fechaHasta = String(fh).trim();
  }

  const cond = [];
  const params = [];
  let n = 1;

  if (statusRaw === "all") {
    cond.push(`p.status NOT IN ('converted', 'expired')`);
  } else if (statusRaw === "draft") {
    cond.push(`p.status IN ('draft', 'borrador')`);
  } else {
    cond.push(`p.status = 'sent'`);
  }

  if (clienteId != null) {
    cond.push(`p.cliente_id = $${n++}`);
    params.push(clienteId);
  }
  if (channelId != null) {
    cond.push(`p.channel_id = $${n++}`);
    params.push(channelId);
  }
  if (fechaDesde != null) {
    cond.push(`p.fecha_creacion >= $${n++}::date`);
    params.push(fechaDesde);
  }
  if (fechaHasta != null) {
    cond.push(`p.fecha_creacion < ($${n++}::date + interval '1 day')`);
    params.push(fechaHasta);
  }
  if (search != null) {
    const like = `%${search}%`;
    cond.push(
      `(${sqlReferenceExpr("p")} ILIKE $${n} OR COALESCE(c.full_name, '') ILIKE $${n})`
    );
    params.push(like);
    n += 1;
  }

  const whereSql = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

  const refExpr = sqlReferenceExpr("p");
  const countSql = `
    SELECT COUNT(*)::bigint AS c
    FROM inventario_presupuesto p
    LEFT JOIN customers c ON c.id = p.cliente_id
    ${whereSql}
  `;

  const listSql = `
    SELECT
      p.id,
      ${refExpr} AS reference,
      p.status,
      p.pipeline_stage,
      p.total,
      p.fecha_vencimiento,
      p.fecha_creacion,
      p.channel_id,
      p.chat_id,
      p.cliente_id,
      c.full_name AS cliente_nombre,
      p.created_by,
      p.conversion_document_id,
      p.converted_at,
      (SELECT COUNT(*)::int FROM inventario_detallepresupuesto d WHERE d.presupuesto_id = p.id) AS items_count
    FROM inventario_presupuesto p
    LEFT JOIN customers c ON c.id = p.cliente_id
    ${whereSql}
    ORDER BY p.fecha_creacion DESC
    LIMIT $${n} OFFSET $${n + 1}
  `;

  const countParams = params.slice();
  const listParams = [...params, limit, offset];

  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query(countSql, countParams),
    pool.query(listSql, listParams),
  ]);

  const total = Number(countRows[0]?.c || 0);
  const items = rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    pipeline_stage: r.pipeline_stage || "lead",
    total: r.total != null ? Number(r.total) : null,
    fecha_vencimiento: r.fecha_vencimiento,
    fecha_creacion: r.fecha_creacion,
    channel_id: r.channel_id,
    chat_id: r.chat_id,
    cliente_id: r.cliente_id,
    cliente_nombre: r.cliente_nombre,
    created_by: r.created_by,
    conversion_document_id: r.conversion_document_id || null,
    converted_at: r.converted_at || null,
    items_count: r.items_count != null ? Number(r.items_count) : 0,
  }));

  writeJson(res, 200, {
    items,
    pagination: {
      total,
      limit,
      offset,
      has_more: offset + items.length < total,
    },
  });
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

    // ─── PATCH /api/inbox/quotations/:id/convert (Bloque 4) ─────────────────────
    // Marca la cotización como convertida, registra el documento formal (obligatorio).
    const convertMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/convert$/);
    if (convertMatch && req.method === "PATCH") {
      const pId = Number(convertMatch[1]);
      let body;
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const docId =
        body.document_id != null && String(body.document_id).trim() !== ""
          ? String(body.document_id).trim().slice(0, 200)
          : null;
      if (!docId) {
        writeJson(res, 400, {
          error: "bad_request",
          message: "document_id es obligatorio (N° de orden, referencia de pago, nota de entrega, etc.)",
        });
        return true;
      }
      const note =
        body.note != null && String(body.note).trim() !== ""
          ? String(body.note).trim().slice(0, 2000)
          : null;
      const uid = user.userId != null ? Number(user.userId) : null;
      const { rows: cur } = await pool.query(
        `SELECT id, status, channel_id FROM inventario_presupuesto WHERE id = $1`, [pId]
      );
      if (!cur.length) {
        writeJson(res, 404, { error: "not_found" }); return true;
      }
      const allowedFrom = ["sent", "approved", "draft"];
      if (!allowedFrom.includes(cur[0].status)) {
        writeJson(res, 409, {
          error: "conflict",
          message: `No se puede convertir una cotización en estado '${cur[0].status}'.`,
          current_status: cur[0].status,
        });
        return true;
      }
      await pool.query(
        `UPDATE inventario_presupuesto
         SET status                 = 'converted',
             pipeline_stage         = 'converted',
             conversion_document_id = $1,
             conversion_note        = $2,
             converted_at           = NOW(),
             converted_by           = $3,
             updated_at             = NOW()
         WHERE id = $4`,
        [docId, note, uid, pId]
      );
      const ref = buildReference(cur[0].channel_id, pId);
      writeJson(res, 200, {
        ok: true,
        id: pId,
        reference: ref,
        status: "converted",
        pipeline_stage: "converted",
        conversion_document_id: docId,
      });
      return true;
    }

    // ─── PATCH /api/inbox/quotations/:id/stage (Bloque 4 · Kanban) ──────────────
    const stageMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/stage$/);
    if (stageMatch && req.method === "PATCH") {
      const pId = Number(stageMatch[1]);
      let body;
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const VALID_STAGES = ["lead", "quoted", "negotiating", "accepted", "converted", "lost"];
      const stage =
        body.pipeline_stage != null ? String(body.pipeline_stage).trim().toLowerCase() : "";
      if (!VALID_STAGES.includes(stage)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `pipeline_stage inválido. Valores: ${VALID_STAGES.join(", ")}`,
        });
        return true;
      }
      const { rowCount } = await pool.query(
        `UPDATE inventario_presupuesto
         SET pipeline_stage = $1, updated_at = NOW()
         WHERE id = $2`,
        [stage, pId]
      );
      if (!rowCount) {
        writeJson(res, 404, { error: "not_found" }); return true;
      }
      writeJson(res, 200, { ok: true, id: pId, pipeline_stage: stage });
      return true;
    }

    // GET /api/inbox/quotations — listado global paginado (antes de /:chatId)
    if (req.method === "GET" && pathname === "/api/inbox/quotations") {
      await handleListQuotations(res, url);
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
