"use strict";

const { requireAdminOrPermission } = require("../utils/authMiddleware");

/**
 * Página mínima de prueba WMS (solo GET). Requiere `?k=` o `?secret=` igual a ADMIN_SECRET
 * (o cabecera X-Admin-Secret vía fetch desde consola).
 */
async function handleWmsTestPage(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/wms-test") return false;

  if (!await requireAdminOrPermission(req, res, 'wms')) {
    return true;
  }

  const k = url.searchParams.get("k") || url.searchParams.get("secret") || "";
  const qp = (obj) => {
    const sp = new URLSearchParams();
    Object.entries(obj || {}).forEach(([key, val]) => {
      if (val != null && String(val) !== "") sp.set(key, String(val));
    });
    if (k) sp.set("k", k);
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WMS — pruebas</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; }
    code { background: #f4f4f4; padding: 0.1rem 0.35rem; border-radius: 4px; }
    a { word-break: break-all; }
    ul { line-height: 1.7; }
  </style>
</head>
<body>
  <h1>WMS — enlaces de prueba</h1>
  <p>Abriste con secreto válido. Los enlaces siguientes reutilizan el mismo <code>k</code> en query.</p>
  <ul>
    <li><a href="/api/wms/warehouses${qp({})}">GET /api/wms/warehouses</a></li>
    <li><a href="/api/wms/warehouses/1/bins${qp({})}">GET /api/wms/warehouses/1/bins</a></li>
    <li><a href="/api/wms/picking${qp({ warehouse_id: "1" })}">GET /api/wms/picking?warehouse_id=1</a> (ajustar id)</li>
    <li><a href="/api/wms/movements${qp({ limit: "10" })}">GET /api/wms/movements?limit=10</a></li>
  </ul>
  <p><strong>POST</strong> (ajuste, reserva, etc.): usar curl o consola del navegador con cabecera <code>X-Admin-Secret</code> o repetir <code>k</code> en la query si <code>ADMIN_SECRET_QUERY_AUTH</code> no está en 0.</p>
  <pre>fetch('/api/wms/stock/adjust?k=…', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    bin_id: 1, product_sku: 'TU-SKU', delta: 1,
    reason: 'ADJUSTMENT_UP', reference_type: 'manual', reference_id: 'test'
  })
}).then(r => r.json()).then(console.log)</pre>
  <p>Si ves 403, falta <code>?k=TU_ADMIN_SECRET</code> en la URL o la cabecera admin.</p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

module.exports = { handleWmsTestPage };
