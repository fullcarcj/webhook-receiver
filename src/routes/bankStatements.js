"use strict";

const {
  ensureAdmin,
  writeJson,
  ensureAdminHtml,
  escapeHtml,
} = require("./bankBanesco");
const {
  listBankStatements,
  RECONCILIATION_STATUSES,
} = require("../services/bankStatementsService");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @returns {{ ok: true, params: object } | { ok: false, status: number, body: object }}
 */
function parseStatementQueryParams(url) {
  const sp = url.searchParams;
  let bankAccountId = null;
  const rawAcc = sp.get("bank_account_id");
  if (rawAcc != null && String(rawAcc).trim() !== "") {
    const x = parseInt(String(rawAcc).trim(), 10);
    if (!Number.isFinite(x) || x < 1) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: "invalid_bank_account_id" },
      };
    }
    bankAccountId = x;
  }

  const fromDate = sp.get("from");
  const toDate = sp.get("to");
  if (fromDate && !DATE_RE.test(fromDate.trim())) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "invalid_from_date", hint: "YYYY-MM-DD" },
    };
  }
  if (toDate && !DATE_RE.test(toDate.trim())) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "invalid_to_date", hint: "YYYY-MM-DD" },
    };
  }

  let reconciliationStatus = null;
  const rawSt = sp.get("reconciliation_status");
  if (rawSt != null && String(rawSt).trim() !== "") {
    const u = String(rawSt).trim().toUpperCase();
    if (!RECONCILIATION_STATUSES.has(u)) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: "invalid_reconciliation_status",
          allowed: [...RECONCILIATION_STATUSES],
        },
      };
    }
    reconciliationStatus = u;
  }

  let limit = parseInt(sp.get("limit") || "50", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 500) limit = 500;

  let offset = parseInt(sp.get("offset") || "0", 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  return {
    ok: true,
    params: {
      bankAccountId,
      fromDate: fromDate ? fromDate.trim() : null,
      toDate: toDate ? toDate.trim() : null,
      reconciliationStatus,
      limit,
      offset,
    },
  };
}

function formatTxDate(row) {
  const d = row.tx_date;
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return String(d);
  }
}

/**
 * GET /statements?k=ADMIN_SECRET — tabla HTML (mismos filtros que la API).
 */
async function handleStatementsHtmlPage(req, res, url) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return true;
  }

  if (!ensureAdminHtml(req, res, url)) {
    return true;
  }

  const parsed = parseStatementQueryParams(url);
  if (!parsed.ok) {
    if (url.searchParams.get("format") === "json") {
      writeJson(res, parsed.status, parsed.body);
      return true;
    }
    res.writeHead(parsed.status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><meta charset="utf-8"><title>Statements</title><p>${escapeHtml(
        JSON.stringify(parsed.body)
      )}</p>`
    );
    return true;
  }

  const { params } = parsed;

  if (url.searchParams.get("format") === "json") {
    try {
      const { rows, total } = await listBankStatements(params);
      writeJson(res, 200, {
        ok: true,
        total,
        limit: params.limit,
        offset: params.offset,
        rows,
      });
    } catch (e) {
      console.error("[bank statements]", e);
      writeJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  let rows;
  let total;
  try {
    const r = await listBankStatements(params);
    rows = r.rows;
    total = r.total;
  } catch (e) {
    console.error("[bank statements]", e);
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><meta charset="utf-8"><title>Statements</title><p>Error: ${escapeHtml(
        e.message || String(e)
      )}</p>`
    );
    return true;
  }

  const nav = (newOffset) => {
    const p = new URLSearchParams(url.searchParams);
    p.set("offset", String(Math.max(0, newOffset)));
    return `?${p.toString()}`;
  };
  const prevOff = params.offset - params.limit;
  const nextOff = params.offset + params.limit;
  const hasPrev = params.offset > 0;
  const hasNext = nextOff < total;

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr>
  <td>${escapeHtml(formatTxDate(r))}</td>
  <td>${escapeHtml(r.account_number)}</td>
  <td>${escapeHtml(r.reference_number || "")}</td>
  <td class="desc">${escapeHtml(r.description || "")}</td>
  <td>${escapeHtml(r.tx_type || "")}</td>
  <td class="num">${escapeHtml(r.amount != null ? String(r.amount) : "")}</td>
  <td>${escapeHtml(r.reconciliation_status || "")}</td>
</tr>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Extractos — bank_statements</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; padding: 1rem; max-width: 100%; margin: 0 auto; line-height: 1.4; }
    h1 { font-size: 1.2rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
    th, td { border: 1px solid #e2e8f0; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #f8fafc; }
    .desc { max-width: 18rem; word-break: break-word; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .muted { color: #64748b; font-size: 0.9rem; margin: 0.5rem 0 1rem; }
    .nav a { margin-right: 1rem; }
    code { background: #f1f5f9; padding: 0.1rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Extractos bancarios</h1>
  <p class="muted">Total en BD con estos filtros: <strong>${total}</strong> · mostrando ${rows.length} fila(s) · limit=${params.limit} offset=${params.offset}</p>
  <p class="nav">
    ${hasPrev ? `<a href="${escapeHtml(nav(prevOff))}">← Anterior</a>` : "<span>Anterior</span>"}
    ${hasNext ? `<a href="${escapeHtml(nav(nextOff))}">Siguiente →</a>` : "<span>Siguiente</span>"}
  </p>
  <table>
    <thead>
      <tr>
        <th>Fecha</th><th>Cuenta</th><th>Ref.</th><th>Descripción</th><th>Tipo</th><th>Monto</th><th>Conciliación</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length ? rowsHtml : '<tr><td colspan="7">Sin filas</td></tr>'}
    </tbody>
  </table>
  <p class="muted">JSON: misma URL con <code>?format=json</code> (y el resto de parámetros). API: <code>GET /api/bank/statements</code> + cabecera <code>X-Admin-Secret</code>.</p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

/**
 * GET /api/bank/statements — JSON (cabecera X-Admin-Secret).
 * GET /statements?k= — HTML tabla (o ?format=json).
 */
async function handleBankStatementsRequest(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/statements") {
    return handleStatementsHtmlPage(req, res, url);
  }

  if (!url.pathname.startsWith("/api/bank/statements")) return false;

  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  if (!ensureAdmin(req, res)) return true;

  try {
    if (url.pathname.replace(/\/+$/, "") !== "/api/bank/statements") {
      writeJson(res, 404, { ok: false, error: "not_found" });
      return true;
    }

    const parsed = parseStatementQueryParams(url);
    if (!parsed.ok) {
      writeJson(res, parsed.status, parsed.body);
      return true;
    }

    const { rows, total } = await listBankStatements(parsed.params);

    writeJson(res, 200, {
      ok: true,
      total,
      limit: parsed.params.limit,
      offset: parsed.params.offset,
      rows,
    });
    return true;
  } catch (e) {
    console.error("[bank statements]", e);
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = { handleBankStatementsRequest };
