require("../../load-env-local");

const { fetchAndSaveDailyRates } = require("../services/currencyService");
const { runDailyExpiry } = require("../services/lotService");

async function runDailyRatesFetch() {
  const result = await fetchAndSaveDailyRates();
  console.log("[currency fetch-rates]", JSON.stringify(result));

  try {
    await runDailyExpiry();
  } catch (err) {
    console.error("[lots] Error en expire_lots_daily:", err && err.message ? err.message : err);
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

