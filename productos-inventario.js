/**
 * Inventario de repuestos (`productos` en PostgreSQL vía `./db`).
 *
 * **Mercado Libre (autopartes)** — contexto para mapear sin inflar columnas:
 * - Dominios por sitio (p. ej. `MLV-CARS_AND_VANS`, `MLA-CARS_AND_VANS`): discovery / categorías ML.
 * - Atributos exigidos por categoría: `GET https://api.mercadolibre.com/categories/{CATEGORY_ID}/attributes`.
 * - En el ítem (`GET /items/{id}`): arreglo `attributes` con pares `id`/`value_name` (p. ej. **SELLER_SKU**);
 *   `seller_custom_field` es texto interno del vendedor (distinto del SKU en atributos si aplica).
 * - Campo local **`item_id_ml`**: mismo string que el id de publicación ML (alineado con `ml_listings.item_id`).
 * - Datos técnicos variables (medidas, dientes, material, snapshot de attributes ML): **`atributos` JSONB**.
 * - **`cod_producto`** / **`marca_producto`**: pieza y marca (alias JSON `Cod_producto` / `Marca_producto`; `cod_marca_proveedor` se migra a `cod_producto`).
 * - **`aplicacion_extendida`**, **`ubicacion`**: compatibilidades y ubicación en almacén.
 * - **`urls` JSONB**: enlaces en la misma fila (`ml`, `web`, etc.). Tabla hija solo si hace falta historial o muchas URLs por fuente.
 *
 * @example
 * const { insertProducto, upsertProductoBySku, listProductos } = require("./db");
 * await upsertProductoBySku({
 *   sku: "FULLCAR-001",
 *   cod_producto: "XYZ-99",
 *   marca_producto: "MarcaX",
 *   descripcion: "Pastillas freno",
 *   aplicacion_extendida: "Gol 2008–2012 1.6",
 *   ubicacion: "A-12-3",
 *   stock: 10,
 *   precio_usd: 25.5,
 *   oem: "ABC123",
 *   urls: { ml: "https://articulo.mercadolibre.com.ve/MLV-123" },
 *   atributos: { material: "cerámica", ml: { category_id: "MLV45777" } },
 *   item_id_ml: "MLV1234567890",
 * });
 */

const db = require("./db");

module.exports = {
  insertProducto: db.insertProducto,
  upsertProductoBySku: db.upsertProductoBySku,
  getProductoById: db.getProductoById,
  getProductoBySku: db.getProductoBySku,
  listProductos: db.listProductos,
  countProductos: db.countProductos,
  updateProducto: db.updateProducto,
  deleteProducto: db.deleteProducto,
  normalizeProductoAtributosJson: db.normalizeProductoAtributosJson,
  normalizeProductoUrlsJson: db.normalizeProductoUrlsJson,
};
