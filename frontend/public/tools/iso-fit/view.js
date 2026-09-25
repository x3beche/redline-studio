// Clearance Fit Calculator: the page is the ISO 286 zone chart you work on.
//   Size    - a log ruler of nominal sizes with the ISO size steps; drag the
//             marker (or arrow keys) to change the diameter.
//   Fit     - the chosen hole and shaft zones against the zero line, zoomed to
//             them, with the smallest and largest clearance dimensioned between
//             them and the resulting range on its own bar. Drag a zone's free
//             edge to change its grade; with a zone focused, up/down changes the
//             grade and left/right the letter.
//   Letters - every hole letter and every shaft letter at the chosen grades,
//             the fundamental-deviation picture of ISO 286: click one to use it.
//   Preferred fits at this size as small pictures; click one to take it.
// Every deviation and clearance drawn comes from run()'s result.chart.

const NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sg = (v) => (v > 0 ? `+${v}` : `${v}`);
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const niceStep = (span, n) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'h', 'js', 'k', 'm', 'n', 'p', 'r', 's'];
const TONE = { clearance: 'ok', transition: 'warn', interference: 'bad' };

const CSS = `
:root { --tool-hole: #1f4ed8; --tool-shaft: #d97706; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-hole: #7d9bff; --tool-shaft: #f0a33a; } }
:root[data-theme="dark"] { --tool-hole: #7d9bff; --tool-shaft: #f0a33a; }

.k-page { padding: 10px 12px; }
.if { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 390px 330px;
  grid-template-rows: auto minmax(0, 1fr) auto; grid-template-areas: "top top out" "fit map out" "pref pref out";
  height: calc(100vh - 66px); min-height: 640px; }
.if-top { grid-area: top; display: flex; gap: 10px; align-items: stretch; }
.if-fit { grid-area: fit; } .if-map { grid-area: map; } .if-pref { grid-area: pref; }
.if-out { grid-area: out; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.if-out .k-outwrap { flex: 1; min-height: 160px; display: flex; flex-direction: column; }
.if-out .k-out { flex: 1; max-height: none; }
.if-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.if-head { display: flex; align-items: baseline; gap: 10px; padding: 6px 10px 0; flex-wrap: wrap; }
.if-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.if-note { margin-left: auto; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.if-entry { display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 6px 10px; flex: none; }
.if-entry label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-soft); }
.if-entry input { padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 600 17px "IBM Plex Mono", ui-monospace, monospace; width: 112px; }
.if-entry input.sz { width: 76px; font-size: 14px; font-weight: 500; text-align: right; }
.if-entry input.bad { border-color: var(--danger); }
.if-type { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; padding: 1px 7px; border-radius: 4px; text-align: center; }
.if-type.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.if-type.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
.if-type.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.if-ruler { flex: 1; }
.if-ruler svg { display: block; width: 100%; height: 64px; touch-action: none; }

.if-box { position: relative; flex: 1; min-height: 0; }
.if-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.if-warns:empty { display: none; }
.if-warns { border-top: 1px solid var(--warn); padding: 5px 10px; font-size: 12px; background: color-mix(in srgb, var(--warn) 10%, var(--surface)); border-radius: 0 0 6px 6px; }
.if-warns div::before { content: "! "; color: var(--warn); font-weight: 600; }
.if-stale svg { opacity: 0.35; }

.if-pref-row { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 6px; padding: 6px 8px 8px; }
.if-mini { border: 1px solid var(--line-soft); border-radius: 5px; background: transparent; cursor: pointer; padding: 3px 3px 4px; color: var(--ink-soft);
  display: flex; flex-direction: column; align-items: stretch; gap: 1px; min-width: 0; }
.if-mini:hover { background: var(--sunken); color: var(--ink); }
.if-mini[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.if-mini svg { width: 100%; height: 54px; display: block; }
.if-mini b { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.if-mini small { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.if-draw text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.z-grid { stroke: var(--line-soft); stroke-width: 1; }
.z-ax { font-size: 11px; fill: var(--ink-soft); }
.z-zero { stroke: var(--ink); stroke-width: 1.6; }
.z-zerot { font-size: 11.5px; fill: var(--ink); }
.z-hole { fill: color-mix(in srgb, var(--tool-hole) 22%, transparent); stroke: var(--tool-hole); stroke-width: 1.6; }
.z-shaft { fill: color-mix(in srgb, var(--tool-shaft) 26%, transparent); stroke: var(--tool-shaft); stroke-width: 1.6; }
.z-name { font-size: 17px; font-weight: 600; }
.z-name.hole { fill: var(--tool-hole); } .z-name.shaft { fill: var(--tool-shaft); }
.z-sub { font-size: 11px; fill: var(--ink-soft); }
.z-edge { font-size: 11.5px; fill: var(--ink); stroke: var(--surface); stroke-width: 3; paint-order: stroke; }
.z-lim { font-size: 11px; fill: var(--ink-soft); stroke: var(--surface); stroke-width: 3; paint-order: stroke; }
.z-zone { outline: none; cursor: default; }
.z-zone:focus-visible rect.zr { stroke-width: 3; stroke-dasharray: 5 3; }
.z-grab { cursor: ns-resize; }
.z-grab .hit { stroke: transparent; stroke-width: 14; }
.z-grab .tab { stroke: none; }
.z-grab .tab.hole { fill: var(--tool-hole); } .z-grab .tab.shaft { fill: var(--tool-shaft); }
.z-grab text { font-size: 10.5px; font-weight: 600; fill: var(--surface); }
.z-ext { stroke: var(--ink-soft); stroke-width: 0.8; stroke-dasharray: 3 3; }
.z-dim { stroke-width: 1.3; fill: none; }
.z-dim.ok { stroke: var(--ok); } .z-dim.bad { stroke: var(--danger); }
.z-ah.ok { fill: var(--ok); } .z-ah.bad { fill: var(--danger); }
.z-dt { font-size: 12px; font-weight: 600; stroke: var(--surface); stroke-width: 4; paint-order: stroke; }
.z-dt.ok { fill: var(--ok); } .z-dt.bad { fill: var(--danger); }
.z-bar { stroke: none; } .z-bar.ok { fill: var(--ok); } .z-bar.warn { fill: var(--warn); } .z-bar.bad { fill: var(--danger); }
.z-bart { font-size: 12px; font-weight: 600; } .z-bart.ok { fill: var(--ok); } .z-bart.warn { fill: var(--warn); } .z-bart.bad { fill: var(--danger); }
.z-cz { fill: color-mix(in srgb, var(--ok) 8%, transparent); } .z-iz { fill: color-mix(in srgb, var(--danger) 8%, transparent); }
.z-col { cursor: pointer; outline: none; }
.z-col .bg { fill: transparent; }
.z-col:hover .bg { fill: var(--sunken); }
.z-col:focus-visible .bg { stroke: var(--accent); stroke-width: 1.5; }
.z-col .zm.hole { fill: color-mix(in srgb, var(--tool-hole) 18%, transparent); stroke: color-mix(in srgb, var(--tool-hole) 60%, transparent); }
.z-col .zm.shaft { fill: color-mix(in srgb, var(--tool-shaft) 18%, transparent); stroke: color-mix(in srgb, var(--tool-shaft) 60%, transparent); }
.z-col[aria-checked="true"] .zm.hole { fill: var(--tool-hole); stroke: var(--tool-hole); }
.z-col[aria-checked="true"] .zm.shaft { fill: var(--tool-shaft); stroke: var(--tool-shaft); }
.z-col text { font-size: 11.5px; fill: var(--ink-soft); }
.z-col[aria-checked="true"] text { fill: var(--ink); font-weight: 600; }
.z-strip { font-size: 11.5px; fill: var(--ink-soft); font-weight: 500; }
.r-band { fill: var(--sunken); } .r-band.on { fill: color-mix(in srgb, var(--accent) 16%, var(--surface)); }
.r-tick { stroke: var(--ink-soft); stroke-width: 1; } .r-tt { font-size: 10.5px; fill: var(--ink-soft); }
.r-b { stroke: var(--line); stroke-width: 1; }
.r-mark { cursor: ew-resize; outline: none; }
.r-mark path { fill: var(--accent); }
.r-mark:focus-visible circle { stroke: var(--accent); stroke-width: 2; fill: none; }
.r-mark circle { fill: none; }
.r-mt { font-size: 12px; font-weight: 600; fill: var(--accent); }
.r-st { font-size: 10.5px; fill: var(--accent); }

@media (max-width: 1250px) {
  .if { grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto 430px auto auto; grid-template-areas: "top top" "fit map" "pref pref" "out out"; height: auto; min-height: 0; }
  .if-pref-row { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
}
@media (max-width: 760px) {
  .k-page { padding: 8px; }
  .if { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "top" "fit" "map" "pref" "out"; }
  .if-top { flex-direction: column; }
  .if-entry { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .if-fit .if-box { height: 360px; flex: none; } .if-map .if-box { height: 330px; flex: none; }
  .if-note { display: none; }
}
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  let C = null, res = null;
  let fitScale = null, grab = null, focusKey = null;
  let rulerScale = null, rulerDrag = false;

  // ---------- top: entry + size ruler ----------
  const fitIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Fit, hole/shaft, like H7/g6', oninput: (e) => ctx.set('fit', e.target.value) });
  const sizeIn = h('input', { type: 'text', class: 'sz', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Nominal size in mm', oninput: (e) => ctx.set('size', e.target.value) });
  const typeChip = h('span', { class: 'if-type' });
  const entry = h('div', { class: 'if-card if-entry' },
    h('label', {}, h('span', {}, 'Fit'), fitIn), h('label', {}, h('span', {}, 'Ø'), sizeIn, h('small', {}, 'mm')), typeChip);
  const rulerSvg = sv(null, 'svg', { class: 'if-draw', role: 'group', 'aria-label': 'Nominal size on a log scale with the ISO 286 size steps' });
  const ruler = h('div', { class: 'if-card if-ruler' }, rulerSvg);
  const top = h('div', { class: 'if-top' }, entry, ruler);

  // ---------- fit ----------
  const fitSvg = sv(null, 'svg', { class: 'if-draw', role: 'group', 'aria-label': 'Hole and shaft tolerance zones' });
  const fitHead = h('div', { class: 'if-head' });
  const warns = h('div', { class: 'if-warns', 'aria-live': 'polite' });
  const fit = h('section', { class: 'if-card if-fit' }, fitHead, h('div', { class: 'if-box' }, fitSvg), warns);
  // ---------- map ----------
  const mapSvg = sv(null, 'svg', { class: 'if-draw', role: 'group', 'aria-label': 'All hole and shaft letters at the chosen grades' });
  const mapHead = h('div', { class: 'if-head' });
  const map = h('section', { class: 'if-card if-map' }, mapHead, h('div', { class: 'if-box' }, mapSvg));
  // ---------- preferred ----------
  const prefRow = h('div', { class: 'if-pref-row' });
  const pref = h('section', { class: 'if-card if-pref' }, h('div', { class: 'if-head' }, h('span', { class: 'if-cap' }, 'Preferred hole-basis fits at this size'),
    h('span', { class: 'if-note' }, 'loose → tight')), prefRow);
  const out = h('aside', { class: 'if-out' }, ctx.outputs);
  const layout = h('div', { class: 'if' }, top, fit, map, pref, out);
  root.append(layout);

  const setFit = (hl, hn, sl, sn) => ctx.set('fit', `${hl}${hn}/${sl}${sn}`);
  const markers = (svg) => {
    const d = sv(svg, 'defs');
    for (const t of ['ok', 'bad']) {
      const m = sv(d, 'marker', { id: `if-ar-${t}`, viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      sv(m, 'path', { d: 'M0,1 L10,5 L0,9 z', class: `z-ah ${t}` });
    }
  };

  // ---------- size ruler ----------
  const LMIN = 1, LMAX = 500;
  function drawRuler() {
    const svg = rulerSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 700), H = 64;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const l = 14, r = W - 14, y = 26;
    const X = (v) => l + ((Math.log(clamp(v, LMIN, LMAX)) - Math.log(LMIN)) / (Math.log(LMAX) - Math.log(LMIN))) * (r - l);
    rulerScale = { l, r };
    const b = [LMIN, ...C.bounds];
    for (let i = 0; i < b.length - 1; i++) {
      const on = C.size > b[i] && C.size <= b[i + 1];
      sv(svg, 'rect', { x: X(b[i]), y: y - 8, width: X(b[i + 1]) - X(b[i]), height: 16, class: `r-band${on ? ' on' : ''}` });
      sv(svg, 'line', { x1: X(b[i + 1]), x2: X(b[i + 1]), y1: y - 8, y2: y + 8, class: 'r-b' });
    }
    const narrow = W < 520;
    for (const t of [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500]) {
      if (narrow && [2, 20, 200, 300].includes(t)) continue;
      sv(svg, 'line', { x1: X(t), x2: X(t), y1: y + 8, y2: y + 13, class: 'r-tick' });
      sv(svg, 'text', { x: X(t), y: y + 25, 'text-anchor': 'middle', class: 'r-tt' }, t);
    }
    const mx = X(C.size);
    const g = sv(svg, 'g', { class: 'r-mark', tabindex: 0, role: 'slider', 'aria-label': 'Nominal size', 'aria-valuemin': 0, 'aria-valuemax': 500, 'aria-valuenow': C.size, 'aria-valuetext': `${C.size} mm`, 'data-h': 'size' });
    sv(g, 'circle', { cx: mx, cy: y, r: 11 });
    sv(g, 'path', { d: `M${mx},${y + 8} l-6,-10 h12 z M${mx - 1},${y - 12} h2 v20 h-2 z` });
    const tx = clamp(mx, l + 50, r - 90);
    const t = sv(svg, 'text', { x: tx, y: y - 13, 'text-anchor': 'middle', class: 'r-mt' }, `Ø${C.size}`);
    sv(t, 'tspan', { class: 'r-st', dx: 6 }, `size step ${C.step[0]}–${C.step[1]} mm`);
    g.addEventListener('keydown', (e) => {
      const s = C.size;
      const inc = s < 10 ? 0.5 : s < 100 ? 1 : 5;
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = s + inc;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = s - inc;
      else if (e.key === 'PageUp') v = C.bounds.find((x) => x > s) ?? 500;
      else if (e.key === 'PageDown') v = [...C.bounds].reverse().find((x) => x < s) ?? 1;
      if (v == null) return;
      e.preventDefault(); focusKey = 'size'; setSize(v, true);
    });
    if (focusKey === 'size') { g.focus(); focusKey = null; }
  }
  const snapSize = (v) => (v < 10 ? Math.round(v * 2) / 2 : v < 100 ? Math.round(v) : Math.round(v / 5) * 5);
  function setSize(v, exact) {
    const s = clamp(exact ? Math.round(v * 100) / 100 : snapSize(v), 0.5, 500);
    if (C && Math.abs(s - C.size) < 1e-9) return;
    ctx.set('size', String(s));
  }
  const sizeAt = (e) => {
    const rc = rulerSvg.getBoundingClientRect(), vb = rulerSvg.viewBox.baseVal;
    const x = ((e.clientX - rc.left) / rc.width) * vb.width;
    const t = clamp((x - rulerScale.l) / (rulerScale.r - rulerScale.l), 0, 1);
    return Math.exp(Math.log(LMIN) + t * (Math.log(LMAX) - Math.log(LMIN)));
  };
  rulerSvg.addEventListener('pointerdown', (e) => { if (!C) return; rulerDrag = true; capture(rulerSvg, e); setSize(sizeAt(e)); e.preventDefault(); });
  rulerSvg.addEventListener('pointermove', (e) => { if (rulerDrag) setSize(sizeAt(e)); });
  rulerSvg.addEventListener('pointerup', () => { rulerDrag = false; });
  rulerSvg.addEventListener('pointercancel', () => { rulerDrag = false; });

  // ---------- fit detail ----------
  function drawFit() {
    const svg = fitSvg; svg.replaceChildren(); markers(svg);
    const W = Math.max(280, svg.clientWidth || 640), H = Math.max(260, svg.clientHeight || 440);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 520;
    const L = narrow ? 40 : 56, R = narrow ? 96 : 150, T = 36, B = 30;
    const { hole: ho, shaft: sh } = C;
    let lo = Math.min(0, ho.zone[0], sh.zone[0]), hi = Math.max(0, ho.zone[1], sh.zone[1]);
    const pad = (hi - lo) * 0.16 || 5; lo -= pad; hi += pad;
    if (grab && fitScale) ({ lo, hi } = fitScale);
    const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    fitScale = { lo, hi, Y, T, B, H };
    const cw = W - L - R;
    const step = niceStep(hi - lo, 7);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      sv(svg, 'line', { x1: L, x2: W - R + 8, y1: Y(v), y2: Y(v), class: 'z-grid' });
      sv(svg, 'text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'z-ax' }, sg(Math.round(v * 10) / 10));
    }
    sv(svg, 'text', { x: 6, y: 16, class: 'z-ax' }, 'µm');
    // zones
    const hx0 = L + cw * 0.07, hx1 = L + cw * 0.41, sx0 = L + cw * 0.59, sx1 = L + cw * 0.93;
    const zone = (kind, x0, x1, z, name, letterList, grades, limits) => {
      const g = sv(svg, 'g', { class: 'z-zone', tabindex: 0, role: 'slider', 'data-z': kind,
        'aria-label': `${kind} ${name}: up and down change the grade, left and right the letter`,
        'aria-valuemin': 4, 'aria-valuemax': 12, 'aria-valuenow': kind === 'hole' ? ho.grade : sh.grade, 'aria-valuetext': name });
      sv(g, 'rect', { x: x0, y: Y(z[1]), width: x1 - x0, height: Math.max(2, Y(z[0]) - Y(z[1])), rx: 2, class: `zr z-${kind}` });
      const nameY = Y(z[1]) - 10;
      const tight = x1 - x0 < 150;
      sv(g, 'text', { x: tight ? x0 + 1 : (x0 + x1) / 2, y: nameY, 'text-anchor': tight ? 'start' : 'middle', class: `z-name ${kind}` }, name);
      // edges: deviation and limit in mm
      const lx = kind === 'hole' ? x0 - 6 : x1 + 6, anchor = kind === 'hole' ? 'end' : 'start';
      const both = Y(z[0]) - Y(z[1]) < 24;
      sv(g, 'text', { x: lx, y: Y(z[1]) + (both ? -2 : 4), 'text-anchor': anchor, class: 'z-edge' }, `${sg(z[1])}`);
      sv(g, 'text', { x: lx, y: Y(z[0]) + (both ? 12 : 4), 'text-anchor': anchor, class: 'z-edge' }, `${sg(z[0])}`);
      if (!narrow) {
        sv(g, 'text', { x: (x0 + x1) / 2, y: Y(z[1]) + 13, 'text-anchor': 'middle', class: 'z-lim', style: both ? 'display:none' : null }, limits[1]);
        sv(g, 'text', { x: (x0 + x1) / 2, y: Y(z[0]) - 5, 'text-anchor': 'middle', class: 'z-lim', style: both ? 'display:none' : null }, limits[0]);
      }
      // grab on the edge that moves with the grade: the one further from the letter's fixed deviation
      const g0 = grades.find((x) => x.zone), g1 = [...grades].reverse().find((x) => x.zone);
      const upperMoves = Math.abs(g1.zone[1] - g0.zone[1]) >= Math.abs(g1.zone[0] - g0.zone[0]);
      const ey = Y(upperMoves ? z[1] : z[0]);
      const gg = sv(g, 'g', { class: 'z-grab', 'data-grab': kind });
      sv(gg, 'line', { x1: x0, x2: x1, y1: ey, y2: ey, class: 'hit' });
      const tw = tight ? 30 : 40, ty = upperMoves ? ey - 1 : ey + 1;
      sv(gg, 'path', { d: upperMoves ? `M${x1 - tw - 6},${ty} v-12 a3,3 0 0 1 3,-3 h${tw} a3,3 0 0 1 3,3 v12 z` : `M${x1 - tw - 6},${ty} v12 a3,3 0 0 0 3,3 h${tw} a3,3 0 0 0 3,-3 v-12 z`, class: `tab ${kind}` });
      sv(gg, 'text', { x: x1 - tw / 2 - 6, y: upperMoves ? ty - 4 : ty + 12, 'text-anchor': 'middle' }, `${tight ? '' : '↕ '}IT${kind === 'hole' ? ho.grade : sh.grade}`);
      gg.addEventListener('pointerdown', (e) => {
        grab = { kind, upper: upperMoves, grades }; capture(fitSvg, e); e.preventDefault(); e.stopPropagation();
      });
      g.addEventListener('keydown', (e) => {
        const cur = kind === 'hole' ? ho : sh;
        const up = { ArrowUp: 1, ArrowDown: -1 }[e.key], side = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!up && !side) return;
        e.preventDefault(); focusKey = `zone-${kind}`;
        if (up) {
          const ng = clamp(cur.grade + (upperMoves ? up : -up), 4, 12);
          if (kind === 'hole') setFit(ho.letter, ng, sh.letter, sh.grade); else setFit(ho.letter, ho.grade, sh.letter, ng);
        } else {
          const i = LETTERS.indexOf(cur.letter.toLowerCase());
          const nl = LETTERS[clamp(i + side, 0, LETTERS.length - 1)];
          if (kind === 'hole') setFit(nl.toUpperCase(), ho.grade, sh.letter, sh.grade); else setFit(ho.letter, ho.grade, nl, sh.grade);
        }
      });
      if (focusKey === `zone-${kind}`) { requestAnimationFrame(() => g.focus()); focusKey = null; }
      return g;
    };
    // zero line (nominal size)
    zone('hole', hx0, hx1, ho.zone, `${ho.letter}${ho.grade}`, null, C.holeGrades, ho.limits);
    zone('shaft', sx0, sx1, sh.zone, `${sh.letter}${sh.grade}`, null, C.shaftGrades, sh.limits);
    sv(svg, 'line', { x1: L, x2: W - R + 8, y1: Y(0), y2: Y(0), class: 'z-zero' });
    sv(svg, 'text', { x: L - 6, y: Y(0) + 17, 'text-anchor': 'end', class: 'z-zerot' }, `Ø${C.size}`);
    // clearance dims between the zones: min = EI - es, max = ES - ei
    const gx = (hx1 + sx0) / 2;
    const dim = (x, a, b, label, v) => {
      const t = v >= 0 ? 'ok' : 'bad';
      sv(svg, 'line', { x1: hx0 + (hx1 - hx0) * 0.5, x2: x + 6, y1: Y(a), y2: Y(a), class: 'z-ext' });
      sv(svg, 'line', { x1: x - 6, x2: sx0 + (sx1 - sx0) * 0.5, y1: Y(b), y2: Y(b), class: 'z-ext' });
      if (Math.abs(Y(a) - Y(b)) > 3) sv(svg, 'line', { x1: x, x2: x, y1: Y(a), y2: Y(b), class: `z-dim ${t}`, 'marker-start': `url(#if-ar-${t})`, 'marker-end': `url(#if-ar-${t})` });
      const my = (Y(a) + Y(b)) / 2;
      const word = v >= 0 ? `${label} ${v}` : `${label === 'min' ? 'max' : 'min'} int. ${-v}`;
      if (!narrow) sv(svg, 'text', { x: x + 6, y: my + 4, class: `z-dt ${t}` }, word);
    };
    const minX = gx - 18, maxX = gx - 18 - (narrow ? 0 : 0);
    dim(minX, ho.zone[0], sh.zone[1], 'min', C.min);
    // the max dim is offset so both read
    const d2x = gx + 10;
    dim(d2x, ho.zone[1], sh.zone[0], 'max', C.max);
    void maxX;
    // range bar at the right: clearance axis
    const bx = W - R + 34, bw = 14;
    const cl = Math.min(0, C.min), ch = Math.max(0, C.max), cp = (ch - cl) * 0.15 || 4;
    const YC = (v) => T + 18 + (H - T - B - 36) * (1 - (v - (cl - cp)) / ((ch + cp) - (cl - cp)));
    sv(svg, 'rect', { x: bx - 6, y: YC(ch + cp), width: bw + 12, height: YC(0) - YC(ch + cp), class: 'z-cz' });
    sv(svg, 'rect', { x: bx - 6, y: YC(0), width: bw + 12, height: YC(cl - cp) - YC(0), class: 'z-iz' });
    sv(svg, 'line', { x1: bx - 10, x2: bx + bw + 10, y1: YC(0), y2: YC(0), class: 'z-zero' });
    const tone = TONE[C.type];
    sv(svg, 'rect', { x: bx, y: YC(C.max), width: bw, height: Math.max(3, YC(C.min) - YC(C.max)), rx: 3, class: `z-bar ${tone}` });
    sv(svg, 'text', { x: bx + bw + 8, y: YC(C.max) + 4, class: `z-bart ${tone}` }, sg(C.max));
    sv(svg, 'text', { x: bx + bw + 8, y: YC(C.min) + 4, class: `z-bart ${tone}` }, sg(C.min));
    sv(svg, 'text', { x: bx + bw / 2, y: T + 4, 'text-anchor': 'middle', class: 'z-sub' }, narrow ? 'fit' : 'fit, µm');
    if (!narrow) {
      sv(svg, 'text', { x: bx - 10, y: YC(ch + cp) + 12, 'text-anchor': 'end', class: 'z-sub' }, 'play');
      if (cl < 0 || cp) sv(svg, 'text', { x: bx - 10, y: YC(cl - cp) - 4, 'text-anchor': 'end', class: 'z-sub' }, 'press');
    }
    sv(svg, 'text', { x: bx + bw / 2, y: H - 10, 'text-anchor': 'middle', class: `z-bart ${tone}` }, C.type);
  }
  fitSvg.addEventListener('pointermove', (e) => {
    if (!grab || !fitScale) return;
    const rc = fitSvg.getBoundingClientRect(), vb = fitSvg.viewBox.baseVal;
    const y = ((e.clientY - rc.top) / rc.height) * vb.height;
    let best = null;
    for (const g of grab.grades) {
      if (!g.zone) continue;
      const ey = fitScale.Y(grab.upper ? g.zone[1] : g.zone[0]);
      if (!best || Math.abs(ey - y) < best.d) best = { d: Math.abs(ey - y), grade: g.grade };
    }
    if (!best) return;
    const { hole: ho, shaft: sh } = C;
    if (grab.kind === 'hole' && best.grade !== ho.grade) setFit(ho.letter, best.grade, sh.letter, sh.grade);
    if (grab.kind === 'shaft' && best.grade !== sh.grade) setFit(ho.letter, ho.grade, sh.letter, best.grade);
  });
  const endGrab = () => { if (!grab) return; grab = null; if (C) drawFit(); };
  fitSvg.addEventListener('pointerup', endGrab);
  fitSvg.addEventListener('pointercancel', endGrab);

  // ---------- letter map ----------
  function drawMap() {
    const svg = mapSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 390), H = Math.max(260, svg.clientHeight || 440);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const all = [...C.holeLetters, ...C.shaftLetters].filter((x) => x.zone);
    let lo = Math.min(0, ...all.map((x) => x.zone[0])), hi = Math.max(0, ...all.map((x) => x.zone[1]));
    const L = 44, R = 8, gap = 26, top = 18, bot = 20;
    const sh = (H - top - bot - gap) / 2;
    const strip = (list, kind, y0, label, cur) => {
      const Y = (v) => y0 + 16 + (sh - 32) * (1 - (v - lo) / (hi - lo));
      const step = niceStep(hi - lo, 4);
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        sv(svg, 'line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'z-grid' });
        sv(svg, 'text', { x: L - 5, y: Y(v) + 4, 'text-anchor': 'end', class: 'z-ax' }, sg(v));
      }
      sv(svg, 'text', { x: 6, y: y0 + 8, class: 'z-strip' }, label);
      const cw = (W - L - R) / list.length;
      const grp = sv(svg, 'g', { role: 'radiogroup', 'aria-label': label });
      list.forEach((it, i) => {
        const on = it.letter === cur;
        const x = L + cw * i;
        const g = sv(grp, 'g', { class: 'z-col', role: 'radio', tabindex: on ? 0 : -1, 'aria-checked': String(on), 'data-l': `${kind}-${it.letter}`,
          'aria-label': `${it.letter}${it.zone ? `: ${sg(it.zone[1])} / ${sg(it.zone[0])} µm` : ''}` });
        sv(g, 'rect', { x: x + 1, y: y0 + 12, width: cw - 2, height: sh - 12, rx: 3, class: 'bg' });
        if (it.zone) sv(g, 'rect', { x: x + cw * 0.22, y: Y(it.zone[1]), width: cw * 0.56, height: Math.max(1.5, Y(it.zone[0]) - Y(it.zone[1])), rx: 1.5, class: `zm ${kind}` });
        sv(g, 'text', { x: x + cw / 2, y: y0 + sh + 2, 'text-anchor': 'middle' }, it.letter);
        const pick = (l) => {
          if (kind === 'hole') setFit(l, C.hole.grade, C.shaft.letter, C.shaft.grade);
          else setFit(C.hole.letter, C.hole.grade, l, C.shaft.grade);
        };
        g.addEventListener('click', () => pick(it.letter));
        g.addEventListener('keydown', (e) => {
          const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!d) return; e.preventDefault();
          const j = clamp(i + d, 0, list.length - 1);
          focusKey = `${kind}-${list[j].letter}`; pick(list[j].letter);
        });
      });
      sv(svg, 'line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), class: 'z-zero' });
    };
    strip(C.holeLetters, 'hole', top - 14, `Holes at IT${C.hole.grade}`, C.hole.letter);
    strip(C.shaftLetters, 'shaft', top - 14 + sh + gap, `Shafts at IT${C.shaft.grade}`, C.shaft.letter);
    if (focusKey && focusKey.includes('-') && !focusKey.startsWith('zone')) {
      const el = mapSvg.querySelector(`[data-l="${focusKey}"]`);
      if (el) { el.focus(); focusKey = null; }
    }
  }

  // ---------- preferred ----------
  function drawPref() {
    const cur = `${C.hole.letter}${C.hole.grade}/${C.shaft.letter}${C.shaft.grade}`;
    const all = C.preferred.flatMap((p) => [...p.hole, ...p.shaft]);
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    prefRow.replaceChildren(...C.preferred.map((p) => {
      const s = sv(null, 'svg', { viewBox: '0 0 100 54', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      const Y = (v) => 3 + 48 * (1 - (v - lo) / (hi - lo));
      sv(s, 'line', { x1: 0, x2: 100, y1: Y(0), y2: Y(0), class: 'z-zero', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
      sv(s, 'rect', { x: 18, y: Y(p.hole[1]), width: 26, height: Math.max(1, Y(p.hole[0]) - Y(p.hole[1])), class: 'z-hole', 'vector-effect': 'non-scaling-stroke' });
      sv(s, 'rect', { x: 56, y: Y(p.shaft[1]), width: 26, height: Math.max(1, Y(p.shaft[0]) - Y(p.shaft[1])), class: 'z-shaft', 'vector-effect': 'non-scaling-stroke' });
      const t = TONE[p.type];
      return h('button', { type: 'button', class: 'if-mini', 'aria-pressed': String(p.name === cur), title: `${p.name}: ${p.use}; ${sg(p.min)} … ${sg(p.max)} µm, ${p.type}`,
        onclick: () => ctx.set('fit', p.name) }, s, h('b', {}, p.name),
      h('small', { class: `if-t-${t}`, style: `color: var(--${t === 'bad' ? 'danger' : t})` }, `${sg(p.min)}…${sg(p.max)}`),
      h('small', {}, p.use.split(':')[0]));
    }));
  }

  function draw() {
    const raw = ctx.raw;
    if (document.activeElement !== fitIn) fitIn.value = raw.fit ?? '';
    if (document.activeElement !== sizeIn) sizeIn.value = raw.size ?? '';
    const stale = !res?.chart;
    fitIn.classList.toggle('bad', stale && !!res);
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    layout.classList.toggle('if-stale', stale && !!C);
    if (!C) return;
    typeChip.className = `if-type ${TONE[C.type]}`;
    typeChip.textContent = stale ? '–' : `${C.type}`;
    fitHead.replaceChildren(h('span', { class: 'if-cap' }, `Ø${C.size} ${C.hole.letter}${C.hole.grade}/${C.shaft.letter}${C.shaft.grade}: tolerance zones, µm`),
      h('span', { class: 'if-note' }, 'drag a ↕ tab to change the grade'));
    mapHead.replaceChildren(h('span', { class: 'if-cap' }, 'All letters, fundamental deviations'), h('span', { class: 'if-note' }, 'click to use'));
    drawRuler(); drawFit(); drawMap(); drawPref();
  }
  ctx.onResult((r) => { res = r; if (r.chart) C = r.chart; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [rulerSvg, fitSvg, mapSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !C) return;
      sizes = now; drawRuler(); drawFit(); drawMap();
    });
  }).observe(layout);
}

