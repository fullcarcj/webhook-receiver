const fs = require("fs");
const { getMlAccount, upsertMlAccount } = require("./db");

const TOKEN_URL =
  process.env.OAUTH_TOKEN_URL || "https://api.mercadolibre.com/oauth/token";

let cache = {
  access_token: null,
  /** ms epoch cuando caduca (con margen de seguridad) */
  expiresAt: 0,
  refresh_token: null,
};

let inFlight = null;
let proactiveTimer = null;

function marginMs() {
  return Number(process.env.OAUTH_EXPIRY_MARGIN_SEC || 120) * 1000;
}

/** Renueva solo el access_token poco antes de que caduque (p. ej. expires_in=21600 s). */
function scheduleProactiveRefresh() {
  if (process.env.OAUTH_PROACTIVE_REFRESH === "0") return;
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
  if (!cache.access_token || !cache.expiresAt) return;

  const delay = Math.max(
    10_000,
    cache.expiresAt - Date.now() - marginMs()
  );
  const maxTimer = 2147483647;
  const wait = Math.min(delay, maxTimer);

  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    getAccessToken().catch((e) => console.error("[OAuth auto-refresh]", e.message));
  }, wait);
}

function readTokenFile() {
  const p = process.env.OAUTH_TOKEN_FILE;
  if (!p || !fs.existsSync(p)) return;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof j.refresh_token === "string") cache.refresh_token = j.refresh_token;
  } catch {
    /* ignorar */
  }
}

function writeTokenFile() {
  const p = process.env.OAUTH_TOKEN_FILE;
  if (!p || !cache.refresh_token) return;
  fs.writeFileSync(
    p,
    JSON.stringify(
      { refresh_token: cache.refresh_token, updated_at: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
}

function envRefresh() {
  return (
    cache.refresh_token ||
    process.env.OAUTH_REFRESH_TOKEN ||
    process.env.ML_REFRESH_TOKEN ||
    ""
  );
}

function envClient() {
  return {
    id: process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID || "",
    secret: process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET || "",
  };
}

async function performRefresh(refresh_token) {
  const { id: client_id, secret: client_secret } = envClient();
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error(
      "Configura OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET y refresh_token (cuenta o env)"
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id,
    client_secret,
    refresh_token,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth refresh ${res.status}: ${text}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("OAuth: respuesta no es JSON");
  }
  if (!data.access_token) {
    throw new Error("OAuth: falta access_token en la respuesta");
  }
  return data;
}

/** Cache por vendedor (user_id de Mercado Libre). */
const cacheByMlUser = new Map();
const inFlightByMlUser = new Map();
const proactiveTimersByMlUser = new Map();

function scheduleProactiveRefreshForMlUser(mlUserId) {
  if (process.env.OAUTH_PROACTIVE_REFRESH === "0") return;
  const id = Number(mlUserId);
  const prev = proactiveTimersByMlUser.get(id);
  if (prev) {
    clearTimeout(prev);
    proactiveTimersByMlUser.delete(id);
  }
  const c = cacheByMlUser.get(id);
  if (!c || !c.expiresAt) return;

  const delay = Math.max(
    10_000,
    c.expiresAt - Date.now() - marginMs()
  );
  const wait = Math.min(delay, 2147483647);

  const t = setTimeout(() => {
    proactiveTimersByMlUser.delete(id);
    getAccessTokenForMlUser(id).catch((e) =>
      console.error(`[OAuth auto-refresh ml_user_id=${id}]`, e.message)
    );
  }, wait);

  proactiveTimersByMlUser.set(id, t);
}

/**
 * Al arrancar el servidor: pide token para cada cuenta en DB y deja programado el siguiente refresh (~21600 s).
 * Escalonado para no disparar N llamadas al mismo tiempo.
 */
function warmAllMlAccountsRefresh() {
  if (process.env.OAUTH_PROACTIVE_REFRESH === "0") return;
  const { listMlAccounts } = require("./db");
  const rows = listMlAccounts();
  if (!rows.length) return;
  const { id: cid, secret: csec } = envClient();
  if (!cid || !csec) {
    console.warn(
      "[OAuth] Hay cuentas en ml_accounts pero falta OAUTH_CLIENT_ID / SECRET; no se renuevan."
    );
    return;
  }
  const stagger = Number(process.env.ML_ACCOUNT_STAGGER_MS || 500);
  rows.forEach((row, i) => {
    const uid = row.ml_user_id;
    setTimeout(() => {
      getAccessTokenForMlUser(uid)
        .then(() =>
          console.log(
            "[OAuth] ml_user_id=%s: token listo; siguiente renovacion automatica antes del vencimiento",
            uid
          )
        )
        .catch((e) => console.error("[OAuth] ml_user_id=%s: %s", uid, e.message));
    }, i * stagger);
  });
}

/**
 * Obtiene un access_token válido; si está caducado o falta, llama al endpoint de refresh.
 * Usa el mismo refresh en memoria y, si la API devuelve uno nuevo, lo persiste en OAUTH_TOKEN_FILE.
 */
async function getAccessToken() {
  const margin = marginMs();
  if (cache.access_token && Date.now() < cache.expiresAt - margin) {
    return cache.access_token;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { id: cid, secret: csec } = envClient();
    const refresh_token = envRefresh();
    if (!cid || !csec || !refresh_token) {
      throw new Error(
        "Configura OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET y OAUTH_REFRESH_TOKEN (o ML_* y token en archivo)"
      );
    }
    const data = await performRefresh(refresh_token);

    cache.access_token = data.access_token;
    const expiresIn = Number(data.expires_in) || 3600;
    cache.expiresAt = Date.now() + expiresIn * 1000;

    if (data.refresh_token) {
      cache.refresh_token = data.refresh_token;
      writeTokenFile();
    }

    scheduleProactiveRefresh();

    return cache.access_token;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Varias cuentas: mismo Client ID / Secret de la app, un refresh_token por vendedor.
 * Los datos se guardan en tabla ml_accounts; el webhook trae user_id para saber cual usar.
 */
async function getAccessTokenForMlUser(mlUserId) {
  const id = Number(mlUserId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("mlUserId invalido");
  }
  const row = getMlAccount(id);
  if (!row || !row.refresh_token) {
    throw new Error(
      `No hay refresh_token guardado para user_id=${id}. Registra la cuenta (POST /admin/ml-accounts).`
    );
  }

  const margin = marginMs();
  const c = cacheByMlUser.get(id);
  if (c && c.access_token && Date.now() < c.expiresAt - margin) {
    return c.access_token;
  }

  let p = inFlightByMlUser.get(id);
  if (p) return p;

  p = (async () => {
    const data = await performRefresh(row.refresh_token);
    const expiresIn = Number(data.expires_in) || 3600;
    const next = {
      access_token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      refresh_token: data.refresh_token || row.refresh_token,
    };
    if (data.refresh_token) {
      upsertMlAccount(id, data.refresh_token, row.nickname);
    }
    cacheByMlUser.set(id, next);
    scheduleProactiveRefreshForMlUser(id);
    return next.access_token;
  })().finally(() => {
    inFlightByMlUser.delete(id);
  });

  inFlightByMlUser.set(id, p);
  return p;
}

/**
 * Convierte `resource` del webhook en path de API (p. ej. messages trae id sin "/").
 * Si ML cambia el endpoint, sobreescribe con ML_MESSAGES_PATH_PREFIX o el path completo en ML_*.
 */
function normalizeMlResourcePath(topic, resource) {
  if (!resource || typeof resource !== "string") return null;
  const r = resource.trim();
  if (!r) return null;
  if (r.startsWith("/")) return r;
  if (topic === "messages") {
    const prefix = process.env.ML_MESSAGES_PATH_PREFIX || "/messages";
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return `${base}/${r}`;
  }
  return `/${r}`;
}

async function mercadoLibreGetWithToken(getToken, resourcePath) {
  const token = await getToken();
  const base = process.env.ML_API_BASE || "https://api.mercadolibre.com";
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ML API ${res.status} ${path}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * GET autenticado sin lanzar si HTTP != 2xx; devuelve status y cuerpo parseado o texto.
 */
async function mercadoLibreFetchForUser(mlUserId, resourcePath) {
  const token = await getAccessTokenForMlUser(mlUserId);
  const base = process.env.ML_API_BASE || "https://api.mercadolibre.com";
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    path,
    url,
    data,
    rawText: text,
  };
}

/** GET autenticado (cuenta unica por variables de entorno). */
async function mercadoLibreGet(resourcePath) {
  return mercadoLibreGetWithToken(() => getAccessToken(), resourcePath);
}

/** GET autenticado para el vendedor `mlUserId`. */
async function mercadoLibreGetForUser(mlUserId, resourcePath) {
  return mercadoLibreGetWithToken(() => getAccessTokenForMlUser(mlUserId), resourcePath);
}

readTokenFile();
if (process.env.OAUTH_REFRESH_TOKEN || process.env.ML_REFRESH_TOKEN) {
  cache.refresh_token =
    process.env.OAUTH_REFRESH_TOKEN || process.env.ML_REFRESH_TOKEN;
}

/** Opcional: comprobación periódica (por si el temporizador único no basta en tu entorno). */
const keepaliveMs = Number(process.env.OAUTH_KEEPALIVE_MS || 0);
if (keepaliveMs > 0) {
  setInterval(() => {
    getAccessToken().catch((e) => console.error("[OAuth keepalive]", e.message));
  }, keepaliveMs);
}

function getTokenStatus() {
  const at = cache.access_token;
  return {
    access_token_preview: at ? `${at.slice(0, 8)}…${at.slice(-4)}` : null,
    mask: at ? `${at.slice(0, 8)}…${at.slice(-4)}` : null,
    expiresAtIso: cache.expiresAt ? new Date(cache.expiresAt).toISOString() : null,
    secondsRemaining:
      cache.expiresAt > 0
        ? Math.max(0, Math.floor((cache.expiresAt - Date.now()) / 1000))
        : 0,
  };
}

function getTokenStatusForMlUser(mlUserId) {
  const id = Number(mlUserId);
  const c = cacheByMlUser.get(id);
  const at = c && c.access_token;
  const preview = at ? `${at.slice(0, 8)}…${at.slice(-4)}` : null;
  return {
    ml_user_id: id,
    access_token_preview: preview,
    mask: preview,
    expiresAtIso: c && c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    secondsRemaining:
      c && c.expiresAt > 0
        ? Math.max(0, Math.floor((c.expiresAt - Date.now()) / 1000))
        : 0,
  };
}

module.exports = {
  getAccessToken,
  getAccessTokenForMlUser,
  mercadoLibreGet,
  mercadoLibreGetForUser,
  mercadoLibreFetchForUser,
  normalizeMlResourcePath,
  getTokenStatus,
  getTokenStatusForMlUser,
  warmAllMlAccountsRefresh,
};
