'use strict';
const crypto = require('crypto');
const config = require('../config');
const db = require('../lib/db');
const { HttpError, createLimiter, sha256 } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES, permissionsFor } = require('../lib/perms');
const mailer = require('../services/mailer');

const loginIpLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginUserLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const forgotLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const DUMMY_HASH = 'scrypt$32768$8$3$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

function publicUser(u) {
  return {
    id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, role_label: ROLES[u.role],
    org_id: u.org_id, org_name: u.org_name, must_change_password: u.must_change_password,
    permissions: permissionsFor(u.role), allowed_farms: u.allowedFarms,
  };
}

function notifyAdmins(orgId, n) {
  db.run(
    `INSERT OR IGNORE INTO notifications (org_id, category, severity, title, body, link, dedup_key, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    orgId, 'admin', n.severity || 'atencao', n.title, n.body || null, n.link || null, n.dedup, new Date().toISOString(),
  );
}

module.exports = function register(app) {
  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password || username.length > 200 || password.length > 500) throw new HttpError(400, 'Informe usuário e senha.');
    loginIpLimiter.check(req.ip || 'x');
    loginUserLimiter.check(username.toLowerCase());
    const user = db.get('SELECT * FROM users WHERE username = ? OR email = ?', username, username);
    if (!user || !user.active) {
      await A.verifyPassword(password, DUMMY_HASH); // equaliza o tempo de resposta
      A.audit(req, { action: 'login_falhou', entity: 'sessao', summary: `Tentativa de login inválida (${username.slice(0, 60)})`, orgId: user ? user.org_id : null });
      throw new HttpError(401, 'Usuário ou senha inválidos.');
    }
    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      const mins = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000);
      throw new HttpError(429, `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${mins} min.`);
    }
    const ok = await A.verifyPassword(password, user.password_hash);
    if (!ok) {
      const fails = user.failed_attempts + 1;
      if (fails >= MAX_FAILS) {
        db.run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), user.id);
        notifyAdmins(user.org_id, { title: 'Conta bloqueada temporariamente', body: `O usuário ${user.username} excedeu ${MAX_FAILS} tentativas de login.`, dedup: `lock:${user.id}:${new Date().toISOString().slice(0, 13)}`, link: '#/configuracoes/usuarios' });
      } else db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', fails, user.id);
      A.audit(req, { action: 'login_falhou', entity: 'sessao', entityId: user.id, summary: `Senha incorreta para ${user.username}`, user: { id: user.id, username: user.username, org_id: user.org_id } });
      throw new HttpError(401, 'Usuário ou senha inválidos.');
    }
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND absolute_expires_at < ?', user.id, new Date().toISOString());
    loginUserLimiter.reset(username.toLowerCase());
    A.createSession(res, user, req);
    const ctx = A.loadUserContext({ ...user, uid: user.id, org_name: (db.get('SELECT name FROM organizations WHERE id = ?', user.org_id) || {}).name });
    A.audit(req, { action: 'login', entity: 'sessao', entityId: user.id, summary: `${user.username} entrou no sistema`, user: ctx });
    res.json({ user: publicUser(ctx) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionId) {
      db.run('DELETE FROM sessions WHERE id = ?', req.sessionId);
      A.audit(req, { action: 'logout', entity: 'sessao', entityId: req.user.id, summary: `${req.user.username} saiu do sistema` });
    }
    A.clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    A.requireAuth(req);
    res.json({ user: publicUser(req.user) });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    A.requireAuth(req);
    const { current_password: cur, new_password: nw } = req.body;
    const problem = A.passwordProblem(nw);
    if (problem) throw new HttpError(400, 'Dados inválidos.', { new_password: problem });
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!(await A.verifyPassword(String(cur || ''), row.password_hash))) throw new HttpError(400, 'Dados inválidos.', { current_password: 'Senha atual incorreta.' });
    if (cur === nw) throw new HttpError(400, 'Dados inválidos.', { new_password: 'A nova senha deve ser diferente da atual.' });
    const hash = await A.hashPassword(nw);
    db.run("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", hash, new Date().toISOString(), req.user.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', req.user.id, req.sessionId);
    db.run("DELETE FROM notifications WHERE org_id = ? AND dedup_key = ?", req.user.org_id, `default-password:${req.user.id}`);
    A.audit(req, { action: 'trocar_senha', entity: 'usuario', entityId: req.user.id, summary: 'Alterou a própria senha' });
    res.json({ ok: true });
  });

  // Esqueci a senha: resposta sempre genérica (não revela se o usuário existe).
  app.post('/api/auth/forgot', async (req, res) => {
    forgotLimiter.check(req.ip || 'x');
    const ident = String(req.body.identifier || '').trim();
    const generic = { ok: true, email_enabled: mailer.enabled(), message: mailer.enabled() ? 'Se o cadastro existir, enviaremos as instruções para o e-mail registrado.' : 'Solicitação registrada. Peça ao administrador do sistema para gerar um link de redefinição de senha para você.' };
    if (!ident || ident.length > 200) return res.json(generic);
    const user = db.get('SELECT * FROM users WHERE (username = ? OR email = ?) AND active = 1', ident, ident);
    if (!user) return res.json(generic);
    notifyAdmins(user.org_id, { title: 'Solicitação de redefinição de senha', body: `O usuário ${user.username} (${user.name}) pediu para redefinir a senha.`, dedup: `pwreq:${user.id}:${new Date().toISOString().slice(0, 13)}`, link: '#/configuracoes/usuarios' });
    A.audit(req, { action: 'solicitar_redefinicao', entity: 'usuario', entityId: user.id, summary: `Solicitação de redefinição de senha para ${user.username}`, user: { id: user.id, username: user.username, org_id: user.org_id } });
    if (mailer.enabled() && user.email) {
      try {
        const token = A.newToken();
        db.run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)', user.id, sha256(token), new Date(Date.now() + 3600 * 1000).toISOString());
        const base = config.publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
        await mailer.send({
          to: user.email,
          subject: 'AgroSensor Tech - redefinição de senha',
          text: `Olá, ${user.name}.\n\nRecebemos um pedido para redefinir a sua senha no AgroSensor Tech.\nUse o link abaixo (válido por 1 hora):\n\n${base}/#/redefinir/${token}\n\nSe você não fez essa solicitação, ignore esta mensagem.`,
        });
      } catch (e) {
        console.error('[e-mail] falha ao enviar redefinição:', e.message);
      }
    }
    res.json(generic);
  });

  app.get('/api/auth/reset/:token', (req, res) => {
    const row = db.get(
      `SELECT r.id, u.name FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.active = 1`, sha256(req.params.token), new Date().toISOString());
    if (!row) throw new HttpError(404, 'Link inválido ou expirado.');
    res.json({ valid: true, name: row.name });
  });

  app.post('/api/auth/reset', async (req, res) => {
    forgotLimiter.check('reset:' + (req.ip || 'x'));
    const token = String(req.body.token || '');
    const problem = A.passwordProblem(req.body.new_password);
    if (problem) throw new HttpError(400, 'Dados inválidos.', { new_password: problem });
    const row = db.get(
      `SELECT r.id, r.user_id, u.username, u.org_id FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.active = 1`, sha256(token), new Date().toISOString());
    if (!row) throw new HttpError(400, 'Link inválido ou expirado. Solicite um novo.');
    const hash = await A.hashPassword(req.body.new_password);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, new Date().toISOString(), row.user_id);
      db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    A.audit(req, { action: 'redefinir_senha', entity: 'usuario', entityId: row.user_id, summary: `Senha de ${row.username} redefinida por link`, user: { id: row.user_id, username: row.username, org_id: row.org_id } });
    res.json({ ok: true });
  });

  app.get('/api/auth/sessions', (req, res) => {
    A.requireAuth(req);
    const rows = db.all('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', req.user.id);
    res.json(rows.map((r) => ({ handle: r.id.slice(0, 16), created_at: r.created_at, last_seen_at: r.last_seen_at, ip: r.ip, user_agent: r.user_agent, current: r.id === req.sessionId })));
  });

  app.delete('/api/auth/sessions/:handle', (req, res) => {
    A.requireAuth(req);
    const handle = String(req.params.handle);
    if (!/^[0-9a-f]{16}$/.test(handle)) throw new HttpError(400, 'Sessão inválida.');
    const r = db.run("DELETE FROM sessions WHERE user_id = ? AND substr(id,1,16) = ? AND id <> ?", req.user.id, handle, req.sessionId);
    if (!r.changes) throw new HttpError(404, 'Sessão não encontrada.');
    A.audit(req, { action: 'encerrar_sessao', entity: 'sessao', summary: 'Encerrou uma sessão ativa' });
    res.json({ ok: true });
  });

  app.delete('/api/auth/sessions', (req, res) => {
    A.requireAuth(req);
    const r = db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', req.user.id, req.sessionId);
    A.audit(req, { action: 'encerrar_sessoes', entity: 'sessao', summary: `Encerrou ${r.changes} outra(s) sessão(ões)` });
    res.json({ ok: true, revoked: r.changes });
  });
};

module.exports.publicUser = publicUser;
module.exports.notifyAdmins = notifyAdmins;
