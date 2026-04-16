"use strict";

/**
 * Endpoints de numeración fiscal venezolana.
 * Documentos: FACTURA · NOTA_DEBITO · NOTA_CREDITO · COMPROBANTE_RETENCION
 * Formato control: 00-XXXXXXXX  Formato doc: FAC-XXXXXXXX etc.
 *
 * GET    /api/fiscal/documents                 → listDocuments
 * GET    /api/fiscal/documents/:id             → getDocument
 * POST   /api/fiscal/documents/invoice         → issueInvoice
 * POST   /api/fiscal/documents/credit-note     → issueCreditNote
 * POST   /api/fiscal/documents/debit-note      → issueDebitNote
 * POST   /api/fiscal/documents/retention       → issueRetentionCertificate
 * PATCH  /api/fiscal/documents/:id/confirm     → confirmExternalNumber
 * POST   /api/fiscal/documents/:id/cancel      → cancelDocument
 * GET    /api/fiscal/libro-ventas/:year/:month → getLibroVentasTotales
 * GET    /api/fiscal/sequences                 → getSequences
 * PATCH  /api/fiscal/sequences/:id             → updateSequence (X-Confirm: reset-sequence)
 * GET    /api/fiscal/numbering-panel           → HTML de pruebas
 */

const {
  issueInvoice,
  issueCreditNote,
  issueDebitNote,
  issueRetentionCertificate,
  cancelDocument,
  confirmExternalNumber,
  getDocument,
  listDocuments,
  getLibroVentasTotales,
  getSequences,
  updateSequence,
} = require("../services/fiscalNumberingService");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { rejectDuringDowntime } = require("../utils/sessionGuard");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 2 * 1024 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function schemaMissing(res, e) {
  const msg = (e && e.message) || String(e);
  if (
    e &&
    (e.code === "42P01" ||
      /fiscal_documents/.test(msg) ||
      /fiscal_sequences/.test(msg) ||
      /next_fiscal_number/.test(msg) ||
      /issue_fiscal_document/.test(msg) ||
      /cancel_fiscal_document/.test(msg) ||
      /fiscal_doc_type/.test(msg) ||
      /fiscal_doc_status/.test(msg))
  ) {
    writeJson(res, 503, {
      ok: false,
      error: "Esquema de numeración fiscal no migrado. Ejecutar: npm run db:fiscal-numbering",
      code: "SCHEMA_MISSING",
    });
    return true;
  }
  return false;
}

function handleError(res, e) {
  if (schemaMissing(res, e)) return;
  if (e instanceof SyntaxError) {
    writeJson(res, 400, { ok: false, error: "invalid_json" });
    return;
  }
  if (e && e.message === "body_too_large") {
    writeJson(res, 413, { ok: false, error: "body_too_large" });
    return;
  }
  const status = e && e.status ? Number(e.status) : 500;
  const code = (e && e.code) || undefined;
  if (status >= 400 && status < 500) {
    writeJson(res, status, { ok: false, error: e.message || String(e), code });
    return;
  }
  // Errores de PG function (RAISE EXCEPTION)
  const msg = (e && e.message) || String(e);
  if (/ya está anulado|already cancelled/i.test(msg) || /CANT_CANCEL/i.test(msg)) {
    writeJson(res, 422, { ok: false, error: msg, code: "ALREADY_CANCELLED" });
    return;
  }
  if (/DRAFT/i.test(msg) && /no.*anuld|borradores/i.test(msg)) {
    writeJson(res, 422, { ok: false, error: msg, code: "CANT_CANCEL_DRAFT" });
    return;
  }
  if (/Talonario agotado/i.test(msg)) {
    writeJson(res, 503, { ok: false, error: msg, code: "SEQUENCE_EXHAUSTED" });
    return;
  }
  if (/No hay secuencia activa/i.test(msg)) {
    writeJson(res, 503, { ok: false, error: msg, code: "NO_ACTIVE_SEQUENCE" });
    return;
  }
  console.error("[fiscal-numbering]", e);
  writeJson(res, 500, { ok: false, error: msg });
}

const COMPANY_ID = 1;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleFiscalDocumentsRequest(req, res, url) {
  const path = (url.pathname || "").replace(/\/+$/, "") || "/";

  // ── Panel HTML de pruebas ─────────────────────────────────────────────
  if (req.method === "GET" && path === "/api/fiscal/numbering-panel") {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=utf-8><p>Define ADMIN_SECRET.</p>");
      return true;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=utf-8><p>Acceso denegado. Usá <code>?k=TU_SECRETO</code>.</p>");
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Numeración Fiscal</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px}
pre{background:#1e293b;color:#e2e8f0;padding:1rem;border-radius:.5rem;overflow:auto;font-size:.83rem}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.75rem;font-weight:700}
.issued{background:#f0fdf4;color:#15803d}.draft{background:#fffbeb;color:#b45309}
.cancelled{background:#fef2f2;color:#b91c1c}h2{margin-top:1.5rem;font-size:1rem}
button{padding:.4rem 1rem;background:#c2281a;color:#fff;border:none;border-radius:.4rem;cursor:pointer;font-size:.85rem;font-weight:600}
</style></head>
<body>
<h1>&#127481;&#127487; Numeración Fiscal Venezolana</h1>
<p>Todos los endpoints requieren <code>X-Admin-Secret</code> o <code>?k=</code>.</p>

<h2>Ver secuencias</h2>
<pre id="seq">Cargando…</pre>

<h2>Emitir factura de prueba (base 100 USD)</h2>
<button onclick="emitirFactura()">Emitir FAC</button>
<pre id="fac">—</pre>

<h2>Ver documentos emitidos</h2>
<a href="/api/fiscal/documents?k=${encodeURIComponent(k)}" target="_blank">/api/fiscal/documents</a>

<h2>Libro de ventas mes actual</h2>
<pre id="libro">—</pre>
<button onclick="loadLibro()">Cargar</button>

<script>
const K = ${JSON.stringify(k)};
const h = {'X-Admin-Secret': K, 'Content-Type': 'application/json'};
async function get(url){ const r=await fetch(url,{headers:h}); return r.json(); }
async function post(url,b){ const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(b)}); return r.json(); }

async function loadSeq(){
  const d=await get('/api/fiscal/sequences?k='+encodeURIComponent(K));
  document.getElementById('seq').textContent=JSON.stringify(d,null,2);
}
loadSeq();

async function emitirFactura(){
  const d=await post('/api/fiscal/documents/invoice',{
    receptor_rif:'J-12345678-9',receptor_name:'Cliente Test C.A.',
    receptor_address:'Caracas, Venezuela',base_imponible_usd:100,igtf_usd:0
  });
  document.getElementById('fac').textContent=JSON.stringify(d,null,2);
  loadSeq();
}

async function loadLibro(){
  const now=new Date();
  const d=await get('/api/fiscal/libro-ventas/'+now.getFullYear()+'/'+(now.getMonth()+1)+'?k='+encodeURIComponent(K));
  document.getElementById('libro').textContent=JSON.stringify(d,null,2);
}
</script>
</body></html>`);
    return true;
  }

  // Solo manejar rutas bajo /api/fiscal/documents, /api/fiscal/libro-ventas, /api/fiscal/sequences
  if (
    !path.startsWith("/api/fiscal/documents") &&
    !path.startsWith("/api/fiscal/libro-ventas") &&
    !path.startsWith("/api/fiscal/sequences")
  ) {
    return false;
  }

  try {
    // ── GET /api/fiscal/documents ─────────────────────────────────────
    if (req.method === "GET" && path === "/api/fiscal/documents") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const result = await listDocuments({
        companyId: COMPANY_ID,
        docType: url.searchParams.get("doc_type") || url.searchParams.get("docType"),
        status: url.searchParams.get("status"),
        periodId: url.searchParams.get("period_id") || url.searchParams.get("periodId"),
        receptorRif: url.searchParams.get("receptor_rif") || url.searchParams.get("receptorRif"),
        dateFrom: url.searchParams.get("date_from") || url.searchParams.get("dateFrom"),
        dateTo: url.searchParams.get("date_to") || url.searchParams.get("dateTo"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      writeJson(res, 200, { ok: true, ...result });
      return true;
    }

    // ── GET /api/fiscal/documents/:id ────────────────────────────────
    const getOneM = req.method === "GET" && path.match(/^\/api\/fiscal\/documents\/(\d+)$/);
    if (getOneM) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const doc = await getDocument(getOneM[1]);
      if (!doc) {
        writeJson(res, 404, { ok: false, error: "Documento no encontrado" });
        return true;
      }
      writeJson(res, 200, { ok: true, document: doc });
      return true;
    }

    // ── POST /api/fiscal/documents/invoice ───────────────────────────
    if (req.method === "POST" && path === "/api/fiscal/documents/invoice") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      if (!body.base_imponible_usd && body.base_imponible_usd !== 0) {
        writeJson(res, 400, { ok: false, error: "base_imponible_usd requerido" });
        return true;
      }
      const base = Number(body.base_imponible_usd);
      if (!Number.isFinite(base) || base <= 0) {
        writeJson(res, 400, { ok: false, error: "base_imponible_usd debe ser > 0" });
        return true;
      }
      const doc = await issueInvoice({
        companyId: COMPANY_ID,
        saleId: body.sale_id,
        issueDate: body.issue_date || todayStr(),
        receptorRif: body.receptor_rif,
        receptorName: body.receptor_name,
        receptorAddress: body.receptor_address,
        baseImponibleUsd: base,
        igtfUsd: Number(body.igtf_usd) || 0,
        notes: body.notes || null,
      });
      writeJson(res, 201, { ok: true, document: doc });
      return true;
    }

    // ── POST /api/fiscal/documents/credit-note ───────────────────────
    if (req.method === "POST" && path === "/api/fiscal/documents/credit-note") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      if (!body.related_doc_id) {
        writeJson(res, 400, { ok: false, error: "related_doc_id requerido" });
        return true;
      }
      if (!body.reason || !String(body.reason).trim()) {
        writeJson(res, 400, { ok: false, error: "reason requerido para nota de crédito" });
        return true;
      }
      const doc = await issueCreditNote({
        companyId: COMPANY_ID,
        relatedDocId: body.related_doc_id,
        receptorRif: body.receptor_rif,
        receptorName: body.receptor_name,
        receptorAddress: body.receptor_address,
        baseImponibleUsd: body.base_imponible_usd,
        reason: body.reason,
        notes: body.notes || null,
      });
      writeJson(res, 201, { ok: true, document: doc });
      return true;
    }

    // ── POST /api/fiscal/documents/debit-note ────────────────────────
    if (req.method === "POST" && path === "/api/fiscal/documents/debit-note") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      if (!body.related_doc_id) {
        writeJson(res, 400, { ok: false, error: "related_doc_id requerido" });
        return true;
      }
      if (!body.reason || !String(body.reason).trim()) {
        writeJson(res, 400, { ok: false, error: "reason requerido para nota de débito" });
        return true;
      }
      const doc = await issueDebitNote({
        companyId: COMPANY_ID,
        relatedDocId: body.related_doc_id,
        receptorRif: body.receptor_rif,
        receptorName: body.receptor_name,
        receptorAddress: body.receptor_address,
        baseImponibleUsd: body.base_imponible_usd,
        reason: body.reason,
        notes: body.notes || null,
      });
      writeJson(res, 201, { ok: true, document: doc });
      return true;
    }

    // ── POST /api/fiscal/documents/retention ─────────────────────────
    if (req.method === "POST" && path === "/api/fiscal/documents/retention") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      const doc = await issueRetentionCertificate({
        companyId: COMPANY_ID,
        retentionId: body.retention_id,
        counterpartRif: body.counterpart_rif,
        counterpartName: body.counterpart_name,
        counterpartAddress: body.counterpart_address,
        baseImponibleUsd: body.base_imponible_usd,
        retentionAmountUsd: body.retention_amount_usd,
        notes: body.notes || null,
      });
      writeJson(res, 201, { ok: true, document: doc });
      return true;
    }

    // ── PATCH /api/fiscal/documents/:id/confirm ───────────────────────
    const confirmM = req.method === "PATCH" && path.match(/^\/api\/fiscal\/documents\/(\d+)\/confirm$/);
    if (confirmM) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      const extNum = String(body.external_number || "").trim();
      if (!extNum) {
        writeJson(res, 400, { ok: false, error: "external_number requerido" });
        return true;
      }
      const doc = await confirmExternalNumber({
        docId: confirmM[1],
        externalNumber: extNum,
      });
      writeJson(res, 200, { ok: true, document: doc });
      return true;
    }

    // ── POST /api/fiscal/documents/:id/cancel ─────────────────────────
    const cancelM = req.method === "POST" && path.match(/^\/api\/fiscal\/documents\/(\d+)\/cancel$/);
    if (cancelM) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      const reason = String(body.reason || "").trim();
      if (!reason) {
        writeJson(res, 400, { ok: false, error: "reason requerido para anular" });
        return true;
      }
      const doc = await cancelDocument({
        docId: cancelM[1],
        userId: body.user_id != null ? body.user_id : null,
        reason,
      });
      writeJson(res, 200, { ok: true, document: doc });
      return true;
    }

    // ── GET /api/fiscal/libro-ventas/:year/:month ─────────────────────
    const libroM = req.method === "GET" && path.match(/^\/api\/fiscal\/libro-ventas\/(\d{4})\/(\d{1,2})$/);
    if (libroM) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const totales = await getLibroVentasTotales({
        companyId: COMPANY_ID,
        year: Number(libroM[1]),
        month: Number(libroM[2]),
      });
      writeJson(res, 200, { ok: true, data: totales });
      return true;
    }

    // ── GET /api/fiscal/sequences ─────────────────────────────────────
    if (req.method === "GET" && path === "/api/fiscal/sequences") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const seqs = await getSequences(COMPANY_ID);
      writeJson(res, 200, { ok: true, sequences: seqs });
      return true;
    }

    // ── PATCH /api/fiscal/sequences/:id ──────────────────────────────
    const seqM = req.method === "PATCH" && path.match(/^\/api\/fiscal\/sequences\/(\d+)$/);
    if (seqM) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;

      // Constraint 5: OBLIGATORIO el header X-Confirm: reset-sequence
      const confirmHeader = req.headers["x-confirm"];
      if (!confirmHeader || String(confirmHeader).trim() !== "reset-sequence") {
        writeJson(res, 400, {
          ok: false,
          error:
            "Operación peligrosa. Requiere cabecera: X-Confirm: reset-sequence (resetea el correlativo a 0).",
          code: "CONFIRM_REQUIRED",
        });
        return true;
      }

      const body = await parseJsonBody(req);
      if (!body.control_prefix || !String(body.control_prefix).trim()) {
        writeJson(res, 400, { ok: false, error: "control_prefix requerido" });
        return true;
      }
      if (!body.serie || !String(body.serie).trim()) {
        writeJson(res, 400, { ok: false, error: "serie requerida" });
        return true;
      }

      const seq = await updateSequence({
        sequenceId: seqM[1],
        controlPrefix: String(body.control_prefix).trim(),
        serie: String(body.serie).trim().toUpperCase(),
        companyId: COMPANY_ID,
      });
      writeJson(res, 200, { ok: true, sequence: seq });
      return true;
    }
  } catch (e) {
    handleError(res, e);
    return true;
  }

  return false;
}

module.exports = { handleFiscalDocumentsRequest };
