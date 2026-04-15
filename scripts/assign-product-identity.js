"use strict";
/**
 * Deduce brand_id, subcategory_id y category_id en `products`
 * analizando el campo `name` con matching por keywords y aliases.
 *
 * Uso:
 *   node scripts/assign-product-identity.js --dry-run           # solo reporte
 *   node scripts/assign-product-identity.js --dry-run --limit=50
 *   node scripts/assign-product-identity.js --min-confidence=2  # aplica con mayor rigor
 *   node scripts/assign-product-identity.js                     # aplica todo (conf >= 1)
 *   node scripts/assign-product-identity.js --log-every=500     # log cada N UPDATEs OK (default 200)
 *   node scripts/assign-product-identity.js --batch-size=300    # COMMIT cada N filas del bucle (default 400)
 *   node scripts/assign-product-identity.js --heartbeat=25    # “latido” cada N iteraciones (default 50)
 *   node scripts/assign-product-identity.js --no-skip-locked   # UPDATE clásico (espera lock; ver --lock-timeout-ms)
 *   node scripts/assign-product-identity.js --lock-timeout-ms=0  # sin tope de espera en modo no-skip-locked
 *
 * Por defecto el UPDATE usa FOR UPDATE SKIP LOCKED: si DBeaver u otra sesión tiene la fila,
 * no espera 30s ni error 55P03; la fila queda para un segundo pase del script.
 *
 * Errores SQL: consola + append en scripts/assign-product-identity-errors.log (gitignore).
 * Cada UPDATE va en SAVEPOINT dentro de un lote; COMMIT cada --batch-size filas (default 400)
 * para no bloquear `products` ni la consola durante minutos sin salida.
 *
 * Confianza de marca (brand):
 *   3 = nombre de marca exacto en el texto
 *   2 = alias de modelo conocido (ej. CRUZE → CHEVROLET)
 *
 * Confianza de subcategoría:
 *   N = número de tokens de la subcategoría que aparecen en el nombre del producto
 */

const fs   = require("fs");
const path = require("path");

require("../load-env-local");
const { pool } = require("../db");

/** Errores SQL de esta corrida (consola + append; en .gitignore) */
const ERROR_LOG_PATH = path.join(__dirname, "assign-product-identity-errors.log");

/**
 * @param {{ productId: number, sku?: string, setSummary?: string }} ctx
 * @param {Error & { code?: string; detail?: string; constraint?: string; schema?: string; table?: string; column?: string }} err
 */
function logIdentityAssignError(ctx, err) {
  const iso = new Date().toISOString();
  const bits = [
    err.message,
    err.code && `code=${err.code}`,
    err.detail && `detail=${err.detail}`,
    err.constraint && `constraint=${err.constraint}`,
    err.schema && err.table && `table=${err.schema}.${err.table}`,
    err.column && `column=${err.column}`,
  ].filter(Boolean);
  const oneLine = bits.join(" | ");

  console.error("\n  ❌ ERROR asignación identidad (producto)");
  console.error(`     id=${ctx.productId} sku=${ctx.sku || "(sin sku)"}`);
  if (ctx.setSummary) console.error(`     campos: ${ctx.setSummary}`);
  console.error(`     ${oneLine}`);
  if (err.code === "55P03") {
    console.error(
      "     (55P03 = lock timeout: cerrá transacciones en DBeaver u otras apps, o ejecutá el script con SKIP LOCKED por defecto.)"
    );
  }

  const block =
    `[${iso}] id=${ctx.productId} sku=${JSON.stringify(ctx.sku || "")} ${ctx.setSummary || ""}\n` +
    `${oneLine}\n` +
    `${String(err.stack || "").slice(0, 4000)}\n` +
    `${"─".repeat(72)}\n`;

  try {
    fs.appendFileSync(ERROR_LOG_PATH, block, "utf8");
    console.error(`     → log: ${ERROR_LOG_PATH}`);
  } catch (w) {
    console.error("     (no se pudo escribir archivo de log:", w.message, ")");
  }
}

// ── Argumentos CLI ─────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const DRY_RUN        = Boolean(args["dry-run"]);
const LIMIT          = args.limit ? Number(args.limit) : null;
const MIN_CONFIDENCE = args["min-confidence"] ? Number(args["min-confidence"]) : 1;
const ONLY_UNSET     = !args["include-assigned"];
const LOG_EVERY_RAW =
  args["log-every"] != null
    ? Number(args["log-every"])
    : Number(process.env.ASSIGN_PRODUCT_IDENTITY_LOG_EVERY || 200);
const LOG_EVERY = Math.max(1, Number.isFinite(LOG_EVERY_RAW) ? Math.floor(LOG_EVERY_RAW) : 200);

const BATCH_RAW =
  args["batch-size"] != null
    ? Number(args["batch-size"])
    : Number(process.env.ASSIGN_PRODUCT_IDENTITY_BATCH_SIZE || 400);
const BATCH_SIZE = Math.max(25, Math.min(2000, Number.isFinite(BATCH_RAW) ? Math.floor(BATCH_RAW) : 400));

const HEARTBEAT_EVERY = Math.max(
  10,
  Math.min(500, Number(args["heartbeat"] || process.env.ASSIGN_PRODUCT_IDENTITY_HEARTBEAT || 50) || 50)
);

/** true = UPDATE con CTE FOR UPDATE SKIP LOCKED (recomendado si hay DBeaver / otras sesiones) */
const USE_SKIP_LOCKED =
  !args["no-skip-locked"] &&
  process.env.ASSIGN_PRODUCT_IDENTITY_NO_SKIP_LOCKED !== "1";

/** Solo aplica con --no-skip-locked. 0 = sin límite (espera al lock). */
const LOCK_TIMEOUT_MS_RAW =
  args["lock-timeout-ms"] != null
    ? Number(args["lock-timeout-ms"])
    : Number(process.env.ASSIGN_PRODUCT_IDENTITY_LOCK_TIMEOUT_MS ?? 300000);
const LOCK_TIMEOUT_MS =
  Number.isFinite(LOCK_TIMEOUT_MS_RAW) && LOCK_TIMEOUT_MS_RAW >= 0 ? Math.floor(LOCK_TIMEOUT_MS_RAW) : 300000;

function pgLockTimeoutValue(ms) {
  if (ms <= 0) return "0";
  return `${ms}ms`;
}

// ── Aliases: término en nombre del producto → name en crm_vehicle_brands ──────
const BRAND_ALIASES = {
  // CHEVROLET
  CHEVROLET: "CHEVROLET", CHEVY: "CHEVROLET",
  CRUZE: "CHEVROLET", AVEO: "CHEVROLET", SPARK: "CHEVROLET",
  SONIC: "CHEVROLET", CAPTIVA: "CHEVROLET", TRACKER: "CHEVROLET",
  SILVERADO: "CHEVROLET", TAHOE: "CHEVROLET", BLAZER: "CHEVROLET",
  SUBURBAN: "CHEVROLET", TRAILBLAZER: "CHEVROLET", MALIBU: "CHEVROLET",
  COBALT: "CHEVROLET", CORVETTE: "CHEVROLET", CAMARO: "CHEVROLET",
  ORLANDO: "CHEVROLET", TRAX: "CHEVROLET", EQUINOX: "CHEVROLET",
  AVALANCHE: "CHEVROLET", AVALANCH: "CHEVROLET",
  // DAEWOO
  DAEWOO: "DAEWOO", DAEWO: "DAEWOO",
  MATIZ: "DAEWOO", OPTRA: "DAEWOO", NUBIRA: "DAEWOO",
  TACUMA: "DAEWOO", LACETTI: "DAEWOO", LANOS: "DAEWOO",
  CIELO: "DAEWOO", ESPERO: "DAEWOO", LEGANZA: "DAEWOO",
  RACER: "DAEWOO", NEXIA: "DAEWOO", LASER: "DAEWOO",
  // TOYOTA
  TOYOTA: "TOYOTA",
  COROLLA: "TOYOTA", CAMRY: "TOYOTA", YARIS: "TOYOTA",
  HILUX: "TOYOTA", PRADO: "TOYOTA", FORTUNER: "TOYOTA",
  RAV4: "TOYOTA", PRIUS: "TOYOTA", CELICA: "TOYOTA",
  INNOVA: "TOYOTA", ETIOS: "TOYOTA", TERIOS: "TOYOTA",
  // HONDA
  HONDA: "HONDA",
  ACCORD: "HONDA", CIVIC: "HONDA", CRV: "HONDA",
  FIT: "HONDA", PILOT: "HONDA", ODYSSEY: "HONDA",
  RIDGELINE: "HONDA", ELEMENT: "HONDA", STREAM: "HONDA",
  // FORD
  FORD: "FORD",
  FIESTA: "FORD", FOCUS: "FORD", FUSION: "FORD",
  EXPLORER: "FORD", EXPEDITION: "FORD",
  RANGER: "FORD", BRONCO: "FORD", MUSTANG: "FORD",
  ECOSPORT: "FORD", KUGA: "FORD", MONDEO: "FORD",
  TRANSIT: "FORD", COURIER: "FORD",
  // NISSAN
  NISSAN: "NISSAN",
  SENTRA: "NISSAN", ALTIMA: "NISSAN", MAXIMA: "NISSAN",
  PATHFINDER: "NISSAN", FRONTIER: "NISSAN", NAVARA: "NISSAN",
  TIIDA: "NISSAN", VERSA: "NISSAN", MURANO: "NISSAN",
  XTRAIL: "NISSAN", NOTE: "NISSAN",
  PATROL: "NISSAN", TERRANO: "NISSAN", D21: "NISSAN",
  MARCH: "NISSAN",
  // HYUNDAI
  HYUNDAI: "HYUNDAI",
  ACCENT: "HYUNDAI", ELANTRA: "HYUNDAI", SONATA: "HYUNDAI",
  TUCSON: "HYUNDAI", TERRACAN: "HYUNDAI",
  GETZ: "HYUNDAI", I10: "HYUNDAI", I20: "HYUNDAI",
  I30: "HYUNDAI", IX35: "HYUNDAI",
  // KIA
  KIA: "KIA",
  RIO: "KIA", SPORTAGE: "KIA", SORENTO: "KIA",
  CERATO: "KIA", PICANTO: "KIA", STINGER: "KIA",
  CARNIVAL: "KIA", SOUL: "KIA",
  // JEEP
  JEEP: "JEEP",
  CHEROKEE: "JEEP", WRANGLER: "JEEP", WRANGER: "JEEP",
  COMMANDER: "JEEP", COMPASS: "JEEP",
  RENEGADE: "JEEP", LIBERTY: "JEEP", PATRIOT: "JEEP",
  // JEEP-CHRYSLER
  CHRYSLER: "JEEP-CHRISLER", CHRISLER: "JEEP-CHRISLER",
  VOYAGER: "JEEP-CHRISLER",
  SEBRING: "JEEP-CHRISLER",
  // DODGE
  DODGE: "DODGE",
  NEON: "DODGE", DURANGO: "DODGE", DAKOTA: "DODGE",
  CHARGER: "DODGE", CHALLENGER: "DODGE",
  CARAVAN: "DODGE",
  // MITSUBISHI
  MITSUBISHI: "MITSUBISHI",
  LANCER: "MITSUBISHI", OUTLANDER: "MITSUBISHI", ECLIPSE: "MITSUBISHI",
  GALANT: "MITSUBISHI", MONTERO: "MITSUBISHI", PAJERO: "MITSUBISHI",
  COLT: "MITSUBISHI", L200: "MITSUBISHI", ASX: "MITSUBISHI",
  // MAZDA
  MAZDA: "MAZDA",
  // VOLKSWAGEN
  VOLKSWAGEN: "VOLKSWAGEN", VW: "VOLKSWAGEN",
  GOLF: "VOLKSWAGEN", JETTA: "VOLKSWAGEN", PASSAT: "VOLKSWAGEN",
  POLO: "VOLKSWAGEN", TIGUAN: "VOLKSWAGEN", TOUAREG: "VOLKSWAGEN",
  ESCARABAJO: "VOLKSWAGEN", BEETLE: "VOLKSWAGEN",
  KOMBI: "VOLKSWAGEN", AMAROK: "VOLKSWAGEN",
  // FIAT
  FIAT: "FIAT",
  TEMPRA: "FIAT", SIENA: "FIAT", PALIO: "FIAT",
  STRADA: "FIAT", DOBLO: "FIAT", PUNTO: "FIAT",
  MAREA: "FIAT", BRAVO: "FIAT",
  // RENAULT
  RENAULT: "RENAULT",
  LOGAN: "RENAULT", SANDERO: "RENAULT", DUSTER: "RENAULT",
  CLIO: "RENAULT", MEGANE: "RENAULT", LAGUNA: "RENAULT",
  SCENIC: "RENAULT", FLUENCE: "RENAULT",
  // PEUGEOT
  PEUGEOT: "PEUGEOT",
  // CITROEN
  CITROEN: "CITROEN", BERLINGO: "CITROEN",
  // MERCEDES
  MERCEDES: "MERCEDES",
  // BMW
  BMW: "BMW",
  // SUZUKI
  SUZUKI: "SUZUKI", SWIFT: "SUZUKI", VITARA: "SUZUKI", JIMNY: "SUZUKI",
  // LADA
  LADA: "LADA",
  // CHERY
  CHERY: "CHERY", ORINOCO: "CHERY", TIGGO: "CHERY", ARAUCA: "CHERY",
  // ISUZU
  ISUZU: "ISUZU",
  // SEAT
  SEAT: "SEAT",
  // SKODA
  SKODA: "SKODA",
  // VENIRAUTO
  VENIRAUTO: "VENIRAUTO",
  // GREAT WALL
  "GREAT WALL": "GREAT WALL",
  // LAND ROVER (multi-token manejado en detectBrand)
  "LAND ROVER": "LAND ROVER", DISCOVERY: "LAND ROVER",
  FREELANDER: "LAND ROVER", DEFENDER: "LAND ROVER",
};

// ── Utilidades ─────────────────────────────────────────────────────────────────
function normalize(str) {
  return String(str || "")
    .replace(/\u00A5/g, "N")           // ¥ → N (MU¥ON en BD → MUNON)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // quitar tildes
    .replace(/[^A-Z0-9\s\-]/gi, " ")  // solo alfanumérico + espacio/guión
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Expande tokens singulares comunes al plural para mejorar el matching */
function expandTokens(tokens) {
  const singular2plural = {
    MANGUERA: "MANGUERAS",
    ESTOPERA: "ESTOPERAS",
    RODAMIENTO: "RODAMIENTOS",
    ROLINERA: "ROLINERAS",
    PASTILLA: "PASTILLAS",
    CORREA: "CORREAS",
    ANILLO: "ANILLOS",
    CONCHA: "CONCHAS",
    GOMA: "GOMAS",
    VALVULA: "VALVULAS",
    EMPACADURA: "EMPACADURAS",
    PISTÓN: "PISTONES",
    PISTON: "PISTONES",
    AMORTIGUADOR: "AMORTIGUADORES",
    SENSOR: "SENSORES",
    GUARDAPOLVO: "GUARDAPOLVOS",
  };
  const result = new Set(tokens);
  for (const t of tokens) {
    if (singular2plural[t]) result.add(singular2plural[t]);
    // también el inverso: si el token es plural y el mapa tiene su singular
    for (const [sg, pl] of Object.entries(singular2plural)) {
      if (t === pl) result.add(sg);
    }
  }
  return result;
}

// ── Detectar marca del vehículo ────────────────────────────────────────────────
function detectBrand(productName, brandByName) {
  const norm   = normalize(productName);
  const tokens = norm.split(" ");

  let bestBrand = null;
  let bestConf  = 0;
  let bestLen   = 0;

  function trySet(brand, conf, len) {
    if (!brand) return;
    if (conf > bestConf || (conf === bestConf && len > bestLen)) {
      bestBrand = brand;
      bestConf  = conf;
      bestLen   = len;
    }
  }

  // Frases de dos palabras (GRAND CHEROKEE, LAND ROVER, GREAT WALL…)
  for (let i = 0; i < tokens.length - 1; i++) {
    const phrase  = `${tokens[i]} ${tokens[i + 1]}`;
    const target  = BRAND_ALIASES[phrase];
    if (target) trySet(brandByName[target], 2, 2);
  }

  // Palabras individuales
  for (const token of tokens) {
    if (token.length < 2) continue;
    // Nombre exacto de marca en BD (prioridad máxima)
    if (brandByName[token]) trySet(brandByName[token], 3, 1);
    // Alias de modelo
    const target = BRAND_ALIASES[token];
    if (target) trySet(brandByName[target], 2, 1);
  }

  return bestBrand ? { brand: bestBrand, confidence: bestConf } : null;
}

// ── Detectar subcategoría por scoring de tokens ────────────────────────────────
function detectSubcategory(productName, subcategories) {
  const norm          = normalize(productName);
  const rawTokens     = norm.split(" ").filter(t => t.length >= 3);
  const productTokens = expandTokens(rawTokens);

  let bestSub   = null;
  let bestScore = 0;
  let bestRatio = 0;        // tokens coincidentes / tokens de la subcategoría
  let bestTotal = Infinity; // menor total de tokens = más preciso en empate

  for (const sub of subcategories) {
    const subTokens = normalize(sub.name).split(" ").filter(t => t.length >= 3);
    if (!subTokens.length) continue;
    let score = 0;
    for (const t of subTokens) {
      if (productTokens.has(t)) score++;
    }
    if (score > 0) {
      const ratio = score / subTokens.length;
      if (
        score > bestScore ||
        (score === bestScore && ratio > bestRatio) ||
        (score === bestScore && ratio === bestRatio && subTokens.length < bestTotal)
      ) {
        bestSub   = sub;
        bestScore = score;
        bestRatio = ratio;
        bestTotal = subTokens.length;
      }
    }
  }

  return bestSub ? { sub: bestSub, score: bestScore } : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(66)}`);
  console.log("  Asignación de brand_id / subcategory_id / category_id");
  console.log(`${"═".repeat(66)}`);
  console.log(`  Modo            : ${DRY_RUN ? "DRY-RUN (sin cambios en BD)" : "APLICAR CAMBIOS"}`);
  console.log(`  Min confianza   : ${MIN_CONFIDENCE}`);
  console.log(`  Solo NULL       : ${ONLY_UNSET ? "sí" : "no (todos los productos)"}`);
  if (LIMIT) console.log(`  Límite filas    : ${LIMIT}`);
  if (!DRY_RUN) {
    console.log(`  Log cada N UPDATEs: ${LOG_EVERY}`);
    console.log(`  COMMIT cada lote: ${BATCH_SIZE} filas (heartbeat cada ${HEARTBEAT_EVERY} iteraciones)`);
    console.log(
      `  Locks: ${USE_SKIP_LOCKED ? "SKIP LOCKED (filas ocupadas se omiten y podés re-ejecutar)" : `espera hasta ${pgLockTimeoutValue(LOCK_TIMEOUT_MS)}`}`
    );
  }
  console.log(`${"═".repeat(66)}\n`);

  // Cargar catálogos
  const [brandsRes, subsRes] = await Promise.all([
    pool.query(`SELECT id, name, sku_prefix FROM crm_vehicle_brands ORDER BY name`),
    pool.query(`
      SELECT ps.id, ps.name, ps.sku_prefix, ps.category_id,
             cp.category_descripcion AS cat_name
      FROM product_subcategories ps
      JOIN category_products cp ON cp.id = ps.category_id
      ORDER BY ps.id
    `),
  ]);

  // Mapa normalizado de marcas: "CHEVROLET" → {id, name, sku_prefix}
  const brandByName = {};
  for (const b of brandsRes.rows) {
    brandByName[normalize(b.name)] = b;
  }

  const subcategories = subsRes.rows;

  // Cargar productos
  const whereClause = ONLY_UNSET
    ? `WHERE (brand_id IS NULL OR subcategory_id IS NULL OR category_id IS NULL)`
    : ``;
  const limitClause = LIMIT ? `LIMIT ${LIMIT}` : "";

  const prodsRes = await pool.query(
    `SELECT id, sku, name, brand_id, subcategory_id, category_id
     FROM products ${whereClause} ORDER BY id ${limitClause}`
  );
  const products = prodsRes.rows;
  console.log(`  Productos a evaluar: ${products.length}\n`);

  const toUpdate = [];
  const noMatch  = [];

  for (const p of products) {
    const brandMatch = detectBrand(p.name, brandByName);
    const subMatch   = detectSubcategory(p.name, subcategories);

    const brandOk = brandMatch && brandMatch.confidence >= MIN_CONFIDENCE;
    const subOk   = subMatch   && subMatch.score        >= MIN_CONFIDENCE;

    if (brandOk || subOk) {
      toUpdate.push({
        product: p,
        brand:   brandOk ? brandMatch : null,
        sub:     subOk   ? subMatch   : null,
      });
    } else {
      noMatch.push(p);
    }
  }

  // ── Tabla de resultados ──────────────────────────────────────────────────────
  const COL_ID   = 8;
  const COL_NAME = 45;
  const COL_BRAN = 22;
  const header =
    "ID".padEnd(COL_ID) +
    "NOMBRE".padEnd(COL_NAME) +
    "MARCA (c)".padEnd(COL_BRAN) +
    "SUBCATEGORÍA (s)";

  console.log(`  Productos con match: ${toUpdate.length}  |  Sin match: ${noMatch.length}\n`);
  console.log(`  ${header}`);
  console.log(`  ${"─".repeat(header.length)}`);

  for (const r of toUpdate) {
    const bStr = r.brand
      ? `${r.brand.brand.name} (${r.brand.confidence})`.padEnd(COL_BRAN)
      : "─".padEnd(COL_BRAN);
    const sStr = r.sub
      ? `${r.sub.sub.name} (${r.sub.score})`
      : "─";
    const nameShort = String(r.product.name || "").slice(0, COL_NAME - 2).padEnd(COL_NAME);
    console.log(`  ${String(r.product.id).padEnd(COL_ID)}${nameShort}${bStr}${sStr}`);
  }

  if (noMatch.length) {
    console.log(`\n  SIN MATCH (${noMatch.length}):`);
    noMatch.slice(0, 40).forEach(p =>
      console.log(`    [${p.id}] ${p.name}`)
    );
    if (noMatch.length > 40) console.log(`    … y ${noMatch.length - 40} más.`);
  }

  // Estadísticas
  const cBrand = toUpdate.filter(r => r.brand).length;
  const cSub   = toUpdate.filter(r => r.sub).length;
  const cBoth  = toUpdate.filter(r => r.brand && r.sub).length;

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Con marca            : ${cBrand}`);
  console.log(`  Con subcategoría     : ${cSub}`);
  console.log(`  Con ambos            : ${cBoth}`);
  console.log(`  Sin ningún match     : ${noMatch.length}`);
  console.log(`${"─".repeat(66)}`);

  if (DRY_RUN) {
    console.log("\n  [DRY-RUN] Ningún cambio aplicado.\n");
    await pool.end();
    return;
  }

  // ── Aplicar cambios (lotes + latido: evita bloqueo largo en products y “pantalla muerta”) ──
  console.log("\n  Aplicando cambios en BD…");
  console.log("  → pidiendo conexión al pool…");
  const client = await pool.connect();
  console.log("  → conexión obtenida.");
  let updated = 0;
  let skipped = 0;
  let errors  = 0;
  let skippedLocked = 0;
  let loopIdx = 0;
  const tApplyStart = Date.now();
  const totalBatches = Math.ceil(toUpdate.length / BATCH_SIZE) || 1;

  try {
    for (let start = 0; start < toUpdate.length; start += BATCH_SIZE) {
      const chunk = toUpdate.slice(start, start + BATCH_SIZE);
      const batchNo = Math.floor(start / BATCH_SIZE) + 1;
      console.log(
        `  → lote ${batchNo}/${totalBatches} (índices ${start + 1}…${start + chunk.length} de ${toUpdate.length})`
      );
      console.log("     ejecutando BEGIN (si se queda aquí, otra sesión tiene lock en `products`)…");

      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = ${USE_SKIP_LOCKED ? "'0'" : `'${pgLockTimeoutValue(LOCK_TIMEOUT_MS)}'`}`);
      await client.query("SET LOCAL statement_timeout = '0'");
      console.log(`     BEGIN OK; ${chunk.length} filas en este lote…`);

      try {
        for (const r of chunk) {
          loopIdx++;
          const sec = ((Date.now() - tApplyStart) / 1000).toFixed(1);
          if (loopIdx % HEARTBEAT_EVERY === 0) {
            console.log(
              `     … latido: fila ${loopIdx}/${toUpdate.length} | UPDATEs=${updated} omitidos=${skipped} bloqueadas=${skippedLocked} errores=${errors} (${sec}s)`
            );
          }

          const setClauses = [];
          const values     = [];
          let   idx        = 1;

          if (r.brand && r.product.brand_id !== r.brand.brand.id) {
            setClauses.push(`brand_id = $${idx++}`);
            values.push(r.brand.brand.id);
          }
          if (r.sub && r.product.subcategory_id !== r.sub.sub.id) {
            setClauses.push(`subcategory_id = $${idx++}`);
            values.push(r.sub.sub.id);
          }
          if (r.sub && r.product.category_id !== r.sub.sub.category_id) {
            setClauses.push(`category_id = $${idx++}`);
            values.push(r.sub.sub.category_id);
          }

          if (!setClauses.length) {
            skipped++;
            continue;
          }

          setClauses.push("updated_at = NOW()");
          values.push(r.product.id);
          const setSummary = setClauses.filter((c) => !c.includes("updated_at")).join(", ");

          await client.query("SAVEPOINT sp_assign_identity");
          try {
            let rowCount = 0;
            if (USE_SKIP_LOCKED) {
              const parts = [];
              const valsSk = [r.product.id];
              let ip = 2;
              if (r.brand && r.product.brand_id !== r.brand.brand.id) {
                parts.push(`brand_id = $${ip++}`);
                valsSk.push(r.brand.brand.id);
              }
              if (r.sub && r.product.subcategory_id !== r.sub.sub.id) {
                parts.push(`subcategory_id = $${ip++}`);
                valsSk.push(r.sub.sub.id);
              }
              if (r.sub && r.product.category_id !== r.sub.sub.category_id) {
                parts.push(`category_id = $${ip++}`);
                valsSk.push(r.sub.sub.category_id);
              }
              parts.push("updated_at = NOW()");
              const sqlSk =
                `WITH picked AS (SELECT id FROM products WHERE id = $1 FOR UPDATE SKIP LOCKED) ` +
                `UPDATE products AS p SET ${parts.join(", ")} FROM picked WHERE p.id = picked.id`;
              const resSk = await client.query(sqlSk, valsSk);
              rowCount = resSk.rowCount || 0;
            } else {
              const resPlain = await client.query(
                `UPDATE products SET ${setClauses.join(", ")} WHERE id = $${idx}`,
                values
              );
              rowCount = resPlain.rowCount || 0;
            }

            if (USE_SKIP_LOCKED && rowCount === 0) {
              skippedLocked++;
            } else {
              updated++;
            }

            await client.query("RELEASE SAVEPOINT sp_assign_identity");
            // Importante: (0 % N === 0) en JS; sin `updated > 0` se imprimiría en cada fila bloqueada.
            if (updated > 0 && updated % LOG_EVERY === 0) {
              const s2 = ((Date.now() - tApplyStart) / 1000).toFixed(1);
              console.log(
                `     … ${updated} UPDATEs OK, ${skipped} omitidos, ${skippedLocked} bloqueadas, ${errors} errores (${s2}s)`
              );
            } else if (USE_SKIP_LOCKED && skippedLocked > 0 && skippedLocked % 200 === 0) {
              const s2 = ((Date.now() - tApplyStart) / 1000).toFixed(1);
              console.log(
                `     … ${skippedLocked} filas aún bloqueadas por otras sesiones (UPDATEs=${updated}). Cerrá DBeaver / transacciones en products y re-ejecutá. (${s2}s)`
              );
            }
          } catch (e) {
            try {
              await client.query("ROLLBACK TO SAVEPOINT sp_assign_identity");
            } catch (re) {
              console.error("  ❌ ROLLBACK TO SAVEPOINT falló:", re.message);
              logIdentityAssignError(
                { productId: r.product.id, sku: r.product.sku, setSummary: "ROLLBACK TO" },
                re
              );
              throw re;
            }
            errors++;
            logIdentityAssignError(
              { productId: r.product.id, sku: r.product.sku, setSummary },
              e
            );
          }
        }

        await client.query("COMMIT");
        const s3 = ((Date.now() - tApplyStart) / 1000).toFixed(1);
        console.log(
          `  ← lote ${batchNo}/${totalBatches} COMMIT OK — acum. UPDATEs=${updated} omitidos=${skipped} bloqueadas=${skippedLocked} errores=${errors} (${s3}s)`
        );
      } catch (batchErr) {
        await client.query("ROLLBACK").catch(() => {});
        logIdentityAssignError(
          { productId: 0, sku: "", setSummary: `lote ${batchNo} ROLLBACK` },
          batchErr
        );
        throw batchErr;
      }
    }

    if (updated > 0 && updated % LOG_EVERY !== 0) {
      const sec = ((Date.now() - tApplyStart) / 1000).toFixed(1);
      console.log(
        `  … resumen final escritura: ${updated} UPDATEs OK, ${skipped} omitidos, ${skippedLocked} bloqueadas (re-ejecutar), ${errors} errores (${sec}s)`
      );
    }
  } finally {
    client.release();
    console.log("  → conexión liberada.");
  }

  console.log(`\n${"═".repeat(66)}`);
  console.log("  RESULTADO FINAL");
  console.log(`${"═".repeat(66)}`);
  console.log(`  Filas actualizadas : ${updated}`);
  console.log(`  Sin cambio (iguales): ${skipped}`);
  console.log(`  Omitidas (lock)    : ${skippedLocked}  ${skippedLocked ? "→ volvé a correr el script cuando no haya otras sesiones en products" : ""}`);
  console.log(`  Errores            : ${errors}`);
  console.log(`  Sin match (quedan) : ${noMatch.length}`);
  console.log(`${"═".repeat(66)}\n`);

  await pool.end();
}

main().catch((e) => {
  console.error("\n❌ Error fatal:", e.message);
  if (e.stack) console.error(e.stack);
  try {
    const block =
      `[${new Date().toISOString()}] FATAL (main)\n${e.message}\n${String(e.stack || "").slice(0, 8000)}\n${"─".repeat(72)}\n`;
    fs.appendFileSync(ERROR_LOG_PATH, block, "utf8");
    console.error(`→ detalle en ${ERROR_LOG_PATH}`);
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
