// Standoff Height: the page is the board standing in its box. A side
// elevation, heights to scale, of the board on its standoffs over the floor
// (or over a second board): the tallest part under it, the through-hole leads
// poking down, the tallest part on top and the enclosure line above it, with
// the air under the lowest point measured against the gap and tolerance you
// ask for. Pull a part's edge to its real height, lift the boss, or drag the
// board itself up and down through the stock lengths. Under it the stock
// drawer, every catalogue standoff standing to one scale against the height
// needed (click one to use it), and the screw joint in section with the
// thread each screw gets. Every number shown comes from run()'s result
// (result.drawing).

const NS = 'http://www.w3.org/2000/svg';
const SCREWS = ['M2', 'M2.5', 'M3', 'M4', 'M5'];
const HEX_AF = { M2: 4, 'M2.5': 5, M3: 5.5, M4: 7, M5: 8 };        // drawing only: hex across flats
const HEAD = { M2: [3.8, 1.6], 'M2.5': [4.5, 2], M3: [5.5, 2.4], M4: [7, 3.1], M5: [8.5, 3.8] }; // pan head dk, k (drawing only)

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
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const q = (v, step) => String(Number((Math.round(v / step) * step).toFixed(3)));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };

const CSS = `
:root { --tool-pcb: #2f7d4f; --tool-pcb-edge: #1f5a37; --tool-part: #4b5663; --tool-part2: #6a5f86; --tool-brass: #c49a3a; --tool-air: #2f855a; --tool-tol: #b7791f; --tool-steel: #8a97a6; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-pcb: #3f9a64; --tool-pcb-edge: #6fd09a; --tool-part: #6d7a88; --tool-part2: #9486bd; --tool-brass: #d9b154; --tool-air: #68b36b; --tool-tol: #e8a735; --tool-steel: #aab6c2; } }
:root[data-theme="dark"] { --tool-pcb: #3f9a64; --tool-pcb-edge: #6fd09a; --tool-part: #6d7a88; --tool-part2: #9486bd; --tool-brass: #d9b154; --tool-air: #68b36b; --tool-tol: #e8a735; --tool-steel: #aab6c2; }
.k-page { padding: 10px 12px; }
.so { display: grid; gap: 10px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(300px, 0.95fr);
  grid-template-rows: auto minmax(300px, 1fr) 250px; grid-template-areas: "bar bar bar" "elev elev elev" "drawer joint out";
  height: calc(100vh - 66px); min-height: 700px; }
.so-bar { grid-area: bar; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.so-elev { grid-area: elev; } .so-drawer { grid-area: drawer; } .so-joint { grid-area: joint; } .so-out { grid-area: out; min-height: 0; display: flex; }
.so-out .k-outwrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.so-out .k-out { flex: 1; max-height: none; min-height: 0; }
.so-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.so-box { position: relative; flex: 1; min-height: 0; }
.so-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.so-head { display: flex; align-items: center; gap: 8px 10px; padding: 7px 10px 0; flex-wrap: wrap; min-height: 26px; }
.so-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.so-hint { margin-left: auto; font-size: 11px; color: var(--ink-soft); }
.so-grp { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.so-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.so-seg button, .so-btn { border: 0; background: transparent; padding: 4px 10px; font-size: 12.5px; color: var(--ink-soft); cursor: pointer; white-space: nowrap; }
.so-seg button + button { border-left: 1px solid var(--line-soft); }
.so-seg button:hover, .so-btn:hover { background: var(--sunken); color: var(--ink); }
.so-seg button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); }
.so-seg.small button { padding: 2px 8px; font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.so-btn { border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.so-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.so-btn.small { padding: 2px 8px; font-size: 12px; }
.so-num { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.so-num input { width: 54px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.so-warns { padding: 0 10px 8px; font-size: 12px; color: var(--danger); display: flex; flex-direction: column; gap: 2px; }
.so-warns:empty { display: none; }
/* drawing */
.so svg text { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.so svg text.v { fill: var(--ink); font-weight: 600; }
.so svg text.bad { fill: var(--danger); font-weight: 600; }
.so svg text.acc { fill: var(--accent); font-weight: 600; }
.so svg text.ok { fill: var(--tool-air); }
.so-floor { fill: url(#so-hatch); stroke: var(--ink-soft); stroke-width: 1; }
.so-hatch-bg { fill: color-mix(in srgb, var(--ink-soft) 14%, var(--surface)); } .so-hatch-ln { stroke: color-mix(in srgb, var(--ink-soft) 55%, transparent); }
.so-pcb { fill: var(--tool-pcb); stroke: var(--tool-pcb-edge); stroke-width: 1; }
.so-pcb.grab { cursor: ns-resize; }
.so-partb { fill: color-mix(in srgb, var(--tool-part) 70%, var(--surface)); stroke: var(--ink); stroke-width: 1; }
.so-partt { fill: color-mix(in srgb, var(--tool-part2) 55%, var(--surface)); stroke: var(--ink); stroke-width: 1; }
.so-lead { stroke: var(--tool-steel); stroke-width: 2.2; stroke-linecap: round; }
.so-hex { fill: color-mix(in srgb, var(--tool-brass) 60%, var(--surface)); stroke: color-mix(in srgb, var(--tool-brass) 70%, var(--ink)); stroke-width: 1; }
.so-hex-ln { stroke: color-mix(in srgb, var(--tool-brass) 80%, var(--ink)); stroke-width: .8; opacity: .6; }
.so-screw { fill: color-mix(in srgb, var(--tool-steel) 55%, var(--surface)); stroke: var(--ink); stroke-width: 1; }
.so-washer { fill: color-mix(in srgb, var(--tool-steel) 30%, var(--surface)); stroke: var(--ink-soft); stroke-width: 1; }
.so-air { fill: var(--tool-air); opacity: .22; } .so-tol { fill: var(--tool-tol); opacity: .3; } .so-short { fill: var(--danger); opacity: .3; }
.so-enc { stroke: var(--ink-soft); stroke-dasharray: 7 4; stroke-width: 1.2; }
.so-dim { stroke: var(--ink-soft); stroke-width: 1; fill: none; } .so-ext { stroke: var(--ink-soft); stroke-width: .7; opacity: .6; }
.so-dimhead { fill: var(--ink-soft); }
.so-h { cursor: ns-resize; outline: none; } .so-h.x { cursor: grab; }
.so-h .ring { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.so-h .halo { fill: var(--accent); opacity: 0; }
.so-h:hover .halo, .so-h:focus-visible .halo { opacity: .22; }
.so-h:focus-visible .ring { stroke: var(--ink); stroke-width: 3; }
.so-need { stroke: var(--danger); stroke-width: 1.4; stroke-dasharray: 6 3; }
.so-stock { cursor: pointer; outline: none; }
.so-stock .body { fill: color-mix(in srgb, var(--tool-brass) 45%, var(--surface)); stroke: color-mix(in srgb, var(--tool-brass) 70%, var(--ink)); }
.so-stock.short .body { fill: color-mix(in srgb, var(--danger) 16%, var(--surface)); stroke: color-mix(in srgb, var(--danger) 55%, var(--line)); }
.so-stock.on .body { stroke: var(--accent); stroke-width: 2.5; }
.so-stock:hover .body { stroke: var(--ink); }
.so-stock:focus-visible .body { stroke: var(--ink); stroke-width: 3; }
.so-stock .sel { fill: var(--accent); }
.so-stock.disabled { cursor: default; opacity: .75; }
.so-band-ok { fill: var(--tool-air); opacity: .25; } .so-band-min { fill: var(--danger); opacity: .18; }
.so-mid { stroke: var(--danger); stroke-width: 1; stroke-dasharray: 3 3; }
.so-thread { stroke: var(--ink-soft); stroke-width: .8; }
.so-conn { fill: color-mix(in srgb, var(--ink-soft) 30%, var(--surface)); stroke: var(--ink); stroke-width: 1; }
@media (max-width: 1100px) {
  .so { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto minmax(320px, 1fr) 250px 260px;
    grid-template-areas: "bar bar" "elev elev" "drawer joint" "out out"; height: auto; min-height: 0; }
  .so-elev { min-height: 420px; }
}
@media (max-width: 680px) {
  .so { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 460px 230px 250px 300px; grid-template-areas: "bar" "elev" "drawer" "joint" "out"; }
}
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  let D = null, res = null;

  // ---------- bar ----------
  const seg = (label, items, onPick, cls) => {
    const g = h('div', { class: `so-seg ${cls || ''}`, role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title,
      onclick: () => onPick(v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
        e.preventDefault(); const i = items.findIndex((x) => x[0] === v); const n = items[clamp(i + d, 0, items.length - 1)][0];
        onPick(n); requestAnimationFrame(() => g.querySelector(`[data-v="${CSS.escape(n)}"]`)?.focus());
      } }, t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const numField = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'so-num', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const modeSeg = seg('Standoff between', [['floor', 'Board over floor'], ['stack', 'Two stacked boards']], (v) => ctx.set('mode', v));
  const fGap = numField('gap', 'air gap', 'mm', 'Air gap to keep');
  const fTol = numField('tol', 'tolerance', 'mm', 'Standoff and part height tolerances together');
  const fT = numField('t', 'board', 'mm', 'Board thickness');
  const fB2b = numField('b2b', 'connector', 'mm', 'Board-to-board connector mated height (empty = none)');
  const fLen = numField('length', 'length', 'mm', 'Standoff length to use (empty = shortest stock)');
  const barFields = h('div', { class: 'so-grp' }, fGap, fTol, fT, fB2b, fLen);
  const bar = h('div', { class: 'so-bar' }, h('div', { class: 'so-grp' }, modeSeg), barFields);

  // ---------- elevation ----------
  const elevSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Side elevation of the board on its standoffs, heights to scale' });
  const elevWarn = h('div', { class: 'so-warns', 'aria-live': 'polite' });
  const elevHint = h('span', { class: 'so-hint' });
  const elev = h('section', { class: 'so-panel so-elev' }, h('div', { class: 'so-head' }, h('span', { class: 'so-cap' }, 'Side elevation · heights to scale'), elevHint),
    h('div', { class: 'so-box' }, elevSvg), elevWarn);

  // ---------- stock drawer ----------
  const drawerSvg = sv(null, 'svg', { role: 'radiogroup', 'aria-label': 'Stock standoff lengths' });
  const autoBtn = h('button', { type: 'button', class: 'so-btn small', title: 'Use the shortest stock length that fits', onclick: () => ctx.set('length', '') }, 'Shortest that fits');
  const drawer = h('section', { class: 'so-panel so-drawer' }, h('div', { class: 'so-head' }, h('span', { class: 'so-cap' }, 'Stock drawer · to one scale'), h('span', { class: 'so-hint' }, autoBtn)),
    h('div', { class: 'so-box' }, drawerSvg));

  // ---------- joint ----------
  const screwSeg = seg('Screw', SCREWS.map((s) => [s, s, `${s} screw`]), (v) => ctx.set('screw', v), 'small');
  const washerBtn = h('button', { type: 'button', class: 'so-btn small', 'aria-pressed': 'false', onclick: () => ctx.set('washer', !ctx.raw.washer) }, 'washer');
  const jointSvg = sv(null, 'svg', { role: 'img', 'aria-label': 'Section through one female standoff with its two screws' });
  const joint = h('section', { class: 'so-panel so-joint' }, h('div', { class: 'so-head' }, h('span', { class: 'so-cap' }, 'Screw joint'), screwSeg, washerBtn),
    h('div', { class: 'so-box' }, jointSvg));
  const out = h('section', { class: 'so-out' }, ctx.outputs);

  const layout = h('div', { class: 'so' }, bar, elev, drawer, joint, out);
  root.append(layout);

  // ---------- elevation drawing ----------
  let E = null, drag = null, focusKey = null;
  function drawElev() {
    const svg = elevSvg; svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 900), Hh = Math.max(260, svg.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!D) return;
    const narrow = W < 560;
    const stack = D.mode === 'stack';
    const floorT = 3;
    // heights (mm, 0 = floor top, or lower board bottom in a stack)
    const lowT = stack ? D.t : 0;                 // lower board occupies 0..t
    const sBase = stack ? lowT : D.boss;          // standoff foot
    const bBot = sBase + D.L, bTop = bBot + D.t;  // upper / the board
    const topH = stack ? 0 : D.top;
    const Hmax = (stack ? bTop + 3 : bTop + topH + 3.5);
    const mT = 26, mB = 30;
    let sc = (Hh - mT - mB) / (Hmax + floorT);
    // scale and floor hold still while something is dragged (the warnings under
    // the drawing come and go and would move the floor under the pointer)
    const base = drag && E ? E.base : Hh - mB;
    if (drag && E) sc = E.sc;
    const Y = (z) => base - (z + floorT) * sc;
    const mL = narrow ? 8 : 20, mR = narrow ? 92 : 250;
    const x0 = mL + 10, x1 = W - mR;          // board extent (schematic in x)
    const bw = x1 - x0;
    E = { sc, Y, x0, x1, base, floorT };

    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'so-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 7, height: 7, class: 'so-hatch-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'so-hatch-ln' });
    const mk = sv(defs, 'marker', { id: 'so-ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'so-dimhead' });

    const rect = (xa, za, xb, zb, cls, extra = {}) => sv(svg, 'rect', { x: Math.min(xa, xb), y: Y(Math.max(za, zb)), width: Math.abs(xb - xa), height: Math.abs(zb - za) * sc, class: cls, ...extra });
    const af = HEX_AF[D.screw.name] || 5.5;
    const sw = Math.min(af * sc, bw * 0.12);   // hex width to scale, narrowed on a small screen
    const hsc = sw / af;
    const sx = [x0 + sw / 2 + 12, x1 - sw / 2 - 12];
    // floor, or the lower board
    if (!stack) {
      rect(mL, -floorT, W - (narrow ? 8 : mR - 60), 0, 'so-floor');
      if (D.boss > 0) for (const x of sx) rect(x - sw * 0.9, 0, x + sw * 0.9, D.boss, 'so-floor');
      sv(svg, 'text', { x: mL + 4, y: Y(-floorT) - 6 }, 'floor');
    } else {
      rect(mL, -floorT, W - (narrow ? 8 : mR - 60), 0, 'so-floor', { opacity: 0.35 });
      rect(x0, 0, x1, lowT, 'so-pcb');
      sv(svg, 'text', { x: x0 + 6, y: Y(0) + 13, class: 'v' }, 'lower board');
    }
    // standoffs
    for (const x of sx) {
      rect(x - sw / 2, sBase, x + sw / 2, bBot, 'so-hex');
      for (const f of [-0.25, 0.25]) sv(svg, 'line', { x1: x + f * sw, x2: x + f * sw, y1: Y(bBot), y2: Y(sBase), class: 'so-hex-ln' });
      // screw heads on top
      const [dk, k] = HEAD[D.screw.name] || HEAD.M3;
      const wz = bTop + D.screw.washerT;
      if (D.screw.washerT) rect(x - dk * 0.62 * hsc, bTop, x + dk * 0.62 * hsc, wz, 'so-washer');
      sv(svg, 'path', { d: `M${x - dk / 2 * hsc},${Y(wz)} L${x - dk / 2 * hsc},${Y(wz + k * 0.6)} Q${x},${Y(wz + k * 1.15)} ${x + dk / 2 * hsc},${Y(wz + k * 0.6)} L${x + dk / 2 * hsc},${Y(wz)} Z`, class: 'so-screw' });
    }
    // the board (drag it: tries other lengths)
    const brd = rect(x0, bBot, x1, bTop, `so-pcb${D.fixed ? '' : ' grab'}`, { 'data-h': D.fixed ? null : 'board' });
    void brd;
    sv(svg, 'text', { x: x0 + 6, y: Y(bTop) - 4, class: 'v' }, stack ? 'upper board' : 'board');

    // parts
    const px = (f) => x0 + bw * f;
    const lowest = stack ? null : Math.max(D.under, D.leads);
    if (!stack) {
      // bottom SMD part
      const bx0 = px(0.26), bx1 = px(0.26) + Math.max(40, bw * 0.12);
      if (D.under > 0) rect(bx0, bBot - D.under, bx1, bBot, 'so-partb');
      // top THT part with its leads through the board
      const tx0 = px(0.55), tx1 = tx0 + Math.max(36, bw * 0.08);
      if (D.top > 0) sv(svg, 'rect', { x: tx0, y: Y(bTop + D.top), width: tx1 - tx0, height: D.top * sc, rx: 3, class: 'so-partt' });
      for (const lx of [tx0 + (tx1 - tx0) * 0.3, tx0 + (tx1 - tx0) * 0.7]) sv(svg, 'line', { x1: lx, x2: lx, y1: Y(bBot), y2: Y(bBot - D.leads), class: 'so-lead' });
      // air under the lowest point: asked gap, tolerance, and what is left (or missing)
      const lowX = D.under >= D.leads ? (bx0 + bx1) / 2 : tx0 + (tx1 - tx0) / 2;
      const zLow = bBot - lowest;
      const cx0 = lowX + (narrow ? 26 : 44), cw = 16;
      const g = D.gap, tl = D.tol, air = D.clear;
      if (air >= 0) {
        const gz = Math.min(g, air);
        rect(cx0, zLow - gz, cx0 + cw, zLow, 'so-air');
        if (air > g) rect(cx0, zLow - Math.min(g + tl, air), cx0 + cw, zLow - g, 'so-tol');
        if (air < g) rect(cx0, zLow - g, cx0 + cw, zLow - air, 'so-short');
      }
      sv(svg, 'line', { x1: lowX, x2: cx0 + cw + 4, y1: Y(zLow), y2: Y(zLow), class: 'so-ext' });
      sv(svg, 'line', { x1: cx0 + cw + 8, x2: cx0 + cw + 8, y1: Y(zLow), y2: Y(0), class: 'so-dim', 'marker-start': 'url(#so-ah)', 'marker-end': 'url(#so-ah)' });
      const airBad = air < g - 1e-9;
      sv(svg, 'text', { x: cx0 + cw + 14, y: Y(zLow / 2) - 2, class: airBad ? 'bad' : 'v' }, `air ${f3(air)}`);
      if (!narrow) sv(svg, 'text', { x: cx0 + cw + 14, y: Y(zLow / 2) + 12 }, `gap ${f3(g)} + tol ${f3(tl)}`);
      // part labels
      if (!narrow) {
        sv(svg, 'text', { x: bx0, y: Y(bBot - D.under) + 14 }, `under ${f3(D.under)}`);
        sv(svg, 'text', { x: tx1 + 6, y: Y(bTop + D.top) + 12 }, `top ${f3(D.top)}`);
        sv(svg, 'text', { x: tx1 + 6, y: Y(bBot - D.leads) + 4 }, `leads ${f3(D.leads)}`);
      }
      // the enclosure line
      sv(svg, 'line', { x1: mL, x2: x1 + 30, y1: Y(D.topHeight), y2: Y(D.topHeight), class: 'so-enc' });
      sv(svg, 'text', { x: mL + 4, y: Y(D.topHeight) - 5 }, narrow ? `inside ≥ ${f3(D.topHeight)}` : `enclosure inside ≥ ${f3(D.topHeight)} mm`);
      // handles
      handle('under', bx0 + (bx1 - bx0) / 2, Y(bBot - D.under), 'Tallest part under the board', `${f3(D.under)} mm`);
      handle('leads', tx0 + (tx1 - tx0) * 0.3, Y(bBot - D.leads), 'Through-hole lead protrusion', `${f3(D.leads)} mm`);
      handle('top', tx0 + (tx1 - tx0) / 2, Y(bTop + D.top), 'Tallest part on top', `${f3(D.top)} mm`);
      handle('boss', sx[0] + sw * 0.9 + 12, Y(D.boss), 'Floor boss height', `${f3(D.boss)} mm`);
    } else {
      // lower board's top part, upper board's bottom part (over it, or beside it)
      const lx0 = px(0.3), lx1 = lx0 + Math.max(44, bw * 0.12);
      rect(lx0, lowT, lx1, lowT + D.lowerTop, 'so-partt');
      const ux0 = D.overlap ? lx0 + 8 : px(0.56), ux1 = ux0 + Math.max(44, bw * 0.12);
      rect(ux0, bBot - D.upperBottom, ux1, bBot, 'so-partb', { 'data-h': 'overlap', style: 'cursor:ew-resize' });
      sv(svg, 'text', { x: lx1 + 6, y: Y(lowT + D.lowerTop) + 12 }, `lower top ${f3(D.lowerTop)}`);
      sv(svg, 'text', { x: ux1 + 6, y: Y(bBot - D.upperBottom) - 4 }, `upper bottom ${f3(D.upperBottom)}`);
      sv(svg, 'text', { x: ux1 + 6, y: Y(bBot - D.upperBottom) + 10, class: D.overlap ? '' : 'ok' }, D.overlap ? 'over the lower part: drag aside' : 'apart in x/y: drag over');
      // air between the two parts (or between the taller part and the other board)
      const air = D.clear;
      // overlapping: between the two parts; apart: between the taller part and the other board
      const lowerTaller = D.lowerTop >= D.upperBottom;
      const cx = (D.overlap || lowerTaller ? lx1 : ux1) + (narrow ? 12 : 60);
      const zA = D.overlap || lowerTaller ? lowT + D.lowerTop : lowT;
      const zB = D.overlap ? bBot - D.upperBottom : lowerTaller ? bBot : bBot - D.upperBottom;
      if (air >= 0) {
        rect(cx, zA, cx + 16, zA + Math.min(D.gap, air), 'so-air', { transform: null });
        if (air < D.gap) rect(cx, zA + air, cx + 16, zA + D.gap, 'so-short');
      }
      sv(svg, 'line', { x1: cx + 22, x2: cx + 22, y1: Y(zA), y2: Y(zB), class: 'so-dim', 'marker-start': 'url(#so-ah)', 'marker-end': 'url(#so-ah)' });
      sv(svg, 'text', { x: cx + 28, y: Y((zA + zB) / 2) + 4, class: air < D.gap - 1e-9 ? 'bad' : 'v' }, `air ${f3(air)}`);
      // board-to-board connector
      if (D.b2b != null) {
        const cx0 = px(0.8), cx1 = cx0 + Math.max(30, bw * 0.06);
        rect(cx0, lowT, cx1, lowT + D.b2b * 0.55, 'so-conn');
        rect(cx0 + 3, lowT + D.b2b * 0.55, cx1 - 3, lowT + D.b2b, 'so-conn');
        sv(svg, 'text', { x: cx0 - 6, y: Y(lowT + D.b2b / 2) + 4, 'text-anchor': 'end' }, `connector ${f3(D.b2b)}`);
        if (D.b2b < D.need - 1e-9) sv(svg, 'text', { x: cx0 - 6, y: Y(lowT + D.b2b / 2) + 18, 'text-anchor': 'end', class: 'bad' }, 'boards collide');
      }
      handle('lowerTop', (lx0 + lx1) / 2, Y(lowT + D.lowerTop), 'Lower board: tallest top part', `${f3(D.lowerTop)} mm`);
      handle('upperBottom', (ux0 + ux1) / 2, Y(bBot - D.upperBottom), 'Upper board: tallest bottom part', `${f3(D.upperBottom)} mm`);
    }
    // dimension chain on the right: boss, standoff, board, top part
    const dx = x1 + (narrow ? 20 : 60);
    const chain = stack ? [[0, lowT, 't'], [lowT, bBot, D.fixed ? 'L = connector' : D.chosen ? 'L chosen' : 'L stock'], [bBot, bTop, 't']]
      : [...(D.boss > 0 ? [[0, D.boss, 'boss']] : []), [sBase, bBot, D.chosen ? 'L chosen' : 'L stock'], [bBot, bTop, 't'], [bTop, bTop + D.top, 'top']];
    for (const [za, zb, name] of chain) {
      if (zb - za <= 0) continue;
      sv(svg, 'line', { x1: dx - 6, x2: dx + 6, y1: Y(za), y2: Y(za), class: 'so-ext' });
      sv(svg, 'line', { x1: dx, x2: dx, y1: Y(za), y2: Y(zb), class: 'so-dim', 'marker-start': (zb - za) * sc > 14 ? 'url(#so-ah)' : null, 'marker-end': (zb - za) * sc > 14 ? 'url(#so-ah)' : null });
      if (!narrow || name.startsWith('L')) {
        const isL = name.startsWith('L');
        sv(svg, 'text', { x: dx + 10, y: Y((za + zb) / 2) + 4, class: isL ? (D.clear < D.gap - 1e-9 ? 'bad' : 'acc') : '' }, `${name} ${f3(zb - za)}`);
      }
    }
    sv(svg, 'line', { x1: dx - 6, x2: dx + 6, y1: Y(chain[chain.length - 1][1]), y2: Y(chain[chain.length - 1][1]), class: 'so-ext' });
    if (!narrow && !stack) sv(svg, 'text', { x: dx + 10, y: Y(bBot) + 22 }, `min ${f3(D.need)}`);
    if (!narrow && stack) sv(svg, 'text', { x: dx + 10, y: Y(bTop) - 10 }, `pitch ${f3(D.pitch)}`);
    // the need line: where the board bottom must at least be
    const zNeed = sBase + D.need;
    sv(svg, 'line', { x1: x0 - 6, x2: dx - 8, y1: Y(zNeed), y2: Y(zNeed), class: 'so-need' });
    if (!D.fixed) handle('board', sx[0] + sw / 2 + 18, Y((bBot + bTop) / 2), 'Board height: drag through the stock lengths', `${f3(D.L)} mm standoff`, 'x');
    elevHint.textContent = stack ? 'drag the part edges · drag the upper part sideways to say whether it sits over the lower one · drag the board for another length'
      : 'drag the part edges, the lead tips, the boss · drag the board up and down through the stock lengths · dashed red: lowest the board may sit';
    if (focusKey) { svg.querySelector(`[data-h="${focusKey}"]`)?.focus(); focusKey = null; }

    function handle(key, x, y, label, vt, cls) {
      const g = sv(svg, 'g', { class: `so-h ${cls || ''}`, tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': label, 'aria-valuetext': vt });
      sv(g, 'circle', { cx: x, cy: y, r: 12, class: 'halo' });
      sv(g, 'circle', { cx: x, cy: y, r: 5.5, class: 'ring' });
    }
  }
  const zAt = (e) => { const r = elevSvg.getBoundingClientRect(), vb = elevSvg.viewBox.baseVal; return [(e.clientX - r.left) / r.width * vb.width, (E.base - (e.clientY - r.top) / r.height * vb.height) / E.sc - E.floorT]; };
  const stockNear = (L) => D.stock.reduce((a, b) => (Math.abs(b.L - L) < Math.abs(a.L - L) ? b : a)).L;
  elevSvg.addEventListener('pointerdown', (e) => {
    if (!D || !E) return;
    const g = e.target.closest('[data-h]'); if (!g) return;
    const [x, z] = zAt(e);
    drag = { key: g.dataset.h, x, z, D: { ...D } };
    capture(elevSvg, e); e.preventDefault(); if (g.focus) g.focus();
  });
  elevSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, z] = zAt(e), dz = z - drag.z, s = drag.D;
    const set = (k, v) => { if (String(ctx.raw[k]) !== v) ctx.set(k, v); };
    switch (drag.key) {
      case 'under': set('under', q(clamp(s.under - dz, 0, 60), 0.1)); break;
      case 'leads': set('leads', q(clamp(s.leads - dz, 0, 6), 0.1)); break;
      case 'top': set('top', q(clamp(s.top + dz, 0, 120), 0.5)); break;
      case 'boss': set('boss', q(clamp(s.boss + dz, 0, 30), 0.5)); break;
      case 'lowerTop': set('lowerTop', q(clamp(s.lowerTop + dz, 0, 60), 0.1)); break;
      case 'upperBottom': set('upperBottom', q(clamp(s.upperBottom - dz, 0, 60), 0.1)); break;
      case 'board': { const L = stockNear(Math.max(3, s.L + dz)); set('length', String(L)); break; }
      case 'overlap': {
        const moved = x - drag.x;
        if (Math.abs(moved) > 24) { const want = s.overlap ? false : true; if (ctx.raw.overlap !== want) ctx.set('overlap', want); }
        break;
      }
      default:
    }
  });
  const endDrag = () => { if (drag) { drag = null; drawElev(); } };
  elevSvg.addEventListener('pointerup', endDrag); elevSvg.addEventListener('pointercancel', endDrag);
  elevSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-h]'); if (!g || !D) return;
    const k = g.dataset.h;
    if (k === 'overlap' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.set('overlap', !D.overlap); return; }
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key]; if (!d) return;
    e.preventDefault(); focusKey = k;
    // up always means taller part / higher edge on the drawing
    if (k === 'under') ctx.set('under', q(clamp(D.under - d * 0.1, 0, 60), 0.1));
    if (k === 'leads') ctx.set('leads', q(clamp(D.leads - d * 0.1, 0, 6), 0.1));
    if (k === 'top') ctx.set('top', q(clamp(D.top + d * 0.5, 0, 120), 0.5));
    if (k === 'boss') ctx.set('boss', q(clamp(D.boss + d * 0.5, 0, 30), 0.5));
    if (k === 'lowerTop') ctx.set('lowerTop', q(clamp(D.lowerTop + d * 0.1, 0, 60), 0.1));
    if (k === 'upperBottom') ctx.set('upperBottom', q(clamp(D.upperBottom - d * 0.1, 0, 60), 0.1));
    if (k === 'board') {
      const i = D.stock.findIndex((s) => s.L >= D.L - 1e-9);
      const n = D.stock[clamp((D.stock[i]?.L === D.L ? i : i - (d > 0 ? 1 : 0)) + Math.sign(d), 0, D.stock.length - 1)];
      ctx.set('length', String(n.L));
    }
  });

  // ---------- stock drawer ----------
  let focusStock = null;
  function drawDrawer() {
    const svg = drawerSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 500), Hh = Math.max(150, svg.clientHeight || 200);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!D) return;
    const lo = Math.max(3, D.need - 6), hiNeed = D.need + (W < 420 ? 10 : 22);
    let items = D.stock.filter((s) => s.L >= lo - 1e-9 && s.L <= hiNeed + 1e-9);
    const maxN = Math.max(6, Math.floor((W - 40) / 30));
    if (items.length > maxN) items = items.slice(0, maxN);
    if (!items.length) items = D.stock.slice(-6);
    const Lmax = Math.max(...items.map((s) => s.L), D.need, D.L) * 1.05;
    const mB = 36, mT = 24, sc = (Hh - mB - mT) / Lmax;
    const Y = (z) => Hh - mB - z * sc;
    const pitch = (W - 50) / items.length, bw = Math.min(18, pitch * 0.55);
    sv(svg, 'line', { x1: 36, x2: W - 6, y1: Y(0), y2: Y(0), class: 'so-ext' });
    // need line
    sv(svg, 'line', { x1: 36, x2: W - 6, y1: Y(D.need), y2: Y(D.need), class: 'so-need' });
    sv(svg, 'text', { x: 6, y: Y(D.need) + 4, class: 'bad' }, f3(D.need));
    sv(svg, 'text', { x: 6, y: Y(D.need) + 18 }, 'need');
    const cur = D.L;
    items.forEach((s, i) => {
      const x = 44 + pitch * i + (pitch - bw) / 2;
      const on = Math.abs(s.L - cur) < 1e-6;
      const g = sv(svg, 'g', { class: `so-stock${s.ok ? '' : ' short'}${on ? ' on' : ''}${D.fixed ? ' disabled' : ''}`, tabindex: on || (!items.some((t) => Math.abs(t.L - cur) < 1e-6) && i === 0) ? 0 : -1,
        role: 'radio', 'aria-checked': String(on), 'data-l': s.L, 'aria-label': `${s.L} mm standoff, ${f3(s.air)} mm air${s.ok ? '' : ', too short'}` });
      sv(g, 'rect', { x: x - (pitch - bw) / 2, y: mT - 10, width: pitch, height: Hh - mT, fill: 'transparent' });
      sv(g, 'rect', { x, y: Y(s.L), width: bw, height: s.L * sc, rx: 1.5, class: 'body' });
      for (const f of [0.3, 0.7]) sv(g, 'line', { x1: x + bw * f, x2: x + bw * f, y1: Y(s.L) + 1, y2: Y(0) - 1, class: 'so-hex-ln' });
      sv(g, 'text', { x: x + bw / 2, y: Y(0) + 14, 'text-anchor': 'middle', class: on ? 'acc' : s.ok ? '' : 'bad' }, String(s.L));
      if (on) sv(g, 'path', { d: `M${x + bw / 2},${Y(s.L) - 4} l-5,-7 h10 z`, class: 'sel' });
      if (on && pitch > 40) sv(g, 'text', { x: x + bw / 2, y: Y(0) + 28, 'text-anchor': 'middle' }, `${f3(s.air)} air`);
    });
    if (!items.some((s) => Math.abs(s.L - cur) < 1e-6)) sv(svg, 'text', { x: W - 8, y: mT, 'text-anchor': 'end', class: 'acc' }, `${D.fixed ? 'connector' : 'chosen'} ${f3(cur)} mm (not stock)`);
    else if (!items.some((s) => Math.abs(s.L - cur) < 1e-6 && !s.ok) && D.fixed) sv(svg, 'text', { x: W - 8, y: mT, 'text-anchor': 'end' }, 'set by the connector');
    sv(svg, 'text', { x: 6, y: Hh - 8 }, 'mm');
    if (focusStock != null) { svg.querySelector(`[data-l="${focusStock}"]`)?.focus(); focusStock = null; }
  }
  drawerSvg.addEventListener('click', (e) => { const g = e.target.closest('[data-l]'); if (!g || !D || D.fixed) return; ctx.set('length', g.dataset.l); });
  drawerSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-l]'); if (!g || !D || D.fixed) return;
    const list = [...drawerSvg.querySelectorAll('[data-l]')];
    const i = list.indexOf(g);
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    let n = null;
    if (d) n = list[clamp(i + d, 0, list.length - 1)].dataset.l;
    else if (e.key === 'Enter' || e.key === ' ') n = g.dataset.l;
    if (n == null) return; e.preventDefault(); focusStock = n; ctx.set('length', n);
  });

  // ---------- joint ----------
  function drawJoint() {
    const svg = jointSvg; svg.replaceChildren();
    const W = Math.max(240, svg.clientWidth || 380), Hh = Math.max(150, svg.clientHeight || 200);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!D) return;
    const s = D.screw, d = s.d, L = D.L, t = D.t;
    const [dk, k] = HEAD[s.name] || HEAD.M3;
    const af = HEX_AF[s.name] || 5.5;
    // lying on its side: x along the standoff axis, board on the left, panel on the right
    const span = t + s.washerT + k + L + 2 + k + s.washerT;
    const sc = Math.min((W - 30) / span, (Hh - 64) / (af * 1.6));
    const cy = (Hh - 20) / 2 + 4;
    const X0 = 15 + k * sc + s.washerT * sc;   // board outer face
    const X = (mm) => X0 + mm * sc;            // 0 = board outer face; standoff from t to t+L
    const Yr = (r) => cy - r * sc;
    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'so-hatch2', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 6, height: 6, class: 'so-hatch-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'so-hatch-ln' });
    const mk = sv(defs, 'marker', { id: 'so-ah2', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'so-dimhead' });
    // board and the far panel (the floor or the other board), cut
    sv(svg, 'rect', { x: X(0), y: Yr(af * 0.95), width: t * sc, height: af * 1.9 * sc, class: 'so-pcb' });
    sv(svg, 'rect', { x: X(t + L), y: Yr(af * 0.95), width: t * sc, height: af * 1.9 * sc, class: 'so-pcb', opacity: 0.55 });
    // standoff body in section, with its internal thread from each end
    sv(svg, 'rect', { x: X(t), y: Yr(af / 2), width: L * sc, height: af * sc, fill: 'url(#so-hatch2)', stroke: 'var(--ink-soft)' });
    sv(svg, 'rect', { x: X(t), y: Yr(d / 2), width: L * sc, height: d * sc, fill: 'var(--surface)', stroke: 'none' });
    for (const r of [d / 2, -d / 2]) sv(svg, 'line', { x1: X(t), x2: X(t + L), y1: Yr(r * 0.82), y2: Yr(r * 0.82), class: 'so-thread' });
    // engagement bands: at least 0.5 d, full strength 1.5 d (from each end)
    const band = (from, len, cls, dir) => sv(svg, 'rect', { x: dir > 0 ? X(from) : X(from - len), y: Yr(af / 2) - 7, width: len * sc, height: 5, class: cls });
    band(t, Math.min(s.min, L / 2), 'so-band-min', 1); band(t + Math.min(s.min, L / 2), Math.max(0, Math.min(s.target, L / 2) - s.min), 'so-band-ok', 1);
    band(t + L, Math.min(s.min, L / 2), 'so-band-min', -1); band(t + L - Math.min(s.min, L / 2), Math.max(0, Math.min(s.target, L / 2) - s.min), 'so-band-ok', -1);
    // mid line: the two screw tips may not meet
    sv(svg, 'line', { x1: X(t + L / 2), x2: X(t + L / 2), y1: Yr(af / 2) - 10, y2: Yr(-af / 2) + 4, class: 'so-mid' });
    // screws, from both ends, if one fits
    if (s.len) {
      for (const side of [1, -1]) {
        const face = side > 0 ? 0 : t + L + t;     // outer face of the plate it goes through
        const hx = side > 0 ? X(face - s.washerT) : X(face + s.washerT);
        if (s.washerT) sv(svg, 'rect', { x: side > 0 ? X(face - s.washerT) : X(face), y: Yr(dk * 0.62), width: s.washerT * sc, height: dk * 1.24 * sc, class: 'so-washer' });
        const tip = side > 0 ? X(face - s.washerT + s.len) : X(face + s.washerT - s.len);
        sv(svg, 'rect', { x: Math.min(hx, tip), y: Yr(d / 2), width: Math.abs(tip - hx), height: d * sc, class: 'so-screw' });
        const hk = k * sc;
        sv(svg, 'path', { d: side > 0
          ? `M${hx},${Yr(dk / 2)} L${hx - hk * 0.6},${Yr(dk / 2)} Q${hx - hk * 1.15},${cy} ${hx - hk * 0.6},${Yr(-dk / 2)} L${hx},${Yr(-dk / 2)} Z`
          : `M${hx},${Yr(dk / 2)} L${hx + hk * 0.6},${Yr(dk / 2)} Q${hx + hk * 1.15},${cy} ${hx + hk * 0.6},${Yr(-dk / 2)} L${hx},${Yr(-dk / 2)} Z`, class: 'so-screw' });
      }
    }
    // labels
    const eBad = !s.len, eWarn = s.len && s.eng < d;
    sv(svg, 'line', { x1: X(t), x2: X(t + (s.len ? s.eng : 0)), y1: Yr(-af / 2) + 12, y2: Yr(-af / 2) + 12, class: 'so-dim', 'marker-start': 'url(#so-ah2)', 'marker-end': 'url(#so-ah2)' });
    sv(svg, 'text', { x: 8, y: 16, class: eBad ? 'bad' : 'v' }, s.len ? `${s.name} × ${f3(s.len)} screw, each end` : `no stock ${s.name} screw fits a ${f3(L)} mm standoff`);
    sv(svg, 'text', { x: 8, y: Hh - 24, class: eBad ? 'bad' : eWarn ? 'bad' : 'ok' }, s.len ? `thread ${f3(s.eng)} mm = ${f3(s.eng / d)}·d` : `under ${f3(s.min)} mm (0.5·d) of thread each`);
    sv(svg, 'text', { x: 8, y: Hh - 9 }, `aim 1.5·d = ${f3(s.target)} · at most ${f3(s.engMax)} (half, less 0.1)`);
  }

  // ---------- all ----------
  function draw() {
    const raw = ctx.raw;
    modeSeg.sync(raw.mode); screwSeg.sync(raw.screw);
    washerBtn.setAttribute('aria-pressed', String(!!raw.washer));
    fGap.sync(raw.gap); fTol.sync(raw.tol); fT.sync(raw.t); fB2b.sync(raw.b2b); fLen.sync(raw.length);
    fB2b.style.display = raw.mode === 'stack' ? '' : 'none';
    autoBtn.disabled = !(raw.length !== '' && raw.length != null);
    const warns = res?.warnings || [];
    elevWarn.replaceChildren(...warns.map((w) => h('div', {}, w)));
    if (!D) { elevSvg.replaceChildren(); drawerSvg.replaceChildren(); jointSvg.replaceChildren(); return; }
    drawElev(); drawDrawer(); drawJoint();
  }
  ctx.onResult((r) => { res = r; D = r.drawing || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [elevSvg, drawerSvg, jointSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !D) return; sizes = now; drawElev(); drawDrawer(); drawJoint();
    });
  }).observe(layout);
}
