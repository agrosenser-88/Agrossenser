'use strict';
// Fazendas, talhões e arquivos (documentos/imagens).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('../lib/db');
const { HttpError, readMultipart } = require('../lib/http');
const A = require('../lib/auth');
const { can } = require('../lib/perms');
const { crud, farmClause } = require('../lib/crud');
const { v } = require('../lib/validate');

const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

// Tipos de arquivo aceitos (verificação por assinatura/“magic bytes”; SVG e HTML são recusados de propósito).
const FILE_TYPES = {
  jpg: { mime: 'image/jpeg', inline: true, test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', inline: true, test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp', inline: true, test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  pdf: { mime: 'application/pdf', inline: true, test: (b) => b.slice(0, 5).toString() === '%PDF-' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  csv: { mime: 'text/csv', inline: false, test: (b) => !b.includes(0) },
  txt: { mime: 'text/plain', inline: false, test: (b) => !b.includes(0) },
};
const IMAGE_ONLY = ['jpg', 'png', 'webp'];

function detectType(filename, data, allowed) {
  const ext = path.extname(filename).slice(1).toLowerCase().replace('jpeg', 'jpg');
  const t = FILE_TYPES[ext];
  if (!t || !allowed.includes(ext) || !t.test(data)) return null;
  return { ext, ...t };
}

// Relação tipo de referência -> tabela e módulo que controla o acesso.
const REFS = {
  farm: { table: 'farms', module: 'farms' },
  plot: { table: 'plots', module: 'plots' },
  occurrence: { table: 'occurrences', module: 'occurrences' },
  ai_analysis: { table: 'ai_analyses', module: 'ia' },
  drone_mission: { table: 'drone_missions', module: 'missions' },
  spray_operation: { table: 'spray_operations', module: 'spray' },
  machine: { table: 'machines', module: 'machines' },
};

function refRow(req, refType, refId) {
  const ref = REFS[refType];
  if (!ref) throw new HttpError(400, 'Tipo de referência inválido.');
  const row = db.get(`SELECT * FROM ${ref.table} WHERE id = ? AND org_id = ?`, refId, req.user.org_id);
  if (!row) throw new HttpError(404, 'Registro não encontrado.');
  const farmId = ref.table === 'farms' ? row.id : row.farm_id;
  if (req.user.allowedFarms && !A.farmAllowed(req.user, farmId)) throw new HttpError(403, 'Sem acesso a este registro.');
  return { row, farmId, plotId: ref.table === 'plots' ? row.id : row.plot_id || null, ref };
}

function filePath(orgId, stored) {
  return path.join(config.uploadDir, String(orgId), stored);
}

function removeStoredFiles(list) {
  for (const f of list) {
    try { fs.unlinkSync(filePath(f.org_id, f.stored_name)); } catch (_) { /* arquivo já removido */ }
  }
}

// Salva um arquivo enviado e registra no banco. Retorna o registro.
function storeFile(req, { refType, refId, farmId, plotId, title, file, allowed }) {
  const t = detectType(file.filename, file.data, allowed);
  if (!t) throw new HttpError(400, 'Tipo de arquivo não permitido ou conteúdo inválido. Aceitos: ' + allowed.join(', ').toUpperCase() + '.');
  if (!file.data.length) throw new HttpError(400, 'Arquivo vazio.');
  if (file.data.length > config.maxUploadMb * 1048576) throw new HttpError(413, `Arquivo maior que o limite de ${config.maxUploadMb} MB.`);
  const dir = path.join(config.uploadDir, String(req.user.org_id));
  fs.mkdirSync(dir, { recursive: true });
  const stored = crypto.randomBytes(16).toString('hex') + '.' + t.ext;
  fs.writeFileSync(path.join(dir, stored), file.data, { mode: 0o600 });
  const safeName = path.basename(file.filename).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, 150) || ('arquivo.' + t.ext);
  const r = db.run(
    'INSERT INTO files (org_id, farm_id, plot_id, ref_type, ref_id, title, filename, stored_name, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    req.user.org_id, farmId, plotId, refType, refId, title ? String(title).slice(0, 200) : null, safeName, stored, t.mime, file.data.length, req.user.id,
  );
  return db.get('SELECT id, ref_type, ref_id, title, filename, mime, size, created_at FROM files WHERE id = ?', r.id);
}

function register(app) {
  // ---- Fazendas ----
  crud(app, {
    base: '/api/farms', table: 'farms', module: 'farms', entity: 'fazenda', farmCol: 't.id',
    schema: {
      name: v.str({ req: true, max: 120 }),
      owner_name: v.str({ max: 120 }),
      city: v.str({ max: 100 }),
      state: v.str({ enum: STATES, max: 2 }),
      area_ha: v.num({ min: 0, max: 10000000 }),
      latitude: v.lat(),
      longitude: v.lng(),
      notes: v.text(),
    },
    select: `t.*, (SELECT COUNT(*) FROM plots p WHERE p.farm_id = t.id) AS plot_count,
             (SELECT COALESCE(SUM(p.area_ha),0) FROM plots p WHERE p.farm_id = t.id) AS plots_area_ha,
             (SELECT COUNT(*) FROM occurrences o WHERE o.farm_id = t.id AND o.status <> 'resolvida') AS open_occurrences`,
    search: ['t.name', 't.owner_name', 't.city'], order: 't.name COLLATE NOCASE ASC',
    hooks: {
      extraInsert: (ctx) => ({ created_by: ctx.user.id }),
      beforeSave: (ctx, data, existing, isCreate) => {
        if (isCreate && ctx.user.allowedFarms) throw new HttpError(403, 'Seu perfil não permite cadastrar novas fazendas.');
      },
      beforeDelete: (ctx, farm) => {
        if (String(ctx.req.query.confirm || '') !== farm.name) throw new HttpError(400, 'Para excluir, confirme informando o nome exato da fazenda. Todos os dados vinculados serão apagados.');
        ctx.req._files = db.all('SELECT org_id, stored_name FROM files WHERE farm_id = ?', farm.id);
      },
      afterDelete: (ctx) => removeStoredFiles(ctx.req._files || []),
    },
  });

  // ---- Talhões ----
  crud(app, {
    base: '/api/plots', table: 'plots', module: 'plots', entity: 'talhão', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }),
      name: v.str({ req: true, max: 120 }),
      crop: v.str({ max: 80 }),
      variety: v.str({ max: 80 }),
      area_ha: v.num({ min: 0, max: 1000000 }),
      season: v.str({ max: 20 }),
      planting_date: v.date(),
      harvest_forecast: v.date(),
      status: v.str({ enum: ['planejado', 'ativo', 'colhido', 'inativo'], default: 'ativo' }),
      boundary: v.json({ geo: true }),
      notes: v.text(),
    },
    select: 't.*, f.name AS farm_name', from: 'plots t JOIN farms f ON f.id = t.farm_id',
    filters: { farm_id: 't.farm_id', crop: 't.crop', season: 't.season', status: 't.status' },
    search: ['t.name', 't.crop', 't.variety'], order: 'f.name COLLATE NOCASE, t.name COLLATE NOCASE', json: ['boundary'],
    hooks: {
      beforeSave: (ctx, data, existing) => {
        const pd = data.planting_date !== undefined ? data.planting_date : existing && existing.planting_date;
        const hf = data.harvest_forecast !== undefined ? data.harvest_forecast : existing && existing.harvest_forecast;
        if (pd && hf && hf < pd) throw new HttpError(400, 'Dados inválidos.', { harvest_forecast: 'A previsão de colheita deve ser posterior ao plantio.' });
      },
      beforeDelete: (ctx, plot) => { ctx.req._files = db.all('SELECT org_id, stored_name FROM files WHERE ref_type = ? AND ref_id = ?', 'plot', plot.id); },
      afterDelete: (ctx) => removeStoredFiles(ctx.req._files || []),
    },
  });

  // ---- Arquivos ----
  app.get('/api/files', A.requireAuth, (req, res) => {
    const refType = String(req.query.ref_type || '');
    const refId = Number(req.query.ref_id);
    const { ref } = refRow(req, refType, refId);
    if (!can(req.user.role, ref.module, 'r')) throw new HttpError(403, 'Você não tem permissão para esta ação.');
    res.json(db.all(
      `SELECT f.id, f.ref_type, f.ref_id, f.title, f.filename, f.mime, f.size, f.created_at, u.name AS uploaded_by_name
         FROM files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.org_id = ? AND f.ref_type = ? AND f.ref_id = ? ORDER BY f.created_at DESC`,
      req.user.org_id, refType, refId));
  });

  app.post('/api/files', A.requireAuth, async (req, res) => {
    const { fields, files } = await readMultipart(req, { maxBytes: config.maxUploadMb * 1048576 });
    const refType = String(fields.ref_type || '');
    const refId = Number(fields.ref_id);
    const { row, farmId, plotId, ref } = refRow(req, refType, refId);
    if (!can(req.user.role, ref.module, 'w')) throw new HttpError(403, 'Você não tem permissão para esta ação.');
    if (!files.length) throw new HttpError(400, 'Selecione um arquivo.');
    const allowed = ['farm', 'plot'].includes(refType) ? Object.keys(FILE_TYPES) : IMAGE_ONLY.concat(['pdf']);
    const rec = storeFile(req, { refType, refId, farmId, plotId, title: fields.title, file: files[0], allowed });
    A.audit(req, { action: 'enviar_arquivo', entity: 'arquivo', entityId: rec.id, farmId, summary: `Enviou o arquivo ${rec.filename} (${refType} #${row.id})` });
    res.json(rec, 201);
  });

  app.get('/api/files/:id/download', A.requireAuth, (req, res) => {
    const f = db.get('SELECT * FROM files WHERE id = ? AND org_id = ?', Number(req.params.id), req.user.org_id);
    if (!f) throw new HttpError(404, 'Arquivo não encontrado.');
    const { ref } = refRow(req, f.ref_type, f.ref_id);
    if (!can(req.user.role, ref.module, 'r')) throw new HttpError(403, 'Você não tem permissão para esta ação.');
    const p = filePath(f.org_id, f.stored_name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Arquivo indisponível no armazenamento.');
    const ext = path.extname(f.stored_name).slice(1);
    const t = FILE_TYPES[ext];
    const inline = t && t.inline && req.query.download !== '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(fs.readFileSync(p), f.mime);
  });

  app.delete('/api/files/:id', A.requireAuth, (req, res) => {
    const f = db.get('SELECT * FROM files WHERE id = ? AND org_id = ?', Number(req.params.id), req.user.org_id);
    if (!f) throw new HttpError(404, 'Arquivo não encontrado.');
    const { ref, farmId } = refRow(req, f.ref_type, f.ref_id);
    if (!can(req.user.role, ref.module, 'w')) throw new HttpError(403, 'Você não tem permissão para esta ação.');
    db.run('DELETE FROM files WHERE id = ?', f.id);
    removeStoredFiles([f]);
    A.audit(req, { action: 'excluir', entity: 'arquivo', entityId: f.id, farmId, summary: `Excluiu o arquivo ${f.filename}` });
    res.json({ ok: true });
  });

  // ---- Histórico de uma fazenda (auditoria filtrada) ----
  app.get('/api/farms/:id/history', A.requirePerm('farms', 'r'), (req, res) => {
    const id = Number(req.params.id);
    if (!db.get('SELECT 1 AS x FROM farms WHERE id = ? AND org_id = ?', id, req.user.org_id) || !A.farmAllowed(req.user, id)) throw new HttpError(404, 'Fazenda não encontrada.');
    res.json(db.all(
      `SELECT id, created_at, username, action, entity, entity_id, summary FROM audit_log
        WHERE org_id = ? AND farm_id = ? ORDER BY id DESC LIMIT 200`, req.user.org_id, id));
  });
}

module.exports = register;
module.exports.storeFile = storeFile;
module.exports.removeStoredFiles = removeStoredFiles;
module.exports.refRow = refRow;
module.exports.filePath = filePath;
module.exports.FILE_TYPES = FILE_TYPES;
module.exports.farmClause = farmClause;
