"use strict";

/**
 * Página HTML pública del catálogo de repuestos con buscador técnico por vehículo.
 * GET /catalogo  — sirve el SPA embebido.
 *
 * La página JS llama a /api/v1/catalog/compat/* y /api/v1/catalog usando
 * FRONTEND_API_KEY, que se inyecta como variable JS en el HTML servido.
 * Pública por defecto; si CATALOG_PAGE_ENABLED=0, devuelve 503.
 */

function isEnabled() {
  const v = process.env.CATALOG_PAGE_ENABLED;
  if (v === undefined || v === null || String(v).trim() === "") return true;
  return !(v === "0" || /^false$/i.test(String(v)));
}

function buildHtml(apiKey, siteName) {
  const escJs = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const name = String(siteName || process.env.CATALOG_SITE_NAME || "Repuestos Automotrices");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Catálogo técnico</title>
<meta name="description" content="Catálogo de repuestos con buscador técnico por vehículo, año y cilindrada">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f1f5f9;--surface:#fff;--surface2:#f8fafc;
  --primary:#c2281a;--primary-dark:#a01e14;--primary-light:#fef2f2;
  --accent:#f59e0b;
  --txt:#1e293b;--txt2:#475569;--txt3:#94a3b8;
  --border:#e2e8f0;--border2:#cbd5e1;
  --intake:#3b82f6;--exhaust:#ef4444;--both:#10b981;
  --oem:#7c3aed;
  --stock-ok:#16a34a;--stock-no:#dc2626;
  --rad:0.5rem;--rad2:0.75rem;--rad3:1rem;
  --shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06);
  --shadow2:0 4px 6px -1px rgba(0,0,0,.1),0 2px 4px -2px rgba(0,0,0,.1);
  --shadow3:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);
}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;font-size:15px;line-height:1.5}

/* ── Header ── */
header{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);color:#fff;padding:0}
.header-inner{max-width:1140px;margin:auto;padding:1rem 1.25rem;display:flex;align-items:center;gap:1rem;justify-content:space-between}
.logo-area{display:flex;align-items:center;gap:.75rem}
.logo-icon{width:2.5rem;height:2.5rem;background:var(--primary);border-radius:var(--rad);display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0}
.logo-text h1{font-size:1.1rem;font-weight:700;letter-spacing:-.01em}
.logo-text p{font-size:.75rem;color:#94a3b8;margin-top:.05rem}
.header-badge{font-size:.7rem;padding:.2rem .6rem;background:rgba(255,255,255,.08);border-radius:999px;color:#94a3b8;white-space:nowrap}

/* ── Nav tabs ── */
.nav-tabs{max-width:1140px;margin:auto;padding:.75rem 1.25rem 0;display:flex;gap:.25rem}
.tab-btn{padding:.6rem 1.1rem;border-radius:var(--rad) var(--rad) 0 0;border:none;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .15s;background:var(--surface2);color:var(--txt2)}
.tab-btn:hover{background:#e2e8f0;color:var(--txt)}
.tab-btn.active{background:var(--surface);color:var(--primary);box-shadow:inset 0 -2px 0 var(--primary)}

/* ── Main layout ── */
main{max-width:1140px;margin:auto;padding:0 1.25rem 2rem}

/* ── Search panels ── */
.panel{display:none;background:var(--surface);border-radius:0 var(--rad3) var(--rad3);box-shadow:var(--shadow);padding:1.5rem}
.panel.active{display:block}

.panel-title{font-size:1rem;font-weight:700;color:var(--txt);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem}
.panel-title::before{content:'';display:inline-block;width:.25rem;height:1.1rem;background:var(--primary);border-radius:2px}

/* ── Vehicle form ── */
.vehicle-form{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.field{display:flex;flex-direction:column;gap:.35rem}
.field label{font-size:.78rem;font-weight:600;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em}
.field select,.field input[type=number],.field input[type=text]{width:100%;padding:.6rem .85rem;border:1.5px solid var(--border2);border-radius:var(--rad);font-size:.9rem;color:var(--txt);background:var(--surface);transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none}
.field select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%236b7280' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .6rem center;background-size:1.2rem;padding-right:2.2rem;cursor:pointer}
.field select:focus,.field input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(194,40,26,.12)}
.field select:disabled,.field input:disabled{background:#f1f5f9;cursor:not-allowed;opacity:.6}

.search-btn{align-self:flex-end;padding:.65rem 1.75rem;background:var(--primary);color:#fff;border:none;border-radius:var(--rad);font-size:.9rem;font-weight:700;cursor:pointer;transition:background .15s,transform .1s;letter-spacing:.02em;white-space:nowrap}
.search-btn:hover:not(:disabled){background:var(--primary-dark)}
.search-btn:active:not(:disabled){transform:scale(.97)}
.search-btn:disabled{opacity:.5;cursor:not-allowed}

/* General & SKU search */
.search-row{display:flex;gap:.75rem;align-items:flex-end}
.search-row .field{flex:1}
.search-row .search-btn{flex-shrink:0}

/* ── Loader ── */
.loader{display:none;margin:2.5rem auto;text-align:center}
.spinner{width:2rem;height:2rem;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .6s linear infinite;margin:auto}
@keyframes spin{to{transform:rotate(360deg)}}
.loader p{margin-top:.75rem;font-size:.85rem;color:var(--txt3)}

/* ── Results header ── */
.results-header{display:flex;align-items:center;justify-content:space-between;margin:1.5rem 0 1rem;flex-wrap:wrap;gap:.5rem}
.results-count{font-size:.85rem;font-weight:600;color:var(--txt2)}
.results-count strong{color:var(--txt)}
.results-meta{font-size:.8rem;color:var(--txt3)}

/* ── Cards grid ── */
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem}

.card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rad2);overflow:hidden;transition:box-shadow .15s,border-color .15s;cursor:default}
.card:hover{box-shadow:var(--shadow2);border-color:var(--border2)}
.card-head{padding:.9rem 1rem .75rem;border-bottom:1px solid var(--border)}
.card-head-row{display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem}
.sku-badge{font-size:.72rem;font-weight:700;padding:.15rem .55rem;background:var(--primary-light);color:var(--primary);border-radius:999px;font-family:monospace;letter-spacing:.02em;white-space:nowrap}
.badges-row{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.45rem}
.badge{font-size:.68rem;font-weight:700;padding:.15rem .45rem;border-radius:999px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
.badge-intake{background:#eff6ff;color:var(--intake)}
.badge-exhaust{background:#fef2f2;color:var(--exhaust)}
.badge-both{background:#f0fdf4;color:var(--both)}
.badge-oem{background:#f5f3ff;color:var(--oem)}
.badge-stock-ok{background:#f0fdf4;color:var(--stock-ok)}
.badge-stock-no{background:#fef2f2;color:var(--stock-no)}
.badge-gray{background:#f1f5f9;color:var(--txt2)}

.card-body{padding:.85rem 1rem}
.card-desc{font-size:.9rem;font-weight:600;color:var(--txt);line-height:1.35;margin-bottom:.6rem}
.price-row{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.7rem}
.price{font-size:1.1rem;font-weight:800;color:var(--txt)}
.price-label{font-size:.72rem;color:var(--txt3)}
.price-consult{font-size:.88rem;color:var(--txt2);font-style:italic}

/* Dimensions table */
.dims{width:100%;font-size:.78rem;border-collapse:collapse;margin:.6rem 0}
.dims td{padding:.15rem .25rem .15rem 0;color:var(--txt2);white-space:nowrap}
.dims td:last-child{font-weight:700;color:var(--txt);text-align:right}
.dims-label{color:var(--txt3);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:.5rem 0 .2rem;padding-top:.5rem;border-top:1px solid var(--border)}

/* Expand sections */
.expand-btns{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.85rem;border-top:1px solid var(--border);padding-top:.75rem}
.expand-btn{font-size:.77rem;font-weight:600;padding:.35rem .75rem;border:1.5px solid var(--border2);background:var(--surface2);color:var(--txt2);border-radius:var(--rad);cursor:pointer;transition:all .15s}
.expand-btn:hover,.expand-btn.open{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}
.expand-section{display:none;margin-top:.75rem;padding:.75rem;background:var(--surface2);border-radius:var(--rad);font-size:.8rem}
.expand-section.open{display:block}
.expand-section h4{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--txt2);margin-bottom:.6rem}

/* Compat list */
.compat-list{list-style:none;display:flex;flex-direction:column;gap:.35rem}
.compat-item{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.compat-make{font-weight:700;color:var(--txt)}
.compat-model{color:var(--txt2)}
.compat-years{font-size:.75rem;color:var(--txt3);margin-left:.2rem}
.compat-disp{font-size:.72rem;padding:.1rem .4rem;background:var(--border);color:var(--txt2);border-radius:999px}

/* Equivalences list */
.equiv-list{display:flex;flex-direction:column;gap:.5rem}
.equiv-item{display:flex;justify-content:space-between;align-items:center;padding:.4rem .5rem;background:var(--surface);border-radius:var(--rad);gap:.5rem}
.equiv-sku{font-size:.75rem;font-family:monospace;font-weight:700;color:var(--primary)}
.equiv-desc{font-size:.78rem;color:var(--txt2);flex:1;margin:0 .5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.equiv-stock{font-size:.72rem;font-weight:700}
.equiv-stock.ok{color:var(--stock-ok)}
.equiv-stock.no{color:var(--stock-no)}

/* ── State messages ── */
.empty-state{text-align:center;padding:3rem 1rem;color:var(--txt2)}
.empty-state .icon{font-size:3rem;margin-bottom:.75rem;line-height:1}
.empty-state h3{font-size:1rem;font-weight:700;color:var(--txt);margin-bottom:.35rem}
.empty-state p{font-size:.85rem;color:var(--txt3)}

.error-msg{background:#fef2f2;border:1.5px solid #fecaca;border-radius:var(--rad);padding:.85rem 1rem;color:#b91c1c;font-size:.85rem;display:flex;gap:.5rem;align-items:flex-start}

/* ── General search tab ── */
.quick-filters{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem}
.qf-btn{font-size:.77rem;padding:.3rem .75rem;border:1.5px solid var(--border2);background:var(--surface2);color:var(--txt2);border-radius:999px;cursor:pointer;transition:all .15s}
.qf-btn:hover,.qf-btn.active{border-color:var(--primary);background:var(--primary-light);color:var(--primary)}

/* ── Footer ── */
footer{max-width:1140px;margin:1.5rem auto;padding:0 1.25rem 1.5rem;font-size:.75rem;color:var(--txt3);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem}
.footer-note{display:flex;align-items:center;gap:.35rem}

/* ── Responsive ── */
@media(max-width:640px){
  .header-inner{padding:.85rem 1rem}
  .logo-text h1{font-size:1rem}
  .header-badge{display:none}
  .vehicle-form{grid-template-columns:1fr 1fr}
  .cards-grid{grid-template-columns:1fr}
  .panel{border-radius:0 0 var(--rad3) var(--rad3)}
  .search-row{flex-direction:column}
  .search-row .search-btn{width:100%}
}
@media(max-width:400px){
  .vehicle-form{grid-template-columns:1fr}
}

/* ── Skeleton loading ── */
.skeleton{background:linear-gradient(90deg,#e2e8f0 25%,#f1f5f9 50%,#e2e8f0 75%);background-size:200% 100%;animation:shimmer 1.2s infinite;border-radius:var(--rad)}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skel-card{height:220px;border-radius:var(--rad2)}
</style>
</head>
<body>

<header>
  <div class="header-inner">
    <div class="logo-area">
      <div class="logo-icon">&#9881;</div>
      <div class="logo-text">
        <h1>${name}</h1>
        <p>Catálogo técnico de repuestos</p>
      </div>
    </div>
    <div class="header-badge">Búsqueda por vehículo</div>
  </div>
</header>

<div class="nav-tabs">
  <button class="tab-btn active" data-tab="vehicle">&#128663; Por vehículo</button>
  <button class="tab-btn" data-tab="general">&#128269; Búsqueda general</button>
  <button class="tab-btn" data-tab="sku">&#128230; Por referencia / SKU</button>
</div>

<main>
  <!-- ── Panel: Por vehículo ── -->
  <div class="panel active" id="tab-vehicle">
    <div class="panel-title">Buscador técnico por vehículo</div>
    <form id="vehicle-form" autocomplete="off" onsubmit="return false">
      <div class="vehicle-form">
        <div class="field">
          <label for="sel-make">Marca</label>
          <select id="sel-make" required>
            <option value="">Cargando…</option>
          </select>
        </div>
        <div class="field">
          <label for="sel-model">Modelo</label>
          <select id="sel-model" disabled required>
            <option value="">— Seleccioná la marca —</option>
          </select>
        </div>
        <div class="field">
          <label for="inp-year">Año</label>
          <input type="number" id="inp-year" placeholder="Ej. 2005" min="1960" max="2030" step="1" disabled required>
        </div>
        <div class="field">
          <label for="sel-disp">Cilindrada (opcional)</label>
          <select id="sel-disp" disabled>
            <option value="">Cualquier cilindrada</option>
          </select>
        </div>
        <div class="field" style="justify-content:flex-end">
          <button type="submit" class="search-btn" id="btn-search-vehicle" disabled>Buscar</button>
        </div>
      </div>
    </form>
    <div class="loader" id="loader-vehicle"><div class="spinner"></div><p>Buscando repuestos compatibles…</p></div>
    <div id="results-vehicle"></div>
  </div>

  <!-- ── Panel: Búsqueda general ── -->
  <div class="panel" id="tab-general">
    <div class="panel-title">Búsqueda en todo el catálogo</div>
    <form id="general-form" onsubmit="return false">
      <div class="search-row">
        <div class="field">
          <label for="inp-general">Descripción, referencia o código</label>
          <input type="text" id="inp-general" placeholder="Ej. válvula admisión, 38mm…">
        </div>
        <button type="submit" class="search-btn" id="btn-search-general">Buscar</button>
      </div>
    </form>
    <div class="loader" id="loader-general"><div class="spinner"></div><p>Buscando…</p></div>
    <div id="results-general"></div>
  </div>

  <!-- ── Panel: Por SKU / referencia ── -->
  <div class="panel" id="tab-sku">
    <div class="panel-title">Compatibilidad por referencia</div>
    <form id="sku-form" onsubmit="return false">
      <div class="search-row">
        <div class="field">
          <label for="inp-sku">SKU o referencia exacta</label>
          <input type="text" id="inp-sku" placeholder="Ej. TY-VAL-INT-001" style="text-transform:uppercase">
        </div>
        <button type="submit" class="search-btn" id="btn-search-sku">Consultar</button>
      </div>
    </form>
    <div class="loader" id="loader-sku"><div class="spinner"></div><p>Consultando…</p></div>
    <div id="results-sku"></div>
  </div>
</main>

<footer>
  <span class="footer-note">&#9889; Catálogo actualizado en tiempo real</span>
  <span>API v1 &mdash; datos sujetos a disponibilidad</span>
</footer>

<script>
const API_KEY = '${escJs(apiKey)}';
const API = '';  // mismo origen

// ──────────────────────────────────────────────────
// Utilidades de fetch
// ──────────────────────────────────────────────────
async function apiFetch(path) {
  const r = await fetch(API + path, {
    headers: { 'X-API-KEY': API_KEY }
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || j.detail || 'Error ' + r.status);
  }
  return r.json();
}

// ──────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById('tab-' + btn.dataset.tab);
    if (target) target.classList.add('active');
  });
});

// ──────────────────────────────────────────────────
// Helpers de DOM
// ──────────────────────────────────────────────────
function showLoader(id, show) {
  document.getElementById('loader-' + id).style.display = show ? 'block' : 'none';
}
function setResults(id, html) {
  document.getElementById('results-' + id).innerHTML = html;
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
function badge(cls, text) {
  return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
}

// ──────────────────────────────────────────────────
// Formateo de tarjeta de producto (resultado compat)
// ──────────────────────────────────────────────────
function posBadge(pos) {
  if (!pos) return '';
  const map = { INTAKE: 'badge-intake', EXHAUST: 'badge-exhaust', BOTH: 'badge-both' };
  const lbl = { INTAKE: 'Admisión', EXHAUST: 'Escape', BOTH: 'Admisión / Escape' };
  return badge(map[pos] || 'badge-gray', lbl[pos] || pos);
}
function fmtPrice(p) {
  const n = Number(p);
  if (!n || !isFinite(n)) return '<span class="price-consult">Consultar precio</span>';
  return '<span class="price">USD ' + n.toFixed(2) + '</span>';
}
function fmtDims(row) {
  const f = v => v != null ? Number(v).toFixed(2) + ' mm' : '—';
  const has = row.head_diameter_mm != null || row.stem_diameter_mm != null || row.total_length_mm != null;
  if (!has) return '';
  return '<div class="dims-label">Dimensiones</div><table class="dims"><tbody>'
    + '<tr><td>&#8960; Cabeza</td><td>' + f(row.head_diameter_mm) + '</td></tr>'
    + '<tr><td>&#8960; Vástago</td><td>' + f(row.stem_diameter_mm) + '</td></tr>'
    + '<tr><td>Longitud total</td><td>' + f(row.total_length_mm) + '</td></tr>'
    + (row.seat_angle_deg != null ? '<tr><td>Ángulo asiento</td><td>' + Number(row.seat_angle_deg).toFixed(1) + '°</td></tr>' : '')
    + (row.material ? '<tr><td>Material</td><td>' + esc(row.material.replace(/_/g,' ')) + '</td></tr>' : '')
    + '</tbody></table>';
}
function stockBadge(available) {
  const n = Number(available) || 0;
  if (n > 0) return badge('badge-stock-ok', 'Stock: ' + n);
  return badge('badge-stock-no', 'Sin stock');
}

function buildCompatCard(row, extraMeta) {
  const uid = 'c' + Math.random().toString(36).slice(2);
  const hasEquiv = row.head_diameter_mm != null;
  const metaLabel = extraMeta || '';
  return \`<div class="card" id="\${uid}">
  <div class="card-head">
    <div class="card-head-row">
      <span class="sku-badge">\${esc(row.producto_sku)}</span>
      \${stockBadge(row.stock_available)}
    </div>
    <div class="badges-row">
      \${posBadge(row.position)}
      \${row.is_oem ? badge('badge-oem','OEM') : ''}
      \${row.engine_code ? badge('badge-gray', esc(row.engine_code)) : ''}
      \${row.qty_per_engine > 1 ? badge('badge-gray','×' + row.qty_per_engine + ' por motor') : ''}
      \${metaLabel}
    </div>
  </div>
  <div class="card-body">
    <div class="card-desc">\${esc(row.descripcion || '(sin descripción)')}</div>
    <div class="price-row">\${fmtPrice(row.precio_usd)}</div>
    \${row.displacement_l != null ? '<div style="font-size:.78rem;color:var(--txt2);margin-bottom:.3rem">Motor \${esc(row.displacement_l)}L · \${esc(row.cylinders || '?')} cil · \${esc(row.fuel_type || '')}</div>' : ''}
    \${fmtDims(row)}
    <div class="expand-btns">
      <button class="expand-btn" onclick="toggleExpand('\${uid}-apps', this)">&#128663; Vehículos</button>
      \${hasEquiv ? '<button class="expand-btn" onclick="loadEquiv(this, \\'' + esc(row.producto_sku) + '\\', \\'' + uid + '-equiv\\')">&#128260; Equivalencias</button>' : ''}
    </div>
    <div class="expand-section" id="\${uid}-apps">
      \${buildAppsList(row)}
    </div>
    <div class="expand-section" id="\${uid}-equiv"></div>
  </div>
</div>\`;
}

function buildAppsList(row) {
  if (!row.make_name) return '<p style="color:var(--txt3);font-size:.8rem">Sin datos de vehículo.</p>';
  const years = row.year_to ? row.year_from + '–' + row.year_to : row.year_from + '+';
  return '<h4>Aplica a</h4><ul class="compat-list"><li class="compat-item"><span class="compat-make">' + esc(row.make_name) + '</span><span class="compat-model">' + esc(row.model_name) + '</span><span class="compat-years">' + years + '</span>' + (row.displacement_l != null ? '<span class="compat-disp">' + esc(row.displacement_l) + 'L</span>' : '') + '</li></ul>';
}

function toggleExpand(sectionId, btn) {
  const s = document.getElementById(sectionId);
  if (!s) return;
  const open = s.classList.toggle('open');
  btn.classList.toggle('open', open);
}

async function loadEquiv(btn, sku, sectionId) {
  const s = document.getElementById(sectionId);
  if (!s) return;
  const alreadyOpen = s.classList.contains('open');
  if (alreadyOpen && s.dataset.loaded) { toggleExpand(sectionId, btn); return; }
  if (s.dataset.loaded) { toggleExpand(sectionId, btn); return; }
  btn.disabled = true;
  s.innerHTML = '<div class="spinner" style="margin:.5rem auto"></div>';
  s.classList.add('open');
  btn.classList.add('open');
  try {
    const d = await apiFetch('/api/v1/catalog/compat/equivalences?sku=' + encodeURIComponent(sku) + '&limit=10');
    s.dataset.loaded = '1';
    if (!d.items || !d.items.length) {
      s.innerHTML = '<h4>Equivalencias técnicas</h4><p style="font-size:.8rem;color:var(--txt3)">No se encontraron equivalencias con stock.</p>';
    } else {
      s.innerHTML = '<h4>Equivalencias técnicas (' + d.items.length + ')</h4><div class="equiv-list">'
        + d.items.map(e => \`<div class="equiv-item">
            <span class="equiv-sku">\${esc(e.sku_equivalente)}</span>
            <span class="equiv-desc">\${esc(e.descripcion_equivalente)}</span>
            <span class="equiv-stock \${Number(e.stock_disponible) > 0 ? 'ok' : 'no'}">\${Number(e.stock_disponible) > 0 ? '✓ ' + e.stock_disponible : '0'}</span>
          </div>\`).join('')
        + '</div>';
    }
  } catch(err) {
    s.innerHTML = '<p style="color:var(--stock-no);font-size:.8rem">Error: ' + esc(err.message) + '</p>';
  }
  btn.disabled = false;
}

// ──────────────────────────────────────────────────
// Tarjeta para resultados generales (solo productos)
// ──────────────────────────────────────────────────
function buildGeneralCard(row) {
  const uid = 'g' + Math.random().toString(36).slice(2);
  return \`<div class="card" id="\${uid}">
  <div class="card-head">
    <div class="card-head-row">
      <span class="sku-badge">\${esc(row.sku)}</span>
      \${Number(row.stock) > 0 ? stockBadge(row.stock) : badge('badge-stock-no','Sin stock')}
    </div>
  </div>
  <div class="card-body">
    <div class="card-desc">\${esc(row.nombre || row.descripcion || '(sin descripción)')}</div>
    <div class="price-row">\${fmtPrice(row.precio_venta || row.precio_usd)}</div>
    <div class="expand-btns">
      <button class="expand-btn" onclick="loadSkuApps(this, '\${esc(row.sku)}', '\${uid}-skuapps')">&#128663; Ver aplicaciones</button>
    </div>
    <div class="expand-section" id="\${uid}-skuapps"></div>
  </div>
</div>\`;
}

async function loadSkuApps(btn, sku, sectionId) {
  const s = document.getElementById(sectionId);
  if (!s) return;
  if (s.dataset.loaded) { toggleExpand(sectionId, btn); return; }
  btn.disabled = true;
  s.innerHTML = '<div class="spinner" style="margin:.5rem auto"></div>';
  s.classList.add('open'); btn.classList.add('open');
  try {
    const d = await apiFetch('/api/v1/catalog/compat/for-sku?sku=' + encodeURIComponent(sku));
    s.dataset.loaded = '1';
    if (!d.items || !d.items.length) {
      s.innerHTML = '<h4>Aplicaciones</h4><p style="font-size:.8rem;color:var(--txt3)">Sin aplicaciones registradas.</p>';
    } else {
      const grouped = {};
      for (const r of d.items) {
        const k = (r.make_name || '') + ' ' + (r.model_name || '');
        if (!grouped[k]) grouped[k] = { make: r.make_name, model: r.model_name, years: [], disps: new Set() };
        grouped[k].years.push(r.year_from, r.year_to);
        if (r.displacement_l) grouped[k].disps.add(r.displacement_l);
      }
      const items = Object.values(grouped).map(g => {
        const yrs = g.years.filter(Boolean);
        const yFrom = Math.min(...yrs); const yTo = Math.max(...yrs);
        const disps = [...g.disps].sort().map(x => '<span class="compat-disp">'+esc(x)+'L</span>').join(' ');
        return '<li class="compat-item"><span class="compat-make">'+esc(g.make)+'</span><span class="compat-model">'+esc(g.model)+'</span><span class="compat-years">'+yFrom+(yTo>yFrom?'–'+yTo:'')+'</span>'+disps+'</li>';
      });
      s.innerHTML = '<h4>Aplicaciones (' + d.items.length + ' motores)</h4><ul class="compat-list">' + items.join('') + '</ul>';
    }
  } catch(err) {
    s.innerHTML = '<p style="color:var(--stock-no);font-size:.8rem">Error: '+esc(err.message)+'</p>';
  }
  btn.disabled = false;
}

// ──────────────────────────────────────────────────
// Tarjeta para resultados de buscar-por-SKU
// ──────────────────────────────────────────────────
function buildSkuResultCards(sku, items) {
  if (!items.length) {
    return \`<div class="empty-state">
      <div class="icon">&#128230;</div>
      <h3>SKU no encontrado</h3>
      <p>La referencia <strong>\${esc(sku)}</strong> no tiene aplicaciones registradas o no existe.</p>
    </div>\`;
  }
  const groupedByMake = {};
  for (const r of items) {
    const mk = r.make_name || 'Desconocida';
    if (!groupedByMake[mk]) groupedByMake[mk] = [];
    groupedByMake[mk].push(r);
  }
  const prodInfo = items[0];
  let html = \`<div class="results-header">
    <div><span class="results-count">SKU <strong>\${esc(sku)}</strong> — \${items.length} aplicación\${items.length!==1?'es':''} encontrada\${items.length!==1?'s':''}</span></div>
  </div>
  <div class="cards-grid">\${buildCompatCard(prodInfo)}</div>
  <div style="margin:1.5rem 0 .75rem;font-weight:700;font-size:.95rem;color:var(--txt)">Todos los vehículos compatibles</div>\`;

  for (const [make, rows] of Object.entries(groupedByMake)) {
    html += '<div style="margin-bottom:1rem"><div style="font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--txt2);margin-bottom:.5rem">'+esc(make)+'</div><ul class="compat-list">';
    for (const r of rows) {
      const y2 = r.year_to ? '–'+r.year_to : '+';
      html += '<li class="compat-item"><span class="compat-model">'+esc(r.model_name)+'</span><span class="compat-years">'+r.year_from+y2+'</span>'+(r.displacement_l?'<span class="compat-disp">'+esc(r.displacement_l)+'L</span>':'')+'<span class="compat-disp">'+esc(r.position)+'</span></li>';
    }
    html += '</ul></div>';
  }
  return html;
}

// ──────────────────────────────────────────────────
// Panel: Por vehículo — carga de marcas
// ──────────────────────────────────────────────────
const selMake = document.getElementById('sel-make');
const selModel = document.getElementById('sel-model');
const inpYear = document.getElementById('inp-year');
const selDisp = document.getElementById('sel-disp');
const btnSearchV = document.getElementById('btn-search-vehicle');

async function loadMakes() {
  try {
    const d = await apiFetch('/api/v1/catalog/compat/makes');
    selMake.innerHTML = '<option value="">— Seleccioná la marca —</option>'
      + d.items.map(m => '<option value="'+esc(m.name)+'">'+esc(m.name)+(m.country?' ('+esc(m.country)+')':'')+'</option>').join('');
  } catch(err) {
    selMake.innerHTML = '<option value="">Error al cargar marcas</option>';
    console.error('[catalog]', err);
  }
}
loadMakes();

selMake.addEventListener('change', async () => {
  const mk = selMake.value;
  selModel.disabled = true; selModel.innerHTML = '<option value="">Cargando…</option>';
  inpYear.disabled = true; inpYear.value = '';
  selDisp.disabled = true; selDisp.innerHTML = '<option value="">Cualquier cilindrada</option>';
  btnSearchV.disabled = true;
  if (!mk) { selModel.innerHTML = '<option value="">— Seleccioná la marca —</option>'; return; }
  try {
    const d = await apiFetch('/api/v1/catalog/compat/models?make=' + encodeURIComponent(mk));
    selModel.innerHTML = '<option value="">— Seleccioná el modelo —</option>'
      + d.items.map(m => '<option value="'+esc(m.name)+'">'+esc(m.name)+(m.body_type?' · '+esc(m.body_type):'')+'</option>').join('');
    selModel.disabled = false;
  } catch(err) {
    selModel.innerHTML = '<option value="">Error al cargar modelos</option>';
  }
});

selModel.addEventListener('change', () => {
  inpYear.disabled = !selModel.value;
  if (!selModel.value) { inpYear.value = ''; btnSearchV.disabled = true; }
  else checkYearAndEnableSearch();
});

inpYear.addEventListener('input', checkYearAndEnableSearch);

function checkYearAndEnableSearch() {
  const y = parseInt(inpYear.value, 10);
  const valid = selModel.value && Number.isFinite(y) && y >= 1960 && y <= 2030;
  btnSearchV.disabled = !valid;
  if (valid) loadDisplacements();
}

async function loadDisplacements() {
  const mk = selMake.value; const md = selModel.value;
  const y = parseInt(inpYear.value, 10);
  if (!mk || !md || !y) return;
  selDisp.disabled = true; selDisp.innerHTML = '<option value="">Cualquier cilindrada</option>';
  try {
    const d = await apiFetch(\`/api/v1/catalog/compat/years?make=\${encodeURIComponent(mk)}&model=\${encodeURIComponent(md)}\`);
    if (d.displacements && d.displacements.length) {
      selDisp.innerHTML = '<option value="">Cualquier cilindrada</option>'
        + d.displacements.map(v => '<option value="'+esc(v)+'">'+esc(v)+' L</option>').join('');
      selDisp.disabled = false;
    }
  } catch(_) {}
}

document.getElementById('vehicle-form').addEventListener('submit', async () => {
  const mk = selMake.value; const md = selModel.value;
  const yr = parseInt(inpYear.value, 10); const disp = selDisp.value || null;
  if (!mk || !md || !yr) return;
  showLoader('vehicle', true); setResults('vehicle', '');
  btnSearchV.disabled = true;
  try {
    let url = \`/api/v1/catalog/compat/search?make=\${encodeURIComponent(mk)}&model=\${encodeURIComponent(md)}&year=\${yr}\`;
    if (disp) url += '&displacement_l=' + encodeURIComponent(disp);
    const d = await apiFetch(url);
    renderCompatResults(d.items, mk, md, yr, disp);
  } catch(err) {
    setResults('vehicle', '<div class="error-msg">&#9888; ' + esc(err.message) + '</div>');
  } finally {
    showLoader('vehicle', false);
    btnSearchV.disabled = false;
  }
});

function renderCompatResults(items, mk, md, yr, disp) {
  if (!items || !items.length) {
    setResults('vehicle', \`<div class="empty-state">
      <div class="icon">&#128663;</div>
      <h3>Sin repuestos para ese vehículo</h3>
      <p>\${esc(mk)} \${esc(md)} \${yr}\${disp?' · '+esc(disp)+'L':''} — No hay productos con compatibilidad registrada.</p>
      <p style="margin-top:.5rem">Probá sin filtro de cilindrada o consultanos directamente.</p>
    </div>\`);
    return;
  }

  const intakes = items.filter(r => r.position === 'INTAKE' || r.position === 'BOTH');
  const exhausts = items.filter(r => r.position === 'EXHAUST' || r.position === 'BOTH');

  const summary = \`<div class="results-header">
    <div>
      <span class="results-count"><strong>\${items.length}</strong> repuesto\${items.length!==1?'s':''} para \${esc(mk)} \${esc(md)} \${yr}\${disp?' · '+esc(disp)+'L':''}</span>
    </div>
    <span class="results-meta">
      \${intakes.length} admisión &nbsp;·&nbsp; \${exhausts.length} escape
    </span>
  </div>\`;

  let html = summary;

  if (intakes.length > 0) {
    html += '<div style="margin:1.25rem 0 .6rem;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--intake)">&#8595; Válvulas de Admisión ('+intakes.length+')</div>';
    html += '<div class="cards-grid">' + intakes.map(r => buildCompatCard(r)).join('') + '</div>';
  }
  if (exhausts.length > 0) {
    html += '<div style="margin:1.5rem 0 .6rem;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--exhaust)">&#8593; Válvulas de Escape ('+exhausts.length+')</div>';
    html += '<div class="cards-grid">' + exhausts.map(r => buildCompatCard(r)).join('') + '</div>';
  }
  const others = items.filter(r => r.position !== 'INTAKE' && r.position !== 'EXHAUST' && r.position !== 'BOTH');
  if (others.length > 0) {
    html += '<div style="margin:1.5rem 0 .6rem;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--txt2)">Otros ('+others.length+')</div>';
    html += '<div class="cards-grid">' + others.map(r => buildCompatCard(r)).join('') + '</div>';
  }
  setResults('vehicle', html);
}

// ──────────────────────────────────────────────────
// Panel: Búsqueda general
// ──────────────────────────────────────────────────
document.getElementById('general-form').addEventListener('submit', async () => {
  const q = document.getElementById('inp-general').value.trim();
  showLoader('general', true); setResults('general', '');
  try {
    const d = await apiFetch('/api/v1/catalog?search=' + encodeURIComponent(q) + '&limit=60');
    if (!d.items || !d.items.length) {
      setResults('general', \`<div class="empty-state"><div class="icon">&#128269;</div><h3>Sin resultados</h3><p>No se encontraron productos para <strong>\${esc(q)}</strong>.</p></div>\`);
    } else {
      let html = \`<div class="results-header"><span class="results-count"><strong>\${d.total ?? d.items.length}</strong> resultado\${(d.total??d.items.length)!==1?'s':''}\${q?' para <em>'+esc(q)+'</em>':''}</span></div>\`;
      html += '<div class="cards-grid">' + d.items.map(r => buildGeneralCard(r)).join('') + '</div>';
      setResults('general', html);
    }
  } catch(err) {
    setResults('general', '<div class="error-msg">&#9888; ' + esc(err.message) + '</div>');
  } finally {
    showLoader('general', false);
  }
});

// Cargar catálogo general al abrir tab
document.querySelector('[data-tab="general"]').addEventListener('click', () => {
  const res = document.getElementById('results-general');
  if (!res.dataset.preloaded) {
    res.dataset.preloaded = '1';
    document.getElementById('general-form').dispatchEvent(new Event('submit'));
  }
});

// ──────────────────────────────────────────────────
// Panel: Por SKU
// ──────────────────────────────────────────────────
document.getElementById('sku-form').addEventListener('submit', async () => {
  const sku = document.getElementById('inp-sku').value.trim().toUpperCase();
  if (!sku) return;
  showLoader('sku', true); setResults('sku', '');
  try {
    const d = await apiFetch('/api/v1/catalog/compat/for-sku?sku=' + encodeURIComponent(sku));
    setResults('sku', buildSkuResultCards(sku, d.items || []));
  } catch(err) {
    setResults('sku', '<div class="error-msg">&#9888; ' + esc(err.message) + '</div>');
  } finally {
    showLoader('sku', false);
  }
});

document.getElementById('inp-sku').addEventListener('input', function() {
  this.value = this.value.toUpperCase();
});
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
function handleCatalogPublicPage(req, res, url) {
  const path = url.pathname || "";
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized !== "/catalogo" && normalized !== "/catalogo") return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return true;
  }

  if (!isEnabled()) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><meta charset=utf-8><title>No disponible</title><p>El catálogo público está desactivado (<code>CATALOG_PAGE_ENABLED=0</code>).</p>"
    );
    return true;
  }

  const apiKey = process.env.FRONTEND_API_KEY || "";
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><meta charset=utf-8><title>No disponible</title><p>Define <code>FRONTEND_API_KEY</code> en el servidor para activar el catálogo público.</p>"
    );
    return true;
  }

  const html = buildHtml(apiKey);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

module.exports = { handleCatalogPublicPage };
