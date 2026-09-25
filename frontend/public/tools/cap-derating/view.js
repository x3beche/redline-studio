// Capacitor Derating page: the part itself. Its label runs across the top and
// is edited in place; below it every package and voltage rating of the same
// nominal value stands as a small chip, filled to the share of capacitance it
// keeps at your bias and temperature, so the part that still holds enough is
// found by looking and picked with a click. Beside the board the chosen chip
// is cut open (layer thickness and field), and its bias and temperature curves
// carry the operating point as a handle to drag. Every number comes from
// run()'s result (each chip on the board is its own run()).

import { run } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const PFX = [[1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
function eng(v, unit = '', digits = 3) {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return `0 ${unit}`.trim();
  const [m, p] = PFX.find(([m]) => Math.abs(v) >= m * 0.9995) || PFX[PFX.length - 1];
  return `${Number((v / m).toPrecision(digits))} ${p}${unit}`;
}
const pc = (f, d = 3) => `${Number((f * 100).toPrecision(d))} %`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const PKGS = ['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2220'];
const METRIC = { '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225', '1812': '4532', '2220': '5750' };
const RATINGS = [4, 6.3, 10, 16, 25, 35, 50, 100];
const DIELS = ['C0G', 'X7R', 'X5R', 'X6S', 'X7S', 'X8R', 'Y5V'];
const TOLS = [['5', '±5 % J'], ['10', '±10 % K'], ['20', '±20 % M']];
const capText = (v) => eng(v, '').replace(' ', '').replace('µ', 'u');
const tone = (f) => (f < 0.3 ? 'bad' : f < 0.5 ? 'warn' : 'ok');

const CSS = `
.cd { --tool-ok: #2f855a; --tool-warn: #b7791f; --tool-bad: #c0392b; --tool-term: #9aa6b2; --tool-body: #c9b99a; --tool-elec: #6b7785;
  --tool-need: #1f4ed8; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cd {
  --tool-ok: #68b36b; --tool-warn: #e8a735; --tool-bad: #e57373; --tool-term: #8b97a3; --tool-body: #6d634f; --tool-elec: #b8c4cf; --tool-need: #7d9bff; } }
:root[data-theme="dark"] .cd { --tool-ok: #68b36b; --tool-warn: #e8a735; --tool-bad: #e57373; --tool-term: #8b97a3; --tool-body: #6d634f; --tool-elec: #b8c4cf; --tool-need: #7d9bff; }
.k-page { padding: 12px; }
.cd-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.cd-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 12px; padding: 6px 10px 2px; font-size: 11.5px; color: var(--ink-soft); }
.cd-head b { color: var(--ink); font-weight: 600; font-size: 12.5px; }
.cd-head .r { margin-left: auto; }
/* the part label */
.cd-label { display: flex; flex-wrap: wrap; align-items: stretch; gap: 0; padding: 0; overflow: hidden; }
.cd-part { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 4px 14px; padding: 8px 12px 9px; flex: 1 1 520px; min-width: 0; }
.cd-f { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cd-f > span { font-size: 10.5px; color: var(--ink-soft); letter-spacing: .02em; }
.cd-f input, .cd-f select { font: 600 17px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); background: transparent; border: 0;
  border-bottom: 1.5px dashed var(--ink-soft); padding: 1px 2px; border-radius: 0; min-width: 0; }
.cd-f input:hover, .cd-f select:hover { background: var(--sunken); }
.cd-f input:focus-visible, .cd-f select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cd-f input.bad { border-bottom-color: var(--danger); }
.cd-f .u { font: 500 14px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.cd-f .row { display: flex; align-items: baseline; gap: 3px; }
.cd-sep { align-self: stretch; width: 1px; background: var(--line); margin: 2px 2px; }
.cd-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.cd-seg button { border: 0; background: transparent; padding: 2px 7px; font: 600 13px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); cursor: pointer; }
.cd-seg button + button { border-left: 1px solid var(--line); }
.cd-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.cd-verdict { flex: 0 1 330px; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 8px 14px; border-left: 1px solid var(--line); background: var(--sunken); min-width: 220px; }
.cd-verdict .big { font: 600 26px "IBM Plex Mono", ui-monospace, monospace; line-height: 1.1; }
.cd-verdict .big small { font-size: 14px; color: var(--ink-soft); font-weight: 500; }
.cd-verdict .sub { font-size: 12px; color: var(--ink-soft); }
.cd-verdict .ok { color: var(--tool-ok); } .cd-verdict .warn { color: var(--tool-warn); } .cd-verdict .bad { color: var(--tool-bad); }
@media (max-width: 700px) { .cd-verdict { border-left: 0; border-top: 1px solid var(--line); flex-basis: 100%; } .cd-f input, .cd-f select { font-size: 15px; } }
.cd-main { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 10px; align-items: start; }
@media (max-width: 1100px) { .cd-main { grid-template-columns: minmax(0, 1fr); } }
.cd-board svg, .cd-detail svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.cd-detail { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (max-width: 1100px) and (min-width: 700px) { .cd-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.cd svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; fill: var(--ink); }
.cd svg text.soft { fill: var(--ink-soft); } .cd svg text.sm { font-size: 10px; } .cd svg text.b { font-weight: 600; }
.cd svg text.sans { font-family: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif; }
.cd svg text.ok { fill: var(--tool-ok); } .cd svg text.warn { fill: var(--tool-warn); } .cd svg text.bad { fill: var(--tool-bad); }
.cd svg .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.cd .cell { cursor: pointer; outline: none; }
.cd .cell text.halo { stroke: var(--sunken); stroke-width: 4px; }
.cd .cell .frame { fill: var(--sunken); stroke: var(--line); stroke-width: 1; }
.cd .cell:hover .frame { stroke: var(--ink-soft); }
.cd .cell .term { fill: var(--tool-term); opacity: .55; }
.cd .cell .lvl.ok { fill: var(--tool-ok); } .cd .cell .lvl.warn { fill: var(--tool-warn); } .cd .cell .lvl.bad { fill: var(--tool-bad); }
.cd .cell .lvl { opacity: .32; }
.cd .cell .top.ok { stroke: var(--tool-ok); } .cd .cell .top.warn { stroke: var(--tool-warn); } .cd .cell .top.bad { stroke: var(--tool-bad); }
.cd .cell .top { stroke-width: 2; }
.cd .cell.over .frame { fill: url(#cd-hatch); }
.cd .cell.nomade .frame { stroke-dasharray: 3 3; fill: transparent; }
.cd .cell.sel .frame { stroke: var(--accent); stroke-width: 2.5; }
.cd .cell:focus-visible .frame { stroke: var(--accent); stroke-width: 3; stroke-dasharray: none; }
.cd .needl { stroke: var(--tool-need); stroke-width: 1.2; stroke-dasharray: 4 2; }
.cd .rowsel { fill: var(--accent); opacity: .07; }
.cd .pkgtop .bd { fill: var(--tool-body); stroke: var(--line); }
.cd .pkgtop .tm { fill: var(--tool-term); }
.cd .pkgtop.sel .bd { stroke: var(--accent); stroke-width: 2; }
.cd .grid { stroke: var(--line-soft); stroke-width: 1; }
.cd .axis { stroke: var(--line); stroke-width: 1; }
.cd .curve { fill: none; stroke: var(--accent); stroke-width: 2.2; }
.cd .ghost { fill: none; stroke: var(--ink-soft); stroke-width: 1.2; stroke-dasharray: 5 3; }
.cd .rated { stroke: var(--tool-bad); stroke-width: 1.2; stroke-dasharray: 6 3; }
.cd .derate { stroke: var(--tool-warn); stroke-width: 1; stroke-dasharray: 2 3; }
.cd .over { fill: var(--tool-bad); opacity: .08; }
.cd .band { fill: var(--tool-ok); opacity: .09; }
.cd .bandl { stroke: var(--tool-ok); stroke-width: 1; stroke-dasharray: 3 3; opacity: .8; }
.cd .outside { fill: var(--tool-bad); opacity: .07; }
.cd .h { cursor: grab; outline: none; }
.cd .h .hc { fill: var(--surface); stroke: var(--accent); stroke-width: 2.5; }
.cd .h:hover .hc { fill: var(--sunken); }
.cd .h:focus-visible .hc { stroke-width: 4; }
.cd .h .hit { fill: transparent; }
.cd .guide { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 2 2; opacity: .7; }
.cd .dragging, .cd .dragging * { cursor: grabbing !important; }
.cd .x-body { fill: var(--tool-body); stroke: var(--ink-soft); stroke-width: 1; }
.cd .x-term { fill: var(--tool-term); stroke: var(--ink-soft); stroke-width: 1; }
.cd .x-el { stroke: var(--tool-elec); stroke-width: 1.3; }
.cd .x-lens { fill: var(--surface); stroke: var(--ink-soft); stroke-width: 1; }
.cd .x-field { stroke: var(--accent); stroke-width: 1.2; marker-end: url(#cd-arrow); }
.cd .dim { stroke: var(--ink-soft); stroke-width: 1; }
.cd-fall { padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; }
.cd-fall .r { display: grid; grid-template-columns: 96px minmax(0, 1fr) 70px; gap: 8px; align-items: center; color: var(--ink-soft); }
.cd-fall .t { height: 12px; background: var(--sunken); border-radius: 2px; position: relative; overflow: hidden; }
.cd-fall .t i { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
.cd-fall .t i.keep { background: var(--line); }
.cd-fall .t i.lost { background: var(--tool-bad); opacity: .45; }
.cd-fall .t i.res.ok { background: var(--tool-ok); } .cd-fall .t i.res.warn { background: var(--tool-warn); } .cd-fall .t i.res.bad { background: var(--tool-bad); }
.cd-fall .r b { font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }
.cd-fall .r.sum { color: var(--ink); font-weight: 600; }
.cd-warn { display: flex; flex-direction: column; gap: 5px; }
.cd-warn div { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 5px; padding: 5px 9px; font-size: 12px; }
.cd-warn:empty { display: none; }
.cd-foot { font-size: 11px; color: var(--ink-soft); padding: 2px 10px 7px; }
.cd-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; background: var(--sunken); }
.cd-legend { display: inline-flex; flex-wrap: wrap; gap: 3px 12px; }
.cd-legend i { display: inline-block; width: 11px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.cd-notes { font-size: 12px; color: var(--ink-soft); }
.cd-notes summary { cursor: pointer; }
.cd-notes ul { margin: 6px 0 0; padding-left: 18px; }
.cd .k-out { max-height: 260px; }
`;

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let res = null, m = null, drag = null, focusKey = null;

  // ---------- the part label ----------
  const fld = (key, label, unit, width, list) => {
    const inp = h('input', { spellcheck: 'false', inputmode: 'decimal', 'aria-label': label, style: `width:${width}ch`, list: list || null });
    inp.addEventListener('input', () => ctx.set(key, inp.value.trim()));
    // Arrow keys step the value: the ladder for capacitances and ratings, fixed steps for the rest.
    inp.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return;
      const v = ctx.input[key];
      let nv = null;
      if (key === 'vrated') {
        const cur = Number.isFinite(v) ? v : 10;
        nv = d > 0 ? RATINGS.find((r) => r > cur + 1e-9) : [...RATINGS].reverse().find((r) => r < cur - 1e-9);
        nv = nv == null ? null : String(nv);
      } else if (key === 'cnom' || key === 'need') {
        const cur = Number.isFinite(v) && v > 0 ? v : 1e-6;
        const lad = []; for (let k = -14; k <= -2; k++) for (const mnt of [1, 2.2, 4.7]) lad.push(Number((mnt * 10 ** k).toPrecision(3)));
        const n = d > 0 ? lad.find((x) => x > cur * 1.001) : [...lad].reverse().find((x) => x < cur * 0.999);
        nv = n == null ? null : capText(n);
      } else {
        const stp = { vbias: e.shiftKey ? 1 : 0.1, temp: e.shiftKey ? 10 : 1, years: 1 }[key] || 1;
        const cur = Number.isFinite(v) ? v : 0;
        nv = String(Math.round((cur + d * stp) * 10) / 10);
        if (key === 'years' && Number(nv) < 0) nv = '0';
      }
      if (nv == null) return;
      e.preventDefault(); inp.value = nv; ctx.set(key, nv);
    });
    const f = h('label', { class: 'cd-f' }, h('span', {}, label), h('span', { class: 'row' }, inp, unit ? h('span', { class: 'u' }, unit) : null));
    f.inp = inp; f.key = key;
    return f;
  };
  const sel = (key, label, opts) => {
    const e = h('select', { 'aria-label': label, onchange: (ev) => ctx.set(key, ev.target.value) },
      opts.map(([v, t]) => h('option', { value: v }, t)));
    const f = h('label', { class: 'cd-f' }, h('span', {}, label), e);
    f.inp = e; f.key = key;
    return f;
  };
  const seg = (key, label, opts) => {
    const g = h('div', { class: 'cd-seg', role: 'group', 'aria-label': label });
    for (const [v, t] of opts) g.append(h('button', { type: 'button', 'data-v': v, onclick: () => ctx.set(key, v) }, t));
    const f = h('div', { class: 'cd-f' }, h('span', {}, label), g);
    f.seg = g; f.key = key;
    return f;
  };
  const F = {
    cnom: fld('cnom', 'Nominal', 'F', 6),
    tol: seg('tol', 'Tolerance', TOLS.map(([v, t]) => [v, t.split(' ')[0]])),
    vrated: fld('vrated', 'Rated', 'V', 4),
    diel: sel('diel', 'Dielectric', DIELS.map((d) => [d, d])),
    pkg: sel('pkg', 'Package', PKGS.map((p) => [p, `${p}`])),
    vbias: fld('vbias', 'DC bias', 'V', 5),
    temp: fld('temp', 'Temperature', '°C', 4),
    years: fld('years', 'Age', 'yr', 3),
    need: fld('need', 'You need', 'F', 6),
  };
  F.need.inp.placeholder = 'opt.';
  const verdict = h('div', { class: 'cd-verdict', 'aria-live': 'polite' });
  const label = h('section', { class: 'cd-card cd-label' },
    h('div', { class: 'cd-part' }, F.cnom, F.tol, F.vrated, F.diel, F.pkg, h('span', { class: 'cd-sep' }), F.vbias, F.temp, F.years, F.need),
    verdict);

  // ---------- board ----------
  const board = s('svg', { role: 'grid', 'aria-label': 'Packages and voltage ratings of the same nominal value' });
  const boardHead = h('div', { class: 'cd-head' });
  const boardCard = h('section', { class: 'cd-card cd-board' }, boardHead, board,
    h('div', { class: 'cd-foot' }, 'Each chip is filled to the share of the nominal it keeps here. Click one to take its package and rating; ',
      h('kbd', {}, '←'), h('kbd', {}, '→'), h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move through the board.'));

  // ---------- detail ----------
  const xsec = s('svg', { role: 'img' });
  const biasSvg = s('svg', { role: 'group', 'aria-label': 'Capacitance against DC bias' });
  const tempSvg = s('svg', { role: 'group', 'aria-label': 'Capacitance against temperature' });
  const fall = h('div', { class: 'cd-fall' });
  const xsecHead = h('div', { class: 'cd-head' });
  const biasHead = h('div', { class: 'cd-head' });
  const tempHead = h('div', { class: 'cd-head' });
  const warnBox = h('div', { class: 'cd-warn', 'aria-live': 'polite' });
  const detail = h('aside', { class: 'cd-detail' },
    h('section', { class: 'cd-card' }, xsecHead, xsec),
    h('section', { class: 'cd-card' }, biasHead, biasSvg),
    h('section', { class: 'cd-card' }, tempHead, tempSvg),
    h('section', { class: 'cd-card' }, h('div', { class: 'cd-head' }, h('b', {}, 'Where it goes'), h('span', {}, 'each factor multiplies')), fall));
  const notes = h('details', { class: 'cd-notes' });
  root.append(h('div', { class: 'cd' }, label, warnBox, h('div', { class: 'cd-main' }, boardCard, detail), ctx.outputs, notes));

  function syncLabel() {
    const raw = ctx.raw;
    for (const f of Object.values(F)) {
      if (f.inp && document.activeElement !== f.inp) f.inp.value = raw[f.key] ?? '';
      if (f.seg) for (const b of f.seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === String(raw[f.key])));
    }
    const inp = ctx.input;
    for (const k of ['cnom', 'vrated', 'vbias', 'temp', 'years', 'need']) {
      const bad = String(raw[k] ?? '').trim() !== '' && !Number.isFinite(inp[k]);
      F[k].inp.classList.toggle('bad', bad);
    }
  }

  // ---------- helpers for keyboard focus across redraws ----------
  document.addEventListener('focusin', (e) => { focusKey = e.target.getAttribute?.('data-key') || null; });
  const restoreFocus = () => {
    if (!focusKey) return;
    const el = root.querySelector(`[data-key="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  };

  // ---------- board drawing ----------
  let cells = null; // [{pkg, vr (the row's value: a capacitance or a rating), r}]
  // Rows are either the nominal values around yours (1-2.2-4.7 ladder, three below and three
  // above) or the common voltage ratings of your value; the choice is kept per viewer.
  let rowMode = 'values';
  try { rowMode = localStorage.getItem('redline.tool.cap-derating.rows') || 'values'; } catch { /* private window */ }
  const RATE_ROWS = [6.3, 10, 16, 25, 50];
  const byRating = () => rowMode === 'ratings';
  const rowIs = (vr) => (byRating() ? Math.abs(vr - ctx.input.vrated) < 1e-9 : Math.abs(vr / ctx.input.cnom - 1) < 1e-6);
  const rowSet = (vr) => (byRating() ? { vrated: String(vr) } : { cnom: capText(vr) });
  const rowLabel = (vr, narrow) => (byRating() ? `${vr} V` : eng(vr, narrow ? '' : 'F', 2));
  function ratingsList() {
    if (byRating()) {
      const vr = ctx.input.vrated;
      const list = [...RATE_ROWS];
      if (Number.isFinite(vr) && vr > 0 && !list.includes(vr)) { list.push(vr); list.sort((a, b) => a - b); }
      return list;
    }
    const c = ctx.input.cnom;
    if (!(c > 0)) return [];
    const ladder = [];
    for (let k = -14; k <= -2; k++) for (const mnt of [1, 2.2, 4.7]) ladder.push(Number((mnt * 10 ** k).toPrecision(3)));
    const below = ladder.filter((v) => v < c * 0.999).slice(-3), above = ladder.filter((v) => v > c * 1.001).slice(0, 3);
    return [...below, c, ...above];
  }
  function computeBoard() {
    const inp = ctx.input;
    cells = [];
    for (const cv of ratingsList()) for (const pkg of PKGS) {
      let r = null;
      try { r = run({ ...inp, pkg, ...(byRating() ? { vrated: cv } : { cnom: cv }) }); } catch { r = null; }
      cells.push({ pkg, vr: cv, r: r?.model, nomade: (r?.warnings || []).some((w) => /usually hold/.test(w)) });
    }
  }

  function drawBoard() {
    board.replaceChildren();
    if (!m || !cells) return;
    const W = Math.max(300, board.clientWidth || boardCard.clientWidth || 800);
    const narrow = W < 600;
    const rl = ratingsList();
    const LW = narrow ? 46 : 60, headH = narrow ? 44 : 78, pad = 3;
    const cw = (W - LW - 6) / PKGS.length;
    const ch = narrow ? 42 : clamp(Math.round(cw * 0.52), 46, 62);
    const H = headH + rl.length * ch + 22;
    board.setAttribute('viewBox', `0 0 ${W} ${H}`); board.setAttribute('height', H);
    const defs = s('defs');
    defs.innerHTML = `<pattern id="cd-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--sunken)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--tool-bad)" stroke-width="1.4" opacity=".45"/></pattern>`;
    board.append(defs);
    // package headers, all drawn to one scale (top view)
    const mmpx = Math.min((cw - 10) / 5.7, (headH - 30) / 5.0);
    const inp = ctx.input;
    PKGS.forEach((p, i) => {
      const cx = LW + i * cw + cw / 2;
      const r0 = run({ ...inp, pkg: p })?.model;
      const [L, Wd] = r0?.body || [1, 0.5];
      const bw = Math.max(1.5, L * mmpx), bh = Math.max(1, Wd * mmpx), tw = Math.max(0.6, bw * 0.16);
      const g = s('g', { class: `pkgtop${p === inp.pkg ? ' sel' : ''}` });
      const yb = narrow ? 8 : headH - 30 - bh / 2 - (5.0 * mmpx - bh) / 2;
      const yc = narrow ? headH - 30 : (headH - 30) / 2 + 4;
      g.append(s('rect', { class: 'bd', x: cx - bw / 2, y: yc - bh / 2, width: bw, height: bh, rx: 0.8 }));
      g.append(s('rect', { class: 'tm', x: cx - bw / 2, y: yc - bh / 2, width: tw, height: bh }), s('rect', { class: 'tm', x: cx + bw / 2 - tw, y: yc - bh / 2, width: tw, height: bh }));
      g.append(s('title', {}, `${p} (${METRIC[p]} metric): ${L} × ${Wd} mm, drawn to scale`));
      board.append(g);
      void yb;
      board.append(s('text', { x: cx, y: headH - 12, 'text-anchor': 'middle', class: `b${p === inp.pkg ? '' : ''}` }, p));
      if (!narrow) board.append(s('text', { x: cx, y: headH - 1, 'text-anchor': 'middle', class: 'soft sm' }, `${L}×${Wd}`));
    });
    // rows
    const needF = Number.isFinite(inp.need) && inp.need > 0 && m.cnom > 0 ? inp.need / m.cnom : null;
    rl.forEach((vr, ri) => {
      const y0 = headH + 4 + ri * ch;
      const cur = rowIs(vr);
      if (cur) board.append(s('rect', { class: 'rowsel', x: 0, y: y0, width: W, height: ch }));
      board.append(s('text', { x: LW - 8, y: y0 + ch / 2 + 4, 'text-anchor': 'end', class: cur ? 'b' : 'soft' }, rowLabel(vr, narrow)));
    });
    cells.forEach((c) => {
      const ri = rl.indexOf(c.vr), ci = PKGS.indexOf(c.pkg);
      const x = LW + ci * cw + pad, y = headH + 4 + ri * ch + pad, w = cw - 2 * pad, hh = ch - 2 * pad;
      const isSel = c.pkg === inp.pkg && rowIs(c.vr);
      const rated = byRating() ? c.vr : inp.vrated;
      c.over = Number.isFinite(inp.vbias) && rated > 0 && Math.abs(inp.vbias) > rated;
      // with ratings as rows: the volume, not the rating, sets this chip's layers
      const capped = byRating() && c.r?.limitBy === 'volume' && c.r.dRateUm > c.r.dVolUm * 1.02;
      const f = c.r ? c.r.frac : 0;
      const t = tone(f);
      const key = `c-${c.pkg}-${c.vr}`;
      const g = s('g', { class: `cell${isSel ? ' sel' : ''}${c.over ? ' over' : ''}${c.nomade ? ' nomade' : ''}`, role: 'gridcell', tabindex: isSel ? '0' : '-1',
        'data-key': key, 'data-pkg': c.pkg, 'data-vr': c.vr,
        'aria-label': `${rowLabel(c.vr)} ${c.pkg}: ${c.r ? `${eng(c.r.ceff, 'F')}, ${pc(f)} of nominal` : 'no result'}${c.over ? ', bias above rating' : ''}${c.nomade ? ', not made' : ''}`,
        'aria-selected': String(isSel) });
      g.append(s('rect', { class: 'frame', x, y, width: w, height: hh, rx: 4 }));
      const tw = Math.max(3, w * 0.09);
      if (!c.nomade && !c.over && c.r) {
        const lh = (hh - 2) * clamp(f, 0, 1);
        g.append(s('rect', { class: `lvl ${t}`, x: x + tw, y: y + hh - 1 - lh, width: w - 2 * tw, height: lh }));
        g.append(s('line', { class: `top ${t}`, x1: x + tw, x2: x + w - tw, y1: y + hh - 1 - lh, y2: y + hh - 1 - lh }));
      }
      g.append(s('rect', { class: 'term', x: x + 1, y: y + 1, width: tw, height: hh - 2, rx: 3 }), s('rect', { class: 'term', x: x + w - tw - 1, y: y + 1, width: tw, height: hh - 2, rx: 3 }));
      const needC = Number.isFinite(inp.need) && inp.need > 0 ? inp.need / (byRating() ? inp.cnom : c.vr) : null;
      if (needC != null && needC <= 1 && !c.over && !c.nomade) {
        const yn = y + hh - 1 - (hh - 2) * clamp(needC, 0, 1);
        g.append(s('line', { class: 'needl', x1: x + tw, x2: x + w - tw, y1: yn, y2: yn }));
      }
      const mid = x + w / 2;
      if (c.over) {
        g.append(s('text', { x: mid, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: 'soft sm halo' }, narrow ? '>V' : 'bias > rated'));
      } else if (c.nomade) {
        g.append(s('text', { x: mid, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: 'soft sm' }, narrow ? '–' : 'not made'));
      } else if (c.r) {
        if (narrow) {
          g.append(s('text', { x: mid, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: `b halo ${t}` }, `${Math.round(f * 100)}`));
        } else {
          g.append(s('text', { x: mid, y: y + hh / 2 - 1, 'text-anchor': 'middle', class: 'b halo' }, eng(c.r.ceff, 'F')));
          g.append(s('text', { x: mid, y: y + hh / 2 + 12, 'text-anchor': 'middle', class: `sm halo ${t}` }, pc(f, 2)));
        }
      }
      if (needC != null && c.r && !c.over && !c.nomade && c.r.ceff >= inp.need) {
        const ok = c.r.worst >= inp.need;
        g.append(s('path', { d: `M${x + w - tw - 13},${y + 9}l3,3l6,-6`, fill: 'none', stroke: ok ? 'var(--tool-ok)' : 'var(--tool-warn)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      }
      if (capped && !c.over && !c.nomade && !narrow) g.append(s('text', { x: x + tw + 3, y: y + 11, class: 'soft sm' }, 'vol.'));
      g.append(s('title', {}, `${rowLabel(c.vr)} ${c.pkg} ${inp.diel}: ${c.r?.dUm ? `layers ${Number(c.r.dUm.toPrecision(3))} µm, set by the ${c.r.limitBy}; ` : ''}${c.r ? `${eng(c.r.ceff, 'F')} typical (${pc(f)}), worst ${eng(c.r.worst, 'F')}` : ''}${c.over ? ' - the bias is above this rating' : ''}${c.nomade ? ' - more than this package usually holds at this rating' : ''}`));
      board.append(g);
    });
    board.append(s('text', { x: LW, y: H - 5, class: 'soft sm sans' }, narrow ? '% of nominal kept' : `${byRating() ? `${eng(m.cnom, 'F')} ${inp.diel}` : `${inp.diel}, ${inp.vrated} V rated`}${byRating() ? ' · vol.: the package volume caps the layers, a higher rating gains nothing more' : ''}, at ${m.vbias} V and ${m.temp} °C${needF != null ? ` · dashed line: the ${eng(inp.need, 'F')} you need, tick: has it (amber: typical only)` : ''}`));
    restoreFocus();
  }
  board.addEventListener('click', (e) => {
    const c = e.target.closest('.cell'); if (!c) return;
    focusKey = c.dataset.key;
    ctx.setMany({ pkg: c.dataset.pkg, ...rowSet(Number(c.dataset.vr)) });
  });
  board.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.cell'); if (!c) return;
    const rl = ratingsList();
    let ci = PKGS.indexOf(c.dataset.pkg), ri = rl.indexOf(Number(c.dataset.vr));
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.setMany({ pkg: c.dataset.pkg, ...rowSet(Number(c.dataset.vr)) }); return; }
    if (!d) return;
    e.preventDefault();
    ci = clamp(ci + d[0], 0, PKGS.length - 1); ri = clamp(ri + d[1], 0, rl.length - 1);
    focusKey = `c-${PKGS[ci]}-${rl[ri]}`;
    ctx.setMany({ pkg: PKGS[ci], ...rowSet(rl[ri]) });
  });

  // ---------- cross-section ----------
  function drawXsec() {
    xsec.replaceChildren();
    if (!m) return;
    const W = Math.max(280, xsec.clientWidth || 400), H = 150;
    const lensGap = 124;
    xsec.setAttribute('viewBox', `0 0 ${W} ${H}`); xsec.setAttribute('height', H);
    const defs = s('defs');
    defs.innerHTML = '<marker id="cd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8Z" fill="var(--accent)"/></marker>';
    xsec.append(defs);
    const [L, , Hh] = m.body;
    const avail = W - 40 - lensGap - 20;
    const sc = Math.min(avail / L, 96 / Hh);
    const bw = L * sc, bh = Hh * sc, x0 = 16, y0 = 20 + (100 - bh) / 2;
    const tw = Math.max(6, bw * 0.13);
    xsec.append(s('rect', { class: 'x-body', x: x0, y: y0, width: bw, height: bh, rx: 2 }));
    // electrodes: alternate sides, drawn fewer than real
    const n = Math.max(4, Math.min(18, Math.round(bh / 5)));
    if (m.cls === 2 || true) {
      for (let i = 1; i < n; i++) {
        const yy = y0 + (bh * i) / n;
        const left = i % 2 === 1;
        xsec.append(s('line', { class: 'x-el', x1: left ? x0 + tw - 1 : x0 + tw + bw * 0.1, x2: left ? x0 + bw - tw - bw * 0.1 : x0 + bw - tw + 1, y1: yy, y2: yy }));
      }
    }
    xsec.append(s('path', { class: 'x-term', d: `M${x0 + tw},${y0 - 2}H${x0 - 2}V${y0 + bh + 2}H${x0 + tw}V${y0 + bh - 4}H${x0 + 3}V${y0 + 4}H${x0 + tw}Z` }));
    xsec.append(s('path', { class: 'x-term', d: `M${x0 + bw - tw},${y0 - 2}H${x0 + bw + 2}V${y0 + bh + 2}H${x0 + bw - tw}V${y0 + bh - 4}H${x0 + bw - 3}V${y0 + 4}H${x0 + bw - tw}Z` }));
    // dimensions
    const yd = y0 + bh + 12;
    xsec.append(s('path', { class: 'dim', d: `M${x0},${yd - 4}v8M${x0 + bw},${yd - 4}v8M${x0},${yd}H${x0 + bw}` }));
    xsec.append(s('text', { x: x0 + bw / 2, y: yd + 13, 'text-anchor': 'middle', class: 'soft sm' }, `${L} mm`));
    xsec.append(s('path', { class: 'dim', d: `M${x0 + bw + 8},${y0}h8M${x0 + bw + 8},${y0 + bh}h8M${x0 + bw + 12},${y0}V${y0 + bh}` }));
    xsec.append(s('text', { x: x0 + bw + 18, y: y0 + bh / 2 + 4, class: 'soft sm' }, `${Hh}`));
    // lens on one layer
    const lx = W - 62, ly = 66, lr = 48;
    const pyy = y0 + bh * (Math.floor(n / 2) / n);
    xsec.append(s('line', { class: 'dim', x1: x0 + bw * 0.55, y1: pyy, x2: lx - lr * 0.7, y2: ly - lr * 0.2, 'stroke-dasharray': '2 2' }));
    xsec.append(s('circle', { class: 'x-lens', cx: lx, cy: ly, r: lr }));
    const cl = s('clipPath', { id: 'cd-lens' }); cl.append(s('circle', { cx: lx, cy: ly, r: lr - 1 })); defs.append(cl);
    const gl = s('g', { 'clip-path': 'url(#cd-lens)' });
    gl.append(s('rect', { x: lx - lr, y: ly - lr, width: 2 * lr, height: 2 * lr, fill: 'var(--tool-body)', opacity: 0.55 }));
    gl.append(s('rect', { x: lx - lr, y: ly - 26, width: 2 * lr, height: 5, fill: 'var(--tool-elec)' }), s('rect', { x: lx - lr, y: ly + 21, width: 2 * lr, height: 5, fill: 'var(--tool-elec)' }));
    if (m.cls === 2 && m.field > 0) for (const dx of [-26, -9, 8, 25]) gl.append(s('line', { class: 'x-field', x1: lx + dx, y1: ly - 19, x2: lx + dx, y2: ly + 18 }));
    xsec.append(gl);
    xsec.append(s('text', { x: lx, y: ly + lr + 13, 'text-anchor': 'middle', class: 'b halo' }, m.cls === 2 ? `d ${Number(m.dUm.toPrecision(3))} µm` : 'class I'));
    xsecHead.replaceChildren(h('b', {}, `${m.pkg} cut open`), h('span', {}, m.cls === 2
      ? `layer set by the ${m.limitBy === 'rating' ? `${ctx.input.vrated} V rating` : 'package volume'} · field ${Number(m.field.toPrecision(3))} V/µm (model)` : 'C0G: no bias loss'));
    restoreFocus();
  }

  // ---------- bias curve ----------
  let bGeom = null, tGeom = null, frozenB = null;
  function drawBias() {
    biasSvg.replaceChildren();
    if (!m) return;
    const W = Math.max(280, biasSvg.clientWidth || 400), H = 190;
    biasSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); biasSvg.setAttribute('height', H);
    const L = 44, R = 14, T = 12, B = 26;
    const inp = ctx.input;
    const xmax = frozenB ?? (m.curve[m.curve.length - 1][0] || 1);
    const X = (v) => L + ((W - L - R) * v) / xmax, Y = (f) => T + (H - T - B) * (1 - f / 1.1);
    // grid
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      biasSvg.append(s('line', { class: f ? 'grid' : 'axis', x1: L, x2: W - R, y1: Y(f), y2: Y(f) }));
      biasSvg.append(s('text', { x: L - 5, y: Y(f) + 4, 'text-anchor': 'end', class: 'soft sm' }, `${f * 100}%`));
    }
    const step = xmax > 60 ? 20 : xmax > 30 ? 10 : xmax > 12 ? 5 : xmax > 5 ? 2 : 1;
    for (let v = 0; v <= xmax + 1e-9; v += step) {
      biasSvg.append(s('line', { class: 'grid', x1: X(v), x2: X(v), y1: T, y2: H - B }));
      biasSvg.append(s('text', { x: X(v), y: H - 10, 'text-anchor': 'middle', class: 'soft sm' }, `${Number(v.toPrecision(3))}`));
    }
    const vr = inp.vrated;
    if (vr > 0 && vr <= xmax) {
      biasSvg.append(s('rect', { class: 'over', x: X(vr), y: T, width: Math.max(0, W - R - X(vr)), height: H - T - B }));
      biasSvg.append(s('line', { class: 'rated', x1: X(vr), x2: X(vr), y1: T, y2: H - B }));
      biasSvg.append(s('text', { x: X(vr) - 4, y: T + 10, 'text-anchor': 'end', class: 'bad sm halo' }, `rated ${vr} V`));
      if (X(vr * 0.8) > L + 30) biasSvg.append(s('line', { class: 'derate', x1: X(vr * 0.8), x2: X(vr * 0.8), y1: T + 14, y2: H - B }));
    }
    // neighbours: one size up, one rating up (their own runs)
    const up = PKGS[PKGS.indexOf(inp.pkg) + 1];
    const down = PKGS[PKGS.indexOf(inp.pkg) - 1];
    const ghosts = [];
    if (up && m.cls === 2) ghosts.push([`${up}`, run({ ...inp, pkg: up })?.model]);
    if (down && m.cls === 2) ghosts.push([`${down}`, run({ ...inp, pkg: down })?.model]);
    const rUp = RATE_ROWS.find((r) => r > (vr || 0));
    if (rUp && m.cls === 2) { const gm = run({ ...inp, vrated: rUp })?.model; if (gm && Math.abs(gm.dUm - m.dUm) > 0.01) ghosts.push([`${rUp} V`, gm]); }
    for (const [name, gm] of ghosts) {
      if (!gm?.curve) continue;
      const pts = gm.curve.filter(([v]) => v <= xmax + 1e-9);
      biasSvg.append(s('path', { class: 'ghost', d: pts.map(([v, f], i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(f).toFixed(1)}`).join('') }));
      const [lv, lf] = pts[pts.length - 1];
      biasSvg.append(s('text', { x: X(lv) - 3, y: Y(lf) - 5, 'text-anchor': 'end', class: 'soft sm halo' }, name));
    }
    biasSvg.append(s('path', { class: 'curve', d: m.curve.filter(([v]) => v <= xmax + 1e-9).map(([v, f], i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(f).toFixed(1)}`).join('') }));
    // need line
    if (inp.need > 0 && m.cnom > 0) {
      const nf = inp.need / m.cnom;
      if (nf <= 1.1) {
        biasSvg.append(s('line', { class: 'needl', x1: L, x2: W - R, y1: Y(nf), y2: Y(nf) }));
        biasSvg.append(s('text', { x: L + 4, y: Y(nf) - 4, class: 'sm halo', style: 'fill:var(--tool-need)' }, `need ${eng(inp.need, 'F')}`));
      }
    }
    // worst-case mark and the operating point
    const vb = m.vbias, xb = X(Math.min(vb, xmax));
    biasSvg.append(s('line', { class: 'guide', x1: xb, x2: xb, y1: Y(m.frac), y2: H - B }));
    biasSvg.append(s('line', { class: 'guide', x1: L, x2: xb, y1: Y(m.frac), y2: Y(m.frac) }));
    biasSvg.append(s('path', { d: `M${xb - 5},${Y(m.worst / m.cnom)}h10`, stroke: 'var(--tool-bad)', 'stroke-width': 2 }));
    const lab = `${eng(m.ceff, 'F')} · ${pc(m.frac, 2)}`;
    const right = xb < W - R - 120;
    biasSvg.append(s('text', { x: right ? xb + 10 : xb - 10, y: Y(m.frac) - 9, 'text-anchor': right ? 'start' : 'end', class: 'b halo' }, lab));
    biasSvg.append(s('text', { x: right ? xb + 10 : xb - 10, y: Y(m.worst / m.cnom) + 13, 'text-anchor': right ? 'start' : 'end', class: 'sm halo bad' }, `worst ${eng(m.worst, 'F')}`));
    const g = s('g', { class: 'h', tabindex: '0', role: 'slider', 'data-key': 'h-bias', 'aria-label': 'DC bias', 'aria-valuenow': String(vb), 'aria-valuetext': `${vb} V` });
    g.append(s('circle', { class: 'hit', cx: xb, cy: Y(m.frac), r: 14 }), s('circle', { class: 'hc', cx: xb, cy: Y(m.frac), r: 6.5 }), s('title', {}, 'Drag along the curve: DC bias'));
    biasSvg.append(g);
    bGeom = { X, L, R, W, xmax };
    biasHead.replaceChildren(h('b', {}, 'DC bias, V'), h('span', {}, `drag the point · ${vb} V`), h('span', { class: 'r cd-legend' },
      h('span', {}, h('i', { style: 'background:var(--accent);height:3px' }), inp.pkg), ghosts.length ? h('span', {}, h('i', { style: 'background:transparent;border-top:1.5px dashed var(--ink-soft);height:0' }), 'package up / down, next rating') : null));
    restoreFocus();
  }

  // ---------- temperature ----------
  function drawTemp() {
    tempSvg.replaceChildren();
    if (!m) return;
    const W = Math.max(280, tempSvg.clientWidth || 400), H = 150;
    tempSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); tempSvg.setAttribute('height', H);
    const L = 44, R = 14, T = 12, B = 26;
    const t0 = -60, t1 = 155;
    const [blo, bhi, tlo, thi] = m.band;
    const fmin = Math.min(0.2, 1 + blo - 0.05, ...m.tcurve.map((p) => p[1] - 0.05)), fmax = 1.1;
    const X = (t) => L + ((W - L - R) * (t - t0)) / (t1 - t0), Y = (f) => T + (H - T - B) * (1 - (f - fmin) / (fmax - fmin));
    tempSvg.append(s('rect', { class: 'outside', x: X(t0), y: T, width: X(tlo) - X(t0), height: H - T - B }));
    tempSvg.append(s('rect', { class: 'outside', x: X(thi), y: T, width: X(t1) - X(thi), height: H - T - B }));
    tempSvg.append(s('rect', { class: 'band', x: X(tlo), y: Y(1 + bhi), width: X(thi) - X(tlo), height: Y(1 + blo) - Y(1 + bhi) }));
    tempSvg.append(s('line', { class: 'bandl', x1: X(tlo), x2: X(thi), y1: Y(1 + blo), y2: Y(1 + blo) }));
    for (const f of [0.25, 0.5, 0.75, 1].filter((v) => v >= fmin)) {
      tempSvg.append(s('line', { class: 'grid', x1: L, x2: W - R, y1: Y(f), y2: Y(f) }));
      tempSvg.append(s('text', { x: L - 5, y: Y(f) + 4, 'text-anchor': 'end', class: 'soft sm' }, `${f * 100}%`));
    }
    for (const t of [-55, 0, 25, 85, 125, 150]) {
      tempSvg.append(s('line', { class: 'grid', x1: X(t), x2: X(t), y1: T, y2: H - B }));
      tempSvg.append(s('text', { x: X(t), y: H - 10, 'text-anchor': 'middle', class: 'soft sm' }, `${t}`));
    }
    tempSvg.append(s('text', { x: X(tlo) + 4, y: Y(1 + blo) + 12, class: 'ok sm halo' }, `${m.diel} ${pc(blo, 2)} band, ${tlo} to ${thi} °C`));
    tempSvg.append(s('path', { class: 'curve', d: m.tcurve.map(([t, f], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(f).toFixed(1)}`).join('') }));
    const tt = clamp(m.temp, t0, t1), xt = X(tt), yt = Y(m.fTemp);
    tempSvg.append(s('line', { class: 'guide', x1: xt, x2: xt, y1: yt, y2: H - B }));
    const right = xt < W - R - 110;
    tempSvg.append(s('text', { x: right ? xt + 10 : xt - 10, y: yt - 9, 'text-anchor': right ? 'start' : 'end', class: `b halo${m.temp < tlo || m.temp > thi ? ' bad' : ''}` },
      `${m.temp} °C · ${pc(m.fTemp, 3)}`));
    const g = s('g', { class: 'h', tabindex: '0', role: 'slider', 'data-key': 'h-temp', 'aria-label': 'Temperature', 'aria-valuenow': String(m.temp), 'aria-valuetext': `${m.temp} °C` });
    g.append(s('circle', { class: 'hit', cx: xt, cy: yt, r: 14 }), s('circle', { class: 'hc', cx: xt, cy: yt, r: 6.5 }), s('title', {}, 'Drag along the curve: temperature'));
    tempSvg.append(g);
    tGeom = { X, t0, t1, L, R, W };
    tempHead.replaceChildren(h('b', {}, 'Temperature, °C'), h('span', {}, m.cls === 2 ? `typical ${m.diel} curve; shaded: the code's guaranteed band` : '±30 ppm/°C'));
    restoreFocus();
  }

  // dragging on the two curves
  const pt = (svg, e) => { const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; return ((e.clientX - r.left) * vb.width) / r.width; };
  function onBias(e) {
    if (!bGeom) return;
    const x = pt(biasSvg, e);
    const v = clamp(((x - bGeom.L) / (bGeom.W - bGeom.L - bGeom.R)) * bGeom.xmax, 0, bGeom.xmax);
    const nv = bGeom.xmax > 20 ? Math.round(v * 2) / 2 : Math.round(v * 10) / 10;
    if (String(nv) !== String(ctx.raw.vbias)) ctx.set('vbias', String(nv));
  }
  function onTemp(e) {
    if (!tGeom) return;
    const x = pt(tempSvg, e);
    const t = Math.round(clamp(tGeom.t0 + ((x - tGeom.L) / (tGeom.W - tGeom.L - tGeom.R)) * (tGeom.t1 - tGeom.t0), -55, 150));
    if (String(t) !== String(ctx.raw.temp)) ctx.set('temp', String(t));
  }
  for (const [svg, fn, key] of [[biasSvg, onBias, 'h-bias'], [tempSvg, onTemp, 'h-temp']]) {
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      focusKey = key; svg.querySelector('.h')?.focus({ preventScroll: true });
      drag = fn; if (svg === biasSvg) frozenB = bGeom?.xmax ?? null;
      svg.setPointerCapture(e.pointerId); svg.classList.add('dragging');
      fn(e);
    });
    svg.addEventListener('pointermove', (e) => { if (drag === fn) fn(e); });
    const end = () => { if (drag === fn) { drag = null; svg.classList.remove('dragging'); if (svg === biasSvg && frozenB != null) { frozenB = null; drawBias(); } } };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  }
  biasSvg.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d || !m) return;
    e.preventDefault(); focusKey = 'h-bias';
    const stp = e.shiftKey ? 1 : 0.1;
    ctx.set('vbias', String(Math.max(0, Math.round((m.vbias + d * stp) * 10) / 10)));
  });
  tempSvg.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d || !m) return;
    e.preventDefault(); focusKey = 'h-temp';
    ctx.set('temp', String(clamp(Math.round(m.temp + d * (e.shiftKey ? 10 : 1)), -55, 150)));
  });

  // ---------- waterfall ----------
  function drawFall() {
    fall.replaceChildren();
    if (!m) return;
    const rows = [
      ['DC bias', m.fBias, m.cls === 2 ? `${Number(m.field.toPrecision(3))} V/µm` : 'none'],
      ['Temperature', m.fTemp, `${m.temp} °C`],
      ['Aging', m.fAge, ctx.input.years > 0 ? `${ctx.input.years} yr` : 'off'],
    ];
    let keep = 1;
    const tn = tone(m.frac);
    fall.append(h('div', { class: 'r' }, h('span', {}, 'Nominal'), h('div', { class: 't' }, h('i', { class: 'keep', style: 'left:0;width:100%' })), h('b', {}, eng(m.cnom, 'F'))));
    for (const [name, f, hint] of rows) {
      const next = keep * f;
      fall.append(h('div', { class: 'r', title: hint }, h('span', {}, `${name} `, h('small', {}, hint)),
        h('div', { class: 't' }, h('i', { class: 'keep', style: `left:0;width:${(next * 100).toFixed(2)}%` }),
          h('i', { class: 'lost', style: `left:${(Math.min(next, keep) * 100).toFixed(2)}%;width:${(Math.abs(keep - next) * 100).toFixed(2)}%` })),
        h('b', {}, `× ${pc(f, 3)}`)));
      keep = next;
    }
    fall.append(h('div', { class: 'r sum' }, h('span', {}, 'Typical'), h('div', { class: 't' }, h('i', { class: `res ${tn}`, style: `left:0;width:${(m.frac * 100).toFixed(2)}%` })), h('b', {}, eng(m.ceff, 'F'))));
    fall.append(h('div', { class: 'r' }, h('span', {}, 'Worst case'), h('div', { class: 't' }, h('i', { class: 'res bad', style: `left:0;width:${(m.worst / m.cnom * 100).toFixed(2)}%;opacity:.6` })), h('b', {}, eng(m.worst, 'F'))));
    fall.append(h('div', { class: 'cd-foot', style: 'padding:2px 0 0' }, `Worst case: −${pc(m.tolF, 2)} tolerance and the ${m.diel} code's ${pc(m.band[0], 2)} band in place of the typical temperature curve.`));
  }

  function drawVerdict() {
    verdict.replaceChildren();
    if (!m) {
      verdict.append(h('div', { class: 'sub' }, 'No result: fix the label.'));
      return;
    }
    const t = tone(m.frac);
    verdict.append(h('div', { class: 'sub' }, 'Typically left'),
      h('div', { class: `big ${t}` }, eng(m.ceff, 'F'), ' ', h('small', {}, `${pc(m.frac, 2)} of ${eng(m.cnom, 'F')}`)),
      h('div', { class: 'sub' }, `worst case ${eng(m.worst, 'F')}`));
    const nv = (res.values || []).find((v) => v.label === 'Against what you need');
    if (nv) verdict.append(h('div', { class: `sub ${nv.tone}` }, `${nv.value} of what you need · ${nv.tone === 'ok' ? 'meets it, worst case too' : nv.tone === 'warn' ? 'typical only' : 'short'}`));
  }

  function drawAll() {
    syncLabel(); drawVerdict();
    warnBox.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    if (!m) { board.replaceChildren(); xsec.replaceChildren(); biasSvg.replaceChildren(); tempSvg.replaceChildren(); fall.replaceChildren(); return; }
    computeBoard();
    const rowSeg = h('span', { class: 'cd-seg', role: 'group', 'aria-label': 'Board rows' }, [['values', 'Values'], ['ratings', 'Ratings']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(rowMode === v), onclick: () => {
        rowMode = v; try { localStorage.setItem('redline.tool.cap-derating.rows', v); } catch { /* private window */ }
        computeBoard(); drawAll();
      } }, t)));
    boardHead.replaceChildren(rowSeg, h('b', {}, byRating() ? `${eng(m.cnom, 'F')} ${ctx.input.diel} at each rating, in every package` : `${ctx.input.diel} chips around ${eng(m.cnom, 'F')}, in every package`), h('span', {}, 'what each keeps here · click one to use it'),
      h('span', { class: 'r cd-legend' }, h('span', {}, h('i', { style: 'background:var(--tool-ok);opacity:.6' }), '≥ 50 %'), h('span', {}, h('i', { style: 'background:var(--tool-warn);opacity:.6' }), '30–50 %'),
        h('span', {}, h('i', { style: 'background:var(--tool-bad);opacity:.6' }), '< 30 %'), h('span', {}, h('i', { style: 'background:url(#x);border:1px dashed var(--ink-soft)' }), 'not made')));
    drawBoard(); drawXsec(); drawBias(); drawTemp(); drawFall();
    notes.replaceChildren(h('summary', {}, `Model and sources (${(res.notes || []).length + (ctx.manifest.sources || []).length})`),
      h('ul', {}, [...(res.notes || []), ...(ctx.manifest.sources || []).map((x) => `Source: ${x}`)].map((n) => h('li', {}, n))));
  }

  ctx.onResult((r) => { res = r; m = r?.model || null; drawAll(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth; if (w === lastW) return; lastW = w;
    if (m) { drawBoard(); drawXsec(); drawBias(); drawTemp(); }
  }).observe(root);
}
