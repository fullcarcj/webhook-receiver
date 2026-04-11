-- Parche: lotes pasan de FK/flags en `productos` (legacy) a `products` (canónico).
-- Ejecutar UNA VEZ si aplicaste `lot-management.sql` cuando aún referenciaba productos(sku).
-- Requisitos: filas `products` para cada producto_sku presente en product_lots / lot_bin_stock
--   (p. ej. `node scripts/migrateInventory.js` o equivalente).
-- Idempotencia parcial: columnas ADD IF NOT EXISTS; DROP/ADD FK puede requerir estado limpio.

-- 1) Columnas y comentarios en products
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS requires_lot_tracking BOOLEAN
    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_shelf_life_days INTEGER;

COMMENT ON COLUMN products.requires_lot_tracking IS 'TRUE = juntas/sellos/filtros; FALSE = válvulas acero (default)';
COMMENT ON COLUMN products.default_shelf_life_days IS 'Vida útil estándar del SKU en días (opcional)';

-- 2) Copiar valores desde productos si existían allí
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'productos' AND column_name = 'requires_lot_tracking'
  ) THEN
    UPDATE products pr
    SET
      requires_lot_tracking = COALESCE(po.requires_lot_tracking, pr.requires_lot_tracking),
      default_shelf_life_days = COALESCE(po.default_shelf_life_days, pr.default_shelf_life_days)
    FROM productos po
    WHERE pr.sku = po.sku;
  END IF;
END$$;

-- 3) Quitar FKs antiguas (nombres por defecto de PostgreSQL)
ALTER TABLE product_lots DROP CONSTRAINT IF EXISTS product_lots_producto_sku_fkey;
ALTER TABLE lot_bin_stock DROP CONSTRAINT IF EXISTS lot_bin_stock_producto_sku_fkey;

-- 4) FKs hacia products
ALTER TABLE product_lots
  ADD CONSTRAINT product_lots_producto_sku_fkey
  FOREIGN KEY (producto_sku) REFERENCES products(sku);

ALTER TABLE lot_bin_stock
  ADD CONSTRAINT lot_bin_stock_producto_sku_fkey
  FOREIGN KEY (producto_sku) REFERENCES products(sku);

-- 5) Vistas (misma definición que sql/lot-management.sql actual)
CREATE OR REPLACE VIEW v_lots_fefo AS
SELECT
  lbs.producto_sku,
  COALESCE(NULLIF(TRIM(p.description), ''), p.sku) AS descripcion,
  l.lot_number,
  l.supplier_lot_number,
  l.expiration_date,
  l.manufacture_date,
  l.received_date,
  l.status        AS lot_status,
  wb.bin_code,
  wa.aisle_number,
  ws.shelf_number,
  wb.level,
  lbs.bin_id,
  lbs.lot_id,
  lbs.qty_available,
  lbs.qty_reserved,
  CASE
    WHEN l.expiration_date IS NULL THEN NULL
    ELSE l.expiration_date - CURRENT_DATE
  END AS days_until_expiry,
  CASE
    WHEN l.expiration_date IS NULL               THEN 'NO_EXPIRY'
    WHEN l.expiration_date < CURRENT_DATE        THEN 'EXPIRED'
    WHEN l.expiration_date <= CURRENT_DATE + 30  THEN 'CRITICAL'
    WHEN l.expiration_date <= CURRENT_DATE + 90  THEN 'WARNING'
    ELSE 'OK'
  END AS expiry_alert
FROM lot_bin_stock      lbs
JOIN product_lots       l   ON l.id  = lbs.lot_id
JOIN products           p   ON p.sku = lbs.producto_sku
JOIN warehouse_bins     wb  ON wb.id = lbs.bin_id
JOIN warehouse_shelves  ws  ON ws.id = wb.shelf_id
JOIN warehouse_aisles   wa  ON wa.id = ws.aisle_id
JOIN warehouses         w   ON w.id  = wa.warehouse_id
WHERE lbs.qty_available > 0
  AND l.status  = 'ACTIVE'::lot_status
  AND w.is_active = TRUE;

CREATE OR REPLACE VIEW v_expiry_alerts AS
SELECT
  l.id AS lot_id,
  l.producto_sku,
  COALESCE(NULLIF(TRIM(p.description), ''), p.sku) AS descripcion,
  l.lot_number,
  l.expiration_date,
  l.expiration_date - CURRENT_DATE AS days_remaining,
  COALESCE(SUM(lbs.qty_available), 0)::NUMERIC(18,4) AS qty_available,
  CASE
    WHEN l.expiration_date < CURRENT_DATE       THEN 'EXPIRED'
    WHEN l.expiration_date <= CURRENT_DATE + 30 THEN 'CRITICAL'
    WHEN l.expiration_date <= CURRENT_DATE + 90 THEN 'WARNING'
  END AS alert_level
FROM product_lots   l
JOIN products       p   ON p.sku = l.producto_sku
LEFT JOIN lot_bin_stock lbs ON lbs.lot_id = l.id
WHERE l.expiration_date IS NOT NULL
  AND l.expiration_date <= CURRENT_DATE + 90
  AND l.status IN ('ACTIVE'::lot_status,'EXPIRED'::lot_status)
GROUP BY l.id, l.producto_sku, p.description, p.sku, l.lot_number, l.expiration_date, l.status;
