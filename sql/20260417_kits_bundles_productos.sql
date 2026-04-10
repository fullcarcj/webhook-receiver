-- Kits y bundles sobre catálogo real `productos` (ventas / WMS).
-- Ejecutar: npm run db:kits-bundles
-- DECISIÓN: no usar tabla `products`+`inventory` del skeleton; el POS usa `productos.stock`.

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS is_kit BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS kit_components_count INT DEFAULT 0;

CREATE TABLE IF NOT EXISTS product_bundles (
  id                     BIGSERIAL PRIMARY KEY,
  parent_product_id      BIGINT NOT NULL REFERENCES productos (id) ON DELETE CASCADE,
  component_product_id   BIGINT NOT NULL REFERENCES productos (id) ON DELETE RESTRICT,
  quantity               NUMERIC(10, 2) NOT NULL DEFAULT 1,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Si la tabla ya existía (CREATE IF NOT EXISTS no altera columnas), añadir las que falten.
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS quantity NUMERIC(10, 2) NOT NULL DEFAULT 1;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Unicidad idempotente (evita ADD CONSTRAINT duplicado en re-ejecuciones).
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_bundles_parent_component
  ON product_bundles (parent_product_id, component_product_id);

DROP INDEX IF EXISTS idx_product_bundles_parent;
CREATE INDEX idx_product_bundles_parent
  ON product_bundles (parent_product_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_product_bundles_component
  ON product_bundles (component_product_id);

CREATE TABLE IF NOT EXISTS bundle_component_alternatives (
  id                       BIGSERIAL PRIMARY KEY,
  bundle_id                BIGINT NOT NULL REFERENCES product_bundles (id) ON DELETE CASCADE,
  alternative_product_id   BIGINT NOT NULL REFERENCES productos (id) ON DELETE CASCADE,
  brand_name               TEXT,
  is_preferred             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bundle_alt
  ON bundle_component_alternatives (bundle_id, alternative_product_id);

CREATE INDEX IF NOT EXISTS idx_bundle_alt_bundle ON bundle_component_alternatives (bundle_id);

CREATE TABLE IF NOT EXISTS price_review_queue (
  id                   BIGSERIAL PRIMARY KEY,
  product_id           BIGINT NOT NULL REFERENCES productos (id) ON DELETE CASCADE,
  sku                  TEXT NOT NULL,
  product_name         TEXT NOT NULL,
  review_type          TEXT NOT NULL
    CHECK (review_type IN ('component_pricing', 'high_rotation')),
  current_price_usd    NUMERIC(10, 4),
  suggested_price_usd  NUMERIC(10, 4),
  suggestion_basis     TEXT,
  rotation_count       INT,
  rotation_threshold   INT,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed', 'dismissed', 'applied')),
  reviewed_by          TEXT,
  review_notes         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_price_review_pending
  ON price_review_queue (status, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_price_review_product
  ON price_review_queue (product_id, review_type);

INSERT INTO dynamic_prices_settings (setting_key, setting_value, description, category)
VALUES (
  'ROTATION_ALERT_THRESHOLD',
  5,
  'Ventas en 30 días para disparar alerta de revisión de precio',
  'threshold'
)
ON CONFLICT (setting_key) DO NOTHING;

-- Seed: marcar kits por descripción (excluir semi-kit)
UPDATE productos
SET is_kit = TRUE
WHERE (
  descripcion ILIKE '%kit%'
  OR descripcion ILIKE '%combo%'
)
AND descripcion NOT ILIKE '%semi kit%'
AND descripcion NOT ILIKE '%semikit%'
AND is_kit = FALSE;

UPDATE productos p
SET kit_components_count = sub.c
FROM (
  SELECT parent_product_id, COUNT(*)::INT AS c
  FROM product_bundles
  WHERE is_active = TRUE
  GROUP BY parent_product_id
) sub
WHERE p.id = sub.parent_product_id;

COMMENT ON TABLE product_bundles IS 'Componentes de kit: parent = SKU kit en productos; quantity = unidades de componente por 1 kit.';
COMMENT ON TABLE price_review_queue IS 'Supervisor: revisión de precios; purgar registros viejos si hace falta.';
