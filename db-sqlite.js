const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");

// Por defecto ./data (incl. Render). Para disco persistente: DB_PATH=/var/data/webhooks.db y disco montado en /var/data.
const dbPath =
  process.env.DB_PATH || path.join(__dirname, "data", "webhooks.db");
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
    process_status TEXT,
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

  CREATE TABLE IF NOT EXISTS ml_post_sale_sent (
    order_id INTEGER PRIMARY KEY,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_post_sale_auto_send_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    ml_user_id INTEGER NOT NULL,
    topic TEXT,
    notification_id TEXT,
    order_id INTEGER,
    outcome TEXT NOT NULL,
    skip_reason TEXT,
    http_status INTEGER,
    option_id TEXT,
    request_path TEXT,
    response_body TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ps_auto_log_created ON ml_post_sale_auto_send_log(created_at);

  CREATE TABLE IF NOT EXISTS post_sale_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Predeterminado',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_ventas_detalle_web (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    ml_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    request_url TEXT NOT NULL,
    http_status INTEGER,
    raw TEXT,
    celular TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ventas_detalle_user_order ON ml_ventas_detalle_web(ml_user_id, order_id);
  CREATE INDEX IF NOT EXISTS idx_ventas_detalle_created ON ml_ventas_detalle_web(created_at);
`);

(function migratePostSalePackIdToOrderId() {
  try {
    const t1 = db.prepare("PRAGMA table_info(ml_post_sale_sent)").all();
    const n1 = new Set(t1.map((c) => c.name));
    if (n1.has("pack_id") && !n1.has("order_id")) {
      db.exec("ALTER TABLE ml_post_sale_sent RENAME COLUMN pack_id TO order_id");
    }
  } catch (e) {
    console.error("[db] migrate ml_post_sale_sent:", e.message);
  }
  try {
    const t2 = db.prepare("PRAGMA table_info(ml_post_sale_auto_send_log)").all();
    const n2 = new Set(t2.map((c) => c.name));
    if (n2.has("pack_id") && !n2.has("order_id")) {
      db.exec("ALTER TABLE ml_post_sale_auto_send_log RENAME COLUMN pack_id TO order_id");
      db.exec("DROP INDEX IF EXISTS idx_ps_auto_log_pack");
    }
  } catch (e) {
    console.error("[db] migrate ml_post_sale_auto_send_log:", e.message);
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ps_auto_log_order ON ml_post_sale_auto_send_log(order_id)"
    );
  } catch (e) {
    console.error("[db] idx_ps_auto_log_order:", e.message);
  }
})();

(function migrateMlVentasDetalleRaw() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_ventas_detalle_web)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("raw")) {
      if (names.has("body")) {
        db.exec("ALTER TABLE ml_ventas_detalle_web ADD COLUMN raw TEXT");
        db.exec("UPDATE ml_ventas_detalle_web SET raw = body WHERE raw IS NULL AND body IS NOT NULL");
      } else {
        db.exec("ALTER TABLE ml_ventas_detalle_web ADD COLUMN raw TEXT");
      }
    }
  } catch (e) {
    console.error("[db] migrate ml_ventas_detalle_web raw:", e.message);
  }
})();

(function migrateMlVentasDetalleCelular() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_ventas_detalle_web)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("celular")) {
      db.exec("ALTER TABLE ml_ventas_detalle_web ADD COLUMN celular TEXT");
    }
  } catch (e) {
    console.error("[db] migrate ml_ventas_detalle_web celular:", e.message);
  }
})();

/** Pasos de envío post-venta por orden (evita duplicar al reintentar). */
(function migrateMlPostSaleStepsSent() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ml_post_sale_steps_sent (
        order_id INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (order_id, step_index)
      );
      CREATE INDEX IF NOT EXISTS idx_ml_post_sale_steps_order ON ml_post_sale_steps_sent(order_id);
    `);
    db.exec(`
      INSERT OR IGNORE INTO ml_post_sale_steps_sent (order_id, step_index, sent_at)
      SELECT order_id, 0, sent_at FROM ml_post_sale_sent
    `);
  } catch (e) {
    console.error("[db] migrate ml_post_sale_steps_sent:", e.message);
  }
})();

/** Una vez: elimina filas históricas de log post-venta cuyo topic no es orders_v2. */
(function migratePostSaleAutoSendLogNonOrdersV2() {
  try {
    const done = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_mig_ps_auto_log_orders_v2'"
      )
      .get();
    if (done) return;
    const r = db
      .prepare(
        "DELETE FROM ml_post_sale_auto_send_log WHERE topic IS NULL OR topic <> 'orders_v2'"
      )
      .run();
    db.exec(
      "CREATE TABLE _mig_ps_auto_log_orders_v2 (id INTEGER PRIMARY KEY CHECK (id = 1), applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    db.prepare("INSERT INTO _mig_ps_auto_log_orders_v2 (id) VALUES (1)").run();
    if (r.changes > 0) {
      console.log(
        `[db] ml_post_sale_auto_send_log: eliminadas ${r.changes} filas (topic distinto de orders_v2)`
      );
    }
  } catch (e) {
    console.error("[db] migrate ml_post_sale_auto_send_log orders_v2:", e.message);
  }
})();

/** Máximo alineado con API ML (option OTHER) y UI /mensajes-postventa. */
const POST_SALE_MESSAGE_BODY_MAX = 350;

function clipPostSaleBody(s) {
  const t = s != null ? String(s) : "";
  return t.length > POST_SALE_MESSAGE_BODY_MAX ? t.slice(0, POST_SALE_MESSAGE_BODY_MAX) : t;
}

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
    ).run("Predeterminado", clipPostSaleBody(DEFAULT_POST_SALE_BODY), now, now);
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

/** Tras payload: Procesando... mientras GET ML; Completado al guardar resultado. */
const FETCH_PROCESS_STATUS_PENDING = "Procesando...";
const FETCH_PROCESS_STATUS_DONE = "Completado";
/** Topic orders: envío automático post-venta respondió error (no Completado). */
const FETCH_PROCESS_STATUS_POST_SALE_FAILED = "Fallo post-venta";

(function migrateMlTopicFetchesProcessStatus() {
  try {
    const cols = db.prepare("PRAGMA table_info(ml_topic_fetches)").all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("process_status")) {
      db.exec("ALTER TABLE ml_topic_fetches ADD COLUMN process_status TEXT");
    }
    db.prepare(`UPDATE ml_topic_fetches SET process_status = ? WHERE process_status IS NULL`).run(
      FETCH_PROCESS_STATUS_DONE
    );
  } catch (e) {
    console.error("[db] migrate ml_topic_fetches process_status:", e.message);
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
     notification_id, payload, process_status, error, sku, title
   ) VALUES (
     @ml_user_id, @topic, @resource, @request_path, @http_status, @fetched_at,
     @notification_id, @payload, @process_status, @error, @sku, @title
   )`
);

function insertTopicFetch(row) {
  const ps =
    row.process_status != null && String(row.process_status).trim() !== ""
      ? String(row.process_status).trim()
      : FETCH_PROCESS_STATUS_DONE;
  const info = insertTopicFetchStmt.run({
    ml_user_id: row.ml_user_id,
    topic: row.topic != null ? String(row.topic) : null,
    resource: row.resource,
    request_path: row.request_path,
    http_status: row.http_status,
    fetched_at: row.fetched_at,
    notification_id: row.notification_id != null ? String(row.notification_id) : null,
    payload: row.payload != null ? String(row.payload) : null,
    process_status: ps,
    error: row.error != null ? String(row.error) : null,
    sku: row.sku != null && row.sku !== "" ? String(row.sku) : null,
    title: row.title != null && row.title !== "" ? String(row.title) : null,
  });
  return Number(info.lastInsertRowid);
}

/**
 * @param {number} id
 * @param {Partial<{ payload: string|null, error: string|null, sku: string|null, title: string|null, http_status: number, request_path: string, fetched_at: string, process_status: string }>} patch
 */
function updateTopicFetch(id, patch) {
  const row = db
    .prepare(
      `SELECT id, payload, error, sku, title, http_status, request_path, fetched_at, process_status
       FROM ml_topic_fetches WHERE id = ?`
    )
    .get(id);
  if (!row) return 0;
  const payload = patch.payload !== undefined ? patch.payload : row.payload;
  const error = patch.error !== undefined ? patch.error : row.error;
  const sku = patch.sku !== undefined ? patch.sku : row.sku;
  const title = patch.title !== undefined ? patch.title : row.title;
  const http_status = patch.http_status !== undefined ? patch.http_status : row.http_status;
  const request_path = patch.request_path !== undefined ? patch.request_path : row.request_path;
  const fetched_at = patch.fetched_at !== undefined ? patch.fetched_at : row.fetched_at;
  const process_status =
    patch.process_status !== undefined ? patch.process_status : row.process_status;
  db.prepare(
    `UPDATE ml_topic_fetches SET
       payload = @payload,
       error = @error,
       sku = @sku,
       title = @title,
       http_status = @http_status,
       request_path = @request_path,
       fetched_at = @fetched_at,
       process_status = @process_status
     WHERE id = @id`
  ).run({
    id,
    payload: payload != null ? String(payload) : null,
    error: error != null ? String(error) : null,
    sku: sku != null && sku !== "" ? String(sku) : null,
    title: title != null && title !== "" ? String(title) : null,
    http_status,
    request_path,
    fetched_at,
    process_status:
      process_status != null && String(process_status).trim() !== ""
        ? String(process_status).trim()
        : FETCH_PROCESS_STATUS_DONE,
  });
  return 1;
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
              f.notification_id, f.payload, f.process_status, f.error, f.sku, f.title,
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

/** Borra todas las filas de ml_topic_fetches. Devuelve número de filas eliminadas. */
function deleteAllTopicFetches() {
  return db.prepare("DELETE FROM ml_topic_fetches").run().changes;
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

function normalizeBuyerPhoneValue(v) {
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function getMlBuyer(buyerId) {
  return db
    .prepare(
      `SELECT buyer_id, nickname, phone_1, phone_2, created_at, updated_at
       FROM ml_buyers WHERE buyer_id = ?`
    )
    .get(buyerId);
}

/** Actualiza phone_1 y/o phone_2; campos omitidos se conservan. null o "" borran el teléfono. */
function updateMlBuyerPhones(buyerId, patch) {
  const row = getMlBuyer(buyerId);
  if (!row) return null;
  const phone_1 =
    patch.phone_1 !== undefined ? normalizeBuyerPhoneValue(patch.phone_1) : row.phone_1;
  const phone_2 =
    patch.phone_2 !== undefined ? normalizeBuyerPhoneValue(patch.phone_2) : row.phone_2;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ml_buyers SET phone_1 = @phone_1, phone_2 = @phone_2, updated_at = @updated_at
     WHERE buyer_id = @buyer_id`
  ).run({
    buyer_id: buyerId,
    phone_1,
    phone_2,
    updated_at: now,
  });
  return {
    buyer_id: buyerId,
    nickname: row.nickname,
    phone_1,
    phone_2,
    created_at: row.created_at,
    updated_at: now,
  };
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
  const body = clipPostSaleBody(row.body != null ? String(row.body) : "");
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
  const body =
    row.body !== undefined ? clipPostSaleBody(String(row.body)) : existing.body;
  return db
    .prepare(`UPDATE post_sale_messages SET name = ?, body = ?, updated_at = ? WHERE id = ?`)
    .run(name, body, now, id).changes;
}

function deletePostSaleMessage(id) {
  return db.prepare(`DELETE FROM post_sale_messages WHERE id = ?`).run(id).changes;
}

function getFirstPostSaleMessageBody() {
  const row = db.prepare(`SELECT body FROM post_sale_messages ORDER BY id ASC LIMIT 1`).get();
  return row && row.body != null ? String(row.body) : null;
}

/**
 * @param {number|string} orderId
 * @param {number} [totalSteps=1] — cuántos pasos (plantillas) deben estar enviados para considerar la orden cerrada
 */
function wasPostSaleSent(orderId, totalSteps) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const n = Math.min(Math.max(Number(totalSteps) || 1, 1), 3);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ml_post_sale_steps_sent WHERE order_id = ? AND step_index >= 0 AND step_index < ?`
    )
    .get(id, n);
  return Boolean(row && row.c >= n);
}

function isPostSaleStepSent(orderId, stepIndex) {
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return false;
  return Boolean(
    db.prepare(`SELECT 1 FROM ml_post_sale_steps_sent WHERE order_id = ? AND step_index = ?`).get(id, si)
  );
}

function markPostSaleStepSent(orderId, stepIndex) {
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO ml_post_sale_steps_sent (order_id, step_index, sent_at) VALUES (?, ?, ?)`
  ).run(id, si, now);
}

/** Marca envío “completo” en tabla legada (compatibilidad). Llamar tras todos los pasos OK. */
function markPostSaleSent(orderId) {
  const id = Number(orderId);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO ml_post_sale_sent (order_id, sent_at) VALUES (?, ?)`).run(id, now);
}

/** Quita marca de enviado para permitir otro intento (uso con reintento manual). */
function deletePostSaleSent(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  db.prepare(`DELETE FROM ml_post_sale_steps_sent WHERE order_id = ?`).run(id);
  return db.prepare(`DELETE FROM ml_post_sale_sent WHERE order_id = ?`).run(id).changes;
}

const insertPostSaleAutoSendLogStmt = db.prepare(
  `INSERT INTO ml_post_sale_auto_send_log (
     created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
     http_status, option_id, request_path, response_body, error_message
   ) VALUES (
     @created_at, @ml_user_id, @topic, @notification_id, @order_id, @outcome, @skip_reason,
     @http_status, @option_id, @request_path, @response_body, @error_message
   )`
);

function insertPostSaleAutoSendLog(row) {
  const topicNorm = row.topic != null ? String(row.topic).trim() : "";
  if (topicNorm !== "orders_v2") return null;
  const info = insertPostSaleAutoSendLogStmt.run({
    created_at: row.created_at || new Date().toISOString(),
    ml_user_id: row.ml_user_id,
    topic: topicNorm,
    notification_id: row.notification_id != null ? String(row.notification_id) : null,
    order_id: row.order_id != null ? Number(row.order_id) : null,
    outcome: String(row.outcome),
    skip_reason: row.skip_reason != null ? String(row.skip_reason).slice(0, 2000) : null,
    http_status: row.http_status != null ? Number(row.http_status) : null,
    option_id: row.option_id != null ? String(row.option_id) : null,
    request_path: row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
    response_body: row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
    error_message: row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
  });
  return Number(info.lastInsertRowid);
}

function listPostSaleAutoSendLog(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  return db
    .prepare(
      `SELECT id, created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
              http_status, option_id, request_path, response_body, error_message
       FROM ml_post_sale_auto_send_log
       WHERE topic = 'orders_v2'
       ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

const insertMlVentasDetalleWebStmt = db.prepare(
  `INSERT INTO ml_ventas_detalle_web (
     created_at, ml_user_id, order_id, request_url, http_status, raw, celular, error
   ) VALUES (
     @created_at, @ml_user_id, @order_id, @request_url, @http_status, @raw, @celular, @error
   )`
);

function insertMlVentasDetalleWeb(row) {
  const html =
    row.raw != null
      ? String(row.raw)
      : row.body != null
        ? String(row.body)
        : null;
  const celular =
    row.celular != null && String(row.celular).trim() !== ""
      ? String(row.celular).replace(/\s+/g, "").slice(0, 16)
      : null;
  const info = insertMlVentasDetalleWebStmt.run({
    created_at: row.created_at || new Date().toISOString(),
    ml_user_id: Number(row.ml_user_id),
    order_id: Number(row.order_id),
    request_url: String(row.request_url).slice(0, 4000),
    http_status: row.http_status != null ? Number(row.http_status) : null,
    raw: html,
    celular,
    error: row.error != null ? String(row.error).slice(0, 4000) : null,
  });
  return Number(info.lastInsertRowid);
}

function listMlVentasDetalleWeb(limit, maxAllowed, includeRaw) {
  const cap = maxAllowed != null ? maxAllowed : 500;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  const sel = includeRaw
    ? `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTR(raw, 1, 400) END AS resultado_g,
              celular,
              raw AS raw,
              error`
    : `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTR(raw, 1, 400) END AS resultado_g,
              celular,
              error`;
  return db.prepare(`${sel} FROM ml_ventas_detalle_web ORDER BY id DESC LIMIT ?`).all(n);
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
  updateTopicFetch,
  listTopicFetches,
  FETCH_PROCESS_STATUS_PENDING,
  FETCH_PROCESS_STATUS_DONE,
  FETCH_PROCESS_STATUS_POST_SALE_FAILED,
  listDistinctFetchTopics,
  deleteAllTopicFetches,
  upsertMlBuyer,
  listMlBuyers,
  getMlBuyer,
  updateMlBuyerPhones,
  getPostSaleMessage,
  listPostSaleMessages,
  insertPostSaleMessage,
  updatePostSaleMessage,
  deletePostSaleMessage,
  getFirstPostSaleMessageBody,
  wasPostSaleSent,
  isPostSaleStepSent,
  markPostSaleStepSent,
  markPostSaleSent,
  deletePostSaleSent,
  insertPostSaleAutoSendLog,
  listPostSaleAutoSendLog,
  insertMlVentasDetalleWeb,
  listMlVentasDetalleWeb,
};
