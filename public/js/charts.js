// Gráficos em SVG (sem bibliotecas): barras, linhas, rosca e medidor. Cores vêm de variáveis CSS (tema claro/escuro).
const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
export const color = (i) => COLORS[i % COLORS.length];

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const k of kids) if (k) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}
const nice = (max) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max)); const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const short = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} mi` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)} mil` : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const trunc = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

export function noData(text = 'Sem dados para exibir.') {
  const d = document.createElement('div'); d.className = 'muted small'; d.style.padding = '28px 8px'; d.style.textAlign = 'center'; d.textContent = text; return d;
}

// bar({labels, series:[{name, values, color?}], format, height})
export function barChart({ labels, series, format = short, height = 240, stacked = false }) {
  if (!labels.length || !series.length || series.every((x) => x.values.every((v) => !v))) return noData();
  const W = 640; const H = height; const m = { t: 18, r: 12, b: 46, l: 52 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, x) => a + (x.values[i] || 0), 0) : Math.max(...series.map((x) => x.values[i] || 0))));
  const max = nice(Math.max(...totals)); const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': series.map((x) => x.name).join(', ') });
  for (let i = 0; i <= 4; i += 1) {
    const y = m.t + ih - (ih * i) / 4;
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }));
    svg.appendChild(s('text', { x: m.l - 7, y: y + 4, 'text-anchor': 'end' }, format((max * i) / 4)));
  }
  const gw = iw / labels.length; const n = stacked ? 1 : series.length; const bw = Math.min(46, (gw * 0.7) / n);
  labels.forEach((lb, i) => {
    const gx = m.l + gw * i + gw / 2; let acc = 0;
    series.forEach((ser, si) => {
      const v = ser.values[i] || 0; const bh = (v / max) * ih;
      const x = stacked ? gx - bw / 2 : gx - (bw * n) / 2 + bw * si;
      const y = stacked ? m.t + ih - ((acc + v) / max) * ih : m.t + ih - bh;
      acc += v;
      if (v > 0) {
        const r = s('rect', { x, y, width: bw - 2, height: Math.max(bh, 1), rx: 4, fill: ser.color || color(si), class: 'bar' }, s('title', {}, `${lb} — ${ser.name}: ${format(v)}`));
        svg.appendChild(r);
        if (!stacked && n === 1 && labels.length <= 8) svg.appendChild(s('text', { x: x + (bw - 2) / 2, y: y - 5, 'text-anchor': 'middle', class: 'val' }, format(v)));
      }
    });
    svg.appendChild(s('text', { x: gx, y: H - m.b + 17, 'text-anchor': 'middle' }, trunc(lb, labels.length > 6 ? 9 : 14)));
  });
  svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'axis' }));
  return wrapLegend(svg, series);
}

export function lineChart({ labels, series, format = short, height = 230 }) {
  if (labels.length < 1 || series.every((x) => x.values.every((v) => v === null || v === undefined))) return noData();
  const W = 640; const H = height; const m = { t: 16, r: 14, b: 38, l: 52 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const all = series.flatMap((x) => x.values.filter((v) => v !== null && v !== undefined));
  const lo = Math.min(0, ...all); const max = nice(Math.max(...all, 0.0001)); const span = max - lo || 1;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': series.map((x) => x.name).join(', ') });
  for (let i = 0; i <= 4; i += 1) {
    const y = m.t + ih - (ih * i) / 4;
    svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }));
    svg.appendChild(s('text', { x: m.l - 7, y: y + 4, 'text-anchor': 'end' }, format(lo + (span * i) / 4)));
  }
  const px = (i) => m.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1));
  const py = (v) => m.t + ih - ((v - lo) / span) * ih;
  series.forEach((ser, si) => {
    const pts = ser.values.map((v, i) => (v === null || v === undefined ? null : [px(i), py(v), v, i]));
    const c = ser.color || color(si);
    let d = ''; let pen = false;
    pts.forEach((p) => { if (!p) { pen = false; return; } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)} `; pen = true; });
    if (si === 0 && pts.filter(Boolean).length > 1) {
      const f = pts.filter(Boolean);
      svg.appendChild(s('path', { d: `${d} L${f[f.length - 1][0]} ${m.t + ih} L${f[0][0]} ${m.t + ih} Z`, fill: c, opacity: 0.12 }));
    }
    svg.appendChild(s('path', { d, fill: 'none', stroke: c, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    pts.forEach((p) => { if (p) svg.appendChild(s('circle', { cx: p[0], cy: p[1], r: labels.length > 40 ? 0 : 3.6, fill: c, stroke: 'var(--card)', 'stroke-width': 1.5 }, s('title', {}, `${labels[p[3]]} — ${ser.name}: ${format(p[2])}`))); });
  });
  const step = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((lb, i) => { if (i % step === 0 || i === labels.length - 1) svg.appendChild(s('text', { x: px(i), y: H - m.b + 17, 'text-anchor': 'middle' }, trunc(lb, 10))); });
  svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'axis' }));
  return wrapLegend(svg, series);
}

// donut({items:[{label,value,color?}]})
export function donut({ items, format = short, size = 150, center }) {
  const total = items.reduce((a, x) => a + x.value, 0);
  const wrap = document.createElement('div'); wrap.className = 'donut-wrap';
  if (!total) { wrap.appendChild(noData()); return wrap; }
  const r = 52; const C = 2 * Math.PI * r; let off = 0;
  const svg = s('svg', { viewBox: '0 0 140 140', width: size, height: size, role: 'img', 'aria-label': items.map((x) => `${x.label}: ${x.value}`).join(', ') });
  svg.appendChild(s('circle', { cx: 70, cy: 70, r, fill: 'none', stroke: 'var(--card-2)', 'stroke-width': 20 }));
  items.forEach((it, i) => {
    if (!it.value) return;
    const len = (it.value / total) * C;
    svg.appendChild(s('circle', { cx: 70, cy: 70, r, fill: 'none', stroke: it.color || color(i), 'stroke-width': 20, 'stroke-dasharray': `${Math.max(len - 1.5, 0.5)} ${C}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 70 70)' }, s('title', {}, `${it.label}: ${format(it.value)}`)));
    off += len;
  });
  const t1 = s('text', { x: 70, y: 70, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 700, fill: 'var(--text)' }, center !== undefined ? String(center) : format(total));
  svg.appendChild(t1); svg.appendChild(s('text', { x: 70, y: 88, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-3)' }, 'total'));
  const legend = document.createElement('div'); legend.className = 'legend-list';
  items.forEach((it, i) => {
    const row = document.createElement('div'); const sw = document.createElement('i'); sw.style.background = it.color || color(i);
    const lb = document.createElement('span'); lb.textContent = it.label; const b = document.createElement('b'); b.textContent = format(it.value);
    row.append(sw, lb, b); legend.appendChild(row);
  });
  wrap.append(svg, legend);
  return wrap;
}

export function progress(pct, label) {
  const p = document.createElement('div'); p.className = 'progress'; p.setAttribute('role', 'progressbar'); p.setAttribute('aria-valuenow', String(Math.round(pct))); p.setAttribute('aria-valuemin', '0'); p.setAttribute('aria-valuemax', '100');
  if (label) p.setAttribute('aria-label', label);
  const i = document.createElement('span'); i.style.width = `${Math.max(0, Math.min(100, pct))}%`; p.appendChild(i); return p;
}

function wrapLegend(svg, series) {
  const box = document.createElement('div'); box.appendChild(svg);
  if (series.length > 1) {
    const lg = document.createElement('div'); lg.className = 'legend'; lg.style.marginTop = '6px';
    series.forEach((x, i) => { const sp = document.createElement('span'); const sw = document.createElement('i'); sw.style.background = x.color || color(i); sp.append(sw, x.name); lg.appendChild(sp); });
    box.appendChild(lg);
  }
  return box;
}
