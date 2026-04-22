-- Imputaciones de pago a cotización (bimoneda mixto: varias piernas VES/USD).
-- Requiere: inventario_presupuesto, payment_attempts (20260412 o equivalente).
-- Criterio de cierre: SUM(monto efectivo en USD equivalente) >= total cotización (±0,5 %)
--   y toda pierna USD tiene usd_caja_status = 'approved'.
--
-- Incluye reconciled_quotation_id si aún no existe (mismo criterio que sql/20260426_*.sql)
-- para que este script se pueda ejecutar solo sin error en el backfill.

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS reconciled_quotation_id BIGINT
    REFERENCES inventario_presupuesto(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_attempts_reconciled_quotation
  ON payment_attempts(reconciled_quotation_id)
  WHERE reconciled_quotation_id IS NOT NULL;

COMMENT ON COLUMN payment_attempts.reconciled_quotation_id IS
  'Cotización (inventario_presupuesto) vinculada al comprobante (match manual o automático).';

CREATE TABLE IF NOT EXISTS quotation_payment_allocations (
  id                      BIGSERIAL PRIMARY KEY,
  quotation_id            BIGINT NOT NULL
                            REFERENCES inventario_presupuesto(id) ON DELETE CASCADE,
  payment_attempt_id      BIGINT
                            REFERENCES payment_attempts(id) ON DELETE SET NULL,
  source_currency         TEXT NOT NULL
                            CHECK (source_currency IN ('VES', 'USD')),
  amount_original         NUMERIC(18, 4) NOT NULL
                            CHECK (amount_original > 0),
  amount_usd_equivalent   NUMERIC(18, 6) NOT NULL
                            CHECK (amount_usd_equivalent > 0),
  fx_rate_bs_per_usd      NUMERIC(20, 8),
  usd_caja_status         TEXT
                            CHECK (usd_caja_status IS NULL OR usd_caja_status IN ('pending', 'approved', 'rejected')),
  caja_approved_by        BIGINT,
  caja_approved_at        TIMESTAMPTZ,
  created_by_user_id      BIGINT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                   TEXT,
  CONSTRAINT chk_qpa_ves_caja_null CHECK (
    source_currency <> 'VES' OR usd_caja_status IS NULL
  ),
  CONSTRAINT chk_qpa_usd_caja_required CHECK (
    source_currency <> 'USD' OR usd_caja_status IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_qpa_quotation ON quotation_payment_allocations(quotation_id);
CREATE INDEX IF NOT EXISTS idx_qpa_pending_usd
  ON quotation_payment_allocations(quotation_id)
  WHERE source_currency = 'USD' AND usd_caja_status = 'pending';

COMMENT ON TABLE quotation_payment_allocations IS
  'Piernas de cobro imputadas a una cotización; VES sin caja; USD requiere aprobación de caja (usd_caja_status).';

-- Un mismo comprobante no puede duplicarse contra la misma cotización.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qpa_attempt_quotation
  ON quotation_payment_allocations(payment_attempt_id, quotation_id)
  WHERE payment_attempt_id IS NOT NULL;

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS extracted_amount_usd NUMERIC(14, 2);

COMMENT ON COLUMN payment_attempts.extracted_amount_usd IS
  'Opcional: monto en USD leído del comprobante (pago mixto).';

-- Backfill: una pierna VES por comprobante ya matcheado a cotización (sin fila previa).
INSERT INTO quotation_payment_allocations (
  quotation_id,
  payment_attempt_id,
  source_currency,
  amount_original,
  amount_usd_equivalent,
  fx_rate_bs_per_usd,
  usd_caja_status,
  created_by_user_id
)
SELECT
  pa.reconciled_quotation_id,
  pa.id,
  'VES',
  pa.extracted_amount_bs,
  ROUND(
    (pa.extracted_amount_bs / NULLIF(r.active_rate, 0))::numeric,
    6
  ),
  r.active_rate,
  NULL,
  NULL
FROM payment_attempts pa
JOIN LATERAL (
  SELECT active_rate::numeric AS active_rate
  FROM daily_exchange_rates
  WHERE company_id = 1
    AND active_rate IS NOT NULL
    AND active_rate::numeric > 0
  ORDER BY rate_date DESC NULLS LAST, id DESC
  LIMIT 1
) r ON TRUE
WHERE pa.reconciliation_status = 'matched'
  AND pa.reconciled_quotation_id IS NOT NULL
  AND pa.extracted_amount_bs IS NOT NULL
  AND pa.extracted_amount_bs > 0
  AND NOT EXISTS (
    SELECT 1
    FROM quotation_payment_allocations x
    WHERE x.payment_attempt_id = pa.id
      AND x.quotation_id = pa.reconciled_quotation_id
  );
