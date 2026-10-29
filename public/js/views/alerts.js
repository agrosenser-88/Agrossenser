import { api, qs } from '../api.js';
import { h, clear, fmt, L, badge, errMsg, pageHead, loading, emptyState, toast, options } from '../ui.js';
import { icon } from '../icons.js';
import { refreshAlertCount } from '../app.js';

const SEV = { info: 'Informativo', atencao: 'Atenção', critico: 'Crítico' };
const DOT = { info: 'var(--info)', atencao: 'var(--warn)', critico: 'var(--crit)' };
const CAT_ICON = { praga: 'bug', sensor: 'sensor', manutencao: 'wrench', operacao: 'spray', clima: 'cloud', tarefa: 'check', admin: 'shield' };

export async function render(host) {
  const st = { category: '', severity: '', unread: '', history: '' }; const body = h('div');
  const sel = (label, key, opts) => h('div', { class: 'field' }, h('label', null, label), h('select', { class: 'input', onchange: (e) => { st[key] = e.target.value; load(); } }, h('option', { value: '' }, 'Todos'), opts.map((o) => h('option', { value: o.value }, o.label))));
  host.append(pageHead('Alertas', 'Pragas, sensores, manutenções, operações, clima e tarefas.', h('button', { class: 'btn', onclick: async () => { try { await api.post('/api/notifications/read-all'); toast('Todos marcados como lidos.'); load(); refreshAlertCount(); } catch (e) { toast(errMsg(e), 'err'); } } }, icon('check', 16), 'Marcar todos como lidos')),
    h('div', { class: 'toolbar' }, sel('Categoria', 'category', options(L.alertCat)), sel('Gravidade', 'severity', options(SEV)), sel('Leitura', 'unread', [{ value: '1', label: 'Somente não lidos' }]),
      h('div', { class: 'field' }, h('label', null, 'Exibir'), h('select', { class: 'input', onchange: (e) => { st.history = e.target.value; load(); } }, h('option', { value: '' }, 'Ativos'), h('option', { value: '1' }, 'Histórico (resolvidos)'), h('option', { value: 'all' }, 'Todos')))), body);
  await load();
  async function load() {
    clear(body); body.appendChild(loading());
    try {
      const rows = await api.get(`/api/notifications${qs(st)}`); clear(body);
      if (!rows.length) { body.appendChild(emptyState({ iconName: 'bell', title: 'Nenhum alerta', text: st.history ? 'Não há alertas no histórico com esses filtros.' : 'Tudo em ordem: não há alertas ativos com esses filtros.' })); return; }
      body.appendChild(h('div', { class: 'card', style: { padding: '4px 16px' } }, rows.map((n) => h('div', { class: `alert-item ${n.read || n.resolved_at ? '' : 'unread'}` },
        h('span', { class: 'dot', style: { background: DOT[n.severity] } }),
        h('div', { class: 'body' }, h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, n.title), badge(n.severity, SEV[n.severity]), n.resolved_at ? badge('ok', 'Resolvido', 'ok') : null),
          n.body ? h('div', { class: 'small muted' }, n.body) : null, h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, `${L.alertCat[n.category]}${n.farm_name ? ' · ' + n.farm_name : ''} · ${fmt.datetime(n.created_at)}`),
          h('div', { class: 'row', style: { marginTop: '8px' } }, n.link ? h('a', { class: 'btn sm', href: n.link }, 'Abrir') : null, h('button', { class: 'btn sm ghost', onclick: async () => { await api.post(`/api/notifications/${n.id}/read`, { read: !n.read }); load(); refreshAlertCount(); } }, n.read ? 'Marcar como não lido' : 'Marcar como lido'))),
        h('span', { class: 'muted' }, icon(CAT_ICON[n.category] || 'bell', 20))))));
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
}
