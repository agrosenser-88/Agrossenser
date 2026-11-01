'use strict';
// Gerador de PDF mínimo (texto + tabelas simples) sem dependências. Fonte Helvetica, codificação WinAnsi.

const PAGE = { w: 842, h: 595, m: 36 }; // A4 paisagem

function enc(s) {
  const str = String(s === null || s === undefined ? '' : s).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out.push(0x5c, c);
    else if (c === 0x20ac) out.push(0x80);
    else if (c >= 32 && c <= 255) out.push(c);
    else if (c === 9 || c === 10) out.push(32);
    else out.push(63);
  }
  return Buffer.from(out);
}

// Largura aproximada de Helvetica (média por caractere).
const textWidth = (s, size) => String(s).length * size * 0.5;

function truncate(s, width, size) {
  s = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ');
  const max = Math.max(1, Math.floor(width / (size * 0.5)));
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…'.replace('…', '.') : s;
}

function buildPdf({ title, subtitle, columns, rows, summary = [] }) {
  const pages = [];
  let cur = null;
  const newPage = () => { cur = []; pages.push(cur); return PAGE.h - PAGE.m; };
  const text = (x, y, s, size = 9, bold = false) => cur.push(Buffer.concat([Buffer.from(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (`), enc(s), Buffer.from(') Tj ET\n')]));
  const rect = (x, y, w, h, rgb) => cur.push(Buffer.from(`${rgb.join(' ')} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 g\n`));

  let y = newPage();
  rect(PAGE.m, y - 4, PAGE.w - 2 * PAGE.m, 3, [0.18, 0.55, 0.25]);
  y -= 22;
  text(PAGE.m, y, 'AgroSenser Tech', 16, true);
  text(PAGE.w - PAGE.m - 190, y, 'Controle inteligente, colheita eficiente', 8);
  y -= 22;
  text(PAGE.m, y, title, 13, true);
  y -= 14;
  if (subtitle) { text(PAGE.m, y, subtitle, 9); y -= 14; }
  text(PAGE.m, y, `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, 8);
  y -= 18;
  for (const s of summary) {
    text(PAGE.m, y, `${s.label}: ${s.value}`, 9, true);
    y -= 13;
  }
  if (summary.length) y -= 4;

  const usable = PAGE.w - 2 * PAGE.m;
  const n = Math.max(columns.length, 1);
  const widths = columns.map((c) => c.width || usable / n);
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = usable / total;
  const cw = widths.map((w) => w * scale);
  const header = () => {
    rect(PAGE.m, y - 4, usable, 16, [0.9, 0.95, 0.9]);
    let x = PAGE.m + 3;
    columns.forEach((c, i) => { text(x, y, truncate(c.label, cw[i] - 6, 8), 8, true); x += cw[i]; });
    y -= 16;
  };
  header();
  rows.forEach((r, ri) => {
    if (y < PAGE.m + 20) { y = newPage(); header(); }
    if (ri % 2 === 1) rect(PAGE.m, y - 3, usable, 12, [0.97, 0.97, 0.97]);
    let x = PAGE.m + 3;
    columns.forEach((c, i) => { text(x, y, truncate(r[i], cw[i] - 6, 8), 8); x += cw[i]; });
    y -= 12;
  });
  if (!rows.length) text(PAGE.m + 3, y, 'Nenhum registro encontrado para os filtros selecionados.', 9);

  const objs = [];
  const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PLACEHOLDER');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((p, i) => {
    const body = Buffer.concat(p);
    const footer = Buffer.from(`BT /F1 8 Tf ${PAGE.m} 18 Td (Pagina ${i + 1} de ${pages.length}) Tj ET\n`);
    const content = Buffer.concat([body, footer]);
    const cId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
    const pId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cId} 0 R >>`);
    kids.push(`${pId} 0 R`);
  });
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`);
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b);
    pos += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { xref += `${String(o).padStart(10, '0')} 00000 n \n`; });
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

module.exports = { buildPdf, textWidth };
