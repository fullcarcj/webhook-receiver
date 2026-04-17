-- =============================================================================
-- Backfill identidades ML + repair crm_chats + repair sales_orders ML + vista
-- Fecha: 2026-04-17
--
-- Prerrequisitos (orden típico):
--   sql/customer-wallet.sql (customers, customer_ml_buyers)
--   sql/crm-solomotor3k.sql (crm_customer_identities, crm_identity_source)
--   sql/20260408_sales_orders.sql + sql/20260408_sales_orders_ml.sql (ml_user_id)
--   db-postgres ensureSchema o equivalente: ml_orders, ml_buyers(buyer_id PK)
--   sql/20260410_whatsapp_hub.sql (crm_chats)
--
-- Idempotente: re-ejecutar no duplica identidades (ON CONFLICT DO NOTHING);
--   updates solo filas que aún cumplen NULL / mismatch resuelto.
--
-- Ejecución: staging primero; revisar RAISE NOTICE. Validación al final del archivo.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 — Backfill crm_customer_identities desde primary_ml_buyer_id
-- -----------------------------------------------------------------------------
-- UNIQUE real: (source, external_id) — ver sql/crm-solomotor3k.sql
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_ins INTEGER;
BEGIN
  INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
  SELECT
    c.id,
    'mercadolibre'::crm_identity_source,
    c.primary_ml_buyer_id::text,
    TRUE
  FROM customers c
  WHERE c.primary_ml_buyer_id IS NOT NULL
  ON CONFLICT (source, external_id) DO NOTHING;

  GET DIAGNOSTICS v_ins = ROW_COUNT;
  RAISE NOTICE '[PASO 1] INSERT intentado; filas afectadas (inserciones nuevas): %', v_ins;
END $$;

DO $$
DECLARE
  v_cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM crm_customer_identities
  WHERE source = 'mercadolibre'::crm_identity_source;
  RAISE NOTICE '[PASO 1] Total filas source=mercadolibre en crm_customer_identities: %', v_cnt;
END $$;


-- -----------------------------------------------------------------------------
-- PASO 2 — Repair crm_chats (customer_id IS NULL) vía identidad WhatsApp
-- -----------------------------------------------------------------------------
-- Match por dígitos; si hay varias identidades por número, elige customer_id mínimo.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_upd INTEGER;
BEGIN
  UPDATE crm_chats ch
  SET customer_id = (
    SELECT ci.customer_id
    FROM crm_customer_identities ci
    WHERE ci.source = 'whatsapp'::crm_identity_source
      AND REGEXP_REPLACE(ci.external_id, '\D', '', 'g')
        = REGEXP_REPLACE(ch.phone, '\D', '', 'g')
    ORDER BY ci.customer_id
    LIMIT 1
  )
  WHERE ch.customer_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM crm_customer_identities ci2
      WHERE ci2.source = 'whatsapp'::crm_identity_source
        AND REGEXP_REPLACE(ci2.external_id, '\D', '', 'g')
          = REGEXP_REPLACE(ch.phone, '\D', '', 'g')
    );

  GET DIAGNOSTICS v_upd = ROW_COUNT;
  RAISE NOTICE '[PASO 2] crm_chats actualizados (customer_id rellenado): %', v_upd;
END $$;

DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_orphans FROM crm_chats WHERE customer_id IS NULL;
  RAISE NOTICE '[PASO 2] crm_chats aún sin customer_id: %', v_orphans;
END $$;


-- -----------------------------------------------------------------------------
-- PASO 3 — Repair sales_orders import ML con customer_id NULL
-- -----------------------------------------------------------------------------
-- Formato external_order_id al importar: {ml_user_id}-{order_id} (salesService.js).
-- ml_buyers PK: buyer_id. Une por ml_orders.buyer_id → customer_ml_buyers.
-- Si un buyer_id enlaza a varios customers (dato sucio), se usa MIN(customer_id).
-- Requiere columna sales_orders.ml_user_id (20260408_sales_orders_ml.sql).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_upd INTEGER;
BEGIN
  UPDATE sales_orders so
  SET customer_id = x.customer_id
  FROM (
    SELECT mo.ml_user_id, mo.order_id, MIN(cmb.customer_id) AS customer_id
    FROM ml_orders mo
    INNER JOIN customer_ml_buyers cmb ON cmb.ml_buyer_id = mo.buyer_id
    WHERE mo.buyer_id IS NOT NULL
    GROUP BY mo.ml_user_id, mo.order_id
  ) x
  WHERE so.source = 'mercadolibre'
    AND so.customer_id IS NULL
    AND so.ml_user_id IS NOT NULL
    AND so.ml_user_id = x.ml_user_id
    AND so.external_order_id = (x.ml_user_id::text || '-' || x.order_id::text);

  GET DIAGNOSTICS v_upd = ROW_COUNT;
  RAISE NOTICE '[PASO 3] sales_orders mercadolibre actualizados (customer_id): %', v_upd;
END $$;

DO $$
DECLARE
  v_null INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_null
  FROM sales_orders
  WHERE customer_id IS NULL
    AND source = 'mercadolibre';
  RAISE NOTICE '[PASO 3] sales_orders mercadolibre con customer_id NULL restantes: %', v_null;
END $$;


-- -----------------------------------------------------------------------------
-- PASO 4 — Vista identity_score (referencia única para API / plantillas)
-- -----------------------------------------------------------------------------
-- Los COUNT por fila son aceptables en MVP; en tablas muy grandes valorar
-- materialized view o agregados vía JOIN + GROUP BY en consultas dedicadas.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_customer_identity_score AS
SELECT
  c.id,
  c.full_name,
  c.phone,
  c.email,
  c.id_type,
  c.id_number,
  CASE
    WHEN c.id_type IS NOT NULL
     AND c.id_number IS NOT NULL
     AND c.email IS NOT NULL
     AND NULLIF(TRIM(c.phone), '') IS NOT NULL THEN 'verde'
    WHEN NULLIF(TRIM(c.email), '') IS NOT NULL
      OR NULLIF(TRIM(c.phone), '') IS NOT NULL THEN 'amarillo'
    ELSE 'rojo'
  END AS identity_score,
  (c.id_number IS NULL OR NULLIF(TRIM(c.id_number), '') IS NULL) AS falta_cedula,
  (c.id_type IS NULL OR TRIM(COALESCE(c.id_type, '')) = '') AS falta_id_type,
  (c.email IS NULL OR NULLIF(TRIM(c.email), '') IS NULL) AS falta_email,
  (c.phone IS NULL OR NULLIF(TRIM(c.phone), '') IS NULL) AS falta_phone,
  (SELECT COUNT(*)::int FROM customer_ml_buyers cmb WHERE cmb.customer_id = c.id) AS ml_accounts,
  (SELECT COUNT(*)::int FROM crm_chats ch WHERE ch.customer_id = c.id) AS wa_chats
FROM customers c;

COMMENT ON VIEW v_customer_identity_score IS
  'Semáforo de completitud de identidad. verde=id_type+id_number+email+phone; '
  'amarillo=email o phone; rojo=resto. MVP: subconsultas COUNT por fila; '
  'volumen alto: materializar o JOIN agregado.';


COMMIT;

-- =============================================================================
-- POST-EJECUCIÓN (fuera de transacción): correr manualmente y pegar resultados
-- =============================================================================

-- SELECT identity_score, COUNT(*) AS total
-- FROM v_customer_identity_score
-- GROUP BY identity_score
-- ORDER BY total DESC;

-- SELECT id, full_name, phone, falta_cedula, falta_id_type, falta_email
-- FROM v_customer_identity_score
-- WHERE identity_score = 'rojo'
-- ORDER BY id
-- LIMIT 20;

-- SELECT COUNT(*) AS chats_sin_customer FROM crm_chats WHERE customer_id IS NULL;
