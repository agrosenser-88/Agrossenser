// Aplicação principal: sessão, navegação (menu lateral no computador, barra inferior no celular) e roteamento por hash.
import { api, onUnauthorized } from './api.js';
import { h, clear, toast, loading, errMsg, emptyState } from './ui.js';
import { icon } from './icons.js';
import { renderLogin, renderForgot, renderReset, renderForcedPassword } from './views/auth.js';

export const session = { user: null, filters: null };
const root = document.getElementById('app');

const NAV = [
  { key: 'inicio', label: 'Início', icon: 'home', mod: null },
  { key: 'fazendas', label: 'Fazendas', icon: 'farm', mod: 'farms' },
  { key: 'mapa', label: 'Mapa', icon: 'map', mod: 'map' },
  { key: 'ia', label: 'AgroSenser IA', icon: 'ia', mod: 'ia' },
  { key: 'pragas', label: 'Pragas e doenças', icon: 'bug', mod: 'occurrences' },
  { key: 'maquinas', label: 'Máquinas', icon: 'tractor', mod: 'machines' },
  { key: 'drones', label: 'Drones', icon: 'drone', mod: 'drones' },
  { key: 'pulverizacao', label: 'Pulverização', icon: 'spray', mod: 'spray' },
  { key: 'sensores', label: 'Sensores', icon: 'sensor', mod: 'sensors' },
  { key: 'clima', label: 'Clima', icon: 'cloud', mod: 'weather' },
  { key: 'relatorios', label: 'Relatórios', icon: 'chart', mod: 'reports' },
  { key: 'custos', label: 'Custos e economia', icon: 'coins', mod: 'costs' },
  { key: 'alertas', label: 'Alertas', icon: 'bell', mod: null },
  { key: 'configuracoes', label: 'Configurações', icon: 'settings', mod: null },
];
const MOBILE_MAIN = ['inicio', 'fazendas', 'mapa', 'ia'];
const VIEWS = {
  inicio: () => import('./views/dashboard.js'), fazendas: () => import('./views/farms.js'), mapa: () => import('./views/mapview.js'),
  ia: () => import('./views/ia.js'), pragas: () => import('./views/occurrences.js'), maquinas: () => import('./views/machines.js'),
  drones: () => import('./views/drones.js'), pulverizacao: () => import('./views/spray.js'), sensores: () => import('./views/sensors.js'),
  clima: () => import('./views/weather.js'), relatorios: () => import('./views/reports.js'), custos: () => import('./views/costs.js'),
  alertas: () => import('./views/alerts.js'), configuracoes: () => import('./views/settings.js'),
};

export const can = (mod, act = 'r') => !!(session.user && session.user.permissions && (session.user.permissions[mod] || '').includes(act));
export const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

export async function loadFilters(force) {
  if (!session.filters || force) session.filters = await api.get('/api/filters');
  return session.filters;
}

// ---- Tema ----
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('agro_theme', t); } catch (_) { /* sem armazenamento */ }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'light' ? '#ecf8ee' : '#06130e');
}
const themeBtn = (cls = 'btn ghost icon') => {
  const b = h('button', { class: cls, 'aria-label': 'Alternar tema claro/escuro', title: 'Alternar tema', onclick: () => { const cur = document.documentElement.getAttribute('data-theme'); setTheme(cur === 'light' ? 'dark' : 'light'); paint(); } });
  const paint = () => { clear(b); b.appendChild(icon(document.documentElement.getAttribute('data-theme') === 'light' ? 'moon' : 'sun', 19)); };
  paint(); return b;
};

// ---- Casca autenticada ----
let shell = null; let current = null; let alertTimer = null; let alertCount = 0;
const pillEls = new Set();

function buildShell() {
  const u = session.user;
  const items = NAV.filter((n) => !n.mod || can(n.mod));
  const links = new Map();
  const mkLink = (n, cls = '') => {
    const a = h('a', { href: `#/${n.key}`, class: cls, dataset: { key: n.key } }, icon(n.icon, 20), h('span', null, n.label));
    if (n.key === 'alertas') { const p = h('span', { class: 'pill hidden' }); pillEls.add(p); a.appendChild(p); }
    links.set(n.key + cls, a); return a;
  };
  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { href: '#/inicio', class: 'brand-plate', 'aria-label': 'AgroSenser - início' }, h('img', { src: '/img/logo.png', alt: 'AgroSenser - Controle inteligente, colheita eficiente' })),
    h('nav', { class: 'nav', 'aria-label': 'Menu principal' }, items.map((n) => mkLink(n))),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'user-chip' }, h('div', { class: 'avatar' }, (u.name || '?').trim().slice(0, 1).toUpperCase()), h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, u.name), h('div', { class: 'tiny muted' }, u.role_label))),
      h('div', { class: 'row' }, themeBtn('btn icon'), h('button', { class: 'btn grow', style: { flex: 1 }, onclick: logout }, icon('logout', 17), 'Sair'))));
  const titleEl = h('div', { class: 'title' });
  const topbar = h('header', { class: 'topbar' },
    h('a', { href: '#/inicio', class: 'top-logo', 'aria-label': 'Início' }, h('img', { src: '/img/logo-mark.png', alt: 'AgroSenser' })),
    titleEl, h('div', { class: 'spacer' }),
    h('a', { href: '#/alertas', class: 'btn ghost icon', 'aria-label': 'Alertas', style: { position: 'relative' } }, icon('bell', 20), (() => { const p = h('span', { class: 'pill hidden', style: { position: 'absolute', top: '2px', right: '0' } }); pillEls.add(p); return p; })()),
    themeBtn());
  const offline = h('div', { class: 'offline-bar hidden', role: 'status' }, 'Você está sem conexão. Os dados não serão atualizados até a rede voltar.');
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const main = h('div', { class: 'main' }, offline, topbar, content);
  // Navegação inferior (celular)
  const sheetBack = h('div', { class: 'sheet-back', onclick: () => toggleSheet(false) });
  const rest = items.filter((n) => !MOBILE_MAIN.includes(n.key));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Mais opções' }, rest.map((n) => { const a = h('a', { href: `#/${n.key}`, dataset: { key: n.key }, onclick: () => toggleSheet(false) }, icon(n.icon, 24), n.label); links.set(n.key + 'sheet', a); return a; }),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, icon('logout', 24), 'Sair'));
  const toggleSheet = (open) => { sheet.classList.toggle('open', open); sheetBack.classList.toggle('open', open); };
  const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Navegação rápida' },
    items.filter((n) => MOBILE_MAIN.includes(n.key)).map((n) => mkLink(n, ' m')),
    h('button', { onclick: () => toggleSheet(!sheet.classList.contains('open')), 'aria-label': 'Mais opções' }, icon('more', 22), h('span', null, 'Mais')));
  bottom.querySelectorAll('a').forEach((a) => { const sp = a.querySelector('svg'); void sp; });
  const wrap = h('div', { class: 'shell' }, sidebar, main);
  clear(root); root.append(wrap, bottom, sheetBack, sheet);
  const setOffline = () => offline.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', setOffline); window.addEventListener('offline', setOffline); setOffline();
  shell = { content, titleEl, links, wrap };
  refreshAlertCount();
  clearInterval(alertTimer); alertTimer = setInterval(refreshAlertCount, 60000);
}

export async function refreshAlertCount() {
  if (!session.user) return;
  try {
    const c = await api.get('/api/notifications/count'); alertCount = c.unread;
    pillEls.forEach((p) => { p.textContent = alertCount > 99 ? '99+' : String(alertCount); p.classList.toggle('hidden', alertCount === 0); });
  } catch (_) { /* silencioso */ }
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch (_) { /* sessão já inválida */ }
  session.user = null; session.filters = null; shell = null; clearInterval(alertTimer);
  navigate('#/entrar'); route();
}

// ---- Roteamento ----
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  const first = parts[0] || '';
  if (!session.user) {
    if (first === 'redefinir' && parts[1]) return renderReset(root, parts[1]);
    if (first === 'esqueci') return renderForgot(root);
    return renderLogin(root, onLogin);
  }
  if (session.user.must_change_password) return renderForcedPassword(root, async () => { session.user.must_change_password = false; shell = null; route(); });
  if (!shell || !shell.wrap.isConnected) buildShell();
  const key = VIEWS[first] ? first : 'inicio';
  if (!VIEWS[first]) { history.replaceState(null, '', '#/inicio'); }
  const nav = NAV.find((n) => n.key === key);
  if (nav.mod && !can(nav.mod)) { clear(shell.content); shell.content.appendChild(emptyState({ iconName: 'shield', title: 'Acesso restrito', text: 'Seu perfil não tem permissão para acessar esta área. Fale com o administrador.' })); return; }
  shell.titleEl.textContent = nav.label; document.title = `${nav.label} · AgroSenser Tech`;
  shell.wrap.parentNode.querySelectorAll('[data-key]').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
  const token = Symbol('view'); current = token;
  clear(shell.content); shell.content.appendChild(loading());
  try {
    const mod = await VIEWS[key]();
    if (current !== token) return;
    const host = h('div');
    await mod.render(host, { params: parts.slice(1), user: session.user, navigate, can });
    if (current !== token) return;
    clear(shell.content); shell.content.appendChild(host);
    window.scrollTo(0, 0);
  } catch (e) {
    if (current !== token) return;
    console.error(e);
    clear(shell.content);
    shell.content.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('h3', null, 'Não foi possível carregar esta tela'), h('p', null, errMsg(e)), h('button', { class: 'btn', onclick: () => route() }, icon('refresh', 17), 'Tentar novamente'))));
  }
}

async function onLogin(user) {
  session.user = user; session.filters = null; shell = null;
  navigate(location.hash && !/entrar|esqueci|redefinir/.test(location.hash) ? location.hash : '#/inicio'); route();
}

onUnauthorized(() => { if (session.user) { session.user = null; shell = null; toast('Sua sessão expirou. Entre novamente.', 'warn'); route(); } });
window.addEventListener('hashchange', route);

async function boot() {
  try { const r = await api.get('/api/auth/me'); session.user = r.user; } catch (_) { session.user = null; }
  await route();
  const sp = document.getElementById('splash'); setTimeout(() => { sp.classList.add('done'); setTimeout(() => sp.remove(), 500); }, 350);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA opcional */ });
}
boot();
