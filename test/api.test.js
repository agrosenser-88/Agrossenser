'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers');

const { Client, PNG, multipart } = T;
let admin; let farmId; let plotId;
const POLY = { type: 'Polygon', coordinates: [[[-47.9, -15.8], [-47.89, -15.8], [-47.89, -15.79], [-47.9, -15.79], [-47.9, -15.8]]] };

before(async () => { await T.start(); admin = new Client(); });
after(async () => { await T.stop(); });

test('login: credenciais iniciais admin/admin123 funcionam e a senha não é guardada em texto puro', async () => {
  const u = await admin.login('admin', 'admin123');
  assert.equal(u.role, 'admin');
  const row = T.db.get("SELECT password_hash FROM users WHERE username = 'admin'");
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes('admin123'));
});

test('login inválido, CSRF e rotas privadas protegidas', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'errada' })).status, 401);
  assert.equal((await c.get('/api/farms')).status, 401);
  assert.equal((await new Client().req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, csrf: false })).status, 403);
  const fake = new Client(); fake.cookie = 'agro_sid=token-inventado';
  assert.equal((await fake.get('/api/farms')).status, 401);
});

test('fazenda: validação, criação, edição, consulta e talhão com limites', async () => {
  let r = await admin.post('/api/farms', { name: '' });
  assert.equal(r.status, 400); assert.ok(r.data.details.name);
  r = await admin.post('/api/farms', { name: 'Fazenda Boa Vista', owner_name: 'João', city: 'Rio Verde', state: 'GO', area_ha: 500, latitude: -17.79, longitude: -50.92 });
  assert.equal(r.status, 201); farmId = r.data.id;
  assert.equal((await admin.post('/api/farms', { name: 'X', state: 'ZZ' })).status, 400);
  assert.equal((await admin.post('/api/farms', { name: 'X', latitude: 200 })).status, 400);
  r = await admin.put(`/api/farms/${farmId}`, { notes: 'Sede próxima à rodovia' });
  assert.equal(r.data.notes, 'Sede próxima à rodovia');
  r = await admin.post('/api/plots', { farm_id: farmId, name: 'Talhão 1', crop: 'Soja', variety: 'M6410', area_ha: 120, season: '2025/26', planting_date: '2025-10-10', harvest_forecast: '2026-02-15', boundary: POLY });
  assert.equal(r.status, 201); plotId = r.data.id;
  assert.deepEqual(r.data.boundary, POLY);
  assert.equal((await admin.post('/api/plots', { farm_id: farmId, name: 'T2', planting_date: '2025-10-10', harvest_forecast: '2025-01-01' })).status, 400);
  assert.equal((await admin.post('/api/plots', { farm_id: farmId, name: 'T3', boundary: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } })).status, 400);
  assert.equal((await admin.post('/api/plots', { farm_id: 99999, name: 'T4' })).status, 400);
  r = await admin.get(`/api/farms/${farmId}`);
  assert.equal(r.data.plot_count, 1);
});

test('isolamento entre organizações', async () => {
  await T.secondOrg();
  const other = new Client(); await other.login('outro', 'outra12345');
  assert.deepEqual((await other.get('/api/farms')).data, []);
  assert.equal((await other.get(`/api/farms/${farmId}`)).status, 404);
  assert.equal((await other.put(`/api/farms/${farmId}`, { name: 'Invadida' })).status, 404);
  assert.equal((await other.del(`/api/plots/${plotId}`)).status, 404);
  assert.equal((await other.post('/api/occurrences', { farm_id: farmId, name: 'x', observed_at: new Date().toISOString() })).status, 400);
  assert.equal((await other.get('/api/users')).data.length, 1);
  const f = await other.post('/api/farms', { name: 'Fazenda do outro' });
  assert.equal(f.status, 201);
  assert.equal((await admin.get(`/api/farms/${f.data.id}`)).status, 404);
});

test('permissões por perfil', async () => {
  const op = await T.makeUser(admin, { username: 'operador1', name: 'Operador', role: 'operador', password: 'senha12345' });
  await T.makeUser(admin, { username: 'viewer1', name: 'Visualizador', role: 'visualizador', password: 'senha12345' });
  await T.makeUser(admin, { username: 'agro1', name: 'Agrônomo', role: 'agronomo', password: 'senha12345' });
  assert.ok(op.id);
  const v = new Client(); await v.login('viewer1', 'senha12345');
  assert.equal((await v.get('/api/farms')).status, 200);
  assert.equal((await v.post('/api/farms', { name: 'Nova' })).status, 403);
  assert.equal((await v.post('/api/occurrences', { farm_id: farmId, name: 'x', observed_at: new Date().toISOString() })).status, 403);
  assert.equal((await v.get('/api/users')).status, 403);
  assert.equal((await v.get('/api/audit')).status, 403);
  const o = new Client(); await o.login('operador1', 'senha12345');
  assert.equal((await o.get('/api/costs')).status, 403);
  assert.equal((await o.get('/api/reports')).status, 403);
  assert.equal((await o.post('/api/plots', { farm_id: farmId, name: 'Proibido' })).status, 403);
  assert.equal((await o.post('/api/occurrences', { farm_id: farmId, name: 'Lagarta', observed_at: new Date().toISOString() })).status, 201);
  const a = new Client(); await a.login('agro1', 'senha12345');
  assert.equal((await a.post('/api/plots', { farm_id: farmId, name: 'Talhão do agrônomo' })).status, 201);
  assert.equal((await a.post('/api/farms', { name: 'Não pode' })).status, 403);
  assert.equal((await a.get('/api/settings')).status, 403);
});

test('usuário restrito a uma fazenda só enxerga ela', async () => {
  const f2 = await admin.post('/api/farms', { name: 'Fazenda Segunda' });
  await T.makeUser(admin, { username: 'gestor1', name: 'Gestor', role: 'gestor', password: 'senha12345', farm_ids: [farmId] });
  const g = new Client(); await g.login('gestor1', 'senha12345');
  const farms = (await g.get('/api/farms')).data;
  assert.equal(farms.length, 1); assert.equal(farms[0].id, farmId);
  assert.equal((await g.get(`/api/farms/${f2.data.id}`)).status, 404);
  assert.equal((await g.post('/api/occurrences', { farm_id: f2.data.id, name: 'x', observed_at: new Date().toISOString() })).status, 400);
  assert.equal((await g.post('/api/farms', { name: 'Nova' })).status, 403);
});

test('ocorrências geram alertas, filtros e resolução', async () => {
  const r = await admin.post('/api/occurrences', { farm_id: farmId, plot_id: plotId, category: 'praga', name: 'Percevejo-marrom', severity: 'critica', lat: -15.795, lng: -47.895, observed_at: new Date().toISOString(), area_affected_ha: 12.5 });
  assert.equal(r.status, 201);
  assert.equal((await admin.post('/api/occurrences', { farm_id: farmId, name: 'X', severity: 'enorme', observed_at: new Date().toISOString() })).status, 400);
  assert.equal((await admin.post('/api/occurrences', { farm_id: farmId, name: 'X', lat: 123, observed_at: new Date().toISOString() })).status, 400);
  const list = (await admin.get('/api/occurrences?severity=critica')).data;
  assert.equal(list.length, 1);
  const n = (await admin.get('/api/notifications')).data;
  assert.ok(n.some((x) => x.category === 'praga' && x.severity === 'critico'));
  assert.ok((await admin.get('/api/notifications/count')).data.unread >= 1);
  await admin.put(`/api/occurrences/${r.data.id}`, { status: 'resolvida' });
  const hist = (await admin.get('/api/notifications?history=1')).data;
  assert.ok(hist.some((x) => x.title.includes('Percevejo')));
  const id = n.find((x) => x.category === 'praga') && n[0].id;
  assert.equal((await admin.post(`/api/notifications/${id}/read`, {})).status, 200);
  const map = (await admin.get('/api/map')).data;
  assert.equal(map.plots.length >= 1, true); assert.ok(map.occurrences.length >= 1);
});

test('máquinas: operações atualizam horímetro e manutenção vencida gera alerta', async () => {
  const m = (await admin.post('/api/machines', { name: 'Trator 01', kind: 'trator', brand: 'John Deere', year: 2020, hour_meter: 100, farm_id: farmId })).data;
  assert.equal((await admin.post('/api/machines', { name: 'Ruim', year: 1800 })).status, 400);
  const op = await admin.post('/api/machine-operations', { machine_id: m.id, operation: 'Gradagem', op_date: '2026-01-10', hours: 6.5, hour_meter_end: 120 });
  assert.equal(op.status, 201); assert.equal(op.data.farm_id, farmId);
  assert.equal((await admin.get(`/api/machines/${m.id}`)).data.hour_meter, 120);
  assert.equal((await admin.post('/api/machine-fuel', { machine_id: m.id, fuel_date: '2026-01-10', liters: 80, cost: 480 })).status, 201);
  assert.equal((await admin.post('/api/machine-fuel', { machine_id: m.id, fuel_date: '2026-01-10', liters: -5 })).status, 400);
  assert.equal((await admin.post('/api/machine-maintenance', { machine_id: m.id, description: 'Troca de óleo', service_date: '2026-01-01', next_due_date: '2025-12-01' })).status, 400);
  assert.equal((await admin.post('/api/machine-maintenance', { machine_id: m.id, description: 'Troca de óleo', service_date: '2025-06-01', cost: 900, next_due_date: '2025-12-01' })).status, 201);
  const card = (await admin.get('/api/machines')).data.find((x) => x.id === m.id);
  assert.equal(card.hours_logged, 6.5); assert.equal(card.fuel_cost, 480); assert.equal(card.maintenance_cost, 900); assert.equal(card.next_due_date, '2025-12-01');
  const n = (await admin.get('/api/notifications')).data;
  assert.ok(n.some((x) => x.category === 'manutencao' && x.title.startsWith('Revisão vencida')));
  assert.equal((await admin.del(`/api/machines/${m.id}`)).status, 200);
  assert.equal((await admin.get('/api/machine-operations')).data.length, 0);
});

test('drones: checklist pré-voo é exigido para concluir missão', async () => {
  const d = (await admin.post('/api/drones', { name: 'Drone 1', model: 'T40', capacity_l: 40, farm_id: farmId })).data;
  const base = { drone_id: d.id, name: 'Pulverização T1', mission_type: 'pulverizacao', mission_date: '2026-02-01', planned_area_ha: 50, covered_area_ha: 48, flight_minutes: 90, operator_name: 'Carlos', status: 'concluida' };
  assert.equal((await admin.post('/api/drone-missions', { ...base, checklist: { items: [{ label: 'a', checked: true }, { label: 'b', checked: false }] } })).status, 400);
  const ok = await admin.post('/api/drone-missions', { ...base, checklist: { items: [{ label: 'a', checked: true }, { label: 'b', checked: true }] } });
  assert.equal(ok.status, 201); assert.equal(ok.data.checklist.items.length, 2);
  assert.equal((await admin.post('/api/drone-batteries', { drone_id: d.id, label: 'Bat A', cycles: 40, health_pct: 150 })).status, 400);
  assert.equal((await admin.post('/api/drone-batteries', { drone_id: d.id, label: 'Bat A', cycles: 40, health_pct: 92 })).status, 201);
  const card = (await admin.get('/api/drones')).data[0];
  assert.equal(card.missions_count, 1); assert.equal(card.covered_area_ha, 48); assert.equal(card.mission_hours, 1.5);
});

test('pulverização: conclusão exige área executada; percentual e relatório', async () => {
  const b = { farm_id: farmId, plot_id: plotId, op_date: '2026-03-01', planned_area_ha: 100, product: 'Produto X', volume_l: 2000, input_qty: 50, input_unit: 'L', operator_name: 'Maria', geo_planned: POLY };
  assert.equal((await admin.post('/api/spray', { ...b, status: 'concluida' })).status, 400);
  const s = await admin.post('/api/spray', { ...b, status: 'concluida', executed_area_ha: 80 });
  assert.equal(s.status, 201); assert.equal(s.data.executed_pct, 80); assert.equal(s.data.crop, 'Soja');
  assert.deepEqual(s.data.geo_planned, POLY);
  assert.equal((await admin.post('/api/spray', { ...b, geo_planned: { type: 'Polygon', coordinates: [] } })).status, 400);
  const rep = (await admin.get('/api/reports/pulverizacao')).data;
  assert.equal(rep.rows.length, 1); assert.ok(rep.summary.find((x) => x.label === 'Execução').value.startsWith('80'));
  const ins = (await admin.get('/api/reports/insumos')).data;
  assert.equal(ins.rows[0][3], '50'); // quantidade total
});

test('custos, produtividade e economia: fórmula e dados insuficientes', async () => {
  await admin.post('/api/cost-references', { label: 'Referência geral', cost_per_ha: 500 });
  let e = (await admin.get(`/api/economy?farm_id=${farmId}`)).data;
  assert.equal(e.comparisons[0].savings_pct, null);         // sem custos: não calcula
  assert.match(e.comparisons[0].note, /insuficientes/);
  assert.equal((await admin.post('/api/costs', { farm_id: farmId, category: 'insumos', description: 'Fertilizante', amount: 30000, cost_date: '2026-01-15' })).status, 201);
  assert.equal((await admin.post('/api/costs', { farm_id: farmId, category: 'combustivel', description: 'Diesel', amount: 10000, cost_date: '2026-02-15' })).status, 201);
  assert.equal((await admin.post('/api/costs', { farm_id: farmId, category: 'outros', description: 'Negativo', amount: -1, cost_date: '2026-02-15' })).status, 400);
  e = (await admin.get(`/api/economy?farm_id=${farmId}`)).data;
  // área = 120 ha (apenas talhão 1 tem área); custo 40.000 -> 333,33 R$/ha
  assert.equal(e.area_ha, 120); assert.equal(e.total, 40000); assert.equal(e.per_ha, 333.33);
  // Economia (%) = ((500 - 333,33) / 500) * 100 = 33,3
  assert.equal(e.comparisons[0].savings_pct, 33.3);
  assert.equal(e.comparisons[0].savings_total, 20000);
  const period = (await admin.get(`/api/economy?farm_id=${farmId}&from=2026-02-01&to=2026-02-28`)).data;
  assert.equal(period.total, 10000);
  await admin.post('/api/harvests', { farm_id: farmId, plot_id: plotId, season: '2025/26', quantity: 7200, unit: 'sc', revenue: 1000000 });
  const prod = (await admin.get('/api/reports/produtividade')).data;
  assert.equal(prod.rows[0][7], '60 sc/ha');
  const dash = (await admin.get(`/api/dashboard?farm_id=${farmId}`)).data;
  assert.equal(dash.costs.total, 40000); assert.equal(dash.costs.per_ha, 333.33); assert.equal(dash.production[0].productivity, 60);
  assert.equal(dash.empty, false);
});

test('relatórios: filtros, CSV (anti-injeção), PDF e comparativo', async () => {
  const filtered = (await admin.get('/api/reports/custos?category=x&from=2026-02-01&to=2026-02-28')).data;
  assert.equal(filtered.rows.length, 1);
  await admin.post('/api/costs', { farm_id: farmId, category: 'outros', description: '=HYPERLINK("http://x")', amount: 1, cost_date: '2026-02-20' });
  const csv = await admin.get('/api/reports/custos?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const txt = csv.data.toString('utf8');
  assert.ok(txt.startsWith('﻿'));
  assert.ok(txt.includes("'=HYPERLINK"));
  const pdf = await admin.get('/api/reports/ocorrencias?format=pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.data.slice(0, 5).toString(), '%PDF-'); assert.ok(pdf.data.slice(-6).toString().includes('%%EOF'));
  const cmp = (await admin.get('/api/reports/comparativo?a_from=2026-01-01&a_to=2026-01-31&b_from=2026-02-01&b_to=2026-02-28')).data;
  const custos = cmp.rows.find((r) => r[0] === 'Custos totais');
  assert.ok(custos[1].includes('30.000,00')); assert.ok(custos[2].includes('10.001,00') || custos[2].includes('10.000'));
  assert.equal((await admin.get('/api/reports/comparativo')).status, 400);
  assert.equal((await admin.get('/api/reports/inexistente')).status, 404);
  for (const k of ['ocorrencias', 'evolucao', 'pulverizacao', 'maquinas', 'drones', 'sensores', 'insumos', 'custos', 'produtividade', 'economia']) {
    const r = await admin.get(`/api/reports/${k}`); assert.equal(r.status, 200, k); assert.ok(Array.isArray(r.data.rows), k);
  }
});

test('sensores: aguardando conexão, ingestão real, demonstração separada e alertas', async () => {
  const s = (await admin.post('/api/sensors', { farm_id: farmId, plot_id: plotId, name: 'Umidade T1', kind: 'umidade_solo', min_limit: 20, max_limit: 60 })).data;
  assert.equal(s.status, 'aguardando'); assert.ok(s.api_key.startsWith('sk_')); assert.equal(s.key_hash, undefined);
  const listed = (await admin.get('/api/sensors')).data[0];
  assert.equal(listed.key_hash, undefined); assert.equal(listed.real_readings, 0); assert.equal(listed.unit, '%');
  assert.equal((await new Client().post(`/api/ingest/${s.device_id}`, { value: 30 }, { headers: { 'x-device-key': 'errada' } })).status, 401);
  await admin.post(`/api/sensors/${s.id}/demo-readings`, { count: 10 });
  let l = (await admin.get('/api/sensors')).data[0];
  assert.equal(l.status, 'aguardando'); assert.equal(l.demo_readings, 10); assert.equal(l.last_value, null);
  assert.equal((await admin.get('/api/reports/sensores')).data.rows.length, 0);
  const dev = new Client();
  assert.equal((await dev.post(`/api/ingest/${s.device_id}`, { value: 'abc' }, { headers: { 'x-device-key': s.api_key } })).status, 400);
  assert.equal((await dev.post(`/api/ingest/${s.device_id}`, { value: 35.5 }, { headers: { 'x-device-key': s.api_key } })).status, 201);
  l = (await admin.get('/api/sensors')).data[0];
  assert.equal(l.status, 'online'); assert.equal(l.last_value, 35.5); assert.equal(l.real_readings, 1);
  assert.equal((await dev.post(`/api/ingest/${s.device_id}`, { value: 12 }, { headers: { authorization: `Bearer ${s.api_key}` } })).status, 201);
  const n = (await admin.get('/api/notifications')).data;
  assert.ok(n.some((x) => x.category === 'sensor' && x.title.includes('abaixo do mínimo')));
  const rd = (await admin.get(`/api/sensors/${s.id}/readings?demo=0`)).data;
  assert.equal(rd.readings.length, 2); assert.ok(rd.readings.every((r) => r.is_demo === 0));
  assert.equal((await admin.get('/api/reports/sensores')).data.rows.length, 1);
  const rot = (await admin.post(`/api/sensors/${s.id}/rotate-key`)).data;
  assert.equal((await dev.post(`/api/ingest/${s.device_id}`, { value: 40 }, { headers: { 'x-device-key': s.api_key } })).status, 401);
  assert.equal((await dev.post(`/api/ingest/${s.device_id}`, { value: 40 }, { headers: { 'x-device-key': rot.api_key } })).status, 201);
});

test('AgroSensor IA: sem serviço configurado, informa indisponibilidade e salva histórico (sem resposta inventada)', async () => {
  const st = (await admin.get('/api/ia/status')).data; assert.equal(st.configured, false);
  const r = await admin.req('POST', '/api/ia/analyses', { form: multipart({ farm_id: farmId, plot_id: plotId, symptoms: 'Manchas amarelas' }, { field: 'image', data: PNG, type: 'image/png', name: 'folha.png' }) });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'indisponivel'); assert.equal(r.data.result, null);
  assert.match(r.data.message, /ainda não foi configurada/); assert.equal(r.data.crop, 'Soja'); assert.equal(r.data.images.length, 1);
  const img = await admin.get(`/api/files/${r.data.images[0].id}/download`);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  const noImg = await admin.req('POST', '/api/ia/analyses', { form: multipart({ farm_id: farmId }) });
  assert.equal(noImg.status, 400);
  const fake = await admin.req('POST', '/api/ia/analyses', { form: multipart({ farm_id: farmId }, { field: 'image', data: Buffer.from('não sou imagem'), type: 'image/png', name: 'x.png' }) });
  assert.equal(fake.status, 400);
  const retry = (await admin.post(`/api/ia/analyses/${r.data.id}/retry`)).data; assert.equal(retry.status, 'indisponivel');
  const list = (await admin.get('/api/ia/analyses')).data; assert.equal(list.length, 1);
  const occ = await admin.post(`/api/ia/analyses/${r.data.id}/occurrence`, { name: 'Possível ferrugem', category: 'doenca', severity: 'media' });
  assert.equal(occ.status, 201);
  const o = (await admin.get(`/api/occurrences/${occ.data.id}`)).data; assert.equal(o.source, 'ia'); assert.equal(o.analysis_id, r.data.id);
});

test('arquivos: tipos aceitos, assinatura verificada, SVG/HTML recusados e acesso por organização', async () => {
  const up = (name, data, type) => admin.req('POST', '/api/files', { form: multipart({ ref_type: 'farm', ref_id: farmId }, { data, type, name }) });
  assert.equal((await up('foto.png', PNG, 'image/png')).status, 201);
  assert.equal((await up('malicioso.svg', Buffer.from('<svg onload=alert(1)></svg>'), 'image/svg+xml')).status, 400);
  assert.equal((await up('pagina.html', Buffer.from('<script>1</script>'), 'text/html')).status, 400);
  assert.equal((await up('falso.png', Buffer.from('MZ-executavel'), 'image/png')).status, 400);
  assert.equal((await up('dados.csv', Buffer.from('a;b\n1;2'), 'text/csv')).status, 201);
  const files = (await admin.get(`/api/files?ref_type=farm&ref_id=${farmId}`)).data; assert.equal(files.length, 2);
  const other = new Client(); await other.login('outro', 'outra12345');
  assert.equal((await other.get(`/api/files/${files[0].id}/download`)).status, 404);
  assert.equal((await other.get(`/api/files?ref_type=farm&ref_id=${farmId}`)).status, 404);
  const dl = await admin.get(`/api/files/${files.find((f) => f.filename.endsWith('csv')).id}/download`);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await admin.del(`/api/files/${files[0].id}`)).status, 200);
});

test('clima: sem fonte, informa indisponibilidade e não inventa valores', async () => {
  const w = (await admin.get(`/api/weather?farm_id=${farmId}`)).data;
  assert.equal(w.available, false); assert.equal(w.reason, 'indisponivel'); assert.equal(w.current, undefined);
  const nofarm = (await admin.post('/api/farms', { name: 'Sem coordenadas' })).data;
  assert.equal((await admin.get(`/api/weather?farm_id=${nofarm.id}`)).data.reason, 'sem_coordenadas');
  const h = (await admin.get(`/api/weather/history?farm_id=${farmId}&from=2026-01-01&to=2026-01-10`)).data;
  assert.equal(h.available, false);
  assert.equal((await admin.get(`/api/weather/history?farm_id=${farmId}&from=2026-01-10&to=2026-01-01`)).status, 400);
});

test('usuários: último admin protegido, redefinição por link, troca de senha e bloqueio por tentativas', async () => {
  const me = (await admin.get('/api/auth/me')).data.user;
  assert.equal((await admin.put(`/api/users/${me.id}`, { role: 'gestor' })).status, 400);
  assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400);
  const u = await T.makeUser(admin, { username: 'maria', name: 'Maria', role: 'visualizador', password: 'inicial123', must_change_password: true });
  const m = new Client(); const login = await m.login('maria', 'inicial123'); assert.equal(login.must_change_password, true);
  assert.equal((await m.post('/api/auth/change-password', { current_password: 'inicial123', new_password: '123' })).status, 400);
  assert.equal((await m.post('/api/auth/change-password', { current_password: 'inicial123', new_password: 'nova-senha-1' })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { username: 'maria', password: 'inicial123' })).status, 401);
  const link = (await admin.post(`/api/users/${u.id}/reset-link`, {})).data;
  const token = link.url.split('/redefinir/')[1];
  assert.equal((await new Client().get(`/api/auth/reset/${token}`)).status, 200);
  const anon = new Client();
  assert.equal((await anon.post('/api/auth/reset', { token, new_password: 'terceira-senha' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { token, new_password: 'quarta-senha1' })).status, 400); // uso único
  await new Client().login('maria', 'terceira-senha');
  for (let i = 0; i < 5; i += 1) await new Client().post('/api/auth/login', { username: 'maria', password: 'errada' });
  const locked = await new Client().post('/api/auth/login', { username: 'maria', password: 'terceira-senha' });
  assert.equal(locked.status, 429);
  const f = await new Client().post('/api/auth/forgot', { identifier: 'usuario-inexistente' });
  assert.equal(f.status, 200); assert.equal(f.data.ok, true);
});

test('auditoria, backup e configurações', async () => {
  const log = (await admin.get('/api/audit')).data;
  assert.ok(log.some((a) => a.action === 'criar' && a.entity === 'fazenda'));
  assert.ok(log.some((a) => a.action === 'login'));
  assert.ok(log.some((a) => a.action === 'login_falhou'));
  const bk = await admin.get('/api/settings/backup');
  assert.equal(bk.status, 200); assert.equal(bk.data.slice(0, 15).toString(), 'SQLite format 3');
  const set = (await admin.get('/api/settings')).data;
  assert.equal(set.integrations.find((i) => i.key === 'ia').status, 'pendente');
  assert.equal(set.integrations.find((i) => i.key === 'weather').status, 'configurada');
  assert.equal((await admin.put('/api/settings/organization', { name: '' })).status, 400);
});

test('segurança: SQL injection em filtros e busca, XSS armazenado como texto, cabeçalhos', async () => {
  const inj = await admin.get(`/api/occurrences?q=${encodeURIComponent("' OR 1=1; DROP TABLE farms;--")}&severity=${encodeURIComponent("x' OR '1'='1")}`);
  assert.equal(inj.status, 200); assert.equal(inj.data.length, 0);
  assert.ok((await admin.get('/api/farms')).data.length >= 1);
  const x = await admin.post('/api/occurrences', { farm_id: farmId, name: '<img src=x onerror=alert(1)>', observed_at: new Date().toISOString() });
  assert.equal(x.status, 201); assert.equal(x.data.name, '<img src=x onerror=alert(1)>');
  const res = await fetch(`${await Promise.resolve(process.env.__BASE || '')}`).catch(() => null); void res;
  const r = await admin.req('GET', '/api/farms');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await admin.req('GET', '/api/farms/abc')).status, 404);
});

test('exclusão de fazenda exige confirmação e apaga dados vinculados', async () => {
  const f = (await admin.post('/api/farms', { name: 'Descartável' })).data;
  await admin.post('/api/plots', { farm_id: f.id, name: 'P' });
  assert.equal((await admin.del(`/api/farms/${f.id}`)).status, 400);
  assert.equal((await admin.del(`/api/farms/${f.id}?confirm=${encodeURIComponent('Descartável')}`)).status, 200);
  assert.equal((await admin.get(`/api/plots?farm_id=${f.id}`)).data.length, 0);
});

test('persistência: dados continuam após fechar e reabrir o banco', async () => {
  const before = (await admin.get('/api/farms')).data.length;
  T.db.close();
  T.db.open();
  const again = new Client(); await again.login('admin', 'admin123');
  assert.equal((await again.get('/api/farms')).data.length, before);
  assert.equal((await again.get(`/api/plots/${plotId}`)).data.name, 'Talhão 1');
});
