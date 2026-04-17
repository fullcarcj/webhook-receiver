'use strict';

const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { pool }       = require('../../db-postgres');

const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const BCRYPT_ROUNDS  = 12;
const MAX_ATTEMPTS   = 5;

// ── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Convierte string tipo '8h' / '24h' / '7d' a objeto Date de expiración.
 */
function expiresAtFromString(expiresIn) {
  const match = String(expiresIn || '8h').match(/^(\d+)([hmd])$/);
  if (!match) return new Date(Date.now() + 8 * 3600 * 1000);
  const n  = +match[1];
  const u  = match[2];
  const ms = u === 'h' ? n * 3_600_000
           : u === 'd' ? n * 86_400_000
           :              n * 60_000;
  return new Date(Date.now() + ms);
}

/**
 * Valida fortaleza de contraseña.
 * @returns {string|null} null = válida; string = mensaje de error
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Contraseña requerida';
  if (password.length < 8)      return 'Mínimo 8 caracteres';
  if (!/[A-Z]/.test(password))  return 'Debe contener al menos una mayúscula';
  if (!/[0-9]/.test(password))  return 'Debe contener al menos un número';
  return null;
}

/**
 * Carga los permisos del rol desde role_permissions (incl. roles añadidos por sql/20260416_roles_8niveles.sql).
 * @param {string} role
 * @returns {Promise<Array<{module: string, action: string}>>}
 */
async function loadPermissions(role) {
  const { rows } = await pool.query(
    `SELECT module, action FROM role_permissions WHERE role = $1 ORDER BY module, action`,
    [role]
  );
  return rows.map(r => ({ module: r.module, action: r.action }));
}

/**
 * Sanitiza un objeto usuario para respuesta (elimina campos sensibles).
 */
function sanitizeUser(u) {
  if (!u) return null;
  // eslint-disable-next-line no-unused-vars
  const { password_hash, reset_token, reset_token_exp, ...safe } = u;
  return safe;
}

// ── login ─────────────────────────────────────────────────────────────────────

/**
 * Autentica al usuario y devuelve JWT + sets sesión en BD.
 *
 * @param {{ username: string, password: string, ipAddress?: string, userAgent?: string }} p
 * @returns {Promise<{ token: string, expiresIn: string, user: object }>}
 */
async function login({ username, password, ipAddress, userAgent }) {
  if (!JWT_SECRET) {
    throw Object.assign(new Error('JWT_SECRET no configurado'), { code: 'JWT_SECRET_MISSING', status: 503 });
  }

  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE (username = $1 OR email = $1) AND company_id = 1
     LIMIT 1`,
    [String(username || '').trim().toLowerCase()]
  );

  // No revelar si el usuario existe o no
  if (!rows.length) {
    throw Object.assign(
      new Error('Credenciales inválidas'),
      { code: 'INVALID_CREDENTIALS', status: 401 }
    );
  }

  const user = rows[0];

  if (user.status === 'LOCKED') {
    throw Object.assign(
      new Error('Cuenta bloqueada por exceso de intentos fallidos. Contacta a un administrador.'),
      { code: 'ACCOUNT_LOCKED', status: 403 }
    );
  }
  if (user.status === 'INACTIVE') {
    throw Object.assign(
      new Error('Cuenta inactiva. Contacta a un administrador.'),
      { code: 'ACCOUNT_INACTIVE', status: 403 }
    );
  }

  const valid = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!valid) {
    const newAttempts = (user.failed_attempts || 0) + 1;
    if (newAttempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE users SET failed_attempts = $1, status = 'LOCKED', locked_at = now() WHERE id = $2`,
        [newAttempts, user.id]
      );
    } else {
      await pool.query(
        `UPDATE users SET failed_attempts = $1 WHERE id = $2`,
        [newAttempts, user.id]
      );
    }
    throw Object.assign(
      new Error('Credenciales inválidas'),
      { code: 'INVALID_CREDENTIALS', status: 401 }
    );
  }

  // Autenticación OK → resetear intentos y registrar login
  await pool.query(
    `UPDATE users SET failed_attempts = 0, last_login_at = now(), last_login_ip = $1 WHERE id = $2`,
    [ipAddress || null, user.id]
  );

  const permissions = await loadPermissions(user.role);
  const jti         = randomUUID();

  const jwtPayload = {
    jti,
    userId:    user.id,
    username:  user.username,
    role:      user.role,
    companyId: user.company_id,
    permissions,
  };

  const token     = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const expiresAt = expiresAtFromString(JWT_EXPIRES_IN);

  await pool.query(
    `INSERT INTO user_sessions (user_id, jti, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, jti, ipAddress || null, userAgent || null, expiresAt]
  );

  return {
    token,
    expiresIn: JWT_EXPIRES_IN,
    user: {
      id:       user.id,
      username: user.username,
      fullName: user.full_name,
      role:     user.role,
      email:    user.email,
    },
  };
}

// ── logout ────────────────────────────────────────────────────────────────────

async function logout({ jti }) {
  if (!jti || jti === 'admin-secret' || jti === 'admin-secret-query') {
    return { success: true }; // Sesiones sintéticas no se revocan
  }
  await pool.query(
    `UPDATE user_sessions SET revoked = TRUE, revoked_at = now()
     WHERE jti = $1 AND revoked = FALSE`,
    [jti]
  );
  return { success: true };
}

// ── changePassword ────────────────────────────────────────────────────────────

async function changePassword({ userId, currentPassword, newPassword }) {
  const { rows } = await pool.query(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) {
    throw Object.assign(new Error('Usuario no encontrado'), { code: 'NOT_FOUND', status: 404 });
  }

  const valid = await bcrypt.compare(String(currentPassword || ''), rows[0].password_hash);
  if (!valid) {
    throw Object.assign(new Error('Contraseña actual incorrecta'), { code: 'INVALID_PASSWORD', status: 400 });
  }

  const err = validatePassword(newPassword);
  if (err) {
    throw Object.assign(new Error(err), { code: 'WEAK_PASSWORD', status: 422 });
  }

  const newHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

  // Revocar todas las sesiones activas → forzar re-login
  await pool.query(
    `UPDATE user_sessions SET revoked = TRUE, revoked_at = now() WHERE user_id = $1 AND revoked = FALSE`,
    [userId]
  );

  return { success: true };
}

/**
 * Cambio de contraseña por el propio usuario (con contraseña actual) o por SUPERUSER
 * (sin contraseña actual). Revoca todas las sesiones del usuario objetivo.
 */
async function changePasswordByUserOrSuperuser({
  targetUserId,
  actorUserId,
  actorRole,
  currentPassword,
  newPassword,
}) {
  const superuser = String(actorRole || '').toUpperCase() === 'SUPERUSER';
  const tid = Number(targetUserId);
  const aid = Number(actorUserId);
  if (!Number.isFinite(tid) || tid <= 0) {
    throw Object.assign(new Error('Usuario inválido'), { code: 'VALIDATION', status: 400 });
  }
  if (!superuser && aid !== tid) {
    throw Object.assign(new Error('No autorizado'), { code: 'FORBIDDEN', status: 403 });
  }

  const { rows } = await pool.query(
    `SELECT id, password_hash FROM users WHERE id = $1`,
    [tid]
  );
  if (!rows.length) {
    throw Object.assign(new Error('Usuario no encontrado'), { code: 'NOT_FOUND', status: 404 });
  }

  if (!superuser) {
    if (currentPassword == null || String(currentPassword) === '') {
      throw Object.assign(new Error('current_password es obligatorio'), { code: 'VALIDATION', status: 400 });
    }
    const valid = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
    if (!valid) {
      throw Object.assign(new Error('Contraseña actual incorrecta'), { code: 'WRONG_PASSWORD', status: 400 });
    }
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw Object.assign(new Error('new_password debe tener al menos 8 caracteres'), { code: 'VALIDATION', status: 400 });
  }

  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  await pool.query(
    `UPDATE users SET
       password_hash   = $1,
       failed_attempts = 0,
       status          = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
       locked_at       = NULL,
       reset_token     = NULL,
       reset_token_exp = NULL
     WHERE id = $2`,
    [hash, tid]
  );

  await pool.query(
    `UPDATE user_sessions SET revoked = TRUE, revoked_at = now(), revoked_by = $1
     WHERE user_id = $2 AND revoked = FALSE`,
    [superuser ? (Number.isFinite(aid) ? aid : null) : tid, tid]
  );

  return { ok: true, message: 'Contraseña actualizada. Iniciá sesión nuevamente.' };
}

// ── createUser ────────────────────────────────────────────────────────────────

async function createUser({ username, email, fullName, role, password, createdBy }) {
  const err = validatePassword(password);
  if (err) {
    throw Object.assign(new Error(err), { code: 'WEAK_PASSWORD', status: 422 });
  }

  const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, full_name, password_hash, role, company_id, created_by)
       VALUES ($1, $2, $3, $4, $5::user_role, 1, $6)
       RETURNING id, username, email, full_name, role, status, created_at`,
      [
        String(username || '').trim().toLowerCase(),
        String(email    || '').trim().toLowerCase(),
        String(fullName || '').trim(),
        hash,
        String(role || 'OPERATOR').toUpperCase(),
        createdBy || null,
      ]
    );
    row = rows[0];
  } catch (e) {
    if (e.code === '23505') {
      throw Object.assign(
        new Error('El username o email ya existe'),
        { code: 'DUPLICATE_USER', status: 409 }
      );
    }
    if (e.code === '22P02') {
      throw Object.assign(new Error('Rol inválido'), { code: 'INVALID_ROLE', status: 400 });
    }
    throw e;
  }

  return sanitizeUser(row);
}

// ── updateUser ────────────────────────────────────────────────────────────────

async function updateUser({ userId, fullName, email, role, status }) {
  const sets   = [];
  const params = [];
  let   idx    = 1;

  if (fullName != null) { sets.push(`full_name = $${idx++}`); params.push(String(fullName).trim()); }
  if (email    != null) { sets.push(`email = $${idx++}`);     params.push(String(email).trim().toLowerCase()); }
  if (role     != null) { sets.push(`role = $${idx++}::user_role`);   params.push(String(role).toUpperCase()); }
  if (status   != null) { sets.push(`status = $${idx++}::user_status`); params.push(String(status).toUpperCase()); }

  if (!sets.length) {
    throw Object.assign(new Error('No hay campos para actualizar'), { code: 'NO_FIELDS', status: 400 });
  }

  params.push(userId);

  let row;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, username, email, full_name, role, status, created_at, last_login_at`,
      params
    );
    if (!rows.length) {
      throw Object.assign(new Error('Usuario no encontrado'), { code: 'NOT_FOUND', status: 404 });
    }
    row = rows[0];
  } catch (e) {
    if (e.code === '23505') {
      throw Object.assign(new Error('El email ya está en uso'), { code: 'DUPLICATE_EMAIL', status: 409 });
    }
    throw e;
  }

  // Si cambia el rol → revocar sesiones activas (nuevos permisos aplican al re-login)
  if (role != null) {
    await pool.query(
      `UPDATE user_sessions SET revoked = TRUE, revoked_at = now() WHERE user_id = $1 AND revoked = FALSE`,
      [userId]
    );
  }

  return sanitizeUser(row);
}

// ── resetPassword ─────────────────────────────────────────────────────────────

async function resetPassword({ userId, newPassword, resetBy }) {
  const err = validatePassword(newPassword);
  if (err) {
    throw Object.assign(new Error(err), { code: 'WEAK_PASSWORD', status: 422 });
  }

  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);

  const { rows } = await pool.query(
    `UPDATE users SET
       password_hash   = $1,
       failed_attempts = 0,
       status          = 'ACTIVE',
       locked_at       = NULL,
       reset_token     = NULL,
       reset_token_exp = NULL
     WHERE id = $2
     RETURNING id, username, email, full_name, role, status`,
    [hash, userId]
  );
  if (!rows.length) {
    throw Object.assign(new Error('Usuario no encontrado'), { code: 'NOT_FOUND', status: 404 });
  }

  await pool.query(
    `UPDATE user_sessions SET revoked = TRUE, revoked_at = now(), revoked_by = $1 WHERE user_id = $2 AND revoked = FALSE`,
    [resetBy || null, userId]
  );

  return { success: true };
}

// ── unlockUser ────────────────────────────────────────────────────────────────

async function unlockUser(userId) {
  const { rows } = await pool.query(
    `UPDATE users SET status = 'ACTIVE', failed_attempts = 0, locked_at = NULL
     WHERE id = $1 AND status = 'LOCKED'
     RETURNING id, username, email, full_name, role, status`,
    [userId]
  );
  if (!rows.length) return null;
  return sanitizeUser(rows[0]);
}

// ── listUsers ─────────────────────────────────────────────────────────────────

async function listUsers({ companyId = 1, role = null, status = null } = {}) {
  const conds  = ['company_id = $1'];
  const params = [Number(companyId) || 1];
  let   idx    = 2;

  if (role)   { conds.push(`role = $${idx++}::user_role`);   params.push(String(role).toUpperCase()); }
  if (status) { conds.push(`status = $${idx++}::user_status`); params.push(String(status).toUpperCase()); }

  const { rows } = await pool.query(
    `SELECT id, username, email, full_name, role, status,
            last_login_at, last_login_ip, failed_attempts, created_at
     FROM users WHERE ${conds.join(' AND ')}
     ORDER BY role, username`,
    params
  );
  return rows;
}

// ── getUser ───────────────────────────────────────────────────────────────────

async function getUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, full_name, role, status,
            last_login_at, last_login_ip, failed_attempts,
            locked_at, created_at, company_id
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const user = rows[0];
  user.permissions = await loadPermissions(user.role);
  return user;
}

// ── getActiveSessions ─────────────────────────────────────────────────────────

async function getActiveSessions(userId) {
  const { rows } = await pool.query(
    `SELECT jti, ip_address, user_agent, created_at, expires_at
     FROM user_sessions
     WHERE user_id = $1 AND revoked = FALSE AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

// ── revokeAllSessions ─────────────────────────────────────────────────────────

async function revokeAllSessions(userId, revokedBy) {
  const { rowCount } = await pool.query(
    `UPDATE user_sessions SET revoked = TRUE, revoked_at = now(), revoked_by = $1
     WHERE user_id = $2 AND revoked = FALSE`,
    [revokedBy || null, userId]
  );
  return { revoked: rowCount };
}

module.exports = {
  login,
  logout,
  changePassword,
  createUser,
  updateUser,
  resetPassword,
  unlockUser,
  listUsers,
  getUser,
  getActiveSessions,
  revokeAllSessions,
  validatePassword,
  changePasswordByUserOrSuperuser,
};
