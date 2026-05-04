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
  resolveQuestionSellerMlUserId,
} = require("./ml-question-sync");
const {
  getMlAccount,
  getMlQuestionPendingByQuestionId,
  listMlQuestionsPending,
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
  if (!Number.isFinite(uid) || uid <= 0) {
    const envUid = Number(process.env.INBOX_ML_QUESTION_SYNC_USER_ID || process.env.ML_USER_ID || "");
    if (Number.isFinite(envUid) && envUid > 0) {
      uid = envUid;
    }
  }
  if (!Number.isFinite(uid) || uid <= 0) {
    return {
      ok: false,
      error:
        "Sin cuenta vendedor para GET /questions: pasá mlUserId en args, o debe existir ml_questions_pending con ml_user_id, o definí ML_USER_ID / INBOX_ML_QUESTION_SYNC_USER_ID. No se iteran cuentas.",
      skipped: "no_ml_user_id",
      ml_question_id: qid,
    };
  }

  const res = await mercadoLibreFetchForUser(uid, `/questions/${qid}`);
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

  const resolvedSeller = resolveQuestionSellerMlUserId(parsed, uid);
  if (resolvedSeller != null && Number(resolvedSeller) !== Number(uid)) {
    return {
      ok: false,
      error: `seller_id del JSON (${resolvedSeller}) no coincide con la cuenta del GET (${uid}); no se persiste. Usá OAuth del vendedor dueño o pasá mlUserId correcto en args.`,
      skipped: "seller_token_mismatch",
      ml_user_id: uid,
      ml_question_id: qid,
    };
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
