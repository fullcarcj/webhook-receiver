-- Trazabilidad de media en webhooks Wasender:
-- - Si el payload trae media (has_media/media_type)
-- - Estado del pipeline (queued/processing/completed/failed/skipped_*)
-- - URL persistente final en Firebase

ALTER TABLE wasender_webhook_events
  ADD COLUMN IF NOT EXISTS has_media BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS inbound_message_id TEXT,
  ADD COLUMN IF NOT EXISTS media_pipeline_status TEXT NOT NULL DEFAULT 'not_media',
  ADD COLUMN IF NOT EXISTS media_pipeline_detail TEXT,
  ADD COLUMN IF NOT EXISTS media_firebase_url TEXT,
  ADD COLUMN IF NOT EXISTS media_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wasender_webhook_inbound_message_id
  ON wasender_webhook_events (inbound_message_id);

CREATE INDEX IF NOT EXISTS idx_wasender_webhook_media_status
  ON wasender_webhook_events (media_pipeline_status, received_at DESC);
