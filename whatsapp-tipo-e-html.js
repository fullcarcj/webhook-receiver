/**
 * Página HTML de administración de mensajes WhatsApp tipo E (tabla `ml_whatsapp_tipo_e_config`).
 */
function renderWhatsappTipoEPage(row, esc) {
  const { escapeHtml, escapeAttr, escapeTextareaContent } = esc;
  const r = row || {};
  const imageUrl = r.image_url != null ? String(r.image_url) : "";
  const imageCaption = r.image_caption != null ? String(r.image_caption) : "";
  const delayMs = r.delay_ms != null && r.delay_ms !== "" ? String(r.delay_ms) : "";
  const lat = r.location_lat != null && r.location_lat !== "" ? String(r.location_lat) : "";
  const lng = r.location_lng != null && r.location_lng !== "" ? String(r.location_lng) : "";
  const locName = r.location_name != null ? String(r.location_name) : "";
  const locAddr = r.location_address != null ? String(r.location_address) : "";
  const mapsUrl = r.location_maps_url != null ? String(r.location_maps_url) : "";
  const chatText = r.location_chat_text != null ? String(r.location_chat_text) : "";
  const updatedAt = r.updated_at != null ? escapeHtml(String(r.updated_at)) : "—";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mensajes WhatsApp tipo E</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; max-width: 820px; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; line-height: 1.45; }
    label { display: block; font-size: 0.8rem; color: #8b98a5; margin-top: 0.75rem; }
    input[type="text"], input[type="number"] { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0.45rem 0.5rem; background: #0f1419; border: 1px solid #38444d; color: #e7e9ea; border-radius: 4px; font-size: 0.88rem; }
    textarea { width: 100%; box-sizing: border-box; padding: 0.5rem 0.55rem; background: #0f1419; border: 1px solid #38444d; color: #e7e9ea; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    @media (max-width: 640px) { .row2 { grid-template-columns: 1fr; } }
    .btn { margin-top: 1.25rem; padding: 0.4rem 0.9rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.9rem; background: #1d9bf0; color: #fff; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .muted { color: #71767b; font-size: 0.82rem; }
    .ok { color: #00ba7c; font-size: 0.88rem; margin-top: 0.75rem; }
    .err { color: #f4212e; font-size: 0.88rem; margin-top: 0.75rem; }
    section { border: 1px solid #38444d; border-radius: 8px; padding: 1rem 1.1rem; margin-top: 1rem; background: #192734; }
    h2 { font-size: 1rem; margin: 0 0 0.5rem 0; }
  </style>
</head>
<body>
  <h1>WhatsApp tipo E (orden recibida)</h1>
  <p class="lead">Una sola configuración en <code>ml_whatsapp_tipo_e_config</code>. Si un campo queda vacío al guardar, se borra en BD y en el envío se usan variables de entorno o valores por defecto del servidor. Placeholders paso 2: <code>{{order_id}}</code> <code>{{buyer_id}}</code> <code>{{seller_id}}</code> <code>{{status}}</code> <code>{{maps_url}}</code>. Mensajes tipo F (pregunta + opcional E×2): <code>/mensajes-tipo-f-whatsapp?k=…</code>. Última actualización: <strong>${updatedAt}</strong>.</p>

  <section>
    <h2>Paso 1 — Imagen</h2>
    <label for="image_url">URL de la imagen (HTTPS pública)</label>
    <input type="text" id="image_url" value="${escapeAttr(imageUrl)}" placeholder="https://…" autocomplete="off"/>
    <label for="image_caption">Leyenda / texto sobre la imagen</label>
    <textarea id="image_caption" rows="16" placeholder="Texto FULLCAR…">${escapeTextareaContent(imageCaption)}</textarea>
  </section>

  <section>
    <h2>Paso 2 — Ubicación</h2>
    <div class="row2">
      <div>
        <label for="location_lat">Latitud</label>
        <input type="text" id="location_lat" value="${escapeAttr(lat)}" placeholder="10.4904006" inputmode="decimal"/>
      </div>
      <div>
        <label for="location_lng">Longitud</label>
        <input type="text" id="location_lng" value="${escapeAttr(lng)}" placeholder="-66.8764996" inputmode="decimal"/>
      </div>
    </div>
    <label for="location_name">Nombre del pin</label>
    <input type="text" id="location_name" value="${escapeAttr(locName)}" placeholder="FULLCAR CJ CA"/>
    <label for="location_address">Dirección (pin)</label>
    <textarea id="location_address" rows="3" placeholder="CALLE COROMOTO…">${escapeTextareaContent(locAddr)}</textarea>
    <label for="location_maps_url">Enlace Google Maps (placeholder <code>{{maps_url}}</code>)</label>
    <input type="text" id="location_maps_url" value="${escapeAttr(mapsUrl)}" placeholder="https://www.google.com/maps/…"/>
    <label for="location_chat_text">Texto del chat (paso 2, con {{maps_url}})</label>
    <textarea id="location_chat_text" rows="10" placeholder="">{{escapeTextareaContent(chatText)}}</textarea>
  </section>

  <section>
    <h2>Otro</h2>
    <label for="delay_ms">Pausa entre envío imagen y ubicación (ms)</label>
    <input type="number" id="delay_ms" value="${escapeAttr(delayMs)}" placeholder="800" min="0" max="60000" step="1"/>
  </section>

  <p><button type="button" class="btn" id="btn-save">Guardar</button></p>
  <p id="msg" class="muted" aria-live="polite"></p>

  <script>
(function () {
  var q = new URLSearchParams(location.search);
  var k = q.get("k") || "";
  var base = "/mensajes-tipo-e-whatsapp?k=" + encodeURIComponent(k);
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }
  function numOrNull(id) {
    var v = val(id).trim();
    if (v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  document.getElementById("btn-save").addEventListener("click", function () {
    var btn = this;
    var msg = document.getElementById("msg");
    btn.disabled = true;
    msg.textContent = "Guardando…";
    msg.className = "muted";
    var payload = {
      image_url: val("image_url").trim() || null,
      image_caption: val("image_caption") || null,
      delay_ms: numOrNull("delay_ms"),
      location_lat: numOrNull("location_lat"),
      location_lng: numOrNull("location_lng"),
      location_name: val("location_name").trim() || null,
      location_address: val("location_address").trim() || null,
      location_maps_url: val("location_maps_url").trim() || null,
      location_chat_text: val("location_chat_text") || null
    };
    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) {
          msg.textContent = "Guardado correctamente. Recargá la página para ver la fecha de actualización.";
          msg.className = "ok";
        } else {
          msg.textContent = "Error: " + (j.error || "desconocido");
          msg.className = "err";
        }
      })
      .catch(function (e) {
        msg.textContent = String(e.message || e);
        msg.className = "err";
      })
      .finally(function () {
        btn.disabled = false;
      });
  });
})();
  </script>
</body>
</html>`;
}

module.exports = {
  renderWhatsappTipoEPage,
};
