"use strict";

/**
 * Panel administrador — Tasas · Shipments · Reconciliación · Wallet
 * GET /admin-panel?k=ADMIN_SECRET
 *
 * Deprecación: el dashboard operativo vive en el ERP Next (p. ej. /dashboard).
 * GET /admin → 302 a ERP_DASHBOARD_URL o http://localhost:3000/dashboard por defecto.
 *
 * El ADMIN_SECRET se inyecta como variable JS en el HTML.
 * Todas las llamadas API usan X-Admin-Secret en cabecera (mismo origen).
 */

/** URL absoluta del panel global Next (sin barra final). Producción: definir ERP_DASHBOARD_URL. */
function resolveErpDashboardUrl() {
  const u = String(process.env.ERP_DASHBOARD_URL || "").trim();
  if (u) return u.replace(/\/+$/, "");
  return "http://localhost:3000/dashboard";
}

function escHtmlAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function isEnabled() {
  const v = process.env.ADMIN_PANEL_ENABLED;
  if (v === undefined || v === null || String(v).trim() === "") return true;
  return !(v === "0" || /^false$/i.test(String(v)));
}

function buildHtml(adminSecret) {
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Panel — Ferrari ERP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--surface:#1e293b;--surface2:#273349;--surface3:#334155;
  --border:#334155;--border2:#475569;
  --txt:#f1f5f9;--txt2:#94a3b8;--txt3:#64748b;
  --primary:#3b82f6;--primary-dark:#2563eb;--primary-light:rgba(59,130,246,.15);
  --green:#22c55e;--green-bg:rgba(34,197,94,.12);
  --yellow:#f59e0b;--yellow-bg:rgba(245,158,11,.12);
  --red:#ef4444;--red-bg:rgba(239,68,68,.12);
  --purple:#a855f7;--purple-bg:rgba(168,85,247,.12);
  --rad:.5rem;--rad2:.75rem;--rad3:1rem;
  --shadow:0 1px 3px rgba(0,0,0,.4);
  --shadow2:0 4px 12px rgba(0,0,0,.5);
}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg);color:var(--txt);min-height:100vh;font-size:14px;line-height:1.5}

/* ── Layout ── */
.app{display:grid;grid-template-rows:auto 1fr;min-height:100vh}
header{background:var(--surface);border-bottom:1px solid var(--border);
  padding:.75rem 1.5rem;display:flex;align-items:center;gap:1rem;justify-content:space-between;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.6rem}
.header-right{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-left:auto}
.brand-icon{width:2rem;height:2rem;background:var(--primary);border-radius:var(--rad);
  display:flex;align-items:center;justify-content:center;font-size:1rem}
.brand h1{font-size:.95rem;font-weight:700;color:var(--txt)}
.brand p{font-size:.72rem;color:var(--txt2)}
.header-status{font-size:.72rem;color:var(--txt3);display:flex;align-items:center;gap:.4rem}
.status-dot{width:.45rem;height:.45rem;border-radius:50%;background:var(--green);display:inline-block}

.content{display:grid;grid-template-columns:13rem 1fr;overflow:hidden}
nav{background:var(--surface);border-right:1px solid var(--border);padding:1rem 0;
  overflow-y:auto;min-height:0}
.nav-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--txt3);padding:.4rem 1.25rem .2rem;margin-top:.5rem}
.nav-item{display:flex;align-items:center;gap:.6rem;padding:.55rem 1.25rem;
  cursor:pointer;font-size:.85rem;color:var(--txt2);transition:all .15s;
  border-left:3px solid transparent;user-select:none}
.nav-item:hover{background:var(--surface2);color:var(--txt)}
.nav-item.active{background:var(--primary-light);color:var(--primary);
  border-left-color:var(--primary)}
.nav-item .icon{font-size:1rem;flex-shrink:0}

main{overflow-y:auto;padding:1.5rem}
.section{display:none}.section.active{display:block}

/* ── Cards & surfaces ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rad2);
  overflow:hidden;box-shadow:var(--shadow)}
.card-head{padding:.85rem 1.1rem;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.card-title{font-size:.88rem;font-weight:700;color:var(--txt);
  display:flex;align-items:center;gap:.5rem}
.card-body{padding:1.1rem}
.grid-2{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;margin-bottom:1.25rem}
.grid-3{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;margin-bottom:1.25rem}

/* Stat cards */
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--rad2);
  padding:1.1rem;box-shadow:var(--shadow)}
.stat-label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;
  color:var(--txt3);margin-bottom:.35rem}
.stat-value{font-size:1.6rem;font-weight:800;color:var(--txt);line-height:1}
.stat-sub{font-size:.78rem;color:var(--txt2);margin-top:.3rem}
.stat.green .stat-value{color:var(--green)}
.stat.yellow .stat-value{color:var(--yellow)}
.stat.red .stat-value{color:var(--red)}
.stat.blue .stat-value{color:var(--primary)}

/* ── Tables ── */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{padding:.5rem .75rem;text-align:left;font-size:.7rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.05em;color:var(--txt3);
  border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.55rem .75rem;border-bottom:1px solid var(--border);color:var(--txt2);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--surface2);color:var(--txt)}
.num{text-align:right;font-family:monospace;font-size:.8rem}
.mono{font-family:monospace;font-size:.78rem}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;padding:.15rem .55rem;border-radius:999px;
  font-size:.68rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
.b-green{background:var(--green-bg);color:var(--green)}
.b-yellow{background:var(--yellow-bg);color:var(--yellow)}
.b-red{background:var(--red-bg);color:var(--red)}
.b-blue{background:var(--primary-light);color:var(--primary)}
.b-purple{background:var(--purple-bg);color:var(--purple)}
.b-gray{background:var(--surface3);color:var(--txt2)}

/* Piloto IA Tipo M (Groq) — badge cabecera */
.hdr-groq{font-size:.68rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  padding:.38rem .8rem;border-radius:999px;border:1px solid var(--border2);white-space:nowrap;line-height:1.2;
  cursor:default;transition:background .15s,color .15s,border-color .15s}
.hdr-groq--loading{color:var(--txt3);background:var(--surface2)}
.hdr-groq--on{background:var(--green-bg);color:var(--green);border-color:rgba(34,197,94,.45)}
.hdr-groq--off{background:var(--red-bg);color:var(--red);border-color:rgba(239,68,68,.45)}
.hdr-groq--warn{background:var(--yellow-bg);color:var(--yellow);border-color:rgba(245,158,11,.45)}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem 1rem;
  border-radius:var(--rad);border:none;font-size:.82rem;font-weight:600;
  cursor:pointer;transition:all .15s;white-space:nowrap}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-dark)}
.btn-sm{padding:.3rem .7rem;font-size:.78rem}
.btn-ghost{background:var(--surface2);color:var(--txt2);border:1px solid var(--border2)}
.btn-ghost:hover{background:var(--surface3);color:var(--txt)}
.btn-danger{background:var(--red-bg);color:var(--red);border:1px solid var(--red)}
.btn-danger:hover{background:var(--red);color:#fff}
.btn-success{background:var(--green-bg);color:var(--green);border:1px solid var(--green)}
.btn-success:hover{background:var(--green);color:#0f172a}
.btn:disabled{opacity:.45;cursor:not-allowed}

/* ── Forms ── */
.form-row{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:.75rem}
.field{display:flex;flex-direction:column;gap:.3rem}
.field label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--txt3)}
.field input,.field select,.field textarea{padding:.5rem .75rem;background:var(--surface2);
  border:1.5px solid var(--border2);border-radius:var(--rad);color:var(--txt);font-size:.85rem;
  width:100%;transition:border-color .15s}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--primary)}
.field select{-webkit-appearance:none;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2394a3b8' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right .5rem center;background-size:1.1rem;
  padding-right:2rem;cursor:pointer}

/* ── Modal ── */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;
  align-items:center;justify-content:center;padding:1rem}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:var(--rad3);
  width:100%;max-width:32rem;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow2)}
.modal-head{padding:1rem 1.25rem;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between}
.modal-title{font-size:.92rem;font-weight:700}
.modal-close{background:none;border:none;color:var(--txt3);cursor:pointer;font-size:1.2rem;
  line-height:1;padding:.2rem .4rem;border-radius:var(--rad)}
.modal-close:hover{color:var(--txt);background:var(--surface2)}
.modal-body{padding:1.25rem}
.modal-foot{padding:.9rem 1.25rem;border-top:1px solid var(--border);
  display:flex;gap:.6rem;justify-content:flex-end}

/* ── Loader / states ── */
.loader{text-align:center;padding:2.5rem;color:var(--txt3)}
.spinner{width:1.5rem;height:1.5rem;border:2px solid var(--border2);
  border-top-color:var(--primary);border-radius:50%;animation:spin .6s linear infinite;margin:auto}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:2rem 1rem;color:var(--txt3);font-size:.85rem}
.error-bar{background:var(--red-bg);border:1px solid var(--red);border-radius:var(--rad);
  padding:.6rem .9rem;color:var(--red);font-size:.82rem;margin-bottom:.75rem;display:flex;gap:.5rem}

/* ── Section header ── */
.sec-head{display:flex;align-items:center;justify-content:space-between;
  margin-bottom:1rem;gap:.75rem;flex-wrap:wrap}
.sec-title{font-size:1rem;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:.5rem}
.sec-actions{display:flex;gap:.5rem;flex-wrap:wrap}

/* ── Filter row ── */
.filter-row{display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap;
  padding:.85rem 1.1rem;border-bottom:1px solid var(--border);background:var(--surface2)}
.filter-row .field{min-width:130px}
.filter-row .field label{font-size:.65rem}
.filter-row .field input,.filter-row .field select{font-size:.8rem;padding:.35rem .6rem}

/* ── Expand rows ── */
.expand-trigger{cursor:pointer}
.expand-trigger:hover td{background:var(--surface2)}
.expand-row{display:none;background:var(--surface2)}
.expand-row.open{display:table-row}
.expand-cell{padding:.75rem 1.1rem}

/* ── Específico tasas ── */
.rate-big{font-size:2rem;font-weight:900;letter-spacing:-.02em}
.rate-source{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;
  padding:.1rem .4rem;border-radius:999px;background:var(--surface3);color:var(--txt3)}
.spread-ok{color:var(--green)}.spread-warn{color:var(--yellow)}.spread-bad{color:var(--red)}

/* Deprecación — enlace al ERP Next */
.erp-deprecation-banner{
  background:var(--yellow-bg);border-bottom:1px solid rgba(245,158,11,.45);
  color:var(--txt);padding:.55rem 1.25rem;font-size:.78rem;line-height:1.45;
  display:flex;align-items:center;justify-content:center;gap:.65rem;flex-wrap:wrap;text-align:center
}
.erp-deprecation-banner code{font-size:.72rem;background:var(--surface2);padding:.1rem .35rem;border-radius:4px;color:var(--txt2)}
.erp-deprecation-banner a{color:var(--primary);font-weight:700;text-decoration:underline}
.erp-deprecation-banner a:hover{color:var(--primary-dark)}

/* ── Responsive ── */
@media(max-width:720px){
  .content{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  nav{display:flex;overflow-x:auto;padding:.5rem;border-right:none;border-bottom:1px solid var(--border)}
  .nav-label{display:none}
  .nav-item{border-left:none;border-bottom:3px solid transparent;padding:.5rem .75rem;flex-direction:column;gap:.1rem;font-size:.72rem;min-width:4.5rem;text-align:center}
  .nav-item.active{border-bottom-color:var(--primary);border-left:none}
  .nav-item .icon{font-size:1.2rem}
}
</style>
</head>
<body>
${(() => {
    const erp = resolveErpDashboardUrl();
    return `<div class="erp-deprecation-banner" role="status">
  <span>Este panel HTML está <strong>deprecado</strong> para operación diaria. Usá el dashboard ERP Next.</span>
  <a href="${escHtmlAttr(erp)}" target="_blank" rel="noopener noreferrer">Abrir dashboard ERP →</a>
</div>`;
  })()}
<div class="app">

<!-- Header -->
<header>
  <div class="brand">
    <div class="brand-icon">&#9881;</div>
    <div>
      <h1>Ferrari ERP</h1>
      <p>Panel de Administración</p>
    </div>
  </div>
  <div class="header-right">
    <div class="header-status">
      <span class="status-dot" id="hdr-dot"></span>
      <span id="hdr-status">Conectando…</span>
      <span id="hdr-rate" style="margin-left:.75rem;font-weight:700;color:var(--green)"></span>
    </div>
    <span id="hdr-groq" class="hdr-groq hdr-groq--loading" title="Estado del piloto IA (Groq) para WhatsApp CRM (Tipo M).">IA GROQ · …</span>
  </div>
</header>

<div class="content">

<!-- Sidebar nav -->
<nav>
  <div class="nav-label">Finanzas</div>
  <div class="nav-item active" data-sec="tasas"><span class="icon">&#128178;</span>Tasas</div>
  <div class="nav-item" data-sec="shipments"><span class="icon">&#128674;</span>Embarques</div>
  <div class="nav-label">Banco</div>
  <div class="nav-item" data-sec="banco"><span class="icon">&#127981;</span>Extractos</div>
  <div class="nav-label">Operaciones</div>
  <div class="nav-item" data-sec="wallet"><span class="icon">&#128179;</span>Wallet</div>
</nav>

<main>

<!-- ══════════════ SECCIÓN TASAS ══════════════ -->
<div class="section active" id="sec-tasas">
  <div class="sec-head">
    <div class="sec-title">&#128178; Tasas de cambio</div>
    <div class="sec-actions">
      <button class="btn btn-ghost btn-sm" onclick="loadTasaHoy()">&#8635; Actualizar</button>
      <button class="btn btn-primary btn-sm" onclick="fetchRates()">&#9889; Fetch BCV/Binance</button>
      <button class="btn btn-ghost btn-sm" onclick="openModal('modal-override')">&#9998; Override</button>
    </div>
  </div>
  <div id="tasas-stats" class="grid-3"></div>
  <div class="card" style="margin-bottom:1rem">
    <div class="card-head">
      <span class="card-title">&#128200; Historial</span>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input type="date" id="tasa-from" style="padding:.3rem .6rem;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--rad);color:var(--txt);font-size:.78rem">
        <input type="date" id="tasa-to" style="padding:.3rem .6rem;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--rad);color:var(--txt);font-size:.78rem">
        <button class="btn btn-ghost btn-sm" onclick="loadHistorial()">Filtrar</button>
      </div>
    </div>
    <div id="tasa-table"><div class="loader"><div class="spinner"></div></div></div>
  </div>
</div>

<!-- ══════════════ SECCIÓN SHIPMENTS ══════════════ -->
<div class="section" id="sec-shipments">
  <div class="sec-head">
    <div class="sec-title">&#128674; Embarques / Landed Cost</div>
    <div class="sec-actions">
      <select id="ship-filter-status" class="btn btn-ghost btn-sm" style="padding:.3rem .75rem"
        onchange="loadShipments()">
        <option value="">Todos</option>
        <option value="OPEN">Abiertos</option>
        <option value="CLOSED">Cerrados</option>
        <option value="CANCELLED">Cancelados</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="openModal('modal-new-ship')">&#43; Nuevo</button>
    </div>
  </div>
  <div id="ship-stats" class="grid-3"></div>
  <div class="card">
    <div id="ship-table"><div class="loader"><div class="spinner"></div></div></div>
  </div>
</div>

<!-- ══════════════ SECCIÓN BANCO ══════════════ -->
<div class="section" id="sec-banco">
  <div class="sec-head">
    <div class="sec-title">&#127981; Extractos bancarios</div>
    <div class="sec-actions">
      <button class="btn btn-ghost btn-sm" onclick="loadBancoStatus()">Estado conexión</button>
      <button class="btn btn-ghost btn-sm" onclick="loadBanco()">&#8635; Recargar</button>
    </div>
  </div>
  <div id="banco-conn" style="margin-bottom:1rem"></div>
  <div class="card">
    <div class="filter-row">
      <div class="field"><label>Desde</label>
        <input type="date" id="banco-from"></div>
      <div class="field"><label>Hasta</label>
        <input type="date" id="banco-to"></div>
      <div class="field"><label>Estado</label>
        <select id="banco-status">
          <option value="">Todos</option>
          <option value="UNMATCHED">Sin conciliar</option>
          <option value="MATCHED">Conciliado</option>
          <option value="SUGGESTED">Sugerido</option>
          <option value="CONFIRMED">Confirmado</option>
          <option value="IGNORED">Ignorado</option>
        </select>
      </div>
      <div class="field"><label>Límite</label>
        <input type="number" id="banco-limit" value="50" min="1" max="500" style="width:80px"></div>
      <button class="btn btn-primary btn-sm" onclick="loadBanco()" style="align-self:flex-end">Buscar</button>
    </div>
    <div id="banco-table"><div class="loader"><div class="spinner"></div></div></div>
  </div>
</div>

<!-- ══════════════ SECCIÓN WALLET ══════════════ -->
<div class="section" id="sec-wallet">
  <div class="sec-head">
    <div class="sec-title">&#128179; Wallet de clientes</div>
    <div class="sec-actions">
      <button class="btn btn-ghost btn-sm" onclick="loadWalletDrift()">&#9888; Drift</button>
      <button class="btn btn-ghost btn-sm" onclick="loadWalletCustomers()">&#8635; Recargar</button>
    </div>
  </div>
  <div id="wallet-stats" class="grid-3" style="margin-bottom:1rem"></div>
  <div class="grid-2" style="align-items:start">
    <div class="card">
      <div class="card-head"><span class="card-title">&#128100; Clientes</span>
        <input type="text" id="wallet-cust-search" placeholder="Filtrar…"
          style="padding:.3rem .6rem;background:var(--surface2);border:1px solid var(--border2);
                 border-radius:var(--rad);color:var(--txt);font-size:.78rem;width:150px"
          oninput="filterWalletCustomers(this.value)"></div>
      <div id="wallet-customers"><div class="loader"><div class="spinner"></div></div></div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-title" id="wallet-tx-title">&#128196; Movimientos</span>
        <button class="btn btn-primary btn-sm" id="btn-new-tx" style="display:none"
          onclick="openModal('modal-new-tx')">&#43; Movimiento</button>
      </div>
      <div id="wallet-transactions"><div class="empty">Seleccioná un cliente para ver sus movimientos.</div></div>
    </div>
  </div>
</div>

</main>
</div><!-- .content -->
</div><!-- .app -->

<!-- ══════════════ MODALES ══════════════ -->

<!-- Override tasa -->
<div class="modal-overlay" id="modal-override">
  <div class="modal">
    <div class="modal-head"><span class="modal-title">&#9998; Override manual de tasa</span>
      <button class="modal-close" onclick="closeModal('modal-override')">&#10005;</button></div>
    <div class="modal-body">
      <div id="override-err"></div>
      <div class="form-row">
        <div class="field"><label>Fecha</label><input type="date" id="ov-date"></div>
        <div class="field"><label>Campo</label>
          <select id="ov-field">
            <option value="bcv_rate">BCV</option>
            <option value="binance_rate">Binance</option>
            <option value="adjusted_rate">Ajustada</option>
            <option value="active_rate_type">Tipo activo</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Valor</label><input type="text" id="ov-value" placeholder="Ej: 95.50 o BCV"></div>
        <div class="field"><label>Motivo</label><input type="text" id="ov-reason" placeholder="Motivo del override"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('modal-override')">Cancelar</button>
      <button class="btn btn-primary" onclick="submitOverride()">Guardar</button>
    </div>
  </div>
</div>

<!-- Nuevo embarque -->
<div class="modal-overlay" id="modal-new-ship">
  <div class="modal">
    <div class="modal-head"><span class="modal-title">&#128674; Nuevo embarque</span>
      <button class="modal-close" onclick="closeModal('modal-new-ship')">&#10005;</button></div>
    <div class="modal-body">
      <div id="ship-err"></div>
      <div class="form-row">
        <div class="field"><label>Referencia</label><input type="text" id="ship-ref" placeholder="ORD-2026-001"></div>
        <div class="field"><label>Proveedor</label><input type="text" id="ship-supplier" placeholder="Nombre proveedor"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>País origen</label><input type="text" id="ship-country" placeholder="CN, US, DE…"></div>
        <div class="field"><label>Incoterm</label>
          <select id="ship-incoterm">
            <option value="FOB">FOB</option>
            <option value="CIF">CIF</option>
            <option value="EXW">EXW</option>
            <option value="DDP">DDP</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Gastos totales USD</label>
          <input type="number" id="ship-expenses" placeholder="0.00" min="0" step="0.01"></div>
        <div class="field"><label>Notas</label>
          <input type="text" id="ship-notes" placeholder="Opcional"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('modal-new-ship')">Cancelar</button>
      <button class="btn btn-primary" onclick="submitNewShip()">Crear embarque</button>
    </div>
  </div>
</div>

<!-- Agregar línea a embarque -->
<div class="modal-overlay" id="modal-ship-line">
  <div class="modal">
    <div class="modal-head"><span class="modal-title">&#43; Agregar línea</span>
      <button class="modal-close" onclick="closeModal('modal-ship-line')">&#10005;</button></div>
    <div class="modal-body">
      <div id="line-err"></div>
      <div class="form-row">
        <div class="field"><label>SKU</label><input type="text" id="line-sku" placeholder="PROD-001" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
        <div class="field"><label>Cantidad</label><input type="number" id="line-qty" min="1" step="1"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>FOB unitario USD</label><input type="number" id="line-fob" min="0" step="0.0001"></div>
        <div class="field"><label>Volumen CBM/u</label><input type="number" id="line-cbm" min="0" step="0.0001" placeholder="0.0010"></div>
      </div>
      <input type="hidden" id="line-ship-id">
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('modal-ship-line')">Cancelar</button>
      <button class="btn btn-primary" onclick="submitLine()">Agregar</button>
    </div>
  </div>
</div>

<!-- Nuevo movimiento wallet -->
<div class="modal-overlay" id="modal-new-tx">
  <div class="modal">
    <div class="modal-head"><span class="modal-title">&#128196; Nuevo movimiento</span>
      <button class="modal-close" onclick="closeModal('modal-new-tx')">&#10005;</button></div>
    <div class="modal-body">
      <div id="tx-err"></div>
      <div class="form-row">
        <div class="field"><label>Tipo</label>
          <select id="tx-type">
            <option value="CREDIT">Crédito (ingreso)</option>
            <option value="DEBIT">Débito (egreso)</option>
          </select></div>
        <div class="field"><label>Moneda</label>
          <select id="tx-currency">
            <option value="USD">USD</option>
            <option value="VES">VES</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Monto</label><input type="number" id="tx-amount" min="0.01" step="0.01"></div>
        <div class="field"><label>Referencia</label><input type="text" id="tx-ref" placeholder="Ej: transferencia/pago"></div>
      </div>
      <div class="form-row">
        <div class="field" style="grid-column:1/-1"><label>Notas</label>
          <input type="text" id="tx-notes" placeholder="Descripción opcional"></div>
      </div>
      <input type="hidden" id="tx-customer-id">
      <input type="hidden" id="tx-wallet-id">
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('modal-new-tx')">Cancelar</button>
      <button class="btn btn-primary" onclick="submitTx()">Crear movimiento</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="toast" style="position:fixed;bottom:1.25rem;right:1.25rem;z-index:200;
  display:flex;flex-direction:column;gap:.5rem;pointer-events:none;max-width:22rem"></div>

<script>
const ADMIN = '${esc(adminSecret)}';
const H = { 'Content-Type': 'application/json', 'X-Admin-Secret': ADMIN };

// ── Utils ────────────────────────────────────────────────────────────────
function esc(s){ const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML; }
function fmt(n,d=2){ return n!=null&&!isNaN(n)?Number(n).toLocaleString('es-VE',{minimumFractionDigits:d,maximumFractionDigits:d}):'—'; }
function fmtDate(s){ if(!s)return '—'; const d=new Date(String(s).slice(0,10)+'T12:00:00');return d.toLocaleDateString('es-VE',{day:'2-digit',month:'2-digit',year:'numeric'}); }

function toast(msg, type='ok'){
  const el=document.createElement('div');
  el.style.cssText='background:'+(type==='ok'?'var(--green-bg)':type==='err'?'var(--red-bg)':'var(--yellow-bg)')+';color:'+(type==='ok'?'var(--green)':type==='err'?'var(--red)':'var(--yellow)')+';border:1px solid currentColor;border-radius:var(--rad);padding:.6rem 1rem;font-size:.83rem;font-weight:600;pointer-events:all;box-shadow:var(--shadow2)';
  el.textContent=msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(()=>el.remove(),3500);
}
function spin(id){ document.getElementById(id).innerHTML='<div class="loader"><div class="spinner"></div></div>'; }
function errBox(id,msg){ const el=document.getElementById(id); if(el) el.innerHTML=msg?'<div class="error-bar">⚠ '+esc(msg)+'</div>':''; }
async function apiFetch(url,opts={}){
  const r=await fetch(url,{headers:H,...opts});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||j.message||'Error '+r.status);
  return j;
}

// ── Nav ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
    el.classList.add('active');
    const s=document.getElementById('sec-'+el.dataset.sec);
    if(s){ s.classList.add('active'); lazyLoad(el.dataset.sec); }
  });
});
const loaded=new Set(['tasas']);
function lazyLoad(sec){
  if(loaded.has(sec))return;
  loaded.add(sec);
  if(sec==='shipments'){loadShipments();}
  else if(sec==='banco'){loadBancoStatus();loadBanco();}
  else if(sec==='wallet'){loadWalletCustomers();loadWalletDrift();}
}

// ── Modal ────────────────────────────────────────────────────────────────
function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(o=>{
  o.addEventListener('click',e=>{ if(e.target===o) o.classList.remove('open'); });
});

// ══════════════════════════════════════════════════════════════════════════
// TASAS
// ══════════════════════════════════════════════════════════════════════════
async function loadTasaHoy(){
  try{
    const d=await fetch('/api/currency/today').then(r=>r.json());
    const row=d.data;
    const stats=document.getElementById('tasas-stats');
    if(!row){ stats.innerHTML='<div class="empty">Sin tasa para hoy.</div>'; return; }
    const spread=row.spread_current_pct!=null?Number(row.spread_current_pct):null;
    const sc=spread==null?'':(spread>20?'red':spread>10?'yellow':'green');
    stats.innerHTML=\`
      <div class="stat blue"><div class="stat-label">BCV</div>
        <div class="stat-value">\${fmt(row.bcv_rate,2)}</div>
        <div class="stat-sub">Bs/USD &mdash; \${fmtDate(row.rate_date)}</div></div>
      <div class="stat"><div class="stat-label">Binance P2P</div>
        <div class="stat-value">\${fmt(row.binance_rate,2)}</div>
        <div class="stat-sub">Bs/USD</div></div>
      <div class="stat \${row.is_manual_override?'yellow':'green'}">
        <div class="stat-label">Tasa activa <span class="rate-source">\${esc(row.active_rate_type||'—')}</span></div>
        <div class="stat-value">\${fmt(row.active_rate,2)}</div>
        <div class="stat-sub">\${row.is_manual_override?'⚠ Override manual':'Automática'}</div></div>
      <div class="stat"><div class="stat-label">Spread BCV/Binance</div>
        <div class="stat-value \${sc?'spread-'+sc:''}">\${spread!=null?fmt(spread,1)+'%':'—'}</div>
        <div class="stat-sub">\${row.spread_alert_triggered?'⚠ Alerta spread':'Normal'}</div></div>
    \`;
    document.getElementById('hdr-rate').textContent='Bs '+fmt(row.active_rate,2);
    document.getElementById('hdr-dot').style.background='var(--green)';
    document.getElementById('hdr-status').textContent=fmtDate(row.rate_date);
  }catch(e){
    document.getElementById('tasas-stats').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>';
    document.getElementById('hdr-dot').style.background='var(--red)';
    document.getElementById('hdr-status').textContent='Sin tasa';
  }
}
loadTasaHoy();

async function loadGroqBanner(){
  const el=document.getElementById('hdr-groq');
  if(!el)return;
  try{
    const j=await apiFetch('/api/ai-responder/stats');
    el.classList.remove('hdr-groq--loading','hdr-groq--on','hdr-groq--off','hdr-groq--warn');
    if(j.worker_running){
      el.textContent='IA GROQ · ACTIVA';
      el.classList.add('hdr-groq--on');
      el.title='Tipo M: worker + cola con GROQ_API_KEY y piloto habilitado (no suspendido).';
    }else{
      el.textContent='IA GROQ · INACTIVA';
      el.classList.add('hdr-groq--off');
      const bits=[];
      if(!j.provider||!j.provider.groq_key_ok)bits.push('falta GROQ_API_KEY');
      if(j.ai_responder_suspended)bits.push('AI_RESPONDER_SUSPENDED');
      else if(!j.ai_responder_env_enabled)bits.push('AI_RESPONDER_ENABLED distinto de 1');
      el.title=bits.length?bits.join(' · '):'Piloto IA inactivo o sin requisitos para ejecutar.';
    }
  }catch(e){
    el.classList.remove('hdr-groq--loading','hdr-groq--on','hdr-groq--off');
    el.classList.add('hdr-groq--warn');
    el.textContent='IA GROQ · ?';
    el.title='No se pudo leer /api/ai-responder/stats: '+String(e.message||e);
  }
}
loadGroqBanner();
setInterval(loadGroqBanner,120000);

async function loadHistorial(){
  const from=document.getElementById('tasa-from').value;
  const to=document.getElementById('tasa-to').value;
  spin('tasa-table');
  try{
    let url='/api/currency/history?page_size=60';
    if(from) url+='&from='+encodeURIComponent(from);
    if(to)   url+='&to='+encodeURIComponent(to);
    const d=await fetch(url).then(r=>r.json());
    const rows=d.rows||[];
    if(!rows.length){ document.getElementById('tasa-table').innerHTML='<div class="empty">Sin datos en ese rango.</div>';return; }
    document.getElementById('tasa-table').innerHTML=\`<div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>BCV</th><th>Binance</th><th>Activa</th><th>Tipo</th><th>Spread</th><th>Override</th></tr></thead>
      <tbody>\${rows.map(r=>\`<tr>
        <td class="mono">\${esc(r.rate_date?.slice?.(0,10)||'—')}</td>
        <td class="num">\${fmt(r.bcv_rate)}</td>
        <td class="num">\${fmt(r.binance_rate)}</td>
        <td class="num" style="font-weight:700;color:var(--green)">\${fmt(r.active_rate)}</td>
        <td><span class="badge b-blue">\${esc(r.active_rate_type||'—')}</span></td>
        <td class="num \${r.spread_alert_triggered?'spread-bad':'spread-ok'}">\${fmt(r.spread_current_pct,1)}%</td>
        <td>\${r.is_manual_override?'<span class="badge b-yellow">&#9998; Manual</span>':'<span class="badge b-gray">Auto</span>'}</td>
      </tr>\`).join('')}</tbody>
    </table></div>\`;
  }catch(e){ document.getElementById('tasa-table').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}
// Inicializar fechas historial (últimos 30 días)
(()=>{ const t=new Date(); const f=new Date(t); f.setDate(f.getDate()-30);
  document.getElementById('tasa-from').value=f.toISOString().slice(0,10);
  document.getElementById('tasa-to').value=t.toISOString().slice(0,10); })();
loadHistorial();

async function fetchRates(){
  const btn=event.target; btn.disabled=true; btn.textContent='Cargando…';
  try{
    const d=await apiFetch('/api/currency/fetch',{method:'POST'});
    toast('Tasas actualizadas: '+JSON.stringify(d).slice(0,80));
    loadTasaHoy(); loadHistorial();
  }catch(e){ toast('Error: '+e.message,'err'); }
  finally{ btn.disabled=false; btn.textContent='⚡ Fetch BCV/Binance'; }
}

async function submitOverride(){
  errBox('override-err','');
  const date=document.getElementById('ov-date').value;
  const field=document.getElementById('ov-field').value;
  const value=document.getElementById('ov-value').value.trim();
  const reason=document.getElementById('ov-reason').value.trim();
  if(!date||!value){ errBox('override-err','Fecha y valor son obligatorios.'); return; }
  try{
    await apiFetch('/api/currency/override',{method:'POST',
      body:JSON.stringify({rate_date:date,field,value,reason:reason||'Manual override desde panel',company_id:1})});
    toast('Override guardado');
    closeModal('modal-override');
    loadTasaHoy(); loadHistorial();
  }catch(e){ errBox('override-err',e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// SHIPMENTS
// ══════════════════════════════════════════════════════════════════════════
let shipData=[];
async function loadShipments(){
  spin('ship-table');
  const status=document.getElementById('ship-filter-status').value;
  try{
    const url='/api/shipments'+(status?'?status='+status:'');
    const d=await apiFetch(url);
    shipData=(d.data||d.items||d)||[];
    if(!Array.isArray(shipData))shipData=[];

    // Stats
    const open=shipData.filter(s=>s.status==='OPEN').length;
    const closed=shipData.filter(s=>s.status==='CLOSED').length;
    const totalFob=shipData.reduce((a,s)=>a+Number(s.total_fob_usd||0),0);
    document.getElementById('ship-stats').innerHTML=\`
      <div class="stat yellow"><div class="stat-label">Abiertos</div><div class="stat-value">\${open}</div></div>
      <div class="stat green"><div class="stat-label">Cerrados</div><div class="stat-value">\${closed}</div></div>
      <div class="stat blue"><div class="stat-label">FOB total</div><div class="stat-value" style="font-size:1.2rem">USD \${fmt(totalFob)}</div></div>
    \`;

    if(!shipData.length){ document.getElementById('ship-table').innerHTML='<div class="empty">Sin embarques.</div>';return; }

    let rows=shipData.map(s=>\`
      <tr class="expand-trigger" onclick="toggleShip(\${s.id},this)">
        <td class="mono">#\${esc(s.id)}</td>
        <td style="font-weight:600">\${esc(s.shipment_ref||'—')}</td>
        <td>\${esc(s.supplier_name||'—')}</td>
        <td>\${esc(s.origin_country||'—')} · \${esc(s.incoterm||'—')}</td>
        <td class="num">\${fmt(s.total_fob_usd)}</td>
        <td class="num">\${fmt(s.total_landed_usd||s.total_expenses_usd)}</td>
        <td class="num">\${s.total_skus!=null?s.total_skus:'—'}</td>
        <td>\${statusBadge(s.status)}</td>
        <td class="mono" style="color:var(--txt3)">\${fmtDate(s.created_at)}</td>
      </tr>
      <tr class="expand-row" id="ship-detail-\${s.id}">
        <td colspan="9" class="expand-cell">
          <div id="ship-detail-body-\${s.id}"></div>
        </td>
      </tr>\`).join('');

    document.getElementById('ship-table').innerHTML=\`<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Ref</th><th>Proveedor</th><th>Origen/Incoterm</th><th>FOB USD</th><th>Landed USD</th><th>SKUs</th><th>Estado</th><th>Fecha</th></tr></thead>
      <tbody>\${rows}</tbody></table></div>\`;
  }catch(e){ document.getElementById('ship-table').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}

const openShips=new Set();
async function toggleShip(id,tr){
  const detail=document.getElementById('ship-detail-'+id);
  if(openShips.has(id)){ detail.classList.remove('open'); openShips.delete(id); return; }
  openShips.add(id);
  detail.classList.add('open');
  const body=document.getElementById('ship-detail-body-'+id);
  body.innerHTML='<div class="spinner" style="margin:.5rem auto"></div>';
  try{
    const d=await apiFetch('/api/shipments/'+id);
    const s=d.data||d;
    const ship=s.shipment||s;
    const lines=s.lines||[];
    const totals=s.totals||{};
    const canClose=ship.status==='OPEN';
    body.innerHTML=\`
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:.75rem">
        <div><span class="badge b-gray">Ref: \${esc(ship.shipment_ref||'—')}</span></div>
        <div><span class="badge b-gray">Gastos: USD \${fmt(ship.total_expenses_usd)}</span></div>
        <div><span class="badge b-gray">Tasa: \${fmt(ship.rate_applied)}</span></div>
        <div style="margin-left:auto;display:flex;gap:.4rem">
          \${canClose?'<button class="btn btn-ghost btn-sm" onclick="openAddLine('+id+')">&#43; Línea</button>':''}
          \${canClose?'<button class="btn btn-success btn-sm" onclick="closeShip('+id+')">&#10003; Cerrar</button>':''}
          \${ship.status==='CLOSED'?'<button class="btn btn-ghost btn-sm" onclick="reopenShip('+id+')">&#8635; Reabrir</button>':''}
        </div>
      </div>
      \${lines.length?'<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Descripción</th><th>Cant</th><th>FOB/u</th><th>CBM/u</th><th>Total FOB</th><th>Landed/u</th></tr></thead><tbody>'
        +lines.map(l=>\`<tr>
          <td class="mono">\${esc(l.product_sku)}</td>
          <td>\${esc(l.description||l.product_description||'—')}</td>
          <td class="num">\${fmt(l.quantity,0)}</td>
          <td class="num">\${fmt(l.unit_fob_usd,4)}</td>
          <td class="num">\${fmt(l.unit_volume_cbm,4)}</td>
          <td class="num">\${fmt(l.line_fob_usd)}</td>
          <td class="num">\${fmt(l.unit_landed_usd,4)}</td>
        </tr>\`).join('')
        +'</tbody></table></div>'
        :'<div class="empty">Sin líneas. Agregá una con &ldquo;+ Línea&rdquo;.</div>'}
    \`;
  }catch(e){ body.innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}

function openAddLine(shipId){
  document.getElementById('line-ship-id').value=shipId;
  errBox('line-err','');
  openModal('modal-ship-line');
}
async function submitLine(){
  const shipId=document.getElementById('line-ship-id').value;
  const sku=document.getElementById('line-sku').value.trim();
  const qty=Number(document.getElementById('line-qty').value);
  const fob=Number(document.getElementById('line-fob').value);
  const cbm=Number(document.getElementById('line-cbm').value);
  if(!sku||!qty||!fob){ errBox('line-err','SKU, cantidad y FOB son obligatorios.'); return; }
  try{
    await apiFetch('/api/shipments/'+shipId+'/lines',{method:'POST',
      body:JSON.stringify({product_sku:sku,quantity:qty,unit_fob_usd:fob,unit_volume_cbm:cbm||0})});
    toast('Línea agregada');
    closeModal('modal-ship-line');
    openShips.delete(Number(shipId));
    toggleShip(Number(shipId));
  }catch(e){ errBox('line-err',e.message); }
}
async function closeShip(id){
  if(!confirm('¿Cerrar embarque #'+id+'? Esto calcula los landed costs.'))return;
  try{
    await apiFetch('/api/shipments/'+id+'/close',{method:'POST',body:JSON.stringify({user_id:1})});
    toast('Embarque cerrado');
    openShips.delete(id);
    loadShipments();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
async function reopenShip(id){
  if(!confirm('¿Reabrir embarque #'+id+'?'))return;
  try{
    await apiFetch('/api/shipments/'+id+'/reopen',{method:'POST',body:JSON.stringify({})});
    toast('Embarque reabierto');
    openShips.delete(id);
    loadShipments();
  }catch(e){ toast('Error: '+e.message,'err'); }
}
async function submitNewShip(){
  errBox('ship-err','');
  const ref=document.getElementById('ship-ref').value.trim();
  const supplier=document.getElementById('ship-supplier').value.trim();
  const country=document.getElementById('ship-country').value.trim();
  const incoterm=document.getElementById('ship-incoterm').value;
  const expenses=Number(document.getElementById('ship-expenses').value)||0;
  const notes=document.getElementById('ship-notes').value.trim();
  if(!ref||!supplier){ errBox('ship-err','Referencia y proveedor son obligatorios.'); return; }
  try{
    await apiFetch('/api/shipments',{method:'POST',
      body:JSON.stringify({shipment_ref:ref,supplier_name:supplier,origin_country:country,incoterm,total_expenses_usd:expenses,notes:notes||null})});
    toast('Embarque creado');
    closeModal('modal-new-ship');
    loadShipments();
  }catch(e){ errBox('ship-err',e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
// BANCO
// ══════════════════════════════════════════════════════════════════════════
async function loadBancoStatus(){
  try{
    const d=await apiFetch('/api/bank/banesco/status');
    const html=\`<div class="card"><div class="card-body" style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
      <div><span class="badge \${d.configured?'b-green':'b-red'}">\${d.configured?'Configurado':'Sin configurar'}</span></div>
      \${d.status?'<span class="badge b-gray">Estado: '+esc(d.status)+'</span>':''}
      <span style="font-size:.78rem;color:var(--txt3)">Banesco Monitor</span>
      <a href="/banesco?k=\${encodeURIComponent(ADMIN)}" target="_blank"
        class="btn btn-ghost btn-sm" style="margin-left:auto">&#128065; Ver panel Banesco</a>
    </div></div>\`;
    document.getElementById('banco-conn').innerHTML=html;
  }catch(e){
    document.getElementById('banco-conn').innerHTML='<div class="error-bar">Estado Banesco: '+esc(e.message)+'</div>';
  }
}

async function loadBanco(){
  spin('banco-table');
  const from=document.getElementById('banco-from').value;
  const to=document.getElementById('banco-to').value;
  const status=document.getElementById('banco-status').value;
  const limit=document.getElementById('banco-limit').value||50;
  let url='/api/bank/statements?limit='+limit;
  if(from) url+='&from='+from;
  if(to)   url+='&to='+to;
  if(status) url+='&reconciliation_status='+status;
  try{
    const d=await apiFetch(url);
    const rows=d.rows||[];
    const total=d.total||rows.length;
    if(!rows.length){ document.getElementById('banco-table').innerHTML='<div class="empty">Sin movimientos en ese rango.</div>';return; }
    document.getElementById('banco-table').innerHTML=\`
      <div style="padding:.5rem 1.1rem;font-size:.78rem;color:var(--txt3)">
        Mostrando \${rows.length} de \${total} movimientos</div>
      <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Referencia</th><th>Descripción</th><th>Tipo</th><th>Monto</th><th>Saldo</th><th>Tipo Pago</th><th>Estado</th></tr></thead>
      <tbody>\${rows.map(r=>\`<tr>
        <td class="mono">\${esc(r.tx_date?.slice?.(0,10)||'—')}</td>
        <td class="mono" style="font-size:.72rem">\${esc(r.reference_number||'—')}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(r.description)}">\${esc(r.description||'—')}</td>
        <td>\${r.tx_type==='CREDIT'?'<span class="badge b-green">CRÉDITO</span>':'<span class="badge b-red">DÉBITO</span>'}</td>
        <td class="num" style="font-weight:700;color:\${r.tx_type==='CREDIT'?'var(--green)':'var(--red)'}">\${fmt(r.amount)}</td>
        <td class="num">\${fmt(r.balance_after)}</td>
        <td style="font-size:.75rem">\${esc(r.payment_type||'—')}</td>
        <td>\${reconcBadge(r.reconciliation_status)}</td>
      </tr>\`).join('')}
      </tbody></table></div>\`;
  }catch(e){ document.getElementById('banco-table').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}
// Inicializar fechas banco
(()=>{ const t=new Date(); const f=new Date(t); f.setDate(f.getDate()-7);
  document.getElementById('banco-from').value=f.toISOString().slice(0,10);
  document.getElementById('banco-to').value=t.toISOString().slice(0,10); })();

// ══════════════════════════════════════════════════════════════════════════
// WALLET
// ══════════════════════════════════════════════════════════════════════════
let walletCustomerData=[];
let activeCustomerId=null;
let activeWalletId=null;

async function loadWalletCustomers(){
  spin('wallet-customers');
  try{
    const d=await apiFetch('/api/wallet/customers?limit=100');
    walletCustomerData=(d.customers||d.data||d)||[];
    renderWalletCustomers(walletCustomerData);
  }catch(e){ document.getElementById('wallet-customers').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}

function renderWalletCustomers(list){
  if(!list.length){ document.getElementById('wallet-customers').innerHTML='<div class="empty">Sin clientes.</div>';return; }
  document.getElementById('wallet-customers').innerHTML=\`<div class="table-wrap"><table>
    <thead><tr><th>Cliente</th><th>USD</th><th>VES</th><th></th></tr></thead>
    <tbody>\${list.map(c=>\`<tr style="cursor:pointer" onclick="selectWalletCustomer(\${c.id||c.customer_id},'\${esc(c.full_name||c.name||c.id)}')">
      <td>
        <div style="font-weight:600;font-size:.82rem">\${esc(c.full_name||c.name||'#'+c.id)}</div>
        \${c.phone?'<div style="font-size:.72rem;color:var(--txt3)">'+esc(c.phone)+'</div>':''}
      </td>
      <td class="num" style="font-weight:700;color:var(--green)">\${fmt(c.balance_usd??c.usd_balance)}</td>
      <td class="num">\${fmt(c.balance_ves??c.ves_balance,0)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();selectWalletCustomer(\${c.id||c.customer_id},'\${esc(c.full_name||c.name||c.id)}')">&#8594;</button></td>
    </tr>\`).join('')}
    </tbody></table></div>\`;
}

function filterWalletCustomers(q){
  const f=q.toLowerCase();
  renderWalletCustomers(walletCustomerData.filter(c=>
    (c.full_name||c.name||'').toLowerCase().includes(f)||
    (c.phone||'').includes(f)));
}

async function selectWalletCustomer(id,name){
  activeCustomerId=id;
  document.getElementById('wallet-tx-title').textContent='📄 '+name;
  document.getElementById('btn-new-tx').style.display='inline-flex';
  spin('wallet-transactions');
  try{
    // Obtener wallet id
    const sum=await apiFetch('/api/wallet/customer?id='+id);
    const wallets=sum.wallets||sum.data?.wallets||[];
    const usdWallet=wallets.find(w=>(w.currency||'').toUpperCase()==='USD');
    activeWalletId=usdWallet?.id||wallets[0]?.id||null;
    document.getElementById('tx-customer-id').value=id;
    document.getElementById('tx-wallet-id').value=activeWalletId||'';

    const txd=await apiFetch('/api/wallet/transactions?customer_id='+id+'&limit=50');
    const txs=txd.transactions||txd.data||[];
    if(!txs.length){ document.getElementById('wallet-transactions').innerHTML='<div class="empty">Sin movimientos.</div>';return; }
    document.getElementById('wallet-transactions').innerHTML=\`<div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Moneda</th><th>Monto</th><th>Estado</th><th>Ref</th><th></th></tr></thead>
      <tbody>\${txs.map(t=>\`<tr>
        <td class="mono">\${esc(t.created_at?.slice?.(0,10)||'—')}</td>
        <td>\${t.tx_type==='CREDIT'?'<span class="badge b-green">CRÉDITO</span>':'<span class="badge b-red">DÉBITO</span>'}</td>
        <td>\${esc(t.currency||'—')}</td>
        <td class="num" style="font-weight:700">\${fmt(t.amount)}</td>
        <td>\${txStatusBadge(t.status)}</td>
        <td style="font-size:.72rem;color:var(--txt3)">\${esc(t.reference_type||'')} \${esc(t.reference_id||'')} \${esc(t.notes||'')}</td>
        <td>
          \${t.status==='PENDING'?'<button class="btn btn-success btn-sm" onclick="confirmTx('+t.id+')">&#10003;</button> <button class="btn btn-danger btn-sm" onclick="cancelTx('+t.id+')">&#10005;</button>':''}
        </td>
      </tr>\`).join('')}
      </tbody></table></div>\`;
  }catch(e){ document.getElementById('wallet-transactions').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}

async function loadWalletDrift(){
  try{
    const d=await apiFetch('/api/wallet/drift');
    const drift=d.drift||d.data||{};
    const driftN=Number(drift.total_drift_usd||drift.drift||0);
    const dOk=Math.abs(driftN)<0.01;
    document.getElementById('wallet-stats').innerHTML=\`
      <div class="stat \${dOk?'green':'red'}">
        <div class="stat-label">Drift USD</div>
        <div class="stat-value">\${fmt(driftN)}</div>
        <div class="stat-sub">\${dOk?'Balances cuadran':'⚠ Diferencia detectada'}</div></div>
      \${drift.total_customers!=null?'<div class="stat"><div class="stat-label">Clientes</div><div class="stat-value">'+drift.total_customers+'</div></div>':''}
      \${drift.total_balance_usd!=null?'<div class="stat blue"><div class="stat-label">Balance total USD</div><div class="stat-value" style="font-size:1.1rem">'+fmt(drift.total_balance_usd)+'</div></div>':''}
    \`;
  }catch(e){ document.getElementById('wallet-stats').innerHTML='<div class="error-bar">⚠ '+esc(e.message)+'</div>'; }
}

async function confirmTx(id){
  try{
    await apiFetch('/api/wallet/transactions/confirm',{method:'POST',body:JSON.stringify({id})});
    toast('Movimiento confirmado');
    if(activeCustomerId) selectWalletCustomer(activeCustomerId,'');
  }catch(e){ toast('Error: '+e.message,'err'); }
}
async function cancelTx(id){
  const reason=prompt('Motivo de cancelación:'); if(!reason)return;
  try{
    await apiFetch('/api/wallet/transactions/cancel',{method:'POST',
      body:JSON.stringify({id,cancel_reason:reason})});
    toast('Movimiento cancelado');
    if(activeCustomerId) selectWalletCustomer(activeCustomerId,'');
  }catch(e){ toast('Error: '+e.message,'err'); }
}

async function submitTx(){
  errBox('tx-err','');
  const customerId=document.getElementById('tx-customer-id').value;
  const walletId=document.getElementById('tx-wallet-id').value;
  const txType=document.getElementById('tx-type').value;
  const currency=document.getElementById('tx-currency').value;
  const amount=Number(document.getElementById('tx-amount').value);
  const notes=document.getElementById('tx-notes').value.trim();
  const ref=document.getElementById('tx-ref').value.trim();
  if(!amount||amount<=0){ errBox('tx-err','El monto debe ser > 0'); return; }
  if(!walletId){ errBox('tx-err','Este cliente no tiene wallet. Crealo primero en /api/wallet/wallets/ensure'); return; }
  try{
    await apiFetch('/api/wallet/transactions',{method:'POST',
      body:JSON.stringify({
        wallet_id:Number(walletId), customer_id:Number(customerId),
        tx_type:txType, currency, amount, status:'PENDING',
        reference_type:ref||null, notes:notes||null
      })});
    toast('Movimiento creado (PENDING)');
    closeModal('modal-new-tx');
    selectWalletCustomer(Number(customerId),'');
  }catch(e){ errBox('tx-err',e.message); }
}

// ── Helpers de badge ─────────────────────────────────────────────────────
function statusBadge(s){
  const m={OPEN:'b-yellow OPEN',CLOSED:'b-green CLOSED',CANCELLED:'b-red CANCELADO'};
  const [cls,lbl]=(m[s]||'b-gray '+s).split(' ');
  return '<span class="badge '+cls+'">'+lbl+'</span>';
}
function reconcBadge(s){
  const m={MATCHED:'b-green',CONFIRMED:'b-green',SUGGESTED:'b-yellow',UNMATCHED:'b-red',IGNORED:'b-gray'};
  return '<span class="badge '+(m[s]||'b-gray')+'">'+esc(s||'—')+'</span>';
}
function txStatusBadge(s){
  const m={PENDING:'b-yellow',CONFIRMED:'b-green',COMPLETED:'b-green',CANCELLED:'b-red',REJECTED:'b-red'};
  return '<span class="badge '+(m[s]||'b-gray')+'">'+esc(s||'—')+'</span>';
}
</script>
</body>
</html>`;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {boolean}
 */
function handleAdminPanel(req, res, url) {
  const path = (url.pathname || "").replace(/\/+$/, "") || "/";
  if (path !== "/admin-panel") return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }

  if (!isEnabled()) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><meta charset=utf-8><p>Panel desactivado (<code>ADMIN_PANEL_ENABLED=0</code>).</p>");
    return true;
  }

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><meta charset=utf-8><p>Define <code>ADMIN_SECRET</code> en el servidor.</p>");
    return true;
  }

  const k = url.searchParams.get("k") || url.searchParams.get("secret");
  if (k !== adminSecret) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><meta charset=utf-8><title>Admin</title>" +
        "<p>Acceso denegado. Usá <code>/admin-panel?k=TU_ADMIN_SECRET</code> " +
        "o el dashboard ERP en <code>" +
        escHtmlAttr(resolveErpDashboardUrl()) +
        "</code>.</p>"
    );
    return true;
  }

  const html = buildHtml(adminSecret);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

/**
 * GET|HEAD /admin — redirige al dashboard ERP Next (misma URL que la franja de deprecación).
 * @returns {boolean}
 */
function handleAdminLegacyRedirect(req, res, url) {
  const path = (url.pathname || "").replace(/\/+$/, "") || "/";
  if (path !== "/admin") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  const loc = resolveErpDashboardUrl();
  res.writeHead(302, {
    Location: loc,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  });
  res.end();
  return true;
}

module.exports = { handleAdminPanel, handleAdminLegacyRedirect, resolveErpDashboardUrl };
