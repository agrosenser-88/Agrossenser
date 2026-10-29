// Mapa interativo leve (Web Mercator + tiles do OpenStreetMap) com arrastar, zoom (roda, botões, pinça), marcadores,
// polígonos, linhas, seleção de ponto e desenho de áreas. Sem bibliotecas externas.
import { icon } from './icons.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TILE = 256;
const MAX_Z = 19; const MIN_Z = 3;
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const worldPx = (lat, lng, z) => {
  const sc = TILE * 2 ** z; const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * sc, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * sc };
};
const unproject = (x, y, z) => {
  const sc = TILE * 2 ** z; const lng = (x / sc) * 360 - 180; const n = Math.PI - (2 * Math.PI * y) / sc;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
};

export class AgroMap {
  constructor(container, { lat = -15.78, lng = -47.93, zoom = 4 } = {}) {
    this.root = container; this.center = { lat, lng }; this.zoom = zoom;
    this.markers = []; this.shapes = []; this.tiles = new Map(); this.clickCb = null; this.draw = null; this.popup = null;
    this.root.classList.add('map-box'); this.root.setAttribute('role', 'application'); this.root.setAttribute('aria-label', 'Mapa interativo');
    this.tileLayer = el('div', 'map-tiles'); this.svg = document.createElementNS(SVGNS, 'svg'); this.svg.setAttribute('class', 'map-svg');
    this.markerLayer = el('div', 'map-markers');
    const ctrl = el('div', 'map-ctrl');
    ctrl.append(this.btn('plus', 'Aproximar', () => this.zoomBy(1)), this.btn('minus', 'Afastar', () => this.zoomBy(-1)));
    this.attr = el('div', 'map-attr'); this.attr.textContent = '© Colaboradores do OpenStreetMap';
    this.root.append(this.tileLayer, this.svg, this.markerLayer, ctrl, this.attr);
    this.ctrl = ctrl;
    this.bind();
    this.ro = new ResizeObserver(() => this.render()); this.ro.observe(this.root);
    this.render();
  }
  btn(name, label, fn) {
    const b = el('button', 'btn'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    if (name === 'minus') { const s = icon('plus', 18); s.innerHTML = '<path d="M5 12h14"/>'; b.appendChild(s); } else b.appendChild(icon(name, 18));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); b.addEventListener('pointerdown', (e) => e.stopPropagation()); return b;
  }
  addControl(name, label, fn) { const b = this.btn(name, label, fn); this.ctrl.appendChild(b); return b; }
  get size() { return { w: this.root.clientWidth || 600, h: this.root.clientHeight || 400 }; }
  toScreen(lat, lng) {
    const c = worldPx(this.center.lat, this.center.lng, this.zoom); const p = worldPx(lat, lng, this.zoom); const { w, h } = this.size;
    return { x: p.x - c.x + w / 2, y: p.y - c.y + h / 2 };
  }
  fromScreen(x, y) {
    const c = worldPx(this.center.lat, this.center.lng, this.zoom); const { w, h } = this.size;
    return unproject(c.x + x - w / 2, c.y + y - h / 2, this.zoom);
  }
  setView(lat, lng, zoom) { this.center = { lat, lng }; if (zoom !== undefined) this.zoom = Math.max(MIN_Z, Math.min(MAX_Z, zoom)); this.render(); }
  zoomBy(d, at) {
    const nz = Math.max(MIN_Z, Math.min(MAX_Z, this.zoom + d)); if (nz === this.zoom) return;
    if (at) { const ll = this.fromScreen(at.x, at.y); this.zoom = nz; const p = this.toScreen(ll.lat, ll.lng); this.panPx(p.x - at.x, p.y - at.y); } else { this.zoom = nz; }
    this.render();
  }
  panPx(dx, dy) { const c = worldPx(this.center.lat, this.center.lng, this.zoom); this.center = unproject(c.x + dx, c.y + dy, this.zoom); }
  fitPoints(points, { maxZoom = 16, pad = 50 } = {}) {
    const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!pts.length) return false;
    if (pts.length === 1) { this.setView(pts[0].lat, pts[0].lng, Math.min(maxZoom, 14)); return true; }
    const { w, h } = this.size;
    for (let z = maxZoom; z >= MIN_Z; z -= 1) {
      const ps = pts.map((p) => worldPx(p.lat, p.lng, z));
      const minX = Math.min(...ps.map((p) => p.x)); const maxX = Math.max(...ps.map((p) => p.x)); const minY = Math.min(...ps.map((p) => p.y)); const maxY = Math.max(...ps.map((p) => p.y));
      if (maxX - minX <= w - pad * 2 && maxY - minY <= h - pad * 2) { const c = unproject((minX + maxX) / 2, (minY + maxY) / 2, z); this.setView(c.lat, c.lng, z); return true; }
    }
    const c = pts[0]; this.setView(c.lat, c.lng, MIN_Z); return true;
  }
  bind() {
    const ptrs = new Map(); let moved = 0; let lastDist = 0; let startPt = null;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.map-ctrl, .map-popup, .map-marker, .map-hint')) return;
      this.root.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; startPt = { x: e.clientX, y: e.clientY };
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; lastDist = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    this.root.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId); const cur = { x: e.clientX, y: e.clientY }; ptrs.set(e.pointerId, cur);
      if (ptrs.size === 1) { moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y); this.panPx(-(cur.x - prev.x), -(cur.y - prev.y)); this.render(); } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); moved += 10;
        if (lastDist && Math.abs(d - lastDist) > 30) { const r = this.root.getBoundingClientRect(); this.zoomBy(d > lastDist ? 1 : -1, { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }); lastDist = d; }
      }
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId);
      if (ptrs.size === 0 && moved < 6 && startPt) { const r = this.root.getBoundingClientRect(); this.handleClick({ x: e.clientX - r.left, y: e.clientY - r.top }); }
    };
    this.root.addEventListener('pointerup', up); this.root.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
    this.root.addEventListener('wheel', (e) => { e.preventDefault(); const r = this.root.getBoundingClientRect(); this.zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top }); }, { passive: false });
    this.root.addEventListener('dblclick', (e) => { if (this.draw) return; const r = this.root.getBoundingClientRect(); this.zoomBy(1, { x: e.clientX - r.left, y: e.clientY - r.top }); });
    this.root.addEventListener('keydown', (e) => { const k = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[e.key]; if (k) { this.panPx(...k); this.render(); e.preventDefault(); } else if (e.key === '+') this.zoomBy(1); else if (e.key === '-') this.zoomBy(-1); });
    this.root.tabIndex = 0;
  }
  handleClick(pt) {
    this.closePopup();
    const ll = this.fromScreen(pt.x, pt.y);
    if (this.draw) { this.draw.points.push([Number(ll.lng.toFixed(6)), Number(ll.lat.toFixed(6))]); this.render(); this.draw.onChange && this.draw.onChange(this.draw.points.length); return; }
    if (this.clickCb) this.clickCb(ll);
  }
  onClick(cb) { this.clickCb = cb; this.root.style.cursor = cb ? 'crosshair' : ''; }
  // Desenho de polígono: cada clique adiciona um vértice.
  startDraw(onChange) { this.draw = { points: [], onChange }; this.root.style.cursor = 'crosshair'; this.render(); }
  undoDraw() { if (this.draw) { this.draw.points.pop(); this.render(); this.draw.onChange && this.draw.onChange(this.draw.points.length); } }
  finishDraw() {
    if (!this.draw) return null; const pts = this.draw.points; this.draw = null; this.root.style.cursor = this.clickCb ? 'crosshair' : ''; this.render();
    if (pts.length < 3) return null; return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
  }
  cancelDraw() { this.draw = null; this.root.style.cursor = this.clickCb ? 'crosshair' : ''; this.render(); }
  clear() { this.markers = []; this.shapes = []; this.closePopup(); this.render(); }
  // marker: {lat,lng,color,dot,title,popup:()=>Node,onClick}
  addMarker(m) { this.markers.push(m); return m; }
  // shape: {geometry (GeoJSON Polygon/LineString/GeometryCollection), fill, stroke, opacity, dash, popup, onClick, label}
  addShape(sh) { this.shapes.push(sh); return sh; }
  openPopup(lat, lng, node) {
    this.closePopup(); const p = el('div', 'map-popup'); const x = el('button', 'btn ghost icon sm x'); x.type = 'button'; x.setAttribute('aria-label', 'Fechar'); x.appendChild(icon('x', 15));
    x.addEventListener('click', () => this.closePopup()); p.append(x, node); p.addEventListener('pointerdown', (e) => e.stopPropagation()); p.addEventListener('wheel', (e) => e.stopPropagation());
    this.popup = { lat, lng, el: p }; this.root.appendChild(p); this.placePopup();
  }
  placePopup() { if (!this.popup) return; const s = this.toScreen(this.popup.lat, this.popup.lng); this.popup.el.style.left = `${s.x}px`; this.popup.el.style.top = `${s.y}px`; }
  closePopup() { if (this.popup) { this.popup.el.remove(); this.popup = null; } }
  setHint(text) { if (this.hint) { this.hint.remove(); this.hint = null; } if (text) { this.hint = el('div', 'map-hint'); this.hint.textContent = text; this.root.appendChild(this.hint); } return this.hint; }
  render() {
    const { w, h } = this.size; const z = this.zoom; const c = worldPx(this.center.lat, this.center.lng, z);
    const x0 = c.x - w / 2; const y0 = c.y - h / 2; const n = 2 ** z; const need = new Set();
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx += 1) {
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty += 1) {
        if (ty < 0 || ty >= n) continue; const wx = ((tx % n) + n) % n; const key = `${z}/${wx}/${ty}/${tx}`; need.add(key);
        let img = this.tiles.get(key);
        if (!img) { img = new Image(); img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin'; img.src = TILE_URL(z, wx, ty); img.onerror = () => { img.style.visibility = 'hidden'; }; this.tileLayer.appendChild(img); this.tiles.set(key, img); }
        img.style.left = `${Math.round(tx * TILE - x0)}px`; img.style.top = `${Math.round(ty * TILE - y0)}px`;
      }
    }
    for (const [k, img] of this.tiles) if (!need.has(k)) { if (!k.startsWith(`${z}/`) && this.tiles.size < 80) { img.style.display = 'none'; } else { img.remove(); this.tiles.delete(k); } }
    for (const [k, img] of this.tiles) if (need.has(k)) img.style.display = '';
    this.drawVectors(); this.drawMarkers(); this.placePopup();
  }
  path(coords, close) {
    return coords.map((p, i) => { const s = this.toScreen(p[1], p[0]); return `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`; }).join(' ') + (close ? ' Z' : '');
  }
  drawVectors() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    const geoms = (g) => (!g ? [] : g.type === 'GeometryCollection' ? g.geometries.flatMap(geoms) : g.type === 'FeatureCollection' ? g.features.flatMap((f) => geoms(f.geometry)) : [g]);
    this.shapes.forEach((sh, idx) => {
      geoms(sh.geometry).forEach((g) => {
        let d = '';
        if (g.type === 'Polygon') d = g.coordinates.map((r) => this.path(r, true)).join(' ');
        else if (g.type === 'LineString') d = this.path(g.coordinates, false);
        else return;
        const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d);
        p.setAttribute('fill', g.type === 'Polygon' ? sh.fill || 'rgba(182,240,58,.25)' : 'none'); p.setAttribute('stroke', sh.stroke || '#b6f03a'); p.setAttribute('stroke-width', sh.width || 2.4);
        p.setAttribute('stroke-linejoin', 'round'); if (sh.dash) p.setAttribute('stroke-dasharray', sh.dash); p.setAttribute('fill-rule', 'evenodd');
        if (sh.popup || sh.onClick) { p.setAttribute('data-click', idx); p.addEventListener('click', (e) => { e.stopPropagation(); if (this.draw) return; const r = this.root.getBoundingClientRect(); const ll = this.fromScreen(e.clientX - r.left, e.clientY - r.top); if (sh.onClick) sh.onClick(sh, ll); if (sh.popup) this.openPopup(ll.lat, ll.lng, sh.popup()); }); }
        this.svg.appendChild(p);
      });
      if (sh.label) {
        const g = geoms(sh.geometry).find((x) => x.type === 'Polygon'); if (g) {
          const ring = g.coordinates[0]; const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length; const lng = ring.reduce((a, p) => a + p[0], 0) / ring.length; const s = this.toScreen(lat, lng);
          const t = document.createElementNS(SVGNS, 'text'); t.setAttribute('x', s.x); t.setAttribute('y', s.y); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '12'); t.setAttribute('font-weight', '700');
          t.setAttribute('fill', '#fff'); t.setAttribute('stroke', 'rgba(0,0,0,.7)'); t.setAttribute('stroke-width', '3'); t.setAttribute('paint-order', 'stroke'); t.textContent = sh.label; this.svg.appendChild(t);
        }
      }
    });
    if (this.draw && this.draw.points.length) {
      const pts = this.draw.points; const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', this.path(pts, pts.length > 2)); p.setAttribute('fill', 'rgba(77,141,255,.25)'); p.setAttribute('stroke', '#4d8dff'); p.setAttribute('stroke-width', '2.5'); p.setAttribute('stroke-dasharray', '6 4'); this.svg.appendChild(p);
      pts.forEach((pt) => { const s = this.toScreen(pt[1], pt[0]); const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', s.x); c.setAttribute('cy', s.y); c.setAttribute('r', 5); c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#4d8dff'); c.setAttribute('stroke-width', '2'); this.svg.appendChild(c); });
    }
  }
  drawMarkers() {
    while (this.markerLayer.firstChild) this.markerLayer.removeChild(this.markerLayer.firstChild);
    const { w, h } = this.size;
    for (const m of this.markers) {
      const s = this.toScreen(m.lat, m.lng); if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 60) continue;
      const d = el('div', `map-marker${m.dot ? ' dot' : ''}`); d.style.left = `${s.x}px`; d.style.top = `${s.y}px`; if (m.title) d.title = m.title;
      const pin = el('span', 'pin'); pin.style.background = m.color || '#b6f03a'; d.appendChild(pin); d.setAttribute('role', 'button'); d.setAttribute('aria-label', m.title || 'Ponto no mapa');
      d.addEventListener('pointerdown', (e) => e.stopPropagation());
      d.addEventListener('click', (e) => { e.stopPropagation(); if (this.draw) return; if (m.onClick) m.onClick(m); if (m.popup) this.openPopup(m.lat, m.lng, m.popup()); });
      this.markerLayer.appendChild(d);
    }
  }
  destroy() { this.ro.disconnect(); this.root.innerHTML = ''; }
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

export const SEV_COLOR = { baixa: '#4d8dff', media: '#f5a524', alta: '#ff7a45', critica: '#ff3b4e' };

// Área aproximada (ha) de um polígono GeoJSON (projeção equiretangular local; suficiente para talhões).
export function polygonAreaHa(geom) {
  if (!geom || geom.type !== 'Polygon') return null;
  const ring = geom.coordinates[0]; if (!ring || ring.length < 4) return null;
  const lat0 = (ring.reduce((a, p) => a + p[1], 0) / ring.length) * (Math.PI / 180); const R = 6371008.8;
  const pts = ring.map((p) => [(p[0] * Math.PI / 180) * R * Math.cos(lat0), (p[1] * Math.PI / 180) * R]);
  let a = 0; for (let i = 0; i < pts.length - 1; i += 1) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return Math.abs(a / 2) / 10000;
}
export function polygonCenter(geom) {
  const g = geom && geom.type === 'Polygon' ? geom.coordinates[0] : null; if (!g) return null;
  return { lat: g.reduce((a, p) => a + p[1], 0) / g.length, lng: g.reduce((a, p) => a + p[0], 0) / g.length };
}
