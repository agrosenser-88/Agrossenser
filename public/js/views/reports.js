import { api, qs, download } from '../api.js';
import { h, clear, fmt, errMsg, pageHead, loading, toast, table, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { barChart, lineChart, noData } from '../charts.js';
import { filterBar } from './shared.js';

export async function render(host) {
  let list = [];
  try { list = await api.get('/api/reports'); } catch (e) { host.appendChild(h('div', { class: 'form-error' }, errMsg(e))); return; }
  if (!list.length) { host.appendChild(emptyState({ iconName: 'chart', title: 'Sem relatórios disponíveis', text: 'Seu perfil não tem acesso a relatórios.' })); return; }
  const today = new Date(Date.now() - 3 * 3600e3); const iso = (d) => d.toISOString().slice(0, 10);
  const st = { type: list[0].key, farm_id: '', plot_id: '', crop: '', season: '', from: iso(new Date(today - 90 * 864e5)), to: iso(today),
    a_from: iso(new Date(today - 60 * 864e5)), a_to: iso(new Date(today - 31 * 864e5)), b_from: iso(new Date(today - 30 * 864e5)), b_to: iso(today) };
  const out = h('div', { class: 'stack' }); const cmpBox = h('div', { class: 'card hidden' });
  const typeSel = h('div', { class: 'field' }, h('label', null, 'Relatório'), h('select', { class: 'input', onchange: (e) => { st.type = e.target.value; cmpBox.classList.toggle('hidden', st.type !== 'comparativo'); run(); } }, list.map((r) => h('option', { value: r.key }, r.title))));
  const bar = await filterBar(st, run, { extra: [] });
  const dateIn = (label, key) => h('div', { class: 'field' }, h('label', null, label), h('input', { class: 'input', type: 'date', value: st[key], onchange: (e) => { st[key] = e.target.value; run(); } }));
  cmpBox.append(h('h3', { style: { marginBottom: '10px' } }, 'Períodos a comparar'), h('div', { class: 'toolbar' }, dateIn('A: de', 'a_from'), dateIn('A: até', 'a_to'), dateIn('B: de', 'b_from'), dateIn('B: até', 'b_to')));
  const exp = (fmtName) => h('button', { class: 'btn', onclick: async () => { try { await download(`/api/reports/${st.type}${qs({ ...params(), format: fmtName })}`, `relatorio.${fmtName}`); } catch (e) { toast(errMsg(e), 'err'); } } }, icon('download', 16), fmtName.toUpperCase());
  host.append(pageHead('Relatórios', 'Análises calculadas a partir dos dados registrados, com filtros e exportação.', exp('pdf'), exp('csv')), h('div', { class: 'toolbar' }, typeSel), bar, cmpBox, out);

  function params() { const p = { ...st }; delete p.type; if (st.type !== 'comparativo') { delete p.a_from; delete p.a_to; delete p.b_from; delete p.b_to; } return p; }
  async function run() {
    clear(out); out.appendChild(loading());
    try {
      const r = await api.get(`/api/reports/${st.type}${qs(params())}`); clear(out);
      if (r.summary && r.summary.length) out.appendChild(h('div', { class: 'grid g4' }, r.summary.map((s) => h('div', { class: 'card stat', style: { cursor: 'default' } }, h('div', { class: 'label' }, s.label), h('div', { class: 'value', style: { fontSize: String(s.value).length > 18 ? '1rem' : '1.5rem' } }, s.value)))));
      if (r.chart) out.appendChild(h('div', { class: 'card' }, h('h3', { style: { marginBottom: '8px' } }, r.chart.title), r.chart.labels.length ? (r.chart.type === 'line' ? lineChart({ labels: r.chart.labels, series: [{ name: r.chart.title, values: r.chart.values }], format: (n) => fmt.num(n, 1) }) : barChart({ labels: r.chart.labels, series: [{ name: r.chart.title, values: r.chart.values }], format: (n) => fmt.num(n, 1) })) : noData()));
      out.appendChild(h('div', { class: 'card flat' }, h('div', { class: 'row small muted' }, `${r.rows.length} linha(s) · ${r.title}`)));
      out.appendChild(table(r.columns.map((label, i) => ({ label, render: (row) => row[i] })), r.rows, { empty: 'Nenhum registro encontrado para os filtros selecionados.' }));
    } catch (e) { clear(out); out.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  await run();
}
