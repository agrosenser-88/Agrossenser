// Componentes compartilhados entre telas: barra de filtros, seletor de coordenadas, lista de arquivos, CRUD genérico.
import { api, qs } from '../api.js';
import { h, clear, fmt, toast, errMsg, confirmDialog, formModal, table, iconBtn, emptyState, loading, modal, pageHead, selectOptions, getGPS, badge } from '../ui.js';
import { icon } from '../icons.js';
import { loadFilters, can } from '../app.js';

// Barra de filtros por fazenda, talhão, cultura, safra e período. state é alterado in-place.
export async function filterBar(state, onChange, { plot = true, crop = true, season = true, period = true, extra = [] } = {}) {
  const F = await loadFilters();
  const wrap = h('div', { class: 'toolbar' });
  const mk = (label, key, opts, resetKeys = []) => h('div', { class: 'field' }, h('label', null, label),
    h('select', { class: 'input', onchange: (e) => { state[key] = e.target.value; resetKeys.forEach((k) => { state[k] = ''; }); onChange(); if (resetKeys.length) rebuild(); } },
      h('option', { value: '' }, 'Todos'), opts.map((o) => h('option', { value: o.value, selected: String(state[key] || '') === String(o.value) }, o.label))));
  const date = (label, key) => h('div', { class: 'field' }, h('label', null, label), h('input', { class: 'input', type: 'date', value: state[key] || '', onchange: (e) => { state[key] = e.target.value; onChange(); } }));
  function rebuild() {
    clear(wrap);
    wrap.appendChild(mk('Fazenda', 'farm_id', selectOptions(F.farms), ['plot_id']));
    if (plot) wrap.appendChild(mk('Talhão', 'plot_id', selectOptions(F.plots.filter((p) => !state.farm_id || String(p.farm_id) === String(state.farm_id)))));
    if (crop) wrap.appendChild(mk('Cultura', 'crop', F.crops.map((c) => ({ value: c, label: c }))));
    if (season) wrap.appendChild(mk('Safra', 'season', F.seasons.map((c) => ({ value: c, label: c }))));
    if (period) wrap.append(date('De', 'from'), date('Até', 'to'));
    extra.forEach((x) => wrap.appendChild(x));
    wrap.appendChild(h('button', { class: 'btn ghost', onclick: () => { ['farm_id', 'plot_id', 'crop', 'season', 'from', 'to'].forEach((k) => { state[k] = ''; }); rebuild(); onChange(); } }, icon('x', 16), 'Limpar'));
  }
  rebuild();
  return wrap;
}

// Campo de coordenadas com GPS opcional. Retorna {el, get(), set()} — usado em formulários customizados.
export function gpsButton(form, latName = 'lat', lngName = 'lng') {
  return h('button', { type: 'button', class: 'btn sm', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const p = await getGPS(); form.set(latName, p.lat); form.set(lngName, p.lng); toast(`Localização obtida (precisão ~${Math.round(p.accuracy)} m).`); } catch (err) { toast(err.message, 'warn'); } finally { b.disabled = false; }
  } }, icon('locate', 16), 'Usar meu GPS');
}

// Lista de arquivos de um registro, com envio (somente se permitido).
export function filesPanel(refType, refId, { canWrite, accept = 'image/*,application/pdf', title = 'Arquivos' } = {}) {
  const box = h('div', { class: 'stack' });
  async function load() {
    clear(box);
    let files = [];
    try { files = await api.get(`/api/files${qs({ ref_type: refType, ref_id: refId })}`); } catch (e) { box.appendChild(h('div', { class: 'form-error' }, errMsg(e))); return; }
    const head = h('div', { class: 'row' }, h('h3', { style: { flex: 1 } }, title));
    if (canWrite) {
      const inp = h('input', { type: 'file', accept, class: 'hidden', onchange: async () => {
        if (!inp.files[0]) return;
        const fd = new FormData(); fd.append('ref_type', refType); fd.append('ref_id', refId); fd.append('file', inp.files[0]);
        try { await api.upload('/api/files', fd); toast('Arquivo enviado.'); load(); } catch (e) { toast(errMsg(e), 'err'); }
      } });
      head.append(inp, h('button', { class: 'btn sm', onclick: () => inp.click() }, icon('upload', 16), 'Enviar'));
    }
    box.appendChild(head);
    if (!files.length) box.appendChild(h('p', { class: 'muted small' }, 'Nenhum arquivo enviado.'));
    files.forEach((f) => box.appendChild(h('div', { class: 'file-row' }, icon(f.mime.startsWith('image/') ? 'camera' : 'file', 18),
      h('a', { class: 'name', href: `/api/files/${f.id}/download`, target: '_blank', rel: 'noopener' }, f.filename), h('span', { class: 'tiny muted' }, `${fmt.num(f.size / 1024, 0)} KB · ${fmt.date(f.created_at)}`),
      canWrite ? iconBtn('trash', 'Excluir arquivo', async () => { if (await confirmDialog(`Excluir "${f.filename}"?`, { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`/api/files/${f.id}`); load(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'danger') : null)));
  }
  load();
  return box;
}

// CRUD genérico: lista (tabela) + busca + filtros + formulário em modal + exclusão.
// cfg: {endpoint, module, entity, title, subtitle, columns, fields(F)=>[], filters:[{key,label,options}], defaults, searchable, extraActions(row), onRow, afterChange, emptyText, newLabel, transform}
export async function crudPage(host, cfg) {
  const F = await loadFilters();
  const state = { q: '' };
  (cfg.filters || []).forEach((f) => { state[f.key] = ''; });
  const canW = can(cfg.module, 'w'); const canD = can(cfg.module, 'd');
  const body = h('div');
  const bar = h('div', { class: 'toolbar' });
  let timer;
  if (cfg.searchable !== false) bar.appendChild(h('div', { class: 'field grow' }, h('label', null, 'Buscar'), h('input', { class: 'input', type: 'search', placeholder: 'Digite para buscar...', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; load(); }, 250); } })));
  const farmFilter = cfg.farmFilter !== false && F.farms.length > 1;
  if (farmFilter) { state.farm_id = ''; bar.appendChild(h('div', { class: 'field' }, h('label', null, 'Fazenda'), h('select', { class: 'input', onchange: (e) => { state.farm_id = e.target.value; load(); } }, h('option', { value: '' }, 'Todas'), selectOptions(F.farms).map((o) => h('option', { value: o.value }, o.label))))); }
  (cfg.filters || []).forEach((f) => bar.appendChild(h('div', { class: 'field' }, h('label', null, f.label), h('select', { class: 'input', onchange: (e) => { state[f.key] = e.target.value; load(); } }, h('option', { value: '' }, 'Todos'), f.options.map((o) => h('option', { value: o.value }, o.label))))));
  if (cfg.periodFilter) { state.from = ''; state.to = ''; bar.append(h('div', { class: 'field' }, h('label', null, 'De'), h('input', { class: 'input', type: 'date', onchange: (e) => { state.from = e.target.value; load(); } })), h('div', { class: 'field' }, h('label', null, 'Até'), h('input', { class: 'input', type: 'date', onchange: (e) => { state.to = e.target.value; load(); } }))); }

  async function load() {
    clear(body); body.appendChild(loading());
    try {
      let rows = await api.get(`${cfg.endpoint}${qs({ ...state, limit: 1000 })}`);
      if (cfg.transform) rows = cfg.transform(rows);
      clear(body);
      if (cfg.render) { body.appendChild(cfg.render(rows, { reload: load, openForm, remove })); return; }
      if (!rows.length) {
        body.appendChild(emptyState({ iconName: cfg.iconName || 'leaf', title: cfg.emptyTitle || 'Nenhum registro', text: cfg.emptyText || 'Comece cadastrando o primeiro item.', action: canW && !cfg.noCreate ? h('button', { class: 'btn primary', onclick: () => openForm() }, icon('plus', 17), cfg.newLabel || 'Novo') : null }));
        return;
      }
      body.appendChild(table(cfg.columns, rows, { onRow: cfg.onRow, actions: (canW || canD || cfg.extraActions) ? (r) => [cfg.extraActions ? cfg.extraActions(r, load) : null, canW ? iconBtn('edit', 'Editar', () => openForm(r)) : null, canD ? iconBtn('trash', 'Excluir', () => remove(r), 'danger') : null] : null }));
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }
  async function remove(r) {
    if (!(await confirmDialog(cfg.confirmDelete ? cfg.confirmDelete(r) : 'Excluir este registro? Esta ação não pode ser desfeita.', { title: 'Excluir', confirmLabel: 'Excluir', danger: true }))) return;
    try { await api.del(`${cfg.endpoint}/${r.id}`); toast('Registro excluído.'); if (cfg.afterChange) cfg.afterChange(); load(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  function openForm(row) {
    const FF = cfg.fields(F, row);
    const values = row ? { ...row } : { ...(cfg.defaults ? cfg.defaults() : {}) };
    const fm = formModal({
      title: row ? `Editar ${cfg.entity}` : `Novo(a) ${cfg.entity}`, fields: FF, values, size: cfg.modalSize || '',
      extra: cfg.formExtra ? cfg.formExtra(row) : null,
      onSubmit: async (v) => {
        const payload = {}; for (const f of FF) { if (f.noSend) continue; payload[f.name] = f.type === 'checkbox' ? v[f.name] : (v[f.name] === '' ? null : v[f.name]); }
        if (fm.payloadExtra) Object.assign(payload, fm.payloadExtra());
        const out = row ? await api.put(`${cfg.endpoint}/${row.id}`, payload) : await api.post(cfg.endpoint, payload);
        toast(row ? 'Alterações salvas.' : 'Cadastro criado.'); if (cfg.afterChange) cfg.afterChange(out); load();
      },
    });
    if (FF.some((f) => f.name === 'plot_id') && FF.some((f) => f.name === 'farm_id')) linkFarmPlot(fm.form, F);
    if (cfg.onForm) cfg.onForm(fm, row, F);
  }
  host.append(pageHead(cfg.title, cfg.subtitle, cfg.headActions ? cfg.headActions({ reload: load }) : null, canW && !cfg.noCreate ? h('button', { class: 'btn primary', onclick: () => openForm() }, icon('plus', 17), cfg.newLabel || 'Novo') : null), cfg.banner || null, bar, body);
  await load();
  return { reload: load, openForm };
}

export const farmField = (F, extra = {}) => ({ name: 'farm_id', label: 'Fazenda', type: 'select', options: selectOptions(F.farms), required: true, ...extra });
export const plotField = (F, extra = {}) => ({ name: 'plot_id', label: 'Talhão', type: 'select', options: F.plots.map((p) => ({ value: p.id, label: `${p.name}${p.crop ? ' · ' + p.crop : ''}` })), ...extra });
export { badge };

// Mantém o seletor de talhão coerente com a fazenda escolhida no formulário.
export function linkFarmPlot(form, F) {
  const farm = form.inputs.farm_id; const plot = form.inputs.plot_id; if (!farm || !plot) return;
  const fill = () => {
    const cur = plot.value; const list = F.plots.filter((p) => !farm.value || String(p.farm_id) === farm.value);
    clear(plot); plot.appendChild(h('option', { value: '' }, '— nenhum —')); list.forEach((p) => plot.appendChild(h('option', { value: p.id, selected: String(p.id) === cur }, `${p.name}${p.crop ? ' · ' + p.crop : ''}`)));
  };
  farm.addEventListener('change', fill); fill();
}
export { modal, pageHead };
