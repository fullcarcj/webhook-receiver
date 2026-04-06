# Migraciones pendientes — shipping + landed cost

## Orden de ejecución en Render (o psql local)

Ejecutar EN ESTE ORDEN antes de activar las rutas /api/shipping y /api/landed-cost:
```bash
# 1. Módulo de tasas de cambio (si no se ejecutó antes)
psql $DATABASE_URL -f sql/currency-management.sql

# 2. Módulo de costos de importación
psql $DATABASE_URL -f sql/landed-cost.sql

# 3. Módulo de proveedores y categorías de envío
psql $DATABASE_URL -f sql/shipping-providers.sql
```

## Variables de entorno requeridas (ya deben existir)
- DATABASE_URL
- ADMIN_SECRET
- CRON_SECRET (para el job de tasas)

## Verificación post-migración
```sql
-- Confirmar tablas creadas
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'shipping_providers','shipping_categories','shipping_rate_history',
    'import_shipments','import_shipment_lines','import_expenses',
    'daily_exchange_rates','landed_cost_audit'
  )
ORDER BY table_name;
-- Esperado: 8 filas

-- Confirmar triggers activos
SELECT trigger_name FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
    'trg_archive_shipping_rate','trg_seed_shipping_rate',
    'trg_providers_updated_at','trg_categories_updated_at',
    'trg_der_updated_at','trg_shipments_updated_at'
  );
-- Esperado: 6 filas

-- Confirmar columnas nuevas en productos
SELECT column_name FROM information_schema.columns
WHERE table_name = 'productos'
  AND column_name IN ('shipping_category_id','volume_cbm','landed_cost_usd');
-- Esperado: 3 filas
```
