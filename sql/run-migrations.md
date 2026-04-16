# Migraciones pendientes — shipping + landed cost

## Módulo Omnicanal (extensión crm_chats + sales_orders + tablas ML)

Ejecutar DESPUÉS de `db:sales-channels` y `db:business-config`:
```bash
# Extiende crm_chats con vínculos ML (ml_order_id, ml_buyer_id, source_type…)
# Agrega conversation_id + fulfillment_type a sales_orders
# Crea: ml_webhooks_logs (idempotencia CH-03), ml_sku_mapping, ml_sync_log, ml_alerts
npm run db:omnichannel
```

---

## Módulo Configuración de Negocio (companies, branches, currencies)

Ejecutar ANTES del resto si es instalación nueva o se agrega multi-empresa:
```bash
# 0. Configuración base del negocio (companies, branches, currencies, from/to_currency en daily_exchange_rates)
#    Requiere: currency-management.sql (set_updated_at y daily_exchange_rates deben existir)
npm run db:business-config
# Expone: GET/PUT /api/config/company, /api/config/branches, /api/config/currencies
#         GET /api/config/exchange-rates, /at/:date, /history
#         GET /api/config/tax-rules, /active  |  PUT /api/config/tax-rules
```

---

## Orden de ejecución en Render (o psql local)

Ejecutar EN ESTE ORDEN antes de activar las rutas /api/shipping y /api/landed-cost:
```bash
# 1. Módulo de tasas de cambio (si no se ejecutó antes)
psql $DATABASE_URL -f sql/currency-management.sql

# 1b. Vista precios Bs sobre `products` + tablas POS `sales`/`sale_lines`/`purchases` con snapshot de tasa
# psql $DATABASE_URL -f sql/exchange-rates.sql
# npm run db:exchange-rates

# 2. Módulo de costos de importación
psql $DATABASE_URL -f sql/landed-cost.sql

# 3. Módulo de proveedores y categorías de envío
psql $DATABASE_URL -f sql/shipping-providers.sql

# 4. WMS (ubicaciones y stock por bin)
psql $DATABASE_URL -f sql/wms-bins.sql

# 5. WMS — auditoría v2 (ENUM movement_reason, DELETE, deltas generados)
psql $DATABASE_URL -f sql/wms-audit-v2.sql

# 6. Reservas de stock por órdenes ML (tabla ml_order_reservations)
psql $DATABASE_URL -f sql/ml-reservations.sql

# 6b. Lotes y shelf-life (product_lots, lot_bin_stock, lot_movements; FK y flags en `products`; import_shipments + WMS)
npm run db:lots-management
# 6b′. Solo si antes corriste lot-management con FK a `productos`: pasar FK/vistas a `products`
# npm run db:lots-management-products-patch

# 6c. Conteo cíclico (count_sessions, count_lines; requiere WMS + auditoría v2)
# psql $DATABASE_URL -f sql/cycle-count.sql
# npm run db:cycle-count

# 7. Catálogo técnico — compatibilidad motores/válvulas (vehicle_makes, engines, valve_specs, vistas)
psql $DATABASE_URL -f sql/catalog-motor-compatibility.sql

# 8. Customer wallet — CRM customers + billetera (wallet_transactions, vista v_customer_wallet_summary)
psql $DATABASE_URL -f sql/customer-wallet.sql

# 9. Conciliación bancaria Banesco (bank_accounts, bank_statements, invoices, run_reconciliation)
psql $DATABASE_URL -f sql/bank-reconciliation.sql
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

-- Tras el paso 7 (catálogo motor/válvulas):
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'vehicle_makes','vehicle_models','engines',
    'motor_compatibility','valve_specs'
  )
ORDER BY table_name;
-- Esperado: 5 filas

SELECT viewname FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN ('v_catalog_compatibility','v_valve_equivalences')
ORDER BY viewname;
-- Esperado: 2 filas

-- Tras el paso 8 (customer wallet):
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'customers','customer_ml_buyers',
    'customer_wallets','wallet_transactions'
  )
ORDER BY table_name;
-- Esperado: 4 filas

SELECT viewname FROM pg_views
WHERE schemaname = 'public' AND viewname = 'v_customer_wallet_summary';
-- Esperado: 1 fila
```

## Pruebas API wallet (Node)

Con `DATABASE_URL` y migración aplicada:

```bash
npm run test-wallet
```

Con servidor en marcha, `ADMIN_SECRET` y opcional `BASE_URL` (por defecto `http://127.0.0.1:3001`):

```bash
npm run test-wallet-http
```
