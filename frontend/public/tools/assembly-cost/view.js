// Assembly Cost: the page is the order on the assembly line.
//   Line     - one reel per BOM line on the feeder bank (the extended ones,
//              which cost a loading fee, in colour: click a reel to make that
//              many extended), and the board going down the conveyor with its
//              placements, through-hole parts and fine-pitch parts. Drag across
//              the board to add or remove placements. What each costs is
//              written where it happens.
//   Quantity - per-board assembly cost against the run size: the recurring
//              floor and the one-off charges spread over the boards above it.
//              Drag the run size along it.
//   Receipt  - the bill, line by line; point at a line to see what it charges
//              for on the drawing.
// Every amount shown comes from run()'s result.cost; the page only draws it.

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
const usd = (v) => (v == null || !Number.isFinite(v) ? '–' : v >= 10000 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rate = (v) => String(Number(Number(v).toPrecision(3)));
const int = (v) => Math.round(v).toLocaleString('en-US');
// a small seeded generator, so the board's parts sit still between redraws
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const HOUSES = [['econ', 'Online · economic'], ['std', 'Online · standard'], ['cm', 'Contract manufacturer']];
const QTY_LADDER = [1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000, 7500, 10000];
const MAX_REELS = 150, MAX_DOTS = 700;
const Q_LO = 1, Q_HI = 10000;

const CSS = `
.ac { --tool-mask: #2f7a4f; --tool-mask-edge: #256240; --tool-pad: #d9dde2; --tool-ext: var(--tool-s1); --tool-once: var(--tool-s1); --tool-rec: var(--tool-s2); --tool-reel: #eef1f4; --tool-ic: #1f262d;
  display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; align-items: start; }
:root[data-theme="dark"] .ac { --tool-mask: #1f5a3a; --tool-mask-edge: #2f7a4f; --tool-pad: #c9ced4; --tool-reel: #1d2731; --tool-ic: #0b1015; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ac { --tool-mask: #1f5a3a; --tool-mask-edge: #2f7a4f; --tool-pad: #c9ced4; --tool-reel: #1d2731; --tool-ic: #0b1015; } }
.ac-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ac-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ac-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ac-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); min-height: 38px; }
.ac-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.ac-sub { color: var(--ink-soft); font-size: 11.5px; }
.ac-grow { flex: 1; }
.ac-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.ac-seg button { border: 0; background: transparent; padding: 2px 9px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.ac-seg button + button { border-left: 1px solid var(--line); }
.ac-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.ac-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.ac-draw svg { display: block; width: 100%; }
.ac-strip { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 6px 10px 8px; border-top: 1px solid var(--line-soft); }
.ac-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.ac-f input { width: 54px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); text-align: right; }
.ac-f input.bad { border-color: var(--danger); }
.ac-f.q input { width: 68px; font-weight: 600; }
.ac-chip { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 0 8px; font-size: 11px; cursor: pointer; color: var(--ink-soft); }
.ac-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
/* receipt */
.ac-rcpt { font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; padding: 10px 14px 12px; border-top: 3px dotted var(--line); }
.ac-rcpt .hd { font: 600 11px "IBM Plex Sans", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-soft); margin: 8px 0 2px; display: flex; justify-content: space-between; }
.ac-rcpt .hd:first-child { margin-top: 0; }
.ac-rcpt .row { display: flex; gap: 6px; align-items: baseline; padding: 0 4px; margin: 0 -4px; border-radius: 3px; cursor: default; }
.ac-rcpt .row .k { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ac-rcpt .row .d { flex: 1; border-bottom: 1px dotted var(--line); transform: translateY(-3px); min-width: 8px; }
.ac-rcpt .row .v { white-space: nowrap; }
.ac-rcpt .row .n { color: var(--ink-soft); font-size: 11px; white-space: nowrap; }
.ac-rcpt .row.zero { color: var(--ink-soft); }
.ac-rcpt .row[data-k]:hover, .ac-rcpt .row.hl { background: var(--sunken); }
.ac-rcpt .sum { border-top: 1px solid var(--ink-soft); margin-top: 3px; padding-top: 2px; font-weight: 600; }
.ac-rcpt .tot { font-size: 15px; font-weight: 600; margin-top: 8px; border-top: 2px solid var(--ink); padding-top: 4px; }
.ac-rcpt .tot .v { color: var(--ok); }
.ac-rcpt .once::before, .ac-rcpt .rec::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.ac-rcpt .once::before { background: var(--tool-once); } .ac-rcpt .rec::before { background: var(--tool-rec); }
.ac-rcpt .foot { color: var(--ink-soft); font: 11px "IBM Plex Sans", sans-serif; margin-top: 8px; }
.ac-side .k-out { max-height: 170px; }
.ac-warns:empty { display: none; }
@media (max-width: 1040px) { .ac { grid-template-columns: minmax(0, 1fr); } }
/* drawing */
.ac svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.ac svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.ac svg .b { font-weight: 600; } .ac svg .sm { font-size: 10px; } .ac svg .soft { fill: var(--ink-soft); }
.ac svg .money { fill: var(--ink); font-weight: 600; }
.ac svg .once-t { fill: var(--tool-once); } .ac svg .rec-t { fill: var(--tool-rec); }
.ac svg .bank { fill: var(--sunken); stroke: var(--line); }
.ac svg g.reels { outline: none; cursor: pointer; }
.ac svg g.reels:focus-visible .bank { stroke: var(--accent); stroke-width: 2; }
.ac svg .reel { fill: var(--tool-reel); stroke: var(--ink-soft); stroke-width: 1; }
.ac svg .reel.ext { fill: var(--tool-ext); stroke: var(--tool-ext); fill-opacity: .85; }
.ac svg .hub { fill: var(--surface); stroke: var(--ink-soft); stroke-width: .8; }
.ac svg .reel-hit:hover + .reel { stroke: var(--accent); stroke-width: 2; }
.ac svg g.btn { cursor: pointer; outline: none; }
.ac svg g.btn rect { fill: var(--surface); stroke: var(--line); }
.ac svg g.btn:hover rect, .ac svg g.btn:focus-visible rect { stroke: var(--accent); stroke-width: 1.5; }
.ac svg g.btn text { font-weight: 600; }
.ac svg .conv { stroke: var(--line); stroke-width: 1; }
.ac svg .roller { fill: var(--sunken); stroke: var(--line); }
.ac svg .pcb { fill: var(--tool-mask); stroke: var(--tool-mask-edge); stroke-width: 1.5; }
.ac svg .pcb-b { fill: var(--tool-mask); fill-opacity: .45; stroke: var(--tool-mask-edge); stroke-dasharray: 4 3; }
.ac svg g.board { cursor: ew-resize; outline: none; }
.ac svg g.board:focus-visible .pcb { stroke: var(--accent); stroke-width: 3; }
.ac svg .part { fill: var(--tool-ic); }
.ac svg .pad { fill: var(--tool-pad); }
.ac svg .tht { fill: var(--tool-ic); stroke: var(--line); }
.ac svg .hole { fill: var(--tool-pad); }
.ac svg .bga { fill: var(--tool-ic); stroke: var(--warn); stroke-width: 1.5; }
.ac svg .ball { fill: var(--tool-pad); }
.ac svg .stencil { fill: none; stroke: var(--ink-soft); stroke-width: 1.2; stroke-dasharray: 1 3; }
.ac svg .lead { stroke: var(--ink-soft); stroke-width: .9; fill: none; }
.ac svg .lbg { fill: var(--surface); fill-opacity: .92; stroke: var(--line); }
.ac[data-hl="ext"] svg .reel.ext, .ac[data-hl="lines"] svg .reel { stroke: var(--accent); stroke-width: 2.5; }
.ac[data-hl="smt"] svg .part, .ac[data-hl="smt"] svg .pad { fill: var(--accent); }
.ac[data-hl="tht"] svg .tht { stroke: var(--accent); stroke-width: 2.5; }
.ac[data-hl="fine"] svg .bga { stroke: var(--accent); stroke-width: 3; }
.ac[data-hl="stencil"] svg .stencil { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: none; }
.ac[data-hl="setup"] svg .setup-t { fill: var(--accent); }
/* chart */
.ac svg .grid { stroke: var(--line-soft); stroke-width: 1; }
.ac svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.ac svg .a-once { fill: var(--tool-once); fill-opacity: calc(var(--fill-alpha) * 1.6); }
.ac svg .a-rec { fill: var(--tool-rec); fill-opacity: calc(var(--fill-alpha) * 1.6); }
.ac svg .curve { stroke: var(--tool-once); stroke-width: 2; fill: none; }
.ac svg .floor { stroke: var(--tool-rec); stroke-width: 2; fill: none; }
.ac svg g.qh { cursor: ew-resize; outline: none; }
.ac svg g.qh .stem { stroke: var(--accent); stroke-width: 2; }
.ac svg g.qh .knobc { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.ac svg g.qh .tag { fill: var(--accent); } .ac svg g.qh .tag-t { fill: var(--accent-ink); font-weight: 600; }
.ac svg g.qh .ring { fill: none; stroke: none; }
.ac svg g.qh:focus-visible .ring { stroke: var(--accent); stroke-width: 2; }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const state = { drag: null, scrub: null };
  const K = () => ctx.result?.cost;

  // ---------- panels ----------
  const houseSeg = h('div', { class: 'ac-seg', role: 'group', 'aria-label': 'Assembler' });
  const sidesSeg = h('div', { class: 'ac-seg', role: 'group', 'aria-label': 'SMT sides' });
  const line = h('div', { class: 'ac-draw' });
  const inputs = {};
  const field = (key, label, aria, cls = '') => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria || label, oninput: (e) => ctx.set(key, e.target.value) });
    inputs[key] = inp;
    return h('label', { class: `ac-f ${cls}` }, label, inp);
  };
  const strip = h('div', { class: 'ac-strip' },
    field('unique', 'BOM lines', 'Unique parts (BOM lines)'), field('extended', 'extended', 'Extended (non-stock) parts'),
    field('place', 'placements', 'SMT placements per board'), field('pads', 'pads/part', 'Average pads per SMT part'),
    field('tht', 'THT parts', 'Through-hole parts per board'), field('thtpins', 'pins each', 'Pins per through-hole part'),
    field('fine', 'fine-pitch', 'BGA or fine-pitch parts per board'),
    field('bom', 'parts $/board', 'Parts cost per board in USD'), field('attrition', 'attrition %', 'Parts attrition in percent'));
  const linePanel = h('section', { class: 'ac-panel', 'aria-label': 'The assembly line' },
    h('div', { class: 'ac-head' }, h('h2', {}, 'On the line'), h('span', { class: 'ac-sub' }, 'click reels · drag across the board · + / − on the parts'),
      h('span', { class: 'ac-grow' }), houseSeg, sidesSeg),
    line, strip);

  const chart = h('div', { class: 'ac-draw' });
  const qChips = h('span', { class: 'ac-f' });
  const qtyPanel = h('section', { class: 'ac-panel', 'aria-label': 'Cost per board against quantity' },
    h('div', { class: 'ac-head' }, h('h2', {}, 'Per board, against run size'), h('span', { class: 'ac-sub' }, 'drag the run size'),
      h('span', { class: 'ac-grow' }), qChips, field('qty', 'boards', 'Boards to assemble', 'q')),
    chart);

  const rcpt = h('div', { class: 'ac-rcpt', 'aria-live': 'polite' });
  const rcptPanel = h('section', { class: 'ac-panel', 'aria-label': 'Estimate' },
    h('div', { class: 'ac-head' }, h('h2', {}, 'Estimate'), h('span', { class: 'ac-sub' }, 'USD, ±50 %, not a quote')), rcpt);
  const warns = h('div', { class: 'k-warns ac-warns', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'ac' }, h('div', { class: 'ac-main' }, linePanel, qtyPanel), h('aside', { class: 'ac-side' }, rcptPanel, warns, ctx.outputs));
  root.append(wrap);

  const redraw = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  const setInt = (key, v, lo = 0, hi = 1e6) => ctx.set(key, String(Math.round(clamp(v, lo, hi))));

  // ---------- the line ----------
  let boardGeo = null;
  function drawLine() {
    const k = K();
    line.replaceChildren();
    if (!k) { line.append(h('div', { class: 'ac-strip' }, (ctx.result?.warnings || []).join(' '))); return; }
    const W = Math.max(300, line.clientWidth || 800);
    const narrow = W < 620;
    const R = k.rates;
    const svg = sv('svg', { role: 'group', 'aria-label': 'Feeder bank and board' });
    // --- feeder bank
    const n = Math.min(k.unique, MAX_REELS);
    const bx = 12, bw = W - 24 - (narrow ? 0 : 0), by = 34;
    let d = 26, cols, rows;
    for (; d >= 11; d -= 1) { cols = Math.floor((bw - 44) / (d + 4)); rows = Math.ceil((n + 1) / Math.max(1, cols)); if (rows * (d + 4) <= (narrow ? 118 : 96)) break; }
    cols = Math.max(1, cols);
    const bh = Math.max(d + 12, rows * (d + 4) + 8);
    const g = sv('g', { class: 'reels', tabindex: 0, role: 'slider', 'data-fk': 'reels', 'aria-label': 'Extended parts among the BOM lines',
      'aria-valuenow': k.extended, 'aria-valuemin': 0, 'aria-valuemax': k.unique, 'aria-valuetext': `${k.extended} of ${k.unique} BOM lines extended` });
    g.append(sv('rect', { x: bx, y: by, width: bw, height: bh, rx: 4, class: 'bank' }));
    for (let i = 0; i < n; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const cx = bx + 8 + c * (d + 4) + d / 2, cy = by + 6 + r * (d + 4) + d / 2;
      const ext = i < k.extended;
      g.append(sv('circle', { cx, cy, r: d / 2 + 2, fill: 'transparent', class: 'reel-hit', 'data-reel': i }),
        sv('circle', { cx, cy, r: d / 2, class: `reel${ext ? ' ext' : ''}`, 'pointer-events': 'none' }),
        sv('circle', { cx, cy, r: d * 0.17, class: 'hub', 'pointer-events': 'none' }));
    }
    svg.append(g);
    // + / − reel buttons after the last reel
    const bt = (x, y, label, key, aria) => {
      const b = sv('g', { class: 'btn', tabindex: 0, role: 'button', 'data-fk': key, 'data-act': key, 'aria-label': aria });
      b.append(sv('rect', { x, y, width: 18, height: 18, rx: 3 }), txt(x + 9, y + 13, label, 'm', 'middle'));
      svg.append(b);
    };
    const lastC = n % cols, lastR = Math.floor(n / cols);
    const px = bx + 8 + lastC * (d + 4), py = by + 6 + lastR * (d + 4) + d / 2 - 9;
    if (px + 42 < bx + bw) { bt(px, py, '+', 'reel+', 'Add a BOM line'); bt(px + 21, py, '−', 'reel-', 'Remove a BOM line'); }
    else { bt(bx + bw - 42, by - 24, '+', 'reel+', 'Add a BOM line'); bt(bx + bw - 21, by - 24, '−', 'reel-', 'Remove a BOM line'); }
    // what the bank costs
    const bank = R.unique ? `${int(k.unique)} BOM lines × $${rate(R.unique)} = $${usd(k.order.find((o) => o.key === 'lines').amount)} per order`
      : `${int(k.extended)} extended × $${rate(R.extended)} = $${usd(k.order.find((o) => o.key === 'ext').amount)} per order`;
    const bank2 = R.unique ? `${int(k.extended)} marked extended (no extra fee here)` : `${int(k.unique - k.extended)} basic: loaded free`;
    svg.append(txt(bx, by - 10, 'Feeders', 'b'), txt(bx + 58, by - 10, `${bank}${narrow ? '' : ` · ${bank2}`}`, 'm sm money'));
    if (k.unique > MAX_REELS) svg.append(txt(bx + bw - 6, by + bh - 6, `${MAX_REELS} of ${int(k.unique)} drawn`, 'sm soft', 'end'));

    // --- conveyor and board
    const cy0 = by + bh + (narrow ? 30 : 26);
    const x0 = narrow ? 20 : Math.round(Math.max(120, W * 0.14));
    const boardW = narrow ? W - 40 : Math.min(W - x0 - 290, 560), boardH = narrow ? 150 : Math.min(190, Math.max(150, boardW * 0.36));
    const y0 = cy0;
    const convY = y0 + boardH + 10;
    svg.append(sv('line', { x1: 8, y1: convY, x2: W - 8, y2: convY, class: 'conv' }), sv('line', { x1: 8, y1: convY + 12, x2: W - 8, y2: convY + 12, class: 'conv' }));
    for (let x = 18; x < W - 8; x += 26) svg.append(sv('circle', { cx: x, cy: convY + 6, r: 4.5, class: 'roller' }));
    // setup and stencil, before the board (left of it)
    const setupAmt = k.order.find((o) => o.key === 'setup').amount, stAmt = k.order.find((o) => o.key === 'stencil').amount;
    if (k.sides === 2) {
      svg.append(sv('rect', { x: x0 + 10, y: y0 - 10, width: boardW, height: boardH, rx: 4, class: 'pcb-b' }),
        txt(x0 + boardW + 6, y0 - 2, 'bottom side too', 'sm soft'));
    }
    // stencil frame
    svg.append(sv('rect', { x: x0 - 8, y: y0 - 8, width: boardW + 16, height: boardH + 16, rx: 6, class: 'stencil' }));
    const bg = sv('g', { class: 'board', tabindex: 0, role: 'slider', 'data-fk': 'board', 'data-drag': 'board', 'aria-label': 'SMT placements per board',
      'aria-valuenow': k.place, 'aria-valuemin': 0, 'aria-valuetext': `${int(k.place)} placements` });
    bg.append(sv('rect', { x: x0, y: y0, width: boardW, height: boardH, rx: 4, class: 'pcb' }));
    // through-hole parts along the left edge, fine-pitch parts top right
    const thtN = Math.min(Math.round(k.tht), 8), pins = clamp(Math.round(k.thtpins), 1, 20);
    const thtW = 16, thtL = Math.min(boardH - 16, Math.max(24, pins * 8 + 6));
    const thtCols = Math.max(0, thtN);
    for (let i = 0; i < thtCols; i++) {
      const tx = x0 + 8 + i * (thtW + 5), ty = y0 + 8;
      bg.append(sv('rect', { x: tx, y: ty, width: thtW, height: thtL, rx: 2, class: 'tht' }));
      const pitch = (thtL - 8) / Math.max(1, pins - 1 || 1);
      for (let p = 0; p < pins; p++) bg.append(sv('circle', { cx: tx + thtW / 2, cy: ty + 4 + (pins === 1 ? (thtL - 8) / 2 : p * pitch), r: Math.min(3, pitch / 2.6 || 3), class: 'hole' }));
    }
    const fineN = Math.min(Math.round(k.fine), 6);
    const bs = Math.min(38, boardH * 0.3);
    for (let i = 0; i < fineN; i++) {
      const fx = x0 + boardW - 8 - bs - (i % 3) * (bs + 6), fy = y0 + 8 + Math.floor(i / 3) * (bs + 6);
      bg.append(sv('rect', { x: fx, y: fy, width: bs, height: bs, rx: 2, class: 'bga' }));
      const m = 5;
      for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) bg.append(sv('circle', { cx: fx + (a + 0.5) * (bs / m), cy: fy + (b + 0.5) * (bs / m), r: bs / m / 3.2, class: 'ball' }));
    }
    // SMT placements, scattered over the free area
    const zoneX0 = x0 + 8 + thtCols * (thtW + 5) + (thtCols ? 4 : 0), zoneX1 = x0 + boardW - 8;
    const dots = Math.min(Math.round(k.place), MAX_DOTS);
    const area = (zoneX1 - zoneX0) * (boardH - 16);
    const cell = Math.max(5, Math.sqrt(area / Math.max(1, dots * 1.15)));
    const ccols = Math.max(1, Math.floor((zoneX1 - zoneX0) / cell)), crows = Math.max(1, Math.floor((boardH - 16) / cell));
    const rnd = rng(1234);
    const cells = [];
    for (let r = 0; r < crows; r++) for (let c = 0; c < ccols; c++) {
      const cx = zoneX0 + (c + 0.5) * cell, cyy = y0 + 8 + (r + 0.5) * cell;
      const inFine = fineN && cx > x0 + boardW - 8 - Math.min(3, fineN) * (bs + 6) - 4 && cyy < y0 + 8 + Math.ceil(fineN / 3) * (bs + 6) + 2;
      if (!inFine) cells.push([cx, cyy, rnd()]);
    }
    cells.sort((a, b) => a[2] - b[2]);
    const pl = Math.max(2.2, Math.min(cell * 0.62, 9)), pw = pl * 0.5;
    const ic = Math.max(0, Math.min(1, (k.pads - 2) / 12));
    for (let i = 0; i < Math.min(dots, cells.length); i++) {
      const [cx, cyy, rr] = cells[i];
      const vert = rr > 0.5;
      const big = rnd() < ic;
      const L = big ? pl * 1.5 : pl, Wd = big ? pl * 1.1 : pw;
      const [w, hh] = vert ? [Wd, L] : [L, Wd];
      bg.append(sv('rect', { x: cx - w / 2, y: cyy - hh / 2, width: w, height: hh, class: 'part' }));
      if (!big) {
        const pd = Math.max(1, pw * 0.7);
        if (vert) bg.append(sv('rect', { x: cx - w / 2, y: cyy - hh / 2, width: w, height: pd, class: 'pad' }), sv('rect', { x: cx - w / 2, y: cyy + hh / 2 - pd, width: w, height: pd, class: 'pad' }));
        else bg.append(sv('rect', { x: cx - w / 2, y: cyy - hh / 2, width: pd, height: hh, class: 'pad' }), sv('rect', { x: cx + w / 2 - pd, y: cyy - hh / 2, width: pd, height: hh, class: 'pad' }));
      }
    }
    svg.append(bg);
    boardGeo = { x0, w: boardW };
    // +/- for THT and fine-pitch, beside their groups
    const note = (x, y, lines, anchor = 'start') => {
      const w = Math.max(...lines.map((l) => l[0].length)) * 6.1 + 10;
      const lx = anchor === 'end' ? x - w + 5 : x - 5;
      svg.append(sv('rect', { x: lx, y: y - 12, width: w, height: lines.length * 14 + 4, rx: 3, class: 'lbg' }));
      lines.forEach(([t, c], i) => svg.append(txt(x, y + i * 14, t, `m sm ${c || ''}`, anchor)));
      return w;
    };
    const smt = k.board.find((b) => b.key === 'smt'), tht = k.board.find((b) => b.key === 'tht'), fine = k.board.find((b) => b.key === 'fine');
    const smtLine = R.joint ? `${int(k.place)} × ${rate(k.pads)} pads = ${int(k.joints)} joints × $${rate(R.joint)}` : `${int(k.place)} placements × $${rate(R.place)}`;
    const labY = y0 + boardH + 42;
    if (!narrow) {
      // left column: setup, stencil, THT; right column: SMT and fine pitch
      note(x0 - 22, y0 + 6, [['setup', 'soft setup-t'], [`$${usd(setupAmt)}`, 'money']], 'end');
      note(x0 - 22, y0 + 44, [[`stencil${k.sides === 2 ? ' ×2' : ''}`, 'soft'], [`$${usd(stAmt)}`, 'money']], 'end');
      svg.append(txt(x0 - 22, y0 + 88, 'per order', 'sm once-t b', 'end'));
      const xr = x0 + boardW + 24;
      note(xr, y0 + 10, [['SMT', 'soft'], [smtLine, ''], [`$${usd(smt.amount)} / board`, 'money rec-t']]);
      const w1 = note(xr, y0 + 70, [['through-hole', 'soft'], [`${int(k.tht)} × ${int(k.thtpins)} pins × $${rate(R.tht)}`, ''], [`$${usd(tht.amount)} / board`, 'money rec-t']]);
      const w2 = note(xr, y0 + 130, [['fine-pitch / BGA', 'soft'], [`${int(k.fine)} × $${rate(R.fine)}`, ''], [`$${usd(fine.amount)} / board`, 'money rec-t']]);
      bt(xr + w1 + 2, y0 + 58, '+', 'tht+', 'Add a through-hole part'); bt(xr + w1 + 23, y0 + 58, '−', 'tht-', 'Remove a through-hole part');
      bt(xr + w2 + 2, y0 + 118, '+', 'fine+', 'Add a fine-pitch part'); bt(xr + w2 + 23, y0 + 118, '−', 'fine-', 'Remove a fine-pitch part');
    } else {
      note(14, labY, [[`setup $${usd(setupAmt)} · stencil $${usd(stAmt)} per order`, 'money once-t']]);
      note(14, labY + 22, [[`SMT ${smtLine}`, ''], [`= $${usd(smt.amount)} / board`, 'money rec-t']]);
      note(14, labY + 58, [[`THT ${int(k.tht)} × ${int(k.thtpins)} pins: $${usd(tht.amount)} / board`, 'money rec-t']]);
      note(14, labY + 80, [[`fine-pitch ${int(k.fine)}: $${usd(fine.amount)} / board`, 'money rec-t']]);
      bt(W - 86, labY + 46, '+', 'tht+', 'Add a through-hole part'); bt(W - 65, labY + 46, '−', 'tht-', 'Remove a through-hole part');
      bt(W - 86, labY + 68, '+', 'fine+', 'Add a fine-pitch part'); bt(W - 65, labY + 68, '−', 'fine-', 'Remove a fine-pitch part');
    }
    const H = narrow ? labY + 100 : Math.max(convY + 24, y0 + 180);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    line.append(svg);
  }

  // ---------- quantity chart ----------
  let cg = null;
  function drawChart() {
    const k = K();
    chart.replaceChildren();
    if (!k) return;
    const W = Math.max(300, chart.clientWidth || 800);
    const narrow = W < 620;
    const H = narrow ? 210 : clamp(window.innerHeight - 560, 190, 280);
    const L = 46, R = 16, T = 30, B = 26;
    const qs = k.curve.q, ys = k.curve.assemblyPerBoard;
    const X = (q) => L + (Math.log10(clamp(q, Q_LO, Q_HI) / Q_LO) / 4) * (W - L - R);
    // y range: what a run of 5 costs per board, or the chosen run if smaller
    const at5 = ys[qs.findIndex((q) => q >= 5)] ?? ys[0];
    const top = Math.max(k.assemblyPerBoard, at5) * 1.08;
    const step = niceStep(top, 4), yMax = Math.ceil(top / step) * step;
    const Y = (v) => T + (1 - Math.max(0, v) / yMax) * (H - T - B);
    cg = { X, L, R, W };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Assembly cost per board against quantity' });
    const clip = sv('clipPath', { id: 'ac-plot' });
    clip.append(sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
    svg.append(sv('defs', {}, null)); svg.lastChild.append(clip);
    for (let v = 0; v <= yMax + 1e-9; v += step) svg.append(sv('line', { x1: L, y1: Y(v), x2: W - R, y2: Y(v), class: 'grid' }), txt(L - 6, Y(v) + 3.5, `$${v === 0 ? '0' : v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}`, 'm sm soft', 'end'));
    for (let dd = 0; dd <= 4; dd++) svg.append(sv('line', { x1: X(10 ** dd), y1: T, x2: X(10 ** dd), y2: H - B, class: 'grid' }), txt(X(10 ** dd), H - B + 14, int(10 ** dd), 'm sm soft', dd === 0 ? 'start' : dd === 4 ? 'end' : 'middle'));
    svg.append(txt(W - R, H - 3, 'boards in the run', 'sm soft', 'end'));
    // recurring floor and one-off spread above it
    const floorY = Y(k.perBoard);
    const pts = qs.map((q, i) => [X(q), Y(ys[i])]);
    svg.append(sv('rect', { x: L, y: floorY, width: W - L - R, height: H - B - floorY, class: 'a-rec' }));
    const plot = sv('g', { 'clip-path': 'url(#ac-plot)' });
    plot.append(sv('path', { d: `M${pts[0][0]},${floorY} ${pts.map(([x, y]) => `L${x},${y}`).join(' ')} L${pts[pts.length - 1][0]},${floorY} Z`, class: 'a-once' }),
      sv('path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '), class: 'curve' }));
    svg.append(plot);
    if (!narrow) {
      svg.append(txt(W - R - 6, T + 14, 'one-off charges spread over the run', 'sm once-t b', 'end'));
      if (ys[0] > yMax) svg.append(txt(W - R - 6, T + 28, `off the top at 1 board: $${usd(ys[0])}`, 'm sm once-t', 'end'));
    }
    svg.append(sv('line', { x1: L, y1: floorY, x2: W - R, y2: floorY, class: 'floor' }));
    const recLeft = !narrow && X(k.qty) > (W - L - R) * 0.55;
    svg.append(txt(recLeft ? L + 6 : W - R - 4, floorY - 6, `recurring $${usd(k.perBoard)} / board`, 'm sm b rec-t', recLeft ? 'start' : 'end'));
    svg.append(sv('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }));
    // the run-size handle
    const x = X(k.qty), y = Y(k.assemblyPerBoard);
    const tag = `${int(k.qty)} boards`;
    const tw = tag.length * 7 + 14, tx = clamp(x, L + tw / 2, W - R - tw / 2);
    const g = sv('g', { class: 'qh', tabindex: 0, role: 'slider', 'data-fk': 'qty', 'data-drag': 'qty', 'aria-label': 'Boards in the run',
      'aria-valuenow': k.qty, 'aria-valuemin': 1, 'aria-valuemax': Q_HI, 'aria-valuetext': `${k.qty} boards, $${usd(k.assemblyPerBoard)} per board` });
    g.append(sv('rect', { x: x - 14, y: 0, width: 28, height: H - B, fill: 'transparent' }),
      sv('line', { x1: x, y1: 20, x2: x, y2: H - B, class: 'stem' }),
      sv('rect', { x: tx - tw / 2, y: 3, width: tw, height: 17, rx: 3, class: 'tag' }), txt(tx, 15.5, tag, 'm sm tag-t', 'middle'),
      sv('circle', { cx: x, cy: y, r: 6.5, class: 'knobc' }), sv('circle', { cx: x, cy: y, r: 10.5, class: 'ring' }));
    svg.append(g);
    const info = [`$${usd(k.assemblyPerBoard)} per board`, `= $${usd(k.perBoard)} recurring + $${usd(k.oneOffPerBoard)} one-off`];
    const iw = Math.max(...info.map((s) => s.length)) * 6.3 + 10;
    const right = narrow || x + 14 + iw < W - R || x - 14 - iw < L;
    const ix = narrow ? W - R - iw + 5 : right ? Math.min(x + 14, W - R - iw + 5) : x - 14, anchor = right ? 'start' : 'end';
    const iy = narrow ? T + 12 : clamp(y - 8, T + 44, H - B - 30);
    svg.append(sv('rect', { x: right ? ix - 5 : ix - iw + 5, y: iy - 13, width: iw, height: 34, rx: 3, class: 'lbg' }),
      txt(ix, iy, info[0], 'm b', anchor), txt(ix, iy + 14, info[1], 'm sm soft', anchor));
    chart.append(svg);
  }
  const niceStep = (span, n) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };

  // ---------- receipt ----------
  function drawReceipt() {
    const k = K();
    rcpt.replaceChildren();
    if (!k) { rcpt.append(h('div', {}, 'Nothing to estimate yet.')); return; }
    const R = k.rates;
    const row = (key, label, note, v, cls = '') => h('div', { class: `row ${cls}${v === 0 ? ' zero' : ''}`, 'data-k': key || null },
      h('span', { class: 'k' }, label), note ? h('span', { class: 'n' }, note) : null, h('span', { class: 'd' }), h('span', { class: 'v' }, usd(v)));
    const notes = {
      setup: `${k.sides} side${k.sides > 1 ? 's' : ''} × $${rate(R.setup)}`, stencil: `${k.sides} × $${rate(R.stencil)}`,
      lines: R.unique ? `${int(k.unique)} × $${rate(R.unique)}` : '', ext: R.extended ? `${int(k.extended)} × $${rate(R.extended)}` : '',
      smt: R.joint ? `${int(k.joints)} × $${rate(R.joint)}` : `${int(k.place)} × $${rate(R.place)}`, tht: `${int(k.thtJoints)} × $${rate(R.tht)}`, fine: `${int(k.fine)} × $${rate(R.fine)}`,
    };
    const orderRows = k.order.filter((o) => o.amount > 0 || o.key === 'setup');
    const boardRows = k.board.filter((b) => b.amount > 0 || b.key === 'smt');
    rcpt.append(
      h('div', { class: 'hd' }, h('span', { class: 'once' }, 'Once per order'), h('span', {}, (HOUSES.find(([v]) => v === k.house) || [])[1] || k.houseName)),
      ...orderRows.map((o) => row(o.key, o.label.replace(' (kitting, feeders)', '').replace('Extended-part loading fees', 'Extended loading'), notes[o.key], o.amount)),
      row(null, 'per order', '', k.perOrder, 'sum'),
      h('div', { class: 'hd' }, h('span', { class: 'rec' }, 'Every board'), h('span', {}, `× ${int(k.qty)}`)),
      ...boardRows.map((b) => row(b.key, b.label.replace('Fine-pitch / X-ray inspection', 'Fine-pitch / X-ray'), notes[b.key], b.amount)),
      row(null, 'per board', `× ${int(k.qty)} = ${usd(k.recurring)}`, k.perBoard, 'sum'),
      h('div', { class: 'row tot' }, h('span', { class: 'k' }, `Assembly, ${int(k.qty)} boards`), h('span', { class: 'd' }), h('span', { class: 'v' }, `$${usd(k.assembly)}`)),
      row(null, 'per board', '', k.assemblyPerBoard),
      ...(k.bom > 0 ? [
        row(null, 'Parts incl. attrition', `${int(k.qty)} × $${rate(k.bom)} × ${rate(1 + k.attrition)}`, k.parts),
        h('div', { class: 'row tot' }, h('span', { class: 'k' }, 'Assembled board, each'), h('span', { class: 'd' }), h('span', { class: 'v' }, `$${usd(k.totalPerBoard)}`)),
      ] : []),
      h('div', { class: 'foot' }, 'No bare board, shipping, programming or test. Point at a line to see it on the drawing.'));
  }
  rcpt.addEventListener('pointerover', (e) => { const r = e.target.closest('[data-k]'); if (r) wrap.dataset.hl = r.getAttribute('data-k'); else delete wrap.dataset.hl; });
  rcpt.addEventListener('pointerleave', () => { delete wrap.dataset.hl; });

  // ---------- pointer and keys ----------
  const local = (el, e) => {
    const rect = el.getBoundingClientRect();
    const vb = el.querySelector('svg')?.viewBox.baseVal;
    const kk = vb ? vb.width / rect.width : 1;
    return [(e.clientX - rect.left) * kk, (e.clientY - rect.top) * kk];
  };
  const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* ended */ } };
  const act = (a) => {
    const k = K(); if (!k) return;
    if (a === 'reel+') ctx.set('unique', String(k.unique + 1));
    else if (a === 'reel-') ctx.setMany({ unique: String(Math.max(0, k.unique - 1)), ...(k.extended > k.unique - 1 ? { extended: String(Math.max(0, k.unique - 1)) } : {}) });
    else if (a === 'tht+') setInt('tht', k.tht + 1);
    else if (a === 'tht-') setInt('tht', k.tht - 1);
    else if (a === 'fine+') setInt('fine', k.fine + 1);
    else if (a === 'fine-') setInt('fine', k.fine - 1);
  };
  line.addEventListener('pointerdown', (e) => {
    const k = K(); if (!k) return;
    const b = e.target.closest('[data-act]');
    if (b) { e.preventDefault(); act(b.getAttribute('data-act')); return; }
    const reel = e.target.closest('[data-reel]');
    if (reel) {
      e.preventDefault();
      const i = Number(reel.getAttribute('data-reel'));
      setInt('extended', i + 1 === k.extended ? i : i + 1);
      line.querySelector('[data-fk="reels"]')?.focus({ preventScroll: true });
      return;
    }
    if (e.target.closest('[data-drag="board"]')) {
      e.preventDefault();
      capture(line, e);
      const [x] = local(line, e);
      state.drag = 'board';
      state.scrub = { x, place: k.place };
      e.target.closest('[data-drag="board"]').focus({ preventScroll: true });
    }
  });
  line.addEventListener('pointermove', (e) => {
    if (state.drag !== 'board' || !boardGeo) return;
    const [x] = local(line, e);
    // across the whole board: from none to four times what it holds now (at least 400)
    const span = Math.max(400, state.scrub.place * 4);
    const v = Math.round(clamp(state.scrub.place + ((x - state.scrub.x) / boardGeo.w) * span, 0, 100000));
    const st = v < 100 ? 1 : v < 1000 ? 5 : 10;
    const nv = Math.round(v / st) * st;
    if (nv !== K().place) setInt('place', nv);
  });
  chart.addEventListener('pointerdown', (e) => {
    if (!K() || !cg) return;
    e.preventDefault();
    capture(chart, e);
    state.drag = 'qty';
    chart.querySelector('[data-fk="qty"]')?.focus({ preventScroll: true });
    qtyFrom(e);
  });
  const qtyFrom = (e) => {
    const [x] = local(chart, e);
    const q = Q_LO * 10 ** (4 * clamp((x - cg.L) / (cg.W - cg.L - cg.R), 0, 1));
    const st = q < 20 ? 1 : q < 100 ? 5 : q < 1000 ? 10 : 100;
    const nq = Math.max(1, Math.round(q / st) * st);
    if (nq !== K().qty) setInt('qty', nq, 1, Q_HI * 10);
  };
  chart.addEventListener('pointermove', (e) => { if (state.drag === 'qty') qtyFrom(e); });
  const endDrag = () => { if (state.drag) { state.drag = null; state.scrub = null; } };
  for (const el of [line, chart]) { el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag); }
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-fk]'); const k = K();
    if (!t || !k) return;
    const f = t.getAttribute('data-fk');
    if (t.hasAttribute('data-act') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act(t.getAttribute('data-act')); return; }
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    if (f === 'reels') { e.preventDefault(); setInt('extended', k.extended + dir * (e.shiftKey ? 5 : 1), 0, k.unique); }
    else if (f === 'board') { e.preventDefault(); setInt('place', k.place + dir * (e.shiftKey ? 25 : 5)); }
    else if (f === 'qty') {
      e.preventDefault();
      const i = dir > 0 ? QTY_LADDER.findIndex((q) => q > k.qty) : QTY_LADDER.length - 1 - [...QTY_LADDER].reverse().findIndex((q) => q < k.qty);
      const nq = QTY_LADDER[i];
      if (nq != null && i >= 0 && i < QTY_LADDER.length) setInt('qty', nq, 1, Q_HI * 10);
    }
  });

  // ---------- result -> page ----------
  const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
  function renderBars() {
    const raw = ctx.raw;
    houseSeg.replaceChildren(...HOUSES.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(raw.house === v), onclick: () => ctx.set('house', v) }, t)));
    sidesSeg.replaceChildren(...[['one', 'Top only'], ['two', 'Both sides']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(raw.sides === v), onclick: () => ctx.set('sides', v) }, t)));
    qChips.replaceChildren(...[10, 50, 100, 1000].map((q) => h('button', { type: 'button', class: 'ac-chip', 'aria-pressed': String(String(raw.qty) === String(q)), onclick: () => ctx.set('qty', String(q)) }, String(q))));
    for (const [key, inp] of Object.entries(inputs)) {
      sync(inp, raw[key]);
      inp.classList.toggle('bad', String(raw[key] ?? '').trim() !== '' && ctx.parseEng(raw[key]) == null);
    }
    warns.replaceChildren(...(ctx.result?.warnings || []).map((w) => h('div', {}, w)));
  }
  const drawAll = () => { drawLine(); drawChart(); drawReceipt(); };
  ctx.onResult(() => { renderBars(); redraw(drawAll); });
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => redraw(drawAll));
  }).observe(root);
}
