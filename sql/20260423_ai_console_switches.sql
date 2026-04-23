-- Consola IA (interruptores persistidos). El servidor también crea la tabla en caliente si no existe.
CREATE TABLE IF NOT EXISTS ai_console_switches (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  tipo_m_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  transcription_groq BOOLEAN NOT NULL DEFAULT TRUE,
  wa_name_groq BOOLEAN NOT NULL DEFAULT TRUE,
  receipt_gemini_vision BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_console_switches (singleton)
VALUES (1)
ON CONFLICT (singleton) DO NOTHING;
