-- Sequence global para el campo id: del canal SSE CRM (/api/realtime/stream).
-- Arranca en 1000000 para distinguir IDs de producción de IDs de prueba/boot.
-- Sobrevive deploys: nextval nunca retrocede aunque el proceso reinicie.
-- Para multi-instancia futura: la sequence ya vive en Postgres, sin cambio de wire format.
CREATE SEQUENCE IF NOT EXISTS crm_events_seq START 1000000;
