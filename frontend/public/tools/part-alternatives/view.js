// Part Alternative Finder page: the market for one part, drawn as a map. Each
// candidate reel sits at its stock (across, log scale) and at what this order
// would cost with it (up), drawn as its own footprint so a package change is
// visible before it is read. The order quantity is a line you drag: reels left
// of it cannot cover the order. The original part's cost is the line to beat.
// Pick a candidate to lay its footprint beside the original's and set its
// JLCPCB class; the Search button (in the app) refills the map from LCSC.
// Every rank, cost, fit and verdict drawn comes from tool.js run()
// (result.ranked / result.order).

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
const CLASSES = ['basic', 'preferred', 'extended', 'unknown'];

// ---------------- footprints ----------------
// Approximate land patterns in mm, centred: body [w, h] and pads [x, y, w, h].
// Enough to see a package change at a glance; the datasheet has the real one.
function footprint(fam) {
  const F = String(fam || '').toUpperCase();
  const row = (n, pitch, y, pw, ph) => Array.from({ length: n }, (_, k) => [(k - (n - 1) / 2) * pitch, y, pw, ph]);
  const chip = { '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], '1206': [3.2, 1.6], '1210': [3.2, 2.5],
    '1812': [4.5, 3.2], '2010': [5.0, 2.5], '2512': [6.3, 3.2] }[F];
  if (chip) { const [L, W] = chip, pl = L * 0.42; return { body: [L * 0.7, W], pads: [[-L / 2, 0, pl, W * 1.1], [L / 2, 0, pl, W * 1.1]], name: `${F} chip` }; }
  let m;
  if (F === 'SOT-223') return { body: [6.5, 3.5], pads: [...row(3, 2.3, 3.1, 1.0, 2.0), [0, -3.1, 3.3, 2.0]] };
  if (F === 'SOT-89') return { body: [4.5, 2.5], pads: [...row(3, 1.5, 2.0, 0.7, 1.3), [0, -0.5, 1.8, 2.6]] };
  if (F === 'TO-252') return { body: [6.6, 6.1], pads: [[-2.28, 4.3, 1.0, 1.8], [2.28, 4.3, 1.0, 1.8], [0, -2.3, 5.8, 5.6]] };
  if (F === 'TO-263') return { body: [10.2, 9.0], pads: [[-2.54, 6.2, 1.1, 2.4], [2.54, 6.2, 1.1, 2.4], [0, -3.2, 10.8, 8.6]] };
  if ((m = /^(SOT-23|SC-70)-(\d)$/.exec(F))) {
    const k = m[1] === 'SC-70' ? 0.68 : 1, n = Number(m[2]);
    const bot = n === 3 ? [[-0.95 * k, 1.1 * k, 0.6 * k, 0.8 * k], [0.95 * k, 1.1 * k, 0.6 * k, 0.8 * k]] : row(3, 0.95 * k, 1.1 * k, 0.6 * k, 0.8 * k);
    const top = n === 3 ? [[0, -1.1 * k, 0.6 * k, 0.8 * k]] : n === 5 ? [[-0.95 * k, -1.1 * k, 0.6 * k, 0.8 * k], [0.95 * k, -1.1 * k, 0.6 * k, 0.8 * k]] : row(3, 0.95 * k, -1.1 * k, 0.6 * k, 0.8 * k);
    return { body: [2.9 * k, 1.4 * k], pads: [...bot, ...top] };
  }
  if ((m = /^SOD-(\d+)/.exec(F))) {
    const d = { 123: [2.7, 1.6, 1.8], 323: [1.7, 1.25, 1.25], 523: [1.2, 0.8, 0.8], 80: [3.5, 1.5, 2.0], 882: [1.0, 0.6, 0.55] }[m[1]] || [2.7, 1.6, 1.8];
    return { body: [d[0], d[1]], pads: [[-d[2], 0, 0.9, 1.1], [d[2], 0, 0.9, 1.1]] };
  }
  if ((m = /^(SOIC|TSSOP|MSOP|SSOP|ESOP|HSOP)-(\d+)$/.exec(F))) {
    const n = Number(m[2]), per = Math.ceil(n / 2);
    const [bw, pitch, span] = { SOIC: [3.9, 1.27, 5.4], ESOP: [3.9, 1.27, 5.4], HSOP: [3.9, 1.27, 5.4], TSSOP: [4.4, 0.65, 5.8], MSOP: [3.0, 0.65, 4.4], SSOP: [5.3, 0.65, 7.0] }[m[1]];
    const len = per * pitch + 0.4;
    const pads = [...row(per, pitch, span / 2, pitch * 0.5, 1.5), ...row(per, pitch, -span / 2, pitch * 0.5, 1.5)];
    if (m[1] === 'ESOP' || m[1] === 'HSOP') pads.push([0, 0, len * 0.55, bw * 0.6]);
    return { body: [len, bw], pads };
  }
  if ((m = /^(QFN|DFN)-(\d+)$/.exec(F))) {
    const n = Number(m[2]);
    if (m[1] === 'DFN') {
      const per = n / 2, pitch = n <= 8 ? 0.65 : 0.5, side = Math.max(2, per * pitch + 0.6);
      return { body: [side, side], pads: [...row(per, pitch, side / 2, pitch * 0.55, 0.7), ...row(per, pitch, -side / 2, pitch * 0.55, 0.7), [0, 0, side * 0.7, side * 0.45]] };
    }
    const per = Math.ceil(n / 4), pitch = 0.5, side = n <= 16 ? 3 : n <= 24 ? 4 : n <= 32 ? 5 : n <= 48 ? 7 : 8;
    const edge = row(per, pitch, side / 2, 0.25, 0.7);
    const pads = [...edge, ...edge.map(([x, y, w, hh]) => [x, -y, w, hh]), ...edge.map(([x, y, w, hh]) => [y, x, hh, w]), ...edge.map(([x, y, w, hh]) => [-y, x, hh, w]), [0, 0, side * 0.6, side * 0.6]];
    return { body: [side, side], pads };
  }
  if ((m = /^(LQFP|TQFP)-(\d+)$/.exec(F))) {
    const n = Number(m[2]), per = n / 4, pitch = n <= 32 ? 0.8 : 0.5, side = per * pitch + 1.0, lead = 1.2;
    const edge = row(per, pitch, side / 2 + lead / 2, pitch * 0.5, lead);
    return { body: [side, side], pads: [...edge, ...edge.map(([x, y, w, hh]) => [x, -y, w, hh]), ...edge.map(([x, y, w, hh]) => [y, x, hh, w]), ...edge.map(([x, y, w, hh]) => [-y, x, hh, w])] };
  }
  return null;
}
function fpExtent(fp) {
  if (!fp) return [3, 3];
  let x = fp.body[0] / 2, y = fp.body[1] / 2;
  for (const [px, py, pw, ph] of fp.pads) { x = Math.max(x, Math.abs(px) + pw / 2); y = Math.max(y, Math.abs(py) + ph / 2); }
  return [2 * x, 2 * y];
}
/** Draw a footprint centred at (cx, cy), k px per mm. */
function drawFp(g, fp, cx, cy, k, label) {
  if (!fp) {
    g.append(sv('rect', { x: cx - 1.5 * k, y: cy - 1.5 * k, width: 3 * k, height: 3 * k, rx: 2, class: 'pa-body' }));
    g.append(sv('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'pa-fpq' }, '?'));
    return;
  }
  for (const [x, y, w, hh] of fp.pads) g.append(sv('rect', { x: cx + (x - w / 2) * k, y: cy + (y - hh / 2) * k, width: w * k, height: hh * k, rx: Math.min(w, hh) * k * 0.15, class: 'pa-pad' }));
  g.append(sv('rect', { x: cx - fp.body[0] / 2 * k, y: cy - fp.body[1] / 2 * k, width: fp.body[0] * k, height: fp.body[1] * k, rx: 1, class: 'pa-body' }));
  if (label) g.append(sv('circle', { cx: cx - fp.body[0] / 2 * k + 3, cy: cy - fp.body[1] / 2 * k + 3, r: 1.2, class: 'pa-pin1' }));
}

const CSS = `
:root { --tool-pad: #b8862b; --tool-body: #3b4550; --tool-short: rgba(192, 57, 43, .07); --tool-cheap: rgba(47, 133, 90, .07); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-pad: #d4a64a; --tool-body: #8394a5; --tool-short: rgba(229, 115, 115, .08); --tool-cheap: rgba(104, 179, 107, .08); } }
:root[data-theme="dark"] { --tool-pad: #d4a64a; --tool-body: #8394a5; --tool-short: rgba(229, 115, 115, .08); --tool-cheap: rgba(104, 179, 107, .08); }

.k-page { padding: 12px; }
.pa { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) 372px; align-items: start; }
@media (max-width: 1060px) { .pa { grid-template-columns: minmax(0, 1fr); } }
.pa-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pa-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }

/* your part and the order */
.pa-top { display: flex; flex-wrap: wrap; align-items: stretch; }
.pa-top > div { padding: 7px 12px; border-right: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pa-top .t { font-size: 10.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
.pa-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 12px; color: var(--ink-soft); }
.pa-in { padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.pa-in.num { width: 56px; text-align: right; }
.pa-in.bad { border-color: var(--danger); }
.pa-sel { padding: 3px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font-size: 12px; }
.pa-qty b { font: 600 17px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pa-search { flex: 1; min-width: 240px; border-right: 0 !important; }
.pa-search .pa-in { flex: 1; min-width: 120px; }
.pa-btn { padding: 3px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; white-space: nowrap; }
.pa-btn:hover { border-color: var(--ink-soft); }
.pa-btn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.pa-btn:disabled { opacity: .5; cursor: default; }
.pa-status { font-size: 11.5px; color: var(--ink-soft); }
.pa-status.ok { color: var(--ok); } .pa-status.bad { color: var(--danger); }

/* the market map */
.pa-map { padding: 4px 6px 2px; }
.pa-mh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding: 6px 6px 2px; }
.pa-mh h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.pa-mh span { font-size: 11.5px; color: var(--ink-soft); }
.pa-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.pa-ax { stroke: var(--line); }
.pa-gr { stroke: var(--line-soft); }
.pa-tk { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.pa-axl { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.pa-short { fill: var(--tool-short); }
.pa-cheap { fill: var(--tool-cheap); }
.pa-shortt { font: 600 11px "IBM Plex Sans", sans-serif; fill: var(--danger); opacity: .8; }
.pa-cheapt { font: 600 11px "IBM Plex Sans", sans-serif; fill: var(--ok); opacity: .9; }
.pa-orig { stroke: var(--ink); stroke-width: 1.4; stroke-dasharray: 7 4; }
.pa-origt { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.pa-need { stroke: var(--accent); stroke-width: 2; }
.pa-needh { cursor: ew-resize; outline: none; }
.pa-needh rect { fill: var(--accent); }
.pa-needh text { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--accent-ink); pointer-events: none; }
.pa-needh:focus-visible rect { stroke: var(--ink); stroke-width: 2; }
.pa-stem { stroke: var(--ink-soft); stroke-width: 1.2; stroke-dasharray: 2 2; }
.pa-stemd { fill: var(--ink-soft); }
.pa-cand { cursor: pointer; outline: none; }
.pa-cand .tile { fill: var(--surface); stroke-width: 1.8; }
.pa-cand.fit .tile { stroke: var(--ok); }
.pa-cand.change .tile { stroke: var(--warn); }
.pa-cand.short .tile { stroke: var(--ink-soft); stroke-dasharray: 3 2; }
.pa-cand.short { opacity: .55; }
.pa-cand .sel { fill: none; stroke: var(--accent); stroke-width: 2.5; opacity: 0; }
.pa-cand.is-sel .sel { opacity: 1; }
.pa-cand:focus-visible .sel { opacity: 1; stroke-dasharray: 4 2; }
.pa-cand:hover .tile { fill: var(--sunken); }
.pa-rk { font: 600 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.pa-rk.best { fill: var(--ok); }
.pa-cl { font: 11px "IBM Plex Sans", sans-serif; fill: var(--ink); pointer-events: none; }
.pa-cl.soft { fill: var(--ink-soft); }
.pa-halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.pa-pad { fill: var(--tool-pad); }
.pa-body { fill: none; stroke: var(--tool-body); stroke-width: 1.2; }
.pa-pin1 { fill: var(--tool-body); }
.pa-fpq { font: 600 12px "IBM Plex Sans", sans-serif; fill: var(--ink-soft); }
.pa-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--ink-soft); padding: 2px 8px 8px; }
.pa-legend i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; border: 1.8px solid; margin-right: 5px; vertical-align: -2px; }

/* swap check */
.pa-cmp-h { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.pa-cmp-h h2 { margin: 0; font-size: 12.5px; font-weight: 600; flex: 1; }
.pa-cmp-h .nav { display: inline-flex; gap: 4px; }
.pa-fps { display: block; width: 100%; }
.pa-fpl { font: 600 11.5px "IBM Plex Sans", sans-serif; fill: var(--ink); }
.pa-fps .pa-tk { font-size: 10px; }
.pa-tab { width: 100%; border-collapse: collapse; font-size: 12px; }
.pa-tab th { text-align: left; font-weight: 400; color: var(--ink-soft); padding: 4px 10px; width: 30%; font-size: 11.5px; }
.pa-tab td { padding: 4px 10px 4px 0; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; vertical-align: middle; overflow-wrap: anywhere; }
.pa-tab tr + tr th, .pa-tab tr + tr td { border-top: 1px solid var(--line-soft); }
.pa-tab .ok { color: var(--ok); } .pa-tab .warn { color: var(--warn); } .pa-tab .bad { color: var(--danger); }
.pa-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.pa-seg button { border: 0; background: transparent; padding: 2px 7px; min-width: 22px; font-size: 11px; cursor: pointer; color: var(--ink-soft); font-family: "IBM Plex Sans", sans-serif; }
.pa-seg button + button { border-left: 1px solid var(--line); }
.pa-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.pa-sbar { display: inline-block; width: 70px; height: 5px; border-radius: 3px; background: var(--sunken); position: relative; vertical-align: middle; margin-left: 6px; overflow: hidden; }
.pa-sbar i { position: absolute; left: 0; top: 0; bottom: 0; }
.pa-verdict { margin: 8px 10px 10px; padding: 7px 9px; border-radius: 4px; font-size: 12.5px; border-left: 3px solid var(--ok); background: var(--sunken); }
.pa-verdict.warn { border-left-color: var(--warn); } .pa-verdict.bad { border-left-color: var(--danger); }
.pa-verdict b { font-family: "IBM Plex Mono", ui-monospace, monospace; }

/* ranked list */
.pa-list { max-height: 300px; overflow: auto; }
.pa-li { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 1px 8px; padding: 5px 10px; border-bottom: 1px solid var(--line-soft); cursor: pointer; border-left: 3px solid transparent; }
.pa-li:hover { background: var(--sunken); }
.pa-li.is-sel { border-left-color: var(--accent); background: var(--sunken); }
.pa-li .r { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); grid-row: span 2; align-self: center; }
.pa-li .n { font: 12px "IBM Plex Mono", ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-li .c { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.pa-li .m { font-size: 11px; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-li .v { font-size: 11px; text-align: right; white-space: nowrap; }
.pa-li .v.ok { color: var(--ok); } .pa-li .v.warn { color: var(--warn); } .pa-li .v.bad { color: var(--danger); }
.pa-warns { display: flex; flex-direction: column; gap: 4px; }
.pa-warns div { font-size: 12px; padding: 5px 8px; border-left: 3px solid var(--warn); background: var(--surface); border-radius: 0 4px 4px 0; }
.pa-more { font-size: 12px; }
.pa-more summary { cursor: pointer; color: var(--ink-soft); padding: 4px 2px; }
.pa-more ul { margin: 0; padding: 0 0 0 16px; color: var(--ink-soft); }
.pa-more .k-form { margin-top: 6px; }
`;

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  const fmt = ctx.fmtNum;
  const money = (v) => (v == null || !Number.isFinite(v) ? '–' : `$${v < 1 ? fmt(v, 3) : v.toFixed(2)}`);
  const pcs = (v) => (v == null ? '–' : v >= 1e6 ? `${fmt(v / 1e6, 3)}M` : v >= 1e4 ? `${fmt(v / 1e3, 3)}k` : String(v));
  const served = /^https?:/.test(location.protocol);

  // ---------- top: your part, the order, the search ----------
  const bind = {};
  const inp = (key, cls, label, w) => {
    const e = h('input', { class: `pa-in ${cls || ''}`, id: `pa-${key}`, spellcheck: 'false', 'aria-label': label, style: w ? `width:${w}px` : null,
      inputmode: cls === 'num' ? 'decimal' : null });
    e.addEventListener('input', () => ctx.set(key, e.value));
    if (cls === 'num') e.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      const v = ctx.parseEng(e.value); if (v == null) return;
      ev.preventDefault();
      const st = key === 'orig_price' ? 0.001 : 1;
      e.value = String(Number(Math.max(0, v + (ev.key === 'ArrowUp' ? st : -st) * (ev.shiftKey ? 10 : 1)).toFixed(4)));
      ctx.set(key, e.value);
    });
    bind[key] = e; return e;
  };
  const origCls = h('select', { class: 'pa-sel', 'aria-label': 'Original class' }, CLASSES.map((c) => h('option', { value: c }, c)));
  origCls.addEventListener('change', () => ctx.set('orig_class', origCls.value));
  const assumeSel = h('select', { class: 'pa-sel', 'aria-label': 'Unknown class counts as' },
    h('option', { value: 'extended' }, 'unknown = extended'), h('option', { value: 'basic' }, 'unknown = basic'));
  assumeSel.addEventListener('change', () => ctx.set('assume', assumeSel.value));
  const origFp = sv('svg', { width: 44, height: 34, 'aria-hidden': 'true' });
  const qtyB = h('b', {});
  const status = h('span', { class: 'pa-status', role: 'status' });
  const searchBtn = h('button', { class: 'pa-btn pri', onclick: () => search() }, 'Search LCSC');
  const top = h('section', { class: 'pa-card pa-top' },
    h('div', {}, h('span', { class: 't' }, 'Your part'),
      h('div', { class: 'pa-row' }, origFp, h('span', { style: 'display:flex;flex-direction:column;gap:3px' },
        h('span', { class: 'pa-row' }, inp('orig_lcsc', '', 'Original LCSC number', 82), inp('orig_mpn', '', 'Original MPN', 118)),
        h('span', { class: 'pa-row' }, inp('orig_package', '', 'Original package', 82), origCls, '$', inp('orig_price', 'num', 'Original unit price in dollars'))))),
    h('div', { class: 'pa-qty' }, h('span', { class: 't' }, 'Order'),
      h('div', { class: 'pa-row' }, inp('boards', 'num', 'Boards'), 'boards ×', inp('per_board', 'num', 'Parts per board', 40), '='),
      h('div', { class: 'pa-row' }, qtyB, 'pcs')),
    h('div', {}, h('span', { class: 't' }, 'Extended fee'),
      h('div', { class: 'pa-row' }, '$', inp('fee', 'num', 'Extended loading fee in dollars', 44), 'per part'),
      h('div', { class: 'pa-row' }, assumeSel)),
    h('div', { class: 'pa-search' }, h('span', { class: 't' }, 'Candidates from LCSC'),
      h('div', { class: 'pa-row' }, inp('query', '', 'Search LCSC for'), searchBtn),
      status));

  // ---------- map ----------
  const svg = sv('svg', { class: 'pa-svg', role: 'group', 'aria-label': 'Candidates by stock (across) and order cost (up)' });
  const mapHead = h('div', { class: 'pa-mh' }, h('h2', {}, 'Market for this order'),
    h('span', {}, 'across: stock on the reel (log) · up: what the order costs with it, loading fee included · drag the blue line to change the quantity · click a part to compare it'));
  const legend = h('div', { class: 'pa-legend' },
    h('span', {}, h('i', { style: 'border:1.8px solid var(--ok)' }), 'footprint fits'),
    h('span', {}, h('i', { style: 'border:1.8px solid var(--warn)' }), 'footprint change'),
    h('span', {}, h('i', { style: 'border:1.8px dashed var(--ink-soft)' }), 'not enough stock'),
    h('span', {}, '┆ dotted stem = the Extended loading fee on top of the parts'),
    h('span', {}, 'tiles show the land pattern (approximate)'));
  const map = h('section', { class: 'pa-card pa-map' }, mapHead, svg, legend);
  const warnsEl = h('div', { class: 'pa-warns', role: 'status' });
  const more = h('details', { class: 'pa-more' }, h('summary', {}, 'Edit the candidate rows and every input'), ctx.form);
  const notesEl = h('details', { class: 'pa-more' });

  // ---------- compare + list ----------
  const cmp = h('section', { class: 'pa-card', 'aria-live': 'polite' });
  const listCard = h('section', { class: 'pa-card' }, h('div', { class: 'pa-cmp-h' }, h('h2', {}, 'Ranked')), h('div', { class: 'pa-list', role: 'listbox', 'aria-label': 'Candidates, best first' }));
  const list = listCard.querySelector('.pa-list');

  root.append(top, h('div', { class: 'pa', style: 'margin-top:12px' },
    h('div', { class: 'pa-col' }, map, warnsEl, more),
    h('div', { class: 'pa-col' }, cmp, listCard, ctx.outputs, notesEl)));

  // ---------- state ----------
  let sel = null;       // candidate row index (input.candidates)
  let drag = null;
  let axes = null;      // frozen while dragging the quantity
  let pending = null;
  const setSoon = (obj) => {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const ranked = () => ctx.result?.ranked || [];
  const selected = () => ranked().find((r) => r.i === sel) || null;
  const status4 = (r) => (!r.inStock ? 'short' : r.pkgFit === 'different' ? 'change' : 'fit');

  // ---------- live search (in the app) ----------
  let busy = false;
  async function search() {
    const q = String(ctx.raw.query || '').trim();
    if (!q || busy) return;
    if (!served) { setStatus('Open this tool in the app to search LCSC; edit the candidate rows by hand meanwhile.', 'bad'); return; }
    busy = true; searchBtn.disabled = true; searchBtn.textContent = 'Searching…';
    setStatus(`Searching LCSC for "${q}"…`, '');
    try {
      const r = await fetch(`/api/parts/search?q=${encodeURIComponent(q)}&limit=20`);
      if (!r.ok) {
        let why = `${r.status}`;
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 502 || r.status === 503 ? `LCSC did not answer (${why}); try again in a minute.` : `search failed: ${why}`);
      }
      const rowsIn = await r.json();
      const CLASS = (c) => { const t = String(c || '').toLowerCase(); return t.startsWith('basic') ? 'basic' : t.startsWith('pref') ? 'preferred' : t.startsWith('ext') ? 'extended' : null; };
      const had = new Map((ctx.raw.candidates || []).map((c) => [String(c.lcsc), c.class]));
      const cand = rowsIn.map((p) => ({
        lcsc: p.lcsc || '', mpn: p.mpn || '', package: p.package || '', maker: p.maker || p.manufacturer || '',
        stock: p.stock == null ? '' : String(p.stock), price: p.price == null ? '' : String(p.price),
        class: CLASS(p.jlc_class) || (had.get(String(p.lcsc)) && had.get(String(p.lcsc)) !== 'unknown' ? had.get(String(p.lcsc)) : 'unknown'),
      }));
      setStatus(cand.length ? `${cand.length} parts found for "${q}". Set the class where you know it (jlcpcb.com/parts).` : `Nothing found for "${q}": try the bare MPN or a shorter description.`, cand.length ? 'ok' : 'bad');
      sel = null;
      ctx.set('candidates', cand);
    } catch (e) {
      setStatus(`${e.message || e}`, 'bad');
    } finally { busy = false; searchBtn.disabled = false; searchBtn.textContent = 'Search LCSC'; }
  }
  function setStatus(t, tone) { status.textContent = t; status.className = `pa-status ${tone || ''}`; }
  setStatus(served ? 'Replaces the candidate rows with up to 20 catalogue parts; the original is left out by its LCSC number.' : 'Opened as a file: edit the candidate rows by hand.', '');

  // ---------- map drawing ----------
  function computeAxes(rk, o) {
    const stocks = rk.map((r) => r.stock).filter((v) => v > 0);
    const lo = Math.min(o.qty, ...stocks) / 2.5, hi = Math.max(o.qty, ...stocks) * 2.5;
    const costs = rk.map((r) => r.cost).filter((v) => v != null && Number.isFinite(v));
    if (o.origCost != null) costs.push(o.origCost);
    const cmax = Math.max(1, ...costs) * 1.12;
    return { lx0: Math.log10(Math.max(1, lo)), lx1: Math.log10(Math.max(10, hi)), cmax };
  }
  function niceStep(span, target) {
    const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  let G = null;
  function draw() {
    const res = ctx.result || {}, rk = res.ranked || [], o = res.order;
    svg.replaceChildren();
    const W = Math.max(300, svg.parentElement.clientWidth - 12);
    const narrow = W < 560;
    const topPx = svg.getBoundingClientRect().top + window.scrollY;
    const Hh = narrow ? 380 : clamp(window.innerHeight - topPx - 60, 360, 640);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!o) return;
    const A = axes || computeAxes(rk, o);
    const L = narrow ? 44 : 58, R = narrow ? 14 : 24, T = narrow ? 46 : 30, B = 36, Z = narrow ? 30 : 40; // Z: the "0 in stock" gutter
    const x0 = L + Z, x1 = W - R, y0 = Hh - B, y1 = T;
    const X = (s) => (s > 0 ? x0 + (Math.log10(s) - A.lx0) / (A.lx1 - A.lx0) * (x1 - x0) : L + Z / 2);
    const Xinv = (px) => 10 ** (A.lx0 + (px - x0) / (x1 - x0) * (A.lx1 - A.lx0));
    const Y = (c) => y0 - (c / A.cmax) * (y0 - y1);
    G = { X, Xinv, x0, x1, y0, y1, L, Z, A };

    // regions: short of stock (left of the need line), cheaper than the original (below its line)
    const xq = clamp(X(o.qty), x0, x1);
    svg.append(sv('rect', { x: L, y: y1, width: xq - L, height: y0 - y1, class: 'pa-short' }));
    if (o.origCost != null) svg.append(sv('rect', { x: xq, y: Y(o.origCost), width: x1 - xq, height: y0 - Y(o.origCost), class: 'pa-cheap' }));
    // grid + axes
    const ys = niceStep(A.cmax, narrow ? 4 : 6);
    for (let c = 0; c <= A.cmax + 1e-9; c += ys) {
      svg.append(sv('line', { x1: L, x2: x1, y1: Y(c), y2: Y(c), class: 'pa-gr' }));
      svg.append(sv('text', { x: L - 6, y: Y(c) + 3.5, 'text-anchor': 'end', class: 'pa-tk' }, c >= 1 ? `$${fmt(c, 4)}` : `$${fmt(c, 2)}`));
    }
    for (let e = Math.ceil(A.lx0); e <= Math.floor(A.lx1); e++) {
      const s = 10 ** e;
      svg.append(sv('line', { x1: X(s), x2: X(s), y1: y1, y2: y0, class: 'pa-gr' }));
      svg.append(sv('text', { x: X(s), y: y0 + 14, 'text-anchor': 'middle', class: 'pa-tk' }, pcs(s)));
    }
    svg.append(sv('line', { x1: L + Z, x2: L + Z, y1: y1, y2: y0, class: 'pa-ax', 'stroke-dasharray': '2 3' }));
    svg.append(sv('text', { x: L + Z / 2, y: y0 + 14, 'text-anchor': 'middle', class: 'pa-tk' }, '0'));
    svg.append(sv('line', { x1: L, x2: x1, y1: y0, y2: y0, class: 'pa-ax' }));
    svg.append(sv('text', { x: x1, y: y0 + 29, 'text-anchor': 'end', class: 'pa-axl' }, 'stock on the reel, pcs →'));
    svg.append(sv('text', { x: 6, y: 16, class: 'pa-axl' }, `order cost for ${o.qty} pcs ↑`));
    svg.append(sv('text', { x: L + 6, y: y1 + 14, class: 'pa-shortt' }, xq - L > 110 ? 'not enough stock' : ''));

    // original's cost line
    if (o.origCost != null) {
      const yo = Y(o.origCost);
      svg.append(sv('line', { x1: L, x2: x1, y1: yo, y2: yo, class: 'pa-orig' }));
      svg.append(sv('text', { x: x1 - 4, y: yo - 6, 'text-anchor': 'end', class: 'pa-origt pa-halo' }, `original ${o.origLcsc || o.origMpn}  ${money(o.origCost)}`));
      if (y0 - yo > 40) svg.append(sv('text', { x: x1 - 4, y: yo + 16, 'text-anchor': 'end', class: 'pa-cheapt pa-halo' }, 'cheaper than the original'));
    }

    // candidates: stems, then tiles (worst first so the best sits on top)
    const TS = narrow ? 26 : 34;
    const place = rk.filter((r) => r.cost != null).map((r) => ({ r, x: X(r.stock), y: Y(r.cost) }));
    // nudge overlapping tiles apart (vertical first, keeping x honest)
    place.sort((a, b) => a.y - b.y);
    for (let it = 0; it < 30; it++) {
      let moved = false;
      for (let a = 0; a < place.length; a++) for (let b = a + 1; b < place.length; b++) {
        const P = place[a], Q = place[b];
        const dx = Math.abs(P.x - Q.x), dy = Math.abs(P.y - Q.y);
        if (dx < TS + 2 && dy < TS + 2) {
          const push = (TS + 2 - dy) / 2 + 0.5;
          if (P.y <= Q.y) { P.y -= push; Q.y += push; } else { P.y += push; Q.y -= push; }
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const P of place) P.y = clamp(P.y, y1 + TS / 2, y0 - TS / 2);
    for (const P of place) {
      const r = P.r;
      if (r.fee > 0 && r.price != null) {
        const yp = Y(r.cost - r.fee);
        svg.append(sv('line', { x1: X(r.stock), x2: X(r.stock), y1: yp, y2: Y(r.cost), class: 'pa-stem' }));
        svg.append(sv('circle', { cx: X(r.stock), cy: yp, r: 2.2, class: 'pa-stemd' }));
      }
      if (Math.abs(P.y - Y(r.cost)) > 3) svg.append(sv('line', { x1: X(r.stock), x2: P.x, y1: Y(r.cost), y2: P.y, class: 'pa-stem' }));
    }
    // labels: best first, each where it hits no tile and no label already placed
    const boxes = place.map((P) => [P.x - TS / 2 - 2, P.y - TS / 2 - 2, P.x + TS / 2 + 2, P.y + TS / 2 + 2]);
    const hitsAny = (bx) => boxes.some((q) => bx[0] < q[2] && bx[2] > q[0] && bx[1] < q[3] && bx[3] > q[1]);
    const labAt = new Map();
    for (const P of [...place].sort((a, b) => a.r.rank - b.r.rank)) {
      const r = P.r;
      const l1 = narrow ? `#${r.rank}` : `#${r.rank} ${String(r.maker || r.lcsc).split(/\s+/)[0].slice(0, 12)}`;
      const l2 = narrow ? '' : r.best ? `best · ${money(r.cost)}` : money(r.cost);
      const w = Math.max(l1.length * 6.3, l2.length * 6.2) + 2, hh = narrow ? 13 : 26;
      const cands = [
        ['start', P.x + TS / 2 + 5, P.y - hh / 2], ['end', P.x - TS / 2 - 5, P.y - hh / 2],
        ['middle', P.x, P.y - TS / 2 - 4 - hh], ['middle', P.x, P.y + TS / 2 + 4],
        ['start', P.x + TS / 2 + 5, P.y - TS / 2 - hh + 4], ['start', P.x + TS / 2 + 5, P.y + TS / 2 - 4],
        ['end', P.x - TS / 2 - 5, P.y - TS / 2 - hh + 4], ['end', P.x - TS / 2 - 5, P.y + TS / 2 - 4],
        ['middle', P.x, P.y - TS / 2 - 8 - 2 * hh], ['middle', P.x, P.y + TS / 2 + 8 + hh],
      ];
      const over = (bx) => boxes.reduce((a, q) => a + Math.max(0, Math.min(bx[2], q[2]) - Math.max(bx[0], q[0])) * Math.max(0, Math.min(bx[3], q[3]) - Math.max(bx[1], q[1])), 0);
      let pick = null, bestOver = Infinity;
      for (const [anc, x, yTop] of cands) {
        const bx0 = anc === 'start' ? x : anc === 'end' ? x - w : x - w / 2;
        const bx = [bx0, yTop, bx0 + w, yTop + hh];
        if (bx[0] < L || bx[2] > x1 + R - 2 || bx[1] < y1 - 2 || bx[3] > y0 + 2) continue;
        if (!hitsAny(bx)) { pick = { anc, x, yTop, bx }; break; }
        const ov = over(bx);
        if (ov < bestOver) { bestOver = ov; pick = { anc, x, yTop, bx, soft: true }; }
      }
      if (!pick) { const [anc, x, yTop] = cands[0]; pick = { anc, x, yTop, bx: [x, yTop, x + w, yTop + hh] }; }
      boxes.push(pick.bx);
      labAt.set(r.i, { ...pick, l1, l2 });
    }
    const order = [...place].sort((a, b) => b.r.rank - a.r.rank);
    for (const P of order) {
      const r = P.r, st = status4(r);
      const g = sv('g', { class: `pa-cand ${st}${r.i === sel ? ' is-sel' : ''}`, 'data-i': r.i, tabindex: 0, role: 'button',
        'aria-label': `#${r.rank} ${r.lcsc} ${r.maker} ${r.pkg}: ${r.stock ?? 'unknown'} in stock, order cost ${money(r.cost)}, ${r.verdict}` });
      g.append(sv('rect', { x: P.x - TS / 2 - 3, y: P.y - TS / 2 - 3, width: TS + 6, height: TS + 6, rx: 7, class: 'sel' }));
      g.append(sv('rect', { x: P.x - TS / 2, y: P.y - TS / 2, width: TS, height: TS, rx: 5, class: 'tile' }));
      const fp = footprint(r.fam);
      const [ew, eh] = fpExtent(fp);
      drawFp(g, fp, P.x, P.y, (TS - 8) / Math.max(ew, eh, 1));
      g.append(sv('title', {}, `#${r.rank} ${r.lcsc} · ${r.mpn}\n${r.maker} · ${r.pkg} (${r.pkgFit})\nstock ${r.stock ?? '?'} · ${money(r.price)} each · ${r.eff}\norder ${money(r.cost)} · ${r.verdict}`));
      svg.append(g);
    }
    for (const P of place) {
      const r = P.r, st = status4(r), Lb = labAt.get(r.i);
      const bx = Lb.bx, cxm = clamp(P.x, bx[0], bx[2]), cym = clamp(P.y, bx[1], bx[3]);
      if (Math.hypot(cxm - P.x, cym - P.y) > TS / 2 + 14) svg.append(sv('line', { x1: P.x, y1: P.y + (cym < P.y ? -TS / 2 : TS / 2), x2: cxm, y2: cym < P.y ? bx[3] : bx[1], class: 'pa-stem' }));
      svg.append(sv('text', { x: Lb.x, y: Lb.yTop + 10, 'text-anchor': Lb.anc, class: `pa-cl pa-halo${st === 'short' ? ' soft' : ''}` }, Lb.l1));
      if (Lb.l2) svg.append(sv('text', { x: Lb.x, y: Lb.yTop + 23, 'text-anchor': Lb.anc, class: `pa-rk pa-halo${r.best ? ' best' : ''}` }, Lb.l2));
    }

    // the need line and its handle (drawn last: always on top)
    svg.append(sv('line', { x1: xq, x2: xq, y1: y1 - 4, y2: y0, class: 'pa-need' }));
    const lab = `need ${o.qty}`;
    const hw = lab.length * 7.2 + 14;
    const hx = clamp(xq - hw / 2, L, x1 - hw);
    const hd = sv('g', { class: 'pa-needh', tabindex: 0, role: 'slider', 'aria-label': `Order quantity ${o.qty} pieces (${o.boards} boards × ${o.per}). Left/right change the board count.`,
      'aria-valuenow': o.boards, 'data-need': 1 });
    hd.append(sv('rect', { x: hx, y: y1 - 22, width: hw, height: 19, rx: 4 }));
    hd.append(sv('text', { x: hx + hw / 2, y: y1 - 8.5, 'text-anchor': 'middle' }, lab));
    svg.append(hd);
    svg.append(sv('rect', { x: xq - 6, y: y1, width: 12, height: y0 - y1, fill: 'transparent', 'data-need': 1, style: 'cursor:ew-resize' }));
  }

  // ---------- map interaction ----------
  function pt(e) {
    const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  svg.addEventListener('pointerdown', (e) => {
    const need = e.target.closest('[data-need]');
    const cand = e.target.closest('.pa-cand');
    if (need) {
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      drag = { kind: 'need' };
      axes = G?.A || null;
      svg.querySelector('.pa-needh')?.focus({ preventScroll: true });
      return;
    }
    if (cand) { select(Number(cand.dataset.i)); cand.focus({ preventScroll: true }); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || !G) return;
    const q = pt(e);
    const per = ctx.result?.order?.per || 1;
    const qty = G.Xinv(clamp(q.x, G.x0, G.x1));
    const boards = Math.max(1, Math.round(qty / per));
    // round the board count to something an order would use
    const nice = boards < 20 ? boards : boards < 100 ? Math.round(boards / 5) * 5 : boards < 1000 ? Math.round(boards / 10) * 10 : Math.round(boards / 100) * 100;
    setSoon({ boards: String(nice) });
  });
  const end = () => { if (!drag) return; drag = null; axes = null; requestAnimationFrame(draw); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('keydown', (e) => {
    if (e.target.closest?.('.pa-needh')) {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const b = ctx.result?.order?.boards || 1;
      const st = (b < 20 ? 1 : b < 100 ? 5 : b < 1000 ? 10 : 100) * (e.shiftKey ? 10 : 1);
      ctx.set('boards', String(Math.max(1, Math.round((b + d * st) / st) * st)));
      focusNeed = true;
      return;
    }
    const c = e.target.closest?.('.pa-cand');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(Number(c.dataset.i)); }
  });
  let focusNeed = false;

  function select(i) {
    sel = i;
    for (const g of svg.querySelectorAll('.pa-cand')) g.classList.toggle('is-sel', Number(g.dataset.i) === sel);
    for (const li of list.querySelectorAll('.pa-li')) li.classList.toggle('is-sel', Number(li.dataset.i) === sel);
    drawCompare();
  }
  function setClass(i, cls) {
    const rows = (ctx.raw.candidates || []).map((r) => ({ ...r }));
    if (!rows[i]) return;
    rows[i].class = cls;
    ctx.set('candidates', rows);
  }

  // ---------- compare ----------
  function drawCompare() {
    const o = ctx.result?.order;
    const r = selected();
    if (!o) { cmp.replaceChildren(); return; }
    const rk = ranked();
    const idx = r ? rk.indexOf(r) : -1;
    const nav = h('span', { class: 'nav' },
      h('button', { class: 'pa-btn', 'aria-label': 'Previous candidate', disabled: idx <= 0, onclick: () => select(rk[idx - 1].i) }, '‹'),
      h('button', { class: 'pa-btn', 'aria-label': 'Next candidate', disabled: idx < 0 || idx >= rk.length - 1, onclick: () => select(rk[idx + 1].i) }, '›'));
    const head = h('div', { class: 'pa-cmp-h' }, h('h2', {}, r ? `Swap check: #${r.rank} against your part` : 'Swap check'), nav);
    if (!r) { cmp.replaceChildren(head, h('div', { class: 'pa-verdict warn' }, 'Pick a candidate on the map or in the list.')); return; }

    // the two land patterns, side by side at one scale
    const fa = footprint(o.origFam), fb = footprint(r.fam);
    const [aw, ah] = fpExtent(fa), [bw, bh] = fpExtent(fb);
    const W = 352, Hs = 132, k = Math.min((W / 2 - 30) / Math.max(aw, bw), (Hs - 44) / Math.max(ah, bh));
    const fsv = sv('svg', { class: 'pa-fps', viewBox: `0 0 ${W} ${Hs}`, role: 'img', 'aria-label': `Land patterns: ${o.origPackage} and ${r.pkg}, same scale` });
    const ga = sv('g'), gb = sv('g');
    drawFp(ga, fa, W / 4, Hs / 2 + 2, k, true);
    drawFp(gb, fb, (3 * W) / 4, Hs / 2 + 2, k, true);
    fsv.append(ga, gb);
    fsv.append(sv('line', { x1: W / 2, x2: W / 2, y1: 10, y2: Hs - 10, stroke: 'var(--line-soft)' }));
    fsv.append(sv('text', { x: W / 4, y: 16, 'text-anchor': 'middle', class: 'pa-fpl' }, `yours · ${o.origPackage || '?'}`));
    fsv.append(sv('text', { x: (3 * W) / 4, y: 16, 'text-anchor': 'middle', class: 'pa-fpl' }, `#${r.rank} · ${r.pkg || '?'}`));
    const fitTxt = r.pkgFit === 'same' ? 'same package' : r.pkgFit === 'same family' ? `same family (${r.fam})` : r.pkgFit === 'different' ? 'different footprint' : 'package unknown';
    fsv.append(sv('text', { x: W / 2, y: Hs - 6, 'text-anchor': 'middle', class: 'pa-tk', fill: r.pkgFit === 'different' ? 'var(--warn)' : 'var(--ok)' }, `${fitTxt} · approximate outlines, one scale`));

    const stockBar = (s) => {
      const f = s == null ? 0 : clamp(Math.log10(Math.max(1, s)) / Math.log10(Math.max(10, o.qty * 10)), 0, 1);
      const col = s != null && s >= o.qty ? 'var(--ok)' : 'var(--danger)';
      return h('span', { class: 'pa-sbar', title: `need ${o.qty}` }, h('i', { style: `width:${f * 100}%;background:${col}` }));
    };
    const seg = h('span', { class: 'pa-seg', role: 'group', 'aria-label': 'Candidate JLCPCB class' },
      CLASSES.map((c) => h('button', { 'aria-pressed': String(r.cls === c), 'aria-label': c, title: c === 'unknown' ? `unknown: counted as ${o.assume}` : c, onclick: () => setClass(r.i, c) }, c === 'unknown' ? '?' : c[0].toUpperCase())));
    const diff = o.origCost != null && r.cost != null ? r.cost - o.origCost : null;
    const tr = (label, a, b, cls) => h('tr', {}, h('th', {}, label), h('td', {}, a), h('td', { class: cls || '' }, b));
    const table = h('table', { class: 'pa-tab' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', { style: 'padding-left:0' }, 'yours'), h('th', { style: 'padding-left:0' }, `#${r.rank}`))),
      h('tbody', {},
        tr('LCSC', o.origLcsc || '–', r.lcsc || '–'),
        tr('MPN', o.origMpn || '–', r.mpn || '–', r.sameMpn ? 'ok' : ''),
        tr('Maker', '–', r.maker || '–'),
        tr('Stock', h('span', {}, o.origStock != null ? pcs(o.origStock) : '?', stockBar(o.origStock)), h('span', {}, pcs(r.stock), stockBar(r.stock)), r.inStock ? 'ok' : 'bad'),
        tr('Unit price', money(o.origPrice), money(r.price)),
        tr('Class', `${o.origClass}${o.origFee ? ` +$${o.fee}` : ''}`, h('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' }, seg, h('span', {}, r.eff))),
        tr(`Order, ${o.qty} pcs`, money(o.origCost), h('span', {}, money(r.cost), r.fee ? h('span', { style: 'color:var(--ink-soft)' }, ` incl. $${fmt(r.fee, 3)} fee`) : null),
          diff != null ? (diff <= 0 ? 'ok' : 'warn') : '')));
    const tone = !r.inStock ? 'bad' : r.pkgFit === 'different' ? 'warn' : '';
    const verdict = h('div', { class: `pa-verdict ${tone}` },
      h('b', {}, r.verdict), ' · ',
      diff == null ? 'no price to compare' : diff <= 0 ? h('span', {}, 'saves ', h('b', {}, money(-diff)), ' per order') : h('span', {}, 'costs ', h('b', {}, money(diff)), ' more per order'),
      r.best ? h('span', {}, ' · ', h('b', { style: 'color:var(--ok)' }, 'best alternative')) : null);
    cmp.replaceChildren(head, fsv, table, verdict);
  }

  // ---------- ranked list ----------
  function drawList() {
    const rk = ranked();
    list.replaceChildren(...rk.map((r) => {
      const st = status4(r);
      const li = h('div', { class: `pa-li${r.i === sel ? ' is-sel' : ''}`, 'data-i': r.i, role: 'option', tabindex: 0, 'aria-selected': String(r.i === sel) },
        h('span', { class: 'r' }, `${r.rank}`),
        h('span', { class: 'n' }, `${r.lcsc || '–'} · ${r.pkg || '?'}`),
        h('span', { class: 'c' }, money(r.cost)),
        h('span', { class: 'm' }, `${r.maker || '?'} · ${pcs(r.stock)} in stock · ${r.eff}`),
        h('span', { class: `v ${st === 'short' ? 'bad' : st === 'change' ? 'warn' : 'ok'}` }, r.verdict));
      li.addEventListener('click', () => select(r.i));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.i); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling; if (n) { n.focus(); select(Number(n.dataset.i)); } }
      });
      return li;
    }));
    listCard.querySelector('h2').textContent = `Ranked · ${rk.length} candidate${rk.length === 1 ? '' : 's'}`;
  }

  // ---------- sync ----------
  function syncTop(res) {
    const raw = ctx.raw;
    for (const [k, e] of Object.entries(bind)) {
      if (document.activeElement !== e) e.value = raw[k] ?? '';
      e.classList.toggle('bad', e.classList.contains('num') && String(raw[k] ?? '').trim() !== '' && ctx.parseEng(String(raw[k])) == null);
    }
    origCls.value = raw.orig_class; assumeSel.value = raw.assume;
    const o = res.order;
    qtyB.textContent = o ? String(o.qty) : '–';
    origFp.replaceChildren();
    const fp = footprint(o?.origFam);
    const [ew, eh] = fpExtent(fp);
    drawFp(origFp, fp, 22, 17, 28 / Math.max(ew, eh, 1));
    searchBtn.textContent = busy ? 'Searching…' : 'Search LCSC';
  }

  ctx.onResult((res) => {
    const rk = res.ranked || [];
    if (sel == null || !rk.some((r) => r.i === sel)) sel = (rk.find((r) => r.best) || rk[0])?.i ?? null;
    syncTop(res);
    draw();
    if (focusNeed) { focusNeed = false; svg.querySelector('.pa-needh')?.focus({ preventScroll: true }); }
    drawCompare();
    drawList();
    warnsEl.replaceChildren(...(res.warnings || []).map((t) => h('div', {}, t)));
    notesEl.replaceChildren(h('summary', {}, 'How candidates are ranked'), h('ul', {}, (res.notes || []).map((t) => h('li', {}, t))));
  });
  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (!drag) draw(); }, 60); }).observe(map);
}
