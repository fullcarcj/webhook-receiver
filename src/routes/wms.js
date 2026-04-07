"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const {
  adjustStock,
  reserveStock,
  releaseReservation,
  getStockBySku,
  getPickingList,
  getMovementHistory,
  getBinByCode,
  createBin,
} = require("../services/wmsService");
/** Reservas por orden ML (`ml_order_reservations`); independiente de stock/reserve genérico arriba */
const {
  reserveForOrder,
  commitReservation,
  releaseReservation: releaseMlOrderReservation,
} = require("../services/reservationService");

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

function ensureAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

async function handleWmsApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/wms")) return false;

  try {
    if (req.method === "GET" && url.pathname.startsWith("/api/wms/stock/")) {
      const sku = decodeURIComponent(url.pathname.slice("/api/wms/stock/".length).replace(/\/+$/, ""));
      if (!sku) {
        writeJson(res, 400, { ok: false, error: "sku requerido" });
        return true;
      }
      const row = await getStockBySku(sku);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wms/picking-list") {
      const raw = url.searchParams.get("skus") || "";
      const skus = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const data = await getPickingList(skus);
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/adjust") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const out = await adjustStock({
        binId: Number(body.bin_id),
        sku: String(body.sku || "").trim(),
        deltaAvailable: body.delta_available,
        deltaReserved: body.delta_reserved,
        reason: body.reason,
        referenceId: body.reference_id,
        referenceType: body.reference_type,
        userId: body.user_id,
        notes: body.notes,
      });
      writeJson(res, 200, { ok: true, ...out });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/reserve") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      try {
        const out = await reserveStock({
          sku: String(body.sku || "").trim(),
          quantity: body.quantity,
          referenceId: body.reference_id,
          referenceType: body.reference_type,
          userId: body.user_id,
        });
        writeJson(res, 200, { ok: true, ...out });
      } catch (e) {
        if (e && e.code === "INSUFFICIENT_STOCK") {
          writeJson(res, 409, {
            ok: false,
            error: "INSUFFICIENT_STOCK",
            available: e.available,
            requested: e.requested,
          });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/release") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const out = await releaseReservation({
        sku: String(body.sku || "").trim(),
        quantity: body.quantity,
        referenceId: body.reference_id,
        userId: body.user_id,
      });
      writeJson(res, 200, { ok: true, ...out });
      return true;
    }

    /** Órdenes ML → tabla ml_order_reservations (misma lógica que el webhook orders_v2). Requiere X-Admin-Secret. */
    if (req.method === "POST" && url.pathname === "/api/wms/ml-order/reserve") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const mlOrderId = Number(body.ml_order_id);
      const items = Array.isArray(body.items) ? body.items : [];
      const mlResourceUrl =
        body.ml_resource_url != null ? String(body.ml_resource_url) : body.mlResourceUrl != null ? String(body.mlResourceUrl) : "";
      const userId = body.user_id != null ? body.user_id : body.userId != null ? body.userId : null;
      const r = await reserveForOrder({
        mlOrderId,
        mlResourceUrl,
        items,
        userId,
      });
      if (r.success) {
        writeJson(res, 200, { ok: true, ...r });
      } else if (r.code === "INSUFFICIENT_STOCK") {
        writeJson(res, 409, { ok: false, ...r });
      } else if (r.reason === "ALREADY_RESERVED") {
        writeJson(res, 409, { ok: false, ...r });
      } else if (r.reason === "BAD_ORDER_ID" || r.reason === "NO_ITEMS") {
        writeJson(res, 400, { ok: false, ...r });
      } else {
        writeJson(res, 200, { ok: false, ...r });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/ml-order/commit") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const mlOrderId = Number(body.ml_order_id != null ? body.ml_order_id : body.mlOrderId);
      const userId = body.user_id != null ? body.user_id : body.userId != null ? body.userId : null;
      const r = await commitReservation({ mlOrderId, userId });
      if (r.success) {
        writeJson(res, 200, { ok: true, ...r });
      } else if (r.reason === "NO_ACTIVE_RESERVATION") {
        writeJson(res, 404, { ok: false, ...r });
      } else if (r.reason === "BAD_ORDER_ID") {
        writeJson(res, 400, { ok: false, ...r });
      } else {
        writeJson(res, 200, { ok: false, ...r });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/ml-order/release") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const mlOrderId = Number(body.ml_order_id != null ? body.ml_order_id : body.mlOrderId);
      const userId = body.user_id != null ? body.user_id : body.userId != null ? body.userId : null;
      const r = await releaseMlOrderReservation({ mlOrderId, userId });
      if (r.success) {
        writeJson(res, 200, { ok: true, ...r });
      } else if (r.reason === "NO_ACTIVE_RESERVATION") {
        writeJson(res, 404, { ok: false, ...r });
      } else if (r.reason === "BAD_ORDER_ID") {
        writeJson(res, 400, { ok: false, ...r });
      } else {
        writeJson(res, 200, { ok: false, ...r });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/wms/movements/")) {
      if (!ensureAdmin(req, res)) return true;
      const sku = decodeURIComponent(url.pathname.slice("/api/wms/movements/".length).replace(/\/+$/, ""));
      if (!sku) {
        writeJson(res, 400, { ok: false, error: "sku requerido" });
        return true;
      }
      const from = url.searchParams.get("from") || null;
      const to = url.searchParams.get("to") || null;
      const page = url.searchParams.get("page") || "1";
      const binId = url.searchParams.get("bin_id") || null;
      const data = await getMovementHistory({
        sku,
        binId,
        fromDate: from,
        toDate: to,
        page,
        pageSize: url.searchParams.get("pageSize") || url.searchParams.get("page_size") || "50",
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/bins") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const row = await createBin({
        shelfId: Number(body.shelf_id),
        level: Number(body.level),
        maxWeightKg: body.max_weight_kg,
        maxVolumeCbm: body.max_volume_cbm,
        notes: body.notes,
      });
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/wms/bins/")) {
      const binCode = decodeURIComponent(url.pathname.slice("/api/wms/bins/".length).replace(/\/+$/, ""));
      if (!binCode) {
        writeJson(res, 400, { ok: false, error: "bin_code requerido" });
        return true;
      }
      const row = await getBinByCode(binCode);
      if (!row) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
    return true;
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "error";
    console.error("[wms]", e);
    writeJson(res, 500, { ok: false, error: msg });
    return true;
  }
}

module.exports = { handleWmsApiRequest };
