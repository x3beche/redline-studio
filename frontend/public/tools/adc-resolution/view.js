// ADC Resolution: the page is the converter's transfer function.
//   Lens     - the full input span as a strip (0 … Vref, or ±Vref) with the
//              input on it; the magnified window below is the staircase itself
//              around the input, one tread per code. Drag the input along
//              either; scroll or +/- to zoom. The tread under the input carries
//              its LSB width, its code and the voltage it reads back as.
//   Noise    - the input's noise as a bell under the axis; drag its sigma
//              handle. The codes one conversion returns with that noise are
//              the bars at the right, on their own code rows.
//   Word     - the output code as bit cells: the bits the noise leaves alone,
//              the ones that flicker (hatched), ENOB as a mark, and the bits
//              oversampling adds, appended. -/+ at its ends change the bits.
//   Decimate - OSR samples of that noisy input as dots on their codes, summed
//              into one output word at the lower rate.
// Every number shown comes from run()'s result.adc; the page only draws it.
import { fmtEng, fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const txt = (x, y, s, cls = '', anchor = 'start') => sv('text', { x, y, class: cls, 'text-anchor': anchor }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const E = (v, u = 'V', d = 4) => fmtEng(v, u, d);
// A number as an input takes it: 512.3u, 1.25, -100m.
const eng = (v, d = 5) => fmtEng(v, '', d).replace(/\s+/g, '').replace('µ', 'u');
const hexOf = (c, bits) => {
  const b = BigInt(Math.max(1, bits));
  const u = c < 0 ? (1n << b) + BigInt(c) : BigInt(c);
  return '0x' + u.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0');
};

const VREFS = ['1.2', '1.8', '2.048', '2.5', '3.3', '4.096', '5'];
const OSRS = [1, 4, 16, 64, 256, 1024];

const CSS = `
.adc { --tool-step: var(--accent); --tool-os: #b45309; --tool-noise: #0f8a78; --tool-hatch: var(--ink-soft);
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 400px); gap: 12px; align-items: start; }
:root[data-theme="dark"] .adc { --tool-os: #f0a33a; --tool-noise: #3cc7b3; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .adc { --tool-os: #f0a33a; --tool-noise: #3cc7b3; } }
@media (max-width: 1020px) { .adc { grid-template-columns: minmax(0, 1fr); } }
.adc-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.adc-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); }
.adc-head h2 { font-size: 12.5px; font-weight: 600; margin: 0; }
.adc-sub { color: var(--ink-soft); font-size: 11.5px; }
.adc-grow { flex: 1; }
.adc-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.adc-f input { width: 64px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }
.adc-f input.bad { border-color: var(--danger); }
.adc-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; flex-wrap: wrap; }
.adc-seg button { border: 0; background: transparent; padding: 2px 7px; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; cursor: pointer; color: var(--ink-soft); }
.adc-seg button + button { border-left: 1px solid var(--line); }
.adc-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.adc-seg.soft button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.adc-step { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.adc-step button { border: 0; background: transparent; width: 22px; padding: 2px 0; cursor: pointer; color: var(--ink); }
.adc-step button:hover { background: var(--sunken); }
.adc-step input { width: 38px; border: 0; border-left: 1px solid var(--line); border-right: 1px solid var(--line); border-radius: 0; text-align: center; }
.adc-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.adc-draw svg { display: block; width: 100%; overflow: visible; }
.adc-foot { padding: 4px 10px 7px; color: var(--ink-soft); font-size: 11px; display: flex; gap: 4px 14px; flex-wrap: wrap; align-items: center; }
.adc-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.adc-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.adc-side .k-out { max-height: 240px; }
.adc-warns:empty { display: none; }
.adc-read { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 2px 10px; padding: 4px 10px 8px; }
.adc-read div { min-width: 0; }
.adc-read span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.adc-read b { font: 500 13px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.adc-read b.warn { color: var(--warn); } .adc-read b.ok { color: var(--ok); }
.adc-notes { color: var(--ink-soft); font-size: 11.5px; padding: 0 2px; }
.adc-notes div + div { margin-top: 3px; }
.adc-more summary { cursor: pointer; color: var(--ink-soft); font-size: 11.5px; padding: 2px; }
.adc-more[open] summary { margin-bottom: 4px; }
/* drawing */
.adc svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.adc svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 10.5px; }
.adc svg .sm { font-size: 9.5px; }
.adc svg .soft { fill: var(--ink-soft); }
.adc svg .b { font-weight: 600; }
.adc svg .bg { fill: var(--surface); }
.adc svg .plot { fill: var(--sunken); }
.adc svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.adc svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.adc svg .ideal { stroke: var(--ink-soft); stroke-width: 1; stroke-dasharray: 4 4; fill: none; }
.adc svg .stair { stroke: var(--tool-step); stroke-width: 2.25; fill: none; stroke-linejoin: miter; }
.adc svg .stair-os { stroke: var(--tool-os); stroke-width: 1.25; fill: none; opacity: .9; }
.adc svg .os-t { fill: var(--tool-os); }
.adc svg .tread { stroke: var(--tool-step); stroke-width: 5; stroke-linecap: butt; opacity: .35; }
.adc svg .out { fill: url(#adc-hatch); }
.adc svg .hatch-l { stroke: var(--danger); stroke-opacity: .5; stroke-width: 1; }
.adc svg .hatch-n { stroke: var(--tool-hatch); stroke-opacity: .55; stroke-width: 1; }
.adc svg .cross { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 3 3; }
.adc svg .dim { stroke: var(--ink); stroke-width: 1; }
.adc svg .dimf { fill: var(--ink); }
.adc svg .codebox { fill: var(--tool-step); }
.adc svg .codebox-t { fill: var(--accent-ink); font-weight: 600; }
.adc svg .danger { fill: var(--danger); } .adc svg .warn-t { fill: var(--warn); }
.adc svg .bell { fill: var(--tool-noise); fill-opacity: calc(var(--fill-alpha) * 1.1); stroke: var(--tool-noise); stroke-width: 1.5; }
.adc svg .bell-s { fill: var(--tool-noise); fill-opacity: calc(var(--fill-alpha) * 1.6); }
.adc svg .pp { stroke: var(--tool-noise); stroke-width: 1; }
.adc svg .pp-band { fill: var(--tool-noise); fill-opacity: calc(var(--fill-alpha) * .3); }
.adc svg .noise-t { fill: var(--tool-noise); }
.adc svg .hbar { fill: var(--tool-noise); }
.adc svg .hbar.main { fill: var(--tool-step); }
.adc svg .lens { fill: var(--accent); fill-opacity: calc(var(--fill-alpha) * 1.4); stroke: var(--accent); stroke-width: 1; }
.adc svg .fan { fill: var(--accent); fill-opacity: calc(var(--fill-alpha) * .35); }
.adc svg .span { fill: var(--surface); stroke: var(--line); }
.adc svg g.h { cursor: ew-resize; outline: none; }
.adc svg g.h .knob { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.adc svg g.h .lbl { fill: var(--accent); }
.adc svg g.h .lbl-t { fill: var(--accent-ink); font-weight: 600; }
.adc svg g.h.n .knob { fill: var(--tool-noise); } .adc svg g.h.n .lbl { fill: var(--tool-noise); }
.adc svg g.h.bad .knob, .adc svg g.h.bad .lbl { fill: var(--danger); }
.adc svg g.h .ring { fill: none; stroke: transparent; stroke-width: 2; }
.adc svg g.h:focus-visible .ring, .adc svg g.h:hover .ring { stroke: var(--accent); }
.adc svg .cell { stroke: var(--line); stroke-width: 1; fill: var(--surface); }
.adc svg .cell.on { fill: var(--tool-step); stroke: var(--tool-step); }
.adc svg .cell.os { fill: none; stroke: var(--tool-os); stroke-dasharray: 3 2; }
.adc svg .cell-t { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.adc svg .cell-t.on { fill: var(--accent-ink); }
.adc svg .brace { stroke: var(--ink-soft); stroke-width: 1; fill: none; }
.adc svg .brace.n { stroke: var(--warn); } .adc svg .brace.o { stroke: var(--tool-os); }
.adc svg .enob { stroke: var(--ink); stroke-width: 2; }
.adc svg .dot { fill: var(--tool-noise); }
.adc svg .dot.flat { fill: var(--warn); }
.adc svg .row { stroke: var(--line-soft); stroke-width: 1; }
.adc svg .box { fill: var(--sunken); stroke: var(--line); }
.adc svg .snr { fill: var(--tool-step); } .adc svg .snr.os { fill: var(--tool-os); }
.adc svg g.btn { cursor: pointer; outline: none; }
.adc svg g.btn rect { fill: var(--surface); stroke: var(--line); }
.adc svg g.btn:hover rect, .adc svg g.btn:focus-visible rect { stroke: var(--accent); }
.adc svg g.btn text { font-weight: 600; font-size: 13px; }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  // View state: the lens window (centre in volts, span in LSB) and whether the
  // span was chosen by hand or follows the noise.
  const view = { c: null, spanL: null, auto: true, drag: null };

  // ---------- controls ----------
  const numField = (label, unit, key, aria, width) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria,
      style: width ? `width:${width}px` : null, oninput: (e) => ctx.set(key, e.target.value) });
    return { el: h('label', { class: 'adc-f' }, label, inp, unit), inp, key };
  };
  const fields = [];
  const vrefF = numField('Vref', 'V', 'vref', 'Reference voltage in volts'); fields.push(vrefF);
  const vrefSeg = h('div', { class: 'adc-seg soft', role: 'group', 'aria-label': 'Common references' });
  const rangeSeg = h('div', { class: 'adc-seg', role: 'group', 'aria-label': 'Input range' });
  const bitsIn = h('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'ADC bits', oninput: (e) => ctx.set('bits', e.target.value) });
  const bitsF = { inp: bitsIn, key: 'bits' }; fields.push(bitsF);
  const stepBits = (d) => { const a = ctx.result?.adc; const n = clamp((a?.N ?? 12) + d, 1, 32); ctx.set('bits', String(n)); };
  const bitsStep = h('label', { class: 'adc-f' }, 'bits',
    h('span', { class: 'adc-f adc-step' },
      h('button', { type: 'button', 'aria-label': 'One bit fewer', onclick: () => stepBits(-1) }, '−'), bitsIn,
      h('button', { type: 'button', 'aria-label': 'One bit more', onclick: () => stepBits(1) }, '+')));
  const vinF = numField('Vin', 'V', 'vin', 'Input voltage in volts', 78); fields.push(vinF);
  const noiseF = numField('noise', 'V rms', 'noise', 'Input noise, RMS volts', 64); fields.push(noiseF);
  const zoomOut = h('button', { class: 'k-btn', type: 'button', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => zoom(2) }, '−');
  const zoomIn = h('button', { class: 'k-btn', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoom(0.5) }, '+');
  const zoomRead = h('span', { class: 'adc-sub' });
  const fitBtn = h('button', { class: 'k-btn', type: 'button', title: 'Fit the window to the noise', onclick: () => { view.auto = true; view.c = null; draw(); } }, 'Fit');

  const lensDraw = h('div', { class: 'adc-draw', 'aria-label': 'Full input range' });
  const plotDraw = h('div', { class: 'adc-draw', 'aria-label': 'Transfer function, magnified around the input' });
  const readout = h('div', { class: 'adc-read', 'aria-live': 'polite' });
  const mainPanel = h('section', { class: 'adc-panel', 'aria-label': 'Transfer function' },
    h('div', { class: 'adc-head' }, h('h2', {}, 'Transfer function'), vrefF.el, vrefSeg, rangeSeg, bitsStep),
    lensDraw, plotDraw,
    h('div', { class: 'adc-head', style: 'border-top:1px solid var(--line-soft);border-bottom:0' },
      vinF.el, noiseF.el, h('span', { class: 'adc-grow' }), h('span', { class: 'adc-sub' }, 'window'), zoomRead, zoomOut, zoomIn, fitBtn),
    h('div', { class: 'adc-foot' },
      h('span', {}, 'Drag the input on the staircase or the strip; drag the green σ handle for the noise.'),
      h('span', {}, h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' 1 LSB, ', h('kbd', {}, 'Shift'), ' 10 LSB'),
      h('span', {}, 'wheel or ', h('kbd', {}, '+'), ' ', h('kbd', {}, '−'), ' zoom')));

  const wordDraw = h('div', { class: 'adc-draw' });
  const wordPanel = h('section', { class: 'adc-panel', 'aria-label': 'Output code' },
    h('div', { class: 'adc-head' }, h('h2', {}, 'Output word'), h('span', { class: 'adc-sub' }, 'the code for the input, bit by bit')),
    wordDraw, readout);

  const osrSeg = h('div', { class: 'adc-seg', role: 'group', 'aria-label': 'Oversampling ratio' });
  const osrF = numField('OSR', '×', 'osr', 'Oversampling ratio', 50); fields.push(osrF);
  const fsF = numField('fs', 'Hz', 'fs', 'Sample rate in hertz', 60); fields.push(fsF);
  const osDraw = h('div', { class: 'adc-draw' });
  const osPanel = h('section', { class: 'adc-panel', 'aria-label': 'Oversampling and decimation' },
    h('div', { class: 'adc-head' }, h('h2', {}, 'Oversample'), osrSeg, h('span', { class: 'adc-grow' }), fsF.el),
    osDraw);

  const warns = h('div', { class: 'k-warns adc-warns', 'aria-live': 'polite' });
  const notesBody = h('div', { class: 'adc-notes' });
  const notes = h('details', { class: 'adc-more' }, h('summary', {}, 'Notes and assumptions'), notesBody);
  root.append(h('div', { class: 'adc' },
    h('div', { style: 'display:flex;flex-direction:column;gap:12px;min-width:0' }, mainPanel),
    h('div', { class: 'adc-side' }, wordPanel, osPanel, warns, ctx.outputs, notes)));

  const setVin = (v) => ctx.set('vin', eng(v, 7));
  const A = () => ctx.result?.adc;

  // Keyboard focus survives a redraw.
  const keepFocus = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };

  // ---------- the lens window ----------
  function windowOf(a) {
    if (view.auto || view.spanL == null) {
      // Wide enough for the noise's peak-to-peak and a few treads either side.
      const want = Math.max(12, Math.ceil(a.ppLsb * 1.6 + 6));
      view.spanL = Math.min(4096, 2 ** Math.ceil(Math.log2(want)));
    }
    const span = view.spanL * a.lsb;
    const vin = a.vin ?? 0;
    if (a.clipped) {
      // Keep the end of the range in view, where the staircase goes flat.
      view.c = vin < a.lo * a.lsb ? a.lo * a.lsb + span * 0.3 : (a.hi + 1) * a.lsb - span * 0.3;
      return [view.c - span / 2, view.c + span / 2];
    }
    if (view.c == null || Math.abs(vin - view.c) > span * 0.42) view.c = vin;
    const min = Math.min(a.lo * a.lsb, vin) - span * 0.1, max = Math.max((a.hi + 1) * a.lsb, vin) + span * 0.1;
    view.c = clamp(view.c, Math.min(min + span / 2, (min + max) / 2), Math.max(max - span / 2, (min + max) / 2));
    return [view.c - span / 2, view.c + span / 2];
  }
  function zoom(f) {
    const a = A(); if (!a) return;
    view.auto = false;
    view.spanL = clamp(Math.round((view.spanL || 16) * f), 4, 1 << 16);
    if (a.vin != null) view.c = a.vin;
    draw();
  }

  // ---------- drawing: the full-range strip ----------
  let lensGeom = null;
  function drawLens(a, win) {
    const W = Math.max(300, lensDraw.clientWidth || 700);
    const L = W > 620 ? 86 : 58, R = W > 620 ? 118 : 70, H = 58;
    const v0 = a.lo * a.lsb, v1 = (a.hi + 1) * a.lsb;
    const X = (v) => L + ((v - v0) / (v1 - v0)) * (W - L - R);
    lensGeom = { X, inv: (x) => v0 + ((x - L) / (W - L - R)) * (v1 - v0), L, R, W };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Full range ${E(v0)} to ${E(v1)}` });
    svg.append(sv('rect', { x: L, y: 14, width: W - L - R, height: 14, class: 'plot', rx: 2 }));
    for (let k = 0; k <= 4; k++) {
      const x = L + (k / 4) * (W - L - R);
      svg.append(sv('line', { x1: x, x2: x, y1: 28, y2: 32, class: 'axis' }));
      const v = v0 + (k / 4) * (v1 - v0);
      if (k === 0 || k === 4 || W > 480) svg.append(txt(x, 43, E(v, 'V', 3), 'm soft sm', k === 0 ? 'start' : k === 4 ? 'end' : 'middle'));
    }
    svg.append(txt(L - 8, 25, 'input', 'soft sm', 'end'));
    svg.append(txt(L, 10, `code ${a.lo}`, 'm soft sm'));
    svg.append(txt(W - R, 10, `code ${a.hi}`, 'm soft sm', 'end'));
    if (a.bip) { const x = X(0); svg.append(sv('line', { x1: x, x2: x, y1: 12, y2: 30, class: 'axis' })); }
    // The lens: the window of the plot below, however narrow.
    const xa = X(Math.max(v0, win[0])), xb = X(Math.min(v1, win[1]));
    const lw = Math.max(3, xb - xa), lx = (xa + xb) / 2 - lw / 2;
    svg.append(sv('path', { d: `M${lx},28 L${lx + lw},28 L${W - R},${H} L${L},${H} Z`, class: 'fan' }));
    svg.append(sv('rect', { x: lx, y: 12, width: lw, height: 18, class: 'lens', rx: 1 }));
    if (a.vin != null) {
      const x = X(clamp(a.vin, v0, v1));
      svg.append(sv('path', { d: `M${x},12 l-5,-7 h10 z`, class: a.clipped ? 'danger' : 'codebox' }));
    }
    svg.append(txt(W - R + 8, 25, W > 620 ? `${a.levels.toLocaleString('en-US')} codes` : `${a.N} bits`, 'm soft sm'));
    lensDraw.replaceChildren(svg);
  }

  // ---------- drawing: the magnified staircase ----------
  let plotGeom = null;
  function drawPlot(a, win) {
    const W = Math.max(300, plotDraw.clientWidth || 700);
    const narrow = W < 620;
    const L = narrow ? 58 : 86, HW = narrow ? 70 : 118, T = 26;
    const PH = clamp(Math.round(W * 0.42), 220, 410);
    const bellH = 64;
    const H = T + PH + 42 + bellH + 14;
    const PW = W - L - HW;
    const [va, vb] = win;
    const X = (v) => L + ((v - va) / (vb - va)) * PW;
    const Xi = (x) => va + ((x - L) / PW) * (vb - va);
    // Code axis in LSB units, square to the voltage axis.
    const ua = va / a.lsb - 0.5, ub = vb / a.lsb - 0.5;
    const Y = (u) => T + PH * (1 - (u - ua) / (ub - ua));
    const rowH = PH / (ub - ua);
    plotGeom = { X, Xi, L, PW, T, PH, H, bellTop: T + PH + 42, bellH, W };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'ADC staircase around the input' });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'adc-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-l' }));
    const pat2 = sv('pattern', { id: 'adc-noisy', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat2.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'hatch-n' }));
    const clip = sv('clipPath', { id: 'adc-clip' }); clip.append(sv('rect', { x: L, y: T, width: PW, height: PH }));
    defs.append(pat, pat2, clip); svg.append(defs);
    svg.append(sv('rect', { x: L, y: T, width: PW, height: PH, class: 'plot' }));
    const g = sv('g', { 'clip-path': 'url(#adc-clip)' }); svg.append(g);

    // Outside the converter's range: hatched.
    const vLo = a.lo * a.lsb, vHi = (a.hi + 1) * a.lsb;
    if (vLo > va) g.append(sv('rect', { x: L, y: T, width: X(vLo) - L, height: PH, class: 'out' }));
    if (vHi < vb) g.append(sv('rect', { x: X(vHi), y: T, width: L + PW - X(vHi), height: PH, class: 'out' }));

    // Grid: one line per code when there is room, else every k-th.
    const nSteps = Math.ceil(vb / a.lsb) - Math.floor(va / a.lsb);
    const every = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((k) => (nSteps / k) <= (narrow ? 8 : 12)) || 20000;
    const cStart = Math.floor(va / a.lsb), cEnd = Math.ceil(vb / a.lsb);
    for (let c = Math.ceil(cStart / every) * every; c <= cEnd; c += every) {
      const x = X(c * a.lsb);
      g.append(sv('line', { x1: x, x2: x, y1: T, y2: T + PH, class: 'grid' }));
      const y = Y(c);
      g.append(sv('line', { x1: L, x2: L + PW, y1: y, y2: y, class: 'grid' }));
    }
    // Ideal line through the treads' middles, then the staircase.
    g.append(sv('line', { x1: X(va), y1: Y(va / a.lsb - 0.5), x2: X(vb), y2: Y(vb / a.lsb - 0.5), class: 'ideal' }));
    const stair = (lsb, lo, hi, scale) => {
      const c0 = Math.floor(va / lsb), c1 = Math.ceil(vb / lsb);
      if (c1 - c0 > 2400) {
        // Too fine to draw tread by tread: the clamped ideal line.
        const u = (v) => clamp(v / lsb, lo, hi + 1) * scale - 0.5;
        return `M${X(va)},${Y(u(va))} L${X(vb)},${Y(u(vb))}`;
      }
      let d = '';
      for (let c = c0; c <= c1; c++) {
        const k = clamp(c, lo, hi);
        const y = Y(k * scale);
        d += `${d ? 'L' : 'M'}${X(Math.max(va, c * lsb)).toFixed(1)},${y.toFixed(1)}L${X(Math.min(vb, (c + 1) * lsb)).toFixed(1)},${y.toFixed(1)}`;
      }
      return d;
    };
    // After oversampling: a finer staircase, the treads the decimated output has.
    if (a.R > 1 && a.whole > 0) {
      const f = 2 ** a.whole;
      g.append(sv('path', { d: stair(a.outLsb, a.lo * f, (a.hi + 1) * f - 1, 1 / f), class: 'stair-os' }));
    }
    g.append(sv('path', { d: stair(a.lsb, a.lo, a.hi, 1), class: 'stair' }));

    // p-p noise band behind the input.
    if (a.vin != null && a.sigma > 0) {
      const x1 = X(a.vin - 3.3 * a.sigma), x2 = X(a.vin + 3.3 * a.sigma);
      g.insertBefore(sv('rect', { x: x1, y: T, width: Math.max(1, x2 - x1), height: PH, class: 'pp-band' }), g.firstChild.nextSibling);
    }

    // Code axis labels.
    const yLab = (c, cls = 'm soft sm') => { const y = Y(c); if (y > T + 4 && y < T + PH - 2) svg.append(txt(L - 6, y + 3.5, String(c), cls, 'end')); };
    for (let c = Math.ceil(cStart / every) * every; c <= cEnd; c += every) if (c >= a.lo && c <= a.hi && c !== a.code) yLab(c);
    svg.append(txt(L - 6, T - 10, 'code', 'soft sm', 'end'));
    // Voltage axis: tread edges, with digits enough to tell them apart.
    svg.append(sv('line', { x1: L, x2: L + PW, y1: T + PH, y2: T + PH, class: 'axis' }));
    const digits = clamp(Math.ceil(Math.log10(Math.max(Math.abs(va), Math.abs(vb)) / (every * a.lsb))) + 2, 3, 9);
    let lastX = -1e9;
    for (let c = Math.ceil(cStart / every) * every; c <= cEnd; c += every) {
      const x = X(c * a.lsb);
      if (x < L - 1 || x > L + PW + 1) continue;
      svg.append(sv('line', { x1: x, x2: x, y1: T + PH, y2: T + PH + 4, class: 'axis' }));
      const s = E(c * a.lsb, 'V', digits);
      if (x - lastX > s.length * 6.4 + 8) { svg.append(txt(x, T + PH + 15, s, 'm soft sm', 'middle')); lastX = x; }
    }

    // The input: its tread, the crosshair to the code axis, the dimension of one LSB.
    if (a.vin != null) {
      const xv = X(a.vin);
      const inWin = a.clipped || (xv >= L && xv <= L + PW);
      const c = a.code;
      const t0 = X(c * a.lsb), t1 = X((c + 1) * a.lsb), yc = Y(c);
      if (inWin) {
        g.append(sv('line', { x1: t0, x2: t1, y1: yc, y2: yc, class: 'tread' }));
        g.append(sv('line', { x1: L, x2: Math.max(L, Math.min(t0, xv)), y1: yc, y2: yc, class: 'cross' }));
        if (!a.clipped) g.append(sv('line', { x1: xv, x2: xv, y1: yc, y2: T + PH, class: 'cross' }));
        // Code box on the axis.
        const lab = String(c), hx = a.codeHex;
        const bw = Math.max(lab.length, narrow ? 0 : hx.length) * 6.6 + 10;
        const by = clamp(yc - (narrow ? 8 : 15), T - 6, T + PH - 24);
        svg.append(sv('rect', { x: L - bw - 3, y: by, width: bw, height: narrow ? 16 : 28, rx: 3, class: a.clipped ? 'danger' : 'codebox' }));
        svg.append(txt(L - 3 - bw / 2, by + 12, lab, 'm codebox-t', 'middle'));
        if (!narrow) svg.append(txt(L - 3 - bw / 2, by + 24, hx, 'm codebox-t sm', 'middle'));
        // One LSB, dimensioned on the input's tread (outside arrows when the tread is narrow).
        const dy = yc - 14;
        const lsbLab = `1 LSB ${E(a.lsb, 'V', 4)}`;
        if (dy > T + 12) {
          const wide = t1 - t0 > 26;
          svg.append(sv('line', { x1: t0, x2: t0, y1: yc - 4, y2: dy - 5, class: 'dim' }));
          svg.append(sv('line', { x1: t1, x2: t1, y1: yc - 4, y2: dy - 5, class: 'dim' }));
          if (wide) {
            svg.append(sv('line', { x1: t0 + 1, x2: t1 - 1, y1: dy, y2: dy, class: 'dim' }));
            svg.append(sv('path', { d: `M${t0 + 1},${dy} l6,-3 v6 z M${t1 - 1},${dy} l-6,-3 v6 z`, class: 'dimf' }));
          } else {
            svg.append(sv('path', { d: `M${t0},${dy} l-6,-3 v6 z M${t1},${dy} l6,-3 v6 z`, class: 'dimf' }));
            svg.append(sv('line', { x1: t0 - 14, x2: t0, y1: dy, y2: dy, class: 'dim' }));
            svg.append(sv('line', { x1: t1, x2: t1 + 14, y1: dy, y2: dy, class: 'dim' }));
          }
          const lx = clamp((t0 + t1) / 2, L + lsbLab.length * 3.3 + 4, L + PW - lsbLab.length * 3.3 - 4);
          const tw = lsbLab.length * 6.5 + 8;
          svg.append(sv('rect', { x: lx - tw / 2, y: dy - 20, width: tw, height: 14, rx: 2, class: 'bg', opacity: 0.85 }));
          svg.append(txt(lx, dy - 9, lsbLab, 'm b', 'middle'));
        }
        // Reads back as: the tread's start, on its left end.
        const rb = `reads back ${E(a.vq, 'V', 6)}`;
        const ry = Math.min(T + PH - 8, yc + 15);
        const rx = clamp(t0, L + 4, L + PW - rb.length * 6.1 - 4);
        svg.append(sv('rect', { x: rx - 3, y: ry - 11, width: rb.length * 6.1 + 6, height: 14, rx: 2, class: 'bg', opacity: 0.85 }));
        svg.append(txt(rx, ry, rb, 'm soft'));
      } else {
        svg.append(txt(L + PW / 2, T + 16, 'the input is outside this window: press Fit', 'soft', 'middle'));
      }
      if (a.clipped) svg.append(txt(L + PW / 2, T + PH - 10, `clipped at code ${c}: the input is outside the range`, 'danger b', 'middle'));
    }

    // After-oversampling label on the fine staircase.
    if (a.R > 1 && a.whole > 0) svg.append(txt(L + 6, T + 14, narrow ? `${fmtNum(a.R)}×: ${a.outBits} bits` : `after ${fmtNum(a.R)}× oversampling: ${a.outBits} bits, 1 LSB ${E(a.outLsb, 'V', 3)}`, 'm os-t sm'));

    // Codes a conversion returns: probability bars on their own rows, at the right.
    const hx0 = L + PW + 8, hw = HW - (narrow ? 42 : 48);
    svg.append(txt(hx0, T - 10, narrow ? 'reads' : 'one conversion reads', 'soft sm'));
    if (a.hist && a.vin != null) {
      const pmax = Math.max(...a.hist.map((e) => e.p));
      for (const e of a.hist) {
        const y = Y(e.code);
        if (y < T || y > T + PH) continue;
        const bh = clamp(rowH * 0.7, 2, 14);
        svg.append(sv('rect', { x: hx0, y: y - bh / 2, width: Math.max(1.5, (e.p / pmax) * hw), height: bh, rx: 1, class: `hbar${e.code === a.code ? ' main' : ''}` }));
        if (rowH >= 11 && e.p >= 0.005) svg.append(txt(hx0 + (e.p / pmax) * hw + 4, y + 3.5, `${fmtNum(e.p * 100, e.p >= 0.1 ? 3 : 2)}%`, 'm sm'));
      }
    } else if (a.vin != null) {
      const t = txt(hx0, T + 20, `spans ~${fmtNum(a.ppLsb, 3)}`, 'm noise-t sm'); svg.append(t);
      svg.append(txt(hx0, T + 33, 'codes p-p', 'soft sm'));
    }

    // The noise: a bell under the axis, sigma handle, p-p span.
    const bt = T + PH + 42, bb = bt + bellH;
    svg.append(txt(L - 6, bt + 14, 'noise', 'soft sm', 'end'));
    svg.append(sv('line', { x1: L, x2: L + PW, y1: bb, y2: bb, class: 'axis' }));
    if (a.vin != null) {
      const s = a.sigma;
      if (s > 0) {
        const pdf = (v) => Math.exp(-0.5 * ((v - a.vin) / s) ** 2);
        let d = '', ds = '';
        const n = 160;
        for (let i = 0; i <= n; i++) {
          const v = va + ((vb - va) * i) / n;
          const y = bb - pdf(v) * (bellH - 8);
          d += `${i ? 'L' : 'M'}${X(v).toFixed(1)},${y.toFixed(1)}`;
          if (Math.abs(v - a.vin) <= s) ds += `${ds ? 'L' : 'M'}${X(v).toFixed(1)},${y.toFixed(1)}`;
        }
        const bell = sv('g', { 'clip-path': 'url(#adc-clip2)' });
        const clip2 = sv('clipPath', { id: 'adc-clip2' }); clip2.append(sv('rect', { x: L, y: bt - 2, width: PW, height: bellH + 2 })); defs.append(clip2);
        bell.append(sv('path', { d: `${d}L${X(vb)},${bb}L${X(va)},${bb}Z`, class: 'bell' }));
        if (ds) {
          const xs0 = X(Math.max(va, a.vin - s)), xs1 = X(Math.min(vb, a.vin + s));
          bell.append(sv('path', { d: `${ds}L${xs1},${bb}L${xs0},${bb}Z`, class: 'bell-s' }));
        }
        svg.append(bell);
        // p-p = 6.6 sigma, bracketed under the bell.
        const p0 = X(a.vin - 3.3 * s), p1 = X(a.vin + 3.3 * s);
        if (p1 - p0 > 20) {
          const yb = bb + 8;
          svg.append(sv('path', { d: `M${Math.max(L, p0)},${yb - 4} v4 H${Math.min(L + PW, p1)} v-4`, class: 'pp', fill: 'none' }));
        }
      } else svg.append(txt(clamp(X(a.vin) + 10, L + 4, L + PW - 290), bb - 8, 'no noise: drag the handle to add some', 'soft sm'));
      const sigLab = `σ ${E(s, 'V', 3)} = ${fmtNum(a.ditherLsb, 3)} LSB · p-p ${fmtNum(a.ppLsb, 3)} LSB`;
      const xs = X(a.vin + s);
      svg.append(txt(narrow ? L : clamp(xs + 12, L + 4, L + PW - sigLab.length * 5.9), narrow ? bt + 6 : bt + 10, sigLab, `m noise-t${narrow ? ' sm' : ''}`));
      // sigma handle
      const hx = clamp(xs, L, L + PW);
      const hn = sv('g', { class: 'h n', tabindex: 0, role: 'slider', 'data-fk': 'sigma', 'aria-label': 'Input noise sigma',
        'aria-valuetext': E(s, 'V', 3) });
      hn.append(sv('line', { x1: hx, x2: hx, y1: bt + 14, y2: bb, class: 'pp' }));
      hn.append(sv('circle', { cx: hx, cy: bb - (bellH - 8) * Math.exp(-0.5) , r: 6.5, class: 'knob' }));
      hn.append(sv('circle', { cx: hx, cy: bb - (bellH - 8) * Math.exp(-0.5), r: 10, class: 'ring' }));
      hn.append(sv('title', {}, 'Drag to set the input noise; arrows ×/÷ 1.25'));
      hn.addEventListener('keydown', (e) => {
        const f = { ArrowRight: 1.25, ArrowUp: 1.25, ArrowLeft: 0.8, ArrowDown: 0.8 }[e.key];
        if (e.key === 'Home' || e.key === 'Delete') { e.preventDefault(); ctx.set('noise', '0'); return; }
        if (!f) return; e.preventDefault();
        const base = a.sigma > 0 ? a.sigma : a.lsb * 0.1;
        ctx.set('noise', eng(base * f, 3));
      });
      hn.addEventListener('pointerdown', (e) => startDrag(e, 'sigma'));
      svg.append(hn);

      // The input handle, on the voltage axis.
      if (a.clipped || xv_in(a, X, L, PW)) {
        const xv = clamp(X(a.vin), L, L + PW);
        const off = X(a.vin) > L + PW ? ' ▸' : X(a.vin) < L ? '◂ ' : '';
        const lab = `${off === '◂ ' ? off : ''}Vin ${E(a.vin, 'V', digits + 1)}${off === ' ▸' ? off : ''}`;
        const tw = lab.length * 6.5 + 10;
        const lx = clamp(xv - tw / 2, L - 20, L + PW + 20 - tw);
        const hv = sv('g', { class: `h${a.clipped ? ' bad' : ''}`, tabindex: 0, role: 'slider', 'data-fk': 'vin',
          'aria-label': 'Input voltage', 'aria-valuetext': E(a.vin, 'V', 5) });
        hv.append(sv('line', { x1: xv, x2: xv, y1: T, y2: T + PH + 20, stroke: 'transparent', 'stroke-width': 14 }));
        hv.append(sv('path', { d: `M${xv},${T + PH + 18} l-6,8 h12 z`, class: 'knob' }));
        hv.append(sv('rect', { x: lx, y: T + PH + 22, width: tw, height: 16, rx: 3, class: 'lbl' }));
        hv.append(txt(lx + tw / 2, T + PH + 34, lab, 'm lbl-t', 'middle'));
        hv.append(sv('rect', { x: lx - 2, y: T + PH + 16, width: tw + 4, height: 24, rx: 4, class: 'ring' }));
        hv.append(sv('title', {}, 'Drag, or arrows: 1 LSB, Shift: 10 LSB'));
        hv.addEventListener('keydown', (e) => {
          const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
          if (!d) return; e.preventDefault();
          setVin(a.vin + d * (e.shiftKey ? 10 : 1) * a.lsb);
        });
        svg.append(hv);
      }
    }
    plotDraw.replaceChildren(svg);
  }
  const xv_in = (a, X, L, PW) => { const x = X(a.vin); return x >= L - 1 && x <= L + PW + 1; };

  // ---------- drawing: the output word ----------
  function drawWord(a) {
    const W = Math.max(280, wordDraw.clientWidth || 380);
    const n = a.N, extra = a.R > 1 ? a.whole : 0, tot = n + extra;
    const L = 30, R = 30;
    const cw = Math.min(26, (W - L - R) / tot);
    const x0 = L + ((W - L - R) - cw * tot) / 2;
    const cy = 34, ch = 24, H = 104;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `code ${a.code} as ${n} bits` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'adc-noisy2', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: 'var(--warn)', 'stroke-width': 1.2, 'stroke-opacity': 0.8 }));
    defs.append(pat); svg.append(defs);
    let bits = null;
    if (a.code != null) {
      const levels = BigInt(a.levels);
      let u = BigInt(a.code); if (u < 0n) u += levels;
      bits = u.toString(2).padStart(n, '0');
    }
    const nf = Math.max(0, Math.min(n, Math.floor(a.nfBits + 1e-9)));
    for (let i = 0; i < tot; i++) {
      const x = x0 + i * cw;
      const os = i >= n;
      const on = !os && bits && bits[i] === '1';
      svg.append(sv('rect', { x: x + 0.5, y: cy, width: cw - 1, height: ch, rx: Math.min(3, cw / 5), class: `cell${on ? ' on' : ''}${os ? ' os' : ''}` }));
      if (!os && i >= nf) svg.append(sv('rect', { x: x + 0.5, y: cy, width: cw - 1, height: ch, fill: 'url(#adc-noisy2)' }));
      if (cw >= 13 && !os && bits) svg.append(txt(x + cw / 2, cy + 16.5, bits[i], `cell-t${on ? ' on' : ''}`, 'middle'));
      if (cw >= 13 && os) svg.append(txt(x + cw / 2, cy + 16.5, '·', 'os-t', 'middle'));
      const b = n - 1 - i;
      const labEvery = cw >= 16 ? 1 : cw >= 9 ? 4 : 8;
      if (!os && (b % labEvery === 0 || i === 0)) svg.append(txt(x + cw / 2, cy - 4, String(b), 'm soft sm', 'middle'));
    }
    // Braces: noise-free bits above... below the word, flicker and oversampling.
    const yb = cy + ch + 6;
    const brace = (i0, i1, cls, label, cl) => {
      if (i1 <= i0) return;
      const xa = x0 + i0 * cw + 1, xb = x0 + i1 * cw - 1;
      svg.append(sv('path', { d: `M${xa},${yb} v4 H${xb} v-4`, class: `brace ${cls}` }));
      const mid = (xa + xb) / 2;
      const tw = label.length * 5.8;
      svg.append(txt(clamp(mid, L - 26 + tw / 2, W - R + 26 - tw / 2), yb + 16, label, `m sm ${cl}`, 'middle'));
    };
    brace(0, nf, '', `noise-free ${fmtNum(a.nfBits, 3)}`, 'soft');
    brace(nf, n, 'n', n - nf > 2 ? 'flicker' : '±', 'warn-t');
    if (extra) brace(n, tot, 'o', `+${extra} (${fmtNum(a.R)}×)`, 'os-t');
    // ENOB mark, a fraction into the word.
    const xe = x0 + clamp(a.effBits, 0, n) * cw;
    svg.append(sv('line', { x1: xe, x2: xe, y1: cy - 14, y2: cy + ch + 3, class: 'enob' }));
    svg.append(txt(clamp(xe, L + 30, W - R - 30), 12, `ENOB ${fmtNum(a.effBits, 3)}`, 'm b', 'middle'));
    // -/+ bits at the word's ends.
    const btn = (x, label, d, fk, aria) => {
      const gb = sv('g', { class: 'btn', tabindex: 0, role: 'button', 'data-fk': fk, 'aria-label': aria });
      gb.append(sv('rect', { x: x - 11, y: cy + 1, width: 22, height: ch - 2, rx: 3 }));
      gb.append(txt(x, cy + 17, label, '', 'middle'));
      const go = () => ctx.set('bits', String(clamp(n + d, 1, 32)));
      gb.addEventListener('click', go);
      gb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      svg.append(gb);
    };
    btn(x0 - 16, '−', -1, 'bminus', 'One bit fewer');
    btn(x0 + tot * cw + 16, '+', 1, 'bplus', 'One bit more');
    svg.append(txt(W / 2, H - 4, a.code != null ? `code ${a.code} · ${a.codeHex} · ${a.bip ? 'two\'s complement' : 'straight binary'}` : 'no input voltage', 'm soft sm', 'middle'));
    wordDraw.replaceChildren(svg);
  }

  // ---------- drawing: oversampling ----------
  function drawOs(a) {
    const W = Math.max(280, osDraw.clientWidth || 380);
    const H = 150;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `oversampling ${a.R} times` });
    const shown = Math.min(a.R, 64);
    const clen = Math.max(String(a.code ?? 0).length + 1, 3);
    const L = clen * 6 + 10, sw = W - L - 138, top = 18, bot = 92;
    // Samples: each lands on a code; the codes follow run()'s probabilities.
    const cdf = []; let acc = 0;
    for (const e of a.hist || [{ code: a.code ?? 0, p: 1 }]) { acc += e.p; cdf.push([acc, e.code]); }
    const codeAt = (q) => (cdf.find(([p]) => q * acc <= p) || cdf[cdf.length - 1])[1];
    const samples = a.R > 1 ? Array.from({ length: shown }, (_, k) => codeAt(((k + 0.5) * 0.6180339887) % 1)) : [a.code ?? 0];
    const cs = [...new Set(samples)].sort((x, y) => x - y);
    const rows = Math.max(3, cs.length);
    const cMid = a.code ?? 0;
    const lo = Math.min(cMid - 1, ...cs), hi = Math.max(cMid + 1, ...cs);
    const Y = (c) => bot - ((c - lo + 0.5) / (hi - lo + 1)) * (bot - top);
    for (let c = lo; c <= hi; c++) {
      if (hi - lo > 5 && c % Math.ceil((hi - lo + 1) / 5)) continue;
      svg.append(sv('line', { x1: L, x2: L + sw, y1: Y(c), y2: Y(c), class: 'row' }));
      svg.append(txt(L - 4, Y(c) + 3.5, String(c), 'm soft sm', 'end'));
    }
    const flat = !a.dithered && a.R > 1;
    samples.forEach((c, k) => {
      const x = L + 4 + (k + 0.5) * ((sw - 8) / shown);
      svg.append(sv('circle', { cx: x, cy: Y(c), r: clamp((sw - 8) / shown / 2.6, 1.6, 4), class: `dot${flat ? ' flat' : ''}` }));
    });
    svg.append(txt(L, 11, a.R > 1 ? `${fmtNum(a.R)} samples${a.R > shown ? ` (first ${shown} shown)` : ''}` : 'one sample per output', 'soft sm'));
    // Brace and the decimator.
    svg.append(sv('path', { d: `M${L},${bot + 6} v4 H${L + sw} v-4`, class: 'brace' }));
    const rate = a.fs ? `${E(a.fs, 'S/s', 3)}` : 'fs ?';
    svg.append(txt(L + sw / 2, bot + 22, rate, 'm soft sm', 'middle'));
    const bx = L + sw + 14, bw = W - bx - 4;
    svg.append(sv('path', { d: `M${L + sw + 2},${(top + bot) / 2} h10`, class: 'brace' }));
    svg.append(sv('rect', { x: bx, y: top, width: bw, height: bot - top + 28, rx: 4, class: 'box' }));
    const osT = (y, s, cls) => svg.append(txt(bx + 8, y, s, cls));
    osT(top + 15, a.R > 1 ? `Σ${fmtNum(a.R)} ≫ ${a.whole}` : 'no decimation', 'm soft sm');
    osT(top + 34, `${a.outBits} bits`, `m b ${a.R > 1 && a.whole > 0 ? (flat ? 'warn-t' : 'os-t') : ''}`);
    osT(top + 50, `LSB ${E(a.outLsb, 'V', 3)}`, 'm sm');
    osT(top + 66, a.outRate ? `${E(a.outRate, 'S/s', 3)} out` : 'give fs', 'm sm');
    osT(top + 82, `ENOB ${fmtNum(a.enobOs, 3)}`, 'm sm');
    osT(top + 98, `SNR ${fmtNum(a.snrOs, 4)} dB`, 'm sm');
    // SNR, before and after, as two bars on one scale.
    const sy = bot + 34, sx = L, sww = sw;
    const smax = Math.max(a.snrOs, a.snrIdeal, 60) * 1.05;
    svg.append(txt(sx - 4, sy + 7, 'SNR', 'soft sm', 'end'));
    svg.append(sv('rect', { x: sx, y: sy, width: (a.snrIdeal / smax) * sww, height: 6, rx: 1, class: 'snr' }));
    if (a.R > 1) svg.append(sv('rect', { x: sx, y: sy + 9, width: (a.snrOs / smax) * sww, height: 6, rx: 1, class: 'snr os' }));
    svg.append(txt(sx + (a.snrIdeal / smax) * sww + 4, sy + 6, `${fmtNum(a.snrIdeal, 4)}`, 'm sm'));
    if (a.R > 1) svg.append(txt(sx + (a.snrOs / smax) * sww + 4, sy + 16, `+${fmtNum(a.snrOs - a.snrIdeal, 3)} dB`, 'm sm os-t'));
    if (flat) svg.append(txt(L + sw / 2, top + 4 + 8, 'no dither: every sample reads the same code', 'warn-t sm b', 'middle'));
    osDraw.replaceChildren(svg);
  }

  // ---------- drag ----------
  function startDrag(e, what) {
    e.preventDefault(); e.stopPropagation();
    view.drag = what;
    const host = what === 'lens' ? lensDraw : plotDraw;
    try { host.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    move(e, host);
  }
  function move(e, host) {
    const a = A(); if (!a || !view.drag) return;
    const r = host.getBoundingClientRect();
    const sx = (e.clientX - r.left) * ((host === lensDraw ? lensGeom.W : plotGeom.W) / r.width);
    if (view.drag === 'lens') {
      const v = lensGeom.inv(clamp(sx, lensGeom.L, lensGeom.W - lensGeom.R));
      view.c = v; setVin(v);
    } else if (view.drag === 'vin') {
      setVin(plotGeom.Xi(clamp(sx, plotGeom.L, plotGeom.L + plotGeom.PW)));
    } else if (view.drag === 'sigma' && a.vin != null) {
      const s = Math.abs(plotGeom.Xi(sx) - a.vin);
      ctx.set('noise', eng(s, 3));
    }
  }
  plotDraw.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !plotGeom) return;
    const r = plotDraw.getBoundingClientRect();
    const y = (e.clientY - r.top) * (plotGeom.W / r.width);
    if (y > plotGeom.bellTop) return; // the bell only moves by its handle
    startDrag(e, 'vin');
  });
  lensDraw.addEventListener('pointerdown', (e) => { if (e.button === 0 && lensGeom) startDrag(e, 'lens'); });
  for (const host of [plotDraw, lensDraw]) {
    host.addEventListener('pointermove', (e) => { if (view.drag) move(e, host); });
    const end = () => { view.drag = null; };
    host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
  }
  plotDraw.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 2 : 0.5); }, { passive: false });
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(0.5); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(2); }
  });

  // ---------- controls from the result ----------
  function drawControls(a) {
    const raw = ctx.raw;
    for (const f of fields) if (document.activeElement !== f.inp) f.inp.value = raw[f.key] ?? '';
    for (const f of fields) f.inp.classList.toggle('bad', String(raw[f.key] ?? '').trim() !== '' && ctx.parseEng(raw[f.key]) == null);
    vrefSeg.replaceChildren(...VREFS.map((v) => h('button', { type: 'button', 'aria-pressed': String(Math.abs(Number(v) - (a?.vref ?? -1)) < 1e-9),
      onclick: () => ctx.set('vref', v) }, v)));
    rangeSeg.replaceChildren(...[['unipolar', '0 … Vref'], ['bipolar', '±Vref']].map(([k, t]) => h('button', { type: 'button',
      'aria-pressed': String((raw.range || 'unipolar') === k), onclick: () => ctx.set('range', k) }, t)));
    osrSeg.replaceChildren(...OSRS.map((r) => h('button', { type: 'button', 'aria-pressed': String((a?.R ?? 1) === r),
      onclick: () => ctx.set('osr', String(r)) }, `${r}×`)));
    if (a) zoomRead.textContent = `${view.spanL} LSB = ${E(view.spanL * a.lsb, 'V', 3)}`;
  }

  function drawReadout(res) {
    const a = res.adc;
    const cell = (label, value, cls) => h('div', {}, h('span', {}, label), h('b', { class: cls || null }, value));
    readout.replaceChildren(
      cell('LSB', E(a.lsb, 'V', 4)),
      cell('levels', a.levels.toLocaleString('en-US')),
      cell('ideal SNR', `${fmtNum(a.snrIdeal, 4)} dB`),
      cell('q-noise', E(a.qn, 'V', 3) + ' rms'),
      cell('ENOB', `${fmtNum(a.effBits, 3)} bits`),
      cell('noise-free', `${fmtNum(a.nfBits, 3)} bits`, a.nfBits < a.N - 2 ? 'warn' : null));
  }

  function draw() {
    const res = ctx.result;
    const a = res?.adc;
    drawControls(a);
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    notesBody.replaceChildren(...(res?.notes || []).map((w) => h('div', {}, w)));
    if (!a) {
      for (const d of [lensDraw, plotDraw, wordDraw, osDraw]) d.replaceChildren();
      readout.replaceChildren();
      return;
    }
    keepFocus(() => {
      const win = windowOf(a);
      drawControls(a);
      drawLens(a, win);
      drawPlot(a, win);
      drawWord(a);
      drawOs(a);
      drawReadout(res);
    });
  }

  ctx.onResult(() => draw());
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(draw); }).observe(root);
}
