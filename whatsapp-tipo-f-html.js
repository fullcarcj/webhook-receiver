/**
 * Página HTML de administración de mensajes WhatsApp tipo F (`ml_whatsapp_tipo_f_config`).
 */
function renderWhatsappTipoFPage(row, esc, options = {}) {
  const { escapeHtml, escapeAttr, escapeTextareaContent } = esc;
  const k = options.k != null ? String(options.k) : "";
  const r = row || {};
  const body = r.body_template != null ? String(r.body_template) : "";
  const follow =
    r.follow_with_tipo_e === false || r.follow_with_tipo_e === 0 ? false : true;
  const updatedAt = r.updated_at != null ? escapeHtml(String(r.updated_at)) : "—";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mensajes WhatsApp tipo F</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; max-width: 820px; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; line-height: 1.45; }
    label { display: block; font-size: 0.8rem; color: #8b98a5; margin-top: 0.75rem; }
    textarea { width: 100%; box-sizing: border-box; padding: 0.5rem 0.55rem; background: #0f1419; border: 1px solid #38444d; color: #e7e9ea; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem; min-height: 14rem; }
    .btn { margin-top: 1.25rem; padding: 0.4rem 0.9rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.9rem; background: #1d9bf0; color: #fff; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .muted { color: #71767b; font-size: 0.82rem; }
    .ok { color: #00ba7c; font-size: 0.88rem; margin-top: 0.75rem; }
    .err { color: #f4212e; font-size: 0.88rem; margin-top: 0.75rem; }
    section { border: 1px solid #38444d; border-radius: 8px; padding: 1rem 1.1rem; margin-top: 1rem; background: #192734; }
    h2 { font-size: 1rem; margin: 0 0 0.5rem 0; }
    .row-check { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; }
    .row-check input { width: auto; }
    a { color: #1d9bf0; }
  </style>
</head>
<body>
  <h1>WhatsApp tipo F (pregunta → texto + opcional E×2)</h1>
  <p class="lead">Una sola configuración en <code>ml_whatsapp_tipo_f_config</code>. Los datos <strong>{{name}}</strong> (comprador), <strong>{{title}}</strong> y <strong>{{price}}</strong> salen de <code>ml_buyers</code> y del ítem MLV (GET <code>/items</code> o caché <code>ml_listings</code>). Tras el mensaje F, si está marcado, se envían los <strong>dos pasos E</strong> (misma config que <a href="/mensajes-tipo-e-whatsapp?k=${escapeAttr(k)}">tipo E</a>). <strong>Logs:</strong> <a href="/envios-whatsapp-tipo-e?k=${escapeAttr(k)}&amp;kind=all">envíos Wasender E/F</a>. Última actualización: <strong>${updatedAt}</strong>.</p>

  <section>
    <h2>Texto del mensaje F</h2>
    <label for="body_template">Plantilla (placeholders <code>{{name}}</code> <code>{{title}}</code> <code>{{price}}</code> <code>{{question_id}}</code> <code>{{item_id}}</code> <code>{{buyer_id}}</code> <code>{{seller_id}}</code>)</label>
    <textarea id="body_template" placeholder="">${escapeTextareaContent(body)}</textarea>
    <div class="row-check">
      <input type="checkbox" id="follow_with_tipo_e" ${follow ? "checked" : ""}/>
      <label for="follow_with_tipo_e" style="margin-top:0">Después del F, enviar los dos mensajes tipo E (imagen + ubicación) al mismo teléfono</label>
    </div>
  </section>

  <p><button type="button" class="btn" id="btn-save">Guardar</button></p>
  <p id="msg" class="muted" aria-live="polite"></p>

  <script>
(function () {
  var q = new URLSearchParams(location.search);
  var k = q.get("k") || "";
  var base = "/mensajes-tipo-f-whatsapp?k=" + encodeURIComponent(k);
  document.getElementById("btn-save").addEventListener("click", function () {
    var btn = this;
    var msg = document.getElementById("msg");
    btn.disabled = true;
    msg.textContent = "Guardando…";
    msg.className = "muted";
    var payload = {
      body_template: document.getElementById("body_template").value.trim() || null,
      follow_with_tipo_e: document.getElementById("follow_with_tipo_e").checked
    };
    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok && x.j && x.j.ok) {
          msg.textContent = "Guardado.";
          msg.className = "ok";
        } else {
          msg.textContent = (x.j && x.j.error) ? x.j.error : "Error";
          msg.className = "err";
        }
      })
      .catch(function () {
        msg.textContent = "Error de red";
        msg.className = "err";
      })
      .finally(function () { btn.disabled = false; });
  });
})();
  </script>
</body>
</html>`;
}

module.exports = { renderWhatsappTipoFPage };
