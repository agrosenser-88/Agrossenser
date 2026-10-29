import { api, qs } from '../api.js';
import { h, clear, fmt, errMsg, pageHead, loading, emptyState, selectOptions, todayISO, badge } from '../ui.js';
import { icon } from '../icons.js';
import { barChart, lineChart, noData } from '../charts.js';
import { loadFilters } from '../app.js';

const DIRS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
const dir = (deg) => (deg === null || deg === undefined ? '—' : `${DIRS[Math.round(deg / 45) % 8]} (${Math.round(deg)}°)`);
const weekday = (d) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(`${d}T12:00:00`).getDay()];

export async function render(host) {
  const F = await loadFilters();
  if (!F.farms.length) { host.append(pageHead('Clima', 'Previsão e histórico por fazenda.'), emptyState({ iconName: 'cloud', title: 'Cadastre uma fazenda com coordenadas', text: 'O clima é consultado pelas coordenadas da fazenda.', action: h('a', { class: 'btn primary', href: '#/fazendas' }, 'Ir para Fazendas') })); return; }
  const st = { farm_id: String(F.farms[0].id), from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: todayISO() };
  const body = h('div', { class: 'stack' });
  const sel = h('div', { class: 'field' }, h('label', null, 'Fazenda'), h('select', { class: 'input', onchange: (e) => { st.farm_id = e.target.value; load(); } }, selectOptions(F.farms).map((o) => h('option', { value: o.value }, o.label))));
  host.append(pageHead('Clima', 'Previsão e histórico meteorológico da propriedade, com alertas para o planejamento agrícola.'), h('div', { class: 'toolbar' }, sel), body);
  await load();

  async function load() {
    clear(body); body.appendChild(loading());
    let w;
    try { w = await api.get(`/api/weather${qs({ farm_id: st.farm_id })}`); } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); return; }
    clear(body);
    if (!w.available) {
      body.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'ico-big' }, icon('cloud', 28)), h('h3', null, 'Dados climáticos indisponíveis'), h('p', null, w.message), w.reason === 'sem_coordenadas' ? h('a', { class: 'btn primary', href: `#/fazendas` }, 'Informar coordenadas') : h('button', { class: 'btn', onclick: load }, icon('refresh', 16), 'Tentar novamente')),
        h('p', { class: 'tiny muted center' }, 'O sistema não exibe valores fictícios quando a fonte meteorológica não responde.')));
      body.appendChild(await history());
      return;
    }
    const c = w.current;
    body.appendChild(h('div', { class: 'grid g4' },
      tile('thermo', 'Temperatura', c.temperature !== null ? `${fmt.num(c.temperature, 1)} °C` : '—', `Agora · ${w.farm.name}`), tile('drop', 'Umidade relativa', c.humidity !== null ? `${fmt.num(c.humidity, 0)}%` : '—', 'Ar a 2 m'),
      tile('cloud', 'Precipitação', c.precipitation !== null ? `${fmt.num(c.precipitation, 1)} mm` : '—', 'Hora atual'), tile('wind', 'Vento', c.wind_speed !== null ? `${fmt.num(c.wind_speed, 0)} km/h` : '—', `Direção ${dir(c.wind_dir)}`)));
    body.appendChild(h('p', { class: 'tiny muted' }, `Fonte: ${w.source} (modelo de previsão para as coordenadas da fazenda; não é medição de estação local). Atualizado ${fmt.ago(w.fetched_at)}.`));
    if (w.alerts.length) body.appendChild(h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Alertas para o planejamento'), h('div', { class: 'stack', style: { gap: '8px' } }, w.alerts.map((a) => h('div', { class: `notice ${a.level === 'info' ? '' : 'warn'}` }, icon(a.level === 'info' ? 'info' : 'alert', 18), h('div', null, h('b', null, a.title), h('div', { class: 'small muted' }, a.detail)))))));
    else body.appendChild(h('div', { class: 'notice ok' }, icon('check', 18), 'Sem alertas meteorológicos relevantes para os próximos 3 dias.'));
    body.appendChild(h('div', { class: 'card' }, h('h2', { style: { marginBottom: '12px' } }, 'Previsão para 7 dias'), h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '10px' } }, w.daily.map((d) => h('div', { class: 'card flat', style: { padding: '12px', textAlign: 'center' } }, h('div', { class: 'tiny muted' }, `${weekday(d.date)} ${fmt.date(d.date).slice(0, 5)}`), h('div', { style: { fontWeight: 700, margin: '6px 0' } }, `${d.tmax !== null ? Math.round(d.tmax) : '—'}° / ${d.tmin !== null ? Math.round(d.tmin) : '—'}°`), h('div', { class: 'small' }, `${fmt.num(d.precip_sum, 1)} mm`), h('div', { class: 'tiny muted' }, d.precip_prob !== null ? `${d.precip_prob}% chuva` : ''), h('div', { class: 'tiny muted' }, d.wind_max !== null ? `vento ${Math.round(d.wind_max)} km/h` : ''))))));
    body.appendChild(h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, 'Precipitação prevista (mm)'), barChart({ labels: w.daily.map((d) => fmt.date(d.date).slice(0, 5)), series: [{ name: 'mm', values: w.daily.map((d) => d.precip_sum || 0) }], height: 190, format: (n) => fmt.num(n, 1) })),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, 'Temperatura prevista (°C)'), lineChart({ labels: w.daily.map((d) => fmt.date(d.date).slice(0, 5)), series: [{ name: 'Máxima', values: w.daily.map((d) => d.tmax), color: 'var(--chart-3)' }, { name: 'Mínima', values: w.daily.map((d) => d.tmin), color: 'var(--chart-2)' }], height: 190, format: (n) => fmt.num(n, 0) }))));
    body.appendChild(await history());
    body.appendChild(h('div', { class: 'notice' }, icon('info', 18), 'Integração futura: estações meteorológicas e sensores IoT locais (módulo Sensores) poderão complementar estes dados.'));
  }

  function tile(ico, label, value, sub) { const i = icon(ico, 22); i.setAttribute('class', 'ico'); return h('div', { class: 'card stat', style: { cursor: 'default' } }, i, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub)); }

  async function history() {
    const box = h('div', { class: 'card' }); const chart = h('div');
    const load2 = async () => {
      clear(chart); chart.appendChild(loading());
      try {
        const r = await api.get(`/api/weather/history${qs({ farm_id: st.farm_id, from: st.from, to: st.to })}`); clear(chart);
        if (!r.available) { chart.appendChild(h('div', { class: 'notice warn' }, icon('info', 18), r.message)); return; }
        if (!r.days.length) { chart.appendChild(noData('Sem dados no período.')); return; }
        const labels = r.days.map((d) => fmt.date(d.date).slice(0, 5)); const tot = r.days.reduce((a, d) => a + (d.precip_sum || 0), 0);
        chart.append(h('p', { class: 'tiny muted' }, `Fonte: ${r.source}${r.partial ? ' — dados parciais' : ''}. Chuva acumulada no período: ${fmt.num(tot, 1)} mm.`), barChart({ labels, series: [{ name: 'Chuva diária (mm)', values: r.days.map((d) => d.precip_sum || 0) }], height: 200, format: (n) => fmt.num(n, 1) }), lineChart({ labels, series: [{ name: 'Máxima (°C)', values: r.days.map((d) => d.tmax), color: 'var(--chart-3)' }, { name: 'Mínima (°C)', values: r.days.map((d) => d.tmin), color: 'var(--chart-2)' }], height: 200, format: (n) => fmt.num(n, 0) }));
      } catch (e) { clear(chart); chart.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
    };
    box.append(h('div', { class: 'card-head' }, h('h2', null, 'Histórico climático'), h('div', { class: 'row' }, h('input', { class: 'input', type: 'date', value: st.from, 'aria-label': 'De', onchange: (e) => { st.from = e.target.value; load2(); } }), h('input', { class: 'input', type: 'date', value: st.to, 'aria-label': 'Até', onchange: (e) => { st.to = e.target.value; load2(); } }))), chart);
    load2(); void badge; return box;
  }
}
