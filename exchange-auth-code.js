require("./load-env-local");

/**
 * Uso único: intercambia el "authorization code" por access_token + refresh_token.
 * El código caduca rápido y solo sirve una vez.
 *
 * PowerShell (misma carpeta que oauth-credentials.ps1):
 *   . .\oauth-credentials.ps1
 *   node exchange-auth-code.js
 *
 * Requiere en entorno:
 *   OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_AUTH_CODE
 *   OAUTH_REDIRECT_URI  (debe coincidir EXACTO con la Redirect URI de la app en ML)
 */

const TOKEN_URL =
  process.env.OAUTH_TOKEN_URL || "https://api.mercadolibre.com/oauth/token";

async function main() {
  const client_id = process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID;
  const client_secret = process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET;
  const code = process.env.OAUTH_AUTH_CODE || process.env.ML_AUTH_CODE;
  const redirect_uri = process.env.OAUTH_REDIRECT_URI || process.env.ML_REDIRECT_URI;

  if (!client_id || !client_secret || !code || !redirect_uri) {
    console.error(
      "Faltan variables: OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_AUTH_CODE, OAUTH_REDIRECT_URI"
    );
    process.exit(1);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id,
    client_secret,
    code,
    redirect_uri,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("Error", res.status, text);
    process.exit(1);
  }

  const data = JSON.parse(text);
  console.log(JSON.stringify(data, null, 2));

  if (process.env.ML_SAVE_ACCOUNT === "1" && data.user_id && data.refresh_token) {
    const { upsertMlAccount } = require("./db");
    upsertMlAccount(
      data.user_id,
      data.refresh_token,
      typeof data.nickname === "string" ? data.nickname : null
    );
    console.error(
      "\n[ml_accounts] Guardado user_id=%s (ML_SAVE_ACCOUNT=1)",
      data.user_id
    );
  }

  console.error(
    "\nGuarda OAUTH_REFRESH_TOKEN en oauth-credentials.ps1 o ejecuta registrar-cuenta-ml.js (y borra OAUTH_AUTH_CODE)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
