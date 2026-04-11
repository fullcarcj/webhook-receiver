-- Parche: agrega ml_user_id a ml_publications para soportar OAuth multi-cuenta.
-- Sin este campo, mlService.js no sabe qué token usar al llamar a la API de ML.
-- Idempotente (ADD COLUMN IF NOT EXISTS).

ALTER TABLE ml_publications
  ADD COLUMN IF NOT EXISTS ml_user_id BIGINT REFERENCES ml_accounts(ml_user_id);

CREATE INDEX IF NOT EXISTS idx_ml_pub_user
  ON ml_publications(ml_user_id);

-- Backfill: si solo hay una cuenta registrada, asignarla a todas las publicaciones sin ml_user_id.
DO $$
DECLARE
  v_uid BIGINT;
BEGIN
  SELECT ml_user_id INTO v_uid FROM ml_accounts LIMIT 1;
  IF v_uid IS NOT NULL THEN
    UPDATE ml_publications
    SET ml_user_id = v_uid
    WHERE ml_user_id IS NULL;
  END IF;
END $$;

COMMENT ON COLUMN ml_publications.ml_user_id IS
  'Cuenta ML (ml_accounts.ml_user_id) a la que pertenece esta publicación. Requerido por mlService.js para OAuth.';
