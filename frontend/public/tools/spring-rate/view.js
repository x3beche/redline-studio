// Spring Rate: the page is the spring on a test stand. The coil is drawn to
// scale, wire by wire, between a base and a top plate that you push down to
// the working length (or grab the dashed free-length plate to change L0); the
// wire colours with its stress as it is squeezed. The length ruler on the left
// and the force-length line on the right share the spring's own height axis,
// so the free, working, clash and solid lengths line up across all three. On
// the right: the spring from above (click the diameter you are giving) and a
// loupe on the wire section (drag its rim for the wire size). Across the top:
// the wire grades as spools, with their rate and allowable stress for this
// spring. Every number shown comes from run()'s result (result.spring).

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
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const f4 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(4))));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const q = (v, step) => String(Number((Math.round(v / step) * step).toFixed(4)));
const niceStep = (span, n) => { const r = span / n, p = 10 ** Math.floor(Math.log10(r)), m = r / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

const SHORT = { music: ['Music wire', 'A228'], hd: ['Hard-drawn', 'A227'], ot: ['Oil-tempered', 'A229'], crv: ['Chrome-vanadium', 'A232'],
  crsi: ['Chrome-silicon', 'A401'], ss302: ['Stainless 302', 'A313'], pb: ['Phosphor bronze', 'B159'] };
const WIRE_COL = { music: '#8a97a6', hd: '#6f7b86', ot: '#4f5a64', crv: '#5c6f8a', crsi: '#6a5f86', ss302: '#b3bec9', pb: '#b0793a' };
const ENDS = [['plain', 'Plain'], ['plainground', 'Plain, ground'], ['squared', 'Squared'], ['sqground', 'Squared, ground']];

const CSS = `
:root { --tool-wire: #56697d; --tool-wire-hi: #e0662b; --tool-plate: #7d8b98; --tool-line: var(--accent); --tool-clash: #b7791f; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-wire: #9fb3c6; --tool-wire-hi: #ff8a4c; --tool-plate: #8796a4; --tool-clash: #e8a735; } }
:root[data-theme="dark"] { --tool-wire: #9fb3c6; --tool-wire-hi: #ff8a4c; --tool-plate: #8796a4; --tool-clash: #e8a735; }
.k-page { padding: 10px 12px; }
.sr { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 350px; grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "wires wires" "rig side"; height: calc(100vh - 66px); min-height: 700px; }
.sr-wires { grid-area: wires; display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
.sr-rig { grid-area: rig; } .sr-side { grid-area: side; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.sr-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.sr-box { position: relative; flex: 1; min-height: 0; }
.sr-box > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.sr-head { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px 0; flex-wrap: wrap; }
.sr-cap { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); }
.sr-hint { margin-left: auto; font-size: 11px; color: var(--ink-soft); }
.sr-spools { display: flex; gap: 4px; flex-wrap: wrap; flex: 1 1 560px; }
.sr-spool { display: grid; grid-template-columns: 26px auto; grid-template-rows: auto auto; column-gap: 7px; align-items: center; padding: 4px 9px 4px 6px;
  border: 1px solid var(--line); border-radius: 6px; background: var(--surface); cursor: pointer; text-align: left; color: var(--ink-soft); min-width: 0; }
.sr-spool svg { grid-row: 1 / 3; width: 26px; height: 26px; }
.sr-spool b { font-size: 12px; font-weight: 500; color: var(--ink); white-space: nowrap; }
.sr-spool small { font: 11px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.sr-spool:hover { border-color: var(--ink-soft); }
.sr-spool[aria-checked="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--sunken); }
.sr-spool.out small { color: var(--warn); }
.sr-nums { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.sr-num { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.sr-num input { width: 62px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; text-align: right; }
.sr-seg { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.sr-seg button { border: 0; background: transparent; padding: 3px 8px; font-size: 12px; color: var(--ink-soft); cursor: pointer; display: inline-flex; gap: 5px; align-items: center; white-space: nowrap; }
.sr-seg button + button { border-left: 1px solid var(--line-soft); }
.sr-seg button:hover { background: var(--sunken); color: var(--ink); }
.sr-seg button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); }
.sr-seg svg { width: 18px; height: 20px; }
.sr-seg svg path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.sr-seg svg rect { fill: currentColor; opacity: .6; }
.sr-warns { padding: 0 10px 8px; font-size: 12px; color: var(--danger); display: flex; flex-direction: column; gap: 2px; }
.sr-warns:empty { display: none; }
.sr-out { flex: 1; min-height: 160px; display: flex; }
.sr-out .k-outwrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.sr-out .k-out { flex: 1; max-height: none; min-height: 0; }
.sr-top { flex: 0 0 214px; } .sr-loupe { flex: 0 0 176px; }
/* drawing */
.sr svg text { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.sr svg text.v { fill: var(--ink); font-weight: 600; }
.sr svg text.bad { fill: var(--danger); font-weight: 600; }
.sr svg text.warn { fill: var(--tool-clash); }
.sr svg text.acc { fill: var(--tool-line); font-weight: 600; }
.sr-back { fill: none; stroke: color-mix(in srgb, var(--tool-wire) 45%, var(--surface)); stroke-linecap: round; }
.sr-front { fill: none; stroke-linecap: round; }
.sr-plate { fill: url(#sr-hatch); stroke: var(--ink-soft); stroke-width: 1; }
.sr-hatch-bg { fill: color-mix(in srgb, var(--tool-plate) 25%, var(--surface)); } .sr-hatch-ln { stroke: color-mix(in srgb, var(--tool-plate) 70%, transparent); }
.sr-top-plate { fill: color-mix(in srgb, var(--accent) 22%, var(--surface)); stroke: var(--accent); stroke-width: 1.4; cursor: ns-resize; outline: none; }
.sr-grab:focus-visible .sr-top-plate, .sr-grab:focus-visible .ring { stroke: var(--ink); stroke-width: 2.5; }
.sr-freeplate { fill: none; stroke: var(--ink-soft); stroke-dasharray: 5 4; stroke-width: 1.2; }
.sr-grab { cursor: ns-resize; outline: none; }
.sr-grab.x { cursor: ew-resize; }
.sr-grab .ring { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.sr-grab .halo { fill: var(--accent); opacity: 0; }
.sr-grab:hover .halo, .sr-grab:focus-visible .halo { opacity: .22; }
.sr-rule { stroke: var(--ink-soft); stroke-width: 1; }
.sr-tick { stroke: var(--ink-soft); stroke-width: 1; opacity: .7; }
.sr-guide { stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 4; }
.sr-guide.work { stroke: var(--accent); opacity: .7; }
.sr-solid { fill: var(--danger); opacity: .16; } .sr-clash { fill: var(--tool-clash); opacity: .2; }
.sr-crit { stroke: var(--danger); stroke-width: 1.2; stroke-dasharray: 6 3; }
.sr-axis { stroke: var(--line); stroke-width: 1; } .sr-grid { stroke: var(--line-soft); stroke-width: 1; }
.sr-kline { stroke: var(--tool-line); stroke-width: 2.4; fill: none; }
.sr-set { fill: var(--danger); opacity: .1; } .sr-setl { stroke: var(--danger); stroke-width: 1.4; stroke-dasharray: 5 3; }
.sr-dim { stroke: var(--ink-soft); stroke-width: 1; fill: none; } .sr-dimhead { fill: var(--ink-soft); }
.sr-btn rect { fill: var(--surface); stroke: var(--line); } .sr-btn { cursor: pointer; outline: none; }
.sr-btn:hover rect { stroke: var(--accent); } .sr-btn:focus-visible rect { stroke: var(--ink); stroke-width: 2; }
.sr-btn text { fill: var(--ink) !important; font-weight: 600; }
.sr-ring { fill: color-mix(in srgb, var(--tool-wire) 55%, var(--surface)); stroke: var(--ink-soft); fill-rule: evenodd; }
.sr-mean { fill: none; stroke: var(--ink-soft); stroke-dasharray: 4 3; }
.sr-dia { cursor: pointer; outline: none; }
.sr-dia rect { fill: transparent; stroke: transparent; }
.sr-dia:hover rect, .sr-dia:focus-visible rect { stroke: var(--line); fill: var(--sunken); }
.sr-dia.on rect { stroke: var(--accent); fill: color-mix(in srgb, var(--accent) 14%, transparent); }
.sr-cband { fill: var(--ok); opacity: .22; } .sr-ctrack { fill: var(--sunken); stroke: var(--line); }
.sr-cmark { fill: var(--ink); }
.sr-wirex { stroke: var(--ink-soft); stroke-width: 1.2; }
@media (max-width: 1100px) { .sr { grid-template-columns: minmax(0, 1fr) 300px; } }
@media (max-width: 860px) {
  .sr { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 560px auto; height: auto; min-height: 0; grid-template-areas: "wires" "rig" "side"; }
  .sr-out { min-height: 300px; } .sr-out .k-out { max-height: 360px; }
  .sr-spool { grid-template-columns: 20px auto; padding: 3px 7px 3px 4px; } .sr-spool svg { width: 20px; height: 20px; }
}
@media (max-width: 480px) { .sr { grid-template-rows: auto 440px auto; } .sr-seg button span { display: none; } .sr-seg button { padding: 3px 9px; } .sr-spool { flex: 1 1 46%; } .sr-spool small { display: none; } .sr-num input { width: 48px; } }
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  let S = null, res = null;

  // ---------- top: wire spools and the numbers ----------
  const spools = h('div', { class: 'sr-spools', role: 'radiogroup', 'aria-label': 'Wire material' });
  const numField = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'sr-num', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const seg = (label, items, key) => {
    const g = h('div', { class: 'sr-seg', role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, content, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title,
      onclick: () => ctx.set(key, v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
        e.preventDefault(); const i = items.findIndex((x) => x[0] === v); const n = items[clamp(i + d, 0, items.length - 1)][0];
        ctx.set(key, n); requestAnimationFrame(() => g.querySelector(`[data-v="${n}"]`)?.focus());
      } }, content));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const endIcon = (type) => {
    const s = sv(null, 'svg', { viewBox: '0 0 18 20', 'aria-hidden': 'true' });
    const sq = type === 'squared' || type === 'sqground', gr = type === 'plainground' || type === 'sqground';
    const y0 = gr ? 17 : 18;
    sv(s, 'path', { d: sq ? `M2,${y0} L16,${y0} M2,${y0 - 1} L16,${y0 - 6} M2,${y0 - 6} L16,${y0 - 11} M2,${y0 - 11} L16,${y0 - 16}` : `M2,${y0} L16,${y0 - 5} M2,${y0 - 5} L16,${y0 - 10} M2,${y0 - 10} L16,${y0 - 15}` });
    if (gr) sv(s, 'rect', { x: 1, y: 18, width: 16, height: 2 });
    return s;
  };
  const endsSeg = seg('End type', ENDS.map(([v, t]) => [v, [endIcon(v), h('span', {}, t)], `${t} ends`]), 'ends');
  const dField = numField('d', 'd', 'mm', 'Wire diameter d');
  const diaField = numField('dia', 'Ø', 'mm', 'Coil diameter (outside, mean or inside, as chosen in the top view)');
  const coilField = numField('coils', 'coils', '', 'Coil count');
  const coilSeg = seg('Coil count is', [['total', 'total'], ['active', 'active']], 'coilsAre');
  const l0Field = numField('L0', 'L0', 'mm', 'Free length');
  const l1Field = numField('L1', 'L1', 'mm', 'Working length (empty = none)');
  const gField = numField('Gc', 'G', 'GPa', 'Shear modulus of the custom wire');
  const nums = h('div', { class: 'sr-nums' }, dField, diaField, coilField, coilSeg, l0Field, l1Field, gField);
  const wires = h('div', { class: 'sr-wires' }, spools, h('div', { class: 'sr-nums' }, h('span', { class: 'sr-cap' }, 'Ends'), endsSeg), nums);

  // ---------- rig ----------
  const rigSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'The spring on a test stand, its length ruler and its force against length' });
  const rigWarn = h('div', { class: 'sr-warns', 'aria-live': 'polite' });
  const rig = h('section', { class: 'sr-panel sr-rig' },
    h('div', { class: 'sr-head' }, h('span', { class: 'sr-cap' }, 'Test stand, to scale · length ruler · force against length'),
      h('span', { class: 'sr-hint' }, 'push the top plate · drag the dashed plate for the free length · drag the coil edge for Ø · the dot rides the line')),
    h('div', { class: 'sr-box' }, rigSvg), rigWarn);

  // ---------- side ----------
  const topSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'The spring from above' });
  const topPanel = h('section', { class: 'sr-panel sr-top' }, h('div', { class: 'sr-head' }, h('span', { class: 'sr-cap' }, 'From above'), h('span', { class: 'sr-hint' }, 'click the Ø you are giving')),
    h('div', { class: 'sr-box' }, topSvg));
  const loupeSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Wire section and its shear stress' });
  const loupe = h('section', { class: 'sr-panel sr-loupe' }, h('div', { class: 'sr-head' }, h('span', { class: 'sr-cap' }, 'Wire section, shear stress'), h('span', { class: 'sr-hint' }, 'drag the rim for d')),
    h('div', { class: 'sr-box' }, loupeSvg));
  const side = h('aside', { class: 'sr-side' }, topPanel, loupe, h('div', { class: 'sr-out' }, ctx.outputs));

  const layout = h('div', { class: 'sr' }, wires, rig, side);
  root.append(layout);

  // ---------- spools ----------
  function drawSpools() {
    const list = [...S.wires, { id: 'custom', name: 'Custom', custom: true }];
    spools.replaceChildren(...list.map((w, i) => {
      const s = sv(null, 'svg', { viewBox: '0 0 26 26', 'aria-hidden': 'true' });
      sv(s, 'rect', { x: 3, y: 2, width: 20, height: 22, rx: 2, fill: 'none', stroke: 'var(--ink-soft)' });
      for (let k = 0; k < 6; k++) sv(s, 'line', { x1: 5, x2: 21, y1: 5 + k * 3.3, y2: 6.5 + k * 3.3, stroke: w.custom ? 'var(--ink-soft)' : WIRE_COL[w.id], 'stroke-width': 2.4, 'stroke-linecap': 'round' });
      const on = w.id === S.material;
      const [nm, std] = SHORT[w.id] || ['Custom', 'G given'];
      const sub = w.custom ? (on ? `G ${f3(S.G)} GPa` : 'your G') : `k ${f3(w.k)} · τ≤${Math.round(w.tauAllow)}`;
      return h('button', { type: 'button', role: 'radio', class: `sr-spool${w.inRange === false ? ' out' : ''}`, 'aria-checked': String(on), tabindex: on ? 0 : -1, 'data-v': w.id,
        title: w.custom ? 'Your own wire: give G' : `${w.name}: G ${w.G} GPa, Sut ${Math.round(w.Sut)} MPa at d ${f3(S.d)} mm, allowed at solid ${Math.round(w.allow * 100)} % = ${Math.round(w.tauAllow)} MPa${w.inRange ? '' : ` (made ${w.range[0]}-${w.range[1]} mm)`}`,
        onclick: () => ctx.set('material', w.id),
        onkeydown: (e) => {
          const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
          const n = list[clamp(i + d, 0, list.length - 1)].id; ctx.set('material', n); requestAnimationFrame(() => spools.querySelector(`[data-v="${n}"]`)?.focus());
        } }, s, h('b', {}, `${nm} `, h('span', { style: 'color:var(--ink-soft);font-weight:400' }, std)), h('small', {}, sub));
    }));
  }

  // ---------- rig drawing ----------
  let G = null;           // geometry of the last draw, for dragging
  let drag = null, focusKey = null;
  function helix(Lc) {
    // wire centre height against turn angle, per end type (Shigley table 10-1)
    const { d, Na, Nt, ends } = S;
    let z0, dead, act, p;
    if (ends === 'plain') { z0 = d / 2; dead = 0; act = Na; p = (Lc - d) / Na; }
    else if (ends === 'plainground') { z0 = 0; dead = 0; act = Nt; p = Lc / Nt; }
    else if (ends === 'squared') { z0 = d / 2; dead = 1; act = Na; p = (Lc - 3 * d) / Na; }
    else { z0 = 0; dead = 1; act = Na; p = (Lc - 2 * d) / Na; }
    p = Math.max(p, d);
    const turns = act + 2 * dead;
    const z = (t) => { // t in turns
      if (t <= dead) return z0 + t * d;
      if (t <= dead + act) return z0 + dead * d + (t - dead) * p;
      return z0 + dead * d + act * p + (t - dead - act) * d;
    };
    return { turns, z, p };
  }
  function drawRig() {
    const svg = rigSvg; svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), Hh = Math.max(360, svg.clientHeight || 600);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!S) return;
    const narrow = W < 560;
    const free = S.free, work = S.work;
    const Lc = work ?? free ?? S.solid * 1.8;
    const Lghost = free ?? S.solid * 1.8;
    let Lmax = Math.max(Lghost, Lc) * 1.12 + 2;
    const showCrit = S.crit != null && S.crit < Lmax * 1.35;
    if (showCrit) Lmax = Math.max(Lmax, S.crit * 1.04);
    const mT = 40, mB = 76;
    const rulerW = narrow ? 46 : 84;
    let sc = (Hh - mT - mB) / Lmax;
    const springMaxW = W * (narrow ? 0.24 : 0.34);
    if (S.OD * sc > springMaxW) sc = springMaxW / S.OD;
    // scale and base hold still while a handle is held (warnings under the
    // drawing come and go and would move the base under the pointer)
    const base = drag && G ? G.base : Hh - mB;
    if (drag && G) sc = G.sc;
    const Y = (L) => base - L * sc;
    const cx = rulerW + 26 + (S.OD * sc) / 2 + 24;
    const R = (S.D / 2) * sc, wpx = Math.max(1, S.d * sc);
    const cx0 = cx + (S.OD * sc) / 2 + (narrow ? 44 : 70), cx1 = W - (narrow ? 12 : 26);
    G = { sc, Y, cx, R, cx0, cx1, base };

    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'sr-hatch', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    sv(pt, 'rect', { width: 6, height: 6, class: 'sr-hatch-bg' }); sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'sr-hatch-ln' });
    const mk = sv(defs, 'marker', { id: 'sr-ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'sr-dimhead' });
    const clip = sv(defs, 'clipPath', { id: 'sr-clip' });
    sv(clip, 'rect', { x: 0, y: Y(Lc), width: W, height: Lc * sc });

    // ---- guides across ruler, spring and chart ----
    const guide = (L, cls) => sv(svg, 'line', { x1: rulerW - 6, x2: cx1, y1: Y(L), y2: Y(L), class: `sr-guide ${cls || ''}` });
    // ---- ruler ----
    const rx = rulerW - 6;
    sv(svg, 'rect', { x: rx - 7, y: Y(S.solid), width: 7, height: S.solid * sc, class: 'sr-solid' });
    if (S.clash != null) sv(svg, 'rect', { x: rx - 7, y: Y(S.clash), width: 7, height: (S.clash - S.solid) * sc, class: 'sr-clash' });
    sv(svg, 'line', { x1: rx, x2: rx, y1: Y(0), y2: Y(Lmax), class: 'sr-rule' });
    const st = niceStep(Lmax, narrow ? 5 : 8);
    for (let v = 0; v <= Lmax + 1e-9; v += st / 2) {
      const major = Math.abs(v / st - Math.round(v / st)) < 1e-6;
      sv(svg, 'line', { x1: rx - (major ? 7 : 4), x2: rx, y1: Y(v), y2: Y(v), class: 'sr-tick' });
      if (major) sv(svg, 'text', { x: rx - 10, y: Y(v) + 4, 'text-anchor': 'end' }, f4(v));
    }
    sv(svg, 'text', { x: rx - 10, y: Y(Lmax) - 10, 'text-anchor': 'end' }, 'mm');
    guide(S.solid);
    if (free != null) guide(free);
    if (work != null) guide(work, 'work');
    if (showCrit) {
      sv(svg, 'line', { x1: rx - 8, x2: cx1, y1: Y(S.crit), y2: Y(S.crit), class: 'sr-crit' });
      sv(svg, 'text', { x: cx1, y: Y(S.crit) - 5, 'text-anchor': 'end', class: free >= S.crit ? 'bad' : '' }, `buckles above ${f3(S.crit)} (2.63 D / 0.5)`);
    }

    // ---- base plate and spring ----
    const pw = S.OD * sc + 34;
    sv(svg, 'rect', { x: cx - pw / 2, y: Y(0), width: pw, height: 16, class: 'sr-plate' });
    const hx = helix(Lc);
    const tauNow = work != null ? S.tau1 : 0;
    const hot = S.tauAllow ? clamp(tauNow / S.tauAllow, 0, 1.2) : 0;
    const frontCol = hot > 1 ? 'var(--danger)' : `color-mix(in srgb, var(--tool-wire-hi) ${Math.round(hot * 85)}%, var(--tool-wire))`;
    const g = sv(svg, 'g', { 'clip-path': 'url(#sr-clip)' });
    const seg = 18, n = Math.ceil(hx.turns * seg);
    let back = '', front = '';
    for (let i = 0; i < n; i++) {
      const t0 = (hx.turns * i) / n, t1 = (hx.turns * (i + 1)) / n;
      const a0 = t0 * 2 * Math.PI, a1 = t1 * 2 * Math.PI;
      const x0 = cx + R * Math.sin(a0), x1 = cx + R * Math.sin(a1);
      const y0 = Y(hx.z(t0)), y1 = Y(hx.z(t1));
      const mid = Math.cos((a0 + a1) / 2);
      const s = `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`;
      if (mid < 0) back += s; else front += s;
    }
    sv(g, 'path', { d: back, class: 'sr-back', 'stroke-width': wpx });
    sv(g, 'path', { d: front, class: 'sr-front', stroke: frontCol, 'stroke-width': wpx });
    // ---- the free-length ghost plate ----
    const gy = Y(Lghost);
    const gp = sv(svg, 'g', { class: 'sr-grab', tabindex: 0, role: 'slider', 'data-h': 'L0', 'aria-label': 'Free length L0',
      'aria-valuetext': free != null ? `${f3(free)} mm` : 'not given' });
    sv(gp, 'rect', { x: cx - pw / 2, y: gy - 12, width: pw, height: 12, class: 'sr-freeplate' });
    sv(gp, 'circle', { cx: cx + pw / 2 + 12, cy: gy - 6, r: 12, class: 'halo' });
    sv(gp, 'circle', { cx: cx + pw / 2 + 12, cy: gy - 6, r: 5.5, class: 'ring' });
    // ---- top plate (working length) ----
    const tp = sv(svg, 'g', { class: 'sr-grab', tabindex: 0, role: 'slider', 'data-h': 'L1', 'aria-label': 'Working length L1, push the plate down',
      'aria-valuetext': work != null ? `${f3(work)} mm, ${f3(S.F1)} N` : 'none' });
    sv(tp, 'rect', { x: cx - pw / 2, y: Y(Lc) - 16, width: pw, height: 16, rx: 2, class: 'sr-top-plate' });
    sv(tp, 'rect', { x: cx - 16, y: Y(Lc) - 26, width: 32, height: 10, rx: 2, class: 'sr-top-plate' });
    // ---- labels on the ruler side ----
    const lab = [];
    if (free != null) lab.push({ y: Y(free), t: `L0 ${f3(free)}`, c: 'v', s: 'free' });
    if (work != null) lab.push({ y: Y(work), t: `L1 ${f3(work)}`, c: 'acc', s: 'working' });
    if (S.clash != null) lab.push({ y: Y(S.clash), t: `${f3(S.clash)}`, c: 'warn', s: 'clash' });
    lab.push({ y: Y(S.solid), t: `${f3(S.solid)}`, c: 'bad', s: 'solid' });
    lab.sort((a, b) => a.y - b.y);
    for (let i = 1; i < lab.length; i++) lab[i].ly = Math.max(lab[i].y, (lab[i - 1].ly ?? lab[i - 1].y) + 28);
    if (lab.length) lab[0].ly = lab[0].y;
    const lx = cx - pw / 2 - 8;
    if (!narrow) for (const l of lab) {
      sv(svg, 'text', { x: lx, y: l.ly - 3, 'text-anchor': 'end', class: l.c }, l.t);
      sv(svg, 'text', { x: lx, y: l.ly + 10, 'text-anchor': 'end' }, l.s);
    }
    // ---- OD dimension under the base, and the OD handle ----
    const dy = Y(0) + 30;
    sv(svg, 'line', { x1: cx - (S.OD / 2) * sc, x2: cx + (S.OD / 2) * sc, y1: dy, y2: dy, class: 'sr-dim', 'marker-start': 'url(#sr-ah)', 'marker-end': 'url(#sr-ah)' });
    sv(svg, 'text', { x: cx, y: dy + 15, 'text-anchor': 'middle', class: 'v' }, `OD ${f3(S.OD)}`);
    const oh = sv(svg, 'g', { class: 'sr-grab x', tabindex: 0, role: 'slider', 'data-h': 'dia', 'aria-label': 'Coil outside diameter', 'aria-valuetext': `${f3(S.OD)} mm` });
    const ohy = Y(Math.min(Lc, Lghost) * 0.5);
    sv(oh, 'circle', { cx: cx + R + wpx / 2, cy: ohy, r: 12, class: 'halo' });
    sv(oh, 'circle', { cx: cx + R + wpx / 2, cy: ohy, r: 5.5, class: 'ring' });
    // ---- coil stepper beside the spring ----
    const bxs = 6, bys = Y(0) + 44;
    const btn = (key, x, y, t, label) => {
      const b = sv(svg, 'g', { class: 'sr-btn', tabindex: 0, role: 'button', 'aria-label': label, 'data-b': key });
      sv(b, 'rect', { x, y, width: 20, height: 20, rx: 3 }); sv(b, 'text', { x: x + 10, y: y + 14.5, 'text-anchor': 'middle' }, t);
      return b;
    };
    btn('minus', bxs, bys, '−', 'One coil fewer'); btn('plus', bxs + 96, bys, '+', 'One coil more');
    sv(svg, 'text', { x: bxs + 58, y: bys + 15, 'text-anchor': 'middle', class: 'v' }, `${f3(S.Na)}/${f3(S.Nt)}`);
    if (!narrow) sv(svg, 'text', { x: bxs, y: bys - 6 }, 'active/total coils');

    // ---- force-length chart on the same length axis ----
    if (cx1 - cx0 > 90) {
      const Fmax0 = Math.max(S.Fs ?? S.k * Lghost * 0.6, S.Fallow && S.Fs != null ? Math.min(S.Fallow, S.Fs * 1.6) : 0) * 1.12 || 1;
      const Fst = niceStep(Fmax0, narrow ? 3 : 5), Fmax = Math.ceil(Fmax0 / Fst) * Fst;
      const XF = (F) => cx0 + (cx1 - cx0) * (F / Fmax);
      G.XF = XF; G.Fmax = Fmax;
      sv(svg, 'line', { x1: cx0, x2: cx0, y1: Y(0), y2: Y(Lmax), class: 'sr-axis' });
      sv(svg, 'line', { x1: cx0, x2: cx1, y1: Y(0), y2: Y(0), class: 'sr-axis' });
      for (let F = 0; F <= Fmax + 1e-9; F += Fst) {
        sv(svg, 'line', { x1: XF(F), x2: XF(F), y1: Y(0), y2: Y(Lmax), class: 'sr-grid' });
        sv(svg, 'text', { x: XF(F), y: Y(0) + 16, 'text-anchor': 'middle' }, f3(F));
        if (!narrow || F === 0 || F >= Fmax - 1e-9) sv(svg, 'text', { x: XF(F), y: Y(Lmax) - 6, 'text-anchor': 'middle' }, String(Math.round(F * S.tauPerN)));
      }
      sv(svg, 'text', { x: cx1, y: Y(0) + 32, 'text-anchor': 'end' }, 'force N');
      sv(svg, 'text', { x: cx1, y: Y(Lmax) - 20, 'text-anchor': 'end' }, 'τ MPa');
      if (S.Fallow != null && S.Fallow < Fmax) {
        sv(svg, 'rect', { x: XF(S.Fallow), y: Y(Lmax), width: cx1 - XF(S.Fallow), height: Lmax * sc, class: 'sr-set' });
        sv(svg, 'line', { x1: XF(S.Fallow), x2: XF(S.Fallow), y1: Y(0), y2: Y(Lmax), class: 'sr-setl' });
        if (!narrow) {
          sv(svg, 'text', { x: XF(S.Fallow) + 5, y: Y(Lmax) + 14, class: 'bad' }, `τ ${Math.round(S.tauAllow)} allowed`);
          sv(svg, 'text', { x: XF(S.Fallow) + 5, y: Y(Lmax) + 28 }, 'beyond: takes a set');
        }
      }
      if (free != null && S.Fs != null) {
        sv(svg, 'path', { d: `M${XF(0)},${Y(free)} L${XF(S.Fs)},${Y(S.solid)}`, class: 'sr-kline' });
        sv(svg, 'circle', { cx: XF(S.Fs), cy: Y(S.solid), r: 4, fill: S.tauS > (S.tauAllow ?? Infinity) ? 'var(--danger)' : 'var(--tool-line)' });
        const sBad = S.tauAllow != null && S.tauS > S.tauAllow;
        const sx = XF(S.Fs) > cx1 - 120 ? XF(S.Fs) - 8 : XF(S.Fs) + 8, sa = XF(S.Fs) > cx1 - 120 ? 'end' : 'start';
        if (!narrow) {
          sv(svg, 'text', { x: sx, y: Y(S.solid) - 18, 'text-anchor': sa, class: sBad ? 'bad' : 'v' }, `Fs ${f3(S.Fs)} N`);
          sv(svg, 'text', { x: sx, y: Y(S.solid) - 5, 'text-anchor': sa, class: sBad ? 'bad' : '' }, `τ ${f3(S.tauS)} MPa at solid`);
        }
        // slope label along the line
        const mx = XF(0) + (XF(S.Fs) - XF(0)) * 0.22, my = Y(free) + (Y(S.solid) - Y(free)) * 0.22;
        const ang = (Math.atan2(Y(S.solid) - Y(free), XF(S.Fs) - XF(0)) * 180) / Math.PI;
        if (!narrow) sv(svg, 'text', { x: mx, y: my - 8, 'text-anchor': 'middle', class: 'acc', transform: `rotate(${ang} ${mx} ${my})` }, `k ${f4(S.k)} N/mm`);
        // working point, a handle on the line
        if (work != null) {
          const wx = XF(S.F1), wy = Y(work);
          sv(svg, 'line', { x1: cx0, x2: wx, y1: wy, y2: wy, class: 'sr-guide work' });
          const wp = sv(svg, 'g', { class: 'sr-grab', tabindex: 0, role: 'slider', 'data-h': 'L1dot', 'aria-label': 'Working point on the force line', 'aria-valuetext': `${f3(S.F1)} N at ${f3(work)} mm` });
          sv(wp, 'circle', { cx: wx, cy: wy, r: 13, class: 'halo' });
          sv(wp, 'circle', { cx: wx, cy: wy, r: 6.5, class: 'ring' });
          const right = wx < cx1 - 150 && Math.abs(wy - Y(S.solid)) > 34;
          if (!narrow) {
          sv(svg, 'text', { x: wx + (right ? 14 : -14), y: wy - 4, 'text-anchor': right ? 'start' : 'end', class: 'acc' }, `F1 ${f3(S.F1)} N`);
          sv(svg, 'text', { x: wx + (right ? 14 : -14), y: wy + 11, 'text-anchor': right ? 'start' : 'end' }, `τ ${f3(S.tau1)} MPa`);
          }
        }
      } else {
        sv(svg, 'text', { x: (cx0 + cx1) / 2, y: Y(Lmax / 2), 'text-anchor': 'middle' }, free == null ? 'give a free length: drag the dashed plate' : 'free length not above solid');
      }
    }
    // readout on the top plate
    const readY = Y(Lc) - 32;
    sv(svg, 'text', { x: cx, y: readY - 2, 'text-anchor': 'middle', class: work != null ? 'acc' : '' }, work != null ? `${f3(S.F1)} N` : 'free');
    if (focusKey) { svg.querySelector(`[data-h="${focusKey}"],[data-b="${focusKey}"]`)?.focus(); focusKey = null; }
  }
  const pt = (e) => { const r = rigSvg.getBoundingClientRect(), vb = rigSvg.viewBox.baseVal; return [(e.clientX - r.left) / r.width * vb.width, (e.clientY - r.top) / r.height * vb.height]; };
  const lenAt = (y) => (G.base - y) / G.sc;
  const setL1 = (L) => { const v = q(clamp(L, S.solid, (S.free ?? L + 1) - 0.1), 0.1); if (v !== String(ctx.raw.L1)) ctx.set('L1', v); };
  const setDiaFromOD = (OD) => {
    OD = Math.max(OD, 2.2 * S.d);
    const v = S.diaIs === 'mean' ? OD - S.d : S.diaIs === 'id' ? OD - 2 * S.d : OD;
    const s = q(v, 0.1); if (s !== String(ctx.raw.dia)) ctx.set('dia', s);
  };
  const stepCoils = (dn) => { const c = Number(S.coilsRaw ?? ctx.input.coils) || 0; ctx.set('coils', String(Math.max(1, Math.round((c + dn) * 2) / 2))); };
  rigSvg.addEventListener('pointerdown', (e) => {
    if (!S || !G) return;
    const b = e.target.closest('[data-b]');
    if (b) { focusKey = b.dataset.b; stepCoils(b.dataset.b === 'plus' ? 1 : -1); e.preventDefault(); return; }
    const g = e.target.closest('[data-h]'); if (!g) return;
    const [x, y] = pt(e);
    drag = { key: g.dataset.h, x, y, OD: S.OD, L0: S.free ?? lenAt(y) };
    capture(rigSvg, e); e.preventDefault(); g.focus();
  });
  rigSvg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = pt(e);
    if (drag.key === 'L1' || drag.key === 'L1dot') setL1(lenAt(y));
    else if (drag.key === 'L0') { const v = q(Math.max(S.solid + 0.5, lenAt(y)), 0.5); if (v !== String(ctx.raw.L0)) ctx.set('L0', v); }
    else if (drag.key === 'dia') setDiaFromOD(drag.OD + (2 * (x - drag.x)) / G.sc);
  });
  const end = () => { if (drag) { drag = null; drawRig(); } };
  rigSvg.addEventListener('pointerup', end); rigSvg.addEventListener('pointercancel', end);
  rigSvg.addEventListener('keydown', (e) => {
    if (!S) return;
    const b = e.target.closest?.('[data-b]');
    if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusKey = b.dataset.b; stepCoils(b.dataset.b === 'plus' ? 1 : -1); return; }
    const g = e.target.closest?.('[data-h]'); if (!g) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key]; if (!d) return;
    e.preventDefault(); focusKey = g.dataset.h;
    const k = g.dataset.h;
    if (k === 'L1' || k === 'L1dot') setL1((S.work ?? S.free ?? S.solid) + d * 0.5);
    else if (k === 'L0') ctx.set('L0', q(Math.max(S.solid + 0.5, (S.free ?? S.solid * 1.8) + d * 0.5), 0.5));
    else if (k === 'dia') setDiaFromOD(S.OD + d * 0.1);
  });

  // ---------- top view ----------
  function drawTop() {
    const svg = topSvg; svg.replaceChildren();
    const W = Math.max(240, svg.clientWidth || 340), Hh = Math.max(150, svg.clientHeight || 180);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!S) return;
    const r = Math.min((Hh - 24) / 2, W * 0.26);
    const s = r / (S.OD / 2), cx = r + 16, cy = Hh / 2 + 2;
    sv(svg, 'path', { d: `M${cx - r},${cy} a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0 Z M${cx - (S.ID / 2) * s},${cy} a${(S.ID / 2) * s},${(S.ID / 2) * s} 0 1 1 ${S.ID * s},0 a${(S.ID / 2) * s},${(S.ID / 2) * s} 0 1 1 ${-S.ID * s},0 Z`, class: 'sr-ring' });
    sv(svg, 'circle', { cx, cy, r: (S.D / 2) * s, class: 'sr-mean' });
    sv(svg, 'line', { x1: cx - 4, x2: cx + 4, y1: cy, y2: cy, class: 'sr-wirex' }); sv(svg, 'line', { x1: cx, x2: cx, y1: cy - 4, y2: cy + 4, class: 'sr-wirex' });
    // the three diameters, click to say which one is given
    const lx = cx + r + 18;
    const rows = [['od', 'OD', S.OD, 0], ['mean', 'mean D', S.D, 1], ['id', 'ID', S.ID, 2]];
    for (const [k, t, v, i] of rows) {
      const y = 22 + i * 26;
      const on = S.diaIs === k;
      const g = sv(svg, 'g', { class: `sr-dia${on ? ' on' : ''}`, tabindex: 0, role: 'radio', 'aria-checked': String(on), 'data-d': k, 'aria-label': `${t} ${f3(v)} mm is the diameter given` });
      sv(g, 'rect', { x: lx - 6, y: y - 15, width: Math.min(150, W - lx - 4), height: 22, rx: 4 });
      sv(g, 'text', { x: lx, y, class: on ? 'v' : '' }, `${t} ${f3(v)}`);
      if (on) sv(g, 'text', { x: lx + Math.min(150, W - lx - 4) - 12, y, 'text-anchor': 'end', class: 'acc' }, 'given');
    }
    // spring index gauge
    const gx = lx, gw = Math.min(150, W - lx - 4) - 6, gy = 22 + 3 * 26 + 2;
    const XC = (c) => gx + gw * clamp(c / 16, 0, 1);
    sv(svg, 'rect', { x: gx, y: gy, width: gw, height: 8, rx: 2, class: 'sr-ctrack' });
    sv(svg, 'rect', { x: XC(4), y: gy, width: XC(12) - XC(4), height: 8, class: 'sr-cband' });
    sv(svg, 'path', { d: `M${XC(S.C)},${gy - 1} l-5,-7 h10 z`, class: 'sr-cmark' });
    const cOk = S.C >= 4 && S.C <= 12;
    sv(svg, 'text', { x: gx, y: gy + 22, class: cOk ? '' : 'bad' }, `C = D/d ${f3(S.C)}${cOk ? '' : (S.C < 4 ? ' tight' : ' loose')}`);
    sv(svg, 'text', { x: gx, y: gy + 36 }, '4-12 good');
  }
  // Saying which diameter you give keeps the spring: the number becomes that diameter.
  const giveDia = (k) => { if (!S || k === S.diaIs) return; ctx.setMany({ diaIs: k, dia: String(Number((k === 'od' ? S.OD : k === 'id' ? S.ID : S.D).toPrecision(6))) }); };
  topSvg.addEventListener('click', (e) => { const g = e.target.closest('[data-d]'); if (g) giveDia(g.dataset.d); });
  topSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-d]'); if (!g) return;
    const order = ['od', 'mean', 'id'];
    let n = null;
    if (e.key === 'Enter' || e.key === ' ') n = g.dataset.d;
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (d) n = order[clamp(order.indexOf(g.dataset.d) + d, 0, 2)];
    if (!n) return; e.preventDefault(); giveDia(n);
    requestAnimationFrame(() => topSvg.querySelector(`[data-d="${n}"]`)?.focus());
  });

  // ---------- wire loupe ----------
  let L = null, ldrag = null, lfocus = false;
  function drawLoupe() {
    const svg = loupeSvg; svg.replaceChildren();
    const W = Math.max(240, svg.clientWidth || 340), Hh = Math.max(120, svg.clientHeight || 150);
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!S) return;
    const r = Math.min((Hh - 30) / 2, 56), cx = r + 20, cy = Hh / 2 + 4;
    L = { r, cx, cy };
    const defs = sv(svg, 'defs');
    const gr = sv(defs, 'linearGradient', { id: 'sr-tau', x1: 0, x2: 1, y1: 0, y2: 0 });
    // inner side (towards the spring axis, left) carries the curvature factor KB
    const tau = S.work != null ? S.tau1 : S.tauS;
    const hot = S.tauAllow && tau != null ? clamp(tau / S.tauAllow, 0, 1) : 0.4;
    sv(gr, 'stop', { offset: 0, style: `stop-color:var(--tool-wire-hi);stop-opacity:${0.25 + 0.7 * hot}` });
    sv(gr, 'stop', { offset: 0.5, style: 'stop-color:var(--tool-wire);stop-opacity:.25' });
    sv(gr, 'stop', { offset: 1, style: `stop-color:var(--tool-wire-hi);stop-opacity:${(0.25 + 0.7 * hot) / S.KB * 0.8}` });
    sv(svg, 'circle', { cx, cy, r, fill: 'url(#sr-tau)', stroke: 'var(--ink-soft)', 'stroke-width': 1.2 });
    sv(svg, 'line', { x1: cx - r, x2: cx + r, y1: cy + r + 10, y2: cy + r + 10, class: 'sr-dim', 'marker-start': 'url(#sr-ah2)', 'marker-end': 'url(#sr-ah2)' });
    const mk = sv(defs, 'marker', { id: 'sr-ah2', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'sr-dimhead' });
    sv(svg, 'text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'v' }, `d ${f3(S.d)}`);
    sv(svg, 'text', { x: cx - r - 4, y: cy - r + 2, 'text-anchor': 'start' }, 'axis side');
    const hd = sv(svg, 'g', { class: 'sr-grab x', tabindex: 0, role: 'slider', 'data-l': 'd', 'aria-label': 'Wire diameter d', 'aria-valuetext': `${f3(S.d)} mm` });
    sv(hd, 'circle', { cx: cx + r, cy, r: 12, class: 'halo' }); sv(hd, 'circle', { cx: cx + r, cy, r: 5.5, class: 'ring' });
    // stresses beside it
    const tx = cx + r + 26;
    const rows = [
      ['τ working', S.tau1, S.work != null ? 'acc' : ''],
      ['τ at solid', S.tauS, S.tauAllow != null && S.tauS > S.tauAllow ? 'bad' : 'v'],
      ['allowed', S.tauAllow, ''],
    ];
    rows.forEach(([t, v, c], i) => {
      sv(svg, 'text', { x: tx, y: 26 + i * 18 }, t);
      sv(svg, 'text', { x: W - 10, y: 26 + i * 18, 'text-anchor': 'end', class: c }, v == null ? '–' : `${Math.round(v)} MPa`);
    });
    sv(svg, 'text', { x: tx, y: 26 + 3 * 18 + 4 }, `KB ${f3(S.KB)} · G ${f3(S.G)} GPa`);
    sv(svg, 'text', { x: tx, y: 26 + 4 * 18 + 4 }, S.Sut ? `Sut ${Math.round(S.Sut)} MPa` : 'Sut: give it yourself');
    if (lfocus) { hd.focus(); lfocus = false; }
  }
  loupeSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-l]'); if (!g || !L) return;
    const r = loupeSvg.getBoundingClientRect();
    ldrag = { x: e.clientX, d: S.d, k: (S.d / 2) / (L.r * (r.width / loupeSvg.viewBox.baseVal.width)) };
    capture(loupeSvg, e); e.preventDefault(); g.focus();
  });
  loupeSvg.addEventListener('pointermove', (e) => {
    if (!ldrag) return;
    const v = q(clamp(ldrag.d + (e.clientX - ldrag.x) * ldrag.k * 0.5, 0.05, 20), 0.01);
    if (v !== String(ctx.raw.d)) ctx.set('d', v);
  });
  loupeSvg.addEventListener('pointerup', () => { ldrag = null; }); loupeSvg.addEventListener('pointercancel', () => { ldrag = null; });
  loupeSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-l]'); if (!g || !S) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault(); lfocus = true; ctx.set('d', q(clamp(S.d + d * (S.d < 1 ? 0.01 : 0.05), 0.05, 20), 0.01));
  });

  // ---------- all ----------
  function draw() {
    const raw = ctx.raw;
    endsSeg.sync(raw.ends); coilSeg.sync(raw.coilsAre);
    dField.sync(raw.d); diaField.sync(raw.dia); coilField.sync(raw.coils); l0Field.sync(raw.L0); l1Field.sync(raw.L1); gField.sync(raw.Gc);
    gField.style.display = raw.material === 'custom' ? '' : 'none';
    const warns = res?.warnings || [];
    rigWarn.replaceChildren(...warns.map((w) => h('div', {}, w)));
    if (!S) { rigSvg.replaceChildren(); topSvg.replaceChildren(); loupeSvg.replaceChildren(); spools.replaceChildren(); return; }
    S.coilsRaw = ctx.input.coils;
    drawSpools(); drawRig(); drawTop(); drawLoupe();
  }
  ctx.onResult((r) => { res = r; S = r.spring || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [rigSvg, topSvg, loupeSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !S) return; sizes = now; drawRig(); drawTop(); drawLoupe();
    });
  }).observe(layout);
}
