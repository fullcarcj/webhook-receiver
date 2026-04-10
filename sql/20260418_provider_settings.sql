-- Provider settings + AI usage log (AI Gateway admin)
-- Ejecutar: npm run db:provider-settings

CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  model_name TEXT NOT NULL,
  api_key_encrypted TEXT,
  base_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  daily_token_limit INTEGER NOT NULL DEFAULT 1000000,
  daily_request_limit INTEGER NOT NULL DEFAULT 10000,
  current_daily_usage INTEGER NOT NULL DEFAULT 0,
  current_daily_requests INTEGER NOT NULL DEFAULT 0,
  error_count_today INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 15,
  circuit_breaker_until TIMESTAMPTZ,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_check_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  fallback_provider_id TEXT REFERENCES provider_settings (provider_id) DEFERRABLE INITIALLY DEFERRED,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider_settings (provider_id),
  function_called TEXT NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_provider_created ON ai_usage_log (provider_id, created_at DESC);

CREATE OR REPLACE FUNCTION provider_settings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_provider_settings_updated ON provider_settings;
CREATE TRIGGER trg_provider_settings_updated
  BEFORE UPDATE ON provider_settings
  FOR EACH ROW
  EXECUTE FUNCTION provider_settings_touch_updated_at();

INSERT INTO provider_settings (
  provider_id,
  display_name,
  category,
  provider_type,
  model_name,
  enabled,
  daily_token_limit,
  daily_request_limit,
  fallback_provider_id
)
VALUES
  (
    'GEMINI_FLASH',
    'Gemini 1.5 Flash',
    'ai_vision',
    'gemini',
    'gemini-1.5-flash',
    TRUE,
    1000000,
    5000,
    NULL
  ),
  (
    'GROQ_WHISPER',
    'Groq Whisper Large V3',
    'ai_audio',
    'groq',
    'whisper-large-v3',
    TRUE,
    500000,
    2000,
    NULL
  ),
  (
    'GROQ_LLAMA',
    'Llama 3.3 70B Versatile',
    'ai_chat_basic',
    'groq',
    'llama-3.3-70b-versatile',
    TRUE,
    500000,
    5000,
    NULL
  ),
  (
    'OPENAI_GPT4',
    'GPT-4.1-mini',
    'ai_chat_advanced',
    'openai',
    'gpt-4.1-mini',
    FALSE,
    200000,
    1000,
    NULL
  )
ON CONFLICT (provider_id) DO NOTHING;
