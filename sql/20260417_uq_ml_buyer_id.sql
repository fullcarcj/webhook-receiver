-- Precondición (ejecutar en psql o cliente SQL antes de aplicar este archivo):
--   SELECT ml_buyer_id, COUNT(*) AS c
--   FROM customer_ml_buyers
--   GROUP BY ml_buyer_id
--   HAVING COUNT(*) > 1;
-- Si devuelve filas: detener, corregir duplicados o repetir backfill; no crear el índice único.

CREATE UNIQUE INDEX IF NOT EXISTS uq_cml_ml_buyer_id
  ON customer_ml_buyers (ml_buyer_id);
