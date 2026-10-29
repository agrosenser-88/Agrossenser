'use strict';
// Sensores agrícolas / IoT. Leituras reais chegam por API (ingest) com chave do dispositivo; leituras de teste são marcadas como demonstração.
const crypto = require('crypto');
const db = require('../lib/db');
const { HttpError, createLimiter, sha256 } = require('../lib/http');
const A = require('../lib/auth');
const { crud } = require('../lib/crud');
const { v, validateBody } = require('../lib/validate');
const { upsert } = require('../services/alerts');

const KINDS = ['umidade_solo', 'temperatura', 'umidade_ar', 'chuva', 'irrigacao', 'outro'];
const DEFAULT_UNIT = { umidade_solo: '%', temperatura: '°C', umidade_ar: '%', chuva: 'mm', irrigacao: 'L', outro: '' };
const ingestLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });

const schema = {
  farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), name: v.str({ req: true, max: 120 }),
  kind: v.str({ enum: KINDS, default: 'umidade_solo' }), unit: v.str({ max: 12 }),
  min_limit: v.num({ min: -100000, max: 100000 }), max_limit: v.num({ min: -100000, max: 100000 }),
  lat: v.lat(), lng: v.lng(), status: v.str({ enum: ['aguardando', 'inativo'] }), notes: v.text(),
};

function publicSensor(s) {
  if (!s) return s;
  const { key_hash, ...rest } = s;
  return rest;
}

function checkLimits(sensor, value, readAt) {
  const low = sensor.min_limit !== null && value < sensor.min_limit;
  const high = sensor.max_limit !== null && value > sensor.max_limit;
  const key = `sensorlimit:${sensor.id}`;
  if (low || high) {
    upsert(sensor.org_id, {
      key, farm_id: sensor.farm_id, category: 'sensor', severity: 'atencao',
      title: `${sensor.name}: leitura ${low ? 'abaixo do mínimo' : 'acima do máximo'}`,
      body: `Valor ${value} ${sensor.unit || ''} (limite ${low ? 'mínimo ' + sensor.min_limit : 'máximo ' + sensor.max_limit}) em ${new Date(readAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
      link: '#/sensores',
    });
  } else {
    db.run('UPDATE notifications SET resolved_at = ? WHERE org_id = ? AND dedup_key = ? AND resolved_at IS NULL', new Date().toISOString(), sensor.org_id, key);
  }
}

function insertReadings(sensor, list, isDemo) {
  let latest = null;
  db.tx(() => {
    for (const r of list) {
      db.run('INSERT INTO sensor_readings (org_id, sensor_id, value, read_at, is_demo) VALUES (?,?,?,?,?)', sensor.org_id, sensor.id, r.value, r.read_at, isDemo ? 1 : 0);
      if (!isDemo && (!latest || r.read_at > latest.read_at)) latest = r;
    }
    if (latest) {
      const prev = db.get('SELECT last_reading_at FROM sensors WHERE id = ?', sensor.id);
      if (!prev.last_reading_at || latest.read_at >= prev.last_reading_at) {
        db.run("UPDATE sensors SET last_value = ?, last_reading_at = ?, status = CASE WHEN status = 'inativo' THEN status ELSE 'online' END, updated_at = ? WHERE id = ?", latest.value, latest.read_at, new Date().toISOString(), sensor.id);
      }
    }
  });
  if (latest) checkLimits(sensor, latest.value, latest.read_at);
}

module.exports = function register(app) {
  const { fetchOne } = (() => ({ fetchOne: null }))();
  void fetchOne;

  // Criação customizada: gera o identificador do dispositivo e a chave (exibida uma única vez).
  app.post('/api/sensors', A.requirePerm('sensors', 'w'), (req, res) => {
    const { data, errors } = validateBody(schema, req.body, { user: req.user });
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    if (data.status === 'aguardando') delete data.status;
    if (req.user.allowedFarms && !A.farmAllowed(req.user, data.farm_id)) throw new HttpError(403, 'Sem acesso a esta fazenda.');
    if (data.plot_id) {
      const p = db.get('SELECT farm_id FROM plots WHERE id = ? AND org_id = ?', data.plot_id, req.user.org_id);
      if (!p || p.farm_id !== data.farm_id) throw new HttpError(400, 'Dados inválidos.', { plot_id: 'O talhão não pertence à fazenda selecionada.' });
    }
    if (data.min_limit !== null && data.max_limit !== null && data.min_limit > data.max_limit) throw new HttpError(400, 'Dados inválidos.', { min_limit: 'O limite mínimo deve ser menor que o máximo.' });
    const deviceId = 'AGS-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const key = 'sk_' + crypto.randomBytes(24).toString('base64url');
    const unit = data.unit !== null && data.unit !== undefined ? data.unit : DEFAULT_UNIT[data.kind || 'umidade_solo'];
    const r = db.run(
      `INSERT INTO sensors (org_id, farm_id, plot_id, name, kind, unit, device_id, key_hash, min_limit, max_limit, lat, lng, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.user.org_id, data.farm_id, data.plot_id, data.name, data.kind || 'umidade_solo', unit, deviceId, sha256(key), data.min_limit, data.max_limit, data.lat, data.lng, data.notes,
    );
    A.audit(req, { action: 'criar', entity: 'sensor', entityId: r.id, farmId: data.farm_id, summary: `Criou o sensor ${data.name} (${deviceId})` });
    const row = publicSensor(db.get('SELECT * FROM sensors WHERE id = ?', r.id));
    res.json({ ...row, api_key: key }, 201);
  });

  crud(app, {
    base: '/api/sensors', table: 'sensors', module: 'sensors', entity: 'sensor', farmCol: 't.farm_id',
    schema: { ...schema, farm_id: v.ref('farms') },
    select: 't.id, t.org_id, t.farm_id, t.plot_id, t.name, t.kind, t.unit, t.device_id, t.min_limit, t.max_limit, t.lat, t.lng, t.status, t.last_reading_at, t.last_value, t.notes, t.created_at, t.updated_at, f.name AS farm_name, p.name AS plot_name, (SELECT COUNT(*) FROM sensor_readings r WHERE r.sensor_id = t.id AND r.is_demo = 0) AS real_readings, (SELECT COUNT(*) FROM sensor_readings r WHERE r.sensor_id = t.id AND r.is_demo = 1) AS demo_readings',
    from: 'sensors t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id', kind: 't.kind', status: 't.status' }, search: ['t.name', 't.device_id'], order: 't.name COLLATE NOCASE',
    hooks: {
      beforeSave: (ctx, data, existing) => {
        const lo = data.min_limit !== undefined ? data.min_limit : existing && existing.min_limit;
        const hi = data.max_limit !== undefined ? data.max_limit : existing && existing.max_limit;
        if (lo !== null && lo !== undefined && hi !== null && hi !== undefined && lo > hi) throw new HttpError(400, 'Dados inválidos.', { min_limit: 'O limite mínimo deve ser menor que o máximo.' });
        if (data.status === 'aguardando' && existing && existing.real_readings > 0) data.status = 'online';
      },
    },
  });
  // (a rota POST do crud fica sombreada pela rota personalizada acima, registrada primeiro)

  const sensorFor = (req, perm = 'r') => {
    const s = db.get('SELECT * FROM sensors WHERE id = ? AND org_id = ?', Number(req.params.id), req.user.org_id);
    if (!s) throw new HttpError(404, 'Sensor não encontrado.');
    if (req.user.allowedFarms && !A.farmAllowed(req.user, s.farm_id)) throw new HttpError(403, 'Sem acesso a este sensor.');
    void perm;
    return s;
  };

  app.get('/api/sensors/:id/readings', A.requirePerm('sensors', 'r'), (req, res) => {
    const s = sensorFor(req);
    const params = [s.id];
    let where = 'sensor_id = ?';
    if (req.query.from) { where += ' AND substr(read_at,1,10) >= ?'; params.push(String(req.query.from).slice(0, 10)); }
    if (req.query.to) { where += ' AND substr(read_at,1,10) <= ?'; params.push(String(req.query.to).slice(0, 10)); }
    if (req.query.demo === '0') where += ' AND is_demo = 0';
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    const rows = db.all(`SELECT id, value, read_at, is_demo FROM sensor_readings WHERE ${where} ORDER BY read_at DESC LIMIT ?`, ...params, limit);
    res.json({ sensor: publicSensor(s), readings: rows.reverse() });
  });

  // Leituras de demonstração: claramente identificadas, nunca alteram o status real do sensor.
  app.post('/api/sensors/:id/demo-readings', A.requirePerm('sensors', 'w'), (req, res) => {
    const s = sensorFor(req);
    const count = Math.min(Math.max(parseInt(req.body.count, 10) || 24, 1), 200);
    const base = { umidade_solo: 35, temperatura: 26, umidade_ar: 60, chuva: 1, irrigacao: 10, outro: 50 }[s.kind];
    const list = [];
    const now = Date.now();
    for (let i = count - 1; i >= 0; i -= 1) {
      const wave = Math.sin(i / 4) * (base * 0.2);
      list.push({ value: Math.round((base + wave + (Math.random() - 0.5) * base * 0.1) * 10) / 10, read_at: new Date(now - i * 3600000).toISOString() });
    }
    insertReadings(s, list, true);
    A.audit(req, { action: 'dados_demonstracao', entity: 'sensor', entityId: s.id, farmId: s.farm_id, summary: `Gerou ${count} leituras de DEMONSTRAÇÃO para ${s.name}` });
    res.json({ ok: true, demo: true, count });
  });

  app.delete('/api/sensors/:id/demo-readings', A.requirePerm('sensors', 'w'), (req, res) => {
    const s = sensorFor(req);
    const r = db.run('DELETE FROM sensor_readings WHERE sensor_id = ? AND is_demo = 1', s.id);
    res.json({ ok: true, removed: r.changes });
  });

  // Registro manual de uma leitura real (ex.: medição de campo).
  app.post('/api/sensors/:id/readings', A.requirePerm('sensors', 'w'), (req, res) => {
    const s = sensorFor(req);
    const { data, errors } = validateBody({ value: v.num({ req: true, min: -1e9, max: 1e9 }), read_at: v.datetime() }, req.body, { user: req.user });
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    const at = data.read_at || new Date().toISOString();
    if (Date.parse(at) > Date.now() + 5 * 60000) throw new HttpError(400, 'Dados inválidos.', { read_at: 'A data da leitura não pode estar no futuro.' });
    insertReadings(s, [{ value: data.value, read_at: at }], false);
    A.audit(req, { action: 'leitura_manual', entity: 'sensor', entityId: s.id, farmId: s.farm_id, summary: `Leitura manual registrada em ${s.name}` });
    res.json({ ok: true }, 201);
  });

  app.post('/api/sensors/:id/rotate-key', A.requirePerm('sensors', 'w'), (req, res) => {
    const s = sensorFor(req);
    const key = 'sk_' + crypto.randomBytes(24).toString('base64url');
    db.run('UPDATE sensors SET key_hash = ?, updated_at = ? WHERE id = ?', sha256(key), new Date().toISOString(), s.id);
    A.audit(req, { action: 'nova_chave', entity: 'sensor', entityId: s.id, farmId: s.farm_id, summary: `Gerou nova chave de API para ${s.name}` });
    res.json({ api_key: key, device_id: s.device_id });
  });

  // Ingestão por dispositivo (HTTP). Autenticada por chave do dispositivo; sem cookies.
  app.post('/api/ingest/:device', (req, res) => {
    ingestLimiter.check('ing:' + req.params.device);
    const auth = String(req.headers['x-device-key'] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = db.get('SELECT * FROM sensors WHERE device_id = ?', req.params.device);
    const ok = s && auth && crypto.timingSafeEqual(Buffer.from(sha256(auth)), Buffer.from(s.key_hash));
    if (!ok) throw new HttpError(401, 'Dispositivo ou chave inválidos.');
    if (s.status === 'inativo') throw new HttpError(409, 'Sensor inativo.');
    const items = Array.isArray(req.body.readings) ? req.body.readings.slice(0, 500) : [req.body];
    const list = [];
    for (const it of items) {
      const val = Number(it && it.value);
      if (!Number.isFinite(val)) throw new HttpError(400, 'Valor de leitura inválido.');
      let at = new Date().toISOString();
      if (it.read_at) {
        const d = new Date(it.read_at);
        if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60000) throw new HttpError(400, 'Data da leitura inválida.');
        at = d.toISOString();
      }
      list.push({ value: val, read_at: at });
    }
    if (!list.length) throw new HttpError(400, 'Nenhuma leitura enviada.');
    insertReadings(s, list, false);
    res.json({ ok: true, accepted: list.length }, 201);
  });
};
