"use strict";

require("../../load-env-local");
const pino = require("pino");
const { pool } = require("../../db");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "checkPendingRatings" });

async function checkPendingRatings() {
  const deadlineHours = Math.max(1, parseInt(process.env.ALERT_WARNING_HOURS || "24", 10) || 24);

  const { rows: nearDeadline } = await pool.query(
    `SELECT
        so.id, so.status, so.lifecycle_status, so.created_at, so.rating_deadline_at,
        c.full_name AS customer_name,
        EXTRACT(EPOCH FROM (so.rating_deadline_at - NOW())) / 3600 AS hours_remaining
     FROM sales_orders so
     LEFT JOIN customers c ON c.id = so.customer_id
     WHERE so.source = 'mercadolibre'
       AND (so.lifecycle_status IS NULL OR so.lifecycle_status NOT IN ('archivado', 'anulada'))
       AND so.rating_deadline_at IS NOT NULL
       AND so.rating_deadline_at <= NOW() + ($1::text || ' hours')::interval
       AND so.rating_deadline_at > NOW()
       AND so.is_rating_alert = FALSE
     ORDER BY so.rating_deadline_at ASC`,
    [String(deadlineHours)]
  );

  const { rows: overdue } = await pool.query(
    `SELECT id, status, lifecycle_status, rating_deadline_at
     FROM sales_orders
     WHERE source = 'mercadolibre'
       AND (lifecycle_status IS NULL OR lifecycle_status NOT IN ('archivado', 'anulada'))
       AND rating_deadline_at IS NOT NULL
       AND rating_deadline_at < NOW()
     ORDER BY rating_deadline_at ASC`
  );

  if (nearDeadline.length) {
    const ids = nearDeadline.map((r) => r.id);
    await pool.query(`UPDATE sales_orders SET is_rating_alert = TRUE WHERE id = ANY($1::bigint[])`, [ids]);
  }

  log.info(
    {
      near_deadline_count: nearDeadline.length,
      overdue_count: overdue.length,
      near_deadline: nearDeadline.map((r) => ({
        order_id: r.id,
        customer: r.customer_name,
        hours_remaining: r.hours_remaining != null ? Math.round(Number(r.hours_remaining) * 10) / 10 : null,
      })),
      overdue_ids: overdue.map((r) => r.id),
    },
    "checkPendingRatings completado"
  );

  return { nearDeadline, overdue };
}

if (require.main === module) {
  checkPendingRatings()
    .then((result) => {
      console.log(
        `Alertas: ${result.nearDeadline.length} próximas a marcar, ${result.overdue.length} vencidas`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error en job:", err);
      process.exit(1);
    });
}

module.exports = { checkPendingRatings };
