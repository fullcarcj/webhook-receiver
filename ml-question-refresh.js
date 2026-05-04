/**
 * GET /questions/{id} en nombre del vendedor y alinea ml_questions_pending / ml_questions_answered
 * (p. ej. respuesta manual en ML sin webhook).
 */
const { mercadoLibreFetchForUser } = require("./oauth-token");
const {
  buildQuestionPendingRow,
  buildQuestionAnsweredRow,
  enrichAnsweredRowFromPendingSnapshot,
  isQuestionAnsweredOrClosedStatus,
  isQuestionUnansweredStatus,
} = require("./ml-question-sync");
const {
  pool,
  getMlAccount,
  getMlQuestionPendingByQuestionId,
  listMlQuestionsPending,
  listMlAccounts,
  upsertMlQuestionPending,
  upsertMlQuestionAnswered,
  deleteMlQuestionPending,
} = require("./db");
const {
  getQuestionsIaAutoWindowEvaluation,
  getQuestionsIaAutoWindowArithmeticBreakdown,
  serializeIaAutoPendingRouteDetail,
} = require("./ml-questions-ia-auto");
const { syncAnsweredMlQuestionToCrm } = require("./src/services/mlInboxBridge");
const { syncMlListingForQuestionRow } = require("./src/services/mlQuestionListingSync");

/**
 * ml_user_id que alguna vez procesaron esta pregunta (webhook GET guardado, IA, WA).
 * Sirve para ordenar el probe cuando no hay fila en ml_questions_* pero el vendedor real
 * no coincide con el orden alfabético de ml_accounts.
 * @param {number} qid
 * @returns {Promise<number[]>}
 */
async function hintMlUserIdsForQuestion(qid) {
  const idStr = String(qid);
  const ordered = [];
  const seen = new Set();
  const push = (mlUserId) => {
    const n = Number(mlUserId);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) return;
    seen.add(n);
    ordered.push(n);
  };

  try {
    const { rows } = await pool.query(
      `SELECT ml_user_id
         FROM ml_topic_fetches
        WHERE http_status >= 200 AND http_status < 300
          AND (
            resource ILIKE '%/questions/' || $1::text || '%'
            OR request_path ILIKE '%/questions/' || $1::text || '%'
          )
        ORDER BY id DESC
        LIMIT 25`,
      [idStr]
    );
    for (const r of rows) push(r.ml_user_id);
  } catch {
    /* tabla ausente u otro error: ignorar */
  }

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ml_user_id) ml_user_id
         FROM ml_questions_ia_auto_log
        WHERE ml_question_id = $1 AND ml_user_id IS NOT NULL
        ORDER BY ml_user_id, id DESC
        LIMIT 15`,
      [qid]
    );
    for (const r of rows) push(r.ml_user_id);
  } catch {
    /* ignorar */
  }

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ml_user_id) ml_user_id
         FROM ml_whatsapp_wasender_log
        WHERE ml_question_id = $1 AND ml_user_id IS NOT NULL
        ORDER BY ml_user_id, id DESC
        LIMIT 15`,
      [qid]
    );
    for (const r of rows) push(r.ml_user_id);
  } catch {
    /* ignorar */
  }

  return ordered;
}

/**
 * @param {{ mlQuestionId: number|string, mlUserId?: number|string|null }} args
 * @returns {Promise<object>}
 */
async function refreshMlQuestionFromApi(args) {
  const qid = Number(args && args.mlQuestionId);
  if (!Number.isFinite(qid) || qid <= 0) {
    return { ok: false, error: "ml_question_id numérico requerido" };
  }

  let uid = args.mlUserId != null ? Number(args.mlUserId) : null;
  if (!Number.isFinite(uid) || uid <= 0) {
    const pending = await getMlQuestionPendingByQuestionId(qid);
    if (pending && pending.ml_user_id != null) {
      uid = Number(pending.ml_user_id);
    }
  }

  /** Si no hay pending con ml_user_id, probamos GET /questions/{id} con cada cuenta en ml_accounts hasta que ML devuelva 200 y el id coincida (Bandeja / chat huérfano). */
  let res = null;
  let probeNotes = [];
  let probeAccountsCount = 0;
  let hintedMlUserIds = [];
  let hintedMissingFromAccounts = [];
  if (!Number.isFinite(uid) || uid <= 0) {
    let accounts = [];
    try {
      accounts = await listMlAccounts();
    } catch (e) {
      return {
        ok: false,
        error: `listMlAccounts: ${e && e.message ? String(e.message) : String(e)}`,
      };
    }
    probeAccountsCount = accounts.length;
    const accountIdSet = new Set(accounts.map((a) => Number(a.ml_user_id)));
    hintedMlUserIds = await hintMlUserIdsForQuestion(qid);
    hintedMissingFromAccounts = hintedMlUserIds.filter((id) => !accountIdSet.has(Number(id))).slice(0, 8);
    const hintSet = new Set(hintedMlUserIds.filter((id) => accountIdSet.has(Number(id))));

    const preferUid = Number(process.env.INBOX_ML_QUESTION_SYNC_USER_ID || process.env.ML_USER_ID || "");
    if (accounts.length > 0) {
      accounts.sort((a, b) => {
        const ua = Number(a.ml_user_id);
        const ub = Number(b.ml_user_id);
        const ha = hintSet.has(ua) ? 0 : 1;
        const hb = hintSet.has(ub) ? 0 : 1;
        if (ha !== hb) return ha - hb;
        const pa = Number.isFinite(preferUid) && preferUid > 0 && ua === preferUid ? 0 : 1;
        const pb = Number.isFinite(preferUid) && preferUid > 0 && ub === preferUid ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return ua - ub;
      });
    }
    for (const acc of accounts) {
      const tryUid = Number(acc.ml_user_id);
      if (!Number.isFinite(tryUid) || tryUid <= 0) continue;
      let probe;
      try {
        probe = await mercadoLibreFetchForUser(tryUid, `/questions/${qid}`);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        probeNotes.push({ ml_user_id: tryUid, error: msg.slice(0, 200) });
        continue;
      }
      let data = probe.data;
      if (data != null && typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      const idOk =
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (String(data.id) === String(qid) || Number(data.id) === qid);
      if (probe.ok && idOk) {
        uid = tryUid;
        res = { ...probe, data };
        break;
      }
      let note;
      if (!probe.ok) {
        note = `http_${probe.status}`;
      } else if (!idOk) {
        note = "id_mismatch_or_bad_body";
      } else {
        note = "unexpected";
      }
      const row = { ml_user_id: tryUid, http_status: probe.status, ok: probe.ok, note };
      if (!probe.ok && probe.rawText) {
        row.body_snippet = String(probe.rawText).slice(0, 160);
      }
      probeNotes.push(row);
    }
  }

  if (!Number.isFinite(uid) || uid <= 0) {
    const hintMsg =
      hintedMissingFromAccounts.length > 0
        ? ` En BD hay vendedor(es) asociados a esta pregunta (${hintedMissingFromAccounts.join(
            ", "
          )}) que no están en ml_accounts: agregá OAuth para ese ml_user_id.`
        : hintedMlUserIds.length > 0
          ? " Pistas en BD no coincidieron con cuentas OAuth (revisá tokens)."
          : "";
    return {
      ok: false,
      error:
        probeAccountsCount === 0
          ? "No hay filas en ml_accounts: registrá al menos una cuenta OAuth con refresh_token."
          : `Ninguna cuenta en ml_accounts pudo obtener GET /questions/{id}.${hintMsg} 404 suele indicar token de otro vendedor o pregunta eliminada en ML.`,
      probe_accounts_tried: probeNotes.slice(0, 12),
      ml_accounts_count: probeAccountsCount,
      hinted_ml_user_ids: hintedMlUserIds.slice(0, 15),
      hinted_missing_from_ml_accounts: hintedMissingFromAccounts,
    };
  }

  if (!res) {
    res = await mercadoLibreFetchForUser(uid, `/questions/${qid}`);
  }
  if (!res.ok) {
    const st = res.status;
    /** Pregunta borrada o ya no expuesta: evita fantasmas en ml_questions_pending. */
    if (st === 404 || st === 410) {
      let pendingRowsRemoved = 0;
      try {
        pendingRowsRemoved = await deleteMlQuestionPending(qid);
      } catch (e) {
        return {
          ok: false,
          ml_user_id: uid,
          ml_question_id: qid,
          http_status: st,
          error: (e && e.message) || String(e),
        };
      }
      return {
        ok: true,
        action: "removed_gone",
        ml_user_id: uid,
        ml_question_id: qid,
        http_status: st,
        pending_rows_removed: pendingRowsRemoved,
        note:
          "El recurso ya no existe en la API ML (404/410). Se quitó la fila de ml_questions_pending si existía.",
      };
    }
    return {
      ok: false,
      ml_user_id: uid,
      ml_question_id: qid,
      http_status: st,
      error: (res.rawText || "").slice(0, 800),
    };
  }

  let parsed = res.data;
  if (parsed != null && typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "respuesta GET /questions no es un objeto JSON" };
  }

  const notifId = null;
  const row = buildQuestionPendingRow(parsed, uid, notifId);
  if (!row) {
    return { ok: false, error: "no se pudo interpretar el JSON de la pregunta" };
  }

  const sellerAcc = await getMlAccount(Number(row.ml_user_id));
  const sellerOAuthOk =
    sellerAcc &&
    sellerAcc.refresh_token != null &&
    String(sellerAcc.refresh_token).trim() !== "";
  if (!sellerOAuthOk) {
    return {
      ok: false,
      error: `seller_id=${row.ml_user_id} sin OAuth en ml_accounts (sin refresh_token); no se persiste la pregunta ni el listing.`,
      ml_user_id: row.ml_user_id,
      ml_question_id: qid,
      skipped: "seller_not_in_ml_accounts",
    };
  }

  try {
    await syncMlListingForQuestionRow(row);
  } catch (eList) {
    console.error("[ml-question-refresh] sync listing tras GET pregunta:", eList.message || eList);
  }

  if (isQuestionAnsweredOrClosedStatus(row.ml_status)) {
    const pendingSnap = await getMlQuestionPendingByQuestionId(qid);
    const answeredRow = buildQuestionAnsweredRow(parsed, uid, notifId);
    if (!answeredRow) {
      return { ok: false, error: "no se pudo armar fila answered" };
    }
    enrichAnsweredRowFromPendingSnapshot(answeredRow, pendingSnap, parsed);
    const answeredId = await upsertMlQuestionAnswered(answeredRow);
    if (answeredId != null) {
      await deleteMlQuestionPending(qid);
      try {
        await syncAnsweredMlQuestionToCrm(answeredRow);
      } catch (eSync) {
        console.error("[ml-question-refresh] syncAnsweredMlQuestionToCrm", eSync.message || eSync);
      }
    }
    return {
      ok: true,
      action: "synced_answered",
      ml_user_id: uid,
      ml_question_id: qid,
      ml_status: row.ml_status,
      answered_internal_id: answeredId,
    };
  }

  if (isQuestionUnansweredStatus(row.ml_status)) {
    const pendingSnap = await getMlQuestionPendingByQuestionId(qid);
    const hadDetail =
      pendingSnap &&
      pendingSnap.ia_auto_route_detail != null &&
      String(pendingSnap.ia_auto_route_detail).trim() !== "";
    let iaDetail = null;
    if (!hadDetail) {
      const evalAt = new Date();
      const win = getQuestionsIaAutoWindowEvaluation(evalAt);
      iaDetail = serializeIaAutoPendingRouteDetail({
        route: "pending_from_refresh_sync",
        evaluated_at_utc: evalAt.toISOString(),
        question_date_created_ml: row.date_created || null,
        evaluation: {
          active: win.active,
          outcome: win.outcome,
          reason_detail: win.reason_detail,
        },
        arithmetic_breakdown: getQuestionsIaAutoWindowArithmeticBreakdown(evalAt),
        human:
          "Origen: GET /questions/{id} (refresh o sync-pending). No es el diagnóstico del instante del webhook; ventana mostrada = estado al ejecutar este sync.",
      });
    }
    await upsertMlQuestionPending({ ...row, ia_auto_route_detail: iaDetail });
    return {
      ok: true,
      action: "synced_still_unanswered",
      ml_user_id: uid,
      ml_question_id: qid,
      ml_status: row.ml_status,
    };
  }

  await deleteMlQuestionPending(qid);
  return {
    ok: true,
    action: "removed_from_pending_other_status",
    ml_user_id: uid,
    ml_question_id: qid,
    ml_status: row.ml_status,
  };
}

/**
 * Recorre ml_questions_pending y alinea cada una con GET /questions/{id}.
 * Si en ML ya está ANSWERED/CLOSED/DELETED/…, pasa a answered y borra pending.
 * Si el GET devuelve 404/410, borra pending (pregunta ya no existe en ML).
 * @param {{ limit?: number }} [opts]
 */
async function syncAllPendingQuestionsFromApi(opts) {
  const cap = opts && opts.limit != null ? Number(opts.limit) : 50;
  const n = Math.min(Math.max(Number.isFinite(cap) ? cap : 50, 1), 200);
  const rows = await listMlQuestionsPending(n, 200);
  const results = [];
  for (const row of rows) {
    const r = await refreshMlQuestionFromApi({
      mlQuestionId: row.ml_question_id,
      mlUserId: row.ml_user_id,
    });
    results.push({ ml_question_id: row.ml_question_id, ...r });
  }
  return { ok: true, processed: rows.length, results };
}

module.exports = {
  refreshMlQuestionFromApi,
  syncAllPendingQuestionsFromApi,
};
