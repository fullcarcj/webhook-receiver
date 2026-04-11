-- Ferrari ERP — Índices GIN pg_trgm para búsqueda textual del catálogo
-- Prerrequisito: sql/motor-compatibility.sql ejecutado primero.
-- Ejecutar con: npm run db:search-indexes
--
-- pg_trgm: incluida en PostgreSQL 15, solo hay que activarla.
-- Los índices GIN con gin_trgm_ops aceleran ILIKE '%texto%'
-- que de otro modo haría Seq Scan en toda la tabla.
--
-- IMPORTANTE: solo para columnas de texto.
-- Columnas numéricas (diámetros, precios) → B-Tree (ya creados).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────
-- products — búsqueda por descripción y SKU
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gin_products_descripcion
  ON products USING GIN (descripcion gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gin_products_sku
  ON products USING GIN (sku gin_trgm_ops);

-- ─────────────────────────────────────────────────────
-- engines — búsqueda por código de motor
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gin_engines_code
  ON engines USING GIN (engine_code gin_trgm_ops);

-- ─────────────────────────────────────────────────────
-- vehicle_makes / vehicle_models — búsqueda por nombre
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gin_makes_name
  ON vehicle_makes USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gin_models_name
  ON vehicle_models USING GIN (name gin_trgm_ops);

-- ─────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';
-- Esperado: 1 fila

SELECT indexname, tablename
FROM pg_indexes
WHERE indexname LIKE 'idx_gin_%'
ORDER BY tablename, indexname;
-- Esperado: 5 índices GIN
