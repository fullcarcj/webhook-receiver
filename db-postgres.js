/**
 * Persistencia PostgreSQL (Render: DATABASE_URL interna o externa).
 * Misma API que db-sqlite.js pero funciones async.
 */
const { Pool } = require("pg");

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

const FETCH_PROCESS_STATUS_PENDING = "Procesando...";
const FETCH_PROCESS_STATUS_DONE = "Completado";
const FETCH_PROCESS_STATUS_POST_SALE_FAILED = "Fallo post-venta";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

let initDone = null;

async function ensureSchema() {
  if (!initDone) {
    initDone = runSchemaAndSeed();
  }
  return initDone;
}

async function runSchemaAndSeed() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      received_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      topic TEXT,
      resource TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON webhook_events(id)`,
    `CREATE TABLE IF NOT EXISTS ml_accounts (
      ml_user_id BIGINT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      nickname TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ml_topic_fetches (
      id SERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_user ON ml_topic_fetches(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_topic ON ml_topic_fetches(topic)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_topic_fetches_fetched ON ml_topic_fetches(fetched_at)`,
    `CREATE TABLE IF NOT EXISTS ml_buyers (
      buyer_id BIGINT PRIMARY KEY,
      nickname TEXT,
      phone_1 TEXT,
      phone_2 TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_buyers_updated ON ml_buyers(updated_at)`,
    `CREATE TABLE IF NOT EXISTS ml_post_sale_sent (
      order_id BIGINT PRIMARY KEY,
      sent_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ml_post_sale_auto_send_log (
      id SERIAL PRIMARY KEY,
      created_at TEXT NOT NULL,
      ml_user_id BIGINT NOT NULL,
      topic TEXT,
      notification_id TEXT,
      order_id BIGINT,
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      http_status INTEGER,
      option_id TEXT,
      request_path TEXT,
      response_body TEXT,
      error_message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ps_auto_log_created ON ml_post_sale_auto_send_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS post_sale_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Predeterminado',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ml_ventas_detalle_web (
      id SERIAL PRIMARY KEY,
      created_at TEXT NOT NULL,
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      request_url TEXT NOT NULL,
      http_status INTEGER,
      raw TEXT,
      celular TEXT,
      error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ventas_detalle_user_order ON ml_ventas_detalle_web(ml_user_id, order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ventas_detalle_created ON ml_ventas_detalle_web(created_at)`,
    `CREATE TABLE IF NOT EXISTS ml_post_sale_steps_sent (
      order_id BIGINT NOT NULL,
      step_index INTEGER NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (order_id, step_index)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_post_sale_steps_order ON ml_post_sale_steps_sent(order_id)`,
  ];
  for (const sql of stmts) {
    await pool.query(sql);
  }

  const { rows: cnt } = await pool.query("SELECT COUNT(*)::int AS c FROM post_sale_messages");
  if (cnt[0] && Number(cnt[0].c) === 0) {
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO post_sale_messages (name, body, created_at, updated_at) VALUES ($1, $2, $3, $4)`,
      ["Predeterminado", clipPostSaleBody(DEFAULT_POST_SALE_BODY), now, now]
    );
  }

  await migratePostSaleAutoSendLogNonOrdersV2();
  await migratePostSaleAutoSendLogTopicOrdersV2Only();
}

/** Una vez: elimina filas históricas de log post-venta cuyo topic no es orders_v2. */
async function migratePostSaleAutoSendLogNonOrdersV2() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS _mig_ps_auto_log_orders_v2 (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    const { rows: done } = await pool.query(
      `SELECT 1 FROM _mig_ps_auto_log_orders_v2 WHERE id = 1 LIMIT 1`
    );
    if (done.length > 0) return;
    const { rowCount } = await pool.query(
      `DELETE FROM ml_post_sale_auto_send_log WHERE topic IS NULL OR topic <> $1`,
      ["orders_v2"]
    );
    await pool.query(`INSERT INTO _mig_ps_auto_log_orders_v2 (id) VALUES (1)`);
    if (rowCount > 0) {
      console.log(
        `[db] ml_post_sale_auto_send_log: eliminadas ${rowCount} filas (topic distinto de orders_v2)`
      );
    }
  } catch (e) {
    console.error("[db] migrate ml_post_sale_auto_send_log orders_v2:", e.message);
  }
}

/** Limpia filas con topic ≠ orders_v2; añade CHECK la primera vez (PostgreSQL rechaza otros INSERT). */
async function migratePostSaleAutoSendLogTopicOrdersV2Only() {
  try {
    await pool.query(`DELETE FROM ml_post_sale_auto_send_log WHERE topic IS DISTINCT FROM 'orders_v2'`);
    await pool.query(
      `DELETE FROM ml_post_sale_auto_send_log WHERE outcome IN ('success', 'skipped')`
    );
    const { rows: hasCheck } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'ml_post_sale_auto_send_log_topic_orders_v2' LIMIT 1`
    );
    if (hasCheck.length > 0) return;
    await pool.query(`
      ALTER TABLE ml_post_sale_auto_send_log
      ADD CONSTRAINT ml_post_sale_auto_send_log_topic_orders_v2
      CHECK (topic = 'orders_v2')
    `);
    console.log("[db] ml_post_sale_auto_send_log: CHECK(topic = orders_v2) aplicado");
  } catch (e) {
    console.error("[db] migrate ml_post_sale_auto_send_log topic CHECK:", e.message);
  }
}

async function insertWebhook(payloadObj) {
  await ensureSchema();
  const received_at = new Date().toISOString();
  const payload = JSON.stringify(payloadObj);
  const topic =
    payloadObj && typeof payloadObj.topic === "string" ? payloadObj.topic : null;
  const resource =
    payloadObj && typeof payloadObj.resource === "string" ? payloadObj.resource : null;
  const { rows } = await pool.query(
    `INSERT INTO webhook_events (received_at, payload, topic, resource)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [received_at, payload, topic, resource]
  );
  return Number(rows[0].id);
}

async function listWebhooks(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 500;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, received_at, payload, topic, resource
     FROM webhook_events ORDER BY id ASC LIMIT $1`,
    [n]
  );
  return rows.map((r) => ({
    id: r.id,
    received_at: r.received_at,
    topic: r.topic,
    resource: r.resource,
    data: JSON.parse(r.payload),
  }));
}

async function deleteWebhooks(ids) {
  await ensureSchema();
  const list = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!list.length) return 0;
  const ph = list.map((_, i) => `$${i + 1}`).join(",");
  const { rowCount } = await pool.query(`DELETE FROM webhook_events WHERE id IN (${ph})`, list);
  return rowCount;
}

async function upsertMlAccount(mlUserId, refreshToken, nickname) {
  await ensureSchema();
  const updated_at = new Date().toISOString();
  await pool.query(
    `INSERT INTO ml_accounts (ml_user_id, refresh_token, nickname, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ml_user_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       nickname = COALESCE(EXCLUDED.nickname, ml_accounts.nickname),
       updated_at = EXCLUDED.updated_at`,
    [mlUserId, refreshToken, nickname || null, updated_at]
  );
}

async function getMlAccount(mlUserId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, refresh_token, nickname, updated_at FROM ml_accounts WHERE ml_user_id = $1`,
    [mlUserId]
  );
  return rows[0] || undefined;
}

async function listMlAccounts() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, nickname, updated_at FROM ml_accounts ORDER BY ml_user_id`
  );
  return rows;
}

async function deleteMlAccount(mlUserId) {
  await ensureSchema();
  const { rowCount } = await pool.query(`DELETE FROM ml_accounts WHERE ml_user_id = $1`, [mlUserId]);
  return rowCount;
}

async function insertTopicFetch(row) {
  await ensureSchema();
  const ps =
    row.process_status != null && String(row.process_status).trim() !== ""
      ? String(row.process_status).trim()
      : FETCH_PROCESS_STATUS_DONE;
  const { rows } = await pool.query(
    `INSERT INTO ml_topic_fetches (
       ml_user_id, topic, resource, request_path, http_status, fetched_at,
       notification_id, payload, process_status, error, sku, title
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      row.ml_user_id,
      row.topic != null ? String(row.topic) : null,
      row.resource,
      row.request_path,
      row.http_status,
      row.fetched_at,
      row.notification_id != null ? String(row.notification_id) : null,
      row.payload != null ? String(row.payload) : null,
      ps,
      row.error != null ? String(row.error) : null,
      row.sku != null && row.sku !== "" ? String(row.sku) : null,
      row.title != null && row.title !== "" ? String(row.title) : null,
    ]
  );
  return Number(rows[0].id);
}

async function updateTopicFetch(id, patch) {
  await ensureSchema();
  const { rows: cur } = await pool.query(
    `SELECT id, payload, error, sku, title, http_status, request_path, fetched_at, process_status
     FROM ml_topic_fetches WHERE id = $1`,
    [id]
  );
  const row = cur[0];
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
  await pool.query(
    `UPDATE ml_topic_fetches SET
       payload = $1,
       error = $2,
       sku = $3,
       title = $4,
       http_status = $5,
       request_path = $6,
       fetched_at = $7,
       process_status = $8
     WHERE id = $9`,
    [
      payload != null ? String(payload) : null,
      error != null ? String(error) : null,
      sku != null && sku !== "" ? String(sku) : null,
      title != null && title !== "" ? String(title) : null,
      http_status,
      request_path,
      fetched_at,
      process_status != null && String(process_status).trim() !== ""
        ? String(process_status).trim()
        : FETCH_PROCESS_STATUS_DONE,
      id,
    ]
  );
  return 1;
}

async function listTopicFetches(limit, maxAllowed, topicFilter) {
  await ensureSchema();
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
    const { rows } = await pool.query(
      `${selectFrom} WHERE f.topic = $1 ORDER BY f.id DESC LIMIT $2`,
      [tf, n]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `${selectFrom} ORDER BY COALESCE(f.topic, '') ASC, f.id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

async function listDistinctFetchTopics() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT DISTINCT topic FROM ml_topic_fetches WHERE topic IS NOT NULL AND TRIM(topic) != '' ORDER BY topic`
  );
  return rows.map((r) => r.topic);
}

async function deleteAllTopicFetches() {
  await ensureSchema();
  const { rowCount } = await pool.query("DELETE FROM ml_topic_fetches");
  return rowCount;
}

async function upsertMlBuyer(row) {
  await ensureSchema();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO ml_buyers (buyer_id, nickname, phone_1, phone_2, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (buyer_id) DO UPDATE SET
       nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), ml_buyers.nickname),
       phone_1 = COALESCE(EXCLUDED.phone_1, ml_buyers.phone_1),
       phone_2 = COALESCE(EXCLUDED.phone_2, ml_buyers.phone_2),
       updated_at = EXCLUDED.updated_at`,
    [
      row.buyer_id,
      row.nickname != null ? String(row.nickname) : null,
      row.phone_1 != null ? String(row.phone_1) : null,
      row.phone_2 != null ? String(row.phone_2) : null,
      now,
      now,
    ]
  );
}

async function listMlBuyers(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const { rows } = await pool.query(
    `SELECT buyer_id, nickname, phone_1, phone_2, created_at, updated_at
     FROM ml_buyers ORDER BY updated_at DESC LIMIT $1`,
    [n]
  );
  return rows;
}

function normalizeBuyerPhoneValue(v) {
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function getMlBuyer(buyerId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT buyer_id, nickname, phone_1, phone_2, created_at, updated_at
     FROM ml_buyers WHERE buyer_id = $1`,
    [buyerId]
  );
  return rows[0] || undefined;
}

async function updateMlBuyerPhones(buyerId, patch) {
  await ensureSchema();
  const row = await getMlBuyer(buyerId);
  if (!row) return null;
  const phone_1 =
    patch.phone_1 !== undefined ? normalizeBuyerPhoneValue(patch.phone_1) : row.phone_1;
  const phone_2 =
    patch.phone_2 !== undefined ? normalizeBuyerPhoneValue(patch.phone_2) : row.phone_2;
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE ml_buyers SET phone_1 = $1, phone_2 = $2, updated_at = $3
     WHERE buyer_id = $4`,
    [phone_1, phone_2, now, buyerId]
  );
  return {
    buyer_id: buyerId,
    nickname: row.nickname,
    phone_1,
    phone_2,
    created_at: row.created_at,
    updated_at: now,
  };
}

async function getPostSaleMessage(id) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, name, body, created_at, updated_at FROM post_sale_messages WHERE id = $1`,
    [id]
  );
  return rows[0] || undefined;
}

async function listPostSaleMessages() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, name, body, created_at, updated_at FROM post_sale_messages ORDER BY id ASC`
  );
  return rows;
}

async function insertPostSaleMessage(row) {
  await ensureSchema();
  const now = new Date().toISOString();
  const name =
    row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : "Sin nombre";
  const body = clipPostSaleBody(row.body != null ? String(row.body) : "");
  const { rows } = await pool.query(
    `INSERT INTO post_sale_messages (name, body, created_at, updated_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, body, now, now]
  );
  return Number(rows[0].id);
}

async function updatePostSaleMessage(id, row) {
  await ensureSchema();
  const existing = await getPostSaleMessage(id);
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
  const { rowCount } = await pool.query(
    `UPDATE post_sale_messages SET name = $1, body = $2, updated_at = $3 WHERE id = $4`,
    [name, body, now, id]
  );
  return rowCount;
}

async function deletePostSaleMessage(id) {
  await ensureSchema();
  const { rowCount } = await pool.query(`DELETE FROM post_sale_messages WHERE id = $1`, [id]);
  return rowCount;
}

async function getFirstPostSaleMessageBody() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT body FROM post_sale_messages ORDER BY id ASC LIMIT 1`);
  const row = rows[0];
  return row && row.body != null ? String(row.body) : null;
}

async function wasPostSaleSent(orderId, totalSteps) {
  await ensureSchema();
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const n = Math.min(Math.max(Number(totalSteps) || 1, 1), 3);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ml_post_sale_steps_sent WHERE order_id = $1 AND step_index >= 0 AND step_index < $2`,
    [id, n]
  );
  return Boolean(rows[0] && rows[0].c >= n);
}

async function isPostSaleStepSent(orderId, stepIndex) {
  await ensureSchema();
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_post_sale_steps_sent WHERE order_id = $1 AND step_index = $2 LIMIT 1`,
    [id, si]
  );
  return rows.length > 0;
}

async function markPostSaleStepSent(orderId, stepIndex) {
  await ensureSchema();
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return;
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO ml_post_sale_steps_sent (order_id, step_index, sent_at) VALUES ($1, $2, $3)
     ON CONFLICT (order_id, step_index) DO UPDATE SET sent_at = EXCLUDED.sent_at`,
    [id, si, now]
  );
}

async function markPostSaleSent(orderId) {
  await ensureSchema();
  const id = Number(orderId);
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO ml_post_sale_sent (order_id, sent_at) VALUES ($1, $2)
     ON CONFLICT (order_id) DO UPDATE SET sent_at = EXCLUDED.sent_at`,
    [id, now]
  );
}

async function deletePostSaleSent(orderId) {
  await ensureSchema();
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  await pool.query(`DELETE FROM ml_post_sale_steps_sent WHERE order_id = $1`, [id]);
  const { rowCount } = await pool.query(`DELETE FROM ml_post_sale_sent WHERE order_id = $1`, [id]);
  return rowCount;
}

async function insertPostSaleAutoSendLog(row) {
  const topicNorm = row.topic != null ? String(row.topic).trim() : "";
  if (topicNorm !== "orders_v2") return null;
  const out = String(row.outcome || "");
  if (out === "success" || out === "skipped") return null;
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO ml_post_sale_auto_send_log (
       created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
       http_status, option_id, request_path, response_body, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      row.created_at || new Date().toISOString(),
      row.ml_user_id,
      topicNorm,
      row.notification_id != null ? String(row.notification_id) : null,
      row.order_id != null ? Number(row.order_id) : null,
      String(row.outcome),
      row.skip_reason != null ? String(row.skip_reason).slice(0, 2000) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.option_id != null ? String(row.option_id) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
    ]
  );
  return Number(rows[0].id);
}

async function listPostSaleAutoSendLog(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
            http_status, option_id, request_path, response_body, error_message
     FROM ml_post_sale_auto_send_log
     WHERE topic = 'orders_v2' AND outcome NOT IN ('success', 'skipped')
     ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

async function insertMlVentasDetalleWeb(row) {
  await ensureSchema();
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
  const { rows } = await pool.query(
    `INSERT INTO ml_ventas_detalle_web (
       created_at, ml_user_id, order_id, request_url, http_status, raw, celular, error
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      row.created_at || new Date().toISOString(),
      Number(row.ml_user_id),
      Number(row.order_id),
      String(row.request_url).slice(0, 4000),
      row.http_status != null ? Number(row.http_status) : null,
      html,
      celular,
      row.error != null ? String(row.error).slice(0, 4000) : null,
    ]
  );
  return Number(rows[0].id);
}

async function listMlVentasDetalleWeb(limit, maxAllowed, includeRaw) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 500;
  const n = Math.min(Math.max(Number(limit) || 50, 1), cap);
  const sel = includeRaw
    ? `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw::text) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTRING(raw::text FROM 1 FOR 400) END AS resultado_g,
              celular,
              raw AS raw,
              error`
    : `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw::text) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTRING(raw::text FROM 1 FOR 400) END AS resultado_g,
              celular,
              error`;
  const { rows } = await pool.query(`${sel} FROM ml_ventas_detalle_web ORDER BY id DESC LIMIT $1`, [n]);
  return rows;
}

function dbPathDisplay() {
  const u = process.env.DATABASE_URL || "";
  try {
    const parsed = new URL(u);
    return `postgresql://${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return "postgresql:(DATABASE_URL)";
  }
}

module.exports = {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
  get dbPath() {
    return dbPathDisplay();
  },
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
  /** Cierra el pool (tests). */
  _poolEnd: () => pool.end(),
};
