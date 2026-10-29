'use strict';
// Fábrica de rotas CRUD com: permissões por módulo, isolamento por organização, restrição por fazenda,
// validação no servidor, consultas parametrizadas (sem SQL injection) e auditoria.
const db = require('./db');
const { HttpError } = require('./http');
const { requirePerm, farmAllowed, audit } = require('./auth');
const { validateBody } = require('./validate');

function farmClause(user, col, params) {
  if (!user.allowedFarms || !col) return '';
  params.push(...user.allowedFarms);
  return ` AND ${col} IN (${user.allowedFarms.map(() => '?').join(',')})`;
}

function parseJsonCols(row, cols) {
  if (!row) return row;
  for (const c of cols || []) {
    if (typeof row[c] === 'string') {
      try { row[c] = JSON.parse(row[c]); } catch (_) { row[c] = null; }
    }
  }
  return row;
}

function dbError(e) {
  const msg = String((e && e.message) || '');
  if (/UNIQUE constraint failed/i.test(msg)) return new HttpError(409, 'Já existe um registro com esses dados.');
  if (/FOREIGN KEY constraint failed/i.test(msg)) return new HttpError(409, 'Operação bloqueada: existem registros vinculados a este item.');
  if (/CHECK constraint failed|NOT NULL constraint failed/i.test(msg)) return new HttpError(400, 'Dados inválidos para este registro.');
  return e;
}

function crud(app, cfg) {
  const {
    base, table, module, entity, schema, select = 't.*', from = `${table} t`, farmCol = null, filters = {}, search = [],
    dateCol = null, order = 't.id DESC', json = [], parent = null, label = (r) => r.name || `#${r.id}`, hooks = {},
    noDelete = false, hasUpdatedAt = true,
  } = cfg;

  const baseWhere = (req, params) => {
    params.push(req.user.org_id);
    return ' WHERE t.org_id = ?' + farmClause(req.user, farmCol, params);
  };

  const fetchOne = (req, id) => {
    const params = [];
    const where = baseWhere(req, params);
    return parseJsonCols(db.get(`SELECT ${select} FROM ${from}${where} AND t.id = ?`, ...params, id), json);
  };

  function reconcile(ctx, data, existing) {
    const user = ctx.user;
    if (parent) {
      const pid = data[parent.col] !== undefined ? data[parent.col] : existing && existing[parent.col];
      const prow = db.get(`SELECT id, farm_id FROM ${parent.table} WHERE id = ? AND org_id = ?`, pid, user.org_id);
      if (!prow) throw new HttpError(400, 'Dados inválidos.', { [parent.col]: 'Registro relacionado não encontrado.' });
      if (user.allowedFarms && prow.farm_id !== null && !farmAllowed(user, prow.farm_id)) throw new HttpError(403, 'Sem acesso a este registro.');
      if ('farm_id' in schema || parent.inherit) {
        if (parent.inherit === 'always') data.farm_id = prow.farm_id;
        else if (data.farm_id === undefined && !(existing && existing.farm_id)) data.farm_id = prow.farm_id;
      }
    }
    if ('plot_id' in schema) {
      const plotId = data.plot_id !== undefined ? data.plot_id : existing && existing.plot_id;
      const farmId = data.farm_id !== undefined ? data.farm_id : existing && existing.farm_id;
      if (plotId) {
        const plot = db.get('SELECT id, farm_id, crop FROM plots WHERE id = ? AND org_id = ?', plotId, user.org_id);
        if (!plot) throw new HttpError(400, 'Dados inválidos.', { plot_id: 'Talhão não encontrado.' });
        if (farmId === null || farmId === undefined) data.farm_id = plot.farm_id;
        else if (plot.farm_id !== farmId) throw new HttpError(400, 'Dados inválidos.', { plot_id: 'O talhão não pertence à fazenda selecionada.' });
      }
    }
    if (farmCol && farmCol !== 't.id') {
      const farmId = data.farm_id !== undefined ? data.farm_id : existing && existing.farm_id;
      if (user.allowedFarms && farmId !== undefined && !farmAllowed(user, farmId)) throw new HttpError(403, 'Sem acesso a esta fazenda.');
    }
  }

  // Listagem
  app.get(base, requirePerm(module, 'r'), (req, res) => {
    const params = [];
    let where = baseWhere(req, params);
    for (const [q, col] of Object.entries(filters)) {
      const val = req.query[q];
      if (val !== undefined && val !== '') { where += ` AND ${col} = ?`; params.push(val); }
    }
    if (search.length && req.query.q) {
      where += ' AND (' + search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')';
      const like = '%' + String(req.query.q).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      search.forEach(() => params.push(like));
    }
    if (dateCol) {
      if (req.query.from) { where += ` AND substr(${dateCol},1,10) >= ?`; params.push(String(req.query.from).slice(0, 10)); }
      if (req.query.to) { where += ` AND substr(${dateCol},1,10) <= ?`; params.push(String(req.query.to).slice(0, 10)); }
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const total = db.get(`SELECT COUNT(*) AS n FROM ${from}${where}`, ...params).n;
    const rows = db.all(`SELECT ${select} FROM ${from}${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    rows.forEach((r) => parseJsonCols(r, json));
    res.setHeader('X-Total-Count', String(total));
    res.json(rows);
  });

  app.get(`${base}/:id`, requirePerm(module, 'r'), (req, res) => {
    const row = fetchOne(req, Number(req.params.id));
    if (!row) throw new HttpError(404, 'Registro não encontrado.');
    res.json(row);
  });

  app.post(base, requirePerm(module, 'w'), (req, res) => {
    const ctx = { user: req.user, req };
    const { data, errors } = validateBody(schema, req.body, ctx);
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    reconcile(ctx, data, null);
    if (hooks.beforeSave) hooks.beforeSave(ctx, data, null, true);
    // reaplica obrigatoriedade para colunas derivadas (ex.: farm_id vindo do talhão)
    const missing = {};
    for (const [k, fn] of Object.entries(schema)) if (fn.required && (data[k] === undefined || data[k] === null)) missing[k] = 'Campo obrigatório.';
    if (Object.keys(missing).length) throw new HttpError(400, 'Dados inválidos.', missing);
    const cols = ['org_id', ...Object.keys(data)];
    const vals = [req.user.org_id, ...Object.values(data)];
    if (hooks.extraInsert) { const x = hooks.extraInsert(ctx); for (const [k, val] of Object.entries(x)) { cols.push(k); vals.push(val); } }
    let id;
    try {
      id = db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals).id;
    } catch (e) { throw dbError(e); }
    const row = fetchOne(req, id);
    audit(req, { action: 'criar', entity, entityId: id, farmId: row && (row.farm_id || (table === 'farms' ? id : null)), summary: `Criou ${entity}: ${label(row)}` });
    if (hooks.afterSave) hooks.afterSave(ctx, row, true);
    res.json(row, 201);
  });

  app.put(`${base}/:id`, requirePerm(module, 'w'), (req, res) => {
    const id = Number(req.params.id);
    const existing = fetchOne(req, id);
    if (!existing) throw new HttpError(404, 'Registro não encontrado.');
    const ctx = { user: req.user, req };
    const { data, errors } = validateBody(schema, req.body, ctx, { partial: true });
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    for (const [k, fn] of Object.entries(schema)) if (fn.required && k in data && data[k] === null) errors[k] = 'Campo obrigatório.';
    if (Object.keys(errors).length) throw new HttpError(400, 'Dados inválidos.', errors);
    reconcile(ctx, data, existing);
    if (hooks.beforeSave) hooks.beforeSave(ctx, data, existing, false);
    const keys = Object.keys(data);
    if (!keys.length) throw new HttpError(400, 'Nenhum campo válido para atualizar.');
    const sets = keys.map((k) => `${k} = ?`);
    if (hasUpdatedAt) sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    try {
      db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, ...keys.map((k) => data[k]), id, req.user.org_id);
    } catch (e) { throw dbError(e); }
    const row = fetchOne(req, id);
    const changed = {};
    for (const k of keys) {
      const nv = data[k];
      changed[k] = typeof nv === 'string' && nv.length > 120 ? '[alterado]' : nv;
    }
    audit(req, { action: 'editar', entity, entityId: id, farmId: row.farm_id || (table === 'farms' ? id : null), summary: `Editou ${entity}: ${label(row)}`, details: changed });
    if (hooks.afterSave) hooks.afterSave(ctx, row, false, existing);
    res.json(row);
  });

  if (!noDelete) {
    app.delete(`${base}/:id`, requirePerm(module, 'd'), (req, res) => {
      const id = Number(req.params.id);
      const existing = fetchOne(req, id);
      if (!existing) throw new HttpError(404, 'Registro não encontrado.');
      if (hooks.beforeDelete) hooks.beforeDelete({ user: req.user, req }, existing);
      try {
        db.run(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`, id, req.user.org_id);
      } catch (e) { throw dbError(e); }
      audit(req, { action: 'excluir', entity, entityId: id, farmId: existing.farm_id || (table === 'farms' ? id : null), summary: `Excluiu ${entity}: ${label(existing)}` });
      if (hooks.afterDelete) hooks.afterDelete({ user: req.user, req }, existing);
      res.json({ ok: true });
    });
  }
  return { fetchOne };
}

module.exports = { crud, farmClause, parseJsonCols, dbError };
