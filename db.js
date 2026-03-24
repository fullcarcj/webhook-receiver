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
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_user ON ml_topic_fetches(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_topic ON ml_topic_fetches(topic);
  CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_fetched ON ml_topic_fetches(fetched_at);
`);

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
     notification_id, payload, error
   ) VALUES (
     @ml_user_id, @topic, @resource, @request_path, @http_status, @fetched_at,
     @notification_id, @payload, @error
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
  });
  return Number(info.lastInsertRowid);
}

function listTopicFetches(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  return db
    .prepare(
      `SELECT id, ml_user_id, topic, resource, request_path, http_status, fetched_at,
              notification_id, payload, error
       FROM ml_topic_fetches ORDER BY id DESC LIMIT ?`
    )
    .all(n);
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
};
