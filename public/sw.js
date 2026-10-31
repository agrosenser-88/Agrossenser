// Service worker: guarda apenas arquivos estáticos públicos (casca do app). Nunca armazena respostas da API (dados sensíveis).
const VERSION = 'agrosensor-v4';
const SHELL = ['/', '/index.html', '/offline.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/ui.js', '/js/icons.js', '/js/charts.js', '/js/map.js', '/js/theme-init.js', '/js/views/auth.js', '/js/views/shared.js', '/manifest.webmanifest', '/img/logo.png', '/img/logo-mark.png', '/img/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== location.origin) return;               // tiles do mapa e outros domínios: rede normal
  if (url.pathname.startsWith('/api/')) return;              // API (dados privados): nunca em cache
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Estáticos: rede primeiro (sempre a versão mais nova), cache como reserva offline.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});
