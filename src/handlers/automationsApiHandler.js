"use strict";

/**
 * API JWT para logs y configuración de mensajes automáticos (ML / Wasender / IA preguntas).
 * Auth: requireAdminOrPermission(..., 'settings').
 *
 * Esquema real: `ml_message_kind_send_log` → created_at, outcome, detail;
 * `ml_whatsapp_wasender_log` → message_kind E|F; tipo H CRM = F + tipo_e_activation_source = tipo_h_crm_wa_welcome.
 */

const pino = require("pino");
const { pool, ensureSchema } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { isEnabled: isAiResponderTipoMEnabled } = require("../services/aiResponder");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "automations_api" });

const CRM_TIPO_H_SOURCE = "tipo_h_crm_wa_welcome";

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseLimitOffset(url) {
  const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const off = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  return { limit: lim, offset: off };
}

function parseOptionalDate(param) {
  if (param == null || String(param).trim() === "") return null;
  const d = new Date(String(param));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 256 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function mapWaKindDisplay(row) {
  if (row.message_kind === "E") return "E";
  if (row.message_kind === "F" && row.tipo_e_activation_source === CRM_TIPO_H_SOURCE) return "H";
  return "F";
}

async function getCaracasDayBounds() {
  const { rows } = await pool.query(`
    SELECT
      ((date_trunc('day', (now() AT TIME ZONE 'America/Caracas')))::timestamp)
        AT TIME ZONE 'America/Caracas' AS day_start,
      (((date_trunc('day', (now() AT TIME ZONE 'America/Caracas')))::timestamp)
        + interval '1 day') AT TIME ZONE 'America/Caracas' AS day_end
  `);
  return rows[0] || { day_start: null, day_end: null };
}

async function getCaracasMonthBounds() {
  const { rows } = await pool.query(`
    SELECT
      ((date_trunc('month', (now() AT TIME ZONE 'America/Caracas')))::timestamp)
        AT TIME ZONE 'America/Caracas' AS month_start,
      (((date_trunc('month', (now() AT TIME ZONE 'America/Caracas')))::timestamp
        + interval '1 month') AT TIME ZONE 'America/Caracas') AS month_end
  `);
  return rows[0] || { month_start: null, month_end: null };
}

async function buildMlKindStats(rangeStart, rangeEnd) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE message_kind = 'A')::bigint AS a,
      COUNT(*) FILTER (WHERE message_kind = 'B')::bigint AS b,
      COUNT(*) FILTER (WHERE message_kind = 'C')::bigint AS c
    FROM ml_message_kind_send_log
    WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  `,
    [rangeStart, rangeEnd]
  );
  const r = rows[0] || {};
  const a = Number(r.a || 0);
  const b = Number(r.b || 0);
  const c = Number(r.c || 0);
  return { a, b, c, total: a + b + c };
}

async function buildWhatsappStats(rangeStart, rangeEnd) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE message_kind = 'E')::bigint AS e,
      COUNT(*) FILTER (WHERE message_kind = 'F' AND (tipo_e_activation_source IS DISTINCT FROM $3 OR tipo_e_activation_source IS NULL))::bigint AS f,
      COUNT(*) FILTER (WHERE message_kind = 'F' AND tipo_e_activation_source = $3)::bigint AS h
    FROM ml_whatsapp_wasender_log
    WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  `,
    [rangeStart, rangeEnd, CRM_TIPO_H_SOURCE]
  );
  const r = rows[0] || {};
  const e = Number(r.e || 0);
  const f = Number(r.f || 0);
  const h = Number(r.h || 0);
  return { e, f, h, total: e + f + h };
}

async function buildQuestionsIaStats(rangeStart, rangeEnd) {
  const { rows: sentRows } = await pool.query(
    `
    SELECT COUNT(*)::bigint AS c FROM ml_questions_ia_auto_sent
    WHERE sent_at >= $1::timestamptz AND sent_at < $2::timestamptz
  `,
    [rangeStart, rangeEnd]
  );
  const { rows: logRows } = await pool.query(
    `
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE outcome IN ('api_error', 'exception'))::bigint AS failed
    FROM ml_questions_ia_auto_log
    WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  `,
    [rangeStart, rangeEnd]
  );
  const sent = Number(sentRows[0]?.c || 0);
  const failed = Number(logRows[0]?.failed || 0);
  const total = Number(logRows[0]?.total || 0);
  return { sent, failed, total };
}

async function buildPostSaleStats(rangeStart, rangeEnd) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE outcome = 'success')::bigint AS sent,
      COUNT(*) FILTER (WHERE outcome = 'api_error')::bigint AS failed
    FROM ml_post_sale_auto_send_log
    WHERE created_at::timestamptz >= $1::timestamptz AND created_at::timestamptz < $2::timestamptz
  `,
    [rangeStart, rangeEnd]
  );
  const r = rows[0] || {};
  return {
    sent: Number(r.sent || 0),
    failed: Number(r.failed || 0),
    total: Number(r.total || 0),
  };
}

async function loadActiveConfigs() {
  let qiaRows = [];
  try {
    const r = await pool.query(`SELECT 1 FROM question_ia_auto_settings LIMIT 1`);
    qiaRows = r.rows;
  } catch {
    qiaRows = [];
  }

  const [ps, te, tf, air] = await Promise.all([
    pool
      .query(
        `SELECT COUNT(*)::int AS c FROM post_sale_messages WHERE COALESCE(is_active, TRUE) = TRUE`
      )
      .catch(() => ({ rows: [{ c: 0 }] })),
    pool.query(`SELECT 1 FROM ml_whatsapp_tipo_e_config WHERE id = 1 LIMIT 1`).catch(() => ({ rows: [] })),
    pool.query(`SELECT 1 FROM ml_whatsapp_tipo_f_config WHERE id = 1 LIMIT 1`).catch(() => ({ rows: [] })),
    Promise.resolve({ rows: [{ ok: isAiResponderTipoMEnabled() ? 1 : 0 }] }),
  ]);

  return {
    post_sale: Number(ps.rows[0]?.c || 0) > 0,
    tipo_e: te.rows.length > 0,
    tipo_f: tf.rows.length > 0,
    questions_ia: qiaRows.length > 0,
    ai_responder: air.rows[0]?.ok === 1,
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleAutomationsApiRequest(req, res, url) {
  const path = url.pathname || "";
  if (!path.startsWith("/api/automations")) return false;

  const user = await requireAdminOrPermission(req, res, "settings");
  if (!user) return true;

  try {
    await ensureSchema();
    if (req.method === "GET" && path === "/api/automations/logs/ml") {
      const { limit, offset } = parseLimitOffset(url);
      const kindRaw = (url.searchParams.get("kind") || "").trim().toLowerCase();
      const kind =
        kindRaw === "a" || kindRaw === "b" || kindRaw === "c" ? kindRaw.toUpperCase() : null;
      const from = parseOptionalDate(url.searchParams.get("from"));
      const to = parseOptionalDate(url.searchParams.get("to"));

      const cond = ["TRUE"];
      const params = [];
      if (kind) {
        params.push(kind);
        cond.push(`l.message_kind = $${params.length}`);
      }
      if (from) {
        params.push(from.toISOString());
        cond.push(`l.created_at >= $${params.length}::timestamptz`);
      }
      if (to) {
        params.push(to.toISOString());
        cond.push(`l.created_at <= $${params.length}::timestamptz`);
      }
      const where = cond.join(" AND ");
      const countParams = [...params];
      const { rows: cr } = await pool.query(
        `SELECT COUNT(*)::bigint AS c FROM ml_message_kind_send_log l WHERE ${where}`,
        countParams
      );
      const total = Number(cr[0]?.c || 0);

      const listParams = [...params, limit, offset];
      const { rows: logs } = await pool.query(
        `
        SELECT
          l.id,
          l.message_kind,
          l.order_id AS ml_order_id,
          l.buyer_id AS ml_buyer_id,
          l.outcome AS status,
          l.created_at AS sent_at,
          COALESCE(l.detail, l.skip_reason) AS error_message,
          0::int AS retry_count,
          NULL::text AS template_used
        FROM ml_message_kind_send_log l
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `,
        listParams
      );

      writeJson(res, 200, {
        data: { logs, pagination: { total, limit, offset } },
      });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/logs/whatsapp") {
      const { limit, offset } = parseLimitOffset(url);
      const kindRaw = (url.searchParams.get("kind") || "all").trim().toLowerCase();
      const from = parseOptionalDate(url.searchParams.get("from"));
      const to = parseOptionalDate(url.searchParams.get("to"));

      const cond = ["TRUE"];
      const params = [];

      if (kindRaw === "e") {
        cond.push(`l.message_kind = 'E'`);
      } else if (kindRaw === "f") {
        params.push(CRM_TIPO_H_SOURCE);
        cond.push(
          `(l.message_kind = 'F' AND (l.tipo_e_activation_source IS DISTINCT FROM $${params.length} OR l.tipo_e_activation_source IS NULL))`
        );
      } else if (kindRaw === "h") {
        params.push(CRM_TIPO_H_SOURCE);
        cond.push(`l.message_kind = 'F' AND l.tipo_e_activation_source = $${params.length}`);
      }

      if (from) {
        params.push(from.toISOString());
        cond.push(`l.created_at >= $${params.length}::timestamptz`);
      }
      if (to) {
        params.push(to.toISOString());
        cond.push(`l.created_at <= $${params.length}::timestamptz`);
      }

      const where = cond.join(" AND ");
      const countParams = [...params];
      const { rows: cr } = await pool.query(
        `SELECT COUNT(*)::bigint AS c FROM ml_whatsapp_wasender_log l WHERE ${where}`,
        countParams
      );
      const total = Number(cr[0]?.c || 0);

      const listParams = [...params, limit, offset];
      const { rows: rawLogs } = await pool.query(
        `
        SELECT
          l.id,
          l.message_kind,
          l.phone_e164,
          l.order_id,
          l.outcome,
          l.created_at,
          l.error_message,
          l.wasender_msg_id,
          l.tipo_e_activation_source
        FROM ml_whatsapp_wasender_log l
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `,
        listParams
      );

      const logs = rawLogs.map((row) => ({
        id: row.id,
        message_kind: mapWaKindDisplay(row),
        phone_number: row.phone_e164,
        ml_order_id: row.order_id,
        status: row.outcome,
        sent_at: row.created_at,
        error_message: row.error_message,
        wasender_message_id: row.wasender_msg_id,
      }));

      writeJson(res, 200, {
        data: { logs, pagination: { total, limit, offset } },
      });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/logs/questions-ia") {
      const { limit, offset } = parseLimitOffset(url);
      const statusFilter = (url.searchParams.get("status") || "").trim();
      const from = parseOptionalDate(url.searchParams.get("from"));
      const to = parseOptionalDate(url.searchParams.get("to"));

      const cond = ["TRUE"];
      const params = [];
      if (statusFilter) {
        params.push(statusFilter);
        cond.push(`l.outcome = $${params.length}`);
      }
      if (from) {
        params.push(from.toISOString());
        cond.push(`l.created_at >= $${params.length}::timestamptz`);
      }
      if (to) {
        params.push(to.toISOString());
        cond.push(`l.created_at <= $${params.length}::timestamptz`);
      }
      const where = cond.join(" AND ");
      const countParams = [...params];
      const { rows: cr } = await pool.query(
        `SELECT COUNT(*)::bigint AS c FROM ml_questions_ia_auto_log l WHERE ${where}`,
        countParams
      );
      const total = Number(cr[0]?.c || 0);

      const listParams = [...params, limit, offset];
      const { rows: logs } = await pool.query(
        `
        SELECT
          l.id,
          l.ml_question_id,
          l.item_id,
          NULL::text AS question_text,
          NULL::text AS answer_text,
          l.outcome AS status,
          l.created_at AS sent_at,
          l.reason_detail AS error_message,
          NULL::text AS template_used
        FROM ml_questions_ia_auto_log l
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `,
        listParams
      );

      writeJson(res, 200, {
        data: { logs, pagination: { total, limit, offset } },
      });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/stats") {
      const day = await getCaracasDayBounds();
      const month = await getCaracasMonthBounds();
      const active_configs = await loadActiveConfigs();

      const [todayMl, monthMl, todayWa, monthWa, todayQ, monthQ, todayPs, monthPs] = await Promise.all([
        buildMlKindStats(day.day_start, day.day_end),
        buildMlKindStats(month.month_start, month.month_end),
        buildWhatsappStats(day.day_start, day.day_end),
        buildWhatsappStats(month.month_start, month.month_end),
        buildQuestionsIaStats(day.day_start, day.day_end),
        buildQuestionsIaStats(month.month_start, month.month_end),
        buildPostSaleStats(day.day_start, day.day_end),
        buildPostSaleStats(month.month_start, month.month_end),
      ]);

      writeJson(res, 200, {
        data: {
          today: {
            ml_messages: todayMl,
            whatsapp_messages: todayWa,
            questions_ia: todayQ,
            post_sale: todayPs,
          },
          month: {
            ml_messages: monthMl,
            whatsapp_messages: monthWa,
            questions_ia: monthQ,
            post_sale: monthPs,
          },
          active_configs,
        },
      });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/config/post-sale") {
      const { rows } = await pool.query(`
        SELECT
          id,
          COALESCE(message_order, id) AS message_order,
          body AS message_text,
          COALESCE(is_active, TRUE) AS is_active,
          created_at
        FROM post_sale_messages
        ORDER BY COALESCE(message_order, id) ASC
      `);
      writeJson(res, 200, { data: { messages: rows } });
      return true;
    }

    const patchPostSale = path.match(/^\/api\/automations\/config\/post-sale\/(\d+)$/);
    if (req.method === "PATCH" && patchPostSale) {
      const id = Number(patchPostSale[1]);
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        writeJson(res, 400, { error: "invalid_json", message: e.message });
        return true;
      }
      const sets = [];
      const vals = [];
      if (body.message_text != null) {
        vals.push(String(body.message_text));
        sets.push(`body = $${vals.length}`);
      }
      if (body.is_active != null) {
        vals.push(Boolean(body.is_active));
        sets.push(`is_active = $${vals.length}`);
      }
      if (sets.length === 0) {
        writeJson(res, 400, { error: "validation", message: "message_text o is_active requeridos" });
        return true;
      }
      vals.push(new Date().toISOString());
      sets.push(`updated_at = $${vals.length}`);
      vals.push(id);
      const idParam = vals.length;
      const { rows } = await pool.query(
        `UPDATE post_sale_messages SET ${sets.join(", ")} WHERE id = $${idParam}
         RETURNING id, COALESCE(message_order, id) AS message_order, body AS message_text,
                   COALESCE(is_active, TRUE) AS is_active, created_at, updated_at`,
        vals
      );
      if (!rows[0]) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, message: rows[0] });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/config/tipo-e") {
      const { rows } = await pool.query(`SELECT * FROM ml_whatsapp_tipo_e_config WHERE id = 1 LIMIT 1`);
      writeJson(res, 200, { data: { config: rows[0] || null } });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/config/tipo-f") {
      const { rows } = await pool.query(`SELECT * FROM ml_whatsapp_tipo_f_config WHERE id = 1 LIMIT 1`);
      writeJson(res, 200, { data: { config: rows[0] || null } });
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/config/questions-ia") {
      try {
        const { rows } = await pool.query(`SELECT * FROM question_ia_auto_settings LIMIT 1`);
        writeJson(res, 200, { data: { config: rows[0] || null } });
      } catch (e) {
        if (String(e.message || "").includes("question_ia_auto_settings")) {
          writeJson(res, 200, { data: { config: null } });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "GET" && path === "/api/automations/config/wasender") {
      const { rows } = await pool.query(`SELECT * FROM ml_wasender_settings WHERE id = 1 LIMIT 1`);
      const row = rows[0];
      const hasApiKeyEnv = Boolean(
        process.env.WASENDER_API_KEY && String(process.env.WASENDER_API_KEY).trim()
      );
      const hasTokenEnv = Boolean(
        process.env.WASENDER_API_TOKEN && String(process.env.WASENDER_API_TOKEN).trim()
      );
      const hasKeyCol = row && row.api_key != null && String(row.api_key).trim() !== "";
      const hasTokCol = row && row.token != null && String(row.token).trim() !== "";
      writeJson(res, 200, {
        data: {
          configured: Boolean(row),
          phone_number: null,
          has_api_key: hasApiKeyEnv || hasKeyCol,
          has_token: hasTokenEnv || hasTokCol,
        },
      });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    log.error({ err: e.message }, "automations_api");
    writeJson(res, 500, { error: "internal_error", message: e.message });
    return true;
  }
}

module.exports = { handleAutomationsApiRequest };
