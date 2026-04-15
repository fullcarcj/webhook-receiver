#!/usr/bin/env node
/**
 * Importa subcategorías desde CSV a product_subcategories.
 *
 * Flujo:
 *  1) Fase padres: valida y mapea contra category_products existente.
 *  2) Fase hijos: inserta product_subcategories con category_id del Map.
 *
 * Uso:
 *   node scripts/import-product-subcategories-csv.js --file="C:/ruta/archivo.csv"
 *
 * Opciones:
 *   --delimiter=;              Separador (default ;)
 *   --encoding=auto            auto|utf8|latin1|win1252 (default auto)
 *   --dry-run                  No escribe en DB; solo valida y cuenta
 *   --allow-create-parents=1   Permite crear padres faltantes (default: 0)
 */
"use strict";

require("../load-env-local");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:/]/i.test(raw) ||
    /@127\.0\.0\.1[:/]/i.test(raw) ||
    /:\/\/localhost[:/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

function argVal(name, def) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : def;
}

function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && c === delimiter) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function textDecoder(bytes, encoding) {
  if (encoding === "utf8") return bytes.toString("utf8");
  if (encoding === "latin1") return bytes.toString("latin1");
  if (encoding === "win1252") {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch (_) {
      return bytes.toString("latin1");
    }
  }
  // auto: intenta UTF-8 primero; si ve caracteres de reemplazo, usa win1252.
  const utf = bytes.toString("utf8");
  if (utf.includes("\uFFFD")) {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch (_) {
      return bytes.toString("latin1");
    }
  }
  return utf;
}

function normText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function keyNorm(v) {
  return normText(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

async function main() {
  const fileArg = argVal("file", "");
  if (!fileArg) {
    console.error("Falta --file=RUTA_CSV");
    process.exit(1);
  }
  const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error("No existe el archivo:", filePath);
    process.exit(1);
  }

  const delimiter = argVal("delimiter", ";");
  const encoding = argVal("encoding", "auto").toLowerCase();
  const dryRun = process.argv.includes("--dry-run");
  const allowCreateParents = argVal("allow-create-parents", "0") === "1";
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url && !dryRun) {
    console.error("DATABASE_URL no definida.");
    process.exit(1);
  }

  const bytes = fs.readFileSync(filePath);
  const raw = textDecoder(bytes, encoding);
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    console.error("CSV vacío o sin filas de datos.");
    process.exit(1);
  }

  const header = parseCsvLine(lines[0], delimiter);
  if (header.length < 2) {
    console.error("Cabecera inválida. Se esperan 2 columnas: Sistema;Subcategoría");
    process.exit(1);
  }

  const parentSet = new Set();
  const parentIdSet = new Set();
  const pairs = [];
  const seenPair = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], delimiter);
    if (cols.length < 2) continue;
    const parentRaw = normText(cols[0]);
    const childRaw = normText(cols[1]);
    if (!parentRaw || !childRaw) continue;
    const parentIdNum = Number(parentRaw);
    const hasParentId = Number.isInteger(parentIdNum) && parentIdNum > 0;
    if (hasParentId) parentIdSet.add(parentIdNum);
    else parentSet.add(parentRaw);
    const parentKey = hasParentId ? `id:${parentIdNum}` : `name:${keyNorm(parentRaw)}`;
    const pairKey = `${parentKey}\t${keyNorm(childRaw)}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    pairs.push({
      parent: parentRaw,
      parentId: hasParentId ? parentIdNum : null,
      child: childRaw,
    });
  }

  if (dryRun) {
    console.log(
      `[import-product-subcategories] Padres por nombre: ${parentSet.size}, por id: ${parentIdSet.size}`
    );
    console.log(`[import-product-subcategories] Subcategorías únicas CSV: ${pairs.length}`);
    process.exit(0);
  }

  const client = new Client({
    connectionString: url,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();

  let systemsProcessed = 0;
  let subsCreated = 0;

  try {
    await client.query("BEGIN");

    // Carga categorías existentes una vez y normaliza llaves para match robusto.
    const existingParents = await client.query(
      "SELECT id, category_descripcion FROM category_products"
    );
    const parentMap = new Map(); // keyNorm(name) -> { id, name }
    for (const row of existingParents.rows) {
      parentMap.set(keyNorm(row.category_descripcion), {
        id: Number(row.id),
        name: row.category_descripcion,
      });
    }

    // Fase 1: validar/mapeo de padres (modo estricto por defecto).
    const insertParentSql = `
      INSERT INTO category_products (category_descripcion, category_ml)
      VALUES ($1, '')
      RETURNING id, category_descripcion
    `;
    const missingParents = [];
    for (const parentName of parentSet) {
      const k = keyNorm(parentName);
      if (parentMap.has(k)) {
        systemsProcessed++;
        continue;
      }
      if (!allowCreateParents) {
        missingParents.push(parentName);
        continue;
      }
      const ins = await client.query(insertParentSql, [parentName]);
      const row = ins.rows[0];
      parentMap.set(k, { id: Number(row.id), name: row.category_descripcion });
      systemsProcessed++;
    }

    if (missingParents.length > 0) {
      throw new Error(
        `Padres no encontrados en category_products (${missingParents.length}): ${missingParents.join(", ")}`
      );
    }

    // Si el CSV trae parent_id directo, validar que exista.
    if (parentIdSet.size > 0) {
      const idList = Array.from(parentIdSet);
      const parentIds = await client.query(
        "SELECT id FROM category_products WHERE id = ANY($1::bigint[])",
        [idList]
      );
      const exists = new Set(parentIds.rows.map((r) => Number(r.id)));
      const missingIds = idList.filter((id) => !exists.has(id));
      if (missingIds.length > 0) {
        throw new Error(
          `category_id inexistente en category_products: ${missingIds.join(", ")}`
        );
      }
    }

    // Fase 2: insertar hijos idempotente.
    const insertChildSql = `
      INSERT INTO product_subcategories (category_id, name, sort_order)
      VALUES ($1, $2, 0)
      ON CONFLICT (category_id, name) DO NOTHING
      RETURNING id
    `;
    for (const row of pairs) {
      const categoryId =
        row.parentId != null
          ? row.parentId
          : (parentMap.get(keyNorm(row.parent)) || {}).id;
      if (!categoryId) throw new Error(`No se pudo resolver category_id para "${row.parent}"`);
      const res = await client.query(insertChildSql, [categoryId, row.child]);
      if (res.rowCount > 0) subsCreated++;
    }

    await client.query("COMMIT");

    console.log(
      `[import-product-subcategories] ${systemsProcessed} Sistemas procesados, ${subsCreated} Subcategorías creadas`
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[import-product-subcategories]", e.message);
  if (e && e.detail) console.error("detail:", e.detail);
  process.exit(1);
});
