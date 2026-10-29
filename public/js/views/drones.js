import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, options, modal, errMsg, toast, tabs, loading, todayISO, table, iconBtn, confirmDialog, formModal, selectOptions } from '../ui.js';
import { icon } from '../icons.js';
import { progress } from '../charts.js';
import { crudPage, plotField, filesPanel, linkFarmPlot } from './shared.js';
import { can, loadFilters } from '../app.js';

const CHECKLIST = ['Bateria(s) carregada(s) e sem danos', 'Hélices e motores inspecionados', 'Tanque/carga e bicos conferidos', 'Sinal de GPS fixo e retorno-ao-ponto configurado', 'Firmware e aplicativo atualizados', 'Área de voo livre de pessoas, animais e obstáculos', 'Condições de vento e chuva adequadas', 'Operador habilitado e autorizações em dia'];
const BAT = { ok: 'Boa', atencao: 'Atenção', substituir: 'Substituir' };

export async function render(host) {
  await crudPage(host, {
    endpoint: '/api/drones', module: 'drones', entity: 'drone', title: 'Drones agrícolas', subtitle: 'Cadastro, baterias, missões e manutenção. O app registra os dados das missões; não controla drones fisicamente.', iconName: 'drone', newLabel: 'Novo drone',
    emptyTitle: 'Nenhum drone cadastrado', emptyText: 'Cadastre seus drones para registrar baterias, checklist pré-voo, missões e relatórios. A integração com fabricantes e telemetria é uma evolução futura.',
    filters: [{ key: 'status', label: 'Situação', options: options(L.droneStatus) }], modalSize: 'wide', defaults: () => ({ status: 'disponivel', flight_hours: 0 }),
    banner: h('div', { class: 'notice', style: { marginBottom: '14px' } }, icon('info', 18), 'Operação de drones exige habilitação, registro e autorizações exigidas pela legislação aplicável. Este módulo organiza as informações; não substitui o planejamento de voo oficial.'),
    render: (rows, { openForm, remove }) => h('div', { class: 'grid g-auto' }, rows.map((d) => {
      const pct = d.planned_area_ha > 0 ? (d.covered_area_ha / d.planned_area_ha) * 100 : null;
      return h('div', { class: 'card item-card' },
        h('div', { class: 'top' }, h('div', null, h('h3', null, d.name), h('div', { class: 'small muted' }, [d.model, d.serial_number && `S/N ${d.serial_number}`].filter(Boolean).join(' · ') || 'Sem modelo informado'), h('div', { class: 'tiny muted' }, d.farm_name || 'Sem fazenda vinculada')),
          h('div', { class: 'row', style: { gap: '2px' } }, can('drones', 'w') ? iconBtn('edit', 'Editar', () => openForm(d)) : null, can('drones', 'd') ? iconBtn('trash', 'Excluir', () => remove(d), 'danger') : null)),
        h('div', null, badge(d.status, L.droneStatus[d.status])),
        h('div', { class: 'mini-stats' }, h('div', null, h('b', null, fmt.num(d.flight_hours, 1)), h('span', null, 'Horas de voo')), h('div', null, h('b', null, d.missions_count), h('span', null, 'Missões')), h('div', null, h('b', null, d.capacity_l ? `${fmt.num(d.capacity_l)} L` : '—'), h('span', null, 'Capacidade'))),
        pct !== null ? h('div', null, h('div', { class: 'row tiny muted', style: { justifyContent: 'space-between', marginBottom: '4px' } }, h('span', null, `Área atendida x planejada (concluídas)`), h('span', null, `${fmt.ha(d.covered_area_ha)} / ${fmt.ha(d.planned_area_ha)}`)), progress(pct, 'Área atendida')) : null,
        h('div', { class: 'tiny muted' }, d.last_mission_date ? `Última missão: ${fmt.date(d.last_mission_date)}` : 'Nenhuma missão registrada'),
        h('button', { class: 'btn primary sm', onclick: () => detail(d) }, 'Missões, baterias e manutenção'));
    })),
    fields: (F) => [
      { name: 'name', label: 'Nome / identificação', required: true, maxlength: 120 }, { name: 'model', label: 'Modelo', maxlength: 80 }, { name: 'serial_number', label: 'Número de série', maxlength: 80 }, { name: 'capacity_l', label: 'Capacidade do tanque (L)', type: 'number', min: 0 },
      { name: 'flight_hours', label: 'Horas de voo acumuladas', type: 'number', min: 0 }, { name: 'status', label: 'Situação', type: 'select', options: options(L.droneStatus), required: true }, { name: 'farm_id', label: 'Fazenda vinculada', type: 'select', options: selectOptions(F.farms) }, { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ],
  });
}

async function detail(d) {
  const content = h('div'); let current = 'missions';
  const tb = tabs([{ key: 'missions', label: 'Missões' }, { key: 'batteries', label: 'Baterias' }, { key: 'maint', label: 'Inspeção e manutenção' }], 'missions', (k) => { current = k; show(); });
  modal({ title: d.name, size: 'wide', body: h('div', null, tb, content) });
  const F = await loadFilters();

  async function show() {
    clear(content); content.appendChild(loading());
    try {
      if (current === 'missions') return missions();
      if (current === 'batteries') return generic({ url: '/api/drone-batteries', perm: can('drones', 'w'), label: 'Nova bateria', base: { status: 'ok', cycles: 0 }, cols: [{ label: 'Bateria', key: 'label' }, { label: 'Ciclos', num: true, key: 'cycles' }, { label: 'Saúde', num: true, render: (r) => (r.health_pct !== null ? `${fmt.num(r.health_pct, 0)}%` : '—') }, { label: 'Situação', render: (r) => badge(r.status, BAT[r.status], r.status === 'ok' ? 'ok' : r.status === 'atencao' ? 'warn' : 'bad') }], fields: () => [{ name: 'label', label: 'Identificação da bateria', required: true, maxlength: 80 }, { name: 'cycles', label: 'Ciclos de carga', type: 'number', min: 0, step: 1 }, { name: 'health_pct', label: 'Saúde (%)', type: 'number', min: 0, max: 100 }, { name: 'status', label: 'Situação', type: 'select', options: Object.entries(BAT).map(([value, label]) => ({ value, label })), required: true }] });
      return generic({ url: '/api/drone-maintenance', perm: can('maintenance', 'w'), label: 'Novo registro', base: { service_date: todayISO(), kind: 'inspecao' }, cols: [{ label: 'Data', render: (r) => fmt.date(r.service_date) }, { label: 'Tipo', render: (r) => L.maintKind[r.kind] }, { label: 'Descrição', key: 'description' }, { label: 'Custo', num: true, render: (r) => fmt.money(r.cost) }], fields: () => [{ name: 'kind', label: 'Tipo', type: 'select', options: options(L.maintKind), required: true }, { name: 'service_date', label: 'Data', type: 'date', required: true }, { name: 'description', label: 'Descrição', required: true, full: true, maxlength: 300 }, { name: 'cost', label: 'Custo (R$)', type: 'number', min: 0 }] });
    } catch (e) { clear(content); content.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }

  async function generic(cfg) {
    const rows = await api.get(`${cfg.url}${qs({ drone_id: d.id })}`); clear(content);
    const open = (row) => { const FF = cfg.fields(); formModal({ title: row ? 'Editar' : cfg.label, fields: FF, values: row || cfg.base, onSubmit: async (v) => { const p = { drone_id: d.id }; FF.forEach((f) => { p[f.name] = v[f.name] === '' ? null : v[f.name]; }); if (row) await api.put(`${cfg.url}/${row.id}`, p); else await api.post(cfg.url, p); toast('Registro salvo.'); show(); } }); };
    if (cfg.perm) content.appendChild(h('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: () => open(null) }, icon('plus', 17), cfg.label)));
    content.appendChild(table(cfg.cols, rows, { empty: 'Nenhum registro ainda.', actions: cfg.perm ? (r) => [iconBtn('edit', 'Editar', () => open(r)), iconBtn('trash', 'Excluir', async () => { if (await confirmDialog('Excluir este registro?', { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`${cfg.url}/${r.id}`); show(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger')] : null }));
  }

  async function missions() {
    const rows = await api.get(`/api/drone-missions${qs({ drone_id: d.id })}`); clear(content);
    if (can('missions', 'w')) content.appendChild(h('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: () => missionForm(null) }, icon('plus', 17), 'Nova missão')));
    content.appendChild(table([
      { label: 'Data', render: (r) => fmt.date(r.mission_date) }, { label: 'Missão', render: (r) => [h('b', null, r.name), h('div', { class: 'tiny muted' }, L.missionType[r.mission_type])] }, { label: 'Local', render: (r) => [r.farm_name, r.plot_name].filter(Boolean).join(' / ') || '—' },
      { label: 'Planejada', num: true, render: (r) => fmt.ha(r.planned_area_ha) }, { label: 'Atendida', num: true, render: (r) => fmt.ha(r.covered_area_ha) }, { label: 'Operador', render: (r) => r.operator_name || '—' }, { label: 'Situação', render: (r) => badge(r.status, L.opStatus[r.status]) },
    ], rows, { empty: 'Nenhuma missão registrada.', onRow: (r) => missionDetail(r), actions: (r) => [iconBtn('eye', 'Detalhes', () => missionDetail(r)), can('missions', 'w') ? iconBtn('edit', 'Editar', () => missionForm(r)) : null, can('missions', 'd') ? iconBtn('trash', 'Excluir', async () => { if (await confirmDialog('Excluir esta missão?', { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`/api/drone-missions/${r.id}`); show(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger') : null] }));
  }

  function missionForm(row) {
    const items = CHECKLIST.map((label) => ({ label, checked: !!(row && row.checklist && (row.checklist.items || []).find((i) => i.label === label && i.checked)) }));
    const fields = [
      { name: 'name', label: 'Nome da missão', required: true, full: true, maxlength: 150 }, { name: 'mission_type', label: 'Tipo', type: 'select', options: options(L.missionType), required: true }, { name: 'mission_date', label: 'Data', type: 'date', required: true },
      { name: 'farm_id', label: 'Fazenda', type: 'select', options: selectOptions(F.farms) }, plotField(F), { name: 'planned_area_ha', label: 'Área planejada (ha)', type: 'number', min: 0 }, { name: 'covered_area_ha', label: 'Área efetivamente atendida (ha)', type: 'number', min: 0 },
      { name: 'flight_minutes', label: 'Tempo de voo (min)', type: 'number', min: 0 }, { name: 'operator_name', label: 'Operador responsável', maxlength: 120 }, { name: 'status', label: 'Situação', type: 'select', options: options(L.opStatus), required: true }, { name: 'report', label: 'Relatório da missão', type: 'textarea', full: true, rows: 4, placeholder: 'Resumo da execução, ocorrências, observações...' },
    ];
    const boxes = items.map((it) => h('label', null, h('input', { type: 'checkbox', checked: it.checked }), it.label));
    const extra = h('div', { class: 'checklist', style: { marginTop: '14px' } }, h('h3', { style: { marginBottom: '4px' } }, 'Checklist pré-voo'), h('p', { class: 'tiny muted' }, 'Todos os itens devem estar marcados para concluir a missão.'), boxes);
    const fm = formModal({
      title: row ? 'Editar missão' : 'Nova missão', fields, values: { mission_type: 'inspecao', status: 'planejada', mission_date: todayISO(), farm_id: d.farm_id || '', ...(row || {}) }, size: 'wide', extra,
      onSubmit: async (v) => {
        const p = { drone_id: d.id }; fields.forEach((f) => { p[f.name] = v[f.name] === '' ? null : v[f.name]; });
        p.checklist = { items: items.map((it, i) => ({ label: it.label, checked: boxes[i].querySelector('input').checked })), done_at: new Date().toISOString() };
        if (row) await api.put(`/api/drone-missions/${row.id}`, p); else await api.post('/api/drone-missions', p);
        toast('Missão salva.'); show();
      },
    });
    linkFarmPlot(fm.form, F);
  }

  function missionDetail(r) {
    const cl = r.checklist && r.checklist.items ? r.checklist.items : [];
    modal({ title: r.name, size: 'wide', body: h('div', { class: 'stack' },
      h('div', { class: 'row' }, badge(r.status, L.opStatus[r.status]), badge('x', L.missionType[r.mission_type], 'neutral')),
      h('dl', { class: 'kv' }, h('dt', null, 'Data'), h('dd', null, fmt.date(r.mission_date)), h('dt', null, 'Drone'), h('dd', null, r.drone_name), h('dt', null, 'Local'), h('dd', null, [r.farm_name, r.plot_name].filter(Boolean).join(' / ') || '—'), h('dt', null, 'Área planejada'), h('dd', null, fmt.ha(r.planned_area_ha)), h('dt', null, 'Área atendida'), h('dd', null, fmt.ha(r.covered_area_ha)),
        h('dt', null, 'Tempo de voo'), h('dd', null, r.flight_minutes !== null ? `${fmt.num(r.flight_minutes, 0)} min` : '—'), h('dt', null, 'Operador'), h('dd', null, r.operator_name || '—'), h('dt', null, 'Relatório'), h('dd', null, r.report || '—')),
      cl.length ? h('div', null, h('h3', { style: { marginBottom: '6px' } }, 'Checklist pré-voo'), h('ul', { style: { margin: 0, paddingLeft: '20px', lineHeight: '1.7' } }, cl.map((i) => h('li', null, `${i.checked ? '✔' : '✖'} ${i.label}`)))) : null,
      filesPanel('drone_mission', r.id, { canWrite: can('missions', 'w'), accept: 'image/*,application/pdf', title: 'Imagens capturadas e anexos' })) });
  }
  await show();
}
