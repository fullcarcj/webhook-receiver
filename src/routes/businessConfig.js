'use strict';

/**
 * businessConfig.js — Módulo de Configuración de Negocio
 *
 * Endpoints /api/config/...
 *   company        → datos empresa (GET/PUT)
 *   branches       → sucursales   (GET/POST/PUT/:id/DELETE/:id)
 *   currencies     → catálogo     (GET/POST)
 *   exchange-rates → tasas        (GET/GET history/GET at/:date — solo lectura aquí)
 *   tax-rules      → impuestos    (GET/GET active — lee settings_tax + igtf_config)
 *
 * Auth: requireAdminOrPermission(req, res, 'settings')
 *   GET    → settings:read  (OPERATOR, ADMIN, SUPERUSER)
 *   POST/PUT → settings:write (ADMIN, SUPERUSER)
 *   DELETE → settings:admin  (SUPERUSER)
 *
 * REGLA: exchange-rates no expone PUT ni DELETE (tabla append-only).
 * REGLA: soft delete en branches y currencies (is_active = false).
 */

const { pool } = require('../../db-postgres');
const { requireAdminOrPermission } = require('../utils/authMiddleware');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 512 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString('utf8');
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); }
  catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

function idFromPath(path, prefix) {
  const rest = path.slice(prefix.length).replace(/^\//, '').split('/')[0];
  const n = parseInt(rest, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Handler principal ────────────────────────────────────────────────────────

async function handleBusinessConfigRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/config')) return false;

  const method = req.method;
  const path   = url.pathname.replace(/\/+$/, '');

  try {
    // ── COMPANY ────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/api/config/company') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const { rows } = await pool.query(
        'SELECT id, name, rif, address, phone, email, base_currency_code, fiscal_year_start, is_active, created_at, updated_at FROM companies WHERE id = 1'
      );
      writeJson(res, 200, { ok: true, data: rows[0] || null });
      return true;
    }

    if (method === 'PUT' && path === '/api/config/company') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const body = await parseJsonBody(req);
      const allowed = ['name', 'rif', 'address', 'phone', 'email', 'fiscal_year_start'];
      const sets  = [];
      const vals  = [];
      allowed.forEach(k => {
        if (k in body) { sets.push(`${k} = $${vals.length + 2}`); vals.push(body[k]); }
      });
      if (!sets.length) {
        writeJson(res, 400, { ok: false, error: 'Sin campos a actualizar' });
        return true;
      }
      const { rows } = await pool.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1
         RETURNING id, name, rif, address, phone, email, base_currency_code, fiscal_year_start, updated_at`,
        [1, ...vals]
      );
      writeJson(res, 200, { ok: true, data: rows[0] });
      return true;
    }

    // ── BRANCHES ───────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/api/config/branches') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const companyId = Number(url.searchParams.get('company_id') || 1);
      const { rows }  = await pool.query(
        `SELECT id, company_id, name, code, address, phone, is_main_branch, has_warehouse, is_active, created_at
         FROM branches WHERE company_id = $1 ORDER BY is_main_branch DESC, name`,
        [companyId]
      );
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    if (method === 'POST' && path === '/api/config/branches') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const body = await parseJsonBody(req);
      if (!body.name || !body.code) {
        writeJson(res, 400, { ok: false, error: 'name y code son obligatorios' });
        return true;
      }
      const companyId = Number(body.company_id || 1);
      const { rows } = await pool.query(
        `INSERT INTO branches (company_id, name, code, address, phone, is_main_branch, has_warehouse)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [companyId, body.name, body.code.toUpperCase(),
         body.address || null, body.phone || null,
         body.is_main_branch === true, body.has_warehouse === true]
      );
      writeJson(res, 201, { ok: true, data: rows[0] });
      return true;
    }

    const branchIdMatch = path.match(/^\/api\/config\/branches\/(\d+)$/);

    if (method === 'GET' && branchIdMatch) {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const id = Number(branchIdMatch[1]);
      const { rows } = await pool.query('SELECT * FROM branches WHERE id = $1', [id]);
      if (!rows.length) { writeJson(res, 404, { ok: false, error: 'Sucursal no encontrada' }); return true; }
      writeJson(res, 200, { ok: true, data: rows[0] });
      return true;
    }

    if (method === 'PUT' && branchIdMatch) {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const id   = Number(branchIdMatch[1]);
      const body = await parseJsonBody(req);
      const allowed = ['name', 'code', 'address', 'phone', 'is_main_branch', 'has_warehouse', 'is_active'];
      const sets = [];
      const vals = [];
      allowed.forEach(k => {
        if (k in body) { sets.push(`${k} = $${vals.length + 2}`); vals.push(body[k]); }
      });
      if (!sets.length) { writeJson(res, 400, { ok: false, error: 'Sin campos a actualizar' }); return true; }
      const { rows } = await pool.query(
        `UPDATE branches SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...vals]
      );
      if (!rows.length) { writeJson(res, 404, { ok: false, error: 'Sucursal no encontrada' }); return true; }
      writeJson(res, 200, { ok: true, data: rows[0] });
      return true;
    }

    if (method === 'DELETE' && branchIdMatch) {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const id = Number(branchIdMatch[1]);
      const { rows } = await pool.query(
        `UPDATE branches SET is_active = FALSE, updated_at = now() WHERE id = $1 AND is_main_branch = FALSE RETURNING id`,
        [id]
      );
      if (!rows.length) {
        writeJson(res, 404, { ok: false, error: 'Sucursal no encontrada o es la sucursal principal (no se puede desactivar)' });
        return true;
      }
      writeJson(res, 200, { ok: true, message: 'Sucursal desactivada', id });
      return true;
    }

    // ── CURRENCIES ─────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/api/config/currencies') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const onlyActive = url.searchParams.get('active') !== 'false';
      const { rows } = await pool.query(
        `SELECT code, name, symbol, decimal_places, is_base_currency, is_active
         FROM currencies ${onlyActive ? 'WHERE is_active = TRUE' : ''} ORDER BY is_base_currency DESC, code`
      );
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    if (method === 'POST' && path === '/api/config/currencies') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const body = await parseJsonBody(req);
      if (!body.code || !body.name) {
        writeJson(res, 400, { ok: false, error: 'code y name son obligatorios' });
        return true;
      }
      const { rows } = await pool.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_base_currency)
         VALUES ($1, $2, $3, $4, FALSE)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
               decimal_places = EXCLUDED.decimal_places, is_active = TRUE
         RETURNING *`,
        [body.code.toUpperCase(), body.name, body.symbol || '', Number(body.decimal_places ?? 2)]
      );
      writeJson(res, 201, { ok: true, data: rows[0] });
      return true;
    }

    // ── EXCHANGE RATES (solo lectura — append-only en daily_exchange_rates) ─

    if (method === 'GET' && path === '/api/config/exchange-rates') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const companyId = Number(url.searchParams.get('company_id') || 1);
      const { rows } = await pool.query(
        `SELECT rate_date, active_rate, bcv_rate, binance_rate, adjusted_rate,
                active_rate_type, is_manual_override,
                COALESCE(from_currency, 'USD') AS from_currency,
                COALESCE(to_currency,   'VES') AS to_currency
         FROM daily_exchange_rates
         WHERE company_id = $1 AND rate_date <= CURRENT_DATE AND active_rate IS NOT NULL
         ORDER BY rate_date DESC
         LIMIT 1`,
        [companyId]
      );
      writeJson(res, 200, { ok: true, data: rows[0] || null });
      return true;
    }

    if (method === 'GET' && path === '/api/config/exchange-rates/history') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const companyId = Number(url.searchParams.get('company_id') || 1);
      const limit     = Math.min(Number(url.searchParams.get('limit')  || 90), 365);
      const offset    = Number(url.searchParams.get('offset') || 0);
      const from      = url.searchParams.get('from');
      const to        = url.searchParams.get('to');
      const { rows } = await pool.query(
        `SELECT rate_date, active_rate, bcv_rate, binance_rate, active_rate_type,
                is_manual_override,
                COALESCE(from_currency, 'USD') AS from_currency,
                COALESCE(to_currency,   'VES') AS to_currency
         FROM daily_exchange_rates
         WHERE company_id = $1
           AND ($2::date IS NULL OR rate_date >= $2::date)
           AND ($3::date IS NULL OR rate_date <= $3::date)
           AND active_rate IS NOT NULL
         ORDER BY rate_date DESC
         LIMIT $4 OFFSET $5`,
        [companyId, from || null, to || null, limit, offset]
      );
      writeJson(res, 200, { ok: true, data: rows, limit, offset });
      return true;
    }

    const rateAtMatch = path.match(/^\/api\/config\/exchange-rates\/at\/(\d{4}-\d{2}-\d{2})$/);
    if (method === 'GET' && rateAtMatch) {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const targetDate = rateAtMatch[1];
      const companyId  = Number(url.searchParams.get('company_id') || 1);
      const { rows } = await pool.query(
        `SELECT rate_date, active_rate, bcv_rate, binance_rate, active_rate_type,
                is_manual_override, override_reason,
                COALESCE(from_currency, 'USD') AS from_currency,
                COALESCE(to_currency,   'VES') AS to_currency
         FROM daily_exchange_rates
         WHERE company_id = $1 AND rate_date <= $2::date AND active_rate IS NOT NULL
         ORDER BY rate_date DESC
         LIMIT 1`,
        [companyId, targetDate]
      );
      if (!rows.length) {
        writeJson(res, 404, { ok: false, error: `Sin tasa disponible en o antes de ${targetDate}` });
        return true;
      }
      writeJson(res, 200, { ok: true, data: rows[0], requested_date: targetDate });
      return true;
    }

    // ── TAX RULES (lectura de settings_tax + igtf_config) ──────────────────

    if (method === 'GET' && path === '/api/config/tax-rules') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const companyId = Number(url.searchParams.get('company_id') || 1);
      const [stRes, igtfRes] = await Promise.all([
        pool.query(
          `SELECT key, value, value_type, description, effective_from, updated_at
           FROM settings_tax WHERE company_id = $1 ORDER BY key, effective_from DESC`,
          [companyId]
        ),
        pool.query(
          `SELECT 'igtf' AS key, (rate_pct * 100)::TEXT AS value, 'number' AS value_type,
                  'IGTF %' AS description, effective_from
           FROM igtf_config ORDER BY effective_from DESC`
        ),
      ]);
      writeJson(res, 200, { ok: true, settings_tax: stRes.rows, igtf_config: igtfRes.rows });
      return true;
    }

    if (method === 'GET' && path === '/api/config/tax-rules/active') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const companyId = Number(url.searchParams.get('company_id') || 1);
      const [stRes, igtfRes] = await Promise.all([
        pool.query(
          `SELECT DISTINCT ON (key) key, value, value_type, description, effective_from
           FROM settings_tax
           WHERE company_id = $1 AND effective_from <= CURRENT_DATE
           ORDER BY key, effective_from DESC`,
          [companyId]
        ),
        pool.query(
          `SELECT rate_pct, (rate_pct * 100)::TEXT AS rate_pct_display, effective_from
           FROM igtf_config
           WHERE effective_from <= CURRENT_DATE
           ORDER BY effective_from DESC LIMIT 1`
        ),
      ]);
      writeJson(res, 200, {
        ok: true,
        date: new Date().toISOString().slice(0, 10),
        settings_tax: stRes.rows,
        igtf:         igtfRes.rows[0] || null,
      });
      return true;
    }

    // PUT /api/config/tax-rules → inserta nuevo effective_from (no modifica histórico)
    if (method === 'PUT' && path === '/api/config/tax-rules') {
      if (!await requireAdminOrPermission(req, res, 'settings')) return true;
      const body = await parseJsonBody(req);
      if (!body.key || body.value === undefined || !body.effective_from) {
        writeJson(res, 400, { ok: false, error: 'key, value y effective_from son obligatorios' });
        return true;
      }
      const companyId = Number(body.company_id || 1);
      const { rows } = await pool.query(
        `INSERT INTO settings_tax (company_id, key, value, value_type, description, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6::date)
         ON CONFLICT (company_id, key, effective_from)
           DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description,
                         updated_at = now()
         RETURNING *`,
        [companyId, body.key, String(body.value),
         body.value_type || 'number', body.description || null, body.effective_from]
      );
      writeJson(res, 200, { ok: true, data: rows[0] });
      return true;
    }

  } catch (e) {
    const status = e.status || (e.code === '23505' ? 409 : 500);
    writeJson(res, status, { ok: false, error: e.message || String(e) });
    return true;
  }

  return false;
}

module.exports = { handleBusinessConfigRequest };
