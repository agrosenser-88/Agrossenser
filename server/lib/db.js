'use strict';
// Camada de acesso ao banco (SQLite embutido do Node, sem dependências externas).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db = null;
const stmtCache = new Map();

function open(file = config.dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return db;
}

function close() {
  if (db) {
    stmtCache.clear();
    db.close();
    db = null;
  }
}

function norm(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function stmt(sql) {
  open();
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

const all = (sql, ...params) => stmt(sql).all(...norm(params)).map((r) => ({ ...r }));
const get = (sql, ...params) => {
  const r = stmt(sql).get(...norm(params));
  return r ? { ...r } : undefined;
};
const run = (sql, ...params) => {
  const r = stmt(sql).run(...norm(params));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};
const exec = (sql) => {
  open();
  db.exec(sql);
};

function tx(fn) {
  open();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* já revertido */ }
    throw e;
  }
}

function migrate() {
  open();
  exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(all('SELECT name FROM schema_migrations').map((r) => r.name));
  const done = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    tx(() => {
      exec(sql);
      run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
    });
    done.push(f);
  }
  return done;
}

module.exports = { open, close, all, get, run, exec, tx, migrate };
