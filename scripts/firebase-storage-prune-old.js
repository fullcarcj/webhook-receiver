#!/usr/bin/env node
"use strict";

/**
 * Limpieza de Firebase Storage: borra objetos más viejos que N días.
 *
 * Modo recomendado (por defecto): solo carpetas de multimedia WhatsApp:
 *   wa-audios/, wa-images/, wa-videos/
 * Nunca toca productos/ ni ninguna ruta bajo productos/.
 *
 * Variables de entorno (opcionales, la CLI tiene prioridad al final del parseo):
 *   FIREBASE_STORAGE_PRUNE_DAYS       — días de retención (default 20)
 *   FIREBASE_STORAGE_PRUNE_EXECUTE=1  — equivalente a --execute (útil en CI)
 *   FIREBASE_STORAGE_PRUNE_DRY_RUN=1  — fuerza dry-run aunque exista EXECUTE
 *   FIREBASE_STORAGE_PRUNE_PREFIXES   — lista separada por comas (solo si no usás --wa-media)
 *   FIREBASE_STORAGE_PRUNE_SKIP_WAIT=1 — sin espera de 5s antes del borrado
 *
 * npm run: NO uses --prefix (es reservado por npm). Usá --storage-prefix o --wa-media.
 * En PowerShell, si --days / --execute no aplican, usá los scripts `firebase:storage-prune:wa:15`
 * o ejecutá node directo: node scripts/firebase-storage-prune-old.js --days=15 --execute
 */

require("../load-env-local");

const { getBucket } = require("../src/whatsapp/media/firebaseUpload");

const MS_PER_DAY = 86_400_000;

/** Carpetas WA en el bucket (consola Firebase). No incluir productos/. */
const DEFAULT_WA_MEDIA_PREFIXES = ["wa-audios/", "wa-images/", "wa-videos/"];

/** Rutas que nunca se procesan (ni listado destructivo accidental). */
function isDeniedPath(storagePath) {
  const p = String(storagePath || "").replace(/^\/+/, "").toLowerCase();
  return p === "productos" || p.startsWith("productos/");
}

function assertAllowedPrefix(prefix) {
  const norm = String(prefix || "").trim();
  if (!norm) return;
  if (isDeniedPath(norm)) {
    console.error(
      "[firebase-prune] Bloqueado: no se permite operar sobre `productos/` " +
        "(usa solo --wa-media o --storage-prefix bajo carpetas permitidas)."
    );
    process.exit(2);
  }
}

function parsePrefixesFromEnv() {
  const raw = process.env.FIREBASE_STORAGE_PRUNE_PREFIXES;
  if (!raw || !String(raw).trim()) return null;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith("/") ? p : `${p}/`));
}

function parseArgs(argv) {
  let dryRun = process.env.FIREBASE_STORAGE_PRUNE_EXECUTE === "1" ? false : true;
  if (process.env.FIREBASE_STORAGE_PRUNE_DRY_RUN === "1") dryRun = true;

  let days = parseInt(process.env.FIREBASE_STORAGE_PRUNE_DAYS || "20", 10);
  if (!Number.isFinite(days) || days < 1) days = 20;

  let storagePrefix = "";
  let waMediaFlag = false;
  let allowFullBucket = false;
  let skipWait = process.env.FIREBASE_STORAGE_PRUNE_SKIP_WAIT === "1";

  for (const a of argv) {
    if (a === "--execute" || a === "--yes") dryRun = false;
    if (a === "--dry-run") dryRun = true;
    if (a === "--wa-media" || a === "--wa-media-only") waMediaFlag = true;
    if (a === "--allow-full-bucket") allowFullBucket = true;
    if (a === "--skip-wait") skipWait = true;
    if (a.startsWith("--storage-prefix=")) storagePrefix = String(a.slice("--storage-prefix=".length)).trim();
    if (a.startsWith("--folder=")) storagePrefix = String(a.slice("--folder=".length)).trim();
    if (a.startsWith("--days=")) {
      const n = parseInt(a.slice("--days=".length), 10);
      if (Number.isFinite(n) && n >= 1) days = n;
    }
    if (a === "--help" || a === "-h") {
      console.log(`
firebase-storage-prune-old.js

  Por defecto: solo wa-audios/, wa-images/, wa-videos/ (multimedia WhatsApp).
  Nunca borra ni recorre productos/.

Opciones:
  --wa-media          Solo las tres carpetas WA (también es el default si no pasás otra cosa).
  --days=N            Retención en días (default 20 o FIREBASE_STORAGE_PRUNE_DAYS).
  --storage-prefix=X  Una sola carpeta (no puede ser productos/).
  --folder=X          Alias de --storage-prefix=
  --dry-run           Solo listar (default si no hay FIREBASE_STORAGE_PRUNE_EXECUTE=1).
  --execute           Borrar en Storage.
  --skip-wait         Sin espera de 5s (CI / cron).
  --allow-full-bucket Peligro: todo el bucket salvo bloqueo explícito a productos/ en borrado.

Variables de entorno:
  FIREBASE_STORAGE_PRUNE_DAYS, FIREBASE_STORAGE_PRUNE_EXECUTE, FIREBASE_STORAGE_PRUNE_DRY_RUN,
  FIREBASE_STORAGE_PRUNE_PREFIXES  (coma-separado; desactiva el default WA si definís esto y no usás --wa-media)

Ejemplos:
  npm run firebase:storage-prune:wa:15
  npm run firebase:storage-prune:wa:15:live
  node scripts/firebase-storage-prune-old.js --wa-media --days=30 --execute --skip-wait

  candidatos=0: ningún archivo supera el umbral de días (todos más nuevos que la fecha límite).
`);
      process.exit(0);
    }
  }

  const envPrefixes = parsePrefixesFromEnv();
  let prefixes = [];

  if (allowFullBucket) {
    prefixes = [""];
  } else if (storagePrefix) {
    const p = storagePrefix.endsWith("/") ? storagePrefix : `${storagePrefix}/`;
    assertAllowedPrefix(p);
    prefixes = [p];
  } else if (waMediaFlag) {
    prefixes = [...DEFAULT_WA_MEDIA_PREFIXES];
  } else if (envPrefixes && envPrefixes.length) {
    prefixes = envPrefixes.map((p) => {
      const norm = p.endsWith("/") ? p : `${p}/`;
      assertAllowedPrefix(norm);
      return norm;
    });
  } else {
    // Sin argumentos: mismo comportamiento seguro que --wa-media
    prefixes = [...DEFAULT_WA_MEDIA_PREFIXES];
  }

  return { dryRun, days, prefixes, allowFullBucket, skipWait };
}

function ageDays(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / MS_PER_DAY;
}

async function pruneUnderPrefix(bucket, prefix, cutoff, dryRun) {
  let eligible = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = 0;

  const [files] = await bucket.getFiles({
    prefix: prefix || undefined,
    autoPaginate: true,
  });

  for (const file of files) {
    const name = file.name;
    if (isDeniedPath(name)) {
      skipped++;
      continue;
    }
    try {
      const [meta] = await file.getMetadata();
      const created = meta.timeCreated || meta.updated;
      if (!created) {
        skipped++;
        continue;
      }
      const t = new Date(created).getTime();
      if (!Number.isFinite(t) || t >= cutoff) {
        skipped++;
        continue;
      }
      const ad = ageDays(created);
      eligible++;
      const line = `  ${name}  (${created} · ~${ad != null ? ad.toFixed(1) : "?"} días)`;
      if (dryRun) {
        console.log(line);
      } else {
        await file.delete();
        deleted++;
        console.log(`[borrado] ${line}`);
      }
    } catch (e) {
      errors++;
      console.error(`[error] ${name}:`, e && e.message ? e.message : e);
    }
  }

  return { eligible, skipped, deleted, errors };
}

async function main() {
  const { dryRun, days, prefixes, allowFullBucket, skipWait } = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - days * MS_PER_DAY;
  const cutoffIso = new Date(cutoff).toISOString();

  if (!dryRun && !skipWait) {
    console.warn("[firebase-prune] ATENCIÓN: borrado real en 5s (Ctrl+C o --skip-wait en CI)…");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const bucket = getBucket();
  const label = allowFullBucket
    ? "(TODO EL BUCKET — productos/ se omite objeto a objeto)"
    : prefixes.join(", ");

  console.log(
    `[firebase-prune] bucket=${bucket.name} prefijos=[${label}] ` +
      `umbral=${days} días (anteriores a ${cutoffIso}) modo=${dryRun ? "DRY-RUN" : "EJECUCIÓN"}`
  );

  let totalE = 0;
  let totalS = 0;
  let totalD = 0;
  let totalErr = 0;

  for (const prefix of prefixes) {
    if (prefix && isDeniedPath(prefix)) {
      console.error(`[firebase-prune] Saltando prefijo prohibido: ${prefix}`);
      continue;
    }
    console.log(`\n--- Prefijo: "${prefix || "(raíz)"}" ---`);
    const r = await pruneUnderPrefix(bucket, prefix, cutoff, dryRun);
    totalE += r.eligible;
    totalS += r.skipped;
    totalD += r.deleted;
    totalErr += r.errors;
    console.log(
      `    subtotal: candidatos=${r.eligible} omitidos=${r.skipped} ` +
        `${dryRun ? "" : `borrados=${r.deleted} `}errores=${r.errors}`
    );
  }

  console.log(
    `\n[firebase-prune] TOTAL: candidatos=${totalE} omitidos=${totalS} ` +
      `${dryRun ? "(dry-run)" : `borrados=${totalD}`} errores=${totalErr}`
  );

  if (dryRun && totalE > 0) {
    console.log("\nPara borrar: mismo comando con --execute (y en CI --skip-wait).");
  }
  if (totalE === 0) {
    console.log(
      "\n[firebase-prune] Ningún objeto por encima del umbral de días: " +
        "los archivos listados como «omitidos» son más recientes que la fecha de corte (o sin fecha)."
    );
  }
}

main().catch((err) => {
  console.error("[firebase-prune] fallo:", err && err.message ? err.message : err);
  process.exit(1);
});
