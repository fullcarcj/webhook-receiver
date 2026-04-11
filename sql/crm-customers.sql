-- ════════════════════════════════════════════════════════
-- Ferrari ERP — CRM: customers + customer_ml_buyers
--
-- REGLA ABSOLUTA: NUNCA modificar ml_buyers.
-- ml_buyers es la fuente de verdad para WaSender.
-- Este script solo extiende tablas propias del ERP.
--
-- Prerrequisitos:
--   sql/customer-wallet.sql (customers, customer_ml_buyers,
--   customer_wallets, wallet_transactions — con ENUMs)
--
-- Ejecución: psql $DATABASE_URL -f sql/crm-customers.sql
-- ════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────
-- 1. Extender customers con columnas CRM
--
-- La tabla ya existe desde customer-wallet.sql.
-- Solo se agregan columnas faltantes — idempotente.
-- ─────────────────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city          TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'RETAIL';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags          TEXT[];
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_orders      INTEGER       NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_spent_usd   NUMERIC(15,4) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_order_date   DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_order_date  DATE;

-- CHECK idempotente para customer_type
ALTER TABLE customers DROP CONSTRAINT IF EXISTS chk_customer_type;
ALTER TABLE customers ADD CONSTRAINT chk_customer_type
  CHECK (customer_type IN ('RETAIL','WHOLESALE','WORKSHOP','DEALER'));


-- ─────────────────────────────────────────────────────
-- 2. Corregir el constraint UNIQUE NULLS NOT DISTINCT
--    en customers.
--
-- PROBLEMA: UNIQUE NULLS NOT DISTINCT en
-- (company_id, id_type, id_number) solo permite UNO
-- con id_type=NULL por empresa — bloqueando la migración
-- masiva (18k buyers sin cédula conocida).
--
-- SOLUCIÓN: reemplazar por índice parcial que aplica
-- solo cuando id_type e id_number están presentes.
-- El comportamiento para clientes CON cédula es idéntico.
-- ─────────────────────────────────────────────────────
ALTER TABLE customers DROP CONSTRAINT IF EXISTS uq_customer_id_doc;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_id_doc
  ON customers (company_id, id_type, id_number)
  WHERE id_type IS NOT NULL AND id_number IS NOT NULL;


-- ─────────────────────────────────────────────────────
-- 3. Extender customer_ml_buyers
-- ─────────────────────────────────────────────────────
ALTER TABLE customer_ml_buyers ADD COLUMN IF NOT EXISTS linked_by INTEGER;
ALTER TABLE customer_ml_buyers ADD COLUMN IF NOT EXISTS notes     TEXT;

-- Solo UN primary por customer (guard de BD)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cml_primary
  ON customer_ml_buyers (customer_id)
  WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_cml_customer
  ON customer_ml_buyers (customer_id);


-- ─────────────────────────────────────────────────────
-- 4. Índices GIN y de clasificación en customers
-- ─────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_gin_cust_name
  ON customers USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_cust_type
  ON customers (customer_type, company_id);

CREATE INDEX IF NOT EXISTS idx_cust_spent
  ON customers (total_spent_usd DESC NULLS LAST, company_id);


-- ─────────────────────────────────────────────────────
-- 5. migrate_ml_buyers_to_crm()
--
-- Migra cada ml_buyer que aún no tiene customer_ml_buyers
-- a un customer CRM nuevo.
--
-- ADAPTADO AL ESQUEMA REAL de ml_buyers:
--   PK   = buyer_id  (no id)
--   nombre = nombre_apellido  (no first_name/last_name)
--   tel  = phone_1  (no phone)
--   ⚠ SIN columna email en ml_buyers
--
-- Idempotente: solo procesa buyers sin link existente.
-- Un error en un buyer no detiene la migración completa.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION migrate_ml_buyers_to_crm(
  p_company_id INTEGER DEFAULT 1
)
RETURNS TABLE (
  created  INTEGER,
  linked   INTEGER,
  skipped  INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
  v_created   INTEGER := 0;
  v_linked    INTEGER := 0;
  v_skipped   INTEGER := 0;
  v_buyer     RECORD;
  v_cust_id   BIGINT;
  v_ins_count INTEGER;
BEGIN
  FOR v_buyer IN
    SELECT b.*
    FROM ml_buyers b
    WHERE NOT EXISTS (
      SELECT 1
      FROM customer_ml_buyers cmb
      WHERE cmb.ml_buyer_id = b.buyer_id
    )
    ORDER BY b.buyer_id
  LOOP
    BEGIN
      -- Intentar crear customer nuevo
      INSERT INTO customers (
        company_id,
        full_name,
        phone,
        primary_ml_buyer_id,
        customer_type
      ) VALUES (
        p_company_id,
        COALESCE(
          NULLIF(TRIM(COALESCE(v_buyer.nombre_apellido, '')), ''),
          v_buyer.nickname,
          'Comprador ML ' || v_buyer.buyer_id::TEXT
        ),
        v_buyer.phone_1,
        v_buyer.buyer_id,
        'RETAIL'
      )
      RETURNING id INTO v_cust_id;

      IF v_cust_id IS NOT NULL THEN
        v_created := v_created + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      -- ON CONFLICT no aplica; otros errores → buscar existente
      v_cust_id := NULL;
    END;

    -- Si no se creó, buscar por primary_ml_buyer_id
    IF v_cust_id IS NULL THEN
      SELECT id INTO v_cust_id
        FROM customers
        WHERE primary_ml_buyer_id = v_buyer.buyer_id
        LIMIT 1;
    END IF;

    IF v_cust_id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO customer_ml_buyers
        (customer_id, ml_buyer_id, is_primary)
      VALUES
        (v_cust_id, v_buyer.buyer_id, TRUE)
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS v_ins_count = ROW_COUNT;
      v_linked := v_linked + v_ins_count;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Error vinculando buyer % → customer %: %',
        v_buyer.buyer_id, v_cust_id, SQLERRM;
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_created, v_linked, v_skipped;
END;
$$;


-- ─────────────────────────────────────────────────────
-- 6. v_customers_full — vista CRM unificada
--
-- Combina:
--   customers  → datos CRM
--   ml_buyers  → datos ML del buyer principal (lectura)
--   customer_wallets (USD) → saldo en dólares
--   customer_ml_buyers  → conteo de cuentas ML
--
-- La columna ml_phone es ml_buyers.phone_1 —
-- NUNCA usar customers.phone para WaSender.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_customers_full AS
SELECT
  c.id               AS customer_id,
  c.company_id,
  c.full_name,
  c.id_type,
  c.id_number,
  c.email            AS crm_email,
  c.phone            AS crm_phone,
  c.address,
  c.city,
  c.customer_type,
  c.tags,
  c.total_orders,
  c.total_spent_usd,
  c.last_order_date,
  c.first_order_date,
  c.is_active,
  c.notes,
  -- Buyer ML principal (lectura, NUNCA escritura sobre ml_buyers)
  b.buyer_id         AS primary_ml_buyer_id,
  b.nickname         AS ml_nickname,
  b.nombre_apellido  AS ml_nombre_apellido,
  b.phone_1          AS ml_phone,
  -- Saldo wallet USD
  COALESCE(cw.balance, 0) AS wallet_balance_usd,
  -- Cantidad de cuentas ML vinculadas
  COUNT(cmb.ml_buyer_id)  AS ml_accounts_count,
  c.created_at,
  c.updated_at
FROM customers               c
LEFT JOIN ml_buyers           b   ON  b.buyer_id    = c.primary_ml_buyer_id
LEFT JOIN customer_wallets    cw  ON  cw.customer_id = c.id
                                  AND cw.currency    = 'USD'
LEFT JOIN customer_ml_buyers  cmb ON  cmb.customer_id = c.id
GROUP BY
  c.id, b.buyer_id, b.nickname, b.nombre_apellido, b.phone_1,
  cw.balance
ORDER BY c.total_spent_usd DESC NULLS LAST;


-- ─────────────────────────────────────────────────────
-- 7. balance_before_usd — auditoría del libro mayor
--
-- Agrega la columna a wallet_transactions si no existe.
-- El trigger actualizado la poplua automáticamente en
-- cada cambio de estado que afecta el balance.
-- ─────────────────────────────────────────────────────
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS balance_before_usd NUMERIC(15,4);

-- Reemplazar update_wallet_balance() para capturar
-- el saldo antes de cada movimiento confirmado.
-- Idempotente: CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION update_wallet_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_before NUMERIC(15,4) := 0;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'CONFIRMED' THEN
    SELECT COALESCE(balance, 0)
      INTO v_before
      FROM customer_wallets WHERE id = NEW.wallet_id;

    UPDATE wallet_transactions
      SET balance_before_usd = v_before
      WHERE id = NEW.id;

    UPDATE customer_wallets
      SET balance          = balance + NEW.amount,
          last_movement_at = now()
      WHERE id = NEW.wallet_id;

  ELSIF TG_OP = 'UPDATE'
    AND OLD.status = 'PENDING'
    AND NEW.status = 'CONFIRMED' THEN

    SELECT COALESCE(balance, 0)
      INTO v_before
      FROM customer_wallets WHERE id = NEW.wallet_id;

    UPDATE wallet_transactions
      SET balance_before_usd = v_before
      WHERE id = NEW.id;

    UPDATE customer_wallets
      SET balance          = balance + NEW.amount,
          last_movement_at = now()
      WHERE id = NEW.wallet_id;

  ELSIF TG_OP = 'UPDATE'
    AND OLD.status = 'CONFIRMED'
    AND NEW.status = 'CANCELLED' THEN

    SELECT COALESCE(balance, 0)
      INTO v_before
      FROM customer_wallets WHERE id = OLD.wallet_id;

    UPDATE wallet_transactions
      SET balance_before_usd = v_before
      WHERE id = NEW.id;

    UPDATE customer_wallets
      SET balance          = balance - OLD.amount,
          last_movement_at = now()
      WHERE id = OLD.wallet_id;
  END IF;

  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM 1 FROM customer_wallets
      WHERE id = NEW.wallet_id AND balance < 0;
    IF FOUND THEN
      RAISE EXCEPTION
        'Balance negativo detectado en wallet_id=%. Operación revertida.',
        NEW.wallet_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- El trigger ya existe — DROP+CREATE es idempotente aquí.
DROP TRIGGER IF EXISTS trg_wallet_balance ON wallet_transactions;
CREATE TRIGGER trg_wallet_balance
  AFTER INSERT OR UPDATE OF status
  ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION update_wallet_balance();


-- ─────────────────────────────────────────────────────
-- 8. Verificación
-- ─────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'customers'
  AND column_name IN (
    'address','city','customer_type','tags',
    'total_orders','total_spent_usd',
    'last_order_date','first_order_date'
  )
ORDER BY column_name;
-- Esperado: 8 filas

SELECT indexname FROM pg_indexes
WHERE tablename = 'customer_ml_buyers'
  AND indexname IN ('uq_cml_primary','idx_cml_customer');
-- Esperado: 2 filas

SELECT proname FROM pg_proc
WHERE proname = 'migrate_ml_buyers_to_crm';
-- Esperado: 1 fila

SELECT viewname FROM pg_views
WHERE viewname = 'v_customers_full';
-- Esperado: 1 fila

-- CRÍTICO: confirmar que ml_buyers NO cambió
SELECT column_name FROM information_schema.columns
WHERE table_name = 'ml_buyers'
ORDER BY ordinal_position;
-- Debe ser IDÉNTICO al antes de ejecutar este script
