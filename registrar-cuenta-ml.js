require("./load-env-local");

/**
 * Guarda una cuenta de vendedor en la base (tabla ml_accounts).
 * Misma app de Mercado Libre (Client ID/Secret), un refresh_token por cuenta.
 *
 *   $env:ML_USER_ID = "1335920698"
 *   $env:OAUTH_REFRESH_TOKEN = "TG-..."
 *   node registrar-cuenta-ml.js
 *
 * Opcional: $env:ML_NICKNAME = "mitienda"
 */

const { upsertMlAccount } = require("./db");

async function main() {
  const uid = Number(process.env.ML_USER_ID);
  const rt =
    process.env.OAUTH_REFRESH_TOKEN || process.env.ML_REFRESH_TOKEN || "";
  if (!Number.isFinite(uid) || uid <= 0 || !rt.trim()) {
    console.error("Define ML_USER_ID (numero) y OAUTH_REFRESH_TOKEN");
    process.exit(1);
  }
  const nick = process.env.ML_NICKNAME || null;
  await upsertMlAccount(uid, rt.trim(), nick);
  console.log("Cuenta guardada: ml_user_id=%s", uid);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
