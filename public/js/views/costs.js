import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, options, errMsg, pageHead, loading, tabs, todayISO, selectOptions, toast, formModal, confirmDialog, table, iconBtn, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { donut, barChart, color, noData } from '../charts.js';
import { crudPage, farmField, plotField, filterBar } from './shared.js';
import { can } from '../app.js';

export async function render(host) {
  const content = h('div'); let cur = 'resumo';
  host.append(pageHead('Custos e economia', 'Custos operacionais, produtividade e economia calculada com base em valores de referência reais.'),
    tabs([{ key: 'resumo', label: 'Resumo e economia' }, { key: 'custos', label: 'Lançamentos de custo' }, { key: 'refs', label: 'Custos de referência' }, { key: 'colheitas', label: 'Colheitas e produtividade' }], cur, (k) => { cur = k; show(); }), content);
  show();
  async function show() {
    clear(content);
    if (cur === 'resumo') return summary();
    if (cur === 'custos') return crudPage(content, { endpoint: '/api/costs', module: 'costs', entity: 'custo', title: 'Lançamentos de custo', iconName: 'coins', newLabel: 'Novo custo', periodFilter: true, modalSize: 'wide', filters: [{ key: 'category', label: 'Categoria', options: options(L.cost) }], defaults: () => ({ cost_date: todayISO(), category: 'insumos' }),
      emptyTitle: 'Nenhum custo lançado', emptyText: 'Registre custos de insumos, combustível, manutenção, serviços e demais gastos para acompanhar o custo por hectare.',
      columns: [{ label: 'Data', render: (r) => fmt.date(r.cost_date) }, { label: 'Descrição', render: (r) => [h('b', null, r.description), r.plot_name ? h('div', { class: 'tiny muted' }, r.plot_name) : null] }, { label: 'Categoria', render: (r) => L.cost[r.category] }, { label: 'Fazenda', key: 'farm_name' }, { label: 'Valor', num: true, render: (r) => fmt.money(r.amount) }],
      fields: (F) => [farmField(F), plotField(F), { name: 'category', label: 'Categoria', type: 'select', options: options(L.cost), required: true }, { name: 'cost_date', label: 'Data', type: 'date', required: true }, { name: 'description', label: 'Descrição', required: true, full: true, maxlength: 200 }, { name: 'amount', label: 'Valor (R$)', type: 'number', min: 0, required: true }, { name: 'area_ha', label: 'Área atendida (ha)', type: 'number', min: 0, hint: 'Opcional' }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }] });
    if (cur === 'refs') return crudPage(content, { endpoint: '/api/cost-references', module: 'costs', entity: 'custo de referência', title: 'Custos de referência', subtitle: 'Valores por hectare usados para calcular a economia real (ex.: média histórica, orçamento, método anterior).', iconName: 'coins', newLabel: 'Nova referência', modalSize: 'wide', searchable: false,
      emptyTitle: 'Nenhuma referência cadastrada', emptyText: 'Cadastre quanto custava por hectare antes (ou o orçamento previsto). A economia só é calculada quando há referência e dados reais suficientes.',
      columns: [{ label: 'Referência', render: (r) => h('b', null, r.label) }, { label: 'Categoria', render: (r) => (r.category ? L.cost[r.category] : 'Todos os custos') }, { label: 'Fazenda', render: (r) => r.farm_name || 'Todas' }, { label: 'R$/ha', num: true, render: (r) => fmt.money(r.cost_per_ha) }, { label: 'Vigência desde', render: (r) => fmt.date(r.valid_from) }],
      fields: (F) => [{ name: 'label', label: 'Nome da referência', required: true, full: true, maxlength: 150, placeholder: 'Ex.: Custo médio por ha — safra anterior' }, { name: 'category', label: 'Categoria', type: 'select', options: options(L.cost), hint: 'Vazio = todos os custos' }, { name: 'farm_id', label: 'Fazenda', type: 'select', options: selectOptions(F.farms), hint: 'Vazio = todas' }, { name: 'cost_per_ha', label: 'Custo de referência (R$/ha)', type: 'number', required: true, min: 0.01 }, { name: 'valid_from', label: 'Vigência desde', type: 'date' }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }] });
    return crudPage(content, { endpoint: '/api/harvests', module: 'costs', entity: 'colheita', title: 'Colheitas e produtividade', iconName: 'leaf', newLabel: 'Registrar colheita', periodFilter: true, modalSize: 'wide', defaults: () => ({ unit: 'sc' }),
      emptyTitle: 'Nenhuma colheita registrada', emptyText: 'Informe a produção (e a receita, se quiser) por safra e talhão para acompanhar a produtividade.',
      columns: [{ label: 'Safra', key: 'season' }, { label: 'Fazenda / talhão', render: (r) => [h('b', null, r.farm_name), r.plot_name ? h('div', { class: 'tiny muted' }, r.plot_name) : null] }, { label: 'Cultura', render: (r) => r.crop || '—' }, { label: 'Área', num: true, render: (r) => fmt.ha(r.effective_area_ha) }, { label: 'Produção', num: true, render: (r) => (r.quantity !== null ? `${fmt.num(r.quantity)} ${r.unit}` : '—') }, { label: 'Produtividade', num: true, render: (r) => (r.productivity !== null ? `${fmt.num(r.productivity)} ${r.unit}/ha` : '—') }, { label: 'Receita', num: true, render: (r) => fmt.money(r.revenue) }],
      fields: (F) => [farmField(F), plotField(F), { name: 'season', label: 'Safra', required: true, maxlength: 20, placeholder: '2025/26' }, { name: 'crop', label: 'Cultura', maxlength: 80 }, { name: 'area_ha', label: 'Área colhida (ha)', type: 'number', min: 0, hint: 'Se vazio, usa a área do talhão.' }, { name: 'quantity', label: 'Produção total', type: 'number', min: 0 }, { name: 'unit', label: 'Unidade', type: 'select', options: [['sc', 'sacas (sc)'], ['kg', 'quilos (kg)'], ['t', 'toneladas (t)'], ['@', 'arrobas (@)'], ['cx', 'caixas (cx)']].map(([value, label]) => ({ value, label })), required: true }, { name: 'revenue', label: 'Receita (R$)', type: 'number', min: 0 }, { name: 'harvest_date', label: 'Data da colheita', type: 'date' }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }] });
  }

  async function summary() {
    const st = { farm_id: '', plot_id: '', from: '', to: '' }; const body = h('div', { class: 'stack' });
    const bar = await filterBar(st, load, { crop: false, season: false });
    content.append(bar, body); await load();
    async function load() {
      clear(body); body.appendChild(loading());
      try {
        const e = await api.get(`/api/economy${qs(st)}`); clear(body);
        body.appendChild(h('div', { class: 'grid g3' }, stat('Custo total', fmt.money(e.total), 'no período selecionado'), stat('Área considerada', fmt.ha(e.area_ha), 'soma da área dos talhões do filtro'), stat('Custo por hectare', e.per_ha !== null ? fmt.money(e.per_ha) : '—', e.per_ha === null ? 'Cadastre custos e a área dos talhões' : 'custo total ÷ área')));
        body.appendChild(h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Custos por categoria'), e.by_category.length ? donut({ items: e.by_category.map((c, i) => ({ label: c.label, value: c.amount, color: color(i) })), format: (n) => fmt.money(n), center: '' }) : noData('Sem custos no período.')),
          h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Custo por hectare (R$/ha)'), e.by_category.some((c) => c.per_ha !== null) ? barChart({ labels: e.by_category.map((c) => c.label), series: [{ name: 'R$/ha', values: e.by_category.map((c) => c.per_ha || 0) }], format: (n) => fmt.num(n, 0), height: 220 }) : noData('Informe a área dos talhões para calcular.'))));
        body.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Economia em relação à referência')), h('p', { class: 'small muted', style: { marginBottom: '12px' } }, e.formula),
          e.comparisons.length ? table([{ label: 'Referência', render: (c) => [h('b', null, c.label), h('div', { class: 'tiny muted' }, c.category_label)] }, { label: 'Referência (R$/ha)', num: true, render: (c) => fmt.money(c.reference_per_ha) }, { label: 'Atual (R$/ha)', num: true, render: (c) => (c.current_per_ha === null ? '—' : fmt.money(c.current_per_ha)) },
            { label: 'Economia', num: true, render: (c) => (c.savings_pct === null ? h('span', { class: 'tiny muted' }, 'dados insuficientes') : h('b', { style: { color: c.savings_pct >= 0 ? 'var(--ok)' : 'var(--crit)' } }, `${fmt.num(c.savings_pct, 1)}%`)) }, { label: 'Economia (R$)', num: true, render: (c) => (c.savings_total === null ? '—' : fmt.money(c.savings_total)) }], e.comparisons)
            : h('div', { class: 'notice' }, icon('info', 18), 'Cadastre custos de referência (aba “Custos de referência”) para calcular a economia real. O sistema não presume percentuais de economia.')));
        body.appendChild(scenarios(e));
      } catch (er) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(er))); }
    }
    function stat(l, v, s) { return h('div', { class: 'card stat', style: { cursor: 'default' } }, h('div', { class: 'label' }, l), h('div', { class: 'value' }, v), h('div', { class: 'sub' }, s)); }
  }
}

// Cenários ILUSTRATIVOS (metas), claramente separados dos resultados reais.
function scenarios(e) {
  const input = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: 10, style: { maxWidth: '110px' } }); const out = h('div', { class: 'big' });
  const paint = () => { clear(out); const g = Math.min(100, Math.max(0, Number(input.value) || 0)); if (!e.total) { out.appendChild(h('span', { class: 'muted small' }, 'Lance custos para simular.')); return; } out.appendChild(h('span', null, `Meta de ${fmt.num(g, 0)}% de redução sobre ${fmt.money(e.total)} = `, h('b', null, fmt.money((e.total * g) / 100)), e.per_ha ? ` (${fmt.money((e.per_ha * g) / 100)}/ha)` : '')); };
  input.addEventListener('input', paint); paint();
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Simulador de meta'), badge('demo', 'Cenário ilustrativo', 'demo')), h('p', { class: 'small muted', style: { marginBottom: '10px' } }, 'Simulação de meta de redução de custos. Não é resultado real nem garantia de economia: os resultados reais aparecem na tabela acima, calculados com seus dados.'), h('div', { class: 'row' }, h('span', { class: 'small' }, 'Meta de redução (%)'), input), h('div', { style: { marginTop: '10px' } }, out));
}
void iconBtn; void confirmDialog; void toast; void formModal; void emptyState; void can;
