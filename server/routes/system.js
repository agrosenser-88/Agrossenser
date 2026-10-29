'use strict';
// Notificações, auditoria, configurações e integrações.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../lib/db');
const { HttpError } = require('../lib/http');
const A = require('../lib/auth');
const { can } = require('../lib/perms');
const { farmClause } = require('../lib/crud');
const alerts = require('../services/alerts');
const mailer = require('../services/mailer');

function visibleWhere(req) {
  const params = [req.user.org_id, req.user.id];
  let where = ' WHERE n.org_id = ? AND (n.user_id IS NULL OR n.user_id = ?)';
  if (req.user.allowedFarms) {
    where += ` AND (n.farm_id IS NULL OR n.farm_id IN (${req.user.allowedFarms.map(() => '?').join(',')}))`;
    params.push(...req.user.allowedFarms);
  }
  // Alertas administrativos só para quem administra
  if (!can(req.user.role, 'users', 'r')) where += " AND (n.category <> 'admin' OR n.user_id = " + Number(req.user.id) + ')';
  return { where, params };
}

module.exports = function register(app) {
  app.get('/api/notifications', A.requireAuth, (req, res) => {
    alerts.refreshOrg(req.user.org_id);
    const { where, params } = visibleWhere(req);
    let w = where;
    const p = [...params];
    if (req.query.category) { w += ' AND n.category = ?'; p.push(String(req.query.category)); }
    if (req.query.severity) { w += ' AND n.severity = ?'; p.push(String(req.query.severity)); }
    if (req.query.history === '1') w += ' AND n.resolved_at IS NOT NULL';
    else if (req.query.history !== 'all') w += ' AND n.resolved_at IS NULL';
    if (req.query.unread === '1') w += ' AND r.read_at IS NULL';
    const rows = db.all(
      `SELECT n.id, n.farm_id, n.category, n.severity, n.title, n.body, n.link, n.created_at, n.resolved_at, r.read_at, f.name AS farm_name
         FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ${Number(req.user.id)} LEFT JOIN farms f ON f.id = n.farm_id${w}
        ORDER BY CASE n.severity WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END, n.created_at DESC LIMIT 300`, ...p);
    res.json(rows.map((r) => ({ ...r, read: !!r.read_at })));
  });

  app.get('/api/notifications/count', A.requireAuth, (req, res) => {
    alerts.refreshOrg(req.user.org_id);
    const { where, params } = visibleWhere(req);
    const row = db.get(
      `SELECT COUNT(*) AS unread, SUM(CASE WHEN n.severity = 'critico' THEN 1 ELSE 0 END) AS critical FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ${Number(req.user.id)}${where} AND n.resolved_at IS NULL AND r.read_at IS NULL`, ...params);
    res.json({ unread: row.unread || 0, critical: row.critical || 0 });
  });

  app.post('/api/notifications/read-all', A.requireAuth, (req, res) => {
    const { where, params } = visibleWhere(req);
    const ids = db.all(`SELECT n.id FROM notifications n${where} AND n.resolved_at IS NULL`, ...params).map((r) => r.id);
    db.tx(() => ids.forEach((id) => db.run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', id, req.user.id, new Date().toISOString())));
    res.json({ ok: true, marked: ids.length });
  });

  app.post('/api/notifications/:id/read', A.requireAuth, (req, res) => {
    const { where, params } = visibleWhere(req);
    const n = db.get(`SELECT n.id FROM notifications n${where} AND n.id = ?`, ...params, Number(req.params.id));
    if (!n) throw new HttpError(404, 'Notificação não encontrada.');
    if (req.body.read === false) db.run('DELETE FROM notification_reads WHERE notification_id = ? AND user_id = ?', n.id, req.user.id);
    else db.run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', n.id, req.user.id, new Date().toISOString());
    res.json({ ok: true });
  });

  // ---- Auditoria (administradores) ----
  app.get('/api/audit', A.requirePerm('audit', 'r'), (req, res) => {
    const params = [req.user.org_id];
    let where = ' WHERE a.org_id = ?';
    if (req.query.user) { where += ' AND a.username = ?'; params.push(String(req.query.user)); }
    if (req.query.entity) { where += ' AND a.entity = ?'; params.push(String(req.query.entity)); }
    if (req.query.action) { where += ' AND a.action = ?'; params.push(String(req.query.action)); }
    if (req.query.from) { where += ' AND substr(a.created_at,1,10) >= ?'; params.push(String(req.query.from).slice(0, 10)); }
    if (req.query.to) { where += ' AND substr(a.created_at,1,10) <= ?'; params.push(String(req.query.to).slice(0, 10)); }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json(db.all(`SELECT a.id, a.created_at, a.username, a.action, a.entity, a.entity_id, a.summary, a.ip FROM audit_log a${where} ORDER BY a.id DESC LIMIT ?`, ...params, limit));
  });

  // ---- Configurações e integrações ----
  app.get('/api/settings', A.requirePerm('settings', 'r'), (req, res) => {
    const org = db.get('SELECT id, name FROM organizations WHERE id = ?', req.user.org_id);
    res.json({
      organization: org,
      integrations: [
        { key: 'database', name: 'Banco de dados (SQLite local)', status: 'configurada', detail: 'Dados persistidos em arquivo. Veja o procedimento de backup na documentação.' },
        { key: 'ia', name: 'AgroSensor IA (visão computacional)', status: config.ai.enabled ? 'configurada' : 'pendente', detail: config.ai.enabled ? `Modelo: ${config.ai.model}` : 'Defina ANTHROPIC_API_KEY no servidor para habilitar a análise automática de imagens.' },
        { key: 'weather', name: 'Clima (Open-Meteo)', status: config.weather.enabled ? 'configurada' : 'desativada', detail: config.weather.enabled ? 'Previsão e histórico reais por coordenadas da fazenda. Não exige chave de API.' : 'Ative com WEATHER_ENABLED=true.' },
        { key: 'sensors', name: 'Sensores IoT via HTTP', status: 'configurada', detail: 'Endpoint POST /api/ingest/{ID do sensor} com chave do dispositivo. MQTT: integração futura (ponte para HTTP).' },
        { key: 'email', name: 'E-mail (SMTP)', status: mailer.enabled() ? 'configurada' : 'pendente', detail: mailer.enabled() ? 'Recuperação de senha por e-mail ativa.' : 'Defina SMTP_HOST, SMTP_USER, SMTP_PASS e SMTP_FROM. Sem isso, o administrador gera links de redefinição.' },
        { key: 'push', name: 'Notificações push', status: 'pendente', detail: 'Preparado para integração futura. Hoje os alertas aparecem no centro de notificações.' },
        { key: 'gps', name: 'Rastreamento GPS de máquinas e drones', status: 'pendente', detail: 'Requer dispositivo/integração. Hoje as posições são informadas manualmente.' },
        { key: 'drone_sdk', name: 'Integração com fabricantes de drones', status: 'pendente', detail: 'O sistema registra missões; não controla drones fisicamente.' },
        { key: 'vra', name: 'Taxa variável / prescrições', status: 'pendente', detail: 'Depende do formato exigido pelo fabricante do equipamento.' },
      ],
      limits: { max_upload_mb: config.maxUploadMb, session_idle_hours: config.sessionIdleHours, session_max_days: config.sessionMaxDays },
    });
  });

  app.put('/api/settings/organization', A.requirePerm('settings', 'w'), (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Dados inválidos.', { name: 'Informe o nome da organização (até 120 caracteres).' });
    db.run('UPDATE organizations SET name = ? WHERE id = ?', name, req.user.org_id);
    A.audit(req, { action: 'editar', entity: 'organizacao', entityId: req.user.org_id, summary: `Renomeou a organização para ${name}` });
    res.json({ ok: true, name });
  });

  // Backup consistente do banco (admin). Não inclui arquivos enviados: veja a documentação.
  app.get('/api/settings/backup', A.requirePerm('settings', 'w'), (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Somente administradores gerais podem baixar backups.');
    const dir = path.join(config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tmp-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(file);
    fs.unlinkSync(file);
    A.audit(req, { action: 'backup', entity: 'sistema', summary: 'Baixou backup do banco de dados' });
    res.setHeader('Content-Disposition', `attachment; filename="agrosensor-backup-${new Date().toISOString().slice(0, 10)}.db"`);
    res.send(buf, 'application/octet-stream');
  });

  app.get('/api/health', (req, res) => {
    db.get('SELECT 1 AS ok');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
};

module.exports.farmClause = farmClause;
