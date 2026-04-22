-- Migración: corregir FK de inventario_detallepresupuesto.producto_id
-- El sistema Node.js usa la tabla `products` (7514 items) como catálogo,
-- pero el constraint apuntaba a `inventario_producto` (tabla Django legacy, 394 items).
-- El único registro existente (producto_id=3548) también existe en `products`, migración segura.

ALTER TABLE inventario_detallepresupuesto
  DROP CONSTRAINT IF EXISTS inventario_detallepr_producto_id_af764f79_fk_inventari;

ALTER TABLE inventario_detallepresupuesto
  ADD CONSTRAINT inventario_detallepresupuesto_producto_id_fk
  FOREIGN KEY (producto_id)
  REFERENCES products(id)
  ON DELETE RESTRICT;
