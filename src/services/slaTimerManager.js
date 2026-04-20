"use strict";

const sseBroker = require("../realtime/sseBroker");

/** @type {Map<number, { tid: NodeJS.Timeout, expectedDeadlineMs: number }>} */
const timers = new Map();

// MULTI-INSTANCIA: si se escala Render horizontal, mover a Redis + SET NX lock. Hoy single-process, OK.

const { pool } = require("../../db");

function cancel(chatId) {
  const cid = Number(chatId);
  const entry = timers.get(cid);
  if (!entry) return;
  clearTimeout(entry.tid);
  timers.delete(cid);
}

function schedule(chatId, deadlineAt) {
  const cid = Number(chatId);
  cancel(cid);

  const dl = deadlineAt instanceof Date ? deadlineAt : new Date(deadlineAt);
  const expectedDeadlineMs = dl.getTime();
  if (!Number.isFinite(expectedDeadlineMs)) return;

  const delay = Math.max(0, expectedDeadlineMs - Date.now());
  const tid = setTimeout(() => {
    timers.delete(cid);
    onExpire(cid, expectedDeadlineMs).catch((e) => {
      console.error("[sla] onExpire failed", e);
    });
  }, delay);

  timers.set(cid, { tid, expectedDeadlineMs });
}

/**
 * @param {number} chatId
 * @param {number} expectedDeadlineMs
 */
async function onExpire(chatId, expectedDeadlineMs) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status, sla_deadline_at, assigned_to
       FROM crm_chats
       WHERE id = $1
       FOR UPDATE`,
      [chatId]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return;
    }
    const row = rows[0];
    if (row.status !== "PENDING_RESPONSE") {
      await client.query("ROLLBACK");
      return;
    }
    const dbDl = row.sla_deadline_at ? new Date(row.sla_deadline_at).getTime() : null;
    if (dbDl !== expectedDeadlineMs) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE crm_chats
       SET status = 'UNASSIGNED',
           assigned_to = NULL,
           sla_deadline_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [chatId]
    );
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }

  sseBroker.broadcast("urgent_alert", { chat_id: chatId, reason: "sla_expired" });
  sseBroker.broadcast("chat_released", { chat_id: chatId });
}

/**
 * @param {import('pg').Pool} pgPool
 */
async function rehydrateOnBoot(pgPool) {
  const p = pgPool || pool;
  const { rows } = await p.query(
    `SELECT id, sla_deadline_at
     FROM crm_chats
     WHERE status = 'PENDING_RESPONSE'
       AND sla_deadline_at IS NOT NULL`
  );
  for (const r of rows) {
    const id = Number(r.id);
    if (!r.sla_deadline_at) continue;
    schedule(id, new Date(r.sla_deadline_at));
  }
}

module.exports = {
  schedule,
  cancel,
  onExpire,
  rehydrateOnBoot,
};
