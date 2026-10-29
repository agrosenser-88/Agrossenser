import { api } from '../api.js';
import { h, fmt, L, badge, options, modal, selectOptions, toast, errMsg, formModal, todayISO } from '../ui.js';
import { icon } from '../icons.js';
import { AgroMap, polygonAreaHa } from '../map.js';
import { progress } from '../charts.js';
import { crudPage, farmField, plotField, filesPanel } from './shared.js';
import { can } from '../app.js';

export async function render(host) {
  const [machines, drones] = await Promise.all([can('machines') ? api.get('/api/machines') : [], can('drones') ? api.get('/api/drones') : []]);
  await crudPage(host, {
    endpoint: '/api/spray', module: 'spray', entity: 'pulverização', title: 'Pulverização', subtitle: 'Planejamento, execução e histórico de aplicações. O sistema registra os dados; não comanda equipamentos.', iconName: 'spray', newLabel: 'Nova operação', periodFilter: true, modalSize: 'wide',
    emptyTitle: 'Nenhuma pulverização registrada', emptyText: 'Crie uma operação planejada, acompanhe o andamento e compare a área planejada com a executada. Registros geográficos aparecem no mapa.',
    filters: [{ key: 'status', label: 'Situação', options: options(L.opStatus) }],
    defaults: () => ({ status: 'planejada', op_date: todayISO() }),
    banner: h('div', { class: 'notice', style: { marginBottom: '14px' } }, icon('info', 18), 'Produtos, doses e condições de aplicação devem seguir a recomendação técnica do engenheiro agrônomo e a bula/receituário. O sistema não sugere produtos nem doses.'),
    columns: [
      { label: 'Data', render: (r) => fmt.date(r.op_date) }, { label: 'Fazenda / talhão', render: (r) => [h('b', null, r.farm_name), r.plot_name ? h('div', { class: 'tiny muted' }, `${r.plot_name}${r.crop ? ' · ' + r.crop : ''}`) : null] },
      { label: 'Produto', render: (r) => [r.product || '—', r.input_qty !== null ? h('div', { class: 'tiny muted' }, `${fmt.num(r.input_qty)} ${r.input_unit || ''}`) : null] }, { label: 'Planejada', num: true, render: (r) => fmt.ha(r.planned_area_ha) },
      { label: 'Executada', num: true, render: (r) => [fmt.ha(r.executed_area_ha), r.executed_pct !== null ? h('div', { class: 'tiny muted' }, `${fmt.pct(r.executed_pct, 0)} do planejado`) : null] }, { label: 'Equipamento', render: (r) => r.machine_name || r.drone_name || '—' }, { label: 'Operador', render: (r) => r.operator_name || '—' }, { label: 'Situação', render: (r) => badge(r.status, L.opStatus[r.status]) },
    ],
    onRow: (r) => detail(r),
    fields: (F) => [
      farmField(F), plotField(F), { name: 'crop', label: 'Cultura', maxlength: 80, hint: 'Se vazio, usa a cultura do talhão.' }, { name: 'op_date', label: 'Data', type: 'date', required: true },
      { name: 'planned_area_ha', label: 'Área planejada (ha)', type: 'number', min: 0 }, { name: 'executed_area_ha', label: 'Área executada (ha)', type: 'number', min: 0, hint: 'Obrigatória para concluir.' },
      { name: 'product', label: 'Produto utilizado', maxlength: 150 }, { name: 'volume_l', label: 'Volume de calda aplicado (L)', type: 'number', min: 0 }, { name: 'input_qty', label: 'Quantidade de insumo', type: 'number', min: 0 }, { name: 'input_unit', label: 'Unidade do insumo', type: 'select', options: ['L', 'mL', 'kg', 'g', 'un'].map((v) => ({ value: v, label: v })) },
      { name: 'machine_id', label: 'Máquina', type: 'select', options: selectOptions(machines) }, { name: 'drone_id', label: 'Drone', type: 'select', options: selectOptions(drones) }, { name: 'operator_name', label: 'Operador', maxlength: 120 }, { name: 'status', label: 'Situação', type: 'select', options: options(L.opStatus), required: true },
      { name: 'cost', label: 'Custo da operação (R$)', type: 'number', min: 0 }, { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ],
    onForm: (fm, row) => {
      const body = fm.el.querySelector('.modal-body form');
      let planned = row && row.geo_planned; let executed = row && row.geo_executed;
      const info = h('span', { class: 'tiny muted' }, `${planned ? 'Área planejada desenhada. ' : ''}${executed ? 'Área executada desenhada.' : ''}`);
      const draw = (kind) => drawArea(kind === 'planned' ? planned : executed, (g) => { if (kind === 'planned') { planned = g; if (g && !fm.form.read().planned_area_ha) fm.form.set('planned_area_ha', Math.round(polygonAreaHa(g) * 100) / 100); } else { executed = g; if (g && !fm.form.read().executed_area_ha) fm.form.set('executed_area_ha', Math.round(polygonAreaHa(g) * 100) / 100); } info.textContent = `${planned ? 'Área planejada desenhada. ' : ''}${executed ? 'Área executada desenhada.' : ''}`; });
      body.insertBefore(h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { type: 'button', class: 'btn sm', onclick: () => draw('planned') }, icon('polygon', 15), 'Desenhar área planejada'), h('button', { type: 'button', class: 'btn sm', onclick: () => draw('executed') }, icon('polygon', 15), 'Desenhar área executada'), info), body.querySelector('.form-error'));
      fm.payloadExtra = () => ({ geo_planned: planned || null, geo_executed: executed || null });
    },
  });
}

function drawArea(current, onDone) {
  const el = h('div', { style: { height: '56vh', minHeight: '320px' } }); let map; const counter = h('span', { class: 'small' }, '0 pontos');
  const m0 = modal({ title: 'Desenhar área no mapa', size: 'wide', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Toque ou clique no mapa para marcar os vértices (mínimo 3).'), el, counter),
    actions: [h('button', { class: 'btn', onclick: () => m0.close() }, 'Cancelar'), current ? h('button', { class: 'btn danger', onclick: () => { onDone(null); m0.close(); } }, 'Remover') : null, h('button', { class: 'btn', onclick: () => map.undoDraw() }, 'Desfazer ponto'),
      h('button', { class: 'btn primary', onclick: () => { const g = map.finishDraw(); if (!g) { toast('Marque pelo menos 3 pontos.', 'warn'); map.startDraw((n) => { counter.textContent = `${n} pontos`; }); return; } onDone(g); m0.close(); } }, 'Concluir')] });
  setTimeout(() => { map = new AgroMap(el); if (current) { map.addShape({ geometry: current, fill: 'rgba(255,255,255,.12)', stroke: '#fff', dash: '5 4' }); map.fitPoints(current.coordinates[0].map((c) => ({ lat: c[1], lng: c[0] })), { maxZoom: 17 }); } else map.setView(-15.78, -47.93, 5); map.startDraw((n) => { counter.textContent = `${n} ponto${n === 1 ? '' : 's'}`; }); }, 40);
}

function detail(r) {
  const pct = r.executed_pct;
  const body = h('div', { class: 'stack' }, h('div', { class: 'row' }, badge(r.status, L.opStatus[r.status])),
    h('dl', { class: 'kv' }, h('dt', null, 'Data'), h('dd', null, fmt.date(r.op_date)), h('dt', null, 'Fazenda'), h('dd', null, r.farm_name), h('dt', null, 'Talhão'), h('dd', null, r.plot_name || '—'), h('dt', null, 'Cultura'), h('dd', null, r.crop || '—'), h('dt', null, 'Produto'), h('dd', null, r.product || '—'),
      h('dt', null, 'Insumo'), h('dd', null, r.input_qty !== null ? `${fmt.num(r.input_qty)} ${r.input_unit || ''}` : '—'), h('dt', null, 'Volume de calda'), h('dd', null, r.volume_l !== null ? `${fmt.num(r.volume_l)} L` : '—'), h('dt', null, 'Equipamento'), h('dd', null, r.machine_name || r.drone_name || '—'), h('dt', null, 'Operador'), h('dd', null, r.operator_name || '—'), h('dt', null, 'Custo'), h('dd', null, fmt.money(r.cost)), h('dt', null, 'Observações'), h('dd', null, r.notes || '—')),
    h('div', null, h('div', { class: 'row small', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('span', null, `Planejada ${fmt.ha(r.planned_area_ha)} · Executada ${fmt.ha(r.executed_area_ha)}`), h('b', null, pct !== null ? fmt.pct(pct, 0) : '—')), pct !== null ? progress(pct, 'Executada x planejada') : null));
  if (r.geo_planned || r.geo_executed) { const el = h('div', { style: { height: '280px' } }); body.appendChild(el); setTimeout(() => { const m = new AgroMap(el); const pts = []; if (r.geo_planned) { m.addShape({ geometry: r.geo_planned, fill: 'rgba(77,141,255,.15)', stroke: '#4d8dff', dash: '6 4' }); (r.geo_planned.coordinates ? r.geo_planned.coordinates[0] : []).forEach((c) => pts.push({ lat: c[1], lng: c[0] })); } if (r.geo_executed) { m.addShape({ geometry: r.geo_executed, fill: 'rgba(182,240,58,.3)', stroke: '#b6f03a' }); (r.geo_executed.coordinates ? r.geo_executed.coordinates[0] : []).forEach((c) => pts.push({ lat: c[1], lng: c[0] })); } m.fitPoints(pts, { maxZoom: 17 }); m.render(); }, 30); body.appendChild(h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: '#4d8dff' } }), 'Planejada'), h('span', null, h('i', { style: { background: '#b6f03a' } }), 'Executada'))); }
  body.appendChild(filesPanel('spray_operation', r.id, { canWrite: can('spray', 'w'), accept: 'image/*,application/pdf', title: 'Imagens e anexos' }));
  const actions = [];
  const setStatus = (s) => h('button', { class: 'btn', onclick: async () => { try { await api.put(`/api/spray/${r.id}`, { status: s }); toast('Situação atualizada.'); mm.close(); location.reload(); } catch (e) { toast(errMsg(e), 'err'); } } }, L.opStatus[s]);
  if (can('spray', 'w')) { if (r.status === 'planejada') actions.push(setStatus('em_andamento'), setStatus('cancelada')); else if (r.status === 'em_andamento') actions.push(setStatus('cancelada')); }
  const mm = modal({ title: `Pulverização — ${r.farm_name}`, body, size: 'wide', actions }); void formModal; void selectOptions;
}
