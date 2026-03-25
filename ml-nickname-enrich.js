/**
 * Si no hay nickname en ml_accounts, lo obtiene del perfil público GET /users/{id}
 * (sin token) y opcionalmente lo persiste para que el JOIN futuro lo tenga.
 */
const { getMlAccount, upsertMlAccount } = require("./db");

const cache = new Map();

async function fetchPublicNickname(mlUserId) {
  const id = Number(mlUserId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (cache.has(id)) return cache.get(id);

  const base = process.env.ML_API_BASE || "https://api.mercadolibre.com";
  try {
    const res = await fetch(`${base}/users/${id}`);
    if (!res.ok) {
      cache.set(id, null);
      return null;
    }
    const data = await res.json();
    const nick =
      data && data.nickname != null && String(data.nickname).trim() !== ""
        ? String(data.nickname)
        : null;
    cache.set(id, nick);
    return nick;
  } catch {
    cache.set(id, null);
    return null;
  }
}

/**
 * @param {Array<{ ml_user_id: number, nickname?: string|null } & Record<string, unknown>>} rows
 */
async function enrichNicknameForFetches(rows) {
  return Promise.all(
    rows.map(async (r) => {
      if (r.nickname != null && String(r.nickname).trim() !== "") {
        return r;
      }
      const n = await fetchPublicNickname(r.ml_user_id);
      if (n && r.ml_user_id != null) {
        try {
          const acc = await getMlAccount(r.ml_user_id);
          if (acc && (!acc.nickname || !String(acc.nickname).trim())) {
            await upsertMlAccount(r.ml_user_id, acc.refresh_token, n);
          }
        } catch {
          /* ignorar */
        }
        return { ...r, nickname: n };
      }
      return { ...r, nickname: r.nickname || null };
    })
  );
}

module.exports = { enrichNicknameForFetches, fetchPublicNickname };
