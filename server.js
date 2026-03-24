require("./load-env-local");
const http = require("http");
const pkg = require("./package.json");
const {
  getAccessToken,
  getAccessTokenForMlUser,
  mercadoLibreGetForUser,
  warmAllMlAccountsRefresh,
  getTokenStatus,
  getTokenStatusForMlUser,
} = require("./oauth-token");
const {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
  upsertMlAccount,
  listMlAccounts,
  deleteMlAccount,
} = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
const REG_PATH = process.env.REG_PATH || "/reg";
const WEBHOOK_SAVE_DB = process.env.WEBHOOK_SAVE_DB === "1";

function matchesRegPath(pathname) {
  if (pathname === REG_PATH) return true;
  if (pathname === "/reg.php") return true;
  return false;
}

function isCuentasPath(pathname) {
  return pathname === "/cuentas" || pathname === "/cuentas/";
}

function rejectIngestSecret(req, res) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  if (req.headers["x-ingest-secret"] !== secret) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }
  return false;
}

function rejectAdminSecret(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
    return true;
  }
  if (req.headers["x-admin-secret"] !== secret) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }
  return false;
}

/** URLs destino (hasta 4 POST salientes). Usa POST_URL_1…POST_URL_4 o POST_WEBHOOK_URLS=url1,url2,… */
function getForwardPostUrls() {
  const fromList = (process.env.POST_WEBHOOK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const singles = [1, 2, 3, 4]
    .map((n) => process.env[`POST_URL_${n}`])
    .filter(Boolean);
  const merged = fromList.length ? fromList : singles;
  return merged.slice(0, 4);
}

function buildForwardHeaders() {
  const h = { "Content-Type": "application/json; charset=utf-8" };
  const bearer = process.env.POST_BEARER_TOKEN;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

/** Dispara hasta 4 POST en segundo plano (no bloquea la respuesta al webhook entrante). */
function forwardWebhookToTargets(body) {
  const urls = getForwardPostUrls();
  if (!urls.length) return;

  const payload = JSON.stringify(body);
  const headers = buildForwardHeaders();

  setImmediate(() => {
    Promise.allSettled(
      urls.map((url, index) =>
        fetch(url, { method: "POST", headers, body: payload }).then((res) => {
          if (!res.ok) {
            throw new Error(`POST #${index + 1} ${res.status} ${url}`);
          }
        })
      )
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`[forward POST #${i + 1}]`, r.reason?.message || r.reason);
        } else {
          console.log(`[forward POST #${i + 1}] ok`);
        }
      });
    });
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined || s === "") return "—";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new SyntaxError("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function isOrdersV2Notification(body) {
  return (
    body &&
    typeof body === "object" &&
    typeof body.topic === "string" &&
    typeof body.resource === "string" &&
    (body.topic === "orders_v2" || body.topic.startsWith("orders"))
  );
}

function logWebhook(body, req) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    ip: req.socket.remoteAddress,
    topic: body.topic,
    resource: body.resource,
    user_id: body.user_id,
    application_id: body.application_id,
    _id: body._id,
  });
  console.log("[webhook]", line);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "webhook-receiver",
        version: pkg.version,
        webhook: WEBHOOK_PATH,
        multi_cuentas_ml:
          "POST /admin/ml-accounts (cabecera X-Admin-Secret) registra refresh por ml_user_id",
        oauth_token_status:
          "GET /oauth/token-status  o  ?ml_user_id=  (token enmascarado, sin secreto completo)",
        cuentas_ml:
          "GET /cuentas?k=ADMIN_SECRET (lista cuentas; mismo valor que variable ADMIN_SECRET)",
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/status") {
    const hasCreds = Boolean(
      (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
        (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
        (process.env.OAUTH_REFRESH_TOKEN ||
          process.env.ML_REFRESH_TOKEN ||
          process.env.OAUTH_TOKEN_FILE)
    );
    if (!hasCreds) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "no configurado" }));
      return;
    }
    try {
      await getAccessToken();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "conectado", ok: true }));
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "error", ok: false, message: e.message }));
    }
    return;
  }

  /** Token activo: solo vista enmascarada + caducidad (nunca el string completo). */
  if (req.method === "GET" && url.pathname === "/oauth/token-status") {
    const mlUid = url.searchParams.get("ml_user_id");
    try {
      if (mlUid !== null && mlUid !== "") {
        const id = Number(mlUid);
        if (!Number.isFinite(id) || id <= 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "ml_user_id invalido" }));
          return;
        }
        await getAccessTokenForMlUser(id);
        const st = getTokenStatusForMlUser(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            modo: "cuenta_registrada",
            nota: "access_token enmascarado; no se muestra el valor completo por seguridad",
            ...st,
          })
        );
        return;
      }

      const hasSingle = Boolean(
        (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
          (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
          (process.env.OAUTH_REFRESH_TOKEN ||
            process.env.ML_REFRESH_TOKEN ||
            process.env.OAUTH_TOKEN_FILE)
      );
      if (!hasSingle) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            hint: "Configura refresh en env, o usa /oauth/token-status?ml_user_id=NUMERO (cuenta en ml_accounts)",
          })
        );
        return;
      }

      await getAccessToken();
      const st = getTokenStatus();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          modo: "cuenta_env",
          nota: "access_token enmascarado; no se muestra el valor completo por seguridad",
          ...st,
        })
      );
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return;
  }

  /** Lista de cuentas ML registradas (HTML o JSON); protegida con ?k= igual a ADMIN_SECRET. */
  if (req.method === "GET" && isCuentasPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Cuentas</title><p>Define la variable de entorno <code>ADMIN_SECRET</code> en el servidor y reinicia.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Cuentas</title><p>Acceso denegado. Abre <code>/cuentas?k=TU_CLAVE</code> (la misma clave que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    let accounts;
    try {
      accounts = listMlAccounts();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    const enriched = await Promise.all(
      accounts.map(async (a) => {
        const uid = a.ml_user_id;
        try {
          await getAccessTokenForMlUser(uid);
          const st = getTokenStatusForMlUser(uid);
          return {
            ml_user_id: uid,
            nickname: a.nickname,
            updated_at: a.updated_at,
            status: "ok",
            access_token_preview: st.access_token_preview || st.mask,
            expiresAtIso: st.expiresAtIso,
            secondsRemaining: st.secondsRemaining,
            error: null,
          };
        } catch (err) {
          return {
            ml_user_id: uid,
            nickname: a.nickname,
            updated_at: a.updated_at,
            status: "error",
            access_token_preview: null,
            expiresAtIso: null,
            secondsRemaining: null,
            error: err.message || String(err),
          };
        }
      })
    );

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, accounts: enriched }));
      return;
    }

    const rows = enriched
      .map((row) => {
        const ok = row.status === "ok";
        const badge = ok
          ? '<span class="badge ok">Conectado</span>'
          : `<span class="badge err">Error</span>`;
        const tokenCell = ok
          ? `<code class="tok">${escapeHtml(row.access_token_preview)}</code>`
          : `<span class="err-msg">${escapeHtml(row.error)}</span>`;
        const caduca = ok ? escapeHtml(row.expiresAtIso) : "—";
        const seg = ok && row.secondsRemaining != null ? escapeHtml(row.secondsRemaining) : "—";
        return `<tr>
  <td>${escapeHtml(row.ml_user_id)}</td>
  <td>${escapeHtml(row.nickname)}</td>
  <td>${badge}</td>
  <td>${tokenCell}</td>
  <td>${caduca}</td>
  <td>${seg}</td>
  <td class="muted">${escapeHtml(row.updated_at)}</td>
</tr>`;
      })
      .join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Cuentas Mercado Libre</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; max-width: 1100px; margin-top: 1rem; font-size: 0.9rem; }
    th, td { border: 1px solid #38444d; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #71767b; font-size: 0.85rem; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
    .badge.ok { background: #003920; color: #00d395; }
    .badge.err { background: #3b1219; color: #f4212e; }
    .tok { font-size: 0.8rem; word-break: break-all; color: #c4cfda; }
    .err-msg { font-size: 0.8rem; color: #f4212e; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Cuentas conectadas</h1>
  <p class="lead">${accounts.length} cuenta(s). Token en vista previa; refresh no se muestra.</p>
  <table>
    <thead><tr>
      <th>user_id</th><th>Nickname</th><th>Estado</th><th>Token (enmascarado)</th>
      <th>Caduca (UTC)</th><th>Seg. restantes</th><th>Actualizado (DB)</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No hay cuentas registradas.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === WEBHOOK_PATH) {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
      return;
    }

    logWebhook(body, req);

    if (
      process.env.ML_WEBHOOK_FETCH_ORDER === "1" &&
      body.user_id &&
      body.resource
    ) {
      setImmediate(() => {
        mercadoLibreGetForUser(body.user_id, body.resource).catch((e) =>
          console.error("[ml] API cuenta user_id=%s: %s", body.user_id, e.message)
        );
      });
    }

    if (WEBHOOK_SAVE_DB) {
      try {
        const id = insertWebhook(body);
        console.log("[db] guardado id=%s", id);
      } catch (e) {
        console.error("[db]", e.message);
      }
    }

    if (!isOrdersV2Notification(body)) {
      forwardWebhookToTargets(body);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, received: true, note: "payload sin formato orders_v2 esperado" }));
      return;
    }

    forwardWebhookToTargets(body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, received: true }));
    return;
  }

  /** Varias cuentas ML: registrar refresh por user_id (misma app, distintos vendedores). */
  if (url.pathname === "/admin/ml-accounts") {
    if (req.method === "GET") {
      if (rejectAdminSecret(req, res)) return;
      try {
        const accounts = listMlAccounts();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, accounts }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === "POST") {
      if (rejectAdminSecret(req, res)) return;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const mlUid = Number(body.ml_user_id);
      const rt = body.refresh_token;
      if (!Number.isFinite(mlUid) || mlUid <= 0 || typeof rt !== "string" || !rt.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "requiere ml_user_id (numero) y refresh_token",
          })
        );
        return;
      }
      try {
        upsertMlAccount(mlUid, rt.trim(), typeof body.nickname === "string" ? body.nickname : null);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ml_user_id: mlUid }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      const uid = Number(url.searchParams.get("ml_user_id"));
      if (!Number.isFinite(uid) || uid <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?ml_user_id=123" }));
        return;
      }
      try {
        const deleted = deleteMlAccount(uid);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted: deleted > 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  /** Sustituye al antiguo reg.php: POST guarda JSON, GET lista, DELETE borra por id(s). */
  if (matchesRegPath(url.pathname)) {
    if (req.method === "POST") {
      if (rejectIngestSecret(req, res)) return;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      try {
        const id = insertWebhook(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET") {
      if (rejectIngestSecret(req, res)) return;
      const limit = url.searchParams.get("limit");
      try {
        const items = listWebhooks(limit);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, items }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "DELETE") {
      if (rejectIngestSecret(req, res)) return;
      const idsParam = url.searchParams.get("ids") || url.searchParams.get("id");
      if (!idsParam || !idsParam.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?ids=1,2 o ?id=1" }));
        return;
      }
      const ids = idsParam
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0);
      try {
        const deleted = deleteWebhooks(ids);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "no encontrado" }));
});

server.listen(PORT, "0.0.0.0", () => {
  const forwards = getForwardPostUrls();
  console.log(`Escuchando en http://localhost:${PORT} (todas las interfaces, para tunel loclx/ngrok)`);
  console.log(`Webhook POST: http://localhost:${PORT}${WEBHOOK_PATH}`);
  console.log(
    `Registro (DB): POST|GET|DELETE http://localhost:${PORT}${REG_PATH} o .../reg.php`
  );
  if (forwards.length) {
    console.log(`Reenvío: ${forwards.length} POST(s) configurados`);
  } else {
    console.log("Reenvío: ninguno (define POST_URL_1…4 o POST_WEBHOOK_URLS)");
  }

  const hasOAuth = Boolean(
    (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
      (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
      (process.env.OAUTH_REFRESH_TOKEN ||
        process.env.ML_REFRESH_TOKEN ||
        process.env.OAUTH_TOKEN_FILE)
  );
  if (hasOAuth) {
    getAccessToken()
      .then(() => console.log("OAuth: conexión OK (access_token listo)"))
      .catch((e) => console.error("OAuth:", e.message));
  }
  warmAllMlAccountsRefresh();
  if (process.env.ADMIN_SECRET) {
    console.log(`Cuentas ML: GET|POST|DELETE http://localhost:${PORT}/admin/ml-accounts (cabecera X-Admin-Secret)`);
    console.log(`Cuentas (navegador): http://localhost:${PORT}/cuentas?k=TU_ADMIN_SECRET`);
  }
  console.log(`Token (enmascarado): GET http://localhost:${PORT}/oauth/token-status`);
});
