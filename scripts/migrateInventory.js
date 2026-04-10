'use strict';
/**
 * MIGRACIÓN ÚNICA: productos + inventario_producto → products + inventory
 *
 * Usa INSERT INTO ... SELECT FROM (operación server-side, sin transferencia de datos).
 * Field mappings verificados:
 *   productos:            sku, descripcion, marca_producto, precio_usd, stock, id
 *   inventario_producto:  codigo_interno, stock, stock_minimo, precio_venta, tipo_producto, id
 */

require('../load-env-local');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  statement_timeout: 300000, // 5 min
});

async function migrateInventory() {
  const client = await pool.connect();
  try {

    // ── PASO 1: productos → products ─────────────────────────────────────────
    console.log('PASO 1: Migrando productos → products...');
    const { rowCount: r1 } = await client.query(`
      INSERT INTO products
        (sku, name, description, brand, unit_price_usd, source, source_id, is_active)
      SELECT
        p.sku,
        LEFT(COALESCE(p.descripcion, p.sku), 500),
        LEFT(p.descripcion, 1000),
        p.marca_producto,
        p.precio_usd,
        'productos',
        p.id,
        TRUE
      FROM productos p
      ON CONFLICT (sku) DO UPDATE SET
        name           = EXCLUDED.name,
        description    = EXCLUDED.description,
        brand          = EXCLUDED.brand,
        unit_price_usd = EXCLUDED.unit_price_usd,
        source_id      = EXCLUDED.source_id,
        updated_at     = NOW()
    `);
    console.log(`  ✅ ${r1} productos migrados`);

    // ── PASO 2: inventory desde productos (stock real) ───────────────────────
    console.log('PASO 2: Creando inventory desde productos...');
    const { rowCount: r2 } = await client.query(`
      INSERT INTO inventory (product_id, stock_qty)
      SELECT pr.id, COALESCE(p.stock, 0)
      FROM products pr
      JOIN productos p ON p.id = pr.source_id AND pr.source = 'productos'
      ON CONFLICT (product_id) DO UPDATE SET
        stock_qty  = EXCLUDED.stock_qty,
        updated_at = NOW()
    `);
    console.log(`  ✅ ${r2} filas inventory creadas (stock desde productos)`);

    // ── PASO 3: inventario_producto → products (solo SKUs nuevos) ────────────
    console.log('PASO 3: Migrando inventario_producto → products...');
    const { rowCount: r3 } = await client.query(`
      INSERT INTO products (sku, name, source, source_id, is_active)
      SELECT
        ip.codigo_interno,
        LEFT(COALESCE(ip.tipo_producto, 'PRODUCTO') || ' ' || ip.codigo_interno, 500),
        'inventario_producto',
        ip.id,
        TRUE
      FROM inventario_producto ip
      ON CONFLICT (sku) DO NOTHING
    `);
    console.log(`  ✅ ${r3} nuevos SKUs migrados desde inventario_producto`);

    // ── PASO 4: inventory para inventario_producto ───────────────────────────
    console.log('PASO 4: Actualizando inventory desde inventario_producto...');
    const { rowCount: r4 } = await client.query(`
      INSERT INTO inventory (product_id, stock_qty, stock_min)
      SELECT pr.id, COALESCE(ip.stock, 0), COALESCE(ip.stock_minimo, 0)
      FROM products pr
      JOIN inventario_producto ip ON ip.id = pr.source_id AND pr.source = 'inventario_producto'
      ON CONFLICT (product_id) DO UPDATE SET
        stock_qty  = GREATEST(inventory.stock_qty, EXCLUDED.stock_qty),
        stock_min  = GREATEST(inventory.stock_min, EXCLUDED.stock_min),
        updated_at = NOW()
    `);
    console.log(`  ✅ ${r4} filas inventory actualizadas (inventario_producto)`);

    // ── PASO 5: Rellenar huecos con stock=0 ──────────────────────────────────
    console.log('PASO 5: Rellenando inventory faltante...');
    const { rowCount: r5 } = await client.query(`
      INSERT INTO inventory (product_id, stock_qty)
      SELECT p.id, 0
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE i.product_id IS NULL
      ON CONFLICT (product_id) DO NOTHING
    `);
    console.log(`  ✅ ${r5} filas faltantes rellenadas con stock=0`);

    // ── Totales finales ──────────────────────────────────────────────────────
    const { rows: totals } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM products)               AS products,
        (SELECT COUNT(*) FROM inventory)              AS inventory,
        (SELECT COUNT(*) FROM products WHERE source = 'productos')              AS from_productos,
        (SELECT COUNT(*) FROM products WHERE source = 'inventario_producto')    AS from_inventario
    `);
    console.log('\n✅ Migración completada:');
    console.log(JSON.stringify(totals[0], null, 2));

    return totals[0];

  } catch (err) {
    console.error('❌ Migración fallida:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrateInventory()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrateInventory };
