"use strict";

const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const SALT = "ai-gateway-v1";

function requireAdminSecret() {
  const s = process.env.ADMIN_SECRET;
  if (!s || !String(s).trim()) {
    throw new Error("ADMIN_SECRET requerido para cifrado de claves de proveedor");
  }
  return String(s);
}

function deriveKey() {
  return crypto.scryptSync(requireAdminSecret(), SALT, 32);
}

/**
 * @param {string} plain
 * @returns {string} base64(iv + tag + ciphertext)
 */
function encryptApiKey(plain) {
  if (plain == null || plain === "") return null;
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LEN });
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * @param {string} b64
 * @returns {string|null}
 */
function decryptApiKey(b64) {
  if (!b64 || !String(b64).trim()) return null;
  const buf = Buffer.from(String(b64), "base64");
  if (buf.length < IV_LEN + AUTH_TAG_LEN + 1) return null;
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const data = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LEN });
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
};
