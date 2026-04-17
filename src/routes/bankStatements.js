"use strict";

const {
  writeJson,
  ensureAdminHtml,
  escapeHtml,
} = require("./bankBanesco");
const {
  listBankStatements,
  getLatestBalancesSnapshot,
  RECONCILIATION_STATUSES,
  TX_TYPES,
} = require("../services/bankStatementsService");
const { requireBankRead } = require("./bankAuth");

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
  const rawSt = sp.get("status") || sp.get("reconciliation_status");
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

  let txType = null;
  const rawTx = sp.get("tx_type");
  if (rawTx != null && String(rawTx).trim() !== "") {
    const u = String(rawTx).trim().toUpperCase();
    if (!TX_TYPES.has(u)) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: "invalid_tx_type", allowed: [...TX_TYPES] },
      };
    }
    txType = u;
  }

  const search = sp.get("search") || sp.get("q");
  const searchTrim = search != null && String(search).trim() !== "" ? String(search).trim() : null;

  let limit = parseInt(sp.get("limit") || "50", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  let offset = parseInt(sp.get("offset") || "0", 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  return {
    ok: true,
    params: {
      bankAccountId,
      fromDate: fromDate ? fromDate.trim() : null,
      toDate: toDate ? toDate.trim() : null,
      reconciliationStatus,
      txType,
      search: searchTrim,
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

/** Campos estables para API JSON (sin joins extra). */
function mapStatementApiRow(r) {
  return {
    id: r.id != null ? String(r.id) : r.id,
    bank_account_id: r.bank_account_id != null ? Number(r.bank_account_id) : null,
    tx_date: formatTxDate(r),
    reference_number: r.reference_number ?? null,
    description: r.description ?? "",
    tx_type: r.tx_type ?? null,
    amount: r.amount != null ? String(r.amount) : null,
    balance_after: r.balance_after != null ? String(r.balance_after) : null,
    payment_type: r.payment_type ?? null,
    reconciliation_status: r.reconciliation_status ?? null,
  };
}

function formatAmountEs(value) {
  if (value == null || String(value).trim() === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
        data: rows.map(mapStatementApiRow),
        meta: { total, limit: params.limit, offset: params.offset },
      });
    } catch (e) {
      console.error("[bank statements]", e);
      writeJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  let rows;
  let total;
  let balanceSnapshots;
  try {
    const [listed, snapshots] = await Promise.all([
      listBankStatements(params),
      getLatestBalancesSnapshot(params),
    ]);
    rows = listed.rows;
    total = listed.total;
    balanceSnapshots = snapshots;
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
  <td class="num">${escapeHtml(formatAmountEs(r.amount))}</td>
  <td>${escapeHtml(r.reconciliation_status || "")}</td>
  <td>${escapeHtml(r.sales_order_id != null ? String(r.sales_order_id) : "")}</td>
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
    .balance-banner {
      background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%);
      color: #f8fafc;
      border-radius: 12px;
      padding: 1rem 1.25rem 1.1rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
    }
    .balance-banner .balance-label { margin: 0 0 0.35rem; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #94a3b8; }
    .balance-banner .balance-amount {
      margin: 0;
      font-size: 2rem;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
      letter-spacing: -0.02em;
    }
    .balance-banner .balance-cur { font-size: 1.1rem; font-weight: 600; color: #cbd5e1; margin-left: 0.35rem; }
    .balance-banner .balance-meta { margin: 0.5rem 0 0; font-size: 0.8rem; color: #94a3b8; }
    .balance-banner .balance-account { margin: 0 0 0.25rem; font-size: 0.9rem; color: #e2e8f0; font-weight: 600; }
    .balance-banner .balance-empty { margin: 0; font-size: 0.95rem; color: #cbd5e1; }
    .balance-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
  </style>
</head>
<body>
  <h1>Extractos bancarios</h1>
  ${
    balanceSnapshots.length === 0
      ? `<div class="balance-banner" role="region" aria-label="Saldo disponible">
    <p class="balance-label">Saldo según último balance_after (estos filtros)</p>
    <p class="balance-empty">Sin movimientos coincidentes — no hay saldo que mostrar.</p>
  </div>`
      : `<div class="balance-grid" role="region" aria-label="Saldo disponible">
  ${balanceSnapshots
    .map((b) => {
      const amt =
        b.balance_after != null && String(b.balance_after).trim() !== ""
          ? escapeHtml(formatAmountEs(b.balance_after))
          : "—";
      const cur = escapeHtml((b.account_currency || "VES").trim());
      const acct = escapeHtml(b.account_number || "");
      const asOf = formatTxDate(b);
      return `<div class="balance-banner">
    <p class="balance-label">Saldo disponible (último movimiento del filtro)</p>
    ${balanceSnapshots.length > 1 ? `<p class="balance-account">Cuenta ${acct}</p>` : ""}
    <p class="balance-amount">${amt}<span class="balance-cur">${cur}</span></p>
    <p class="balance-meta">Según movimiento del ${escapeHtml(asOf || "—")} · balance_after</p>
  </div>`;
    })
    .join("")}
</div>`
  }
  <p class="muted">Total en BD con estos filtros: <strong>${total}</strong> · mostrando ${rows.length} fila(s) · limit=${params.limit} offset=${params.offset}</p>
  <p class="nav">
    ${hasPrev ? `<a href="${escapeHtml(nav(prevOff))}">← Anterior</a>` : "<span>Anterior</span>"}
    ${hasNext ? `<a href="${escapeHtml(nav(nextOff))}">Siguiente →</a>` : "<span>Siguiente</span>"}
  </p>
  <table>
    <thead>
      <tr>
        <th>Fecha</th><th>Cuenta</th><th>Ref.</th><th>Descripción</th><th>Tipo</th><th>Monto</th><th>Conciliación</th><th>Sales ID</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length ? rowsHtml : '<tr><td colspan="8">Sin filas</td></tr>'}
    </tbody>
  </table>
  <p class="muted">JSON: misma URL con <code>?format=json</code>. API: <code>GET /api/bank/statements?k=…</code> (o cabecera <code>X-Admin-Secret</code>).</p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

/**
 * GET /api/bank/statements — JSON (X-Admin-Secret o ?k= / ?secret=).
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

  if (!(await requireBankRead(req, res))) return true;

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
      data: rows.map(mapStatementApiRow),
      meta: { total, limit: parsed.params.limit, offset: parsed.params.offset },
    });
    return true;
  } catch (e) {
    console.error("[bank statements]", e);
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = { handleBankStatementsRequest };
