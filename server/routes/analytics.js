'use strict';
// Dashboard, mapa, clima, custos/economia e relatórios (tudo calculado a partir dos dados cadastrados).
const db = require('../lib/db');
const { HttpError } = require('../lib/http');
const A = require('../lib/auth');
const { can } = require('../lib/perms');
const { farmClause, parseJsonCols } = require('../lib/crud');
const { buildPdf } = require('../lib/pdf');
const weather = require('../services/weather');
const alerts = require('../services/alerts');

const COST_LABEL = { insumos: 'Insumos', combustivel: 'Combustível', manutencao: 'Manutenção', operacao_maquinas: 'Operação de máquinas', terceirizados: 'Serviços terceirizados', pulverizacao: 'Pulverização', outros: 'Outros' };
const SEV_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' };
const STATUS_LABEL = {
  planejada: 'Planejada', em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada', aberta: 'Aberta', em_tratamento: 'Em tratamento', resolvida: 'Resolvida',
  disponivel: 'Disponível', em_operacao: 'Em operação', manutencao: 'Manutenção', inativo: 'Inativo', em_missao: 'Em missão', online: 'Online', offline: 'Offline', aguardando: 'Aguardando conexão',
};
const KIND_LABEL = { trator: 'Trator', pulverizador: 'Pulverizador', colheitadeira: 'Colheitadeira', plantadeira: 'Plantadeira', caminhao: 'Caminhão', outro: 'Outro' };
const CAT_LABEL = { praga: 'Praga', doenca: 'Doença', daninha: 'Planta daninha', deficiencia: 'Deficiência', outro: 'Outro' };

const fmtDate = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '');
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: d }));
const fmtMoney = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// Filtros comuns: fazenda, talhão, cultura, safra, período.
function filters(req, { farm = 'x.farm_id', plot = null, crop = null, season = null, date = null } = {}) {
  const params = [req.user.org_id];
  let where = ' WHERE x.org_id = ?' + farmClause(req.user, farm, params);
  const q = req.query;
  if (q.farm_id) { where += ` AND ${farm} = ?`; params.push(Number(q.farm_id)); }
  if (plot && q.plot_id) { where += ` AND ${plot} = ?`; params.push(Number(q.plot_id)); }
  if (crop && q.crop) { where += ` AND ${crop} = ?`; params.push(String(q.crop)); }
  if (season && q.season) { where += ` AND ${season} = ?`; params.push(String(q.season)); }
  if (date && q.from) { where += ` AND substr(${date},1,10) >= ?`; params.push(String(q.from).slice(0, 10)); }
  if (date && q.to) { where += ` AND substr(${date},1,10) <= ?`; params.push(String(q.to).slice(0, 10)); }
  return { where, params };
}

function farmArea(req) {
  const params = [req.user.org_id];
  let where = ' WHERE p.org_id = ?' + farmClause(req.user, 'p.farm_id', params);
  if (req.query.farm_id) { where += ' AND p.farm_id = ?'; params.push(Number(req.query.farm_id)); }
  if (req.query.plot_id) { where += ' AND p.id = ?'; params.push(Number(req.query.plot_id)); }
  if (req.query.crop) { where += ' AND p.crop = ?'; params.push(String(req.query.crop)); }
  return db.get(`SELECT COALESCE(SUM(p.area_ha),0) AS a FROM plots p${where}`, ...params).a;
}

const get1 = (sql, params) => db.get(sql, ...params);

function dashboard(req) {
  const u = req.user;
  const f = (farm, opts) => filters(req, { farm, ...opts });
  const out = {};

  const farmsP = [u.org_id];
  let farmsW = ' WHERE x.org_id = ?' + farmClause(u, 'x.id', farmsP);
  if (req.query.farm_id) { farmsW += ' AND x.id = ?'; farmsP.push(Number(req.query.farm_id)); }
  out.farms = get1(`SELECT COUNT(*) AS n, COALESCE(SUM(x.area_ha),0) AS area_ha FROM farms x${farmsW}`, farmsP);

  const pl = f('x.farm_id', { crop: 'x.crop', season: 'x.season' });
  out.plots = get1(`SELECT COUNT(*) AS n, COALESCE(SUM(x.area_ha),0) AS area_ha, SUM(CASE WHEN x.status = 'ativo' THEN 1 ELSE 0 END) AS active FROM plots x${pl.where}`, pl.params);
  out.crops = db.all(`SELECT x.crop AS crop, COUNT(*) AS plots, COALESCE(SUM(x.area_ha),0) AS area_ha FROM plots x${pl.where} AND x.crop IS NOT NULL GROUP BY x.crop ORDER BY area_ha DESC`, ...pl.params);

  const oc = f('x.farm_id', { plot: 'x.plot_id', date: 'x.observed_at', crop: '(SELECT crop FROM plots WHERE id = x.plot_id)' });
  out.occurrences = {
    open: get1(`SELECT COUNT(*) AS n FROM occurrences x${oc.where} AND x.status <> 'resolvida'`, oc.params).n,
    by_severity: db.all(`SELECT x.severity, COUNT(*) AS n FROM occurrences x${oc.where} AND x.status <> 'resolvida' GROUP BY x.severity`, ...oc.params),
    critical: get1(`SELECT COUNT(*) AS n FROM occurrences x${oc.where} AND x.status <> 'resolvida' AND x.severity IN ('alta','critica')`, oc.params).n,
    total: get1(`SELECT COUNT(*) AS n FROM occurrences x${oc.where}`, oc.params).n,
    recent: db.all(`SELECT x.id, x.name, x.severity, x.status, x.observed_at, fm.name AS farm_name FROM occurrences x JOIN farms fm ON fm.id = x.farm_id${oc.where} ORDER BY x.observed_at DESC LIMIT 5`, ...oc.params),
  };

  const sp = f('x.farm_id', { plot: 'x.plot_id', date: 'x.op_date', crop: 'x.crop' });
  out.spray = {
    by_status: db.all(`SELECT x.status, COUNT(*) AS n FROM spray_operations x${sp.where} GROUP BY x.status`, ...sp.params),
    planned_ha: get1(`SELECT COALESCE(SUM(x.planned_area_ha),0) AS a FROM spray_operations x${sp.where} AND x.status <> 'cancelada'`, sp.params).a,
    executed_ha: get1(`SELECT COALESCE(SUM(x.executed_area_ha),0) AS a FROM spray_operations x${sp.where} AND x.status IN ('em_andamento','concluida')`, sp.params).a,
    volume_l: get1(`SELECT COALESCE(SUM(x.volume_l),0) AS a FROM spray_operations x${sp.where} AND x.status IN ('em_andamento','concluida')`, sp.params).a,
    in_progress: get1(`SELECT COUNT(*) AS n FROM spray_operations x${sp.where} AND x.status = 'em_andamento'`, sp.params).n,
  };
  out.inputs = db.all(
    `SELECT COALESCE(x.product,'Não informado') AS product, COALESCE(x.input_unit,'un') AS unit, COALESCE(SUM(x.input_qty),0) AS qty, COUNT(*) AS ops
       FROM spray_operations x${sp.where} AND x.status IN ('em_andamento','concluida') AND x.input_qty IS NOT NULL GROUP BY 1, 2 ORDER BY qty DESC LIMIT 8`, ...sp.params);

  const mp = [u.org_id];
  let mw = ' WHERE x.org_id = ?' + farmClause(u, 'x.farm_id', mp);
  if (req.query.farm_id) { mw += ' AND x.farm_id = ?'; mp.push(Number(req.query.farm_id)); }
  out.machines = { by_status: db.all(`SELECT x.status, COUNT(*) AS n FROM machines x${mw} GROUP BY x.status`, ...mp), total: get1(`SELECT COUNT(*) AS n FROM machines x${mw}`, mp).n };
  out.drones = { by_status: db.all(`SELECT x.status, COUNT(*) AS n FROM drones x${mw} GROUP BY x.status`, ...mp), total: get1(`SELECT COUNT(*) AS n FROM drones x${mw}`, mp).n };

  const co = f('x.farm_id', { plot: 'x.plot_id', date: 'x.cost_date' });
  out.costs = {
    total: get1(`SELECT COALESCE(SUM(x.amount),0) AS a FROM costs x${co.where}`, co.params).a,
    by_category: db.all(`SELECT x.category, COALESCE(SUM(x.amount),0) AS amount FROM costs x${co.where} GROUP BY x.category ORDER BY amount DESC`, ...co.params),
    by_month: db.all(`SELECT substr(x.cost_date,1,7) AS month, COALESCE(SUM(x.amount),0) AS amount FROM costs x${co.where} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, ...co.params).reverse(),
  };
  const area = farmArea(req);
  out.costs.per_ha = area > 0 ? round(out.costs.total / area) : null;

  const hv = f('x.farm_id', { plot: 'x.plot_id', crop: 'x.crop', season: 'x.season' });
  out.production = db.all(
    `SELECT x.season, x.unit, COALESCE(SUM(x.quantity),0) AS quantity, COALESCE(SUM(x.revenue),0) AS revenue, COALESCE(SUM(COALESCE(x.area_ha,(SELECT area_ha FROM plots WHERE id = x.plot_id))),0) AS area_ha
       FROM harvests x${hv.where} GROUP BY x.season, x.unit ORDER BY x.season`, ...hv.params)
    .map((r) => ({ ...r, productivity: r.area_ha > 0 ? round(r.quantity / r.area_ha) : null }));

  const sn = [u.org_id];
  let sw = ' WHERE x.org_id = ?' + farmClause(u, 'x.farm_id', sn);
  if (req.query.farm_id) { sw += ' AND x.farm_id = ?'; sn.push(Number(req.query.farm_id)); }
  out.sensors = { total: get1(`SELECT COUNT(*) AS n FROM sensors x${sw}`, sn).n, online: get1(`SELECT COUNT(*) AS n FROM sensors x${sw} AND x.status = 'online'`, sn).n, waiting: get1(`SELECT COUNT(*) AS n FROM sensors x${sw} AND x.status = 'aguardando'`, sn).n };

  const ap = [u.org_id];
  let aw = ' WHERE x.org_id = ? AND x.action NOT IN (\'login\',\'logout\',\'login_falhou\',\'solicitar_redefinicao\')';
  if (u.allowedFarms) { aw += ` AND x.farm_id IN (${u.allowedFarms.map(() => '?').join(',')})`; ap.push(...u.allowedFarms); }
  if (req.query.farm_id) { aw += ' AND x.farm_id = ?'; ap.push(Number(req.query.farm_id)); }
  out.activity = db.all(`SELECT x.id, x.created_at, x.username, x.action, x.entity, x.summary FROM audit_log x${aw} ORDER BY x.id DESC LIMIT 12`, ...ap);
  out.empty = get1('SELECT COUNT(*) AS n FROM farms x WHERE x.org_id = ?' + farmClause(u, 'x.id', []), [u.org_id, ...(u.allowedFarms || [])]).n === 0;
  return out;
}

function mapData(req) {
  const u = req.user;
  const out = {};
  const fp = [u.org_id];
  let fw = ' WHERE x.org_id = ?' + farmClause(u, 'x.id', fp);
  if (req.query.farm_id) { fw += ' AND x.id = ?'; fp.push(Number(req.query.farm_id)); }
  out.farms = db.all(`SELECT x.id, x.name, x.latitude, x.longitude, x.city, x.state, x.area_ha FROM farms x${fw}`, ...fp);

  const pp = [u.org_id];
  let pw = ' WHERE x.org_id = ?' + farmClause(u, 'x.farm_id', pp);
  if (req.query.farm_id) { pw += ' AND x.farm_id = ?'; pp.push(Number(req.query.farm_id)); }
  if (req.query.crop) { pw += ' AND x.crop = ?'; pp.push(String(req.query.crop)); }
  out.plots = db.all(`SELECT x.id, x.farm_id, x.name, x.crop, x.variety, x.area_ha, x.status, x.boundary, f.name AS farm_name FROM plots x JOIN farms f ON f.id = x.farm_id${pw}`, ...pp)
    .map((r) => parseJsonCols(r, ['boundary']));

  const o = filters(req, { farm: 'x.farm_id', date: 'x.observed_at' });
  let ow = o.where + ' AND x.lat IS NOT NULL AND x.lng IS NOT NULL';
  const op = [...o.params];
  if (req.query.severity) { ow += ' AND x.severity = ?'; op.push(String(req.query.severity)); }
  if (req.query.status) { ow += ' AND x.status = ?'; op.push(String(req.query.status)); }
  if (req.query.crop) { ow += ' AND p.crop = ?'; op.push(String(req.query.crop)); }
  out.occurrences = db.all(`SELECT x.id, x.farm_id, x.plot_id, x.name, x.category, x.severity, x.status, x.lat, x.lng, x.observed_at, p.name AS plot_name, p.crop AS crop, f.name AS farm_name FROM occurrences x JOIN farms f ON f.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id${ow} ORDER BY x.observed_at DESC LIMIT 1000`, ...op);

  const i = filters(req, { farm: 'x.farm_id', date: 'x.inspected_at' });
  out.inspections = db.all(`SELECT x.id, x.farm_id, x.plot_id, x.lat, x.lng, x.inspected_at, x.notes, p.name AS plot_name FROM inspections x LEFT JOIN plots p ON p.id = x.plot_id${i.where} AND x.lat IS NOT NULL AND x.lng IS NOT NULL ORDER BY x.inspected_at DESC LIMIT 500`, ...i.params);

  const mp = [u.org_id];
  let mw = ' WHERE x.org_id = ? AND x.last_lat IS NOT NULL AND x.last_lng IS NOT NULL' + farmClause(u, 'x.farm_id', mp);
  if (req.query.farm_id) { mw += ' AND x.farm_id = ?'; mp.push(Number(req.query.farm_id)); }
  out.machines = can(u.role, 'machines', 'r') ? db.all(`SELECT x.id, x.name, x.kind, x.status, x.last_lat AS lat, x.last_lng AS lng, x.last_position_at FROM machines x${mw}`, ...mp) : [];

  const sp = filters(req, { farm: 'x.farm_id', date: 'x.op_date', crop: 'x.crop' });
  out.sprays = can(u.role, 'spray', 'r') ? db.all(`SELECT x.id, x.farm_id, x.product, x.status, x.op_date, x.geo_planned, x.geo_executed, x.planned_area_ha, x.executed_area_ha FROM spray_operations x${sp.where} AND (x.geo_planned IS NOT NULL OR x.geo_executed IS NOT NULL) LIMIT 300`, ...sp.params).map((r) => parseJsonCols(r, ['geo_planned', 'geo_executed'])) : [];

  const sn = [u.org_id];
  let sw = ' WHERE x.org_id = ? AND x.lat IS NOT NULL AND x.lng IS NOT NULL' + farmClause(u, 'x.farm_id', sn);
  if (req.query.farm_id) { sw += ' AND x.farm_id = ?'; sn.push(Number(req.query.farm_id)); }
  out.sensors = can(u.role, 'sensors', 'r') ? db.all(`SELECT x.id, x.name, x.kind, x.status, x.lat, x.lng, x.last_value, x.unit FROM sensors x${sw}`, ...sn) : [];
  out.crops = db.all('SELECT DISTINCT crop FROM plots WHERE org_id = ? AND crop IS NOT NULL ORDER BY crop', u.org_id).map((r) => r.crop);
  return out;
}

// ---- Economia ----
function economy(req) {
  const co = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.cost_date' });
  const rows = db.all(`SELECT x.category, COALESCE(SUM(x.amount),0) AS amount, COUNT(*) AS n FROM costs x${co.where} GROUP BY x.category`, ...co.params);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const area = farmArea(req);
  const byCategory = rows.map((r) => ({ category: r.category, label: COST_LABEL[r.category], amount: r.amount, n: r.n, per_ha: area > 0 ? round(r.amount / area) : null })).sort((a, b) => b.amount - a.amount);

  const refParams = [req.user.org_id];
  let refW = ' WHERE x.org_id = ?' + farmClause(req.user, 'x.farm_id', refParams);
  if (req.query.farm_id) { refW += ' AND (x.farm_id = ? OR x.farm_id IS NULL)'; refParams.push(Number(req.query.farm_id)); }
  const refs = db.all(`SELECT x.*, f.name AS farm_name FROM cost_references x LEFT JOIN farms f ON f.id = x.farm_id${refW} ORDER BY x.label`, ...refParams);
  const comparisons = refs.map((r) => {
    let cost = null;
    if (area > 0) {
      const amount = r.category ? (rows.find((c) => c.category === r.category) || { amount: 0 }).amount : total;
      cost = amount / area;
    }
    const enough = cost !== null && total > 0;
    return {
      id: r.id, label: r.label, category: r.category, category_label: r.category ? COST_LABEL[r.category] : 'Todos os custos', farm_name: r.farm_name, reference_per_ha: r.cost_per_ha,
      current_per_ha: enough ? round(cost) : null, savings_pct: enough ? round(((r.cost_per_ha - cost) / r.cost_per_ha) * 100, 1) : null,
      savings_per_ha: enough ? round(r.cost_per_ha - cost) : null, savings_total: enough ? round((r.cost_per_ha - cost) * area) : null,
      note: enough ? null : 'Dados insuficientes: informe custos e a área dos talhões no período para calcular a economia.',
    };
  });
  return { total, area_ha: area, per_ha: area > 0 && total > 0 ? round(total / area) : null, by_category: byCategory, comparisons, formula: 'Economia (%) = ((Custo de referência − Custo atual) ÷ Custo de referência) × 100' };
}

// ---- Relatórios ----
const REPORTS = {
  ocorrencias: {
    title: 'Histórico de pragas e doenças', module: 'occurrences',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.observed_at', crop: 'p.crop' });
      const rows = db.all(`SELECT x.observed_at, fm.name AS farm, p.name AS plot, p.crop, x.category, x.name, x.severity, x.status, x.area_affected_ha, x.source FROM occurrences x JOIN farms fm ON fm.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id${f.where} ORDER BY x.observed_at DESC LIMIT 5000`, ...f.params);
      return {
        columns: ['Data', 'Fazenda', 'Talhão', 'Cultura', 'Tipo', 'Ocorrência', 'Gravidade', 'Situação', 'Área afetada (ha)', 'Origem'],
        rows: rows.map((r) => [fmtDate(r.observed_at), r.farm, r.plot || '', r.crop || '', CAT_LABEL[r.category], r.name, SEV_LABEL[r.severity], STATUS_LABEL[r.status], fmtNum(r.area_affected_ha), r.source === 'ia' ? 'AgroSenser IA' : 'Manual']),
        summary: [{ label: 'Total de ocorrências', value: rows.length }, { label: 'Em aberto', value: rows.filter((r) => r.status !== 'resolvida').length }, { label: 'Graves/críticas', value: rows.filter((r) => ['alta', 'critica'].includes(r.severity)).length }],
        chart: { type: 'bar', title: 'Ocorrências por gravidade', labels: ['Baixa', 'Média', 'Alta', 'Crítica'], values: ['baixa', 'media', 'alta', 'critica'].map((s) => rows.filter((r) => r.severity === s).length) },
      };
    },
  },
  evolucao: {
    title: 'Evolução das ocorrências', module: 'occurrences',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.observed_at', crop: 'p.crop' });
      const rows = db.all(`SELECT substr(x.observed_at,1,7) AS month, COUNT(*) AS total, SUM(CASE WHEN x.severity IN ('alta','critica') THEN 1 ELSE 0 END) AS graves, SUM(CASE WHEN x.status = 'resolvida' THEN 1 ELSE 0 END) AS resolvidas, COALESCE(SUM(x.area_affected_ha),0) AS area FROM occurrences x LEFT JOIN plots p ON p.id = x.plot_id${f.where} GROUP BY 1 ORDER BY 1`, ...f.params);
      return {
        columns: ['Mês', 'Ocorrências', 'Graves/críticas', 'Resolvidas', 'Área afetada (ha)'],
        rows: rows.map((r) => [r.month.split('-').reverse().join('/'), r.total, r.graves, r.resolvidas, fmtNum(r.area)]),
        summary: [{ label: 'Total no período', value: rows.reduce((a, r) => a + r.total, 0) }],
        chart: { type: 'line', title: 'Ocorrências por mês', labels: rows.map((r) => r.month.split('-').reverse().join('/')), values: rows.map((r) => r.total) },
      };
    },
  },
  pulverizacao: {
    title: 'Operações de pulverização', module: 'spray',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.op_date', crop: 'x.crop' });
      const rows = db.all(`SELECT x.*, fm.name AS farm, p.name AS plot, m.name AS machine, d.name AS drone FROM spray_operations x JOIN farms fm ON fm.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id LEFT JOIN machines m ON m.id = x.machine_id LEFT JOIN drones d ON d.id = x.drone_id${f.where} ORDER BY x.op_date DESC LIMIT 5000`, ...f.params);
      const planned = rows.filter((r) => r.status !== 'cancelada').reduce((a, r) => a + (r.planned_area_ha || 0), 0);
      const exec = rows.filter((r) => ['em_andamento', 'concluida'].includes(r.status)).reduce((a, r) => a + (r.executed_area_ha || 0), 0);
      return {
        columns: ['Data', 'Fazenda', 'Talhão', 'Cultura', 'Produto', 'Planejada (ha)', 'Executada (ha)', 'Volume (L)', 'Insumo', 'Equipamento', 'Operador', 'Situação', 'Custo'],
        rows: rows.map((r) => [fmtDate(r.op_date), r.farm, r.plot || '', r.crop || '', r.product || '', fmtNum(r.planned_area_ha), fmtNum(r.executed_area_ha), fmtNum(r.volume_l), r.input_qty !== null ? `${fmtNum(r.input_qty)} ${r.input_unit || ''}` : '', r.machine || r.drone || '', r.operator_name || '', STATUS_LABEL[r.status], fmtMoney(r.cost)]),
        summary: [{ label: 'Operações', value: rows.length }, { label: 'Área planejada', value: `${fmtNum(planned)} ha` }, { label: 'Área executada', value: `${fmtNum(exec)} ha` }, { label: 'Execução', value: planned > 0 ? `${fmtNum((exec / planned) * 100, 1)}%` : '—' }],
        chart: { type: 'bar', title: 'Área planejada x executada (ha)', labels: ['Planejada', 'Executada'], values: [round(planned), round(exec)] },
      };
    },
  },
  maquinas: {
    title: 'Utilização de máquinas', module: 'machines',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.op_date' });
      const rows = db.all(`SELECT m.name, m.kind, COUNT(x.id) AS ops, COALESCE(SUM(x.hours),0) AS hours, m.hour_meter,
          (SELECT COALESCE(SUM(l.liters),0) FROM machine_fuel l WHERE l.machine_id = m.id) AS liters, (SELECT COALESCE(SUM(l.cost),0) FROM machine_fuel l WHERE l.machine_id = m.id) AS fuel_cost,
          (SELECT COALESCE(SUM(t.cost),0) FROM machine_maintenance t WHERE t.machine_id = m.id) AS maint_cost
        FROM machine_operations x JOIN machines m ON m.id = x.machine_id${f.where} GROUP BY m.id ORDER BY hours DESC`, ...f.params);
      return {
        columns: ['Máquina', 'Tipo', 'Operações', 'Horas no período', 'Horímetro (h)', 'Combustível (L)', 'Custo combustível', 'Custo manutenção'],
        rows: rows.map((r) => [r.name, KIND_LABEL[r.kind], r.ops, fmtNum(r.hours), fmtNum(r.hour_meter), fmtNum(r.liters), fmtMoney(r.fuel_cost), fmtMoney(r.maint_cost)]),
        summary: [{ label: 'Máquinas com operações', value: rows.length }, { label: 'Horas totais', value: fmtNum(rows.reduce((a, r) => a + r.hours, 0)) }],
        chart: { type: 'bar', title: 'Horas por máquina', labels: rows.map((r) => r.name), values: rows.map((r) => round(r.hours)) },
      };
    },
  },
  drones: {
    title: 'Missões de drones', module: 'missions',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.mission_date' });
      const rows = db.all(`SELECT x.*, d.name AS drone, fm.name AS farm, p.name AS plot FROM drone_missions x JOIN drones d ON d.id = x.drone_id LEFT JOIN farms fm ON fm.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id${f.where} ORDER BY x.mission_date DESC LIMIT 5000`, ...f.params);
      const TYPE = { pulverizacao: 'Pulverização', mapeamento: 'Mapeamento', inspecao: 'Inspeção', outro: 'Outro' };
      const planned = rows.reduce((a, r) => a + (r.planned_area_ha || 0), 0);
      const cov = rows.filter((r) => r.status === 'concluida').reduce((a, r) => a + (r.covered_area_ha || 0), 0);
      return {
        columns: ['Data', 'Missão', 'Drone', 'Fazenda', 'Talhão', 'Tipo', 'Planejada (ha)', 'Atendida (ha)', 'Voo (min)', 'Operador', 'Situação'],
        rows: rows.map((r) => [fmtDate(r.mission_date), r.name, r.drone, r.farm || '', r.plot || '', TYPE[r.mission_type], fmtNum(r.planned_area_ha), fmtNum(r.covered_area_ha), fmtNum(r.flight_minutes, 0), r.operator_name || '', STATUS_LABEL[r.status]]),
        summary: [{ label: 'Missões', value: rows.length }, { label: 'Área planejada', value: `${fmtNum(planned)} ha` }, { label: 'Área atendida (concluídas)', value: `${fmtNum(cov)} ha` }],
        chart: { type: 'bar', title: 'Missões por situação', labels: ['Planejada', 'Em andamento', 'Concluída', 'Cancelada'], values: ['planejada', 'em_andamento', 'concluida', 'cancelada'].map((s) => rows.filter((r) => r.status === s).length) },
      };
    },
  },
  sensores: {
    title: 'Leituras de sensores (reais)', module: 'sensors',
    run(req) {
      const f = filters(req, { farm: 's.farm_id', plot: 's.plot_id', date: 'x.read_at' });
      const rows = db.all(`SELECT s.name, s.kind, s.unit, fm.name AS farm, COUNT(x.id) AS n, MIN(x.value) AS vmin, AVG(x.value) AS vavg, MAX(x.value) AS vmax, MAX(x.read_at) AS last FROM sensor_readings x JOIN sensors s ON s.id = x.sensor_id JOIN farms fm ON fm.id = s.farm_id${f.where} AND x.is_demo = 0 GROUP BY s.id ORDER BY s.name`, ...f.params);
      return {
        columns: ['Sensor', 'Fazenda', 'Tipo', 'Leituras', 'Mínimo', 'Média', 'Máximo', 'Unidade', 'Última leitura'],
        rows: rows.map((r) => [r.name, r.farm, r.kind.replace('_', ' '), r.n, fmtNum(r.vmin), fmtNum(r.vavg), fmtNum(r.vmax), r.unit, fmtDate(r.last)]),
        summary: [{ label: 'Sensores com leituras reais', value: rows.length }, { label: 'Observação', value: 'Leituras de demonstração não são incluídas' }],
        chart: null,
      };
    },
  },
  insumos: {
    title: 'Consumo de insumos', module: 'spray',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.op_date', crop: 'x.crop' });
      const rows = db.all(`SELECT COALESCE(x.product,'Não informado') AS product, COALESCE(x.input_unit,'un') AS unit, COUNT(*) AS ops, COALESCE(SUM(x.input_qty),0) AS qty, COALESCE(SUM(x.volume_l),0) AS vol, COALESCE(SUM(x.executed_area_ha),0) AS area FROM spray_operations x${f.where} AND x.status IN ('em_andamento','concluida') AND x.input_qty IS NOT NULL GROUP BY 1,2 ORDER BY qty DESC`, ...f.params);
      return {
        columns: ['Produto', 'Unidade', 'Operações', 'Quantidade total', 'Volume de calda (L)', 'Área executada (ha)', 'Quantidade por ha'],
        rows: rows.map((r) => [r.product, r.unit, r.ops, fmtNum(r.qty), fmtNum(r.vol), fmtNum(r.area), r.area > 0 ? fmtNum(r.qty / r.area) : '']),
        summary: [{ label: 'Produtos distintos', value: rows.length }],
        chart: { type: 'bar', title: 'Quantidade aplicada por produto', labels: rows.map((r) => `${r.product} (${r.unit})`), values: rows.map((r) => round(r.qty)) },
      };
    },
  },
  custos: {
    title: 'Custos operacionais', module: 'costs',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', date: 'x.cost_date' });
      const rows = db.all(`SELECT x.cost_date, fm.name AS farm, p.name AS plot, x.category, x.description, x.amount FROM costs x JOIN farms fm ON fm.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id${f.where} ORDER BY x.cost_date DESC LIMIT 5000`, ...f.params);
      const total = rows.reduce((a, r) => a + r.amount, 0);
      const area = farmArea(req);
      const cats = {};
      rows.forEach((r) => { cats[r.category] = (cats[r.category] || 0) + r.amount; });
      return {
        columns: ['Data', 'Fazenda', 'Talhão', 'Categoria', 'Descrição', 'Valor'],
        rows: rows.map((r) => [fmtDate(r.cost_date), r.farm, r.plot || '', COST_LABEL[r.category], r.description, fmtMoney(r.amount)]),
        summary: [{ label: 'Total', value: fmtMoney(total) }, { label: 'Área considerada', value: `${fmtNum(area)} ha` }, { label: 'Custo por hectare', value: area > 0 ? fmtMoney(total / area) : '—' }],
        chart: { type: 'bar', title: 'Custos por categoria (R$)', labels: Object.keys(cats).map((c) => COST_LABEL[c]), values: Object.values(cats).map((x) => round(x)) },
      };
    },
  },
  produtividade: {
    title: 'Produtividade por safra', module: 'costs',
    run(req) {
      const f = filters(req, { farm: 'x.farm_id', plot: 'x.plot_id', crop: 'x.crop', season: 'x.season', date: 'x.harvest_date' });
      const rows = db.all(`SELECT x.season, x.crop, x.unit, fm.name AS farm, p.name AS plot, x.quantity, x.revenue, COALESCE(x.area_ha, p.area_ha) AS area FROM harvests x JOIN farms fm ON fm.id = x.farm_id LEFT JOIN plots p ON p.id = x.plot_id${f.where} ORDER BY x.season DESC, fm.name`, ...f.params);
      return {
        columns: ['Safra', 'Fazenda', 'Talhão', 'Cultura', 'Área (ha)', 'Produção', 'Unidade', 'Produtividade', 'Receita'],
        rows: rows.map((r) => [r.season, r.farm, r.plot || '', r.crop || '', fmtNum(r.area), fmtNum(r.quantity), r.unit, r.area > 0 && r.quantity !== null ? `${fmtNum(r.quantity / r.area)} ${r.unit}/ha` : '', fmtMoney(r.revenue)]),
        summary: [{ label: 'Registros de colheita', value: rows.length }, { label: 'Receita informada', value: fmtMoney(rows.reduce((a, r) => a + (r.revenue || 0), 0)) }],
        chart: { type: 'bar', title: 'Produção por safra', labels: [...new Set(rows.map((r) => r.season))], values: [...new Set(rows.map((r) => r.season))].map((s) => round(rows.filter((r) => r.season === s).reduce((a, r) => a + (r.quantity || 0), 0))) },
      };
    },
  },
  comparativo: {
    title: 'Comparativo entre períodos', module: 'reports',
    run(req) {
      const q = req.query;
      if (!q.a_from || !q.a_to || !q.b_from || !q.b_to) throw new HttpError(400, 'Informe os dois períodos (a_from, a_to, b_from, b_to).');
      const calc = (from, to) => {
        const r = { query: { ...q, from, to }, user: req.user };
        const o = filters(r, { farm: 'x.farm_id', date: 'x.observed_at' });
        const c = filters(r, { farm: 'x.farm_id', date: 'x.cost_date' });
        const s = filters(r, { farm: 'x.farm_id', date: 'x.op_date' });
        const m = filters(r, { farm: 'x.farm_id', date: 'x.op_date' });
        const d = filters(r, { farm: 'x.farm_id', date: 'x.mission_date' });
        return {
          occ: get1(`SELECT COUNT(*) AS n FROM occurrences x${o.where}`, o.params).n,
          grave: get1(`SELECT COUNT(*) AS n FROM occurrences x${o.where} AND x.severity IN ('alta','critica')`, o.params).n,
          cost: get1(`SELECT COALESCE(SUM(x.amount),0) AS a FROM costs x${c.where}`, c.params).a,
          spray: get1(`SELECT COUNT(*) AS n FROM spray_operations x${s.where} AND x.status <> 'cancelada'`, s.params).n,
          sprayHa: get1(`SELECT COALESCE(SUM(x.executed_area_ha),0) AS a FROM spray_operations x${s.where} AND x.status IN ('em_andamento','concluida')`, s.params).a,
          hours: get1(`SELECT COALESCE(SUM(x.hours),0) AS a FROM machine_operations x${m.where}`, m.params).a,
          missions: get1(`SELECT COUNT(*) AS n FROM drone_missions x${d.where} AND x.status = 'concluida'`, d.params).n,
        };
      };
      const A1 = calc(q.a_from, q.a_to);
      const B1 = calc(q.b_from, q.b_to);
      const row = (label, a, b, money) => [label, money ? fmtMoney(a) : fmtNum(a), money ? fmtMoney(b) : fmtNum(b), a === 0 ? (b === 0 ? '0%' : 'novo') : `${fmtNum(((b - a) / a) * 100, 1)}%`];
      return {
        columns: ['Indicador', `Período A (${fmtDate(q.a_from)} a ${fmtDate(q.a_to)})`, `Período B (${fmtDate(q.b_from)} a ${fmtDate(q.b_to)})`, 'Variação B vs A'],
        rows: [row('Ocorrências registradas', A1.occ, B1.occ), row('Ocorrências graves/críticas', A1.grave, B1.grave), row('Custos totais', A1.cost, B1.cost, true), row('Pulverizações', A1.spray, B1.spray), row('Área pulverizada (ha)', A1.sprayHa, B1.sprayHa), row('Horas de máquinas', A1.hours, B1.hours), row('Missões de drones concluídas', A1.missions, B1.missions)],
        summary: [], chart: { type: 'bar', title: 'Custos por período (R$)', labels: ['Período A', 'Período B'], values: [round(A1.cost), round(B1.cost)] },
      };
    },
  },
  economia: {
    title: 'Estimativa de economia', module: 'costs',
    run(req) {
      const e = economy(req);
      return {
        columns: ['Referência', 'Categoria', 'Referência (R$/ha)', 'Atual (R$/ha)', 'Economia (%)', 'Economia (R$)'],
        rows: e.comparisons.map((c) => [c.label, c.category_label, fmtMoney(c.reference_per_ha), c.current_per_ha === null ? '—' : fmtMoney(c.current_per_ha), c.savings_pct === null ? 'dados insuficientes' : `${fmtNum(c.savings_pct, 1)}%`, c.savings_total === null ? '—' : fmtMoney(c.savings_total)]),
        summary: [{ label: 'Fórmula', value: e.formula }, { label: 'Área considerada', value: `${fmtNum(e.area_ha)} ha` }],
        chart: null,
      };
    },
  },
};

const csvCell = (x) => {
  let s = String(x === null || x === undefined ? '' : x);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmulas em planilhas
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

module.exports = function register(app) {
  app.get('/api/dashboard', A.requirePerm('farms', 'r'), (req, res) => {
    try { alerts.refreshOrg(req.user.org_id); } catch (e) { console.error('[alertas]', e.message); }
    res.json(dashboard(req));
  });
  app.get('/api/map', A.requirePerm('map', 'r'), (req, res) => res.json(mapData(req)));
  app.get('/api/filters', A.requireAuth, (req, res) => {
    const u = req.user;
    const fp = [u.org_id];
    const farms = db.all(`SELECT x.id, x.name FROM farms x WHERE x.org_id = ?${farmClause(u, 'x.id', fp)} ORDER BY x.name COLLATE NOCASE`, ...fp);
    const pp = [u.org_id];
    const plots = db.all(`SELECT x.id, x.farm_id, x.name, x.crop, x.season FROM plots x WHERE x.org_id = ?${farmClause(u, 'x.farm_id', pp)} ORDER BY x.name COLLATE NOCASE`, ...pp);
    res.json({ farms, plots, crops: [...new Set(plots.map((p) => p.crop).filter(Boolean))].sort(), seasons: [...new Set(plots.map((p) => p.season).filter(Boolean))].sort().reverse() });
  });

  app.get('/api/weather', A.requirePerm('weather', 'r'), async (req, res) => {
    const id = Number(req.query.farm_id);
    const farm = db.get('SELECT id, org_id, name, latitude, longitude FROM farms WHERE id = ? AND org_id = ?', id, req.user.org_id);
    if (!farm || !A.farmAllowed(req.user, farm.id)) throw new HttpError(404, 'Fazenda não encontrada.');
    const data = await weather.forecastForFarm(farm);
    res.json({ farm: { id: farm.id, name: farm.name, latitude: farm.latitude, longitude: farm.longitude }, ...data });
  });
  app.get('/api/weather/history', A.requirePerm('weather', 'r'), async (req, res) => {
    const id = Number(req.query.farm_id);
    const farm = db.get('SELECT id, org_id, name, latitude, longitude FROM farms WHERE id = ? AND org_id = ?', id, req.user.org_id);
    if (!farm || !A.farmAllowed(req.user, farm.id)) throw new HttpError(404, 'Fazenda não encontrada.');
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, 'Informe um período válido.');
    if (Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new HttpError(400, 'O período máximo é de 1 ano.');
    res.json({ farm: { id: farm.id, name: farm.name }, ...(await weather.history(farm, from, to)) });
  });

  app.get('/api/economy', A.requirePerm('costs', 'r'), (req, res) => res.json(economy(req)));

  app.get('/api/reports', A.requirePerm('reports', 'r'), (req, res) => {
    res.json(Object.entries(REPORTS).filter(([, r]) => can(req.user.role, r.module, 'r')).map(([key, r]) => ({ key, title: r.title })));
  });

  app.get('/api/reports/:type', A.requirePerm('reports', 'r'), (req, res) => {
    const rep = REPORTS[req.params.type];
    if (!rep) throw new HttpError(404, 'Relatório não encontrado.');
    if (!can(req.user.role, rep.module, 'r')) throw new HttpError(403, 'Você não tem permissão para este relatório.');
    const data = rep.run(req);
    const format = String(req.query.format || 'json');
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      const csv = '﻿' + [data.columns, ...data.rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
      res.setHeader('Content-Disposition', `attachment; filename="agrosensor-${req.params.type}-${stamp}.csv"`);
      A.audit(req, { action: 'exportar', entity: 'relatorio', summary: `Exportou CSV: ${rep.title}` });
      return res.send(csv, 'text/csv; charset=utf-8');
    }
    if (format === 'pdf') {
      const sub = [];
      if (req.query.from || req.query.to) sub.push(`Período: ${fmtDate(req.query.from) || '...'} a ${fmtDate(req.query.to) || '...'}`);
      const pdf = buildPdf({ title: rep.title, subtitle: sub.join(' | '), columns: data.columns.map((label) => ({ label })), rows: data.rows, summary: data.summary });
      res.setHeader('Content-Disposition', `attachment; filename="agrosensor-${req.params.type}-${stamp}.pdf"`);
      A.audit(req, { action: 'exportar', entity: 'relatorio', summary: `Exportou PDF: ${rep.title}` });
      return res.send(pdf, 'application/pdf');
    }
    res.json({ key: req.params.type, title: rep.title, ...data });
  });
};
