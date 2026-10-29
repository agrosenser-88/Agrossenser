// Utilitários de interface: criação segura de DOM (sem innerHTML com dados), formatação pt-BR, modais, formulários e tabelas.
import { icon } from './icons.js';
import { ApiError } from './api.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);

// ---- Formatação (DD/MM/AAAA, horário de Brasília, unidades métricas) ----
const TZ = 'America/Sao_Paulo';
export const fmt = {
  date(s) {
    if (!s) return '—';
    const str = String(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str.split('-').reverse().join('/');
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR', { timeZone: TZ });
  },
  datetime(s) {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  num(n, max = 2) { return n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: max }); },
  money(n) { return n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); },
  ha(n) { return n === null || n === undefined || n === '' ? '—' : `${fmt.num(n)} ha`; },
  pct(n, d = 1) { return n === null || n === undefined ? '—' : `${fmt.num(n, d)}%`; },
  month(s) { if (!s) return ''; const [y, m] = String(s).split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(m) - 1] + '/' + y.slice(2); },
  ago(s) {
    if (!s) return '—';
    const sec = Math.max(0, (Date.now() - new Date(s).getTime()) / 1000);
    if (sec < 60) return 'agora'; if (sec < 3600) return `há ${Math.floor(sec / 60)} min`;
    if (sec < 86400) return `há ${Math.floor(sec / 3600)} h`; if (sec < 86400 * 30) return `há ${Math.floor(sec / 86400)} d`;
    return fmt.date(s);
  },
};
export const todayISO = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // data de Brasília
export const isoToLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const nowLocalInput = () => isoToLocalInput(new Date().toISOString());

// ---- Rótulos ----
export const L = {
  severity: { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' },
  occStatus: { aberta: 'Aberta', em_tratamento: 'Em tratamento', resolvida: 'Resolvida' },
  occCategory: { praga: 'Praga', doenca: 'Doença', daninha: 'Planta daninha', deficiencia: 'Deficiência nutricional', outro: 'Outro' },
  opStatus: { planejada: 'Planejada', em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada' },
  machineStatus: { disponivel: 'Disponível', em_operacao: 'Em operação', manutencao: 'Em manutenção', inativo: 'Inativo' },
  droneStatus: { disponivel: 'Disponível', em_missao: 'Em missão', manutencao: 'Em manutenção', inativo: 'Inativo' },
  machineKind: { trator: 'Trator', pulverizador: 'Pulverizador', colheitadeira: 'Colheitadeira', plantadeira: 'Plantadeira', caminhao: 'Caminhão', outro: 'Outro' },
  sensorKind: { umidade_solo: 'Umidade do solo', temperatura: 'Temperatura', umidade_ar: 'Umidade do ar', chuva: 'Chuva', irrigacao: 'Irrigação', outro: 'Outro' },
  sensorStatus: { aguardando: 'Aguardando conexão', online: 'Online', offline: 'Sem comunicação', inativo: 'Inativo' },
  cost: { insumos: 'Insumos', combustivel: 'Combustível', manutencao: 'Manutenção', operacao_maquinas: 'Operação de máquinas', terceirizados: 'Serviços terceirizados', pulverizacao: 'Pulverização', outros: 'Outros' },
  plotStatus: { planejado: 'Planejado', ativo: 'Ativo', colhido: 'Colhido', inativo: 'Inativo' },
  missionType: { pulverizacao: 'Pulverização', mapeamento: 'Mapeamento', inspecao: 'Inspeção', outro: 'Outro' },
  maintKind: { preventiva: 'Preventiva', corretiva: 'Corretiva', inspecao: 'Inspeção' },
  alertCat: { praga: 'Pragas', sensor: 'Sensores', manutencao: 'Manutenção', operacao: 'Operações', clima: 'Clima', tarefa: 'Tarefas', admin: 'Administrativo' },
};
export const options = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));
export const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const TONE = {
  baixa: 'info', media: 'warn', alta: 'bad', critica: 'bad', aberta: 'bad', em_tratamento: 'warn', resolvida: 'ok', planejada: 'info', em_andamento: 'warn', concluida: 'ok', cancelada: 'neutral',
  disponivel: 'ok', em_operacao: 'warn', manutencao: 'warn', inativo: 'neutral', em_missao: 'warn', online: 'ok', offline: 'bad', aguardando: 'neutral', ativo: 'ok', planejado: 'info', colhido: 'neutral',
  info: 'info', atencao: 'warn', critico: 'bad', ok: 'ok', substituir: 'bad',
};
export const badge = (value, label, tone) => h('span', { class: `badge ${tone || TONE[value] || 'neutral'}` }, label || value);

// ---- Toasts, modais ----
let toastBox;
export function toast(msg, type = 'ok') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
  const t = h('div', { class: `toast ${type}` }, msg);
  toastBox.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 7000 : 3800);
}
export const errMsg = (e) => (e instanceof ApiError ? e.message : 'Ocorreu um erro inesperado.');

export function modal({ title, body, actions = [], size = '', onClose }) {
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const prev = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && back === [...document.querySelectorAll('.modal-back')].pop()) close(); };
  document.addEventListener('keydown', onKey);
  const box = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost icon sm', 'aria-label': 'Fechar', onclick: close }, icon('x', 18))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  back.appendChild(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  const first = box.querySelector('input:not([type=hidden]), select, textarea');
  if (first && !('ontouchstart' in window)) first.focus();
  return { close, el: box };
}

export function confirmDialog(message, { title = 'Confirmar', confirmLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let m; let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    m = modal({
      title, size: 'narrow', body: h('p', null, message), onClose: () => done(false),
      actions: [h('button', { class: 'btn', onclick: () => { done(false); m.close(); } }, 'Cancelar'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done(true); m.close(); } }, confirmLabel)],
    });
  });
}

// ---- Formulários ----
// Campo: {name,label,type,options,required,hint,min,max,step,full,placeholder,rows,readonly,show(values)}
export function buildForm(fields, values = {}) {
  const inputs = {}; const wraps = {};
  const grid = h('div', { class: 'form-grid' });
  const toInput = (f) => {
    const v = values[f.name];
    let inp;
    if (f.type === 'select') {
      inp = h('select', { class: 'input', name: f.name }, h('option', { value: '' }, f.placeholder || (f.required ? 'Selecione...' : '— nenhum —')),
        (f.options || []).map((o) => h('option', { value: o.value, selected: String(v) === String(o.value) }, o.label)));
    } else if (f.type === 'textarea') inp = h('textarea', { class: 'input', name: f.name, rows: f.rows || 3, placeholder: f.placeholder || '' }, v ?? '');
    else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', name: f.name, checked: !!v });
    else {
      const type = { number: 'number', date: 'date', datetime: 'datetime-local', email: 'email', password: 'password' }[f.type] || 'text';
      let val = v ?? '';
      if (f.type === 'datetime') val = isoToLocalInput(v);
      inp = h('input', { class: 'input', type, name: f.name, value: val, min: f.min, max: f.max, step: f.type === 'number' ? (f.step || 'any') : undefined, placeholder: f.placeholder || '', maxlength: f.maxlength, autocomplete: f.autocomplete || 'off', readonly: f.readonly ? '' : undefined, inputmode: f.type === 'number' ? 'decimal' : undefined });
    }
    inputs[f.name] = inp;
    return inp;
  };
  for (const f of fields) {
    const inp = toInput(f);
    const err = h('div', { class: 'err', role: 'alert' });
    const wrap = f.type === 'checkbox'
      ? h('div', { class: `field ${f.full ? 'full' : ''}` }, h('label', { class: 'check' }, inp, f.label), f.hint ? h('div', { class: 'hint' }, f.hint) : null, err)
      : h('div', { class: `field ${f.full ? 'full' : ''}` }, h('label', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : null), inp, f.hint ? h('div', { class: 'hint' }, f.hint) : null, err);
    if (f.type !== 'checkbox') { const lab = wrap.querySelector('label'); if (inp.id === '') { inp.id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`; lab.setAttribute('for', inp.id); } }
    wraps[f.name] = wrap;
    grid.appendChild(wrap);
  }
  const refreshVisibility = () => { for (const f of fields) if (f.show) wraps[f.name].classList.toggle('hidden', !f.show(read(true))); };
  const read = (silent) => {
    const out = {};
    for (const f of fields) {
      const el = inputs[f.name];
      if (f.type === 'checkbox') out[f.name] = el.checked;
      else if (f.type === 'datetime') out[f.name] = el.value ? new Date(el.value).toISOString() : '';
      else out[f.name] = el.value;
    }
    void silent;
    return out;
  };
  grid.addEventListener('input', refreshVisibility); grid.addEventListener('change', refreshVisibility);
  refreshVisibility();
  const clientCheck = () => {
    let ok = true;
    for (const f of fields) {
      const wrap = wraps[f.name]; const el = inputs[f.name];
      wrap.querySelector('.err').textContent = ''; el.classList.remove('invalid');
      if (wrap.classList.contains('hidden')) continue;
      if (f.required && f.type !== 'checkbox' && String(el.value).trim() === '') { setErr(f.name, 'Campo obrigatório.'); ok = false; }
      else if (f.type === 'number' && el.value !== '') {
        const n = Number(el.value);
        if (!Number.isFinite(n)) { setErr(f.name, 'Número inválido.'); ok = false; }
        else if (f.min !== undefined && n < Number(f.min)) { setErr(f.name, `Valor mínimo: ${f.min}.`); ok = false; }
        else if (f.max !== undefined && n > Number(f.max)) { setErr(f.name, `Valor máximo: ${f.max}.`); ok = false; }
      }
    }
    const firstBad = grid.querySelector('.invalid');
    if (firstBad) firstBad.focus();
    return ok;
  };
  const setErr = (name, msg) => { if (!wraps[name]) return; wraps[name].querySelector('.err').textContent = msg; inputs[name].classList.add('invalid'); };
  const setServerErrors = (details) => { let any = false; for (const [k, m] of Object.entries(details || {})) { if (wraps[k]) { setErr(k, m); any = true; } } return any; };
  const set = (name, val) => { const el = inputs[name]; if (!el) return; if (el.type === 'checkbox') el.checked = !!val; else el.value = val ?? ''; refreshVisibility(); };
  return { el: grid, inputs, read, clientCheck, setServerErrors, set };
}

// Abre um modal com formulário; onSubmit(values) deve retornar uma Promise. Erros de validação do servidor aparecem nos campos.
export function formModal({ title, fields, values = {}, submitLabel = 'Salvar', size = '', intro, extra, onSubmit }) {
  const form = buildForm(fields, values);
  const errBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const wrapper = h('form', { novalidate: '', onsubmit: async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    if (!form.clientCheck()) return;
    submit.disabled = true;
    try { await onSubmit(form.read(), m); m.close(); } catch (err) {
      const shown = err instanceof ApiError && form.setServerErrors(err.details);
      errBox.textContent = shown ? 'Corrija os campos destacados.' : errMsg(err);
      errBox.classList.remove('hidden');
      const bad = form.el.querySelector('.invalid'); if (bad) bad.focus();
    } finally { submit.disabled = false; }
  } }, intro ? h('p', { class: 'muted small', style: { marginBottom: '12px' } }, intro) : null, form.el, extra || null, errBox);
  const m = modal({ title, size, body: wrapper, actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancelar'), submit] });
  submit.type = 'button';
  submit.addEventListener('click', () => wrapper.requestSubmit());
  return { ...m, form };
}

// ---- Tabela ----
// columns: [{key|render, label, num, cls}]
export function table(columns, rows, { onRow, empty = 'Nada por aqui ainda.', actions } = {}) {
  const head = h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)), actions ? h('th', null, '') : null);
  const body = rows.map((r) => {
    const tr = h('tr', { style: onRow ? { cursor: 'pointer' } : null, onclick: onRow ? (e) => { if (!e.target.closest('button, a, input, select')) onRow(r); } : null },
      columns.map((c) => h('td', { class: `${c.num ? 'num' : ''} ${c.cls || ''}` }, c.render ? c.render(r) : (r[c.key] ?? '—'))),
      actions ? h('td', { class: 'actions-cell' }, actions(r)) : null);
    return tr;
  });
  if (!rows.length) return h('div', { class: 'card flat' }, h('div', { class: 'empty' }, h('p', null, empty)));
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, body)));
}

export const iconBtn = (name, label, onclick, cls = '') => h('button', { class: `btn ghost icon sm ${cls}`, title: label, 'aria-label': label, onclick }, icon(name, 17));

export function emptyState({ iconName = 'leaf', title, text, action }) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'ico-big' }, icon(iconName, 28)), h('h3', null, title), text ? h('p', null, text) : null, action || null));
}

export const loading = () => h('div', { class: 'loading' }, h('span', { class: 'spinner', role: 'status', 'aria-label': 'Carregando' }));

export function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null), h('div', { class: 'actions' }, actions));
}

export function tabs(items, active, onChange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const render = (cur) => { clear(bar); items.forEach((t) => bar.appendChild(h('button', { class: `tab ${t.key === cur ? 'active' : ''}`, role: 'tab', 'aria-selected': String(t.key === cur), onclick: () => { render(t.key); onChange(t.key); } }, t.label))); };
  render(active);
  return bar;
}

export function selectOptions(list, { value = 'id', label = 'name' } = {}) { return list.map((x) => ({ value: x[value], label: typeof label === 'function' ? label(x) : x[label] })); }

export function toolbarSelect(label, name, opts, current, onChange) {
  return h('div', { class: 'field' }, h('label', null, label), h('select', { class: 'input', name, onchange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, 'Todos'), opts.map((o) => h('option', { value: o.value, selected: String(current) === String(o.value) }, o.label))));
}

export const copyText = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copiado.'); } catch (_) { toast('Não foi possível copiar automaticamente. Selecione o texto e copie.', 'warn'); } };

export function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este aparelho não oferece GPS. Informe a localização manualmente.'));
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Permissão de localização negada. Informe a localização manualmente.' : 'Não foi possível obter a localização. Informe manualmente.')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}
