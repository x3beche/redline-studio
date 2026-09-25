// Material Property Table page: the materials themselves, placed in property
// space. A log-log chart of any two properties (density against stiffness by
// default, the classic selection chart) with each family's bubble, where you
// point at a material to make it A and shift-click for B; a guide line of
// equal ratio through A that you drag to see who beats it; a ranking of the
// filtered materials by the sort key; and A against B on eight rulers that
// carry every other material as a tick. Every number comes from run().

const NS = 'http://www.w3.org/2000/svg';

const CSS = `
:root { --tool-mt-metal: #3f6fb0; --tool-mt-plastic: #d97706; --tool-mt-electronics: #0f9d8a; --tool-mt-ceramic: #a23fbf; --tool-mt-composite: #b3261e; --tool-mt-b: #0f9d8a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-mt-metal: #7da2e0; --tool-mt-plastic: #f0a33a; --tool-mt-electronics: #3cc7b3; --tool-mt-ceramic: #c982e0; --tool-mt-composite: #ec7a6f; --tool-mt-b: #3cc7b3; } }
:root[data-theme="dark"] { --tool-mt-metal: #7da2e0; --tool-mt-plastic: #f0a33a; --tool-mt-electronics: #3cc7b3; --tool-mt-ceramic: #c982e0; --tool-mt-composite: #ec7a6f; --tool-mt-b: #3cc7b3; }
.k-page { padding: 12px; }
.mt { display: grid; grid-template-columns: minmax(0, 1fr) 330px; grid-template-areas: "bar bar" "chart rank" "rulers rank"; gap: 10px 12px; align-items: start; }
@media (max-width: 1020px) { .mt { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "chart" "rulers" "rank"; } }
.mt-bar { grid-area: bar; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.mt-cats { display: flex; flex-wrap: wrap; gap: 4px; }
.mt-cat { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); cursor: pointer; font-size: 12px; color: var(--ink-soft); }
.mt-cat i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.mt-cat[aria-pressed="true"] { color: var(--ink); border-color: var(--ink-soft); background: var(--sunken); font-weight: 600; }
.mt-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-soft); }
.mt-filter input { width: 170px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 14px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.mt-ab { margin-left: auto; display: inline-flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-soft); flex-wrap: wrap; }
.mt-ab label { display: inline-flex; align-items: center; gap: 5px; }
.mt-ab b { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; color: var(--accent-ink); background: var(--accent); }
.mt-ab b.b { background: var(--tool-mt-b); }
.mt-ab select { max-width: 190px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); font-size: 12px; }
.mt-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; position: relative; }
.mt-chart { grid-area: chart; height: clamp(340px, calc(100vh - 400px), 760px); }
.mt-chart svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.mt-chart:focus-within { border-color: var(--line); }
.mt-axsel { position: absolute; font-size: 12px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); font-weight: 600; }
.mt-hint { position: absolute; right: 10px; top: 7px; font-size: 11px; color: var(--ink-soft); pointer-events: none; }
.mt-tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; padding: 5px 8px; font-size: 11.5px;
  box-shadow: 0 2px 8px rgba(0,0,0,.18); display: none; z-index: 2; min-width: 170px; }
.mt-tip b { display: block; font-size: 12px; }
.mt-tip div { display: flex; justify-content: space-between; gap: 12px; font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.mt-tip div span:last-child { color: var(--ink); }
.mt svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 10.5px; fill: var(--ink-soft); }
.mt svg text.v { fill: var(--ink); font-weight: 600; }
.mt svg text.t { font-family: "IBM Plex Sans", sans-serif; font-size: 11.5px; }
.mt svg .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.mt .dot { cursor: pointer; }
.mt .hd { cursor: ns-resize; outline: none; }
.mt .hd:focus-visible circle.ring { stroke-width: 3.5; }
.mt svg:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.mt.dragging, .mt.dragging * { cursor: grabbing !important; }
.mt-rulers { grid-area: rulers; }
.mt-rulers svg { display: block; width: 100%; }
.mt-card h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 7px 10px 2px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.mt-card h2 b { color: var(--ink); font-weight: 600; }
.mt-rank { grid-area: rank; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.mt-sorts { display: flex; flex-wrap: wrap; gap: 3px; padding: 4px 10px 8px; border-bottom: 1px solid var(--line); }
.mt-sorts button { border: 1px solid var(--line); background: var(--surface); border-radius: 4px; padding: 1px 5px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.mt-sorts button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.mt-list { max-height: calc(100vh - 470px); min-height: 200px; overflow-y: auto; padding: 2px 0; }
.mt-item { display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 1px 8px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line-soft);
  background: transparent; padding: 3px 10px 4px; cursor: pointer; font-size: 12px; color: var(--ink); position: relative; }
.mt-item:hover { background: var(--sunken); }
.mt-item .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mt-item .n i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
.mt-item .val { text-align: right; font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.mt-item .bar { grid-column: 1 / span 2; height: 3px; background: var(--sunken); border-radius: 2px; overflow: hidden; }
.mt-item .bar span { display: block; height: 100%; border-radius: 2px; opacity: .8; }
.mt-item.a { box-shadow: inset 3px 0 0 var(--accent); background: var(--sunken); font-weight: 600; }
.mt-item.b { box-shadow: inset 3px 0 0 var(--tool-mt-b); background: var(--sunken); font-weight: 600; }
.mt-item em { font-style: normal; font-size: 10px; color: var(--ink-soft); font-weight: 400; margin-left: 5px; }
.mt-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mt-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.mt-msgs:empty { display: none; }
.mt-rank .k-out { max-height: 240px; }
.mt-rank .k-count { display: none; }
@media (max-width: 1020px) { .mt-list { max-height: 420px; } }
@media (max-width: 640px) { .mt-chart { height: 420px; } .mt-hint { display: none; } .mt-ab { margin-left: 0; } .mt-filter input { width: 130px; } }
`;

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
const s = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};
const P = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
const f3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(3))));

const PROPS = {
  rho: { short: 'ρ', name: 'Density', unit: 'g/cm³' },
  E: { short: 'E', name: "Young's modulus", unit: 'GPa' },
  sy: { short: 'Sy', name: 'Yield strength', unit: 'MPa' },
  uts: { short: 'UTS', name: 'Tensile strength', unit: 'MPa' },
  cte: { short: 'CTE', name: 'Thermal expansion', unit: 'ppm/K' },
  k: { short: 'k', name: 'Thermal conductivity', unit: 'W/(m·K)' },
  spE: { short: 'E/ρ', name: 'Specific stiffness', unit: 'GPa·cm³/g' },
  spS: { short: 'Sy/ρ', name: 'Specific strength', unit: 'MPa·cm³/g' },
};
const PKEYS = Object.keys(PROPS);
const CATS = [['all', 'All'], ['metal', 'Metals'], ['plastic', 'Plastics'], ['electronics', 'Electronics'], ['ceramic', 'Ceramics & glass'], ['composite', 'Composites']];
const COL = (c) => `var(--tool-mt-${c})`;
const short = (n) => n.replace(/ \((?:FDM print|ASTM F15|Delrin|SLS)\)/, '').replace(/^Aluminium /, 'Al ').replace(/^Stainless /, 'SS ')
  .replace(/^Steel /, '').replace(/ quasi-isotropic/, '').replace(/^Nylon /, '').replace(/ die cast$/, ' cast').replace(/^Acetal /, '')
  .replace(/^Beryllium copper /, 'BeCu ').replace(/^Titanium /, '').replace(/^Magnesium /, 'Mg ').replace(/^Zinc /, '').replace(/^Copper /, 'Cu ')
  .replace(/^Brass /, 'Brass ').replace(/ \((PC|PP)\)$/, '').replace(/^Solder /, '').replace(/ glass$/, '');

// Convex hull (monotone chain) of screen points.
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let res = null, pts = [], guide = null, hover = null, cur = null;

  // ---------------- toolbar ----------------
  const catBtns = CATS.map(([id, name]) => h('button', { class: 'mt-cat', 'aria-pressed': 'false', onclick: () => ctx.set('category', id) },
    id === 'all' ? null : h('i', { style: `background:${COL(id)}` }), name));
  const filterIn = h('input', { type: 'search', spellcheck: 'false', placeholder: 'aluminium, stainless, print…', 'aria-label': 'Filter materials' });
  filterIn.addEventListener('input', () => ctx.set('filter', filterIn.value));
  const matOpts = ctx.manifest.inputs.find((d) => d.key === 'focus').options;
  const selA = h('select', { 'aria-label': 'Material A', onchange: (e) => ctx.set('focus', e.target.value) }, matOpts.map(([v, t]) => h('option', { value: v }, t)));
  const selB = h('select', { 'aria-label': 'Material B (compare)', onchange: (e) => ctx.set('compare', e.target.value) },
    ctx.manifest.inputs.find((d) => d.key === 'compare').options.map(([v, t]) => h('option', { value: v }, v === 'none' ? '(none)' : t)));
  const bar = h('div', { class: 'mt-bar' },
    h('div', { class: 'mt-cats', role: 'group', 'aria-label': 'Category' }, catBtns),
    h('label', { class: 'mt-filter' }, 'Filter', filterIn),
    h('div', { class: 'mt-ab' }, h('label', {}, h('b', {}, 'A'), selA), h('label', {}, h('b', { class: 'b' }, 'B'), selB)));

  // ---------------- chart ----------------
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Material chart. Arrow keys move A to the nearest material in that direction. B is chosen in the B list or with shift-click.');
  const axSel = (key, label) => {
    const sel = h('select', { class: 'mt-axsel', 'aria-label': label, onchange: (e) => ctx.set(key, e.target.value) },
      PKEYS.map((k) => h('option', { value: k }, `${PROPS[k].name}, ${PROPS[k].unit}`)));
    return sel;
  };
  const xSel = axSel('xprop', 'Chart across'), ySel = axSel('yprop', 'Chart up');
  const tip = h('div', { class: 'mt-tip' });
  const chart = h('section', { class: 'mt-card mt-chart' }, svg, xSel, ySel, tip,
    h('div', { class: 'mt-hint' }, 'click: A · shift-click: B · drag ◆ on the line'));

  // ---------------- rulers ----------------
  const rsvg = document.createElementNS(NS, 'svg');
  const rhead = h('h2', {}, 'A against B');
  const rulers = h('section', { class: 'mt-card mt-rulers' }, rhead, rsvg);

  // ---------------- rank ----------------
  const sortBtns = [['name', 'Name'], ...PKEYS.map((k) => [k, PROPS[k].short])].map(([k, t]) =>
    h('button', { 'aria-pressed': 'false', title: k === 'name' ? 'Sort by name' : `Sort by ${PROPS[k].name}`, onclick: () => ctx.set('sort', k) }, t));
  const list = h('div', { class: 'mt-list', role: 'list' });
  const rankHead = h('h2', {}, 'Ranking');
  const msgs = h('div', { class: 'mt-msgs', 'aria-live': 'polite' });
  const rank = h('aside', { class: 'mt-rank' },
    h('section', { class: 'mt-card' }, rankHead, h('div', { class: 'mt-sorts', role: 'group', 'aria-label': 'Sort by' }, sortBtns), list),
    msgs, ctx.outputs);

  const wrap = h('div', { class: 'mt' }, bar, chart, rulers, rank);
  root.append(wrap);

  const pick = (id, asB) => {
    if (!id) return;
    if (asB) ctx.set('compare', id === ctx.raw.focus ? 'none' : id);
    else if (id === ctx.raw.compare) ctx.setMany({ focus: id, compare: ctx.raw.focus });
    else ctx.set('focus', id);
  };

  // ---------------- chart drawing ----------------
  function drawChart() {
    const W = chart.clientWidth || 800, H = chart.clientHeight || 500;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!pts.length) return;
    const xk = ctx.raw.xprop || 'rho', yk = ctx.raw.yprop || 'E';
    const on = pts.filter((m) => m[xk] > 0 && m[yk] > 0);
    const off = pts.filter((m) => !(m[xk] > 0 && m[yk] > 0));
    const L = 62, R = 16, T = 30, B = 52;
    // The axes fit what the category and filter keep (and A and B); the rest stay as faint dots where they fall.
    const keep = on.filter((m) => m.shown || m.id === ctx.raw.focus || m.id === ctx.raw.compare);
    const fit = keep.length >= 2 ? keep : on;
    const range = (k) => {
      const v = fit.map((m) => m[k]);
      let lo = Math.log10(Math.min(...v)), hi = Math.log10(Math.max(...v));
      const pad = Math.max(0.12, (hi - lo) * 0.06);
      return [lo - pad, hi + pad];
    };
    const [x0, x1] = range(xk), [y0, y1] = range(yk);
    const X = (v) => L + ((Math.log10(v) - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (Math.log10(v) - y0) / (y1 - y0)) * (H - T - B);
    cur = { X, Y, xk, yk, W, H, L, R, T, B, x0, x1, y0, y1 };
    // grid: decades strong, 2 and 5 light
    const grid = s('g');
    const ticks = (lo, hi) => {
      const out = [];
      // Few decades: 1-2-5; a zoomed-in chart gets every digit so it still has labels.
      const ms = hi - lo > 1.6 ? [1, 2, 5] : hi - lo > 0.7 ? [1, 2, 3, 4, 5, 6, 8] : [1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9];
      for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) for (const m of ms) { const v = m * 10 ** d; if (Math.log10(v) >= lo && Math.log10(v) <= hi) out.push([v, m === 1]); }
      return out;
    };
    const lab = (v) => (v >= 1000 || v < 0.01 ? `${v / 10 ** Math.floor(Math.log10(v)) === 1 ? '' : v / 10 ** Math.floor(Math.log10(v)) + '·'}10${sup(Math.floor(Math.log10(v)))}` : String(Number(v.toPrecision(3))));
    for (const [v, major] of ticks(x0, x1)) {
      grid.append(s('line', { x1: X(v), x2: X(v), y1: T, y2: H - B, stroke: major ? 'var(--line)' : 'var(--line-soft)' }));
      grid.append(s('text', { x: X(v), y: H - B + 14, 'text-anchor': 'middle', class: major ? 'v' : '' }, lab(v)));
    }
    for (const [v, major] of ticks(y0, y1)) {
      grid.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: major ? 'var(--line)' : 'var(--line-soft)' }));
      grid.append(s('text', { x: L - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: major ? 'v' : '' }, lab(v)));
    }
    grid.append(s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'none', stroke: 'var(--line)' }));
    svg.append(grid);
    const defs = s('defs'), cp = s('clipPath', { id: 'mt-plot' });
    cp.append(s('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
    defs.append(cp); svg.append(defs);
    // family bubbles, from the materials the filter keeps
    const bub = s('g', { 'clip-path': 'url(#mt-plot)' });
    for (const [cat] of CATS.slice(1)) {
      const q = on.filter((m) => m.cat === cat && m.shown).map((m) => [X(m[xk]), Y(m[yk])]);
      if (!q.length) continue;
      const hp = hull(q);
      const d = hp.length === 1 ? `M${P(hp[0][0] - 0.1, hp[0][1])}L${P(hp[0][0] + 0.1, hp[0][1])}` : `M${hp.map((p) => P(p[0], p[1])).join('L')}Z`;
      bub.append(s('path', { d, fill: COL(cat), 'fill-opacity': 0.1, stroke: COL(cat), 'stroke-opacity': 0.14, 'stroke-width': 26, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    svg.append(bub);
    // the guide line of equal ratio y/x (slope 1 on log-log)
    const A = pts.find((m) => m.id === ctx.raw.focus) || pts[0];
    const Bm = pts.find((m) => m.id === ctx.raw.compare);
    const ratioOK = A[xk] > 0 && A[yk] > 0 && xk !== yk;
    let guideText = null, guideBox = null;
    if (ratioOK) {
      const c = guide ?? A[yk] / A[xk];
      // y = c x, clipped to the plot
      const xa = Math.max(10 ** x0, 10 ** y0 / c), xb = Math.min(10 ** x1, 10 ** y1 / c);
      if (xb > xa) {
        const above = on.filter((m) => m.shown && m[yk] / m[xk] > c * (1 + 1e-9) && m.id !== A.id);
        svg.append(s('path', { d: `M${P(X(xa), Y(c * xa))}L${P(X(xb), Y(c * xb))}L${P(X(xb), T)}L${P(X(xa), T)}Z`, fill: 'var(--accent)', 'fill-opacity': 0.04 }));
        svg.append(s('line', { x1: X(xa), y1: Y(c * xa), x2: X(xb), y2: Y(c * xb), stroke: 'var(--accent)', 'stroke-width': 1.3, 'stroke-dasharray': '7 4' }));
        const t = 0.82;
        const hx = 10 ** (Math.log10(xa) + t * (Math.log10(xb) - Math.log10(xa)));
        const hpx = X(hx), hpy = Y(c * hx);
        const lbl = `${PROPS[yk].short}/${PROPS[xk].short} = ${f3(c)}${guide == null ? ' (A)' : ''}`;
        guideText = [lbl, `${above.length} shown above the line: more ${PROPS[yk].short} per ${PROPS[xk].short}`];
        guideBox = [hpx - 12, hpy - 12, hpx + 12, hpy + 12];
        const hd = s('g', { class: 'hd', tabindex: '0', role: 'slider', 'aria-label': `Guide line ${lbl}`, 'aria-valuenow': f3(c) });
        hd.append(s('rect', { x: hpx - 12, y: hpy - 12, width: 24, height: 24, fill: 'transparent' }));
        hd.append(s('path', { class: 'ring', d: `M${P(hpx, hpy - 7)}L${P(hpx + 7, hpy)}L${P(hpx, hpy + 7)}L${P(hpx - 7, hpy)}Z`, fill: 'var(--surface)', stroke: 'var(--accent)', 'stroke-width': 2 }));
        hd.addEventListener('keydown', (e) => {
          const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
          if (e.key === 'Escape' || e.key === 'Home') { e.preventDefault(); guide = null; drawChart(); focusGuide(); return; }
          if (!k) return;
          e.preventDefault();
          guide = c * 10 ** (k * (e.shiftKey ? 0.1 : 0.02));
          drawChart(); focusGuide();
        });
        hd.addEventListener('dblclick', () => { guide = null; drawChart(); });
        hd.addEventListener('pointerdown', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const rect = svg.getBoundingClientRect(), sc = rect.height / H, id = ev.pointerId;
          const ly0 = Math.log10(c), py0 = ev.clientY;
          wrap.classList.add('dragging');
          const mv = (e) => { if (e.pointerId !== id) return; guide = 10 ** (ly0 - ((e.clientY - py0) / sc / (H - T - B)) * (y1 - y0)); drawChart(); };
          const up = (e) => { if (e.pointerId !== id) return; wrap.classList.remove('dragging'); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); focusGuide(); };
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
        });
        svg.append(hd);
        above.forEach((m) => svg.append(s('circle', { cx: X(m[xk]), cy: Y(m[yk]), r: 8, fill: 'none', stroke: 'var(--accent)', 'stroke-opacity': 0.35 })));
      }
    }
    // the materials
    const taken = guideBox ? [guideBox] : [];
    if (guideText) taken.push([L + 4, T + 4, L + 14 + Math.max(...guideText.map((t) => t.length)) * 6.3, T + 36]);
    const free = (b) => !taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
    const order = [...on].sort((a, b) => (a.id === A.id || a.id === Bm?.id) - (b.id === A.id || b.id === Bm?.id) || (a.shown - b.shown));
    const dots = s('g', { 'clip-path': 'url(#mt-plot)' }), labels = s('g');
    for (const m of order) {
      const px = X(m[xk]), py = Y(m[yk]);
      const isA = m.id === A.id, isB = Bm && m.id === Bm.id;
      const g = s('g', { class: 'dot', 'data-id': m.id, opacity: m.shown || isA || isB ? 1 : 0.22 });
      g.append(s('circle', { cx: px, cy: py, r: 10, fill: 'transparent' }));
      g.append(s('circle', { cx: px, cy: py, r: isA || isB ? 5.5 : 4, fill: COL(m.cat), stroke: 'var(--surface)', 'stroke-width': 1 }));
      if (isA || isB) g.append(s('circle', { cx: px, cy: py, r: 10, fill: 'none', stroke: isA ? 'var(--accent)' : 'var(--tool-mt-b)', 'stroke-width': 2.5 }));
      g.addEventListener('click', (e) => pick(m.id, e.shiftKey));
      g.addEventListener('pointerenter', () => showTip(m, px, py));
      g.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
      dots.append(g);
    }
    // labels: A and B first, then the kept ones where there is room
    const lorder = [...on].sort((a, b) => ((b.id === A.id) * 2 + (b.id === Bm?.id)) - ((a.id === A.id) * 2 + (a.id === Bm?.id)) || b.shown - a.shown);
    for (const m of lorder) {
      const isA = m.id === A.id, isB = Bm && m.id === Bm.id;
      if (!m.shown && !isA && !isB) continue;
      const px = X(m[xk]), py = Y(m[yk]);
      const t = (isA ? 'A ' : isB ? 'B ' : '') + short(m.name);
      const w = t.length * (isA || isB ? 6.6 : 6.1);
      const tries = [[px + 8, py + 4, 'start'], [px - 8, py + 4, 'end'], [px - w / 2, py - 9, 'start'], [px - w / 2, py + 16, 'start']];
      let placed = false;
      for (const [lx, ly, an] of tries) {
        const bx = an === 'end' ? lx - w : lx;
        const box = [bx - 1, ly - 10, bx + w + 1, ly + 2];
        if (bx < L || bx + w > W - R || ly - 10 < T) continue;
        if (!(isA || isB) && !free(box)) continue;
        taken.push(box);
        labels.append(s('text', { class: `${isA || isB ? 'v ' : ''}halo`, x: lx, y: ly, 'text-anchor': an, fill: isA ? 'var(--accent)' : isB ? 'var(--tool-mt-b)' : null,
          style: isA ? 'fill:var(--accent)' : isB ? 'fill:var(--tool-mt-b)' : null }, t));
        placed = true;
        break;
      }
      if (!placed && (isA || isB)) labels.append(s('text', { class: 'v halo', x: px + 8, y: py + 4, style: `fill:${isA ? 'var(--accent)' : 'var(--tool-mt-b)'}` }, t));
      taken.push([px - 5, py - 5, px + 5, py + 5]);
    }
    svg.append(dots, labels);
    if (guideText && W < 520) guideText = guideText.slice(0, 1);
    if (guideText) {
      const gx = L + 8, gy = T + 16;
      svg.append(s('rect', { x: gx - 4, y: gy - 12, width: Math.max(...guideText.map((t) => t.length)) * 6.3 + 26, height: guideText.length * 14 + 4, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.85, stroke: 'var(--line)' }));
      svg.append(s('path', { d: `M${P(gx + 2, gy - 4)}h14`, stroke: 'var(--accent)', 'stroke-width': 1.3, 'stroke-dasharray': '5 3' }));
      svg.append(s('text', { class: 'v', x: gx + 22, y: gy }, guideText[0]));
      if (guideText[1]) svg.append(s('text', { x: gx + 2, y: gy + 14 }, guideText[1]));
    }
    if (off.length) {
      const names = off.filter((m) => m.shown).map((m) => short(m.name));
      if (names.length) svg.append(s('text', { x: L, y: H - 8 }, `not on this chart (no ${[xk, yk].filter((k) => off.some((m) => !(m[k] > 0))).map((k) => PROPS[k].short).join(' / ')}): ${names.join(', ')}`));
    }
    // axis pickers sit on the axes
    xSel.value = xk; ySel.value = yk;
    xSel.style.left = `${Math.max(L, (W - xSel.offsetWidth) / 2)}px`; xSel.style.top = `${H - B + 20}px`;
    ySel.style.left = '8px'; ySel.style.top = '4px';
  }
  const sup = (n) => String(n).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)]).join('');
  const focusGuide = () => svg.querySelector('.hd')?.focus({ preventScroll: true });

  function showTip(m, px, py) {
    const W = chart.clientWidth;
    tip.replaceChildren(h('b', {}, m.name), h('div', {}, h('span', {}, m.cond)),
      ...['rho', 'E', 'sy', 'uts', 'cte', 'k'].map((k) => h('div', {}, h('span', {}, `${PROPS[k].short} ${PROPS[k].unit}`), h('span', {}, f3(m[k])))));
    tip.style.display = 'block';
    const left = px + 16 + 190 > W ? px - 16 - 190 : px + 16;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, py - 40)}px`;
  }

  // Keyboard on the chart: arrows move A to the nearest material in that direction.
  svg.addEventListener('keydown', (e) => {
    if (e.target !== svg || !cur) return;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const A = pts.find((m) => m.id === ctx.raw.focus);
    if (!dir || !A) return;
    e.preventDefault();
    const ax = cur.X(A[cur.xk]), ay = cur.Y(A[cur.yk]);
    let best = null, bd = Infinity;
    for (const m of pts) {
      if (m.id === A.id || !m.shown || !(m[cur.xk] > 0 && m[cur.yk] > 0)) continue;
      const dx = cur.X(m[cur.xk]) - ax, dy = cur.Y(m[cur.yk]) - ay;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const d = along + 2.5 * Math.abs(dx * dir[1] - dy * dir[0]);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) { refocusChart = true; ctx.set('focus', best.id); }
  });
  let refocusChart = false;

  // ---------------- rulers ----------------
  function drawRulers() {
    const W = rulers.clientWidth || 800;
    const A = pts.find((m) => m.id === ctx.raw.focus);
    const Bm = pts.find((m) => m.id === ctx.raw.compare);
    if (!A) return;
    const cmp = Bm ? (res.tables || []).find((t) => t.columns.length === 4 && t.columns[3] === 'Ratio A/B') : null;
    rhead.replaceChildren(...[h('b', { style: 'color:var(--accent)' }, `A ${A.name}`), h('span', {}, A.cond),
      Bm ? h('span', {}, ' against ') : h('span', {}, ' · shift-click a material for B'), Bm ? h('b', { style: 'color:var(--tool-mt-b)' }, `B ${Bm.name}`) : null, Bm ? h('span', {}, Bm.cond) : null].filter(Boolean));
    const rowH = 27, top = 6, labW = W < 560 ? 44 : 170, valW = W < 560 ? 156 : 210;
    const Hh = top + PKEYS.length * rowH + 20;
    rsvg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    rsvg.setAttribute('height', Hh);
    rsvg.replaceChildren();
    const x0 = labW, x1 = W - valW;
    PKEYS.forEach((k, i) => {
      const y = top + i * rowH + 16;
      const vals = pts.map((m) => m[k]).filter((v) => v > 0);
      const lo = Math.log10(Math.min(...vals)), hi = Math.log10(Math.max(...vals));
      const X = (v) => x0 + ((Math.log10(v) - lo) / (hi - lo || 1)) * (x1 - x0);
      rsvg.append(s('text', { class: 't', x: 10, y: y + 4, style: 'fill:var(--ink)' }, W < 560 ? PROPS[k].short : PROPS[k].name));
      rsvg.append(s('text', { x: labW - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 9.5 }, W < 560 ? '' : PROPS[k].unit));
      rsvg.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
      for (const m of pts) {
        if (!(m[k] > 0)) continue;
        const t = s('line', { x1: X(m[k]), x2: X(m[k]), y1: y - 5, y2: y + 5, stroke: COL(m.cat), 'stroke-width': 1.4, opacity: m.shown ? 0.55 : 0.18, class: 'dot' });
        t.append(s('title', {}, `${m.name}: ${f3(m[k])} ${PROPS[k].unit}`));
        t.addEventListener('click', (e) => pick(m.id, e.shiftKey));
        rsvg.append(t);
      }
      rsvg.append(s('text', { x: x0, y: y + 15, 'font-size': 9 }, f3(10 ** lo)), s('text', { x: x1, y: y + 15, 'text-anchor': 'end', 'font-size': 9 }, f3(10 ** hi)));
      const mark = (m, col, up) => {
        if (!(m[k] > 0)) return;
        const x = X(m[k]);
        rsvg.append(s('path', { d: up ? `M${P(x, y - 2)}l-5,-8h10Z` : `M${P(x, y + 2)}l-5,8h10Z`, fill: col }));
      };
      mark(A, 'var(--accent)', true);
      if (Bm) {
        mark(Bm, 'var(--tool-mt-b)', false);
        if (A[k] > 0 && Bm[k] > 0) rsvg.append(s('line', { x1: X(A[k]), x2: X(Bm[k]), y1: y, y2: y, stroke: 'var(--ink)', 'stroke-width': 2.5, opacity: 0.5 }));
      }
      // values as run() wrote them
      const row = cmp?.rows[i];
      const aTxt = row ? row[1] : f3(A[k]);
      const tx = x1 + (W < 560 ? 8 : 12);
      rsvg.append(s('text', { class: 'v', x: tx, y: y + 4, style: 'fill:var(--accent)' }, aTxt));
      if (row) {
        rsvg.append(s('text', { class: 'v', x: tx + (W < 560 ? 44 : 48), y: y + 4, style: 'fill:var(--tool-mt-b)' }, row[2]));
        rsvg.append(s('text', { class: 'v', x: W - 10, y: y + 4, 'text-anchor': 'end' }, row[3]));
      }
    });
    if (Bm && W >= 560) rsvg.append(s('text', { x: W - 10, y: Hh - 4, 'text-anchor': 'end', 'font-size': 9.5 }, 'A / B'));
  }

  // ---------------- rank ----------------
  function drawRank() {
    const sk = ctx.raw.sort || 'name';
    sortBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'name' : PKEYS[i - 1]) === sk)));
    const t = (res.tables || []).find((x) => x.columns[0] === 'Material');
    const byName = new Map(pts.map((m) => [m.name, m]));
    const rows = t ? t.rows.map((r) => byName.get(r[0])).filter(Boolean) : [];
    rankHead.replaceChildren(h('b', {}, `${rows.length} of ${pts.length}`), h('span', {}, sk === 'name' ? 'by name · density, g/cm³' : `by ${PROPS[sk].name}, ${PROPS[sk].unit}`));
    const key = sk === 'name' ? 'rho' : sk;
    const vals = rows.map((m) => m[key]).filter((v) => v > 0);
    const lo = Math.log10(Math.min(...vals, 1)), hi = Math.log10(Math.max(...vals, 1));
    const colIdx = t ? t.columns.findIndex((c) => c.startsWith(({ rho: 'Density', E: 'Young', sy: 'Yield', uts: 'Tensile', cte: 'CTE', k: 'Conductivity', spE: 'E/ρ', spS: 'Sy/ρ' })[key])) : -1;
    list.replaceChildren(...rows.map((m, i) => {
      const v = m[key];
      const w = v > 0 ? 6 + 94 * ((Math.log10(v) - lo) / (hi - lo || 1)) : 0;
      const txt = t.rows[i][colIdx] ?? '–';
      const isA = m.id === ctx.raw.focus, isB = m.id === ctx.raw.compare;
      return h('button', { class: `mt-item${isA ? ' a' : isB ? ' b' : ''}`, role: 'listitem', 'data-id': m.id, title: `${m.name} (${m.cond}). Click: A, shift-click: B`,
        onclick: (e) => pick(m.id, e.shiftKey) },
        h('span', { class: 'n' }, h('i', { style: `background:${COL(m.cat)}` }), m.name, isA ? h('em', {}, 'A') : isB ? h('em', {}, 'B') : null),
        h('span', { class: 'val' }, txt),
        h('span', { class: 'bar' }, h('span', { style: `width:${w}%;background:${COL(m.cat)}` })));
    }));
    list.querySelector('.mt-item.a')?.scrollIntoView({ block: 'nearest' });
  }

  function drawBar() {
    const raw = ctx.raw;
    catBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(CATS[i][0] === (raw.category || 'all'))));
    if (document.activeElement !== filterIn) filterIn.value = raw.filter || '';
    selA.value = raw.focus; selB.value = raw.compare || 'none';
  }

  let lastAxes = '';
  ctx.onResult((r) => {
    res = r || {}; pts = r.points || [];
    const axes = `${ctx.raw.xprop}|${ctx.raw.yprop}|${ctx.raw.focus}`;
    if (axes !== lastAxes) { guide = null; lastAxes = axes; }
    drawBar(); drawChart(); drawRulers(); drawRank();
    msgs.replaceChildren(...(r?.warnings || []).map((w) => h('div', {}, w)));
    if (refocusChart) { svg.focus({ preventScroll: true }); refocusChart = false; }
  });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { drawChart(); drawRulers(); }); }).observe(wrap);
}
