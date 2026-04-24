/**
 * fbmp_edge — background service worker (MV3)
 *
 * Hace polling al backend cada 4 segundos para obtener mensajes pendientes en
 * el outbox y los reenvia al content script de la tab de Facebook activa.
 */

"use strict";

const POLL_INTERVAL_MS = 4000;

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["backendUrl", "secret"], (res) => {
      resolve({
        backendUrl: (res.backendUrl || "").replace(/\/$/, ""),
        secret:     res.secret || "",
      });
    });
  });
}

async function pollOutbox() {
  const { backendUrl, secret } = await getConfig();
  if (!backendUrl || !secret) return;

  let items = [];
  try {
    const res = await fetch(`${backendUrl}/api/fbmp-edge/outbox`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    items = Array.isArray(data.items) ? data.items : [];
  } catch (_) {
    return;
  }

  if (!items.length) return;

  // Encontrar tabs de Facebook abiertas
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
  if (!tabs.length) return;

  for (const item of items) {
    // Buscar tab activa en el thread correcto o usar la primera disponible
    const targetTab = tabs.find((t) =>
      t.url && t.url.includes(item.external_thread_id)
    ) || tabs[0];

    try {
      await chrome.tabs.sendMessage(targetTab.id, {
        type:     "FBMP_SEND",
        text:     item.body,
        outboxId: item.id,
        threadId: item.external_thread_id,
      });
    } catch (err) {
      // Tab puede estar sin content script (otra página de FB); ignorar
      console.warn("[fbmp_edge bg] sendMessage falló:", err.message);
    }
  }
}

// Polling con setInterval (service worker; alarm como fallback)
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOutbox, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Arrancar cuando haya tabs de FB abiertas
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.url && tab.url.includes("facebook.com")) startPolling();
});

chrome.tabs.onRemoved.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
  if (!tabs.length) stopPolling();
});

startPolling();
