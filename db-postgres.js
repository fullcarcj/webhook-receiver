/**
 * Persistencia PostgreSQL (Render: DATABASE_URL interna o externa).
 * Esquema y migraciones (PostgreSQL). `db-sqlite.js` existe solo como referencia opcional; `db.js` solo carga este módulo.
 */
const { Pool } = require("pg");
const {
  normalizeBuyerPrefEntrega,
  normalizeCambioDatos,
  normalizeNombreApellido,
  resolvePrefEntregaForUpsert,
} = require("./ml-buyer-pref");
const { feedbackPurchaseRatingValue } = require("./ml-order-map");

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
    `CREATE TABLE IF NOT EXISTS ml_rating_request_sent (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      ml_user_id BIGINT NOT NULL,
      buyer_id BIGINT,
      sent_at TEXT NOT NULL,
      http_status INTEGER,
      error_message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_sent_order ON ml_rating_request_sent(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user ON ml_rating_request_sent(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user_buyer_sent ON ml_rating_request_sent(ml_user_id, buyer_id, sent_at)`,
    `CREATE TABLE IF NOT EXISTS ml_rating_request_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TEXT NOT NULL,
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      buyer_id BIGINT,
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      http_status INTEGER,
      request_path TEXT,
      response_body TEXT,
      error_message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_created ON ml_rating_request_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_user ON ml_rating_request_log(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_log_order ON ml_rating_request_log(order_id)`,
    `CREATE TABLE IF NOT EXISTS ml_retiro_broadcast_sent (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      buyer_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      slot TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      http_status INTEGER,
      template_index SMALLINT,
      error_message TEXT,
      CONSTRAINT chk_ml_retiro_slot CHECK (slot IN ('morning', 'afternoon'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_retiro_sent_user_buyer ON ml_retiro_broadcast_sent(ml_user_id, buyer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_retiro_sent_user_slot ON ml_retiro_broadcast_sent(ml_user_id, slot, sent_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ml_retiro_broadcast_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      buyer_id BIGINT,
      slot TEXT NOT NULL,
      outcome TEXT NOT NULL,
      template_index SMALLINT,
      http_status INTEGER,
      request_path TEXT,
      response_body TEXT,
      error_message TEXT,
      CONSTRAINT chk_ml_retiro_log_slot CHECK (slot IN ('morning', 'afternoon')),
      CONSTRAINT chk_ml_retiro_log_outcome CHECK (outcome IN ('success', 'api_error'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_retiro_log_created ON ml_retiro_broadcast_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_retiro_log_user ON ml_retiro_broadcast_log(ml_user_id)`,
    `CREATE TABLE IF NOT EXISTS ml_message_kind_send_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_kind CHAR(1) NOT NULL CHECK (message_kind IN ('A','B','C')),
      ml_user_id BIGINT NOT NULL,
      buyer_id BIGINT,
      order_id BIGINT,
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      http_status INTEGER,
      detail TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_msg_kind_log_created ON ml_message_kind_send_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_msg_kind_log_user ON ml_message_kind_send_log(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_msg_kind_log_kind ON ml_message_kind_send_log(message_kind)`,
    `CREATE TABLE IF NOT EXISTS ml_questions_ia_auto_sent (
      ml_question_id BIGINT PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      http_status INTEGER,
      template_index SMALLINT,
      answer_preview TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_ia_auto_user ON ml_questions_ia_auto_sent(ml_user_id, sent_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ml_questions_ia_auto_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ml_user_id BIGINT NOT NULL,
      ml_question_id BIGINT,
      item_id TEXT,
      buyer_id BIGINT,
      outcome TEXT NOT NULL,
      reason_detail TEXT,
      notification_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_ia_auto_log_created ON ml_questions_ia_auto_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_ia_auto_log_user ON ml_questions_ia_auto_log(ml_user_id)`,
    `CREATE TABLE IF NOT EXISTS ml_questions_pending (
      id SERIAL PRIMARY KEY,
      ml_question_id BIGINT NOT NULL UNIQUE,
      ml_user_id BIGINT NOT NULL,
      item_id TEXT,
      buyer_id BIGINT,
      question_text TEXT,
      ml_status TEXT,
      date_created TEXT,
      raw_json TEXT,
      notification_id TEXT,
      ia_auto_route_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_pending_user ON ml_questions_pending(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_pending_created ON ml_questions_pending(created_at)`,
    `CREATE TABLE IF NOT EXISTS ml_questions_answered (
      id SERIAL PRIMARY KEY,
      ml_question_id BIGINT NOT NULL UNIQUE,
      ml_user_id BIGINT NOT NULL,
      item_id TEXT,
      buyer_id BIGINT,
      question_text TEXT,
      answer_text TEXT NOT NULL,
      ml_status TEXT,
      date_created TEXT,
      raw_json TEXT,
      notification_id TEXT,
      pending_internal_id BIGINT,
      answered_at TEXT NOT NULL,
      moved_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      response_time_sec INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_answered_user ON ml_questions_answered(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_questions_answered_at ON ml_questions_answered(answered_at)`,
    `CREATE TABLE IF NOT EXISTS ml_items (
      item_id TEXT PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      resource TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      http_status INTEGER,
      notification_id TEXT,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_items_user ON ml_items(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_items_updated ON ml_items(updated_at)`,
    `CREATE TABLE IF NOT EXISTS ml_listings (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      item_id TEXT NOT NULL,
      site_id TEXT,
      seller_id BIGINT,
      status TEXT,
      title TEXT,
      price NUMERIC(20, 4),
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
      CONSTRAINT uq_ml_listings_account_item UNIQUE (ml_user_id, item_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listings_user_status ON ml_listings(ml_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listings_user_updated ON ml_listings(ml_user_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listings_item_id ON ml_listings(item_id)`,
    `CREATE TABLE IF NOT EXISTS ml_listing_sync_state (
      ml_user_id BIGINT PRIMARY KEY,
      last_scroll_id TEXT,
      last_offset INTEGER,
      last_batch_total INTEGER,
      last_sync_at TEXT,
      last_sync_status TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ml_listing_webhook_log (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      item_id TEXT NOT NULL,
      notification_id TEXT,
      topic TEXT,
      request_path TEXT,
      http_status INTEGER,
      upsert_ok BOOLEAN NOT NULL DEFAULT false,
      listing_id BIGINT,
      error_message TEXT,
      fetched_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_webhook_log_user ON ml_listing_webhook_log(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_webhook_log_fetched ON ml_listing_webhook_log(fetched_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_webhook_log_item ON ml_listing_webhook_log(item_id)`,
    `CREATE TABLE IF NOT EXISTS ml_listing_change_ack (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      item_id TEXT NOT NULL,
      webhook_log_id BIGINT,
      action TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      CONSTRAINT chk_ml_listing_change_ack_action CHECK (
        action IN ('activate', 'add_stock', 'pause', 'delete', 'dismiss')
      )
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_user ON ml_listing_change_ack(ml_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_created ON ml_listing_change_ack(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_listing_change_ack_item ON ml_listing_change_ack(ml_user_id, item_id)`,
    `CREATE TABLE IF NOT EXISTS ml_orders (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      status TEXT,
      date_created TEXT,
      total_amount NUMERIC(20, 4),
      currency_id TEXT,
      buyer_id BIGINT,
      buyer_phone_registered BOOLEAN,
      feedback_sale TEXT,
      feedback_purchase TEXT,
      feedback_purchase_value SMALLINT,
      raw_json TEXT NOT NULL,
      http_status INTEGER,
      sync_error TEXT,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT uq_ml_orders_account_order UNIQUE (ml_user_id, order_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_orders_user_status ON ml_orders(ml_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_orders_user_created ON ml_orders(ml_user_id, date_created DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_orders_order_id ON ml_orders(order_id)`,
    `CREATE TABLE IF NOT EXISTS ml_order_feedback (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      side TEXT NOT NULL,
      ml_feedback_id BIGINT NOT NULL,
      role TEXT,
      fulfilled BOOLEAN,
      rating TEXT,
      reason TEXT,
      message TEXT,
      reply TEXT,
      date_created TEXT,
      visibility_date TEXT,
      feedback_status TEXT,
      modified BOOLEAN,
      restock_item BOOLEAN,
      has_seller_refunded_money BOOLEAN,
      from_user_id BIGINT,
      to_user_id BIGINT,
      from_nickname TEXT,
      to_nickname TEXT,
      item_id TEXT,
      item_title TEXT,
      item_price NUMERIC(20, 4),
      item_currency_id TEXT,
      extended_feedback JSONB,
      site_id TEXT,
      app_id TEXT,
      raw_json TEXT NOT NULL,
      source TEXT,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT uq_ml_order_feedback_ml_id UNIQUE (ml_feedback_id),
      CONSTRAINT chk_ml_order_feedback_side CHECK (side IN ('sale', 'purchase'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_user_order ON ml_order_feedback(ml_user_id, order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_user_rating ON ml_order_feedback(ml_user_id, rating)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_order_feedback_date ON ml_order_feedback(date_created DESC)`,
    `CREATE TABLE IF NOT EXISTS ml_order_pack_messages (
      id BIGSERIAL PRIMARY KEY,
      ml_user_id BIGINT NOT NULL,
      order_id BIGINT NOT NULL,
      ml_message_id TEXT NOT NULL,
      from_user_id BIGINT,
      to_user_id BIGINT,
      message_text TEXT,
      date_created TEXT,
      status TEXT,
      moderation_status TEXT,
      tag TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_ml_order_pack_msg UNIQUE (ml_user_id, order_id, ml_message_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_pack_msg_user_order ON ml_order_pack_messages(ml_user_id, order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_pack_msg_user_fetched ON ml_order_pack_messages(ml_user_id, fetched_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ml_wasender_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      api_base_url TEXT NOT NULL DEFAULT 'https://www.wasenderapi.com',
      default_phone_country_code TEXT NOT NULL DEFAULT '58',
      is_enabled BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ml_whatsapp_tipo_e_config (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      image_url TEXT,
      image_caption TEXT,
      delay_ms INTEGER,
      location_lat DOUBLE PRECISION,
      location_lng DOUBLE PRECISION,
      location_name TEXT,
      location_address TEXT,
      location_maps_url TEXT,
      location_chat_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ml_whatsapp_wasender_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_kind CHAR(1) NOT NULL CHECK (message_kind IN ('E','F')),
      ml_user_id BIGINT,
      buyer_id BIGINT,
      order_id BIGINT,
      ml_question_id BIGINT,
      phone_e164 TEXT NOT NULL,
      phone_source TEXT CHECK (phone_source IN ('phone_1','phone_2')),
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      http_status INTEGER,
      wasender_msg_id BIGINT,
      response_body TEXT,
      error_message TEXT,
      text_preview TEXT,
      tipo_e_step SMALLINT CHECK (tipo_e_step IS NULL OR tipo_e_step IN (1, 2))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_wa_log_created ON ml_whatsapp_wasender_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_wa_log_kind ON ml_whatsapp_wasender_log(message_kind)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_wa_log_buyer ON ml_whatsapp_wasender_log(buyer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_wa_log_order ON ml_whatsapp_wasender_log(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_wa_log_question ON ml_whatsapp_wasender_log(ml_question_id)`,
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

  await pool.query(
    `INSERT INTO ml_wasender_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );

  await pool.query(
    `INSERT INTO ml_whatsapp_tipo_e_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );

  await migratePostSaleAutoSendLogNonOrdersV2();
  await migratePostSaleAutoSendLogTopicOrdersV2Only();
  await migrateMlBuyersPrefEntrega();
  await migrateMlBuyersCambioDatos();
  await migrateMlBuyersActualizacionYDefaults();
  await migrateMlBuyersNombreApellido();
  await migrateMlVentasDetalleAnchorPositions();
  await migrateMlAccountsCookiesNetscape();
  await migrateMlQuestionsAnsweredResponseTimeSec();
  await migrateMlQuestionsDateCreated();
  await migrateMlQuestionsIaAutoRouteDetail();
  await migrateMlOrdersExtraColumns();
  await migrateMlOrdersFeedbackPurchaseValue();
  await migrateMlRatingRequestSentBuyerId();
  await migrateMlRatingRequestSentMultiRow();
  await migrateMlWhatsappWasenderLogBuyerNullable();
  await migrateMlWhatsappWasenderLogTipoEStep();
}

/** Columna tipo_e_step (1=imagen+caption, 2=ubicación Maps) para WhatsApp tipo E. */
async function migrateMlWhatsappWasenderLogTipoEStep() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_whatsapp_wasender_log' AND column_name = 'tipo_e_step'`
    );
    if (rows.length === 0) {
      await pool.query(
        `ALTER TABLE ml_whatsapp_wasender_log ADD COLUMN tipo_e_step SMALLINT
         CHECK (tipo_e_step IS NULL OR tipo_e_step IN (1, 2))`
      );
      console.log("[db] ml_whatsapp_wasender_log: columna tipo_e_step añadida (migración)");
    }
  } catch (e) {
    if (!String(e.message || "").includes("does not exist")) {
      console.error("[db] migrate ml_whatsapp_wasender_log tipo_e_step:", e.message);
    }
  }
}

/** Instalaciones previas: buyer_id NOT NULL → nullable para logs skipped sin comprador. */
async function migrateMlWhatsappWasenderLogBuyerNullable() {
  try {
    const { rows } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_whatsapp_wasender_log' AND column_name = 'buyer_id'`
    );
    if (rows.length && rows[0].is_nullable === "NO") {
      await pool.query(`ALTER TABLE ml_whatsapp_wasender_log ALTER COLUMN buyer_id DROP NOT NULL`);
      console.log("[db] ml_whatsapp_wasender_log: buyer_id nullable (migración)");
    }
  } catch (e) {
    if (!String(e.message || "").includes("does not exist")) {
      console.error("[db] migrate ml_whatsapp_wasender_log buyer_id:", e.message);
    }
  }
}

async function migrateMlOrdersFeedbackPurchaseValue() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_orders' AND column_name = 'feedback_purchase_value'`
    );
    if (rows.length > 0) return;
    await pool.query(`ALTER TABLE ml_orders ADD COLUMN feedback_purchase_value SMALLINT`);
    console.log("[db] ml_orders: columna feedback_purchase_value añadida (migración)");
    await pool.query(`
      UPDATE ml_orders SET feedback_purchase_value = CASE
        WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'positive' THEN 1
        WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'neutral' THEN 0
        WHEN LOWER(TRIM(COALESCE(feedback_purchase,''))) = 'negative' THEN -1
        ELSE NULL
      END`);
  } catch (e) {
    console.error("[db] migrate ml_orders feedback_purchase_value:", e.message);
  }
}

async function migrateMlRatingRequestSentBuyerId() {
  try {
    const { rows: c } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_rating_request_sent' AND column_name = 'buyer_id'`
    );
    if (c.length === 0) {
      await pool.query(`ALTER TABLE ml_rating_request_sent ADD COLUMN buyer_id BIGINT`);
      console.log("[db] ml_rating_request_sent: columna buyer_id añadida (migración)");
    }
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_user_buyer_sent ON ml_rating_request_sent(ml_user_id, buyer_id, sent_at)`
    );
    await pool.query(`
      UPDATE ml_rating_request_sent r
      SET buyer_id = o.buyer_id
      FROM ml_orders o
      WHERE o.order_id = r.order_id AND r.buyer_id IS NULL AND o.buyer_id IS NOT NULL
    `);
  } catch (e) {
    console.error("[db] migrate ml_rating_request_sent buyer_id:", e.message);
  }
}

/** Mensaje tipo C: varias filas por order_id (hasta N días de recordatorio). */
async function migrateMlRatingRequestSentMultiRow() {
  try {
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_rating_request_sent' AND column_name = 'id'`
    );
    if (col.length > 0) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_sent_order ON ml_rating_request_sent(order_id)`
      );
      return;
    }
    await pool.query(`ALTER TABLE ml_rating_request_sent DROP CONSTRAINT IF EXISTS ml_rating_request_sent_pkey`);
    await pool.query(`ALTER TABLE ml_rating_request_sent ADD COLUMN id BIGSERIAL PRIMARY KEY`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_ml_rating_request_sent_order ON ml_rating_request_sent(order_id)`
    );
    console.log("[db] ml_rating_request_sent: varias filas por order_id (tipo C, hasta N envíos por orden)");
  } catch (e) {
    console.error("[db] migrate ml_rating_request_sent multi-row:", e.message);
  }
}

async function migrateMlOrdersExtraColumns() {
  try {
    const { rows: c1 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_orders' AND column_name = 'buyer_phone_registered'`
    );
    if (c1.length === 0) {
      await pool.query(`ALTER TABLE ml_orders ADD COLUMN buyer_phone_registered BOOLEAN`);
      console.log("[db] ml_orders: columna buyer_phone_registered añadida (migración)");
    }
    const { rows: c2 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_orders' AND column_name = 'feedback_sale'`
    );
    if (c2.length === 0) {
      await pool.query(`ALTER TABLE ml_orders ADD COLUMN feedback_sale TEXT`);
      console.log("[db] ml_orders: columna feedback_sale añadida (migración)");
    }
    const { rows: c3 } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_orders' AND column_name = 'feedback_purchase'`
    );
    if (c3.length === 0) {
      await pool.query(`ALTER TABLE ml_orders ADD COLUMN feedback_purchase TEXT`);
      console.log("[db] ml_orders: columna feedback_purchase añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_orders extra columns:", e.message);
  }
}

async function migrateMlQuestionsAnsweredResponseTimeSec() {
  try {
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_questions_answered' AND column_name = 'response_time_sec'`
    );
    if (col.length === 0) {
      await pool.query(`ALTER TABLE ml_questions_answered ADD COLUMN response_time_sec INTEGER`);
      console.log("[db] ml_questions_answered: columna response_time_sec añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_questions_answered response_time_sec:", e.message);
  }
}

async function migrateMlQuestionsDateCreated() {
  try {
    const { rows: p } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_questions_pending' AND column_name = 'date_created'`
    );
    if (p.length === 0) {
      await pool.query(`ALTER TABLE ml_questions_pending ADD COLUMN date_created TEXT`);
      console.log("[db] ml_questions_pending: columna date_created añadida (migración)");
    }
    const { rows: a } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_questions_answered' AND column_name = 'date_created'`
    );
    if (a.length === 0) {
      await pool.query(`ALTER TABLE ml_questions_answered ADD COLUMN date_created TEXT`);
      console.log("[db] ml_questions_answered: columna date_created añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_questions date_created:", e.message);
  }
}

async function migrateMlQuestionsIaAutoRouteDetail() {
  try {
    const { rows: p } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ml_questions_pending' AND column_name = 'ia_auto_route_detail'`
    );
    if (p.length === 0) {
      await pool.query(
        `ALTER TABLE ml_questions_pending ADD COLUMN ia_auto_route_detail TEXT`
      );
      console.log("[db] ml_questions_pending: columna ia_auto_route_detail añadida (migración)");
    }
  } catch (e) {
    console.error("[db] migrate ml_questions ia_auto_route_detail:", e.message);
  }
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

/**
 * Una vez: limpia datos legacy y añade CHECK(topic = orders_v2).
 * No borra filas en cada arranque (antes vaciaba success/skipped en cada ensureSchema).
 */
async function migratePostSaleAutoSendLogTopicOrdersV2Only() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _mig_ps_auto_log_topic_check (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const { rows: migDone } = await pool.query(
      `SELECT 1 FROM _mig_ps_auto_log_topic_check WHERE id = 1 LIMIT 1`
    );
    if (migDone.length > 0) return;

    const { rows: hasCheck } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'ml_post_sale_auto_send_log_topic_orders_v2' LIMIT 1`
    );
    if (hasCheck.length === 0) {
      await pool.query(`DELETE FROM ml_post_sale_auto_send_log WHERE topic IS DISTINCT FROM 'orders_v2'`);
      await pool.query(
        `DELETE FROM ml_post_sale_auto_send_log WHERE outcome IN ('success', 'skipped')`
      );
      await pool.query(
        `DELETE FROM ml_post_sale_auto_send_log WHERE skip_reason IS DISTINCT FROM 'message_step=0'`
      );
      await pool.query(`
        ALTER TABLE ml_post_sale_auto_send_log
        ADD CONSTRAINT ml_post_sale_auto_send_log_topic_orders_v2
        CHECK (topic = 'orders_v2')
      `);
      console.log("[db] ml_post_sale_auto_send_log: CHECK(topic = orders_v2) aplicado");
    }
    await pool.query(`INSERT INTO _mig_ps_auto_log_topic_check (id) VALUES (1)`);
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
     FROM webhook_events ORDER BY id DESC LIMIT $1`,
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

/** Sin filtro topic: orden por id DESC (recientes primero; todos los topics). Con filtro: ese topic, id DESC. */
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
  const { rows } = await pool.query(`${selectFrom} ORDER BY f.id DESC LIMIT $1`, [n]);
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

async function countMlBuyers() {
  await ensureSchema();
  const { rows } = await pool.query("SELECT COUNT(*)::bigint AS c FROM ml_buyers");
  return Number(rows[0].c);
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

/**
 * Reserva atómica del paso antes del POST a ML: solo un proceso puede “ganar” por (order_id, step_index).
 * Si ya había fila (envío previo OK o carrera), devuelve false y no se debe enviar.
 * Si el POST falla, llamar releasePostSaleStepClaim para permitir reintento.
 */
async function tryClaimPostSaleStepForSend(orderId, stepIndex) {
  await ensureSchema();
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return false;
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_post_sale_steps_sent (order_id, step_index, sent_at) VALUES ($1, $2, $3)
     ON CONFLICT (order_id, step_index) DO NOTHING
     RETURNING order_id`,
    [id, si, now]
  );
  return rows.length > 0;
}

async function releasePostSaleStepClaim(orderId, stepIndex) {
  await ensureSchema();
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return;
  await pool.query(`DELETE FROM ml_post_sale_steps_sent WHERE order_id = $1 AND step_index = $2`, [id, si]);
}

/**
 * Si ya consta un envío exitoso de este paso en el día civil (tz), no reenviar el mismo mensaje ese día
 * (p. ej. fila en steps_sent borrada pero log conservado, o inconsistencia).
 */
async function hasPostSaleSuccessForStepToday(orderId, stepIndex, tz) {
  await ensureSchema();
  const id = Number(orderId);
  const si = Number(stepIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(si) || si < 0) return false;
  const zone =
    tz != null && String(tz).trim() !== "" ? String(tz).trim() : "America/Caracas";
  const skipReason = `message_step=${si}`;
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_post_sale_auto_send_log
     WHERE order_id = $1
       AND outcome = 'success'
       AND skip_reason = $2
       AND topic = 'orders_v2'
       AND DATE(timezone($3::text, (created_at)::timestamptz))
         = DATE(timezone($3::text, CURRENT_TIMESTAMP))
     LIMIT 1`,
    [id, skipReason, zone]
  );
  return rows.length > 0;
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
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    console.error("[post-sale log DB] ml_user_id inválido:", row.ml_user_id);
    return null;
  }
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO ml_post_sale_auto_send_log (
       created_at, ml_user_id, topic, notification_id, order_id, outcome, skip_reason,
       http_status, option_id, request_path, response_body, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      row.created_at || new Date().toISOString(),
      mlUid,
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

/**
 * Registro unificado de intentos/envíos por tipo de mensaje (A post-venta orden, B retiro, C calificación).
 * Fallos silenciosos para no interrumpir el flujo de envío.
 */
async function insertMlMessageKindSendLog(row) {
  try {
    const kindRaw = row.message_kind != null ? String(row.message_kind).trim().toUpperCase() : "";
    const kind = kindRaw === "A" || kindRaw === "B" || kindRaw === "C" ? kindRaw : null;
    if (!kind) return null;
    const mlUid = Number(row.ml_user_id);
    if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
    const oc = row.outcome != null ? String(row.outcome).trim() : "";
    if (!oc) return null;
    await ensureSchema();
    await pool.query(
      `INSERT INTO ml_message_kind_send_log (
         created_at, message_kind, ml_user_id, buyer_id, order_id, outcome, skip_reason, http_status, detail
       ) VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.created_at != null ? String(row.created_at) : new Date().toISOString(),
        kind,
        mlUid,
        row.buyer_id != null && Number.isFinite(Number(row.buyer_id)) ? Number(row.buyer_id) : null,
        row.order_id != null && Number.isFinite(Number(row.order_id)) ? Number(row.order_id) : null,
        oc.slice(0, 80),
        row.skip_reason != null ? String(row.skip_reason).slice(0, 2000) : null,
        row.http_status != null ? Number(row.http_status) : null,
        row.detail != null ? String(row.detail).slice(0, 2000) : null,
      ]
    );
  } catch (e) {
    console.error("[db] insertMlMessageKindSendLog:", e.message);
  }
  return null;
}

/**
 * @param {string|number|null} limit
 * @param {number|null} maxAllowed
 * @param {{ message_kind?: 'A'|'B'|'C'|'all', outcome?: string }} [options]
 */
async function listMlMessageKindSendLog(limit, maxAllowed, options = {}) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const mkRaw = options.message_kind != null ? String(options.message_kind).trim().toUpperCase() : "ALL";
  const mk =
    mkRaw === "A" || mkRaw === "B" || mkRaw === "C"
      ? mkRaw
      : "ALL";
  const ocRaw = options.outcome != null ? String(options.outcome).trim().toLowerCase() : "default";
  const validOutcomes = new Set(["success", "skipped", "api_error"]);
  const ocFilter = validOutcomes.has(ocRaw) ? ocRaw : null;

  const conditions = [];
  const params = [];
  let pi = 1;
  if (mk !== "ALL") {
    conditions.push(`message_kind = $${pi++}`);
    params.push(mk);
  }
  if (ocFilter) {
    conditions.push(`outcome = $${pi++}`);
    params.push(ocFilter);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(n);
  const { rows } = await pool.query(
    `SELECT id, created_at, message_kind, ml_user_id, buyer_id, order_id, outcome, skip_reason, http_status, detail
     FROM ml_message_kind_send_log
     ${where}
     ORDER BY id DESC LIMIT $${pi}`,
    params
  );
  return rows;
}

/**
 * Si el caller no envía `ia_auto_route_detail` (undefined), guardamos un JSON mínimo para no dejar la columna vacía.
 * Si envía `null` o "" explícitos, pasamos null y COALESCE conserva el valor anterior en UPDATE.
 * @param {object} row
 * @returns {string|null}
 */
function resolveIaAutoRouteDetailForUpsert(row) {
  if (Object.prototype.hasOwnProperty.call(row, "ia_auto_route_detail")) {
    const v = row.ia_auto_route_detail;
    if (v != null && String(v).trim() !== "") return String(v);
    return null;
  }
  return JSON.stringify({
    route: "pending_detail_not_provided",
    evaluated_at_utc: new Date().toISOString(),
    human:
      "El upsert no incluyó ia_auto_route_detail (despliegue antiguo o llamada sin el campo). Volvé a desplegar el servidor o ejecutá sync GET /questions/{id} para rellenar.",
  });
}

/**
 * Inserta o actualiza una pregunta pendiente (respuesta GET /questions/{id}).
 * @param {object} row
 */
async function upsertMlQuestionPending(row) {
  await ensureSchema();
  const qid = Number(row.ml_question_id);
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(qid) || qid <= 0 || !Number.isFinite(mlUid) || mlUid <= 0) {
    return null;
  }
  const now = new Date().toISOString();
  const iaRouteDetail = resolveIaAutoRouteDetailForUpsert(row);
  const { rows } = await pool.query(
    `INSERT INTO ml_questions_pending (
       ml_question_id, ml_user_id, item_id, buyer_id, question_text, ml_status, date_created, raw_json, notification_id, ia_auto_route_detail, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (ml_question_id) DO UPDATE SET
       ml_user_id = EXCLUDED.ml_user_id,
       item_id = EXCLUDED.item_id,
       buyer_id = EXCLUDED.buyer_id,
       question_text = EXCLUDED.question_text,
       ml_status = EXCLUDED.ml_status,
       date_created = EXCLUDED.date_created,
       raw_json = EXCLUDED.raw_json,
       notification_id = EXCLUDED.notification_id,
       ia_auto_route_detail = COALESCE(EXCLUDED.ia_auto_route_detail, ml_questions_pending.ia_auto_route_detail),
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      qid,
      mlUid,
      row.item_id != null ? String(row.item_id) : null,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      row.question_text != null ? String(row.question_text) : null,
      row.ml_status != null ? String(row.ml_status) : null,
      row.date_created != null ? String(row.date_created) : null,
      row.raw_json != null ? String(row.raw_json) : null,
      row.notification_id != null ? String(row.notification_id) : null,
      iaRouteDetail,
      now,
      now,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Fila en pending por id de pregunta ML (p. ej. para reutilizar date_created al pasar a answered).
 * @param {number|string} mlQuestionId
 * @returns {Promise<object|null>}
 */
async function getMlQuestionPendingByQuestionId(mlQuestionId) {
  await ensureSchema();
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  const { rows } = await pool.query(
    `SELECT id, ml_question_id, ml_user_id, date_created, raw_json, ia_auto_route_detail
     FROM ml_questions_pending WHERE ml_question_id = $1`,
    [qid]
  );
  return rows[0] || null;
}

async function deleteMlQuestionPending(mlQuestionId) {
  await ensureSchema();
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return 0;
  const { rowCount } = await pool.query(`DELETE FROM ml_questions_pending WHERE ml_question_id = $1`, [qid]);
  return rowCount || 0;
}

/** Vacía toda la tabla (solo cola local; no borra preguntas en Mercado Libre). */
async function deleteAllMlQuestionsPending() {
  await ensureSchema();
  const { rowCount } = await pool.query(`DELETE FROM ml_questions_pending`);
  return rowCount || 0;
}

/**
 * Contexto mínimo de pregunta ML para WhatsApp tipo F: pendiente o respondida.
 * @returns {Promise<{ ml_question_id: number, ml_user_id: number, buyer_id: number|null, item_id: string|null, question_text: string|null, source: 'pending'|'answered' }|null>}
 */
async function getMlQuestionContextForWhatsapp(mlQuestionId) {
  await ensureSchema();
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return null;
  const { rows: p } = await pool.query(
    `SELECT ml_question_id, ml_user_id, buyer_id, item_id, question_text
     FROM ml_questions_pending WHERE ml_question_id = $1`,
    [qid]
  );
  if (p[0]) {
    return { ...p[0], source: "pending" };
  }
  const { rows: a } = await pool.query(
    `SELECT ml_question_id, ml_user_id, buyer_id, item_id, question_text
     FROM ml_questions_answered WHERE ml_question_id = $1`,
    [qid]
  );
  if (a[0]) {
    return { ...a[0], source: "answered" };
  }
  return null;
}

async function upsertMlQuestionAnswered(row) {
  await ensureSchema();
  const qid = Number(row.ml_question_id);
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(qid) || qid <= 0 || !Number.isFinite(mlUid) || mlUid <= 0) {
    return null;
  }
  const answerText = row.answer_text != null ? String(row.answer_text) : "(sin texto en API)";
  const now = new Date().toISOString();
  const answeredAt = row.answered_at != null ? String(row.answered_at) : now;
  const movedAt = row.moved_at != null ? String(row.moved_at) : now;
  const createdAt = row.created_at != null ? String(row.created_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rts =
    row.response_time_sec != null && Number.isFinite(Number(row.response_time_sec))
      ? Math.floor(Number(row.response_time_sec))
      : null;
  const { rows } = await pool.query(
    `INSERT INTO ml_questions_answered (
       ml_question_id, ml_user_id, item_id, buyer_id, question_text, answer_text, ml_status, date_created, raw_json, notification_id, pending_internal_id, answered_at, moved_at, created_at, updated_at, response_time_sec
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (ml_question_id) DO UPDATE SET
       ml_user_id = EXCLUDED.ml_user_id,
       item_id = EXCLUDED.item_id,
       buyer_id = EXCLUDED.buyer_id,
       question_text = EXCLUDED.question_text,
       answer_text = EXCLUDED.answer_text,
       ml_status = EXCLUDED.ml_status,
       date_created = EXCLUDED.date_created,
       raw_json = EXCLUDED.raw_json,
       notification_id = EXCLUDED.notification_id,
       pending_internal_id = EXCLUDED.pending_internal_id,
       answered_at = EXCLUDED.answered_at,
       moved_at = EXCLUDED.moved_at,
       updated_at = EXCLUDED.updated_at,
       response_time_sec = EXCLUDED.response_time_sec
     RETURNING id`,
    [
      qid,
      mlUid,
      row.item_id != null ? String(row.item_id) : null,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      row.question_text != null ? String(row.question_text) : null,
      answerText,
      row.ml_status != null ? String(row.ml_status) : null,
      row.date_created != null ? String(row.date_created) : null,
      row.raw_json != null ? String(row.raw_json) : null,
      row.notification_id != null ? String(row.notification_id) : null,
      row.pending_internal_id != null ? Number(row.pending_internal_id) : null,
      answeredAt,
      movedAt,
      createdAt,
      updatedAt,
      rts,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function listMlQuestionsPending(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, ml_question_id, ml_user_id, item_id, buyer_id, question_text, ml_status, date_created, raw_json, notification_id, ia_auto_route_detail, created_at, updated_at
     FROM ml_questions_pending ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

/** Una consulta barata para el poll IA (evita listar pending si la tabla está vacía). */
async function hasMlQuestionsPending() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT 1 FROM ml_questions_pending LIMIT 1`);
  return rows.length > 0;
}

/**
 * Cuáles de estos ml_question_id ya tienen fila en ml_questions_ia_auto_sent (una query).
 * @param {(number|string)[]} mlQuestionIds
 * @returns {Promise<Set<number>>}
 */
async function getMlQuestionsIaAutoSentIdSet(mlQuestionIds) {
  await ensureSchema();
  const ids = (mlQuestionIds || [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT ml_question_id FROM ml_questions_ia_auto_sent WHERE ml_question_id = ANY($1::bigint[])`,
    [ids]
  );
  return new Set(rows.map((r) => Number(r.ml_question_id)));
}

async function listMlQuestionsAnswered(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, ml_question_id, ml_user_id, item_id, buyer_id, question_text, answer_text, ml_status, date_created, raw_json, notification_id, pending_internal_id, answered_at, moved_at, created_at, updated_at, response_time_sec
     FROM ml_questions_answered ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

async function wasMlQuestionsIaAutoSent(mlQuestionId) {
  await ensureSchema();
  const qid = Number(mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_questions_ia_auto_sent WHERE ml_question_id = $1 LIMIT 1`,
    [qid]
  );
  return rows.length > 0;
}

async function insertMlQuestionsIaAutoSent(row) {
  await ensureSchema();
  const qid = Number(row.ml_question_id);
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(qid) || qid <= 0 || !Number.isFinite(mlUid) || mlUid <= 0) return null;
  const sentAt = row.sent_at != null ? String(row.sent_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_questions_ia_auto_sent (ml_question_id, ml_user_id, sent_at, http_status, template_index, answer_preview)
     VALUES ($1,$2,$3::timestamptz,$4,$5,$6)
     ON CONFLICT (ml_question_id) DO NOTHING
     RETURNING ml_question_id`,
    [
      qid,
      mlUid,
      sentAt,
      row.http_status != null ? Number(row.http_status) : null,
      row.template_index != null ? Number(row.template_index) : null,
      row.answer_preview != null ? String(row.answer_preview).slice(0, 2000) : null,
    ]
  );
  return rows[0] ? Number(rows[0].ml_question_id) : null;
}

/**
 * Log de intentos de respuesta IA (p. ej. fuera de ventana, error API).
 * outcome: skip_disabled | skip_no_config | bad_window_parse | skip_day | skip_window | until_expired | skip_already | api_error | …
 */
async function insertMlQuestionsIaAutoLog(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const oc = row.outcome != null ? String(row.outcome).trim().slice(0, 64) : "";
  if (!oc) return null;
  const createdAt = row.created_at != null ? String(row.created_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_questions_ia_auto_log (
       created_at, ml_user_id, ml_question_id, item_id, buyer_id, outcome, reason_detail, notification_id
     ) VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      createdAt,
      mlUid,
      row.ml_question_id != null ? Number(row.ml_question_id) : null,
      row.item_id != null ? String(row.item_id).slice(0, 128) : null,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      oc,
      row.reason_detail != null ? String(row.reason_detail).slice(0, 8000) : null,
      row.notification_id != null ? String(row.notification_id).slice(0, 128) : null,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function listMlQuestionsIaAutoLog(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, created_at, ml_user_id, ml_question_id, item_id, buyer_id, outcome, reason_detail, notification_id
     FROM ml_questions_ia_auto_log ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

/**
 * Acciones permitidas al marcar un cambio de publicación como “procesado” (solo registro; no llama a la API ML).
 */
const ML_LISTING_CHANGE_ACK_ACTIONS = Object.freeze([
  "activate",
  "add_stock",
  "pause",
  "delete",
  "dismiss",
]);

/**
 * Auditoría: webhook topic items → GET /items y upsert en ml_listings.
 * @param {object} row
 */
async function insertMlListingWebhookLog(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const itemId = row.item_id != null ? String(row.item_id).trim() : "";
  if (!itemId) return null;
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_listing_webhook_log (
       ml_user_id, item_id, notification_id, topic, request_path, http_status,
       upsert_ok, listing_id, error_message, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      mlUid,
      itemId,
      row.notification_id != null ? String(row.notification_id) : null,
      row.topic != null ? String(row.topic).slice(0, 80) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.http_status != null ? Number(row.http_status) : null,
      Boolean(row.upsert_ok),
      row.listing_id != null ? Number(row.listing_id) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
      fetchedAt,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Listado reciente (admin / consultas). */
async function listMlListingWebhookLog(limit, maxAllowed) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 5000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, item_id, notification_id, topic, request_path, http_status,
            upsert_ok, listing_id, error_message, fetched_at
     FROM ml_listing_webhook_log ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

/**
 * Registra cómo se procesó un ítem tras un cambio (activar, stock, pausar, etc.).
 * @param {object} row
 * @param {string} row.action — una de ML_LISTING_CHANGE_ACK_ACTIONS
 */
async function insertMlListingChangeAck(row) {
  await ensureSchema();
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
  const { rows } = await pool.query(
    `INSERT INTO ml_listing_change_ack (
       ml_user_id, item_id, webhook_log_id, action, note, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      mlUid,
      itemId,
      row.webhook_log_id != null ? Number(row.webhook_log_id) : null,
      action,
      row.note != null ? String(row.note).slice(0, 4000) : null,
      createdAt,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * @param {number} limit
 * @param {number} [maxAllowed]
 * @param {{ ml_user_id?: number, item_id?: string }} [options]
 */
async function listMlListingChangeAck(limit, maxAllowed, options = {}) {
  await ensureSchema();
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
    const { rows } = await pool.query(
      `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
       FROM ml_listing_change_ack
       WHERE ml_user_id = $1 AND item_id = $2
       ORDER BY id DESC LIMIT $3`,
      [uid, iid, n]
    );
    return rows;
  }
  if (uid != null) {
    const { rows } = await pool.query(
      `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
       FROM ml_listing_change_ack
       WHERE ml_user_id = $1
       ORDER BY id DESC LIMIT $2`,
      [uid, n]
    );
    return rows;
  }
  if (iid != null) {
    const { rows } = await pool.query(
      `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
       FROM ml_listing_change_ack
       WHERE item_id = $1
       ORDER BY id DESC LIMIT $2`,
      [iid, n]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, item_id, webhook_log_id, action, note, created_at
     FROM ml_listing_change_ack ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

async function upsertMlOrder(row) {
  await ensureSchema();
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
    row.total_amount != null && String(row.total_amount).trim() !== "" ? row.total_amount : null;

  const fbSale = row.feedback_sale != null ? String(row.feedback_sale).slice(0, 200) : null;
  const fbPurchase = row.feedback_purchase != null ? String(row.feedback_purchase).slice(0, 200) : null;
  const fbPurchaseVal = feedbackPurchaseRatingValue(fbPurchase);

  let buyerPhoneRegistered = false;
  const bid = row.buyer_id != null ? Number(row.buyer_id) : null;
  if (bid != null && Number.isFinite(bid) && bid > 0) {
    const buyer = await getMlBuyer(bid);
    buyerPhoneRegistered = Boolean(
      buyer && buyer.phone_1 != null && String(buyer.phone_1).trim() !== ""
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO ml_orders (
       ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
       buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
       raw_json, http_status, sync_error, fetched_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (ml_user_id, order_id) DO UPDATE SET
       status = EXCLUDED.status,
       date_created = EXCLUDED.date_created,
       total_amount = EXCLUDED.total_amount,
       currency_id = EXCLUDED.currency_id,
       buyer_id = EXCLUDED.buyer_id,
       buyer_phone_registered = EXCLUDED.buyer_phone_registered,
       feedback_sale = EXCLUDED.feedback_sale,
       feedback_purchase = EXCLUDED.feedback_purchase,
       feedback_purchase_value = EXCLUDED.feedback_purchase_value,
       raw_json = EXCLUDED.raw_json,
       http_status = EXCLUDED.http_status,
       sync_error = EXCLUDED.sync_error,
       fetched_at = EXCLUDED.fetched_at,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      mlUid,
      oid,
      row.status != null ? String(row.status) : null,
      row.date_created != null ? String(row.date_created) : null,
      totalVal != null ? totalVal : null,
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
      updatedAt,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Una orden por cuenta ML y `order_id` (p. ej. WhatsApp tipo E). */
async function getMlOrderByUserAndOrderId(mlUserId, orderId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return null;
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, order_id, status, date_created, buyer_id, total_amount, currency_id
     FROM ml_orders WHERE ml_user_id = $1 AND order_id = $2`,
    [mlUid, oid]
  );
  return rows[0] || null;
}

async function listMlOrdersByUser(mlUserId, limit, maxAllowed, options = {}) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 10000;
  const n = Math.min(Math.max(Number(limit) || 200, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  const sql = st
    ? `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders WHERE ml_user_id = $1
         AND LOWER(TRIM(COALESCE(status, ''))) = LOWER($3)
       ORDER BY date_created DESC NULLS LAST, id DESC LIMIT $2`
    : `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders WHERE ml_user_id = $1
       ORDER BY date_created DESC NULLS LAST, id DESC LIMIT $2`;
  const params = st ? [mlUid, n, st] : [mlUid, n];
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function listMlOrdersAll(limit, maxAllowed, options = {}) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 20000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  const sql = st
    ? `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders
       WHERE LOWER(TRIM(COALESCE(status, ''))) = LOWER($2)
       ORDER BY ml_user_id ASC, date_created DESC NULLS LAST, id DESC LIMIT $1`
    : `SELECT id, ml_user_id, order_id, status, date_created, total_amount, currency_id, buyer_id,
              buyer_phone_registered, feedback_sale, feedback_purchase, feedback_purchase_value,
              raw_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_orders ORDER BY ml_user_id ASC, date_created DESC NULLS LAST, id DESC LIMIT $1`;
  const params = st ? [n, st] : [n];
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Actualiza `feedback_sale`, `feedback_purchase` y `feedback_purchase_value` en `ml_orders` (resumen como en order_search).
 * Usado tras GET /orders/{id}/feedback para alinear la fila de la orden con el job de recordatorios.
 * @returns {number} filas afectadas (0 si no existía la orden)
 */
async function updateMlOrderFeedbackSummary(mlUserId, orderId, feedbackSale, feedbackPurchase) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return 0;
  const now = new Date().toISOString();
  const fpStr = feedbackPurchase != null ? String(feedbackPurchase) : null;
  const fpVal = feedbackPurchaseRatingValue(fpStr);
  const r = await pool.query(
    `UPDATE ml_orders SET
       feedback_sale = $3,
       feedback_purchase = $4,
       feedback_purchase_value = $5,
       updated_at = $6
     WHERE ml_user_id = $1 AND order_id = $2`,
    [
      mlUid,
      oid,
      feedbackSale != null ? String(feedbackSale) : null,
      fpStr,
      Number.isFinite(fpVal) ? fpVal : null,
      now,
    ]
  );
  return r.rowCount ?? 0;
}

async function listMlOrderCountsByUserStatus() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, status, COUNT(*)::int AS total
     FROM ml_orders GROUP BY ml_user_id, status
     ORDER BY ml_user_id ASC, status ASC NULLS LAST`
  );
  return rows;
}

/** Total de órdenes por cuenta (resumen UI, como listMlListingCountsByUser). */
async function listMlOrderCountsByUser() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, COUNT(*)::int AS total FROM ml_orders GROUP BY ml_user_id ORDER BY ml_user_id ASC`
  );
  return rows;
}

/**
 * Mensaje post-venta dentro del pack de una orden (GET /messages/packs/{id}/sellers/{seller_id}).
 * @param {object} row
 */
async function upsertMlOrderPackMessage(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  const mid = row.ml_message_id != null ? String(row.ml_message_id).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0 || !mid) {
    return null;
  }
  const now = new Date().toISOString();
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rawJson = row.raw_json != null ? String(row.raw_json) : "{}";
  const { rows } = await pool.query(
    `INSERT INTO ml_order_pack_messages (
       ml_user_id, order_id, ml_message_id, from_user_id, to_user_id,
       message_text, date_created, status, moderation_status, tag,
       raw_json, fetched_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz
     )
     ON CONFLICT (ml_user_id, order_id, ml_message_id) DO UPDATE SET
       from_user_id = EXCLUDED.from_user_id,
       to_user_id = EXCLUDED.to_user_id,
       message_text = EXCLUDED.message_text,
       date_created = EXCLUDED.date_created,
       status = EXCLUDED.status,
       moderation_status = EXCLUDED.moderation_status,
       tag = EXCLUDED.tag,
       raw_json = EXCLUDED.raw_json,
       fetched_at = EXCLUDED.fetched_at,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      mlUid,
      oid,
      mid,
      row.from_user_id != null && Number.isFinite(Number(row.from_user_id)) ? Number(row.from_user_id) : null,
      row.to_user_id != null && Number.isFinite(Number(row.to_user_id)) ? Number(row.to_user_id) : null,
      row.message_text != null ? String(row.message_text) : null,
      row.date_created != null ? String(row.date_created) : null,
      row.status != null ? String(row.status) : null,
      row.moderation_status != null ? String(row.moderation_status) : null,
      row.tag != null ? String(row.tag) : null,
      rawJson,
      fetchedAt,
      updatedAt,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {number} [limit]
 */
async function listMlOrderPackMessagesByOrder(mlUserId, orderId, limit) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return [];
  const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, order_id, ml_message_id, from_user_id, to_user_id,
            message_text, date_created, status, moderation_status, tag,
            raw_json, fetched_at, updated_at
     FROM ml_order_pack_messages
     WHERE ml_user_id = $1 AND order_id = $2
     ORDER BY date_created DESC NULLS LAST, id DESC
     LIMIT $3`,
    [mlUid, oid, n]
  );
  return rows;
}

/**
 * Mensajes post-venta guardados (sync). Si `options.order_id` está definido, equivale a listMlOrderPackMessagesByOrder.
 * @param {number} mlUserId
 * @param {number} limit
 * @param {{ order_id?: number }} [options]
 */
async function listMlOrderPackMessagesByUser(mlUserId, limit, options = {}) {
  const oid = options.order_id != null ? Number(options.order_id) : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    return listMlOrderPackMessagesByOrder(mlUserId, oid, limit);
  }
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const n = Math.min(Math.max(Number(limit) || 200, 1), 5000);
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, order_id, ml_message_id, from_user_id, to_user_id,
            message_text, date_created, status, moderation_status, tag,
            raw_json, fetched_at, updated_at
     FROM ml_order_pack_messages
     WHERE ml_user_id = $1
     ORDER BY fetched_at DESC NULLS LAST, id DESC
     LIMIT $2`,
    [mlUid, n]
  );
  return rows;
}

/** Filas { ml_user_id, total } para resumen por cuenta (ml_order_pack_messages). */
async function listMlOrderPackMessageCountsByUser() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, COUNT(*)::bigint AS total
     FROM ml_order_pack_messages
     GROUP BY ml_user_id
     ORDER BY ml_user_id ASC`
  );
  return rows.map((r) => ({
    ml_user_id: Number(r.ml_user_id),
    total: Number(r.total),
  }));
}

async function countMlOrderPackMessagesTotal() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS c FROM ml_order_pack_messages`);
  const n = rows[0] && rows[0].c != null ? Number(rows[0].c) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function countMlOrderPackMessagesForMlUser(mlUserId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM ml_order_pack_messages WHERE ml_user_id = $1`,
    [mlUid]
  );
  const n = rows[0] && rows[0].c != null ? Number(rows[0].c) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function countMlOrderPackMessagesForOrder(mlUserId, orderId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM ml_order_pack_messages WHERE ml_user_id = $1 AND order_id = $2`,
    [mlUid, oid]
  );
  const n = rows[0] && rows[0].c != null ? Number(rows[0].c) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function upsertMlOrderFeedback(row) {
  await ensureSchema();
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
  const ext = row.extended_feedback;
  const extVal =
    ext === null || ext === undefined
      ? null
      : typeof ext === "object"
        ? ext
        : null;

  const { rows: out } = await pool.query(
    `INSERT INTO ml_order_feedback (
       ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
       date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
       from_user_id, to_user_id, from_nickname, to_nickname,
       item_id, item_title, item_price, item_currency_id,
       extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
     )
     ON CONFLICT (ml_feedback_id) DO UPDATE SET
       ml_user_id = EXCLUDED.ml_user_id,
       order_id = EXCLUDED.order_id,
       side = EXCLUDED.side,
       role = EXCLUDED.role,
       fulfilled = EXCLUDED.fulfilled,
       rating = EXCLUDED.rating,
       reason = EXCLUDED.reason,
       message = EXCLUDED.message,
       reply = EXCLUDED.reply,
       date_created = EXCLUDED.date_created,
       visibility_date = EXCLUDED.visibility_date,
       feedback_status = EXCLUDED.feedback_status,
       modified = EXCLUDED.modified,
       restock_item = EXCLUDED.restock_item,
       has_seller_refunded_money = EXCLUDED.has_seller_refunded_money,
       from_user_id = EXCLUDED.from_user_id,
       to_user_id = EXCLUDED.to_user_id,
       from_nickname = EXCLUDED.from_nickname,
       to_nickname = EXCLUDED.to_nickname,
       item_id = EXCLUDED.item_id,
       item_title = EXCLUDED.item_title,
       item_price = EXCLUDED.item_price,
       item_currency_id = EXCLUDED.item_currency_id,
       extended_feedback = EXCLUDED.extended_feedback,
       site_id = EXCLUDED.site_id,
       app_id = EXCLUDED.app_id,
       raw_json = EXCLUDED.raw_json,
       source = EXCLUDED.source,
       fetched_at = EXCLUDED.fetched_at,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      mlUid,
      oid,
      side,
      fid,
      row.role != null ? String(row.role) : null,
      row.fulfilled === true ? true : row.fulfilled === false ? false : null,
      row.rating != null ? String(row.rating).slice(0, 64) : null,
      row.reason != null ? String(row.reason).slice(0, 128) : null,
      row.message != null ? String(row.message).slice(0, 4000) : null,
      row.reply != null ? String(row.reply).slice(0, 4000) : null,
      row.date_created != null ? String(row.date_created) : null,
      row.visibility_date != null ? String(row.visibility_date) : null,
      row.feedback_status != null ? String(row.feedback_status).slice(0, 64) : null,
      row.modified === true ? true : row.modified === false ? false : null,
      row.restock_item === true ? true : row.restock_item === false ? false : null,
      row.has_seller_refunded_money === true
        ? true
        : row.has_seller_refunded_money === false
          ? false
          : null,
      row.from_user_id != null ? Number(row.from_user_id) : null,
      row.to_user_id != null ? Number(row.to_user_id) : null,
      row.from_nickname != null ? String(row.from_nickname).slice(0, 256) : null,
      row.to_nickname != null ? String(row.to_nickname).slice(0, 256) : null,
      row.item_id != null ? String(row.item_id).slice(0, 64) : null,
      row.item_title != null ? String(row.item_title).slice(0, 512) : null,
      row.item_price != null && String(row.item_price).trim() !== "" ? row.item_price : null,
      row.item_currency_id != null ? String(row.item_currency_id).slice(0, 16) : null,
      extVal,
      row.site_id != null ? String(row.site_id).slice(0, 16) : null,
      row.app_id != null ? String(row.app_id).slice(0, 32) : null,
      rawJson,
      row.source != null ? String(row.source).slice(0, 64) : null,
      fetchedAt,
      updatedAt,
    ]
  );
  return out[0] ? Number(out[0].id) : null;
}

async function listMlOrderFeedbackByOrder(mlUserId, orderId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return [];
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
            date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
            from_user_id, to_user_id, from_nickname, to_nickname,
            item_id, item_title, item_price, item_currency_id,
            extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
     FROM ml_order_feedback
     WHERE ml_user_id = $1 AND order_id = $2
     ORDER BY side ASC`,
    [mlUid, oid]
  );
  return rows;
}

async function listMlOrderFeedbackByUser(mlUserId, limit, maxAllowed) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 20000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, order_id, side, ml_feedback_id, role, fulfilled, rating, reason, message, reply,
            date_created, visibility_date, feedback_status, modified, restock_item, has_seller_refunded_money,
            from_user_id, to_user_id, from_nickname, to_nickname,
            item_id, item_title, item_price, item_currency_id,
            extended_feedback, site_id, app_id, raw_json, source, fetched_at, updated_at
     FROM ml_order_feedback
     WHERE ml_user_id = $1
     ORDER BY date_created DESC NULLS LAST, id DESC
     LIMIT $2`,
    [mlUid, n]
  );
  return rows;
}

async function wasMlRatingRequestSent(orderId) {
  await ensureSchema();
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_rating_request_sent WHERE order_id = $1 LIMIT 1`,
    [oid]
  );
  return rows.length > 0;
}

async function insertMlRatingRequestSent(row) {
  await ensureSchema();
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
  await pool.query(
    `INSERT INTO ml_rating_request_sent (order_id, ml_user_id, buyer_id, sent_at, http_status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      oid,
      mlUid,
      bid,
      sentAt,
      row.http_status != null ? Number(row.http_status) : null,
      row.error_message != null ? String(row.error_message).slice(0, 2000) : null,
    ]
  );
  return oid;
}

/**
 * ¿Ya se envió hoy (rango UTC [dayStartIso, dayEndIso)) un recordatorio a este comprador desde esta cuenta?
 * Garantiza el tope de un mensaje diario por (ml_user_id, buyer_id) para recordatorios de calificación.
 */
async function wasRatingRequestSentToBuyerToday(mlUserId, buyerId, dayStartIso, dayEndIso) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const bid = buyerId != null ? Number(buyerId) : NaN;
  const ds = dayStartIso != null ? String(dayStartIso).trim() : "";
  const de = dayEndIso != null ? String(dayEndIso).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(bid) || bid <= 0 || !ds || !de) {
    return false;
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_rating_request_sent
     WHERE ml_user_id = $1 AND buyer_id = $2
       AND sent_at >= $3 AND sent_at < $4
     LIMIT 1`,
    [mlUid, bid, ds, de]
  );
  return rows.length > 0;
}

/**
 * Órdenes recientes donde el vendedor ya calificó (sale) y el comprador aún no (purchase pending),
 * y no se envió aún el recordatorio de calificación.
 * Compra→nosotros pending: sin rating en ml_order_feedback (purchase), feedback_purchase_value NULL
 * y texto feedback_purchase NULL / vacío / 'pending' (alineado a feedback.purchase.rating pendiente en ML).
 * Ventana temporal: date_created >= sinceIso (p. ej. últimos 6 días vía ML_RATING_REQUEST_LOOKBACK_DAYS).
 * @param {number} mlUserId
 * @param {string} sinceIso - límite inferior de date_created (orden creada en ventana)
 * @param {string} [dayStartIso] - inicio del día UTC (incl.) para no repetir comprador
 * @param {string} [dayEndIso] - fin del día UTC (excl.)
 * @param {string|null} [orderStatus] - si se pasa (ej. "confirmed"), solo órdenes con ese status en ml_orders (comparación case-insensitive)
 * @param {number} [maxSendsPerOrder=8] - tope de envíos tipo C por orden (uno por día cuando corre el job)
 */
async function listMlOrdersEligibleForRatingRequest(
  mlUserId,
  sinceIso,
  dayStartIso,
  dayEndIso,
  orderStatus,
  maxSendsPerOrder
) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const since = sinceIso != null ? String(sinceIso).trim() : "";
  if (!since) return [];

  const maxRaw = maxSendsPerOrder != null ? Number(maxSendsPerOrder) : 8;
  const maxSends =
    Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(90, Math.floor(maxRaw)) : 8;

  const ds = dayStartIso != null ? String(dayStartIso).trim() : "";
  const de = dayEndIso != null ? String(dayEndIso).trim() : "";
  const filterBuyerDay = ds !== "" && de !== "";
  const stRaw = orderStatus != null ? String(orderStatus).trim() : "";
  const st = stRaw || null;

  const statusClause = filterBuyerDay
    ? ` AND ($5::text IS NULL OR LOWER(TRIM(COALESCE(o.status, ''))) = LOWER(TRIM($5::text)))`
    : ` AND ($3::text IS NULL OR LOWER(TRIM(COALESCE(o.status, ''))) = LOWER(TRIM($3::text)))`;

  const sql = filterBuyerDay
    ? `SELECT o.id, o.ml_user_id, o.order_id, o.buyer_id, o.status, o.date_created
     FROM ml_orders o
     WHERE o.ml_user_id = $1
       AND o.date_created >= $2
       AND o.buyer_id IS NOT NULL
       AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'invalid')
       AND (SELECT COUNT(*)::int FROM ml_rating_request_sent r WHERE r.order_id = o.order_id) < $6
       AND NOT EXISTS (
         SELECT 1 FROM ml_rating_request_sent r
         WHERE r.ml_user_id = o.ml_user_id
           AND r.buyer_id = o.buyer_id
           AND r.buyer_id IS NOT NULL
           AND r.sent_at >= $3 AND r.sent_at < $4
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
       )${statusClause}
     ORDER BY o.date_created DESC NULLS LAST, o.id DESC`
    : `SELECT o.id, o.ml_user_id, o.order_id, o.buyer_id, o.status, o.date_created
     FROM ml_orders o
     WHERE o.ml_user_id = $1
       AND o.date_created >= $2
       AND o.buyer_id IS NOT NULL
       AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'invalid')
       AND (SELECT COUNT(*)::int FROM ml_rating_request_sent r WHERE r.order_id = o.order_id) < $4
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
       )${statusClause}
     ORDER BY o.date_created DESC NULLS LAST, o.id DESC`;

  const params = filterBuyerDay
    ? [mlUid, since, ds, de, st, maxSends]
    : [mlUid, since, st, maxSends];
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Log de intentos de envío de recordatorio de calificación (POST mensajería ML).
 * outcome: success | api_error
 */
async function insertMlRatingRequestLog(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return null;
  const oc = row.outcome != null ? String(row.outcome).trim().toLowerCase() : "";
  if (oc !== "success" && oc !== "api_error") return null;
  const createdAt = row.created_at != null ? String(row.created_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_rating_request_log (
       created_at, ml_user_id, order_id, buyer_id, outcome, skip_reason,
       http_status, request_path, response_body, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      createdAt,
      mlUid,
      oid,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      oc,
      row.skip_reason != null ? String(row.skip_reason).slice(0, 2000) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** @param {{ outcome?: string }} [options] outcome: all | success | api_error */
async function listMlRatingRequestLog(limit, maxAllowed, options = {}) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const mode = String(options.outcome || "all").toLowerCase();
  let extra = "";
  if (mode === "success") extra = " AND l.outcome = 'success'";
  else if (mode === "api_error") extra = " AND l.outcome = 'api_error'";
  const { rows } = await pool.query(
    `SELECT l.id, l.created_at, l.ml_user_id, l.order_id, l.buyer_id, l.outcome, l.skip_reason,
            l.http_status, l.request_path, l.response_body, l.error_message,
            o.feedback_purchase AS purchase_feedback_now,
            o.feedback_purchase_value AS purchase_rating_value
     FROM ml_rating_request_log l
     LEFT JOIN ml_orders o ON o.ml_user_id = l.ml_user_id AND o.order_id = l.order_id
     WHERE 1=1${extra}
     ORDER BY l.id DESC LIMIT $1`,
    [n]
  );
  return rows;
}

/**
 * Órdenes recientes elegibles para mensajes de retiro/despacho (mensajería post-venta).
 * Condición: calificación **pendiente en ambos lados** (vendedor→comprador `sale` y comprador→vendedor `purchase`).
 * En `ml_order_feedback`, solo cuenta como ya calificado `rating` positive|neutral|negative (no `pending` ni vacío).
 * Resumen en `ml_orders` alineado: feedback_sale / feedback_purchase sin valor concreto y feedback_purchase_value NULL.
 * Excluye compradores que ya recibieron un envío en el mismo slot (mañana o tarde) el día civil en `tz`.
 * @param {string} slot - 'morning' | 'afternoon'
 * @param {string} tz - p. ej. America/Caracas
 */
async function listMlOrdersEligibleForRetiroBroadcast(mlUserId, sinceIso, orderStatus, slot, tz) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const since = sinceIso != null ? String(sinceIso).trim() : "";
  if (!since) return [];
  const sl = slot != null ? String(slot).trim().toLowerCase() : "";
  if (sl !== "morning" && sl !== "afternoon") return [];
  const zone = tz != null && String(tz).trim() !== "" ? String(tz).trim() : "America/Caracas";
  const stRaw = orderStatus != null ? String(orderStatus).trim() : "";
  const st = stRaw || null;

  const { rows } = await pool.query(
    `SELECT o.id, o.ml_user_id, o.order_id, o.buyer_id, o.status, o.date_created
     FROM ml_orders o
     WHERE o.ml_user_id = $1
       AND o.date_created >= $2
       AND o.buyer_id IS NOT NULL
       AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'invalid')
       AND ($3::text IS NULL OR LOWER(TRIM(COALESCE(o.status, ''))) = LOWER(TRIM($3::text)))
       AND NOT EXISTS (
         SELECT 1 FROM ml_order_feedback f
         WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
           AND f.side = 'sale'
           AND f.rating IS NOT NULL
           AND LOWER(TRIM(f.rating)) IN ('positive', 'neutral', 'negative')
       )
       AND (
         o.feedback_sale IS NULL
         OR TRIM(COALESCE(o.feedback_sale, '')) = ''
         OR LOWER(TRIM(o.feedback_sale)) = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1 FROM ml_order_feedback f
         WHERE f.ml_user_id = o.ml_user_id AND f.order_id = o.order_id
           AND f.side = 'purchase'
           AND f.rating IS NOT NULL
           AND LOWER(TRIM(f.rating)) IN ('positive', 'neutral', 'negative')
       )
       AND o.feedback_purchase_value IS NULL
       AND (
         o.feedback_purchase IS NULL
         OR TRIM(COALESCE(o.feedback_purchase, '')) = ''
         OR LOWER(TRIM(o.feedback_purchase)) = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1 FROM ml_retiro_broadcast_sent r
         WHERE r.ml_user_id = o.ml_user_id
           AND r.buyer_id = o.buyer_id
           AND r.slot = $4
           AND DATE(timezone($5::text, r.sent_at)) = DATE(timezone($5::text, CURRENT_TIMESTAMP))
       )
     ORDER BY o.date_created DESC NULLS LAST, o.id DESC`,
    [mlUid, since, st, sl, zone]
  );
  return rows;
}

async function wasRetiroBroadcastSentToBuyerTodaySlot(mlUserId, buyerId, slot, tz) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const bid = buyerId != null ? Number(buyerId) : NaN;
  const sl = slot != null ? String(slot).trim().toLowerCase() : "";
  const zone = tz != null && String(tz).trim() !== "" ? String(tz).trim() : "America/Caracas";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(bid) || bid <= 0) {
    return false;
  }
  if (sl !== "morning" && sl !== "afternoon") return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ml_retiro_broadcast_sent
     WHERE ml_user_id = $1 AND buyer_id = $2 AND slot = $3
       AND DATE(timezone($4::text, sent_at)) = DATE(timezone($4::text, CURRENT_TIMESTAMP))
     LIMIT 1`,
    [mlUid, bid, sl, zone]
  );
  return rows.length > 0;
}

async function insertMlRetiroBroadcastSent(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  const bid = row.buyer_id != null ? Number(row.buyer_id) : NaN;
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(bid) || bid <= 0) return null;
  if (!Number.isFinite(oid) || oid <= 0) return null;
  const sl = row.slot != null ? String(row.slot).trim().toLowerCase() : "";
  if (sl !== "morning" && sl !== "afternoon") return null;
  const sentAt = row.sent_at != null ? String(row.sent_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_retiro_broadcast_sent (
       ml_user_id, buyer_id, order_id, slot, sent_at, http_status, template_index, error_message
     ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8) RETURNING id`,
    [
      mlUid,
      bid,
      oid,
      sl,
      sentAt,
      row.http_status != null ? Number(row.http_status) : null,
      row.template_index != null ? Number(row.template_index) : null,
      row.error_message != null ? String(row.error_message).slice(0, 2000) : null,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Mensajes automáticos enviados hoy al comprador (día civil en `tz`): post-venta (cada paso),
 * recordatorio calificación y retiro/despacho. Para aplicar ML_AUTO_MESSAGE_MAX por día.
 */
async function countMlAutoMessagesForBuyerToday(mlUserId, buyerId, tz) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const bid = buyerId != null ? Number(buyerId) : NaN;
  const zone =
    tz != null && String(tz).trim() !== "" ? String(tz).trim() : "America/Caracas";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(bid) || bid <= 0) return 0;
  const { rows } = await pool.query(
    `SELECT (
       COALESCE((
         SELECT COUNT(*)::bigint FROM ml_post_sale_steps_sent s
         INNER JOIN ml_orders o ON o.order_id = s.order_id AND o.ml_user_id = $1
         WHERE o.buyer_id = $2
           AND DATE(timezone($3::text, (s.sent_at)::timestamptz))
             = DATE(timezone($3::text, CURRENT_TIMESTAMP))
       ), 0)
       + COALESCE((
         SELECT COUNT(*)::bigint FROM ml_rating_request_sent r
         WHERE r.ml_user_id = $1 AND r.buyer_id = $2
           AND DATE(timezone($3::text, (r.sent_at)::timestamptz))
             = DATE(timezone($3::text, CURRENT_TIMESTAMP))
       ), 0)
       + COALESCE((
         SELECT COUNT(*)::bigint FROM ml_retiro_broadcast_sent t
         WHERE t.ml_user_id = $1 AND t.buyer_id = $2
           AND DATE(timezone($3::text, t.sent_at))
             = DATE(timezone($3::text, CURRENT_TIMESTAMP))
       ), 0)
     )::int AS c`,
    [mlUid, bid, zone]
  );
  const n = rows[0] && rows[0].c != null ? Number(rows[0].c) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function insertMlRetiroBroadcastLog(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const oid = row.order_id != null ? Number(row.order_id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return null;
  const oc = row.outcome != null ? String(row.outcome).trim().toLowerCase() : "";
  if (oc !== "success" && oc !== "api_error") return null;
  const sl = row.slot != null ? String(row.slot).trim().toLowerCase() : "";
  if (sl !== "morning" && sl !== "afternoon") return null;
  const createdAt = row.created_at != null ? String(row.created_at) : new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO ml_retiro_broadcast_log (
       created_at, ml_user_id, order_id, buyer_id, slot, outcome, template_index,
       http_status, request_path, response_body, error_message
     ) VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      createdAt,
      mlUid,
      oid,
      row.buyer_id != null ? Number(row.buyer_id) : null,
      sl,
      oc,
      row.template_index != null ? Number(row.template_index) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.request_path != null ? String(row.request_path).slice(0, 2000) : null,
      row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function upsertMlListing(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  const itemId = row.item_id != null ? String(row.item_id).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !itemId) {
    return null;
  }
  const now = new Date().toISOString();
  const fetchedAt = row.fetched_at != null ? String(row.fetched_at) : now;
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  const rawJson = row.raw_json != null ? String(row.raw_json) : "{}";
  const priceVal = row.price != null && String(row.price).trim() !== "" ? row.price : null;
  const { rows } = await pool.query(
    `INSERT INTO ml_listings (
       ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
       available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
       raw_json, search_json, http_status, sync_error, fetched_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (ml_user_id, item_id) DO UPDATE SET
       site_id = EXCLUDED.site_id,
       seller_id = EXCLUDED.seller_id,
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       price = EXCLUDED.price,
       currency_id = EXCLUDED.currency_id,
       available_quantity = EXCLUDED.available_quantity,
       sold_quantity = EXCLUDED.sold_quantity,
       category_id = EXCLUDED.category_id,
       listing_type = EXCLUDED.listing_type,
       permalink = EXCLUDED.permalink,
       thumbnail = EXCLUDED.thumbnail,
       raw_json = EXCLUDED.raw_json,
       search_json = EXCLUDED.search_json,
       http_status = EXCLUDED.http_status,
       sync_error = EXCLUDED.sync_error,
       fetched_at = EXCLUDED.fetched_at,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      mlUid,
      itemId,
      row.site_id != null ? String(row.site_id) : null,
      row.seller_id != null ? Number(row.seller_id) : null,
      row.status != null ? String(row.status) : null,
      row.title != null ? String(row.title) : null,
      priceVal != null ? priceVal : null,
      row.currency_id != null ? String(row.currency_id) : null,
      row.available_quantity != null ? Number(row.available_quantity) : null,
      row.sold_quantity != null ? Number(row.sold_quantity) : null,
      row.category_id != null ? String(row.category_id) : null,
      row.listing_type != null ? String(row.listing_type) : null,
      row.permalink != null ? String(row.permalink) : null,
      row.thumbnail != null ? String(row.thumbnail) : null,
      rawJson,
      row.search_json != null ? String(row.search_json) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.sync_error != null ? String(row.sync_error).slice(0, 4000) : null,
      fetchedAt,
      updatedAt,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function listMlListingsByUser(mlUserId, limit, maxAllowed, options = {}) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return [];
  const cap = maxAllowed != null ? maxAllowed : 5000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  const sql = st
    ? `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings WHERE ml_user_id = $1
         AND LOWER(TRIM(COALESCE(status, ''))) = LOWER($3)
       ORDER BY updated_at DESC LIMIT $2`
    : `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings WHERE ml_user_id = $1 ORDER BY updated_at DESC LIMIT $2`;
  const params = st ? [mlUid, n, st] : [mlUid, n];
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getMlListingByItemId(mlUserId, itemId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const iid = itemId != null ? String(itemId).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !iid) return null;
  const { rows } = await pool.query(
    `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
            available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
            raw_json, search_json, http_status, sync_error, fetched_at, updated_at
     FROM ml_listings WHERE ml_user_id = $1 AND item_id = $2`,
    [mlUid, iid]
  );
  return rows[0] || null;
}

async function upsertMlListingSyncState(row) {
  await ensureSchema();
  const mlUid = Number(row.ml_user_id);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const now = new Date().toISOString();
  const updatedAt = row.updated_at != null ? String(row.updated_at) : now;
  await pool.query(
    `INSERT INTO ml_listing_sync_state (
       ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (ml_user_id) DO UPDATE SET
       last_scroll_id = EXCLUDED.last_scroll_id,
       last_offset = EXCLUDED.last_offset,
       last_batch_total = EXCLUDED.last_batch_total,
       last_sync_at = EXCLUDED.last_sync_at,
       last_sync_status = EXCLUDED.last_sync_status,
       last_error = EXCLUDED.last_error,
       updated_at = EXCLUDED.updated_at`,
    [
      mlUid,
      row.last_scroll_id != null ? String(row.last_scroll_id) : null,
      row.last_offset != null ? Number(row.last_offset) : null,
      row.last_batch_total != null ? Number(row.last_batch_total) : null,
      row.last_sync_at != null ? String(row.last_sync_at) : null,
      row.last_sync_status != null ? String(row.last_sync_status) : null,
      row.last_error != null ? String(row.last_error).slice(0, 4000) : null,
      updatedAt,
    ]
  );
  return mlUid;
}

async function getMlListingSyncState(mlUserId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) return null;
  const { rows } = await pool.query(
    `SELECT ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
     FROM ml_listing_sync_state WHERE ml_user_id = $1`,
    [mlUid]
  );
  return rows[0] || null;
}

/** Listado global ordenado por cuenta (ml_user_id) y luego por updated_at. */
async function listMlListingsAll(limit, maxAllowed, options = {}) {
  await ensureSchema();
  const cap = maxAllowed != null ? maxAllowed : 10000;
  const n = Math.min(Math.max(Number(limit) || 500, 1), cap);
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  const sql = st
    ? `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings
       WHERE LOWER(TRIM(COALESCE(status, ''))) = LOWER($2)
       ORDER BY ml_user_id ASC, updated_at DESC LIMIT $1`
    : `SELECT id, ml_user_id, item_id, site_id, seller_id, status, title, price, currency_id,
              available_quantity, sold_quantity, category_id, listing_type, permalink, thumbnail,
              raw_json, search_json, http_status, sync_error, fetched_at, updated_at
       FROM ml_listings ORDER BY ml_user_id ASC, updated_at DESC LIMIT $1`;
  const params = st ? [n, st] : [n];
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function listMlListingSyncStatesAll() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, last_scroll_id, last_offset, last_batch_total, last_sync_at, last_sync_status, last_error, updated_at
     FROM ml_listing_sync_state ORDER BY ml_user_id ASC`
  );
  return rows;
}

/** Conteos por cuenta para resúmenes en UI. */
async function listMlListingCountsByUser() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT ml_user_id, COUNT(*)::int AS total FROM ml_listings GROUP BY ml_user_id ORDER BY ml_user_id ASC`
  );
  return rows;
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

/** Configuración editable de mensajes WhatsApp tipo E (una fila id=1). */
async function getMlWhatsappTipoEConfig() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, image_url, image_caption, delay_ms, location_lat, location_lng,
            location_name, location_address, location_maps_url, location_chat_text, updated_at
     FROM ml_whatsapp_tipo_e_config WHERE id = 1`
  );
  return rows[0] || null;
}

async function upsertMlWhatsappTipoEConfig(row) {
  await ensureSchema();
  const imageUrl = row.image_url != null && String(row.image_url).trim() !== "" ? String(row.image_url).trim() : null;
  const imageCaption = row.image_caption != null ? String(row.image_caption) : null;
  let delayMs = null;
  if (row.delay_ms != null && String(row.delay_ms).trim() !== "") {
    const n = Number(row.delay_ms);
    if (Number.isFinite(n)) delayMs = Math.min(60000, Math.max(0, Math.floor(n)));
  }
  let lat = null;
  if (row.location_lat != null && String(row.location_lat).trim() !== "") {
    const n = Number(row.location_lat);
    if (Number.isFinite(n)) lat = n;
  }
  let lng = null;
  if (row.location_lng != null && String(row.location_lng).trim() !== "") {
    const n = Number(row.location_lng);
    if (Number.isFinite(n)) lng = n;
  }
  const locationName =
    row.location_name != null && String(row.location_name).trim() !== ""
      ? String(row.location_name).trim()
      : null;
  const locationAddress =
    row.location_address != null && String(row.location_address).trim() !== ""
      ? String(row.location_address).trim()
      : null;
  const locationMapsUrl =
    row.location_maps_url != null && String(row.location_maps_url).trim() !== ""
      ? String(row.location_maps_url).trim()
      : null;
  const locationChatText = row.location_chat_text != null ? String(row.location_chat_text) : null;

  await pool.query(
    `INSERT INTO ml_whatsapp_tipo_e_config (
       id, image_url, image_caption, delay_ms, location_lat, location_lng,
       location_name, location_address, location_maps_url, location_chat_text, updated_at
     )
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO UPDATE SET
       image_url = EXCLUDED.image_url,
       image_caption = EXCLUDED.image_caption,
       delay_ms = EXCLUDED.delay_ms,
       location_lat = EXCLUDED.location_lat,
       location_lng = EXCLUDED.location_lng,
       location_name = EXCLUDED.location_name,
       location_address = EXCLUDED.location_address,
       location_maps_url = EXCLUDED.location_maps_url,
       location_chat_text = EXCLUDED.location_chat_text,
       updated_at = NOW()`,
    [
      imageUrl,
      imageCaption,
      delayMs,
      lat,
      lng,
      locationName,
      locationAddress,
      locationMapsUrl,
      locationChatText,
    ]
  );
}

/** Envíos WhatsApp tipo E con `outcome = success` por orden (máx. 2: paso 1 imagen, paso 2 ubicación). */
async function countMlWhatsappTipoESuccessForOrder(mlUserId, orderId) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const oid = orderId != null ? Number(orderId) : NaN;
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM ml_whatsapp_wasender_log
     WHERE message_kind = 'E' AND ml_user_id = $1 AND order_id = $2 AND outcome = 'success'`,
    [mlUid, oid]
  );
  return rows[0] ? Number(rows[0].c) : 0;
}

/**
 * Cuántas órdenes distintas tienen ya **par completo** (≥2 envíos tipo E exitosos) al mismo **destino**
 * (`phone_e164`) desde `since` (ISO). No usa buyer_id: si el cliente cambia de celular y el nuevo E.164
 * es distinto, el conteo del número anterior no aplica.
 */
async function countMlWhatsappTipoECompletedPairsForPhoneSince(mlUserId, phoneE164, sinceIso) {
  await ensureSchema();
  const mlUid = Number(mlUserId);
  const phone = phoneE164 != null ? String(phoneE164).trim() : "";
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !phone || phone === "—") return 0;
  const since =
    sinceIso != null && String(sinceIso).trim() !== "" ? String(sinceIso).trim() : new Date(0).toISOString();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM (
       SELECT order_id
       FROM ml_whatsapp_wasender_log
       WHERE message_kind = 'E'
         AND outcome = 'success'
         AND ml_user_id = $1
         AND phone_e164 = $2
         AND created_at >= $3::timestamptz
         AND order_id IS NOT NULL
       GROUP BY order_id
       HAVING COUNT(*) >= 2
     ) sub`,
    [mlUid, phone, since]
  );
  return rows[0] ? Number(rows[0].c) : 0;
}

async function getMlWasenderSettings() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, api_base_url, default_phone_country_code, is_enabled, updated_at FROM ml_wasender_settings WHERE id = 1`
  );
  return rows[0] || null;
}

async function upsertMlWasenderSettings(row) {
  await ensureSchema();
  const url =
    row.api_base_url != null && String(row.api_base_url).trim() !== ""
      ? String(row.api_base_url).trim()
      : "https://www.wasenderapi.com";
  let cc =
    row.default_phone_country_code != null ? String(row.default_phone_country_code).replace(/\D/g, "") : "58";
  if (!cc) cc = "58";
  const en = row.is_enabled === true || row.is_enabled === 1 || row.is_enabled === "1";
  await pool.query(
    `INSERT INTO ml_wasender_settings (id, api_base_url, default_phone_country_code, is_enabled, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       api_base_url = EXCLUDED.api_base_url,
       default_phone_country_code = EXCLUDED.default_phone_country_code,
       is_enabled = EXCLUDED.is_enabled,
       updated_at = NOW()`,
    [url, cc, en]
  );
}

/**
 * @param {object} row
 * @param {'E'|'F'} row.message_kind
 * @param {string} row.outcome — success | api_error | skipped
 */
async function insertMlWhatsappWasenderLog(row) {
  await ensureSchema();
  const mk = row.message_kind != null ? String(row.message_kind).toUpperCase() : "";
  if (mk !== "E" && mk !== "F") return null;
  let bid = row.buyer_id != null ? Number(row.buyer_id) : null;
  if (bid != null && (!Number.isFinite(bid) || bid <= 0)) bid = null;
  const stepRaw = row.tipo_e_step != null ? Number(row.tipo_e_step) : null;
  const tipoEStep =
    stepRaw === 1 || stepRaw === 2 ? stepRaw : null;
  const { rows } = await pool.query(
    `INSERT INTO ml_whatsapp_wasender_log (
       message_kind, ml_user_id, buyer_id, order_id, ml_question_id,
       phone_e164, phone_source, outcome, skip_reason, http_status,
       wasender_msg_id, response_body, error_message, text_preview, tipo_e_step
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      mk,
      row.ml_user_id != null ? Number(row.ml_user_id) : null,
      bid,
      row.order_id != null ? Number(row.order_id) : null,
      row.ml_question_id != null ? Number(row.ml_question_id) : null,
      String(row.phone_e164 || "").slice(0, 32),
      row.phone_source != null ? String(row.phone_source) : null,
      String(row.outcome || "unknown").slice(0, 64),
      row.skip_reason != null ? String(row.skip_reason).slice(0, 500) : null,
      row.http_status != null ? Number(row.http_status) : null,
      row.wasender_msg_id != null ? Number(row.wasender_msg_id) : null,
      row.response_body != null ? String(row.response_body).slice(0, 8000) : null,
      row.error_message != null ? String(row.error_message).slice(0, 4000) : null,
      row.text_preview != null ? String(row.text_preview).slice(0, 2000) : null,
      tipoEStep,
    ]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function listMlWhatsappWasenderLog(limit, options = {}) {
  await ensureSchema();
  const cap = options.maxAllowed != null ? Number(options.maxAllowed) : 2000;
  const n = Math.min(Math.max(Number(limit) || 100, 1), Number.isFinite(cap) && cap > 0 ? cap : 2000);
  const kind = options.message_kind != null ? String(options.message_kind).toUpperCase() : "";
  if (kind === "E" || kind === "F") {
    const { rows } = await pool.query(
      `SELECT id, created_at, message_kind, ml_user_id, buyer_id, order_id, ml_question_id,
              phone_e164, phone_source, outcome, skip_reason, http_status,
              wasender_msg_id, response_body, error_message, text_preview, tipo_e_step
       FROM ml_whatsapp_wasender_log WHERE message_kind = $1 ORDER BY id DESC LIMIT $2`,
      [kind, n]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, created_at, message_kind, ml_user_id, buyer_id, order_id, ml_question_id,
            phone_e164, phone_source, outcome, skip_reason, http_status,
            wasender_msg_id, response_body, error_message, text_preview, tipo_e_step
     FROM ml_whatsapp_wasender_log ORDER BY id DESC LIMIT $1`,
    [n]
  );
  return rows;
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
  tryClaimPostSaleStepForSend,
  releasePostSaleStepClaim,
  hasPostSaleSuccessForStepToday,
  markPostSaleSent,
  deletePostSaleSent,
  insertPostSaleAutoSendLog,
  insertMlMessageKindSendLog,
  listMlMessageKindSendLog,
  listPostSaleAutoSendLog,
  insertMlVentasDetalleWeb,
  listMlVentasDetalleWeb,
  deleteAllMlVentasDetalleWeb,
  getMlWasenderSettings,
  upsertMlWasenderSettings,
  countMlWhatsappTipoESuccessForOrder,
  countMlWhatsappTipoECompletedPairsForPhoneSince,
  getMlWhatsappTipoEConfig,
  upsertMlWhatsappTipoEConfig,
  insertMlWhatsappWasenderLog,
  listMlWhatsappWasenderLog,
  upsertMlQuestionPending,
  getMlQuestionPendingByQuestionId,
  deleteMlQuestionPending,
  deleteAllMlQuestionsPending,
  getMlQuestionContextForWhatsapp,
  upsertMlQuestionAnswered,
  listMlQuestionsPending,
  hasMlQuestionsPending,
  getMlQuestionsIaAutoSentIdSet,
  listMlQuestionsAnswered,
  wasMlQuestionsIaAutoSent,
  insertMlQuestionsIaAutoSent,
  insertMlQuestionsIaAutoLog,
  listMlQuestionsIaAutoLog,
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
  getMlOrderByUserAndOrderId,
  listMlOrdersByUser,
  listMlOrdersAll,
  updateMlOrderFeedbackSummary,
  listMlOrderCountsByUserStatus,
  listMlOrderCountsByUser,
  upsertMlOrderPackMessage,
  listMlOrderPackMessagesByOrder,
  listMlOrderPackMessagesByUser,
  listMlOrderPackMessageCountsByUser,
  countMlOrderPackMessagesTotal,
  countMlOrderPackMessagesForMlUser,
  countMlOrderPackMessagesForOrder,
  upsertMlOrderFeedback,
  listMlOrderFeedbackByOrder,
  listMlOrderFeedbackByUser,
  wasMlRatingRequestSent,
  insertMlRatingRequestSent,
  wasRatingRequestSentToBuyerToday,
  listMlOrdersEligibleForRatingRequest,
  insertMlRatingRequestLog,
  listMlRatingRequestLog,
  listMlOrdersEligibleForRetiroBroadcast,
  wasRetiroBroadcastSentToBuyerTodaySlot,
  insertMlRetiroBroadcastSent,
  insertMlRetiroBroadcastLog,
  countMlAutoMessagesForBuyerToday,
  /** Cierra el pool (tests). */
  _poolEnd: () => pool.end(),
};
