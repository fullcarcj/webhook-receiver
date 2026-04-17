-- ============================================================
-- Módulo: Etiquetas ML desde almacén
-- Agrega ml_shipment_id a dispatch_records para vincular
-- el despacho físico con el envío ML y permitir imprimir
-- la etiqueta directamente desde el ERP.
-- Idempotente (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE dispatch_records
  ADD COLUMN IF NOT EXISTS ml_shipment_id TEXT;

COMMENT ON COLUMN dispatch_records.ml_shipment_id
  IS 'ID de envío ML (order.shipping.id). Permite recuperar etiqueta ZPL/PDF vía GET /api/ml/shipments/:id/label';

CREATE INDEX IF NOT EXISTS idx_dispatch_ml_shipment
  ON dispatch_records (ml_shipment_id)
  WHERE ml_shipment_id IS NOT NULL;
