import { api } from '../api.js';
import { h, clear, fmt, L, badge, errMsg, pageHead, loading, emptyState, toast, selectOptions, modal, formModal, options, confirmDialog } from '../ui.js';
import { icon } from '../icons.js';
import { loadFilters, can } from '../app.js';
import { linkFarmPlot } from './shared.js';

const TONE = { concluida: 'ok', indisponivel: 'warn', erro: 'bad', pendente: 'neutral' };
const STATUS = { concluida: 'Concluída', indisponivel: 'Análise indisponível', erro: 'Erro na análise', pendente: 'Pendente' };

export async function render(host) {
  const F = await loadFilters();
  const body = h('div', { class: 'stack' });
  let status = { configured: false };
  try { status = await api.get('/api/ia/status'); } catch (_) { /* segue sem status */ }
  const banner = status.configured
    ? h('div', { class: 'notice ok' }, icon('check', 18), h('div', null, h('b', null, 'Serviço de visão computacional conectado.'), ' Os resultados são indicativos e não substituem a avaliação de um engenheiro agrônomo.'))
    : h('div', { class: 'notice warn' }, icon('alert', 18), h('div', null, h('b', null, 'Análise automática ainda não configurada.'), ' Você já pode enviar fotos: elas ficam salvas com fazenda, talhão e sintomas. Para ativar a análise, o administrador deve definir a chave do serviço de IA no servidor (veja Configurações > Integrações).'));
  host.append(pageHead('AgroSenser IA', 'Fotografe a planta, informe os sintomas e receba possibilidades para investigar.', can('ia', 'w') ? h('button', { class: 'btn primary', onclick: () => newAnalysis() }, icon('camera', 17), 'Nova análise') : null), banner, body);
  await load();

  async function load() {
    clear(body); body.appendChild(loading());
    try {
      const rows = await api.get('/api/ia/analyses'); clear(body);
      if (!rows.length) { body.appendChild(emptyState({ iconName: 'ia', title: 'Nenhuma análise ainda', text: 'Fotografe uma folha, fruto ou planta com sintomas. Informe a cultura e descreva o que observou para melhorar a análise.', action: can('ia', 'w') ? h('button', { class: 'btn primary', onclick: () => newAnalysis() }, icon('camera', 17), 'Fazer a primeira análise') : null })); return; }
      body.appendChild(h('div', { class: 'grid g-auto' }, rows.map((r) => h('div', { class: 'card item-card', style: { cursor: 'pointer' }, onclick: () => open(r.id) },
        r.image_id ? h('img', { class: 'thumb', style: { maxHeight: '170px', objectFit: 'cover' }, src: `/api/files/${r.image_id}/download`, alt: `Foto da análise ${r.id}`, loading: 'lazy' }) : null,
        h('div', { class: 'row' }, badge(r.status, STATUS[r.status], TONE[r.status]), r.confidence !== null ? h('span', { class: 'tiny muted' }, `confiança ${fmt.pct(r.confidence * 100, 0)}`) : null),
        h('div', null, h('h3', null, r.top || (r.status === 'concluida' ? 'Sem indício claro' : 'Aguardando análise')), h('div', { class: 'small muted' }, `${r.farm_name}${r.plot_name ? ' / ' + r.plot_name : ''}${r.crop ? ' · ' + r.crop : ''}`), h('div', { class: 'tiny muted' }, fmt.datetime(r.created_at))),
        r.occurrences_count ? h('div', { class: 'tiny' }, badge('ok', 'Ocorrência registrada', 'ok')) : null))));
    } catch (e) { clear(body); body.appendChild(h('div', { class: 'form-error' }, errMsg(e))); }
  }

  function newAnalysis() {
    const fields = [
      { name: 'farm_id', label: 'Fazenda', type: 'select', required: true, options: selectOptions(F.farms) }, { name: 'plot_id', label: 'Talhão', type: 'select', options: F.plots.map((p) => ({ value: p.id, label: `${p.name}${p.crop ? ' · ' + p.crop : ''}` })) },
      { name: 'crop', label: 'Cultura', maxlength: 80, placeholder: 'Ex.: Soja' }, { name: 'symptoms', label: 'Sintomas observados', type: 'textarea', full: true, placeholder: 'Ex.: manchas amarelas nas folhas baixeiras, folhas enroladas, presença de insetos...' },
    ];
    const cam = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', capture: 'environment', class: 'hidden' });
    const gal = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'hidden' });
    let file = null; const preview = h('div', { class: 'muted small' }, 'Nenhuma imagem selecionada.');
    const pick = (inp) => { const f = inp.files[0]; if (!f) return; file = f; clear(preview); const url = URL.createObjectURL(f); preview.appendChild(h('img', { class: 'thumb', src: url, alt: 'Pré-visualização da imagem' })); preview.appendChild(h('div', { class: 'tiny muted' }, `${f.name} · ${fmt.num(f.size / 1048576)} MB`)); };
    cam.onchange = () => pick(cam); gal.onchange = () => pick(gal);
    const imgBox = h('div', { class: 'stack', style: { marginTop: '12px' } }, h('div', { class: 'row' }, cam, gal, h('button', { type: 'button', class: 'btn', onclick: () => cam.click() }, icon('camera', 17), 'Fotografar'), h('button', { type: 'button', class: 'btn', onclick: () => gal.click() }, icon('upload', 17), 'Escolher da galeria')), preview, h('div', { class: 'tiny muted' }, 'Dica: foto nítida, com boa luz, mostrando a parte afetada de perto e a planta inteira.'));
    const fm = formModal({
      title: 'Nova análise', fields, values: { farm_id: F.farms.length === 1 ? F.farms[0].id : '' }, submitLabel: 'Enviar para análise', extra: imgBox, size: 'wide',
      onSubmit: async (v, m) => {
        if (!file) throw new Error('Selecione ou fotografe uma imagem.');
        const fd = new FormData(); Object.entries(v).forEach(([k, val]) => { if (val !== '') fd.append(k, val); }); fd.append('image', file);
        const r = await api.upload('/api/ia/analyses', fd); toast(r.status === 'concluida' ? 'Análise concluída.' : 'Imagem salva.', r.status === 'concluida' ? 'ok' : 'warn'); load(); open(r.id); void m;
      },
    });
    linkFarmPlot(fm.form, F);
    fm.form.inputs.plot_id.addEventListener('change', () => { const p = F.plots.find((x) => String(x.id) === fm.form.inputs.plot_id.value); if (p && p.crop && !fm.form.inputs.crop.value) fm.form.set('crop', p.crop); });
  }

  async function open(id) {
    let r;
    try { r = await api.get(`/api/ia/analyses/${id}`); } catch (e) { toast(errMsg(e), 'err'); return; }
    const res = r.result; const box = h('div', { class: 'stack' });
    if (r.images[0]) box.appendChild(h('img', { class: 'thumb', src: `/api/files/${r.images[0].id}/download`, alt: 'Imagem analisada' }));
    box.appendChild(h('dl', { class: 'kv' }, h('dt', null, 'Fazenda'), h('dd', null, r.farm_name), h('dt', null, 'Talhão'), h('dd', null, r.plot_name || '—'), h('dt', null, 'Cultura'), h('dd', null, r.crop || '—'), h('dt', null, 'Sintomas informados'), h('dd', null, r.symptoms || '—'), h('dt', null, 'Data'), h('dd', null, fmt.datetime(r.created_at)), h('dt', null, 'Situação'), h('dd', null, badge(r.status, STATUS[r.status], TONE[r.status]))));
    const actions = [];
    if (r.status !== 'concluida') {
      box.appendChild(h('div', { class: `notice ${r.status === 'erro' ? 'warn' : 'warn'}` }, icon('info', 18), r.message || 'A análise ainda não foi realizada.'));
      if (can('ia', 'w')) actions.push(h('button', { class: 'btn primary', onclick: async (e) => { e.currentTarget.disabled = true; try { const x = await api.post(`/api/ia/analyses/${id}/retry`); toast(x.status === 'concluida' ? 'Análise concluída.' : (x.message || 'Análise indisponível.'), x.status === 'concluida' ? 'ok' : 'warn'); m.close(); load(); open(id); } catch (er) { toast(errMsg(er), 'err'); e.currentTarget.disabled = false; } } }, icon('refresh', 17), 'Tentar analisar novamente'));
    } else if (res) {
      if (!res.image_usable) box.appendChild(h('div', { class: 'notice warn' }, icon('alert', 18), 'A imagem não permitiu uma análise confiável. Envie uma foto mais nítida, de perto, com boa iluminação.'));
      if (res.summary) box.appendChild(h('p', null, res.summary));
      if (res.observed_symptoms.length) box.appendChild(section('Sintomas observados na imagem', res.observed_symptoms));
      if (res.possibilities.length) box.appendChild(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Possíveis pragas ou doenças'), h('div', { class: 'stack', style: { gap: '10px' } }, res.possibilities.map((p) => h('div', { class: 'card flat', style: { padding: '12px' } },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, p.name), badge('x', `${L.occCategory[p.category]}`, 'neutral'), badge('x', `confiança ${fmt.pct(p.confidence * 100, 0)}`, p.confidence >= 0.7 ? 'ok' : p.confidence >= 0.4 ? 'warn' : 'neutral')), p.reasoning ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, p.reasoning) : null,
        can('occurrences', 'w') ? h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => registerOccurrence(r, p, m) }, icon('plus', 15), 'Registrar como ocorrência') : null)))));
      if (res.alternative_causes.length) box.appendChild(section('Causas alternativas', res.alternative_causes));
      if (res.investigation_steps.length) box.appendChild(section('Como investigar e confirmar', res.investigation_steps));
      if (res.general_management.length) box.appendChild(section('Recomendações gerais de manejo', res.general_management));
      if (res.limitations) box.appendChild(h('p', { class: 'small muted' }, `Limitações: ${res.limitations}`));
      box.appendChild(h('div', { class: 'notice' }, icon('shield', 18), h('div', null, h('b', null, 'Avaliação profissional necessária.'), ' Este resultado é apoio à decisão. Não indica produtos nem doses; qualquer controle químico exige avaliação de engenheiro agrônomo e receituário.')));
    }
    if (can('ia', 'd')) actions.unshift(h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Excluir esta análise e a imagem?', { danger: true, confirmLabel: 'Excluir' })) { try { await api.del(`/api/ia/analyses/${id}`); m.close(); load(); } catch (e) { toast(errMsg(e), 'err'); } } } }, icon('trash', 16), 'Excluir'));
    const m = modal({ title: `Análise #${r.id}`, body: box, size: 'wide', actions });
  }

  function section(title, items) { return h('div', null, h('h3', { style: { marginBottom: '6px' } }, title), h('ul', { style: { margin: 0, paddingLeft: '20px', lineHeight: '1.65' } }, items.map((i) => h('li', null, i)))); }

  function registerOccurrence(r, p, parent) {
    const sevMap = p.confidence >= 0.7 ? 'media' : 'baixa';
    formModal({
      title: 'Registrar ocorrência', intro: 'A ocorrência será criada como sugestão da IA, vinculada a esta análise. Revise os dados antes de salvar.', submitLabel: 'Criar ocorrência',
      fields: [{ name: 'name', label: 'Praga / doença', required: true, full: true, maxlength: 150 }, { name: 'category', label: 'Tipo', type: 'select', options: options(L.occCategory), required: true }, { name: 'severity', label: 'Gravidade', type: 'select', options: options(L.severity), required: true }, { name: 'lat', label: 'Latitude', type: 'number', min: -90, max: 90 }, { name: 'lng', label: 'Longitude', type: 'number', min: -180, max: 180 }],
      values: { name: p.name, category: p.category, severity: sevMap },
      onSubmit: async (v) => { const body2 = {}; Object.entries(v).forEach(([k, val]) => { body2[k] = val === '' ? null : val; }); await api.post(`/api/ia/analyses/${r.id}/occurrence`, body2); toast('Ocorrência registrada.'); parent.close(); load(); },
    });
  }
}
