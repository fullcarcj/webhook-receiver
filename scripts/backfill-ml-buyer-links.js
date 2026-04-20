#!/usr/bin/env node
/**
 * Enlaza ml_buyers huérfanos a customers (teléfono normalizado) o crea cliente nuevo.
 * Uso: node scripts/backfill-ml-buyer-links.js [--dry-run] [--company_id=1]
 * Requiere DATABASE_URL.
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");

const BATCH_SIZE = 100;
const DELAY_MS = 200;

const DRY = process.argv.includes("--dry-run");
const companyArg = process.argv.find((a) => /^--company_id=/.test(a));
const COMPANY_ID = companyArg
  ? Number(companyArg.split("=")[1])
  : Number(process.env.BACKFILL_COMPANY_ID || "1") || 1;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cumple chk_phone_format: solo dígitos, longitud 7–15. */
function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (digits.length > 15) return null;
  return digits;
}

async function mlBuyersHasEmailColumn() {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ml_buyers' AND column_name = 'email'
     LIMIT 1`
  );
  return rows.length > 0;
}

async function loadUnlinkedBuyers(hasEmail) {
  const base = `
     FROM ml_buyers b
     WHERE NOT EXISTS (
       SELECT 1 FROM customer_ml_buyers cmb WHERE cmb.ml_buyer_id = b.buyer_id
     )
     ORDER BY b.buyer_id`;
  if (hasEmail) {
    const { rows } = await pool.query(
      `SELECT b.buyer_id, b.phone_1, b.phone_2, b.nombre_apellido, b.nickname, b.email ${base}`
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT b.buyer_id, b.phone_1, b.phone_2, b.nombre_apellido, b.nickname ${base}`
  );
  return rows;
}

async function findCustomerByPhoneDigits(digits, companyId) {
  if (!digits) return null;
  const { rows } = await pool.query(
    `SELECT id FROM customers
     WHERE company_id = $1
       AND NULLIF(TRIM(phone), '') IS NOT NULL
       AND REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $2
     LIMIT 1`,
    [companyId, digits]
  );
  return rows.length ? Number(rows[0].id) : null;
}

async function processBuyerLive(b, companyId, hasEmail) {
  const bid = Number(b.buyer_id);
  const s1 = sanitizePhone(b.phone_1);
  const s2 = sanitizePhone(b.phone_2);
  const digits = s1 || s2 || "";
  const email =
    hasEmail && b.email != null && String(b.email).trim() !== ""
      ? String(b.email).trim().toLowerCase()
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let customerId = null;
    if (digits) {
      customerId = await findCustomerByPhoneDigitsWithClient(client, digits, companyId);
    }
    if (customerId == null && email) {
      const { rows } = await client.query(
        `SELECT id FROM customers
         WHERE company_id = $1 AND LOWER(TRIM(email)) = $2
         LIMIT 1`,
        [companyId, email]
      );
      if (rows.length) customerId = Number(rows[0].id);
    }

    if (customerId != null) {
      await client.query(
        `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
         VALUES ($1, $2, false)
         ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
        [customerId, bid]
      );
      console.log(`[backfill] linked_existing buyer=${bid} → customer=${customerId}`);
      await client.query("COMMIT");
      return;
    }

    const fullName =
      (b.nombre_apellido && String(b.nombre_apellido).trim()) ||
      (b.nickname && String(b.nickname).trim()) ||
      `Comprador ML ${bid}`;

    const hasP2 = await columnExists(client, "customers", "phone_2");
    const p1 = s1;
    const p2 = hasP2 ? s2 : null;
    let ins;
    if (hasP2) {
      ins = await client.query(
        `INSERT INTO customers (company_id, full_name, primary_ml_buyer_id, phone, phone_2, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [companyId, fullName, bid, p1, p2, `Backfill buyer_id=${bid}`]
      );
    } else {
      ins = await client.query(
        `INSERT INTO customers (company_id, full_name, primary_ml_buyer_id, phone, notes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [companyId, fullName, bid, p1, `Backfill buyer_id=${bid}`]
      );
    }
    const newId = Number(ins.rows[0].id);
    await client.query(
      `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
       VALUES ($1, $2, true)
       ON CONFLICT (customer_id, ml_buyer_id) DO NOTHING`,
      [newId, bid]
    );
    console.log(`[backfill] created_new buyer=${bid} → customer=${newId}`);
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
}

async function findCustomerByPhoneDigitsWithClient(client, digits, companyId) {
  const { rows } = await client.query(
    `SELECT id FROM customers
     WHERE company_id = $1
       AND NULLIF(TRIM(phone), '') IS NOT NULL
       AND REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $2
     LIMIT 1`,
    [companyId, digits]
  );
  return rows.length ? Number(rows[0].id) : null;
}

async function columnExists(client, table, col) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, col]
  );
  return rows.length > 0;
}

async function processBuyerDry(b, companyId, hasEmail) {
  const bid = Number(b.buyer_id);
  const s1 = sanitizePhone(b.phone_1);
  const s2 = sanitizePhone(b.phone_2);
  const digits = s1 || s2 || "";
  const email =
    hasEmail && b.email != null && String(b.email).trim() !== ""
      ? String(b.email).trim().toLowerCase()
      : null;

  let customerId = await findCustomerByPhoneDigits(digits, companyId);
  if (customerId == null && email) {
    const { rows } = await pool.query(
      `SELECT id FROM customers
       WHERE company_id = $1 AND LOWER(TRIM(email)) = $2
       LIMIT 1`,
      [companyId, email]
    );
    if (rows.length) customerId = Number(rows[0].id);
  }

  if (customerId != null) {
    console.log(`[backfill] WOULD linked_existing buyer=${bid} → customer=${customerId}`);
    return;
  }

  const fullName =
    (b.nombre_apellido && String(b.nombre_apellido).trim()) ||
    (b.nickname && String(b.nickname).trim()) ||
    `Comprador ML ${bid}`;
  console.log(
    `[backfill] WOULD create_new buyer=${bid} full_name=${JSON.stringify(fullName.slice(0, 80))}`
  );
}

async function main() {
  const hasEmail = await mlBuyersHasEmailColumn();
  const buyers = await loadUnlinkedBuyers(hasEmail);
  console.log(
    `[backfill] unlinked=${buyers.length} dry_run=${DRY} company_id=${COMPANY_ID} has_ml_email_col=${hasEmail}`
  );

  for (let i = 0; i < buyers.length; i += BATCH_SIZE) {
    const chunk = buyers.slice(i, i + BATCH_SIZE);
    for (const b of chunk) {
      if (DRY) {
        await processBuyerDry(b, COMPANY_ID, hasEmail);
      } else {
        try {
          await processBuyerLive(b, COMPANY_ID, hasEmail);
        } catch (e) {
          console.error(`[backfill] buyer=${b.buyer_id} FAILED`, e && e.message);
        }
      }
    }
    if (i + BATCH_SIZE < buyers.length) await sleep(DELAY_MS);
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[backfill] fatal", e);
  process.exit(1);
});
