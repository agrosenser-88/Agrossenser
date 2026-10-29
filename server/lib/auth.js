'use strict';
// Autenticação (scrypt), sessões no banco (token aleatório, só o hash é gravado) e controle de acesso.
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../config');
const db = require('./db');
const { HttpError, cookieString, sha256 } = require('./http');
const { can } = require('./perms');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'agro_sid';
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 64 };
const MIN_PASSWORD = 8;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(key, expected);
  } catch (_) {
    return false;
  }
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `A senha deve ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > 200) return 'A senha é muito longa.';
  return null;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const iso = (d) => new Date(d).toISOString();

function createSession(res, user, req) {
  const token = newToken();
  const now = Date.now();
  const idleMs = config.sessionIdleHours * 3600 * 1000;
  const absMs = config.sessionMaxDays * 86400 * 1000;
  db.run(
    'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
    sha256(token), user.id, iso(now), iso(now), iso(now + idleMs), iso(now + absMs), req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300),
  );
  res.setHeader('Set-Cookie', cookieString(COOKIE, token, { maxAge: absMs / 1000 }));
  return token;
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', cookieString(COOKIE, '', { maxAge: 0 }));
}

function loadUserContext(row) {
  const user = {
    id: row.uid, org_id: row.org_id, username: row.username, email: row.email, name: row.name, role: row.role,
    must_change_password: !!row.must_change_password, org_name: row.org_name,
  };
  if (user.role === 'admin') user.allowedFarms = null;
  else {
    const farms = db.all('SELECT farm_id FROM user_farms WHERE user_id = ?', user.id).map((r) => r.farm_id);
    user.allowedFarms = farms.length ? farms : null;
  }
  return user;
}

// Middleware: identifica o usuário pela sessão (não bloqueia).
function authenticate(req) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return;
  const id = sha256(token);
  const row = db.get(
    `SELECT s.id AS sid, s.expires_at, s.absolute_expires_at, s.last_seen_at, u.id AS uid, u.org_id, u.username, u.email, u.name, u.role,
            u.active, u.must_change_password, o.name AS org_name
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.org_id WHERE s.id = ?`, id);
  if (!row) return;
  const now = Date.now();
  if (!row.active || Date.parse(row.expires_at) < now || Date.parse(row.absolute_expires_at) < now) {
    db.run('DELETE FROM sessions WHERE id = ?', id);
    return;
  }
  if (now - Date.parse(row.last_seen_at) > 60000) {
    const idleMs = config.sessionIdleHours * 3600 * 1000;
    const newExp = Math.min(now + idleMs, Date.parse(row.absolute_expires_at));
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', iso(now), iso(newExp), id);
  }
  req.sessionId = id;
  req.user = loadUserContext(row);
}

function requireAuth(req) {
  if (!req.user) throw new HttpError(401, 'Sessão expirada ou inexistente. Entre novamente.');
}

function requirePerm(module, action = 'r') {
  return (req) => {
    requireAuth(req);
    if (!can(req.user.role, module, action)) throw new HttpError(403, 'Você não tem permissão para esta ação.');
  };
}

// Proteção CSRF: cabeçalho personalizado + verificação de Origin em requisições que alteram dados.
function csrfGuard(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.path.startsWith('/api/ingest/')) return; // autenticação por chave do dispositivo, sem cookies
  if (req.headers['x-requested-with'] !== 'AgroSensor') throw new HttpError(403, 'Requisição não autorizada (CSRF).');
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (_) { /* inválido */ }
    const expected = String(req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host || '');
    if (host !== expected) throw new HttpError(403, 'Origem não autorizada.');
  }
}

function farmAllowed(user, farmId) {
  if (farmId === null || farmId === undefined) return !user.allowedFarms;
  return !user.allowedFarms || user.allowedFarms.includes(Number(farmId));
}

function audit(req, { action, entity, entityId = null, farmId = null, summary = null, details = null, user = null, orgId = null }) {
  const u = user || req.user || {};
  try {
    db.run(
      'INSERT INTO audit_log (org_id, user_id, username, farm_id, action, entity, entity_id, summary, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      orgId || u.org_id || null, u.id || null, u.username || null, farmId, action, entity, entityId, summary,
      details ? JSON.stringify(details).slice(0, 4000) : null, (req && req.ip) || null, new Date().toISOString(),
    );
  } catch (e) {
    console.error('[auditoria] falha ao registrar:', e.message);
  }
  const org = orgId || u.org_id;
  if (org && !/^login/.test(action)) { try { require('../services/alerts').invalidate(org); } catch { /* opcional */ } }
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD, newToken, createSession, clearCookie,
  authenticate, requireAuth, requirePerm, csrfGuard, farmAllowed, audit, loadUserContext,
};
