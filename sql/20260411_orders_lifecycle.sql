-- Ciclo de vida ML: lifecycle_status + trazabilidad. Requiere sales_orders existente.
-- Ejecutar: npm run db:orders-lifecycle

ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternative_phone TEXT;

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS ml_status TEXT,
  ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT,
  ADD COLUMN IF NOT EXISTS tipo_calificacion_ml TEXT,
  ADD COLUMN IF NOT EXISTS aprobado_por_user_id TEXT,
  ADD COLUMN IF NOT EXISTS es_pago_auto_banesco BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metodo_despacho TEXT,
  ADD COLUMN IF NOT EXISTS calificacion_ml TEXT,
  ADD COLUMN IF NOT EXISTS rating_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_rating_alert BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_motivo_anulacion_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_motivo_anulacion_check CHECK (
  motivo_anulacion IS NULL OR motivo_anulacion IN (
    'falta_stock', 'no_respondio', 'error_precio', 'pago_rechazado',
    'solicitud_comprador', 'duplicada', 'otro'
  )
);

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_tipo_calificacion_ml_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_tipo_calificacion_ml_check CHECK (
  tipo_calificacion_ml IS NULL OR tipo_calificacion_ml IN (
    'positive_fulfilled', 'positive_not_fulfilled', 'negative_not_fulfilled'
  )
);

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_metodo_despacho_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_metodo_despacho_check CHECK (
  metodo_despacho IS NULL OR metodo_despacho IN (
    'pick_up', 'envio_gratis_ml', 'envio_cod', 'delivery_propio'
  )
);

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_lifecycle_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_lifecycle_status_check CHECK (
  lifecycle_status IS NULL OR lifecycle_status IN (
    'pendiente', 'pagada', 'anulada', 'pendiente_entrega', 'entregado', 'archivado'
  )
);

UPDATE sales_orders SET lifecycle_status = CASE status::text
  WHEN 'pending' THEN 'pendiente'
  WHEN 'paid' THEN 'pagada'
  WHEN 'shipped' THEN 'pendiente_entrega'
  WHEN 'cancelled' THEN 'anulada'
  WHEN 'completed' THEN 'archivado'
  ELSE NULL
END
WHERE source = 'mercadolibre' AND lifecycle_status IS NULL;

CREATE TABLE IF NOT EXISTS sales_order_history (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  motivo TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_history_order
  ON sales_order_history(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_orders_rating_deadline
  ON sales_orders(rating_deadline_at ASC)
  WHERE source = 'mercadolibre'
    AND lifecycle_status IS NOT NULL
    AND lifecycle_status NOT IN ('archivado', 'anulada')
    AND rating_deadline_at IS NOT NULL;
