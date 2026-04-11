"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { ensureAdmin } = require("../middleware/adminAuth");
const { sendAiReplyToCustomer, logAiResponse, providerAuditTipoM, isForceSend } = require("../services/aiResponder");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_responder_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 128 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

async function getStats() {
  const today = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE ai_reply_status = 'ai_replied') AS auto_sent,
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review') AS needs_review,
      COUNT(*) FILTER (WHERE ai_reply_status = 'processing') AS processing,
      COUNT(*) FILTER (WHERE ai_reply_status IN ('pending_ai_reply','pending_receipt_confirm')) AS pending,
      COUNT(*) FILTER (WHERE ai_reply_status = 'skipped') AS skipped
    FROM crm_messages
    WHERE created_at >= CURRENT_DATE
      AND ai_reply_status IS NOT NULL
  `);
  const logc = await pool.query(`
    SELECT action_taken, COUNT(*)::int AS n
    FROM ai_response_log
    WHERE created_at >= CURRENT_DATE
    GROUP BY action_taken
  `);
  let prov = null;
  try {
    const { rows } = await pool.query(
      `SELECT provider_id, enabled, health_status FROM provider_settings WHERE provider_id = 'GROQ_LLAMA'`
    );
    prov = rows[0] || null;
  } catch (_) {
    prov = { provider_id: "GROQ_LLAMA", enabled: !!process.env.GROQ_API_KEY, health_status: "env" };
  }
  return {
    ok: true,
    ai_responder_enabled: String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1",
    confidence_min: parseInt(process.env.AI_RESPONDER_CONFIDENCE_MIN || "85", 10) || 85,
    force_send: isForceSend(),
    tipo_m_mode: "plantilla + context_line (IA no elige flujo)",
    today_messages: today.rows[0] || {},
    today_log_by_action: Object.fromEntries(logc.rows.map((r) => [r.action_taken, r.n])),
    provider: prov,
  };
}

async function handleApprove(req, res, id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_text, m.customer_id, m.chat_id
     FROM crm_messages m
     WHERE m.id = $1 AND m.ai_reply_status = 'needs_human_review'`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const m = rows[0];
  const text = m.ai_reply_text;
  if (!text || !String(text).trim()) {
    writeJson(res, 400, { ok: false, error: "no_ai_reply_text" });
    return;
  }
  const { rows: cu } = await pool.query(`SELECT phone FROM customers WHERE id = $1`, [m.customer_id]);
  const phone = cu[0]?.phone;
  if (!phone) {
    writeJson(res, 400, { ok: false, error: "no_phone" });
    return;
  }
  const sendRes = await sendAiReplyToCustomer({
    phoneDigits: phone,
    text: String(text),
    customerId: m.customer_id,
  });
  if (!sendRes || !sendRes.ok) {
    writeJson(res, 502, { ok: false, error: "send_failed", detail: sendRes });
    return;
  }
  await pool.query(
    `UPDATE crm_messages SET ai_reply_status = 'ai_replied', ai_processed_at = NOW() WHERE id = $1`,
    [id]
  );
  await logAiResponse(pool, {
    crm_message_id: id,
    customer_id: m.customer_id,
    chat_id: m.chat_id,
    input_text: null,
    receipt_data: null,
    reply_text: text,
    confidence: null,
    reasoning: "approved_by_human",
    provider_used: providerAuditTipoM("manual_approve"),
    tokens_used: 0,
    action_taken: "approved_by_human",
    error_message: null,
  });
  writeJson(res, 200, { ok: true, id: Number(id) });
}

async function handleOverride(req, res, id, body) {
  const replyText = body && body.reply_text != null ? String(body.reply_text).trim() : "";
  if (!replyText) {
    writeJson(res, 400, { ok: false, error: "reply_text_required" });
    return;
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.customer_id, m.chat_id
     FROM crm_messages m
     WHERE m.id = $1 AND m.ai_reply_status = 'needs_human_review'`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const m = rows[0];
  const { rows: cu } = await pool.query(`SELECT phone FROM customers WHERE id = $1`, [m.customer_id]);
  const phone = cu[0]?.phone;
  if (!phone) {
    writeJson(res, 400, { ok: false, error: "no_phone" });
    return;
  }
  const sendRes = await sendAiReplyToCustomer({
    phoneDigits: phone,
    text: replyText,
    customerId: m.customer_id,
  });
  if (!sendRes || !sendRes.ok) {
    writeJson(res, 502, { ok: false, error: "send_failed", detail: sendRes });
    return;
  }
  await pool.query(
    `UPDATE crm_messages
     SET ai_reply_status = 'human_replied',
         ai_reply_text = $1,
         ai_processed_at = NOW()
     WHERE id = $2`,
    [replyText, id]
  );
  await logAiResponse(pool, {
    crm_message_id: id,
    customer_id: m.customer_id,
    chat_id: m.chat_id,
    input_text: null,
    receipt_data: null,
    reply_text: replyText,
    confidence: null,
    reasoning: body.sent_by ? `override por ${body.sent_by}` : "override",
    provider_used: providerAuditTipoM("human_override"),
    tokens_used: 0,
    action_taken: "overridden",
    error_message: null,
  });
  writeJson(res, 200, { ok: true, id: Number(id) });
}

/**
 * @returns {Promise<boolean>}
 */
async function handleAiResponderRequest(req, res, url) {
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (path === "/ai-responder" || path === "/ai-responder/index") {
    if (req.method !== "GET") return false;
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=\"utf-8\"><p>Define ADMIN_SECRET.</p>");
      return true;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=\"utf-8\"><p>Usa <code>/ai-responder?k=…</code></p>");
      return true;
    }
    let stats;
    let pending;
    let recentLog;
    try {
      stats = await getStats();
      const p = await pool.query(
        `SELECT id, chat_id, customer_id, ai_reply_status, ai_confidence,
                LEFT(COALESCE(ai_reply_text, content::text), 100) AS preview,
                LEFT(COALESCE(ai_reasoning, ''), 220) AS evidencia_proceso,
                COALESCE(ai_provider, '') AS modelo_gateway,
                created_at
         FROM crm_messages
         WHERE ai_reply_status = 'needs_human_review'
         ORDER BY created_at DESC
         LIMIT 30`
      );
      pending = p.rows;
      const lg = await pool.query(
        `SELECT id, crm_message_id, action_taken, confidence,
                COALESCE(provider_used, '') AS provider_used,
                LEFT(COALESCE(reasoning, ''), 160) AS evidencia_razon,
                LEFT(COALESCE(error_message, ''), 140) AS evidencia_error,
                LEFT(COALESCE(input_text, ''), 72) AS input_prev,
                LEFT(COALESCE(reply_text, ''), 72) AS reply_preview,
                created_at
         FROM ai_response_log
         ORDER BY created_at DESC
         LIMIT 40`
      );
      recentLog = lg.rows;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return true;
    }
    const base = `/ai-responder?k=${encodeURIComponent(k)}`;
    const kEnc = encodeURIComponent(k);
    const monitoresHtml = [
      ["/monitor", "Monitor tiempo real (SSE)"],
      ["/hooks", "Webhook events (ML + mixto)"],
      ["/wasender-webhooks", "Eventos Wasender crudos"],
      ["/envios-whatsapp-tipo-e", "Log envíos WA Mercado (E/F)"],
      ["/envios-tipos-abc", "Log tipos A/B/C (ML)"],
      ["/media-logs", "Media CRM / transcripciones"],
      ["/payment-attempts", "Comprobantes de pago"],
      ["/preguntas-ia-auto-log", "IA auto preguntas ML (tipo D)"],
      ["/banesco", "Banesco estado / movimientos"],
      ["/statements", "Extractos banco"],
    ]
      .map(
        ([path, label]) =>
          `<li><a href="${path}?k=${kEnc}">${escapeHtml(label)}</a> <span class="muted"><code>${path}?k=…</code></span></li>`
      )
      .join("\n");
    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AI Responder — Tipo M (piloto)</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:2rem;max-width:1200px}
h1{font-size:1.1rem}a{color:#1d9bf0}.card{background:#15202b;border:1px solid #38444d;border-radius:8px;padding:1rem;margin:1rem 0}
.muted{color:#71767b;font-size:.85rem} table{border-collapse:collapse;width:100%;font-size:.72rem}
th,td{border:1px solid #38444d;padding:.35rem;text-align:left;vertical-align:top}
th{background:#1e2732}.badge{padding:.1rem .35rem;border-radius:4px;font-size:.72rem}
.badge.on{background:#003920;color:#00d395}.badge.off{background:#3b1219;color:#f4212e}
.badge.m{background:#1a237e;color:#c5cae9}
tr.row-fail{background:#2a1515}
td.evid{font-size:.68rem;max-width:14rem;word-break:break-word}
</style></head><body>
<h1>🤖 AI Responder — <span class="badge m">Tipo M</span></h1>
<p class="muted">Mensajes automáticos CRM del piloto IA (convención interna <code>prompt_ai_responder_pilot</code> en código). Worker: <code>AI_RESPONDER_ENABLED=1</code> · umbral <code>AI_RESPONDER_CONFIDENCE_MIN</code> (default 85).</p>
<p>
  <span class="badge ${stats.ai_responder_enabled ? "on" : "off"}">${stats.ai_responder_enabled ? "WORKER HABILITADO" : "WORKER OFF"}</span>
  <span class="badge m" title="Tipo M">${escapeHtml(stats.tipo_m_mode)}</span>
  <span class="badge ${stats.force_send ? "off" : "on"}" title="AI_RESPONDER_FORCE_SEND=1">${stats.force_send ? "AI_RESPONDER_FORCE_SEND=1 (omite solo revisión humana)" : "revisión humana si aplica"}</span>
  · Plantilla: <code>AI_RESPONDER_GENERIC_TEMPLATE</code> (placeholders <code>{{CONTEXTO_IA}}</code>, <code>{{NOMBRE}}</code>, <code>{{NOMBRE_SALUDO}}</code>)
  · Migración: <code>npm run db:ai-responder</code> · Log: <code>ai_responder: mensaje procesado tipo M</code>
</p>
<div class="card">
  <strong>Hoy (crm_messages con estado IA)</strong>
  <pre class="muted">${escapeHtml(JSON.stringify(stats.today_messages, null, 2))}</pre>
  <strong>Log acciones hoy (ai_response_log)</strong>
  <pre class="muted">${escapeHtml(JSON.stringify(stats.today_log_by_action, null, 2))}</pre>
  <p class="muted">Filas Tipo M llevan <code>provider_used</code> con prefijo <code>tipo_m_ai_responder_pilot|</code> (auditoría / SQL).</p>
</div>
<div class="card">
  <strong>Otros monitores HTML</strong> (misma clave <code>?k=</code> / <code>ADMIN_SECRET</code>)
  <ul class="muted" style="margin:0.5rem 0 0 1rem;line-height:1.5">${monitoresHtml}</ul>
</div>
<h2>API JSON (este módulo)</h2>
<ul>
  <li><a href="/api/ai-responder/stats?k=${kEnc}">GET /api/ai-responder/stats</a></li>
  <li><a href="/api/ai-responder/pending?k=${kEnc}">GET /api/ai-responder/pending</a></li>
  <li><a href="/api/ai-responder/log?k=${kEnc}">GET /api/ai-responder/log</a></li>
</ul>
<h2>Revisión humana pendiente</h2>
<p class="muted">Columnas <strong>evidencia</strong> y <strong>modelo</strong> ayudan a ver por qué quedó en revisión o falló el envío previo.</p>
<table><thead><tr><th>id</th><th>chat</th><th>estado</th><th>conf</th><th>vista</th><th class="evid">evidencia / fallo</th><th>modelo</th><th>creado</th><th>aprobar</th></tr></thead><tbody>
${pending
  .map(
    (r) => `<tr>
  <td>${r.id}</td>
  <td>${escapeHtml(String(r.chat_id))}</td>
  <td>${escapeHtml(String(r.ai_reply_status))}</td>
  <td>${r.ai_confidence ?? "—"}</td>
  <td>${escapeHtml(r.preview || "")}</td>
  <td class="evid">${escapeHtml(r.evidencia_proceso || "—")}</td>
  <td>${escapeHtml(r.modelo_gateway || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
  <td><button type="button" onclick="approve(${r.id})">Enviar sugerencia IA</button></td>
</tr>`
  )
  .join("")}
</tbody></table>
<h2>Último log IA (Tipo M y acciones)</h2>
<p class="muted">Filas con error API / envío resaltadas. Columnas de evidencia para depuración.</p>
<table><thead><tr><th>id</th><th>msg</th><th>acción</th><th>conf</th><th>provider</th><th>entrada</th><th>respuesta</th><th class="evid">razón IA</th><th class="evid">error / API</th><th>hora</th></tr></thead><tbody>
${recentLog
  .map((r) => {
    const fail =
      String(r.action_taken || "") === "error" ||
      (r.evidencia_error && String(r.evidencia_error).trim() !== "");
    return `<tr class="${fail ? "row-fail" : ""}">
  <td>${r.id}</td>
  <td>${r.crm_message_id ?? "—"}</td>
  <td>${escapeHtml(String(r.action_taken))}</td>
  <td>${r.confidence ?? "—"}</td>
  <td class="evid">${escapeHtml(r.provider_used || "—")}</td>
  <td class="evid">${escapeHtml(r.input_prev || "—")}</td>
  <td class="evid">${escapeHtml(r.reply_preview || "—")}</td>
  <td class="evid">${escapeHtml(r.evidencia_razon || "—")}</td>
  <td class="evid">${escapeHtml(r.evidencia_error || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
</tr>`;
  })
  .join("")}
</tbody></table>
<script>
const _k = ${JSON.stringify(k)};
async function approve(mid) {
  if (!confirm('¿Enviar la sugerencia IA al cliente?')) return;
  const r = await fetch('/api/ai-responder/' + mid + '/approve?k=' + encodeURIComponent(_k), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const j = await r.json();
  alert(j.ok ? 'Enviado' : JSON.stringify(j));
  if (j.ok) location.reload();
}
</script>
<p class="muted"><a href="${base}">Recargar</a> · <a href="/monitor?k=${kEnc}">/monitor</a> (SSE)</p>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (!path.startsWith("/api/ai-responder")) return false;
  if (!ensureAdmin(req, res, url)) return true;

  if (req.method === "GET" && path === "/api/ai-responder/stats") {
    try {
      const s = await getStats();
      writeJson(res, 200, s);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/pending") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    try {
      const { rows } = await pool.query(
        `SELECT id, chat_id, customer_id, ai_reply_status, ai_confidence, ai_reply_text, ai_reasoning,
                content, created_at
         FROM crm_messages
         WHERE ai_reply_status = 'needs_human_review'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      writeJson(res, 200, { ok: true, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/log") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "80", 10) || 80, 500);
    try {
      const { rows } = await pool.query(
        `SELECT * FROM ai_response_log ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      writeJson(res, 200, { ok: true, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  const postMatch = path.match(/^\/api\/ai-responder\/(\d+)\/(approve|override)$/);
  if (postMatch && req.method === "POST") {
    const id = postMatch[1];
    const action = postMatch[2];
    let body = {};
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      writeJson(res, 400, { ok: false, error: "json_invalid" });
      return true;
    }
    try {
      if (action === "approve") await handleApprove(req, res, id);
      else await handleOverride(req, res, id, body);
    } catch (e) {
      log.error({ err: e.message }, "ai_responder approve/override");
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleAiResponderRequest, getStats };
