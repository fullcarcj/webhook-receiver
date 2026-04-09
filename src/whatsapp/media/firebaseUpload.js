"use strict";

// DECISIÓN: singleton Firebase usando getApps() para evitar doble inicialización
// si otro módulo ya lo inicializó (p. ej. firebase-key.json en server.js).
let _bucket = null;

function getBucket() {
  if (_bucket) return _bucket;
  const { getApps, initializeApp, cert } = require("firebase-admin/app");
  const { getStorage } = require("firebase-admin/storage");

  const BUCKET = "webhook-receiver-b74d8.firebasestorage.app";

  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
      storageBucket: BUCKET,
    });
  }

  _bucket = getStorage().bucket(BUCKET);
  return _bucket;
}

/**
 * @param {string} phone
 * @param {string} messageId
 * @param {string} ext — extensión por defecto del tipo
 * @param {string|null} originalName — nombre original del archivo (si existe)
 */
function buildFileName(phone, messageId, ext, originalName) {
  const ts     = Date.now();
  const safeExt = originalName
    ? (originalName.split(".").pop() || ext)
    : ext;
  return `${phone}/${ts}_${messageId}.${safeExt}`;
}

/**
 * Sube un Buffer a Firebase Storage y retorna la URL pública permanente.
 * @param {{ buffer: Buffer, folder: string, fileName: string, mimeType: string }} opts
 * @returns {Promise<string>} URL pública
 */
async function uploadToFirebase({ buffer, folder, fileName, mimeType }) {
  const BUCKET = "webhook-receiver-b74d8.firebasestorage.app";
  const bucket   = getBucket();
  const filePath = `${folder}/${fileName}`;
  const file     = bucket.file(filePath);

  await file.save(buffer, {
    metadata: {
      contentType:  mimeType,
      cacheControl: "public, max-age=31536000",
    },
    public: true,
  });

  return (
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` +
    `${encodeURIComponent(filePath)}?alt=media`
  );
}

module.exports = { uploadToFirebase, buildFileName, getBucket };
