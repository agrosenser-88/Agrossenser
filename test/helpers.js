'use strict';
// Ambiente de teste: banco temporário, servidor em porta aleatória e cliente HTTP com cookies.
const os = require('os');
const fs = require('fs');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agro-test-'));
process.env.DATA_DIR = dir;
process.env.ENV_FILE = path.join(dir, 'nao-existe.env');
process.env.ANTHROPIC_API_KEY = '';
process.env.WEATHER_API_BASE = 'http://127.0.0.1:9';        // fonte indisponível de propósito
process.env.WEATHER_ARCHIVE_API_BASE = 'http://127.0.0.1:9';
process.env.WEATHER_TIMEOUT_MS = '800';
process.env.SMTP_HOST = '';
process.env.ADMIN_PASSWORD = 'admin123';

const db = require('../server/lib/db');
const { createServer } = require('../server/lib/http');
const { buildApp } = require('../server/app');
const { ensureAdmin } = require('../server/seed');
const { hashPassword } = require('../server/lib/auth');

let server; let base;

async function start() {
  db.migrate();
  await ensureAdmin();
  server = createServer(buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
async function stop() {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, { body, form, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (csrf) h['x-requested-with'] = 'AgroSensor';
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('json')) data = await res.json(); else data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u, o) { return this.req('GET', u, o); }
  post(u, body, o) { return this.req('POST', u, { body: body || {}, ...o }); }
  put(u, body, o) { return this.req('PUT', u, { body, ...o }); }
  del(u, o) { return this.req('DELETE', u, o); }
  async login(username, password) { const r = await this.post('/api/auth/login', { username, password }); if (r.status !== 200) throw new Error(`login falhou ${r.status}`); return r.data.user; }
}

// PNG 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function multipart(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append(file.field || 'file', new Blob([file.data], { type: file.type }), file.name);
  return fd;
}

async function makeUser(admin, data) {
  const r = await admin.post('/api/users', { must_change_password: false, ...data });
  if (r.status !== 201) throw new Error(`criar usuário falhou: ${JSON.stringify(r.data)}`);
  return r.data;
}

async function secondOrg() {
  const org = db.run('INSERT INTO organizations (name) VALUES (?)', 'Outra Empresa');
  const hash = await hashPassword('outra12345');
  db.run('INSERT INTO users (org_id, username, name, password_hash, role) VALUES (?,?,?,?,?)', org.id, 'outro', 'Outro Admin', hash, 'admin');
  return org.id;
}

module.exports = { start, stop, Client, PNG, multipart, makeUser, secondOrg, db, dir };
