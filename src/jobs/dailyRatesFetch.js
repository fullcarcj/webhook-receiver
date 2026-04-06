require("../../load-env-local");

const { fetchAndSaveDailyRates } = require("../services/currencyService");

async function runDailyRatesFetch() {
  const result = await fetchAndSaveDailyRates();
  console.log("[currency fetch-rates]", JSON.stringify(result));
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

