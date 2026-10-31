import { api } from '../api.js';
import { h, clear, buildForm, errMsg, toast } from '../ui.js';

function frame(root, title, ...kids) {
  clear(root);
  root.appendChild(h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo-plate' }, h('img', { src: '/img/logo.png', alt: 'AgroSensor - Controle inteligente, colheita eficiente' })),
    h('h1', null, title), kids)));
}

function simpleForm(fields, { submitLabel, onSubmit }) {
  const form = buildForm(fields, {});
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, submitLabel);
  const el = h('form', { class: 'stack', novalidate: '', onsubmit: async (e) => {
    e.preventDefault(); err.classList.add('hidden');
    if (!form.clientCheck()) return;
    btn.disabled = true;
    try { await onSubmit(form.read(), form); } catch (ex) { if (!(ex.details && form.setServerErrors(ex.details))) { err.textContent = errMsg(ex); err.classList.remove('hidden'); } else { err.textContent = 'Corrija os campos destacados.'; err.classList.remove('hidden'); } }
    finally { btn.disabled = false; }
  } }, form.el, err, btn);
  form.el.style.gridTemplateColumns = '1fr';
  return { el, form };
}

export function renderLogin(root, onLogin) {
  const { el, form } = simpleForm([
    { name: 'username', label: 'Usuário', required: true, autocomplete: 'username', full: true },
    { name: 'password', label: 'Senha', type: 'password', required: true, autocomplete: 'current-password', full: true },
  ], { submitLabel: 'Entrar', onSubmit: async (v) => { const r = await api.post('/api/auth/login', v); await onLogin(r.user); } });
  frame(root, 'Acesse sua conta', h('p', { class: 'muted small' }, 'Controle inteligente, colheita eficiente.'), el,
    h('div', { class: 'auth-links' }, h('a', { href: '#/esqueci' }, 'Esqueci minha senha')));
  form.inputs.username.focus();
}

export function renderForgot(root) {
  const out = h('div');
  const { el } = simpleForm([{ name: 'identifier', label: 'Usuário ou e-mail', required: true, full: true }], {
    submitLabel: 'Solicitar redefinição',
    onSubmit: async (v) => {
      const r = await api.post('/api/auth/forgot', v);
      clear(out); out.appendChild(h('div', { class: `notice ${r.email_enabled ? 'ok' : 'warn'}` }, r.message));
    },
  });
  frame(root, 'Recuperar acesso', h('p', { class: 'muted small' }, 'Informe seu usuário ou e-mail. Por segurança, a resposta é sempre a mesma, exista ou não o cadastro.'), el, out, h('div', { class: 'auth-links' }, h('a', { href: '#/entrar' }, '← Voltar ao login')));
}

export async function renderReset(root, token) {
  try { await api.get(`/api/auth/reset/${encodeURIComponent(token)}`); } catch (e) {
    return frame(root, 'Link inválido', h('div', { class: 'notice warn' }, 'Este link de redefinição é inválido ou expirou. Solicite um novo.'), h('a', { class: 'btn primary', href: '#/esqueci' }, 'Solicitar novo link'));
  }
  const { el } = simpleForm([
    { name: 'new_password', label: 'Nova senha', type: 'password', required: true, hint: 'Mínimo de 8 caracteres.', autocomplete: 'new-password', full: true },
    { name: 'confirm', label: 'Repita a nova senha', type: 'password', required: true, autocomplete: 'new-password', full: true },
  ], {
    submitLabel: 'Definir nova senha',
    onSubmit: async (v, form) => {
      if (v.new_password !== v.confirm) { form.setServerErrors({ confirm: 'As senhas não conferem.' }); throw Object.assign(new Error('x'), { details: { confirm: 'As senhas não conferem.' } }); }
      await api.post('/api/auth/reset', { token, new_password: v.new_password });
      toast('Senha redefinida. Entre com a nova senha.'); location.hash = '#/entrar';
    },
  });
  frame(root, 'Definir nova senha', el);
}

export function renderForcedPassword(root, done) {
  const { el } = simpleForm([
    { name: 'current_password', label: 'Senha atual', type: 'password', required: true, autocomplete: 'current-password', full: true },
    { name: 'new_password', label: 'Nova senha', type: 'password', required: true, hint: 'Mínimo de 8 caracteres.', autocomplete: 'new-password', full: true },
  ], { submitLabel: 'Salvar e continuar', onSubmit: async (v) => { await api.post('/api/auth/change-password', v); toast('Senha alterada.'); await done(); } });
  frame(root, 'Defina uma nova senha', h('div', { class: 'notice warn' }, 'Por segurança, troque a senha inicial antes de continuar.'), el);
}
