// Cliente da API. Todas as chamadas levam o cabeçalho anti-CSRF e tratam sessão expirada.
export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details || null; }
}

const listeners = { unauthorized: [] };
export const onUnauthorized = (fn) => listeners.unauthorized.push(fn);

async function request(method, url, { body, form, raw } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'AgroSensor' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch (e) {
    throw new ApiError(0, navigator.onLine === false ? 'Sem conexão com a internet. Verifique a rede e tente novamente.' : 'Não foi possível falar com o servidor. Tente novamente em instantes.');
  }
  if (raw && res.ok) return res;
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { data = await res.json(); } catch (_) { data = null; } }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/login')) listeners.unauthorized.forEach((fn) => fn());
    throw new ApiError(res.status, (data && data.error) || `Erro ${res.status}`, data && data.details);
  }
  if (res.headers.get('X-Total-Count') && Array.isArray(data)) data.total = Number(res.headers.get('X-Total-Count'));
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, body) => request('POST', u, { body: body || {} }),
  put: (u, body) => request('PUT', u, { body }),
  del: (u) => request('DELETE', u),
  upload: (u, form) => request('POST', u, { form }),
  raw: (u) => request('GET', u, { raw: true }),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
};

// Baixa um arquivo (relatório/backup) respeitando a sessão.
export async function download(url, fallbackName) {
  const res = await api.raw(url);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
