"use strict";

const { z } = require("zod");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { checkAdminSecretOrJwt, requirePermission } = require("../utils/authMiddleware");
const deliveryService = require("../services/deliveryService");

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

const zoneSchema = z.object({
  zone_name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  base_cost_bs: z.number().positive(),
  client_price_bs: z.number().positive(),
  base_cost_usd: z.number().positive().optional(),
  currency_pago: z.enum(deliveryService.DELIVERY_CURRENCIES).default("BS"),
  estimated_minutes: z.number().int().min(1).optional(),
});

const zonePatchSchema = zoneSchema.partial().refine((d) => Object.keys(d).length > 0, {
  message: "Debe enviar al menos un campo",
});

const providerSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().regex(/^584[0-9]{9}$/).optional(),
  id_document: z.string().max(20).optional(),
  preferred_currency: z.enum(deliveryService.DELIVERY_CURRENCIES).default("BS"),
});

const providerPatchSchema = providerSchema
  .extend({ is_active: z.boolean().optional() })
  .partial()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe enviar al menos un campo",
  });

const assignSchema = z.object({ provider_id: z.number().int().positive() });
const deliverSchema = z.object({ notes: z.string().max(2000).optional() });

const liquidateSchema = z
  .object({
    statement_id: z.number().int().positive().optional(),
    manual_tx_id: z.number().int().positive().optional(),
    delivery_ids: z.array(z.number().int().positive()).optional(),
    paid_by: z.enum(["Javier", "Jesus", "Sebastian"]),
  })
  .refine((d) => d.statement_id || d.manual_tx_id, {
    message: "Debe indicar statement_id o manual_tx_id del pago",
  });

function userHasModuleAction(user, module, action) {
  if (user.role === "SUPERUSER") return true;
  return (
    Array.isArray(user.permissions) &&
    user.permissions.some((p) => p.module === module && p.action === action)
  );
}

async function handleDeliveryApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/delivery")) return false;

  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const user = await checkAdminSecretOrJwt(req, res);
  if (!user) return true;
  const resolvedAction =
    req.method === "GET" ? "read" : req.method === "DELETE" ? "admin" : "write";
  const isGetZones = req.method === "GET" && pathname === "/api/delivery/zones";
  if (isGetZones) {
    if (
      !userHasModuleAction(user, "ventas", "read") &&
      !userHasModuleAction(user, "settings", "read")
    ) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "FORBIDDEN",
          message: "Se requiere ventas:read o settings:read para listar zonas de delivery",
        })
      );
      return true;
    }
  } else if (!requirePermission(user, "settings", resolvedAction, res)) {
    return true;
  }

  try {
    // GET /api/delivery/zones
    if (req.method === "GET" && pathname === "/api/delivery/zones") {
      const data = await deliveryService.getZones();
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // POST /api/delivery/zones
    if (req.method === "POST" && pathname === "/api/delivery/zones") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(zoneSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.createZone(parsed.data);
      writeJson(res, 201, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // PATCH /api/delivery/zones/:id
    const zonePatch = pathname.match(/^\/api\/delivery\/zones\/(\d+)$/);
    if (req.method === "PATCH" && zonePatch) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(zonePatchSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.updateZone(Number(zonePatch[1]), parsed.data);
      if (!data) return writeJson(res, 404, { error: "NOT_FOUND" }), true;
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // GET /api/delivery/providers
    if (req.method === "GET" && pathname === "/api/delivery/providers") {
      const data = await deliveryService.getProviders();
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // POST /api/delivery/providers
    if (req.method === "POST" && pathname === "/api/delivery/providers") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(providerSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.createProvider(parsed.data);
      writeJson(res, 201, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // PATCH /api/delivery/providers/:id
    const providerPatch = pathname.match(/^\/api\/delivery\/providers\/(\d+)$/);
    if (req.method === "PATCH" && providerPatch) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(providerPatchSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.updateProvider(Number(providerPatch[1]), parsed.data);
      if (!data) return writeJson(res, 404, { error: "NOT_FOUND" }), true;
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // GET /api/delivery/services
    if (req.method === "GET" && pathname === "/api/delivery/services") {
      const status = url.searchParams.get("status") || undefined;
      const providerId = url.searchParams.get("provider_id");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 200);
      const offset = Math.max(Number(url.searchParams.get("offset") || "0"), 0);
      const data = await deliveryService.listServices({
        status,
        providerId: providerId ? Number(providerId) : undefined,
        limit,
        offset,
      });
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString(), limit, offset } });
      return true;
    }

    // GET /api/delivery/services/:id
    const serviceGet = pathname.match(/^\/api\/delivery\/services\/(\d+)$/);
    if (req.method === "GET" && serviceGet) {
      const data = await deliveryService.getServiceById(Number(serviceGet[1]));
      if (!data) return writeJson(res, 404, { error: "NOT_FOUND" }), true;
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // PATCH /api/delivery/services/:id/assign
    const serviceAssign = pathname.match(/^\/api\/delivery\/services\/(\d+)\/assign$/);
    if (req.method === "PATCH" && serviceAssign) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(assignSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.assignProvider(Number(serviceAssign[1]), parsed.data.provider_id);
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // PATCH /api/delivery/services/:id/deliver
    const serviceDeliver = pathname.match(/^\/api\/delivery\/services\/(\d+)\/deliver$/);
    if (req.method === "PATCH" && serviceDeliver) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(deliverSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.confirmDelivery(Number(serviceDeliver[1]), parsed.data.notes);
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // GET /api/delivery/providers/:id/pending
    const providerPending = pathname.match(/^\/api\/delivery\/providers\/(\d+)\/pending$/);
    if (req.method === "GET" && providerPending) {
      const data = await deliveryService.getPendingPayments(Number(providerPending[1]));
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // POST /api/delivery/providers/:id/liquidate
    const providerLiquidate = pathname.match(/^\/api\/delivery\/providers\/(\d+)\/liquidate$/);
    if (req.method === "POST" && providerLiquidate) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(liquidateSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await deliveryService.liquidateProvider({
        providerId: Number(providerLiquidate[1]),
        statementId: parsed.data.statement_id,
        manualTxId: parsed.data.manual_tx_id,
        deliveryIds: parsed.data.delivery_ids,
        paidBy: parsed.data.paid_by,
      });
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // GET /api/delivery/debt-summary
    if (req.method === "GET" && pathname === "/api/delivery/debt-summary") {
      const data = await deliveryService.getDebtSummary();
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // GET /api/delivery/stats
    if (req.method === "GET" && pathname === "/api/delivery/stats") {
      const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400_000).toISOString();
      const to = url.searchParams.get("to") || new Date().toISOString();
      const data = await deliveryService.getDeliveryStats(from, to);
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString(), from, to } });
      return true;
    }
  } catch (e) {
    if (e && e.code === "INVALID_STATE") {
      writeJson(res, 422, { error: "invalid_state", message: String(e.message || "") });
      return true;
    }
    if (e && e.code === "NO_PENDING") {
      writeJson(res, 404, { error: "no_pending", message: String(e.message || "") });
      return true;
    }
    if (e && e.code === "MISSING_PAYMENT_REF") {
      writeJson(res, 400, { error: "missing_payment_ref", message: String(e.message || "") });
      return true;
    }
    if (e && e.code === "23505") {
      writeJson(res, 409, { error: "duplicate", message: String(e.detail || e.message || "") });
      return true;
    }
    writeJson(res, 500, { error: "error", message: String(e.message || e) });
    return true;
  }

  writeJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { handleDeliveryApiRequest };
