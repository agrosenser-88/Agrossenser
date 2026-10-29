'use strict';
// Uso: npm run reset-password -- <usuario> <nova-senha>
const db = require('../server/lib/db');
const { hashPassword, passwordProblem } = require('../server/lib/auth');
(async () => {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) { console.error('Uso: npm run reset-password -- <usuario> <nova-senha>'); process.exit(1); }
  const problem = passwordProblem(password);
  if (problem) { console.error(problem); process.exit(1); }
  db.migrate(); db.open();
  const u = db.get('SELECT id FROM users WHERE lower(username) = lower(?)', username);
  if (!u) { console.error('Usuário não encontrado.'); process.exit(1); }
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?', await hashPassword(password), u.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  console.log('Senha redefinida e sessões encerradas.');
  db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
