"use strict";

const { sanitizeWaPersonName } = require("../whatsapp/waNameCandidate");

function isWaPhonePlaceholderFullName(s) {
  const t = String(s || "").trim();
  return /^WA-\d+$/i.test(t);
}

/**
 * Permite "subir" full_name cuando el actual es débil (placeholder/1 palabra/no-persona)
 * y llega un nombre+apellido válido desde WhatsApp.
 */
function shouldForceNameUpgrade(currentFullName, incomingName) {
  const nextRaw = incomingName != null ? String(incomingName).trim() : "";
  const nextPerson = nextRaw ? sanitizeWaPersonName(nextRaw) : null;
  if (!nextPerson) return false;

  const cur = currentFullName != null ? String(currentFullName).trim() : "";
  if (!cur) return true;
  if (isWaPhonePlaceholderFullName(cur)) return true;
  if (cur === "Cliente WhatsApp" || cur === "Cliente") return true;

  const curPerson = sanitizeWaPersonName(cur);
  return !curPerson;
}

module.exports = { shouldForceNameUpgrade, isWaPhonePlaceholderFullName };
