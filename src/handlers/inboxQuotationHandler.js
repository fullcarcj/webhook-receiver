"use strict";

/**
 * Cotizaciones inbox → inventario_presupuesto / inventario_detallepresupuesto.
 *
 * POST /api/inbox/:chatId/quotations/from-ml-order — borrador CH-3 desde orden ML vinculada (tasas con getTodayRate).
 *
 * POST /api/inbox/quotations — ítems:
 *   - `precio_unitario` (USD) cuando la UI cotiza en dólares.
 *   - `precio_unitario_bs` (Bs por unidad) cuando la UI cotiza en bolívares; se convierte a USD con `binance_rate` de getTodayRate(company_id).
 *   - Opcional `body.company_id` para la tasa (default 1).
 *
 * Status en BD (verificación 2026-04-16 contra DATABASE_URL local):
 *   SELECT DISTINCT status FROM inventario_presupuesto → sin filas (tabla vacía o status NULL).
 *   Valores usados por esta API para filas nuevas: 'draft' (borrador) y 'sent' (enviado por WA).
 *
 * Detalle / edición de ítems (evita colisión con GET …/quotations/:chatId):
 *   GET    /api/inbox/quotations/presupuesto/:id
 *   PATCH  /api/inbox/quotations/presupuesto/:id/items
 */

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission, checkAdminSecretOrJwt } = require("../utils/authMiddleware");
const quotationPaymentSettlementService = require("../services/quotationPaymentSettlementService");
const { pool } = require("../../db");
const { sendChatMessage } = require("../services/chatMessageService");
const { getTodayRate } = require("../services/currencyService");
const {
  resolveLinkedMlOrderId,
  resolveExternalMlOrderIdFromSalesLink,
} = require("../utils/chatMlOrderReference");
const { parseOrderItems, resolveProductSku } = require("./inboxMlOrderHandler");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_quotation_api",
});

const STATUS_DRAFT    = "draft";
const STATUS_SENT     = "sent";
const STATUS_APPROVED = "approved";
const STATUS_REJECTED = "rejected";

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

/** Aprobación pierna USD: fiscal u operación CRM con write. */
function userCanApproveUsdCaja(user) {
  if (!user) return false;
  if (user.role === "SUPERUSER") return true;
  const p = Array.isArray(user.permissions) ? user.permissions : [];
  return p.some((x) => x.module === "fiscal" && x.action === "write")
    || p.some((x) => x.module === "crm" && x.action === "write");
}

/**
 * Cotización con pago totalmente cerrado (mixto) — no se debe mutar status/etapa/conversión manual.
 * @returns {Promise<boolean>} true si está bloqueada
 */
async function isQuotationPaymentLocked(presupuestoId) {
  const st = await quotationPaymentSettlementService.getSettlementState(presupuestoId, null);
  return Boolean(st.fullySettled);
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toFixed(2);
}

/**
 * Precio unitario persistido en inventario_detallepresupuesto en USD.
 * - `precio_unitario`: USD (switch moneda USD en UI).
 * - `precio_unitario_bs`: Bs por unidad (switch VEF); se divide por binance_rate del día.
 * @param {object} it
 * @param {object|null} rateRow getTodayRate()
 * @returns {{ pu?: number, error?: string, detail?: string }}
 */
function resolveQuotationLineUnitUsd(it, rateRow) {
  const hasBs =
    it.precio_unitario_bs != null &&
    String(it.precio_unitario_bs).trim() !== "" &&
    !Number.isNaN(Number(it.precio_unitario_bs));
  if (hasBs) {
    const bs = Number(it.precio_unitario_bs);
    if (!Number.isFinite(bs) || bs < 0) {
      return { error: "precio_unitario_bs inválido en items" };
    }
    const bin = rateRow ? Number(rateRow.binance_rate) : NaN;
    if (!Number.isFinite(bin) || bin <= 0) {
      return {
        error: "tasa_binance_no_disponible",
        detail:
          "Con precio en bolívares (precio_unitario_bs) hace falta binance_rate del día en daily_exchange_rates.",
      };
    }
    return { pu: Math.round((bs / bin) * 1e6) / 1e6 };
  }
  const pu = it.precio_unitario != null ? Number(it.precio_unitario) : NaN;
  if (!Number.isFinite(pu) || pu < 0) {
    return { error: "precio_unitario inválido en items" };
  }
  return { pu };
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
 * INSERT inventario_presupuesto + líneas dentro de una transacción abierta en `client`.
 * @param {import("pg").PoolClient} client
 * @param {object} params
 */
async function insertPresupuestoDraft(client, params) {
  const {
    fechaVencimiento,
    total,
    observaciones,
    clienteId,
    createdBy,
    chatId,
    channelId,
    salesOrderId,
    lines,
  } = params;
  const salesOrderIdVal =
    salesOrderId != null && Number.isFinite(Number(salesOrderId)) && Number(salesOrderId) > 0
      ? Number(salesOrderId)
      : null;
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
       sales_order_id,
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
       $10,
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
      salesOrderIdVal,
    ]
  );
  const presupuestoId = ins.rows[0].id;
  for (const L of lines) {
    await client.query(
      `INSERT INTO inventario_detallepresupuesto (
         cantidad, precio_unitario, subtotal, producto_id, presupuesto_id
       ) VALUES ($1, $2, $3, $4, $5)`,
      [L.cantidad, L.precio_unitario, L.subtotal, L.producto_id, presupuestoId]
    );
  }
  return presupuestoId;
}

async function resolveActiveProductoIdFromMlSkuRow(prodSkuRow) {
  if (!prodSkuRow || !prodSkuRow.product_sku) return null;
  if (prodSkuRow.product_id != null) {
    const pid = Number(prodSkuRow.product_id);
    if (Number.isFinite(pid) && pid > 0) {
      const { rows } = await pool.query(
        `SELECT id FROM products WHERE id = $1 AND is_active = true LIMIT 1`,
        [pid]
      );
      if (rows.length) return Number(rows[0].id);
    }
  }
  const { rows } = await pool.query(
    `SELECT id FROM products WHERE sku = $1 AND is_active = true LIMIT 1`,
    [prodSkuRow.product_sku]
  );
  return rows[0]?.id != null ? Number(rows[0].id) : null;
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
      p.sales_order_id,
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
    sales_order_id: r.sales_order_id != null ? Number(r.sales_order_id) : null,
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

/**
 * Genera el mensaje de pago en Bs con datos de PagoMóvil.
 * Monto en Bs y pie de tasa: prioriza tasa BCV (`bcv_rate`) para coherencia con el texto “Tasa BCV”.
 * @param {number} totalUsd  - monto total de la cotización en USD
 * @param {object} rateRow   - fila devuelta por getTodayRate()
 * @returns {string}
 */
/** Líneas fijas del instructivo Pago Móvil (mismo texto que `formatPaymentMessage`). */
const PM_KNOWN_PHONE = "04241394269";
const PM_KNOWN_CI = "17488886";
const PM_KNOWN_BANK = "banesco";
const PM_KNOWN_BANK_CODE = "0134";

/**
 * Quita de observaciones bloques que repiten el instructivo de Pago Móvil, para no duplicarlo
 * junto al bloque automático de pago en Bs.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function cleanObservacionesForQuote(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  const hasPmHeading = /pago\s*m[óo]vil|pagom[óo]vil|📱/.test(low);
  const looksLikeOurPm =
    hasPmHeading ||
    (low.includes(PM_KNOWN_BANK) &&
      low.includes(PM_KNOWN_BANK_CODE) &&
      (low.includes(PM_KNOWN_PHONE) || low.includes(PM_KNOWN_CI)));
  if (!looksLikeOurPm) return t;

  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const kept = blocks.filter((b) => {
    const l = b.toLowerCase();
    if (/pago\s*m[óo]vil|pagom[óo]vil|📱/.test(l)) return false;
    if (l.includes(PM_KNOWN_BANK) && l.includes(PM_KNOWN_BANK_CODE) && l.includes(PM_KNOWN_PHONE)) return false;
    if (l.includes(PM_KNOWN_BANK) && l.includes(PM_KNOWN_BANK_CODE) && l.includes(PM_KNOWN_CI)) return false;
    return true;
  });
  const out = kept.join("\n\n").trim();
  return out || null;
}

/**
 * Tasa usada para cotizar en Bs: Binance P2P del día (misma base que el detalle de ítems).
 * Si no hay binance_rate, se usa BCV y luego active_rate.
 */
function quotationRateBsPerUsd(rateRow) {
  if (!rateRow) return { rate: 0, label: "" };
  const bin = Number(rateRow.binance_rate ?? 0);
  if (Number.isFinite(bin) && bin > 0) return { rate: bin, label: "Binance" };
  const bcv = Number(rateRow.bcv_rate ?? 0);
  if (Number.isFinite(bcv) && bcv > 0) return { rate: bcv, label: "BCV" };
  const act = Number(rateRow.active_rate ?? 0);
  if (Number.isFinite(act) && act > 0) {
    const t = String(rateRow.active_rate_type ?? "").toUpperCase();
    return { rate: act, label: t || "activa" };
  }
  return { rate: 0, label: "" };
}

function usdToQuotationBs(usd, rateRow) {
  const { rate } = quotationRateBsPerUsd(rateRow);
  if (!(rate > 0)) return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * rate * 100) / 100;
}

/**
 * Monto en Bs y valor mostrado como Bs/USD en el bloque de pago:
 * prioriza `bcv_rate`; si no hay, misma tasa que la cotización (Binance → BCV → activa).
 * La leyenda del pie siempre dice «Tasa BCV» (texto fijado para el cliente).
 */
function paymentBsRateAndAmount(totalUsd, rateRow) {
  if (!rateRow) return { rate: 0, totalBs: null };
  const bcv = Number(rateRow.bcv_rate ?? 0);
  if (Number.isFinite(bcv) && bcv > 0) {
    const u = Number(totalUsd);
    const totalBs = Number.isFinite(u) ? Math.round(u * bcv * 100) / 100 : null;
    return { rate: bcv, totalBs };
  }
  const { rate } = quotationRateBsPerUsd(rateRow);
  const u = Number(totalUsd);
  const totalBs = rate > 0 && Number.isFinite(u) ? Math.round(u * rate * 100) / 100 : null;
  return { rate, totalBs };
}

function formatPaymentMessage(totalUsd, rateRow) {
  const rateDate = rateRow ? String(rateRow.rate_date ?? "").slice(0, 10) : null;
  const { rate: usedRate, totalBs } = paymentBsRateAndAmount(totalUsd, rateRow);

  const lines = [];
  lines.push("💳 *Pago en Bolívares*");
  lines.push("");
  if (totalBs != null) {
    lines.push(`Monto: *Bs. ${moneyBs(totalBs)}*`);
  } else {
    lines.push("_(Tasa no disponible, consultar monto en Bs)_");
  }
  lines.push("");
  lines.push("📱 *PagoMóvil*");
  lines.push("Banco: Banesco 0134");
  lines.push(`Teléfono: ${PM_KNOWN_PHONE}`);
  lines.push(`C.I.: ${PM_KNOWN_CI}`);
  if (usedRate > 0) {
    const datePart = rateDate ? ` ${rateDate}` : "";
    lines.push("");
    lines.push(`_Tasa BCV${datePart}: Bs.\u00a0${moneyBs(usedRate)} / USD_`);
  }
  lines.push("");
  lines.push("Espero el comprobante de pago.");
  return lines.join("\n");
}

/** Formatea un número en estilo venezolano: separador miles punto, decimales coma. */
function moneyBs(n) {
  const fixed = Number(n).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${intFmt},${decPart}`;
}

/**
 * Genera el texto de WhatsApp para una cotización.
 * Formato profesional: encabezado, tabla de ítems alineada y resumen final.
 * @param {object|null} rateRow Fila de getTodayRate (Binance preferida para Bs de cotización).
 */
function formatSendMessage(row, reference, items, rateRow = null) {
  // Trunca nombres largos preservando la parte más informativa
  const shortName = (raw, maxLen = 40) => {
    const n = String(raw ?? "(producto)").trim();
    if (n.length <= maxLen) return n;
    // Cortar en el último espacio antes del límite
    const cut = n.lastIndexOf(" ", maxLen - 1);
    return (cut > 10 ? n.slice(0, cut) : n.slice(0, maxLen)) + "…";
  };

  // Fecha de vencimiento como "DD/MM/AAAA" o "Thu Apr 23" → normalizar a legible
  const fmtDate = (raw) => {
    if (!raw) return null;
    try {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) return String(raw).slice(0, 10);
      return d.toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" });
    } catch { return String(raw).slice(0, 10); }
  };

  const vence = fmtDate(row.fecha_vencimiento);
  const subtotalUSD = items.reduce((s, it) => s + Number(it.subtotal ?? 0), 0);
  const iva = Number(row.total ?? 0) - subtotalUSD;
  const { rate: fxRate, label: fxLabel } = quotationRateBsPerUsd(rateRow);
  const rateDateStr = rateRow ? String(rateRow.rate_date ?? "").slice(0, 10) : null;
  const fxNote =
    fxRate > 0 && rateDateStr
      ? ` (${fxLabel}, ${rateDateStr})`
      : fxRate > 0
        ? ` (${fxLabel})`
        : "";

  const lines = [];

  // ── Encabezado ──────────────────────────────────────────────
  lines.push(`🧾 *Cotización ${reference}*`);
  if (row.cliente_nombre) {
    lines.push(`👤 ${String(row.cliente_nombre).trim()}`);
  }
  lines.push("");

  // ── Ítems ───────────────────────────────────────────────────
  for (const it of items) {
    const name = shortName(it.name);
    const cant = Number(it.cantidad ?? 1);
    const sub  = Number(it.subtotal ?? 0);
    const unit = cant > 0 ? sub / cant : 0;
    lines.push(`▸ *${name}*`);
    if (cant > 1) {
      lines.push(`   ${cant} u × $${money(unit)}  →  *$${money(sub)}*`);
    } else {
      lines.push(`   $${money(sub)}`);
    }
  }
  lines.push("");

  // ── Resumen ─────────────────────────────────────────────────
  if (iva > 0.005) {
    lines.push(`Subtotal: $${money(subtotalUSD)}`);
    const subBsT = usdToQuotationBs(subtotalUSD, rateRow);
    if (subBsT != null) lines.push(`Subtotal Bs${fxNote}: *Bs.\u00a0${moneyBs(subBsT)}*`);
    lines.push(`IVA 16 %: $${money(iva)}`);
    const ivaBs = usdToQuotationBs(iva, rateRow);
    if (ivaBs != null) lines.push(`IVA Bs${fxNote}: *Bs.\u00a0${moneyBs(ivaBs)}*`);
    lines.push(`*Total:   $${money(row.total)}*`);
  } else {
    lines.push(`*Total: $${money(row.total)}*`);
  }
  if (vence) lines.push(`Válida hasta: ${vence}`);

  // ── Observaciones (sin repetir datos de Pago Móvil del bloque automático) ──
  const obsClean = cleanObservacionesForQuote(row.observaciones);
  if (obsClean) {
    lines.push("", `📝 ${obsClean}`);
  }

  return lines.join("\n");
}

/**
 * @returns {Promise<boolean>}
 */
async function handleInboxQuotationRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const isFromMlOrderPost =
    req.method === "POST" && /^\/api\/inbox\/\d+\/quotations\/from-ml-order$/.test(pathname);
  const isQuotations = pathname.startsWith("/api/inbox/quotations");
  const isPaymentAttemptsGet = req.method === "GET" && pathname === "/api/inbox/payment-attempts";
  const isPaymentAttemptsLink =
    req.method === "POST" &&
    /^\/api\/inbox\/payment-attempts\/\d+\/link-quotation$/.test(pathname);
  const isPaymentAllocApproveUsd =
    req.method === "POST" &&
    /^\/api\/inbox\/payment-allocations\/\d+\/approve-usd$/.test(pathname);
  const isAllocationsGet =
    req.method === "GET" &&
    /^\/api\/inbox\/quotations\/\d+\/allocations$/.test(pathname);
  if (
    !isQuotations &&
    !isPaymentAttemptsGet &&
    !isPaymentAttemptsLink &&
    !isPaymentAllocApproveUsd &&
    !isAllocationsGet &&
    !isFromMlOrderPost
  ) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (isAllocationsGet) {
    const user2 = await requireAdminOrPermission(req, res, "crm");
    if (!user2) return true;
    const allocGetMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/allocations$/);
    const qId = allocGetMatch ? Number(allocGetMatch[1]) : NaN;
    if (!Number.isFinite(qId) || qId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "id de cotización inválido" });
      return true;
    }
    const tbl = await quotationPaymentSettlementService.allocationTableExists(null).catch(() => false);
    if (!tbl) {
      writeJson(res, 200, { ok: true, items: [], schema_missing: true });
      return true;
    }
    try {
      const { rows } = await pool.query(
        `SELECT
           a.id,
           a.payment_attempt_id,
           a.source_currency,
           a.amount_original::text   AS amount_original,
           a.amount_usd_equivalent::text AS amount_usd_equivalent,
           a.fx_rate_bs_per_usd::text    AS fx_rate_bs_per_usd,
           a.usd_caja_status,
           a.caja_approved_by,
           a.caja_approved_at,
           a.created_at,
           a.notes
         FROM quotation_payment_allocations a
         WHERE a.quotation_id = $1
         ORDER BY a.created_at ASC`,
        [qId]
      );
      writeJson(res, 200, { ok: true, quotation_id: qId, items: rows });
    } catch (e) {
      if (e && e.code === "42P01") {
        writeJson(res, 200, { ok: true, items: [], schema_missing: true });
      } else {
        throw e;
      }
    }
    return true;
  }

  if (isPaymentAllocApproveUsd) {
    const uApprove = await checkAdminSecretOrJwt(req, res);
    if (!uApprove) return true;
    if (!userCanApproveUsdCaja(uApprove)) {
      writeJson(res, 403, {
        error:    "forbidden",
        message:  "Se requiere permiso fiscal:write o crm:write para aprobar cobros en USD.",
      });
      return true;
    }
    const m = pathname.match(/^\/api\/inbox\/payment-allocations\/(\d+)\/approve-usd$/);
    const allocId = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(allocId) || allocId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "id de imputación inválido" });
      return true;
    }
    const uid = uApprove.userId != null ? Number(uApprove.userId) : null;
    try {
      const { rows } = await pool.query(
        `UPDATE quotation_payment_allocations
            SET usd_caja_status = 'approved',
                caja_approved_by = $2,
                caja_approved_at = NOW()
          WHERE id = $1
            AND source_currency = 'USD'
            AND usd_caja_status = 'pending'
          RETURNING id, quotation_id`,
        [allocId, Number.isFinite(uid) && uid > 0 ? uid : null]
      );
      if (!rows.length) {
        writeJson(res, 404, {
          error:   "not_found",
          message: "Imputación USD no encontrada o ya procesada.",
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        allocation_id: rows[0].id,
        quotation_id:  rows[0].quotation_id,
        usd_caja_status: "approved",
      });
    } catch (e) {
      if (e && e.code === "42P01") {
        writeJson(res, 503, {
          error:   "schema_missing",
          message: "Ejecutá sql/20260427_quotation_payment_allocations.sql en la base de datos.",
        });
        return true;
      }
      throw e;
    }
    return true;
  }

  /** POST /api/inbox/quotations/:id/caja-usd-complement — caja registra USD aprobado que complementa el Bs ya conciliado. */
  if (req.method === "POST" && /^\/api\/inbox\/quotations\/\d+\/caja-usd-complement$/.test(pathname)) {
    const uCaja = await checkAdminSecretOrJwt(req, res);
    if (!uCaja) return true;
    if (!userCanApproveUsdCaja(uCaja)) {
      writeJson(res, 403, {
        error:   "forbidden",
        message: "Se requiere permiso fiscal:write o crm:write para registrar el complemento en USD.",
      });
      return true;
    }
    const mCaja = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/caja-usd-complement$/);
    const qidCaja = mCaja ? Number(mCaja[1]) : NaN;
    if (!Number.isFinite(qidCaja) || qidCaja <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "id de cotización inválido" });
      return true;
    }
    let bodyCaja = {};
    try {
      bodyCaja = await parseJsonBody(req);
    } catch (_e) {
      bodyCaja = {};
    }
    const amountUsd =
      bodyCaja.amount_usd != null ? Number(bodyCaja.amount_usd) : NaN;
    const notesCaja =
      bodyCaja.notes != null && String(bodyCaja.notes).trim() !== ""
        ? String(bodyCaja.notes).trim().slice(0, 500)
        : null;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "amount_usd debe ser un número mayor a cero." });
      return true;
    }
    const tblCaja = await quotationPaymentSettlementService.allocationTableExists(null).catch(() => false);
    if (!tblCaja) {
      writeJson(res, 503, {
        error:   "schema_missing",
        message: "Ejecutá sql/20260427_quotation_payment_allocations.sql en la base de datos.",
      });
      return true;
    }
    const { rows: ipCaja } = await pool.query(
      `SELECT id, channel_id, status FROM inventario_presupuesto WHERE id = $1`,
      [qidCaja]
    );
    if (!ipCaja.length) {
      writeJson(res, 404, { error: "not_found", message: "Cotización no encontrada" });
      return true;
    }
    if (Number(ipCaja[0].channel_id) !== 2) {
      writeJson(res, 422, {
        error:   "unsupported_channel",
        message: "Solo cotizaciones canal WhatsApp/Redes (channel_id = 2).",
      });
      return true;
    }
    const stLock = await quotationPaymentSettlementService.getSettlementState(qidCaja, null);
    if (stLock.fullySettled) {
      writeJson(res, 409, {
        error:   "payment_already_closed",
        message: "El pago ya está totalmente cerrado; no hace falta complemento USD.",
      });
      return true;
    }
    await quotationPaymentSettlementService.hydrateLegacyMatchedAttempts(null, qidCaja);
    const stBase = await quotationPaymentSettlementService.getSettlementState(qidCaja, null);
    if (!stBase.hasBsReconciledBaseline) {
      writeJson(res, 409, {
        error:   "bs_baseline_required",
        message:
          "Primero debe quedar registrada la parte en bolívares (comprobante conciliado o imputación VES). Luego caja puede registrar el complemento en USD.",
      });
      return true;
    }
    const uidCaja = uCaja.userId != null ? Number(uCaja.userId) : null;
    const clientCaja = await pool.connect();
    try {
      await clientCaja.query("BEGIN");
      await quotationPaymentSettlementService.insertCajaApprovedUsdComplement(clientCaja, {
        quotationId: qidCaja,
        amountUsd,
        userId:      Number.isFinite(uidCaja) && uidCaja > 0 ? uidCaja : null,
        notes:       notesCaja,
      });
      await quotationPaymentSettlementService.assertAllocationTotalsWithinTolerance(clientCaja, qidCaja);
      await clientCaja.query("COMMIT");
    } catch (e) {
      await clientCaja.query("ROLLBACK").catch(() => {});
      if (String(e.code) === "OVER_ALLOCATED") {
        writeJson(res, 409, {
          error:   "over_allocated",
          message: e.message || "Ese monto en USD supera lo que falta por cubrir del total de la cotización.",
        });
        return true;
      }
      if (e && e.code === "AMOUNT_INVALID") {
        writeJson(res, 400, { error: "bad_request", message: e.message || "Monto inválido." });
        return true;
      }
      if (e && e.code === "42P01") {
        writeJson(res, 503, {
          error:   "schema_missing",
          message: "Ejecutá sql/20260427_quotation_payment_allocations.sql en la base de datos.",
        });
        return true;
      }
      throw e;
    } finally {
      clientCaja.release();
    }
    const stAfterCaja = await quotationPaymentSettlementService.getSettlementState(qidCaja, null);
    writeJson(res, 201, {
      ok:                    true,
      quotation_id:          qidCaja,
      payment_fully_settled: Boolean(stAfterCaja.fullySettled),
      message:               stAfterCaja.fullySettled
        ? "Pago cerrado. El vendedor puede crear la orden de compra (CH-2) y el pedido pasará a despacho según el flujo de ventas."
        : "Complemento USD registrado. Aún falta cobertura o hay otra pierna USD pendiente de caja.",
    });
    return true;
  }

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const isDev = process.env.NODE_ENV !== "production";

  try {
    const fromMlMatch = pathname.match(/^\/api\/inbox\/(\d+)\/quotations\/from-ml-order$/);
    if (fromMlMatch && req.method === "POST") {
      const chatIdNum = Number(fromMlMatch[1]);
      if (!Number.isFinite(chatIdNum) || chatIdNum <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "chat_id inválido" });
        return true;
      }
      let bodyFromMl = {};
      try {
        bodyFromMl = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const companyIdRateFm =
        bodyFromMl.company_id != null && String(bodyFromMl.company_id).trim() !== ""
          ? Number(bodyFromMl.company_id)
          : 1;
      const cidRateFm =
        Number.isFinite(companyIdRateFm) && companyIdRateFm > 0 ? companyIdRateFm : 1;

      const { rows: chatRowsFm } = await pool.query(
        `SELECT id, customer_id FROM crm_chats WHERE id = $1 LIMIT 1`,
        [chatIdNum]
      );
      if (!chatRowsFm.length) {
        writeJson(res, 404, { error: "not_found", message: "Chat no encontrado" });
        return true;
      }
      const clienteIdFm =
        chatRowsFm[0].customer_id != null ? Number(chatRowsFm[0].customer_id) : NaN;
      if (!Number.isFinite(clienteIdFm) || clienteIdFm <= 0) {
        writeJson(res, 400, {
          error:   "no_customer",
          message: "Vinculá un cliente al chat antes de generar la cotización.",
        });
        return true;
      }

      const mlOrderIdFm = await resolveLinkedMlOrderId(pool, chatIdNum);
      if (mlOrderIdFm == null) {
        writeJson(res, 400, {
          error:   "no_ml_order",
          message: "No hay orden de Mercado Libre vinculada a este chat.",
        });
        return true;
      }

      let lookupKeyFm = String(mlOrderIdFm).trim();
      let { rows: orderRowsFm } = await pool.query(
        `SELECT order_id, raw_json FROM ml_orders WHERE order_id = $1 LIMIT 1`,
        [lookupKeyFm]
      );
      if (!orderRowsFm.length) {
        const altFm = await resolveExternalMlOrderIdFromSalesLink(pool, lookupKeyFm);
        if (altFm !== lookupKeyFm) {
          lookupKeyFm = altFm;
          const againFm = await pool.query(
            `SELECT order_id, raw_json FROM ml_orders WHERE order_id = $1 LIMIT 1`,
            [lookupKeyFm]
          );
          orderRowsFm = againFm.rows;
        }
      }
      if (!orderRowsFm.length || orderRowsFm[0].raw_json == null) {
        writeJson(res, 409, {
          error:   "order_not_synced",
          message:
            "La orden ML no está sincronizada en el servidor (sin detalle). Sincronizá órdenes e intentá de nuevo.",
        });
        return true;
      }

      let rateRowFm = null;
      try {
        rateRowFm = await getTodayRate(cidRateFm);
      } catch (_e) {
        rateRowFm = null;
      }

      const warnPctFm = (() => {
        const n = Number(process.env.ML_QUOTE_FROM_ML_PRICE_WARN_PCT);
        return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 2;
      })();

      const rawItemsFm = parseOrderItems(orderRowsFm[0].raw_json);
      if (!rawItemsFm.length) {
        writeJson(res, 422, {
          error:   "no_items",
          message: "La orden no tiene ítems en el JSON sincronizado.",
        });
        return true;
      }

      const warningsFm = [];
      const skippedFm = [];
      const linesFm = [];

      for (const it of rawItemsFm) {
        const prodSkuRow = await resolveProductSku(
          it.ml_item_id,
          it.variation_id,
          it.seller_sku
        );
        if (!prodSkuRow || !prodSkuRow.product_sku) {
          skippedFm.push({
            ml_item_id: it.ml_item_id,
            seller_sku: it.seller_sku,
            reason:       "product_not_mapped",
          });
          continue;
        }
        const productIdFm = await resolveActiveProductoIdFromMlSkuRow(prodSkuRow);
        if (!productIdFm) {
          skippedFm.push({
            ml_item_id: it.ml_item_id,
            seller_sku: it.seller_sku,
            reason:       "product_inactive_or_missing",
          });
          continue;
        }

        const qtyRaw = it.quantity != null ? Number(it.quantity) : NaN;
        const cantidadFm = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
        const curFm = it.currency_id ? String(it.currency_id).toUpperCase() : "";

        let itemForUsdFm = {};
        if (curFm === "VES") {
          const up = it.unit_price != null ? Number(it.unit_price) : NaN;
          if (!Number.isFinite(up) || up < 0) {
            skippedFm.push({ ml_item_id: it.ml_item_id, reason: "invalid_unit_price" });
            continue;
          }
          itemForUsdFm = { precio_unitario_bs: up };
          const binFm = rateRowFm ? Number(rateRowFm.binance_rate) : NaN;
          const catalogUsdFm =
            prodSkuRow.price_usd != null ? Number(prodSkuRow.price_usd) : NaN;
          if (Number.isFinite(binFm) && binFm > 0 && Number.isFinite(catalogUsdFm) && catalogUsdFm > 0) {
            const expectedBsFm = Math.round(catalogUsdFm * binFm * 100) / 100;
            const mlBsFm = up;
            if (expectedBsFm > 0 && Number.isFinite(mlBsFm)) {
              const diffPctFm = (Math.abs(mlBsFm - expectedBsFm) / expectedBsFm) * 100;
              if (diffPctFm > warnPctFm) {
                warningsFm.push({
                  code:                     "ml_price_vs_catalog_bs",
                  ml_item_id:               it.ml_item_id,
                  seller_sku:               it.seller_sku,
                  ml_unit_price_bs:         mlBsFm,
                  expected_from_catalog_bs: expectedBsFm,
                  diff_pct:                 Math.round(diffPctFm * 100) / 100,
                  binance_rate:             binFm,
                });
              }
            }
          }
        } else if (curFm === "USD" || curFm === "") {
          itemForUsdFm = { precio_unitario: Number(it.unit_price) };
        } else {
          warningsFm.push({
            code:        "currency_assumed_usd",
            ml_item_id:  it.ml_item_id,
            currency_id: curFm,
          });
          itemForUsdFm = { precio_unitario: Number(it.unit_price) };
        }

        const resolvedFm = resolveQuotationLineUnitUsd(itemForUsdFm, rateRowFm);
        if (resolvedFm.error) {
          skippedFm.push({
            ml_item_id: it.ml_item_id,
            reason:     resolvedFm.error,
            detail:     resolvedFm.detail || null,
          });
          continue;
        }
        const puFm = resolvedFm.pu;
        const subtotalFm = Math.round(cantidadFm * puFm * 100) / 100;
        linesFm.push({
          producto_id:      productIdFm,
          cantidad:         cantidadFm,
          precio_unitario:  puFm,
          subtotal:         subtotalFm,
        });
      }

      if (!linesFm.length) {
        writeJson(res, 422, {
          error:    "no_line_items",
          message:  "No se pudo armar ninguna línea: mapeá los productos o revisá precios/tasas.",
          skipped:  skippedFm,
          warnings: warningsFm,
        });
        return true;
      }

      const uniqFm = [...new Set(linesFm.map((L) => L.producto_id))];
      const chkFm = await pool.query(
        `SELECT id FROM products
         WHERE id = ANY($1::bigint[]) AND is_active = true`,
        [uniqFm]
      );
      if (chkFm.rows.length !== uniqFm.length) {
        writeJson(res, 400, {
          error:   "bad_request",
          message: "Uno o más productos no existen o no están activos.",
        });
        return true;
      }

      const totalFm = linesFm.reduce((acc, L) => acc + L.subtotal, 0);
      const observacionesFm = `Generada desde orden ML ${mlOrderIdFm}.`;
      const createdByBodyFm =
        bodyFromMl.created_by != null && bodyFromMl.created_by !== ""
          ? Number(bodyFromMl.created_by)
          : null;
      const uidFm = user.userId != null ? Number(user.userId) : NaN;
      const createdByFm =
        Number.isFinite(createdByBodyFm) && createdByBodyFm > 0
          ? createdByBodyFm
          : Number.isFinite(uidFm) && uidFm > 0
            ? uidFm
            : null;

      // Resolver sales_order_id para anclar la cotización a la transacción (cross-chat).
      const { rows: soRowsFm } = await pool.query(
        `SELECT id FROM sales_orders
         WHERE source = 'mercadolibre'
           AND (
             external_order_id = $1
             OR (external_order_id ~ '^[0-9]+-[0-9]+$' AND split_part(external_order_id, '-', 2) = $1)
           )
         ORDER BY id DESC LIMIT 1`,
        [String(lookupKeyFm)]
      );
      const salesOrderIdFm = soRowsFm.length ? Number(soRowsFm[0].id) : null;

      // Dedup: si ya existe cotización activa para esta sales_order, reutilizar.
      if (salesOrderIdFm != null) {
        const { rows: dupFmRows } = await pool.query(
          `SELECT id FROM inventario_presupuesto
           WHERE sales_order_id = $1
             AND status NOT IN ('converted','expired')
           ORDER BY fecha_creacion DESC LIMIT 1`,
          [salesOrderIdFm]
        );
        if (dupFmRows.length) {
          const dupFmId = Number(dupFmRows[0].id);
          const detDupFm = await pool.query(
            `SELECT id, cantidad, precio_unitario, subtotal, producto_id
             FROM inventario_detallepresupuesto WHERE presupuesto_id = $1 ORDER BY id`,
            [dupFmId]
          );
          const headDupFm = await pool.query(
            `SELECT id, fecha_creacion, fecha_vencimiento, total, status,
               cliente_id, chat_id, sales_order_id, channel_id, created_by, observaciones
             FROM inventario_presupuesto WHERE id = $1`,
            [dupFmId]
          );
          // Actualizar chat_id si no estaba enlazado aún.
          if (headDupFm.rows[0].chat_id == null && chatIdNum > 0) {
            await pool.query(
              `UPDATE inventario_presupuesto SET chat_id = $1, updated_at = NOW() WHERE id = $2`,
              [chatIdNum, dupFmId]
            );
            headDupFm.rows[0].chat_id = chatIdNum;
          }
          const hdFm = headDupFm.rows[0];
          writeJson(res, 200, {
            ok: true,
            reused: true,
            presupuesto: { ...hdFm, reference: buildReference(hdFm.channel_id, dupFmId) },
            items: detDupFm.rows,
            warnings: [],
            skipped: [],
          });
          return true;
        }
      }

      const channelIdFm = 3;
      let presupuestoIdFm;
      const clientFm = await pool.connect();
      try {
        await clientFm.query("BEGIN");
        presupuestoIdFm = await insertPresupuestoDraft(clientFm, {
          fechaVencimiento: null,
          total:            totalFm,
          observaciones:    observacionesFm,
          clienteId:        clienteIdFm,
          createdBy:        createdByFm,
          chatId:           chatIdNum,
          channelId:        channelIdFm,
          salesOrderId:     salesOrderIdFm,
          lines:            linesFm,
        });
        await clientFm.query("COMMIT");
      } catch (e) {
        await clientFm.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        clientFm.release();
      }

      const detFm = await pool.query(
        `SELECT id, cantidad, precio_unitario, subtotal, producto_id
         FROM inventario_detallepresupuesto
         WHERE presupuesto_id = $1
         ORDER BY id`,
        [presupuestoIdFm]
      );
      const headResFm = await pool.query(
        `SELECT id, fecha_creacion, fecha_vencimiento, total, status,
           cliente_id, chat_id, sales_order_id, channel_id, created_by, observaciones
         FROM inventario_presupuesto WHERE id = $1`,
        [presupuestoIdFm]
      );
      const headerFm = headResFm.rows[0];
      const referenceFm = buildReference(headerFm.channel_id, presupuestoIdFm);
      writeJson(res, 201, {
        ok:          true,
        reused:      false,
        presupuesto: { ...headerFm, reference: referenceFm },
        items:       detFm.rows,
        warnings:    warningsFm,
        skipped:     skippedFm,
      });
      return true;
    }

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
      let rateRow = null;
      try {
        rateRow = await getTodayRate(1);
      } catch (_e) {
        rateRow = null;
      }
      const msg = formatSendMessage(ip, reference, items, rateRow);
      const sentBy = String(user.userId != null ? user.userId : ip.created_by || "quotation-send");

      // Un solo mensaje WA: cotización + pago en Bs (evita duplicar datos de Pago Móvil en dos burbujas)
      let outbound = msg;
      try {
        const totalUsd = Number(ip.total ?? 0);
        const payMsg   = formatPaymentMessage(totalUsd, rateRow);
        outbound = `${msg}\n\n${payMsg}`;
      } catch (payErr) {
        logger.warn({ err: payErr }, "No se pudo anexar bloque de pago en Bs; se envía solo la cotización");
      }
      await sendChatMessage(ip.chat_id, outbound, sentBy, { skipThrottle: true });

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

      const companyIdRate =
        body.company_id != null && String(body.company_id).trim() !== ""
          ? Number(body.company_id)
          : 1;
      const cidRate = Number.isFinite(companyIdRate) && companyIdRate > 0 ? companyIdRate : 1;
      let rateRowQuote = null;
      try {
        rateRowQuote = await getTodayRate(cidRate);
      } catch (_e) {
        rateRowQuote = null;
      }

      const lines = [];
      const productIds = [];
      for (const it of itemsIn) {
        const pid = it.producto_id != null ? Number(it.producto_id) : NaN;
        const cantidad = it.cantidad != null ? Number(it.cantidad) : NaN;
        if (!Number.isFinite(pid) || pid <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "producto_id inválido en items" });
          return true;
        }
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "cantidad inválida en items" });
          return true;
        }
        const resolved = resolveQuotationLineUnitUsd(it, rateRowQuote);
        if (resolved.error) {
          writeJson(res, 400, {
            error:   "bad_request",
            message: resolved.error,
            detail:  resolved.detail || null,
          });
          return true;
        }
        const pu = resolved.pu;
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
        presupuestoId = await insertPresupuestoDraft(client, {
          fechaVencimiento,
          total,
          observaciones,
          clienteId,
          createdBy,
          chatId,
          channelId,
          lines,
        });
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

    // GET /api/inbox/quotations/presupuesto/:id — cabecera + líneas (detalle panel bandeja)
    const presupDetailMatch = pathname.match(/^\/api\/inbox\/quotations\/presupuesto\/(\d+)$/);
    if (presupDetailMatch && req.method === "GET") {
      const pid = Number(presupDetailMatch[1]);
      if (!Number.isFinite(pid) || pid <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "id de presupuesto inválido" });
        return true;
      }
      const headRes = await pool.query(
        `SELECT ip.id, ip.fecha_creacion, ip.fecha_vencimiento, ip.total, ip.status,
           ip.cliente_id, ip.chat_id, ip.channel_id, ip.created_by, ip.observaciones,
           ${sqlReferenceExpr("ip")} AS reference
         FROM inventario_presupuesto ip
         WHERE ip.id = $1`,
        [pid]
      );
      if (!headRes.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Cotización no encontrada" });
        return true;
      }
      const detRes = await pool.query(
        `SELECT d.id,
           d.producto_id,
           d.cantidad,
           d.precio_unitario,
           d.subtotal,
           p.sku,
           p.name,
           p.description,
           COALESCE(p.stock_qty, 0)::int AS stock_qty
         FROM inventario_detallepresupuesto d
         JOIN products p ON p.id = d.producto_id
         WHERE d.presupuesto_id = $1
         ORDER BY d.id ASC`,
        [pid]
      );
      writeJson(res, 200, {
        ok: true,
        presupuesto: headRes.rows[0],
        lines: detRes.rows,
      });
      return true;
    }

    // PATCH /api/inbox/quotations/presupuesto/:id/items — reemplazar líneas + total
    const presupPatchItemsMatch = pathname.match(/^\/api\/inbox\/quotations\/presupuesto\/(\d+)\/items$/);
    if (presupPatchItemsMatch && req.method === "PATCH") {
      const pid = Number(presupPatchItemsMatch[1]);
      if (!Number.isFinite(pid) || pid <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "id de presupuesto inválido" });
        return true;
      }
      let bodyPatch;
      try {
        bodyPatch = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const chatIdBody =
        bodyPatch.chat_id != null && bodyPatch.chat_id !== "" ? Number(bodyPatch.chat_id) : null;
      const itemsIn = Array.isArray(bodyPatch.items) ? bodyPatch.items : [];
      if (!itemsIn.length) {
        writeJson(res, 400, { error: "bad_request", message: "items no puede estar vacío" });
        return true;
      }

      if (await isQuotationPaymentLocked(pid)) {
        writeJson(res, 409, {
          error:   "payment_already_closed",
          message: "El pago está cerrado; no se puede editar la cotización.",
        });
        return true;
      }

      const { rows: curRows } = await pool.query(
        `SELECT id, chat_id, status, total::text AS total
         FROM inventario_presupuesto WHERE id = $1`,
        [pid]
      );
      if (!curRows.length) {
        writeJson(res, 404, { error: "not_found", message: "Cotización no encontrada" });
        return true;
      }
      const cur = curRows[0];
      const st = String(cur.status || "").toLowerCase();
      if (st === "converted" || st === "expired") {
        writeJson(res, 409, {
          error:   "invalid_status",
          message: "Esta cotización no admite edición de ítems.",
        });
        return true;
      }
      if (cur.chat_id != null && Number(cur.chat_id) > 0) {
        if (!Number.isFinite(chatIdBody) || chatIdBody <= 0 || Number(cur.chat_id) !== chatIdBody) {
          writeJson(res, 403, {
            error:   "forbidden",
            message: "chat_id no coincide con la cotización.",
          });
          return true;
        }
      }

      const companyIdRate =
        bodyPatch.company_id != null && String(bodyPatch.company_id).trim() !== ""
          ? Number(bodyPatch.company_id)
          : 1;
      const cidRate = Number.isFinite(companyIdRate) && companyIdRate > 0 ? companyIdRate : 1;
      let rateRowQuote = null;
      try {
        rateRowQuote = await getTodayRate(cidRate);
      } catch (_e) {
        rateRowQuote = null;
      }

      const lines = [];
      const productIds = [];
      for (const it of itemsIn) {
        const prId = it.producto_id != null ? Number(it.producto_id) : NaN;
        const cantidad = it.cantidad != null ? Number(it.cantidad) : NaN;
        if (!Number.isFinite(prId) || prId <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "producto_id inválido en items" });
          return true;
        }
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          writeJson(res, 400, { error: "bad_request", message: "cantidad inválida en items" });
          return true;
        }
        const resolved = resolveQuotationLineUnitUsd(it, rateRowQuote);
        if (resolved.error) {
          writeJson(res, 400, {
            error:   "bad_request",
            message: resolved.error,
            detail:  resolved.detail || null,
          });
          return true;
        }
        const pu = resolved.pu;
        const subtotal = Math.round(cantidad * pu * 100) / 100;
        productIds.push(prId);
        lines.push({ producto_id: prId, cantidad, precio_unitario: pu, subtotal });
      }

      const uniq = [...new Set(productIds)];
      const chk = await pool.query(
        `SELECT id, COALESCE(stock_qty, 0)::numeric AS stock_qty
         FROM products
         WHERE id = ANY($1::bigint[]) AND is_active = true`,
        [uniq]
      );
      if (chk.rows.length !== uniq.length) {
        writeJson(res, 400, {
          error:   "bad_request",
          message: "Uno o más productos no existen o no están activos.",
        });
        return true;
      }
      const stockById = new Map(chk.rows.map((r) => [Number(r.id), Number(r.stock_qty)]));
      for (const L of lines) {
        const sq = stockById.get(L.producto_id) ?? 0;
        if (L.cantidad > sq) {
          writeJson(res, 400, {
            error:   "bad_request",
            message: `Cantidad (${L.cantidad}) supera stock_qty (${sq}) para producto_id ${L.producto_id}.`,
          });
          return true;
        }
      }

      const previousTotal = Number(cur.total);
      const newTotal = lines.reduce((acc, L) => acc + L.subtotal, 0);
      const uidLog = user.userId != null ? Number(user.userId) : null;
      const itemsSnapshot = lines.map((L) => ({ ...L }));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM inventario_detallepresupuesto WHERE presupuesto_id = $1`, [pid]);
        for (const L of lines) {
          await client.query(
            `INSERT INTO inventario_detallepresupuesto (
               cantidad, precio_unitario, subtotal, producto_id, presupuesto_id
             ) VALUES ($1, $2, $3, $4, $5)`,
            [L.cantidad, L.precio_unitario, L.subtotal, L.producto_id, pid]
          );
        }
        await client.query(
          `UPDATE inventario_presupuesto SET total = $2, updated_at = NOW() WHERE id = $1`,
          [pid, newTotal]
        );
        try {
          await client.query(
            `INSERT INTO quotation_edit_log (
               presupuesto_id, user_id, previous_total, new_total, items_snapshot
             ) VALUES ($1, $2, $3::numeric, $4::numeric, $5::jsonb)`,
            [
              pid,
              Number.isFinite(uidLog) && uidLog > 0 ? uidLog : null,
              String(previousTotal),
              String(newTotal),
              JSON.stringify(itemsSnapshot),
            ]
          );
        } catch (logErr) {
          if (logErr && logErr.code !== "42P01") throw logErr;
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      const det = await pool.query(
        `SELECT d.id, d.cantidad, d.precio_unitario, d.subtotal, d.producto_id,
           p.sku, p.name, p.description,
           COALESCE(p.stock_qty, 0)::int AS stock_qty
         FROM inventario_detallepresupuesto d
         JOIN products p ON p.id = d.producto_id
         WHERE d.presupuesto_id = $1
         ORDER BY d.id ASC`,
        [pid]
      );
      const headAfter = await pool.query(
        `SELECT ip.id, ip.fecha_creacion, ip.fecha_vencimiento, ip.total, ip.status,
           ip.cliente_id, ip.chat_id, ip.channel_id, ip.created_by, ip.observaciones,
           ${sqlReferenceExpr("ip")} AS reference
         FROM inventario_presupuesto ip WHERE ip.id = $1`,
        [pid]
      );
      writeJson(res, 200, {
        ok: true,
        presupuesto: headAfter.rows[0],
        lines: det.rows,
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
      if (await isQuotationPaymentLocked(pId)) {
        writeJson(res, 409, {
          error:   "payment_locked",
          message: "El pago de esta cotización está totalmente conciliado; no se puede convertir manualmente desde aquí.",
        });
        return true;
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
      if (await isQuotationPaymentLocked(pId)) {
        writeJson(res, 409, {
          error:   "payment_locked",
          message: "El pago está totalmente conciliado; no se puede cambiar la etapa del embudo.",
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

    // ─── PATCH /api/inbox/quotations/:id/status ─────────────────────────────────
    // Cambia el status de una cotización enviada: sent ↔ approved | rejected.
    const statusMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/status$/);
    if (statusMatch && req.method === "PATCH") {
      const pId = Number(statusMatch[1]);
      let body;
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const VALID_STATUSES = [STATUS_SENT, STATUS_APPROVED, STATUS_REJECTED];
      const newStatus = body.status != null ? String(body.status).trim().toLowerCase() : "";
      if (!VALID_STATUSES.includes(newStatus)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `status inválido. Valores: ${VALID_STATUSES.join(", ")}`,
        }); return true;
      }
      const { rows: cur } = await pool.query(
        `SELECT id, status, channel_id FROM inventario_presupuesto WHERE id = $1`, [pId]
      );
      if (!cur.length) { writeJson(res, 404, { error: "not_found" }); return true; }
      if (await isQuotationPaymentLocked(pId)) {
        writeJson(res, 409, {
          error:   "payment_locked",
          message: "El pago está totalmente conciliado; no se puede cambiar el estado de la cotización.",
        });
        return true;
      }
      const allowedFrom = [STATUS_SENT, STATUS_APPROVED, STATUS_REJECTED];
      if (!allowedFrom.includes(cur[0].status)) {
        writeJson(res, 409, {
          error: "conflict",
          message: `No se puede cambiar el status de '${cur[0].status}'.`,
          current_status: cur[0].status,
        }); return true;
      }
      await pool.query(
        `UPDATE inventario_presupuesto SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, pId]
      );
      const ref = buildReference(cur[0].channel_id, pId);
      writeJson(res, 200, { ok: true, id: pId, reference: ref, status: newStatus });
      return true;
    }

    // ─── POST /api/inbox/quotations/:id/create-sales-order ────────────────────
    // Cotización canal 2 (WA/Redes) con comprobante ya conciliado → sales_orders CH-2.
    const createSoMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)\/create-sales-order$/);
    if (createSoMatch && req.method === "POST") {
      const pId = Number(createSoMatch[1]);
      if (!Number.isFinite(pId) || pId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "id inválido" });
        return true;
      }
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        body = {};
      }
      const bodyChat =
        body.chat_id != null && body.chat_id !== "" ? Number(body.chat_id) : NaN;

      let createOrderZoneId = null;
      if (body.zone_id != null && body.zone_id !== "") {
        const z = Number(body.zone_id);
        if (Number.isFinite(z) && z > 0) createOrderZoneId = z;
      }
      let createOrderDeliveryBs = undefined;
      if (body.delivery_client_price_bs != null && body.delivery_client_price_bs !== "") {
        const b = Number(body.delivery_client_price_bs);
        if (Number.isFinite(b) && b > 0) createOrderDeliveryBs = b;
      }
      if (createOrderDeliveryBs != null && createOrderZoneId == null) {
        writeJson(res, 400, {
          error: "bad_request",
          message: "delivery_client_price_bs requiere zone_id",
        });
        return true;
      }

      const uid = user.userId != null ? Number(user.userId) : null;
      const soldBy = String(user.username ?? user.email ?? user.userId ?? "crm");

      const { rows: ipr } = await pool.query(
        `SELECT id, status, channel_id, chat_id, cliente_id, total, observaciones
         FROM inventario_presupuesto WHERE id = $1`,
        [pId]
      );
      if (!ipr.length) {
        writeJson(res, 404, { error: "not_found", message: "Cotización no encontrada" });
        return true;
      }
      const ip = ipr[0];
      if (Number(ip.channel_id) !== 2) {
        writeJson(res, 422, {
          error: "unsupported_channel",
          message: "Solo cotizaciones canal WhatsApp/Redes (channel_id = 2).",
        });
        return true;
      }
      const st = String(ip.status || "").toLowerCase();
      if (!["sent", "approved"].includes(st)) {
        writeJson(res, 409, {
          error: "conflict",
          message: "La cotización debe estar enviada o aprobada.",
          status: ip.status,
        });
        return true;
      }
      if (ip.chat_id == null) {
        writeJson(res, 400, { error: "bad_request", message: "La cotización no tiene chat asociado." });
        return true;
      }
      if (Number.isFinite(bodyChat) && Number(ip.chat_id) !== bodyChat) {
        writeJson(res, 403, { error: "forbidden", message: "chat_id no coincide con la cotización." });
        return true;
      }
      if (ip.cliente_id == null) {
        writeJson(res, 400, { error: "bad_request", message: "La cotización no tiene cliente." });
        return true;
      }

      let paidOk = false;
      try {
        const stPay = await quotationPaymentSettlementService.getSettlementState(pId, null);
        paidOk = Boolean(stPay.fullySettled);
      } catch (e) {
        if (e && e.code === "42P01") {
          writeJson(res, 503, {
            error: "schema_missing",
            message:
              "Ejecutá sql/20260427_quotation_payment_allocations.sql (y 20260426_payment_attempts_reconciled_quotation.sql si falta).",
          });
          return true;
        }
        throw e;
      }
      if (!paidOk) {
        writeJson(res, 409, {
          error: "payment_not_verified",
          message:
            "El pago no está totalmente cerrado: imputaciones en Bs/USD deben cubrir el total y las piernas en USD deben estar aprobadas por caja.",
        });
        return true;
      }

      const extKey = `INV-PRESUP-${pId}`;
      const { rows: dupSo } = await pool.query(
        `SELECT id FROM sales_orders WHERE external_order_id = $1 LIMIT 1`,
        [extKey]
      );
      if (dupSo.length) {
        writeJson(res, 200, {
          ok: true,
          idempotent: true,
          sales_order_id: Number(dupSo[0].id),
          presupuesto_id: pId,
        });
        return true;
      }

      const { rows: lineRows } = await pool.query(
        `SELECT d.cantidad, d.precio_unitario, pr.sku
         FROM inventario_detallepresupuesto d
         INNER JOIN productos pr ON pr.id = d.producto_id
         WHERE d.presupuesto_id = $1
         ORDER BY d.id`,
        [pId]
      );
      if (!lineRows.length) {
        writeJson(res, 400, { error: "bad_request", message: "Cotización sin líneas." });
        return true;
      }

      const salesService = require("../services/salesService");
      let orderId;
      try {
        const created = await salesService.createOrder({
          source: "social_media",
          channelId: 2,
          customerId: Number(ip.cliente_id),
          items: lineRows.map((L) => ({
            sku: String(L.sku || "").trim(),
            quantity: Math.floor(Number(L.cantidad)),
            unit_price_usd: Number(L.precio_unitario),
          })),
          notes: `Desde cotización ${buildReference(ip.channel_id, pId)} (inventario_presupuesto id=${pId})`,
          soldBy,
          status: "paid",
          externalOrderId: extKey,
          paymentMethod: "pago_movil",
          conversationId: Number(ip.chat_id),
          zoneId: createOrderZoneId,
          deliveryClientPriceBs: createOrderDeliveryBs,
        });
        orderId = Number(created.id);
        if (!Number.isFinite(orderId) || orderId <= 0) {
          throw new Error("createOrder no devolvió id de orden");
        }
      } catch (e) {
        logger.error({ err: e.message, pId }, "create-sales-order: createOrder falló");
        const code = e && e.code ? String(e.code) : "";
        if (code === "NOT_FOUND" || (e.message && String(e.message).includes("SKU"))) {
          writeJson(res, 422, { error: "invalid_items", message: e.message || "Ítem inválido" });
          return true;
        }
        if (code === "INSUFFICIENT_STOCK") {
          writeJson(res, 409, { error: "insufficient_stock", message: e.message || "Stock insuficiente" });
          return true;
        }
        writeJson(res, 500, {
          error: "create_failed",
          message: isDev && e.message ? String(e.message) : "No se pudo crear la orden.",
        });
        return true;
      }

      await pool.query(
        `UPDATE sales_orders
         SET payment_status = 'approved', updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      );

      try {
        await pool.query(
          `UPDATE inventario_presupuesto
           SET status = 'converted',
               pipeline_stage = 'converted',
               conversion_document_id = $2,
               conversion_note = $3,
               converted_at = NOW(),
               converted_by = $4,
               updated_at = NOW()
           WHERE id = $1`,
          [pId, `SALES_ORDER_${orderId}`, `Orden ERP #${orderId} (CH-2 WA/Redes)`, uid]
        );
      } catch (convErr) {
        logger.warn({ err: convErr.message, orderId, pId }, "create-sales-order: marcar cotización convertida falló");
      }

      writeJson(res, 201, {
        ok: true,
        sales_order_id: orderId,
        presupuesto_id: pId,
        external_order_id: extKey,
      });
      return true;
    }

    // ─── GET /api/inbox/payment-attempts ──────────────────────────────────────
    // Devuelve comprobantes de pago sin conciliar (pending / no_match / manual_review)
    // para un chat o un cliente. Params: ?chat_id=X y/o ?customer_id=Y
    if (req.method === "GET" && pathname === "/api/inbox/payment-attempts") {
      const chatIdParam     = url.searchParams.get("chat_id");
      const customerIdParam = url.searchParams.get("customer_id");
      const chatIdNum     = chatIdParam     ? Number(chatIdParam)     : NaN;
      const customerIdNum = customerIdParam ? Number(customerIdParam) : NaN;
      if (!Number.isFinite(chatIdNum) && !Number.isFinite(customerIdNum)) {
        writeJson(res, 400, { error: "bad_request", message: "Se requiere chat_id o customer_id" });
        return true;
      }
      const conditions = [];
      const params = [];
      if (Number.isFinite(chatIdNum)) {
        params.push(chatIdNum);
        conditions.push(`pa.chat_id = $${params.length}`);
      }
      if (Number.isFinite(customerIdNum)) {
        params.push(customerIdNum);
        conditions.push(`pa.customer_id = $${params.length}`);
      }
      const where = conditions.length ? `(${conditions.join(" OR ")})` : "TRUE";
      let attempts;
      try {
        const r = await pool.query(
          `SELECT
             pa.id,
             pa.chat_id,
             pa.customer_id,
             pa.firebase_url,
             pa.extracted_reference,
             pa.extracted_amount_bs::text   AS extracted_amount_bs,
             pa.extracted_amount_usd::text  AS extracted_amount_usd,
             pa.extracted_date,
             pa.extracted_bank,
             pa.extracted_payment_type,
             pa.extraction_confidence::text AS extraction_confidence,
             pa.is_receipt,
             pa.prefiler_score::text        AS prefiler_score,
             pa.prefiler_reason,
             pa.reconciliation_status,
             pa.reconciled_order_id,
             pa.reconciled_quotation_id,
             pa.linked_bank_statement_id,
             pa.created_at
           FROM payment_attempts pa
           WHERE ${where}
             AND pa.reconciliation_status NOT IN ('matched', 'rejected')
           ORDER BY pa.created_at DESC
           LIMIT 50`,
          params
        );
        attempts = r.rows;
      } catch (e) {
        // Esquema antiguo: sin extracted_amount_usd y/o sin linked_bank_statement_id.
        // No repetir columnas que sigan ausentes (p. ej. linked_bank_statement_id — migración
        // sql/20260422_payment_attempts_linked_bank_statement.sql).
        if (e && e.code === "42703") {
          const r = await pool.query(
            `SELECT
               pa.id,
               pa.chat_id,
               pa.customer_id,
               pa.firebase_url,
               pa.extracted_reference,
               pa.extracted_amount_bs::text   AS extracted_amount_bs,
               pa.extracted_date,
               pa.extracted_bank,
               pa.extracted_payment_type,
               pa.extraction_confidence::text AS extraction_confidence,
               pa.is_receipt,
               pa.prefiler_score::text        AS prefiler_score,
               pa.prefiler_reason,
               pa.reconciliation_status,
               pa.reconciled_order_id,
               pa.reconciled_quotation_id,
               pa.created_at
             FROM payment_attempts pa
             WHERE ${where}
               AND pa.reconciliation_status NOT IN ('matched', 'rejected')
             ORDER BY pa.created_at DESC
             LIMIT 50`,
            params
          );
          attempts = r.rows.map((row) => ({
            ...row,
            extracted_amount_usd: null,
            linked_bank_statement_id: null,
          }));
        } else {
          throw e;
        }
      }
      writeJson(res, 200, { ok: true, items: attempts });
      return true;
    }

    // ─── POST /api/inbox/payment-attempts/:id/link-quotation ──────────────────
    // Vincula un comprobante de pago a una cotización (inventario_presupuesto).
    const paLinkMatch = pathname.match(/^\/api\/inbox\/payment-attempts\/(\d+)\/link-quotation$/);
    if (paLinkMatch && req.method === "POST") {
      const paId = Number(paLinkMatch[1]);
      let body;
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const quotationId = body.quotation_id != null ? Number(body.quotation_id) : NaN;
      if (!Number.isFinite(paId) || !Number.isFinite(quotationId)) {
        writeJson(res, 400, { error: "bad_request", message: "parámetros inválidos" });
        return true;
      }
      // Verificar que el comprobante exista y no esté ya conciliado
      let pa;
      try {
        const r = await pool.query(
          `SELECT id, reconciliation_status, extracted_amount_bs, extracted_amount_usd, extracted_date
             FROM payment_attempts WHERE id = $1`,
          [paId]
        );
        pa = r.rows;
      } catch (e) {
        if (e && e.code === "42703") {
          const r = await pool.query(
            `SELECT id, reconciliation_status, extracted_amount_bs, extracted_date
               FROM payment_attempts WHERE id = $1`,
            [paId]
          );
          pa = r.rows.map((row) => ({ ...row, extracted_amount_usd: null }));
        } else {
          throw e;
        }
      }
      if (!pa.length) { writeJson(res, 404, { error: "not_found", message: "Comprobante no encontrado" }); return true; }
      if (pa[0].reconciliation_status === "matched") {
        writeJson(res, 409, { error: "conflict", message: "El comprobante ya está conciliado" }); return true;
      }
      // Verificar que la cotización exista
      const { rows: cot } = await pool.query(
        `SELECT id, status, total, cliente_id, chat_id FROM inventario_presupuesto WHERE id = $1`,
        [quotationId]
      );
      if (!cot.length) { writeJson(res, 404, { error: "not_found", message: "Cotización no encontrada" }); return true; }

      if (await isQuotationPaymentLocked(quotationId)) {
        writeJson(res, 409, {
          error:   "payment_locked",
          message: "El pago ya está totalmente cerrado; no se puede vincular otro comprobante.",
        });
        return true;
      }

      const useAlloc = await quotationPaymentSettlementService.allocationTableExists(null).catch(() => false);
      const rawBs  = body.allocated_amount_bs != null ? Number(body.allocated_amount_bs) : NaN;
      const rawUsd = body.allocated_amount_usd != null ? Number(body.allocated_amount_usd) : NaN;
      const srcCur = body.source_currency != null ? String(body.source_currency).trim().toUpperCase() : "";

      let sourceCurrency = "VES";
      let amountOriginal = NaN;
      if (srcCur === "USD" || (Number.isFinite(rawUsd) && rawUsd > 0)) {
        sourceCurrency = "USD";
        amountOriginal = Number.isFinite(rawUsd) && rawUsd > 0
          ? rawUsd
          : Number(pa[0].extracted_amount_usd);
      } else {
        sourceCurrency = "VES";
        amountOriginal = Number.isFinite(rawBs) && rawBs > 0
          ? rawBs
          : Number(pa[0].extracted_amount_bs);
      }
      if (!Number.isFinite(amountOriginal) || amountOriginal <= 0) {
        writeJson(res, 400, {
          error:   "bad_request",
          message: "Indicá allocated_amount_bs o allocated_amount_usd (> 0), o que el comprobante tenga monto extraído.",
        });
        return true;
      }
      if (Number.isFinite(rawBs) && rawBs > 0 && Number.isFinite(rawUsd) && rawUsd > 0) {
        writeJson(res, 400, {
          error:   "bad_request",
          message: "En una sola solicitud imputá solo una moneda (Bs o USD).",
        });
        return true;
      }
      if (sourceCurrency === "VES") {
        const extBs = Number(pa[0].extracted_amount_bs);
        if (Number.isFinite(extBs) && extBs > 0 && amountOriginal > extBs + 0.01) {
          writeJson(res, 400, {
            error:   "bad_request",
            message: "El monto en Bs imputado no puede superar el del comprobante.",
          });
          return true;
        }
      } else {
        const extU = Number(pa[0].extracted_amount_usd);
        if (Number.isFinite(extU) && extU > 0 && amountOriginal > extU + 0.0001) {
          writeJson(res, 400, {
            error:   "bad_request",
            message: "El monto en USD imputado no puede superar el registrado en el comprobante.",
          });
          return true;
        }
      }

      if (useAlloc) {
        const { rows: dupA } = await pool.query(
          `SELECT 1 FROM quotation_payment_allocations
            WHERE payment_attempt_id = $1 AND quotation_id = $2 LIMIT 1`,
          [paId, quotationId]
        );
        if (dupA.length) {
          writeJson(res, 409, {
            error:   "conflict",
            message: "Este comprobante ya tiene una imputación a esa cotización.",
          });
          return true;
        }
      }

      const rateRow = await getTodayRate(1).catch(() => null);
      const rate =
        rateRow && Number(rateRow.active_rate) > 0 ? Number(rateRow.active_rate) : null;
      if (useAlloc && sourceCurrency === "VES" && !rate) {
        writeJson(res, 503, {
          error:   "rate_unavailable",
          message: "No hay tasa BCV/activa del día para convertir Bs a USD.",
        });
        return true;
      }

      const uid = user.userId != null ? Number(user.userId) : null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE payment_attempts
           SET reconciliation_status = 'matched',
               reconciled_order_id   = NULL,
               reconciled_quotation_id = $2,
               reconciled_at = COALESCE(reconciled_at, NOW()),
               updated_at            = NOW()
           WHERE id = $1`,
          [paId, quotationId]
        );
        if (useAlloc) {
          await quotationPaymentSettlementService.insertAllocation(client, {
            quotationId,
            paymentAttemptId: paId,
            sourceCurrency,
            amountOriginal,
            fxRateBsPerUsd: sourceCurrency === "VES" ? rate : null,
            userId:           uid,
          });
          await quotationPaymentSettlementService.assertAllocationTotalsWithinTolerance(client, quotationId);
        }
        try {
          await client.query(
            `INSERT INTO reconciliation_log
               (payment_attempt_id, source, match_level, confidence_score,
                amount_order_bs, amount_source_bs, amount_diff_bs, tolerance_used_bs,
                reference_matched, date_matched, status, matched_by, notes)
             VALUES ($1, 'payment_attempt', 'manual', 1.0,
                     $2, $2, 0, 0,
                     FALSE, FALSE, 'manual_match', $3, $4)`,
            [
              paId,
              sourceCurrency === "VES" ? amountOriginal : null,
              uid,
              `Vinculado manualmente a cotización #${quotationId} (${sourceCurrency} ${amountOriginal})`,
            ]
          );
        } catch (_logErr) { /* tabla opcional */ }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e && String(e.code) === "OVER_ALLOCATED") {
          writeJson(res, 409, {
            error:   "over_allocated",
            message: e.message || "La suma imputada supera el total de la cotización.",
          });
          return true;
        }
        if (e && e.code === "23505") {
          writeJson(res, 409, { error: "conflict", message: "Imputación duplicada." });
          return true;
        }
        if (e && e.code === "42P01") {
          writeJson(res, 503, {
            error:   "schema_missing",
            message: "Ejecutá sql/20260427_quotation_payment_allocations.sql en la base de datos.",
          });
          return true;
        }
        throw e;
      } finally {
        client.release();
      }
      const stAfter = await quotationPaymentSettlementService.getSettlementState(quotationId, null);
      writeJson(res, 200, {
        ok: true,
        payment_attempt_id: paId,
        quotation_id:       quotationId,
        status:               "matched",
        source_currency:      sourceCurrency,
        allocated_amount:     amountOriginal,
        payment_fully_settled: Boolean(stAfter.fullySettled),
      });
      return true;
    }

    // POST /api/inbox/quotations/from-sales-order — borrador desde sales_orders (sin chat obligatorio)
    if (req.method === "POST" && pathname === "/api/inbox/quotations/from-sales-order") {
      let bodySo = {};
      try { bodySo = await parseJsonBody(req); } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const soId = bodySo.sales_order_id != null ? Number(bodySo.sales_order_id) : NaN;
      if (!Number.isFinite(soId) || soId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "sales_order_id requerido" });
        return true;
      }
      const { rows: soRows } = await pool.query(
        `SELECT id, source, external_order_id, customer_id, conversation_id, ml_user_id
         FROM sales_orders WHERE id = $1 LIMIT 1`,
        [soId]
      );
      if (!soRows.length) {
        writeJson(res, 404, { error: "not_found", message: "Orden de venta no encontrada" });
        return true;
      }
      const so = soRows[0];
      const isMlSo = String(so.source || "").toLowerCase().includes("mercadolibre");
      if (!isMlSo) {
        writeJson(res, 400, {
          error: "not_ml_order",
          message: "Solo se puede generar cotización automática desde órdenes de Mercado Libre.",
        });
        return true;
      }
      const clienteIdSo = so.customer_id != null ? Number(so.customer_id) : NaN;
      if (!Number.isFinite(clienteIdSo) || clienteIdSo <= 0) {
        writeJson(res, 400, {
          error: "no_customer",
          message: "Esta orden no tiene cliente resuelto. Asociá un cliente antes de cotizar.",
        });
        return true;
      }

      // Extraer ID de orden ML de external_order_id (formato: <ml_user_id>-<order_id>)
      const extOid = String(so.external_order_id || "").trim();
      let mlOidSo = extOid;
      if (extOid.includes("-")) {
        const parts = extOid.split("-");
        mlOidSo = parts[parts.length - 1];
      }
      if (!mlOidSo) {
        writeJson(res, 400, { error: "bad_request", message: "No se pudo extraer ID de orden ML." });
        return true;
      }

      // Dedup limpio: cotización activa anclada a esta sales_order (cross-chat).
      const { rows: dupRowsSo } = await pool.query(
        `SELECT id FROM inventario_presupuesto
         WHERE sales_order_id = $1
           AND status NOT IN ('converted','expired')
         ORDER BY fecha_creacion DESC LIMIT 1`,
        [soId]
      );
      if (!dupRowsSo.length) {
        // Fallback: dedup por observaciones si el presupuesto fue creado antes de la migración.
        const obsPatternSo = `Generada desde orden ML ${mlOidSo}`;
        const { rows: dupFallbackSo } = await pool.query(
          `SELECT id FROM inventario_presupuesto
           WHERE cliente_id = $1
             AND observaciones LIKE $2
             AND sales_order_id IS NULL
             AND status NOT IN ('converted','expired')
           ORDER BY fecha_creacion DESC LIMIT 1`,
          [clienteIdSo, `%${obsPatternSo}%`]
        );
        if (dupFallbackSo.length) {
          dupRowsSo.push(dupFallbackSo[0]);
          // Retroalimentar sales_order_id en el presupuesto legado.
          await pool.query(
            `UPDATE inventario_presupuesto SET sales_order_id = $1, updated_at = NOW() WHERE id = $2`,
            [soId, Number(dupFallbackSo[0].id)]
          );
        }
      }
      if (dupRowsSo.length) {
        const dupId = Number(dupRowsSo[0].id);
        const detDup = await pool.query(
          `SELECT id, cantidad, precio_unitario, subtotal, producto_id
           FROM inventario_detallepresupuesto WHERE presupuesto_id = $1 ORDER BY id`,
          [dupId]
        );
        const headDup = await pool.query(
          `SELECT id, fecha_creacion, fecha_vencimiento, total, status,
             cliente_id, chat_id, sales_order_id, channel_id, created_by, observaciones
           FROM inventario_presupuesto WHERE id = $1`,
          [dupId]
        );
        const hd = headDup.rows[0];
        // Enlazar chat si la orden ya tiene conversation_id y el presupuesto aún no tiene chat.
        if (hd.chat_id == null && so.conversation_id != null) {
          await pool.query(
            `UPDATE inventario_presupuesto SET chat_id = $1, updated_at = NOW() WHERE id = $2`,
            [Number(so.conversation_id), dupId]
          );
          hd.chat_id = Number(so.conversation_id);
        }
        writeJson(res, 200, {
          ok: true,
          reused: true,
          presupuesto: { ...hd, reference: buildReference(hd.channel_id, dupId) },
          items: detDup.rows,
          warnings: [],
          skipped: [],
        });
        return true;
      }

      // Buscar orden en ml_orders
      const { rows: mlOrderRowsSo } = await pool.query(
        `SELECT order_id, raw_json FROM ml_orders WHERE order_id = $1 LIMIT 1`,
        [mlOidSo]
      );
      if (!mlOrderRowsSo.length || mlOrderRowsSo[0].raw_json == null) {
        writeJson(res, 409, {
          error: "order_not_synced",
          message: "La orden ML no está sincronizada. Sincronizá órdenes e intentá de nuevo.",
        });
        return true;
      }

      const cidRateSo = (() => {
        const c = bodySo.company_id != null ? Number(bodySo.company_id) : 1;
        return Number.isFinite(c) && c > 0 ? c : 1;
      })();
      let rateRowSo = null;
      try { rateRowSo = await getTodayRate(cidRateSo); } catch (_e) { rateRowSo = null; }

      const warnPctSo = (() => {
        const n = Number(process.env.ML_QUOTE_FROM_ML_PRICE_WARN_PCT);
        return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 2;
      })();

      const rawItemsSo = parseOrderItems(mlOrderRowsSo[0].raw_json);
      if (!rawItemsSo.length) {
        writeJson(res, 422, { error: "no_items", message: "La orden no tiene ítems en el JSON sincronizado." });
        return true;
      }

      const warningsSo = []; const skippedSo = []; const linesSo = [];
      for (const it of rawItemsSo) {
        const prodSkuRowSo = await resolveProductSku(it.ml_item_id, it.variation_id, it.seller_sku);
        if (!prodSkuRowSo || !prodSkuRowSo.product_sku) {
          skippedSo.push({ ml_item_id: it.ml_item_id, seller_sku: it.seller_sku, reason: "product_not_mapped" });
          continue;
        }
        const productIdSo = await resolveActiveProductoIdFromMlSkuRow(prodSkuRowSo);
        if (!productIdSo) {
          skippedSo.push({ ml_item_id: it.ml_item_id, seller_sku: it.seller_sku, reason: "product_inactive_or_missing" });
          continue;
        }
        const qtyRawSo = it.quantity != null ? Number(it.quantity) : NaN;
        const cantidadSo = Number.isFinite(qtyRawSo) && qtyRawSo > 0 ? qtyRawSo : 1;
        const curSo = it.currency_id ? String(it.currency_id).toUpperCase() : "";
        let itemForUsdSo = {};
        if (curSo === "VES") {
          const up = it.unit_price != null ? Number(it.unit_price) : NaN;
          if (!Number.isFinite(up) || up < 0) { skippedSo.push({ ml_item_id: it.ml_item_id, reason: "invalid_unit_price" }); continue; }
          itemForUsdSo = { precio_unitario_bs: up };
          const binSo = rateRowSo ? Number(rateRowSo.binance_rate) : NaN;
          const catalogUsdSo = prodSkuRowSo.price_usd != null ? Number(prodSkuRowSo.price_usd) : NaN;
          if (Number.isFinite(binSo) && binSo > 0 && Number.isFinite(catalogUsdSo) && catalogUsdSo > 0) {
            const expectedBsSo = Math.round(catalogUsdSo * binSo * 100) / 100;
            if (expectedBsSo > 0) {
              const diffPctSo = (Math.abs(up - expectedBsSo) / expectedBsSo) * 100;
              if (diffPctSo > warnPctSo) {
                warningsSo.push({ code: "ml_price_vs_catalog_bs", ml_item_id: it.ml_item_id, seller_sku: it.seller_sku,
                  ml_unit_price_bs: up, expected_from_catalog_bs: expectedBsSo,
                  diff_pct: Math.round(diffPctSo * 100) / 100, binance_rate: binSo });
              }
            }
          }
        } else if (curSo === "USD" || curSo === "") {
          itemForUsdSo = { precio_unitario: Number(it.unit_price) };
        } else {
          warningsSo.push({ code: "currency_assumed_usd", ml_item_id: it.ml_item_id, currency_id: curSo });
          itemForUsdSo = { precio_unitario: Number(it.unit_price) };
        }
        const resolvedSo = resolveQuotationLineUnitUsd(itemForUsdSo, rateRowSo);
        if (resolvedSo.error) { skippedSo.push({ ml_item_id: it.ml_item_id, reason: resolvedSo.error }); continue; }
        const puSo = resolvedSo.pu;
        linesSo.push({ producto_id: productIdSo, cantidad: cantidadSo, precio_unitario: puSo, subtotal: Math.round(cantidadSo * puSo * 100) / 100 });
      }

      if (!linesSo.length) {
        writeJson(res, 422, { error: "no_line_items", message: "No se pudo armar ninguna línea.", skipped: skippedSo, warnings: warningsSo });
        return true;
      }

      const uniqSo = [...new Set(linesSo.map((L) => L.producto_id))];
      const chkSo = await pool.query(`SELECT id FROM products WHERE id = ANY($1::bigint[]) AND is_active = true`, [uniqSo]);
      if (chkSo.rows.length !== uniqSo.length) {
        writeJson(res, 400, { error: "bad_request", message: "Uno o más productos no están activos." });
        return true;
      }

      const totalSo = linesSo.reduce((acc, L) => acc + L.subtotal, 0);
      const uidSo = user.userId != null ? Number(user.userId) : null;
      // chat_id desde conversation_id de la orden (fusión automática con Bandeja si ya existe).
      const chatIdSo = so.conversation_id != null ? Number(so.conversation_id) : null;
      const channelIdSo = chatIdSo != null ? 3 : (bodySo.channel_id != null ? Number(bodySo.channel_id) : null);

      let presupuestoIdSo;
      const clientSo = await pool.connect();
      try {
        await clientSo.query("BEGIN");
        presupuestoIdSo = await insertPresupuestoDraft(clientSo, {
          fechaVencimiento: null,
          total: totalSo,
          observaciones: `Generada desde orden ML ${mlOidSo}.`,
          clienteId: clienteIdSo,
          createdBy: Number.isFinite(uidSo) && uidSo > 0 ? uidSo : null,
          chatId: chatIdSo,
          channelId: channelIdSo,
          salesOrderId: soId,
          lines: linesSo,
        });
        await clientSo.query("COMMIT");
      } catch (e) {
        await clientSo.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        clientSo.release();
      }

      const detSo = await pool.query(
        `SELECT id, cantidad, precio_unitario, subtotal, producto_id
         FROM inventario_detallepresupuesto WHERE presupuesto_id = $1 ORDER BY id`,
        [presupuestoIdSo]
      );
      const headSo = await pool.query(
        `SELECT id, fecha_creacion, fecha_vencimiento, total, status,
           cliente_id, chat_id, sales_order_id, channel_id, created_by, observaciones
         FROM inventario_presupuesto WHERE id = $1`,
        [presupuestoIdSo]
      );
      const headerSo = headSo.rows[0];
      writeJson(res, 201, {
        ok: true,
        reused: false,
        presupuesto: { ...headerSo, reference: buildReference(headerSo.channel_id, presupuestoIdSo) },
        items: detSo.rows,
        warnings: warningsSo,
        skipped: skippedSo,
      });
      return true;
    }

    // GET /api/inbox/quotations — listado global paginado (antes de /:chatId)
    if (req.method === "GET" && pathname === "/api/inbox/quotations") {
      await handleListQuotations(res, url);
      return true;
    }

    // GET /api/inbox/quotations/by-sales-order/:salesOrderId — cotización activa por transacción (cross-chat)
    const bySoMatch = pathname.match(/^\/api\/inbox\/quotations\/by-sales-order\/(\d+)$/);
    if (bySoMatch && req.method === "GET") {
      const soIdBs = Number(bySoMatch[1]);
      if (!Number.isFinite(soIdBs) || soIdBs <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "sales_order_id inválido" });
        return true;
      }
      const { rows: rawBsRows } = await pool.query(
        `SELECT ip.id, ip.total, ip.status, ip.fecha_vencimiento, ip.channel_id,
           ip.sales_order_id, ip.chat_id,
           ${sqlReferenceExpr("ip")} AS reference,
           (
             SELECT so2.id FROM sales_orders so2
             WHERE so2.external_order_id = ('INV-PRESUP-' || ip.id::text)
             LIMIT 1
           ) AS linked_sales_order_id
         FROM inventario_presupuesto ip
         WHERE ip.sales_order_id = $1
           AND ip.status NOT IN ('converted', 'expired')
         ORDER BY ip.fecha_creacion DESC
         LIMIT 5`,
        [soIdBs]
      );
      const bsItems = [];
      for (const r of rawBsRows) {
        const st = await quotationPaymentSettlementService.getSettlementState(Number(r.id), null);
        bsItems.push({
          id:                       r.id,
          total:                    r.total,
          status:                   r.status,
          fecha_vencimiento:        r.fecha_vencimiento,
          channel_id:               r.channel_id,
          reference:                r.reference,
          sales_order_id:           r.sales_order_id,
          chat_id:                  r.chat_id,
          linked_sales_order_id:    r.linked_sales_order_id,
          payment_verified:         Boolean(st.anyPaymentProgress),
          payment_fully_settled:    Boolean(st.fullySettled),
          payment_covered_usd_eq:   st.coveredUsdEquivalent,
          payment_total_usd:        st.totalUsd,
          payment_pending_usd_caja: Boolean(st.hasPendingUsdCaja),
          payment_has_bs_baseline:  Boolean(st.hasBsReconciledBaseline),
        });
      }
      writeJson(res, 200, { items: bsItems });
      return true;
    }

    // GET /api/inbox/quotations/:chatId — cotizaciones activas de un chat (+ cross-chat por sales_order_id)
    const listMatch = pathname.match(/^\/api\/inbox\/quotations\/(\d+)$/);
    if (listMatch && req.method === "GET") {
      const chatId = Number(listMatch[1]);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "chatId inválido" });
        return true;
      }
      // Busca cotizaciones directas del chat Y las ancladas a la sales_order cuya conversation_id es este chat.
      const { rows: rawRows } = await pool.query(
        `SELECT ip.id, ip.total, ip.status, ip.fecha_vencimiento, ip.channel_id,
           ip.sales_order_id, ip.chat_id,
           ${sqlReferenceExpr("ip")} AS reference,
           (
             SELECT so.id FROM sales_orders so
             WHERE so.external_order_id = ('INV-PRESUP-' || ip.id::text)
             LIMIT 1
           ) AS linked_sales_order_id
         FROM inventario_presupuesto ip
         WHERE (
           ip.chat_id = $1
           OR ip.sales_order_id IN (
             SELECT id FROM sales_orders WHERE conversation_id = $1
           )
         )
           AND ip.status NOT IN ('converted', 'expired')
         ORDER BY ip.fecha_creacion DESC
         LIMIT 5`,
        [chatId]
      );
      const rows = [];
      for (const r of rawRows) {
        const st = await quotationPaymentSettlementService.getSettlementState(Number(r.id), null);
        rows.push({
          id:                       r.id,
          total:                    r.total,
          status:                   r.status,
          fecha_vencimiento:        r.fecha_vencimiento,
          channel_id:               r.channel_id,
          reference:                r.reference,
          sales_order_id:           r.sales_order_id,
          chat_id:                  r.chat_id,
          linked_sales_order_id:    r.linked_sales_order_id,
          payment_verified:         Boolean(st.anyPaymentProgress),
          payment_fully_settled:    Boolean(st.fullySettled),
          payment_covered_usd_eq:   st.coveredUsdEquivalent,
          payment_total_usd:        st.totalUsd,
          payment_pending_usd_caja: Boolean(st.hasPendingUsdCaja),
          payment_has_bs_baseline:  Boolean(st.hasBsReconciledBaseline),
        });
      }
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
