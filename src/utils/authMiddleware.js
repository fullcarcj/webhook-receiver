'use strict';

const jwt      = require('jsonwebtoken');
const { pool } = require('../../db-postgres');
const { timingSafeCompare } = require('../services/currencyService');

const JWT_SECRET = process.env.JWT_SECRET;

// No lanzar en carga del módulo si JWT_SECRET falta — el servidor arranca
// y los endpoints que lo requieran responderán 503.
function ensureJwtSecret() {
  if (!JWT_SECRET) {
    throw Object.assign(
      new Error('JWT_SECRET no está configurado. Agregar en variables de entorno.'),
      { code: 'JWT_SECRET_MISSING' }
    );
  }
}

const ROLE_HIERARCHY = {
  SUPERUSER: 3,
  ADMIN:     2,
  OPERATOR:  1,
};

/**
 * Extrae el token JWT desde dos fuentes (en orden de prioridad):
 * 1. Authorization: Bearer <token>  → clientes API / curl
 * 2. Cookie: token=<token>          → browser (panel admin HTML)
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const cookies = req.headers['cookie'] || '';
  const match   = cookies.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Verifica el token JWT y que la sesión no esté revocada en BD.
 * Nunca lanza excepción — retorna null en cualquier fallo.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object|null>} payload del JWT o null
 */
async function verifyToken(req) {
  const token = extractToken(req);
  if (!token) return null;

  let payload;
  try {
    ensureJwtSecret();
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }

  if (!payload || !payload.jti) return null;

  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM user_sessions
       WHERE jti = $1 AND revoked = FALSE AND expires_at > now()`,
      [payload.jti]
    );
    if (!rows.length) return null;
  } catch {
    return null;
  }

  return payload;
}

/**
 * Requiere autenticación JWT o Cookie.
 * Si no es válido → responde 401 automáticamente y retorna null.
 * Si es válido → retorna el payload.
 *
 * Uso: const user = await requireAuth(req, res);
 *      if (!user) return;
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<object|null>}
 */
async function requireAuth(req, res) {
  const payload = await verifyToken(req);
  if (!payload) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error:   'UNAUTHORIZED',
      message: 'Token inválido, expirado o no proporcionado.',
    }));
    return null;
  }
  return payload;
}

/**
 * Verifica que el usuario tiene un permiso específico (module:action).
 * SUPERUSER bypasea siempre.
 * Los permisos vienen dentro del JWT payload — sin consulta a BD.
 *
 * Uso: if (!requirePermission(user, 'wms', 'write', res)) return;
 *
 * @param {object}  user    payload JWT
 * @param {string}  module
 * @param {string}  action
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function requirePermission(user, module, action, res) {
  if (user.role === 'SUPERUSER') return true;

  const has = Array.isArray(user.permissions) &&
    user.permissions.some(p => p.module === module && p.action === action);

  if (!has) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error:    'FORBIDDEN',
      message:  `Sin permiso: ${module}:${action}`,
      required: { module, action },
    }));
    return false;
  }
  return true;
}

/**
 * Verifica que el usuario tiene al menos el rol mínimo requerido.
 * SUPERUSER(3) > ADMIN(2) > OPERATOR(1)
 *
 * Uso: if (!requireRole(user, 'ADMIN', res)) return;
 *
 * @param {object}  user     payload JWT
 * @param {string}  minRole  rol mínimo requerido
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function requireRole(user, minRole, res) {
  const userLevel = ROLE_HIERARCHY[user.role] || 0;
  const minLevel  = ROLE_HIERARCHY[minRole]   || 99;

  if (userLevel < minLevel) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error:    'FORBIDDEN',
      message:  `Requiere rol ${minRole} o superior`,
      yourRole: user.role,
    }));
    return false;
  }
  return true;
}

/**
 * Puente de transición: acepta JWT Bearer/Cookie (nuevo) O X-Admin-Secret (legado).
 *
 * Con X-Admin-Secret genera un payload sintético SUPERUSER con userId=0.
 * Los handlers que usen user.userId para auditoría deben manejar:
 *   createdBy = user.userId || null
 *
 * Cuando todos los clientes migren a JWT → eliminar la rama X-Admin-Secret
 * y reemplazar checkAdminSecretOrJwt() por requireAuth() directamente.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<object|null>}
 */
async function checkAdminSecretOrJwt(req, res) {
  // 1. Intentar con JWT / Cookie primero
  const payload = await verifyToken(req);
  if (payload) return payload;

  // 2. Fallback a X-Admin-Secret (compatibilidad legado)
  const secret   = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'];
  if (secret && provided && timingSafeCompare(provided, secret)) {
    return {
      jti:         'admin-secret',
      userId:      0,
      username:    'admin-secret',
      role:        'SUPERUSER',
      companyId:   1,
      permissions: [], // SUPERUSER bypasea requirePermission() siempre
    };
  }

  // 3. También aceptar ?k= / ?secret= (igual que ensureAdmin legacy)
  const adminQueryEnabled = (() => {
    const v = process.env.ADMIN_SECRET_QUERY_AUTH;
    if (!v || v.trim() === '') return true;
    return !(v === '0' || /^false$/i.test(v));
  })();

  if (adminQueryEnabled && secret) {
    // Parsear query string manualmente (req.url puede incluir path)
    try {
      const raw = req.url || '';
      const qi  = raw.indexOf('?');
      if (qi !== -1) {
        const qs  = new URLSearchParams(raw.slice(qi + 1));
        const qk  = qs.get('k') || qs.get('secret');
        if (qk && timingSafeCompare(qk, secret)) {
          return {
            jti:         'admin-secret-query',
            userId:      0,
            username:    'admin-secret',
            role:        'SUPERUSER',
            companyId:   1,
            permissions: [],
          };
        }
      }
    } catch { /* ignorar errores de parsing */ }
  }

  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    error:   'UNAUTHORIZED',
    message: 'Se requiere Bearer token, Cookie de sesión o X-Admin-Secret.',
  }));
  return null;
}

module.exports = {
  extractToken,
  verifyToken,
  requireAuth,
  requirePermission,
  requireRole,
  checkAdminSecretOrJwt,
  ROLE_HIERARCHY,
};
