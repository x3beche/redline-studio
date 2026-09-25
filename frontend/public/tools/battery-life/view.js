// Battery Life: the page is the cell and the time it lasts.
//   Shelf    - the cells this tool knows, drawn to scale; click the one you hold.
//   Cell     - the chosen cell, big, as a gauge of where its charge goes: the
//              reserve the cut-off leaves (hatched, drag its top to set the
//              usable fraction), what self-discharge takes, what is left when
//              the shelf life ends, and what the load gets. Cells in parallel
//              stand side by side (- / +).
//   Life     - run time against average current, log-log, on a calendar
//              scale (hour, day, week, month, year, 10 years). The operating
//              point rides the curve: drag it for another current. The shelf
//              life is the hatched ceiling, the current where self-discharge
//              equals the load a dashed line; under the axis the cell's
//              continuous and pulse ratings, with the peak current as a
//              second handle.
//   Calendar - the run time as a bar against the shelf life, in years or days.
// Every number drawn comes from run()'s result.battery; the page only draws it.
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
const eng = (v, d = 3) => fmtEng(v, '', d).replace(/\s+/g, '').replace('µ', 'u');
const lg = Math.log10;

// How each cell looks: coin (diameter, thickness), cylinder (diameter, length)
// or pouch (width, height), in mm. Drawing only.
const SHAPE = {
  cr2032: ['coin', 20, 3.2], cr2450: ['coin', 24.5, 5],
  'aa-alk': ['cyl', 14.5, 50.5], 'aaa-alk': ['cyl', 10.5, 44.5], 'aa-li': ['cyl', 14.5, 50.5],
  'aa-lisocl2': ['cyl', 14.5, 50.5], 'aa-nimh': ['cyl', 14.5, 50.5], 'aa-lsd': ['cyl', 14.5, 50.5],
  liion: ['pouch', 34, 50], lifepo4: ['cyl', 18, 65], custom: ['custom', 30, 50],
};
const SHORT = { cr2032: 'CR2032', cr2450: 'CR2450', 'aa-alk': 'AA alkaline', 'aaa-alk': 'AAA alkaline', 'aa-li': 'AA lithium',
  'aa-lisocl2': 'ER14505', 'aa-nimh': 'AA NiMH', 'aa-lsd': 'AA NiMH LSD', liion: 'Li-ion / LiPo', lifepo4: 'LiFePO4', custom: 'Custom' };
const START_CAP = { liion: '2000', lifepo4: '1500', custom: '1000' };
const HOUR = 1, DAY = 24, WEEK = 168, MONTH = 730.5, YEAR = 8766;
const CAL = [[HOUR, '1 hour'], [DAY, '1 day'], [WEEK, '1 week'], [MONTH, '1 month'], [YEAR, '1 year'], [10 * YEAR, '10 years'], [100 * YEAR, '100 years']];

const CSS = `
.bl { --tool-load: var(--accent); --tool-sd: #b45309; --tool-left: #0f8a78; --tool-can: #3b4855; --tool-can-ink: #e9eef3; --tool-coin: #9aa6b2;
  display: grid; grid-template-columns: minmax(300px, 360px) minmax(0, 1fr); grid-template-rows: auto auto 1fr; gap: 12px; align-items: start;
  grid-template-areas: "shelf shelf" "cell life" "out life"; }
.bl-shelf { grid-area: shelf; } .bl-cell { grid-area: cell; } .bl-life { grid-area: life; } .bl-out { grid-area: out; min-width: 0; }
:root[data-theme="dark"] .bl { --tool-sd: #f0a33a; --tool-left: #3cc7b3; --tool-can: #33414e; --tool-coin: #6b7885; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .bl { --tool-sd: #f0a33a; --tool-left: #3cc7b3; --tool-can: #33414e; --tool-coin: #6b7885; } }
@media (max-width: 900px) { .bl { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "shelf" "cell" "life" "out"; } }
.bl-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.bl-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.bl-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); }
.bl-head h2 { font-size: 12.5px; font-weight: 600; margin: 0; }
.bl-sub { color: var(--ink-soft); font-size: 11.5px; }
.bl-grow { flex: 1; }
.bl-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.bl-f input { width: 62px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }
.bl-f input.bad { border-color: var(--danger); }
.bl-fields { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 6px 10px 8px; border-top: 1px solid var(--line-soft); }
.bl-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 6px; padding: 8px 10px; }
.bl-tile { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 5px 4px 6px; border: 1px solid var(--line-soft);
  border-radius: 5px; background: var(--surface); cursor: pointer; color: var(--ink); font: inherit; min-width: 0; }
.bl-tile:hover { border-color: var(--ink-soft); }
.bl-tile[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--sunken); }
.bl-tile svg { display: block; }
.bl-tile b { font-size: 11.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.bl-tile span { font: 10px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); white-space: nowrap; }
@media (max-width: 560px) { .bl-tiles { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: 92px; overflow-x: auto; overscroll-behavior-x: contain; } .bl-tile svg { height: 52px; } }
.bl-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.bl-draw svg { display: block; width: 100%; overflow: visible; }
.bl-foot { padding: 4px 10px 7px; color: var(--ink-soft); font-size: 11px; display: flex; gap: 4px 14px; flex-wrap: wrap; }
.bl-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.bl-warns:empty { display: none; }
.bl-out .k-out { max-height: 230px; }
.bl-more summary { cursor: pointer; color: var(--ink-soft); font-size: 11.5px; padding: 2px; }
.bl-notes { color: var(--ink-soft); font-size: 11.5px; padding: 4px 2px 0; }
.bl-notes div + div { margin-top: 3px; }
.bl-big { font: 600 20px "IBM Plex Mono", ui-monospace, monospace; }
/* drawing */
.bl svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.bl svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 10.5px; }
.bl svg .sm { font-size: 9.5px; } .bl svg .soft { fill: var(--ink-soft); } .bl svg .b { font-weight: 600; }
.bl svg .can { fill: var(--tool-can); stroke: var(--line); }
.bl svg .can-t { fill: var(--tool-can-ink); }
.bl svg .coin { fill: var(--tool-coin); stroke: var(--line); }
.bl svg .pouch { fill: var(--tool-coin); stroke: var(--line); }
.bl svg .term { fill: var(--tool-coin); stroke: var(--line); }
.bl svg .ghost { fill: none; stroke: var(--ink-soft); stroke-dasharray: 4 3; }
.bl svg .well { fill: var(--sunken); }
.bl svg .f-load { fill: var(--tool-load); } .bl svg .f-sd { fill: var(--tool-sd); } .bl svg .f-left { fill: var(--tool-left); fill-opacity: .55; }
.bl svg .f-res { fill: url(#bl-hatch); }
.bl svg .hatch-l { stroke: var(--ink-soft); stroke-opacity: .6; stroke-width: 1; }
.bl svg .hatch-d { stroke: var(--danger); stroke-opacity: .5; stroke-width: 1; }
.bl svg .body-o { fill: none; stroke: var(--ink); stroke-width: 1.5; }
.bl svg .lead { stroke: var(--ink-soft); stroke-width: 1; fill: none; }
.bl svg .sw-load { fill: var(--tool-load); } .bl svg .sw-sd { fill: var(--tool-sd); } .bl svg .sw-left { fill: var(--tool-left); }
.bl svg .plot { fill: var(--sunken); }
.bl svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.bl svg .grid-cal { stroke: var(--line); stroke-width: 1; }
.bl svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.bl svg .curve { stroke: var(--tool-load); stroke-width: 2.5; fill: none; }
.bl svg .curve-raw { stroke: var(--ink-soft); stroke-width: 1.25; stroke-dasharray: 4 4; fill: none; }
.bl svg .ceil { fill: url(#bl-hatch-d); }
.bl svg .ceil-l { stroke: var(--danger); stroke-width: 1.5; }
.bl svg .sdz { fill: var(--tool-sd); fill-opacity: calc(var(--fill-alpha) * .5); }
.bl svg .sdl { stroke: var(--tool-sd); stroke-width: 1.25; stroke-dasharray: 5 4; }
.bl svg .sd-t { fill: var(--tool-sd); }
.bl svg .danger { fill: var(--danger); } .bl svg .warn-t { fill: var(--warn); } .bl svg .ok-t { fill: var(--ok); }
.bl svg .drop { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 3 3; }
.bl svg .over { fill: url(#bl-hatch-d); }
.bl svg .limit { stroke: var(--danger); stroke-width: 1.5; }
.bl svg .rated { stroke: var(--ok); stroke-width: 1.5; }
.bl svg .band { fill: var(--surface); stroke: var(--line); }
.bl svg g.h { cursor: ew-resize; outline: none; }
.bl svg g.h.v { cursor: ns-resize; }
.bl svg g.h .knob { fill: var(--accent); stroke: var(--surface); stroke-width: 2.5; }
.bl svg g.h.bad .knob { fill: var(--danger); }
.bl svg g.h.pk .knob { fill: var(--tool-sd); }
.bl svg g.h .ring { fill: none; stroke: transparent; stroke-width: 2; }
.bl svg g.h:focus-visible .ring, .bl svg g.h:hover .ring { stroke: var(--accent); }
.bl svg .tag { fill: var(--accent); } .bl svg .tag.bad { fill: var(--danger); }
.bl svg .tag-t { fill: var(--accent-ink); font-weight: 600; }
.bl svg .resline { stroke: var(--ink); stroke-width: 2; }
.bl svg g.btn { cursor: pointer; outline: none; }
.bl svg g.btn rect { fill: var(--surface); stroke: var(--line); }
.bl svg g.btn:hover rect, .bl svg g.btn:focus-visible rect { stroke: var(--accent); }
.bl svg g.btn text { font-weight: 600; font-size: 13px; }
.bl svg .bar-run { fill: var(--tool-load); }
.bl svg .bar-shelf { fill: url(#bl-hatch-d); }
`;

function cellShape(kind, x, y, w, ht, cls, extra = {}) {
  // Body outline for a cell whose body occupies (x, y, w, ht).
  if (kind === 'coin') return sv('ellipse', { cx: x + w / 2, cy: y + ht / 2, rx: w / 2, ry: ht / 2, class: cls, ...extra });
  const r = kind === 'pouch' ? 5 : Math.min(w / 5, 8);
  return sv('rect', { x, y, width: w, height: ht, rx: r, class: cls, ...extra });
}

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { drag: null };

  // ---------- panels ----------
  const fields = [];
  const numField = (label, unit, key, aria, width) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria,
      style: width ? `width:${width}px` : null, oninput: (e) => ctx.set(key, e.target.value) });
    const f = { el: h('label', { class: 'bl-f' }, label, inp, unit), inp, key };
    fields.push(f); return f;
  };
  const tiles = h('div', { class: 'bl-tiles', role: 'group', 'aria-label': 'Battery' });
  const shelf = h('section', { class: 'bl-panel bl-shelf', 'aria-label': 'Choose the battery' },
    h('div', { class: 'bl-head' }, h('h2', {}, 'Battery'), h('span', { class: 'bl-sub' }, 'drawn to scale; click the one you use')), tiles);

  const capF = numField('capacity', 'mAh', 'cap', 'Capacity per cell in mAh, 0 = typical', 58);
  const usableF = numField('usable', '%', 'usable', 'Usable fraction in percent', 40);
  const sdF = numField('self-discharge', '%/mo', 'sd', 'Self-discharge in percent per month', 44);
  const shelfF = numField('shelf', 'years', 'shelf', 'Shelf life in years', 40);
  const cellDraw = h('div', { class: 'bl-draw' });
  const cellName = h('span', { class: 'bl-sub' });
  const customBox = h('span', { style: 'display:contents' });
  const cellPanel = h('section', { class: 'bl-panel', 'aria-label': 'The cell' },
    h('div', { class: 'bl-head' }, h('h2', {}, 'Where the charge goes'), cellName),
    cellDraw,
    h('div', { class: 'bl-fields' }, capF.el, usableF.el, customBox),
    h('div', { class: 'bl-foot' }, h('span', {}, 'Drag the top of the hatched reserve to set the usable fraction.')));

  const iavgF = numField('average', 'A', 'iavg', 'Average current in amperes', 62);
  const ipeakF = numField('peak', 'A', 'ipeak', 'Peak current in amperes, 0 = no check', 56);
  const runBig = h('span', { class: 'bl-big' });
  const runSub = h('span', { class: 'bl-sub' });
  const lifeDraw = h('div', { class: 'bl-draw' });
  const calDraw = h('div', { class: 'bl-draw' });
  const lifePanel = h('section', { class: 'bl-panel', 'aria-label': 'Run time against current' },
    h('div', { class: 'bl-head' }, h('h2', {}, 'Run time'), runBig, runSub, h('span', { class: 'bl-grow' }), iavgF.el, ipeakF.el),
    lifeDraw, calDraw,
    h('div', { class: 'bl-foot' },
      h('span', {}, 'Drag the point along the curve for another average current, the orange marker for the peak.'),
      h('span', {}, h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' ×1.2, ', h('kbd', {}, 'PgUp'), ' ', h('kbd', {}, 'PgDn'), ' ×10')));

  const warns = h('div', { class: 'k-warns bl-warns', 'aria-live': 'polite' });
  const notesBody = h('div', { class: 'bl-notes' });
  const notes = h('details', { class: 'bl-more' }, h('summary', {}, 'Notes and the table of other currents'), notesBody);
  cellPanel.classList.add('bl-cell');
  ctx.outputs.classList.add('bl-out');
  root.append(h('div', { class: 'bl' }, shelf, cellPanel,
    h('div', { class: 'bl-col bl-life' }, lifePanel, warns, notes), ctx.outputs));

  const B = () => ctx.result?.battery;
  const keepFocus = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  const pickChem = (id) => {
    const cap = ctx.parseEng(ctx.raw.cap);
    if (START_CAP[id] && !(cap > 0)) ctx.setMany({ chem: id, cap: START_CAP[id] });
    else ctx.set('chem', id);
  };

  // ---------- the shelf of cells ----------
  function drawShelf(b) {
    const cur = ctx.raw.chem || 'cr2032';
    const opts = (ctx.manifest.inputs.find((d) => d.key === 'chem')?.options || []);
    const info = new Map((b?.chems || []).map((c) => [c.id, c]));
    const PX = 1.08; // px per mm
    tiles.replaceChildren(...opts.map(([id, label]) => {
      const [kind, a, c] = SHAPE[id] || SHAPE.custom;
      const svg = sv('svg', { viewBox: '0 0 80 76', width: 80, height: 64, 'aria-hidden': 'true' });
      if (kind === 'coin') {
        const d = a * PX * 1.6, t = Math.max(3, c * PX * 1.6);
        svg.append(sv('rect', { x: 40 - d / 2, y: 66 - t, width: d, height: t, rx: 2, class: 'coin' }));
        svg.append(sv('ellipse', { cx: 40, cy: 66 - t, rx: d / 2, ry: d / 6, class: 'coin' }));
      } else if (kind === 'cyl') {
        const w = a * PX, len = c * PX;
        svg.append(sv('rect', { x: 40 - w / 2, y: 74 - len, width: w, height: len, rx: 2, class: 'can' }));
        svg.append(sv('rect', { x: 40 - w / 5, y: 74 - len - 3, width: w / 2.5, height: 3.5, rx: 1, class: 'term' }));
      } else if (kind === 'pouch') {
        const w = a * PX, ht = c * PX;
        svg.append(sv('rect', { x: 40 - w / 2, y: 74 - ht, width: w, height: ht, rx: 3, class: 'pouch' }));
        svg.append(sv('rect', { x: 40 - w / 4 - 2, y: 74 - ht - 4, width: 4, height: 5, class: 'term' }));
        svg.append(sv('rect', { x: 40 + w / 4 - 2, y: 74 - ht - 4, width: 4, height: 5, class: 'term' }));
      } else {
        svg.append(sv('rect', { x: 24, y: 22, width: 32, height: 52, rx: 4, class: 'ghost' }));
        svg.append(txt(40, 52, '?', 'soft b', 'middle'));
      }
      const x = info.get(id);
      const short = SHORT[id] || label.split(',')[0];
      const meta = id === 'custom' ? 'your figures' : x ? `${x.v} V · ${x.cap ? `${x.cap} mAh` : 'any mAh'}` : '';
      return h('button', { type: 'button', class: 'bl-tile', 'aria-pressed': String(id === cur), title: label, onclick: () => pickChem(id) },
        svg, h('b', {}, short), h('span', {}, meta));
    }));
  }

  // ---------- the cell as a gauge ----------
  let cellGeom = null;
  function drawCell(b) {
    const W = Math.max(280, cellDraw.clientWidth || 340);
    const H = 318;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `${b.name}, ${fmtNum(b.capTot)} mAh` });
    const defs = sv('defs');
    const p1 = sv('pattern', { id: 'bl-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    p1.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-l' }));
    defs.append(p1); svg.append(defs);
    const [kind, a, c] = SHAPE[b.chem] || SHAPE.custom;
    // Body box: the gauge is drawn inside it.
    const top = 52, maxH = 226, labW = 142;
    const avail = W - labW - 24;
    const n = b.n, shown = Math.min(n, 4);
    let bw, bh;
    if (kind === 'coin') { bw = Math.min(maxH, avail / (shown * 0.82 + 0.18)); bh = bw; } else {
      const ratio = kind === 'custom' ? 0.55 : a / c;
      bh = maxH; bw = bh * ratio;
      const fit = (avail - (shown - 1) * 10) / shown;
      if (bw > fit) { bw = fit; }
    }
    const gap = kind === 'coin' ? -bw * 0.18 : 10;
    const x0 = 14 + (avail - (shown * bw + (shown - 1) * gap)) / 2;
    const y0 = top + (maxH - bh);
    const bud = b.budget, tot = b.capTot;
    const segs = [
      ['f-res', bud.reserve], ['f-left', bud.left], ['f-sd', bud.selfDischarge], ['f-load', bud.load],
    ];
    const Yf = (frac) => y0 + bh * (1 - frac); // fraction of the cell from the bottom
    for (let k = 0; k < shown; k++) {
      const x = x0 + k * (bw + gap);
      const id = `bl-cell${k}`;
      const cp = sv('clipPath', { id }); cp.append(cellShape(kind, x, y0, bw, bh, '')); defs.append(cp);
      // terminal
      if (kind === 'cyl' || kind === 'custom') svg.append(sv('rect', { x: x + bw * 0.32, y: y0 - 8, width: bw * 0.36, height: 9, rx: 2, class: 'term' }));
      if (kind === 'pouch') {
        svg.append(sv('rect', { x: x + bw * 0.22, y: y0 - 12, width: 10, height: 13, class: 'term' }));
        svg.append(sv('rect', { x: x + bw * 0.78 - 10, y: y0 - 12, width: 10, height: 13, class: 'term' }));
      }
      const g = sv('g', { 'clip-path': `url(#${id})` });
      g.append(sv('rect', { x, y: y0, width: bw, height: bh, class: 'well' }));
      let acc = 0;
      for (const [cls, mah] of segs) {
        const f0 = acc / tot, f1 = (acc + mah) / tot; acc += mah;
        if (mah <= 0) continue;
        g.append(sv('rect', { x, y: Yf(f1), width: bw, height: Math.max(0.5, Yf(f0) - Yf(f1)), class: cls }));
      }
      svg.append(g);
      svg.append(cellShape(kind, x, y0, bw, bh, 'body-o'));
      if (kind === 'coin' && k === shown - 1) svg.append(txt(x + bw / 2, y0 + bh / 2 + 4, '+', 'soft b', 'middle'));
    }
    if (n > shown) svg.append(txt(x0 + shown * (bw + gap), y0 + 12, `×${n}`, 'm b'));
    const xr = x0 + shown * bw + (shown - 1) * gap; // right edge of the cells
    // The reserve line, draggable.
    const yRes = Yf(bud.reserve / tot);
    const hr = sv('g', { class: 'h v', tabindex: 0, role: 'slider', 'data-fk': 'usable', 'aria-label': 'Usable fraction',
      'aria-valuenow': b.usable, 'aria-valuemin': 1, 'aria-valuemax': 100 });
    hr.append(sv('line', { x1: x0 - 8, x2: xr + 8, y1: yRes, y2: yRes, stroke: 'transparent', 'stroke-width': 14 }));
    hr.append(sv('line', { x1: x0 - 8, x2: xr + 8, y1: yRes, y2: yRes, class: 'resline' }));
    hr.append(sv('circle', { cx: x0 - 8, cy: yRes, r: 6, class: 'knob' }));
    hr.append(sv('circle', { cx: x0 - 8, cy: yRes, r: 9.5, class: 'ring' }));
    hr.append(sv('title', {}, 'Drag: usable fraction. Arrows ±1 %, PgUp/PgDn ±10 %'));
    hr.addEventListener('keydown', (e) => {
      const d = { ArrowUp: -1, ArrowRight: -1, ArrowDown: 1, ArrowLeft: 1, PageUp: -10, PageDown: 10 }[e.key];
      if (!d) return; e.preventDefault();
      ctx.set('usable', String(clamp(Math.round(b.usable - d), 1, 100)));
    });
    hr.addEventListener('pointerdown', (e) => startDrag(e, 'usable', cellDraw));
    svg.append(hr);
    cellGeom = { y0, bh, W };

    // Labels at the right: each share with a leader to its middle.
    const lx = W - labW + 4;
    const items = [
      ['sw-load', 'load', bud.load],
      ['sw-sd', 'self-discharge', bud.selfDischarge],
      ['sw-left', 'left at shelf end', bud.left],
      [null, `reserve ${fmtNum(100 - b.usable, 3)} %`, bud.reserve],
    ].map(([cls, name, mah], i) => {
      const before = [bud.reserve, bud.left, bud.selfDischarge, bud.load].slice(0, 3 - i).reduce((s, v) => s + v, 0);
      return { cls, name, mah, ym: Yf((before + mah / 2) / tot) };
    }).filter((it) => it.mah > tot * 1e-4 || it.name === 'load');
    // Spread the labels so they do not overlap (34 px apart), top to bottom.
    let yPrev = top - 4;
    for (const it of items) { it.y = Math.max(it.ym, yPrev + 34); yPrev = it.y; }
    const over = yPrev - (y0 + bh);
    if (over > 0) for (const it of items) it.y -= over;
    for (const it of items) {
      svg.append(sv('path', { d: `M${xr + 2},${it.ym} L${xr + 12},${it.ym} L${lx - 6},${it.y - 4}`, class: 'lead' }));
      if (it.cls) svg.append(sv('rect', { x: lx, y: it.y - 12, width: 9, height: 9, rx: 1, class: it.cls }));
      else svg.append(sv('rect', { x: lx, y: it.y - 12, width: 9, height: 9, fill: 'url(#bl-hatch)', stroke: 'var(--ink-soft)' }));
      svg.append(txt(lx + 14, it.y - 4, it.name, 'sm'));
      svg.append(txt(lx + 14, it.y + 9, `${fmtNum(it.mah, 3)} mAh · ${fmtNum((it.mah / tot) * 100, 2)} %`, 'm'));
    }
    // Capacity above the cells, energy under them.
    svg.append(txt(14, 16, `${fmtNum(b.capCell, 4)} mAh${n > 1 ? ` × ${n} in parallel` : ''}${b.typical && b.capCell === b.typical ? ' (typical)' : ''}`, 'm b'));
    svg.append(txt(14, 29, `usable ${fmtNum(b.cu, 4)} mAh${b.energyWh != null ? ` · ${fmtNum(b.energyWh, 3)} Wh at ${b.v} V` : ''}`, 'm soft'));
    // - / + cells in parallel
    const btn = (x, label, d, fk, aria) => {
      const gb = sv('g', { class: 'btn', tabindex: 0, role: 'button', 'data-fk': fk, 'aria-label': aria });
      gb.append(sv('rect', { x, y: H - 30, width: 24, height: 22, rx: 3 }));
      gb.append(txt(x + 12, H - 14, label, '', 'middle'));
      const go = () => ctx.set('np', String(clamp(n + d, 1, 99)));
      gb.addEventListener('click', go);
      gb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      svg.append(gb);
    };
    const cxm = x0 + (xr - x0) / 2;
    btn(cxm - 70, '−', -1, 'npm', 'One cell fewer in parallel');
    svg.append(txt(cxm, H - 15, `${n} in parallel`, 'm', 'middle'));
    btn(cxm + 46, '+', 1, 'npp', 'One cell more in parallel');
    cellDraw.replaceChildren(svg);
  }

  // ---------- run time against current ----------
  let lifeGeom = null;
  function drawLife(b) {
    const W = Math.max(300, lifeDraw.clientWidth || 800);
    const narrow = W < 560;
    const L = narrow ? 58 : 70, R = narrow ? 10 : 18, T = 18;
    const PH = clamp(Math.round(W * 0.34), 220, 330);
    const bandH = 40;
    const H = T + PH + 22 + bandH + 8;
    const PW = W - L - R;
    const ix0 = lg(clamp(Math.min(1e-7, b.iavg / 3, b.isd > 0 ? b.isd / 3 : 1), 1e-8, 1)), ix1 = lg(clamp(Math.max(1, (b.ipeak || 0) * 3, b.iavg * 3), 1e-6, 10));
    const hy0 = lg(Math.min(1, b.h / 3)), hy1 = lg(Math.max(b.hShelf * 3, b.h * 3));
    const X = (i) => L + ((lg(i) - ix0) / (ix1 - ix0)) * PW;
    const Xi = (x) => 10 ** (ix0 + ((x - L) / PW) * (ix1 - ix0));
    const Y = (hr) => T + PH * (1 - (lg(hr) - hy0) / (hy1 - hy0));
    lifeGeom = { X, Xi, L, PW, T, PH, W, bandTop: T + PH + 22 };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `run time ${b.runText} at ${fmtEng(b.iavg, 'A')}` });
    const defs = sv('defs');
    const pd = sv('pattern', { id: 'bl-hatch-d', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pd.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-d' }));
    const clip = sv('clipPath', { id: 'bl-plot' }); clip.append(sv('rect', { x: L, y: T, width: PW, height: PH }));
    defs.append(pd, clip); svg.append(defs);
    svg.append(sv('rect', { x: L, y: T, width: PW, height: PH, class: 'plot' }));
    const g = sv('g', { 'clip-path': 'url(#bl-plot)' }); svg.append(g);
    // Current decades.
    for (let d = Math.ceil(ix0); d <= Math.floor(ix1); d++) {
      const x = X(10 ** d);
      g.append(sv('line', { x1: x, x2: x, y1: T, y2: T + PH, class: 'grid' }));
      if (!narrow || d % 2 === 0) svg.append(txt(x, T + PH + 14, fmtEng(10 ** d, 'A', 2), 'm soft sm', 'middle'));
    }
    // Calendar lines.
    for (const [hr, name] of CAL) {
      const y = Y(hr);
      if (y < T + 2 || y > T + PH - 2) continue;
      g.append(sv('line', { x1: L, x2: L + PW, y1: y, y2: y, class: 'grid-cal' }));
      svg.append(txt(L - 6, y + 3.5, name, 'soft sm', 'end'));
    }
    // Where self-discharge outweighs the load.
    if (b.isd > 0 && X(b.isd) > L) {
      const xs = X(b.isd);
      g.append(sv('rect', { x: L, y: T, width: xs - L, height: PH, class: 'sdz' }));
      g.append(sv('line', { x1: xs, x2: xs, y1: T, y2: T + PH, class: 'sdl' }));
      svg.append(txt(Math.min(xs + 5, L + PW - 150), T + PH - 8, `self-discharge ${fmtEng(b.isd, 'A')}`, 'sd-t sm'));
    }
    // Shelf-life ceiling.
    const ys = Y(b.hShelf);
    g.append(sv('rect', { x: L, y: T, width: PW, height: Math.max(0, ys - T), class: 'ceil' }));
    g.append(sv('line', { x1: L, x2: L + PW, y1: ys, y2: ys, class: 'ceil-l' }));
    svg.append(txt(clamp(b.isd > 0 ? X(b.isd) + 6 : L + 6, L + 6, L + PW - 130), ys - 5, `shelf life ~${fmtNum(b.shelfYears)} years`, 'danger sm b'));
    // The curve, and what the load alone would give above the ceiling.
    const pts = b.curve.filter((p) => lg(p.i) >= ix0 - 0.1 && lg(p.i) <= ix1 + 0.1);
    g.append(sv('path', { d: pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(1)},${Y(p.raw).toFixed(1)}`).join(''), class: 'curve-raw' }));
    g.append(sv('path', { d: pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(1)},${Y(p.h).toFixed(1)}`).join(''), class: 'curve' }));
    // Continuous rating as a wall in the plot too.
    if (b.cont != null && X(b.cont) < L + PW) g.append(sv('rect', { x: X(b.cont), y: T, width: L + PW - X(b.cont), height: PH, class: 'over', opacity: 0.6 }));

    // Operating point.
    const xo = X(b.iavg), yo = Y(b.h);
    const bad = b.cont != null && b.iavg > b.cont;
    g.append(sv('line', { x1: xo, x2: xo, y1: yo, y2: T + PH, class: 'drop' }));
    g.append(sv('line', { x1: L, x2: xo, y1: yo, y2: yo, class: 'drop' }));
    const ho = sv('g', { class: `h${bad ? ' bad' : ''}`, tabindex: 0, role: 'slider', 'data-fk': 'iavg', 'aria-label': 'Average current',
      'aria-valuetext': `${fmtEng(b.iavg, 'A')}, runs ${b.runText}` });
    ho.append(sv('circle', { cx: xo, cy: yo, r: 7, class: 'knob' }));
    ho.append(sv('circle', { cx: xo, cy: yo, r: 11, class: 'ring' }));
    ho.append(sv('title', {}, 'Drag: average current. Arrows ×1.2, PgUp/PgDn ×10'));
    ho.addEventListener('keydown', (e) => {
      const f = { ArrowRight: 10 ** (1 / 12), ArrowUp: 10 ** (1 / 12), ArrowLeft: 10 ** (-1 / 12), ArrowDown: 10 ** (-1 / 12), PageUp: 10, PageDown: 0.1 }[e.key];
      if (!f) return; e.preventDefault();
      ctx.set('iavg', eng(clamp(b.iavg * f, 1e-9, 10)));
    });
    ho.addEventListener('pointerdown', (e) => startDrag(e, 'iavg', lifeDraw));
    // Tag: current and run time, beside the point, kept inside.
    const tag1 = `${fmtEng(b.iavg, 'A')} → ${b.runText}`;
    const tag2 = `${/days|h$/.test(b.runText) ? `${fmtNum(b.h, 4)} hours` : `${fmtNum(b.h / 24, 4)} days`} · limited by ${b.limit}`;
    const tw = Math.max(tag1.length * 6.9, tag2.length * 5.9) + 14;
    const right = xo + 14 + tw < L + PW;
    const tx = right ? xo + 14 : xo - 14 - tw;
    const ty = yo - 44 < T + 24 ? clamp(yo + 14, T + 4, T + PH - 40) : yo - 44;
    svg.append(sv('rect', { x: tx, y: ty, width: tw, height: 34, rx: 3, class: `tag${bad ? ' bad' : ''}` }));
    svg.append(txt(tx + 7, ty + 14, tag1, 'm tag-t'));
    svg.append(txt(tx + 7, ty + 27, tag2, 'm tag-t sm'));
    svg.append(ho);
    svg.append(txt(L - 6, T - 6, 'runs', 'soft sm', 'end'));
    svg.append(txt(L + PW, T + PH + 14 + (narrow ? 0 : 0), '', '', 'end'));

    // Ratings band: rated current, continuous limit, pulse limit, and the peak.
    const by = T + PH + 22;
    svg.append(sv('rect', { x: L, y: by, width: PW, height: bandH - 12, class: 'band', rx: 3 }));
    svg.append(txt(L - 6, by + 12, 'per pack', 'soft sm', 'end'));
    svg.append(txt(L - 6, by + 23, 'ratings', 'soft sm', 'end'));
    const bandClip = sv('clipPath', { id: 'bl-band' }); bandClip.append(sv('rect', { x: L, y: by, width: PW, height: bandH - 12 })); defs.append(bandClip);
    const bg = sv('g', { 'clip-path': 'url(#bl-band)' }); svg.append(bg);
    if (b.cont == null && b.pulse == null) {
      svg.append(txt(L + 8, by + 18, W < 560 ? 'No ratings: see its datasheet (C rating).' : 'No ratings for this cell: check its datasheet (C rating) for peaks.', 'soft sm'));
    } else {
      if (b.cont != null) {
        bg.append(sv('rect', { x: X(b.cont), y: by, width: Math.max(0, L + PW - X(b.cont)), height: bandH - 12, class: 'over' }));
        bg.append(sv('line', { x1: X(b.cont), x2: X(b.cont), y1: by, y2: by + bandH - 12, class: 'limit' }));
        if (X(b.cont) < L + PW - 60) svg.append(txt(X(b.cont) + 4, by + 11, `continuous ${fmtEng(b.cont, 'A')}`, 'danger sm'));
      }
      if (b.pulse != null && X(b.pulse) < L + PW) {
        bg.append(sv('line', { x1: X(b.pulse), x2: X(b.pulse), y1: by, y2: by + bandH - 12, class: 'limit', 'stroke-dasharray': '3 2' }));
        svg.append(txt(X(b.pulse) - 4, by + 24, `pulse ${fmtEng(b.pulse, 'A')}`, 'danger sm', 'end'));
      }
      if (b.rated != null) {
        bg.append(sv('line', { x1: X(b.rated), x2: X(b.rated), y1: by, y2: by + bandH - 12, class: 'rated' }));
        const lab = `rated at ${fmtEng(b.rated, 'A')}`;
        svg.append(txt(X(b.rated) - 4, by + 11, lab, 'ok-t sm', 'end'));
      }
    }
    // Peak marker, draggable.
    if (b.ipeak > 0) {
      const xp = clamp(X(b.ipeak), L, L + PW);
      const pbad = b.pulse != null && b.ipeak > b.pulse;
      const hp = sv('g', { class: `h pk${pbad ? ' bad' : ''}`, tabindex: 0, role: 'slider', 'data-fk': 'ipeak', 'aria-label': 'Peak current',
        'aria-valuetext': fmtEng(b.ipeak, 'A') });
      hp.append(sv('path', { d: `M${xp},${by + 16} l-7,12 h14 z`, class: 'knob' }));
      hp.append(sv('circle', { cx: xp, cy: by + 23, r: 11, class: 'ring' }));
      hp.append(sv('title', {}, 'Drag: peak current. Arrows ×1.2, PgUp/PgDn ×10, Delete: none'));
      hp.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ctx.set('ipeak', '0'); return; }
        const f = { ArrowRight: 10 ** (1 / 12), ArrowUp: 10 ** (1 / 12), ArrowLeft: 10 ** (-1 / 12), ArrowDown: 10 ** (-1 / 12), PageUp: 10, PageDown: 0.1 }[e.key];
        if (!f) return; e.preventDefault();
        ctx.set('ipeak', eng(clamp(b.ipeak * f, 1e-9, 100)));
      });
      hp.addEventListener('pointerdown', (e) => startDrag(e, 'ipeak', lifeDraw));
      svg.append(hp);
      const pl = `peak ${fmtEng(b.ipeak, 'A')}`;
      svg.append(txt(clamp(xp, L + 30, L + PW - 30), by + bandH + 6, pl, `m sm b ${pbad ? 'danger' : 'warn-t'}`, 'middle'));
    }
    lifeDraw.replaceChildren(svg);
  }

  // ---------- the calendar bar ----------
  function drawCal(b) {
    const W = Math.max(300, calDraw.clientWidth || 800);
    const L = W < 560 ? 58 : 70, R = W < 560 ? 10 : 18, H = 58;
    const PW = W - L - R;
    const tmax = Math.max(b.h, Math.min(b.hShelf, b.h * 6), Math.min(b.hNoSd, b.h * 6)) * 1.08;
    const [unit, uname] = tmax >= 2 * YEAR ? [YEAR, 'years'] : tmax >= 60 * DAY ? [MONTH, 'months'] : tmax >= 2 * DAY ? [DAY, 'days'] : [HOUR, 'hours'];
    const span = tmax / unit;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => span / s <= (W < 560 ? 5 : 10)) || 1000;
    const X = (hr) => L + (hr / tmax) * PW;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `runs ${b.runText}` });
    svg.append(txt(L - 6, 20, 'calendar', 'soft sm', 'end'));
    svg.append(sv('rect', { x: L, y: 10, width: PW, height: 14, rx: 2, class: 'plot' }));
    if (b.hShelf < tmax) svg.append(sv('rect', { x: X(b.hShelf), y: 10, width: L + PW - X(b.hShelf), height: 14, class: 'bar-shelf' }));
    svg.append(sv('rect', { x: L, y: 10, width: Math.max(1, X(b.h) - L), height: 14, rx: 2, class: 'bar-run' }));
    if (b.hNoSd < tmax && b.hNoSd > b.h * 1.02) {
      const xn = X(Math.min(b.hNoSd, b.hShelf));
      svg.append(sv('line', { x1: xn, x2: xn, y1: 6, y2: 28, class: 'sdl' }));
    }
    for (let k = 0; k * step * unit <= tmax; k++) {
      const x = X(k * step * unit);
      svg.append(sv('line', { x1: x, x2: x, y1: 24, y2: 28, class: 'axis' }));
      svg.append(txt(x, 39, `${k * step}`, 'm soft sm', 'middle'));
    }
    svg.append(txt(L - 6, 51, uname, 'soft sm', 'end'));
    const lab = `${b.runText}${W >= 560 && b.hNoSd > b.h * 1.02 && b.limit !== 'shelf life' ? ` · ${fmtNum(b.hNoSd / unit, 3)} ${uname} without self-discharge (dashed)` : ''}${b.hShelf < tmax ? ' · hatched: past the shelf life' : ''}`;
    svg.append(txt(L, 51, lab, 'm sm'));
    calDraw.replaceChildren(svg);
  }

  // ---------- drag ----------
  function startDrag(e, what, host) {
    e.preventDefault(); e.stopPropagation();
    st.drag = what;
    try { host.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    move(e, host);
  }
  function move(e, host) {
    if (!st.drag) return;
    const r = host.getBoundingClientRect();
    if (st.drag === 'usable' && cellGeom) {
      const y = (e.clientY - r.top) * (cellGeom.W / r.width);
      const u = 100 - clamp(((y - cellGeom.y0) / cellGeom.bh) * 100, 0, 99);
      ctx.set('usable', String(clamp(Math.round(u), 1, 100)));
    } else if (lifeGeom) {
      const x = clamp((e.clientX - r.left) * (lifeGeom.W / r.width), lifeGeom.L, lifeGeom.L + lifeGeom.PW);
      ctx.set(st.drag, eng(lifeGeom.Xi(x)));
    }
  }
  lifeDraw.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !lifeGeom) return;
    const r = lifeDraw.getBoundingClientRect();
    const y = (e.clientY - r.top) * (lifeGeom.W / r.width);
    startDrag(e, y > lifeGeom.bandTop ? 'ipeak' : 'iavg', lifeDraw);
  });
  cellDraw.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('g.btn')) return;
    startDrag(e, 'usable', cellDraw);
  });
  for (const host of [lifeDraw, cellDraw]) {
    host.addEventListener('pointermove', (e) => { if (st.drag) move(e, host); });
    const end = () => { st.drag = null; };
    host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
  }

  function draw() {
    const res = ctx.result, b = res?.battery;
    const raw = ctx.raw;
    for (const f of fields) {
      if (document.activeElement !== f.inp) f.inp.value = raw[f.key] ?? '';
      f.inp.classList.toggle('bad', String(raw[f.key] ?? '').trim() !== '' && ctx.parseEng(raw[f.key]) == null);
    }
    customBox.replaceChildren(...(raw.chem === 'custom' ? [sdF.el, shelfF.el] : []));
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    const tbl = res?.tables?.[0];
    notesBody.replaceChildren(...(res?.notes || []).map((w) => h('div', {}, w)),
      ...(tbl ? [h('div', { class: 'k-tablewrap', style: 'margin-top:6px' }, h('table', { class: 'k-table' },
        h('thead', {}, h('tr', {}, tbl.columns.map((c) => h('th', {}, c)))),
        h('tbody', {}, tbl.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))))] : []));
    keepFocus(() => {
      drawShelf(b);
      if (!b) {
        cellName.textContent = ''; runBig.textContent = '–'; runSub.textContent = 'fix the inputs above';
        for (const d of [cellDraw, lifeDraw, calDraw]) d.replaceChildren();
        return;
      }
      cellName.textContent = b.name;
      runBig.textContent = b.runText;
      runSub.textContent = `limited by ${b.limit}`;
      runBig.style.color = b.h >= YEAR ? 'var(--ok)' : b.h >= MONTH ? '' : 'var(--warn)';
      drawCell(b);
      drawLife(b);
      drawCal(b);
    });
  }

  ctx.onResult(() => draw());
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(draw); }).observe(root);
}
