'use strict';
// Uso: npm run create-user -- <usuario> <senha> [perfil] [nome]
const db = require('../server/lib/db');
const { hashPassword, passwordProblem } = require('../server/lib/auth');
(async () => {
  const [username, password, role = 'gestor', ...nameParts] = process.argv.slice(2);
  if (!username || !password) { console.error('Uso: npm run create-user -- <usuario> <senha> [admin|gestor|agronomo|operador|visualizador] [nome]'); process.exit(1); }
  if (!['admin', 'gestor', 'agronomo', 'operador', 'visualizador'].includes(role)) { console.error('Perfil inválido.'); process.exit(1); }
  const problem = passwordProblem(password);
  if (problem) { console.error(problem); process.exit(1); }
  db.migrate(); db.open();
  const org = db.get('SELECT id FROM organizations ORDER BY id LIMIT 1');
  if (!org) { console.error('Nenhuma organização. Rode: npm run seed'); process.exit(1); }
  if (db.get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) { console.error('Usuário já existe.'); process.exit(1); }
  db.run('INSERT INTO users (org_id, username, name, password_hash, role, must_change_password) VALUES (?,?,?,?,?,1)', org.id, username, nameParts.join(' ') || username, await hashPassword(password), role);
  console.log(`Usuário "${username}" (${role}) criado. Será pedida a troca de senha no primeiro acesso.`);
  db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
