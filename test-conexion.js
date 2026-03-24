/**
 * Prueba OAuth + API Mercado Libre.
 *
 * Opcion A: copia oauth-env.json.example -> oauth-env.json y rellena (misma carpeta).
 *
 * Cuenta unica (refresh en oauth-credentials.ps1):
 *   . .\oauth-credentials.ps1
 *   node test-conexion.js
 *
 * Varias cuentas (probar vendedor concreto por user_id en DB):
 *   ML_TEST_USER_ID en oauth-env.json o env
 *
 * Si no hay OAUTH_REFRESH_TOKEN ni ML_TEST_USER_ID pero hay filas en ml_accounts,
 * se usa automaticamente la primera cuenta de la base.
 *
 * Opcional: $env:ML_TEST_PATH="/users/me"
 */

require("./load-env-local");

const path = require("path");
const { listMlAccounts } = require("./db");
const {
  getAccessToken,
  getAccessTokenForMlUser,
  mercadoLibreGet,
  mercadoLibreGetForUser,
  getTokenStatus,
  getTokenStatusForMlUser,
} = require("./oauth-token");

function tieneAppMl() {
  const id = process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID;
  const sec = process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET;
  return Boolean(id && sec);
}

function tieneRefreshEnv() {
  return Boolean(
    process.env.OAUTH_REFRESH_TOKEN ||
      process.env.ML_REFRESH_TOKEN ||
      process.env.OAUTH_TOKEN_FILE
  );
}

function resumenUsuario(data) {
  if (data && typeof data === "object") {
    return {
      id: data.id,
      nickname: data.nickname,
      site_id: data.site_id,
      email: data.email ? "(presente)" : undefined,
    };
  }
  return data;
}

async function main() {
  if (!tieneAppMl()) {
    const jsonPath = path.join(__dirname, "oauth-env.json");
    console.error(
      "Faltan OAUTH_CLIENT_ID y OAUTH_CLIENT_SECRET (Application ID y Secret de la app en Mercado Libre).\n\n" +
        "Opcion 1 — archivo (recomendado):\n" +
        `  Copia oauth-env.json.example a:\n  ${jsonPath}\n` +
        "  Rellena OAUTH_CLIENT_ID y OAUTH_CLIENT_SECRET (JSON valido, comillas dobles).\n\n" +
        "Opcion 2 — misma ventana PowerShell:\n" +
        '  $env:OAUTH_CLIENT_ID = "..." ; $env:OAUTH_CLIENT_SECRET = "..."\n' +
        "  node test-conexion.js\n"
    );
    process.exit(1);
  }

  let testUserId = process.env.ML_TEST_USER_ID
    ? Number(process.env.ML_TEST_USER_ID)
    : null;
  const testPath = process.env.ML_TEST_PATH || "/users/me";

  if (
    (!testUserId || !Number.isFinite(testUserId) || testUserId <= 0) &&
    !tieneRefreshEnv()
  ) {
    const rows = listMlAccounts();
    if (rows.length) {
      testUserId = rows[0].ml_user_id;
      console.log(
        "Nota: sin OAUTH_REFRESH_TOKEN ni ML_TEST_USER_ID; usando la primera cuenta en ml_accounts (ml_user_id=%s).\n",
        testUserId
      );
    }
  }

  if (testUserId && Number.isFinite(testUserId) && testUserId > 0) {
    console.log("Modo varias cuentas: user_id=%s\n", testUserId);
    console.log("Paso 1: access_token para esta cuenta (refresh en tabla ml_accounts)…");
    await getAccessTokenForMlUser(testUserId);
    const st = getTokenStatusForMlUser(testUserId);
    console.log("  OK — token (mascarado):", st.mask);
    console.log("  Caduca aprox. (UTC):", st.expiresAtIso);
    console.log("  Segundos restantes:", st.secondsRemaining);

    console.log("\nPaso 2: llamada API:", testPath);
    const data = await mercadoLibreGetForUser(testUserId, testPath);
    console.log("  OK —", JSON.stringify(resumenUsuario(data), null, 2));
    console.log("\nConexion correcta para esta cuenta ML.");
    return;
  }

  if (!tieneRefreshEnv()) {
    console.error(
      "Falta refresh en env (cuenta unica), o define ML_TEST_USER_ID para probar una cuenta registrada en ml_accounts.\n" +
        "  Registra cuentas: node registrar-cuenta-ml.js  o  POST /admin/ml-accounts"
    );
    process.exit(1);
  }

  console.log("Paso 1: renovar / obtener access_token con refresh_token…");
  await getAccessToken();
  const st = getTokenStatus();
  console.log("  OK — token (mascarado):", st.mask);
  console.log("  Caduca aprox. (UTC):", st.expiresAtIso);
  console.log("  Segundos restantes:", st.secondsRemaining);

  console.log("\nPaso 2: llamada autenticada a Mercado Libre:", testPath);
  const data = await mercadoLibreGet(testPath);
  console.log("  OK — respuesta (campos clave):", JSON.stringify(resumenUsuario(data), null, 2));

  console.log("\nConexion correcta: refresh + API responden.");
}

main().catch((e) => {
  console.error("\nFallo:", e.message);
  process.exit(1);
});
