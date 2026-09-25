// Total Cost Roll-Up, custom page: the unit cost as a landscape over quantity.
//   Curve   - cost per good unit (y) against order quantity (x, log), as a
//             stack of the seven cost categories. Each layer has a solid part
//             (paid per built unit) and a hatched part (one-time costs spread
//             over the order), so the hatched part melts away to the right.
//             The cursor is the order: drag it (or anywhere on the plot) to
//             change the quantity; arrow keys step it on the focused handle.
//   Column  - the stack at the cursor, pulled out to full height on the
//             right, every category labelled with its cost per unit and share.
//             Click a layer or a column segment to open that category.
//   Inspect - the selected category's inputs. For the BOM: a treemap of the
//             lines by what they cost this order, the part of each line bought
//             but not used (MOQ and attrition) hatched in red; click a block to
//             edit the line, and the "reel" bar shows used / attrition / MOQ.
// Every number drawn comes from run()'s result.cost.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Stack order, bottom to top: the big per-unit costs low, the order-level ones on top.
const ORDER = ['bom', 'pcb', 'asm', 'enc', 'cable', 'test', 'freight'];
const CI = { pcb: 0, bom: 1, asm: 2, enc: 3, cable: 4, test: 5, freight: 6 };
const COLOR = { bom: 'var(--tool-c0)', pcb: 'var(--tool-c1)', asm: 'var(--tool-c2)', enc: 'var(--tool-c3)', cable: 'var(--tool-c4)', test: 'var(--tool-c5)', freight: 'var(--tool-c6)' };
const FIELDS = {
  pcb: [['pcbUnit', 'Price per board', 'per built unit'], ['pcbNre', 'One-time: tooling, e-test, stencil', 'per order']],
  bom: [],
  asm: [['places', 'SMT placements per board', 'count'], ['perPlace', 'Price per placement', 'per placement'], ['hand', 'Hand / THT work per board', 'per built unit'], ['asmSetup', 'Setup per order', 'per order']],
  enc: [['encUnit', 'Enclosure per unit', 'per built unit'], ['encTool', 'Tooling (mold)', 'per order']],
  cable: [['cableUnit', 'Cables per unit', 'per built unit']],
  test: [['testUnit', 'Test, programming, packing', 'per built unit']],
  freight: [['freight', 'Freight and duty', 'per order']],
};
const BLURB = {
  pcb: 'Bare boards, paid per built unit, plus the one-time fab costs.',
  bom: 'Parts bought for the built units: attrition added, then rounded up to each MOQ. Block area = what the line costs this order.',
  asm: 'Placement and hand work per built board, plus the line setup per order.',
  enc: 'Housing per built unit; the mold is a one-time cost.',
  cable: 'Harnesses and leads per built unit.',
  test: 'Programming, functional test and packing per built unit.',
  freight: 'Shipping and duty for the whole order, spread over the good units.',
};

const money = (v) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(1);
  if (a >= 0.1 || a === 0) return v.toFixed(2);
  return v.toPrecision(2);
};
const count = (q) => Math.round(q).toLocaleString('en-US');
const kq = (q) => (q >= 1e6 ? `${q / 1e6}M` : q >= 1000 ? `${q / 1000}k` : String(q));
// Order quantities snap to two significant figures (480, 1300, 25k); below 100 to whole units.
const snapQ = (q) => {
  q = clamp(q, 1, 1e6);
  if (q < 100) return Math.max(1, Math.round(q));
  const p = 10 ** (Math.floor(Math.log10(q)) - 1);
  return Math.round(q / p) * p;
};
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Squarified treemap (Bruls, Huizing, van Wijk 2000) of [{w, ...}] into a rect.
function squarify(items, x, y, w, h) {
  const out = [];
  let rest = items.filter((d) => d.w > 0).sort((a, b) => b.w - a.w);
  const total = rest.reduce((t, d) => t + d.w, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  let rx = x, ry = y, rw = w, rh = h;
  const worst = (row, side) => {
    const s = row.reduce((t, d) => t + d.w * scale, 0);
    let mx = 0;
    for (const d of row) { const a = d.w * scale; mx = Math.max(mx, (side * side * a) / (s * s), (s * s) / (side * side * a)); }
    return mx;
  };
  while (rest.length) {
    const side = Math.min(rw, rh);
    const row = [rest[0]]; let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) { row.push(rest[i]); i++; }
    rest = rest.slice(i);
    const s = row.reduce((t, d) => t + d.w * scale, 0);
    if (rw >= rh) {
      const cw = s / rh; let cy = ry;
      for (const d of row) { const ch = (d.w * scale) / cw; out.push({ ...d, x: rx, y: cy, w2: cw, h2: ch }); cy += ch; }
      rx += cw; rw -= cw;
    } else {
      const ch = s / rw; let cx = rx;
      for (const d of row) { const cw = (d.w * scale) / ch; out.push({ ...d, x: cx, y: ry, w2: cw, h2: ch }); cx += cw; }
      ry += ch; rh -= ch;
    }
  }
  return out;
}

const CSS = `
:root {
  --tool-c0: #2f6fbf; --tool-c1: #2f9a74; --tool-c2: #c27a1a; --tool-c3: #8a5cc2; --tool-c4: #c2527a; --tool-c5: #3f9fb3; --tool-c6: #7c8a2f;
  --tool-band: .80; --tool-hatch-bg: .20; --tool-grid: #dde4ea;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-c0: #5f9cf0; --tool-c1: #4cc39a; --tool-c2: #e8a24a; --tool-c3: #b08ef0; --tool-c4: #ec7ba3; --tool-c5: #5cc6dc; --tool-c6: #b3c35a;
  --tool-band: .72; --tool-hatch-bg: .22; --tool-grid: #24313c; } }
:root[data-theme="dark"] {
  --tool-c0: #5f9cf0; --tool-c1: #4cc39a; --tool-c2: #e8a24a; --tool-c3: #b08ef0; --tool-c4: #ec7ba3; --tool-c5: #5cc6dc; --tool-c6: #b3c35a;
  --tool-band: .72; --tool-hatch-bg: .22; --tool-grid: #24313c; }
.k-page { padding: 12px; }
.cr { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); align-items: start; }
@media (max-width: 1020px) { .cr { grid-template-columns: minmax(0, 1fr); } }
.cr-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.cr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); }
.cr-f { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-soft); }
.cr-f input { width: 76px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 13px "IBM Plex Mono", ui-monospace, monospace; }
.cr-f input.cur { width: 52px; }
.cr-f input.bad { border-color: var(--danger); }
.cr-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.cr-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; color: var(--ink-soft); cursor: pointer; }
.cr-seg button + button { border-left: 1px solid var(--line); }
.cr-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.cr-big { margin-left: auto; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
.cr-big span { font-size: 11px; color: var(--ink-soft); }
.cr-big b { font: 600 20px "IBM Plex Mono", ui-monospace, monospace; }
.cr-big b.s { font-size: 14px; font-weight: 500; }
.cr-stage { position: relative; padding: 4px 6px 0; }
.cr-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.cr-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 6px 12px 8px; border-top: 1px solid var(--line-soft); font-size: 11px; color: var(--ink-soft); align-items: center; }
.cr-legend svg { vertical-align: middle; margin-right: 4px; }
.cr-ax { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.cr-lbl { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.cr-lbl.b { fill: var(--ink); font-weight: 600; }
.cr-lbl.m { font-family: "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.cr-lbl.warn { fill: var(--warn); font-weight: 600; }
.cr-grid { stroke: var(--tool-grid); stroke-width: 1; }
.cr-band { cursor: pointer; }
.cr-band.v { opacity: var(--tool-band); }
.cr-band.v.dim { opacity: .5; } .cr-band.dim { opacity: .6; }
.cr-band.sel { stroke: var(--ink); stroke-width: 1.2; }
.cr-total { fill: none; stroke: var(--ink); stroke-width: 1.8; pointer-events: none; }
.cr-cursor { stroke: var(--accent); stroke-width: 1.5; pointer-events: none; }
.cr-handle { cursor: ew-resize; outline: none; }
.cr-handle .knob { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.cr-handle .ring { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0; }
.cr-handle:focus-visible .ring { opacity: 1; stroke-dasharray: 4 2; }
.cr-tag rect { fill: var(--surface); stroke: var(--accent); stroke-width: 1.2; }
.cr-tag text { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.cr-tag .s { font-weight: 400; fill: var(--ink-soft); font-size: 11px; }
.cr-seg-r { cursor: pointer; outline: none; }
.cr-seg-r rect.f { stroke: var(--surface); stroke-width: 1; }
.cr-seg-r.sel rect.f { stroke: var(--ink); stroke-width: 2; }
.cr-seg-r:focus-visible rect.f { stroke: var(--accent); stroke-width: 2.5; }
.cr-seg-r.dim rect.f { opacity: .35; }
.cr-lead { stroke: var(--ink-soft); opacity: .6; stroke-width: 1; fill: none; }
.cr-over { fill: var(--surface); opacity: .9; }

.cr-side { display: flex; flex-direction: column; }
.cr-sh { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); }
.cr-sw { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.cr-sh h2 { margin: 0; font-size: 13px; font-weight: 600; flex: 1; min-width: 0; }
.cr-sh .v { font: 600 16px "IBM Plex Mono", ui-monospace, monospace; }
.cr-sh .v small { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.cr-cats { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px 0; }
.cr-cats button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 1px 9px 1px 6px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.cr-cats button i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.cr-cats button[aria-pressed="true"] { border-color: var(--ink); color: var(--ink); font-weight: 600; }
.cr-body { padding: 8px 12px 12px; display: grid; gap: 8px; }
.cr-blurb { font-size: 11.5px; color: var(--ink-soft); margin: 0; }
.cr-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 4px; overflow: hidden; }
.cr-facts div { background: var(--sunken); padding: 4px 8px; min-width: 0; }
.cr-facts span { display: block; font-size: 10.5px; color: var(--ink-soft); }
.cr-facts b { font: 500 13px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.cr-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.cr-fields label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.cr-fields label.w { grid-column: 1 / -1; }
.cr-fields input { width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.cr-fields input.bad { border-color: var(--danger); }
.cr-fields em { font-style: normal; font-size: 10.5px; opacity: .8; }
.cr-tm { display: block; width: 100%; touch-action: manipulation; }
.cr-blk { cursor: pointer; outline: none; }
.cr-blk rect.f { fill: var(--tool-c0); opacity: .55; stroke: var(--surface); stroke-width: 2; }
.cr-blk.sel rect.f { opacity: .9; }
.cr-blk rect.o { fill: none; stroke: transparent; stroke-width: 2; }
.cr-blk.sel rect.o { stroke: var(--ink); }
.cr-blk:focus-visible rect.o { stroke: var(--accent); stroke-dasharray: 4 2; }
.cr-blk.bad rect.o { stroke: var(--danger); }
.cr-blk.sel.bad rect.o { stroke: var(--ink); }
.cr-blk text { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink); pointer-events: none; }
.cr-blk text.m { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 10.5px; }
.cr-blk text.bad { fill: var(--danger); font-weight: 600; }
.cr-xs { fill: url(#cr-xs); pointer-events: none; }
.cr-reel { display: grid; gap: 3px; }
.cr-reel .bar { display: flex; height: 14px; border-radius: 3px; overflow: hidden; background: var(--sunken); border: 1px solid var(--line-soft); }
.cr-reel .bar i { display: block; height: 100%; }
.cr-reel .k { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 11px; color: var(--ink-soft); }
.cr-reel .k b { font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.cr-reel .k i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.cr-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.cr-note { font-size: 11px; color: var(--ink-soft); }
.cr-danger { color: var(--danger); }

.cr-foot { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; margin-top: 12px; }
@media (max-width: 1020px) { .cr-foot { grid-template-columns: minmax(0, 1fr); } }
.cr-msgs { display: grid; gap: 8px; min-width: 0; }
.cr-msgs .k-warns:empty, .cr-msgs .k-notes:empty { display: none; }
.cr-all { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.cr-all summary { cursor: pointer; padding: 7px 10px; font-size: 12px; font-weight: 500; }
.cr-all .k-form { border: 0; border-top: 1px solid var(--line-soft); border-radius: 0 0 6px 6px; }
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const state = { cat: 'bom', line: 0, win: null, drag: null, W: 800 };
  const cost = () => ctx.result?.cost || null;

  // ---------- skeleton ----------
  const qtyIn = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Good units to deliver', spellcheck: 'false' });
  const curIn = h('input', { type: 'text', class: 'cur', 'aria-label': 'Currency', spellcheck: 'false' });
  const yieldIn = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Yield in percent', spellcheck: 'false' });
  qtyIn.addEventListener('input', () => { state.win = null; ctx.set('qty', qtyIn.value); });
  curIn.addEventListener('input', () => ctx.set('currency', curIn.value));
  yieldIn.addEventListener('input', () => ctx.set('yieldPct', yieldIn.value));
  const amSeg = h('div', { class: 'cr-seg', role: 'group', 'aria-label': 'One-time costs' });
  const big = h('div', { class: 'cr-big', 'aria-live': 'polite' });
  const bar = h('div', { class: 'cr-bar' },
    h('label', { class: 'cr-f' }, 'Good units', qtyIn),
    h('label', { class: 'cr-f' }, 'Yield', yieldIn, '%'),
    h('label', { class: 'cr-f' }, 'Currency', curIn),
    amSeg, big);

  const svg = sv('svg', { class: 'cr-svg', role: 'group', 'aria-label': 'Cost per unit against order quantity, stacked by category' });
  const stage = h('div', { class: 'cr-stage' }, svg);
  const legend = h('div', { class: 'cr-legend' });
  const main = h('section', { class: 'cr-panel' }, bar, stage, legend);

  const side = h('section', { class: 'cr-panel cr-side' });
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const all = h('details', { class: 'cr-all' }, h('summary', {}, 'All inputs as a form'), ctx.form);
  root.append(h('div', { class: 'cr' }, main, side),
    h('div', { class: 'cr-foot' }, h('div', { class: 'cr-msgs' }, warns, notes, all), ctx.outputs));

  // ---------- chart ----------
  let geo = null;
  function drawChart(c) {
    const W = state.W;
    const narrow = W < 620;
    const H = narrow ? 380 : clamp(Math.round(W * 0.5), 400, 470);
    const colW = narrow ? 104 : 190;
    const L = 52, T = 44, B = 40, R = colW + 18;
    const PW = W - L - R, PH = H - T - B;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.replaceChildren();
    if (!c) {
      svg.append(sv('text', { x: W / 2, y: H / 2, class: 'cr-lbl b', 'text-anchor': 'middle' }, 'Give the number of good units to deliver, e.g. 500.'));
      geo = null; return;
    }
    const lq = Math.log10(c.qty);
    if (!state.win || (!state.drag && (lq < state.win[0] + 0.12 || lq > state.win[1] - 0.12))) {
      const lo = clamp(lq - 1.4, 0, 3.2);
      state.win = [lo, lo + 2.8];
      if (lq > state.win[1] - 0.12) state.win = [Math.max(0, Math.min(lq - 1.4, 6 - 2.8)), Math.min(6, Math.max(lq - 1.4, 0) + 2.8)];
    }
    const [lo, hi] = state.win;
    const X = (q) => L + ((Math.log10(q) - lo) / (hi - lo)) * PW;
    const pts = c.curve.filter((p, i, a) => {
      const l = Math.log10(p.q);
      if (l >= lo && l <= hi) return true;
      const n = a[i + 1], pr = a[i - 1];
      return (l < lo && n && Math.log10(n.q) >= lo) || (l > hi && pr && Math.log10(pr.q) <= hi);
    });
    const at = c.curve.find((p) => p.q === c.qty) || pts[0];
    const rightEnd = pts[pts.length - 1];
    // The scale holds still while the cursor is dragged, and fits again on release.
    const yFit = niceCeil(Math.max(at.perUnit * 1.9, rightEnd.perUnit * 1.15));
    const yTop = state.drag && state.yTop ? state.yTop : yFit;
    state.yTop = yTop;
    const Y = (v) => T + PH * (1 - v / yTop);
    geo = { L, T, PW, PH, X, lo, hi, W, H };

    const defs = sv('defs');
    const clip = sv('clipPath', { id: 'cr-clip' }); clip.append(sv('rect', { x: L, y: T, width: PW, height: PH })); defs.append(clip);
    for (const k of ORDER) {
      const p = sv('pattern', { id: `cr-h-${k}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(sv('rect', { width: 6, height: 6, style: `fill:${COLOR[k]};opacity:var(--tool-hatch-bg)` }), sv('rect', { width: 2.2, height: 6, style: `fill:${COLOR[k]}` }));
      defs.append(p);
    }
    svg.append(defs);

    // grid and axes
    const gy = sv('g');
    for (let i = 0; i <= 5; i++) {
      const v = (yTop * i) / 5;
      gy.append(sv('line', { x1: L, x2: L + PW, y1: Y(v), y2: Y(v), class: 'cr-grid' }),
        sv('text', { x: L - 6, y: Y(v) + 4, class: 'cr-ax', 'text-anchor': 'end' }, money(v)));
    }
    for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
      for (const m of [1, 2, 5]) {
        const q = m * 10 ** e; const l = Math.log10(q);
        if (l < lo - 1e-9 || l > hi + 1e-9) continue;
        gy.append(sv('line', { x1: X(q), x2: X(q), y1: T, y2: T + PH, class: 'cr-grid', 'stroke-dasharray': m === 1 ? null : '2 3' }));
        if (m === 1 || PW > 420) gy.append(sv('text', { x: X(q), y: T + PH + 15, class: 'cr-ax', 'text-anchor': 'middle' }, kq(q)));
      }
    }
    gy.append(sv('text', { x: L + PW, y: T + PH + 32, class: 'cr-lbl', 'text-anchor': 'end' }, 'good units in the order (log) →'),
      narrow ? sv('text', { x: L - 6, y: T + PH + 15, class: 'cr-ax', 'text-anchor': 'end' }, c.cur) : sv('text', { x: L - 44, y: T - 12, class: 'cr-lbl' }, `${c.cur} per good unit`));
    svg.append(gy);

    // bands
    const gb = sv('g', { 'clip-path': 'url(#cr-clip)' });
    const base = pts.map(() => 0);
    const band = (k, vals, hatched) => {
      const top = base.map((b, i) => b + vals[i]);
      if (!vals.some((v) => v > 0)) return;
      const up = pts.map((p, i) => `${X(p.q).toFixed(1)},${Y(top[i]).toFixed(1)}`);
      const dn = pts.map((p, i) => `${X(p.q).toFixed(1)},${Y(base[i]).toFixed(1)}`).reverse();
      const path = sv('path', { d: `M${up.join('L')}L${dn.join('L')}Z`, class: `cr-band${hatched ? '' : ' v'}${state.cat === k ? ' sel' : ''}${state.cat && state.cat !== k ? ' dim' : ''}`,
        'data-cat': k, style: hatched ? `fill:url(#cr-h-${k})` : `fill:${COLOR[k]}` });
      const cat = c.cats[CI[k]];
      path.append(sv('title', {}, `${cat.name}${hatched ? ', one-time costs spread over the order' : ', per built unit'}: click to open`));
      gb.append(path);
      for (let i = 0; i < base.length; i++) base[i] = top[i];
    };
    for (const k of ORDER) { band(k, pts.map((p) => p.v[CI[k]]), false); band(k, pts.map((p) => p.o[CI[k]]), true); }
    gb.append(sv('path', { class: 'cr-total', d: 'M' + pts.map((p) => `${X(p.q).toFixed(1)},${Y(p.perUnit).toFixed(1)}`).join('L') }));
    svg.append(gb);
    svg.append(sv('rect', { x: L, y: T, width: PW, height: PH, fill: 'none', stroke: 'var(--line)' }));

    // off-scale: the total leaves the top on the left
    const first = pts.find((p) => Math.log10(p.q) >= lo) || pts[0];
    if (first.perUnit > yTop) {
      const t = `${money(first.perUnit)} at ${count(first.q)}`;
      const g = sv('g', { class: 'cr-tag', transform: `translate(${L + 6} ${T + 6})` });
      g.append(sv('rect', { x: 0, y: 0, width: t.length * 6.6 + 20, height: 18, rx: 3, style: 'stroke:var(--line)' }), sv('text', { x: 8, y: 13, class: 's' }, `↑ ${t}`));
      svg.append(g);
    }

    // cursor
    const cx = X(c.qty), cy = Y(c.perUnit);
    svg.append(sv('line', { x1: cx, x2: cx, y1: T - 4, y2: T + PH, class: 'cr-cursor' }));
    const handle = sv('g', { class: 'cr-handle', tabindex: 0, role: 'slider', 'aria-label': 'Order quantity',
      'aria-valuemin': 1, 'aria-valuemax': 1000000, 'aria-valuenow': c.qty, 'aria-valuetext': `${count(c.qty)} good units, ${money(c.perUnit)} ${c.cur} per unit` });
    handle.append(sv('circle', { cx, cy: clamp(cy, T, T + PH), r: 13, class: 'ring' }), sv('circle', { cx, cy: clamp(cy, T, T + PH), r: 7, class: 'knob' }),
      sv('circle', { cx, cy: T + PH, r: 5, class: 'knob' }));
    svg.append(handle);
    const tag = `${count(c.qty)} units`;
    const tag2 = `${money(c.perUnit)} ${c.cur}/unit`;
    const tw = Math.max(tag.length, tag2.length) * 7.3 + 16;
    const tx = clamp(cx - tw / 2, L, L + PW - tw);
    const tg = sv('g', { class: 'cr-tag', transform: `translate(${tx} ${T - 40})`, 'pointer-events': 'none' });
    tg.append(sv('rect', { x: 0, y: 0, width: tw, height: 32, rx: 3 }), sv('text', { x: 8, y: 13 }, tag), sv('text', { x: 8, y: 27, class: 's' }, tag2));
    svg.append(tg);

    // the column at the cursor, full height on the right
    const colX = L + PW + 18, bw = narrow ? 18 : 26;
    const cats = ORDER.map((k) => ({ k, c: c.cats[CI[k]] })).filter((d) => d.c.perUnit > 0);
    const sum = c.perUnit || 1;
    let yy = T + PH;
    const segs = cats.map((d) => {
      const hh = (PH * d.c.perUnit) / sum;
      const s = { ...d, y0: yy - hh, h: hh };
      yy -= hh; return s;
    });
    svg.append(sv('text', { x: colX, y: T - 12, class: 'cr-lbl b' }, `At ${count(c.qty)} units`));
    // labels spread so they never overlap
    // lab[0] is the bottom segment; keep labels lh apart inside [T + top, T + PH].
    const lh = narrow ? 27 : 30;
    const lab = segs.map((s) => ({ s, y: s.y0 + s.h / 2 }));
    const yMin = T + 12, yMax = T + PH - 8;
    for (let i = 0; i < lab.length; i++) lab[i].y = clamp(lab[i].y, yMin, yMax);
    for (let i = 1; i < lab.length; i++) if (lab[i - 1].y - lab[i].y < lh) lab[i].y = lab[i - 1].y - lh;
    const over = yMin - lab[lab.length - 1]?.y;
    if (over > 0) {
      lab[lab.length - 1].y = yMin;
      for (let i = lab.length - 2; i >= 0; i--) if (lab[i].y - lab[i + 1].y < lh) lab[i].y = lab[i + 1].y + lh;
    }
    for (const s of segs) {
      const g = sv('g', { class: `cr-seg-r${state.cat === s.k ? ' sel' : ''}${state.cat && state.cat !== s.k ? ' dim' : ''}`, tabindex: 0, role: 'button', 'data-cat': s.k,
        'aria-label': `${s.c.name}: ${money(s.c.perUnit)} ${c.cur} per unit, ${(s.c.share * 100).toFixed(1)} %. Enter opens it.` });
      g.append(sv('rect', { class: 'f', x: colX, y: s.y0, width: bw, height: Math.max(0.5, s.h), style: `fill:${COLOR[s.k]}` }));
      if (s.c.perUnitOnce > 0 && s.h > 1) {
        const oh = (s.h * s.c.perUnitOnce) / s.c.perUnit;
        g.append(sv('rect', { x: colX, y: s.y0, width: bw, height: oh, style: `fill:url(#cr-h-${s.k})`, 'pointer-events': 'none' }));
      }
      svg.append(g);
    }
    for (const { s, y } of lab) {
      const lx = colX + bw + 10;
      svg.append(sv('path', { class: 'cr-lead', d: `M${colX + bw + 1},${s.y0 + s.h / 2} L${lx - 3},${y - 4}` }));
      const t1 = sv('text', { x: lx, y: y - 6, class: 'cr-lbl b', 'data-cat': s.k }, narrow ? ({ bom: 'BOM', test: 'Test', freight: 'Freight', enc: 'Enclosure' }[s.k] || s.c.name) : s.c.name);
      const t2 = sv('text', { x: lx, y: y + 8, class: 'cr-lbl m' }, `${money(s.c.perUnit)}`);
      t2.append(sv('tspan', { class: 'cr-ax', dx: 5 }, `${(s.c.share * 100).toFixed(s.c.share < 0.1 ? 1 : 0)} %`));
      svg.append(t1, t2);
    }
  }

  const qAt = (e) => {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    const l = geo.lo + ((clamp(q.x, geo.L, geo.L + geo.PW) - geo.L) / geo.PW) * (geo.hi - geo.lo);
    return { q: snapQ(10 ** l), inPlot: q.x >= geo.L - 8 && q.x <= geo.L + geo.PW + 8 && q.y >= geo.T - 44 && q.y <= geo.T + geo.PH + 20 };
  };
  const setQty = (q) => { if (q !== ctx.input.qty) ctx.set('qty', String(q)); };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !geo) return;
    const catEl = e.target.closest('[data-cat]');
    if (catEl && !e.target.closest('.cr-band')) { selectCat(catEl.dataset.cat); return; }
    const { q, inPlot } = qAt(e);
    if (!inPlot) return;
    e.preventDefault();
    state.drag = { x0: e.clientX, y0: e.clientY, moved: false, cat: e.target.closest('.cr-band')?.dataset.cat || null, onHandle: !!e.target.closest('.cr-handle') };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    svg.querySelector('.cr-handle')?.focus({ preventScroll: true });
    if (state.drag.onHandle) return;
    state.drag.q = q;
  });
  svg.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    d.moved = true;
    setQty(qAt(e).q);
  });
  const end = (e) => {
    const d = state.drag; state.drag = null;
    try { svg.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!d) return;
    if (!d.moved && !d.onHandle) {
      // A click on a band opens its category; a click on empty plot moves the cursor there.
      if (d.cat) selectCat(d.cat); else setQty(d.q);
    } else render();
    svg.querySelector('.cr-handle')?.focus({ preventScroll: true });
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('keydown', (e) => {
    const seg = e.target.closest('.cr-seg-r');
    if (seg && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectCat(seg.dataset.cat, true); return; }
    if (!e.target.closest('.cr-handle')) return;
    const c = cost(); if (!c) return;
    const l = Math.log10(c.qty); let n = null;
    const step = e.shiftKey ? 0.25 : 1 / 12;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = snapQ(10 ** (l + step));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = snapQ(10 ** (l - step));
    else if (e.key === 'PageUp') n = snapQ(c.qty * 10);
    else if (e.key === 'PageDown') n = snapQ(c.qty / 10);
    else if (e.key === 'Home') n = snapQ(10 ** state.win[0]);
    else if (e.key === 'End') n = snapQ(10 ** state.win[1]);
    if (n == null) return;
    e.preventDefault();
    if (n === c.qty) n = e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown' ? Math.max(1, c.qty - 1) : c.qty + 1;
    state.refocus = 'handle';
    setQty(n);
  });

  // ---------- header ----------
  function drawBar(c) {
    if (document.activeElement !== qtyIn) qtyIn.value = ctx.raw.qty ?? '';
    if (document.activeElement !== curIn) curIn.value = ctx.raw.currency ?? '';
    if (document.activeElement !== yieldIn) yieldIn.value = ctx.raw.yieldPct ?? '';
    qtyIn.classList.toggle('bad', !(ctx.input.qty > 0));
    const am = ctx.raw.amortize !== false;
    amSeg.replaceChildren(...[[true, 'NRE spread'], [false, 'NRE left out']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(am === v), onclick: () => ctx.set('amortize', v),
        title: v ? 'Tooling, setup and freight divided over this order (the usual quote)' : 'Unit cost without the one-time costs' }, t)));
    big.replaceChildren(...(c ? [
      h('div', {}, h('span', {}, c.amortize ? 'per unit ' : 'per unit, no NRE '), h('b', {}, `${money(c.perUnit)}`), h('span', {}, ` ${c.cur}`)),
      h('div', {}, h('span', {}, 'order '), h('b', { class: 's' }, money(c.total))),
      h('div', { title: 'Units built to deliver the good ones at this yield' }, h('span', {}, 'build '), h('b', { class: `s${c.yieldPct < 80 ? ' cr-danger' : ''}` }, count(c.built))),
    ] : []));
  }
  function drawLegend(c) {
    const sw = (k, hatch) => `<svg width="16" height="11" aria-hidden="true"><rect width="16" height="11" rx="2" style="fill:${hatch ? `url(#cr-h-${k})` : COLOR[k]};${hatch ? '' : 'opacity:var(--tool-band)'}"/></svg>`;
    legend.innerHTML = `<span>${sw('bom')}paid per built unit</span><span>${sw('bom', true)}one-time costs spread over the order</span>`
      + '<span><svg width="18" height="11" aria-hidden="true"><line x1="0" x2="18" y1="6" y2="6" stroke="var(--ink)" stroke-width="2"/></svg>total per unit</span>'
      + `<span style="flex-basis:100%">Drag the cursor (or click the plot) to change the order quantity · click a layer to open its costs · focused cursor: ← → step, Shift for bigger steps, PgUp/PgDn ×10${c && !c.amortize ? ' · one-time costs are left out, so no layer is hatched' : ''}</span>`;
  }

  // ---------- inspector ----------
  function selectCat(k, focus) {
    state.cat = k; render();
    if (focus) side.querySelector('input, .cr-blk')?.focus();
  }
  const rowsNow = () => structuredClone(ctx.raw.bom || []);
  const setRows = (rows) => ctx.set('bom', rows);
  function numField(key, label, unit, wide) {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'data-key': key });
    inp.value = ctx.raw[key] ?? '';
    inp.classList.toggle('bad', String(ctx.raw[key] ?? '').trim() !== '' && ctx.input[key] == null);
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    return h('label', { class: wide ? 'w' : null }, h('span', {}, label, ' ', h('em', {}, unit)), inp);
  }
  function drawSide(c) {
    const act = document.activeElement;
    const focusKey = side.contains(act) ? (act.dataset.key || act.dataset.col || (act.classList.contains('cr-blk') ? 'blk' : null)) : null;
    side.replaceChildren();
    if (!c) { side.append(h('div', { class: 'cr-body' }, h('p', { class: 'cr-blurb' }, 'Nothing to show until the quantity is a number.'))); return; }
    const k = state.cat || 'bom';
    const cat = c.cats[CI[k]];
    side.append(h('div', { class: 'cr-sh' }, h('span', { class: 'cr-sw', style: `background:${COLOR[k]}` }), h('h2', {}, cat.name),
      h('span', { class: 'v' }, money(cat.perUnit), h('small', {}, ` ${c.cur}/unit`))));
    side.append(h('div', { class: 'cr-cats', role: 'group', 'aria-label': 'Category' }, ORDER.map((kk) =>
      h('button', { type: 'button', 'aria-pressed': String(kk === k), onclick: () => selectCat(kk) }, h('i', { style: `background:${COLOR[kk]}` }), c.cats[CI[kk]].name))));
    const body = h('div', { class: 'cr-body' });
    side.append(body);
    body.append(h('p', { class: 'cr-blurb' }, BLURB[k]));
    body.append(h('div', { class: 'cr-facts' },
      h('div', {}, h('span', {}, 'Share of unit'), h('b', {}, `${(cat.share * 100).toFixed(1)} %`)),
      h('div', {}, h('span', {}, `Order, ${c.cur}`), h('b', {}, money(cat.total))),
      h('div', {}, h('span', {}, 'of it one-time'), h('b', {}, cat.once ? money(cat.once) : '–'))));
    if (k === 'bom') drawBom(c, body);
    else body.append(h('div', { class: 'cr-fields' }, FIELDS[k].map(([key, label, unit]) => numField(key, label, unit, FIELDS[k].length === 1))));
    if (focusKey) {
      const el = focusKey === 'blk' ? side.querySelector('.cr-blk.sel') : side.querySelector(`[data-key="${focusKey}"], [data-col="${focusKey}"]`);
      if (el) { el.focus({ preventScroll: true }); if (el.setSelectionRange && act.selectionStart != null) { try { el.setSelectionRange(act.selectionStart, act.selectionEnd); } catch { /* not text */ } } }
    }
  }

  function drawBom(c, body) {
    const rows = ctx.raw.bom || [];
    const lines = c.lines;
    if (!rows[state.line]) state.line = 0;
    const W = Math.max(240, side.clientWidth - 26), H = Math.round(clamp(W * 0.62, 170, 250));
    const tm = sv('svg', { class: 'cr-tm', viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'BOM lines sized by their cost this order' });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'cr-xs', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 1.8, height: 5, style: 'fill:var(--danger)' }));
    defs.append(pat); tm.append(defs);
    const boxes = squarify(lines.map((l) => ({ w: l.cost, l })), 0, 0, W, H);
    if (!boxes.length) tm.append(sv('text', { x: W / 2, y: H / 2, class: 'cr-lbl', 'text-anchor': 'middle' }, 'No priced BOM lines: add a part below.'));
    for (const b of boxes) {
      const l = b.l;
      const heavy = l.excess > 0.15 * l.cost && l.excess > 0.005 * c.bomTotal;
      const g = sv('g', { class: `cr-blk${l.row === state.line ? ' sel' : ''}${heavy ? ' bad' : ''}`, tabindex: 0, role: 'button', 'data-row': l.row,
        'aria-label': `${l.part}: ${money(l.cost)} ${c.cur} this order, ${money(l.perUnit)} per unit${l.excess ? `, ${money(l.excess)} left over` : ''}` });
      g.append(sv('rect', { class: 'f', x: b.x, y: b.y, width: b.w2, height: b.h2 }));
      const xh = (b.h2 * l.excess) / (l.cost || 1);
      if (xh > 0.5) g.append(sv('rect', { class: 'cr-xs', x: b.x + 1, y: b.y + b.h2 - xh, width: Math.max(0, b.w2 - 2), height: Math.max(0, xh - 1) }));
      g.append(sv('rect', { class: 'o', x: b.x + 1, y: b.y + 1, width: Math.max(0, b.w2 - 2), height: Math.max(0, b.h2 - 2) }));
      const fits = (s, px) => s.length * px < b.w2 - 8;
      if (b.h2 > 18 && b.w2 > 30) {
        let name = l.part;
        while (name.length > 3 && !fits(name, 6)) name = name.slice(0, -2);
        if (name !== l.part) name = name.slice(0, -1) + '…';
        g.append(sv('text', { x: b.x + 5, y: b.y + 14 }, name));
        if (b.h2 > 32 && fits(money(l.perUnit), 6.3)) g.append(sv('text', { x: b.x + 5, y: b.y + 28, class: 'm' }, `${money(l.perUnit)}/u`));
        if (heavy && b.h2 > 46 && fits('MOQ left-over', 6)) g.append(sv('text', { x: b.x + 5, y: b.y + 42, class: 'm bad' }, `${Math.round((100 * l.excess) / l.cost)} % left over`));
      }
      g.append(sv('title', {}, `${l.part}: ${money(l.cost)} ${c.cur} for the order`));
      tm.append(g);
    }
    tm.addEventListener('click', (e) => { const g = e.target.closest('.cr-blk'); if (g) { state.line = +g.dataset.row; render(); side.querySelector('.cr-blk.sel')?.focus({ preventScroll: true }); } });
    tm.addEventListener('keydown', (e) => {
      const g = e.target.closest('.cr-blk'); if (!g) return;
      const order = boxes.map((b) => b.l.row); const i = order.indexOf(+g.dataset.row);
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = order[(i + 1) % order.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = order[(i - 1 + order.length) % order.length];
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.line = +g.dataset.row; render(); side.querySelector('[data-col="part"]')?.focus(); return; }
      if (n == null) return;
      e.preventDefault(); state.line = n; render(); side.querySelector('.cr-blk.sel')?.focus({ preventScroll: true });
    });
    body.append(tm);
    body.append(h('div', { class: 'cr-note' }, 'Block area = what the line costs this order · red hatch = bought but not used (attrition and MOQ)'));

    // the selected line
    const r = rows[state.line];
    const l = lines.find((x) => x.row === state.line);
    if (r) {
      const cell = (col, label, unit, wide) => {
        const inp = h('input', { type: 'text', spellcheck: 'false', 'data-col': col, inputmode: col === 'part' ? null : 'decimal' });
        inp.value = r[col] ?? '';
        inp.addEventListener('input', () => { const rs = rowsNow(); if (!rs[state.line]) return; rs[state.line][col] = inp.value; setRows(rs); });
        return h('label', { class: wide ? 'w' : null }, h('span', {}, label, unit ? h('em', {}, ` ${unit}`) : null), inp);
      };
      body.append(h('div', { class: 'cr-fields' }, cell('part', 'Part', '', true), cell('per', 'Qty per unit'), cell('price', 'Unit price', c.cur), cell('moq', 'MOQ', 'min. buy'), cell('attr', 'Attrition', '%')));
      if (l) {
        const tot = l.buy || 1;
        const used = Math.min(l.used, tot), att = Math.max(0, Math.min(l.need, tot) - used), moq = Math.max(0, tot - Math.max(l.need, used));
        const pc = (v) => `${(100 * v) / tot}%`;
        body.append(h('div', { class: 'cr-reel' },
          h('div', { class: 'k' }, h('span', {}, 'Buy ', h('b', {}, count(l.buy)), ` for ${count(c.built)} built units`), h('span', {}, 'line ', h('b', {}, `${money(l.cost)} ${c.cur}`))),
          h('div', { class: 'bar', role: 'img', 'aria-label': `Of ${count(l.buy)} bought: ${count(l.used)} used, ${count(att)} attrition, ${count(moq)} to reach the MOQ` },
            h('i', { style: `width:${pc(used)};background:var(--tool-c0)` }), h('i', { style: `width:${pc(att)};background:var(--warn)` }), h('i', { style: `width:${pc(moq)};background:var(--danger)` })),
          h('div', { class: 'k' }, h('span', {}, h('i', { style: 'background:var(--tool-c0)' }), 'used ', h('b', {}, count(l.used))),
            h('span', {}, h('i', { style: 'background:var(--warn)' }), 'attrition ', h('b', {}, count(att))),
            h('span', {}, h('i', { style: 'background:var(--danger)' }), 'MOQ extra ', h('b', {}, count(moq))),
            l.excess > 0 ? h('span', { class: 'cr-danger' }, `${money(l.excess)} ${c.cur} left over`) : null)));
      } else body.append(h('div', { class: 'cr-note cr-danger' }, 'This line is not priced: it needs a qty per unit and a unit price (numbers).'));
    }
    body.append(h('div', { class: 'cr-row' },
      h('button', { class: 'k-btn', type: 'button', onclick: () => { const rs = rowsNow(); rs.push({ part: 'New part', per: '1', price: '0.10', moq: '1', attr: '2' }); state.line = rs.length - 1; setRows(rs); side.querySelector('[data-col="part"]')?.select(); } }, '+ Add part'),
      r ? h('button', { class: 'k-btn cr-danger', type: 'button', onclick: () => { const rs = rowsNow(); rs.splice(state.line, 1); state.line = Math.max(0, state.line - 1); setRows(rs); } }, 'Remove this part') : null,
      h('span', { class: 'cr-note' }, `${lines.length} priced line${lines.length === 1 ? '' : 's'} · ${money(c.bomTotal)} ${c.cur} for the order`)));
  }

  // ---------- render ----------
  function render() {
    const res = ctx.result; if (!res) return;
    const c = res.cost || null;
    const refocusHandle = state.refocus === 'handle' || document.activeElement?.closest?.('.cr-handle');
    const segFocus = document.activeElement?.closest?.('.cr-seg-r')?.dataset.cat;
    state.refocus = null;
    drawBar(c);
    drawChart(c);
    drawLegend(c);
    drawSide(c);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (refocusHandle) svg.querySelector('.cr-handle')?.focus({ preventScroll: true });
    else if (segFocus) svg.querySelector(`.cr-seg-r[data-cat="${segFocus}"]`)?.focus({ preventScroll: true });
  }
  new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth - 12);
    if (w > 0 && Math.abs(w - state.W) > 2) { state.W = w; render(); }
  }).observe(stage);
  state.W = Math.max(300, stage.clientWidth - 12 || 800);
  ctx.onResult(() => render());
}
