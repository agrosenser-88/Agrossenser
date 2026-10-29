import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, options, modal, errMsg, toast, tabs, loading, todayISO, table, iconBtn, confirmDialog, formModal, selectOptions } from '../ui.js';
import { icon } from '../icons.js';
import { barChart, progress } from '../charts.js';
import { crudPage, farmField, plotField, filesPanel, gpsButton } from './shared.js';
import { can, loadFilters } from '../app.js';

export async function render(host) {
  await crudPage(host, {
    endpoint: '/api/machines', module: 'machines', entity: 'máquina', title: 'Máquinas e equipamentos', subtitle: 'Tratores, pulverizadores, colheitadeiras e demais equipamentos, com operações, abastecimentos e manutenções.', iconName: 'tractor', newLabel: 'Nova máquina',
    emptyTitle: 'Nenhuma máquina cadastrada', emptyText: 'Cadastre seus equipamentos para registrar horas de uso, abastecimentos e revisões. O rastreamento por GPS depende de integração com dispositivo compatível; por enquanto as operações são registradas manualmente.',
    filters: [{ key: 'kind', label: 'Tipo', options: options(L.machineKind) }, { key: 'status', label: 'Situação', options: options(L.machineStatus) }], modalSize: 'wide',
    defaults: () => ({ kind: 'trator', status: 'disponivel', hour_meter: 0 }),
    render: (rows, { openForm, remove }) => h('div', { class: 'grid g-auto' }, rows.map((m) => card(m, openForm, remove))),
    fields: (F) => [
      { name: 'name', label: 'Identificação / apelido', required: true, maxlength: 120, placeholder: 'Ex.: Trator 01' }, { name: 'kind', label: 'Tipo', type: 'select', options: options(L.machineKind), required: true },
      { name: 'brand', label: 'Marca', maxlength: 80 }, { name: 'model', label: 'Modelo', maxlength: 80 }, { name: 'year', label: 'Ano', type: 'number', min: 1950, max: 2100, step: 1 }, { name: 'identifier', label: 'Placa / chassi / série', maxlength: 80 },
      { name: 'hour_meter', label: 'Horímetro atual (h)', type: 'number', min: 0 }, { name: 'status', label: 'Situação', type: 'select', options: options(L.machineStatus), required: true },
      { name: 'farm_id', label: 'Fazenda vinculada', type: 'select', options: selectOptions(F.farms) }, plotField(F, { label: 'Talhão atual' }),
      { name: 'last_lat', label: 'Última posição (lat.)', type: 'number', min: -90, max: 90, hint: 'Informada manualmente; não é rastreamento em tempo real.' }, { name: 'last_lng', label: 'Última posição (long.)', type: 'number', min: -180, max: 180 },
      { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ],
    onForm: (fm) => { const hint = fm.el.querySelector('.modal-body form'); hint.insertBefore(h('div', { style: { marginTop: '8px' } }, gpsButton({ set: (n, v) => fm.form.set(n, v) }, 'last_lat', 'last_lng')), hint.querySelector('.form-error')); },
  });
}

function card(m, openForm, remove) {
  const due = []; const today = todayISO();
  if (m.next_due_date) due.push(m.next_due_date < today ? badge('x', `Revisão vencida (${fmt.date(m.next_due_date)})`, 'bad') : badge('x', `Próx. revisão ${fmt.date(m.next_due_date)}`, m.next_due_date <= new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) ? 'warn' : 'neutral'));
  if (m.next_due_hours) due.push(m.hour_meter >= m.next_due_hours ? badge('x', `Revisão por horímetro vencida (${fmt.num(m.next_due_hours, 0)} h)`, 'bad') : badge('x', `Revisão em ${fmt.num(m.next_due_hours, 0)} h`, m.hour_meter >= m.next_due_hours - 20 ? 'warn' : 'neutral'));
  const util = Math.min(100, (m.hours_30d / (30 * 8)) * 100);
  return h('div', { class: 'card item-card' },
    h('div', { class: 'top' }, h('div', null, h('h3', null, m.name), h('div', { class: 'small muted' }, [L.machineKind[m.kind], m.brand, m.model, m.year].filter(Boolean).join(' · ')), h('div', { class: 'tiny muted' }, m.farm_name || 'Sem fazenda vinculada')),
      h('div', { class: 'row', style: { gap: '2px' } }, can('machines', 'w') ? iconBtn('edit', 'Editar', () => openForm(m)) : null, can('machines', 'd') ? iconBtn('trash', 'Excluir', () => remove(m), 'danger') : null)),
    h('div', null, badge(m.status, L.machineStatus[m.status])),
    h('div', { class: 'mini-stats' }, h('div', null, h('b', null, fmt.num(m.hour_meter, 0)), h('span', null, 'Horímetro (h)')), h('div', null, h('b', null, fmt.num(m.hours_30d, 1)), h('span', null, 'Horas em 30 dias')), h('div', null, h('b', null, fmt.money(m.fuel_cost + m.maintenance_cost)), h('span', null, 'Combust. + manut.'))),
    h('div', null, h('div', { class: 'row tiny muted', style: { justifyContent: 'space-between', marginBottom: '4px' } }, h('span', null, 'Utilização (30 dias, base 8 h/dia)'), h('span', null, fmt.pct(util, 0))), progress(util, 'Utilização da máquina')),
    due.length ? h('div', { class: 'row' }, due) : null,
    h('button', { class: 'btn primary sm', onclick: () => detail(m) }, 'Operações, abastecimento e manutenção'));
}

async function detail(m) {
  const content = h('div'); let current = 'ops';
  const canOps = can('machine_ops', 'w'); const canMaint = can('maintenance', 'w');
  const tb = tabs([{ key: 'ops', label: 'Operações' }, { key: 'fuel', label: 'Abastecimentos' }, { key: 'maint', label: 'Manutenções' }, { key: 'files', label: 'Fotos e documentos' }], 'ops', (k) => { current = k; show(); });
  const mm = modal({ title: m.name, size: 'wide', body: h('div', null, tb, content) });
  void mm;
  async function show() {
    clear(content); content.appendChild(loading());
    try {
      if (current === 'files') { clear(content); content.appendChild(filesPanel('machine', m.id, { canWrite: can('machines', 'w'), title: 'Fotos e documentos' })); return; }
      const cfg = {
        ops: { url: '/api/machine-operations', perm: canOps, label: 'Nova operação', cols: [{ label: 'Data', render: (r) => fmt.date(r.op_date) }, { label: 'Operação', key: 'operation' }, { label: 'Horas', num: true, render: (r) => fmt.num(r.hours) }, { label: 'Operador', render: (r) => r.operator_name || '—' }, { label: 'Local', render: (r) => [r.farm_name, r.plot_name].filter(Boolean).join(' / ') || '—' }], base: { op_date: todayISO() },
          fields: (F) => [{ name: 'operation', label: 'Operação realizada', required: true, full: true, maxlength: 150, placeholder: 'Ex.: Plantio, pulverização, gradagem' }, { name: 'op_date', label: 'Data', type: 'date', required: true }, { name: 'hours', label: 'Horas trabalhadas', type: 'number', min: 0, max: 744 }, { name: 'hour_meter_end', label: 'Horímetro ao final (h)', type: 'number', min: 0 }, { name: 'operator_name', label: 'Operador', maxlength: 120 }, { name: 'farm_id', label: 'Fazenda', type: 'select', options: selectOptions(F.farms) }, plotField(F), { name: 'notes', label: 'Observações', type: 'textarea', full: true }] },
        fuel: { url: '/api/machine-fuel', perm: canOps, label: 'Novo abastecimento', cols: [{ label: 'Data', render: (r) => fmt.date(r.fuel_date) }, { label: 'Litros', num: true, render: (r) => fmt.num(r.liters) }, { label: 'Custo', num: true, render: (r) => fmt.money(r.cost) }, { label: 'R$/L', num: true, render: (r) => (r.liters > 0 && r.cost > 0 ? fmt.money(r.cost / r.liters) : '—') }, { label: 'Horímetro', num: true, render: (r) => fmt.num(r.hour_meter, 0) }], base: { fuel_date: todayISO() },
          fields: () => [{ name: 'fuel_date', label: 'Data', type: 'date', required: true }, { name: 'liters', label: 'Litros', type: 'number', required: true, min: 0 }, { name: 'cost', label: 'Custo total (R$)', type: 'number', min: 0 }, { name: 'hour_meter', label: 'Horímetro (h)', type: 'number', min: 0 }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }] },
        maint: { url: '/api/machine-maintenance', perm: canMaint, label: 'Nova manutenção', cols: [{ label: 'Data', render: (r) => fmt.date(r.service_date) }, { label: 'Serviço', key: 'description' }, { label: 'Tipo', render: (r) => L.maintKind[r.kind] }, { label: 'Situação', render: (r) => badge(r.status, r.status === 'agendada' ? 'Agendada' : 'Concluída', r.status === 'agendada' ? 'warn' : 'ok') }, { label: 'Custo', num: true, render: (r) => fmt.money(r.cost) }, { label: 'Próxima revisão', render: (r) => [r.next_due_date ? fmt.date(r.next_due_date) : null, r.next_due_hours ? `${fmt.num(r.next_due_hours, 0)} h` : null].filter(Boolean).join(' / ') || '—' }], base: { service_date: todayISO(), kind: 'preventiva', status: 'concluida' },
          fields: () => [{ name: 'description', label: 'Serviço realizado/agendado', required: true, full: true, maxlength: 300 }, { name: 'kind', label: 'Tipo', type: 'select', options: options(L.maintKind), required: true }, { name: 'status', label: 'Situação', type: 'select', options: [{ value: 'concluida', label: 'Concluída' }, { value: 'agendada', label: 'Agendada' }], required: true }, { name: 'service_date', label: 'Data', type: 'date', required: true }, { name: 'cost', label: 'Custo (R$)', type: 'number', min: 0 }, { name: 'hour_meter', label: 'Horímetro (h)', type: 'number', min: 0 }, { name: 'next_due_date', label: 'Próxima revisão (data)', type: 'date' }, { name: 'next_due_hours', label: 'Próxima revisão (horímetro)', type: 'number', min: 0 }] },
      }[current];
      const rows = await api.get(`${cfg.url}${qs({ machine_id: m.id })}`); const F = await loadFilters();
      clear(content);
      if (current === 'ops' && rows.length) { const byM = {}; rows.forEach((r) => { const k = r.op_date.slice(0, 7); byM[k] = (byM[k] || 0) + r.hours; }); const keys = Object.keys(byM).sort().slice(-6); content.appendChild(h('div', { style: { marginBottom: '14px' } }, h('h4', { class: 'muted' }, 'Horas por mês'), barChart({ labels: keys.map(fmt.month), series: [{ name: 'Horas', values: keys.map((k) => byM[k]) }], height: 170 }))); }
      const open = (row) => { const FF = cfg.fields(F); formModal({ title: row ? 'Editar registro' : cfg.label, fields: FF, values: row || cfg.base, size: 'wide', onSubmit: async (v) => { const p = { machine_id: m.id }; FF.forEach((f) => { p[f.name] = v[f.name] === '' ? null : v[f.name]; }); if (row) await api.put(`${cfg.url}/${row.id}`, p); else await api.post(`${cfg.url}`, p); toast('Registro salvo.'); show(); } }); };
      if (cfg.perm) content.appendChild(h('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: () => open(null) }, icon('plus', 17), cfg.label)));
      content.appendChild(table(cfg.cols, rows, { empty: 'Nenhum registro ainda.', actions: cfg.perm ? (r) => [iconBtn('edit', 'Editar', () => open(r)), iconBtn('trash', 'Excluir', async () => { if (await confirmDialog('Excluir este registro?', { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`${cfg.url}/${r.id}`); show(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger')] : null }));
    } catch (e) { clear(content); content.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  await show();
}
