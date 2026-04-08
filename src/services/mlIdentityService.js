"use strict";

const { pool } = require("../../db");
const { customersHasPhone2Column } = require("../utils/customersPhone2");

/**
 * Resuelve o enriquece customer desde payload GET /orders/{id} (ML).
 * Usa customers.phone / phone_2 (no alternative_phone salvo migración).
 * crm_customer_identities(source=mercadolibre).
 */
async function resolveMLCustomerFromOrder(orderPayload) {
  if (!orderPayload || typeof orderPayload !== "object") return null;
  const buyer = orderPayload.buyer;
  if (!buyer || buyer.id == null) return null;
  const buyerId = String(buyer.id).trim();
  const buyerName =
    (buyer.nickname && String(buyer.nickname).trim()) ||
    (buyer.first_name && `${buyer.first_name} ${buyer.last_name || ""}`.trim()) ||
    `ML-${buyerId}`;
  const phone1 = buyer.phone && buyer.phone.number ? String(buyer.phone.number).trim() : null;
  const phone2 =
    buyer.alternative_phone && buyer.alternative_phone.number
      ? String(buyer.alternative_phone.number).trim()
      : null;

  const { rows: idRows } = await pool.query(
    `SELECT customer_id FROM crm_customer_identities
     WHERE source = 'mercadolibre'::crm_identity_source AND external_id = $1`,
    [buyerId]
  );

  if (idRows && idRows.length) {
    const cid = Number(idRows[0].customer_id);
    if ((phone1 || phone2) && Number.isFinite(cid)) {
      const hasP2 = await customersHasPhone2Column(pool);
      if (hasP2) {
        await pool.query(
          `UPDATE customers SET
             phone = COALESCE(NULLIF(TRIM(phone), ''), $1),
             phone_2 = COALESCE(NULLIF(TRIM(phone_2), ''), $2),
             updated_at = NOW()
           WHERE id = $3`,
          [phone1, phone2, cid]
        );
      } else {
        await pool.query(
          `UPDATE customers SET
             phone = COALESCE(NULLIF(TRIM(phone), ''), $1),
             updated_at = NOW()
           WHERE id = $2`,
          [phone1, cid]
        );
      }
    }
    return cid;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hasP2 = await customersHasPhone2Column(client);
    const notesPlain = `Auto ML buyer ${buyerId}`;
    const notesNoCol = phone2 ? `${notesPlain} | tel2 ML: ${phone2}` : notesPlain;
    const { rows: ins } = hasP2
      ? await client.query(
          `INSERT INTO customers (company_id, full_name, phone, phone_2, crm_status, notes, created_at, updated_at)
           VALUES (1, $1, $2, $3, 'active', $4, NOW(), NOW())
           RETURNING id`,
          [buyerName, phone1, phone2, notesPlain]
        )
      : await client.query(
          `INSERT INTO customers (company_id, full_name, phone, crm_status, notes, created_at, updated_at)
           VALUES (1, $1, $2, 'active', $3, NOW(), NOW())
           RETURNING id`,
          [buyerName, phone1, notesNoCol]
        );
    const cid = Number(ins[0].id);
    await client.query(
      `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
       VALUES ($1, 'mercadolibre'::crm_identity_source, $2, TRUE)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [cid, buyerId]
    );
    await client.query("COMMIT");
    return cid;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    if (e && e.code === "42P01") {
      return null;
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { resolveMLCustomerFromOrder };
