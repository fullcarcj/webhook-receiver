require("./load-env-local");

/**
 * Muestra el access_token activo en forma ENMASCARADA y la caducidad.
 * No imprime nunca el token completo.
 *
 *   . .\oauth-credentials.ps1
 *   node ver-token.js
 *
 * Multicuenta:
 *   $env:ML_TEST_USER_ID = "1335920698"
 *   node ver-token.js
 */

const {
  getAccessToken,
  getAccessTokenForMlUser,
  getTokenStatus,
  getTokenStatusForMlUser,
} = require("./oauth-token");

async function main() {
  const uid = process.env.ML_TEST_USER_ID
    ? Number(process.env.ML_TEST_USER_ID)
    : null;

  if (uid && Number.isFinite(uid) && uid > 0) {
    await getAccessTokenForMlUser(uid);
    const st = getTokenStatusForMlUser(uid);
    console.log(JSON.stringify(st, null, 2));
    printNota(st.secondsRemaining);
    return;
  }

  await getAccessToken();
  const st = getTokenStatus();
  console.log(JSON.stringify(st, null, 2));
  printNota(st.secondsRemaining);
}

function printNota(secondsRemaining) {
  if (secondsRemaining > 21000) {
    console.error(
      "\nNota: cada vez que ejecutas este script es un proceso nuevo sin caché," +
        " asi que suele pedirse un access_token fresco a la API (~21600 s)." +
        " Para ver como bajan los segundos, usa el mismo proceso largo (p. ej. node server.js y GET /oauth/token-status)."
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
