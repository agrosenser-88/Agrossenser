'use strict';
// Mini framework HTTP (sem dependências): roteamento, JSON, multipart, cookies, estáticos, limites de taxa.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('../config');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt']);

function securityHeaders(res) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (config.isProd && config.cookieSecure) csp.push('upgrade-insecure-requests');
  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.isProd && config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* ignora cookie inválido */ }
  }
  return out;
}

function cookieString(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}; HttpOnly; SameSite=Lax`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (config.cookieSecure) s += '; Secure';
  return s;
}

function enhanceResponse(req, res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (data, status) => {
    if (status) res.statusCode = status;
    const body = Buffer.from(JSON.stringify(data));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    sendBuffer(req, res, body, true);
  };
  res.send = (buf, type, status) => {
    if (status) res.statusCode = status;
    if (type) res.setHeader('Content-Type', type);
    sendBuffer(req, res, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), false);
  };
}

function sendBuffer(req, res, body, compressible) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (compressible && body.length > 1024 && /\bgzip\b/.test(ae)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    body = zlib.gzipSync(body);
  }
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

class App {
  constructor() {
    this.routes = [];
    this.pre = [];
  }
  use(fn) { this.pre.push(fn); }
  route(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.route('GET', p, ...h); }
  post(p, ...h) { this.route('POST', p, ...h); }
  put(p, ...h) { this.route('PUT', p, ...h); }
  patch(p, ...h) { this.route('PATCH', p, ...h); }
  delete(p, ...h) { this.route('DELETE', p, ...h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (_) { params[k] = m[i + 1]; } });
        return { route: r, params };
      }
    }
    return null;
  }

  async handle(req, res) {
    enhanceResponse(req, res);
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      req.path = url.pathname;
      req.query = {};
      for (const [k, v] of url.searchParams) if (!(k in req.query)) req.query[k] = v;
      req.cookies = parseCookies(req.headers.cookie);
      req.ip = clientIp(req);
      req.params = {};

      if (req.path.startsWith('/api/') || req.path === '/api') {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        const found = this.match(method, req.path);
        if (!found) {
          const other = this.routes.some((r) => r.re.test(req.path));
          throw new HttpError(other ? 405 : 404, other ? 'Método não permitido.' : 'Recurso não encontrado.');
        }
        req.params = found.params;
        await readJsonBody(req);
        for (const fn of this.pre) await fn(req, res);
        for (const h of found.route.handlers) {
          await h(req, res);
          if (res.writableEnded) return;
        }
        if (!res.writableEnded) res.status(204).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      serveStatic(req, res);
    } catch (e) {
      handleError(req, res, e);
    }
  }
}

function handleError(req, res, e) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (e instanceof HttpError) {
    const body = { error: e.message };
    if (e.details) body.details = e.details;
    if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
    res.json(body, e.status);
    return;
  }
  console.error(`[erro] ${req.method} ${req.url}:`, e && e.stack ? e.stack : e);
  res.json({ error: 'Erro interno do servidor.' }, 500);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  req.body = {};
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) return;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Requisição muito grande.');
    chunks.push(c);
  }
  if (!size) return;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    req.body = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    throw new HttpError(400, 'JSON inválido.');
  }
}

async function readMultipart(req, { maxBytes }) {
  const ct = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!ct.includes('multipart/form-data') || !m) throw new HttpError(400, 'Envie os dados como multipart/form-data.');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes + 64 * 1024) throw new HttpError(413, `Arquivo maior que o limite de ${Math.round(maxBytes / 1048576)} MB.`);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes + 64 * 1024) throw new HttpError(413, `Arquivo maior que o limite de ${Math.round(maxBytes / 1048576)} MB.`);
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  const fields = {};
  const files = [];
  let idx = buf.indexOf(boundary);
  while (idx !== -1) {
    let start = idx + boundary.length;
    if (buf[start] === 45 && buf[start + 1] === 45) break;
    start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const next = buf.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const body = buf.slice(headerEnd + 4, next - 2);
    const disp = /content-disposition:[^\r\n]*/i.exec(headers);
    const name = disp && /\bname="([^"]*)"/i.exec(disp[0]);
    const filename = disp && /\bfilename="([^"]*)"/i.exec(disp[0]);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (name) {
      if (filename && filename[1] !== '') files.push({ field: name[1], filename: filename[1], mime: type ? type[1].trim().toLowerCase() : 'application/octet-stream', data: body });
      else if (!filename) fields[name[1]] = body.toString('utf8');
    }
    idx = next;
  }
  return { fields, files };
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.path); } catch (_) { throw new HttpError(400, 'Endereço inválido.'); }
  if (rel.includes('\0')) throw new HttpError(400, 'Endereço inválido.');
  const root = config.publicDir;
  let file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(403, 'Acesso negado.');
  let stat = null;
  try { stat = fs.statSync(file); } catch (_) { /* inexistente */ }
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    try { stat = fs.statSync(file); } catch (_) { stat = null; }
  }
  if (!stat) {
    if (path.extname(rel)) throw new HttpError(404, 'Arquivo não encontrado.');
    file = path.join(root, 'index.html');
    stat = fs.statSync(file);
  }
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
  let body = fs.readFileSync(file);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  if (COMPRESSIBLE.has(ext) && body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    body = zlib.gzipSync(body);
  }
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Limitador de taxa em memória (janela deslizante simples).
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(windowMs, 60000));
  timer.unref();
  return {
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset <= now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
      e.n += 1;
      return { ok: e.n <= max, retryAfter: Math.ceil((e.reset - now) / 1000), remaining: Math.max(0, max - e.n) };
    },
    reset(key) { hits.delete(key); },
    check(key) {
      const r = this.hit(key);
      if (!r.ok) {
        const err = new HttpError(429, 'Muitas tentativas. Aguarde um pouco e tente novamente.');
        err.headers = { 'Retry-After': String(r.retryAfter) };
        throw err;
      }
    },
  };
}

function createServer(app) {
  return http.createServer((req, res) => { app.handle(req, res); });
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { App, HttpError, createServer, readMultipart, createLimiter, cookieString, sha256, clientIp, MIME };
