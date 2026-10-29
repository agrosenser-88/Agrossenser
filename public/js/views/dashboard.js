import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, loading, errMsg, pageHead, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { barChart, lineChart, donut, progress, color, noData } from '../charts.js';
import { filterBar } from './shared.js';
import { can, session } from '../app.js';

const SEV_COLOR = { baixa: 'var(--info)', media: 'var(--warn)', alta: '#ff7a45', critica: 'var(--crit)' };

export async function render(host) {
  const state = { farm_id: '', crop: '', season: '', from: '', to: '', plot_id: '' };
  const body = h('div', { class: 'stack' });
  const bar = await filterBar(state, load, { plot: true });
  host.append(pageHead(`Olá, ${session.user.name.split(' ')[0]}`, 'Visão geral das suas lavouras, operações e custos.'), bar, body);
  await load();

  async function load() {
    clear(body); body.appendChild(loading());
    let d;
    try { d = await api.get(`/api/dashboard${qs(state)}`); } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); return; }
    clear(body);
    if (d.empty) {
      body.appendChild(emptyState({
        iconName: 'farm', title: 'Cadastre sua primeira fazenda',
        text: 'O painel é construído a partir dos seus dados reais. Comece cadastrando uma fazenda e seus talhões; depois registre ocorrências, operações, custos e colheitas.',
        action: can('farms', 'w') ? h('a', { class: 'btn primary', href: '#/fazendas' }, icon('plus', 17), 'Cadastrar fazenda') : h('p', { class: 'muted small' }, 'Peça ao administrador para cadastrar uma fazenda.'),
      }));
      body.appendChild(h('div', { class: 'card' }, h('h3', { style: { marginBottom: '10px' } }, 'Primeiros passos'),
        h('ol', { class: 'muted', style: { margin: 0, paddingLeft: '20px', lineHeight: '1.8' } },
          h('li', null, 'Cadastre a fazenda (nome, município, área e coordenadas).'), h('li', null, 'Crie os talhões com cultura, safra e limites desenhados no mapa.'),
          h('li', null, 'Registre inspeções, pragas e doenças em campo (com GPS do celular).'), h('li', null, 'Cadastre máquinas, drones, sensores e planeje as pulverizações.'),
          h('li', null, 'Acompanhe custos, produtividade e relatórios.'))));
      return;
    }
    const mk = (href, ico, label, value, sub, tone) => { const a = h('a', { class: `card stat ${tone || ''}`, href }); const i = icon(ico, 22); i.setAttribute('class', 'ico'); a.append(i, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub || '')); return a; };
    const spray = d.spray; const execPct = spray.planned_ha > 0 ? (spray.executed_ha / spray.planned_ha) * 100 : null;
    const machCount = (s) => (d.machines.by_status.find((x) => x.status === s) || { n: 0 }).n;
    const drCount = (s) => (d.drones.by_status.find((x) => x.status === s) || { n: 0 }).n;
    body.appendChild(h('div', { class: 'grid g4' },
      mk('#/fazendas', 'farm', 'Fazendas', fmt.num(d.farms.n, 0), `${fmt.ha(d.farms.area_ha)} cadastrados`),
      mk('#/fazendas', 'leaf', 'Talhões monitorados', fmt.num(d.plots.n, 0), `${d.plots.active || 0} ativos · ${fmt.ha(d.plots.area_ha)}`),
      mk('#/pragas', 'bug', 'Alertas de pragas e doenças', fmt.num(d.occurrences.open, 0), `${d.occurrences.critical} graves/críticas em aberto`, d.occurrences.critical ? 'bad' : d.occurrences.open ? 'warn' : ''),
      mk('#/pulverizacao', 'spray', 'Operações em andamento', fmt.num(spray.in_progress, 0), execPct === null ? 'Sem pulverizações no período' : `${fmt.pct(execPct)} da área planejada executada`)));
    body.appendChild(h('div', { class: 'grid g4' },
      mk('#/maquinas', 'tractor', 'Máquinas', fmt.num(d.machines.total, 0), `${machCount('em_operacao')} em operação · ${machCount('manutencao')} em manutenção`),
      mk('#/drones', 'drone', 'Drones', fmt.num(d.drones.total, 0), `${drCount('em_missao')} em missão · ${drCount('manutencao')} em manutenção`),
      mk('#/sensores', 'sensor', 'Sensores', fmt.num(d.sensors.total, 0), d.sensors.total ? `${d.sensors.online} online · ${d.sensors.waiting} aguardando conexão` : 'Nenhum sensor cadastrado'),
      mk('#/custos', 'coins', 'Custos no período', fmt.money(d.costs.total), d.costs.per_ha !== null ? `${fmt.money(d.costs.per_ha)} por hectare` : 'Informe a área dos talhões para ver o custo por ha')));

    // Situação das lavouras + ocorrências
    const sev = ['baixa', 'media', 'alta', 'critica'].map((s) => ({ label: L.severity[s], value: (d.occurrences.by_severity.find((x) => x.severity === s) || { n: 0 }).n, color: SEV_COLOR[s] }));
    body.appendChild(h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Situação geral das lavouras'), h('a', { class: 'btn sm', href: '#/pragas' }, 'Ver ocorrências')),
        d.occurrences.open === 0 ? h('div', { class: 'notice ok' }, icon('check', 18), d.plots.n ? 'Nenhuma ocorrência de praga ou doença em aberto no período.' : 'Cadastre talhões e inspeções para acompanhar a situação.') : donut({ items: sev, size: 140, center: d.occurrences.open }),
        d.crops.length ? h('div', { style: { marginTop: '16px' } }, h('h4', { class: 'muted', style: { marginBottom: '8px' } }, 'Área por cultura'), h('div', { class: 'stack', style: { gap: '9px' } }, d.crops.slice(0, 5).map((c, i) => h('div', null, h('div', { class: 'row small', style: { justifyContent: 'space-between' } }, h('span', null, `${c.crop} · ${c.plots} talhão(ões)`), h('b', null, fmt.ha(c.area_ha))), progress(d.plots.area_ha > 0 ? (c.area_ha / d.plots.area_ha) * 100 : 0, c.crop))))) : null),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Ocorrências recentes'), h('a', { class: 'btn sm', href: '#/mapa' }, icon('map', 15), 'Ver no mapa')),
        d.occurrences.recent.length ? h('div', { class: 'list' }, d.occurrences.recent.map((o) => h('a', { href: '#/pragas', style: { color: 'inherit', textDecoration: 'none', display: 'flex', gap: '10px', alignItems: 'center' } }, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, o.name), h('div', { class: 'tiny muted' }, `${o.farm_name} · ${fmt.date(o.observed_at)}`)), badge(o.severity, L.severity[o.severity]), badge(o.status, L.occStatus[o.status])))) : noData('Nenhuma ocorrência registrada.'))));

    // Pulverização + insumos
    body.appendChild(h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Indicadores de pulverização'), h('a', { class: 'btn sm', href: '#/pulverizacao' }, 'Detalhes')),
        h('div', { class: 'mini-stats' }, h('div', null, h('b', null, fmt.ha(spray.planned_ha)), h('span', null, 'Área planejada')), h('div', null, h('b', null, fmt.ha(spray.executed_ha)), h('span', null, 'Área executada')), h('div', null, h('b', null, `${fmt.num(spray.volume_l, 0)} L`), h('span', null, 'Volume aplicado'))),
        execPct !== null ? h('div', { style: { marginTop: '14px' } }, h('div', { class: 'row small', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('span', null, 'Execução'), h('b', null, fmt.pct(execPct))), progress(execPct, 'Execução da pulverização')) : null,
        spray.by_status.length ? h('div', { class: 'row', style: { marginTop: '14px' } }, spray.by_status.map((s) => h('span', null, badge(s.status, `${L.opStatus[s.status]}: ${s.n}`)))) : h('p', { class: 'muted small', style: { marginTop: '12px' } }, 'Nenhuma pulverização no período.')),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Consumo de insumos'), h('a', { class: 'btn sm', href: '#/relatorios' }, 'Relatório')),
        d.inputs.length ? barChart({ labels: d.inputs.map((i) => `${i.product}`), series: [{ name: 'Quantidade aplicada', values: d.inputs.map((i) => i.qty), color: color(0) }], height: 220 }) : noData('Registre produto e quantidade nas pulverizações concluídas para ver o consumo.'))));

    // Custos + produção
    body.appendChild(h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Custos por mês'), h('a', { class: 'btn sm', href: '#/custos' }, 'Custos e economia')),
        d.costs.by_month.length ? lineChart({ labels: d.costs.by_month.map((m) => fmt.month(m.month)), series: [{ name: 'Custos (R$)', values: d.costs.by_month.map((m) => m.amount) }], format: (n) => fmt.num(n, 0) }) : noData('Sem custos registrados no período.'),
        d.costs.by_category.length ? h('div', { style: { marginTop: '12px' } }, donut({ items: d.costs.by_category.map((c, i) => ({ label: L.cost[c.category], value: c.amount, color: color(i) })), format: (n) => fmt.money(n), size: 120, center: '' })) : null),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Evolução da produção'), h('a', { class: 'btn sm', href: '#/relatorios' }, 'Relatório')),
        d.production.length ? barChart({ labels: d.production.map((p) => `${p.season} (${p.unit})`), series: [{ name: 'Produção', values: d.production.map((p) => p.quantity), color: color(1) }], height: 220 }) : noData('Registre as colheitas em Custos e economia > Colheitas para acompanhar a produção.'),
        d.production.some((p) => p.productivity) ? h('div', { class: 'row small muted', style: { marginTop: '8px' } }, d.production.filter((p) => p.productivity).map((p) => h('span', null, `${p.season}: ${fmt.num(p.productivity)} ${p.unit}/ha`))) : null)));

    // Mapa resumo + atividades
    body.appendChild(h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Mapa das áreas agrícolas'), h('a', { class: 'btn sm', href: '#/mapa' }, 'Abrir mapa completo')), (() => { const box = h('div'); miniMap(box, state); return box; })()),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Atividades recentes')),
        d.activity.length ? h('div', { class: 'timeline' }, d.activity.map((a) => h('div', null, h('time', null, fmt.datetime(a.created_at)), h('div', null, h('b', null, a.username || 'Sistema'), ` — ${a.summary || a.action}`)))) : noData('Nenhuma atividade registrada ainda.'))));
  }
}

async function miniMap(box, state) {
  try {
    const { AgroMap, SEV_COLOR: SC } = await import('../map.js');
    const data = await api.get(`/api/map${qs({ farm_id: state.farm_id, crop: state.crop })}`);
    const el = h('div', { style: { height: '320px' } }); box.appendChild(el);
    const m = new AgroMap(el); const pts = [];
    data.plots.forEach((p) => { if (p.boundary) { m.addShape({ geometry: p.boundary, fill: 'rgba(46,139,70,.35)', stroke: '#b6f03a', label: p.name, popup: () => h('div', null, h('h4', null, p.name), h('div', { class: 'small muted' }, `${p.farm_name} · ${p.crop || 'sem cultura'} · ${fmt.ha(p.area_ha)}`)) }); (p.boundary.coordinates[0] || []).forEach((c) => pts.push({ lat: c[1], lng: c[0] })); } });
    data.farms.forEach((f) => { if (f.latitude !== null) { m.addMarker({ lat: f.latitude, lng: f.longitude, color: '#2e8b46', title: f.name, popup: () => h('div', null, h('h4', null, f.name), h('div', { class: 'small muted' }, [f.city, f.state].filter(Boolean).join(' - '))) }); pts.push({ lat: f.latitude, lng: f.longitude }); } });
    data.occurrences.forEach((o) => { m.addMarker({ lat: o.lat, lng: o.lng, color: SC[o.severity], dot: true, title: o.name, popup: () => h('div', null, h('h4', null, o.name), h('div', { class: 'small muted' }, `${L.severity[o.severity]} · ${fmt.date(o.observed_at)}`)) }); pts.push({ lat: o.lat, lng: o.lng }); });
    if (!m.fitPoints(pts)) { m.setView(-15.78, -47.93, 4); box.appendChild(h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Informe as coordenadas das fazendas ou desenhe os talhões para vê-los aqui.')); }
    else m.render();
  } catch (e) { box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
}
