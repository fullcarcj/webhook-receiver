"use strict";

const backendInput = document.getElementById("backendUrl");
const secretInput  = document.getElementById("secret");
const btnSave      = document.getElementById("btnSave");
const btnTest      = document.getElementById("btnTest");
const statusEl     = document.getElementById("status");

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className   = type;
}

// Cargar valores guardados
chrome.storage.local.get(["backendUrl", "secret"], (res) => {
  if (res.backendUrl) backendInput.value = res.backendUrl;
  if (res.secret)     secretInput.value  = res.secret;
});

btnSave.addEventListener("click", () => {
  const backendUrl = backendInput.value.trim().replace(/\/$/, "");
  const secret     = secretInput.value.trim();
  if (!backendUrl || !secret) {
    setStatus("Completá ambos campos.", "err");
    return;
  }
  chrome.storage.local.set({ backendUrl, secret }, () => {
    setStatus("Guardado correctamente.", "ok");
  });
});

btnTest.addEventListener("click", async () => {
  const backendUrl = backendInput.value.trim().replace(/\/$/, "");
  const secret     = secretInput.value.trim();
  if (!backendUrl || !secret) {
    setStatus("Completá ambos campos primero.", "err");
    return;
  }
  setStatus("Probando…");
  try {
    const res  = await fetch(`${backendUrl}/api/fbmp-edge/status`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setStatus(`✓ Conectado. Módulo ${data.enabled ? "activo" : "desactivado (FBMP_EDGE_ENABLED!=1)"}.`, "ok");
    } else {
      setStatus(`Error ${res.status}: ${data.error || data.message || "respuesta inesperada"}`, "err");
    }
  } catch (err) {
    setStatus(`Sin conexión: ${err.message}`, "err");
  }
});
