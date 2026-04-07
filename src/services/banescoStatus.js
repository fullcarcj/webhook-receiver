"use strict";

const { pool } = require("../../db-postgres");
const { getLastCycleSnapshot, SESSION_MAX_HOURS } = require("./banescoService");

/**
 * Estado de conexión Banesco: env + fila `bank_accounts` + último ciclo del monitor.
 */
async function getBanescoConnectionSnapshot() {
  const bankAccountId = parseInt(process.env.BANK_ACCOUNT_ID || "1", 10);
  const monitorEnabled = process.env.BANESCO_MONITOR_ENABLED === "1";
  const hasUser = Boolean(process.env.BANESCO_USER && String(process.env.BANESCO_USER).trim());
  const hasPass = Boolean(process.env.BANESCO_PASS && String(process.env.BANESCO_PASS).trim());

  let sessionRow = null;
  try {
    const { rows } = await pool.query(
      `SELECT id, session_cookies, session_saved_at, bank_name, account_number, is_active
       FROM bank_accounts WHERE id = $1`,
      [bankAccountId]
    );
    sessionRow = rows[0] || null;
  } catch (e) {
    return {
      ok: false,
      error: "db_error",
      message: e.message,
      monitor_enabled: monitorEnabled,
      bank_account_id: bankAccountId,
      last_cycle: getLastCycleSnapshot(),
    };
  }

  let sessionAgeHours = null;
  let sessionValid = false;
  if (sessionRow?.session_saved_at && sessionRow?.session_cookies) {
    sessionAgeHours = (Date.now() - new Date(sessionRow.session_saved_at).getTime()) / 3600000;
    sessionValid = sessionAgeHours <= SESSION_MAX_HOURS;
    try {
      JSON.parse(sessionRow.session_cookies);
    } catch {
      sessionValid = false;
    }
  }

  let state;
  if (!monitorEnabled) {
    state = "monitor_disabled";
  } else if (!hasUser || !hasPass) {
    state = "missing_credentials";
  } else if (!sessionRow) {
    state = "account_not_found";
  } else if (!sessionRow.session_cookies || !sessionRow.session_saved_at) {
    state = "no_session";
  } else if (!sessionValid) {
    state = "session_stale";
  } else {
    state = "connected";
  }

  const connected = state === "connected";

  return {
    ok: true,
    connected,
    state,
    monitor_enabled: monitorEnabled,
    credentials_configured: hasUser && hasPass,
    bank_account_id: bankAccountId,
    session_max_hours: SESSION_MAX_HOURS,
    account: sessionRow
      ? {
          id: sessionRow.id,
          bank_name: sessionRow.bank_name,
          account_number: sessionRow.account_number,
          is_active: sessionRow.is_active,
        }
      : null,
    session: {
      present: Boolean(sessionRow?.session_cookies),
      saved_at: sessionRow?.session_saved_at || null,
      age_hours: sessionAgeHours,
      valid: sessionValid,
    },
    last_cycle: getLastCycleSnapshot(),
  };
}

module.exports = { getBanescoConnectionSnapshot };
