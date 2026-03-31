#!/usr/bin/env node
/**
 * Pipeline de imágenes (Solomotor3k): normaliza a 800×800 WebP con fondo blanco.
 * Uso: node scripts/process-lote-imagenes-solomotor.js
 *
 * Rutas por defecto (Windows); sobrescribibles con env:
 *   LOTE_ORIGEN  (default: C:\Users\Javier\Desktop\lote20)
 *   LOTE_DESTINO (default: C:\Users\Javier\Desktop\lote20_procesadas)
 *
 * Sharp: sin withMetadata() en la salida → no se copian EXIF/ICC al WebP (comportamiento deseado).
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

const EXT_OK = new Set([".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp"]);

const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.LOTE_CONCURRENCY || 5) || 5));
const LOG_EVERY = Math.max(1, Number(process.env.LOTE_LOG_EVERY || 100) || 100);

function extLower(p) {
  return path.extname(p).toLowerCase();
}

function isImageFile(filePath) {
  return EXT_OK.has(extLower(filePath));
}

/** Recorre recursivamente y devuelve rutas absolutas de imágenes. */
async function collectImages(rootDir) {
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
      } else if (ent.isFile() && isImageFile(full)) {
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

async function processOne(absoluteSrc, srcRoot, destRoot) {
  const outPath = toDestWebpPath(srcRoot, destRoot, absoluteSrc);
  await ensureParentDir(outPath);

  const pipeline = sharp(absoluteSrc, {
    failOn: "none",
    limitInputPixels: Math.pow(2, 30),
  })
    .resize(800, 800, {
      fit: "contain",
      position: "center",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .webp({ quality: 80 });

  // No encadenar withMetadata()/keepMetadata(): la salida WebP no hereda EXIF/ICC.
  await pipeline.toFile(outPath);
}

async function main() {
  console.log("Solomotor3k — pipeline de imágenes (sharp)");
  console.log(`Origen:  ${SRC}`);
  console.log(`Destino: ${DEST}`);
  console.log(`Concurrencia: ${CONCURRENCY}`);

  await fs.mkdir(DEST, { recursive: true });

  let list;
  try {
    list = await collectImages(SRC);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
    return;
  }

  const total = list.length;
  if (total === 0) {
    console.log("No se encontraron imágenes con extensiones admitidas.");
    process.exit(0);
    return;
  }

  const errLogPath = path.join(DEST, "_errores_pipeline.log");
  const errStream = createWriteStream(errLogPath, { flags: "a" });
  errStream.write(`\n--- ${new Date().toISOString()} inicio lote (${total} archivos) ---\n`);

  const limit = pLimit(CONCURRENCY);
  let ok = 0;
  let errores = 0;
  let finalizados = 0;

  function logProgreso() {
    const pct = total ? ((finalizados / total) * 100).toFixed(1) : "0";
    console.log(
      `[Progreso: ${finalizados}/${total} (${pct}%)] | Errores: ${errores}`
    );
  }

  const tasks = list.map((absSrc) =>
    limit(async () => {
      try {
        await processOne(absSrc, SRC, DEST);
        ok++;
      } catch (e) {
        errores++;
        const line = `${new Date().toISOString()}\t${absSrc}\t${e.message || e}\n`;
        errStream.write(line);
        console.error(`[fallo] ${absSrc}: ${e.message || e}`);
      } finally {
        finalizados++;
        if (finalizados % LOG_EVERY === 0 || finalizados === total) {
          logProgreso();
        }
      }
    })
  );

  await Promise.all(tasks);

  errStream.write(
    `--- ${new Date().toISOString()} fin: ok=${ok}, errores=${errores} ---\n`
  );
  errStream.end();

  console.log("---");
  console.log(`Listo. OK: ${ok} | Errores: ${errores} | Total: ${total}`);
  console.log(`Log de fallos: ${errLogPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
