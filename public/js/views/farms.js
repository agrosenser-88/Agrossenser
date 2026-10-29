import { api, qs } from '../api.js';
import { h, clear, fmt, L, STATES, badge, loading, errMsg, pageHead, emptyState, formModal, modal, table, iconBtn, toast, confirmDialog, tabs, options, selectOptions, todayISO } from '../ui.js';
import { icon } from '../icons.js';
import { AgroMap, polygonAreaHa, polygonCenter } from '../map.js';
import { can, loadFilters, navigate } from '../app.js';
import { filesPanel, gpsButton } from './shared.js';

export async function render(host, { params }) {
  if (params[0]) return detail(host, Number(params[0]), params[1]);
  return list(host);
}

const farmFields = [
  { name: 'name', label: 'Nome da fazenda', required: true, full: true, maxlength: 120 },
  { name: 'owner_name', label: 'Proprietário', maxlength: 120 },
  { name: 'city', label: 'Município', maxlength: 100 },
  { name: 'state', label: 'Estado (UF)', type: 'select', options: STATES.map((s) => ({ value: s, label: s })) },
  { name: 'area_ha', label: 'Área total (ha)', type: 'number', min: 0 },
  { name: 'latitude', label: 'Latitude', type: 'number', min: -90, max: 90, hint: 'Ex.: -15.793889. Usada para o clima e o mapa.' },
  { name: 'longitude', label: 'Longitude', type: 'number', min: -180, max: 180 },
  { name: 'notes', label: 'Observações', type: 'textarea', full: true },
];

async function list(host) {
  const canW = can('farms', 'w');
  const body = h('div');
  const openForm = (row) => {
    const fm = formModal({
      title: row ? 'Editar fazenda' : 'Nova fazenda', fields: farmFields, values: row || {}, size: 'wide',
      extra: h('div', { class: 'row', style: { marginTop: '10px' } }, gpsButton({ set: (n, v) => fm.form.set(n, v) }, 'latitude', 'longitude'), h('span', { class: 'tiny muted' }, 'Use o GPS do celular quando estiver na sede, ou informe as coordenadas manualmente.')),
      onSubmit: async (v) => {
        const payload = {}; farmFields.forEach((f) => { payload[f.name] = v[f.name] === '' ? null : v[f.name]; });
        if (row) await api.put(`/api/farms/${row.id}`, payload); else await api.post('/api/farms', payload);
        toast(row ? 'Fazenda atualizada.' : 'Fazenda cadastrada.'); await loadFilters(true); load();
      },
    });
  };
  const remove = async (f) => {
    const m = modal({ title: 'Excluir fazenda', size: 'narrow', body: null });
    m.close();
    const name = f.name; let box;
    const mm = formModal({
      title: 'Excluir fazenda', submitLabel: 'Excluir definitivamente', fields: [{ name: 'confirm', label: `Digite "${name}" para confirmar`, required: true, full: true }],
      intro: 'Serão apagados todos os talhões, ocorrências, operações, custos e arquivos desta fazenda. Esta ação não pode ser desfeita.',
      onSubmit: async (v) => { if (v.confirm !== name) throw new Error('O nome digitado não confere.'); await api.del(`/api/farms/${f.id}${qs({ confirm: name })}`); toast('Fazenda excluída.'); await loadFilters(true); load(); },
    }); void box; void mm;
  };
  async function load() {
    clear(body); body.appendChild(loading());
    try {
      const farms = await api.get('/api/farms');
      clear(body);
      if (!farms.length) { body.appendChild(emptyState({ iconName: 'farm', title: 'Nenhuma fazenda cadastrada', text: 'Cadastre a primeira fazenda para começar a registrar talhões, ocorrências e operações.', action: canW ? h('button', { class: 'btn primary', onclick: () => openForm() }, icon('plus', 17), 'Cadastrar fazenda') : null })); return; }
      body.appendChild(h('div', { class: 'grid g-auto' }, farms.map((f) => h('div', { class: 'card item-card' },
        h('div', { class: 'top' }, h('div', null, h('h3', null, f.name), h('div', { class: 'small muted' }, [f.city, f.state].filter(Boolean).join(' - ') || 'Localização não informada'), f.owner_name ? h('div', { class: 'tiny muted' }, `Proprietário: ${f.owner_name}`) : null),
          h('div', { class: 'row', style: { gap: '2px' } }, canW ? iconBtn('edit', 'Editar', () => openForm(f)) : null, can('farms', 'd') ? iconBtn('trash', 'Excluir', () => remove(f), 'danger') : null)),
        h('div', { class: 'mini-stats' }, h('div', null, h('b', null, fmt.ha(f.area_ha)), h('span', null, 'Área total')), h('div', null, h('b', null, f.plot_count), h('span', null, 'Talhões')), h('div', null, h('b', { style: { color: f.open_occurrences ? 'var(--warn)' : '' } }, f.open_occurrences), h('span', null, 'Ocorrências'))),
        h('div', { class: 'row' }, h('a', { class: 'btn primary sm', href: `#/fazendas/${f.id}` }, 'Abrir fazenda'), h('a', { class: 'btn sm', href: `#/mapa` }, icon('map', 15), 'Mapa'))))));
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  host.append(pageHead('Fazendas', 'Propriedades rurais e seus talhões.', canW && can('farms', 'w') ? h('button', { class: 'btn primary', onclick: () => openForm() }, icon('plus', 17), 'Nova fazenda') : null), body);
  await load();
}

async function detail(host, id, tabKey = 'talhoes') {
  let farm;
  try { farm = await api.get(`/api/farms/${id}`); } catch (e) { host.appendChild(emptyState({ iconName: 'farm', title: 'Fazenda não encontrada', text: errMsg(e), action: h('a', { class: 'btn', href: '#/fazendas' }, 'Voltar') })); return; }
  const canW = can('plots', 'w');
  const content = h('div');
  host.append(pageHead(farm.name, [farm.city, farm.state].filter(Boolean).join(' - ') || 'Localização não informada', h('a', { class: 'btn', href: '#/fazendas' }, '← Fazendas')),
    h('div', { class: 'grid g4', style: { marginBottom: '16px' } },
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Área total'), h('div', { class: 'value' }, fmt.ha(farm.area_ha)), h('div', { class: 'sub' }, `${fmt.ha(farm.plots_area_ha)} em talhões`)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Talhões'), h('div', { class: 'value' }, farm.plot_count)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Ocorrências em aberto'), h('div', { class: `value` }, farm.open_occurrences)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Proprietário'), h('div', { class: 'value', style: { fontSize: '1.15rem' } }, farm.owner_name || '—'), h('div', { class: 'sub' }, farm.latitude !== null ? `${farm.latitude}, ${farm.longitude}` : 'Sem coordenadas'))),
    tabs([{ key: 'talhoes', label: 'Talhões' }, { key: 'documentos', label: 'Documentos e imagens' }, { key: 'historico', label: 'Histórico' }], tabKey, (k) => show(k)), content);

  async function show(k) {
    clear(content);
    if (k === 'talhoes') return plotsTab(content, farm);
    if (k === 'documentos') { content.appendChild(h('div', { class: 'card' }, filesPanel('farm', farm.id, { canWrite: can('farms', 'w'), accept: 'image/*,application/pdf,.csv,.txt,.docx,.xlsx', title: 'Documentos e imagens da fazenda' }), farm.notes ? h('div', { style: { marginTop: '16px' } }, h('h4', { class: 'muted' }, 'Observações'), h('p', null, farm.notes)) : null)); return; }
    content.appendChild(loading());
    try {
      const rows = await api.get(`/api/farms/${farm.id}/history`); clear(content);
      content.appendChild(h('div', { class: 'card' }, rows.length ? h('div', { class: 'timeline' }, rows.map((r) => h('div', null, h('time', null, fmt.datetime(r.created_at)), h('div', null, h('b', null, r.username || 'Sistema'), ` — ${r.summary || r.action}`)))) : h('p', { class: 'muted' }, 'Nenhuma atividade registrada nesta fazenda.')));
    } catch (e) { clear(content); content.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  await show(tabKey);

  async function plotsTab(box, farm) {
    clear(box); box.appendChild(loading());
    let plots;
    try { plots = await api.get(`/api/plots${qs({ farm_id: farm.id })}`); } catch (e) { clear(box); box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); return; }
    clear(box);
    const head = h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h2', { style: { flex: 1 } }, 'Talhões'), canW ? h('button', { class: 'btn primary', onclick: () => plotForm(farm, null, () => plotsTab(box, farm)) }, icon('plus', 17), 'Novo talhão') : null);
    box.appendChild(head);
    if (!plots.length) { box.appendChild(emptyState({ iconName: 'leaf', title: 'Nenhum talhão cadastrado', text: 'Cadastre os talhões com cultura, safra e limites desenhados no mapa.', action: canW ? h('button', { class: 'btn primary', onclick: () => plotForm(farm, null, () => plotsTab(box, farm)) }, icon('plus', 17), 'Novo talhão') : null })); return; }
    box.appendChild(table([
      { label: 'Talhão', render: (p) => h('b', null, p.name) }, { label: 'Cultura', render: (p) => [p.crop || '—', p.variety ? h('div', { class: 'tiny muted' }, p.variety) : null] },
      { label: 'Safra', key: 'season' }, { label: 'Área', num: true, render: (p) => fmt.ha(p.area_ha) }, { label: 'Plantio', render: (p) => fmt.date(p.planting_date) },
      { label: 'Colheita prev.', render: (p) => fmt.date(p.harvest_forecast) }, { label: 'Situação', render: (p) => badge(p.status, L.plotStatus[p.status]) },
      { label: 'Limites', render: (p) => (p.boundary ? badge('ok', 'Definidos', 'ok') : badge('x', 'Sem limites', 'neutral')) },
    ], plots, {
      onRow: (p) => plotDetail(p, () => plotsTab(box, farm)),
      actions: (p) => [iconBtn('eye', 'Detalhes', () => plotDetail(p, () => plotsTab(box, farm))), canW ? iconBtn('edit', 'Editar', () => plotForm(farm, p, () => plotsTab(box, farm))) : null,
        can('plots', 'd') ? iconBtn('trash', 'Excluir', async () => { if (await confirmDialog(`Excluir o talhão "${p.name}"? Registros vinculados perderão a referência ao talhão.`, { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`/api/plots/${p.id}`); toast('Talhão excluído.'); await loadFilters(true); plotsTab(box, farm); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger') : null],
    }));
  }
}

function plotDetail(p, reload) {
  const body = h('div', { class: 'stack' });
  body.append(h('dl', { class: 'kv' }, h('dt', null, 'Fazenda'), h('dd', null, p.farm_name), h('dt', null, 'Cultura'), h('dd', null, `${p.crop || '—'}${p.variety ? ' · ' + p.variety : ''}`), h('dt', null, 'Safra'), h('dd', null, p.season || '—'), h('dt', null, 'Área'), h('dd', null, fmt.ha(p.area_ha)),
    h('dt', null, 'Plantio'), h('dd', null, fmt.date(p.planting_date)), h('dt', null, 'Colheita prevista'), h('dd', null, fmt.date(p.harvest_forecast)), h('dt', null, 'Situação'), h('dd', null, badge(p.status, L.plotStatus[p.status])), h('dt', null, 'Observações'), h('dd', null, p.notes || '—')));
  if (p.boundary) { const el = h('div', { style: { height: '260px' } }); body.appendChild(el); setTimeout(() => { const m = new AgroMap(el); m.addShape({ geometry: p.boundary, fill: 'rgba(46,139,70,.35)', stroke: '#b6f03a' }); m.fitPoints(p.boundary.coordinates[0].map((c) => ({ lat: c[1], lng: c[0] })), { maxZoom: 17 }); m.render(); }, 30); }
  body.appendChild(filesPanel('plot', p.id, { canWrite: can('plots', 'w'), accept: 'image/*,application/pdf,.csv,.txt,.docx,.xlsx', title: 'Documentos e imagens do talhão' }));
  modal({ title: `Talhão ${p.name}`, body, size: 'wide' }); void reload;
}

function plotForm(farm, row, done) {
  const fields = [
    { name: 'name', label: 'Nome do talhão', required: true, maxlength: 120 }, { name: 'crop', label: 'Cultura', maxlength: 80, placeholder: 'Ex.: Soja, milho, café' },
    { name: 'variety', label: 'Variedade', maxlength: 80 }, { name: 'season', label: 'Safra', maxlength: 20, placeholder: 'Ex.: 2025/26' },
    { name: 'area_ha', label: 'Área (ha)', type: 'number', min: 0, hint: 'Se desenhar o limite no mapa, a área calculada pode ser aplicada.' }, { name: 'status', label: 'Situação', type: 'select', options: options(L.plotStatus), required: true },
    { name: 'planting_date', label: 'Data de plantio', type: 'date' }, { name: 'harvest_forecast', label: 'Previsão de colheita', type: 'date' },
    { name: 'notes', label: 'Observações', type: 'textarea', full: true },
  ];
  let boundary = row && row.boundary ? row.boundary : null;
  const info = h('span', { class: 'small muted' }, boundary ? 'Limites definidos.' : 'Sem limites definidos.');
  const extra = h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { type: 'button', class: 'btn', onclick: () => drawBoundary(farm, boundary, (g) => { boundary = g; info.textContent = g ? `Limites definidos (~${fmt.num(polygonAreaHa(g))} ha).` : 'Sem limites definidos.'; if (g && !fm.form.read().area_ha) fm.form.set('area_ha', Math.round(polygonAreaHa(g) * 100) / 100); }) }, icon('polygon', 17), boundary ? 'Editar limites no mapa' : 'Desenhar limites no mapa'), info);
  const fm = formModal({
    title: row ? 'Editar talhão' : 'Novo talhão', fields, values: { status: 'ativo', ...(row || {}) }, size: 'wide', extra,
    onSubmit: async (v) => {
      const payload = { farm_id: farm.id, boundary }; fields.forEach((f) => { payload[f.name] = v[f.name] === '' ? null : v[f.name]; });
      if (row) await api.put(`/api/plots/${row.id}`, payload); else await api.post('/api/plots', payload);
      toast('Talhão salvo.'); await loadFilters(true); done();
    },
  });
}

// Desenho de limites: clique para adicionar vértices; “Concluir” fecha o polígono.
function drawBoundary(farm, current, onDone) {
  const el = h('div', { style: { height: '56vh', minHeight: '340px' } });
  const counter = h('span', { class: 'small' }, '0 pontos');
  const m0 = modal({ title: 'Desenhar limites do talhão', size: 'wide', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Toque ou clique no mapa para marcar os vértices ao redor do talhão (mínimo de 3 pontos). Use o GPS caminhando pelo perímetro ou marque sobre a imagem.'), el, h('div', { class: 'row' }, counter)),
    actions: [h('button', { class: 'btn', onclick: () => m0.close() }, 'Cancelar'), current ? h('button', { class: 'btn danger', onclick: () => { onDone(null); m0.close(); } }, 'Remover limites') : null, h('button', { class: 'btn', onclick: () => map.undoDraw() }, 'Desfazer ponto'),
      h('button', { class: 'btn primary', onclick: () => { const g = map.finishDraw(); if (!g) { toast('Marque pelo menos 3 pontos.', 'warn'); map.startDraw((n) => { counter.textContent = `${n} pontos`; }); return; } onDone(g); m0.close(); } }, 'Concluir')] });
  let map;
  setTimeout(() => {
    map = new AgroMap(el); if (current) { map.addShape({ geometry: current, fill: 'rgba(255,255,255,.12)', stroke: '#fff', dash: '5 4' }); map.fitPoints(current.coordinates[0].map((c) => ({ lat: c[1], lng: c[0] })), { maxZoom: 17 }); } else if (farm.latitude !== null) map.setView(farm.latitude, farm.longitude, 15); else map.setView(-15.78, -47.93, 5);
    map.startDraw((n) => { counter.textContent = `${n} ponto${n === 1 ? '' : 's'}`; });
    map.addControl('locate', 'Ir para minha posição', async () => { try { const { getGPS } = await import('../ui.js'); const p = await getGPS(); map.setView(p.lat, p.lng, 17); } catch (e) { toast(e.message, 'warn'); } });
  }, 40);
}
