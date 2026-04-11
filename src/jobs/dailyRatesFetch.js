require("../../load-env-local");

const { fetchAndSaveDailyRates } = require("../services/currencyService");
const { runDailyExpiry } = require("../services/lotService");
const { pool } = require("../../db-postgres");

async function runDailyRatesFetch() {
  const result = await fetchAndSaveDailyRates();
  console.log("[currency fetch-rates]", JSON.stringify(result));

  try {
    await runDailyExpiry();
  } catch (err) {
    console.error("[lots] Error en expire_lots_daily:", err && err.message ? err.message : err);
  }

  // Limpiar sesiones JWT expiradas y revocadas > 7 días
  try {
    const { rows } = await pool.query("SELECT cleanup_expired_sessions() AS deleted");
    const deleted = rows[0]?.deleted ?? 0;
    if (Number(deleted) > 0) {
      console.log(`[auth] cleanup_expired_sessions: ${deleted} sesiones eliminadas`);
    }
  } catch (err) {
    console.error("[auth] Error en cleanup_expired_sessions:", err && err.message ? err.message : err);
  }

  return result;
}

module.exports = {
  runDailyRatesFetch,
};

if (require.main === module) {
  runDailyRatesFetch()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[currency fetch-rates]", e.message || e);
      process.exit(1);
    });
}

