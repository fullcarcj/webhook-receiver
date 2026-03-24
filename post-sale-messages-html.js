/**
 * Página HTML de administración de plantillas post-venta (post_sale_messages).
 */
function renderPostSaleMessagesPage(rows, esc) {
  const { escapeHtml, escapeAttr, escapeTextareaContent } = esc;
  const cardsHtml = rows
    .map((r) => {
      const title =
        r.name != null && String(r.name).trim() !== ""
          ? escapeHtml(r.name)
          : escapeHtml("Sin nombre");
      return `<section class="card" data-msg-id="${r.id}">
  <h2 class="card-title">${title}</h2>
  <p class="meta muted">id ${r.id} · creado ${escapeHtml(r.created_at)} · actualizado ${escapeHtml(r.updated_at)}</p>
  <label>Nombre</label>
  <input type="text" class="msg-name" value="${escapeAttr(r.name)}" />
  <label>Texto</label>
  <textarea class="msg-body" rows="14">${escapeTextareaContent(r.body)}</textarea>
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
  <p class="lead">${rows.length} plantilla(s). Tabla <code>post_sale_messages</code>. API: <code>GET ?format=json</code>. POST JSON <code>{"name","body"}</code> crea; <code>{"id","name","body"}</code> actualiza. DELETE <code>?id=</code>.</p>
  ${cardsHtml || "<p class=\"lead\">No hay plantillas.</p>"}
  <div class="new-block">
    <h2 class="card-title">Nueva plantilla</h2>
    <label>Nombre</label>
    <input type="text" id="new-name" placeholder="Ej. Predeterminado" />
    <label>Texto</label>
    <textarea id="new-body" rows="8" placeholder="Contenido del mensaje…"></textarea>
    <p><button type="button" class="btn btn-save" id="btn-create">Crear</button></p>
  </div>
  <script>
(function () {
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
