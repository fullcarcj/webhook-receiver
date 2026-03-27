/**
 * Persistencia PostgreSQL (Render: DATABASE_URL interna o externa).
 * Esquema y migraciones: fuente principal para producción; mantener db-sqlite.js alineado.
 * Misma API que db-sqlite.js pero funciones async.
 */
const { Pool } = require("pg");
const {
  normalizeBuyerPrefEntrega,
  normalizeCambioDatos,
  normalizeNombreApellido,
  resolvePrefEntregaForUpsert,
} = require("./ml-buyer-pref");

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

/**
 * Postgres en la nube (Render, Neon, etc.) exige TLS. Sin esto suele aparecer "SSL/TLS required" o ECONNRESET.
 * Localhost sin SSL: PGSSLMODE=disable o URL solo a 127.0.0.1.
 */
function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:\/]/i.test(raw) ||
    /@127\.0\.0\.1[:\/]/i.test(raw) ||
    /:\/\/localhost[:\/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:\/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: poolSslOption(),
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
      nombre_apellido TEXT,
      phone_1 TEXT,
      phone_2 TEXT,
      pref_entrega TEXT DEFAULT 'Pickup',
      cambio_datos TEXT,
      actualizacion TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT ml_buyers_pref_entrega_check CHECK (
        pref_entrega IS NULL OR pref_entrega IN ('Pickup', 'Envio Courier', 'Delivery')
      )
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
      error TEXT,
      pos_buyer_info_text INTEGER,
      pos_label INTEGER
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
  await migrateMlBuyersPrefEntrega();
  await migrateMlBuyersCambioDatos();
  await migrateMlBuyersActualizacionYDefaults();
  await migrateMlBuyersNombreApellido();
  await migrateMlVentasDetalleAnchorPositions();
  await migrateMlAccountsCookiesNetscape();
}

/** Cookies Netscape para GET detalle ventas (.ve); opcional por cuenta (prioridad sobre archivo). */
async function migrateMlAccountsCookiesNetscape() {
  try {
    const { rows: c1 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_accounts' AND column_name = 'cookies_netscape'`
    );
    if (c1.length === 0) {
      await pool.query(`ALTER TABLE ml_accounts ADD COLUMN cookies_netscape TEXT`);
      console.log("[db] ml_accounts: columna cookies_netscape añadida (migración)");
    }
    const { rows: c2 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_accounts' AND column_name = 'cookies_updated_at'`
    );
    if (c2.length === 0) {
      await pool.query(`ALTER TABLE ml_accounts ADD COLUMN cookies_updated_at TEXT`);
      console.log("[db] ml_accounts: columna cookies_updated_at añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_accounts cookies netscape:", e.message);
  }
}

/** Columnas de prueba: índice 0-based primera aparición buyer_info_text y label en raw. */
async function migrateMlVentasDetalleAnchorPositions() {
  try {
    const { rows: c1 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_ventas_detalle_web' AND column_name = 'pos_buyer_info_text'`
    );
    if (c1.length === 0) {
      await pool.query(`ALTER TABLE ml_ventas_detalle_web ADD COLUMN pos_buyer_info_text INTEGER`);
      console.log("[db] ml_ventas_detalle_web: columna pos_buyer_info_text añadida (migración)");
    }
    const { rows: c2 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_ventas_detalle_web' AND column_name = 'pos_label'`
    );
    if (c2.length === 0) {
      await pool.query(`ALTER TABLE ml_ventas_detalle_web ADD COLUMN pos_label INTEGER`);
      console.log("[db] ml_ventas_detalle_web: columna pos_label añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_ventas_detalle_web anchor pos:", e.message);
  }
}

/** Columna nombre_apellido (Nombre y Apellido) entre nickname y phone_1. */
async function migrateMlBuyersNombreApellido() {
  try {
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_buyers' AND column_name = 'nombre_apellido'`
    );
    if (col.length === 0) {
      await pool.query(`ALTER TABLE ml_buyers ADD COLUMN nombre_apellido TEXT`);
      console.log("[db] ml_buyers: columna nombre_apellido añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers nombre_apellido:", e.message);
  }
}

/** Columna pref_entrega (Pref. entrega) en instalaciones previas sin ella. */
async function migrateMlBuyersPrefEntrega() {
  try {
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_buyers' AND column_name = 'pref_entrega'`
    );
    if (col.length === 0) {
      await pool.query(`ALTER TABLE ml_buyers ADD COLUMN pref_entrega TEXT`);
      console.log("[db] ml_buyers: columna pref_entrega añadida (migración)");
    }
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'ml_buyers_pref_entrega_check' LIMIT 1`
    );
    if (chk.length === 0) {
      await pool.query(`
        ALTER TABLE ml_buyers ADD CONSTRAINT ml_buyers_pref_entrega_check
        CHECK (pref_entrega IS NULL OR pref_entrega IN ('Pickup', 'Envio Courier', 'Delivery'))
      `);
      console.log("[db] ml_buyers: CHECK pref_entrega aplicado");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers pref_entrega:", e.message);
  }
}

/** Columna cambio_datos (Cambio_datos) en instalaciones previas sin ella. */
async function migrateMlBuyersCambioDatos() {
  try {
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_buyers' AND column_name = 'cambio_datos'`
    );
    if (col.length === 0) {
      await pool.query(`ALTER TABLE ml_buyers ADD COLUMN cambio_datos TEXT`);
      console.log("[db] ml_buyers: columna cambio_datos añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers cambio_datos:", e.message);
  }
}

/** Columna actualizacion (Actualización) y pref_entrega por defecto Pickup en filas antiguas. */
async function migrateMlBuyersActualizacionYDefaults() {
  try {
    const { rows: colA } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_buyers' AND column_name = 'actualizacion'`
    );
    if (colA.length === 0) {
      await pool.query(`ALTER TABLE ml_buyers ADD COLUMN actualizacion TEXT`);
      console.log("[db] ml_buyers: columna actualizacion añadida (migración)");
    }
    await pool.query(`
      UPDATE ml_buyers SET pref_entrega = COALESCE(pref_entrega, 'Pickup')
      WHERE pref_entrega IS NULL
    `);
    await pool.query(`
      UPDATE ml_buyers SET actualizacion = updated_at
      WHERE actualizacion IS NULL
    `);
    await pool.query(
      `ALTER TABLE ml_buyers ALTER COLUMN pref_entrega SET DEFAULT 'Pickup'`
    ).catch(() => {});
  } catch (e) {
    console.error("[db] migrate ml_buyers actualizacion/defaults:", e.message);
  }
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
    await pool.query(
      `DELETE FROM ml_post_sale_auto_send_log WHERE skip_reason IS DISTINCT FROM 'message_step=0'`
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
    `SELECT ml_user_id, nickname, updated_at,
            CASE WHEN cookies_netscape IS NOT NULL AND LENGTH(TRIM(cookies_netscape)) > 0
                 THEN 1 ELSE 0 END AS cookies_web_stored
     FROM ml_accounts ORDER BY ml_user_id`
  );
  return rows.map((r) => ({
    ml_user_id: r.ml_user_id,
    nickname: r.nickname,
    updated_at: r.updated_at,
    cookies_web_stored: Number(r.cookies_web_stored) === 1,
  }));
}

/**
 * Texto Netscape guardado en BD para `ml_user_id`, o null si no hay.
 * @param {number} mlUserId
 * @returns {Promise<string|null>}
 */
async function getMlAccountCookiesNetscape(mlUserId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT cookies_netscape FROM ml_accounts WHERE ml_user_id = $1`,
    [mlUserId]
  );
  const v = rows[0] && rows[0].cookies_netscape != null ? String(rows[0].cookies_netscape) : "";
  return v.trim() !== "" ? v : null;
}

/**
 * Guarda cookies Netscape para detalle ventas web. Requiere fila existente en ml_accounts.
 * @returns {Promise<number>} filas actualizadas (0 si no existe la cuenta)
 */
async function setMlAccountCookiesNetscape(mlUserId, netscapeText) {
  await ensureSchema();
  const now = new Date().toISOString();
  const raw = netscapeText != null ? String(netscapeText) : "";
  const { rowCount } = await pool.query(
    `UPDATE ml_accounts SET cookies_netscape = $1, cookies_updated_at = $2 WHERE ml_user_id = $3`,
    [raw.trim() === "" ? null : raw, now, mlUserId]
  );
  return rowCount || 0;
}

/** Quita cookies web de la cuenta (vuelve a usar archivo / env si existen). */
async function clearMlAccountCookiesNetscape(mlUserId) {
  await ensureSchema();
  const { rowCount } = await pool.query(
    `UPDATE ml_accounts SET cookies_netscape = NULL, cookies_updated_at = NULL WHERE ml_user_id = $1`,
    [mlUserId]
  );
  return rowCount || 0;
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
  const pref = resolvePrefEntregaForUpsert(row);
  const cambio =
    row.cambio_datos !== undefined ? normalizeCambioDatos(row.cambio_datos) : null;
  const nombreAp =
    row.nombre_apellido !== undefined ? normalizeNombreApellido(row.nombre_apellido) : null;
  await pool.query(
    `INSERT INTO ml_buyers (buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (buyer_id) DO UPDATE SET
       nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), ml_buyers.nickname),
       nombre_apellido = COALESCE(NULLIF(EXCLUDED.nombre_apellido, ''), ml_buyers.nombre_apellido),
       phone_1 = COALESCE(EXCLUDED.phone_1, ml_buyers.phone_1),
       phone_2 = COALESCE(EXCLUDED.phone_2, ml_buyers.phone_2),
       pref_entrega = COALESCE(EXCLUDED.pref_entrega, ml_buyers.pref_entrega),
       cambio_datos = COALESCE(EXCLUDED.cambio_datos, ml_buyers.cambio_datos),
       actualizacion = EXCLUDED.actualizacion,
       updated_at = EXCLUDED.updated_at`,
    [
      row.buyer_id,
      row.nickname != null ? String(row.nickname) : null,
      nombreAp,
      row.phone_1 != null ? String(row.phone_1) : null,
      row.phone_2 != null ? String(row.phone_2) : null,
      pref,
      cambio,
      now,
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
    `SELECT buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at
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
    `SELECT buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at
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
  let pref_entrega = row.pref_entrega;
  if (patch.pref_entrega !== undefined) {
    pref_entrega =
      patch.pref_entrega === null || String(patch.pref_entrega).trim() === ""
        ? null
        : normalizeBuyerPrefEntrega(patch.pref_entrega);
  }
  let cambio_datos = row.cambio_datos;
  if (patch.cambio_datos !== undefined) {
    cambio_datos =
      patch.cambio_datos === null || String(patch.cambio_datos).trim() === ""
        ? null
        : normalizeCambioDatos(patch.cambio_datos);
  }
  let nombre_apellido = row.nombre_apellido;
  if (patch.nombre_apellido !== undefined) {
    nombre_apellido =
      patch.nombre_apellido === null || String(patch.nombre_apellido).trim() === ""
        ? null
        : normalizeNombreApellido(patch.nombre_apellido);
  }
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE ml_buyers SET phone_1 = $1, phone_2 = $2, pref_entrega = $3, cambio_datos = $4, nombre_apellido = $5, actualizacion = $6, updated_at = $7
     WHERE buyer_id = $8`,
    [phone_1, phone_2, pref_entrega, cambio_datos, nombre_apellido, now, now, buyerId]
  );
  return {
    buyer_id: buyerId,
    nickname: row.nickname,
    nombre_apellido,
    phone_1,
    phone_2,
    pref_entrega,
    cambio_datos,
    actualizacion: now,
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
  const sr = row.skip_reason != null ? String(row.skip_reason).trim() : "";
  if (sr !== "message_step=0") return null;
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

function normalizePostSaleLogOutcomeFilter(raw) {
  if (raw == null || String(raw).trim() === "") return "default";
  const v = String(raw).trim().toLowerCase();
  if (["all", "success", "skipped", "api_error", "default"].includes(v)) return v;
  return "default";
}

function postSaleLogOutcomeSqlExtra(mode) {
  switch (mode) {
    case "all":
      return "";
    case "success":
      return " AND outcome = 'success'";
    case "skipped":
      return " AND outcome = 'skipped'";
    case "api_error":
      return " AND outcome = 'api_error'";
    case "default":
    default:
      return " AND outcome NOT IN ('success', 'skipped') AND skip_reason = 'message_step=0'";
  }
}

/** @param {{ outcome?: string }} [options] outcome: default | all | success | skipped | api_error */
async function listPostSaleAutoSendLog(limit, maxAllowed, options = {}) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const mode = normalizePostSaleLogOutcomeFilter(options.outcome);
  const extra = postSaleLogOutcomeSqlExtra(mode);
  const { rows } = await pool.query(
    `SELECT id, created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
            http_status, option_id, request_path, response_body, error_message
     FROM ml_post_sale_auto_send_log
     WHERE topic = 'orders_v2'${extra}
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
  const posBuyer =
    row.pos_buyer_info_text != null && Number.isFinite(Number(row.pos_buyer_info_text))
      ? Number(row.pos_buyer_info_text)
      : null;
  const posLab =
    row.pos_label != null && Number.isFinite(Number(row.pos_label)) ? Number(row.pos_label) : null;
  const { rows } = await pool.query(
    `INSERT INTO ml_ventas_detalle_web (
       created_at, ml_user_id, order_id, request_url, http_status, raw, celular, error,
       pos_buyer_info_text, pos_label
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      row.created_at || new Date().toISOString(),
      Number(row.ml_user_id),
      Number(row.order_id),
      String(row.request_url).slice(0, 4000),
      row.http_status != null ? Number(row.http_status) : null,
      html,
      celular,
      row.error != null ? String(row.error).slice(0, 4000) : null,
      posBuyer,
      posLab,
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
              pos_buyer_info_text,
              pos_label,
              raw AS raw,
              error`
    : `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw::text) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTRING(raw::text FROM 1 FOR 400) END AS resultado_g,
              celular,
              pos_buyer_info_text,
              pos_label,
              error`;
  const { rows } = await pool.query(`${sel} FROM ml_ventas_detalle_web ORDER BY id DESC LIMIT $1`, [n]);
  return rows;
}

async function deleteAllMlVentasDetalleWeb() {
  await ensureSchema();
  const { rowCount } = await pool.query("DELETE FROM ml_ventas_detalle_web");
  return rowCount;
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
  getMlAccountCookiesNetscape,
  setMlAccountCookiesNetscape,
  clearMlAccountCookiesNetscape,
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
  deleteAllMlVentasDetalleWeb,
  /** Cierra el pool (tests). */
  _poolEnd: () => pool.end(),
};
