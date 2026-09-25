// Snap-Fit: the page is the hook going home. A side section, to scale, of
// the lid's cantilever arm meeting the housing's lip: scrub the stroke (drag
// the housing, the trace, or press Run) and the ramp lifts the arm, the strain
// glows along it from the root, the hook drags over the lip and drops in -
// or, pulling out, rides up its retaining face. The arm is shaped by its
// handles: the tip (length), the root (thickness), the hook (undercut), the
// ramp and the retaining face (their angles). Under it, the force a tester
// would record over the stroke; beside it every material's strain limit
// against this hook's root strain, and section A-A of the arm.
// Every number shown comes from run()'s result (result.hook).

const NS = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;

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
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const r1 = (v) => String(Math.round(v * 10) / 10);
const r2 = (v) => String(Math.round(v * 100) / 100);

const CSS = `
:root { --tool-part: #8fa3b8; --tool-housing: #6b7a88; --tool-strain: #e0662b; --tool-push: var(--accent); --tool-pull: #0f9d8a; --tool-band: #2f855a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-part: #5f7489; --tool-housing: #8796a4; --tool-strain: #ff8a4c; --tool-pull: #3cc7b3; --tool-band: #68b36b; } }
:root[data-theme="dark"] { --tool-part: #5f7489; --tool-housing: #8796a4; --tool-strain: #ff8a4c; --tool-pull: #3cc7b3; --tool-band: #68b36b; }
.k-page { padding: 10px 12px; }
.sf { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 330px;
  grid-template-rows: auto minmax(340px, 1fr) 196px; grid-template-areas: "bar bar" "stage side" "trace out";
  height: calc(100vh - 66px); min-height: 680px; }
.sf-bar { grid-area: bar; display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
.sf-stage { grid-area: stage; } .sf-side { grid-area: side; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.sf-trace { grid-area: trace; } .sf-out { grid-area: out; min-height: 0; display: flex; }
.sf-out .k-outwrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.sf-out .k-out { flex: 1; max-height: none; min-height: 0; }
.sf-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.sf-box { position: relative; flex: 1; min-height: 0; }
.sf-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.sf-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.sf-head { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px 0; flex-wrap: wrap; }
.sf-head .sf-hint { margin-left: auto; font-size: 11px; color: var(--ink-soft); }
.sf-grp { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.sf-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.sf-seg button, .sf-btn { border: 0; background: transparent; padding: 4px 10px; font-size: 12.5px; color: var(--ink-soft); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.sf-seg button + button { border-left: 1px solid var(--line-soft); }
.sf-seg button:hover, .sf-btn:hover { color: var(--ink); background: var(--sunken); }
.sf-seg button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); }
.sf-seg svg { width: 30px; height: 14px; }
.sf-seg svg path { fill: currentColor; opacity: .75; }
.sf-btn { border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.sf-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.sf-num { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.sf-num input { width: 56px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sf-num input.bad { border-color: var(--danger); }
.sf-stroke { margin-left: auto; }
.sf-read { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); min-width: 9.5em; }
.sf-warns { padding: 0 10px 8px; font-size: 12px; color: var(--danger); display: flex; flex-direction: column; gap: 2px; }
.sf-warns:empty { display: none; }
/* drawing */
.sf svg text { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.sf svg text.sf-v { fill: var(--ink); font-weight: 600; }
.sf-partf { fill: color-mix(in srgb, var(--tool-part) 55%, var(--surface)); stroke: var(--ink); stroke-width: 1.2; stroke-linejoin: round; }
.sf-housf { fill: url(#sf-hatch); stroke: var(--ink-soft); stroke-width: 1.1; }
.sf-hatch-bg { fill: color-mix(in srgb, var(--tool-housing) 22%, var(--surface)); }
.sf-hatch-ln { stroke: color-mix(in srgb, var(--tool-housing) 70%, transparent); stroke-width: 1; }
.sf-ghost { fill: none; stroke: var(--ink-soft); stroke-dasharray: 3 3; stroke-width: 1; opacity: .7; }
.sf-dim { stroke: var(--ink-soft); stroke-width: 1; fill: none; }
.sf-ext { stroke: var(--ink-soft); stroke-width: .7; opacity: .7; }
.sf-dimhead { fill: var(--ink-soft); }
.sf-band { fill: var(--tool-band); fill-opacity: var(--fill-alpha); stroke: var(--tool-band); stroke-width: 1; stroke-dasharray: 4 2; }
.sf-band.bad { fill: var(--danger); stroke: var(--danger); }
.sf-need { stroke: var(--ink); stroke-width: 2; }
.sf-need.bad { stroke: var(--danger); }
.sf-arc { fill: none; stroke: var(--tool-push); stroke-width: 1.2; }
.sf-arc2 { fill: none; stroke: var(--tool-pull); stroke-width: 1.2; }
.sf-force { fill: var(--tool-push); }
.sf-force.pull { fill: var(--tool-pull); }
.sf-lab-push { fill: var(--tool-push) !important; } .sf-lab-pull { fill: var(--tool-pull) !important; }
.sf-bad-t { fill: var(--danger) !important; font-weight: 600; }
.sf-root-glow { fill: var(--danger); opacity: .25; }
.sf-h { cursor: grab; outline: none; }
.sf-h .ring { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.sf-h .halo { fill: var(--accent); opacity: 0; }
.sf-h:hover .halo, .sf-h:focus-visible .halo { opacity: .22; }
.sf-h:focus-visible .ring { stroke-width: 3; stroke: var(--ink); }
.sf-h.bad .ring { stroke: var(--danger); }
.sf-drag-surf { cursor: ew-resize; }
.sf-cursor { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 3 3; }
.sf-grid { stroke: var(--line-soft); stroke-width: 1; }
.sf-axis { stroke: var(--line); stroke-width: 1; }
.sf-curve-push { fill: none; stroke: var(--tool-push); stroke-width: 2.2; stroke-linejoin: round; }
.sf-curve-pull { fill: none; stroke: var(--tool-pull); stroke-width: 2.2; stroke-linejoin: round; }
.sf-area-push { fill: var(--tool-push); opacity: .12; } .sf-area-pull { fill: var(--tool-pull); opacity: .12; }
.sf-wall { stroke: var(--danger); stroke-width: 3; }
.sf-dot { stroke: var(--surface); stroke-width: 2; }
.sf-lane-on { fill: var(--sunken); }
.sf-trace-box:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* materials */
.sf-mats { display: flex; flex-direction: column; padding: 4px 6px 6px; gap: 1px; overflow: auto; }
.sf-mat { display: grid; grid-template-columns: 94px minmax(0, 1fr) 50px; align-items: center; gap: 8px; border: 0; background: transparent; padding: 3px 5px;
  border-radius: 4px; cursor: pointer; text-align: left; color: var(--ink-soft); font-size: 12px; }
.sf-mat:hover { background: var(--sunken); color: var(--ink); }
.sf-mat[aria-checked="true"] { background: var(--sunken); color: var(--ink); box-shadow: inset 3px 0 0 var(--accent); }
.sf-mat .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sf-mat .pv { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sf-mat svg { width: 100%; height: 16px; display: block; }
.sf-mbar { fill: var(--tool-band); opacity: .55; } .sf-mat.no .sf-mbar { fill: var(--danger); opacity: .35; }
.sf-mline { stroke: var(--tool-strain); stroke-width: 2; }
.sf-custom { display: flex; gap: 10px; padding: 2px 10px 8px; flex-wrap: wrap; }
.sf-legend { font-size: 11px; color: var(--ink-soft); padding: 0 10px 4px; display: flex; gap: 12px; }
.sf-legend i { display: inline-block; width: 12px; height: 8px; margin-right: 4px; vertical-align: 0; }
.sf-sec { flex: 0 0 170px; }
@media (max-width: 1100px) { .sf { grid-template-columns: minmax(0, 1fr) 290px; } .sf-mat { grid-template-columns: 80px minmax(0, 1fr) 46px; } }
@media (max-width: 860px) {
  .sf { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 420px auto 220px auto; height: auto; min-height: 0;
    grid-template-areas: "bar" "stage" "side" "trace" "out"; }
  .sf-stroke { margin-left: 0; }
  .sf-out .k-out { max-height: 320px; }
}
@media (max-width: 480px) { .sf { grid-template-rows: auto 300px auto 230px auto; } .sf-read { min-width: 0; flex-basis: 100%; } .sf-stroke input[type=range] { flex: 1; min-width: 80px; } }
`;

const VKEY = 'redline.tool.snap-fit.view';
const loadView = () => { try { return { dir: 'push', p: null, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { dir: 'push', p: null }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const view = loadView();
  let H = null, res = null;

  // ---------- bar ----------
  const silhouette = (tapered) => {
    const s = sv(null, 'svg', { viewBox: '0 0 30 14', 'aria-hidden': 'true' });
    sv(s, 'path', { d: tapered ? 'M1,1 H3 V3 L24,3 L27,9 L24,9 L23,6 L3,8 V13 H1 Z' : 'M1,1 H3 V4 H24 L27,10 L24,10 L23,8 H3 V13 H1 Z' });
    return s;
  };
  const seg = (label, items, onPick) => {
    const g = h('div', { class: 'sf-seg', role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, content, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title,
      onclick: () => onPick(v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
        e.preventDefault(); const i = items.findIndex((x) => x[0] === v); const n = items[clamp(i + d, 0, items.length - 1)][0];
        onPick(n); requestAnimationFrame(() => g.querySelector(`[data-v="${n}"]`)?.focus());
      } }, content));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const shapeSeg = seg('Arm shape', [
    ['constant', [silhouette(false), 'Constant'], 'Constant thickness (Bayer shape A, factor 0.67)'],
    ['tapered', [silhouette(true), 'Tapered'], 'Tapers to half the thickness at the hook (factor 1.09)'],
  ], (v) => ctx.set('shape', v));
  const numField = (key, label, unit, title, width) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label,
      style: width ? `width:${width}px` : null, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'sf-num', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v, ph) => { if (document.activeElement !== inp) inp.value = v ?? ''; if (ph != null) inp.placeholder = ph; };
    w.input = inp;
    return w;
  };
  const muField = numField('mu', 'µ', '', 'Friction coefficient; empty = the material against steel');
  const bField = numField('b', 'b', 'mm', 'Arm width', 48);
  const repBtn = h('button', { type: 'button', class: 'sf-btn', 'aria-pressed': 'false', title: 'Assembled and taken apart often: 60 % of the strain limit',
    onclick: () => ctx.set('repeated', !ctx.raw.repeated) }, 'Repeated assembly');
  const dirSeg = seg('Stroke direction', [['push', 'Push in', 'Assemble: the lead-in ramp rides over the lip'], ['pull', 'Pull out', 'Take apart: the retaining face rides back over the lip']],
    (v) => { view.dir = v; view.p = v === 'pull' ? 0.5 : null; saveView(view); draw(); });
  const strokeInp = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Stroke position', style: 'width:130px',
    oninput: (e) => { view.p = e.target.value / 1000; saveView(view); drawStage(); drawTrace(); } });
  const runBtn = h('button', { type: 'button', class: 'sf-btn', onclick: () => play() }, 'Run stroke');
  const read = h('span', { class: 'sf-read', 'aria-live': 'polite' });
  const bar = h('div', { class: 'sf-bar' },
    h('div', { class: 'sf-grp' }, h('span', { class: 'sf-cap' }, 'Arm'), shapeSeg),
    h('div', { class: 'sf-grp' }, bField, muField, repBtn),
    h('div', { class: 'sf-grp sf-stroke' }, dirSeg, strokeInp, runBtn, read));

  // ---------- stage ----------
  const stageSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Side section of the snap hook and the housing lip' });
  const stageWarn = h('div', { class: 'sf-warns', 'aria-live': 'polite' });
  const stage = h('section', { class: 'sf-panel sf-stage' },
    h('div', { class: 'sf-head' }, h('span', { class: 'sf-cap' }, 'Side section, to scale'),
      h('span', { class: 'sf-hint' }, 'drag the housing to stroke · drag the round handles to shape the hook · arrows on a focused handle')),
    h('div', { class: 'sf-box' }, stageSvg), stageWarn);

  // ---------- side: materials, section ----------
  const matList = h('div', { class: 'sf-mats', role: 'radiogroup', 'aria-label': 'Material' });
  const esField = numField('es', 'Es', 'GPa', 'Secant modulus of the custom material');
  const epsField = numField('eps', 'ε perm', '%', 'Permissible strain of the custom material');
  const customBox = h('div', { class: 'sf-custom' }, esField, epsField);
  const matHead = h('div', { class: 'sf-head' }, h('span', { class: 'sf-cap' }, 'Material · strain limit'), h('span', { class: 'sf-hint' }, 'P = force to bend'));
  const legend = h('div', { class: 'sf-legend' });
  const mats = h('section', { class: 'sf-panel', style: 'flex:1' }, matHead, legend, matList, customBox);
  const secSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Section A-A through the arm root' });
  const sec = h('section', { class: 'sf-panel sf-sec' }, h('div', { class: 'sf-head' }, h('span', { class: 'sf-cap' }, 'Section A-A at the root'), h('span', { class: 'sf-hint' }, 'drag the edges')),
    h('div', { class: 'sf-box' }, secSvg));
  const side = h('aside', { class: 'sf-side' }, mats, sec);

  // ---------- trace ----------
  const traceSvg = sv(null, 'svg', { role: 'slider', tabindex: 0, class: 'sf-trace-box', 'aria-label': 'Force over the stroke; arrows move the stroke' });
  const trace = h('section', { class: 'sf-panel sf-trace' },
    h('div', { class: 'sf-head' }, h('span', { class: 'sf-cap' }, 'Force over the stroke, as a tester records it'), h('span', { class: 'sf-hint' }, 'click or drag a lane to scrub')),
    h('div', { class: 'sf-box' }, traceSvg));
  const out = h('section', { class: 'sf-out' }, ctx.outputs);

  const layout = h('div', { class: 'sf' }, bar, stage, side, trace, out);
  root.append(layout);

  // ---------- stroke model (from result.hook) ----------
  const Tw = () => Math.max(2, 1.3 * H.h);
  const he = () => (H.shape === 'tapered' ? H.h / 2 : H.h);
  const hb = (x) => (H.shape === 'tapered' ? H.h * (1 - clamp(x, 0, H.l) / (2 * H.l)) : H.h);
  const tIn = () => H.tIn, tOut = () => H.tOut;
  const locksIn = () => H.W == null, locksOut = () => H.R == null;
  const Xl = () => H.l + tIn();
  const seatDx = () => tIn() + H.lip + tOut() + 0.35;
  const range = () => {
    if (view.dir === 'push') return [-1.2, locksIn() ? 0 : tIn() + H.lip + 0.35 + 0.001];
    return [-0.35, locksOut() ? 0 : tOut() + H.lip + 1.2];
  };
  const curU = () => {
    const [a, b] = range();
    if (view.p == null) return view.dir === 'push' ? (locksIn() ? 0 : tIn()) : (locksOut() ? 0 : tOut());
    return a + (b - a) * clamp(view.p, 0, 1);
  };
  const setU = (u) => { const [a, b] = range(); view.p = b > a ? clamp((u - a) / (b - a), 0, 1) : 0; saveView(view); drawStage(); drawTrace(); };
  // state at stroke u: deflection, force, strain - interpolated between run()'s samples
  const at = (u, dir = view.dir) => {
    const pts = dir === 'push' ? H.push : H.pull;
    const travel = dir === 'push' ? tIn() : tOut();
    const locked = dir === 'push' ? locksIn() : locksOut();
    const dx = dir === 'push' ? u : seatDx() - 0.35 - u;
    if (u <= 0 || !pts.length || locked) return { dx, defl: 0, F: locked && u >= 0 ? null : 0, strain: 0, phase: u < 0 ? 'free' : 'locked' };
    if (u <= travel) {
      const n = pts.length - 2, i = clamp(Math.floor((u / travel) * n), 0, n - 1), t = (u / travel) * n - i;
      const A = pts[i], B = pts[i + 1];
      return { dx, defl: A.defl + (B.defl - A.defl) * t, F: A.F + (B.F - A.F) * t, strain: A.strain + (B.strain - A.strain) * t, phase: 'ramp' };
    }
    const last = pts[pts.length - 1];
    if (u <= last.u) return { dx, defl: H.y, F: last.F, strain: H.strain, phase: 'lip' };
    return { dx, defl: 0, F: 0, strain: 0, phase: dir === 'push' ? 'home' : 'out' };
  };

  // ---------- stage drawing ----------
  let sc = 1, ox = 0, oy = 0;
  const X = (x) => ox + x * sc, Y = (y) => oy + y * sc;
  const focusKey = { v: null };
  function drawStage() {
    const svg = stageSvg; svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 700), Hh = Math.max(240, svg.clientHeight || 420);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!H) return;
    const e = he(), tw = Tw(), base = Math.max(e + H.y + 0.6, H.h + 0.8);
    const u = curU(), st = at(u);
    // scene bounds over the whole stroke, both directions
    const lift = Math.max(H.yAllow, H.y) * 1.15 + 1.2;
    const xmin = -tw - 1.4 - 1.2, xmax = Math.max(H.l + tIn() + seatDx() + 0.8, Xl() + H.lip + 3.5);
    const ymin = -lift - 1.6, ymax = base + 2.6;
    const narrow = W < 560;
    const mL = narrow ? 10 : 150, mR = narrow ? 10 : 150, mT = narrow ? 44 : 34, mB = 36;
    // the scale holds still while a handle is dragged, so the pointer keeps its grip
    if (!(drag && drag.key !== 'stroke')) {
      sc = Math.min((W - mL - mR) / (xmax - xmin), (Hh - mT - mB) / (ymax - ymin));
      ox = mL + ((W - mL - mR) - (xmax - xmin) * sc) / 2 - xmin * sc;
      oy = mT + ((Hh - mT - mB) - (ymax - ymin) * sc) / 2 - ymin * sc;
    }

    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'sf-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 7, height: 7, class: 'sf-hatch-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'sf-hatch-ln' });
    const mk = sv(defs, 'marker', { id: 'sf-ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'sf-dimhead' });
    // strain gradient along the arm (at the current deflection)
    const scaleNow = H.y > 0 ? st.defl / H.y : 0;
    const gr = sv(defs, 'linearGradient', { id: 'sf-strain', gradientUnits: 'userSpaceOnUse', x1: X(st.dx), x2: X(st.dx + H.l), y1: 0, y2: 0 });
    for (const a of H.along) {
      const ratio = (a.strain * scaleNow) / H.epsPerm;
      sv(gr, 'stop', { offset: a.x / H.l, style: `stop-color:${ratio > 1 ? 'var(--danger)' : 'var(--tool-strain)'};stop-opacity:${clamp(ratio, 0, 1) * 0.85}` });
    }

    // ---- housing (fixed) ----
    const hx0 = xmin + 0.6, hx1 = xmax - 0.2;
    const hp = [[hx0, base], [Xl(), base], [Xl(), e], [Xl() + H.lip, e], [Xl() + H.lip, base], [hx1, base], [hx1, base + 2.2], [hx0, base + 2.2]];
    const housing = sv(svg, 'path', { d: hp.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z', class: 'sf-housf sf-drag-surf' });
    housing.dataset.drag = 'stroke';
    sv(svg, 'text', { x: X(hx1) - 4, y: Y(base + 2.2) + 14, 'text-anchor': 'end' }, 'housing · drag to stroke');
    sv(svg, 'text', { x: X(Xl() + H.lip / 2), y: Y(base) - 5, 'text-anchor': 'middle' }, 'lip');

    // ---- the part: lid wall + arm + hook, deflected ----
    const dfl = st.defl;
    const bend = (x) => {
      if (x <= 0) return 0;
      if (x <= H.l) { const xi = x / H.l; return dfl * (3 * xi * xi - xi * xi * xi) / 2; }
      return dfl * (1 + 1.5 * (x - H.l) / H.l);
    };
    const P2 = ([x, y]) => [X(x + st.dx), Y(y - bend(x))];
    const path = (pts) => pts.map((p, i) => { const [a, b] = P2(p); return `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`; }).join('') + 'Z';
    const L = H.l, ti = tIn(), to = Math.min(tOut(), 0.9 * L);
    const top = []; for (let i = 0; i <= 24; i++) top.push([((L + ti) * i) / 24, 0]);
    const bottom = []; for (let i = 16; i >= 0; i--) { const x = ((L - to) * i) / 16; bottom.push([x, hb(x)]); }
    const lidTop = -lift - 0.6, lidBot = Math.min(H.h + 1.4, base - 0.3);
    const part = [[-tw, lidTop], [0, lidTop], ...top, [L + ti, e], [L, e + H.y], [L - to, hb(L - to)], ...bottom, [0, lidBot], [-tw, lidBot]];
    const ghost = sv(svg, 'path', { d: path(part), class: 'sf-ghost', transform: null });
    ghost.setAttribute('d', part.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x + st.dx).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z');
    if (dfl < 1e-6) ghost.remove();
    sv(svg, 'path', { d: path(part), class: 'sf-partf' });
    const armOnly = [...top, [L + ti, e], [L, e + H.y], [L - to, hb(L - to)], ...bottom];
    sv(svg, 'path', { d: path(armOnly), fill: 'url(#sf-strain)', stroke: 'none' });
    sv(svg, 'text', { x: X(-tw / 2 + st.dx), y: Y(lidTop) - 6, 'text-anchor': 'middle' }, 'lid');

    // ---- allowable deflection band at the hook ----
    const bandX = X(L + ti + st.dx) + 10;
    const needBad = H.y > H.yAllow;
    sv(svg, 'rect', { x: bandX, y: Y(-H.yAllow), width: 12, height: H.yAllow * sc, class: 'sf-band' });
    if (needBad) sv(svg, 'rect', { x: bandX, y: Y(-H.y), width: 12, height: (H.y - H.yAllow) * sc, class: 'sf-band bad' });
    sv(svg, 'line', { x1: bandX - 3, x2: bandX + 15, y1: Y(-H.y), y2: Y(-H.y), class: `sf-need${needBad ? ' bad' : ''}` });
    sv(svg, 'line', { x1: bandX - 3, x2: bandX + 15, y1: Y(0), y2: Y(0), class: 'sf-ext' });
    if (!narrow) {
      let ya = Y(-H.yAllow) + 4, yn = Y(-H.y) + 4;
      if (Math.abs(ya - yn) < 15) { if (ya < yn) yn = ya + 15; else ya = yn + 15; }
      sv(svg, 'text', { x: bandX + 20, y: ya, class: needBad ? 'sf-bad-t' : '' }, `allowed ${f3(H.yAllow)} mm`);
      sv(svg, 'text', { x: bandX + 20, y: yn, class: needBad ? 'sf-bad-t' : 'sf-v' }, `needs y ${f3(H.y)}`);
      sv(svg, 'text', { x: bandX + 20, y: Math.max(Y(0) + 4, Math.max(ya, yn) + 15) }, 'tip deflection');
    }

    // ---- dimensions ----
    const dimY = narrow ? Y(lidTop) + 14 : Y(lidTop) + 2;
    const dx0 = X(st.dx), dxL = X(L + st.dx);
    sv(svg, 'line', { x1: dx0, x2: dxL, y1: dimY + 12, y2: dimY + 12, class: 'sf-dim', 'marker-start': 'url(#sf-ah)', 'marker-end': 'url(#sf-ah)' });
    sv(svg, 'line', { x1: dxL, x2: dxL, y1: dimY + 6, y2: Y(-bend(L)) - 4, class: 'sf-ext' });
    sv(svg, 'text', { x: (dx0 + dxL) / 2, y: dimY + 8, 'text-anchor': 'middle', class: 'sf-v' }, `l ${f3(L)}`);
    // h at the root
    const hxr = X(Math.min(0.14 * L, 2.5) + st.dx);
    sv(svg, 'line', { x1: hxr, x2: hxr, y1: Y(0), y2: Y(H.h), class: 'sf-dim', 'marker-start': 'url(#sf-ah)', 'marker-end': 'url(#sf-ah)' });
    sv(svg, 'text', { x: hxr + 6, y: Y(H.h) + 15, class: 'sf-v' }, `h ${f3(H.h)}`);
    // y at the hook (on the undeflected hook, right of it)
    const [vx, vy] = P2([L, e + H.y]);
    const [fx, fy] = P2([L + ti, e]);
    // angles: lead-in arc at the ramp foot, retaining arc at the face
    if (ti > 0.05 && ti * sc > 14) {
      const r = Math.min(26, ti * sc * 0.8);
      const a0 = -90, a1 = -90 + (90 - H.alpha);
      const p0 = [vx + r * Math.cos(a0 * DEG), vy + r * Math.sin(a0 * DEG)], p1 = [vx + r * Math.cos(a1 * DEG), vy + r * Math.sin(a1 * DEG)];
      sv(svg, 'line', { x1: vx, x2: vx, y1: vy, y2: vy - r - 6, class: 'sf-ext' });
      sv(svg, 'path', { d: `M${p0[0]},${p0[1]} A${r},${r} 0 0 1 ${p1[0]},${p1[1]}`, class: 'sf-arc' });
    }
    if (!narrow) {
      sv(svg, 'text', { x: fx + 10, y: Math.max(vy, fy + 14) + 4, class: 'sf-lab-push' }, `α ${f3(H.alpha)}°`);
      sv(svg, 'text', { x: X(L - to + st.dx) - 8, y: Y(e - bend(L - to)) + 16, 'text-anchor': 'end', class: 'sf-lab-pull' }, `α' ${f3(H.alpha2)}°`);
    }
    // root strain gauge
    const glowBad = H.strain > H.epsPerm;
    if (glowBad) sv(svg, 'rect', { x: X(st.dx) - 3, y: Y(0) - 3, width: Math.max(10, 0.2 * L * sc), height: H.h * sc + 6, class: 'sf-root-glow' });
    if (narrow) {
      sv(svg, 'text', { x: 8, y: 16, class: st.strain > H.epsPerm ? 'sf-bad-t' : 'sf-v' }, `ε root ${f3(st.strain)} % now`);
      sv(svg, 'text', { x: 8, y: 31, class: glowBad ? 'sf-bad-t' : '' }, `max ${f3(H.strain)} of ${f3(H.epsPerm)} % · σ ${f3(H.stress)} MPa`);
    } else {
      // at the root, to the left of the lid, with a leader into the root corner
      const gx = X(-tw + st.dx) - 14, gy = Y(H.h / 2);
      sv(svg, 'path', { d: `M${X(st.dx) + 3},${Y(H.h * 0.25)} L${X(-tw + st.dx) - 4},${gy - 22} L${gx + 2},${gy - 22}`, class: 'sf-ext', fill: 'none' });
      sv(svg, 'text', { x: gx, y: gy - 26, 'text-anchor': 'end', class: st.strain > H.epsPerm ? 'sf-bad-t' : 'sf-v' }, `ε ${f3(st.strain)} % now`);
      sv(svg, 'text', { x: gx, y: gy - 8, 'text-anchor': 'end', class: glowBad ? 'sf-bad-t' : '' }, `max ${f3(H.strain)} %`);
      sv(svg, 'text', { x: gx, y: gy + 7, 'text-anchor': 'end', class: glowBad ? 'sf-bad-t' : '' }, `of ${f3(H.epsPerm)} % allowed`);
      sv(svg, 'text', { x: gx, y: gy + 22, 'text-anchor': 'end' }, `σ ${f3(H.stress)} MPa`);
      sv(svg, 'text', { x: gx, y: gy + 37, 'text-anchor': 'end' }, `root fillet ≥ ${f3(H.fillet)}`);
    }
    // force at the contact
    if (st.F != null && st.F > 0 && st.phase !== 'free') {
      const push = view.dir === 'push';
      const cx = push ? (st.phase === 'lip' ? vx : X(Xl())) : (st.phase === 'lip' ? vx : X(Xl() + H.lip));
      const cy = Y(e) ;
      const len = 16 + 30 * clamp(st.F / Math.max(H.W || 0, H.R || 0, H.P, 0.001), 0, 1);
      sv(svg, 'path', { d: `M${cx - 4},${cy + len} L${cx + 4},${cy + len} L${cx + 4},${cy + 10} L${cx + 8},${cy + 10} L${cx},${cy + 1} L${cx - 8},${cy + 10} L${cx - 4},${cy + 10} Z`, class: `sf-force${push ? '' : ' pull'}` });
    }
    if (st.phase === 'locked') sv(svg, 'text', { x: X(Xl()) + 6, y: Y(e) - 8, class: 'sf-bad-t' }, view.dir === 'push' ? 'locks: ramp too steep' : 'self-locking');

    // ---- handles ----
    const handles = [];
    const handle = (key, px, py, label, valuetext, bad) => {
      const g = sv(svg, 'g', { class: `sf-h${bad ? ' bad' : ''}`, tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuetext': valuetext, 'data-h': key });
      sv(g, 'circle', { cx: px, cy: py, r: 13, class: 'halo' });
      sv(g, 'circle', { cx: px, cy: py, r: 6, class: 'ring' });
      handles.push(g);
      return g;
    };
    handle('l', ...P2([L, 0]), 'Arm length l', `${f3(L)} mm`);
    handle('h', ...P2([Math.min(0.3 * L, 5), hb(Math.min(0.3 * L, 5))]), 'Root thickness h', `${f3(H.h)} mm`, glowBad);
    handle('y', vx, vy, 'Undercut y', `${f3(H.y)} mm`, needBad);
    handle('alpha', fx, fy, 'Lead-in angle', `${f3(H.alpha)} degrees`, locksIn());
    handle('alpha2', ...P2([L - to, hb(L - to)]), 'Retaining angle', `${f3(H.alpha2)} degrees`);
    sv(svg, 'text', { x: vx + 10, y: vy + 4, class: needBad ? 'sf-bad-t' : 'sf-v' }, `y ${f3(H.y)}`);
    sv(svg, 'text', { x: W - 8, y: Hh - 8, 'text-anchor': 'end' }, `to scale, ${f3(sc)} px/mm`);
    if (focusKey.v) { svg.querySelector(`[data-h="${focusKey.v}"]`)?.focus(); focusKey.v = null; }

    // readout in the bar
    const phaseText = { free: 'approach', ramp: view.dir === 'push' ? 'on the ramp' : 'on the face', lip: 'over the lip', home: 'snapped home', out: 'released', locked: view.dir === 'push' ? 'locks' : 'self-locking' }[st.phase];
    read.textContent = `${f3(Math.max(0, u))} mm · ${st.F == null ? '–' : f3(st.F)} N · ${phaseText}`;
    strokeInp.value = String(Math.round(clamp(view.p ?? ((u - range()[0]) / (range()[1] - range()[0] || 1)), 0, 1) * 1000));
  }

  // handle dragging: value = start value + pointer travel in mm
  let drag = null;
  const mmAt = (e) => { const r = stageSvg.getBoundingClientRect(); const vb = stageSvg.viewBox.baseVal; return [((e.clientX - r.left) / r.width * vb.width - ox) / sc, ((e.clientY - r.top) / r.height * vb.height - oy) / sc]; };
  stageSvg.addEventListener('pointerdown', (e) => {
    if (!H) return;
    const g = e.target.closest('[data-h]'); const surf = e.target.closest('[data-drag]');
    if (!g && !surf) return;
    const [mx, my] = mmAt(e);
    drag = { key: g ? g.dataset.h : 'stroke', mx, my, H: { ...H }, u: curU() };
    capture(stageSvg, e); e.preventDefault(); g?.focus();
  });
  stageSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [mx, my] = mmAt(e), ddx = mx - drag.mx, ddy = my - drag.my, s = drag.H;
    switch (drag.key) {
      case 'stroke': setU(drag.u + (view.dir === 'push' ? -ddx : ddx)); break;
      case 'l': setIn('l', r1(clamp(s.l + ddx, 2, 80))); break;
      case 'h': setIn('h', r2(clamp(s.h + ddy, 0.3, 8))); break;
      case 'y': setIn('y', r2(clamp(s.y + ddy, 0.05, 10))); break;
      case 'alpha': { const t = Math.max(0.02, s.tIn + ddx); setIn('alpha', r1(clamp(Math.atan(s.y / t) / DEG, 5, 80))); break; }
      case 'alpha2': { const t = s.tOut - ddx; setIn('alpha2', t <= 0.02 ? '90' : r1(clamp(Math.atan(s.y / t) / DEG, 5, 90))); break; }
      default:
    }
  });
  const endDrag = () => { const was = drag; drag = null; if (was && was.key !== 'stroke') drawStage(); };
  stageSvg.addEventListener('pointerup', endDrag); stageSvg.addEventListener('pointercancel', endDrag);
  const last = {};
  function setIn(k, v) { if (last[k] === v && String(ctx.raw[k]) === v) return; last[k] = v; if (String(ctx.raw[k]) !== v) ctx.set(k, v); }
  stageSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-h]'); if (!g || !H) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key]; if (!d) return;
    e.preventDefault(); const k = g.dataset.h; focusKey.v = k;
    // arrows follow the drawing: right/up grows l and angles; down grows h and y
    const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (k === 'l') ctx.set('l', r1(clamp(H.l + d * 0.5, 2, 80)));
    if (k === 'h') ctx.set('h', r2(clamp(H.h + (vert ? -d : d) * 0.05, 0.3, 8)));
    if (k === 'y') ctx.set('y', r2(clamp(H.y + (vert ? -d : d) * 0.05, 0.05, 10)));
    if (k === 'alpha') ctx.set('alpha', r1(clamp(H.alpha + d, 5, 80)));
    if (k === 'alpha2') ctx.set('alpha2', r1(clamp(H.alpha2 + d, 5, 90)));
  });

  // ---------- trace ----------
  let tr = null;
  function drawTrace() {
    const svg = traceSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 600), Hh = Math.max(120, svg.clientHeight || 160);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!H) return;
    const L0 = 100, R0 = 16, T0 = 6, B0 = 20, gap = 8;
    const laneH = (Hh - T0 - B0 - gap) / 2;
    const fmax = Math.max(H.W || 0, H.R || 0, H.drag, H.P, 0.1) * 1.18;
    const umax = Math.max(tIn() + H.lip + 0.8, tOut() + H.lip + 1.3, 2);
    const umin = -1.2;
    const Xu = (u) => L0 + (W - L0 - R0) * ((u - umin) / (umax - umin));
    tr = { Xu, umin, umax, L0, R0, W, T0, laneH, gap };
    const lanes = [
      { dir: 'push', y0: T0, name: 'Push in', pts: H.push, travel: tIn(), locked: locksIn(), peak: H.W, cls: 'push' },
      { dir: 'pull', y0: T0 + laneH + gap, name: 'Pull out', pts: H.pull, travel: tOut(), locked: locksOut(), peak: H.R, cls: 'pull' },
    ];
    for (const ln of lanes) {
      const Yf = (F) => ln.y0 + laneH - (laneH - 14) * (F / fmax);
      if (ln.dir === view.dir) sv(svg, 'rect', { x: L0, y: ln.y0, width: W - L0 - R0, height: laneH, class: 'sf-lane-on' });
      sv(svg, 'line', { x1: L0, x2: W - R0, y1: ln.y0 + laneH, y2: ln.y0 + laneH, class: 'sf-axis' });
      sv(svg, 'text', { x: 4, y: ln.y0 + 13, class: `sf-lab-${ln.cls}` }, ln.name);
      if (ln.dir === 'push') sv(svg, 'text', { x: 4, y: ln.y0 + 27 }, `scale ${f3(fmax / 1.18)} N`);
      sv(svg, 'line', { x1: L0, x2: W - R0, y1: Yf(fmax / 1.18), y2: Yf(fmax / 1.18), class: 'sf-grid' });
      if (ln.locked) {
        sv(svg, 'line', { x1: Xu(0), x2: Xu(0), y1: ln.y0 + 4, y2: ln.y0 + laneH, class: 'sf-wall' });
        sv(svg, 'text', { x: Xu(0) + 8, y: ln.y0 + laneH / 2 + 4, class: ln.dir === 'push' ? 'sf-bad-t' : `sf-lab-${ln.cls}` },
          W < 520 ? (ln.dir === 'push' ? 'locks: α too steep' : `self-locking, α' ${f3(H.alpha2)}°`)
            : ln.dir === 'push' ? 'locks: the ramp cannot lift the hook (α too steep for µ)' : `self-locking at α' ${f3(H.alpha2)}°: only breaks by overload`);
        continue;
      }
      const last = ln.pts[ln.pts.length - 1];
      const poly = [[umin, 0], [0, 0], ...ln.pts.slice(0, -1).map((p) => [p.u, p.F]), [ln.travel, last.F], [last.u, last.F], [last.u, 0], [umax, 0]];
      const d = poly.map(([u, F], i) => `${i ? 'L' : 'M'}${Xu(u).toFixed(1)},${Yf(F).toFixed(1)}`).join('');
      sv(svg, 'path', { d: `${d}L${Xu(umax)},${Yf(0)}L${Xu(umin)},${Yf(0)}Z`, class: `sf-area-${ln.cls}` });
      sv(svg, 'path', { d, class: `sf-curve-${ln.cls}` });
      // labels: peak, drag, snap
      const px = Xu(ln.travel), py = Yf(ln.peak);
      sv(svg, 'circle', { cx: px, cy: py, r: 3.5, class: 'sf-dot', fill: `var(--tool-${ln.cls})` });
      sv(svg, 'text', { x: px - 6, y: py + 4, 'text-anchor': 'end', class: 'sf-v' }, `${ln.dir === 'push' ? 'W' : 'R'} ${f3(ln.peak)} N`);
      sv(svg, 'text', { x: (px + Xu(last.u)) / 2, y: Yf(last.F) - 4, 'text-anchor': 'middle' }, `µP ${f3(last.F)}`);
      const endRight = Xu(last.u) + 70 > W - R0;
      sv(svg, 'text', { x: Xu(last.u) + (endRight ? -4 : 4), y: ln.y0 + laneH - 4, 'text-anchor': endRight ? 'end' : 'start' }, ln.dir === 'push' ? 'snaps in' : 'free');
      if (ln.dir === view.dir) sv(svg, 'text', { x: px - 5, y: ln.y0 + laneH - 4, 'text-anchor': 'end' }, `${f3(ln.travel)} mm`);
    }
    for (let u = 0; u <= umax && Xu(u) < W - R0 - 70; u += umax > 8 ? 2 : 1) {
      sv(svg, 'text', { x: Xu(u), y: Hh - 5, 'text-anchor': 'middle' }, String(u));
      sv(svg, 'line', { x1: Xu(u), x2: Xu(u), y1: Hh - B0, y2: Hh - B0 + 3, class: 'sf-axis' });
    }
    sv(svg, 'text', { x: W - R0, y: Hh - 5, 'text-anchor': 'end' }, 'stroke mm');
    // cursor
    const u = curU(), ln = lanes.find((l) => l.dir === view.dir), st = at(u);
    const cx = Xu(clamp(u, umin, umax));
    sv(svg, 'line', { x1: cx, x2: cx, y1: ln.y0, y2: ln.y0 + laneH, class: 'sf-cursor' });
    if (st.F != null) {
      const Yf = (F) => ln.y0 + laneH - (laneH - 14) * (F / fmax);
      sv(svg, 'circle', { cx, cy: Yf(st.F), r: 5, class: 'sf-dot', fill: 'var(--ink)' });
    }
    traceSvg.setAttribute('aria-valuetext', `${view.dir} ${f3(Math.max(0, u))} mm, ${st.F == null ? 'locked' : `${f3(st.F)} N`}`);
  }
  let tdrag = false;
  const traceAt = (e, choose) => {
    if (!tr) return;
    const r = traceSvg.getBoundingClientRect(), vb = traceSvg.viewBox.baseVal;
    const x = (e.clientX - r.left) / r.width * vb.width, y = (e.clientY - r.top) / r.height * vb.height;
    if (choose) { const dir = y > tr.T0 + tr.laneH + tr.gap / 2 ? 'pull' : 'push'; if (dir !== view.dir) { view.dir = dir; dirSeg.sync(dir); } }
    setU(tr.umin + ((x - tr.L0) / (tr.W - tr.L0 - tr.R0)) * (tr.umax - tr.umin));
  };
  traceSvg.addEventListener('pointerdown', (e) => { tdrag = true; capture(traceSvg, e); traceAt(e, true); e.preventDefault(); traceSvg.focus(); });
  traceSvg.addEventListener('pointermove', (e) => { if (tdrag) traceAt(e, false); });
  traceSvg.addEventListener('pointerup', () => { tdrag = false; });
  traceSvg.addEventListener('pointercancel', () => { tdrag = false; });
  traceSvg.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 0.1, ArrowUp: 0.1, ArrowLeft: -0.1, ArrowDown: -0.1, PageUp: 1, PageDown: -1 }[e.key];
    if (!d || !H) return; e.preventDefault(); setU(curU() + d);
  });

  let anim = 0;
  function play() {
    cancelAnimationFrame(anim);
    const t0 = performance.now(), dur = 2600;
    const step = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      view.p = k; drawStage(); drawTrace();
      if (k < 1) anim = requestAnimationFrame(step); else saveView(view);
    };
    anim = requestAnimationFrame(step);
  }

  // ---------- materials ----------
  function drawMats() {
    const maxEps = 8.5;
    const rows = [...H.materials, { id: 'custom', name: 'Custom', eps: H.material === 'custom' ? H.epsPerm : null, P: H.material === 'custom' ? H.P : null, ok: H.material === 'custom' ? H.ok : null }];
    legend.replaceChildren(
      h('span', {}, h('i', { style: 'background:var(--tool-band);opacity:.55' }), `allowed strain${H.repeated ? ' × 0.6' : ''}`),
      h('span', {}, h('i', { style: 'background:var(--tool-strain);height:2px;vertical-align:3px' }), `this hook ${f3(H.strain)} %`));
    matList.replaceChildren(...rows.map((m, i) => {
      const s = sv(null, 'svg', { viewBox: '0 0 100 16', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      if (m.eps != null) sv(s, 'rect', { x: 0, y: 3, width: (clamp(m.eps, 0, maxEps) / maxEps) * 100, height: 10, class: 'sf-mbar', rx: 1 });
      sv(s, 'line', { x1: (clamp(H.strain, 0, maxEps) / maxEps) * 100, x2: (clamp(H.strain, 0, maxEps) / maxEps) * 100, y1: 0, y2: 16, class: 'sf-mline', 'vector-effect': 'non-scaling-stroke' });
      const on = m.id === H.material;
      const b = h('button', { type: 'button', role: 'radio', class: `sf-mat${m.ok === false ? ' no' : ''}`, 'aria-checked': String(on), tabindex: on ? 0 : -1, 'data-v': m.id,
        title: m.eps != null ? `${m.name}: allowed ${f3(m.eps)} %${m.es ? `, Es ${m.es} GPa, µ ${m.mu}` : ''}` : 'Your own modulus and strain limit',
        onclick: () => ctx.set('material', m.id),
        onkeydown: (e) => {
          const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault();
          const n = rows[clamp(i + d, 0, rows.length - 1)].id; ctx.set('material', n); requestAnimationFrame(() => matList.querySelector(`[data-v="${n}"]`)?.focus());
        } },
      h('span', { class: 'nm' }, m.name.replace(', conditioned', ' cond.').replace(' (acetal)', '')), s,
      h('span', { class: 'pv' }, m.P != null ? `${f3(m.P)} N` : '–'));
      return b;
    }));
    customBox.style.display = H.material === 'custom' ? '' : 'none';
  }

  // ---------- section A-A ----------
  let secS = null, sdrag = null;
  function drawSec() {
    const svg = secSvg; svg.replaceChildren();
    const W = Math.max(200, svg.clientWidth || 300), Hh = Math.max(100, svg.clientHeight || 130);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!H) return;
    const s = Math.min((W - 150) / Math.max(H.b, 1), (Hh - 34) / Math.max(H.h, 0.5), 60);
    const x0 = 40, y0 = (Hh - H.h * s) / 2 + 4;
    secS = { s, x0, y0 };
    sv(svg, 'rect', { x: x0, y: y0, width: H.b * s, height: H.h * s, class: 'sf-partf' });
    if (H.shape === 'tapered') sv(svg, 'rect', { x: x0, y: y0 + H.h * s / 2, width: H.b * s, height: H.h * s / 2, class: 'sf-ghost' });
    sv(svg, 'text', { x: x0 + H.b * s / 2, y: y0 - 6, 'text-anchor': 'middle', class: 'sf-v' }, `b ${f3(H.b)}`);
    sv(svg, 'text', { x: x0 - 6, y: y0 + H.h * s / 2 + 4, 'text-anchor': 'end', class: 'sf-v' }, `h ${f3(H.h)}`);
    sv(svg, 'text', { x: x0 + H.b * s + 16, y: y0 + 12 }, `P ${f3(H.P)} N`);
    sv(svg, 'text', { x: x0 + H.b * s + 16, y: y0 + 27 }, `Es ${f3(H.Es)} GPa`);
    if (H.shape === 'tapered') sv(svg, 'text', { x: x0 + H.b * s + 16, y: y0 + 42 }, 'dashed: hook end');
    const hb2 = (key, cx, cy, label, vt) => {
      const g = sv(svg, 'g', { class: 'sf-h', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuetext': vt, 'data-s': key });
      sv(g, 'circle', { cx, cy, r: 11, class: 'halo' }); sv(g, 'circle', { cx, cy, r: 5, class: 'ring' });
    };
    hb2('b', x0 + H.b * s, y0 + H.h * s / 2, 'Arm width b', `${f3(H.b)} mm`);
    hb2('h', x0 + H.b * s / 2, y0, 'Root thickness h', `${f3(H.h)} mm`);
    if (focusSec) { svg.querySelector(`[data-s="${focusSec}"]`)?.focus(); focusSec = null; }
  }
  let focusSec = null;
  secSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-s]'); if (!g || !secS) return;
    sdrag = { k: g.dataset.s, x: e.clientX, y: e.clientY, b: H.b, h: H.h, s: secS.s, r: secSvg.getBoundingClientRect().width / secSvg.viewBox.baseVal.width };
    capture(secSvg, e); e.preventDefault(); g.focus();
  });
  secSvg.addEventListener('pointermove', (e) => {
    if (!sdrag) return;
    const k = sdrag.s * sdrag.r;
    if (sdrag.k === 'b') setIn('b', r1(clamp(sdrag.b + (e.clientX - sdrag.x) / k, 0.5, 60)));
    else setIn('h', r2(clamp(sdrag.h - (e.clientY - sdrag.y) / k, 0.3, 8)));
  });
  secSvg.addEventListener('pointerup', () => { sdrag = null; });
  secSvg.addEventListener('pointercancel', () => { sdrag = null; });
  secSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-s]'); if (!g || !H) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault(); focusSec = g.dataset.s;
    if (focusSec === 'b') ctx.set('b', r1(clamp(H.b + d * 0.5, 0.5, 60))); else ctx.set('h', r2(clamp(H.h + d * 0.05, 0.3, 8)));
  });

  // ---------- all ----------
  function draw() {
    const raw = ctx.raw;
    shapeSeg.sync(raw.shape); dirSeg.sync(view.dir);
    repBtn.setAttribute('aria-pressed', String(!!raw.repeated));
    muField.sync(raw.mu, H ? `${H.muDefault}` : '');
    bField.sync(raw.b); esField.sync(raw.es); epsField.sync(raw.eps);
    const warns = res?.warnings || [];
    stageWarn.replaceChildren(...warns.map((w) => h('div', {}, w)));
    if (!H) { stageSvg.replaceChildren(); traceSvg.replaceChildren(); return; }
    drawStage(); drawTrace(); drawMats(); drawSec();
  }
  ctx.onResult((r) => { res = r; H = r.hook || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [stageSvg, traceSvg, secSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !H) return; sizes = now; drawStage(); drawTrace(); drawSec();
    });
  }).observe(layout);
}
