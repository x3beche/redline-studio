// Annular Ring: the page is the pad itself, seen from above through a loupe.
//   Loupe  - the copper land, the nominal drill (dashed), the circle the drill
//            centre may land in (registration), and the worst-case drill: the
//            oversize drill pushed to the edge of that circle. Where it leaves
//            the copper the rim turns red (breakout); where it cuts into the
//            class 3 minimum ring the copper turns amber.
//            Drag the pad edge, the drill edge, or the worst-case drill itself
//            (its distance from the centre is the registration tolerance).
//   Ruler  - pad diameter, with the sizes that matter marked on it: where the
//            drill breaks out, the class limit, the fab's minimum, the IPC-2221
//            lands. Drag the pad along it or click a mark.
//   Side   - verdict, the three IPC classes (click to choose), and a title
//            block with every dimension as a number to type.
// Every number drawn comes from run()'s result.ring; the page only draws it.

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
const n3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toFixed(3))));
const deg = (v) => String(Number(Number(v).toPrecision(3)));
const mil = (v) => String(Number((v / 0.0254).toPrecision(3)));
const snap = (v, st) => Math.round(v / st) * st;
const str = (v) => String(Number(v.toFixed(4)));
const DEG = Math.PI / 180;

const VKEY = 'redline.tool.annular-ring.view';
const loadView = () => { try { return { theta: -38, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { theta: -38 }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

const CSS = `
.ar { --tool-lam: #dfe5d8; --tool-lam-line: #cdd6c5; --tool-cu: #c98636; --tool-cu-edge: #9c6224; --tool-void: #262d33; --tool-plate: #e9b068;
  display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 12px; align-items: start; }
:root[data-theme="dark"] .ar { --tool-lam: #18211d; --tool-lam-line: #212c27; --tool-cu: #b87a36; --tool-cu-edge: #e0a45e; --tool-void: #05080a; --tool-plate: #e0a458; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ar { --tool-lam: #18211d; --tool-lam-line: #212c27; --tool-cu: #b87a36; --tool-cu-edge: #e0a45e; --tool-void: #05080a; --tool-plate: #e0a458; } }
.ar-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ar-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); min-height: 38px; }
.ar-head h2 { font-size: 12.5px; font-weight: 600; margin: 0; }
.ar-sub { color: var(--ink-soft); font-size: 11.5px; }
.ar-grow { flex: 1; }
.ar-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.ar-seg button { border: 0; background: transparent; padding: 2px 9px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.ar-seg button + button { border-left: 1px solid var(--line); }
.ar-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.ar-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
.ar-draw svg { display: block; width: 100%; }
.ar-ruler { border-top: 1px solid var(--line-soft); }
.ar-foot { padding: 4px 10px 7px; color: var(--ink-soft); font-size: 11px; display: flex; gap: 6px 14px; flex-wrap: wrap; border-top: 1px solid var(--line-soft); }
.ar-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.ar-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ar-verdict { padding: 10px 12px 9px; border-left: 4px solid var(--line); }
.ar-verdict.ok { border-left-color: var(--ok); } .ar-verdict.warn { border-left-color: var(--warn); } .ar-verdict.bad { border-left-color: var(--danger); }
.ar-verdict .big { font: 600 22px/1.15 "IBM Plex Sans", sans-serif; }
.ar-verdict.ok .big { color: var(--ok); } .ar-verdict.warn .big { color: var(--warn); } .ar-verdict.bad .big { color: var(--danger); }
.ar-verdict .why { color: var(--ink-soft); font-size: 12px; margin-top: 3px; }
.ar-classes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--line-soft); }
.ar-cls { border: 0; background: transparent; text-align: left; padding: 7px 10px 8px; cursor: pointer; border-right: 1px solid var(--line-soft); min-width: 0; }
.ar-cls:last-child { border-right: 0; }
.ar-cls .t { font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; gap: 4px; }
.ar-cls .n { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); display: block; margin-top: 2px; }
.ar-cls .r { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.ar-cls .r.ok { color: var(--ok); } .ar-cls .r.bad { color: var(--danger); }
.ar-cls[aria-pressed="true"] { background: var(--sunken); box-shadow: inset 0 3px 0 var(--accent); }
.ar-cls:hover { background: var(--sunken); }
.ar-tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.ar-tb th { text-align: left; font-weight: 500; color: var(--ink-soft); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; padding: 4px 10px; border-bottom: 1px solid var(--line-soft); background: var(--sunken); }
.ar-tb td { padding: 3px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
.ar-tb tr:last-child td { border-bottom: 0; }
.ar-tb td.l { color: var(--ink-soft); white-space: nowrap; }
.ar-tb td.v { font-family: "IBM Plex Mono", ui-monospace, monospace; text-align: right; white-space: nowrap; }
.ar-tb td.u { color: var(--ink-soft); font-size: 11px; width: 1%; white-space: nowrap; }
.ar-tb input { width: 76px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); text-align: right;
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ar-tb input.bad { border-color: var(--danger); }
.ar-tb .ok { color: var(--ok); } .ar-tb .warn { color: var(--warn); } .ar-tb .bad-t { color: var(--danger); }
.ar-tb tr.dim td.l::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; vertical-align: 0; background: var(--sw, transparent); border: 1px solid var(--line); }
.ar-side .k-out { max-height: 170px; }
.ar-warns:empty { display: none; }
.ar-notes summary { cursor: pointer; color: var(--ink-soft); font-size: 11.5px; }
.ar-notes div { color: var(--ink-soft); font-size: 11.5px; margin-top: 3px; }
@media (max-width: 1000px) { .ar { grid-template-columns: minmax(0, 1fr); } }
/* drawing */
.ar svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.ar svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; }
.ar svg .b { font-weight: 600; } .ar svg .sm { font-size: 10px; } .ar svg .soft { fill: var(--ink-soft); }
.ar svg .lam { fill: var(--tool-lam); }
.ar svg .lamgrid { stroke: var(--tool-lam-line); stroke-width: 1; }
.ar svg .cu { fill: var(--tool-cu); stroke: var(--tool-cu-edge); stroke-width: 1.2; }
.ar svg .void { fill: var(--tool-void); }
.ar svg .plate { fill: none; stroke: var(--tool-plate); }
.ar svg .nom { fill: none; stroke: var(--ink); stroke-width: 1.3; stroke-dasharray: 6 4; opacity: .85; }
.ar svg .reg { fill: var(--accent); fill-opacity: .12; stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 3 3; }
.ar svg .min3 { fill: none; stroke: var(--ok); stroke-width: 1.2; stroke-dasharray: 2 3; }
.ar svg .thin { fill: var(--warn); fill-opacity: .55; }
.ar svg .brk { fill: none; stroke: var(--danger); stroke-width: 4; stroke-linecap: round; }
.ar svg .allow { fill: none; stroke: var(--ok); stroke-width: 7; stroke-opacity: .35; }
.ar svg .allow-e { stroke: var(--ok); stroke-width: 1.5; }
.ar svg .dim { stroke: var(--ink); stroke-width: 1; fill: none; }
.ar svg .ext { stroke: var(--ink-soft); stroke-width: .8; stroke-dasharray: 2 2; }
.ar svg .arr { fill: var(--ink); }
.ar svg .lead { stroke: var(--ink-soft); stroke-width: .9; fill: none; }
.ar svg .lbg { fill: var(--surface); fill-opacity: .88; }
.ar svg .tone-ok { fill: var(--ok); } .ar svg .tone-warn { fill: var(--warn); } .ar svg .tone-bad { fill: var(--danger); }
.ar svg .danger { fill: var(--danger); }
.ar svg g.knob { cursor: grab; outline: none; }
.ar svg g.knob .cap { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.ar svg g.knob .ring { fill: none; stroke: none; }
.ar svg g.knob:hover .cap { stroke-width: 3; }
.ar svg g.knob:focus-visible .ring { stroke: var(--accent); stroke-width: 2; }
.ar svg g.knob.ctr .cap { fill: var(--accent); stroke: var(--surface); }
.ar svg .cross { stroke: var(--accent); stroke-width: 1.2; }
.ar svg .scale { stroke: var(--ink); stroke-width: 2; }
/* ruler */
.ar svg .axis { stroke: var(--ink-soft); stroke-width: 1; }
.ar svg .tick { stroke: var(--line); stroke-width: 1; }
.ar svg .z-bad { fill: url(#ar-hatch); } .ar svg .z-bad-e { stroke: var(--danger); stroke-width: 1.5; }
.ar svg .z-warn { fill: var(--warn); fill-opacity: var(--fill-alpha); }
.ar svg .z-ok { fill: var(--ok); fill-opacity: var(--fill-alpha); }
.ar svg .hatch-l { stroke: var(--danger); stroke-opacity: .5; stroke-width: 1; }
.ar svg g.mark { cursor: pointer; outline: none; }
.ar svg g.mark line { stroke: var(--ink-soft); stroke-width: 1.2; }
.ar svg g.mark:hover line, .ar svg g.mark:focus-visible line { stroke: var(--accent); stroke-width: 2; }
.ar svg g.mark:hover text, .ar svg g.mark:focus-visible text { fill: var(--accent); }
.ar svg g.mark.fab line { stroke: var(--tool-plate); }
.ar svg g.ph { cursor: ew-resize; outline: none; }
.ar svg g.ph .stem { stroke: var(--accent); stroke-width: 2; }
.ar svg g.ph .tag { fill: var(--accent); } .ar svg g.ph .tag-t { fill: var(--accent-ink); font-weight: 600; }
.ar svg g.ph .knobc { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.ar svg g.ph .ring { fill: none; stroke: none; }
.ar svg g.ph:focus-visible .ring { stroke: var(--accent); stroke-width: 2; }
`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const view = loadView();
  const state = { drag: null, scale: null };
  const R = () => ctx.result?.ring;

  // ---------- panels ----------
  const segPlated = h('div', { class: 'ar-seg', role: 'group', 'aria-label': 'Hole type' });
  const segLayer = h('div', { class: 'ar-seg', role: 'group', 'aria-label': 'Layer' });
  const draw = h('div', { class: 'ar-draw' });
  const ruler = h('div', { class: 'ar-draw ar-ruler' });
  const loupe = h('section', { class: 'ar-panel ar-loupe', 'aria-label': 'Pad, top view' },
    h('div', { class: 'ar-head' }, h('h2', {}, 'Pad, top view'), h('span', { class: 'ar-sub' }, 'to scale · drag the pad edge, the drill edge or the worst-case drill'),
      h('span', { class: 'ar-grow' }), segPlated, segLayer),
    draw, ruler,
    h('div', { class: 'ar-foot' },
      h('span', {}, 'Focus a handle, then ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' ±0.01 mm (', h('kbd', {}, 'Shift'), ' ±0.05)'),
      h('span', {}, 'worst-case drill: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' registration, ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' turn it'),
      h('span', {}, 'click a mark on the ruler to use that pad')));

  const verdict = h('div', { class: 'ar-verdict' });
  const classes = h('div', { class: 'ar-classes', role: 'group', 'aria-label': 'IPC-6012 class' });
  const verdictPanel = h('section', { class: 'ar-panel', 'aria-live': 'polite' }, verdict, classes);

  const inputs = {};
  const numIn = (key, label) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} in mm`,
      oninput: (e) => ctx.set(key, e.target.value) });
    inputs[key] = inp;
    return inp;
  };
  const segGiven = h('div', { class: 'ar-seg', role: 'group', 'aria-label': 'Hole size is the' });
  const tbBody = h('tbody');
  const tbOut = h('tbody');
  const rowIn = (label, key, sw, extra) => h('tr', { class: 'dim', style: sw ? `--sw:${sw}` : null, 'data-row': key },
    h('td', { class: 'l' }, label), h('td', { class: 'v' }, extra || null, ' ', numIn(key, label)), h('td', { class: 'u' }, 'mm'));
  const rows = {
    pad: rowIn('Pad Ø', 'pad', 'var(--tool-cu)'),
    hole: rowIn('Hole Ø', 'hole', 'var(--tool-void)'),
    allowance: rowIn('Plating allowance', 'allowance', 'var(--tool-plate)'),
    tol: rowIn('Hole tolerance +', 'tol'),
    reg: rowIn('Registration ±', 'reg', 'color-mix(in srgb, var(--accent) 35%, transparent)'),
    fabmin: rowIn("Fab's min ring", 'fabmin'),
  };
  tbBody.append(rows.pad, h('tr', {}, h('td', { class: 'l' }, 'Hole size is the'), h('td', { class: 'v', colspan: 2 }, segGiven)),
    rows.hole, rows.allowance, rows.tol, rows.reg, rows.fabmin);
  const block = h('section', { class: 'ar-panel' },
    h('table', { class: 'ar-tb' },
      h('thead', {}, h('tr', {}, h('th', { colspan: 3 }, 'Dimensions'))), tbBody,
      h('thead', {}, h('tr', {}, h('th', { colspan: 3 }, 'Result'))), tbOut));
  const warns = h('div', { class: 'k-warns ar-warns', 'aria-live': 'polite' });
  const notes = h('details', { class: 'ar-notes' });
  const side = h('aside', { class: 'ar-side' }, verdictPanel, block, warns, ctx.outputs, notes);
  root.append(h('div', { class: 'ar' }, loupe, side));

  const redraw = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };

  // ---------- setting inputs from the drawing ----------
  const setPad = (d) => ctx.set('pad', str(clamp(d, 0.05, 20)));
  const setDrill = (d) => {
    const r = R(); if (!r) return;
    const drill = clamp(d, 0.05, Math.max(0.06, r.pad - 0.01));
    ctx.set('hole', str(r.finished != null ? Math.max(0.01, drill - r.allow) : drill));
  };
  const setReg = (e) => ctx.set('reg', str(clamp(e, 0, 5)));

  // ---------- the loupe ----------
  let geo = null;
  function drawLoupe() {
    const r = R();
    draw.replaceChildren();
    if (!r) return;
    const W = Math.max(300, draw.clientWidth || 700);
    const wide = W >= 560;
    const Hh = wide ? clamp(window.innerHeight - 330, 400, 620) : Math.round(W * 1.12);
    const Dview = Math.max(r.pad, r.padTangent, r.drill + 2 * r.reg + r.tol) * 1.02;
    const fit = Math.min((W - (wide ? 320 : 40)) / Dview, (Hh - (wide ? 120 : 175)) / Dview);
    const s = state.drag && state.scale ? state.scale : fit;
    const cx = Math.round(W / 2), cy = Math.round(wide ? Hh / 2 + 6 : Hh / 2 + 22);
    geo = { cx, cy, s };
    const Rp = (r.pad / 2) * s, rd = (r.drill / 2) * s, rmax = (r.dmax / 2) * s, e = r.reg * s;
    const th = view.theta * DEG;
    const ox = cx + e * Math.cos(th), oy = cy + e * Math.sin(th);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'group', 'aria-label': `Pad ${n3(r.pad)} mm with a ${n3(r.drill)} mm drill` });
    const defs = sv('defs');
    const id = (k) => `ar-${k}`;
    // clip: outside the pad; outside the class-3 ring line
    const cOut = sv('clipPath', { id: id('out') });
    cOut.append(sv('path', { d: `M0,0 H${W} V${Hh} H0 Z M${cx + Rp},${cy} a${Rp},${Rp} 0 1,0 ${-2 * Rp},0 a${Rp},${Rp} 0 1,0 ${2 * Rp},0 Z`, 'clip-rule': 'evenodd' }));
    const r3 = Math.max(0, Rp - r.bmin * s);
    const cThin = sv('clipPath', { id: id('thin') });
    cThin.append(sv('path', { d: `M${cx + Rp},${cy} a${Rp},${Rp} 0 1,0 ${-2 * Rp},0 a${Rp},${Rp} 0 1,0 ${2 * Rp},0 Z M${cx + r3},${cy} a${r3},${r3} 0 1,0 ${-2 * r3},0 a${r3},${r3} 0 1,0 ${2 * r3},0 Z`, 'clip-rule': 'evenodd' }));
    const arrow = sv('marker', { id: id('a'), viewBox: '0 0 8 8', refX: 7.5, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    arrow.append(sv('path', { d: 'M0,0.8 L8,4 L0,7.2 Z', class: 'arr' }));
    defs.append(cOut, cThin, arrow);
    svg.append(defs);
    // laminate and its 0.1 mm grid
    svg.append(sv('rect', { x: 0, y: 0, width: W, height: Hh, class: 'lam' }));
    const gstep = niceGrid(s);
    for (let x = cx % (gstep * s); x < W; x += gstep * s) svg.append(sv('line', { x1: x, y1: 0, x2: x, y2: Hh, class: 'lamgrid' }));
    for (let y = cy % (gstep * s); y < Hh; y += gstep * s) svg.append(sv('line', { x1: 0, y1: y, x2: W, y2: y, class: 'lamgrid' }));
    // copper land
    svg.append(sv('circle', { cx, cy, r: Rp, class: 'cu' }));
    // worst-case drill, with plating if a finished size is given
    svg.append(sv('circle', { cx: ox, cy: oy, r: rmax, class: 'void' }));
    if (r.pth) {
      const plate = r.finished != null ? Math.max(1.5, (r.allow / 2) * s) : 2;
      svg.append(sv('circle', { cx: ox, cy: oy, r: Math.max(0, rmax - plate / 2), class: 'plate', 'stroke-width': plate, opacity: 0.9 }));
    }
    // amber: the part of the worst-case drill that cuts into the class 3 ring margin
    if (!r.noRing) {
      const thin = sv('g', { 'clip-path': `url(#${id('thin')})` });
      thin.append(sv('circle', { cx: ox, cy: oy, r: rmax, class: 'thin' }));
      svg.append(thin);
    }
    // the class-3 minimum ring line
    if (r3 > 0) svg.append(sv('circle', { cx, cy, r: r3, class: 'min3' }));
    // breakout: the drill rim that is outside the copper
    const brk = sv('g', { 'clip-path': `url(#${id('out')})` });
    brk.append(sv('circle', { cx: ox, cy: oy, r: rmax, class: 'brk' }));
    svg.append(brk);
    // allowed breakout (class 1/2 plated), on the rim, centred where the drill pushes out
    if (r.pth && r.cls !== 3 && r.allowBreak > 0 && r.worst < 0 && !r.noRing) {
      const ra = rmax + 7, a0 = th - (r.allowBreak / 2) * DEG, a1 = th + (r.allowBreak / 2) * DEG;
      const p = (a, rr) => [ox + rr * Math.cos(a), oy + rr * Math.sin(a)];
      const [x0, y0] = p(a0, ra), [x1, y1] = p(a1, ra);
      svg.append(sv('path', { d: `M${x0},${y0} A${ra},${ra} 0 ${r.allowBreak > 180 ? 1 : 0},1 ${x1},${y1}`, class: 'allow' }));
      for (const a of [a0, a1]) { const [u0, v0] = p(a, rmax + 2), [u1, v1] = p(a, rmax + 13); svg.append(sv('line', { x1: u0, y1: v0, x2: u1, y2: v1, class: 'allow-e' })); }
    }
    // nominal drill and the circle its centre may land in
    svg.append(sv('circle', { cx, cy, r: rd, class: 'nom' }));
    if (e > 0.5) svg.append(sv('circle', { cx, cy, r: e, class: 'reg' }));
    svg.append(sv('line', { x1: cx - 6, y1: cy, x2: cx + 6, y2: cy, class: 'cross' }), sv('line', { x1: cx, y1: cy - 6, x2: cx, y2: cy + 6, class: 'cross' }));

    const label = (x, y, lines, anchor = 'start', cls = '') => {
      const g = sv('g');
      const w = Math.max(...lines.map((l) => l[0].length)) * 6.6 + 10;
      const bx = anchor === 'end' ? x - w + 5 : anchor === 'middle' ? x - w / 2 : x - 5;
      g.append(sv('rect', { x: bx, y: y - 12, width: w, height: lines.length * 14 + 4, rx: 3, class: 'lbg' }));
      lines.forEach(([t, c], i) => g.append(txt(x, y + i * 14, t, `m ${c || ''} ${cls}`, anchor)));
      svg.append(g);
    };
    const toneCls = (t) => (t === 'ok' ? 'tone-ok' : t === 'warn' ? 'tone-warn' : 'tone-bad');

    // pad diameter dimension, above
    const yd = cy - Rp - (wide ? 30 : 22);
    svg.append(sv('line', { x1: cx - Rp, y1: cy - 4, x2: cx - Rp, y2: yd - 6, class: 'ext' }), sv('line', { x1: cx + Rp, y1: cy - 4, x2: cx + Rp, y2: yd - 6, class: 'ext' }));
    svg.append(sv('line', { x1: cx - Rp + 1, y1: yd, x2: cx + Rp - 1, y2: yd, class: 'dim', 'marker-start': `url(#${id('a')})`, 'marker-end': `url(#${id('a')})` }));
    label(cx, yd - 7, [[`Ø ${n3(r.pad)} pad`, 'b']], 'middle');
    // drill diameter dimension, below
    const yb = cy + Rp + (wide ? 30 : 22);
    svg.append(sv('line', { x1: cx - rd, y1: cy + 4, x2: cx - rd, y2: yb + 6, class: 'ext' }), sv('line', { x1: cx + rd, y1: cy + 4, x2: cx + rd, y2: yb + 6, class: 'ext' }));
    svg.append(sv('line', { x1: cx - rd + 1, y1: yb, x2: cx + rd - 1, y2: yb, class: 'dim', 'marker-start': `url(#${id('a')})`, 'marker-end': `url(#${id('a')})` }));
    label(cx, yb + 17, [[r.finished != null ? `Ø ${n3(r.drill)} drill = ${n3(r.finished)} finished + ${n3(r.allow)}` : `Ø ${n3(r.drill)} drill (nominal)`, 'b']], 'middle');
    // nominal ring on the left axis, between the drill and pad handles
    const xa = cx - Rp, xb = cx - rd;
    if (!r.noRing) {
      svg.append(sv('line', { x1: xa + 1, y1: cy, x2: xb - 1, y2: cy, class: 'dim', 'marker-start': `url(#${id('a')})`, 'marker-end': `url(#${id('a')})` }));
      if (wide) label(xa - 16, cy - 20, [[`${n3(r.nominal)} nominal ring`, 'b'], [`${mil(r.nominal)} mil`, 'soft']], 'end');
      else label(Math.max(8, xa - 4), cy + 22, [[`${n3(r.nominal)} nominal`, 'b']], 'start');
    }
    // worst ring: radial, from the worst-case drill's edge to the pad edge, along theta
    const pw = (rr) => [ox + rr * Math.cos(th), oy + rr * Math.sin(th)];
    const [wx0, wy0] = pw(rmax);
    const [wx1, wy1] = [cx + Rp * Math.cos(th), cy + Rp * Math.sin(th)];
    const out = e + rmax > Rp;
    const far = pw(Math.max(rmax, Rp - e) + 4);
    let lxx, ly, anchorW;
    if (wide) {
      const lx = cx + (Rp + 64) * Math.cos(th);
      ly = cy + (Rp + 64) * Math.sin(th);
      svg.append(sv('path', { d: `M${far[0]},${far[1]} L${lx},${ly} h${Math.cos(th) >= 0 ? 10 : -10}`, class: 'lead' }));
      anchorW = Math.cos(th) >= 0 ? 'start' : 'end';
      lxx = lx + (Math.cos(th) >= 0 ? 14 : -14);
    } else {
      // narrow: the label sits in the top strip, a leader drops to the spot
      lxx = 12; ly = 20; anchorW = 'start';
      svg.append(sv('path', { d: `M${far[0]},${far[1]} L${clamp(far[0], 40, W - 20)},34`, class: 'lead' }));
    }
    if (!out && Math.hypot(wx1 - wx0, wy1 - wy0) > 3) svg.append(sv('line', { x1: wx0, y1: wy0, x2: wx1, y2: wy1, class: 'dim', 'marker-start': `url(#${id('a')})`, 'marker-end': `url(#${id('a')})` }));
    const wl = [[r.noRing ? 'no ring at all' : r.worst >= 0 ? `${n3(r.worst)} worst-case ring` : `${deg(r.angle)}° breakout`, `b ${toneCls(r.tone)}`]];
    if (r.worst < 0 && !r.noRing) wl.push([r.pth && r.cls !== 3 ? `class ${r.cls} allows ${r.allowBreak}°` : 'no breakout allowed', 'soft']);
    else if (!r.noRing) wl.push([`class 3 wants ≥ ${n3(r.bmin)}`, 'soft']);
    if (wide) wl.push([`drill Ø${n3(r.dmax)} (+${n3(r.tol)}), ${n3(r.reg)} off`, 'soft']);
    label(lxx, wide ? ly + 4 - (Math.sin(th) < 0 ? 18 : 0) : ly, wide ? wl : [[wl.map((l) => l[0]).join(' · '), wl[0][1]]], anchorW);
    // registration: a leader to the circle the drill centre stays in
    if (e > 0.5 && wide) {
      const a = th + Math.PI * 0.62;
      const px = cx + e * Math.cos(a), py = cy + e * Math.sin(a);
      const tx = cx - Rp - 40, ty = cy + Rp * 0.62;
      svg.append(sv('path', { d: `M${px},${py} L${tx + 8},${ty - 4} h-8`, class: 'lead' }));
      label(tx - 4, ty, [[`± ${n3(r.reg)} registration`, 'b'], ['drill centre lands in here', 'soft']], 'end');
    }
    if (r3 > 0 && wide) {
      const a = Math.PI * 0.2;
      const px = cx + r3 * Math.cos(a), py = cy + r3 * Math.sin(a);
      const tx = cx + Rp + 40, ty = cy + Rp * 0.78;
      svg.append(sv('path', { d: `M${px},${py} L${tx - 8},${ty - 4} h8`, class: 'lead' }));
      label(tx + 4, ty, [[`class 3 ring line (${n3(r.bmin)}${r.inner ? ', inner' : ''})`, 'b'], ['amber where the drill cuts past it', 'soft']], 'start');
    }
    // handles: pad edge and drill edge on the left axis, worst-case drill centre
    const knob = (x, y, key, aria, valuetext, cls = '') => {
      const g = sv('g', { class: `knob ${cls}`, tabindex: 0, role: 'slider', 'data-fk': key, 'data-drag': key, 'aria-label': aria, 'aria-valuetext': valuetext });
      g.append(sv('circle', { cx: x, cy: y, r: 16, fill: 'transparent' }), sv('circle', { cx: x, cy: y, r: cls ? 6 : 7, class: 'cap' }), sv('circle', { cx: x, cy: y, r: 11, class: 'ring' }));
      svg.append(g);
    };
    knob(cx - Rp, cy, 'pad', 'Pad diameter', `${n3(r.pad)} mm`);
    knob(cx - rd, cy, 'drill', r.finished != null ? 'Finished hole diameter' : 'Drill diameter', `${n3(r.drill)} mm drill`);
    const cg = sv('g', { class: 'knob ctr', tabindex: 0, role: 'slider', 'data-fk': 'reg', 'data-drag': 'reg', 'aria-label': 'Worst-case drill position: registration tolerance',
      'aria-valuetext': `${n3(r.reg)} mm off centre` });
    cg.append(sv('circle', { cx: ox, cy: oy, r: Math.max(16, Math.min(rmax * 0.5, 26)), fill: 'transparent' }),
      sv('line', { x1: ox - 9, y1: oy, x2: ox + 9, y2: oy, class: 'cross' }), sv('line', { x1: ox, y1: oy - 9, x2: ox, y2: oy + 9, class: 'cross' }),
      sv('circle', { cx: ox, cy: oy, r: 5, class: 'cap' }), sv('circle', { cx: ox, cy: oy, r: 10, class: 'ring' }));
    svg.append(cg);
    // scale bar and layer tag
    const sb = niceGrid(s) * (niceGrid(s) * s < 60 ? 2 : 1);
    svg.append(sv('line', { x1: 14, y1: Hh - 16, x2: 14 + sb * s, y2: Hh - 16, class: 'scale' }),
      txt(14, Hh - 24, `${str(sb)} mm`, 'm sm soft'),
      txt(W - 12, Hh - 12, `${r.pth ? 'plated' : 'non-plated'} · ${r.inner && r.pth ? 'inner' : 'outer'} layer · ${Math.round(s)} px/mm · dimensions in mm`, 'm sm soft', 'end'));
    if (r.noRing) label(cx, cy - 4, [['pad is not larger than the drill', 'b tone-bad']], 'middle');
    draw.append(svg);
  }
  const niceGrid = (s) => { const want = 70 / s; const p = 10 ** Math.floor(Math.log10(want)); const m = want / p; return (m < 2 ? 1 : m < 5 ? 2 : 5) * p; };

  // ---------- the pad ruler ----------
  let rg = null;
  function drawRuler() {
    const r = R();
    ruler.replaceChildren();
    if (!r) return;
    const W = Math.max(300, ruler.clientWidth || 700);
    const narrow = W < 560;
    const H = 122, L = 18, Rr = 18;
    const marks = [
      ...r.lands.map((l) => ({ v: l.land, t: `IPC ${l.level.split(' ')[0]}`, sub: n3(l.land), cls: '' })),
      ...(r.padFab ? [{ v: r.padFab, t: 'fab min', sub: n3(r.padFab), cls: 'fab' }] : []),
      { v: r.padNeeded, t: `class ${r.cls}`, sub: n3(r.padNeeded), cls: '' },
    ];
    if (!state.drag || !rg) {
      const top = Math.max(r.pad, ...marks.map((m) => m.v));
      rg = { lo: Math.floor(r.drill * 20) / 20, hi: Math.ceil(top * 1.12 * 20) / 20 };
    }
    const { lo, hi } = rg;
    const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - Rr);
    rg.X = X; rg.W = W; rg.L = L; rg.R = Rr;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Pad diameter ruler' });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'ar-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-l' }));
    defs.append(pat); svg.append(defs);
    const yT = 40, bandTop = 28, bandBot = 52;
    const zone = (a, b, cls, t) => {
      const x0 = X(clamp(a, lo, hi)), x1 = X(clamp(b, lo, hi));
      if (x1 - x0 < 1) return;
      svg.append(sv('rect', { x: x0, y: bandTop, width: x1 - x0, height: bandBot - bandTop, class: cls }));
      if (t && x1 - x0 > t.length * 6 + 8) svg.append(txt((x0 + x1) / 2, bandTop - 5, t, 'sm soft', 'middle'));
    };
    const classLimited = r.pth && r.cls !== 3;
    if (classLimited) {
      zone(lo, r.padBreakLimit, 'z-bad', `breakout > ${r.allowBreak}°`);
      zone(r.padBreakLimit, r.padTangent, 'z-warn', 'breakout allowed');
      zone(r.padTangent, r.padRing3, 'z-warn', 'ring < class 3');
      zone(r.padRing3, hi, 'z-ok', 'full ring at worst case');
    } else {
      zone(lo, r.padNeeded, 'z-bad', r.pth ? `ring < ${n3(r.bmin)} at worst` : `ring < ${n3(r.bmin)}`);
      zone(r.padNeeded, hi, 'z-ok', 'passes at worst case');
    }
    svg.append(sv('line', { x1: L, y1: bandBot, x2: W - Rr, y2: bandBot, class: 'axis' }));
    const step = niceStep(hi - lo, narrow ? 4 : 10);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      svg.append(sv('line', { x1: X(v), y1: bandBot, x2: X(v), y2: bandBot + 4, class: 'axis' }));
    }
    // marks, labelled below, staggered when they crowd
    const sorted = [];
    for (const m of marks.filter((q) => q.v >= lo && q.v <= hi).sort((a, b) => a.v - b.v)) {
      const same = sorted.find((q) => Math.abs(q.v - m.v) < 0.004);
      if (same) { same.t += ` · ${m.t}`; if (m.cls) same.cls = m.cls; } else sorted.push({ ...m });
    }
    let lastX = -1e9, lane = 0;
    for (const m of sorted) {
      const x = X(m.v);
      lane = x - lastX < 70 ? (lane + 1) % 2 : 0;
      lastX = x;
      const ty = bandBot + 18 + lane * 24;
      const g = sv('g', { class: `mark ${m.cls}`, tabindex: 0, role: 'button', 'data-fk': `mk-${m.t}`, 'data-pad': m.v, 'aria-label': `Use a ${n3(m.v)} mm pad (${m.t})` });
      g.append(sv('rect', { x: x - 26, y: bandTop - 2, width: 52, height: ty - bandTop + 14, fill: 'transparent' }),
        sv('line', { x1: x, y1: bandTop, x2: x, y2: ty - 10 }), txt(x, ty, m.t, 'sm', 'middle'), txt(x, ty + 11, m.sub, 'm sm soft', 'middle'),
        sv('title', {}, `Click to use a ${n3(m.v)} mm pad`));
      svg.append(g);
    }
    // the pad handle
    const x = X(clamp(r.pad, lo, hi));
    const tone = r.tone === 'bad' ? 'var(--danger)' : 'var(--accent)';
    const tag = `Ø ${n3(r.pad)}`;
    const tw = tag.length * 7 + 14;
    const tx = clamp(x, L + tw / 2, W - Rr - tw / 2);
    const g = sv('g', { class: 'ph', tabindex: 0, role: 'slider', 'data-fk': 'rpad', 'data-drag': 'rpad', 'aria-label': 'Pad diameter on the ruler',
      'aria-valuenow': r.pad, 'aria-valuemin': lo, 'aria-valuemax': hi, 'aria-valuetext': `${n3(r.pad)} mm pad` });
    g.append(sv('rect', { x: x - 14, y: 2, width: 28, height: bandBot, fill: 'transparent' }),
      sv('line', { x1: x, y1: 20, x2: x, y2: bandBot, class: 'stem', style: `stroke:${tone}` }),
      sv('rect', { x: tx - tw / 2, y: 3, width: tw, height: 17, rx: 3, class: 'tag', style: `fill:${tone}` }), txt(tx, 15.5, tag, 'm sm tag-t', 'middle'),
      sv('circle', { cx: x, cy: yT, r: 6.5, class: 'knobc', style: `fill:${tone}` }), sv('circle', { cx: x, cy: yT, r: 10.5, class: 'ring' }));
    svg.append(g);
    svg.append(txt(W - Rr, H - 5, 'pad Ø, mm', 'sm soft', 'end'));
    ruler.append(svg);
  }
  const niceStep = (span, n) => { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

  // ---------- pointer and keys ----------
  const local = (el, e) => {
    const rect = el.getBoundingClientRect();
    const vb = el.querySelector('svg')?.viewBox.baseVal;
    const k = vb ? vb.width / rect.width : 1;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };
  const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* ended */ } };
  const dragTo = (e) => {
    if (!state.drag || !geo) return;
    if (state.drag === 'rpad') {
      const [x] = local(ruler, e);
      const v = rg.lo + ((x - rg.L) / (rg.W - rg.L - rg.R)) * (rg.hi - rg.lo);
      const nv = snap(clamp(v, rg.lo, rg.hi), 0.01);
      if (Math.abs(nv - R().pad) > 1e-6) setPad(nv);
      return;
    }
    const [x, y] = local(draw, e);
    const dx = x - geo.cx, dy = y - geo.cy, d = Math.hypot(dx, dy) / geo.s;
    const r = R();
    if (state.drag === 'pad') { const nv = snap(2 * d, 0.01); if (Math.abs(nv - r.pad) > 1e-6) setPad(nv); }
    else if (state.drag === 'drill') { const nv = snap(2 * d, 0.01); if (Math.abs(nv - r.drill) > 1e-6) setDrill(nv); }
    else if (state.drag === 'reg') {
      if (d > 0.002) { view.theta = Math.round(Math.atan2(dy, dx) / DEG); saveView(view); }
      const nv = snap(d, 0.005);
      if (Math.abs(nv - r.reg) > 1e-6) setReg(nv); else redraw(drawLoupe);
    }
  };
  draw.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-drag]');
    if (!t) return;
    e.preventDefault();
    capture(draw, e);
    state.drag = t.getAttribute('data-drag');
    state.scale = geo?.s;
    t.focus({ preventScroll: true });
  });
  ruler.addEventListener('pointerdown', (e) => {
    const m = e.target.closest('[data-pad]');
    if (m) { e.preventDefault(); setPad(Math.ceil(Number(m.getAttribute('data-pad')) * 100 - 1e-6) / 100); return; }
    if (!R()) return;
    e.preventDefault();
    capture(ruler, e);
    state.drag = 'rpad';
    ruler.querySelector('[data-fk="rpad"]')?.focus({ preventScroll: true });
    dragTo(e);
  });
  for (const el of [draw, ruler]) {
    el.addEventListener('pointermove', dragTo);
    const end = () => { if (state.drag) { state.drag = null; state.scale = null; redraw(() => { drawLoupe(); drawRuler(); }); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-fk]');
    const r = R();
    if (!t || !r) return;
    const k = t.getAttribute('data-fk');
    if (k.startsWith('mk-') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); setPad(Math.ceil(Number(t.getAttribute('data-pad')) * 100 - 1e-6) / 100); return;
    }
    const st = e.shiftKey ? 0.05 : 0.01;
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    if (k === 'pad' || k === 'rpad') { e.preventDefault(); setPad(snap(r.pad + (k === 'pad' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? -dir : dir) * st, 0.01)); }
    else if (k === 'drill') { e.preventDefault(); setDrill(snap(r.drill + (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? -dir : dir) * st, 0.01)); }
    else if (k === 'reg') {
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { view.theta = ((view.theta + dir * 15 + 540) % 360) - 180; saveView(view); redraw(drawLoupe); }
      else setReg(snap(Math.max(0, r.reg + dir * (e.shiftKey ? 0.025 : 0.005)), 0.005));
    }
  });

  // ---------- side ----------
  const segBtns = (el, key, opts) => el.replaceChildren(...opts.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(String(ctx.raw[key]) === v),
    onclick: () => ctx.set(key, v) }, t)));
  const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
  function renderSide() {
    const res = ctx.result || {}, r = res.ring, raw = ctx.raw;
    segBtns(segPlated, 'plated', [['pth', 'Plated'], ['npth', 'Non-plated']]);
    segBtns(segLayer, 'layer', [['outer', 'Outer'], ['inner', 'Inner']]);
    segBtns(segGiven, 'given', [['drill', 'Drill'], ['finished', 'Finished']]);
    for (const [k, inp] of Object.entries(inputs)) {
      sync(inp, raw[k]);
      inp.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && ctx.parseEng(raw[k]) == null);
    }
    rows.allowance.hidden = !(raw.plated !== 'npth' && raw.given === 'finished');
    segGiven.parentElement.parentElement.hidden = raw.plated === 'npth';
    const v0 = res.values?.[0];
    verdict.className = `ar-verdict ${r?.tone || 'bad'}`;
    verdict.replaceChildren(h('div', { class: 'big' }, v0 ? v0.value : r?.noRing ? 'No ring' : 'Check the inputs'),
      h('div', { class: 'why' }, v0 ? v0.hint : (res.warnings || [])[0] || ''));
    classes.replaceChildren(...[1, 2, 3].map((c) => {
      const row = r?.classes?.find((x) => x.cls === c);
      return h('button', { type: 'button', class: 'ar-cls', 'aria-pressed': String(String(raw.klass) === String(c)), onclick: () => ctx.set('klass', String(c)),
        'aria-label': `IPC class ${c}${row ? `: ${row.need}, ${row.ok ? 'pass' : 'fail'}` : ''}` },
      h('span', { class: 't' }, `Class ${c}`, row ? h('span', { class: `r ${row.ok ? 'ok' : 'bad'}` }, row.ok ? 'pass' : 'fail') : null),
      h('span', { class: 'n' }, row ? row.need : c === 3 ? 'full ring' : 'breakout limit'));
    }));
    const out = (label, value, cls = '', unit = 'mm') => h('tr', {}, h('td', { class: 'l' }, label), h('td', { class: `v ${cls}` }, value), h('td', { class: 'u' }, unit));
    if (r && !r.noRing) {
      const tcls = (t) => (t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : 'bad-t');
      const vals = res.values || [];
      const find = (lbl) => vals.find((v) => v.label.startsWith(lbl));
      tbOut.replaceChildren(
        out('Drill Ø', n3(r.drill)),
        out('Nominal ring', `${n3(r.nominal)} · ${mil(r.nominal)} mil`),
        out('Worst-case ring', n3(r.worst), tcls(find('Worst-case ring')?.tone)),
        out('Worst-case breakout', `${deg(r.angle)}`, tcls(find('Worst-case breakout')?.tone), '°'),
        out(`Pad for class ${r.cls}`, n3(r.padNeeded)),
      );
    } else tbOut.replaceChildren(out('Drill Ø', r ? n3(r.drill) : '–'));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Model and IPC-2221 lands (${(res.notes || []).length + 1} notes)`),
      ...(r ? [h('div', {}, `IPC-2221 design land = max hole + 2 × min ring + allowance: ${r.lands.map((l) => `${l.level} ${n3(l.land)} mm`).join(', ')}.`)] : []),
      ...(res.notes || []).map((n) => h('div', {}, n)));
  }

  const renderAll = () => { renderSide(); redraw(() => { drawLoupe(); drawRuler(); }); };
  ctx.onResult(renderAll);
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => redraw(() => { drawLoupe(); drawRuler(); }));
  }).observe(root);
}
