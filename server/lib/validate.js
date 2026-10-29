'use strict';
// Validadores de campos (backend). Cada validador recebe (valor, ctx) e devolve o valor normalizado ou lança Error com a mensagem.
const db = require('./db');
const { farmAllowed } = require('./auth');

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function wrap(opts, fn) {
  const validator = (value, ctx) => {
    if (isEmpty(value)) {
      if (opts.req) throw new Error('Campo obrigatório.');
      return opts.default !== undefined ? opts.default : null;
    }
    return fn(value, ctx);
  };
  validator.required = !!opts.req;
  return validator;
}

const v = {
  str(opts = {}) {
    const max = opts.max || 200;
    return wrap(opts, (value) => {
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Texto inválido.');
      const s = String(value).trim();
      if (s.length > max) throw new Error(`Máximo de ${max} caracteres.`);
      if (opts.enum && !opts.enum.includes(s)) throw new Error(`Valor inválido. Use: ${opts.enum.join(', ')}.`);
      if (opts.pattern && !opts.pattern.test(s)) throw new Error(opts.patternMsg || 'Formato inválido.');
      return s;
    });
  },
  text(opts = {}) { return v.str({ max: 5000, ...opts }); },
  num(opts = {}) {
    return wrap(opts, (value) => {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error('Número inválido.');
      if (opts.int && !Number.isInteger(n)) throw new Error('Informe um número inteiro.');
      if (opts.min !== undefined && n < opts.min) throw new Error(`Valor mínimo: ${opts.min}.`);
      if (opts.max !== undefined && n > opts.max) throw new Error(`Valor máximo: ${opts.max}.`);
      return n;
    });
  },
  lat(opts = {}) { return v.num({ ...opts, min: -90, max: 90 }); },
  lng(opts = {}) { return v.num({ ...opts, min: -180, max: 180 }); },
  date(opts = {}) {
    return wrap(opts, (value) => {
      const s = String(value).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Data inválida (use AAAA-MM-DD).');
      const d = new Date(s + 'T00:00:00Z');
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('Data inexistente.');
      if (s < '1950-01-01' || s > '2100-12-31') throw new Error('Data fora do intervalo permitido.');
      return s;
    });
  },
  datetime(opts = {}) {
    return wrap(opts, (value) => {
      const s = String(value).trim();
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new Error('Data e hora inválidas.');
      const y = d.getUTCFullYear();
      if (y < 1950 || y > 2100) throw new Error('Data fora do intervalo permitido.');
      return d.toISOString();
    });
  },
  bool(opts = {}) {
    return wrap({ default: 0, ...opts }, (value) => {
      if (value === true || value === 1 || value === '1' || value === 'true') return 1;
      if (value === false || value === 0 || value === '0' || value === 'false') return 0;
      throw new Error('Valor lógico inválido.');
    });
  },
  email(opts = {}) {
    return wrap(opts, (value) => {
      const s = String(value).trim().toLowerCase();
      if (s.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('E-mail inválido.');
      return s;
    });
  },
  // Referência a outra tabela da mesma organização.
  ref(table, opts = {}) {
    const validator = wrap(opts, (value, ctx) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new Error('Referência inválida.');
      const row = db.get(`SELECT id${table === 'farms' ? '' : ', farm_id'} FROM ${table} WHERE id = ? AND org_id = ?`, id, ctx.user.org_id);
      if (!row) throw new Error('Registro relacionado não encontrado.');
      if (table === 'farms' && !farmAllowed(ctx.user, id)) throw new Error('Sem acesso a esta fazenda.');
      if (table !== 'farms' && ctx.user.allowedFarms && row.farm_id !== null && !farmAllowed(ctx.user, row.farm_id)) throw new Error('Sem acesso ao registro relacionado.');
      return id;
    });
    validator.refTable = table;
    return validator;
  },
  // JSON arbitrário (objeto/array), limitado em tamanho. Com geo: valida geometria GeoJSON simples.
  json(opts = {}) {
    return wrap(opts, (value) => {
      let obj = value;
      if (typeof value === 'string') {
        try { obj = JSON.parse(value); } catch (_) { throw new Error('JSON inválido.'); }
      }
      if (typeof obj !== 'object') throw new Error('JSON inválido.');
      if (opts.geo) validateGeometry(obj);
      const s = JSON.stringify(obj);
      if (s.length > (opts.max || 200000)) throw new Error('Conteúdo muito grande.');
      return s;
    });
  },
};

function validateGeometry(g) {
  const okPos = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (!g || typeof g !== 'object') throw new Error('Geometria inválida.');
  if (g.type === 'Polygon') {
    if (!Array.isArray(g.coordinates) || !g.coordinates.length) throw new Error('Polígono inválido.');
    for (const ring of g.coordinates) {
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(okPos)) throw new Error('Polígono inválido (mínimo de 3 pontos).');
    }
  } else if (g.type === 'LineString') {
    if (!Array.isArray(g.coordinates) || g.coordinates.length < 2 || !g.coordinates.every(okPos)) throw new Error('Linha inválida.');
  } else if (g.type === 'Point') {
    if (!okPos(g.coordinates)) throw new Error('Ponto inválido.');
  } else if (g.type === 'GeometryCollection' || g.type === 'FeatureCollection') {
    // permite coleção simples de geometrias/feições (ex.: várias áreas)
    const items = g.geometries || (g.features || []).map((f) => f && f.geometry);
    if (!Array.isArray(items) || items.length > 200) throw new Error('Coleção de geometrias inválida.');
    items.forEach(validateGeometry);
  } else throw new Error('Tipo de geometria não suportado.');
}

// Valida um corpo de requisição segundo um esquema { campo: validador }.
function validateBody(schema, body, ctx, { partial = false } = {}) {
  const out = {};
  const errors = {};
  for (const [key, fn] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(body, key);
    if (!present) {
      if (!partial && fn.required) errors[key] = 'Campo obrigatório.';
      continue;
    }
    try {
      out[key] = fn(body[key], ctx);
    } catch (e) {
      errors[key] = e.message;
    }
  }
  return { data: out, errors };
}

module.exports = { v, validateBody, isEmpty };
