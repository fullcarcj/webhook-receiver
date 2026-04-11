"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const {
  createLot,
  getLotsBySku,
  dispatchFromLot,
  getExpiryAlerts,
  runDailyExpiry,
} = require("../services/lotService");

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

function validAdminSecret(req) {
  const s = process.env.ADMIN_SECRET;
  if (!s) return false;
  return timingSafeCompare(req.headers["x-admin-secret"], s);
}

function validCronToken(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+/i.test(String(auth))) return false;
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  return timingSafeCompare(token, secret);
}

function ensureAdmin(req, res) {
  if (!process.env.ADMIN_SECRET) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  if (!validAdminSecret(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

function mapLotError(e) {
  const c = e && e.code;
  if (c === "LOT_TRACKING_NOT_REQUIRED") return { status: 422, body: { ok: false, error: e.message, code: c } };
  if (c === "LOT_EXPIRED" || c === "LOT_IN_QUARANTINE" || c === "LOT_BAD_STATUS") {
    return { status: 422, body: { ok: false, error: e.message, code: c, lotNumber: e.lotNumber } };
  }
  if (c === "INSUFFICIENT_LOT_STOCK") {
    return {
      status: 409,
      body: { ok: false, error: e.message, code: c, available: e.available, requested: e.requested },
    };
  }
  if (c === "NEGATIVE_STOCK" || c === "INVALID_ADJUSTMENT") {
    return { status: 409, body: { ok: false, error: e.message, code: c } };
  }
  if (e && e.code === "23505") {
    return { status: 409, body: { ok: false, error: "Conflicto de unicidad (lote o stock)", code: "DUPLICATE" } };
  }
  return { status: 500, body: { ok: false, error: e.message || String(e) } };
}

/**
 * @returns {Promise<boolean>}
 */
async function handleLotsApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/lots")) return false;

  try {
    if (req.method === "GET" && pathname === "/api/lots/alerts") {
      if (!ensureAdmin(req, res)) return true;
      const days = Number(url.searchParams.get("days") || 90);
      const data = await getExpiryAlerts({ companyId: 1, days });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/lots/expire-daily") {
      const okAdmin = validAdminSecret(req);
      const okCron = validCronToken(req);
      if (!okAdmin && !okCron) {
        writeJson(res, 403, { ok: false, error: "forbidden" });
        return true;
      }
      const data = await runDailyExpiry();
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/lots/dispatch") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const data = await dispatchFromLot({
        lotId: body.lot_id,
        binId: body.bin_id,
        qty: body.qty,
        referenceType: body.reference_type,
        referenceId: body.reference_id,
        userId: body.user_id,
      });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/lots" || pathname === "/api/lots/")) {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const data = await createLot({
        companyId: body.company_id,
        sku: body.sku,
        expirationDate: body.expiration_date,
        manufactureDate: body.manufacture_date,
        importShipmentId: body.import_shipment_id,
        qtyInitial: body.qty_initial,
        binId: body.bin_id,
        notes: body.notes,
        supplierLotNumber: body.supplier_lot_number,
        receivedDate: body.received_date,
        userId: body.user_id,
      });
      writeJson(res, 201, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/api/lots/")) {
      const rest = pathname.slice("/api/lots/".length).replace(/\/+$/, "");
      if (!rest || rest === "alerts" || rest === "dispatch" || rest === "expire-daily") {
        return false;
      }
      if (!ensureAdmin(req, res)) return true;
      const sku = decodeURIComponent(rest);
      const rows = await getLotsBySku(sku);
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }
  } catch (e) {
    const m = mapLotError(e);
    writeJson(res, m.status, m.body);
    return true;
  }

  return false;
}

module.exports = { handleLotsApiRequest };
