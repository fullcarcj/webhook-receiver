/**
 * Referencia / pruebas offline. En runtime la app usa solo PostgreSQL vía `db.js` (DATABASE_URL obligatoria).
 * Cambios de esquema: aplicar primero en db-postgres.js y replicar aquí.
 */
const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");
const {
  normalizeBuyerPrefEntrega,
  normalizeCambioDatos,
  normalizeNombreApellido,
  resolvePrefEntregaForUpsert,
} = require("./ml-buyer-pref");
const { feedbackPurchaseRatingValue } = require("./ml-order-map");

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
    nombre_apellido TEXT,
    phone_1 TEXT,
    phone_2 TEXT,
    pref_entrega TEXT DEFAULT 'Pickup' CHECK (
      pref_entrega IS NULL OR pref_entrega IN ('Pickup', 'Envio Courier', 'Delivery')
    ),
    cambio_datos TEXT,
    actualizacion TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_buyers_updated ON ml_buyers(updated_at);

  CREATE TABLE IF NOT EXISTS ml_post_sale_sent (
    order_id INTEGER PRIMARY KEY,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_rating_request_sent (
    order_id INTEGER PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    buyer_id INTEGER,
    sent_at TEXT NOT NULL,
    http_status INTEGER,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user ON ml_rating_request_sent(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user_buyer_sent ON ml_rating_request_sent(ml_user_id, buyer_id, sent_at);

  CREATE TABLE IF NOT EXISTS ml_rating_request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    ml_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    buyer_id INTEGER,
    outcome TEXT NOT NULL,
    skip_reason TEXT,
    http_status INTEGER,
    request_path TEXT,
    response_body TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_created ON ml_rating_request_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_user ON ml_rating_request_log(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_order ON ml_rating_request_log(order_id);

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
    error TEXT,
    pos_buyer_info_text INTEGER,
    pos_label INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ventas_detalle_user_order ON ml_ventas_detalle_web(ml_user_id, order_id);
  CREATE INDEX IF NOT EXISTS idx_ventas_detalle_created ON ml_ventas_detalle_web(created_at);

  CREATE TABLE IF NOT EXISTS ml_questions_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_question_id INTEGER NOT NULL UNIQUE,
    ml_user_id INTEGER NOT NULL,
    item_id TEXT,
    buyer_id INTEGER,
    question_text TEXT,
    ml_status TEXT,
    date_created TEXT,
    raw_json TEXT,
    notification_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_questions_pending_user ON ml_questions_pending(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_questions_pending_created ON ml_questions_pending(created_at);

  CREATE TABLE IF NOT EXISTS ml_questions_answered (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_question_id INTEGER NOT NULL UNIQUE,
    ml_user_id INTEGER NOT NULL,
    item_id TEXT,
    buyer_id INTEGER,
    question_text TEXT,
    answer_text TEXT NOT NULL,
    ml_status TEXT,
    date_created TEXT,
    raw_json TEXT,
    notification_id TEXT,
    pending_internal_id INTEGER,
    answered_at TEXT NOT NULL,
    moved_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    response_time_sec INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ml_questions_answered_user ON ml_questions_answered(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_questions_answered_at ON ml_questions_answered(answered_at);

  CREATE TABLE IF NOT EXISTS ml_items (
    item_id TEXT PRIMARY KEY,
    ml_user_id INTEGER NOT NULL,
    resource TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    http_status INTEGER,
    notification_id TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_items_user ON ml_items(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_items_updated ON ml_items(updated_at);

  CREATE TABLE IF NOT EXISTS ml_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    site_id TEXT,
    seller_id INTEGER,
    status TEXT,
    title TEXT,
    price REAL,
    currency_id TEXT,
    available_quantity INTEGER,
    sold_quantity INTEGER,
    category_id TEXT,
    listing_type TEXT,
    permalink TEXT,
    thumbnail TEXT,
    raw_json TEXT NOT NULL,
    search_json TEXT,
    http_status INTEGER,
    sync_error TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(ml_user_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ml_listings_user_status ON ml_listings(ml_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_ml_listings_user_updated ON ml_listings(ml_user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_ml_listings_item_id ON ml_listings(item_id);

  CREATE TABLE IF NOT EXISTS ml_listing_sync_state (
    ml_user_id INTEGER PRIMARY KEY,
    last_scroll_id TEXT,
    last_offset INTEGER,
    last_batch_total INTEGER,
    last_sync_at TEXT,
    last_sync_status TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ml_listing_webhook_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    notification_id TEXT,
    topic TEXT,
    request_path TEXT,
    http_status INTEGER,
    upsert_ok INTEGER NOT NULL DEFAULT 0,
    listing_id INTEGER,
    error_message TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_listing_webhook_log_user ON ml_listing_webhook_log(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_listing_webhook_log_fetched ON ml_listing_webhook_log(fetched_at DESC);

  CREATE TABLE IF NOT EXISTS ml_listing_change_ack (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    webhook_log_id INTEGER,
    action TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_user ON ml_listing_change_ack(ml_user_id);
  CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_created ON ml_listing_change_ack(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_item ON ml_listing_change_ack(ml_user_id, item_id);

  CREATE TABLE IF NOT EXISTS ml_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    status TEXT,
    date_created TEXT,
    total_amount REAL,
    currency_id TEXT,
    buyer_id INTEGER,
    buyer_phone_registered INTEGER,
    feedback_sale TEXT,
    feedback_purchase TEXT,
    feedback_purchase_value INTEGER,
    raw_json TEXT NOT NULL,
    http_status INTEGER,
    sync_error TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(ml_user_id, order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ml_orders_user_status ON ml_orders(ml_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_ml_orders_user_created ON ml_orders(ml_user_id, date_created);
  CREATE INDEX IF NOT EXISTS idx_ml_orders_order_id ON ml_orders(order_id);

  CREATE TABLE IF NOT EXISTS ml_order_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    ml_feedback_id INTEGER NOT NULL UNIQUE,
    role TEXT,
    fulfilled INTEGER,
    rating TEXT,
    reason TEXT,
    message TEXT,
    reply TEXT,
    date_created TEXT,
    visibility_date TEXT,
    feedback_status TEXT,
    modified INTEGER,
    restock_item INTEGER,
    has_seller_refunded_money INTEGER,
    from_user_id INTEGER,
    to_user_id INTEGER,
    from_nickname TEXT,
    to_nickname TEXT,
    item_id TEXT,
    item_title TEXT,
    item_price REAL,
    item_currency_id TEXT,
    extended_feedback TEXT,
    site_id TEXT,
    app_id TEXT,
    raw_json TEXT NOT NULL,
    source TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_user_order ON ml_order_feedback(ml_user_id, order_id);
  CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_user_rating ON ml_order_feedback(ml_user_id, rating);
  CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_date ON ml_order_feedback(date_created DESC);
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

(function migrateMlVentasDetalleAnchorPositions() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_ventas_detalle_web)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("pos_buyer_info_text")) {
      db.exec("ALTER TABLE ml_ventas_detalle_web ADD COLUMN pos_buyer_info_text INTEGER");
    }
    if (!names.has("pos_label")) {
      db.exec("ALTER TABLE ml_ventas_detalle_web ADD COLUMN pos_label INTEGER");
    }
  } catch (e) {
    console.error("[db] migrate ml_ventas_detalle_web anchor pos:", e.message);
  }
})();

(function migrateMlAccountsCookiesNetscape() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_accounts)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("cookies_netscape")) {
      db.exec("ALTER TABLE ml_accounts ADD COLUMN cookies_netscape TEXT");
      console.log("[db] ml_accounts: columna cookies_netscape añadida (migración)");
    }
    if (!names.has("cookies_updated_at")) {
      db.exec("ALTER TABLE ml_accounts ADD COLUMN cookies_updated_at TEXT");
      console.log("[db] ml_accounts: columna cookies_updated_at añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_accounts cookies netscape:", e.message);
  }
})();

(function migrateMlBuyersPrefEntrega() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_buyers)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("pref_entrega")) {
      db.exec("ALTER TABLE ml_buyers ADD COLUMN pref_entrega TEXT");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers pref_entrega:", e.message);
  }
})();

(function migrateMlBuyersCambioDatos() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_buyers)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("cambio_datos")) {
      db.exec("ALTER TABLE ml_buyers ADD COLUMN cambio_datos TEXT");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers cambio_datos:", e.message);
  }
})();

(function migrateMlBuyersActualizacionYDefaults() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_buyers)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("actualizacion")) {
      db.exec("ALTER TABLE ml_buyers ADD COLUMN actualizacion TEXT");
      console.log("[db] ml_buyers: columna actualizacion añadida (migración)");
    }
    db.prepare(
      `UPDATE ml_buyers SET pref_entrega = 'Pickup'
       WHERE pref_entrega IS NULL OR TRIM(COALESCE(pref_entrega, '')) = ''`
    ).run();
    db.prepare(
      `UPDATE ml_buyers SET actualizacion = updated_at
       WHERE actualizacion IS NULL OR TRIM(COALESCE(actualizacion, '')) = ''`
    ).run();
  } catch (e) {
    console.error("[db] migrate ml_buyers actualizacion/defaults:", e.message);
  }
})();

(function migrateMlBuyersNombreApellido() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_buyers)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("nombre_apellido")) {
      db.exec("ALTER TABLE ml_buyers ADD COLUMN nombre_apellido TEXT");
      console.log("[db] ml_buyers: columna nombre_apellido añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_buyers nombre_apellido:", e.message);
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

/** CHECK vía trigger: solo topic orders_v2; limpia filas inválidas al cargar. */
(function migratePostSaleAutoSendLogTopicTrigger() {
  try {
    const has = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ml_post_sale_auto_send_log_topic_enforce'"
      )
      .get();
    if (!has) {
      db.prepare(
        "DELETE FROM ml_post_sale_auto_send_log WHERE topic IS NULL OR topic <> 'orders_v2'"
      ).run();
      db.exec(`
        CREATE TRIGGER ml_post_sale_auto_send_log_topic_enforce
        BEFORE INSERT ON ml_post_sale_auto_send_log
        FOR EACH ROW
        WHEN NEW.topic IS NOT 'orders_v2' OR NEW.topic IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'ml_post_sale_auto_send_log.topic must be orders_v2');
        END
      `);
      console.log("[db] ml_post_sale_auto_send_log: trigger topic=orders_v2");
    }
  } catch (e) {
    console.error("[db] migrate ml_post_sale_auto_send_log topic trigger:", e.message);
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

(function migrateMlQuestionsAnsweredResponseTimeSec() {
  try {
    const cols = db.prepare("PRAGMA table_info(ml_questions_answered)").all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("response_time_sec")) {
      db.exec("ALTER TABLE ml_questions_answered ADD COLUMN response_time_sec INTEGER");
      console.log("[db] ml_questions_answered: columna response_time_sec añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_questions_answered response_time_sec:", e.message);
  }
})();

(function migrateMlQuestionsDateCreated() {
  try {
    const p = db.prepare("PRAGMA table_info(ml_questions_pending)").all();
    const pn = new Set(p.map((c) => c.name));
    if (!pn.has("date_created")) {
      db.exec("ALTER TABLE ml_questions_pending ADD COLUMN date_created TEXT");
      console.log("[db] ml_questions_pending: columna date_created añadida (migración)");
    }
    const a = db.prepare("PRAGMA table_info(ml_questions_answered)").all();
    const an = new Set(a.map((c) => c.name));
    if (!an.has("date_created")) {
      db.exec("ALTER TABLE ml_questions_answered ADD COLUMN date_created TEXT");
      console.log("[db] ml_questions_answered: columna date_created añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_questions date_created:", e.message);
  }
})();

(function migrateMlOrdersExtraColumns() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_orders)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("buyer_phone_registered")) {
      db.exec("ALTER TABLE ml_orders ADD COLUMN buyer_phone_registered INTEGER");
      console.log("[db] ml_orders: columna buyer_phone_registered añadida (migración)");
    }
    if (!names.has("feedback_sale")) {
      db.exec("ALTER TABLE ml_orders ADD COLUMN feedback_sale TEXT");
      console.log("[db] ml_orders: columna feedback_sale añadida (migración)");
    }
    if (!names.has("feedback_purchase")) {
      db.exec("ALTER TABLE ml_orders ADD COLUMN feedback_purchase TEXT");
      console.log("[db] ml_orders: columna feedback_purchase añadida (migración)");
    }
    if (!names.has("feedback_purchase_value")) {
      db.exec("ALTER TABLE ml_orders ADD COLUMN feedback_purchase_value INTEGER");
      console.log("[db] ml_orders: columna feedback_purchase_value añadida (migración)");
      db.exec(`
        UPDATE ml_orders SET feedback_purchase_value = CASE
          WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'positive' THEN 1
          WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'neutral' THEN 0
          WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'negative' THEN -1
          ELSE NULL
        END
      `);
    }
  } catch (e) {
    console.error("[db] migrate ml_orders extra columns:", e.message);
  }
})();

(function migrateMlRatingRequestSentBuyerId() {
  try {
    const t = db.prepare("PRAGMA table_info(ml_rating_request_sent)").all();
    const names = new Set(t.map((c) => c.name));
    if (!names.has("buyer_id")) {
      db.exec("ALTER TABLE ml_rating_request_sent ADD COLUMN buyer_id INTEGER");
      console.log("[db] ml_rating_request_sent: columna buyer_id añadida (migración)");
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user_buyer_sent ON ml_rating_request_sent(ml_user_id, buyer_id, sent_at)"
    );
    db.exec(`
      UPDATE ml_rating_request_sent
      SET buyer_id = (SELECT buyer_id FROM ml_orders o WHERE o.order_id = ml_rating_request_sent.order_id)
      WHERE buyer_id IS NULL
    `);
  } catch (e) {
    console.error("[db] migrate ml_rating_request_sent buyer_id:", e.message);
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
       FROM webhook_events ORDER BY id DESC LIMIT ?`
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
  const rows = db
    .prepare(
      `SELECT ml_user_id, nickname, updated_at,
              CASE WHEN cookies_netscape IS NOT NULL AND LENGTH(TRIM(cookies_netscape)) > 0
                   THEN 1 ELSE 0 END AS cookies_web_stored
       FROM ml_accounts ORDER BY ml_user_id`
    )
    .all();
  return rows.map((r) => ({
    ml_user_id: r.ml_user_id,
    nickname: r.nickname,
    updated_at: r.updated_at,
    cookies_web_stored: Number(r.cookies_web_stored) === 1,
  }));
}

function getMlAccountCookiesNetscape(mlUserId) {
  const row = db
    .prepare(`SELECT cookies_netscape FROM ml_accounts WHERE ml_user_id = ?`)
    .get(mlUserId);
  const v = row && row.cookies_netscape != null ? String(row.cookies_netscape) : "";
  return v.trim() !== "" ? v : null;
}

function setMlAccountCookiesNetscape(mlUserId, netscapeText) {
  const now = new Date().toISOString();
  const raw = netscapeText != null ? String(netscapeText) : "";
  const info = db
    .prepare(
      `UPDATE ml_accounts SET cookies_netscape = ?, cookies_updated_at = ? WHERE ml_user_id = ?`
    )
    .run(raw.trim() === "" ? null : raw, now, mlUserId);
  return info.changes || 0;
}

function clearMlAccountCookiesNetscape(mlUserId) {
  const info = db
    .prepare(
      `UPDATE ml_accounts SET cookies_netscape = NULL, cookies_updated_at = NULL WHERE ml_user_id = ?`
    )
    .run(mlUserId);
  return info.changes || 0;
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
 * Sin filtro: orden por id descendente (más recientes primero; mezcla todos los topics).
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
  return db.prepare(`${selectFrom} ORDER BY f.id DESC LIMIT ?`).all(n);
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
  `INSERT INTO ml_buyers (buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at)
   VALUES (@buyer_id, @nickname, @nombre_apellido, @phone_1, @phone_2, @pref_entrega, @cambio_datos, @actualizacion, @created_at, @updated_at)
   ON CONFLICT(buyer_id) DO UPDATE SET
     nickname = COALESCE(NULLIF(excluded.nickname, ''), ml_buyers.nickname),
     nombre_apellido = COALESCE(NULLIF(excluded.nombre_apellido, ''), ml_buyers.nombre_apellido),
     phone_1 = COALESCE(excluded.phone_1, ml_buyers.phone_1),
     phone_2 = COALESCE(excluded.phone_2, ml_buyers.phone_2),
     pref_entrega = COALESCE(excluded.pref_entrega, ml_buyers.pref_entrega),
     cambio_datos = COALESCE(excluded.cambio_datos, ml_buyers.cambio_datos),
     actualizacion = excluded.actualizacion,
     updated_at = excluded.updated_at`
);

function upsertMlBuyer(row) {
  const now = new Date().toISOString();
  const pref = resolvePrefEntregaForUpsert(row);
  const cambio =
    row.cambio_datos !== undefined ? normalizeCambioDatos(row.cambio_datos) : null;
  const nombreAp =
    row.nombre_apellido !== undefined ? normalizeNombreApellido(row.nombre_apellido) : null;
  upsertMlBuyerStmt.run({
    buyer_id: row.buyer_id,
    nickname: row.nickname != null ? String(row.nickname) : null,
    nombre_apellido: nombreAp,
    phone_1: row.phone_1 != null ? String(row.phone_1) : null,
    phone_2: row.phone_2 != null ? String(row.phone_2) : null,
    pref_entrega: pref,
    cambio_datos: cambio,
    actualizacion: now,
    created_at: now,
    updated_at: now,
  });
}

function countMlBuyers() {
  const r = db.prepare("SELECT COUNT(*) AS c FROM ml_buyers").get();
  return Number(r.c);
}

function listMlBuyers(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  return db
    .prepare(
      `SELECT buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at
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
      `SELECT buyer_id, nickname, nombre_apellido, phone_1, phone_2, pref_entrega, cambio_datos, actualizacion, created_at, updated_at
       FROM ml_buyers WHERE buyer_id = ?`
    )
    .get(buyerId);
}

/** Actualiza phone_1 y/o phone_2 y opcionalmente pref_entrega / cambio_datos; campos omitidos se conservan. null o "" borran el teléfono. */
function updateMlBuyerPhones(buyerId, patch) {
  const row = getMlBuyer(buyerId);
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
  db.prepare(
    `UPDATE ml_buyers SET phone_1 = @phone_1, phone_2 = @phone_2, pref_entrega = @pref_entrega, cambio_datos = @cambio_datos, nombre_apellido = @nombre_apellido, actualizacion = @actualizacion, updated_at = @updated_at
     WHERE buyer_id = @buyer_id`
  ).run({
    buyer_id: buyerId,
    phone_1,
    phone_2,
    pref_entrega,
    cambio_datos,
    nombre_apellido,
    actualizacion: now,
    updated_at: now,
  });
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
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    console.error("[post-sale log DB] ml_user_id inválido:", row.ml_user_id);
    return null;
  }
  const info = insertPostSaleAutoSendLogStmt.run({
    created_at: row.created_at || new Date().toISOString(),
    ml_user_id: mlUid,
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
      return "";
  }
}

/** @param {{ outcome?: string }} [options] */
function listPostSaleAutoSendLog(limit, maxAllowed, options = {}) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const mode = normalizePostSaleLogOutcomeFilter(options.outcome);
  const extra = postSaleLogOutcomeSqlExtra(mode);
  return db
    .prepare(
      `SELECT id, created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
              http_status, option_id, request_path, response_body, error_message
       FROM ml_post_sale_auto_send_log
       WHERE topic = 'orders_v2'${extra}
       ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

const insertMlVentasDetalleWebStmt = db.prepare(
  `INSERT INTO ml_ventas_detalle_web (
     created_at, ml_user_id, order_id, request_url, http_status, raw, celular, error,
     pos_buyer_info_text, pos_label
   ) VALUES (
     @created_at, @ml_user_id, @order_id, @request_url, @http_status, @raw, @celular, @error,
     @pos_buyer_info_text, @pos_label
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
  const posBuyer =
    row.pos_buyer_info_text != null && Number.isFinite(Number(row.pos_buyer_info_text))
      ? Number(row.pos_buyer_info_text)
      : null;
  const posLab =
    row.pos_label != null && Number.isFinite(Number(row.pos_label)) ? Number(row.pos_label) : null;
  const info = insertMlVentasDetalleWebStmt.run({
    created_at: row.created_at || new Date().toISOString(),
    ml_user_id: Number(row.ml_user_id),
    order_id: Number(row.order_id),
    request_url: String(row.request_url).slice(0, 4000),
    http_status: row.http_status != null ? Number(row.http_status) : null,
    raw: html,
    celular,
    error: row.error != null ? String(row.error).slice(0, 4000) : null,
    pos_buyer_info_text: posBuyer,
    pos_label: posLab,
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
              pos_buyer_info_text,
              pos_label,
              raw AS raw,
              error`
    : `SELECT id, created_at, ml_user_id, order_id, request_url, http_status,
              LENGTH(raw) AS body_len,
              CASE WHEN raw IS NULL THEN NULL ELSE SUBSTR(raw, 1, 400) END AS resultado_g,
              celular,
              pos_buyer_info_text,
              pos_label,
              error`;
  return db.prepare(`${sel} FROM ml_ventas_detalle_web ORDER BY id DESC LIMIT ?`).all(n);
}

function deleteAllMlVentasDetalleWeb() {
  return db.prepare("DELETE FROM ml_ventas_detalle_web").run().changes;
}

const upsertMlQuestionPendingStmt = db.prepare(
  `INSERT INTO ml_questions_pending (
     ml_question_id, ml_user_id, item_id, buyer_id, question_text, ml_status, date_created, raw_json, notification_id, created_at, updated_at
   ) VALUES (@ml_question_id, @ml_user_id, @item_id, @buyer_id, @question_text, @ml_status, @date_created, @raw_json, @notification_id, @created_at, @updated_at)
   ON CONFLICT(ml_question_id) DO UPDATE SET
     ml_user_id = excluded.ml_user_id,
     item_id = excluded.item_id,
     buyer_id = excluded.buyer_id,
     question_text = excluded.question_text,
     ml_status = excluded.ml_status,
     date_created = excluded.date_created,
     raw_json = excluded.raw_json,
     notification_id = excluded.notification_id,
     updated_at = excluded.updated_at`
);

function upsertMlQuestionPending(row) {
  const qid = Number(row.ml_question_id);
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(qid) || qid <= 0 || !Number.isFinite(mlUid) || mlUid <= 0) {
    return null;
  }
  const now = new Date().toISOString();
  upsertMlQuestionPendingStmt.run({
    ml_question_id: qid,
    ml_user_id: mlUid,
    item_id: row.item_id != null ? String(row.item_id) : null,
    buyer_id: row.buyer_id != null ? Number(row.buyer_id) : null,
    question_text: row.question_text != null ? String(row.question_text) : null,
    ml_status: row.ml_status != null ? String(row.ml_status) : null,
    date_created: row.date_created != null ? String(row.date_created) : null,
    raw_json: row.raw_json != null ? String(row.raw_json) : null,
    notification_id: row.notification_id != null ? String(row.notification_id) : null,
    created_at: now,
    updated_at: now,
  });
  const r = db.prepare("SELECT id FROM ml_questions_pending WHERE ml_question_id = ?").get(qid);
  return r && r.id != null ? Number(r.id) : null;
}

function getMlQuestionPendingByQuestionId(mlQuestionId) {
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  return (
    db
      .prepare(
        `SELECT id, ml_question_id, ml_user_id, date_created, raw_json
         FROM ml_questions_pending WHERE ml_question_id = ?`
      )
      .get(qid) || null
  );
}

function deleteMlQuestionPending(mlQuestionId) {
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return 0;
  return db.prepare("DELETE FROM ml_questions_pending WHERE ml_question_id = ?").run(qid).changes;
}

const upsertMlQuestionAnsweredStmt = db.prepare(
  `INSERT INTO ml_questions_answered (
     ml_question_id, ml_user_id, item_id, buyer_id, question_text, answer_text, ml_status, date_created, raw_json, notification_id, pending_internal_id, answered_at, moved_at, created_at, updated_at, response_time_sec
   ) VALUES (@ml_question_id, @ml_user_id, @item_id, @buyer_id, @question_text, @answer_text, @ml_status, @date_created, @raw_json, @notification_id, @pending_internal_id, @answered_at, @moved_at, @created_at, @updated_at, @response_time_sec)
   ON CONFLICT(ml_question_id) DO UPDATE SET
     ml_user_id = excluded.ml_user_id,
     item_id = excluded.item_id,
     buyer_id = excluded.buyer_id,
     question_text = excluded.question_text,
     answer_text = excluded.answer_text,
     ml_status = excluded.ml_status,
     date_created = excluded.date_created,
     raw_json = excluded.raw_json,
     notification_id = excluded.notification_id,
     pending_internal_id = excluded.pending_internal_id,
     answered_at = excluded.answered_at,
     moved_at = excluded.moved_at,
     updated_at = excluded.updated_at,
     response_time_sec = excluded.response_time_sec`
);

function upsertMlQuestionAnswered(row) {
  const qid = Number(row.ml_question_id);
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(qid) || qid <= 0 || !Number.isFinite(mlUid) || mlUid <= 0) {
    return null;
  }
  const now = new Date().toISOString();
  const answerText = row.answer_text != null ? String(row.answer_text) : "(sin texto en API)";
  const answeredAt = row.answered_at != null ? String(row.answered_at) : now;
  const movedAt = row.moved_at != null ? String(row.moved_at) : now;
  const createdAt = row.created_at != null ? String(row.created_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rts =
    row.response_time_sec != null && Number.isFinite(Number(row.response_time_sec))
      ? Math.floor(Number(row.response_time_sec))
      : null;
  upsertMlQuestionAnsweredStmt.run({
    ml_question_id: qid,
    ml_user_id: mlUid,
    item_id: row.item_id != null ? String(row.item_id) : null,
    buyer_id: row.buyer_id != null ? Number(row.buyer_id) : null,
    question_text: row.question_text != null ? String(row.question_text) : null,
    answer_text: answerText,
    ml_status: row.ml_status != null ? String(row.ml_status) : null,
    date_created: row.date_created != null ? String(row.date_created) : null,
    raw_json: row.raw_json != null ? String(row.raw_json) : null,
    notification_id: row.notification_id != null ? String(row.notification_id) : null,
    pending_internal_id: row.pending_internal_id != null ? Number(row.pending_internal_id) : null,
    answered_at: answeredAt,
    moved_at: movedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    response_time_sec: rts,
  });
  const r = db.prepare("SELECT id FROM ml_questions_answered WHERE ml_question_id = ?").get(qid);
  return r && r.id != null ? Number(r.id) : null;
}

function listMlQuestionsPending(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  return db
    .prepare(
      `SELECT id, ml_question_id, ml_user_id, item_id, buyer_id, question_text, ml_status, date_created, raw_json, notification_id, created_at, updated_at
       FROM ml_questions_pending ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

function listMlQuestionsAnswered(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  return db
    .prepare(
      `SELECT id, ml_question_id, ml_user_id, item_id, buyer_id, question_text, answer_text, ml_status, date_created, raw_json, notification_id, pending_internal_id, answered_at, moved_at, created_at, updated_at, response_time_sec
       FROM ml_questions_answered ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

const upsertMlListingStmt = db.prepare(
  `INSERT INTO ml_listings (
     ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
     available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
     raw_json, search_json, http_status, sync_error, fetched_at, updated_at
   ) VALUES (
     @ml_user_id, @item_id, @site_id, @seller_id, @status, @title, @price, @currency_id,
     @available_quantity, @sold_quantity, @category_id, @listing_type, @permalink, @thumbnail,
     @raw_json, @search_json, @http_status, @sync_error, @fetched_at, @updated_at
   )
   ON CONFLICT(ml_user_id, item_id) DO UPDATE SET
     site_id = excluded.site_id,
     seller_id = excluded.seller_id,
     status = excluded.status,
     title = excluded.title,
     price = excluded.price,
     currency_id = excluded.currency_id,
     available_quantity = excluded.available_quantity,
     sold_quantity = excluded.sold_quantity,
     category_id = excluded.category_id,
     listing_type = excluded.listing_type,
     permalink = excluded.permalink,
     thumbnail = excluded.thumbnail,
     raw_json = excluded.raw_json,
     search_json = excluded.search_json,
     http_status = excluded.http_status,
     sync_error = excluded.sync_error,
     fetched_at = excluded.fetched_at,
     updated_at = excluded.updated_at`
);

function insertMlListingWebhookLog(row) {
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const itemId = row.item_id != null ? String(row.item_id).trim() : "";
  if (!itemId) return null;
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO ml_listing_webhook_log (
         ml_user_id, item_id, notification_id, topic, request_path, http_status,
         upsert_ok, listing_id, error_message, fetched_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`
    )
    .get(
      mlUid,
      itemId,
      row.notification_id != null ? String(row.notification_id) : null,
      row.topic != null ? String(row.topic).slice(0, 80) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.upsert_ok ? 1 : 0,
      row.listing_id != null ? Number(row.listing_id) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
      fetchedAt
    );
  return r && r.id != null ? Number(r.id) : null;
}

function listMlListingWebhookLog(limit, maxAllowed) {
  const cap = maxAllowed != null ? maxAllowed : 5000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  return db
    .prepare(
      `SELECT id, ml_user_id, item_id, notification_id, topic, request_path, http_status,
              upsert_ok, listing_id, error_message, fetched_at
       FROM ml_listing_webhook_log ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

function upsertMlOrder(row) {
  const mlUid = Number(row.ml_user_id);
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return null;
  }
  const now = new Date().toISOString();
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rawJson = row.raw_json != null ? String(row.raw_json) : "{}";
  const totalVal =
    row.total_amount != null && String(row.total_amount).trim() !== ""
      ? Number(row.total_amount)
      : null;
  const fbSale = row.feedback_sale != null ? String(row.feedback_sale).slice(0, 200) : null;
  const fbPurchase = row.feedback_purchase != null ? String(row.feedback_purchase).slice(0, 200) : null;
  const fbPurchaseVal = feedbackPurchaseRatingValue(fbPurchase);

  let buyerPhoneRegistered = 0;
  const bid = row.buyer_id != null ? Number(row.buyer_id) : null;
  if (bid != null && Number.isFinite(bid) && bid > 0) {
    const buyer = getMlBuyer(bid);
    buyerPhoneRegistered =
      buyer && buyer.phone_1 != null && String(buyer.phone_1).trim() !== "" ? 1 : 0;
  }

  db.prepare(
    `INSERT INTO ml_orders (
       ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
       buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
       raw_json, http_status, sync_error, fetched_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ml_user_id, order_id) DO UPDATE SET
       status = excluded.status,
       date_created = excluded.date_created,
       total_amount = excluded.total_amount,
       currency_id = excluded.currency_id,
       buyer_id = excluded.buyer_id,
       buyer_phone_registered = excluded.buyer_phone_registered,
       feedback_sale = excluded.feedback_sale,
       feedback_purchase = excluded.feedback_purchase,
       feedback_purchase_value = excluded.feedback_purchase_value,
       raw_json = excluded.raw_json,
       http_status = excluded.http_status,
       sync_error = excluded.sync_error,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`
  ).run(
    mlUid,
    oid,
    row.status != null ? String(row.status) : null,
    row.date_created != null ? String(row.date_created) : null,
    totalVal != null && Number.isFinite(totalVal) ? totalVal : null,
    row.currency_id != null ? String(row.currency_id) : null,
    row.buyer_id != null ? Number(row.buyer_id) : null,
    buyerPhoneRegistered,
    fbSale,
    fbPurchase,
    Number.isFinite(fbPurchaseVal) ? fbPurchaseVal : null,
    rawJson,
    row.http_status != null ? Number(row.http_status) : null,
    row.sync_error != null ? String(row.sync_error).slice(0, 4000) : null,
    fetchedAt,
    updatedAt
  );
  const r = db.prepare("SELECT id FROM ml_orders WHERE ml_user_id = ? AND order_id = ?").get(mlUid, oid);
  return r && r.id != null ? Number(r.id) : null;
}

function listMlOrdersByUser(mlUserId, limit, maxAllowed, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 10000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  if (st) {
    return db
      .prepare(
        `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
                buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
                raw_json, http_status, sync_error, fetched_at, updated_at
         FROM ml_orders WHERE ml_user_id = ?
           AND LOWER(TRIM(COALESCE(status, ''))) = LOWER(?)
         ORDER BY date_created DESC, id DESC LIMIT ?`
      )
      .all(mlUid, st, n);
  }
  return db
    .prepare(
      `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders WHERE ml_user_id = ?
       ORDER BY date_created DESC, id DESC LIMIT ?`
    )
    .all(mlUid, n);
}

function listMlOrdersAll(limit, maxAllowed, options = {}) {
  const cap = maxAllowed != null ? maxAllowed : 20000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  if (st) {
    return db
      .prepare(
        `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
                buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
                raw_json, http_status, sync_error, fetched_at, updated_at
         FROM ml_orders
         WHERE LOWER(TRIM(COALESCE(status, ''))) = LOWER(?)
         ORDER BY ml_user_id ASC, date_created DESC, id DESC LIMIT ?`
      )
      .all(st, n);
  }
  return db
    .prepare(
      `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders ORDER BY ml_user_id ASC, date_created DESC, id DESC LIMIT ?`
    )
    .all(n);
}

/** Ver `updateMlOrderFeedbackSummary` en db-postgres.js */
function updateMlOrderFeedbackSummary(mlUserId, orderId, feedbackSale, feedbackPurchase) {
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return 0;
  const now = new Date().toISOString();
  const fpStr = feedbackPurchase != null ? String(feedbackPurchase) : null;
  const fpVal = feedbackPurchaseRatingValue(fpStr);
  const r = db
    .prepare(
      `UPDATE ml_orders SET feedback_sale = ?, feedback_purchase = ?, feedback_purchase_value = ?, updated_at = ?
       WHERE ml_user_id = ? AND order_id = ?`
    )
    .run(
      feedbackSale != null ? String(feedbackSale) : null,
      fpStr,
      Number.isFinite(fpVal) ? fpVal : null,
      now,
      mlUid,
      oid
    );
  return r.changes ?? 0;
}

function listMlOrderCountsByUserStatus() {
  return db
    .prepare(
      `SELECT ml_user_id, status, COUNT(*) AS total
       FROM ml_orders GROUP BY ml_user_id, status
       ORDER BY ml_user_id ASC, status ASC`
    )
    .all();
}

function listMlOrderCountsByUser() {
  return db
    .prepare(
      `SELECT ml_user_id, COUNT(*) AS total FROM ml_orders GROUP BY ml_user_id ORDER BY ml_user_id ASC`
    )
    .all();
}

const ML_LISTING_CHANGE_ACK_ACTIONS = Object.freeze([
  "activate",
  "add_stock",
  "pause",
  "delete",
  "dismiss",
]);

function boolSqlite(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function upsertMlOrderFeedback(row) {
  const mlUid = Number(row.ml_user_id);
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const fid = row.ml_feedback_id != null ? Number(row.ml_feedback_id) : NaN;
  const side = row.side != null ? String(row.side).trim() : "";
  if (
    !Number.isFinite(mlUid) ||
    mlUid <= 0 ||
    !Number.isFinite(oid) ||
    oid <= 0 ||
    !Number.isFinite(fid) ||
    fid <= 0 ||
    (side !== "sale" && side !== "purchase")
  ) {
    return null;
  }
  const now = new Date().toISOString();
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rawJson = row.raw_json != null ? String(row.raw_json) : "{}";
  let extStr = null;
  if (row.extended_feedback != null) {
    try {
      extStr =
        typeof row.extended_feedback === "object"
          ? JSON.stringify(row.extended_feedback)
          : String(row.extended_feedback);
    } catch {
      extStr = null;
    }
  }
  const priceVal =
    row.item_price != null && String(row.item_price).trim() !== ""
      ? Number(row.item_price)
      : null;
  db.prepare(
    `INSERT INTO ml_order_feedback (
       ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
       date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
       from_user_id, to_user_id, from_nickname, to_nickname,
       item_id, item_title, item_price, item_currency_id,
       extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ml_feedback_id) DO UPDATE SET
       ml_user_id = excluded.ml_user_id,
       order_id = excluded.order_id,
       side = excluded.side,
       role = excluded.role,
       fulfilled = excluded.fulfilled,
       rating = excluded.rating,
       reason = excluded.reason,
       message = excluded.message,
       reply = excluded.reply,
       date_created = excluded.date_created,
       visibility_date = excluded.visibility_date,
       feedback_status = excluded.feedback_status,
       modified = excluded.modified,
       restock_item = excluded.restock_item,
       has_seller_refunded_money = excluded.has_seller_refunded_money,
       from_user_id = excluded.from_user_id,
       to_user_id = excluded.to_user_id,
       from_nickname = excluded.from_nickname,
       to_nickname = excluded.to_nickname,
       item_id = excluded.item_id,
       item_title = excluded.item_title,
       item_price = excluded.item_price,
       item_currency_id = excluded.item_currency_id,
       extended_feedback = excluded.extended_feedback,
       site_id = excluded.site_id,
       app_id = excluded.app_id,
       raw_json = excluded.raw_json,
       source = excluded.source,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`
  ).run(
    mlUid,
    oid,
    side,
    fid,
    row.role != null ? String(row.role) : null,
    boolSqlite(row.fulfilled),
    row.rating != null ? String(row.rating).slice(0, 64) : null,
    row.reason != null ? String(row.reason).slice(0, 128) : null,
    row.message != null ? String(row.message).slice(0, 4000) : null,
    row.reply != null ? String(row.reply).slice(0, 4000) : null,
    row.date_created != null ? String(row.date_created) : null,
    row.visibility_date != null ? String(row.visibility_date) : null,
    row.feedback_status != null ? String(row.feedback_status).slice(0, 64) : null,
    boolSqlite(row.modified),
    boolSqlite(row.restock_item),
    boolSqlite(row.has_seller_refunded_money),
    row.from_user_id != null ? Number(row.from_user_id) : null,
    row.to_user_id != null ? Number(row.to_user_id) : null,
    row.from_nickname != null ? String(row.from_nickname).slice(0, 256) : null,
    row.to_nickname != null ? String(row.to_nickname).slice(0, 256) : null,
    row.item_id != null ? String(row.item_id).slice(0, 64) : null,
    row.item_title != null ? String(row.item_title).slice(0, 512) : null,
    priceVal != null && Number.isFinite(priceVal) ? priceVal : null,
    row.item_currency_id != null ? String(row.item_currency_id).slice(0, 16) : null,
    extStr,
    row.site_id != null ? String(row.site_id).slice(0, 16) : null,
    row.app_id != null ? String(row.app_id).slice(0, 32) : null,
    rawJson,
    row.source != null ? String(row.source).slice(0, 64) : null,
    fetchedAt,
    updatedAt
  );
  const r = db.prepare("SELECT id FROM ml_order_feedback WHERE ml_feedback_id = ?").get(fid);
  return r && r.id != null ? Number(r.id) : null;
}

function listMlOrderFeedbackByOrder(mlUserId, orderId) {
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return [];
  return db
    .prepare(
      `SELECT id, ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
              date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
              from_user_id, to_user_id, from_nickname, to_nickname,
              item_id, item_title, item_price, item_currency_id,
              extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
       FROM ml_order_feedback
       WHERE ml_user_id = ? AND order_id = ?
       ORDER BY side ASC`
    )
    .all(mlUid, oid);
}

function listMlOrderFeedbackByUser(mlUserId, limit, maxAllowed) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 20000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  return db
    .prepare(
      `SELECT id, ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
              date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
              from_user_id, to_user_id, from_nickname, to_nickname,
              item_id, item_title, item_price, item_currency_id,
              extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
       FROM ml_order_feedback
       WHERE ml_user_id = ?
       ORDER BY date_created DESC, id DESC
       LIMIT ?`
    )
    .all(mlUid, n);
}

function wasMlRatingRequestSent(orderId) {
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return false;
  const r = db.prepare("SELECT 1 FROM ml_rating_request_sent WHERE order_id = ?").get(oid);
  return Boolean(r);
}

function insertMlRatingRequestSent(row) {
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const mlUid = row.ml_user_id != null ? Number(row.ml_user_id) : NaN;
  const bid = row.buyer_id != null ? Number(row.buyer_id) : NaN;
  if (
    !Number.isFinite(oid) ||
    oid <= 0 ||
    !Number.isFinite(mlUid) ||
    mlUid <= 0 ||
    !Number.isFinite(bid) ||
    bid <= 0
  ) {
    return null;
  }
  const sentAt = row.sent_at != null ? String(row.sent_at) : new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO ml_rating_request_sent (order_id, ml_user_id, buyer_id, sent_at, http_status, error_message)
     VALUES (?,?,?,?,?,?)`
  ).run(
    oid,
    mlUid,
    bid,
    sentAt,
    row.http_status != null ? Number(row.http_status) : null,
    row.error_message != null ? String(row.error_message).slice(0, 2000) : null
  );
  return oid;
}

/** Un mensaje diario por (ml_user_id, buyer_id) en UTC para recordatorios de calificación. */
function wasRatingRequestSentToBuyerToday(mlUserId, buyerId, dayStartIso, dayEndIso) {
  const mlUid = Number(mlUserId);
  const bid = buyerId != null ? Number(buyerId) : NaN;
  const ds = dayStartIso != null ? String(dayStartIso).trim() : "";
  const de = dayEndIso != null ? String(dayEndIso).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(bid) || bid <= 0 || !ds || !de) {
    return false;
  }
  const r = db
    .prepare(
      `SELECT 1 FROM ml_rating_request_sent
       WHERE ml_user_id = ? AND buyer_id = ?
         AND sent_at >= ? AND sent_at < ?
       LIMIT 1`
    )
    .get(mlUid, bid, ds, de);
  return Boolean(r);
}

function listMlOrdersEligibleForRatingRequest(mlUserId, sinceIso, dayStartIso, dayEndIso, orderStatus) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const since = sinceIso != null ? String(sinceIso).trim() : "";
  if (!since) return [];
  const ds = dayStartIso != null ? String(dayStartIso).trim() : "";
  const de = dayEndIso != null ? String(dayEndIso).trim() : "";
  const filterBuyerDay = ds !== "" && de !== "";
  const stRaw = orderStatus != null ? String(orderStatus).trim() : "";
  const st = stRaw || null;
  const statusSql = st
    ? ` AND LOWER(TRIM(COALESCE(o.status, ''))) = LOWER(?)`
    : "";

  if (filterBuyerDay) {
    const params = st ? [mlUid, since, ds, de, st] : [mlUid, since, ds, de];
    return db
      .prepare(
        `SELECT o.id, o.ml_user_id, o.order_id, o.buyer_id, o.status, o.date_created
         FROM ml_orders o
         WHERE o.ml_user_id = ?
           AND o.date_created >= ?
           AND o.buyer_id IS NOT NULL
           AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'invalid')
           AND NOT EXISTS (SELECT 1 FROM ml_rating_request_sent r WHERE r.order_id = o.order_id)
           AND NOT EXISTS (
             SELECT 1 FROM ml_rating_request_sent r
             WHERE r.ml_user_id = o.ml_user_id
               AND r.buyer_id = o.buyer_id
               AND r.buyer_id IS NOT NULL
               AND r.sent_at >= ? AND r.sent_at < ?
           )
           AND (
             EXISTS (
               SELECT 1 FROM ml_order_feedback f
               WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
                 AND f.side = 'sale' AND f.rating IS NOT NULL AND TRIM(f.rating) <> ''
             )
             OR (
               o.feedback_sale IS NOT NULL
               AND TRIM(o.feedback_sale) <> ''
               AND LOWER(TRIM(o.feedback_sale)) <> 'pending'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM ml_order_feedback f
             WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
               AND f.side = 'purchase' AND f.rating IS NOT NULL AND TRIM(f.rating) <> ''
           )
           AND o.feedback_purchase_value IS NULL
           AND (
             o.feedback_purchase IS NULL
             OR TRIM(COALESCE(o.feedback_purchase, '')) = ''
             OR LOWER(TRIM(o.feedback_purchase)) = 'pending'
           )${statusSql}
         ORDER BY o.date_created DESC, o.id DESC`
      )
      .all(...params);
  }

  const paramsSimple = st ? [mlUid, since, st] : [mlUid, since];
  return db
    .prepare(
      `SELECT o.id, o.ml_user_id, o.order_id, o.buyer_id, o.status, o.date_created
       FROM ml_orders o
       WHERE o.ml_user_id = ?
         AND o.date_created >= ?
         AND o.buyer_id IS NOT NULL
         AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'invalid')
         AND NOT EXISTS (SELECT 1 FROM ml_rating_request_sent r WHERE r.order_id = o.order_id)
         AND (
           EXISTS (
             SELECT 1 FROM ml_order_feedback f
             WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
               AND f.side = 'sale' AND f.rating IS NOT NULL AND TRIM(f.rating) <> ''
           )
           OR (
             o.feedback_sale IS NOT NULL
             AND TRIM(o.feedback_sale) <> ''
             AND LOWER(TRIM(o.feedback_sale)) <> 'pending'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM ml_order_feedback f
           WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
             AND f.side = 'purchase' AND f.rating IS NOT NULL AND TRIM(f.rating) <> ''
         )
         AND o.feedback_purchase_value IS NULL
         AND (
           o.feedback_purchase IS NULL
           OR TRIM(COALESCE(o.feedback_purchase, '')) = ''
           OR LOWER(TRIM(o.feedback_purchase)) = 'pending'
         )${statusSql}
       ORDER BY o.date_created DESC, o.id DESC`
    )
    .all(...paramsSimple);
}

function insertMlRatingRequestLog(row) {
  const mlUid = Number(row.ml_user_id);
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const oc = row.outcome != null ? String(row.outcome).trim().toLowerCase() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return null;
  }
  if (oc !== "success" && oc !== "api_error") return null;
  const createdAt = row.created_at != null ? String(row.created_at) : new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO ml_rating_request_log (
         created_at, ml_user_id, order_id, buyer_id, outcome, skip_reason,
         http_status, request_path, response_body, error_message
       ) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`
    )
    .get(
      createdAt,
      mlUid,
      oid,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      oc,
      row.skip_reason != null ? String(row.skip_reason).slice(0, 2000) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null
    );
  return r && r.id != null ? Number(r.id) : null;
}

function listMlRatingRequestLog(limit, maxAllowed, options = {}) {
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const mode = String(options.outcome || "all").toLowerCase();
  let extra = "";
  if (mode === "success") extra = " AND l.outcome = 'success'";
  else if (mode === "api_error") extra = " AND l.outcome = 'api_error'";
  return db
    .prepare(
      `SELECT l.id, l.created_at, l.ml_user_id, l.order_id, l.buyer_id, l.outcome, l.skip_reason,
              l.http_status, l.request_path, l.response_body, l.error_message,
              o.feedback_purchase AS purchase_feedback_now,
              o.feedback_purchase_value AS purchase_rating_value
       FROM ml_rating_request_log l
       LEFT JOIN ml_orders o ON o.ml_user_id = l.ml_user_id AND o.order_id = l.order_id
       WHERE 1=1${extra}
       ORDER BY l.id DESC LIMIT ?`
    )
    .all(n);
}

function insertMlListingChangeAck(row) {
  const mlUid = Number(row.ml_user_id);
  const itemId = row.item_id != null ? String(row.item_id).trim() : "";
  const action = row.action != null ? String(row.action).trim().toLowerCase() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !itemId) {
    return null;
  }
  if (!ML_LISTING_CHANGE_ACK_ACTIONS.includes(action)) {
    return null;
  }
  const createdAt = row.created_at != null ? String(row.created_at) : new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO ml_listing_change_ack (
         ml_user_id, item_id, webhook_log_id, action, note, created_at
       ) VALUES (?,?,?,?,?,?) RETURNING id`
    )
    .get(
      mlUid,
      itemId,
      row.webhook_log_id != null ? Number(row.webhook_log_id) : null,
      action,
      row.note != null ? String(row.note).slice(0, 4000) : null,
      createdAt
    );
  return r && r.id != null ? Number(r.id) : null;
}

function listMlListingChangeAck(limit, maxAllowed, options = {}) {
  const cap = maxAllowed != null ? maxAllowed : 5000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  const uid =
    options.ml_user_id != null && Number.isFinite(Number(options.ml_user_id))
      ? Number(options.ml_user_id)
      : null;
  const iid =
    options.item_id != null && String(options.item_id).trim() !== ""
      ? String(options.item_id).trim()
      : null;
  if (uid != null && iid != null) {
    return db
      .prepare(
        `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
         FROM ml_listing_change_ack
         WHERE ml_user_id = ? AND item_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(uid, iid, n);
  }
  if (uid != null) {
    return db
      .prepare(
        `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
         FROM ml_listing_change_ack
         WHERE ml_user_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(uid, n);
  }
  if (iid != null) {
    return db
      .prepare(
        `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
         FROM ml_listing_change_ack
         WHERE item_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(iid, n);
  }
  return db
    .prepare(
      `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
       FROM ml_listing_change_ack ORDER BY id DESC LIMIT ?`
    )
    .all(n);
}

function upsertMlListing(row) {
  const mlUid = Number(row.ml_user_id);
  const itemId = row.item_id != null ? String(row.item_id).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !itemId) {
    return null;
  }
  const now = new Date().toISOString();
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rawJson = row.raw_json != null ? String(row.raw_json) : "{}";
  const priceVal =
    row.price != null && String(row.price).trim() !== "" ? Number(row.price) : null;
  upsertMlListingStmt.run({
    ml_user_id: mlUid,
    item_id: itemId,
    site_id: row.site_id != null ? String(row.site_id) : null,
    seller_id: row.seller_id != null ? Number(row.seller_id) : null,
    status: row.status != null ? String(row.status) : null,
    title: row.title != null ? String(row.title) : null,
    price: priceVal != null && Number.isFinite(priceVal) ? priceVal : null,
    currency_id: row.currency_id != null ? String(row.currency_id) : null,
    available_quantity: row.available_quantity != null ? Number(row.available_quantity) : null,
    sold_quantity: row.sold_quantity != null ? Number(row.sold_quantity) : null,
    category_id: row.category_id != null ? String(row.category_id) : null,
    listing_type: row.listing_type != null ? String(row.listing_type) : null,
    permalink: row.permalink != null ? String(row.permalink) : null,
    thumbnail: row.thumbnail != null ? String(row.thumbnail) : null,
    raw_json: rawJson,
    search_json: row.search_json != null ? String(row.search_json) : null,
    http_status: row.http_status != null ? Number(row.http_status) : null,
    sync_error: row.sync_error != null ? String(row.sync_error).slice(0, 4000) : null,
    fetched_at: fetchedAt,
    updated_at: updatedAt,
  });
  const r = db.prepare("SELECT id FROM ml_listings WHERE ml_user_id = ? AND item_id = ?").get(mlUid, itemId);
  return r && r.id != null ? Number(r.id) : null;
}

function listMlListingsByUser(mlUserId, limit, maxAllowed, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 5000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  if (st) {
    return db
      .prepare(
        `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
                available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
                raw_json, search_json, http_status, sync_error, fetched_at, updated_at
         FROM ml_listings WHERE ml_user_id = ?
           AND LOWER(TRIM(COALESCE(status, ''))) = LOWER(?)
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(mlUid, st, n);
  }
  return db
    .prepare(
      `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings WHERE ml_user_id = ? ORDER BY updated_at DESC LIMIT ?`
    )
    .all(mlUid, n);
}

function getMlListingByItemId(mlUserId, itemId) {
  const mlUid = Number(mlUserId);
  const iid = itemId != null ? String(itemId).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !iid) return null;
  return (
    db
      .prepare(
        `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
                available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
                raw_json, search_json, http_status, sync_error, fetched_at, updated_at
         FROM ml_listings WHERE ml_user_id = ? AND item_id = ?`
      )
      .get(mlUid, iid) || null
  );
}

const upsertMlListingSyncStateStmt = db.prepare(
  `INSERT INTO ml_listing_sync_state (
     ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
   ) VALUES (@ml_user_id, @last_scroll_id, @last_offset, @last_batch_total, @last_sync_at, @last_sync_status, @last_error, @updated_at)
   ON CONFLICT(ml_user_id) DO UPDATE SET
     last_scroll_id = excluded.last_scroll_id,
     last_offset = excluded.last_offset,
     last_batch_total = excluded.last_batch_total,
     last_sync_at = excluded.last_sync_at,
     last_sync_status = excluded.last_sync_status,
     last_error = excluded.last_error,
     updated_at = excluded.updated_at`
);

function upsertMlListingSyncState(row) {
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const now = new Date().toISOString();
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  upsertMlListingSyncStateStmt.run({
    ml_user_id: mlUid,
    last_scroll_id: row.last_scroll_id != null ? String(row.last_scroll_id) : null,
    last_offset: row.last_offset != null ? Number(row.last_offset) : null,
    last_batch_total: row.last_batch_total != null ? Number(row.last_batch_total) : null,
    last_sync_at: row.last_sync_at != null ? String(row.last_sync_at) : null,
    last_sync_status: row.last_sync_status != null ? String(row.last_sync_status) : null,
    last_error: row.last_error != null ? String(row.last_error).slice(0, 4000) : null,
    updated_at: updatedAt,
  });
  return mlUid;
}

function getMlListingSyncState(mlUserId) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  return (
    db
      .prepare(
        `SELECT ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
         FROM ml_listing_sync_state WHERE ml_user_id = ?`
      )
      .get(mlUid) || null
  );
}

function listMlListingsAll(limit, maxAllowed, options = {}) {
  const cap = maxAllowed != null ? maxAllowed : 10000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  if (st) {
    return db
      .prepare(
        `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
                available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
                raw_json, search_json, http_status, sync_error, fetched_at, updated_at
         FROM ml_listings
         WHERE LOWER(TRIM(COALESCE(status, ''))) = LOWER(?)
         ORDER BY ml_user_id ASC, updated_at DESC LIMIT ?`
      )
      .all(st, n);
  }
  return db
    .prepare(
      `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings ORDER BY ml_user_id ASC, updated_at DESC LIMIT ?`
    )
    .all(n);
}

function listMlListingSyncStatesAll() {
  return db
    .prepare(
      `SELECT ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
       FROM ml_listing_sync_state ORDER BY ml_user_id ASC`
    )
    .all();
}

function listMlListingCountsByUser() {
  return db
    .prepare(
      `SELECT ml_user_id, COUNT(*) AS total FROM ml_listings GROUP BY ml_user_id ORDER BY ml_user_id ASC`
    )
    .all();
}

module.exports = {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
  dbPath,
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
  countMlBuyers,
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
  upsertMlQuestionPending,
  getMlQuestionPendingByQuestionId,
  deleteMlQuestionPending,
  upsertMlQuestionAnswered,
  listMlQuestionsPending,
  listMlQuestionsAnswered,
  upsertMlListing,
  listMlListingsByUser,
  getMlListingByItemId,
  upsertMlListingSyncState,
  getMlListingSyncState,
  listMlListingsAll,
  listMlListingSyncStatesAll,
  listMlListingCountsByUser,
  insertMlListingWebhookLog,
  listMlListingWebhookLog,
  ML_LISTING_CHANGE_ACK_ACTIONS,
  insertMlListingChangeAck,
  listMlListingChangeAck,
  upsertMlOrder,
  listMlOrdersByUser,
  listMlOrdersAll,
  updateMlOrderFeedbackSummary,
  listMlOrderCountsByUserStatus,
  listMlOrderCountsByUser,
  upsertMlOrderFeedback,
  listMlOrderFeedbackByOrder,
  listMlOrderFeedbackByUser,
  wasMlRatingRequestSent,
  insertMlRatingRequestSent,
  wasRatingRequestSentToBuyerToday,
  listMlOrdersEligibleForRatingRequest,
  insertMlRatingRequestLog,
  listMlRatingRequestLog,
};
