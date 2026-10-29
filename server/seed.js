'use strict';
// Cria a organização e o usuário administrador inicial (somente se ainda não existir nenhum usuário).
const config = require('./config');
const db = require('./lib/db');
const { hashPassword } = require('./lib/auth');

const DEFAULT_PASSWORD = 'admin123';

async function ensureAdmin() {
  db.open();
  const n = db.get('SELECT COUNT(*) AS n FROM users').n;
  if (n > 0) return null;
  const password = config.seed.password || DEFAULT_PASSWORD;
  const hash = await hashPassword(password);
  const org = db.run('INSERT INTO organizations (name) VALUES (?)', config.seed.orgName);
  db.run(
    'INSERT INTO users (org_id, username, email, name, password_hash, role, must_change_password) VALUES (?,?,?,?,?,?,0)',
    org.id, config.seed.username, config.seed.email || null, config.seed.name, hash, 'admin',
  );
  return { username: config.seed.username, usedDefaultPassword: !config.seed.password };
}

module.exports = { ensureAdmin, DEFAULT_PASSWORD };

if (require.main === module) {
  db.migrate();
  ensureAdmin().then((r) => {
    console.log(r ? `Administrador "${r.username}" criado.` : 'Já existem usuários; nada foi alterado.');
    db.close();
  }).catch((e) => { console.error(e); process.exit(1); });
}
