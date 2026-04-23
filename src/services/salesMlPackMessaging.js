"use strict";

const { pool } = require("../../db");

/**
 * @param {string|null|undefined} externalOrderId
 * @returns {number|null}
 */
function parseMlOrderIdFromExternal(externalOrderId) {
  const ext = externalOrderId != null ? String(externalOrderId).trim() : "";
  if (!ext) return null;
  const m = ext.match(/^(\d+)-(\d+)$/);
  if (m) {
    const n = Number(m[2]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^\d+$/.test(ext)) {
    const n = Number(ext);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Resuelve cuenta ML, id de orden pack y comprador para mensajería post-venta ML.
 * @param {number|string} saleId sales_orders.id
 * @returns {Promise<object>}
 */
async function resolveMlPackFromSaleId(saleId) {
  const sid = Number(saleId);
  if (!Number.isFinite(sid) || sid <= 0) {
    return {
      ok: false,
      code: "BAD_ID",
      message: "ID de orden inválido",
      detail: { sale_id_requested: saleId, reason: "sales_orders.id debe ser un entero positivo" },
    };
  }

  const { rows } = await pool.query(
    `SELECT so.id,
            so.source::text AS source,
            so.ml_user_id,
            so.external_order_id
     FROM sales_orders so
     WHERE so.id = $1`,
    [sid]
  );
  if (!rows.length) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Orden no encontrada",
      detail: {
        sale_id_requested: sid,
        lookup: "sales_orders.id",
        hint: "El id de la URL es sales_orders.id (ERP). Si el front envía otro identificador, fallará aquí.",
      },
    };
  }
  const so = rows[0];
  if (String(so.source) !== "mercadolibre") {
    return {
      ok: false,
      code: "NOT_ML",
      message: "Solo aplica a ventas con origen Mercado Libre",
      detail: {
        sale_id_requested: sid,
        source: String(so.source),
        hint: "La fila existe pero source no es mercadolibre.",
      },
    };
  }
  const mlUserId = so.ml_user_id != null ? Number(so.ml_user_id) : NaN;
  if (!Number.isFinite(mlUserId) || mlUserId <= 0) {
    return {
      ok: false,
      code: "NO_ML_USER",
      message: "La orden no tiene cuenta ML (ml_user_id)",
      detail: {
        sale_id_requested: sid,
        external_order_id: so.external_order_id,
        ml_user_id_raw: so.ml_user_id,
        hint: "Asigne ml_user_id en sales_orders (cuenta vendedora en ml_accounts).",
      },
    };
  }
  const mlOrderId = parseMlOrderIdFromExternal(so.external_order_id);
  if (!Number.isFinite(mlOrderId) || mlOrderId <= 0) {
    return {
      ok: false,
      code: "BAD_EXTERNAL",
      message: "external_order_id no permite obtener el id de orden ML (esperado SELLER-ORDER o numérico)",
      detail: {
        sale_id_requested: sid,
        external_order_id: so.external_order_id,
        parsed_ml_order_id: null,
        hint: "Formato típico import ML: {ml_user_id}-{order_id}. Ej. 123456789-9876543210",
      },
    };
  }

  const { rows: mor } = await pool.query(
    `SELECT buyer_id FROM ml_orders
     WHERE ml_user_id = $1 AND order_id = $2
     LIMIT 1`,
    [mlUserId, mlOrderId]
  );
  let buyerId = mor.length && mor[0].buyer_id != null ? Number(mor[0].buyer_id) : NaN;
  if (!Number.isFinite(buyerId) || buyerId <= 0) {
    const { rows: pr } = await pool.query(
      `SELECT from_user_id, to_user_id FROM ml_order_pack_messages
       WHERE ml_user_id = $1 AND order_id = $2
         AND (
           from_user_id IS DISTINCT FROM $3::bigint
           OR to_user_id IS DISTINCT FROM $3::bigint
         )
       ORDER BY date_created DESC NULLS LAST, id DESC
       LIMIT 5`,
      [mlUserId, mlOrderId, mlUserId]
    );
    for (const p of pr) {
      const a = p.from_user_id != null ? Number(p.from_user_id) : NaN;
      const b = p.to_user_id != null ? Number(p.to_user_id) : NaN;
      if (a === mlUserId && Number.isFinite(b) && b > 0) {
        buyerId = b;
        break;
      }
      if (b === mlUserId && Number.isFinite(a) && a > 0) {
        buyerId = a;
        break;
      }
    }
  }
  if (!Number.isFinite(buyerId) || buyerId <= 0) {
    return {
      ok: false,
      code: "NO_BUYER",
      message: "No se pudo resolver el comprador ML (ml_orders o historial de mensajes)",
      detail: {
        sale_id_requested: sid,
        external_order_id: so.external_order_id,
        parsed_ml_order_id: mlOrderId,
        ml_user_id: mlUserId,
        ml_orders_row_found: mor.length > 0,
        ml_orders_buyer_id:
          mor.length > 0 && mor[0].buyer_id != null ? Number(mor[0].buyer_id) : null,
        hint:
          mor.length === 0
            ? "No hay fila en ml_orders para (ml_user_id, order_id). Sincronice órdenes ML (sync-orders / import) para esta cuenta y order_id."
            : "ml_orders existe pero buyer_id es nulo o inválido; actualice la orden desde la API de ML o revise raw_json.",
      },
    };
  }

  const { rows: chr } = await pool.query(
    `SELECT id FROM crm_chats
     WHERE source_type = 'ml_message' AND ml_order_id = $1::bigint
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [mlOrderId]
  );
  const chatId = chr.length ? Number(chr[0].id) : null;

  return {
    ok: true,
    sale_id: sid,
    ml_user_id: mlUserId,
    ml_order_id: mlOrderId,
    buyer_id: buyerId,
    chat_id: chatId,
    external_order_id: so.external_order_id,
  };
}

module.exports = {
  resolveMlPackFromSaleId,
  parseMlOrderIdFromExternal,
};
