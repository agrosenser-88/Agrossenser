'use strict';
const db = require('../lib/db');
const config = require('../config');
const { HttpError, readMultipart } = require('../lib/http');
const A = require('../lib/auth');
const { farmClause, parseJsonCols } = require('../lib/crud');
const { v, validateBody } = require('../lib/validate');
const ai = require('../services/ai');
const { storeFile, removeStoredFiles, filePath } = require('./farms');

const IMAGE_TYPES = ['jpg', 'png', 'webp'];

function load(req, id) {
  const params = [req.user.org_id];
  const where = farmClause(req.user, 'a.farm_id', params);
  const row = db.get(
    `SELECT a.*, f.name AS farm_name, p.name AS plot_name, u.name AS created_by_name FROM ai_analyses a JOIN farms f ON f.id = a.farm_id
       LEFT JOIN plots p ON p.id = a.plot_id LEFT JOIN users u ON u.id = a.created_by WHERE a.org_id = ?${where} AND a.id = ?`, ...params, id);
  if (!row) throw new HttpError(404, 'Análise não encontrada.');
  row.images = db.all("SELECT id, filename, mime, size FROM files WHERE ref_type = 'ai_analysis' AND ref_id = ?", row.id);
  return parseJsonCols(row, ['result']);
}

async function runAnalysis(row) {
  const img = db.get("SELECT * FROM files WHERE ref_type = 'ai_analysis' AND ref_id = ? ORDER BY id LIMIT 1", row.id);
  if (!img) return { status: 'erro', message: 'Nenhuma imagem anexada a esta análise.' };
  return ai.analyze({ imagePath: filePath(img.org_id, img.stored_name), mime: img.mime, crop: row.crop, symptoms: row.symptoms, plotName: row.plot_name, farmName: row.farm_name });
}

function saveOutcome(id, out) {
  db.run(
    'UPDATE ai_analyses SET status = ?, result = ?, confidence = ?, provider = ?, model = ?, message = ?, analyzed_at = ? WHERE id = ?',
    out.status, out.result ? JSON.stringify(out.result) : null, out.confidence === undefined ? null : out.confidence, out.status === 'concluida' ? 'anthropic' : null,
    out.model || null, out.message || null, out.status === 'concluida' ? new Date().toISOString() : null, id,
  );
}

module.exports = function register(app) {
  app.get('/api/ia/status', A.requirePerm('ia', 'r'), (req, res) => {
    res.json({ configured: config.ai.enabled, model: config.ai.enabled ? config.ai.model : null, max_upload_mb: config.maxUploadMb });
  });

  app.get('/api/ia/analyses', A.requirePerm('ia', 'r'), (req, res) => {
    const params = [req.user.org_id];
    let where = farmClause(req.user, 'a.farm_id', params);
    if (req.query.farm_id) { where += ' AND a.farm_id = ?'; params.push(Number(req.query.farm_id)); }
    const rows = db.all(
      `SELECT a.id, a.farm_id, a.plot_id, a.crop, a.symptoms, a.status, a.confidence, a.message, a.created_at, a.analyzed_at, a.result, f.name AS farm_name, p.name AS plot_name,
              (SELECT id FROM files WHERE ref_type = 'ai_analysis' AND ref_id = a.id ORDER BY id LIMIT 1) AS image_id,
              (SELECT COUNT(*) FROM occurrences o WHERE o.analysis_id = a.id) AS occurrences_count
         FROM ai_analyses a JOIN farms f ON f.id = a.farm_id LEFT JOIN plots p ON p.id = a.plot_id WHERE a.org_id = ?${where} ORDER BY a.created_at DESC LIMIT 200`, ...params);
    rows.forEach((r) => { parseJsonCols(r, ['result']); if (r.result) { r.top = r.result.possibilities && r.result.possibilities[0] ? r.result.possibilities[0].name : null; delete r.result; } });
    res.json(rows);
  });

  app.get('/api/ia/analyses/:id', A.requirePerm('ia', 'r'), (req, res) => res.json(load(req, Number(req.params.id))));

  app.post('/api/ia/analyses', A.requirePerm('ia', 'w'), async (req, res) => {
    const { fields, files } = await readMultipart(req, { maxBytes: config.maxUploadMb * 1048576 });
    const schema = { farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), crop: v.str({ max: 80 }), symptoms: v.text({ max: 2000 }) };
    const { data, errors } = validateBody(schema, fields, { user: req.user });
    if (!files.length) errors.image = 'Selecione ou fotografe uma imagem.';
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    if (data.plot_id) {
      const p = db.get('SELECT farm_id, crop FROM plots WHERE id = ? AND org_id = ?', data.plot_id, req.user.org_id);
      if (!p || p.farm_id !== data.farm_id) throw new HttpError(400, 'Dados inválidos.', { plot_id: 'O talhão não pertence à fazenda selecionada.' });
      if (!data.crop && p.crop) data.crop = p.crop;
    }
    const r = db.run('INSERT INTO ai_analyses (org_id, farm_id, plot_id, crop, symptoms, status, created_by) VALUES (?,?,?,?,?,?,?)', req.user.org_id, data.farm_id, data.plot_id, data.crop, data.symptoms, 'pendente', req.user.id);
    try {
      storeFile(req, { refType: 'ai_analysis', refId: r.id, farmId: data.farm_id, plotId: data.plot_id, title: 'Imagem da análise', file: files[0], allowed: IMAGE_TYPES });
    } catch (e) {
      db.run('DELETE FROM ai_analyses WHERE id = ?', r.id);
      throw e;
    }
    let row = load(req, r.id);
    saveOutcome(r.id, await runAnalysis(row));
    row = load(req, r.id);
    A.audit(req, { action: 'analise_ia', entity: 'analise_ia', entityId: r.id, farmId: data.farm_id, summary: `Análise IA #${r.id}: ${row.status}` });
    res.json(row, 201);
  });

  app.post('/api/ia/analyses/:id/retry', A.requirePerm('ia', 'w'), async (req, res) => {
    const row = load(req, Number(req.params.id));
    saveOutcome(row.id, await runAnalysis(row));
    A.audit(req, { action: 'analise_ia', entity: 'analise_ia', entityId: row.id, farmId: row.farm_id, summary: `Nova tentativa da análise IA #${row.id}` });
    res.json(load(req, row.id));
  });

  // Registra a ocorrência somente após confirmação do usuário (a IA apenas sugere).
  app.post('/api/ia/analyses/:id/occurrence', A.requirePerm('occurrences', 'w'), (req, res) => {
    const row = load(req, Number(req.params.id));
    const { data, errors } = validateBody({
      name: v.str({ req: true, max: 150 }), category: v.str({ enum: ['praga', 'doenca', 'daninha', 'deficiencia', 'outro'], default: 'praga' }),
      severity: v.str({ enum: ['baixa', 'media', 'alta', 'critica'], default: 'media' }), lat: v.lat(), lng: v.lng(),
    }, req.body, { user: req.user });
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    const desc = `Registrada a partir da análise IA #${row.id} (sujeita à confirmação por engenheiro agrônomo).${row.symptoms ? ' Sintomas: ' + row.symptoms : ''}`;
    const r = db.run(
      `INSERT INTO occurrences (org_id, farm_id, plot_id, category, name, severity, lat, lng, observed_at, description, source, analysis_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.user.org_id, row.farm_id, row.plot_id, data.category, data.name, data.severity, data.lat, data.lng, new Date().toISOString(), desc, 'ia', row.id, req.user.id,
    );
    A.audit(req, { action: 'criar', entity: 'ocorrência', entityId: r.id, farmId: row.farm_id, summary: `Criou ocorrência a partir da análise IA #${row.id}: ${data.name}` });
    require('../services/alerts').refreshOrg(req.user.org_id, { force: true });
    res.json({ id: r.id }, 201);
  });

  app.delete('/api/ia/analyses/:id', A.requirePerm('ia', 'd'), (req, res) => {
    const row = load(req, Number(req.params.id));
    const files = db.all("SELECT org_id, stored_name FROM files WHERE ref_type = 'ai_analysis' AND ref_id = ?", row.id);
    db.tx(() => {
      db.run('UPDATE occurrences SET analysis_id = NULL WHERE analysis_id = ?', row.id);
      db.run("DELETE FROM files WHERE ref_type = 'ai_analysis' AND ref_id = ?", row.id);
      db.run('DELETE FROM ai_analyses WHERE id = ?', row.id);
    });
    removeStoredFiles(files);
    A.audit(req, { action: 'excluir', entity: 'analise_ia', entityId: row.id, farmId: row.farm_id, summary: `Excluiu a análise IA #${row.id}` });
    res.json({ ok: true });
  });
};
