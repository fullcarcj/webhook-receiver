"use strict";

const { requireAdminOrPermission } = require("../utils/authMiddleware");
const {
  adjustStock,
  reserveStock,
  releaseReservation,
  commitBinReservationSql,
  getStockBySku,
  getStockByBin,
  getPickingListBySkus,
  getPickingListForWarehouse,
  getMovementHistory,
  listWarehouses,
  listBins,
  getBinByCode,
  createBin,
  getWmsInventorySummary,
} = require("../services/wmsService");
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

async function handleWmsApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/wms")) return false;

  try {
    const binsStockMatch = url.pathname.match(/^\/api\/wms\/bins\/(\d+)\/stock\/?$/);
    if (req.method === "GET" && binsStockMatch) {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const binId = Number(binsStockMatch[1]);
      const data = await getStockByBin(binId);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wms/warehouses") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const rows = await listWarehouses(1);
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    if (req.method === "GET" && (url.pathname === "/api/wms/summary" || url.pathname === "/api/wms/summary/")) {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const summary = await getWmsInventorySummary();
      writeJson(res, 200, { ok: true, ...summary });
      return true;
    }

    const whBinsMatch = url.pathname.match(/^\/api\/wms\/warehouses\/(\d+)\/bins\/?$/);
    if (req.method === "GET" && whBinsMatch) {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const warehouseId = Number(whBinsMatch[1]);
      const aisleId = url.searchParams.get("aisle_id");
      const status = url.searchParams.get("status");
      const data = await listBins({
        warehouseId,
        aisleId: aisleId ? Number(aisleId) : null,
        status: status || null,
      });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wms/picking") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const wid = url.searchParams.get("warehouse_id");
      if (!wid || !String(wid).trim()) {
        writeJson(res, 400, { ok: false, error: "warehouse_id obligatorio" });
        return true;
      }
      const raw = url.searchParams.get("skus") || "";
      const skus = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const data = await getPickingListForWarehouse({
        warehouseId: Number(wid),
        skus: skus.length ? skus : null,
      });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wms/movements") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const data = await getMovementHistory({
        sku: url.searchParams.get("sku") || null,
        binId: url.searchParams.get("bin_id"),
        referenceType: url.searchParams.get("reference_type"),
        referenceId: url.searchParams.get("reference_id"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/wms/stock/")) {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const sku = decodeURIComponent(url.pathname.slice("/api/wms/stock/".length).replace(/\/+$/, ""));
      if (sku === "adjust" || sku === "adjust-simple") {
        writeJson(res, 404, {
          ok: false,
          error: "not_found",
          hint: "Los ajustes son POST /api/wms/stock/adjust o POST /api/wms/stock/adjust-simple",
        });
        return true;
      }
      if (!sku) {
        writeJson(res, 400, { ok: false, error: "sku requerido" });
        return true;
      }
      const wid = url.searchParams.get("warehouse_id");
      const rows = await getStockBySku(sku, wid ? Number(wid) : null);
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wms/picking-list") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const raw = url.searchParams.get("skus") || "";
      const skus = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (skus.length === 0) {
        writeJson(res, 400, {
          ok: false,
          error: "Se requiere al menos un SKU",
          example: "?skus=SKU-001,SKU-002",
        });
        return true;
      }
      const orderParam = url.searchParams.get("order");
      let orderOpts = {};
      if (orderParam != null && String(orderParam).trim() !== "") {
        const n = Number(orderParam);
        if (Number.isFinite(n) && n > 0) orderOpts = { orderId: n };
      }
      try {
        const data = await getPickingListBySkus(skus, orderOpts);
        writeJson(res, 200, { ok: true, ...data });
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "error";
        if (msg.includes("skus debe ser")) {
          writeJson(res, 400, { ok: false, error: msg });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/adjust-simple") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const body = await parseJsonBody(req);
      const binId = Number(body.bin_id);
      const sku = body.product_sku != null ? String(body.product_sku).trim() : "";
      const delta =
        body.delta != null && body.delta !== ""
          ? Number(body.delta)
          : NaN;
      if (!Number.isFinite(binId) || binId <= 0) {
        writeJson(res, 400, { ok: false, error: "bin_id debe ser un entero positivo" });
        return true;
      }
      if (!sku) {
        writeJson(res, 400, { ok: false, error: "product_sku es obligatorio" });
        return true;
      }
      if (!Number.isFinite(delta) || delta === 0) {
        writeJson(res, 400, { ok: false, error: "delta debe ser un número distinto de cero" });
        return true;
      }
      const out = await adjustStock({
        bin_id: binId,
        product_sku: sku,
        delta,
        reason: body.reason,
        reference_type: body.reference_type,
        reference_id: body.reference_id,
        user_id: body.user_id,
        notes: body.notes,
      });
      writeJson(res, 200, { ok: true, data: out });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/adjust") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const body = await parseJsonBody(req);
      const binId = body.bin_id != null ? body.bin_id : body.binId;
      const sku = body.product_sku != null ? body.product_sku : body.sku;
      if (binId == null || !String(sku || "").trim()) {
        writeJson(res, 400, { ok: false, error: "bin_id y product_sku (o sku) son obligatorios" });
        return true;
      }
      if (body.delta != null && body.delta !== "" && Number(body.delta) === 0) {
        writeJson(res, 400, { ok: false, error: "delta no puede ser 0" });
        return true;
      }
      const out = await adjustStock({ ...body, bin_id: binId, sku });
      writeJson(res, 200, { ok: true, data: out });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/reserve") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const body = await parseJsonBody(req);
      const qty = body.qty != null ? body.qty : body.quantity;
      if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
        writeJson(res, 400, { ok: false, error: "qty > 0 requerido" });
        return true;
      }
      try {
        const out = await reserveStock({
          bin_id: body.bin_id,
          sku: body.product_sku || body.sku,
          qty,
          reference_id: body.reference_id,
          reference_type: body.reference_type,
          user_id: body.user_id,
        });
        writeJson(res, 200, { ok: true, ...out });
      } catch (e) {
        if (e && e.code === "INSUFFICIENT_STOCK") {
          writeJson(res, 409, {
            ok: false,
            code: "INSUFFICIENT_STOCK",
            available: e.available,
            requested: e.requested,
          });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/commit") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const body = await parseJsonBody(req);
      const qty = body.qty != null ? body.qty : body.quantity;
      if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
        writeJson(res, 400, { ok: false, error: "qty > 0 requerido" });
        return true;
      }
      try {
        const row = await commitBinReservationSql({
          binId: body.bin_id,
          sku: body.product_sku || body.sku,
          qty,
          referenceType: body.reference_type,
          referenceId: body.reference_id,
          userId: body.user_id,
        });
        writeJson(res, 200, { ok: true, data: row });
      } catch (e) {
        if (e && e.code === "INSUFFICIENT_RESERVATION") {
          writeJson(res, 409, { ok: false, code: "INSUFFICIENT_RESERVATION" });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/stock/release") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
      const body = await parseJsonBody(req);
      const qty = body.qty != null ? body.qty : body.quantity;
      if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
        writeJson(res, 400, { ok: false, error: "qty > 0 requerido" });
        return true;
      }
      try {
        const out = await releaseReservation({
          bin_id: body.bin_id,
          sku: body.product_sku || body.sku,
          qty,
          reference_id: body.reference_id,
          reference_type: body.reference_type,
          user_id: body.user_id,
        });
        writeJson(res, 200, { ok: true, ...out });
      } catch (e) {
        if (e && e.code === "INSUFFICIENT_RESERVATION") {
          writeJson(res, 409, { ok: false, code: "INSUFFICIENT_RESERVATION" });
        } else if (e && e.code === "RELEASE_NOT_FOUND") {
          writeJson(res, Number(e.status) || 404, { ok: false, code: "RELEASE_NOT_FOUND" });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wms/ml-order/reserve") {
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
      if (!await requireAdminOrPermission(req, res, 'wms')) return true;
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
