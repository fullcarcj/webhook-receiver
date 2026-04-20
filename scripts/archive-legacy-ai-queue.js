#!/usr/bin/env node
"use strict";
/**
 * Archiva en bloque mensajes CRM con ai_reply_status = needs_human_review → legacy_archived
 * y registra una fila en ai_response_log por mensaje (action_taken = legacy_archived).
 *
 * Idempotente: segunda ejecución con cola vacía no inserta duplicados.
 *
 * Requiere: migración sql/20260420b_ai_responder_legacy_archived.sql aplicada (npm run db:ai-responder).
 * Uso: npm run archive:legacy-ai-queue
 */
require("../load-env-local");
const { pool } = require("../db");

const ARCHIVE_SQL = `
WITH archived AS (
  UPDATE crm_messages
  SET ai_reply_status = 'legacy_archived',
      ai_reply_updated_at = NOW()
  WHERE ai_reply_status = 'needs_human_review'
  RETURNING id, customer_id, chat_id
)
INSERT INTO ai_response_log (
  crm_message_id,
  customer_id,
  chat_id,
  input_text,
  receipt_data,
  reply_text,
  confidence,
  reasoning,
  provider_used,
  tokens_used,
  action_taken,
  error_message
)
SELECT
  a.id,
  a.customer_id,
  a.chat_id,
  NULL,
  NULL,
  NULL,
  NULL,
  (jsonb_build_object(
    'chat_phone', COALESCE(NULLIF(TRIM(ch.phone), ''), ''),
    'archived_reason', 'pre_sprint6a_backlog_cleanup',
    'archived_at', NOW(),
    'archived_by', 'archive-legacy-ai-queue.js',
    'sprint', '6A'
  ))::text,
  'system',
  0,
  'legacy_archived',
  NULL
FROM archived a
LEFT JOIN crm_chats ch ON ch.id = a.chat_id
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL no definida.");
    process.exit(1);
  }

  const { rows: c0 } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE ai_reply_status = 'needs_human_review'`
  );
  const n = c0[0]?.n ?? 0;

  if (n === 0) {
    console.log("Cola vacía · nada para archivar");
    process.exit(0);
  }

  console.log(`Encontrados ${n} mensajes a archivar`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(ARCHIVE_SQL);
    const inserted = ins.rowCount ?? 0;
    if (inserted !== n) {
      throw new Error(`Inconsistencia: esperaba insertar ${n} filas de log, filas=${inserted}`);
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("❌ Rollback:", e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  const { rows: v1 } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE ai_reply_status = 'needs_human_review'`
  );
  const { rows: v2 } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_response_log
     WHERE action_taken = 'legacy_archived'
       AND created_at > NOW() - INTERVAL '5 minutes'`
  );

  const remaining = v1[0]?.n ?? -1;
  const logRecent = v2[0]?.n ?? -1;

  if (remaining !== 0) {
    console.error(`❌ Post-commit: aún hay ${remaining} mensajes en needs_human_review (esperado 0).`);
    process.exit(1);
  }
  if (logRecent !== n) {
    console.error(
      `❌ Post-commit: log legacy_archived reciente=${logRecent}, esperado=${n} (ventana 5 min).`
    );
    process.exit(1);
  }

  console.log(
    `✅ Archivados ${n} mensajes · log registró ${n} filas · cola needs_human_review = 0`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
