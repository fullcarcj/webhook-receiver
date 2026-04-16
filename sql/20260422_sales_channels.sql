-- Ferrari ERP — Modelo omnicanal 5 canales
-- Requiere: 20260408_sales_orders.sql, users.sql
-- Idempotente. Ejecutar: npm run db:sales-channels
--
-- ESTRATEGIA DE MIGRACIÓN:
--   1. Crea catálogo sales_channels
--   2. ADD COLUMN channel_id (nullable primero)
--   3. Backfill channel_id desde source existente
--   4. Agrega columnas de estado por dominio (payment / fulfillment / approval)
--   5. NOT NULL + FK después del backfill
--   6. NO elimina source — permanece para compatibilidad con código legacy

-- ─────────────────────────────────────────────────────────────────────
-- 1. Catálogo de canales (fuente de verdad de los 5 canales)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_channels (
  id              SMALLINT    PRIMARY KEY,
  code            TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  -- ¿Requiere cliente registrado para crear orden?
  requires_customer      BOOLEAN NOT NULL DEFAULT TRUE,
  -- ¿Pago diferido posible? (FALSE = cobro inmediato en caja)
  allows_deferred_payment BOOLEAN NOT NULL DEFAULT FALSE,
  -- ¿Genera comprobante fiscal automático post-pago?
  auto_invoice    BOOLEAN NOT NULL DEFAULT FALSE,
  -- ¿Requiere fulfillment explícito (envío/entrega)?
  requires_fulfillment  BOOLEAN NOT NULL DEFAULT FALSE,
  -- ¿Requiere seller_id en la orden?
  requires_seller BOOLEAN NOT NULL DEFAULT FALSE,
  -- ¿Órdenes grandes requieren aprobación de supervisor?
  approval_threshold_usd NUMERIC(12,2),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_sales_channels_code UNIQUE (code)
);

-- Seed de los 5 canales exactos del negocio
INSERT INTO sales_channels
  (id, code, name, requires_customer, allows_deferred_payment,
   auto_invoice, requires_fulfillment, requires_seller, approval_threshold_usd)
VALUES
  (1, 'MOSTRADOR',      'Mostrador / POS',           FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  (2, 'WHATSAPP_REDES', 'WhatsApp / Redes Sociales', TRUE,  TRUE,  FALSE, TRUE,  FALSE, NULL),
  (3, 'MERCADOLIBRE',   'MercadoLibre',              TRUE,  TRUE,  TRUE,  TRUE,  FALSE, NULL),
  (4, 'ECOMMERCE',      'E-Commerce Propio',         TRUE,  FALSE, TRUE,  TRUE,  FALSE, NULL),
  (5, 'FUERZA_VENTAS',  'Fuerza de Ventas',          TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  500.00)
ON CONFLICT (id) DO UPDATE
  SET name                    = EXCLUDED.name,
      requires_customer       = EXCLUDED.requires_customer,
      allows_deferred_payment = EXCLUDED.allows_deferred_payment,
      auto_invoice            = EXCLUDED.auto_invoice,
      requires_fulfillment    = EXCLUDED.requires_fulfillment,
      requires_seller         = EXCLUDED.requires_seller,
      approval_threshold_usd  = EXCLUDED.approval_threshold_usd;

-- ─────────────────────────────────────────────────────────────────────
-- 2. ENUMs de estado por dominio
--    (no mezclar payment + fulfillment en una sola columna status)
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE payment_status_enum AS ENUM (
    'not_required',  -- CH-01 mostrador: cobrado en caja, no se trackea aquí
    'pending',       -- CH-02/05: esperando transferencia / efectivo
    'approved',      -- CH-03/04: confirmado por MercadoPago / pasarela
    'rejected',      -- Pago rechazado por pasarela
    'refunded',      -- Devuelto al cliente
    'waived'         -- Condonado (crédito CH-05)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fulfillment_status_enum AS ENUM (
    'not_required',  -- CH-01: cliente retira en el acto
    'pending',       -- Orden confirmada, sin preparar
    'preparing',     -- En picking/empaque
    'ready',         -- Listo para despacho o retiro
    'shipped',       -- En tránsito
    'delivered',     -- Entregado y confirmado
    'failed',        -- Intento fallido (dirección incorrecta, etc.)
    'cancelled'      -- Fulfillment cancelado
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_status_enum AS ENUM (
    'not_required',  -- Orden debajo del umbral o canal sin aprobación
    'pending',       -- Esperando supervisor (CH-05 sobre umbral)
    'approved',      -- Aprobada por supervisor
    'rejected'       -- Rechazada por supervisor
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. ADD COLUMN a sales_orders (nullable primero para backfill seguro)
-- ─────────────────────────────────────────────────────────────────────

-- Canal
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS channel_id SMALLINT REFERENCES sales_channels(id) ON DELETE RESTRICT;

-- Estados por dominio
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS payment_status     payment_status_enum     NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS fulfillment_status fulfillment_status_enum NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approval_status    approval_status_enum    NOT NULL DEFAULT 'not_required';

-- Fuerza de ventas (CH-05)
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS seller_id     INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_by   INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ;

-- Deduplicación CH-02: validar telefono + sku + ventana de tiempo en aplicación
-- El índice parcial ayuda a detectar duplicados recientes
CREATE INDEX IF NOT EXISTS idx_so_channel_customer_created
  ON sales_orders (channel_id, customer_id, created_at DESC)
  WHERE channel_id = 2;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Backfill channel_id desde source existente
-- ─────────────────────────────────────────────────────────────────────
UPDATE sales_orders SET channel_id = 1 WHERE channel_id IS NULL AND source = 'mostrador';
UPDATE sales_orders SET channel_id = 2 WHERE channel_id IS NULL AND source = 'social_media';
UPDATE sales_orders SET channel_id = 3 WHERE channel_id IS NULL AND source = 'mercadolibre';
UPDATE sales_orders SET channel_id = 4 WHERE channel_id IS NULL AND source = 'ecommerce';
-- fuerza_ventas: no hay filas históricas — channel_id quedará NULL en nuevas solo si
-- se inserta con source='fuerza_ventas' sin channel_id → la app debe mandarlo

-- Backfill de payment_status y fulfillment_status basado en status legacy
UPDATE sales_orders SET
  payment_status     = 'not_required',
  fulfillment_status = 'not_required'
WHERE channel_id = 1  -- MOSTRADOR: cobro inmediato, sin fulfillment
  AND payment_status = 'pending';

UPDATE sales_orders SET
  payment_status = 'approved'
WHERE source = 'mercadolibre'
  AND status IN ('paid', 'completed')
  AND payment_status = 'pending';

UPDATE sales_orders SET
  fulfillment_status = 'delivered'
WHERE status = 'completed'
  AND fulfillment_status = 'pending';

-- ─────────────────────────────────────────────────────────────────────
-- 5. Ahora que hay datos, agregar NOT NULL en channel_id
--    SOLO si todas las filas tienen valor — si no, dejar nullable hasta
--    que el equipo limpie los NULL restantes manualmente.
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_nulls INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_nulls FROM sales_orders WHERE channel_id IS NULL;
  IF v_nulls = 0 THEN
    ALTER TABLE sales_orders ALTER COLUMN channel_id SET NOT NULL;
    RAISE NOTICE 'channel_id marcado NOT NULL (0 NULL encontrados)';
  ELSE
    RAISE WARNING 'channel_id tiene % filas NULL — revisar antes de imponer NOT NULL', v_nulls;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Extender CHECK de source para incluir fuerza_ventas
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_source_check;

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_source_check
    CHECK (source IN ('mercadolibre', 'mostrador', 'ecommerce', 'social_media', 'fuerza_ventas'));

-- ─────────────────────────────────────────────────────────────────────
-- 7. Índices de soporte para reportes por canal
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_so_channel_created
  ON sales_orders (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_so_channel_payment
  ON sales_orders (channel_id, payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_so_channel_fulfillment
  ON sales_orders (channel_id, fulfillment_status, created_at DESC);

-- CH-05: índice de comisiones por vendedor + período
CREATE INDEX IF NOT EXISTS idx_so_seller_created
  ON sales_orders (seller_id, created_at DESC)
  WHERE seller_id IS NOT NULL;

-- Aprobaciones pendientes CH-05
CREATE INDEX IF NOT EXISTS idx_so_approval_pending
  ON sales_orders (approval_status, created_at DESC)
  WHERE approval_status = 'pending';

-- ─────────────────────────────────────────────────────────────────────
-- 8. Vista de diagnóstico — verificar distribución por canal
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_orders_by_channel AS
SELECT
  sc.id                                              AS channel_id,
  sc.code                                            AS channel_code,
  sc.name                                            AS channel_name,
  COUNT(so.id)                                       AS total_orders,
  COUNT(so.id) FILTER (WHERE so.payment_status = 'pending')   AS payment_pending,
  COUNT(so.id) FILTER (WHERE so.fulfillment_status = 'pending') AS fulfillment_pending,
  COUNT(so.id) FILTER (WHERE so.approval_status   = 'pending') AS approval_pending,
  ROUND(AVG(so.order_total_amount), 2)               AS avg_order_usd,
  SUM(so.order_total_amount)                         AS total_revenue_usd
FROM sales_channels sc
LEFT JOIN sales_orders so ON so.channel_id = sc.id
GROUP BY sc.id, sc.code, sc.name
ORDER BY sc.id;

COMMENT ON VIEW v_orders_by_channel
  IS 'Dashboard de operaciones por canal — usa para monitoreo en tiempo real.';
