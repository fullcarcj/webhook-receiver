/**
 * fbmp_edge — content script
 *
 * Se inyecta en:
 *   https://www.facebook.com/messages/*
 *   https://www.facebook.com/marketplace/inbox/*
 *
 * Responsabilidades:
 *   1. Observar el DOM con MutationObserver (throttle 300 ms)
 *   2. Parsear mensajes con selectores ARIA (no clases CSS)
 *   3. Enviar batch al backend vía POST /api/fbmp-edge/ingest
 *   4. Escuchar mensajes del background.js (outbox) y simular escritura humana
 *
 * IMPORTANTE: No se usan clases CSS de Facebook (cambian frecuentemente).
 *             Solo atributos ARIA, roles y jerarquía relativa de nodos.
 */

"use strict";

// ─── Config ──────────────────────────────────────────────────────────────────
const THROTTLE_MS  = 300;   // ms entre batches del observer
const MAX_BATCH    = 20;    // máximo mensajes por envío
const TYPING_DELAY = 2000;  // ms antes del clic "Enviar" (simular escritura humana)

// ─── Estado ──────────────────────────────────────────────────────────────────
let config         = { backendUrl: "", secret: "" };
let pendingFlush   = false;
let lastThreadId   = null;
let lastMessageSet = new Set(); // dedupe local antes de enviar

// ─── Cargar config desde storage ─────────────────────────────────────────────
chrome.storage.local.get(["backendUrl", "secret"], (res) => {
  config.backendUrl = (res.backendUrl || "").replace(/\/$/, "");
  config.secret     = res.secret || "";
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.backendUrl) config.backendUrl = (changes.backendUrl.newValue || "").replace(/\/$/, "");
  if (changes.secret)     config.secret     = changes.secret.newValue || "";
});

// ─── Extraer thread_external_id de la URL actual ─────────────────────────────
function getThreadExternalId() {
  const m = location.pathname.match(/\/(?:messages|marketplace\/inbox)\/t\/([^/?\s]+)/);
  return m ? m[1] : null;
}

// ─── Extraer nombre del participante ─────────────────────────────────────────
function getParticipantName() {
  // Intentar desde el encabezado del hilo (rol "heading" o aria-label de la conversación)
  const header = document.querySelector('[role="main"] [role="heading"]');
  if (header) return header.textContent?.trim() || null;
  const titleEl = document.querySelector("title");
  const title   = titleEl?.textContent?.trim() || "";
  // Títulos FB: "Nombre — Messenger" o "Nombre | Facebook"
  return title.split(/[—|]/)[0].trim() || null;
}

// ─── Extraer mensajes del DOM ─────────────────────────────────────────────────
/**
 * Devuelve Array<{ direction, body, dedupe_key, occurred_at? }>
 * Solo ARIA: busca el rol "row" o "listitem" en el hilo de mensajes.
 * Distingue inbound/outbound por si el nodo tiene aria-label que contenga
 * "Tú" o el nombre del participante (heurística; ajustar al idioma).
 */
function extractMessages() {
  const participantName = getParticipantName();
  const results = [];

  // Contenedor principal de mensajes
  const feed = document.querySelector('[role="main"] [role="feed"]')
    || document.querySelector('[role="main"] [role="log"]')
    || document.querySelector('[role="main"]');

  if (!feed) return results;

  // Nodos individuales de mensaje
  const rows = feed.querySelectorAll('[role="row"], [data-scope="messages_table"] [role="row"]');
  const candidates = rows.length > 0
    ? Array.from(rows)
    : Array.from(feed.querySelectorAll('[dir="auto"]'));

  for (const node of candidates) {
    const text = node.textContent?.trim();
    if (!text || text.length < 1) continue;

    // Detectar dirección: outbound si el nodo está alineado a la derecha
    // o si el aria-label contiene el patrón "Tú" / "You"
    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    const isOutbound = label.includes("tú") || label.includes("you")
      || node.closest('[aria-label*="Tú"]') !== null
      || node.closest('[aria-label*="You"]') !== null;

    const direction = isOutbound ? "outbound" : "inbound";

    // Timestamp: buscar aria-label en ancestros con patrón de hora
    const timeEl = node.querySelector("[aria-label]");
    const timeStr = timeEl?.getAttribute("aria-label") || "";
    const occurred_at = timeStr.match(/\d{1,2}:\d{2}/) ? timeStr : null;

    const dedupe_key = btoa(unescape(encodeURIComponent(
      `${getThreadExternalId()}|${direction}|${text.slice(0, 80)}|${occurred_at || ""}`
    ))).slice(0, 64);

    if (lastMessageSet.has(dedupe_key)) continue;

    results.push({ direction, body: text.slice(0, 2000), dedupe_key, occurred_at });
  }

  return results;
}

// ─── Enviar batch al backend ──────────────────────────────────────────────────
async function flushMessages(messages) {
  if (!config.backendUrl || !config.secret) return;
  if (!messages.length) return;

  const threadExternalId = getThreadExternalId();
  if (!threadExternalId) return;

  try {
    const res = await fetch(`${config.backendUrl}/api/fbmp-edge/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.secret}`,
      },
      body: JSON.stringify({
        thread_external_id: threadExternalId,
        participant_name:   getParticipantName(),
        messages:           messages.slice(0, MAX_BATCH),
      }),
    });

    if (res.ok) {
      messages.forEach((m) => lastMessageSet.add(m.dedupe_key));
      if (lastMessageSet.size > 500) {
        const arr = [...lastMessageSet];
        lastMessageSet = new Set(arr.slice(arr.length - 300));
      }
    } else {
      console.warn("[fbmp_edge] ingest:", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.warn("[fbmp_edge] ingest error:", err.message);
  }
}

// ─── Observer con throttle ────────────────────────────────────────────────────
function scheduleFlush() {
  if (pendingFlush) return;
  pendingFlush = true;
  setTimeout(async () => {
    pendingFlush = false;
    const currentThread = getThreadExternalId();
    if (currentThread !== lastThreadId) {
      lastMessageSet.clear();
      lastThreadId = currentThread;
    }
    const msgs = extractMessages();
    if (msgs.length) await flushMessages(msgs);
  }, THROTTLE_MS);
}

const observer = new MutationObserver(scheduleFlush);

function startObserver() {
  const target = document.querySelector('[role="main"]') || document.body;
  observer.observe(target, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver);
} else {
  startObserver();
}

// Re-observar si cambia la URL sin recarga (SPA navigation)
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastMessageSet.clear();
    lastThreadId = null;
    observer.disconnect();
    startObserver();
  }
}, 1000);

// ─── Outbound: recibir mensaje del background y simular escritura humana ──────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "FBMP_SEND" || !msg.text || !msg.outboxId) return;

  const sendText = async () => {
    // Buscar el textarea / contenteditable del chat activo
    const input = document.querySelector('[aria-label="Escribe un mensaje"]')
      || document.querySelector('[aria-label="Write a message"]')
      || document.querySelector('[aria-label*="mensaje"]')
      || document.querySelector('[role="textbox"][contenteditable="true"]')
      || document.querySelector("textarea");

    if (!input) {
      console.warn("[fbmp_edge] No se encontró el input del chat");
      await reportFail(msg.outboxId, "input_not_found");
      return;
    }

    try {
      input.focus();

      // Insertar texto con InputEvent (no value= directo)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement?.prototype || Object.getPrototypeOf(input),
        "value"
      )?.set;

      if (nativeInputValueSetter && input instanceof HTMLInputElement) {
        nativeInputValueSetter.call(input, msg.text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        // contenteditable
        input.textContent = msg.text;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: msg.text }));
      }

      // Jitter humano antes de enviar
      const jitter = TYPING_DELAY + Math.floor(Math.random() * 1000);
      await new Promise((r) => setTimeout(r, jitter));

      // Buscar botón de envío
      const sendBtn = document.querySelector('[aria-label="Enviar"]')
        || document.querySelector('[aria-label="Send"]')
        || document.querySelector('[aria-label*="nviar"]')
        || document.querySelector('[data-testid="send_attachment"]');

      if (sendBtn) {
        sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } else {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      }

      await ackMessage(msg.outboxId);
    } catch (err) {
      console.error("[fbmp_edge] sendText error:", err);
      await reportFail(msg.outboxId, String(err.message).slice(0, 200));
    }
  };

  sendText();
});

async function ackMessage(outboxId) {
  if (!config.backendUrl || !config.secret) return;
  await fetch(`${config.backendUrl}/api/fbmp-edge/outbox/${outboxId}/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.secret}` },
  }).catch(() => {});
}

async function reportFail(outboxId, error) {
  if (!config.backendUrl || !config.secret) return;
  await fetch(`${config.backendUrl}/api/fbmp-edge/outbox/${outboxId}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
    body: JSON.stringify({ error }),
  }).catch(() => {});
}
