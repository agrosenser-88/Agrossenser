'use strict';
const fs = require('fs');
const config = require('./config');
const db = require('./lib/db');
const { createServer } = require('./lib/http');
const { buildApp } = require('./app');
const { ensureAdmin } = require('./seed');
const alerts = require('./services/alerts');

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const applied = db.migrate();
  if (applied.length) console.log('[banco] migrations aplicadas:', applied.join(', '));
  const created = await ensureAdmin();
  if (created) {
    console.log(`[acesso] Administrador inicial criado: usuário "${created.username}".`);
    if (created.usedDefaultPassword) console.log('[acesso] Senha inicial definida pelo padrão do sistema. Troque-a em Configurações > Segurança.');
  }
  const app = buildApp();
  const server = createServer(app);
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 65000;
  server.listen(config.port, config.host, () => {
    console.log(`AgroSensor Tech em http://localhost:${config.port}  (${config.isProd ? 'produção' : 'desenvolvimento'})`);
    console.log(`[integrações] IA: ${config.ai.enabled ? 'ativa' : 'pendente (sem ANTHROPIC_API_KEY)'} | Clima: ${config.weather.enabled ? 'ativo' : 'desativado'} | SMTP: ${config.smtp.enabled ? 'ativo' : 'pendente'}`);
  });
  alerts.startScheduler();
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
