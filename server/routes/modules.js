'use strict';
// Módulos operacionais: inspeções, pragas/doenças, máquinas, drones, pulverização, custos e produtividade.
const db = require('../lib/db');
const { HttpError } = require('../lib/http');
const { crud } = require('../lib/crud');
const { v } = require('../lib/validate');

const alerts = () => require('../services/alerts');
const refreshAlerts = (ctx) => { try { alerts().refreshOrg(ctx.user.org_id); } catch (e) { console.error('[alertas]', e.message); } };
const createdBy = (ctx) => ({ created_by: ctx.user.id });

const SEVERITY = ['baixa', 'media', 'alta', 'critica'];
const OP_STATUS = ['planejada', 'em_andamento', 'concluida', 'cancelada'];
const COST_CATEGORIES = ['insumos', 'combustivel', 'manutencao', 'operacao_maquinas', 'terceirizados', 'pulverizacao', 'outros'];

function bumpHourMeter(machineId, value) {
  if (value === null || value === undefined) return;
  db.run('UPDATE machines SET hour_meter = ?, updated_at = ? WHERE id = ? AND hour_meter < ?', value, new Date().toISOString(), machineId, value);
}

function dateOrder(data, existing, a, b, label) {
  const x = data[a] !== undefined ? data[a] : existing && existing[a];
  const y = data[b] !== undefined ? data[b] : existing && existing[b];
  if (x && y && y < x) throw new HttpError(400, 'Dados inválidos.', { [b]: label });
}

module.exports = function register(app) {
  const J = (alias) => `LEFT JOIN farms ${alias} ON ${alias}.id = t.farm_id`;

  // ---------- Inspeções ----------
  crud(app, {
    base: '/api/inspections', table: 'inspections', module: 'map', entity: 'inspeção', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), lat: v.lat(), lng: v.lng(),
      inspected_at: v.datetime({ req: true }), notes: v.text(),
    },
    select: 't.*, f.name AS farm_name, p.name AS plot_name, u.name AS inspector_name',
    from: 'inspections t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id LEFT JOIN users u ON u.id = t.inspector_id',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id' }, dateCol: 't.inspected_at', search: ['t.notes', 'p.name'],
    order: 't.inspected_at DESC, t.id DESC', label: (r) => `${r.farm_name}${r.plot_name ? ' / ' + r.plot_name : ''}`,
    hooks: { extraInsert: (ctx) => ({ inspector_id: ctx.user.id }) },
  });

  // ---------- Pragas e doenças ----------
  crud(app, {
    base: '/api/occurrences', table: 'occurrences', module: 'occurrences', entity: 'ocorrência', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'),
      category: v.str({ enum: ['praga', 'doenca', 'daninha', 'deficiencia', 'outro'], default: 'praga' }),
      name: v.str({ req: true, max: 150 }),
      severity: v.str({ enum: SEVERITY, default: 'media' }),
      status: v.str({ enum: ['aberta', 'em_tratamento', 'resolvida'], default: 'aberta' }),
      lat: v.lat(), lng: v.lng(), observed_at: v.datetime({ req: true }),
      area_affected_ha: v.num({ min: 0, max: 1000000 }), description: v.text(),
    },
    select: 't.*, f.name AS farm_name, p.name AS plot_name, p.crop AS plot_crop, u.name AS created_by_name',
    from: 'occurrences t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id LEFT JOIN users u ON u.id = t.created_by',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id', category: 't.category', severity: 't.severity', status: 't.status', source: 't.source' },
    dateCol: 't.observed_at', search: ['t.name', 't.description', 'p.name'], order: 't.observed_at DESC, t.id DESC',
    hooks: { extraInsert: createdBy, afterSave: refreshAlerts },
  });

  // ---------- Máquinas ----------
  crud(app, {
    base: '/api/machines', table: 'machines', module: 'machines', entity: 'máquina', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms'), plot_id: v.ref('plots'), name: v.str({ req: true, max: 120 }),
      kind: v.str({ enum: ['trator', 'pulverizador', 'colheitadeira', 'plantadeira', 'caminhao', 'outro'], default: 'trator' }),
      brand: v.str({ max: 80 }), model: v.str({ max: 80 }), year: v.num({ int: true, min: 1950, max: 2100 }),
      identifier: v.str({ max: 80 }), hour_meter: v.num({ min: 0, max: 1000000, default: 0 }),
      status: v.str({ enum: ['disponivel', 'em_operacao', 'manutencao', 'inativo'], default: 'disponivel' }),
      last_lat: v.lat(), last_lng: v.lng(), last_position_at: v.datetime(), notes: v.text(),
    },
    select: `t.*, f.name AS farm_name, p.name AS plot_name,
      (SELECT COALESCE(SUM(o.hours),0) FROM machine_operations o WHERE o.machine_id = t.id AND o.op_date >= date('now','-30 day')) AS hours_30d,
      (SELECT COALESCE(SUM(o.hours),0) FROM machine_operations o WHERE o.machine_id = t.id) AS hours_logged,
      (SELECT COALESCE(SUM(x.liters),0) FROM machine_fuel x WHERE x.machine_id = t.id) AS fuel_liters,
      (SELECT COALESCE(SUM(x.cost),0) FROM machine_fuel x WHERE x.machine_id = t.id) AS fuel_cost,
      (SELECT COALESCE(SUM(m.cost),0) FROM machine_maintenance m WHERE m.machine_id = t.id) AS maintenance_cost,
      (SELECT m.next_due_date FROM machine_maintenance m WHERE m.machine_id = t.id AND m.status = 'concluida' AND m.next_due_date IS NOT NULL ORDER BY m.service_date DESC, m.id DESC LIMIT 1) AS next_due_date,
      (SELECT m.next_due_hours FROM machine_maintenance m WHERE m.machine_id = t.id AND m.status = 'concluida' AND m.next_due_hours IS NOT NULL ORDER BY m.service_date DESC, m.id DESC LIMIT 1) AS next_due_hours`,
    from: `machines t ${J('f')} LEFT JOIN plots p ON p.id = t.plot_id`,
    filters: { farm_id: 't.farm_id', kind: 't.kind', status: 't.status' }, search: ['t.name', 't.brand', 't.model', 't.identifier'],
    order: 't.name COLLATE NOCASE ASC',
  });

  crud(app, {
    base: '/api/machine-operations', table: 'machine_operations', module: 'machine_ops', entity: 'operação de máquina', farmCol: 't.farm_id',
    schema: {
      machine_id: v.ref('machines', { req: true }), farm_id: v.ref('farms'), plot_id: v.ref('plots'), operation: v.str({ req: true, max: 150 }),
      op_date: v.date({ req: true }), hours: v.num({ min: 0, max: 24 * 31, default: 0 }), hour_meter_end: v.num({ min: 0, max: 1000000 }),
      operator_name: v.str({ max: 120 }), notes: v.text(),
    },
    select: 't.*, m.name AS machine_name, f.name AS farm_name, p.name AS plot_name',
    from: `machine_operations t JOIN machines m ON m.id = t.machine_id ${J('f')} LEFT JOIN plots p ON p.id = t.plot_id`,
    filters: { machine_id: 't.machine_id', farm_id: 't.farm_id', plot_id: 't.plot_id' }, dateCol: 't.op_date', search: ['t.operation', 't.operator_name'],
    order: 't.op_date DESC, t.id DESC', label: (r) => `${r.operation} (${r.machine_name})`,
    parent: { col: 'machine_id', table: 'machines', inherit: 'default' },
    hooks: { afterSave: (ctx, row) => bumpHourMeter(row.machine_id, row.hour_meter_end) },
  });

  crud(app, {
    base: '/api/machine-fuel', table: 'machine_fuel', module: 'machine_ops', entity: 'abastecimento', farmCol: 't.farm_id',
    schema: {
      machine_id: v.ref('machines', { req: true }), fuel_date: v.date({ req: true }), liters: v.num({ req: true, min: 0, max: 100000 }),
      cost: v.num({ min: 0, max: 100000000, default: 0 }), hour_meter: v.num({ min: 0, max: 1000000 }), notes: v.text(),
    },
    select: 't.*, m.name AS machine_name', from: 'machine_fuel t JOIN machines m ON m.id = t.machine_id',
    filters: { machine_id: 't.machine_id', farm_id: 't.farm_id' }, dateCol: 't.fuel_date', order: 't.fuel_date DESC, t.id DESC',
    label: (r) => `${r.liters} L (${r.machine_name})`, parent: { col: 'machine_id', table: 'machines', inherit: 'always' },
    hooks: { afterSave: (ctx, row) => bumpHourMeter(row.machine_id, row.hour_meter) },
  });

  crud(app, {
    base: '/api/machine-maintenance', table: 'machine_maintenance', module: 'maintenance', entity: 'manutenção de máquina', farmCol: 't.farm_id',
    schema: {
      machine_id: v.ref('machines', { req: true }), kind: v.str({ enum: ['preventiva', 'corretiva'], default: 'preventiva' }),
      description: v.str({ req: true, max: 300 }), service_date: v.date({ req: true }), cost: v.num({ min: 0, max: 100000000, default: 0 }),
      hour_meter: v.num({ min: 0, max: 1000000 }), next_due_date: v.date(), next_due_hours: v.num({ min: 0, max: 1000000 }),
      status: v.str({ enum: ['agendada', 'concluida'], default: 'concluida' }),
    },
    select: 't.*, m.name AS machine_name', from: 'machine_maintenance t JOIN machines m ON m.id = t.machine_id',
    filters: { machine_id: 't.machine_id', farm_id: 't.farm_id', kind: 't.kind', status: 't.status' }, dateCol: 't.service_date',
    order: 't.service_date DESC, t.id DESC', label: (r) => `${r.description} (${r.machine_name})`,
    parent: { col: 'machine_id', table: 'machines', inherit: 'always' },
    hooks: {
      beforeSave: (ctx, data, existing) => dateOrder(data, existing, 'service_date', 'next_due_date', 'A próxima revisão deve ser posterior à data do serviço.'),
      afterSave: (ctx, row) => { if (row.status === 'concluida') bumpHourMeter(row.machine_id, row.hour_meter); refreshAlerts(ctx); },
    },
  });

  // ---------- Drones ----------
  crud(app, {
    base: '/api/drones', table: 'drones', module: 'drones', entity: 'drone', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms'), name: v.str({ req: true, max: 120 }), model: v.str({ max: 80 }), serial_number: v.str({ max: 80 }),
      capacity_l: v.num({ min: 0, max: 1000 }), flight_hours: v.num({ min: 0, max: 100000, default: 0 }),
      status: v.str({ enum: ['disponivel', 'em_missao', 'manutencao', 'inativo'], default: 'disponivel' }), notes: v.text(),
    },
    select: `t.*, f.name AS farm_name,
      (SELECT COUNT(*) FROM drone_missions m WHERE m.drone_id = t.id) AS missions_count,
      (SELECT COALESCE(SUM(m.flight_minutes),0) FROM drone_missions m WHERE m.drone_id = t.id AND m.status = 'concluida') / 60.0 AS mission_hours,
      (SELECT COALESCE(SUM(m.planned_area_ha),0) FROM drone_missions m WHERE m.drone_id = t.id AND m.status = 'concluida') AS planned_area_ha,
      (SELECT COALESCE(SUM(m.covered_area_ha),0) FROM drone_missions m WHERE m.drone_id = t.id AND m.status = 'concluida') AS covered_area_ha,
      (SELECT MAX(m.mission_date) FROM drone_missions m WHERE m.drone_id = t.id) AS last_mission_date,
      (SELECT COUNT(*) FROM drone_batteries b WHERE b.drone_id = t.id) AS battery_count`,
    from: `drones t ${J('f')}`, filters: { farm_id: 't.farm_id', status: 't.status' }, search: ['t.name', 't.model', 't.serial_number'],
    order: 't.name COLLATE NOCASE ASC',
  });

  crud(app, {
    base: '/api/drone-batteries', table: 'drone_batteries', module: 'drones', entity: 'bateria de drone', farmCol: 't.farm_id',
    schema: {
      drone_id: v.ref('drones', { req: true }), label: v.str({ req: true, max: 80 }), cycles: v.num({ int: true, min: 0, max: 100000, default: 0 }),
      health_pct: v.num({ min: 0, max: 100 }), status: v.str({ enum: ['ok', 'atencao', 'substituir'], default: 'ok' }),
    },
    select: 't.*, d.name AS drone_name', from: 'drone_batteries t JOIN drones d ON d.id = t.drone_id', filters: { drone_id: 't.drone_id' },
    order: 't.label COLLATE NOCASE', label: (r) => `${r.label} (${r.drone_name})`, parent: { col: 'drone_id', table: 'drones', inherit: 'always' },
  });

  crud(app, {
    base: '/api/drone-missions', table: 'drone_missions', module: 'missions', entity: 'missão de drone', farmCol: 't.farm_id',
    schema: {
      drone_id: v.ref('drones', { req: true }), farm_id: v.ref('farms'), plot_id: v.ref('plots'), name: v.str({ req: true, max: 150 }),
      mission_type: v.str({ enum: ['pulverizacao', 'mapeamento', 'inspecao', 'outro'], default: 'inspecao' }), mission_date: v.date({ req: true }),
      planned_area_ha: v.num({ min: 0, max: 1000000 }), covered_area_ha: v.num({ min: 0, max: 1000000 }), operator_name: v.str({ max: 120 }),
      flight_minutes: v.num({ min: 0, max: 100000 }), status: v.str({ enum: OP_STATUS, default: 'planejada' }),
      checklist: v.json({ max: 20000 }), report: v.text({ max: 20000 }),
    },
    select: 't.*, d.name AS drone_name, f.name AS farm_name, p.name AS plot_name',
    from: `drone_missions t JOIN drones d ON d.id = t.drone_id ${J('f')} LEFT JOIN plots p ON p.id = t.plot_id`,
    filters: { drone_id: 't.drone_id', farm_id: 't.farm_id', plot_id: 't.plot_id', status: 't.status', mission_type: 't.mission_type' },
    dateCol: 't.mission_date', search: ['t.name', 't.operator_name'], order: 't.mission_date DESC, t.id DESC', json: ['checklist'],
    parent: { col: 'drone_id', table: 'drones', inherit: 'default' },
    hooks: {
      beforeSave: (ctx, data, existing) => {
        const status = data.status !== undefined ? data.status : existing && existing.status;
        if (status === 'concluida') {
          let cl = data.checklist !== undefined ? data.checklist : existing && existing.checklist;
          if (typeof cl === 'string') { try { cl = JSON.parse(cl); } catch (_) { cl = null; } }
          const items = cl && Array.isArray(cl.items) ? cl.items : [];
          if (items.length && items.some((i) => !i.checked)) throw new HttpError(400, 'Dados inválidos.', { checklist: 'Conclua todos os itens do checklist pré-voo antes de finalizar a missão.' });
        }
      },
      afterSave: refreshAlerts,
    },
  });

  crud(app, {
    base: '/api/drone-maintenance', table: 'drone_maintenance', module: 'maintenance', entity: 'manutenção de drone', farmCol: 't.farm_id',
    schema: {
      drone_id: v.ref('drones', { req: true }), kind: v.str({ enum: ['inspecao', 'preventiva', 'corretiva'], default: 'inspecao' }),
      description: v.str({ req: true, max: 300 }), service_date: v.date({ req: true }), cost: v.num({ min: 0, max: 100000000, default: 0 }),
    },
    select: 't.*, d.name AS drone_name', from: 'drone_maintenance t JOIN drones d ON d.id = t.drone_id',
    filters: { drone_id: 't.drone_id', farm_id: 't.farm_id' }, dateCol: 't.service_date', order: 't.service_date DESC, t.id DESC',
    label: (r) => `${r.description} (${r.drone_name})`, parent: { col: 'drone_id', table: 'drones', inherit: 'always' },
  });

  // ---------- Pulverização ----------
  crud(app, {
    base: '/api/spray', table: 'spray_operations', module: 'spray', entity: 'pulverização', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), crop: v.str({ max: 80 }), op_date: v.date({ req: true }),
      planned_area_ha: v.num({ min: 0, max: 1000000 }), executed_area_ha: v.num({ min: 0, max: 1000000 }), product: v.str({ max: 150 }),
      volume_l: v.num({ min: 0, max: 100000000 }), input_qty: v.num({ min: 0, max: 100000000 }), input_unit: v.str({ max: 20 }),
      machine_id: v.ref('machines'), drone_id: v.ref('drones'), operator_name: v.str({ max: 120 }),
      status: v.str({ enum: OP_STATUS, default: 'planejada' }), cost: v.num({ min: 0, max: 100000000 }),
      geo_planned: v.json({ geo: true }), geo_executed: v.json({ geo: true }), notes: v.text(),
    },
    select: `t.*, f.name AS farm_name, p.name AS plot_name, m.name AS machine_name, d.name AS drone_name,
      CASE WHEN t.planned_area_ha > 0 AND t.executed_area_ha IS NOT NULL THEN ROUND(t.executed_area_ha * 100.0 / t.planned_area_ha, 1) END AS executed_pct`,
    from: 'spray_operations t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN drones d ON d.id = t.drone_id',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id', status: 't.status', machine_id: 't.machine_id', drone_id: 't.drone_id' },
    dateCol: 't.op_date', search: ['t.product', 't.operator_name', 'p.name', 't.crop'], order: 't.op_date DESC, t.id DESC', json: ['geo_planned', 'geo_executed'],
    label: (r) => `${r.product || 'pulverização'} em ${r.farm_name}${r.plot_name ? ' / ' + r.plot_name : ''}`,
    hooks: {
      beforeSave: (ctx, data, existing) => {
        const plotId = data.plot_id !== undefined ? data.plot_id : existing && existing.plot_id;
        const crop = data.crop !== undefined ? data.crop : existing && existing.crop;
        if (!crop && plotId) {
          const p = db.get('SELECT crop FROM plots WHERE id = ?', plotId);
          if (p && p.crop) data.crop = p.crop;
        }
        const status = data.status !== undefined ? data.status : existing && existing.status;
        const exec = data.executed_area_ha !== undefined ? data.executed_area_ha : existing && existing.executed_area_ha;
        if (status === 'concluida' && (exec === null || exec === undefined)) throw new HttpError(400, 'Dados inválidos.', { executed_area_ha: 'Informe a área executada para concluir a operação.' });
      },
      afterSave: refreshAlerts,
    },
  });

  // ---------- Custos, referências e produtividade ----------
  crud(app, {
    base: '/api/costs', table: 'costs', module: 'costs', entity: 'custo', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), category: v.str({ req: true, enum: COST_CATEGORIES }),
      description: v.str({ req: true, max: 200 }), amount: v.num({ req: true, min: 0, max: 1000000000 }), cost_date: v.date({ req: true }),
      area_ha: v.num({ min: 0, max: 1000000 }), spray_id: v.ref('spray_operations'), machine_id: v.ref('machines'), notes: v.text(),
    },
    select: 't.*, f.name AS farm_name, p.name AS plot_name', from: 'costs t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id', category: 't.category' }, dateCol: 't.cost_date', search: ['t.description'],
    order: 't.cost_date DESC, t.id DESC', label: (r) => `${r.description} (R$ ${Number(r.amount).toFixed(2)})`,
  });

  crud(app, {
    base: '/api/cost-references', table: 'cost_references', module: 'costs', entity: 'custo de referência', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms'), category: v.str({ enum: COST_CATEGORIES }), label: v.str({ req: true, max: 150 }),
      cost_per_ha: v.num({ req: true, min: 0.01, max: 100000000 }), valid_from: v.date(), notes: v.text(),
    },
    select: 't.*, f.name AS farm_name', from: `cost_references t ${J('f')}`, filters: { farm_id: 't.farm_id', category: 't.category' },
    order: 't.label COLLATE NOCASE', label: (r) => r.label,
  });

  crud(app, {
    base: '/api/harvests', table: 'harvests', module: 'costs', entity: 'colheita', farmCol: 't.farm_id',
    schema: {
      farm_id: v.ref('farms', { req: true }), plot_id: v.ref('plots'), season: v.str({ req: true, max: 20 }), crop: v.str({ max: 80 }),
      area_ha: v.num({ min: 0.01, max: 1000000 }), quantity: v.num({ min: 0, max: 1000000000 }),
      unit: v.str({ enum: ['sc', 'kg', 't', '@', 'cx'], default: 'sc' }), revenue: v.num({ min: 0, max: 1000000000 }), harvest_date: v.date(), notes: v.text(),
    },
    select: `t.*, f.name AS farm_name, p.name AS plot_name,
      COALESCE(t.area_ha, p.area_ha) AS effective_area_ha,
      CASE WHEN COALESCE(t.area_ha, p.area_ha) > 0 AND t.quantity IS NOT NULL THEN ROUND(t.quantity / COALESCE(t.area_ha, p.area_ha), 2) END AS productivity`,
    from: 'harvests t JOIN farms f ON f.id = t.farm_id LEFT JOIN plots p ON p.id = t.plot_id',
    filters: { farm_id: 't.farm_id', plot_id: 't.plot_id', season: 't.season', crop: 't.crop' }, dateCol: 't.harvest_date', search: ['t.crop', 't.season'],
    order: 't.season DESC, t.id DESC', label: (r) => `${r.crop || 'colheita'} ${r.season}`,
    hooks: {
      beforeSave: (ctx, data, existing) => {
        const plotId = data.plot_id !== undefined ? data.plot_id : existing && existing.plot_id;
        const crop = data.crop !== undefined ? data.crop : existing && existing.crop;
        if (!crop && plotId) { const p = db.get('SELECT crop FROM plots WHERE id = ?', plotId); if (p && p.crop) data.crop = p.crop; }
      },
    },
  });
};

module.exports.COST_CATEGORIES = COST_CATEGORIES;
