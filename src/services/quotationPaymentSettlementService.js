"use strict";

/**
 * Cierre de pago sobre cotización (bimoneda mixto).
 * - Piernas en quotation_payment_allocations (VES inmediato; USD con usd_caja_status).
 * - Cierre: suma de cobertura en USD equivalente >= total cotización (±0,5 %) y sin USD pendiente/rechazado.
 */

const { pool } = require("../../db");
const { getTodayRate } = require("./currencyService");

const DEFAULT_COMPANY_ID = 1;

/** Mínimo en Bs al comparar comprobante / extracto Banesco / total cotización (redondeos distintos). */
const MIN_QUOTE_PAYMENT_TOLERANCE_BS = 100;

/** Evita consultar `information_schema` en cada cotización del listado inbox. */
let _allocationTableExistsCache = null;

/** @param {number} totalUsd */
function toleranceUsd(totalUsd) {
  const t = Math.abs(Number(totalUsd) || 0);
  return Math.max(0.01, t * 0.005);
}

/**
 * Tolerancia en Bs: al menos {@link MIN_QUOTE_PAYMENT_TOLERANCE_BS} VES y además 0,5 % del monto de referencia.
 * Usar al comparar `payment_attempts` / `bank_statements` con total cotización en bolívares.
 * @param {number|null|undefined} referenceBs
 * @returns {number}
 */
function toleranceBsForQuotationPayment(referenceBs) {
  const b = Math.abs(Number(referenceBs) || 0);
  return Math.max(MIN_QUOTE_PAYMENT_TOLERANCE_BS, b * 0.005);
}

/**
 * @param {import('pg').PoolClient | null} client
 * @returns {Promise<boolean>}
 */
async function allocationTableExists(client) {
  if (_allocationTableExistsCache !== null) return _allocationTableExistsCache;
  const q = client || pool;
  const { rows } = await q.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'quotation_payment_allocations'
      LIMIT 1`
  );
  _allocationTableExistsCache = rows.length > 0;
  return _allocationTableExistsCache;
}

/**
 * Si hay comprobantes matched a la cotización pero aún no hay filas de imputación, crea piernas VES (idempotente).
 * @param {import('pg').PoolClient} [client]
 * @param {number} quotationId
 */
async function hydrateLegacyMatchedAttempts(client, quotationId) {
  if (!(await allocationTableExists(client))) return;
  const q = client || pool;
  const rateRow = await getTodayRate(DEFAULT_COMPANY_ID).catch(() => null);
  const rate =
    rateRow && Number(rateRow.active_rate) > 0 ? Number(rateRow.active_rate) : null;
  if (!rate) return;
  await q.query(
    `INSERT INTO quotation_payment_allocations (
       quotation_id, payment_attempt_id, source_currency,
       amount_original, amount_usd_equivalent, fx_rate_bs_per_usd, usd_caja_status
     )
     SELECT
       pa.reconciled_quotation_id,
       pa.id,
       'VES',
       pa.extracted_amount_bs,
       ROUND((pa.extracted_amount_bs / $2::numeric)::numeric, 6),
       $2::numeric,
       NULL
     FROM payment_attempts pa
     WHERE pa.reconciled_quotation_id = $1
       AND pa.reconciliation_status = 'matched'
       AND pa.extracted_amount_bs IS NOT NULL
       AND pa.extracted_amount_bs > 0
       AND NOT EXISTS (
         SELECT 1 FROM quotation_payment_allocations x
         WHERE x.payment_attempt_id = pa.id AND x.quotation_id = pa.reconciled_quotation_id
       )`,
    [quotationId, rate]
  );
}

/**
 * Hidrata piernas VES legacy para varias cotizaciones en un solo `getTodayRate` + INSERT.
 * @param {import('pg').PoolClient | null} client
 * @param {number[]} quotationIds
 */
async function hydrateLegacyMatchedAttemptsBatch(client, quotationIds) {
  if (!(await allocationTableExists(client))) return;
  const q = client || pool;
  const ids = [...new Set(quotationIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return;
  const rateRow = await getTodayRate(DEFAULT_COMPANY_ID).catch(() => null);
  const rate =
    rateRow && Number(rateRow.active_rate) > 0 ? Number(rateRow.active_rate) : null;
  if (!rate) return;
  await q.query(
    `INSERT INTO quotation_payment_allocations (
       quotation_id, payment_attempt_id, source_currency,
       amount_original, amount_usd_equivalent, fx_rate_bs_per_usd, usd_caja_status
     )
     SELECT
       pa.reconciled_quotation_id,
       pa.id,
       'VES',
       pa.extracted_amount_bs,
       ROUND((pa.extracted_amount_bs / $2::numeric)::numeric, 6),
       $2::numeric,
       NULL
     FROM payment_attempts pa
     WHERE pa.reconciled_quotation_id = ANY($1::bigint[])
       AND pa.reconciliation_status = 'matched'
       AND pa.extracted_amount_bs IS NOT NULL
       AND pa.extracted_amount_bs > 0
       AND NOT EXISTS (
         SELECT 1 FROM quotation_payment_allocations x
         WHERE x.payment_attempt_id = pa.id AND x.quotation_id = pa.reconciled_quotation_id
       )`,
    [ids, rate]
  );
}

/**
 * @param {import('pg').PoolClient | null} client
 * @param {number} quotationId
 * @returns {Promise<object>}
 */
async function getSettlementState(quotationId, client) {
  const q = client || pool;
  const tbl = await allocationTableExists(client);
  if (!tbl) {
    const { rows } = await q.query(
      `SELECT 1 AS ok
         FROM payment_attempts pa
        WHERE pa.reconciled_quotation_id = $1
          AND pa.reconciliation_status = 'matched'
        LIMIT 1`,
      [quotationId]
    );
    const legacyMatched = rows.length > 0;
    return {
      schemaAllocations: false,
      coveredUsdEquivalent: 0,
      totalUsd: null,
      toleranceUsd: 0,
      hasPendingUsdCaja: false,
      hasRejectedUsd: false,
      overAllocated: false,
      hasBsReconciledBaseline: legacyMatched,
      /** Sin tabla nueva: se mantiene comportamiento previo (un matched alcanza). */
      fullySettled: legacyMatched,
      anyPaymentProgress: legacyMatched,
    };
  }

  await hydrateLegacyMatchedAttempts(client, quotationId);

  let hasBsReconciledBaseline = false;
  const { rows: vesLeg } = await q.query(
    `SELECT 1 AS ok
       FROM quotation_payment_allocations a
      WHERE a.quotation_id = $1 AND a.source_currency = 'VES'
      LIMIT 1`,
    [quotationId]
  );
  if (vesLeg.length) hasBsReconciledBaseline = true;
  else {
    const { rows: paBs } = await q.query(
      `SELECT 1 AS ok
         FROM payment_attempts pa
        WHERE pa.reconciled_quotation_id = $1
          AND pa.reconciliation_status = 'matched'
          AND pa.extracted_amount_bs IS NOT NULL
          AND pa.extracted_amount_bs > 0
        LIMIT 1`,
      [quotationId]
    );
    if (paBs.length) hasBsReconciledBaseline = true;
  }

  const { rows: head } = await q.query(
    `SELECT total::numeric AS total_usd FROM inventario_presupuesto WHERE id = $1`,
    [quotationId]
  );
  const totalUsd = head.length ? Number(head[0].total_usd) : 0;

  const { rows: allocRows } = await q.query(
    `SELECT source_currency, amount_usd_equivalent::numeric AS eq, usd_caja_status
       FROM quotation_payment_allocations
      WHERE quotation_id = $1`,
    [quotationId]
  );

  let covered = 0;
  let hasPendingUsd = false;
  let hasRejectedUsd = false;
  for (const r of allocRows) {
    const eq = Number(r.eq);
    if (!Number.isFinite(eq) || eq <= 0) continue;
    const cur = String(r.source_currency || "").toUpperCase();
    if (cur === "VES") {
      covered += eq;
    } else if (cur === "USD") {
      const st = r.usd_caja_status;
      if (st === "approved") covered += eq;
      else if (st === "pending" || st == null) hasPendingUsd = true;
      else if (st === "rejected") hasRejectedUsd = true;
    }
  }

  const tol = toleranceUsd(totalUsd);
  const covers = covered >= totalUsd - tol;
  const overAllocated = covered > totalUsd + tol;
  const fullySettled =
    allocRows.length > 0 &&
    covers &&
    !hasPendingUsd &&
    !hasRejectedUsd &&
    !overAllocated;

  const { rows: prog } = await q.query(
    `SELECT 1 AS ok
       FROM payment_attempts pa
      WHERE pa.reconciled_quotation_id = $1
        AND pa.reconciliation_status = 'matched'
      LIMIT 1`,
    [quotationId]
  );

  return {
    schemaAllocations: true,
    coveredUsdEquivalent: covered,
    totalUsd,
    toleranceUsd: tol,
    hasPendingUsdCaja: hasPendingUsd,
    hasRejectedUsd,
    overAllocated,
    hasBsReconciledBaseline,
    fullySettled,
    anyPaymentProgress: allocRows.length > 0 || prog.length > 0,
  };
}

/**
 * Mismo criterio que `getSettlementState` pero en pocas idas a BD (listados inbox).
 * @param {number[]} quotationIds
 * @param {import('pg').PoolClient | null} client
 * @returns {Promise<Map<number, object>>}
 */
async function getSettlementStatesForQuotationIds(quotationIds, client) {
  const q = client || pool;
  const ids = [...new Set(quotationIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  /** @type {Map<number, object>} */
  const map = new Map();
  if (!ids.length) return map;

  const tbl = await allocationTableExists(client);

  if (!tbl) {
    const { rows } = await q.query(
      `SELECT DISTINCT pa.reconciled_quotation_id AS qid
         FROM payment_attempts pa
        WHERE pa.reconciled_quotation_id = ANY($1::bigint[])
          AND pa.reconciliation_status = 'matched'`,
      [ids]
    );
    const matchedSet = new Set(rows.map((r) => Number(r.qid)));
    for (const id of ids) {
      const legacyMatched = matchedSet.has(id);
      map.set(id, {
        schemaAllocations: false,
        coveredUsdEquivalent: 0,
        totalUsd: null,
        toleranceUsd: 0,
        hasPendingUsdCaja: false,
        hasRejectedUsd: false,
        overAllocated: false,
        hasBsReconciledBaseline: legacyMatched,
        fullySettled: legacyMatched,
        anyPaymentProgress: legacyMatched,
      });
    }
    return map;
  }

  await hydrateLegacyMatchedAttemptsBatch(client, ids);

  const { rows: bsRows } = await q.query(
    `SELECT DISTINCT a.quotation_id AS qid
       FROM quotation_payment_allocations a
      WHERE a.quotation_id = ANY($1::bigint[]) AND a.source_currency = 'VES'
     UNION
     SELECT DISTINCT pa.reconciled_quotation_id AS qid
       FROM payment_attempts pa
      WHERE pa.reconciled_quotation_id = ANY($1::bigint[])
        AND pa.reconciliation_status = 'matched'
        AND pa.extracted_amount_bs IS NOT NULL AND pa.extracted_amount_bs > 0`,
    [ids]
  );
  const hasBsSet = new Set(bsRows.map((r) => Number(r.qid)));

  const { rows: heads } = await q.query(
    `SELECT id, total::numeric AS total_usd FROM inventario_presupuesto WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  const totalById = new Map(heads.map((h) => [Number(h.id), Number(h.total_usd) || 0]));

  const { rows: allocRows } = await q.query(
    `SELECT quotation_id, source_currency, amount_usd_equivalent::numeric AS eq, usd_caja_status
       FROM quotation_payment_allocations
      WHERE quotation_id = ANY($1::bigint[])`,
    [ids]
  );
  /** @type {Map<number, Array<{ source_currency: string, eq: string, usd_caja_status: string|null }>>} */
  const allocByQid = new Map();
  for (const id of ids) allocByQid.set(id, []);
  for (const r of allocRows) {
    const qid = Number(r.quotation_id);
    if (!allocByQid.has(qid)) allocByQid.set(qid, []);
    allocByQid.get(qid).push(r);
  }

  const { rows: progRows } = await q.query(
    `SELECT DISTINCT pa.reconciled_quotation_id AS qid
       FROM payment_attempts pa
      WHERE pa.reconciled_quotation_id = ANY($1::bigint[])
        AND pa.reconciliation_status = 'matched'`,
    [ids]
  );
  const progSet = new Set(progRows.map((r) => Number(r.qid)));

  for (const id of ids) {
    const totalUsd = totalById.has(id) ? totalById.get(id) : 0;
    const rowsFor = allocByQid.get(id) || [];
    let covered = 0;
    let hasPendingUsd = false;
    let hasRejectedUsd = false;
    for (const r of rowsFor) {
      const eq = Number(r.eq);
      if (!Number.isFinite(eq) || eq <= 0) continue;
      const cur = String(r.source_currency || "").toUpperCase();
      if (cur === "VES") {
        covered += eq;
      } else if (cur === "USD") {
        const st = r.usd_caja_status;
        if (st === "approved") covered += eq;
        else if (st === "pending" || st == null) hasPendingUsd = true;
        else if (st === "rejected") hasRejectedUsd = true;
      }
    }
    const tol = toleranceUsd(totalUsd);
    const covers = covered >= totalUsd - tol;
    const overAllocated = covered > totalUsd + tol;
    const fullySettled =
      rowsFor.length > 0 && covers && !hasPendingUsd && !hasRejectedUsd && !overAllocated;
    const hasBsReconciledBaseline = hasBsSet.has(id);

    map.set(id, {
      schemaAllocations: true,
      coveredUsdEquivalent: covered,
      totalUsd,
      toleranceUsd: tol,
      hasPendingUsdCaja: hasPendingUsd,
      hasRejectedUsd,
      overAllocated,
      hasBsReconciledBaseline,
      fullySettled,
      anyPaymentProgress: rowsFor.length > 0 || progSet.has(id),
    });
  }
  return map;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {object} p
 * @param {number} p.quotationId
 * @param {number} p.paymentAttemptId
 * @param {'VES'|'USD'} p.sourceCurrency
 * @param {number} p.amountOriginal
 * @param {number} p.fxRateBsPerUsd  tasa Bs/USD (solo VES)
 * @param {number|null} p.userId
 */
async function insertAllocation(client, p) {
  const {
    quotationId,
    paymentAttemptId,
    sourceCurrency,
    amountOriginal,
    fxRateBsPerUsd,
    userId,
  } = p;
  const cur = sourceCurrency === "USD" ? "USD" : "VES";
  let usdEq;
  let cajaStatus;
  if (cur === "VES") {
    if (!fxRateBsPerUsd || !Number.isFinite(Number(fxRateBsPerUsd)) || Number(fxRateBsPerUsd) <= 0) {
      throw Object.assign(new Error("fx_rate_invalid"), { code: "FX_RATE_INVALID" });
    }
    usdEq = Number(amountOriginal) / Number(fxRateBsPerUsd);
    cajaStatus = null;
  } else {
    usdEq = Number(amountOriginal);
    cajaStatus = "pending";
  }
  if (!Number.isFinite(usdEq) || usdEq <= 0) {
    throw Object.assign(new Error("amount_invalid"), { code: "AMOUNT_INVALID" });
  }
  const { rows } = await client.query(
    `INSERT INTO quotation_payment_allocations (
       quotation_id, payment_attempt_id, source_currency,
       amount_original, amount_usd_equivalent, fx_rate_bs_per_usd,
       usd_caja_status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, ROUND($5::numeric, 6), $6, $7, $8)
     RETURNING id`,
    [
      quotationId,
      paymentAttemptId,
      cur,
      amountOriginal,
      usdEq,
      cur === "VES" ? fxRateBsPerUsd : null,
      cajaStatus,
      userId != null && Number.isFinite(Number(userId)) ? Number(userId) : null,
    ]
  );
  return rows[0].id;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} quotationId
 */
async function assertAllocationTotalsWithinTolerance(client, quotationId) {
  const st = await getSettlementState(quotationId, client);
  if (st.overAllocated) {
    const err = new Error("La suma imputada supera el total de la cotización (fuera de tolerancia).");
    err.code = "OVER_ALLOCATED";
    throw err;
  }
}

/**
 * Complemento en USD registrado y aprobado por caja (sin comprobante WA), suma al cierre bimoneda.
 * @param {import('pg').PoolClient} client
 * @param {{ quotationId: number, amountUsd: number, userId: number|null, notes?: string|null }} p
 */
async function insertCajaApprovedUsdComplement(client, p) {
  const { quotationId, amountUsd, userId, notes } = p;
  const amt = Number(amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error("Monto USD inválido.");
    err.code = "AMOUNT_INVALID";
    throw err;
  }
  const uid = userId != null && Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : null;
  const { rows } = await client.query(
    `INSERT INTO quotation_payment_allocations (
       quotation_id, payment_attempt_id, source_currency,
       amount_original, amount_usd_equivalent, fx_rate_bs_per_usd,
       usd_caja_status, caja_approved_by, caja_approved_at, created_by_user_id, notes
     ) VALUES ($1, NULL, 'USD', $2, ROUND($2::numeric, 6), NULL,
               'approved', $3, NOW(), $3, $4)
     RETURNING id`,
    [quotationId, amt, uid, notes != null && String(notes).trim() !== "" ? String(notes).trim().slice(0, 500) : null]
  );
  return rows[0].id;
}

module.exports = {
  allocationTableExists,
  toleranceUsd,
  toleranceBsForQuotationPayment,
  getSettlementState,
  getSettlementStatesForQuotationIds,
  hydrateLegacyMatchedAttempts,
  insertAllocation,
  insertCajaApprovedUsdComplement,
  assertAllocationTotalsWithinTolerance,
  DEFAULT_COMPANY_ID,
};
