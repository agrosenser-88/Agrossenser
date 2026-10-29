import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, errMsg, pageHead, formModal, toast, options, selectOptions, loading, nowLocalInput, getGPS, modal } from '../ui.js';
import { icon } from '../icons.js';
import { AgroMap, SEV_COLOR } from '../map.js';
import { can, loadFilters } from '../app.js';
import { filterBar } from './shared.js';

const MACH_COLOR = '#4d8dff'; const SENSOR_COLOR = '#c084fc'; const INSP_COLOR = '#2dd4bf';

export async function render(host) {
  const F = await loadFilters();
  const state = { farm_id: '', crop: '', from: '', to: '', severity: '', status: '' };
  const layers = { plots: true, occurrences: true, inspections: true, machines: true, sensors: true, sprays: true };
  const el = h('div', { class: 'tall' });
  const legend = h('div', { class: 'legend', style: { marginBottom: '10px' } });
  let map; let data = null; let mode = null;

  const sevSel = h('div', { class: 'field' }, h('label', null, 'Gravidade'), h('select', { class: 'input', onchange: (e) => { state.severity = e.target.value; load(); } }, h('option', { value: '' }, 'Todas'), options(L.severity).map((o) => h('option', { value: o.value }, o.label))));
  const stSel = h('div', { class: 'field' }, h('label', null, 'Situação'), h('select', { class: 'input', onchange: (e) => { state.status = e.target.value; load(); } }, h('option', { value: '' }, 'Todas'), options(L.occStatus).map((o) => h('option', { value: o.value }, o.label))));
  const bar = await filterBar(state, load, { plot: false, season: false, extra: [sevSel, stSel] });
  const layerBar = h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'small muted' }, 'Camadas:'),
    [['plots', 'Talhões'], ['occurrences', 'Ocorrências'], ['inspections', 'Inspeções'], ['machines', 'Máquinas'], ['sensors', 'Sensores'], ['sprays', 'Pulverização']].map(([k, label]) =>
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { layers[k] = e.target.checked; paint(false); } }), label)));
  const actions = [];
  if (can('map', 'w')) actions.push(h('button', { class: 'btn', onclick: () => startPick('inspection') }, icon('pin', 17), 'Registrar inspeção'));
  if (can('occurrences', 'w')) actions.push(h('button', { class: 'btn primary', onclick: () => startPick('occurrence') }, icon('bug', 17), 'Registrar foco'));
  host.append(pageHead('Mapa', 'Talhões, pontos de inspeção, focos de pragas e doenças, operações e equipamentos.', actions), bar, layerBar, legend, el);
  map = new AgroMap(el);
  map.addControl('locate', 'Ir para minha posição', async () => { try { const p = await getGPS(); map.setView(p.lat, p.lng, 16); } catch (e) { toast(e.message, 'warn'); } });
  await load();

  async function load() {
    try { data = await api.get(`/api/map${qs(state)}`); } catch (e) { toast(errMsg(e), 'err'); return; }
    paint(true);
  }

  function paint(fit) {
    map.clear(); const pts = [];
    if (layers.plots) data.plots.forEach((p) => { if (!p.boundary) return; map.addShape({ geometry: p.boundary, fill: p.status === 'ativo' ? 'rgba(46,139,70,.38)' : 'rgba(120,130,125,.3)', stroke: p.status === 'ativo' ? '#b6f03a' : '#9aa59f', label: p.name, popup: () => h('div', null, h('h4', null, p.name), h('div', { class: 'small' }, `${p.farm_name}`), h('div', { class: 'small muted' }, `${p.crop || 'Sem cultura'}${p.variety ? ' · ' + p.variety : ''} · ${fmt.ha(p.area_ha)}`), h('div', { style: { marginTop: '6px' } }, badge(p.status, L.plotStatus[p.status]))) }); p.boundary.coordinates[0].forEach((c) => pts.push({ lat: c[1], lng: c[0] })); });
    data.farms.forEach((f) => { if (f.latitude !== null && f.latitude !== undefined) { map.addMarker({ lat: f.latitude, lng: f.longitude, color: '#2e8b46', title: f.name, popup: () => h('div', null, h('h4', null, f.name), h('div', { class: 'small muted' }, [f.city, f.state].filter(Boolean).join(' - ')), h('a', { class: 'btn sm', href: `#/fazendas/${f.id}`, style: { marginTop: '8px' } }, 'Abrir fazenda')) }); pts.push({ lat: f.latitude, lng: f.longitude }); } });
    if (layers.sprays) data.sprays.forEach((s) => { if (s.geo_planned) map.addShape({ geometry: s.geo_planned, fill: 'rgba(77,141,255,.12)', stroke: '#4d8dff', dash: '6 4', popup: () => sprayPopup(s, 'planejada') }); if (s.geo_executed) map.addShape({ geometry: s.geo_executed, fill: 'rgba(182,240,58,.28)', stroke: '#b6f03a', popup: () => sprayPopup(s, 'executada') }); });
    if (layers.occurrences) data.occurrences.forEach((o) => { map.addMarker({ lat: o.lat, lng: o.lng, color: SEV_COLOR[o.severity], title: `${o.name} (${L.severity[o.severity]})`, popup: () => h('div', null, h('h4', null, o.name), h('div', { class: 'small' }, `${o.farm_name}${o.plot_name ? ' / ' + o.plot_name : ''}`), h('div', { class: 'small muted' }, `${L.occCategory[o.category]} · ${fmt.date(o.observed_at)}`), h('div', { class: 'row', style: { marginTop: '8px' } }, badge(o.severity, L.severity[o.severity]), badge(o.status, L.occStatus[o.status])), h('a', { class: 'btn sm', href: '#/pragas', style: { marginTop: '8px' } }, 'Ver ocorrências')) }); pts.push({ lat: o.lat, lng: o.lng }); });
    if (layers.inspections) data.inspections.forEach((i) => { map.addMarker({ lat: i.lat, lng: i.lng, color: INSP_COLOR, dot: true, title: 'Inspeção', popup: () => h('div', null, h('h4', null, 'Ponto de inspeção'), h('div', { class: 'small muted' }, `${fmt.datetime(i.inspected_at)}${i.plot_name ? ' · ' + i.plot_name : ''}`), i.notes ? h('p', { class: 'small', style: { marginTop: '6px' } }, i.notes) : null) }); pts.push({ lat: i.lat, lng: i.lng }); });
    if (layers.machines) data.machines.forEach((m) => { map.addMarker({ lat: m.lat, lng: m.lng, color: MACH_COLOR, dot: true, title: m.name, popup: () => h('div', null, h('h4', null, m.name), h('div', { class: 'small muted' }, `${L.machineKind[m.kind]} · ${L.machineStatus[m.status]}`), h('div', { class: 'tiny muted', style: { marginTop: '6px' } }, `Posição informada manualmente em ${fmt.datetime(m.last_position_at)}. Não é rastreamento em tempo real.`)) }); pts.push({ lat: m.lat, lng: m.lng }); });
    if (layers.sensors) data.sensors.forEach((s) => { map.addMarker({ lat: s.lat, lng: s.lng, color: SENSOR_COLOR, dot: true, title: s.name, popup: () => h('div', null, h('h4', null, s.name), h('div', { class: 'small muted' }, L.sensorKind[s.kind]), h('div', { style: { marginTop: '6px' } }, badge(s.status, L.sensorStatus[s.status]), s.last_value !== null ? h('span', { class: 'small', style: { marginLeft: '8px' } }, `${fmt.num(s.last_value)} ${s.unit}`) : null)) }); pts.push({ lat: s.lat, lng: s.lng }); });
    legend.replaceChildren(...[['Talhão', 'rgba(46,139,70,.8)'], ['Baixa', SEV_COLOR.baixa], ['Média', SEV_COLOR.media], ['Alta', SEV_COLOR.alta], ['Crítica', SEV_COLOR.critica], ['Inspeção', INSP_COLOR], ['Máquina', MACH_COLOR], ['Sensor', SENSOR_COLOR]].map(([t, c]) => h('span', null, h('i', { style: { background: c } }), t)));
    if (fit) { if (!map.fitPoints(pts)) { map.setView(-15.78, -47.93, 4); } }
    map.render();
    if (!pts.length && fit) { map.setHint('Sem dados georreferenciados ainda. Cadastre coordenadas, desenhe talhões ou registre um foco.'); setTimeout(() => map.setHint(null), 6000); }
  }

  function sprayPopup(s, kind) { return h('div', null, h('h4', null, s.product || 'Pulverização'), h('div', { class: 'small muted' }, `Área ${kind} · ${fmt.date(s.op_date)}`), h('div', { class: 'small', style: { marginTop: '6px' } }, `Planejada: ${fmt.ha(s.planned_area_ha)} · Executada: ${fmt.ha(s.executed_area_ha)}`), h('a', { class: 'btn sm', href: '#/pulverizacao', style: { marginTop: '8px' } }, 'Ver operação')); }

  // Seleciona um ponto no mapa (ou GPS) e abre o formulário correspondente.
  function startPick(kind) {
    mode = kind; map.closePopup();
    const hint = map.setHint(kind === 'occurrence' ? 'Toque no mapa onde está o foco' : 'Toque no mapa no ponto de inspeção');
    const cancel = h('button', { class: 'btn sm ghost', onclick: stop }, 'Cancelar'); const gps = h('button', { class: 'btn sm', onclick: async () => { try { const p = await getGPS(); stop(); openForm(kind, p); } catch (e) { toast(e.message, 'warn'); } } }, icon('locate', 15), 'GPS');
    hint.append(gps, cancel);
    map.onClick((ll) => { stop(); openForm(kind, { lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) }); });
    function stop() { mode = null; map.onClick(null); map.setHint(null); }
  }
  function openForm(kind, p) {
    const farms = data.farms.length ? data.farms : F.farms;
    const base = [
      { name: 'farm_id', label: 'Fazenda', type: 'select', required: true, options: selectOptions(F.farms) }, { name: 'plot_id', label: 'Talhão', type: 'select', options: F.plots.map((x) => ({ value: x.id, label: `${x.name}${x.crop ? ' · ' + x.crop : ''}` })) },
    ];
    void farms;
    const geo = [{ name: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90 }, { name: 'lng', label: 'Longitude', type: 'number', min: -180, max: 180 }];
    const fields = kind === 'occurrence'
      ? [...base, { name: 'name', label: 'Praga/doença', required: true, full: true, maxlength: 150, placeholder: 'Ex.: Lagarta-do-cartucho, ferrugem' }, { name: 'category', label: 'Tipo', type: 'select', options: options(L.occCategory), required: true }, { name: 'severity', label: 'Gravidade', type: 'select', options: options(L.severity), required: true }, ...geo, { name: 'observed_at', label: 'Data e hora', type: 'datetime', required: true }, { name: 'area_affected_ha', label: 'Área afetada (ha)', type: 'number', min: 0 }, { name: 'description', label: 'Descrição / sintomas', type: 'textarea', full: true }]
      : [...base, ...geo, { name: 'inspected_at', label: 'Data e hora', type: 'datetime', required: true }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }];
    const values = { ...p, farm_id: state.farm_id || (F.farms.length === 1 ? F.farms[0].id : ''), category: 'praga', severity: 'media', observed_at: new Date().toISOString(), inspected_at: new Date().toISOString() };
    void nowLocalInput;
    const fm = formModal({
      title: kind === 'occurrence' ? 'Registrar foco de praga/doença' : 'Registrar ponto de inspeção', fields, values, size: 'wide',
      onSubmit: async (v) => { const payload = {}; fields.forEach((f) => { payload[f.name] = v[f.name] === '' ? null : v[f.name]; }); await api.post(kind === 'occurrence' ? '/api/occurrences' : '/api/inspections', payload); toast('Registro salvo.'); load(); },
    });
    const f2 = fm.form; const farm = f2.inputs.farm_id; const plot = f2.inputs.plot_id;
    const fill = () => { const cur = plot.value; clear(plot); plot.appendChild(h('option', { value: '' }, '— nenhum —')); F.plots.filter((x) => !farm.value || String(x.farm_id) === farm.value).forEach((x) => plot.appendChild(h('option', { value: x.id, selected: String(x.id) === cur }, `${x.name}${x.crop ? ' · ' + x.crop : ''}`))); };
    farm.addEventListener('change', fill); fill();
  }
  void modal; void loading; void clear;
}
