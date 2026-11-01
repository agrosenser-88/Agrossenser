'use strict';
const config = require('../config');
const db = require('../lib/db');
const { HttpError, sha256 } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES } = require('../lib/perms');
const { v, validateBody } = require('../lib/validate');
const mailer = require('../services/mailer');

const baseSchema = {
  name: v.str({ req: true, max: 120 }),
  email: v.email(),
  role: v.str({ req: true, enum: Object.keys(ROLES) }),
};

function farmIdsFor(req, ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Dados inválidos.', { farm_ids: 'Fazenda inválida.' });
    if (!db.get('SELECT 1 AS ok FROM farms WHERE id = ? AND org_id = ?', id, req.user.org_id)) throw new HttpError(400, 'Dados inválidos.', { farm_ids: 'Fazenda não encontrada.' });
    out.push(id);
  }
  return [...new Set(out)];
}

function present(u) {
  const farms = db.all('SELECT farm_id FROM user_farms WHERE user_id = ?', u.id).map((r) => r.farm_id);
  return {
    id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, role_label: ROLES[u.role], active: !!u.active,
    must_change_password: !!u.must_change_password, last_login_at: u.last_login_at, created_at: u.created_at, farm_ids: farms,
  };
}

function activeAdmins(orgId, exceptId) {
  return db.get("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'admin' AND active = 1 AND id <> ?", orgId, exceptId || 0).n;
}

function getUser(req, id) {
  const u = db.get('SELECT * FROM users WHERE id = ? AND org_id = ?', Number(id), req.user.org_id);
  if (!u) throw new HttpError(404, 'Usuário não encontrado.');
  return u;
}

module.exports = function register(app) {
  const guard = A.requirePerm('users', 'r');
  const guardW = A.requirePerm('users', 'w');
  const guardD = A.requirePerm('users', 'd');

  app.get('/api/users', guard, (req, res) => {
    res.json(db.all('SELECT * FROM users WHERE org_id = ? ORDER BY name COLLATE NOCASE', req.user.org_id).map(present));
  });

  app.post('/api/users', guardW, async (req, res) => {
    const schema = {
      ...baseSchema,
      username: v.str({ req: true, max: 40, pattern: /^[A-Za-z0-9._-]{3,40}$/, patternMsg: 'Use de 3 a 40 letras, números, ponto, hífen ou sublinhado.' }),
    };
    const { data, errors } = validateBody(schema, req.body, { user: req.user });
    const problem = A.passwordProblem(req.body.password);
    if (problem) errors.password = problem;
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    const farms = farmIdsFor(req, req.body.farm_ids);
    if (db.get('SELECT 1 AS x FROM users WHERE username = ?', data.username)) throw new HttpError(400, 'Dados inválidos.', { username: 'Este nome de usuário já está em uso.' });
    if (data.email && db.get('SELECT 1 AS x FROM users WHERE email = ?', data.email)) throw new HttpError(400, 'Dados inválidos.', { email: 'Este e-mail já está em uso.' });
    const hash = await A.hashPassword(req.body.password);
    const id = db.tx(() => {
      const r = db.run(
        'INSERT INTO users (org_id, username, email, name, password_hash, role, must_change_password) VALUES (?,?,?,?,?,?,?)',
        req.user.org_id, data.username, data.email, data.name, hash, data.role, req.body.must_change_password === false ? 0 : 1,
      );
      farms.forEach((f) => db.run('INSERT INTO user_farms (user_id, farm_id) VALUES (?,?)', r.id, f));
      return r.id;
    });
    A.audit(req, { action: 'criar', entity: 'usuario', entityId: id, summary: `Criou o usuário ${data.username} (${ROLES[data.role]})` });
    res.json(present(getUser(req, id)), 201);
  });

  app.put('/api/users/:id', guardW, (req, res) => {
    const u = getUser(req, req.params.id);
    const schema = { name: baseSchema.name, email: baseSchema.email, role: baseSchema.role, active: v.bool() };
    const { data, errors } = validateBody(schema, req.body, { user: req.user }, { partial: true });
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    if (data.email && db.get('SELECT 1 AS x FROM users WHERE email = ? AND id <> ?', data.email, u.id)) throw new HttpError(400, 'Dados inválidos.', { email: 'Este e-mail já está em uso.' });
    const newRole = data.role || u.role;
    const newActive = data.active !== undefined ? data.active : u.active;
    if ((u.role === 'admin' && (newRole !== 'admin' || !newActive)) && activeAdmins(req.user.org_id, u.id) === 0) {
      throw new HttpError(400, 'Mantenha pelo menos um administrador ativo.');
    }
    if (u.id === req.user.id && (newRole !== u.role || !newActive)) throw new HttpError(400, 'Você não pode alterar o próprio perfil ou desativar a própria conta.');
    const farms = req.body.farm_ids !== undefined ? farmIdsFor(req, req.body.farm_ids) : null;
    db.tx(() => {
      const keys = Object.keys(data);
      if (keys.length) db.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => data[k]), new Date().toISOString(), u.id);
      if (farms) {
        db.run('DELETE FROM user_farms WHERE user_id = ?', u.id);
        farms.forEach((f) => db.run('INSERT INTO user_farms (user_id, farm_id) VALUES (?,?)', u.id, f));
      }
      if (data.role !== undefined || data.active === 0 || farms) db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    A.audit(req, { action: 'editar', entity: 'usuario', entityId: u.id, summary: `Editou o usuário ${u.username}`, details: { ...data, farm_ids: farms || undefined } });
    res.json(present(getUser(req, u.id)));
  });

  app.post('/api/users/:id/reset-link', guardW, async (req, res) => {
    const u = getUser(req, req.params.id);
    const token = A.newToken();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, created_by) VALUES (?,?,?,?)', u.id, sha256(token), expires, req.user.id);
    const base = config.publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const url = `${base}/#/redefinir/${token}`;
    let emailed = false;
    if (req.body.send_email && mailer.enabled() && u.email) {
      try {
        await mailer.send({ to: u.email, subject: 'AgroSenser Tech - redefinição de senha', text: `Olá, ${u.name}.\n\nUse o link abaixo para definir uma nova senha (válido por 24 horas):\n\n${url}\n` });
        emailed = true;
      } catch (e) { console.error('[e-mail] falha:', e.message); }
    }
    A.audit(req, { action: 'gerar_link_redefinicao', entity: 'usuario', entityId: u.id, summary: `Gerou link de redefinição de senha para ${u.username}` });
    res.json({ url, expires_at: expires, emailed });
  });

  app.post('/api/users/:id/set-password', guardW, async (req, res) => {
    const u = getUser(req, req.params.id);
    const problem = A.passwordProblem(req.body.password);
    if (problem) throw new HttpError(400, 'Dados inválidos.', { password: problem });
    const hash = await A.hashPassword(req.body.password);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, new Date().toISOString(), u.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    A.audit(req, { action: 'definir_senha', entity: 'usuario', entityId: u.id, summary: `Definiu senha temporária para ${u.username}` });
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', guardD, (req, res) => {
    const u = getUser(req, req.params.id);
    if (u.id === req.user.id) throw new HttpError(400, 'Você não pode excluir a própria conta.');
    if (u.role === 'admin' && activeAdmins(req.user.org_id, u.id) === 0) throw new HttpError(400, 'Mantenha pelo menos um administrador ativo.');
    db.run('DELETE FROM users WHERE id = ?', u.id);
    A.audit(req, { action: 'excluir', entity: 'usuario', entityId: u.id, summary: `Excluiu o usuário ${u.username}` });
    res.json({ ok: true });
  });

  app.get('/api/meta', (req, res) => {
    A.requireAuth(req);
    res.json({ roles: ROLES });
  });
};
