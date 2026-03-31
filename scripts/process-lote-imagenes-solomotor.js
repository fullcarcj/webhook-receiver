#!/usr/bin/env node
/**
 * Pipeline de imágenes (Solomotor3k): buffer → Sharp detecta formato por firma; salida siempre WebP.
 *
 * Uso: node scripts/process-lote-imagenes-solomotor.js
 * Env: LOTE_ORIGEN, LOTE_DESTINO, LOTE_CONCURRENCY (default 5), LOTE_LOG_EVERY (default 100),
 *      LOTE_MAX_BYTES (default ~40MB, evita leer binarios enormes por error)
 */

const fs = require("fs/promises");
const path = require("path");
const { createWriteStream } = require("fs");
const pLimitModule = require("p-limit");
const pLimit = typeof pLimitModule === "function" ? pLimitModule : pLimitModule.default;
const sharp = require("sharp");

const DEFAULT_ORIGEN = String.raw`C:\Users\Javier\Desktop\lote20`;
const DEFAULT_DESTINO = String.raw`C:\Users\Javier\Desktop\lote20_procesadas`;

const SRC = process.env.LOTE_ORIGEN || DEFAULT_ORIGEN;
const DEST = process.env.LOTE_DESTINO || DEFAULT_DESTINO;

const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.LOTE_CONCURRENCY || 5) || 5));
const LOG_EVERY = Math.max(1, Number(process.env.LOTE_LOG_EVERY || 100) || 100);
const MAX_BYTES = Math.max(
  1024,
  Number(process.env.LOTE_MAX_BYTES || 40 * 1024 * 1024) || 40 * 1024 * 1024
);

/** Ignorar artefactos típicos de sistema (no son imágenes de lote). */
const SKIP_NAMES = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

/**
 * Lista recursiva de todos los archivos (agnóstico a extensión).
 * Sharp decidirá por magic bytes si el buffer es imagen decodificable.
 */
async function collectAllFiles(rootDir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      throw new Error(`No se puede leer ${current}: ${e.message}`);
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        if (SKIP_NAMES.has(ent.name.toLowerCase())) continue;
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

function toDestWebpPath(srcRoot, destRoot, absoluteSrc) {
  const rel = path.relative(srcRoot, absoluteSrc);
  const dir = path.dirname(rel);
  const base = path.basename(rel, path.extname(rel));
  const outName = `${base}.webp`;
  return path.join(destRoot, dir === "." ? outName : path.join(dir, outName));
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Lee el archivo completo en memoria y decodifica con Sharp (formato real, no la extensión).
 * Salida: WebP 800×800 sin preservar EXIF/ICC (no usar withMetadata() en la salida).
 */
async function processOneBuffer(absoluteSrc, srcRoot, destRoot) {
  const st = await fs.stat(absoluteSrc);
  if (st.size === 0) {
    throw new Error("archivo vacío");
  }
  if (st.size > MAX_BYTES) {
    throw new Error(`supera LOTE_MAX_BYTES (${MAX_BYTES} bytes)`);
  }

  let buffer;
  try {
    buffer = await fs.readFile(absoluteSrc);
  } catch (e) {
    throw new Error(`lectura: ${e.message || e}`);
  }

  const outPath = toDestWebpPath(srcRoot, destRoot, absoluteSrc);
  await ensureParentDir(outPath);

  const pipeline = sharp(buffer, {
    failOn: "none",
    limitInputPixels: Math.pow(2, 30),
  })
    .resize(800, 800, {
      fit: "contain",
      position: "center",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .webp({ quality: 80 });

  await pipeline.toFile(outPath);
}

async function main() {
  console.log("Solomotor3k — pipeline de imágenes (sharp, lectura por buffer)");
  console.log(`Origen:  ${SRC}`);
  console.log(`Destino: ${DEST}`);
  console.log(`Concurrencia: ${CONCURRENCY} | max lectura: ${MAX_BYTES} bytes`);

  await fs.mkdir(DEST, { recursive: true });

  let list;
  try {
    list = await collectAllFiles(SRC);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
    return;
  }

  const total = list.length;
  if (total === 0) {
    console.log("No se encontraron archivos bajo el origen.");
    process.exit(0);
    return;
  }

  const errLogPath = path.join(DEST, "_errores_pipeline.log");
  const errStream = createWriteStream(errLogPath, { flags: "a" });
  errStream.write(`\n--- ${new Date().toISOString()} inicio (${total} rutas) buffer+sharp ---\n`);

  /** @type {{ path: string, message: string }[]} */
  const errores = [];

  const limit = pLimit(CONCURRENCY);
  let exitos = 0;
  let fallos = 0;
  let finalizados = 0;

  function logLine() {
    console.log(`[Éxito: ${exitos} | Fallos: ${fallos} | Total: ${total}]`);
  }

  const tasks = list.map((absSrc) =>
    limit(async () => {
      try {
        await processOneBuffer(absSrc, SRC, DEST);
        exitos++;
      } catch (e) {
        fallos++;
        const msg = e instanceof Error ? e.message : String(e);
        errores.push({ path: absSrc, message: msg });
        errStream.write(`${new Date().toISOString()}\t${absSrc}\t${msg}\n`);
      } finally {
        finalizados++;
        if (finalizados % LOG_EVERY === 0 || finalizados === total) {
          logLine();
        }
      }
    })
  );

  await Promise.all(tasks);

  errStream.write(
    `--- ${new Date().toISOString()} fin: éxitos=${exitos}, fallos=${fallos} ---\n`
  );
  errStream.end();

  console.log("---");
  logLine();
  console.log(`Log de fallos: ${errLogPath}`);
  if (errores.length > 0) {
    const muestra = errores.slice(0, 30);
    console.log(`Archivos con error (mostrando hasta ${muestra.length} de ${errores.length}):`);
    for (const { path: p, message: m } of muestra) {
      console.log(`  - ${p}`);
      console.log(`    ${m}`);
    }
    if (errores.length > 30) {
      console.log(`  … y ${errores.length - 30} más (ver log).`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
