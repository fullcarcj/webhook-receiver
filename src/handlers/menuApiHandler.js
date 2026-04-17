"use strict";

const {
  requireAuth,
  hasMinRole,
  ROLE_HIERARCHY,
} = require("../utils/authMiddleware");
const {
  ACTIVE_MODULES,
  PENDING_MODULES,
  HIDDEN_MODULES,
  CANAL_BY_ROLE,
  MENU_SECTIONS,
} = require("../config/menuDefinition");

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function moduleStatusFor(moduleKey) {
  if (moduleKey == null) return null;
  if (PENDING_MODULES.includes(moduleKey)) return "pending";
  if (ACTIVE_MODULES.includes(moduleKey)) return "active";
  return null;
}

function modOk(moduleKey) {
  if (moduleKey == null) return { ok: true, status: null };
  if (HIDDEN_MODULES.includes(moduleKey)) return { ok: false, status: null };
  if (ACTIVE_MODULES.includes(moduleKey)) return { ok: true, status: "active" };
  if (PENDING_MODULES.includes(moduleKey)) return { ok: true, status: "pending" };
  return { ok: false, status: null };
}

function canalOk(userRole, item) {
  const canalRole = CANAL_BY_ROLE[userRole];
  if (canalRole === "all") return true;
  if (!item.canal || !item.canal.length) return true;
  return item.canal.includes(canalRole);
}

function sectionAllowedRole(userRole, section) {
  if (!section.allowedRoles || !section.allowedRoles.length) return true;
  return section.allowedRoles.includes(userRole);
}

function itemAllowedRole(userRole, item) {
  if (!item.allowedRoles || !item.allowedRoles.length) return true;
  return item.allowedRoles.includes(userRole);
}

/**
 * Jerarquía numérica + reglas de silo (almacén vs contador no se cruzan).
 */
function itemVisibleForRole(userRole, item) {
  const min = item.minRole;
  if (userRole === "CONTADOR" && min === "ALMACENISTA") return false;
  if (userRole === "ALMACENISTA" && min === "CONTADOR") return false;
  return hasMinRole(userRole, min);
}

/**
 * GET /api/menu — menú filtrado por rol + canal (sin BD).
 * @returns {Promise<boolean>} true si la petición fue atendida
 */
async function handleMenuApiRequest(req, res, url) {
  const pathname = (url.pathname || "").replace(/\/+$/, "") || "/";
  if (req.method !== "GET" || pathname !== "/api/menu") {
    return false;
  }

  const user = await requireAuth(req, res);
  if (!user) return true;

  const role = user.role;
  if (role == null || !(role in ROLE_HIERARCHY)) {
    json(res, 403, { error: "FORBIDDEN", message: "Rol no reconocido" });
    return true;
  }

  const canal = CANAL_BY_ROLE[role] || "all";

  const menu = [];
  for (const section of MENU_SECTIONS) {
    const mk = section.moduleKey;
    if (mk && HIDDEN_MODULES.includes(mk)) continue;

    const m = modOk(mk);
    if (!m.ok) {
      // eslint-disable-next-line no-console
      console.warn("[menu] moduleKey omitido:", mk);
      continue;
    }

    if (!sectionAllowedRole(role, section)) continue;
    if (!hasMinRole(role, section.minRole)) continue;

    const itemsOut = [];
    for (const raw of section.items) {
      const pendingMigration = raw.pendingMigration === true;
      const future = raw.future === true;
      if (!itemAllowedRole(role, raw)) continue;
      if (!itemVisibleForRole(role, raw)) continue;
      if (!canalOk(role, raw)) continue;

      const itemOut = {
        id: raw.id,
        label: raw.label,
        path: raw.path,
        minRole: raw.minRole,
        pendingMigration,
        future,
      };
      if (raw.icon) itemOut.icon = raw.icon;
      if (raw.apiPath) itemOut.apiPath = raw.apiPath;
      itemsOut.push(itemOut);
    }

    if (!itemsOut.length) continue;

    menu.push({
      id: section.id,
      label: section.label,
      icon: section.icon,
      group: section.group,
      moduleKey: mk,
      moduleStatus: m.status,
      items: itemsOut,
    });
  }

  json(res, 200, { role, canal, menu });
  return true;
}

module.exports = { handleMenuApiRequest };
