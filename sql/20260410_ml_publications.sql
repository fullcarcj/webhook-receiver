-- ============================================================
-- Módulo ML Publications: gestión + pausas automáticas/manuales
-- ============================================================

CREATE TABLE IF NOT EXISTS ml_publications (
  id                 BIGSERIAL PRIMARY KEY,
  product_id         BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                TEXT NOT NULL,
  ml_item_id         TEXT NOT NULL UNIQUE,
  ml_title           TEXT,
  ml_status          TEXT NOT NULL DEFAULT 'active'
    CHECK (ml_status IN ('active','paused','closed','under_review')),
  local_status       TEXT NOT NULL DEFAULT 'active'
    CHECK (local_status IN ('active','paused','pending_pause','pending_activate')),
  stock_qty          NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_bs           NUMERIC(14,2),
  price_usd          NUMERIC(10,4),
  auto_pause_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_pub_product
  ON ml_publications(product_id);
CREATE INDEX IF NOT EXISTS idx_ml_pub_item
  ON ml_publications(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_ml_pub_status
  ON ml_publications(ml_status, local_status);
CREATE INDEX IF NOT EXISTS idx_ml_pub_stock_zero
  ON ml_publications(stock_qty, auto_pause_enabled)
  WHERE stock_qty = 0 AND auto_pause_enabled = TRUE;

CREATE TABLE IF NOT EXISTS ml_paused_publications (
  id                 BIGSERIAL PRIMARY KEY,
  ml_publication_id  BIGINT NOT NULL REFERENCES ml_publications(id),
  ml_item_id         TEXT NOT NULL,
  sku                TEXT NOT NULL,
  pause_type         TEXT NOT NULL
    CHECK (pause_type IN ('auto','manual')),
  pause_reason       TEXT NOT NULL,
  paused_by          TEXT NOT NULL DEFAULT 'system',
  approved_by        TEXT,
  stock_at_pause     NUMERIC(10,2),
  paused_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reactivated_at     TIMESTAMPTZ,
  reactivated_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_paused_pub
  ON ml_paused_publications(ml_publication_id, paused_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_paused_active
  ON ml_paused_publications(ml_item_id)
  WHERE reactivated_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_paused_active_per_pub
  ON ml_paused_publications(ml_publication_id)
  WHERE reactivated_at IS NULL;

CREATE TABLE IF NOT EXISTS ml_pending_actions (
  id                 BIGSERIAL PRIMARY KEY,
  ml_publication_id  BIGINT NOT NULL REFERENCES ml_publications(id),
  ml_item_id         TEXT NOT NULL,
  sku                TEXT NOT NULL,
  action_type        TEXT NOT NULL
    CHECK (action_type IN ('pause','activate','price_update','close')),
  reason             TEXT NOT NULL,
  requested_by       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','executed','expired')),
  approved_by        TEXT,
  rejection_reason   TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at        TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_ml_pending_status
  ON ml_pending_actions(status, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ml_api_log (
  id             BIGSERIAL PRIMARY KEY,
  ml_item_id     TEXT,
  action         TEXT NOT NULL,
  request_body   JSONB,
  response_code  INT,
  response_body  JSONB,
  success        BOOLEAN NOT NULL DEFAULT FALSE,
  error_message  TEXT,
  executed_by    TEXT DEFAULT 'system',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_log_item
  ON ml_api_log(ml_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_log_errors
  ON ml_api_log(success, created_at DESC)
  WHERE success = FALSE;

CREATE OR REPLACE FUNCTION touch_ml_pub_updated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ml_pub_updated ON ml_publications;
CREATE TRIGGER trg_ml_pub_updated
  BEFORE UPDATE ON ml_publications
  FOR EACH ROW EXECUTE FUNCTION touch_ml_pub_updated();

-- DECISION: en este repositorio ml_item_id vive en `productos.item_id_ml`.
--           La tabla `products` mantiene referencia por `source='productos'` + `source_id`.
-- Seed recomendado:
-- INSERT INTO ml_publications (product_id, sku, ml_item_id, stock_qty)
-- SELECT p.id, p.sku, pr.item_id_ml, COALESCE(i.stock_qty, 0)
-- FROM products p
-- JOIN productos pr
--   ON p.source = 'productos'
--  AND p.source_id = pr.id
-- JOIN inventory i
--   ON i.product_id = p.id
-- WHERE COALESCE(TRIM(pr.item_id_ml), '') <> ''
-- ON CONFLICT (ml_item_id) DO NOTHING;
