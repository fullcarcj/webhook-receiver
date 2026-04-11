-- Ferrari ERP — ML Orders ERP (reserva automática + alertas de stock)
-- Prerrequisitos: db-postgres.js (ml_orders ya existe), sql/wms-bins.sql
-- Idempotente. Ejecutar con: npm run db:ml-orders
--
-- IMPORTANTE: ml_orders YA EXISTE con columnas legacy (ml_user_id, order_id, status…).
-- Este script solo AGREGA columnas ERP nuevas y crea las tablas auxiliares.
-- NO toca el esquema existente de ml_orders ni ml_order_feedback.

-- ─────────────────────────────────────────────────────
-- products: columna de acción por defecto ante sin stock
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ml_no_stock_action TEXT NOT NULL DEFAULT 'ALERT_ONLY';
-- 'ALERT_ONLY' → solo insertar ml_stock_alert (default)
-- 'CANCEL_ML'  → cancelar la orden en ML via API
-- 'BACKORDER'  → marcar erp_status = 'BACKORDER'

-- ─────────────────────────────────────────────────────
-- ml_orders: columnas ERP nuevas (no tocar legacy)
-- ─────────────────────────────────────────────────────
ALTER TABLE ml_orders
  ADD COLUMN IF NOT EXISTS erp_status TEXT NOT NULL DEFAULT 'PENDING',
  -- 'PENDING'            → recibida, sin procesar
  -- 'RESERVED'           → stock reservado exitosamente
  -- 'PARTIAL'            → algunos ítems reservados
  -- 'NO_STOCK'           → sin stock, alerta creada
  -- 'BACKORDER'          → pendiente de reposición
  -- 'CANCELLED_NO_STOCK' → cancelada en ML por sin stock
  -- 'DISPATCHED'         → despachado
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reservation_error TEXT,
  ADD COLUMN IF NOT EXISTS webhook_attempts INTEGER NOT NULL DEFAULT 0;

-- Índice para consultas ERP por estado
CREATE INDEX IF NOT EXISTS idx_ml_orders_erp_status
  ON ml_orders (erp_status, id DESC);

-- ─────────────────────────────────────────────────────
-- ml_item_sku_map — item_id de ML → SKU de Ferrari
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_item_sku_map (
  id              SERIAL      PRIMARY KEY,
  company_id      INTEGER     NOT NULL DEFAULT 1,
  ml_item_id      TEXT        NOT NULL,
  -- 'MLV123456789' — ID del ítem en MercadoLibre
  ml_variation_id BIGINT,
  -- NULL = aplica a todas las variaciones del ítem
  product_sku     TEXT        NOT NULL REFERENCES products(sku),
  no_stock_action TEXT,
  -- NULL = usar ml_no_stock_action de products
  -- 'ALERT_ONLY' | 'CANCEL_ML' | 'BACKORDER'
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ml_item_map
    UNIQUE (company_id, ml_item_id, ml_variation_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_map_item
  ON ml_item_sku_map (ml_item_id, ml_variation_id)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_ml_item_sku_map_updated_at ON ml_item_sku_map;
CREATE TRIGGER trg_ml_item_sku_map_updated_at
  BEFORE UPDATE ON ml_item_sku_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- ml_order_items — líneas por orden (seguimiento ERP)
--
-- Referencia a ml_orders via order_id (BIGINT, no FK
-- formal porque ml_orders usa PK BIGSERIAL id, no order_id).
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_order_items (
  id                    BIGSERIAL   PRIMARY KEY,
  order_id              BIGINT      NOT NULL,
  -- = ml_orders.order_id (el ID de ML)
  company_id            INTEGER     NOT NULL DEFAULT 1,

  ml_item_id            TEXT        NOT NULL,
  ml_variation_id       BIGINT,

  title                 TEXT,
  quantity              INTEGER     NOT NULL DEFAULT 1,
  unit_price            NUMERIC(15,4),
  currency_id           TEXT,

  -- Mapeo al catálogo Ferrari
  product_sku           TEXT        REFERENCES products(sku),
  -- NULL si no hay mapeo en ml_item_sku_map todavía

  -- Estado de la reserva de este ítem
  reservation_status    TEXT        NOT NULL DEFAULT 'PENDING',
  -- 'PENDING'    → esperando procesamiento
  -- 'RESERVED'   → stock reservado
  -- 'NO_STOCK'   → sin stock disponible
  -- 'PARTIAL'    → menos de qty disponibles
  -- 'NO_SKU_MAP' → ítem sin SKU mapeado
  -- 'BACKORDER'  → pendiente de reposición
  reserved_qty          INTEGER     NOT NULL DEFAULT 0,
  reserved_bin_id       INTEGER,
  -- FK suave a warehouse_bins(id) — sin constraint formal para no depender del WMS

  no_stock_action_taken TEXT,
  -- Qué acción se ejecutó: 'ALERT_ONLY' | 'CANCEL_ML' | 'BACKORDER'

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_ml_item_per_order
    UNIQUE (order_id, ml_item_id)
);

CREATE INDEX IF NOT EXISTS idx_mloi_order
  ON ml_order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_mloi_sku
  ON ml_order_items (product_sku)
  WHERE product_sku IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ml_order_items_updated_at ON ml_order_items;
CREATE TRIGGER trg_ml_order_items_updated_at
  BEFORE UPDATE ON ml_order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- ml_stock_alerts — alertas de stock insuficiente
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_stock_alerts (
  id               BIGSERIAL     PRIMARY KEY,
  company_id       INTEGER       NOT NULL DEFAULT 1,
  order_id         BIGINT        NOT NULL,
  -- = ml_orders.order_id
  ml_item_id       TEXT          NOT NULL,
  product_sku      TEXT,
  qty_ordered      INTEGER       NOT NULL,
  qty_available    NUMERIC(12,3) NOT NULL DEFAULT 0,
  alert_type       TEXT          NOT NULL DEFAULT 'NO_STOCK',
  -- 'NO_STOCK'   → 0 unidades disponibles
  -- 'PARTIAL'    → menos de qty_ordered disponibles
  -- 'NO_SKU_MAP' → ítem sin SKU mapeado
  action_taken     TEXT,
  -- Acción ejecutada: 'ALERT_ONLY' | 'CANCEL_ML' | 'BACKORDER'
  is_resolved      BOOLEAN       NOT NULL DEFAULT FALSE,
  resolved_at      TIMESTAMPTZ,
  resolved_by      INTEGER,
  resolution_notes TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_ml_alert_order_item
    UNIQUE (order_id, ml_item_id)
);

CREATE INDEX IF NOT EXISTS idx_msa_unresolved
  ON ml_stock_alerts (company_id, is_resolved, created_at DESC)
  WHERE is_resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_msa_order
  ON ml_stock_alerts (order_id);

-- ─────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'ml_item_sku_map', 'ml_order_items', 'ml_stock_alerts')
ORDER BY table_name;
-- Esperado: 3 filas

SELECT column_name FROM information_schema.columns
WHERE table_name = 'products'
  AND column_name = 'ml_no_stock_action';
-- Esperado: 1 fila

SELECT column_name FROM information_schema.columns
WHERE table_name = 'ml_orders'
  AND column_name IN ('erp_status', 'reserved_at',
    'reservation_error', 'webhook_attempts')
ORDER BY column_name;
-- Esperado: 4 filas
