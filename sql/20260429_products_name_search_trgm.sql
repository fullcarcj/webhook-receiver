-- Índice GIN pg_trgm para búsquedas por nombre (LIKE '%token%') alineadas a
-- translate(lower(name), …) en inventoryService.listProducts.
-- Ejecutar: npm run db:products-search-trgm
--
-- Requiere extensión pg_trgm (Postgres contrib). Sin ella, el CREATE INDEX falla.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_active_name_fold_trgm
  ON public.products
  USING gin (
    translate(
      lower(name),
      'áéíóúüñàèìòùäëïöõÁÉÍÓÚÜÑÀÈÌÒÙÄËÏÖÕ',
      'aeiouunaieouaeiouoAEIOUUNAEIOUAEIOU'
    ) gin_trgm_ops
  )
  WHERE is_active = TRUE;

COMMENT ON INDEX idx_products_active_name_fold_trgm IS
  'Acelera listProducts search_by=name (LIKE por token) sobre productos activos.';
