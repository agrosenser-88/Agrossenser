import { api, qs, download, ApiError } from '../api.js';
import { h, clear, fmt, badge, options, errMsg, pageHead, loading, toast, tabs, table, iconBtn, confirmDialog, formModal, selectOptions, copyText, modal } from '../ui.js';
import { icon } from '../icons.js';
import { can, session, loadFilters } from '../app.js';

const ROLE_TXT = { admin: 'Acesso total, gerencia usuários e configurações.', gestor: 'Gerencia fazendas, operações, custos e equipamentos.', agronomo: 'Registra inspeções, ocorrências, análises e pulverizações; consulta o restante.', operador: 'Registra operações de máquinas, missões, ocorrências e pulverizações.', visualizador: 'Somente consulta.' };

export async function render(host, { params }) {
  const items = [{ key: 'conta', label: 'Minha conta' }];
  if (can('users', 'r')) items.push({ key: 'usuarios', label: 'Usuários' });
  if (can('settings', 'r')) items.push({ key: 'integracoes', label: 'Integrações' }, { key: 'sistema', label: 'Sistema e backup' });
  if (can('audit', 'r')) items.push({ key: 'auditoria', label: 'Auditoria' });
  let cur = params[0] === 'usuarios' && can('users', 'r') ? 'usuarios' : 'conta';
  const content = h('div');
  host.append(pageHead('Configurações', 'Conta, usuários, integrações e segurança.'), tabs(items, cur, (k) => { cur = k; show(); }), content);
  show();
  function show() { clear(content); ({ conta: account, usuarios: users, integracoes: integrations, sistema: system, auditoria: audit })[cur](content); }
}

async function account(box) {
  const u = session.user;
  box.appendChild(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('h2', { style: { marginBottom: '12px' } }, 'Meus dados'), h('dl', { class: 'kv' }, h('dt', null, 'Nome'), h('dd', null, u.name), h('dt', null, 'Usuário'), h('dd', null, u.username), h('dt', null, 'E-mail'), h('dd', null, u.email || '—'), h('dt', null, 'Perfil'), h('dd', null, u.role_label), h('dt', null, 'Organização'), h('dd', null, u.org_name)), h('p', { class: 'small muted', style: { marginTop: '10px' } }, ROLE_TXT[u.role]),
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'btn primary', onclick: changePassword }, icon('key', 16), 'Alterar senha'))),
    h('div', { class: 'card' }, h('h2', { style: { marginBottom: '12px' } }, 'Segurança e privacidade'), h('ul', { class: 'small muted', style: { margin: 0, paddingLeft: '18px', lineHeight: '1.8' } }, h('li', null, 'Senhas armazenadas com hash (scrypt); nunca em texto puro.'), h('li', null, 'Sessões com expiração por inatividade; você pode encerrar outras sessões abaixo.'), h('li', null, 'Ações importantes ficam registradas na auditoria.'), h('li', null, 'Seus dados e os da sua organização são isolados dos demais clientes.'), h('li', null, 'LGPD: dados pessoais tratados somente para operar o sistema. Solicitações de acesso, correção ou exclusão devem ser feitas ao administrador.')))));
  const sess = h('div', { class: 'card', style: { marginTop: '16px' } }); box.appendChild(sess); await loadSessions();
  async function loadSessions() {
    clear(sess); sess.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Sessões ativas'), h('button', { class: 'btn sm', onclick: async () => { const r = await api.del('/api/auth/sessions'); toast(`${r.revoked} sessão(ões) encerrada(s).`); loadSessions(); } }, 'Encerrar outras sessões')));
    try { const rows = await api.get('/api/auth/sessions'); sess.appendChild(table([{ label: 'Dispositivo', render: (r) => [String(r.user_agent || '—').slice(0, 70), r.current ? badge('ok', 'Esta sessão', 'ok') : null] }, { label: 'IP', render: (r) => r.ip || '—' }, { label: 'Último acesso', render: (r) => fmt.datetime(r.last_seen_at) }], rows, { actions: (r) => (r.current ? null : iconBtn('x', 'Encerrar sessão', async () => { await api.del(`/api/auth/sessions/${r.handle}`); loadSessions(); }, 'danger')) })); } catch (e) { sess.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  function changePassword() {
    formModal({ title: 'Alterar senha', size: 'narrow', fields: [{ name: 'current_password', label: 'Senha atual', type: 'password', required: true, full: true, autocomplete: 'current-password' }, { name: 'new_password', label: 'Nova senha', type: 'password', required: true, full: true, hint: 'Mínimo de 8 caracteres.', autocomplete: 'new-password' }, { name: 'confirm', label: 'Repita a nova senha', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (v) => { if (v.new_password !== v.confirm) throw new ApiError(400, 'Dados inválidos.', { confirm: 'As senhas não conferem.' }); await api.post('/api/auth/change-password', { current_password: v.current_password, new_password: v.new_password }); toast('Senha alterada. Outras sessões foram encerradas.'); } });
  }
}

async function users(box) {
  const F = await loadFilters(); const canW = can('users', 'w'); const body = h('div'); let roles = {};
  try { roles = (await api.get('/api/meta')).roles; } catch (_) { /* usa vazio */ }
  box.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, h('p', { class: 'muted small', style: { flex: 1 } }, 'Cada perfil tem permissões específicas. Para limitar um usuário a algumas fazendas, selecione-as no cadastro.'), canW ? h('button', { class: 'btn primary', onclick: () => form(null) }, icon('plus', 16), 'Novo usuário') : null),
    h('div', { class: 'card flat', style: { marginBottom: '14px' } }, h('div', { class: 'grid g-auto', style: { gap: '8px' } }, Object.entries(roles).map(([k, l]) => h('div', { class: 'small' }, h('b', null, l), h('div', { class: 'tiny muted' }, ROLE_TXT[k]))))), body);
  await load();
  async function load() {
    clear(body); body.appendChild(loading());
    try {
      const rows = await api.get('/api/users'); clear(body);
      body.appendChild(table([{ label: 'Nome', render: (r) => [h('b', null, r.name), h('div', { class: 'tiny muted' }, `${r.username}${r.email ? ' · ' + r.email : ''}`)] }, { label: 'Perfil', key: 'role_label' }, { label: 'Fazendas', render: (r) => (r.role === 'admin' ? 'Todas' : r.farm_ids.length ? r.farm_ids.map((id) => (F.farms.find((f) => f.id === id) || {}).name).filter(Boolean).join(', ') : 'Todas') },
        { label: 'Situação', render: (r) => badge(r.active, r.active ? 'Ativo' : 'Inativo', r.active ? 'ok' : 'neutral') }, { label: 'Último acesso', render: (r) => fmt.datetime(r.last_login_at) }], rows,
        { actions: canW ? (r) => [iconBtn('key', 'Redefinir senha', () => reset(r)), iconBtn('edit', 'Editar', () => form(r)), can('users', 'd') && r.id !== session.user.id ? iconBtn('trash', 'Excluir', async () => { if (await confirmDialog(`Excluir o usuário ${r.username}?`, { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`/api/users/${r.id}`); toast('Usuário excluído.'); load(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger') : null] : null }));
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  function form(row) {
    const farmsBox = h('div', { class: 'stack', style: { gap: '4px', marginTop: '12px' } }, h('div', { class: 'lbl small muted' }, 'Restringir às fazendas (nenhuma marcada = todas)'), F.farms.map((f) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', value: f.id, checked: !!(row && row.farm_ids.includes(f.id)) }), f.name)));
    const fields = [{ name: 'name', label: 'Nome completo', required: true, full: true, maxlength: 120 }, ...(row ? [] : [{ name: 'username', label: 'Usuário (login)', required: true, maxlength: 40, hint: 'Letras, números, ponto, hífen.' }]), { name: 'email', label: 'E-mail', type: 'email' }, { name: 'role', label: 'Perfil', type: 'select', required: true, options: Object.entries(roles).map(([value, label]) => ({ value, label })) },
      ...(row ? [{ name: 'active', label: 'Usuário ativo', type: 'checkbox' }] : [{ name: 'password', label: 'Senha inicial', type: 'password', required: true, hint: 'Mínimo de 8 caracteres. O usuário será obrigado a trocá-la no primeiro acesso.', autocomplete: 'new-password' }])];
    formModal({ title: row ? 'Editar usuário' : 'Novo usuário', fields, values: row || { role: 'visualizador', active: true }, size: 'wide', extra: farmsBox,
      onSubmit: async (v) => { const farm_ids = [...farmsBox.querySelectorAll('input:checked')].map((i) => Number(i.value)); const p = { ...v, email: v.email || null, farm_ids }; if (row) await api.put(`/api/users/${row.id}`, p); else await api.post('/api/users', p); toast('Usuário salvo.'); load(); } });
  }
  function reset(u) {
    const m = modal({ title: `Redefinir senha — ${u.username}`, size: 'wide', body: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Gere um link de redefinição (válido por 24 h) para enviar ao usuário, ou defina uma senha temporária.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const r = await api.post(`/api/users/${u.id}/reset-link`, { send_email: true }); const out = m.el.querySelector('.out'); clear(out); out.append(h('div', { class: 'code' }, r.url), h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => copyText(r.url) }, icon('copy', 14), 'Copiar link'), r.emailed ? badge('ok', 'Enviado por e-mail', 'ok') : h('span', { class: 'tiny muted' }, 'Envie o link ao usuário (e-mail não configurado ou não informado).'))); } catch (e) { toast(errMsg(e), 'err'); } } }, icon('key', 16), 'Gerar link de redefinição'),
        h('button', { class: 'btn', onclick: () => { m.close(); formModal({ title: 'Senha temporária', size: 'narrow', fields: [{ name: 'password', label: 'Nova senha temporária', type: 'password', required: true, full: true, autocomplete: 'new-password', hint: 'O usuário deverá trocá-la no próximo acesso.' }], onSubmit: async (v) => { await api.post(`/api/users/${u.id}/set-password`, v); toast('Senha temporária definida.'); } }); } }, 'Definir senha temporária')), h('div', { class: 'out' })) });
  }
}

async function integrations(box) {
  box.appendChild(loading());
  try {
    const s = await api.get('/api/settings'); clear(box); const TONE = { configurada: 'ok', pendente: 'warn', desativada: 'neutral' };
    box.appendChild(h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Integrações configuradas e pendentes. Chaves e credenciais ficam somente no servidor (variáveis de ambiente), nunca no navegador.'),
      h('div', { class: 'grid g2' }, s.integrations.map((i) => h('div', { class: 'card item-card' }, h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, i.name), badge(i.status, i.status === 'configurada' ? 'Configurada' : i.status === 'pendente' ? 'Pendente' : 'Desativada', TONE[i.status])), h('p', { class: 'small muted' }, i.detail))))));
  } catch (e) { clear(box); box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
}

async function system(box) {
  box.appendChild(loading());
  try {
    const s = await api.get('/api/settings'); clear(box);
    box.appendChild(h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Organização'), h('div', { class: 'row' }, h('input', { class: 'input', id: 'orgname', value: s.organization.name, maxlength: 120, style: { flex: 1 } }), h('button', { class: 'btn primary', onclick: async () => { try { await api.put('/api/settings/organization', { name: document.getElementById('orgname').value }); toast('Nome atualizado.'); } catch (e) { toast(errMsg(e), 'err'); } } }, 'Salvar')),
        h('dl', { class: 'kv', style: { marginTop: '14px' } }, h('dt', null, 'Tamanho máx. de arquivo'), h('dd', null, `${s.limits.max_upload_mb} MB`), h('dt', null, 'Sessão (inatividade)'), h('dd', null, `${s.limits.session_idle_hours} h`), h('dt', null, 'Sessão (máximo)'), h('dd', null, `${s.limits.session_max_days} dias`))),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Backup'), h('p', { class: 'small muted', style: { marginBottom: '12px' } }, 'Baixe uma cópia consistente do banco de dados. Os arquivos enviados (fotos e documentos) ficam na pasta de uploads do servidor e devem ser copiados junto — veja o procedimento completo no README.'), session.user.role === 'admin' ? h('button', { class: 'btn primary', onclick: async () => { try { await download('/api/settings/backup', 'agrosensor-backup.db'); toast('Backup gerado.'); } catch (e) { toast(errMsg(e), 'err'); } } }, icon('download', 16), 'Baixar backup do banco') : h('p', { class: 'small muted' }, 'Somente administradores gerais podem baixar backups.'))));
  } catch (e) { clear(box); box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
}

async function audit(box) {
  const st = { user: '', entity: '', from: '', to: '' }; const body = h('div');
  const inp = (label, key, type = 'text') => h('div', { class: 'field' }, h('label', null, label), h('input', { class: 'input', type, onchange: (e) => { st[key] = e.target.value.trim(); load(); } }));
  box.append(h('div', { class: 'toolbar' }, inp('Usuário', 'user'), inp('Entidade', 'entity'), inp('De', 'from', 'date'), inp('Até', 'to', 'date')), body); await load();
  async function load() {
    clear(body); body.appendChild(loading());
    try { const rows = await api.get(`/api/audit${qs({ ...st, limit: 300 })}`); clear(body); body.appendChild(table([{ label: 'Data', render: (r) => fmt.datetime(r.created_at) }, { label: 'Usuário', render: (r) => r.username || '—' }, { label: 'Ação', render: (r) => badge('x', r.action.replace(/_/g, ' '), 'neutral') }, { label: 'Entidade', key: 'entity' }, { label: 'Resumo', render: (r) => r.summary || '' }, { label: 'IP', render: (r) => r.ip || '' }], rows, { empty: 'Nenhum registro.' })); } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
}
void options; void selectOptions;
