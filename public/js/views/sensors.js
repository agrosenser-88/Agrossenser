import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, options, modal, errMsg, toast, formModal, confirmDialog, selectOptions, copyText, loading, todayISO } from '../ui.js';
import { icon } from '../icons.js';
import { lineChart, noData } from '../charts.js';
import { crudPage, farmField, plotField, gpsButton } from './shared.js';
import { can } from '../app.js';

export async function render(host) {
  await crudPage(host, {
    endpoint: '/api/sensors', module: 'sensors', entity: 'sensor', title: 'Sensores agrícolas', subtitle: 'Cadastro, limites de alerta e histórico de leituras. Sem sensor conectado, o status é “Aguardando conexão”.', iconName: 'sensor', newLabel: 'Novo sensor', modalSize: 'wide',
    emptyTitle: 'Nenhum sensor cadastrado', emptyText: 'Cadastre um sensor para receber leituras por API (HTTP). Você receberá o identificador e a chave do dispositivo para configurá-lo. Leituras reais só aparecem quando o dispositivo enviar dados.',
    filters: [{ key: 'kind', label: 'Tipo', options: options(L.sensorKind) }, { key: 'status', label: 'Situação', options: options(L.sensorStatus) }],
    defaults: () => ({ kind: 'umidade_solo', unit: '%' }),
    render: (rows, { openForm, remove, reload }) => h('div', { class: 'grid g-auto' }, rows.map((s) => card(s, openForm, remove, reload))),
    fields: (F) => [
      farmField(F), plotField(F), { name: 'name', label: 'Nome do sensor', required: true, maxlength: 120 }, { name: 'kind', label: 'Tipo', type: 'select', options: options(L.sensorKind), required: true },
      { name: 'unit', label: 'Unidade de medida', maxlength: 12, hint: 'Ex.: %, °C, mm, L' }, { name: 'min_limit', label: 'Limite mínimo (alerta)', type: 'number' }, { name: 'max_limit', label: 'Limite máximo (alerta)', type: 'number' },
      { name: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90 }, { name: 'lng', label: 'Longitude', type: 'number', min: -180, max: 180 }, { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ],
    onForm: (fm, row) => {
      const body = fm.el.querySelector('.modal-body form'); body.insertBefore(h('div', { style: { marginTop: '8px' } }, gpsButton({ set: (n, v) => fm.form.set(n, v) })), body.querySelector('.form-error'));
      if (!row) fm.form.inputs.kind.addEventListener('change', () => { const u = { umidade_solo: '%', temperatura: '°C', umidade_ar: '%', chuva: 'mm', irrigacao: 'L', outro: '' }[fm.form.inputs.kind.value]; if (u !== undefined) fm.form.set('unit', u); });
    },
    afterChange: (out) => { if (out && out.api_key) showKey(out); },
    createdHook: true,
  });
}

function showKey(s) {
  modal({ title: 'Credenciais do dispositivo', size: 'wide', body: h('div', { class: 'stack' }, h('div', { class: 'notice warn' }, icon('key', 18), 'Guarde a chave agora: por segurança ela não será exibida novamente. Se perder, gere uma nova.'), keyInfo(s, s.api_key)) });
}
function keyInfo(s, key) {
  const url = `${location.origin}/api/ingest/${s.device_id}`;
  const curl = `curl -X POST ${url} \\\n  -H "Content-Type: application/json" -H "X-Device-Key: ${key}" \\\n  -d '{"value": 23.5}'`;
  const row = (label, val) => h('div', null, h('div', { class: 'tiny muted' }, label), h('div', { class: 'row' }, h('div', { class: 'code', style: { flex: 1 } }, val), h('button', { class: 'btn sm', onclick: () => copyText(val) }, icon('copy', 15), 'Copiar')));
  return h('div', { class: 'stack' }, row('ID do dispositivo', s.device_id), row('Chave de API', key), row('Endereço (POST)', url), h('div', null, h('div', { class: 'tiny muted' }, 'Exemplo de envio de leitura'), h('pre', { class: 'code', style: { whiteSpace: 'pre-wrap', margin: 0 } }, curl)), h('p', { class: 'tiny muted' }, 'Aceita também {"readings":[{"value":12.3,"read_at":"2026-01-31T12:00:00Z"}]}. MQTT: use uma ponte MQTT→HTTP até a integração nativa ser implementada.'));
}

function card(s, openForm, remove, reload) {
  const outside = s.last_value !== null && ((s.min_limit !== null && s.last_value < s.min_limit) || (s.max_limit !== null && s.last_value > s.max_limit));
  return h('div', { class: 'card item-card' },
    h('div', { class: 'top' }, h('div', null, h('h3', null, s.name), h('div', { class: 'small muted' }, `${L.sensorKind[s.kind]} · ${s.farm_name}${s.plot_name ? ' / ' + s.plot_name : ''}`), h('div', { class: 'tiny muted mono' }, s.device_id)),
      h('div', { class: 'row', style: { gap: '2px' } }, can('sensors', 'w') ? iconBtn2('edit', 'Editar', () => openForm(s)) : null, can('sensors', 'd') ? iconBtn2('trash', 'Excluir', () => remove(s), 'danger') : null)),
    h('div', { class: 'row' }, badge(s.status, L.sensorStatus[s.status]), s.demo_readings ? badge('demo', `${s.demo_readings} leituras de demonstração`, 'demo') : null),
    s.real_readings ? h('div', { class: 'mini-stats' }, h('div', null, h('b', { style: { color: outside ? 'var(--crit)' : '' } }, `${fmt.num(s.last_value)} ${s.unit}`), h('span', null, 'Última leitura')), h('div', null, h('b', null, s.min_limit !== null ? fmt.num(s.min_limit) : '—'), h('span', null, 'Mínimo')), h('div', null, h('b', null, s.max_limit !== null ? fmt.num(s.max_limit) : '—'), h('span', null, 'Máximo')))
      : h('div', { class: 'notice' }, icon('info', 18), 'Aguardando conexão: nenhuma leitura real recebida ainda.'),
    s.last_reading_at ? h('div', { class: 'tiny muted' }, `Última leitura real: ${fmt.datetime(s.last_reading_at)}`) : null,
    h('button', { class: 'btn primary sm', onclick: () => detail(s, reload) }, 'Histórico e conexão'));
}
const iconBtn2 = (n, l, f, c = '') => h('button', { class: `btn ghost icon sm ${c}`, title: l, 'aria-label': l, onclick: f }, icon(n, 17));

function detail(s, reload) {
  const box = h('div', { class: 'stack' }); const range = { from: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), to: todayISO(), demo: '1' };
  const m = modal({ title: s.name, size: 'wide', body: box, onClose: reload });
  async function load() {
    clear(box); box.appendChild(loading());
    try {
      const r = await api.get(`/api/sensors/${s.id}/readings${qs(range)}`); clear(box);
      const ctl = h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'De'), h('input', { class: 'input', type: 'date', value: range.from, onchange: (e) => { range.from = e.target.value; load(); } })), h('div', { class: 'field' }, h('label', null, 'Até'), h('input', { class: 'input', type: 'date', value: range.to, onchange: (e) => { range.to = e.target.value; load(); } })),
        h('label', { class: 'check small', style: { paddingBottom: '10px' } }, h('input', { type: 'checkbox', checked: range.demo === '1', onchange: (e) => { range.demo = e.target.checked ? '1' : '0'; load(); } }), 'Incluir dados de demonstração'));
      box.appendChild(ctl);
      const real = r.readings.filter((x) => !x.is_demo); const demo = r.readings.filter((x) => x.is_demo);
      if (!r.readings.length) box.appendChild(noData('Nenhuma leitura no período.'));
      else {
        const labels = r.readings.map((x) => fmt.datetime(x.read_at).slice(0, 16));
        const series = [{ name: 'Leituras reais', values: r.readings.map((x) => (x.is_demo ? null : x.value)) }]; if (demo.length) series.push({ name: 'Demonstração', values: r.readings.map((x) => (x.is_demo ? x.value : null)), color: '#c084fc' });
        box.appendChild(lineChart({ labels, series, format: (n) => fmt.num(n, 1) }));
        if (demo.length) box.appendChild(h('div', { class: 'notice' }, icon('info', 18), 'Os pontos em roxo são dados de DEMONSTRAÇÃO gerados para teste. Eles não representam medições reais e não entram nos relatórios.'));
        box.appendChild(h('p', { class: 'small muted' }, `${real.length} leitura(s) real(is) no período${s.min_limit !== null || s.max_limit !== null ? ` · limites: ${s.min_limit ?? '—'} a ${s.max_limit ?? '—'} ${s.unit}` : ''}.`));
      }
      const acts = h('div', { class: 'row' });
      if (can('sensors', 'w')) acts.append(
        h('button', { class: 'btn', onclick: manual }, icon('plus', 16), 'Leitura manual'),
        h('button', { class: 'btn', onclick: async () => { try { await api.post(`/api/sensors/${s.id}/demo-readings`, { count: 24 }); toast('Leituras de demonstração geradas (identificadas).', 'warn'); load(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'Gerar dados de demonstração'),
        demo.length ? h('button', { class: 'btn', onclick: async () => { await api.del(`/api/sensors/${s.id}/demo-readings`); load(); } }, 'Remover demonstração') : null,
        h('button', { class: 'btn', onclick: async () => { if (await confirmDialog('Gerar nova chave? A chave atual deixará de funcionar.', { confirmLabel: 'Gerar nova chave' })) { try { const k = await api.post(`/api/sensors/${s.id}/rotate-key`); showKey({ device_id: k.device_id, api_key: k.api_key }); } catch (e) { toast(errMsg(e), 'err'); } } } }, icon('key', 16), 'Nova chave'));
      box.appendChild(acts);
      box.appendChild(h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Como conectar o dispositivo'), h('div', { style: { marginTop: '10px' } }, keyInfo(s, '<sua chave>'))));
    } catch (e) { clear(box); box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  function manual() {
    formModal({ title: 'Leitura manual', fields: [{ name: 'value', label: `Valor (${s.unit})`, type: 'number', required: true }, { name: 'read_at', label: 'Data e hora', type: 'datetime' }], values: { read_at: new Date().toISOString() }, onSubmit: async (v) => { await api.post(`/api/sensors/${s.id}/readings`, { value: v.value, read_at: v.read_at || undefined }); toast('Leitura registrada.'); load(); } });
  }
  void m; load();
}
