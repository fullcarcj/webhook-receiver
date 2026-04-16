"use strict";

const { pool } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 1024 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function parseLimitOffset(url, defLimit = 50) {
  const lim = Math.min(Math.max(parseInt(String(url.searchParams.get("limit") || defLimit), 10) || defLimit, 1), 200);
  const off = Math.max(parseInt(String(url.searchParams.get("offset") || "0"), 10) || 0, 0);
  return { limit: lim, offset: off };
}

function usernameFrom(user) {
  if (!user) return null;
  return user.username != null ? String(user.username) : null;
}

/**
 * Normaliza referencia de venta para POST /api/dispatch/request.
 * Compatible con v_sales_unified: source_table "pos" → tabla "sales";
 * IDs compuestos "pos-123" / "so-42"; opcional source_id + source_table.
 */
function normalizeDispatchSaleRef(body) {
  const idRaw =
    body.source_id != null && body.source_id !== "" ? body.source_id : body.sale_id;

  let saleTable = "";
  if (body.source_table != null && String(body.source_table).trim() !== "") {
    saleTable = String(body.source_table).trim().toLowerCase();
  } else if (body.sale_table != null && String(body.sale_table).trim() !== "") {
    saleTable = String(body.sale_table).trim().toLowerCase();
  }

  let saleId;
  if (typeof idRaw === "string") {
    const t = idRaw.trim();
    const pos = /^pos-(\d+)$/i.exec(t);
    const so = /^so-(\d+)$/i.exec(t);
    if (pos) {
      saleId = Number(pos[1]);
      if (!saleTable) saleTable = "sales";
    } else if (so) {
      saleId = Number(so[1]);
      if (!saleTable) saleTable = "sales_orders";
    } else {
      saleId = Number(t);
    }
  } else if (idRaw != null && idRaw !== "") {
    saleId = Number(idRaw);
  } else {
    saleId = NaN;
  }

  if (saleTable === "pos") saleTable = "sales";
  if (saleTable === "sales_order") saleTable = "sales_orders";

  return { saleId, saleTable };
}

/**
 * Descuento físico: sin reserva previa se usa adjust_stock (delta negativo).
 * commit_reservation solo aplica si hubo reserve_stock antes (mismo bin/sku).
 */
async function applyDispatchStockMovements(client, { binMovements, dispatchId, userId }) {
  const uid = userId != null && Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : null;
  const refId = String(dispatchId);
  for (const m of binMovements) {
    const binId = Number(m.bin_id != null ? m.bin_id : m.binId);
    const sku = String(m.sku != null ? m.sku : m.product_sku || "").trim();
    const qty = Number(m.qty != null ? m.qty : m.quantity);
    if (!Number.isFinite(binId) || binId <= 0 || !sku || !Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error("bin_movements: bin_id, sku y qty > 0 requeridos"), {
        code: "INVALID_MOVEMENT",
        status: 400,
      });
    }
    const { rows } = await client.query(
      `SELECT * FROM adjust_stock(
         $1::bigint, $2::text, $3::numeric, $4::text, $5::text, $6::text, $7::int, $8::text
       )`,
      [binId, sku, -qty, "SALE_DISPATCH", "dispatch", refId, uid, null]
    );
    if (!rows || !rows.length) {
      throw Object.assign(new Error(`adjust_stock sin fila para SKU ${sku} bin ${binId}`), { status: 500 });
    }
  }
}

async function logMlDispatchTracking(dispatchId, trackingNumber, metadataExtra) {
  try {
    await pool.query(
      `INSERT INTO ml_sync_log (entity_type, entity_id, action, status, ml_user_id, error, metadata)
       VALUES ('dispatch', $1, 'tracking_recorded', 'ok', NULL, NULL, $2::jsonb)`,
      [
        String(dispatchId),
        JSON.stringify({
          tracking_number: trackingNumber,
          ...metadataExtra,
        }),
      ]
    );
  } catch (e) {
    console.warn("[dispatch] ml_sync_log:", e && e.message ? e.message : e);
  }
}

const BASE_SELECT = `
  SELECT
    dr.id            AS dispatch_id,
    dr.sale_id,
    dr.sale_table,
    dr.channel,
    dr.status,
    dr.requested_by,
    dr.requested_at,
    dr.dispatched_by,
    dr.dispatched_at,
    dr.notes,
    dr.tracking_number,
    dr.warehouse_id,
    dr.created_at,
    dr.updated_at,
    COALESCE(so.external_order_id, s.id::text) AS order_reference,
    COALESCE(so.customer_id, s.customer_id)   AS customer_id,
    COALESCE(so.order_total_amount, s.total_usd) AS total_usd,
    COALESCE(so.created_at, s.created_at)       AS sale_date
  FROM dispatch_records dr
  LEFT JOIN sales_orders so
    ON so.id = dr.sale_id AND dr.sale_table = 'sales_orders'
  LEFT JOIN sales s
    ON s.id = dr.sale_id AND dr.sale_table = 'sales'
`;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 */
async function handleDispatchApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/dispatch")) return false;

  try {
    if (req.method === "GET" && pathname === "/api/dispatch/pending") {
      const user = await requireAdminOrPermission(req, res, "wms");
      if (!user) return true;
      const { limit, offset } = parseLimitOffset(url, 50);
      const channel = url.searchParams.get("channel");
      const params = [];
      let p = 1;
      let where = `WHERE dr.status IN ('pending', 'ready_to_ship')`;
      if (channel && String(channel).trim()) {
        where += ` AND dr.channel = $${p++}`;
        params.push(String(channel).trim());
      }
      const countSql = `SELECT COUNT(*)::bigint AS c FROM dispatch_records dr ${where}`;
      const listSql = `${BASE_SELECT} ${where}
        ORDER BY dr.requested_at ASC NULLS LAST, dr.created_at ASC
        LIMIT $${p++} OFFSET $${p++}`;
      params.push(limit, offset);
      const [{ rows: cr }, { rows }] = await Promise.all([
        pool.query(countSql, params.slice(0, -2)),
        pool.query(listSql, params),
      ]);
      const total = Number(cr[0]?.c || 0);
      writeJson(res, 200, {
        items: rows,
        pagination: { total, limit, offset },
      });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/dispatch/history") {
      const user = await requireAdminOrPermission(req, res, "wms");
      if (!user) return true;
      const { limit, offset } = parseLimitOffset(url, 50);
      const channel = url.searchParams.get("channel");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const params = [];
      let p = 1;
      let where = `WHERE dr.status = 'shipped'`;
      if (channel && String(channel).trim()) {
        where += ` AND dr.channel = $${p++}`;
        params.push(String(channel).trim());
      }
      if (from && String(from).trim()) {
        where += ` AND dr.dispatched_at >= $${p++}::timestamptz`;
        params.push(new Date(from).toISOString());
      }
      if (to && String(to).trim()) {
        where += ` AND dr.dispatched_at < ($${p++}::timestamptz + interval '1 day')`;
        params.push(new Date(to).toISOString());
      }
      const countSql = `SELECT COUNT(*)::bigint AS c FROM dispatch_records dr ${where}`;
      const listSql = `${BASE_SELECT} ${where}
        ORDER BY dr.dispatched_at DESC NULLS LAST
        LIMIT $${p++} OFFSET $${p++}`;
      params.push(limit, offset);
      const [{ rows: cr }, { rows }] = await Promise.all([
        pool.query(countSql, params.slice(0, -2)),
        pool.query(listSql, params),
      ]);
      const total = Number(cr[0]?.c || 0);
      writeJson(res, 200, {
        items: rows,
        pagination: { total, limit, offset },
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/dispatch/request") {
      const user = await requireAdminOrPermission(req, res, "ventas");
      if (!user) return true;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        if (e instanceof SyntaxError) {
          writeJson(res, 400, { ok: false, error: "invalid_json" });
          return true;
        }
        throw e;
      }
      const channel = body.channel != null ? String(body.channel).trim() : "";
      const { saleId, saleTable } = normalizeDispatchSaleRef(body);
      if (!Number.isFinite(saleId) || saleId <= 0 || (saleTable !== "sales" && saleTable !== "sales_orders") || !channel) {
        writeJson(res, 400, {
          ok: false,
          error: "invalid_dispatch_request",
          message:
            "Requiere channel y venta válida: sale_table/source_table sales|sales_orders (o pos→sales), sale_id numérico o pos-N/so-N, o source_id desde vista unificada.",
        });
        return true;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: dup } = await client.query(
          `SELECT id FROM dispatch_records
           WHERE sale_id = $1 AND sale_table = $2 AND status IN ('pending', 'ready_to_ship')
           LIMIT 1`,
          [saleId, saleTable]
        );
        if (dup.length) {
          await client.query("ROLLBACK");
          writeJson(res, 409, { ok: false, error: "dispatch_already_open", dispatch_id: dup[0].id });
          return true;
        }

        if (saleTable === "sales_orders") {
          const { rows: so } = await client.query(
            `SELECT id, status FROM sales_orders WHERE id = $1 FOR UPDATE`,
            [saleId]
          );
          if (!so.length) {
            await client.query("ROLLBACK");
            writeJson(res, 404, {
              ok: false,
              error: "sale_not_found",
              sale_id: saleId,
              sale_table: saleTable,
            });
            return true;
          }
          const st = String(so[0].status || "");
          if (st !== "paid") {
            await client.query("ROLLBACK");
            writeJson(res, 422, { ok: false, error: "invalid_sale_status", status: st, expected: "paid" });
            return true;
          }
          await client.query(`UPDATE sales_orders SET status = 'ready_to_ship', updated_at = now() WHERE id = $1`, [saleId]);
        } else {
          const { rows: sr } = await client.query(
            `SELECT id, status FROM sales WHERE id = $1 FOR UPDATE`,
            [saleId]
          );
          if (!sr.length) {
            await client.query("ROLLBACK");
            writeJson(res, 404, {
              ok: false,
              error: "sale_not_found",
              sale_id: saleId,
              sale_table: saleTable,
            });
            return true;
          }
          const st = String(sr[0].status || "").toUpperCase();
          if (st !== "PAID") {
            await client.query("ROLLBACK");
            writeJson(res, 422, { ok: false, error: "invalid_sale_status", status: st, expected: "PAID" });
            return true;
          }
          await client.query(`UPDATE sales SET status = 'READY_TO_SHIP', updated_at = now() WHERE id = $1`, [saleId]);
        }

        const whId = body.warehouse_id != null ? Number(body.warehouse_id) : null;
        const notes = body.notes != null ? String(body.notes) : null;
        const uname = usernameFrom(user);

        const { rows: ins } = await client.query(
          `INSERT INTO dispatch_records (
             sale_id, sale_table, channel, status, requested_by, requested_at, notes, warehouse_id
           ) VALUES ($1, $2, $3, 'pending', $4, now(), $5, $6)
           RETURNING *`,
          [saleId, saleTable, channel, uname, notes, Number.isFinite(whId) && whId > 0 ? whId : null]
        );

        await client.query("COMMIT");
        writeJson(res, 201, { ok: true, dispatch_record: ins[0] });
        return true;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        if (e && e.code === "23505") {
          writeJson(res, 409, { ok: false, error: "dispatch_already_open" });
          return true;
        }
        throw e;
      } finally {
        client.release();
      }
    }

    const mConfirm = pathname.match(/^\/api\/dispatch\/(\d+)\/confirm\/?$/);
    if (req.method === "POST" && mConfirm) {
      const user = await requireAdminOrPermission(req, res, "wms");
      if (!user) return true;
      const dispatchId = Number(mConfirm[1]);
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        if (e instanceof SyntaxError) {
          writeJson(res, 400, { ok: false, error: "invalid_json" });
          return true;
        }
        throw e;
      }
      const tracking = body.tracking_number != null ? String(body.tracking_number).trim() : "";
      const notesIn = body.notes != null ? String(body.notes) : null;
      const binMovements = Array.isArray(body.bin_movements) ? body.bin_movements : [];

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: dr } = await client.query(
          `SELECT * FROM dispatch_records WHERE id = $1 FOR UPDATE`,
          [dispatchId]
        );
        if (!dr.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { ok: false, error: "not_found" });
          return true;
        }
        const row = dr[0];
        const st = String(row.status || "");
        if (st === "shipped") {
          await client.query("ROLLBACK");
          writeJson(res, 409, { ok: false, error: "already_shipped" });
          return true;
        }
        if (st === "cancelled" || !["pending", "ready_to_ship"].includes(st)) {
          await client.query("ROLLBACK");
          writeJson(res, 422, { ok: false, error: "invalid_dispatch_status", status: st });
          return true;
        }

        if (binMovements.length) {
          await applyDispatchStockMovements(client, {
            binMovements,
            dispatchId,
            userId: user.userId,
          });
        }

        const uname = usernameFrom(user);
        const { rows: upd } = await client.query(
          `UPDATE dispatch_records SET
             status = 'shipped',
             dispatched_by = $2,
             dispatched_at = now(),
             tracking_number = CASE WHEN $3::text <> '' THEN $3 ELSE tracking_number END,
             notes = COALESCE($4, notes),
             updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [dispatchId, uname, tracking, notesIn]
        );

        const saleId = Number(row.sale_id);
        const saleTable = String(row.sale_table);
        if (saleTable === "sales_orders") {
          await client.query(`UPDATE sales_orders SET status = 'shipped', updated_at = now() WHERE id = $1`, [saleId]);
        } else {
          await client.query(`UPDATE sales SET status = 'SHIPPED', updated_at = now() WHERE id = $1`, [saleId]);
        }

        await client.query("COMMIT");

        const ch = String(row.channel || "").toLowerCase();
        if (ch === "mercadolibre" && tracking) {
          await logMlDispatchTracking(dispatchId, tracking, { sale_id: saleId, sale_table: saleTable });
        }

        writeJson(res, 200, { ok: true, dispatch_record: upd[0] });
        return true;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        if (e && e.code === "INVALID_MOVEMENT") {
          writeJson(res, e.status || 400, { ok: false, error: e.message });
          return true;
        }
        throw e;
      } finally {
        client.release();
      }
    }

    const mCancel = pathname.match(/^\/api\/dispatch\/(\d+)\/cancel\/?$/);
    if (req.method === "POST" && mCancel) {
      const user = await requireAdminOrPermission(req, res, "ventas");
      if (!user) return true;
      const dispatchId = Number(mCancel[1]);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: dr } = await client.query(
          `SELECT * FROM dispatch_records WHERE id = $1 FOR UPDATE`,
          [dispatchId]
        );
        if (!dr.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { ok: false, error: "not_found" });
          return true;
        }
        const row = dr[0];
        if (String(row.status) === "shipped") {
          await client.query("ROLLBACK");
          writeJson(res, 409, { ok: false, error: "cannot_cancel_shipped" });
          return true;
        }

        await client.query(
          `UPDATE dispatch_records SET status = 'cancelled', updated_at = now() WHERE id = $1`,
          [dispatchId]
        );

        const saleId = Number(row.sale_id);
        if (String(row.sale_table) === "sales_orders") {
          await client.query(`UPDATE sales_orders SET status = 'paid', updated_at = now() WHERE id = $1`, [saleId]);
        } else {
          await client.query(`UPDATE sales SET status = 'PAID', updated_at = now() WHERE id = $1`, [saleId]);
        }

        await client.query("COMMIT");
        writeJson(res, 200, { ok: true });
        return true;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    }

    const mDetail = pathname.match(/^\/api\/dispatch\/(\d+)\/?$/);
    if (req.method === "GET" && mDetail && !pathname.endsWith("/confirm") && !pathname.endsWith("/cancel")) {
      const user = await requireAdminOrPermission(req, res, "wms");
      if (!user) return true;
      const dispatchId = Number(mDetail[1]);
      const { rows } = await pool.query(
        `${BASE_SELECT} WHERE dr.id = $1`,
        [dispatchId]
      );
      if (!rows.length) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: rows[0] });
      return true;
    }

    return false;
  } catch (e) {
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { ok: false, error: "body_too_large" });
      return true;
    }
    console.error("[dispatch]", e);
    writeJson(res, 500, { ok: false, error: e && e.message ? String(e.message) : "error" });
    return true;
  }
}

module.exports = { handleDispatchApiRequest };
