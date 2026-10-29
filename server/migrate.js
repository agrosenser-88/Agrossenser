'use strict';
const db = require('./lib/db');
const done = db.migrate();
console.log(done.length ? `Migrations aplicadas: ${done.join(', ')}` : 'Banco de dados já está atualizado.');
db.close();
