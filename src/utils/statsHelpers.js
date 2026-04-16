"use strict";

/**
 * Helpers para el módulo Analytics ERP/CRM.
 * fillGaps  — rellena días sin datos con ceros (Recharts necesita arrays continuos)
 * calcChange — variación porcentual entre dos valores
 * calcPct    — porcentaje de un valor sobre un total
 * resolvePeriod — convierte period/from/to en start/end Date
 * buildMeta  — objeto meta unificado para todas las respuestas
 */

// Rellenar días sin datos con ceros
function fillGaps(rows, startDate, endDate, defaultValues = {}) {
  const result = [];
  const map    = new Map(rows.map((r) => [r.date, r]));
  const cursor = new Date(startDate);
  const end    = new Date(endDate);

  while (cursor <= end) {
    const key = cursor.toISOString().split("T")[0];
    result.push(map.get(key) || { date: key, ...defaultValues });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

// Variación porcentual — null si no hay valor anterior
function calcChange(current, previous) {
  if (!previous || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// Porcentaje de valor sobre total, redondeado a 1 decimal
function calcPct(value, total) {
  if (!total || total === 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

// Resolver start/end a partir de period string
function resolvePeriod(period, from, to) {
  const now = new Date();
  const tz  = "America/Caracas";

  switch (period) {
    case "today": {
      const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
      const start    = new Date(todayStr + "T00:00:00-04:00");
      const end      = new Date(start.getTime() + 86400000);
      return { start, end, label: "today" };
    }
    case "week": {
      const start = new Date(now);
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: new Date(now.getTime() + 86400000), label: "week" };
    }
    case "year":
      return {
        start: new Date(now.getFullYear(), 0, 1),
        end:   new Date(now.getFullYear() + 1, 0, 1),
        label: "year",
      };
    case "custom": {
      if (!from || !to) {
        const err = new Error("Se requieren from y to para period=custom");
        err.code   = "MISSING_DATES";
        err.status = 400;
        throw err;
      }
      return { start: new Date(from), end: new Date(to + "T23:59:59"), label: "custom" };
    }
    case "month":
    default:
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end:   new Date(now.getFullYear(), now.getMonth() + 1, 1),
        label: "month",
      };
  }
}

// Meta objeto unificado para todas las respuestas
function buildMeta(startTime, label) {
  return {
    timestamp:    new Date().toISOString(),
    period:       label || "custom",
    generated_ms: Date.now() - startTime,
  };
}

/**
 * Monto equivalente en Bs por fila de `v_sales_unified`:
 * POS (`sales`) = USD × tasa; omnicanal (`sales_orders`) = `order_total_amount` (Bs).
 */
const V_SALES_UNIFIED_BS_AMOUNT =
  "CASE WHEN source_table = 'sales' THEN total_usd * NULLIF(exchange_rate_bs_per_usd, 0) ELSE order_total_amount END";

module.exports = {
  fillGaps,
  calcChange,
  calcPct,
  resolvePeriod,
  buildMeta,
  V_SALES_UNIFIED_BS_AMOUNT,
};
