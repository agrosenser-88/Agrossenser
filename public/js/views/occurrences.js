import { api } from '../api.js';
import { h, fmt, L, badge, options, modal, nowLocalInput } from '../ui.js';
import { icon } from '../icons.js';
import { crudPage, farmField, plotField, filesPanel, gpsButton } from './shared.js';
import { can } from '../app.js';

export async function render(host) {
  void nowLocalInput;
  await crudPage(host, {
    endpoint: '/api/occurrences', module: 'occurrences', entity: 'ocorrência', title: 'Pragas e doenças', subtitle: 'Registro de focos, gravidade e acompanhamento do tratamento.', iconName: 'bug', newLabel: 'Registrar ocorrência',
    emptyTitle: 'Nenhuma ocorrência registrada', emptyText: 'Registre focos de pragas, doenças e plantas daninhas encontrados nas inspeções. Eles aparecem no mapa e geram alertas.',
    periodFilter: true, modalSize: 'wide',
    filters: [{ key: 'severity', label: 'Gravidade', options: options(L.severity) }, { key: 'status', label: 'Situação', options: options(L.occStatus) }, { key: 'category', label: 'Tipo', options: options(L.occCategory) }, { key: 'source', label: 'Origem', options: [{ value: 'manual', label: 'Manual' }, { value: 'ia', label: 'AgroSenser IA' }] }],
    defaults: () => ({ category: 'praga', severity: 'media', status: 'aberta', observed_at: new Date().toISOString() }),
    columns: [
      { label: 'Data', render: (r) => fmt.date(r.observed_at) }, { label: 'Ocorrência', render: (r) => [h('b', null, r.name), h('div', { class: 'tiny muted' }, L.occCategory[r.category])] },
      { label: 'Fazenda / talhão', render: (r) => [r.farm_name, r.plot_name ? h('div', { class: 'tiny muted' }, `${r.plot_name}${r.plot_crop ? ' · ' + r.plot_crop : ''}`) : null] },
      { label: 'Gravidade', render: (r) => badge(r.severity, L.severity[r.severity]) }, { label: 'Situação', render: (r) => badge(r.status, L.occStatus[r.status]) },
      { label: 'Área afetada', num: true, render: (r) => fmt.ha(r.area_affected_ha) }, { label: 'Origem', render: (r) => (r.source === 'ia' ? badge('ia', 'IA', 'info') : 'Manual') },
    ],
    onRow: (r) => detail(r),
    fields: (F) => [
      farmField(F), plotField(F), { name: 'name', label: 'Praga / doença', required: true, full: true, maxlength: 150, placeholder: 'Ex.: Percevejo-marrom, ferrugem-asiática' },
      { name: 'category', label: 'Tipo', type: 'select', options: options(L.occCategory), required: true }, { name: 'severity', label: 'Gravidade', type: 'select', options: options(L.severity), required: true },
      { name: 'status', label: 'Situação', type: 'select', options: options(L.occStatus), required: true }, { name: 'observed_at', label: 'Data e hora da observação', type: 'datetime', required: true },
      { name: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90 }, { name: 'lng', label: 'Longitude', type: 'number', min: -180, max: 180 },
      { name: 'area_affected_ha', label: 'Área afetada (ha)', type: 'number', min: 0 }, { name: 'description', label: 'Descrição / sintomas observados', type: 'textarea', full: true },
    ],
    onForm: (fm) => { fm.el.querySelector('.modal-body form').insertBefore(h('div', { class: 'row', style: { marginTop: '10px' } }, gpsButton({ set: (n, v) => fm.form.set(n, v) }), h('span', { class: 'tiny muted' }, 'Capture a posição do foco pelo GPS (com sua autorização) ou informe manualmente.')), fm.el.querySelector('.form-error')); },
  });
}

function detail(r) {
  const body = h('div', { class: 'stack' },
    h('div', { class: 'row' }, badge(r.severity, L.severity[r.severity]), badge(r.status, L.occStatus[r.status]), r.source === 'ia' ? badge('ia', 'Sugerida pela IA — confirmar com agrônomo', 'info') : null),
    h('dl', { class: 'kv' }, h('dt', null, 'Tipo'), h('dd', null, L.occCategory[r.category]), h('dt', null, 'Fazenda'), h('dd', null, r.farm_name), h('dt', null, 'Talhão'), h('dd', null, r.plot_name || '—'), h('dt', null, 'Cultura'), h('dd', null, r.plot_crop || '—'),
      h('dt', null, 'Observada em'), h('dd', null, fmt.datetime(r.observed_at)), h('dt', null, 'Área afetada'), h('dd', null, fmt.ha(r.area_affected_ha)), h('dt', null, 'Localização'), h('dd', null, r.lat !== null ? `${r.lat}, ${r.lng}` : 'Não informada'),
      h('dt', null, 'Registrada por'), h('dd', null, r.created_by_name || '—'), h('dt', null, 'Descrição'), h('dd', null, r.description || '—')),
    filesPanel('occurrence', r.id, { canWrite: can('occurrences', 'w'), accept: 'image/*,application/pdf', title: 'Fotos e anexos' }));
  const acts = [];
  if (can('occurrences', 'w') && r.status !== 'resolvida') acts.push(h('button', { class: 'btn primary', onclick: async () => { await api.put(`/api/occurrences/${r.id}`, { status: 'resolvida' }); m.close(); location.reload(); } }, icon('check', 17), 'Marcar como resolvida'));
  const m = modal({ title: r.name, body, size: 'wide', actions: acts });
}
