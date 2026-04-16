-- Compras POS: vincular purchases a suppliers + permisos compras (ALMACENISTA write, SUPERVISOR read).
-- Requiere: public.purchases, public.suppliers, public.role_permissions (users.sql + roles 8 niveles).
-- Ejecutar: npm run db:purchases-supplier

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) purchases.supplier_id (FK opcional)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchases_supplier
  ON purchases(supplier_id)
  WHERE supplier_id IS NOT NULL;

COMMENT ON COLUMN purchases.supplier_id IS 'Proveedor de la compra (directorio suppliers); opcional.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Nombre de proveedor único (POST duplicado → 409)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name
  ON suppliers (lower(trim(name)));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Permisos compras (idempotente)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role, module, action) VALUES
  ('ALMACENISTA','compras','write'),
  ('SUPERVISOR','compras','read')
ON CONFLICT DO NOTHING;
