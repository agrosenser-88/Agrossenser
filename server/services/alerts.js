'use strict';
// Geração de alertas/notificações a partir dos dados reais cadastrados (nada é inventado).
const db = require('../lib/db');
const config = require('../config');

const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function upsert(orgId, n) {
  db.run(
    `INSERT INTO notifications (org_id, farm_id, user_id, category, severity, title, body, link, dedup_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(org_id, dedup_key) DO UPDATE SET resolved_at = NULL, severity = excluded.severity, title = excluded.title, body = excluded.body`,
    orgId, n.farm_id || null, n.user_id || null, n.category, n.severity || 'info', n.title, n.body || null, n.link || null, n.key, nowIso(),
  );
}

// Mantém sincronizado um conjunto de alertas "de estado": o que deixou de valer é marcado como resolvido.
function sync(orgId, prefix, items) {
  for (const it of items) upsert(orgId, it);
  const keys = items.map((i) => i.key);
  const like = prefix + '%';
  if (!keys.length) {
    db.run('UPDATE notifications SET resolved_at = ? WHERE org_id = ? AND dedup_key LIKE ? AND resolved_at IS NULL', nowIso(), orgId, like);
    return;
  }
  const marks = keys.map(() => '?').join(',');
  db.run(
    `UPDATE notifications SET resolved_at = ? WHERE org_id = ? AND dedup_key LIKE ? AND resolved_at IS NULL AND dedup_key NOT IN (${marks})`,
    nowIso(), orgId, like, ...keys,
  );
}

const lastRefresh = new Map();
// Qualquer escrita auditada invalida o intervalo mínimo, para os alertas refletirem o cadastro na hora.
function invalidate(orgId) { lastRefresh.delete(orgId); }

function refreshOrg(orgId, { force = false } = {}) {
  const last = lastRefresh.get(orgId) || 0;
  if (!force && Date.now() - last < 15000) return;
  lastRefresh.set(orgId, Date.now());
  const today = todayStr();
  const soon = addDays(today, 7);

  // Pragas e doenças graves em aberto
  const occ = db.all(
    `SELECT o.id, o.farm_id, o.name, o.severity, o.status, f.name AS farm_name, p.name AS plot_name
       FROM occurrences o JOIN farms f ON f.id = o.farm_id LEFT JOIN plots p ON p.id = o.plot_id
      WHERE o.org_id = ? AND o.status <> 'resolvida' AND o.severity IN ('alta','critica')`, orgId);
  sync(orgId, 'occ:', occ.map((o) => ({
    key: `occ:${o.id}`, farm_id: o.farm_id, category: 'praga', severity: o.severity === 'critica' ? 'critico' : 'atencao',
    title: `Ocorrência ${o.severity === 'critica' ? 'crítica' : 'grave'}: ${o.name}`,
    body: `${o.farm_name}${o.plot_name ? ' / ' + o.plot_name : ''} — situação: ${o.status === 'aberta' ? 'em aberto' : 'em tratamento'}.`, link: '#/pragas',
  })));

  // Manutenções próximas ou vencidas (última revisão com próxima data/horímetro + serviços agendados)
  const maint = [];
  const machines = db.all('SELECT id, farm_id, name, hour_meter FROM machines WHERE org_id = ? AND status <> \'inativo\'', orgId);
  for (const m of machines) {
    const last = db.get(
      `SELECT next_due_date, next_due_hours FROM machine_maintenance
        WHERE machine_id = ? AND status = 'concluida' AND (next_due_date IS NOT NULL OR next_due_hours IS NOT NULL)
        ORDER BY service_date DESC, id DESC LIMIT 1`, m.id);
    if (last && last.next_due_date && last.next_due_date <= soon) {
      const overdue = last.next_due_date < today;
      maint.push({
        key: `maint:${m.id}:d:${last.next_due_date}`, farm_id: m.farm_id, category: 'manutencao', severity: overdue ? 'critico' : 'atencao',
        title: overdue ? `Revisão vencida: ${m.name}` : `Revisão próxima: ${m.name}`,
        body: `Próxima revisão prevista para ${last.next_due_date.split('-').reverse().join('/')}.`, link: '#/maquinas',
      });
    }
    if (last && last.next_due_hours && m.hour_meter >= last.next_due_hours - 20) {
      const overdue = m.hour_meter >= last.next_due_hours;
      maint.push({
        key: `maint:${m.id}:h:${last.next_due_hours}`, farm_id: m.farm_id, category: 'manutencao', severity: overdue ? 'critico' : 'atencao',
        title: overdue ? `Revisão por horímetro vencida: ${m.name}` : `Revisão por horímetro próxima: ${m.name}`,
        body: `Horímetro atual ${m.hour_meter} h; revisão prevista em ${last.next_due_hours} h.`, link: '#/maquinas',
      });
    }
    const sched = db.all("SELECT id, description, service_date FROM machine_maintenance WHERE machine_id = ? AND status = 'agendada' AND service_date <= ?", m.id, soon);
    for (const s of sched) {
      maint.push({
        key: `maint:${m.id}:s:${s.id}`, farm_id: m.farm_id, category: 'manutencao', severity: s.service_date < today ? 'critico' : 'atencao',
        title: `${s.service_date < today ? 'Manutenção agendada em atraso' : 'Manutenção agendada'}: ${m.name}`,
        body: `${s.description} — ${s.service_date.split('-').reverse().join('/')}.`, link: '#/maquinas',
      });
    }
  }
  sync(orgId, 'maint:', maint);

  // Operações atrasadas (pulverizações e missões)
  const overdue = [];
  for (const s of db.all("SELECT s.id, s.farm_id, s.op_date, s.product, f.name AS farm_name FROM spray_operations s JOIN farms f ON f.id = s.farm_id WHERE s.org_id = ? AND s.status IN ('planejada','em_andamento') AND s.op_date < ?", orgId, today)) {
    overdue.push({ key: `overdue:spray:${s.id}`, farm_id: s.farm_id, category: 'operacao', severity: 'atencao', title: `Pulverização atrasada em ${s.farm_name}`, body: `Prevista para ${s.op_date.split('-').reverse().join('/')}${s.product ? ' (' + s.product + ')' : ''} e ainda não concluída.`, link: '#/pulverizacao' });
  }
  for (const m of db.all("SELECT m.id, m.farm_id, m.name, m.mission_date FROM drone_missions m WHERE m.org_id = ? AND m.status IN ('planejada','em_andamento') AND m.mission_date < ?", orgId, today)) {
    overdue.push({ key: `overdue:mission:${m.id}`, farm_id: m.farm_id, category: 'operacao', severity: 'atencao', title: `Missão de drone atrasada: ${m.name}`, body: `Prevista para ${m.mission_date.split('-').reverse().join('/')} e ainda não concluída.`, link: '#/drones' });
  }
  sync(orgId, 'overdue:', overdue);

  // Tarefas pendentes (operações planejadas para hoje/amanhã)
  const tasks = [];
  const tomorrow = addDays(today, 1);
  for (const s of db.all("SELECT s.id, s.farm_id, s.op_date, s.product, f.name AS farm_name FROM spray_operations s JOIN farms f ON f.id = s.farm_id WHERE s.org_id = ? AND s.status = 'planejada' AND s.op_date BETWEEN ? AND ?", orgId, today, tomorrow)) {
    tasks.push({ key: `task:spray:${s.id}`, farm_id: s.farm_id, category: 'tarefa', severity: 'info', title: `Pulverização planejada ${s.op_date === today ? 'para hoje' : 'para amanhã'} em ${s.farm_name}`, body: s.product || null, link: '#/pulverizacao' });
  }
  for (const m of db.all("SELECT m.id, m.farm_id, m.name, m.mission_date FROM drone_missions m WHERE m.org_id = ? AND m.status = 'planejada' AND m.mission_date BETWEEN ? AND ?", orgId, today, tomorrow)) {
    tasks.push({ key: `task:mission:${m.id}`, farm_id: m.farm_id, category: 'tarefa', severity: 'info', title: `Missão de drone ${m.mission_date === today ? 'hoje' : 'amanhã'}: ${m.name}`, link: '#/drones' });
  }
  sync(orgId, 'task:', tasks);

  // Sensores sem comunicação há mais de 24 h (somente leituras reais)
  const limit = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  db.run("UPDATE sensors SET status = 'offline' WHERE org_id = ? AND status = 'online' AND last_reading_at < ?", orgId, limit);
  const off = db.all("SELECT s.id, s.farm_id, s.name, s.last_reading_at FROM sensors s WHERE s.org_id = ? AND s.status = 'offline'", orgId);
  sync(orgId, 'sensoroff:', off.map((s) => ({
    key: `sensoroff:${s.id}`, farm_id: s.farm_id, category: 'sensor', severity: 'atencao', title: `Sensor sem comunicação: ${s.name}`,
    body: `Última leitura real em ${new Date(s.last_reading_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`, link: `#/sensores`,
  })));

  // Alerta administrativo: senha inicial ainda em uso
  for (const u of db.all("SELECT id, username FROM users WHERE org_id = ? AND must_change_password = 1 AND active = 1 AND role = 'admin'", orgId)) {
    upsert(orgId, {
      key: `default-password:${u.id}`, user_id: u.id, category: 'admin', severity: 'atencao', title: 'Altere a senha inicial',
      body: `O usuário ${u.username} ainda usa a senha inicial. Troque-a em Configurações > Segurança.`, link: '#/configuracoes',
    });
  }
}

// Alertas meteorológicos (eventos, não resolvem automaticamente). Chamado quando a previsão é obtida.
function weatherAlertsFor(daily) {
  const out = [];
  for (const d of daily.slice(0, 3)) {
    const label = d.date.split('-').reverse().join('/');
    if (d.precip_sum !== null && d.precip_sum >= 20) out.push({ type: 'chuva_forte', level: 'atencao', date: d.date, title: `Chuva forte prevista (${d.precip_sum.toFixed(0)} mm) em ${label}`, detail: 'Pode comprometer operações de campo e aplicações.' });
    else if (d.precip_prob !== null && d.precip_prob >= 70 && (d.precip_sum || 0) >= 5) out.push({ type: 'chuva', level: 'info', date: d.date, title: `Alta chance de chuva em ${label} (${d.precip_prob}%)`, detail: 'Considere reprogramar aplicações.' });
    if (d.wind_max !== null && d.wind_max >= 20) out.push({ type: 'vento_forte', level: 'atencao', date: d.date, title: `Vento forte previsto (${d.wind_max.toFixed(0)} km/h) em ${label}`, detail: 'Evite pulverização; risco de deriva. Siga a recomendação técnica do produto.' });
    else if (d.wind_max !== null && d.wind_max >= 15) out.push({ type: 'vento', level: 'info', date: d.date, title: `Vento acima do ideal para pulverização em ${label} (${d.wind_max.toFixed(0)} km/h)`, detail: 'Referência geral; valide com o responsável técnico.' });
    if (d.tmax !== null && d.tmax >= 35) out.push({ type: 'calor', level: 'atencao', date: d.date, title: `Calor intenso previsto (${d.tmax.toFixed(0)} °C) em ${label}`, detail: 'Condição desfavorável para aplicações e para o trabalho em campo.' });
    if (d.tmin !== null && d.tmin <= 3) out.push({ type: 'frio', level: 'atencao', date: d.date, title: `Risco de geada/frio intenso (${d.tmin.toFixed(0)} °C) em ${label}`, detail: 'Avalie a sensibilidade da cultura.' });
  }
  return out;
}

function saveWeatherAlerts(orgId, farm, daily) {
  for (const a of weatherAlertsFor(daily)) {
    upsert(orgId, {
      key: `weather:${farm.id}:${a.date}:${a.type}`, farm_id: farm.id, category: 'clima', severity: a.level === 'info' ? 'info' : 'atencao',
      title: `${a.title} — ${farm.name}`, body: a.detail, link: '#/clima',
    });
  }
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const run = async () => {
    try {
      const orgs = db.all('SELECT id FROM organizations');
      for (const o of orgs) {
        refreshOrg(o.id, { force: true });
        try { await require('./weather').refreshOrgWeather(o.id); } catch (e) { console.error('[clima]', e.message); }
      }
    } catch (e) { console.error('[alertas] falha:', e.message); }
  };
  timer = setInterval(run, Math.max(1, config.alertsIntervalMinutes) * 60000);
  timer.unref();
  setTimeout(run, 5000).unref();
}

module.exports = { invalidate, refreshOrg, startScheduler, upsert, weatherAlertsFor, saveWeatherAlerts };
