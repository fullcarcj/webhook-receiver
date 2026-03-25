/**
 * Página HTML de administración de plantillas post-venta (post_sale_messages).
 * Límite 350 caracteres (API Mercado Libre mensaje libre post-venta).
 */
const POST_SALE_BODY_MAX = 350;

function renderPostSaleMessagesPage(rows, esc) {
  const { escapeHtml, escapeAttr, escapeTextareaContent } = esc;
  const cardsHtml = rows
    .map((r) => {
      const title =
        r.name != null && String(r.name).trim() !== ""
          ? escapeHtml(r.name)
          : escapeHtml("Sin nombre");
      const rawBody = r.body != null ? String(r.body) : "";
      const bodyLen = Math.min(rawBody.length, POST_SALE_BODY_MAX);
      const bodyForTa =
        rawBody.length > POST_SALE_BODY_MAX
          ? rawBody.slice(0, POST_SALE_BODY_MAX)
          : rawBody;
      const longWarn =
        rawBody.length > POST_SALE_BODY_MAX
          ? `<p class="warn-long">El texto guardado tenía ${rawBody.length} caracteres; se muestran solo los primeros ${POST_SALE_BODY_MAX}. Al guardar se persistirá este límite.</p>`
          : "";
      return `<section class="card" data-msg-id="${r.id}">
  <h2 class="card-title">${title}</h2>
  <p class="meta muted">id ${r.id} · creado ${escapeHtml(r.created_at)} · actualizado ${escapeHtml(r.updated_at)}</p>
  <label>Nombre</label>
  <input type="text" class="msg-name" value="${escapeAttr(r.name)}" />
  <label>Texto <span class="char-count" aria-live="polite">${bodyLen} / ${POST_SALE_BODY_MAX}</span></label>
  ${longWarn}
  <textarea class="msg-body" maxlength="${POST_SALE_BODY_MAX}" rows="14">${escapeTextareaContent(bodyForTa)}</textarea>
  <p>
    <button type="button" class="btn btn-save" data-id="${r.id}">Guardar</button>
    <button type="button" class="btn btn-del" data-id="${r.id}">Eliminar</button>
  </p>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mensajes post-venta</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; max-width: 720px; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    .card { border: 1px solid #38444d; border-radius: 8px; padding: 1rem 1.1rem; margin-top: 1.25rem; background: #192734; }
    .card-title { font-size: 1rem; margin: 0 0 0.35rem 0; }
    .meta { font-size: 0.8rem; margin: 0 0 0.75rem 0; }
    label { display: block; font-size: 0.8rem; color: #8b98a5; margin-top: 0.5rem; }
    .char-count { float: right; font-weight: 600; color: #00ba7c; }
    .char-count.at-limit { color: #f4212e; }
    .char-count.near-limit { color: #ffd400; }
    .warn-long { font-size: 0.8rem; color: #ffd400; margin: 0.35rem 0 0.5rem 0; }
    input.msg-name { width: 100%; max-width: 420px; padding: 0.4rem 0.5rem; background: #0f1419; border: 1px solid #38444d; color: #e7e9ea; border-radius: 4px; }
    textarea.msg-body { width: 100%; box-sizing: border-box; padding: 0.5rem 0.55rem; background: #0f1419; border: 1px solid #38444d; color: #e7e9ea; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem; }
    .btn { margin-right: 0.5rem; padding: 0.35rem 0.75rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.9rem; }
    .btn-save { background: #1d9bf0; color: #fff; }
    .btn-del { background: #536471; color: #e7e9ea; }
    .new-block { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #38444d; }
  </style>
</head>
<body>
  <h1>Plantillas post-venta</h1>
  <p class="lead">${rows.length} plantilla(s). Orden por <strong>id</strong>: la 1.ª es el mensaje principal; la 2.ª y 3.ª se usan como adicionales si en el servidor defines <code>ML_POST_SALE_TOTAL_MESSAGES=2</code> o <code>3</code> (y <code>ML_AUTO_SEND_POST_SALE=1</code>). Placeholders: <code>{{order_id}}</code> <code>{{buyer_id}}</code> <code>{{seller_id}}</code>. Pausa entre envíos: <code>ML_POST_SALE_EXTRA_DELAY_MS</code> (ms). Máximo <strong>${POST_SALE_BODY_MAX} caracteres</strong> por mensaje (API ML). Tabla <code>post_sale_messages</code>. API: <code>GET ?format=json</code>. POST JSON <code>{"name","body"}</code> crea; <code>{"id","name","body"}</code> actualiza. DELETE <code>?id=</code>.</p>
  ${cardsHtml || "<p class=\"lead\">No hay plantillas.</p>"}
  <div class="new-block">
    <h2 class="card-title">Nueva plantilla</h2>
    <label>Nombre</label>
    <input type="text" id="new-name" placeholder="Ej. Predeterminado" />
    <label>Texto <span id="new-char-count" class="char-count" aria-live="polite">0 / ${POST_SALE_BODY_MAX}</span></label>
    <textarea id="new-body" maxlength="${POST_SALE_BODY_MAX}" rows="8" placeholder="Contenido del mensaje (máx. ${POST_SALE_BODY_MAX} caracteres)…"></textarea>
    <p><button type="button" class="btn btn-save" id="btn-create">Crear</button></p>
  </div>
  <script>
(function () {
  var MAX = ${POST_SALE_BODY_MAX};
  var q = new URLSearchParams(location.search);
  var k = q.get("k") || "";
  var base = "/mensajes-postventa?k=" + encodeURIComponent(k);
  function post(json) {
    return fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(json),
    }).then(function (r) {
      return r.json();
    });
  }
  function updateCount(span, len) {
    if (!span) return;
    span.textContent = len + " / " + MAX;
    span.classList.remove("near-limit", "at-limit");
    if (len >= MAX) span.classList.add("at-limit");
    else if (len >= MAX - 40) span.classList.add("near-limit");
  }
  function wireTextarea(ta) {
    var span;
    if (ta.id === "new-body") {
      span = document.getElementById("new-char-count");
    } else {
      var card = ta.closest(".card");
      span = card ? card.querySelector("label .char-count") : null;
    }
    function sync() {
      var v = ta.value;
      if (v.length > MAX) {
        ta.value = v.slice(0, MAX);
        v = ta.value;
      }
      updateCount(span, v.length);
    }
    ta.addEventListener("input", sync);
    ta.addEventListener("paste", function () {
      setTimeout(sync, 0);
    });
    sync();
  }
  document.querySelectorAll("textarea.msg-body, #new-body").forEach(wireTextarea);
  document.querySelectorAll(".btn-save").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-id");
      if (!id) return;
      var card = btn.closest(".card");
      var name = card.querySelector(".msg-name").value;
      var body = card.querySelector(".msg-body").value;
      post({ id: Number(id), name: name, body: body }).then(function (j) {
        alert(j.ok ? "Guardado" : (j.error || "Error"));
        if (j.ok) location.reload();
      });
    });
  });
  document.querySelectorAll(".btn-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!confirm("¿Eliminar esta plantilla?")) return;
      var id = btn.getAttribute("data-id");
      fetch(base + "&id=" + encodeURIComponent(id), { method: "DELETE" })
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          alert(j.ok ? "Eliminado" : (j.error || "Error"));
          if (j.ok) location.reload();
        });
    });
  });
  var createBtn = document.getElementById("btn-create");
  if (createBtn) {
    createBtn.addEventListener("click", function () {
      var name = document.getElementById("new-name").value;
      var body = document.getElementById("new-body").value;
      post({ name: name, body: body }).then(function (j) {
        alert(j.ok ? "Creado" : (j.error || "Error"));
        if (j.ok) location.reload();
      });
    });
  }
})();
  </script>
</body>
</html>`;
}

module.exports = { renderPostSaleMessagesPage };
