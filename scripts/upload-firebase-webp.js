#!/usr/bin/env node
/**
 * Sube recursivamente .webp locales a Firebase Storage (Admin SDK).
 *
 * Requisitos:
 * - `firebase-key.json` en la raíz del repo (service account; NO subir a git).
 * - Reglas de Storage que permitan lectura pública en el prefijo usado, o ajustar tras `makePublic()`.
 *
 * Env:
 *   FIREBASE_KEY_JSON     ruta al JSON (default: ../firebase-key.json)
 *   FIREBASE_STORAGE_BUCKET  (default: webhook-receiver-b74d8.firebasestorage.app)
 *   FIREBASE_UPLOAD_SOURCE   carpeta local (default: Desktop/lote20_procesadas)
 *   FIREBASE_STORAGE_PREFIX  prefijo en bucket (default: productos)
 *   FIREBASE_URLS_JSON_OUT   salida del mapa URL (default: {source}/urls_imagenes.json)
 *   FIREBASE_UPLOAD_CONCURRENCY (default: 10)
 */

const fs = require("fs/promises");
const path = require("path");
const { createWriteStream } = require("fs");
const pLimitModule = require("p-limit");
const pLimit = typeof pLimitModule === "function" ? pLimitModule : pLimitModule.default;

const DEFAULT_SOURCE = String.raw`C:\Users\Javier\Desktop\lote20_procesadas`;
const DEFAULT_BUCKET = "webhook-receiver-b74d8.firebasestorage.app";
const DEFAULT_PREFIX = "productos";

const SOURCE = process.env.FIREBASE_UPLOAD_SOURCE || DEFAULT_SOURCE;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_BUCKET;
const PREFIX = (process.env.FIREBASE_STORAGE_PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.FIREBASE_UPLOAD_CONCURRENCY || 10) || 10));
const KEY_PATH =
  process.env.FIREBASE_KEY_JSON || path.join(__dirname, "..", "firebase-key.json");
const OUT_JSON =
  process.env.FIREBASE_URLS_JSON_OUT || path.join(SOURCE, "urls_imagenes.json");
const LOG_EVERY = Math.max(1, Number(process.env.FIREBASE_LOG_EVERY || 100) || 100);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function collectWebpFiles(rootDir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && path.extname(ent.name).toLowerCase() === ".webp") {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

/** Clave estable: ruta relativa con `/` (evita colisiones entre carpetas). */
function keyForFile(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

/** Destino en bucket: prefix/rel/path.webp */
function destInBucket(rootDir, absolutePath) {
  const rel = keyForFile(rootDir, absolutePath);
  return PREFIX ? `${PREFIX}/${rel}` : rel;
}

function publicDownloadUrl(bucketName, objectPath) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucketName
  )}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

async function uploadOne(bucket, rootDir, absolutePath) {
  const destPath = destInBucket(rootDir, absolutePath);
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bucket.upload(absolutePath, {
        destination: destPath,
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000",
        },
      });
      const file = bucket.file(destPath);
      await file.makePublic();
      const url = publicDownloadUrl(bucket.name, destPath);
      return { key: keyForFile(rootDir, absolutePath), url };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastErr;
}

async function main() {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (e) {
    console.error("Instalá la dependencia: npm install firebase-admin");
    process.exit(1);
    return;
  }

  let serviceAccount;
  try {
    const raw = await fs.readFile(KEY_PATH, "utf8");
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    console.error(
      `No se pudo leer ${KEY_PATH}. Colocá el JSON de service account de Firebase (o FIREBASE_KEY_JSON).`
    );
    console.error(e.message || e);
    process.exit(1);
    return;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: BUCKET_NAME,
    });
  }

  const bucket = admin.storage().bucket(BUCKET_NAME);

  console.log("Firebase Storage — subida masiva .webp");
  console.log(`Origen local: ${SOURCE}`);
  console.log(`Bucket:       ${BUCKET_NAME}`);
  console.log(`Prefijo:      ${PREFIX || "(raíz)"}`);
  console.log(`Concurrencia: ${CONCURRENCY}`);
  console.log(`Salida JSON:  ${OUT_JSON}`);

  let files;
  try {
    files = await collectWebpFiles(SOURCE);
  } catch (e) {
    console.error("No se pudo leer la carpeta origen:", e.message || e);
    process.exit(1);
    return;
  }

  const total = files.length;
  if (total === 0) {
    console.log("No hay archivos .webp bajo la carpeta origen.");
    process.exit(0);
    return;
  }

  const errLog = path.join(path.dirname(OUT_JSON), "_firebase_upload_errors.log");
  const errStream = createWriteStream(errLog, { flags: "a" });
  errStream.write(`\n--- ${new Date().toISOString()} inicio (${total} archivos) ---\n`);

  const map = {};
  const limit = pLimit(CONCURRENCY);
  let done = 0;
  let ok = 0;
  let fail = 0;

  const tasks = files.map((abs) =>
    limit(async () => {
      try {
        const { key, url } = await uploadOne(bucket, SOURCE, abs);
        map[key] = url;
        ok++;
      } catch (e) {
        fail++;
        const msg = e instanceof Error ? e.message : String(e);
        errStream.write(`${new Date().toISOString()}\t${abs}\t${msg}\n`);
        console.error(`[fallo] ${abs}: ${msg}`);
      } finally {
        done++;
        if (done % LOG_EVERY === 0 || done === total) {
          console.log(`Subida ${done}/${total}… | OK: ${ok} | Fallos: ${fail}`);
        }
      }
    })
  );

  await Promise.all(tasks);

  errStream.write(`--- fin ok=${ok} fail=${fail} ---\n`);
  errStream.end();

  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.writeFile(OUT_JSON, JSON.stringify(map, null, 2), "utf8");

  console.log("---");
  console.log(`Listo. Mapa: ${OUT_JSON}`);
  console.log(`Errores: ${errLog}`);
  console.log(
    "Nota: las URLs usan objeto público (makePublic). Revisá reglas de Storage si no abren en el navegador."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
