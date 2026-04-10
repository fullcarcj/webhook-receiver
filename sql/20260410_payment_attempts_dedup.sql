-- Eliminar duplicados: conservar solo el registro más antiguo por firebase_url
DELETE FROM payment_attempts
WHERE id NOT IN (
  SELECT MIN(id) FROM payment_attempts GROUP BY firebase_url
);

-- Índice UNIQUE en firebase_url para prevenir payment_attempts duplicados
-- (Wasender reintenta webhooks múltiples veces con el mismo mensaje)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_firebase_url_unique
  ON payment_attempts(firebase_url);
