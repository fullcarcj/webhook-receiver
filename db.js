const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "webhooks.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    topic TEXT,
    resource TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON webhook_events(id);

  CREATE TABLE IF NOT EXISTS ml_accounts (
    ml_user_id INTEGER PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    nickname TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_topic_fetches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    topic TEXT,
    resource TEXT NOT NULL,
    request_path TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    notification_id TEXT,
    payload TEXT,
    error TEXT,
    sku TEXT,
    title TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_user ON ml_topic_fetches(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_topic ON ml_topic_fetches(topic);
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_fetched ON ml_topic_fetches(fetched_at);

  CREATE TABLE IF NOT EXISTS ml_buyers (
    buyer_id INTEGER PRIMARY KEY,
    nickname TEXT,
    phone_1 TEXT,
    phone_2 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_buyers_updated ON ml_buyers(updated_at);

  CREATE TABLE IF NOT EXISTS post_sale_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Predeterminado',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const DEFAULT_POST_SALE_BODY = `TELÉFONOS:  04241394269   04242701513  Atiende DIEGO / DANIEL / CESAR

DIRECCIÓN: Calle Coromoto a una cuadra de la salida del CC El Recreo, Qta Cruz Maria, Urbanizacion Bello Monte Tocar el timbre.

HORARIO  Lunes a Viernes Corrido de 8:00 am a 5:00 pm. Sábado 9AM - 4 PM.

ENVÍO GRATIS - ZOOM (SE COLOCAN A LAS 3 PM) PEDIDOS YA Y YUMMI MAS DE 10$

NO Ofertar Varias veces por favor`;

(function seedPostSaleMessagesIfEmpty() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM post_sale_messages").get();
  if (row && row.c === 0) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO post_sale_messages (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run("Predeterminado", DEFAULT_POST_SALE_BODY, now, now);
  }
})();

(function migrateMlTopicFetchesSkuTitle() {
  const cols = db.prepare("PRAGMA table_info(ml_topic_fetches)").all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("sku")) {
    db.exec("ALTER TABLE ml_topic_fetches ADD COLUMN sku TEXT");
  }
  if (!names.has("title")) {
    db.exec("ALTER TABLE ml_topic_fetches ADD COLUMN title TEXT");
  }
})();

const insertStmt = db.prepare(
  `INSERT INTO webhook_events (received_at, payload, topic, resource)
   VALUES (@received_at, @payload, @topic, @resource)`
);

function insertWebhook(payloadObj) {
  const received_at = new Date().toISOString();
  const payload = JSON.stringify(payloadObj);
  const topic =
    payloadObj && typeof payloadObj.topic === "string" ? payloadObj.topic : null;
  const resource =
    payloadObj && typeof payloadObj.resource === "string"
      ? payloadObj.resource
      : null;
  const info = insertStmt.run({
    received_at,
    payload,
    topic,
    resource,
  });
  return Number(info.lastInsertRowid);
}

function listWebhooks(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 500;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  const rows = db
    .prepare(
      `SELECT id, received_at, payload, topic, resource
       FROM webhook_events ORDER BY id ASC LIMIT ?`
    )
    .all(n);
  return rows.map((r) => ({
    id: r.id,
    received_at: r.received_at,
    topic: r.topic,
    resource: r.resource,
    data: JSON.parse(r.payload),
  }));
}

function deleteWebhooks(ids) {
  const list = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!list.length) return 0;
  const placeholders = list.map(() => "?").join(",");
  const q = db.prepare(`DELETE FROM webhook_events WHERE id IN (${placeholders})`);
  return q.run(...list).changes;
}

const upsertAccountStmt = db.prepare(
  `INSERT INTO ml_accounts (ml_user_id, refresh_token, nickname, updated_at)
   VALUES (@ml_user_id, @refresh_token, @nickname, @updated_at)
   ON CONFLICT(ml_user_id) DO UPDATE SET
     refresh_token = excluded.refresh_token,
     nickname = COALESCE(excluded.nickname, ml_accounts.nickname),
     updated_at = excluded.updated_at`
);

function upsertMlAccount(mlUserId, refreshToken, nickname) {
  const updated_at = new Date().toISOString();
  upsertAccountStmt.run({
    ml_user_id: mlUserId,
    refresh_token: refreshToken,
    nickname: nickname || null,
    updated_at,
  });
}

function getMlAccount(mlUserId) {
  return db
    .prepare(`SELECT ml_user_id, refresh_token, nickname, updated_at FROM ml_accounts WHERE ml_user_id = ?`)
    .get(mlUserId);
}

function listMlAccounts() {
  return db
    .prepare(`SELECT ml_user_id, nickname, updated_at FROM ml_accounts ORDER BY ml_user_id`)
    .all();
}

function deleteMlAccount(mlUserId) {
  return db.prepare(`DELETE FROM ml_accounts WHERE ml_user_id = ?`).run(mlUserId).changes;
}

const insertTopicFetchStmt = db.prepare(
  `INSERT INTO ml_topic_fetches (
     ml_user_id, topic, resource, request_path, http_status, fetched_at,
     notification_id, payload, error, sku, title
   ) VALUES (
     @ml_user_id, @topic, @resource, @request_path, @http_status, @fetched_at,
     @notification_id, @payload, @error, @sku, @title
   )`
);

function insertTopicFetch(row) {
  const info = insertTopicFetchStmt.run({
    ml_user_id: row.ml_user_id,
    topic: row.topic != null ? String(row.topic) : null,
    resource: row.resource,
    request_path: row.request_path,
    http_status: row.http_status,
    fetched_at: row.fetched_at,
    notification_id: row.notification_id != null ? String(row.notification_id) : null,
    payload: row.payload != null ? String(row.payload) : null,
    error: row.error != null ? String(row.error) : null,
    sku: row.sku != null && row.sku !== "" ? String(row.sku) : null,
    title: row.title != null && row.title !== "" ? String(row.title) : null,
  });
  return Number(info.lastInsertRowid);
}

/**
 * @param {string} [topicFilter] - Si se indica, solo filas con ese topic (exacto).
 * Sin filtro: orden por topic (A→Z) y dentro de cada topic por id descendente.
 */
function listTopicFetches(limit, maxAllowed, topicFilter) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  const tf =
    topicFilter != null && String(topicFilter).trim() !== ""
      ? String(topicFilter).trim()
      : null;

  const selectFrom = `SELECT f.id, f.ml_user_id, f.topic, f.resource, f.request_path, f.http_status, f.fetched_at,
              f.notification_id, f.payload, f.error, f.sku, f.title,
              a.nickname AS nickname
       FROM ml_topic_fetches f
       LEFT JOIN ml_accounts a ON a.ml_user_id = f.ml_user_id`;

  if (tf) {
    return db.prepare(`${selectFrom} WHERE f.topic = ? ORDER BY f.id DESC LIMIT ?`).all(tf, n);
  }
  return db
    .prepare(`${selectFrom} ORDER BY COALESCE(f.topic, '') ASC, f.id DESC LIMIT ?`)
    .all(n);
}

/** Topics distintos que hay en la tabla (para filtros en /fetches). */
function listDistinctFetchTopics() {
  return db
    .prepare(
      `SELECT DISTINCT topic FROM ml_topic_fetches WHERE topic IS NOT NULL AND TRIM(topic) != '' ORDER BY topic`
    )
    .all()
    .map((r) => r.topic);
}

const upsertMlBuyerStmt = db.prepare(
  `INSERT INTO ml_buyers (buyer_id, nickname, phone_1, phone_2, created_at, updated_at)
   VALUES (@buyer_id, @nickname, @phone_1, @phone_2, @created_at, @updated_at)
   ON CONFLICT(buyer_id) DO UPDATE SET
     nickname = COALESCE(NULLIF(excluded.nickname, ''), ml_buyers.nickname),
     phone_1 = COALESCE(excluded.phone_1, ml_buyers.phone_1),
     phone_2 = COALESCE(excluded.phone_2, ml_buyers.phone_2),
     updated_at = excluded.updated_at`
);

function upsertMlBuyer(row) {
  const now = new Date().toISOString();
  upsertMlBuyerStmt.run({
    buyer_id: row.buyer_id,
    nickname: row.nickname != null ? String(row.nickname) : null,
    phone_1: row.phone_1 != null ? String(row.phone_1) : null,
    phone_2: row.phone_2 != null ? String(row.phone_2) : null,
    created_at: now,
    updated_at: now,
  });
}

function listMlBuyers(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  return db
    .prepare(
      `SELECT buyer_id, nickname, phone_1, phone_2, created_at, updated_at
       FROM ml_buyers ORDER BY updated_at DESC LIMIT ?`
    )
    .all(n);
}

const insertPostSaleMessageStmt = db.prepare(
  `INSERT INTO post_sale_messages (name, body, created_at, updated_at)
   VALUES (@name, @body, @created_at, @updated_at)`
);

function getPostSaleMessage(id) {
  return db
    .prepare(`SELECT id, name, body, created_at, updated_at FROM post_sale_messages WHERE id = ?`)
    .get(id);
}

function listPostSaleMessages() {
  return db
    .prepare(`SELECT id, name, body, created_at, updated_at FROM post_sale_messages ORDER BY id ASC`)
    .all();
}

function insertPostSaleMessage(row) {
  const now = new Date().toISOString();
  const name =
    row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : "Sin nombre";
  const body = row.body != null ? String(row.body) : "";
  const info = insertPostSaleMessageStmt.run({
    name,
    body,
    created_at: now,
    updated_at: now,
  });
  return Number(info.lastInsertRowid);
}

function updatePostSaleMessage(id, row) {
  const existing = getPostSaleMessage(id);
  if (!existing) return 0;
  const now = new Date().toISOString();
  const name =
    row.name !== undefined
      ? String(row.name).trim() !== ""
        ? String(row.name).trim()
        : existing.name
      : existing.name;
  const body = row.body !== undefined ? String(row.body) : existing.body;
  return db
    .prepare(`UPDATE post_sale_messages SET name = ?, body = ?, updated_at = ? WHERE id = ?`)
    .run(name, body, now, id).changes;
}

function deletePostSaleMessage(id) {
  return db.prepare(`DELETE FROM post_sale_messages WHERE id = ?`).run(id).changes;
}

module.exports = {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
  dbPath,
  upsertMlAccount,
  getMlAccount,
  listMlAccounts,
  deleteMlAccount,
  insertTopicFetch,
  listTopicFetches,
  listDistinctFetchTopics,
  upsertMlBuyer,
  listMlBuyers,
  getPostSaleMessage,
  listPostSaleMessages,
  insertPostSaleMessage,
  updatePostSaleMessage,
  deletePostSaleMessage,
};
