// Fastener Library: the page is the screw joint laid out on the drafting table.
//   Gauge   - a bolt gauge plate across the top: every size's clearance hole
//             drilled to one scale. Click a hole (or arrow along them) to pick
//             the size; sizes the head is not made in are blanked.
//   Joint   - the assembly in elevation, axis horizontal and to scale: head,
//             washer, the clamped part cut open, then the nut or the tapped
//             base with its thread and drill depth. Drag the part's far face
//             (or focus it and use the arrow keys) to change the grip; the
//             length ruler underneath shows where the needed length falls
//             among the standard lengths and which one to order.
//   Side    - the hole to model (counterbore or countersink, in section), the
//             parts seen end-on (drive, washer, nut and its printed trap), and
//             the outputs with the CAD variables.
// Every dimension drawn comes from run()'s result.draw.

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
const n = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v * 100) / 100));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };

const HEADS = [
  ['socket', 'Socket cap', 'ISO 4762 / DIN 912'], ['button', 'Button', 'ISO 7380-1'], ['countersunk', 'Countersunk', 'ISO 10642 / DIN 7991'],
  ['pan', 'Pan', 'ISO 7045 Phillips'], ['hex', 'Hex', 'ISO 4017 / DIN 933'],
];
const NUTS = [['none', 'Tapped', 'no nut: screw into a tapped hole'], ['hex', 'Hex nut', 'ISO 4032'], ['nyloc', 'Nyloc', 'DIN 985']];
const MATS = [['steel', 'Steel'], ['castiron', 'Cast iron'], ['aluminium', 'Aluminium'], ['plastic', 'Plastic']];

const CSS = `
:root {
  --tool-metal: #8a98a6; --tool-metal-fill: color-mix(in srgb, #8a98a6 30%, var(--surface));
  --tool-part: #5b6b7a; --tool-base: #7a6a55; --tool-dim: #1f4ed8; --tool-need: #b7791f;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-metal: #9fb0bf; --tool-metal-fill: color-mix(in srgb, #9fb0bf 22%, var(--surface));
  --tool-part: #8ea0b0; --tool-base: #b89f7d; --tool-dim: #7d9bff; --tool-need: #e8a735; } }
:root[data-theme="dark"] {
  --tool-metal: #9fb0bf; --tool-metal-fill: color-mix(in srgb, #9fb0bf 22%, var(--surface));
  --tool-part: #8ea0b0; --tool-base: #b89f7d; --tool-dim: #7d9bff; --tool-need: #e8a735; }

.k-page { padding: 10px 12px; }
.fl { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 360px;
  grid-template-rows: auto auto minmax(0, 1fr); grid-template-areas: "bar bar" "gauge side" "joint side";
  height: calc(100vh - 66px); min-height: 660px; }
.fl-bar { grid-area: bar; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.fl-gauge { grid-area: gauge; }
.fl-joint { grid-area: joint; display: flex; flex-direction: column; }
.fl-side { grid-area: side; display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
.fl-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; }
.fl-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.fl-head { display: flex; align-items: baseline; gap: 10px; padding: 6px 10px 0; }
.fl-head .fl-note { margin-left: auto; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.fl-grp { display: flex; align-items: center; gap: 8px; }

.fl-pick { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.fl-pick button { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; cursor: pointer;
  padding: 3px 9px 3px 6px; font-size: 12.5px; color: var(--ink-soft); }
.fl-pick button + button { border-left: 1px solid var(--line-soft); }
.fl-pick button:hover { background: var(--sunken); color: var(--ink); }
.fl-pick button[aria-checked="true"] { background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
.fl-pick svg { width: 26px; height: 20px; flex: none; }
.fl-pick svg * { fill: var(--tool-metal-fill); stroke: var(--ink-soft); stroke-width: 1; vector-effect: non-scaling-stroke; }
.fl-pick button[aria-checked="true"] svg * { stroke: var(--accent); }
.fl-pick.fl-text button { padding: 3px 9px; }
.fl-toggle { border: 1px solid var(--line); border-radius: 5px; background: var(--surface); padding: 3px 10px; cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
.fl-toggle[aria-pressed="true"] { color: var(--ink); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.fl-num { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.fl-num input { width: 56px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.fl-grip { margin-left: auto; }

.fl-gauge svg { display: block; width: 100%; height: 92px; }
.fl-hole { cursor: pointer; outline: none; }
.fl-hole .bore { fill: var(--paper); stroke: var(--ink-soft); stroke-width: 1; }
.fl-hole .ring { fill: none; stroke: transparent; stroke-width: 2; }
.fl-hole:hover .bore { stroke: var(--ink); }
.fl-hole[aria-checked="true"] .bore { fill: color-mix(in srgb, var(--accent) 22%, var(--paper)); stroke: var(--accent); stroke-width: 1.5; }
.fl-hole[aria-checked="true"] .ring { stroke: var(--accent); }
.fl-hole:focus-visible .ring { stroke: var(--accent); stroke-dasharray: 3 2; }
.fl-hole.off { cursor: not-allowed; }
.fl-hole.off .bore { fill: var(--surface); stroke: var(--line); stroke-dasharray: 2 2; }
.fl-hole.off text { fill: var(--line); }
.fl-plate { fill: var(--sunken); stroke: var(--line); }
.fl-gl { font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.fl-gs { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.fl-hole[aria-checked="true"] .fl-gl { fill: var(--accent); }

.fl-box { position: relative; flex: 1; min-height: 0; }
.fl-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.fl-warns:empty { display: none; }
.fl-warns { border-top: 1px solid var(--warn); padding: 5px 10px; font-size: 12px; background: color-mix(in srgb, var(--warn) 10%, var(--surface)); border-radius: 0 0 6px 6px; }
.fl-warns div::before { content: "! "; color: var(--warn); font-weight: 600; }

/* drawing */
.fl-draw text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.f-metal { fill: var(--tool-metal-fill); stroke: var(--ink); stroke-width: 1.3; stroke-linejoin: round; }
.f-thin { fill: none; stroke: var(--ink); stroke-width: 0.8; }
.f-hidden { fill: none; stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 4 3; }
.f-axis { stroke: var(--ink-soft); stroke-width: 0.8; stroke-dasharray: 14 3 2 3; }
.f-part { stroke: var(--tool-part); stroke-width: 1.2; }
.f-base { stroke: var(--tool-base); stroke-width: 1.2; }
.f-hp-bg { fill: color-mix(in srgb, var(--tool-part) 10%, var(--surface)); }
.f-hp-ln { stroke: var(--tool-part); stroke-width: 0.8; }
.f-hb-bg { fill: color-mix(in srgb, var(--tool-base) 12%, var(--surface)); }
.f-hb-ln { stroke: var(--tool-base); stroke-width: 0.8; }
.f-washer { fill: color-mix(in srgb, var(--tool-metal) 45%, var(--surface)); stroke: var(--ink); stroke-width: 1; }
.f-dim { stroke: var(--tool-dim); stroke-width: 0.9; fill: none; }
.f-ext { stroke: var(--tool-dim); stroke-width: 0.6; opacity: 0.6; fill: none; }
.f-lead { stroke: var(--tool-dim); stroke-width: 0.8; fill: none; }
.f-dimhead { fill: var(--tool-dim); }
.f-dt { font-size: 11.5px; fill: var(--tool-dim); }
.f-dt.bg { stroke: var(--surface); stroke-width: 4; paint-order: stroke; }
.f-lab { font-size: 11px; fill: var(--ink-soft); }
.f-bad { stroke: var(--danger) !important; }
.f-badfill { fill: color-mix(in srgb, var(--danger) 22%, transparent); stroke: var(--danger); stroke-dasharray: 3 2; }
.f-badt { fill: var(--danger); font-size: 11.5px; }
.f-handle { cursor: ew-resize; outline: none; }
.f-handle rect.hit { fill: transparent; }
.f-handle rect.bar { fill: var(--accent); opacity: 0.85; }
.f-handle:hover rect.bar, .f-handle.drag rect.bar { opacity: 1; }
.f-handle rect.ring { fill: none; stroke: none; }
.f-handle:focus-visible rect.ring { stroke: var(--accent); stroke-width: 2; fill: none; }
.f-handle .grip-dot { fill: var(--accent-ink); }
.f-ruler { stroke: var(--line); stroke-width: 1; }
.f-tick { stroke: var(--ink-soft); stroke-width: 1; }
.f-tickt { font-size: 10.5px; fill: var(--ink-soft); }
.f-need { stroke: var(--tool-need); stroke-width: 1.5; stroke-dasharray: 4 2; }
.f-needt { font-size: 11.5px; fill: var(--tool-need); }
.bg-s { stroke: var(--surface); stroke-width: 4; paint-order: stroke; }
.f-pick { stroke: var(--accent); stroke-width: 2.5; }
.f-pickt { font-size: 12.5px; font-weight: 600; fill: var(--accent); }
.f-span { fill: color-mix(in srgb, var(--accent) 14%, transparent); }

.fl-seat svg, .fl-ends svg { display: block; width: 100%; }
.fl-ends { flex: none; }
.fl-side .k-outwrap { flex: 1; min-height: 150px; display: flex; flex-direction: column; }
.fl-side .k-out { flex: 1; max-height: none; }

@media (max-width: 1100px) {
  .fl { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "bar" "gauge" "joint" "side"; height: auto; min-height: 0; }
  .fl-joint .fl-box { height: 400px; flex: none; }
  .fl-side { display: grid; grid-template-columns: 1fr 1fr; }
  .fl-side .k-outwrap { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  .k-page { padding: 8px; }
  .fl-side { display: flex; }
  .fl-joint .fl-box { height: 300px; }
  .fl-head .fl-note { display: none; }
  .fl-grip { margin-left: 0; }
  .fl-pick button span { display: none; }
  .fl-pick.fl-text button span { display: inline; }
  .fl-gauge svg { height: 84px; }
}
`;

// Head silhouettes for the picker (side view, axis horizontal).
const ICONS = {
  socket: 'M3,3 H10 V17 H3 Z M10,8 H24 V12 H10 Z',
  button: 'M10,2 Q1,2 1,10 Q1,18 10,18 Z M10,8 H24 V12 H10 Z',
  countersunk: 'M3,2 L10,8 L10,12 L3,18 Z M10,8 H24 V12 H10 Z',
  pan: 'M10,3 H5 Q2,3 2,6 V14 Q2,17 5,17 H10 Z M10,8 H24 V12 H10 Z',
  hex: 'M4,2 H10 V18 H4 Z M10,8 H24 V12 H10 Z',
};

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  let D = null, res = null;
  let frozen = null;   // scale held still while the grip is dragged
  let focusHandle = false;

  // ---------- bar ----------
  const radio = (label, items, key, cls, icon) => {
    const g = h('div', { class: `fl-pick ${cls || ''}`, role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, title]) => {
      const b = h('button', { type: 'button', role: 'radio', 'data-v': v, title: title || null, onclick: () => ctx.set(key, v) });
      if (icon) { const s = sv(null, 'svg', { viewBox: '0 0 26 20', 'aria-hidden': 'true' }); sv(s, 'path', { d: ICONS[v] }); b.append(s); }
      b.append(h('span', {}, t));
      b.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const i = clamp(items.findIndex((x) => x[0] === v) + d, 0, items.length - 1);
        ctx.set(key, items[i][0]);
        requestAnimationFrame(() => g.querySelector(`[data-v="${items[i][0]}"]`)?.focus());
      });
      return b;
    });
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const headPick = radio('Head type', HEADS, 'head', '', true);
  const nutPick = radio('Nut or tapped hole', NUTS, 'nut', 'fl-text');
  const matPick = radio('Tapped into', MATS, 'material', 'fl-text');
  const matGrp = h('div', { class: 'fl-grp' }, h('span', { class: 'fl-cap' }, 'into'), matPick);
  const washerBtn = h('button', { type: 'button', class: 'fl-toggle', 'aria-pressed': 'false', title: 'ISO 7089 plain washer under head and nut',
    onclick: () => ctx.set('washer', !ctx.raw.washer) }, 'Washers');
  const gripIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Clamped thickness (grip) in mm',
    oninput: (e) => ctx.set('grip', e.target.value) });
  const bar = h('div', { class: 'fl-bar' },
    h('div', { class: 'fl-grp' }, h('span', { class: 'fl-cap' }, 'Head'), headPick),
    h('div', { class: 'fl-grp' }, h('span', { class: 'fl-cap' }, 'Held by'), nutPick), matGrp,
    washerBtn,
    h('label', { class: 'fl-num fl-grip' }, h('span', {}, 'Grip'), gripIn, h('small', {}, 'mm')));

  // ---------- gauge plate ----------
  const gaugeSvg = sv(null, 'svg', { class: 'fl-draw', role: 'radiogroup', 'aria-label': 'Screw size: bolt gauge with the clearance holes to scale' });
  const gauge = h('section', { class: 'fl-card fl-gauge' }, gaugeSvg);

  // ---------- joint ----------
  const jointSvg = sv(null, 'svg', { class: 'fl-draw', role: 'group', 'aria-label': 'The screw joint in elevation, to scale' });
  const jointHead = h('div', { class: 'fl-head' });
  const warns = h('div', { class: 'fl-warns', 'aria-live': 'polite' });
  const joint = h('section', { class: 'fl-card fl-joint' }, jointHead, h('div', { class: 'fl-box' }, jointSvg), warns);

  // ---------- side ----------
  const seatSvg = sv(null, 'svg', { class: 'fl-draw', role: 'img' });
  const seatHead = h('div', { class: 'fl-head' });
  const endsSvg = sv(null, 'svg', { class: 'fl-draw', role: 'img', 'aria-label': 'Head, washer and nut seen end-on' });
  const side = h('aside', { class: 'fl-side' },
    h('section', { class: 'fl-card fl-seat' }, seatHead, seatSvg),
    h('section', { class: 'fl-card fl-ends' }, h('div', { class: 'fl-head' }, h('span', { class: 'fl-cap' }, 'End views, to one scale')), endsSvg),
    ctx.outputs);

  const layout = h('div', { class: 'fl' }, bar, gauge, joint, side);
  root.append(layout);

  // ---------- gauge drawing ----------
  function drawGauge() {
    const svg = gaugeSvg; svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), H = svg.clientHeight || 92;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const sizes = D.sizes;
    const maxC = Math.max(...sizes.map((s) => s.clear));
    const narrow = W < 560;
    const slot = (W - 20) / sizes.length;
    const sc = Math.min((H - 36) / maxC, (slot - 6) / maxC);
    sv(svg, 'rect', { x: 4, y: 4, width: W - 8, height: H - 8, rx: 6, class: 'fl-plate' });
    const cy = 10 + (H - 36) / 2;
    sizes.forEach((s, i) => {
      const cx = 10 + slot * (i + 0.5);
      const on = s.size === D.size;
      const g = sv(svg, 'g', { class: `fl-hole${s.made ? '' : ' off'}`, role: 'radio', tabindex: on ? 0 : -1, 'aria-checked': String(on),
        'aria-disabled': s.made ? null : 'true', 'data-v': s.size,
        'aria-label': `${s.size}, clearance hole ${s.clear} mm${s.made ? '' : ', not made in this head'}` });
      sv(g, 'rect', { x: cx - slot / 2, y: 4, width: slot, height: H - 8, fill: 'transparent' });
      sv(g, 'circle', { cx, cy, r: (s.clear / 2) * sc + 5, class: 'ring' });
      sv(g, 'circle', { cx, cy, r: Math.max(1.5, (s.clear / 2) * sc), class: 'bore' });
      sv(g, 'text', { x: cx, y: H - 17, 'text-anchor': 'middle', class: 'fl-gl' }, s.size);
      if (!narrow) sv(g, 'text', { x: cx, y: H - 7, 'text-anchor': 'middle', class: 'fl-gs' }, `Ø${s.clear}`);
      if (!s.made) sv(g, 'title', {}, `${D.headName} is not made in ${s.size}`);
      g.addEventListener('click', () => { if (s.made) ctx.set('size', s.size); });
      g.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        let j = i + d;
        while (sizes[j] && !sizes[j].made) j += d;
        if (!sizes[j]) return;
        ctx.set('size', sizes[j].size);
        requestAnimationFrame(() => gaugeSvg.querySelector(`[data-v="${sizes[j].size}"]`)?.focus());
      });
    });
  }

  // ---------- joint drawing ----------
  const arrows = (defs) => {
    const m = sv(defs, 'marker', { id: 'fl-ar', viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(m, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'f-dimhead' });
  };
  const hatch = (defs, id, ang, gap, cls) => {
    const pt = sv(defs, 'pattern', { id, patternUnits: 'userSpaceOnUse', width: gap, height: gap, patternTransform: `rotate(${ang})` });
    sv(pt, 'rect', { width: gap, height: gap, class: `${cls}-bg` });
    sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: gap, class: `${cls}-ln` });
  };
  // px-space dimension lines
  const dimH = (svg, x1, x2, y, label, ext = []) => {
    for (const [x, y0] of ext) sv(svg, 'line', { x1: x, x2: x, y1: y0, y2: y + (y0 < y ? 4 : -4), class: 'f-ext' });
    const out = Math.abs(x2 - x1) < 22;
    sv(svg, 'line', { x1, x2, y1: y, y2: y, class: 'f-dim', 'marker-start': out ? null : 'url(#fl-ar)', 'marker-end': out ? null : 'url(#fl-ar)' });
    if (out) { sv(svg, 'path', { d: `M${Math.min(x1, x2) - 14},${y}h14M${Math.max(x1, x2) + 14},${y}h-14`, class: 'f-dim', 'marker-end': 'url(#fl-ar)' }); }
    sv(svg, 'text', { x: (x1 + x2) / 2, y: y - 4, 'text-anchor': 'middle', class: 'f-dt bg' }, label);
  };
  const dimV = (svg, x, y1, y2, label, ext = [], side = -1) => {
    for (const [x0, y] of ext) sv(svg, 'line', { x1: x0, x2: x + (x0 < x ? 4 : -4), y1: y, y2: y, class: 'f-ext' });
    sv(svg, 'line', { x1: x, x2: x, y1, y2, class: 'f-dim', 'marker-start': 'url(#fl-ar)', 'marker-end': 'url(#fl-ar)' });
    const tx = x + side * 5, ty = (y1 + y2) / 2;
    sv(svg, 'text', { x: tx, y: ty, 'text-anchor': 'middle', transform: `rotate(-90 ${tx} ${ty})`, class: 'f-dt bg' }, label);
  };

  function drawJoint() {
    const svg = jointSvg; svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), Hpx = Math.max(260, svg.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hpx}`);
    const defs = sv(svg, 'defs'); arrows(defs);
    hatch(defs, 'fl-hp', 45, 7, 'f-hp'); hatch(defs, 'fl-hb', -45, 7, 'f-hb');
    const { d, p, dk, k, clear, nut, washer: wa, thread: th } = D;
    const csk = D.head === 'countersunk';
    const grip = D.grip ?? Math.max(2, 2 * d);
    const wH = wa && wa.underHead ? wa.h : 0;
    const wN = wa && wa.underNut ? wa.h : 0;
    const L = D.pick ?? D.need ?? grip + 2 * d;
    // axis coordinates in mm: x = 0 plate top face; head to the left
    const x0 = csk ? 0 : -wH;                 // where the length is measured from
    const headL = csk ? 0 : x0 - k, headR = csk ? k : x0;
    const end = x0 + L;
    const baseEnd = nut ? null : grip + Math.max((th ? th.drillDepth + 0.6 * d : 1.5 * d + 2), 1.2 * d) + Math.max(2, 0.8 * d);
    const nutX0 = nut ? grip + wN : null, nutX1 = nut ? grip + wN + nut.h : null;
    const xMin = csk ? -1.2 : headL, xMax = Math.max(end, nutX1 ?? 0, baseEnd ?? 0);
    const Rmax = Math.max(dk, wa ? wa.d2 : 0, nut ? nut.s : 0, D.seat.d) / 2;
    const plateR = Rmax + Math.max(2, 0.9 * d);
    const narrow = W < 560;
    const mL = narrow ? 38 : 70, mR = narrow ? 20 : 60, mT = 50, mB = (nut ? 62 : 100) + (narrow ? 4 : 0);
    let sc, ox, oy;
    if (frozen) ({ sc, ox, oy } = frozen);
    else {
      const span = xMax - xMin;
      sc = Math.min((W - mL - mR) / (span * 1.12), (Hpx - mT - mB) / (2 * plateR));
      ox = mL + ((W - mL - mR) - span * sc) / 2 - xMin * sc;
      oy = mT + (Hpx - mT - mB) / 2;
    }
    lastScale = { sc, ox, oy };
    const X = (x) => ox + x * sc, Y = (y) => oy - y * sc;
    const rect = (x1, x2, y1, y2, attrs) => sv(svg, 'rect', { x: Math.min(X(x1), X(x2)), y: Math.min(Y(y1), Y(y2)), width: Math.abs(X(x2) - X(x1)), height: Math.abs(Y(y2) - Y(y1)), ...attrs });
    const path = (pts, attrs, close = true) => sv(svg, 'path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + (close ? 'Z' : ''), ...attrs });

    // ---- clamped part, cut open ----
    const rc = clear / 2;
    const bad = D.flushProblem;
    if (csk) {
      const rs = D.seat.d / 2, cd = Math.min(grip, (rs - rc)); // 90 deg: depth = radius difference
      for (const s of [1, -1]) path([[0, s * rs], [0, s * plateR], [grip, s * plateR], [grip, s * rc], [cd, s * rc]], { fill: 'url(#fl-hp)', class: `f-part${bad ? ' f-bad' : ''}` });
    } else {
      for (const s of [1, -1]) rect(0, grip, s * rc, s * plateR, { fill: 'url(#fl-hp)', class: 'f-part' });
    }
    sv(svg, 'text', { x: X(grip / 2), y: Y(plateR) - 6, 'text-anchor': 'middle', class: 'f-lab' }, 'clamped part');
    // ---- tapped base ----
    if (!nut) {
      const r1 = th ? th.tapDrill / 2 : (d - p) / 2;
      const dd = th ? th.drillDepth : 1.5 * d, td = th ? th.tapDepth : 1.5 * d;
      const tip = r1 * Math.tan((31 * Math.PI) / 180); // 118 deg drill point
      for (const s of [1, -1]) path([[grip, s * r1], [grip, s * plateR], [baseEnd, s * plateR], [baseEnd, 0], [grip + dd + tip, 0], [grip + dd, s * r1]], { fill: 'url(#fl-hb)', class: 'f-base' });
      for (const s of [1, -1]) sv(svg, 'line', { x1: X(grip), x2: X(grip + td), y1: Y(s * d / 2), y2: Y(s * d / 2), class: `f-thin${th && th.deep ? ' f-bad' : ''}` });
      sv(svg, 'text', { x: X((grip + baseEnd) / 2), y: Y(plateR) - 6, 'text-anchor': 'middle', class: 'f-lab' }, `${D.material}, tapped`);
    }
    // ---- washers ----
    if (wH) for (const s of [1, -1]) rect(-wH, 0, s * wa.d1 / 2, s * wa.d2 / 2, { class: 'f-washer' });
    if (wN) for (const s of [1, -1]) rect(grip, grip + wN, s * wa.d1 / 2, s * wa.d2 / 2, { class: 'f-washer' });
    // ---- nut (elevation, across flats) ----
    if (nut) {
      const c = 0.12 * nut.h, r = nut.s / 2;
      path([[nutX0, r - c], [nutX0 + c, r], [nutX1 - c, r], [nutX1, r - c], [nutX1, -r + c], [nutX1 - c, -r], [nutX0 + c, -r], [nutX0, -r + c]], { class: 'f-metal' });
      sv(svg, 'line', { x1: X(nutX0), x2: X(nutX1), y1: Y(0), y2: Y(0), class: 'f-thin' });
      if (nut.kind === 'nyloc') {
        const xr = nutX0 + nut.plainH;
        sv(svg, 'line', { x1: X(xr), x2: X(xr), y1: Y(r * 0.85), y2: Y(-r * 0.85), class: 'f-thin' });
        path([[xr, r * 0.85], [nutX1 - c, r * 0.85], [nutX1 - c, -r * 0.85], [xr, -r * 0.85]], { class: 'f-hidden' });
      }
    }
    // ---- screw (elevation; threads by convention) ----
    const r = d / 2, rm = (d - 1.2268 * p) / 2, ch = Math.min(p, 0.1 * d + 0.2);
    const b = 2 * d + 12;                        // thread length, ISO 888 for L <= 125
    const thStart = Math.max(headR + 0.5 * d, end - b);
    path([[headR - 0.01, r], [end - ch, r], [end, r - ch], [end, -r + ch], [end - ch, -r], [headR - 0.01, -r]], { class: 'f-metal' });
    for (const s of [1, -1]) sv(svg, 'line', { x1: X(thStart), x2: X(end - ch / 2), y1: Y(s * rm), y2: Y(s * rm), class: 'f-thin' });
    sv(svg, 'line', { x1: X(thStart), x2: X(thStart), y1: Y(r), y2: Y(-r), class: 'f-thin' });
    // head
    const dr = D.drive || '';
    const key = parseFloat(dr.replace(/[^\d.]/g, '')) || 0;
    if (D.head === 'socket') {
      const c = 0.08 * k;
      path([[headL, dk / 2 - c], [headL + c, dk / 2], [headR, dk / 2], [headR, -dk / 2], [headL + c, -dk / 2], [headL, -dk / 2 + c]], { class: 'f-metal' });
      const kr = key * 0.577, dep = 0.55 * k;
      path([[headL, kr], [headL + dep, kr], [headL + dep + kr * 0.6, 0], [headL + dep, -kr], [headL, -kr]], { class: 'f-hidden' }, false);
    } else if (D.head === 'button') {
      sv(svg, 'path', { d: `M${X(headR)},${Y(dk / 2)} L${X(headR - 0.25 * k)},${Y(dk / 2)} A${0.75 * k * sc},${(dk / 2) * sc} 0 0 0 ${X(headR - 0.25 * k)},${Y(-dk / 2)} L${X(headR)},${Y(-dk / 2)} Z`, class: 'f-metal' });
      const kr = key * 0.577, dep = 0.5 * k;
      path([[headL + 0.05 * k, kr], [headL + dep, kr], [headL + dep + kr * 0.6, 0], [headL + dep, -kr], [headL + 0.05 * k, -kr]], { class: 'f-hidden' }, false);
    } else if (csk) {
      path([[0, dk / 2], [k, r], [k, -r], [0, -dk / 2]], { class: 'f-metal' });
      const kr = key * 0.577, dep = 0.6 * k;
      path([[0, kr], [dep, kr], [dep + kr * 0.6, 0], [dep, -kr], [0, -kr]], { class: 'f-hidden' }, false);
    } else if (D.head === 'pan') {
      const rr = 0.4 * k;
      sv(svg, 'path', { d: `M${X(headR)},${Y(dk / 2)} L${X(headL + rr)},${Y(dk / 2)} Q${X(headL)},${Y(dk / 2)} ${X(headL)},${Y(dk / 2 - rr)} L${X(headL)},${Y(-dk / 2 + rr)} Q${X(headL)},${Y(-dk / 2)} ${X(headL + rr)},${Y(-dk / 2)} L${X(headR)},${Y(-dk / 2)} Z`, class: 'f-metal' });
      path([[headL, dk * 0.18], [headL + 0.55 * k, 0], [headL, -dk * 0.18]], { class: 'f-hidden' }, false);
    } else {
      const c = 0.12 * k;
      path([[headL, dk / 2 - c], [headL + c, dk / 2], [headR, dk / 2], [headR, -dk / 2], [headL + c, -dk / 2], [headL, -dk / 2 + c]], { class: 'f-metal' });
      sv(svg, 'line', { x1: X(headL), x2: X(headR), y1: Y(0), y2: Y(0), class: 'f-thin' });
    }
    // axis
    sv(svg, 'line', { x1: X(xMin) - 16, x2: X(xMax) + 16, y1: Y(0), y2: Y(0), class: 'f-axis' });

    // ---- dimensions ----
    const dimsAnchor = sv(svg, 'g');
    const yTop = Y(plateR) - 20;
    const hx = X(headL) - (narrow ? 12 : 22);
    dimV(svg, hx, Y(dk / 2), Y(-dk / 2), `${D.head === 'hex' ? 'AF' : 'Ø'}${n(dk)}`, [[X(csk ? 0 : headL + 0.3 * k), Y(dk / 2)], [X(csk ? 0 : headL + 0.3 * k), Y(-dk / 2)]]);
    if (!csk) dimH(svg, X(headL), X(headR), Y(Math.max(dk / 2, wa ? wa.d2 / 2 : 0)) - 14, `k ${n(k)}`, [[X(headL), Y(dk / 2) - 2], [X(headR), Y(dk / 2) - 2]]);
    dimH(svg, X(0), X(grip), yTop, `grip ${n(grip)}`, [[X(0), Y(plateR)], [X(grip), Y(plateR)]]);
    // clearance hole leader
    {
      const px = X(grip * 0.62), py = Y(-rc);
      const lx = px + 18, ly = (Y(-rc) + Y(-plateR)) / 2 + 8;
      sv(svg, 'path', { d: `M${px},${py} L${lx},${ly} h8`, class: 'f-lead' });
      sv(svg, 'text', { x: lx + 10, y: ly + 4, class: 'f-dt bg' }, `Ø${n(clear)} hole`);
    }
    if (nut) {
      dimH(svg, X(nutX0), X(nutX1), Y(nut.s / 2) - 12, `m ${n(nut.h)}`, [[X(nutX0), Y(nut.s / 2) - 2], [X(nutX1), Y(nut.s / 2) - 2]]);
      dimV(svg, X(nutX1) + 16, Y(nut.s / 2), Y(-nut.s / 2), `AF ${n(nut.s)}`, [[X(nutX1) + 2, Y(nut.s / 2)], [X(nutX1) + 2, Y(-nut.s / 2)]], 1 * -1);
      if (D.protrusion != null) {
        const yy = Y(-r) + 16;
        const lab = `${D.protrusion >= 0 ? '+' : ''}${n(D.protrusion)} past nut`;
        if (D.protrusion > 0.05) dimH(svg, X(nutX1), X(end), yy, '', [[X(end), Y(-r) + 2]]);
        sv(svg, 'text', { x: X(end) + 6, y: yy + 14, class: D.protrusion < 2 * p - 0.01 ? 'f-badt' : 'f-dt bg' }, lab);
      }
    } else if (th) {
      const yb = Y(-plateR) + 16, yb2 = yb + 16;
      sv(svg, 'line', { x1: X(grip), x2: X(grip), y1: Y(-plateR), y2: yb2 + 4, class: 'f-ext' });
      dimH(svg, X(grip), X(grip + th.tapDepth), yb, `thread ${n(th.tapDepth)}`, [[X(grip + th.tapDepth), Y(-d / 2)]]);
      dimH(svg, X(grip), X(grip + th.drillDepth), yb2, `drill Ø${n(th.tapDrill)} × ${n(th.drillDepth)}`, [[X(grip + th.drillDepth), Y(-th.tapDrill / 2)]]);
      if (th.deep) sv(svg, 'text', { x: X(grip + th.tapDepth / 2), y: Y(plateR) - 20, 'text-anchor': 'middle', class: 'f-badt' }, `deep: ${n(th.into)} in`);
    }
    if (bad) sv(svg, 'text', { x: X(grip / 2), y: Y(plateR) - 22, 'text-anchor': 'middle', class: 'f-badt' }, 'thinner than the head');

    // ---- grip handle on the part's far face ----
    const hg = sv(svg, 'g', { class: `f-handle${dragging ? ' drag' : ''}`, tabindex: 0, role: 'slider', 'aria-label': 'Grip: clamped thickness',
      'aria-valuemin': 0.5, 'aria-valuemax': 150, 'aria-valuenow': grip, 'aria-valuetext': `${n(grip)} mm`, 'data-h': 'grip' });
    const hx0 = X(grip), hy0 = Y(plateR), hy1 = Y(-plateR);
    sv(hg, 'rect', { x: hx0 - 9, y: hy0 - 4, width: 18, height: hy1 - hy0 + 8, class: 'hit' });
    sv(hg, 'rect', { x: hx0 - 3, y: hy0 + (hy1 - hy0) * 0.3, width: 6, height: (hy1 - hy0) * 0.4, rx: 3, class: 'bar' });
    for (let i = -1; i <= 1; i++) sv(hg, 'circle', { cx: hx0, cy: Y(0) + i * 7 + (hy1 - hy0) * (i === 0 ? 0 : 0), r: 1.3, class: 'grip-dot' });
    sv(hg, 'rect', { x: hx0 - 7, y: hy0 + (hy1 - hy0) * 0.3 - 4, width: 14, height: (hy1 - hy0) * 0.4 + 8, rx: 5, class: 'ring' });
    hg.addEventListener('pointerdown', (e) => {
      dragging = true; frozen = lastScale; capture(jointSvg, e); e.preventDefault(); hg.classList.add('drag');
    });
    hg.addEventListener('keydown', (e) => {
      const st = { ArrowRight: 0.5, ArrowUp: 0.5, ArrowLeft: -0.5, ArrowDown: -0.5 }[e.key];
      if (!st) return; e.preventDefault();
      setGrip(grip + st * (e.shiftKey ? 10 : 1)); focusHandle = true;
    });
    if (focusHandle) { hg.focus(); focusHandle = false; }

    // ---- length ruler: standard lengths measured from x0 ----
    const ry = Hpx - 34;
    const rx0 = X(x0);
    sv(svg, 'line', { x1: rx0, x2: W - 8, y1: ry, y2: ry, class: 'f-ruler' });
    sv(svg, 'line', { x1: rx0, x2: rx0, y1: Y(-Math.max(dk, clear) / 2), y2: ry + 6, class: 'f-ext' });
    if (D.need != null) sv(svg, 'rect', { x: rx0, y: ry - 5, width: Math.max(0, D.need * sc), height: 10, class: 'f-span' });
    const maxL = (W - 8 - rx0) / sc;
    let lastLab = -1e9;
    for (const Ls of D.lengths) {
      if (Ls > maxL) break;
      const x = rx0 + Ls * sc, isPick = Ls === D.pick;
      sv(svg, 'line', { x1: x, x2: x, y1: ry - (isPick ? 12 : 4), y2: ry + (isPick ? 12 : 4), class: isPick ? 'f-pick' : 'f-tick' });
      if (!isPick && x - lastLab > 22 && Math.abs(x - (D.pick != null ? rx0 + D.pick * sc : -1e9)) > 26) { sv(svg, 'text', { x, y: ry + 16, 'text-anchor': 'middle', class: 'f-tickt' }, Ls); lastLab = x; }
    }
    if (D.need != null) {
      const x = rx0 + D.need * sc;
      svg.insertBefore(sv(null, 'line', { x1: x, x2: x, y1: Y(-r), y2: ry + 4, class: 'f-need' }), dimsAnchor);
      sv(svg, 'text', { x: x - 4, y: ry - 8, 'text-anchor': 'end', class: 'f-needt bg-s' }, `needs ${n(D.need)}`);
    }
    if (D.pick != null) {
      const x = rx0 + D.pick * sc;
      sv(svg, 'text', { x, y: ry + 28, 'text-anchor': 'middle', class: 'f-pickt' }, `order ${D.size} × ${D.pick}`);
    }
    sv(svg, 'text', { x: rx0 - 6, y: ry + 4, 'text-anchor': 'end', class: 'f-tickt' }, narrow ? 'L' : 'L, mm');
    scaleNote = `to scale · ${n(sc)} px/mm · L ${D.lengthFrom}`;
  }
  let dragging = false, lastScale = null, scaleNote = '';
  function setGrip(v) {
    const g = Math.round(clamp(v, 0.5, 150) * 2) / 2;
    if (D && D.grip != null && Math.abs(g - D.grip) < 1e-9) return;
    ctx.set('grip', String(g));
  }
  jointSvg.addEventListener('pointermove', (e) => {
    if (!dragging || !lastScale) return;
    const r = jointSvg.getBoundingClientRect();
    const vb = jointSvg.viewBox.baseVal;
    const x = ((e.clientX - r.left) / r.width) * vb.width;
    setGrip((x - lastScale.ox) / lastScale.sc);
  });
  const endDrag = () => { if (!dragging) return; dragging = false; frozen = null; if (D) drawJoint(); };
  jointSvg.addEventListener('pointerup', endDrag);
  jointSvg.addEventListener('pointercancel', endDrag);

  // ---------- seat: the hole to model ----------
  function drawSeat() {
    const svg = seatSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 340), H = 170;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.height = `${H}px`;
    const defs = sv(svg, 'defs'); arrows(defs); hatch(defs, 'fl-hp2', 45, 6, 'f-hp');
    const { seat, clear } = D;
    const rs = seat.d / 2, rc = clear / 2;
    const csk = seat.kind === 'countersink';
    const depth = csk ? rs - rc : seat.depth;
    const T = Math.max(depth + clear * 0.9, depth * 1.8);
    const half = rs + Math.max(2, 0.5 * seat.d);
    const sc = Math.min((W - 110) / (2 * half), (H - 52) / T);
    const cx = W / 2 - 10, y0 = 32;
    const X = (x) => cx + x * sc, Y = (y) => y0 + y * sc;
    for (const s of [1, -1]) {
      const pts = csk ? [[s * half, 0], [s * rs, 0], [s * rc, depth], [s * rc, T], [s * half, T]]
        : [[s * half, 0], [s * rs, 0], [s * rs, depth], [s * rc, depth], [s * rc, T], [s * half, T]];
      sv(svg, 'path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z', fill: 'url(#fl-hp2)', class: 'f-part' });
    }
    sv(svg, 'line', { x1: cx, x2: cx, y1: y0 - 8, y2: Y(T) + 6, class: 'f-axis' });
    dimH(svg, X(-rs), X(rs), y0 - 10, csk ? `Ø${n(seat.d)} × 90°` : `Ø${n(seat.d)}`, []);
    dimH(svg, X(-rc), X(rc), Y(T) + 14, `Ø${n(clear)}`, [[X(-rc), Y(T)], [X(rc), Y(T)]]);
    if (csk) sv(svg, 'text', { x: X(rs) + 8, y: Y(depth / 2) + 4, class: 'f-dt' }, `${n(D.seat.depth)} deep (head)`);
    else dimV(svg, X(half) + 16, Y(0), Y(depth), `${n(depth)}`, [[X(half), Y(0)], [X(rs) + 2, Y(depth)]], 1 * -1);
    seatHead.replaceChildren(h('span', { class: 'fl-cap' }, csk ? 'Countersink to model' : 'Counterbore to model, if the head is sunk'),
      h('span', { class: 'fl-note' }, csk ? 'head flush' : D.head === 'socket' ? 'DIN 974-1' : 'head + 1'));
    svg.setAttribute('aria-label', csk ? `Countersink diameter ${n(seat.d)} mm at 90 degrees, clearance hole ${n(clear)} mm`
      : `Counterbore diameter ${n(seat.d)} by ${n(depth)} mm deep, clearance hole ${n(clear)} mm`);
  }

  // ---------- end views ----------
  function drawEnds() {
    const svg = endsSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 340), H = 150;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.height = `${H}px`;
    const { dk, nut, washer: wa, d } = D;
    const items = [{ kind: 'head', R: dk / 2 }];
    if (wa) items.push({ kind: 'washer', R: wa.d2 / 2 });
    if (nut) items.push({ kind: 'nut', R: (nut.trapCorners || nut.e) / 2 });
    const gap = 16, avail = W - 20 - gap * (items.length - 1);
    const sc = Math.min(avail / items.reduce((a, it) => a + 2 * it.R, 0), (H - 50) / (2 * Math.max(...items.map((i) => i.R))));
    let x = 10 + (avail - items.reduce((a, it) => a + 2 * it.R, 0) * sc) / 2;
    const cy = 12 + (H - 50) / 2;
    const hex = (cx, R, cls) => sv(svg, 'path', { d: Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${i ? 'L' : 'M'}${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`; }).join('') + 'Z', class: cls });
    for (const it of items) {
      const cx = x + it.R * sc;
      if (it.kind === 'head') {
        const key = parseFloat(String(D.drive).replace(/[^\d.]/g, '')) || 0;
        if (D.head === 'hex') { hex(cx, (dk / 2) / Math.cos(Math.PI / 6) * sc, 'f-metal'); sv(svg, 'circle', { cx, cy, r: (dk / 2) * sc * 0.95, class: 'f-thin' }); }
        else sv(svg, 'circle', { cx, cy, r: (dk / 2) * sc, class: 'f-metal' });
        if (/^hex/.test(D.drive)) hex(cx, (key / 2) / Math.cos(Math.PI / 6) * sc, 'f-thin');
        else if (/^PH/.test(D.drive)) { const a = dk * 0.22 * sc, w = Math.max(1.2, dk * 0.05 * sc); sv(svg, 'path', { d: `M${cx - a},${cy - w}h${a - w}v${-(a - w)}h${2 * w}v${a - w}h${a - w}v${2 * w}h${-(a - w)}v${a - w}h${-2 * w}v${-(a - w)}h${-(a - w)}z`, class: 'f-thin' }); }
        sv(svg, 'text', { x: cx, y: H - 22, 'text-anchor': 'middle', class: 'f-dt' }, `${D.head === 'hex' ? 'AF' : 'Ø'}${n(dk)}`);
        sv(svg, 'text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'f-lab' }, `drive ${D.drive}`);
      } else if (it.kind === 'washer') {
        sv(svg, 'circle', { cx, cy, r: (wa.d2 / 2) * sc, class: 'f-washer' });
        sv(svg, 'circle', { cx, cy, r: (wa.d1 / 2) * sc, fill: 'var(--surface)', class: 'f-thin' });
        sv(svg, 'text', { x: cx, y: H - 22, 'text-anchor': 'middle', class: 'f-dt' }, `${n(wa.d1)} / ${n(wa.d2)}`);
        sv(svg, 'text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'f-lab' }, `washer t ${n(wa.h)}`);
      } else {
        const Rt = (nut.trapCorners / 2) * sc;
        hex(cx, Rt, 'f-hidden');
        hex(cx, (nut.e / 2) * sc, 'f-metal');
        sv(svg, 'circle', { cx, cy, r: (d / 2) * sc, fill: 'var(--surface)', class: 'f-thin' });
        sv(svg, 'text', { x: cx, y: H - 22, 'text-anchor': 'middle', class: 'f-dt' }, `AF ${n(nut.s)} · ${n(nut.e)}`);
        sv(svg, 'text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'f-lab' }, `trap ${n(nut.trap)} × ${n(nut.trapDepth)}`);
      }
      x += 2 * it.R * sc + gap;
    }
  }

  // ---------- all together ----------
  function draw() {
    const raw = ctx.raw;
    headPick.sync(raw.head); nutPick.sync(raw.nut); matPick.sync(raw.material);
    matGrp.style.display = raw.nut === 'none' ? '' : 'none';
    washerBtn.setAttribute('aria-pressed', String(!!raw.washer));
    if (document.activeElement !== gripIn) gripIn.value = raw.grip ?? '';
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    if (!D) return;
    drawGauge(); drawJoint(); drawSeat(); drawEnds();
    jointHead.replaceChildren(h('span', { class: 'fl-cap' }, `${D.size} × ${n(D.p)} · ${D.headName}`),
      h('span', { class: 'fl-note' }, dragging ? 'release to rescale' : `drag the blue bar to set the grip · ${scaleNote}`));
  }
  ctx.onResult((r) => { res = r; D = r.draw || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [gaugeSvg, jointSvg, seatSvg, endsSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !D) return;
      sizes = now; frozen = null; draw();
    });
  }).observe(layout);
}
