/**
 * fbmp_edge — content script
 *
 * Se inyecta en facebook.com / messenger.com (manifest amplio).
 * Solo hace scrape cuando hay thread_id (URL o mini ventana con enlace al hilo).
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

// ─── thread_external_id: URL o enlace dentro de ventana flotante ────────────
function getThreadExternalIdFromUrl() {
  const p = location.pathname || "";
  let m = p.match(/\/(?:messages|marketplace\/inbox)\/t\/([^/?\s#]+)/);
  if (m) return m[1];
  m = p.match(/^\/t\/([^/?\s#]+)/);
  if (m && /messenger\.com/i.test(location.hostname)) return m[1];
  m = p.match(/\/e2ee\/t\/([^/?\s#]+)/);
  if (m && /messenger\.com/i.test(location.hostname)) return m[1];
  return null;
}

function getThreadExternalIdFromDom() {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="complementary"]');
  for (const d of dialogs) {
    const links = d.querySelectorAll('a[href*="/messages/t/"], a[href*="messenger.com/t/"]');
    for (const a of links) {
      const href = a.href || "";
      let m = href.match(/\/messages\/t\/([^/?&#]+)/);
      if (m) return m[1];
      m = href.match(/messenger\.com\/t\/([^/?&#]+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function getThreadExternalId() {
  return getThreadExternalIdFromUrl() || getThreadExternalIdFromDom();
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
  const tid = getThreadExternalId();
  if (!tid) return [];

  const results = [];

  const feed = document.querySelector('[role="main"] [role="grid"]')
    || document.querySelector('[role="main"] [role="feed"]')
    || document.querySelector('[role="main"] [role="log"]')
    || document.querySelector('[role="dialog"] [role="grid"]')
    || document.querySelector('[role="main"]');

  if (!feed) return results;

  const rows = feed.querySelectorAll('[role="row"], [data-scope="messages_table"] [role="row"]');
  const candidates = rows.length > 0
    ? Array.from(rows)
    : Array.from(feed.querySelectorAll('[dir="auto"]'));

  for (const node of candidates) {
    const text = node.textContent?.trim();
    if (!text || text.length < 2 || text.length > 3500) continue;
    if (text.includes("Activar Windows")) continue;

    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    const isOutbound = label.includes("tú") || label.includes("you")
      || node.closest('[aria-label*="Tú"]') !== null
      || node.closest('[aria-label*="You"]') !== null;

    const direction = isOutbound ? "outbound" : "inbound";

    const timeEl = node.querySelector("[aria-label]");
    const timeStr = timeEl?.getAttribute("aria-label") || "";
    const occurred_at = timeStr.match(/\d{1,2}:\d{2}/) ? timeStr : null;

    const dedupe_key = btoa(unescape(encodeURIComponent(
      `${tid}|${direction}|${text.slice(0, 80)}|${occurred_at || ""}`
    ))).slice(0, 64);

    if (lastMessageSet.has(dedupe_key)) continue;

    results.push({ direction, body: text.slice(0, 2000), dedupe_key, occurred_at });
  }

  return results;
}

// ─── Ingest genérico (hilo activo o fila de la lista lateral) ────────────────
async function postIngest(threadExternalId, participantName, messages) {
  if (!config.backendUrl || !config.secret) return false;
  if (!messages.length) return false;
  if (!threadExternalId) return false;

  try {
    const res = await fetch(`${config.backendUrl}/api/fbmp-edge/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.secret}`,
      },
      body: JSON.stringify({
        thread_external_id: threadExternalId,
        participant_name:   participantName || null,
        messages:           messages.slice(0, MAX_BATCH),
      }),
    });

    if (res.ok) {
      messages.forEach((m) => lastMessageSet.add(m.dedupe_key));
      if (lastMessageSet.size > 500) {
        const arr = [...lastMessageSet];
        lastMessageSet = new Set(arr.slice(arr.length - 300));
      }
      return true;
    }
    console.warn("[fbmp_edge] ingest:", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.warn("[fbmp_edge] ingest error:", err.message);
  }
  return false;
}

async function flushMessages(messages) {
  const threadExternalId = getThreadExternalId();
  if (!threadExternalId) return;
  await postIngest(threadExternalId, getParticipantName(), messages);
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return String(h);
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (o) => resolve(o[key]));
  });
}

function storageSet(key, val) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: val }, resolve);
  });
}

/**
 * Hilos en la columna izquierda (lista) aunque el centro sea otro chat.
 * Envía un ingest con el texto de la fila (preview) cuando cambia respecto al último envío.
 */
async function scrapeSidebarThreads() {
  if (!config.backendUrl || !config.secret) return;
  const href = (location.pathname || "") + (location.href || "");
  if (!/\/messages|marketplace/i.test(href)) return;

  const main = document.querySelector("[role=\"main\"]");
  const anchors = document.querySelectorAll(
    "a[href*=\"/messages/t/\"], a[href*=\"/marketplace/inbox/t/\"]"
  );
  const seen = new Set();

  for (const a of anchors) {
    const raw = a.getAttribute("href") || a.href || "";
    let m = raw.match(/\/messages\/t\/([^/?&#]+)/);
    if (!m) m = raw.match(/\/marketplace\/inbox\/t\/([^/?&#]+)/);
    if (!m) continue;
    const tid = m[1];
    if (seen.has(tid)) continue;
    seen.add(tid);

    if (main) {
      const mr = main.getBoundingClientRect();
      if (mr.width > 400) {
        const ar = a.getBoundingClientRect();
        const rel = (ar.left + ar.width / 2 - mr.left) / mr.width;
        if (rel > 0.45) continue;
      }
    }

    const row = a.closest("[role=\"row\"]") || a.closest("li") || a.parentElement;
    if (!row) continue;
    let preview = String(row.innerText || "")
      .trim()
      .replace(/\s+/g, " ");
    if (preview.length < 3 || preview.length > 1500) continue;
    if (preview.includes("Activar Windows")) continue;

    const fingerprint = simpleHash(preview);
    const sk = `fbmp_sb_${tid}`;
    const prev = await storageGet(sk);
    if (prev === fingerprint) continue;

    const nameGuess = preview.split("·")[0].trim().slice(0, 120) || null;
    const dedupe_key = `sb_${tid}_${fingerprint}`;
    const body = preview.slice(0, 2000);
    const ok = await postIngest(tid, nameGuess, [{ direction: "inbound", body, dedupe_key }]);
    if (ok) await storageSet(sk, fingerprint);
  }
}

// ─── Observer con throttle ────────────────────────────────────────────────────
function scheduleFlush() {
  if (pendingFlush) return;
  pendingFlush = true;
  setTimeout(async () => {
    pendingFlush = false;
    const currentThread = getThreadExternalId();
    if (!currentThread) return;
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
  observer.observe(document.body, { childList: true, subtree: true });
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

// DOM ya cargado sin mutaciones nuevas (p. ej. abrir hilo): re-scrape periódico
setInterval(() => {
  if (getThreadExternalId()) scheduleFlush();
}, 4000);

// Lista lateral: otros hilos (p. ej. Yelitza) aunque el centro sea Cesar
setInterval(() => {
  scrapeSidebarThreads().catch(() => {});
}, 7000);

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
