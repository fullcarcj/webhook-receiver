"use strict";

const { checkAdminSecretOrJwt, requirePermission } = require("../utils/authMiddleware");

/**
 * JWT Bearer/Cookie o X-Admin-Secret / ?k= + permiso fiscal:read.
 * @returns {Promise<boolean>} true si autorizado; false si ya respondió 401/403.
 */
async function requireBankRead(req, res) {
  const user = await checkAdminSecretOrJwt(req, res);
  if (!user) return false;
  if (!requirePermission(user, "fiscal", "read", res)) return false;
  return true;
}

module.exports = { requireBankRead };
