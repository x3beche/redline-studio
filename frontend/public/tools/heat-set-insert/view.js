// Heat-Set Insert Sizer: the page is the boss the insert goes into.
//   Plan    - the boss seen from above, to scale: the hole, the insert's knurl
//             ring cutting into the wall, the 1.6 x and 2 x OD limits as rings,
//             and for FDM every perimeter the slicer lays in the wall, drawn at
//             its line width. Drag the boss's outer edge (or its knob, or use
//             the arrow keys on it) to size the boss.
//   Section - a cut through the boss with the hole depth; drag the insert (or
//             use the arrow keys) to press it in and see where it seats and
//             where the displaced plastic goes.
//   Shelf   - the common inserts to scale; click one, or give a custom size.
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

const CSS = `
:root {
  --tool-plastic: #3f7fbf; --tool-plastic-2: #6aa3d9; --tool-brass: #b88a1e; --tool-brass-fill: color-mix(in srgb, #d9a93a 45%, var(--surface));
  --tool-melt: #d9534f; --tool-dim: #1f4ed8; --tool-iron: #5b6b7a;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --tool-plastic: #5b9be0; --tool-plastic-2: #8dbdf0; --tool-brass: #e0b44a; --tool-brass-fill: color-mix(in srgb, #e0b44a 30%, var(--surface));
  --tool-melt: #ef7a76; --tool-dim: #7d9bff; --tool-iron: #8ea0b0; } }
:root[data-theme="dark"] {
  --tool-plastic: #5b9be0; --tool-plastic-2: #8dbdf0; --tool-brass: #e0b44a; --tool-brass-fill: color-mix(in srgb, #e0b44a 30%, var(--surface));
  --tool-melt: #ef7a76; --tool-dim: #7d9bff; --tool-iron: #8ea0b0; }

.k-page { padding: 10px 12px; }
.hs { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) minmax(250px, 300px) 350px;
  grid-template-rows: auto minmax(0, 1fr) auto; grid-template-areas: "bar bar bar" "plan sect side" "shelf shelf side";
  height: calc(100vh - 66px); min-height: 640px; }
.hs-bar { grid-area: bar; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.hs-plan { grid-area: plan; } .hs-sect { grid-area: sect; } .hs-shelf { grid-area: shelf; } .hs-side { grid-area: side; }
.hs-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.hs-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.hs-head { display: flex; align-items: baseline; gap: 10px; padding: 6px 10px 0; flex-wrap: wrap; }
.hs-note { margin-left: auto; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.hs-grp { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hs-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.hs-seg button { border: 0; background: transparent; padding: 3px 9px; cursor: pointer; font-size: 12.5px; color: var(--ink-soft); line-height: 1.25; }
.hs-seg button + button { border-left: 1px solid var(--line-soft); }
.hs-seg button:hover { background: var(--sunken); color: var(--ink); }
.hs-seg button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); }
.hs-seg button small { display: block; font: 10.5px "IBM Plex Mono", ui-monospace, monospace; opacity: 0.8; }
.hs-num { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.hs-num input { width: 56px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.hs-right { margin-left: auto; }

.hs-box { position: relative; flex: 1; min-height: 0; }
.hs-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.hs-warns:empty { display: none; }
.hs-warns { border-top: 1px solid var(--warn); padding: 5px 10px; font-size: 12px; background: color-mix(in srgb, var(--warn) 10%, var(--surface)); border-radius: 0 0 6px 6px; }
.hs-warns div::before { content: "! "; color: var(--warn); font-weight: 600; }
.hs-side { display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
.hs-side .k-outwrap { flex: 1; min-height: 160px; display: flex; flex-direction: column; }
.hs-side .k-out { flex: 1; max-height: none; }
.hs-facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; padding: 8px 10px 10px; margin: 0; font-size: 12.5px; }
.hs-facts dt { color: var(--ink-soft); }
.hs-facts dd { margin: 0; text-align: right; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.hs-facts dd.ok { color: var(--ok); } .hs-facts dd.warn { color: var(--warn); } .hs-facts dd.bad { color: var(--danger); }

/* shelf */
.hs-shelf-row { display: flex; gap: 6px; padding: 6px 8px 8px; align-items: stretch; overflow-x: auto; }
.hs-item { flex: 1 1 0; min-width: 62px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px;
  border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; padding: 4px 4px 5px; color: var(--ink-soft); }
.hs-item:hover { background: var(--sunken); color: var(--ink); }
.hs-item[aria-checked="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--ink); }
.hs-item svg { width: 100%; height: 64px; display: block; }
.hs-item b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; }
.hs-item small { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.hs-custom { flex: 1.4 1 0; min-width: 130px; justify-content: center; gap: 4px; cursor: default; }
.hs-custom .hs-num input { width: 48px; }
.hs-custom > button { border: 0; background: transparent; color: inherit; cursor: pointer; font: 500 12px "IBM Plex Mono", ui-monospace, monospace; padding: 0; }

/* drawing */
.hs-draw text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.h-boss { fill: color-mix(in srgb, var(--tool-plastic) 14%, var(--surface)); stroke: var(--ink); stroke-width: 1.4; }
.h-boss.ok { stroke: var(--ok); } .h-boss.warn { stroke: var(--warn); } .h-boss.bad { stroke: var(--danger); fill: color-mix(in srgb, var(--danger) 12%, var(--surface)); }
.h-hole { fill: var(--paper); stroke: var(--ink); stroke-width: 1.2; }
.h-knurl { fill: color-mix(in srgb, var(--tool-melt) 18%, transparent); stroke: var(--tool-melt); stroke-width: 0.9; stroke-dasharray: 3 2; }
.h-peri { fill: none; stroke: var(--tool-plastic); stroke-opacity: 0.55; }
.h-peri.b { stroke: var(--tool-plastic-2); }
.h-peri-c { fill: none; stroke: var(--surface); stroke-width: 0.8; stroke-opacity: 0.8; }
.h-gap { fill: none; stroke: var(--tool-melt); stroke-dasharray: 1.5 2.5; }
.h-lim { fill: none; stroke-width: 1.1; stroke-dasharray: 6 4; }
.h-lim.min { stroke: var(--warn); } .h-lim.rec { stroke: var(--ok); }
.h-band { fill: color-mix(in srgb, var(--warn) 10%, transparent); }
.h-limt { font-size: 11px; } .h-limt.min { fill: var(--warn); } .h-limt.rec { fill: var(--ok); }
.h-dim { stroke: var(--tool-dim); stroke-width: 0.9; fill: none; }
.h-ext { stroke: var(--tool-dim); stroke-width: 0.6; opacity: 0.6; fill: none; }
.h-ah { fill: var(--tool-dim); }
.h-dt { font-size: 11.5px; fill: var(--tool-dim); stroke: var(--surface); stroke-width: 4; paint-order: stroke; }
.h-dt.big { font-size: 13px; font-weight: 600; }
.h-lab { font-size: 11px; fill: var(--ink-soft); stroke: var(--surface); stroke-width: 3; paint-order: stroke; }
.h-bad { fill: var(--danger); font-size: 11.5px; stroke: var(--surface); stroke-width: 4; paint-order: stroke; }
.h-axis { stroke: var(--ink-soft); stroke-width: 0.7; stroke-dasharray: 12 3 2 3; }
.h-edge { fill: none; stroke: transparent; stroke-width: 16; cursor: nwse-resize; }
.h-knob { cursor: ew-resize; outline: none; }
.h-knob circle.k { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.h-knob circle.r { fill: none; stroke: none; }
.h-knob:focus-visible circle.r { stroke: var(--accent); stroke-width: 2; }
.h-knob path { fill: var(--accent-ink); }
.h-sect { stroke: var(--tool-plastic); stroke-width: 1.2; }
.h-hp-bg { fill: color-mix(in srgb, var(--tool-plastic) 18%, var(--surface)); }
.h-hp-ln { stroke: var(--tool-plastic); stroke-width: 0.9; }
.h-brass { fill: var(--tool-brass-fill); stroke: var(--tool-brass); stroke-width: 1.2; }
.h-thread { stroke: var(--tool-brass); stroke-width: 0.8; fill: none; }
.h-iron { fill: color-mix(in srgb, var(--tool-iron) 30%, var(--surface)); stroke: var(--tool-iron); stroke-width: 1.2; }
.h-ins { cursor: ns-resize; outline: none; }
.h-ins:focus-visible .h-brass { stroke: var(--accent); stroke-width: 2; }
.h-melt { fill: color-mix(in srgb, var(--tool-melt) 30%, transparent); stroke: none; }
.h-meltt { font-size: 11px; fill: var(--tool-melt); stroke: var(--surface); stroke-width: 3; paint-order: stroke; }

@media (max-width: 1150px) {
  .hs { grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); grid-template-rows: auto 460px auto auto;
    grid-template-areas: "bar bar" "plan sect" "shelf shelf" "side side"; height: auto; min-height: 0; }
}
@media (max-width: 680px) {
  .k-page { padding: 8px; }
  .hs { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "bar" "plan" "sect" "shelf" "side"; }
  .hs-plan .hs-box { height: 340px; flex: none; } .hs-sect .hs-box { height: 300px; flex: none; }
  .hs-right { margin-left: 0; }
  .hs-note { display: none; }
}
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  let D = null, res = null;
  let planScale = null, dragBoss = false, frozenPlan = null, focusKnob = false;
  let press = 0.35;            // visual only: how far the insert is pressed in, 0..1
  let dragIns = null, focusIns = false, knownInserts = [];

  // ---------- bar ----------
  const seg = (label, key, cls) => {
    const g = h('div', { class: `hs-seg ${cls || ''}`, role: 'radiogroup', 'aria-label': label });
    g.sync = (items, cur) => {
      if (g.dataset.items !== JSON.stringify(items)) {
        g.dataset.items = JSON.stringify(items);
        g.replaceChildren(...items.map(([v, t, sub], i) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set(key, v),
          onkeydown: (e) => {
            const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!d) return; e.preventDefault();
            const j = clamp(i + d, 0, items.length - 1); ctx.set(key, items[j][0]);
            requestAnimationFrame(() => g.querySelector(`[data-v="${items[j][0]}"]`)?.focus());
          } }, t, sub ? h('small', {}, sub) : null)));
      }
      for (const b of g.children) { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    };
    return g;
  };
  const procSeg = seg('Part made by', 'process');
  const matSeg = seg('Material', 'material');
  const numField = (key, label, unit, aria) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'hs-num' }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const lineF = numField('line', 'Line', 'mm', 'FDM line width in mm');
  const bossF = numField('boss', 'Boss Ø', 'mm', 'Your boss outer diameter in mm');
  const bar = h('div', { class: 'hs-bar' },
    h('div', { class: 'hs-grp' }, h('span', { class: 'hs-cap' }, 'Made by'), procSeg),
    h('div', { class: 'hs-grp' }, h('span', { class: 'hs-cap' }, 'Material · iron'), matSeg),
    h('div', { class: 'hs-grp hs-right' }, lineF, bossF));

  // ---------- plan ----------
  const planSvg = sv(null, 'svg', { class: 'hs-draw', role: 'group', 'aria-label': 'The boss seen from above, to scale' });
  const planHead = h('div', { class: 'hs-head' });
  const warns = h('div', { class: 'hs-warns', 'aria-live': 'polite' });
  const plan = h('section', { class: 'hs-card hs-plan' }, planHead, h('div', { class: 'hs-box' }, planSvg), warns);
  // ---------- section ----------
  const sectSvg = sv(null, 'svg', { class: 'hs-draw', role: 'group', 'aria-label': 'Section through the boss with the insert' });
  const sectHead = h('div', { class: 'hs-head' });
  const sect = h('section', { class: 'hs-card hs-sect' }, sectHead, h('div', { class: 'hs-box' }, sectSvg));
  // ---------- shelf ----------
  const shelfRow = h('div', { class: 'hs-shelf-row', role: 'radiogroup', 'aria-label': 'Insert' });
  const shelf = h('section', { class: 'hs-card hs-shelf' }, h('div', { class: 'hs-head' }, h('span', { class: 'hs-cap' }, 'Insert, to scale'),
    h('span', { class: 'hs-note' }, 'typical tapered brass inserts')), shelfRow);
  // ---------- side ----------
  const facts = h('dl', { class: 'hs-facts' });
  const side = h('aside', { class: 'hs-side' }, h('section', { class: 'hs-card' }, h('div', { class: 'hs-head' }, h('span', { class: 'hs-cap' }, 'To model')), facts), ctx.outputs);

  const layout = h('div', { class: 'hs' }, bar, plan, sect, shelf, side);
  root.append(layout);

  const defs = (svg) => {
    const d = sv(svg, 'defs');
    const m = sv(d, 'marker', { id: `hs-ar-${svg === planSvg ? 'p' : 's'}`, viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(m, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'h-ah' });
    return d;
  };

  // ---------- plan drawing ----------
  function drawPlan() {
    const svg = planSvg; svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 600), H = Math.max(260, svg.clientHeight || 480);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    defs(svg);
    const AR = 'url(#hs-ar-p)';
    const { od, hole, bossMin, bossRec, boss, line, process } = D;
    const Rb = (boss ?? bossRec) / 2;
    let sc, cx, cy;
    if (frozenPlan) ({ sc, cx, cy } = frozenPlan);
    else {
      const Rv = Math.max(bossRec, boss ?? 0) / 2 * 1.2;
      const narrow = W < 500;
      sc = Math.min((W - (narrow ? 30 : 210)) / (2 * Rv), (H - 60) / (2 * Rv));
      cx = narrow ? W / 2 : (W - 170) / 2 + 10; cy = H / 2 + 6;
    }
    planScale = { sc, cx, cy };
    const R = (mm) => mm * sc;
    // limit band between 1.6 x and 2 x OD
    const circ = (r) => `M${cx + r},${cy} a${r},${r} 0 1 0 ${-2 * r},0 a${r},${r} 0 1 0 ${2 * r},0 Z`;
    sv(svg, 'path', { d: circ(R(bossRec / 2)) + circ(R(bossMin / 2)), class: 'h-band', 'fill-rule': 'evenodd' });
    // the boss
    if (boss != null && boss > hole) {
      sv(svg, 'circle', { cx, cy, r: R(Rb), class: `h-boss ${D.tone || ''}` });
      if (process === 'fdm' && line) {
        const wall = (boss - hole) / 2, k = Math.floor(wall / line + 1e-9);
        const nIn = Math.ceil(k / 2), nOut = k - nIn;
        const sw = Math.max(0.6, R(line) - 0.8);
        for (let i = 0; i < nIn; i++) sv(svg, 'circle', { cx, cy, r: R(hole / 2 + line * (i + 0.5)), class: 'h-peri', 'stroke-width': sw });
        for (let i = 0; i < nOut; i++) sv(svg, 'circle', { cx, cy, r: R(boss / 2 - line * (i + 0.5)), class: 'h-peri b', 'stroke-width': sw });
        const gap = wall - k * line;
        if (gap > 0.02 * line && k > 0) sv(svg, 'circle', { cx, cy, r: R(hole / 2 + nIn * line + gap / 2), class: 'h-gap', 'stroke-width': Math.max(1, R(gap)) });
      }
    }
    // knurl ring: the insert's teeth cut into the wall between the hole and its OD
    sv(svg, 'path', { d: circ(R(od / 2)) + circ(R(hole / 2)), class: 'h-knurl', 'fill-rule': 'evenodd' });
    sv(svg, 'circle', { cx, cy, r: R(hole / 2), class: 'h-hole' });
    // centre lines
    const ext = R(Math.max(bossRec, boss ?? 0) / 2) + 14;
    sv(svg, 'line', { x1: cx - ext, x2: cx + ext, y1: cy, y2: cy, class: 'h-axis' });
    sv(svg, 'line', { x1: cx, x2: cx, y1: cy - ext, y2: cy + ext, class: 'h-axis' });
    // limit rings with labels on the upper right
    const ring = (dia, cls, text, ang) => {
      const r = R(dia / 2);
      sv(svg, 'circle', { cx, cy, r, class: `h-lim ${cls}` });
      const a = (ang * Math.PI) / 180, px = cx + r * Math.cos(a), py = cy - r * Math.sin(a);
      const lx = cx + R(Math.max(bossRec, boss ?? 0) / 2) + 24, ly = Math.min(py, labelY); labelY = ly + 16;
      if (W >= 500) {
        sv(svg, 'path', { d: `M${px},${py} L${lx - 4},${ly}`, class: `h-lim ${cls}`, 'stroke-dasharray': null, 'stroke-width': 0.8 });
        sv(svg, 'text', { x: lx, y: ly + 4, class: `h-limt ${cls}` }, text);
      }
    };
    let labelY = Infinity;
    ring(bossRec, 'rec', `rec. Ø${n(bossRec)}  2×OD`, 40);
    labelY = Infinity;
    const recY = cy - R(bossRec / 2) * Math.sin((40 * Math.PI) / 180);
    labelY = recY - 16;
    ring(bossMin, 'min', `min Ø${n(bossMin)}  1.6×OD`, 52);
    // dims: hole Ø across the lower-left; insert OD
    const a1 = (-135 * Math.PI) / 180;
    const hx = Math.cos(a1), hy = -Math.sin(a1);
    sv(svg, 'line', { x1: cx - hx * R(hole / 2), y1: cy - hy * R(hole / 2), x2: cx + hx * R(hole / 2), y2: cy + hy * R(hole / 2), class: 'h-dim', 'marker-start': 'url(#hs-ar-p)', 'marker-end': 'url(#hs-ar-p)' });
    const tip = { x: cx + hx * R(hole / 2), y: cy + hy * R(hole / 2) };
    const lab = { x: Math.max(tip.x - 30, 128), y: tip.y + 34 };
    sv(svg, 'path', { d: `M${tip.x},${tip.y} L${lab.x + 4},${lab.y - 4}`, class: 'h-ext' });
    sv(svg, 'text', { x: lab.x, y: lab.y + 8, 'text-anchor': 'end', class: 'h-dt big' }, `hole Ø${n(hole)}`);
    sv(svg, 'text', { x: lab.x, y: lab.y + 22, 'text-anchor': 'end', class: 'h-lab' }, `insert Ø${n(od)} knurl`);
    // wall: a radial dimension to the east, and the perimeter count
    if (boss != null && boss > hole) {
      const y = cy + 18;
      sv(svg, 'line', { x1: cx + R(hole / 2), x2: cx + R(Rb), y1: y, y2: y, class: 'h-dim', 'marker-start': AR, 'marker-end': AR });
      sv(svg, 'line', { x1: cx + R(Rb), x2: cx + R(Rb), y1: cy + 4, y2: y + 5, class: 'h-ext' });
      const thin = R(Rb - hole / 2) < 70;
      const tx = thin ? cx + R(Rb) + 8 : cx + R((hole / 2 + Rb) / 2), ta = thin ? 'start' : 'middle';
      sv(svg, 'text', { x: tx, y: y + 16, 'text-anchor': ta, class: `h-dt big` }, `wall ${n(D.wall)}`);
      if (D.lines != null) sv(svg, 'text', { x: tx, y: y + 30, 'text-anchor': ta, class: D.linesTone === 'bad' ? 'h-bad' : 'h-lab' }, `${n(D.lines)} lines of ${n(line)}`);
      // boss Ø over the top
      const ty = cy - R(Rb) - 14;
      sv(svg, 'line', { x1: cx - R(Rb), x2: cx + R(Rb), y1: ty, y2: ty, class: 'h-dim', 'marker-start': AR, 'marker-end': AR });
      for (const s of [-1, 1]) sv(svg, 'line', { x1: cx + s * R(Rb), x2: cx + s * R(Rb), y1: cy - 3, y2: ty - 5, class: 'h-ext' });
      sv(svg, 'text', { x: cx, y: ty - 5, 'text-anchor': 'middle', class: 'h-dt big' }, `boss Ø${n(boss)}`);
      if (D.tone === 'bad') sv(svg, 'text', { x: cx, y: ty - 24, 'text-anchor': 'middle', class: 'h-bad' }, `wall ${n(D.wall)}: under the 1.6×OD minimum`);
    } else {
      sv(svg, 'text', { x: cx, y: cy - R(bossRec / 2) - 16, 'text-anchor': 'middle', class: 'h-bad' }, boss == null ? 'no boss given: drag the knob to draw one' : 'boss not larger than the hole');
    }
    // the drag edge and knob
    const edge = sv(svg, 'circle', { cx, cy, r: R(Rb), class: 'h-edge' });
    const kg = sv(svg, 'g', { class: 'h-knob', tabindex: 0, role: 'slider', 'aria-label': 'Boss outer diameter', 'aria-valuemin': n(hole), 'aria-valuemax': 60,
      'aria-valuenow': boss ?? '', 'aria-valuetext': boss != null ? `${n(boss)} mm` : 'not set', 'data-h': 'boss' });
    const kx = cx + R(Rb) * Math.cos(-Math.PI / 4), ky = cy - R(Rb) * Math.sin(-Math.PI / 4);
    sv(kg, 'circle', { cx: kx, cy: ky, r: 13, class: 'r' });
    sv(kg, 'circle', { cx: kx, cy: ky, r: 8, class: 'k' });
    sv(kg, 'path', { d: `M${kx - 4},${ky - 4} l0,3.4 l3.4,-3.4 z M${kx + 4},${ky + 4} l0,-3.4 l-3.4,3.4 z` });
    const start = (e) => { dragBoss = true; frozenPlan = planScale; capture(planSvg, e); e.preventDefault(); setBossAt(e); };
    edge.addEventListener('pointerdown', start);
    kg.addEventListener('pointerdown', start);
    kg.addEventListener('keydown', (e) => {
      const st = { ArrowRight: 0.1, ArrowUp: 0.1, ArrowLeft: -0.1, ArrowDown: -0.1 }[e.key];
      if (!st) return; e.preventDefault();
      setBoss((boss ?? bossRec) + st * (e.shiftKey ? 10 : 1)); focusKnob = true;
    });
    if (focusKnob) { kg.focus(); focusKnob = false; }
    // legend
    const lg = sv(svg, 'g', {});
    let ly = H - 12;
    const item = (cls, text, style) => { sv(lg, 'rect', { x: 10, y: ly - 8, width: 14, height: 8, class: cls, style }); sv(lg, 'text', { x: 30, y: ly, class: 'h-lab' }, text); ly -= 15; };
    if (process === 'fdm' && line && boss) { item('h-peri', 'perimeters from the hole', 'stroke-width:3;fill:none'); item('h-peri b', 'perimeters from the outside', 'stroke-width:3;fill:none'); }
    item('h-knurl', 'cut by the knurl', '');
  }
  function setBoss(v) {
    const b = Math.round(clamp(v, D.hole + 0.2, 80) * 10) / 10;
    if (D.boss != null && Math.abs(b - D.boss) < 1e-9) return;
    ctx.set('boss', String(b));
  }
  function setBossAt(e) {
    const r = planSvg.getBoundingClientRect(), vb = planSvg.viewBox.baseVal;
    const x = ((e.clientX - r.left) / r.width) * vb.width, y = ((e.clientY - r.top) / r.height) * vb.height;
    const { sc, cx, cy } = planScale;
    setBoss((2 * Math.hypot(x - cx, y - cy)) / sc);
  }
  planSvg.addEventListener('pointermove', (e) => { if (dragBoss) setBossAt(e); });
  const endBoss = () => { if (!dragBoss) return; dragBoss = false; frozenPlan = null; if (D) draw(); };
  planSvg.addEventListener('pointerup', endBoss);
  planSvg.addEventListener('pointercancel', endBoss);

  // ---------- section drawing ----------
  function drawSect() {
    const svg = sectSvg; svg.replaceChildren();
    const W = Math.max(220, svg.clientWidth || 300), H = Math.max(260, svg.clientHeight || 480);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const d = defs(svg);
    const AR = 'url(#hs-ar-s)';
    const pt = sv(d, 'pattern', { id: 'hs-hp', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 6, height: 6, class: 'h-hp-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'h-hp-ln' });
    const { od, hole, depth, length: L, boss, bossRec } = D;
    const Bd = boss != null && boss > hole ? boss : bossRec;
    const baseH = depth + Math.max(1.5, 0.4 * od);
    // y in mm: 0 = boss top, positive down. Insert above by (1 - press) of its travel.
    const seatTop = 0.15;                       // pressed 0.1-0.2 mm below the surface
    const travel = L + 2.5;
    const insTop = seatTop - (1 - press) * travel;
    const yMin = seatTop - travel - 0.35 * L - 1.2, yMax = baseH + 0.6;
    const halfW = Bd / 2 + 0.6;
    const sc = Math.min((W - 96) / (2 * halfW), (H - 70) / (yMax - yMin));
    const cx = W / 2 - 16, oy = 30 - yMin * sc + ((H - 70) - (yMax - yMin) * sc) / 2;
    const X = (x) => cx + x * sc, Y = (y) => oy + y * sc;
    // boss walls
    for (const s of [-1, 1]) {
      const pts = [[s * hole / 2, 0], [s * Bd / 2, 0], [s * Bd / 2, baseH], [0, baseH], [0, depth], [s * hole / 2, depth]];
      sv(svg, 'path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z', fill: 'url(#hs-hp)', class: 'h-sect' });
    }
    // melt/displaced plastic along the insert where it is in
    const inTop = Math.max(0, insTop), inBot = Math.min(depth, insTop + L);
    const od2 = (y) => { const t = clamp((y - insTop) / L, 0, 1); return (od / 2) - t * 0.18 * (od - hole); }; // slight taper
    if (inBot > inTop) for (const s of [-1, 1]) sv(svg, 'path', { d: `M${X(s * hole / 2)},${Y(inTop)} L${X(s * od2(inTop))},${Y(inTop)} L${X(s * od2(inBot))},${Y(inBot)} L${X(s * hole / 2)},${Y(inBot)} Z`, class: 'h-melt' });
    // the insert
    const g = sv(svg, 'g', { class: 'h-ins', tabindex: 0, role: 'slider', 'aria-label': 'Press the insert in (drawing only)', 'aria-valuemin': 0, 'aria-valuemax': 100,
      'aria-valuenow': Math.round(press * 100), 'data-h': 'press' });
    const top = insTop, bot = insTop + L, rT = od / 2, rB = od / 2 - 0.18 * (od - hole);
    sv(g, 'rect', { x: X(-rT) - 8, y: Y(top) - 6, width: 2 * rT * sc + 16, height: L * sc + 12, fill: 'transparent' });
    sv(g, 'path', { d: `M${X(-rT)},${Y(top)} L${X(rT)},${Y(top)} L${X(rB)},${Y(bot)} L${X(-rB)},${Y(bot)} Z`, class: 'h-brass' });
    // knurl bands
    const kn = Math.max(2, Math.round(L / 1.2));
    for (let i = 1; i < kn; i++) { const y = top + (L * i) / kn; const r = od2(y); sv(g, 'line', { x1: X(-r), x2: X(r), y1: Y(y), y2: Y(y), class: 'h-thread', 'stroke-dasharray': '2 2' }); }
    const rTh = Math.min(rB - 0.4, hole / 2 - 0.35);
    for (const s of [-1, 1]) sv(g, 'line', { x1: X(s * rTh), x2: X(s * rTh), y1: Y(top), y2: Y(bot), class: 'h-thread' });
    // iron over the insert
    const ib = top - 0.15;
    sv(g, 'path', { d: `M${X(-rT * 0.9)},${Y(ib)} L${X(rT * 0.9)},${Y(ib)} L${X(rT * 1.1)},${Y(ib - 0.25 * L)} L${X(rT * 0.55)},${Y(ib - 0.35 * L)} L${X(rT * 0.55)},${Y(ib - 0.35 * L) - 16} L${X(-rT * 0.55)},${Y(ib - 0.35 * L) - 16} L${X(-rT * 0.55)},${Y(ib - 0.35 * L)} L${X(-rT * 1.1)},${Y(ib - 0.25 * L)} Z`, class: 'h-iron' });
    sv(svg, 'text', { x: X(rT * 1.1) + 8, y: Y(ib - 0.25 * L) + 4, class: 'h-meltt' }, `iron ${D.temp}`);
    // axis
    sv(svg, 'line', { x1: cx, x2: cx, y1: Y(yMin) + 6, y2: Y(yMax) + 4, class: 'h-axis' });
    // dims: hole depth on the right, hole Ø at the bottom, boss Ø on top
    const dx = X(Bd / 2) + 18;
    sv(svg, 'line', { x1: dx, x2: dx, y1: Y(0), y2: Y(depth), class: 'h-dim', 'marker-start': AR, 'marker-end': AR });
    sv(svg, 'line', { x1: X(hole / 2), x2: dx + 4, y1: Y(depth), y2: Y(depth), class: 'h-ext' });
    sv(svg, 'line', { x1: X(Bd / 2), x2: dx + 4, y1: Y(0), y2: Y(0), class: 'h-ext' });
    const my = (Y(0) + Y(depth)) / 2;
    sv(svg, 'text', { x: dx + 5, y: my, transform: `rotate(-90 ${dx + 5} ${my})`, 'text-anchor': 'middle', class: 'h-dt', dy: -2 }, `≥ ${n(depth)}`);
    const by = Y(baseH) + 16;
    sv(svg, 'line', { x1: X(-hole / 2), x2: X(hole / 2), y1: by, y2: by, class: 'h-dim', 'marker-start': AR, 'marker-end': AR });
    for (const s of [-1, 1]) sv(svg, 'line', { x1: X(s * hole / 2), x2: X(s * hole / 2), y1: Y(depth), y2: by + 4, class: 'h-ext' });
    sv(svg, 'text', { x: cx, y: by + 15, 'text-anchor': 'middle', class: 'h-dt' }, `Ø${n(hole)}`);
    // the +1 mm for displaced plastic
    const lx = X(-Bd / 2) - 6;
    sv(svg, 'path', { d: `M${X(-hole / 2) + 2},${Y(depth - 0.5)} L${lx},${Y(depth - 0.5)}`, class: 'h-ext' });
    sv(svg, 'text', { x: lx - 2, y: Y(depth - 0.5) + 4, 'text-anchor': 'end', class: 'h-lab' }, '+1');
    // insert labels
    const seated = press > 0.995;
    sv(svg, 'text', { x: X(-rT) - 8, y: Y(top + L / 2) + 4, 'text-anchor': 'end', class: 'h-lab' }, `${n(od)}×${n(L)}`);
    if (seated) sv(svg, 'text', { x: cx, y: Y(0) - 8 - 0.35 * L * sc - 18, 'text-anchor': 'middle', class: 'h-dt' }, '0.1-0.2 below the top');
    const g2 = g;
    g2.addEventListener('pointerdown', (e) => {
      dragIns = { y: e.clientY, p: press, k: (sectSvg.viewBox.baseVal.height / sectSvg.getBoundingClientRect().height) / (travel * sc) };
      capture(sectSvg, e); e.preventDefault();
    });
    g2.addEventListener('keydown', (e) => {
      const st = { ArrowDown: 0.1, ArrowRight: 0.1, ArrowUp: -0.1, ArrowLeft: -0.1, End: 1, Home: -1 }[e.key];
      if (!st) return; e.preventDefault();
      press = clamp(press + st, 0, 1); focusIns = true; drawSect(); drawSectHead();
    });
    if (focusIns) { g2.focus(); focusIns = false; }
  }
  sectSvg.addEventListener('pointermove', (e) => {
    if (!dragIns) return;
    press = clamp(dragIns.p + (e.clientY - dragIns.y) * dragIns.k, 0, 1);
    drawSect(); drawSectHead();
  });
  const endIns = () => { dragIns = null; };
  sectSvg.addEventListener('pointerup', endIns);
  sectSvg.addEventListener('pointercancel', endIns);
  function drawSectHead() {
    sectHead.replaceChildren(h('span', { class: 'hs-cap' }, 'Section'),
      h('span', { class: 'hs-note' }, press > 0.995 ? 'seated' : `drag the insert down · ${Math.round(press * 100)} %`));
  }

  // ---------- shelf ----------
  function drawShelf() {
    if (D) knownInserts = D.inserts;
    const list = knownInserts;
    if (!list.length) return;
    const raw = ctx.raw;
    const maxOD = Math.max(...list.map((i) => i.od), 1), maxL = Math.max(...list.map((i) => i.length), 1);
    const items = list.map((it, idx) => {
      const on = raw.insert === it.key;
      const s = sv(null, 'svg', { viewBox: '0 0 60 64', 'aria-hidden': 'true' });
      const k = Math.min(52 / maxOD, 56 / maxL);
      const rT = (it.od / 2) * k, rB = (it.od / 2 - 0.18 * (it.od - it.hole)) * k, Lp = it.length * k, x0 = 30, y1 = 62, y0 = y1 - Lp;
      sv(s, 'path', { d: `M${x0 - rT},${y0} L${x0 + rT},${y0} L${x0 + rB},${y1} L${x0 - rB},${y1} Z`, class: 'h-brass' });
      const kn = Math.max(2, Math.round(it.length / 1.2));
      for (let i = 1; i < kn; i++) { const y = y0 + (Lp * i) / kn, r = rT - (rT - rB) * (i / kn); sv(s, 'line', { x1: x0 - r, x2: x0 + r, y1: y, y2: y, class: 'h-thread', 'stroke-dasharray': '2 2' }); }
      return h('button', { type: 'button', class: 'hs-item', role: 'radio', 'aria-checked': String(on), tabindex: on ? 0 : -1, 'data-v': it.key,
        title: `${it.name}: Ø${it.od} × ${it.length}, hole Ø${it.hole}`,
        onclick: () => ctx.set('insert', it.key),
        onkeydown: (e) => {
          const dd = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!dd) return; e.preventDefault();
          const keys = [...list.map((x) => x.key), 'custom'];
          const j = clamp(idx + dd, 0, keys.length - 1); ctx.set('insert', keys[j]);
          requestAnimationFrame(() => shelfRow.querySelector(`[data-v="${keys[j]}"]`)?.focus());
        } }, s, h('b', {}, it.name.replace(' short', 's')), h('small', {}, `${it.od}×${it.length}`));
    });
    const on = raw.insert === 'custom';
    const odIn = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Custom insert outer diameter, mm', value: raw.od ?? '', oninput: (e) => ctx.set('od', e.target.value) });
    const lIn = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Custom insert length, mm', value: raw.length ?? '', oninput: (e) => ctx.set('length', e.target.value) });
    const custom = h('div', { class: 'hs-item hs-custom', role: 'radio', 'aria-checked': String(on), 'data-v': 'custom', tabindex: on ? 0 : -1,
      onkeydown: (e) => {
        if (e.target !== custom) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const k = list[list.length - 1].key; ctx.set('insert', k); requestAnimationFrame(() => shelfRow.querySelector(`[data-v="${k}"]`)?.focus()); }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('insert', 'custom'); }
      } },
    h('button', { type: 'button', tabindex: -1, onclick: () => ctx.set('insert', 'custom') }, 'Custom, from data sheet'),
    h('label', { class: 'hs-num' }, h('span', {}, 'OD'), odIn), h('label', { class: 'hs-num' }, h('span', {}, 'L'), lIn));
    custom.addEventListener('focusin', (e) => { if (e.target.tagName === 'INPUT' && ctx.raw.insert !== 'custom') ctx.set('insert', 'custom'); });
    const act = document.activeElement;
    if (act && shelfRow.contains(act) && act.tagName === 'INPUT') {
      // keep typing: update the other items but leave the custom box alone
      shelfRow.querySelectorAll('.hs-item:not(.hs-custom)').forEach((b) => { const o = b.dataset.v === raw.insert; b.setAttribute('aria-checked', String(o)); b.tabIndex = o ? 0 : -1; });
      shelfRow.querySelector('.hs-custom').setAttribute('aria-checked', String(on));
      return;
    }
    shelfRow.replaceChildren(...items, custom);
  }

  // ---------- facts ----------
  function drawFacts() {
    const row = (k, v, cls) => [h('dt', {}, k), h('dd', { class: cls || null }, v)];
    facts.replaceChildren(
      ...row('Hole Ø', `${n(D.hole)} mm`, 'ok'),
      ...row('Hole depth', `≥ ${n(D.depth)} mm`),
      ...row('Boss Ø min / rec.', `${n(D.bossMin)} / ${n(D.bossRec)}`),
      ...(D.wall != null ? row('Your wall', `${n(D.wall)} mm`, D.tone) : []),
      ...(D.lines != null ? row('Perimeters', `${n(D.lines)} → set ${D.walls}`, D.linesTone) : []),
      ...row('Iron', `${D.temp}`),
    );
  }

  function draw() {
    const raw = ctx.raw;
    procSeg.sync([['fdm', 'FDM print'], ['moulded', 'Moulded']], raw.process);
    const mats = res?.draw?.materials || [['pla', 'PLA'], ['petg', 'PETG'], ['abs', 'ABS / ASA'], ['pa', 'Nylon (PA)'], ['pc', 'PC'], ['other', 'Other']].map(([key, name]) => ({ key, name, temp: '' }));
    matSeg.sync(mats.map((m) => [m.key, m.name === 'Other thermoplastic' ? 'Other' : m.name, m.temp.replace(' °C', '°').replace('per the insert supplier', 'see sheet')]), raw.material);
    lineF.style.display = raw.process === 'fdm' ? '' : 'none';
    lineF.sync(raw.line); bossF.sync(raw.boss);
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    drawShelf();
    if (!D) { planSvg.replaceChildren(); sectSvg.replaceChildren(); facts.replaceChildren(); planHead.replaceChildren(h('span', { class: 'hs-cap' }, 'Boss, from above')); return; }
    planHead.replaceChildren(h('span', { class: 'hs-cap' }, `${D.name.replace(/ insert$/i, '')} insert in ${D.material}, boss from above`),
      h('span', { class: 'hs-note' }, dragBoss ? 'release to rescale' : 'drag the boss edge to size it'));
    drawPlan(); drawSect(); drawSectHead(); drawFacts();
  }
  ctx.onResult((r) => { res = r; D = r.draw && !r.draw.partial ? r.draw : null; if (r.draw?.inserts) knownInserts = r.draw.inserts; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [planSvg, sectSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !D) return;
      sizes = now; frozenPlan = null; drawPlan(); drawSect();
    });
  }).observe(layout);
}
