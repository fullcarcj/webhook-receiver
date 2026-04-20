"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { requireAdminOrPermission, verifyToken } = require("../utils/authMiddleware");
const {
  sendAiReplyToCustomer,
  logAiResponse,
  providerAuditTipoM,
  isForceSend,
  isHumanReviewGateOn,
} = require("../services/aiResponder");

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

/** Usuario JWT (username) o `admin` si la sesión es secreto / query legacy. */
async function getActorLabel(req) {
  try {
    const p = await verifyToken(req);
    if (p && p.username) return String(p.username).trim().slice(0, 120);
  } catch (_) {}
  return "admin";
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
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review' AND COALESCE(TRIM(ai_reply_text), '') <> '') AS needs_review_post_wa_fail,
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review' AND COALESCE(TRIM(ai_reply_text), '') = '') AS needs_review_pre_send,
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
  const groqKeyOk = !!process.env.GROQ_API_KEY;
  return {
    ok: true,
    ai_responder_enabled: String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1",
    force_send: isForceSend(),
    human_review_gate: isHumanReviewGateOn(),
    tipo_m_mode: "plantilla + context_line (IA no elige flujo)",
    today_messages: today.rows[0] || {},
    today_log_by_action: Object.fromEntries(logc.rows.map((r) => [r.action_taken, r.n])),
    provider: { groq_key_ok: groqKeyOk },
  };
}

async function handleReject(req, res, id, body) {
  const actor = await getActorLabel(req);
  let reason = body && body.reason != null ? String(body.reason).trim() : "";
  if (reason.length > 500) reason = reason.slice(0, 500);
  const reasonOrNull = reason === "" ? null : reason;

  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.customer_id, m.chat_id,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 409, { ok: false, error: "invalid_state" });
    return;
  }

  const reasoningPayload = JSON.stringify({
    reason: reasonOrNull,
    sent_by: actor,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'human_rejected', ai_reply_updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: null,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: "human",
      tokens_used: 0,
      action_taken: "rejected",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  writeJson(res, 200, { ok: true, id: Number(id), status: "human_rejected" });
}

async function handleDraft(req, res, id, body) {
  const actor = await getActorLabel(req);
  const replyText = body && body.reply_text != null ? String(body.reply_text).trim() : "";
  if (!replyText || replyText.length > 4000) {
    writeJson(res, 400, { ok: false, error: "invalid_reply_text" });
    return;
  }

  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.customer_id, m.chat_id, m.ai_reply_text,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 409, { ok: false, error: "invalid_state" });
    return;
  }

  const originalAi = m.ai_reply_text != null ? String(m.ai_reply_text) : "";
  const reasoningPayload = JSON.stringify({
    original_ai_text: originalAi,
    new_draft_text: replyText,
    sent_by: actor,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_text = $1, ai_reply_updated_at = NOW()
       WHERE id = $2`,
      [replyText, id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: replyText,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: "human",
      tokens_used: 0,
      action_taken: "draft_saved",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  writeJson(res, 200, {
    ok: true,
    id: Number(id),
    status: "needs_human_review",
    ai_reply_text: replyText,
  });
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
    `SELECT m.id, m.customer_id, m.chat_id, m.ai_reply_text,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1 AND m.ai_reply_status = 'needs_human_review'`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const m = rows[0];
  const originalAi = m.ai_reply_text != null ? String(m.ai_reply_text) : "";
  const actor = await getActorLabel(req);
  const sentBy =
    body.sent_by != null && String(body.sent_by).trim() !== ""
      ? String(body.sent_by).trim().slice(0, 200)
      : actor;

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

  const reasoningPayload = JSON.stringify({
    original_ai_text: originalAi,
    override_text: replyText,
    sent_by: sentBy,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'human_replied',
           ai_reply_text = $1,
           ai_processed_at = NOW()
       WHERE id = $2`,
      [replyText, id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: replyText,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: providerAuditTipoM("human_override"),
      tokens_used: 0,
      action_taken: "overridden",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
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
    let queuedPending;
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
      const qp = await pool.query(
        `SELECT id, chat_id, customer_id, ai_reply_status,
                LEFT(COALESCE(content::text, ''), 140) AS contenido,
                created_at
         FROM crm_messages
         WHERE ai_reply_status IN ('pending_ai_reply', 'pending_receipt_confirm', 'processing')
         ORDER BY created_at DESC
         LIMIT 30`
      );
      queuedPending = qp.rows;
      const lg = await pool.query(
        `SELECT l.id, l.crm_message_id, l.action_taken, l.confidence,
                COALESCE(l.provider_used, '') AS provider_used,
                LEFT(COALESCE(l.reasoning, ''), 400) AS evidencia_razon,
                COALESCE(NULLIF(TRIM(l.error_message), ''), '') AS evidencia_error,
                LEFT(COALESCE(l.input_text, ''), 100) AS input_prev,
                LEFT(COALESCE(l.reply_text, ''), 120) AS reply_preview,
                l.created_at,
                COALESCE(ch_log.phone, ch_msg.phone) AS chat_phone
         FROM ai_response_log l
         LEFT JOIN crm_chats ch_log ON ch_log.id = l.chat_id
         LEFT JOIN crm_messages cm ON cm.id = l.crm_message_id
         LEFT JOIN crm_chats ch_msg ON ch_msg.id = cm.chat_id
         ORDER BY l.created_at DESC
         LIMIT 80`
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
body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:2rem;max-width:1300px}
h1,h2{font-size:1rem}h2{margin-top:1.6rem}a{color:#1d9bf0}
.card{background:#15202b;border:1px solid #38444d;border-radius:8px;padding:1rem;margin:1rem 0}
.muted{color:#71767b;font-size:.82rem} table{border-collapse:collapse;width:100%;font-size:.72rem}
th,td{border:1px solid #38444d;padding:.3rem .4rem;text-align:left;vertical-align:top}
th{background:#1e2732;white-space:nowrap}
.badge{padding:.1rem .35rem;border-radius:4px;font-size:.72rem}
.badge.on{background:#003920;color:#00d395}.badge.off{background:#3b1219;color:#f4212e}
.badge.m{background:#1a237e;color:#c5cae9}
.badge.sent{background:#003920;color:#00d395;font-weight:700}
.badge.error{background:#3b1219;color:#f4212e;font-weight:700}
.badge.skip{background:#2d2200;color:#f0b429}
.badge.review{background:#1a237e;color:#c5cae9}
.badge.pend{background:#1e2732;color:#71767b}
tr.row-fail{background:#2a1515}
tr.row-ok{background:#061a0e}
td.evid{font-size:.66rem;max-width:18rem;word-break:break-word}
td.errdetail{font-size:.62rem;max-width:42rem;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;line-height:1.35}
td.msg{max-width:22rem;word-break:break-word}
td.phone{font-family:ui-monospace,Consolas,monospace;font-size:.68rem;white-space:nowrap}
.pill{display:inline-block;padding:.05rem .3rem;border-radius:3px;font-size:.65rem}
</style></head><body>
<h1>🤖 AI Responder — <span class="badge m">Tipo M</span></h1>
<p>
  <span class="badge ${stats.ai_responder_enabled ? "on" : "off"}">${stats.ai_responder_enabled ? "WORKER ON" : "WORKER OFF — falta AI_RESPONDER_ENABLED=1"}</span>
  <span class="badge ${stats.provider && stats.provider.groq_key_ok ? "on" : "off"}">GROQ_API_KEY: ${stats.provider && stats.provider.groq_key_ok ? "OK" : "❌ FALTA"}</span>
  <span class="badge ${stats.human_review_gate ? "on" : "off"}" title="AI_RESPONDER_FORCE_SEND = switch revisión humana">${stats.human_review_gate ? "Revisión humana ON" : "Revisión humana OFF (FORCE)"}</span>
</p>

<div class="card">
  <table style="width:auto;font-size:.8rem;border:none">
    <tr>
      <td style="border:none;padding:.15rem .6rem .15rem 0;color:#71767b">Enviados hoy</td>
      <td style="border:none;font-weight:700;color:#00d395">${stats.today_messages.auto_sent ?? 0}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Pendientes cola</td>
      <td style="border:none;font-weight:700;color:#c5cae9">${stats.today_messages.pending ?? 0}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b" title="needs_human_review: cola previa envío (sin FORCE) o post-fallo Wasender">Rev. humana</td>
      <td style="border:none;font-weight:700;color:#c5cae9">${stats.today_messages.needs_review ?? 0}
        <span class="muted" style="font-weight:400;font-size:.72rem"><br/>↳ post-WA: ${stats.today_messages.needs_review_post_wa_fail ?? 0} · pre-envío: ${stats.today_messages.needs_review_pre_send ?? 0}</span>
      </td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Error / fallo WA</td>
      <td style="border:none;font-weight:700;color:#f4212e">${stats.today_log_by_action.error ?? 0}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Saltados</td>
      <td style="border:none;color:#71767b">${stats.today_messages.skipped ?? 0}</td>
    </tr>
  </table>
  <p class="muted" style="margin-top:.5rem">
    Plantilla: <code>AI_RESPONDER_GENERIC_TEMPLATE</code> · placeholders <code>{{CONTEXTO_IA}}</code> <code>{{NOMBRE}}</code> <code>{{NOMBRE_SALUDO}}</code>
    · <a href="/api/ai-responder/stats?k=${kEnc}">stats JSON</a>
    · <a href="/api/ai-responder/log?k=${kEnc}">log JSON</a>
    · <a href="/api/ai-responder/pending?k=${kEnc}">pending JSON</a>
  </p>
  ${queuedPending.length > 0 ? `
  <p style="margin:.6rem 0 .3rem"><strong>⏳ En cola / procesando ahora</strong> <span class="muted">(${queuedPending.length})</span></p>
  <table>
    <thead><tr><th>#msg</th><th>chat</th><th>cliente</th><th>estado</th><th class="msg">contenido recibido</th><th>recibido</th></tr></thead>
    <tbody>
    ${queuedPending.map((r) => {
      const est = String(r.ai_reply_status || "");
      const estBadge = est === "processing"
        ? `<span class="badge" style="background:#1a237e;color:#c5cae9">⚙ procesando</span>`
        : est === "pending_receipt_confirm"
        ? `<span class="badge pend">comprobante</span>`
        : `<span class="badge pend">⏳ pendiente</span>`;
      return `<tr>
        <td>${r.id}</td>
        <td>${escapeHtml(String(r.chat_id || "—"))}</td>
        <td>${escapeHtml(String(r.customer_id || "—"))}</td>
        <td>${estBadge}</td>
        <td class="msg">${escapeHtml(r.contenido || "—")}</td>
        <td>${escapeHtml(String(r.created_at))}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table>` : `<p class="muted" style="margin:.4rem 0 0">Sin mensajes en cola ahora.</p>`}
</div>

<h2>📋 Log completo de mensajes automáticos (últimos 80)</h2>
<p class="muted">
  <span class="pill" style="background:#003920;color:#00d395">✔ sent</span> = enviado OK a Wasender ·
  <span class="pill" style="background:#3b1219;color:#f4212e">✖ error</span> = fallo al enviar (Wasender rechazó o sin respuesta) ·
  <span class="pill" style="background:#1a237e;color:#c5cae9">⏳ queued_review</span> = en cola revisión humana ·
  <span class="pill" style="background:#2d2200;color:#f0b429">skip</span> = saltado (sin texto, sin teléfono, etc.)
</p>
<p class="muted" style="margin-top:.25rem;line-height:1.45">
  Columna <strong>error / detalle</strong>: primera línea <code>[origen=…]</code> — <code>WASENDER_API</code> = respuesta HTTP/API de envío;
  <code>APP_CONFIG</code> / <code>APP_DATOS</code> / <code>APP_LOGIC</code> = no se llegó a llamar a Wasender;
  fallos del modelo para <code>context_line</code> van en <strong>razón / contexto IA</strong> como <code>[origen=GROQ_LLAMA: …]</code> (la plantilla igual se arma con fallback).
</p>
<table>
  <thead><tr>
    <th>#log</th><th>#msg</th>
    <th>teléfono (chat)</th>
    <th>resultado</th>
    <th>conf</th>
    <th class="msg">mensaje del cliente</th>
    <th class="msg">respuesta enviada / sugerida</th>
    <th class="evid">razón / contexto IA</th>
    <th class="errdetail">error / detalle (origen + API)</th>
    <th>hora</th>
  </tr></thead>
  <tbody>
${recentLog
  .map((r) => {
    const act = String(r.action_taken || "");
    const isSent = act === "sent";
    const isError = act === "error" || (r.evidencia_error && String(r.evidencia_error).trim() !== "");
    const isReview = act === "queued_review" || act === "approved_by_human" || act === "overridden";
    const isSkip = act.startsWith("skipped");
    const rowClass = isSent ? "row-ok" : isError ? "row-fail" : "";
    const badgeCls = isSent ? "sent" : isError ? "error" : isReview ? "review" : isSkip ? "skip" : "pend";
    const badgeTxt = isSent ? "✔ enviado" : isError ? "✖ error WA" : isReview ? "⏳ rev. humana" : isSkip ? "⬜ skip" : escapeHtml(act);
    return `<tr class="${rowClass}">
  <td>${r.id}</td>
  <td>${r.crm_message_id ?? "—"}</td>
  <td class="phone">${escapeHtml(r.chat_phone && String(r.chat_phone).trim() ? String(r.chat_phone).trim() : "—")}</td>
  <td><span class="badge ${badgeCls}">${badgeTxt}</span></td>
  <td>${r.confidence ?? "—"}</td>
  <td class="msg">${escapeHtml(r.input_prev || "—")}</td>
  <td class="msg">${escapeHtml(r.reply_preview || "—")}</td>
  <td class="evid">${escapeHtml(r.evidencia_razon || "—")}</td>
  <td class="errdetail">${escapeHtml(r.evidencia_error || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
</tr>`;
  })
  .join("")}
  </tbody>
</table>

<h2>🔍 Revisión humana pendiente</h2>
${pending.length === 0
  ? `<p class="muted">Sin mensajes en revisión humana actualmente.</p>`
  : `<table><thead><tr><th>id</th><th>chat</th><th>conf</th><th class="msg">vista</th><th class="evid">motivo / evidencia</th><th>creado</th><th>aprobar</th></tr></thead><tbody>
${pending.map((r) => `<tr>
  <td>${r.id}</td>
  <td>${escapeHtml(String(r.chat_id))}</td>
  <td>${r.ai_confidence ?? "—"}</td>
  <td class="msg">${escapeHtml(r.preview || "")}</td>
  <td class="evid">${escapeHtml(r.evidencia_proceso || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
  <td><button type="button" onclick="approve(${r.id})">Enviar sugerencia IA</button></td>
</tr>`).join("")}
</tbody></table>`}

<div class="card" style="margin-top:1.5rem">
  <strong>Otros monitores HTML</strong> (misma clave <code>?k=</code>)
  <ul class="muted" style="margin:.4rem 0 0 1rem;line-height:1.6">${monitoresHtml}</ul>
</div>
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
  if (!await requireAdminOrPermission(req, res, 'crm')) return true;

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
        `SELECT l.*, COALESCE(ch_log.phone, ch_msg.phone) AS chat_phone
         FROM ai_response_log l
         LEFT JOIN crm_chats ch_log ON ch_log.id = l.chat_id
         LEFT JOIN crm_messages cm ON cm.id = l.crm_message_id
         LEFT JOIN crm_chats ch_msg ON ch_msg.id = cm.chat_id
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );
      writeJson(res, 200, { ok: true, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  const postMatch = path.match(/^\/api\/ai-responder\/(\d+)\/(approve|override|reject|draft)$/);
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
      else if (action === "override") await handleOverride(req, res, id, body);
      else if (action === "reject") await handleReject(req, res, id, body);
      else await handleDraft(req, res, id, body);
    } catch (e) {
      log.error({ err: e.message }, "ai_responder approve/override/reject/draft");
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleAiResponderRequest, getStats };
