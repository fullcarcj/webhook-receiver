"use strict";

// DECISIÓN: singleton Firebase usando getApps() para evitar doble inicialización
// si otro módulo ya lo inicializó (p. ej. firebase-key.json en server.js).
let _bucket = null;

function resolveFirebaseCredential() {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  // Si las tres variables están definidas, usarlas directamente
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    };
  }

  // Fallback: leer firebase-key.json del raíz del proyecto
  try {
    const path = require("path");
    const keyPath = path.join(__dirname, "../../../firebase-key.json");
    const key = require(keyPath);
    if (key && key.project_id) {
      return {
        projectId:   key.project_id,
        clientEmail: key.client_email,
        privateKey:  key.private_key,
      };
    }
  } catch (_e) {
    // archivo no disponible (producción sin firebase-key.json)
  }

  throw new Error(
    "Firebase no configurado: define FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en las variables de entorno."
  );
}

function getBucket() {
  if (_bucket) return _bucket;
  const { getApps, initializeApp, cert } = require("firebase-admin/app");
  const { getStorage } = require("firebase-admin/storage");

  const BUCKET = "webhook-receiver-b74d8.firebasestorage.app";

  if (getApps().length === 0) {
    initializeApp({
      credential: cert(resolveFirebaseCredential()),
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
  // Nombre determinístico por messageId: misma ruta en Firebase → sobreescribe en lugar de duplicar
  const safeExt = originalName
    ? (originalName.split(".").pop() || ext)
    : ext;
  const safePhone = String(phone || "unknown").replace(/\D/g, "");
  const safeMsgId = String(messageId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safePhone}/${safeMsgId}.${safeExt}`;
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
