'use strict';
const { App } = require('./lib/http');
const A = require('./lib/auth');

function buildApp() {
  const app = new App();
  app.use((req) => A.authenticate(req));
  app.use((req) => A.csrfGuard(req));
  // Rotas específicas antes das genéricas (sensores: POST personalizado precede o do CRUD).
  require('./routes/auth')(app);
  require('./routes/users')(app);
  require('./routes/farms')(app);
  require('./routes/modules')(app);
  require('./routes/sensors')(app);
  require('./routes/ia')(app);
  require('./routes/analytics')(app);
  require('./routes/system')(app);
  return app;
}

module.exports = { buildApp };
