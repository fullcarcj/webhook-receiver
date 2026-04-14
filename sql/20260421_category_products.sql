-- SEED incluido: seguro ejecutar en BD vacía o nueva.
-- Render: correr este script en el servicio webhook-receiver
-- antes del primer deploy que use category_products.

-- Tabla: category_products (inventario / catálogo de categorías)
-- Idempotente: seguro ejecutar más de una vez.

CREATE TABLE IF NOT EXISTS category_products (
  id BIGSERIAL PRIMARY KEY,
  category_descripcion TEXT NOT NULL,
  category_ml TEXT
);

COMMENT ON TABLE category_products IS 'Categorías de producto (descripción + referencia ML).';
COMMENT ON COLUMN category_products.id IS 'Identificador interno.';
COMMENT ON COLUMN category_products.category_descripcion IS 'Descripción legible de la categoría.';
COMMENT ON COLUMN category_products.category_ml IS 'Identificador o ruta de categoría en Mercado Libre (según convención del negocio).';

INSERT INTO category_products (category_descripcion, category_ml)
SELECT * FROM (VALUES
  ('Frenos',       'FRENOS'),
  ('Motor',        'MOTOR'),
  ('Suspensión',   'SUSPENSION'),
  ('Transmisión',  'TRANSMISION'),
  ('Eléctrico',    'ELECTRICO'),
  ('Carrocería',   'CARROCERIA'),
  ('Enfriamiento', 'ENFRIAMIENTO'),
  ('Escape',       'ESCAPE'),
  ('Filtros',      'FILTROS'),
  ('Genérico',     'GENERICO')
) AS v(category_descripcion, category_ml)
WHERE NOT EXISTS (
  SELECT 1 FROM category_products LIMIT 1
);
