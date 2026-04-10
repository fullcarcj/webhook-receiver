-- Flujo de aprobación de caja (pagos en moneda extranjera / no Banesco Bs)
-- Prerrequisitos: sql/20260413_financial_tables.sql, migraciones sales_orders (status check vigente).

-- ── manual_transactions: aprobación de caja ───────────────────────────────────
ALTER TABLE manual_transactions
  ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES sales_orders(id) ON DELETE SET NULL;

ALTER TABLE manual_transactions
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_manual_tx_approval_status'
  ) THEN
    ALTER TABLE manual_transactions
      ADD CONSTRAINT chk_manual_tx_approval_status
      CHECK (approval_status IN ('pending', 'approved', 'rejected', 'cancelled'));
  END IF;
END $$;

ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS resubmit_count INT NOT NULL DEFAULT 0;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS proof_url TEXT;
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS discrepancy_usd NUMERIC(10, 4);
ALTER TABLE manual_transactions ADD COLUMN IF NOT EXISTS discrepancy_flag BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_manual_tx_approval
  ON manual_transactions(approval_status, submitted_at DESC)
  WHERE approval_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_manual_tx_order
  ON manual_transactions(order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manual_tx_discrepancy
  ON manual_transactions(discrepancy_flag, submitted_at DESC)
  WHERE discrepancy_flag = TRUE;

-- ── Configuración financiera ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_settings (
  id BIGSERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'number'
    CHECK (value_type IN ('number', 'boolean', 'string', 'minutes')),
  description TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO finance_settings (setting_key, setting_value, value_type, description)
VALUES
  ('CASH_APPROVAL_TOLERANCE_USD', '0.01', 'number',
   'Tolerancia máxima de discrepancia en USD para aprobación de caja'),
  ('CASH_APPROVAL_MODE', 'individual', 'string',
   'Modo de aprobación: individual (por transacción) o batch (por lote diario)'),
  ('CASH_APPROVAL_EXPIRY_HOURS', '24', 'number',
   'Horas antes de que una transacción pendiente se marque como vencida'),
  ('CASH_SHIFT_MODE', 'daily', 'string',
   'Modo de turno: daily (por día) o shift (mañana/tarde)'),
  ('CASH_SHIFT_MORNING_END', '13:00', 'string',
   'Hora de fin del turno mañana (formato HH:MM Venezuela)'),
  ('CASH_ALERT_LOSS_THRESHOLD_USD', '20.00', 'number',
   'Umbral de pérdida en USD que dispara alerta L3 al administrador'),
  ('CASH_REQUIRE_PROOF', 'false', 'boolean',
   'Si TRUE, el vendedor debe adjuntar comprobante para pagos externos')
ON CONFLICT (setting_key) DO NOTHING;

-- ── sales_orders.status: pending_cash_approval ───────────────────────────────
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'status'
  ) THEN
    FOR v_constraint IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = 'public'
        AND cls.relname = 'sales_orders'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS %I', v_constraint);
    END LOOP;

    ALTER TABLE sales_orders
      ADD CONSTRAINT chk_sales_orders_status
      CHECK (status IN (
        'pending',
        'pending_payment',
        'pending_cash_approval',
        'paid',
        'shipped',
        'cancelled',
        'refunded',
        'completed',
        'payment_overdue'
      ));
  END IF;
END $$;

-- ── Auditoría ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_approval_log (
  id BIGSERIAL PRIMARY KEY,
  manual_tx_id BIGINT NOT NULL REFERENCES manual_transactions(id),
  order_id BIGINT REFERENCES sales_orders(id),
  action TEXT NOT NULL
    CHECK (action IN ('submitted', 'approved', 'rejected', 'resubmitted', 'cancelled', 'expired')),
  action_by TEXT NOT NULL,
  action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount_usd NUMERIC(10, 4),
  discrepancy_usd NUMERIC(10, 4),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cash_log_tx
  ON cash_approval_log(manual_tx_id, action_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_log_order
  ON cash_approval_log(order_id, action_at DESC);
