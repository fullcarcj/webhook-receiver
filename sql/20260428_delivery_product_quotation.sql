-- ============================================================
-- Delivery como línea de cotización
-- Ejecutar: npm run db:delivery-product
-- Idempotente.
-- ============================================================

-- 1. Columna is_service en products (productos tipo servicio: no descuentan stock)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_service BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN products.is_service IS
  'TRUE para servicios (delivery, instalación, etc.): no requieren stock y no generan movimiento de inventario.';

-- 2. Producto canónico de delivery (SKU fijo)
INSERT INTO products (sku, name, description, is_service, is_active, source)
VALUES (
  'SVC-DELIVERY',
  'Servicio de Delivery',
  'Carrera de motorizado / envío al cliente. Se agrega como línea en la cotización para que el total cotizado coincida con el pago del cliente.',
  TRUE,
  TRUE,
  'manual'
)
ON CONFLICT (sku) DO UPDATE
  SET is_service   = TRUE,
      is_active    = TRUE,
      name         = EXCLUDED.name,
      description  = EXCLUDED.description,
      updated_at   = NOW();

-- 3. Fila de inventario simbólica (stock alto para no bloquear validaciones legacy que no revisan is_service)
INSERT INTO inventory (product_id, stock_qty)
SELECT id, 99999
FROM products
WHERE sku = 'SVC-DELIVERY'
ON CONFLICT (product_id) DO NOTHING;

-- 4. Columnas de delivery en la cabecera de cotización
--    delivery_zone_id  → zona seleccionada al agregar delivery (FK a delivery_zones)
--    delivery_line_bs  → precio en Bs al cliente (para usarlo al crear la orden ERP sin recalcular)
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS delivery_zone_id BIGINT REFERENCES delivery_zones(id),
  ADD COLUMN IF NOT EXISTS delivery_line_bs NUMERIC(10,2);

COMMENT ON COLUMN inventario_presupuesto.delivery_zone_id IS
  'Zona de delivery elegida al agregar la línea SVC-DELIVERY a la cotización.';
COMMENT ON COLUMN inventario_presupuesto.delivery_line_bs IS
  'Monto en Bs del envío al cliente (snapshot al momento de agregar el delivery a la cotización).';

CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_delivery_zone
  ON inventario_presupuesto (delivery_zone_id)
  WHERE delivery_zone_id IS NOT NULL;
