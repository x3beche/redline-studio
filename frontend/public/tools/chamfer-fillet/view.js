// Chamfer & Fillet Guide: the page is the part. A typical part for the chosen
// process is drawn in section, with every edge and corner the guide talks
// about called out where it is on the part; point at one and the loupe on
// the right shows that edge magnified and to scale on a millimetre grid, the
// recommended size solid and the minimum dashed. The wall thickness is
// scrubbed in the loupe, the pocket depth dragged on the milled part. Every
// number drawn comes from run()'s result (result.draw).

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
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const n3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(3))));

const PROCS = [
  ['mill', 'CNC milling'], ['turn', 'CNC turning'], ['fdm', 'FDM print'], ['sla', 'SLA resin'], ['sls', 'SLS / MJF'],
  ['mold', 'Injection mould'], ['diecast', 'Die casting'], ['sheet', 'Sheet metal'], ['all', 'All'],
];

// ---------------------------------------------------------------------------
// The parts, in drawing units (0..560 × 0..440). Each returns the anchor of
// every feature the guide lists for that process, by the feature's name.
// kind: how the loupe draws the feature; t: whether the wall thickness shows.
const KIND = {
  'mill|Internal vertical corner radius': ['in', false, 'plan view of the pocket corner'],
  'mill|Pocket floor fillet': ['in', false, 'section at the pocket floor'],
  'mill|Outside edge break (chamfer)': ['cham', false],
  'mill|Outside edge fillet': ['out', false],
  'mill|Hole entry chamfer': ['cham', false],
  'turn|Outside edge chamfer': ['cham', false],
  'turn|Shoulder (internal) radius': ['in', false],
  'turn|Thread start chamfer': ['text', false],
  'turn|Mating bore entry chamfer': ['cham', false],
  'fdm|Bottom edge (on the bed)': ['cham', true, 'on the build plate'],
  'fdm|Downward-facing edge': ['text', false],
  'fdm|Vertical (Z) edge fillet': ['out', true, 'plan view'],
  'fdm|Inside corner fillet': ['in', true],
  'fdm|Top edge fillet': ['out', true],
  'sla|Inside corner fillet': ['in', true],
  'sla|Outside edge fillet / chamfer': ['out', true],
  'sla|Wall-to-floor fillet (hollow parts)': ['in', true],
  'sls|Inside corner fillet': ['in', true],
  'sls|Outside edge fillet': ['out', true],
  'sls|Hole entry chamfer': ['cham', true],
  'mold|Inside corner radius': ['in', true],
  'mold|Outside corner radius': ['out', true],
  'mold|Rib base fillet': ['rib', true],
  'mold|Boss base fillet': ['rib', true],
  'mold|Edges on the parting line': ['sharp', false],
  'diecast|Inside fillet': ['in', true],
  'diecast|Outside corner radius': ['out', true],
  'diecast|Rib / boss root fillet': ['rib', true],
  'diecast|Edges to be machined later': ['cham', false],
  'sheet|Inside bend radius': ['bend', true],
  'sheet|Outside corner radius (flat)': ['out', true, 'flat blank corner'],
  'sheet|Bend relief (width / depth)': ['relief', true],
  'sheet|Edge break / deburr': ['cham', false],
};

function hatch(defs) {
  const pt = sv(defs, 'pattern', { id: 'cf-hatch', patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(45)' });
  sv(pt, 'rect', { width: 8, height: 8, class: 'cf-hs-bg' });
  sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'cf-hs-ln' });
}

const PARTS = {
  mill(g, o) {
    const dp = clamp(24 + 170 * Math.min(o.depth, 60) / 60, 30, 196), fy = 110 + dp;
    sv(g, 'text', { x: 12, y: 96, class: 'cf-cap' }, 'SECTION');
    sv(g, 'path', { class: 'cf-cut', d: `M10,117 L17,110 L80,110 L80,${fy - 7} Q80,${fy} 87,${fy} L233,${fy} Q240,${fy} 240,${fy - 7} L240,110 L270,110 L275,115 L275,330 L10,330 Z` });
    sv(g, 'path', { class: 'cf-cut', d: 'M297,115 L302,110 L323,110 L330,117 L330,330 L297,330 Z' });
    sv(g, 'text', { x: 372, y: 116, class: 'cf-cap' }, 'PLAN');
    sv(g, 'rect', { x: 370, y: 128, width: 180, height: 202, rx: 12, class: 'cf-solid' });
    sv(g, 'rect', { x: 392, y: 156, width: 110, height: 146, rx: 16, class: 'cf-void' });
    sv(g, 'circle', { cx: 527, cy: 229, r: 11, class: 'cf-void' });
    sv(g, 'circle', { cx: 527, cy: 229, r: 15, class: 'cf-thin' });
    return {
      anchors: {
        'Internal vertical corner radius': [397, 161], 'Pocket floor fillet': [82, fy - 2], 'Outside edge break (chamfer)': [13, 113],
        'Outside edge fillet': [374, 132], 'Hole entry chamfer': [299, 112],
      },
      depth: { x: 160, y0: 110, y1: fy },
    };
  },
  turn(g) {
    sv(g, 'text', { x: 30, y: 150, class: 'cf-cap' }, 'HALF-SECTION ABOVE THE AXIS');
    sv(g, 'path', { class: 'cf-cut', d: 'M30,202 L42,190 L260,190 L260,222 Q260,232 270,232 L508,232 L520,244 L520,320 L120,320 L120,272 L44,272 L30,258 Z' });
    for (let x = 408; x < 508; x += 8) sv(g, 'path', { class: 'cf-thin', d: `M${x},232 L${x + 4},240 L${x + 8},232` });
    sv(g, 'line', { x1: 10, y1: 320, x2: 550, y2: 320, class: 'cf-axis' });
    sv(g, 'text', { x: 430, y: 225, class: 'cf-cap' }, 'THREAD');
    sv(g, 'text', { x: 50, y: 300, class: 'cf-cap' }, 'BORE');
    return { anchors: { 'Outside edge chamfer': [35, 195], 'Shoulder (internal) radius': [262, 229], 'Thread start chamfer': [514, 238], 'Mating bore entry chamfer': [36, 266] } };
  },
  fdm(g) {
    sv(g, 'text', { x: 20, y: 70, class: 'cf-cap' }, 'SIDE VIEW');
    sv(g, 'rect', { x: 10, y: 340, width: 360, height: 14, class: 'cf-bed' });
    sv(g, 'text', { x: 20, y: 372, class: 'cf-cap' }, 'BUILD PLATE');
    sv(g, 'path', { class: 'cf-solid', d: 'M40,332 L40,100 Q40,90 50,90 L240,90 L240,112 L232,120 L120,120 L120,238 Q120,250 132,250 L330,250 L330,332 L322,340 L48,340 Z' });
    sv(g, 'text', { x: 402, y: 110, class: 'cf-cap' }, 'PLAN');
    sv(g, 'rect', { x: 400, y: 120, width: 140, height: 110, rx: 16, class: 'cf-solid' });
    return { anchors: { 'Bottom edge (on the bed)': [326, 336], 'Downward-facing edge': [236, 116], 'Vertical (Z) edge fillet': [405, 125], 'Inside corner fillet': [123, 247], 'Top edge fillet': [43, 93] } };
  },
  sla(g, o) {
    sv(g, 'text', { x: 40, y: 96, class: 'cf-cap' }, 'SECTION, HOLLOW PART');
    sv(g, 'path', { class: 'cf-cut', d: 'M40,110 L66,110 L66,286 Q66,304 84,304 L464,304 Q482,304 482,286 L482,110 L508,110 L508,318 Q508,330 496,330 L52,330 Q40,330 40,318 Z' });
    sv(g, 'path', { class: 'cf-cut', d: 'M280,180 L300,180 L300,296 Q300,304 308,304 L272,304 Q280,304 280,296 Z' });
    return { anchors: { 'Inside corner fillet': [283, 301], 'Outside edge fillet / chamfer': [44, 326], 'Wall-to-floor fillet (hollow parts)': [70, 300] }, tDim: [40, 66, 100] };
    void o;
  },
  sls(g) {
    sv(g, 'text', { x: 40, y: 126, class: 'cf-cap' }, 'SECTION');
    sv(g, 'path', { class: 'cf-cut', d: 'M40,150 Q40,140 50,140 L250,140 L250,228 Q250,240 262,240 L470,240 Q480,240 480,250 L480,320 Q480,330 470,330 L402,330 L402,258 L407,252 L407,240 L371,240 L377,246 L377,330 L50,330 Q40,330 40,320 Z' });
    return { anchors: { 'Inside corner fillet': [253, 237], 'Outside edge fillet': [43, 143], 'Hole entry chamfer': [374, 243] } };
  },
  mold(g) {
    sv(g, 'text', { x: 60, y: 104, class: 'cf-cap' }, 'SECTION THROUGH THE WALL');
    sv(g, 'path', { class: 'cf-cut', d: 'M60,330 L60,153 A33 33 0 0 1 93,120 L467,120 A33 33 0 0 1 500,153 L500,330 L478,330 L478,153 A11 11 0 0 0 467,142 L431,142 A11 11 0 0 0 420,153 L420,262 L380,262 L380,153 A11 11 0 0 0 369,142 L281,142 A11 11 0 0 0 270,153 L270,244 L254,244 L254,153 A11 11 0 0 0 243,142 L93,142 A11 11 0 0 0 82,153 L82,330 Z' });
    sv(g, 'rect', { x: 393, y: 184, width: 14, height: 78, class: 'cf-void' });
    sv(g, 'line', { x1: 20, y1: 330, x2: 540, y2: 330, class: 'cf-pl' });
    sv(g, 'text', { x: 510, y: 346, class: 'cf-cap' }, 'PL');
    sv(g, 'text', { x: 232, y: 270, class: 'cf-cap' }, 'RIB');
    sv(g, 'text', { x: 382, y: 288, class: 'cf-cap' }, 'BOSS');
    return { anchors: { 'Inside corner radius': [85, 146], 'Outside corner radius': [69, 129], 'Rib base fillet': [251, 146], 'Boss base fillet': [376, 146], 'Edges on the parting line': [60, 330] }, tDim: [60, 82, 300] };
  },
  diecast(g) {
    sv(g, 'text', { x: 60, y: 104, class: 'cf-cap' }, 'SECTION THROUGH THE CASTING');
    sv(g, 'path', { class: 'cf-cut', d: 'M60,330 L60,164 A44 44 0 0 1 104,120 L456,120 A44 44 0 0 1 500,164 L500,330 L478,330 L478,164 A22 22 0 0 0 456,142 L292,142 A12 12 0 0 0 280,154 L280,250 L262,250 L262,154 A12 12 0 0 0 250,142 L104,142 A22 22 0 0 0 82,164 L82,330 Z' });
    for (const x of [60, 478]) sv(g, 'line', { x1: x, y1: 333, x2: x + 22, y2: 333, stroke: 'var(--ink)', 'stroke-width': 3 });
    sv(g, 'path', { class: 'cf-thin', d: 'M40,348 L48,336 L56,348 Z' });
    sv(g, 'text', { x: 62, y: 360, class: 'cf-cap' }, 'MACHINED FACE');
    return { anchors: { 'Inside fillet': [88, 148], 'Outside corner radius': [73, 133], 'Rib / boss root fillet': [259, 146], 'Edges to be machined later': [60, 332] }, tDim: [60, 82, 290] };
  },
  sheet(g) {
    sv(g, 'text', { x: 40, y: 96, class: 'cf-cap' }, 'SECTION, BENT');
    sv(g, 'path', { class: 'cf-cut', d: 'M40,300 L276,300 A24 24 0 0 0 300,276 L300,110 L312,110 L312,276 A36 36 0 0 1 276,312 L40,312 Z' });
    sv(g, 'text', { x: 372, y: 96, class: 'cf-cap' }, 'FLAT BLANK');
    sv(g, 'path', { class: 'cf-solid', d: 'M380,122 Q380,110 392,110 L528,110 Q540,110 540,122 L540,196 L532,196 L532,208 L540,208 L540,318 Q540,330 528,330 L392,330 Q380,330 380,318 L380,208 L388,208 L388,196 L380,196 Z' });
    sv(g, 'line', { x1: 388, y1: 202, x2: 532, y2: 202, class: 'cf-thin', 'stroke-dasharray': '8 4' });
    sv(g, 'text', { x: 420, y: 196, class: 'cf-cap' }, 'BEND LINE');
    return { anchors: { 'Inside bend radius': [294, 294], 'Outside corner radius (flat)': [384, 114], 'Bend relief (width / depth)': [386, 202], 'Edge break / deburr': [40, 306] }, tDim: [300, 312, 150] };
  },
};

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let res = null, D = null;
  let selKey = null;          // "p|feature"
  let dragging = false, focusAfter = null;

  // ---------- strip: processes and the numbers ----------
  const procGroup = h('div', { class: 'cf-procs', role: 'radiogroup', 'aria-label': 'Process' });
  const thumb = (p) => {
    const s = sv(null, 'svg', { viewBox: p === 'all' ? '0 0 560 440' : '0 60 560 320', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
    if (p === 'all') {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) sv(s, 'rect', { x: 20 + i * 135, y: 60 + j * 170, width: 115, height: 140, rx: 10, class: 'cf-thumb' });
    } else {
      const g = sv(s, 'g');
      PARTS[p](g, { depth: 12 });
      for (const el of g.querySelectorAll('text, line')) el.remove();
      for (const el of g.querySelectorAll('path, rect, circle')) el.setAttribute('class', 'cf-thumb');
    }
    return s;
  };
  const procBtns = PROCS.map(([v, name]) => h('button', { type: 'button', class: 'cf-proc', role: 'radio', 'data-v': v, title: name,
    onclick: () => ctx.set('process', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
      const i = PROCS.findIndex((x) => x[0] === v); const nv = PROCS[clamp(i + d, 0, PROCS.length - 1)][0];
      ctx.set('process', nv); requestAnimationFrame(() => procGroup.querySelector(`[data-v="${nv}"]`)?.focus());
    } }, thumb(v), h('span', {}, name)));
  procGroup.append(...procBtns);
  const numField = (key, label, unit, cls) => {
    const inp = h('input', { type: 'text', inputmode: cls ? null : 'decimal', spellcheck: 'false', class: cls || null, 'aria-label': `${label}${unit ? ` ${unit}` : ''}`,
      placeholder: cls ? 'corner, edge, rib, hole…' : null, oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'cf-num' }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = () => { if (document.activeElement !== inp) inp.value = ctx.raw[key] ?? ''; inp.classList.toggle('cf-bad', !cls && String(ctx.raw[key] ?? '').trim() !== '' && !(ctx.input[key] > 0)); };
    return w;
  };
  const tF = numField('t', 'Wall t', 'mm'), dF = numField('depth', 'Pocket depth', 'mm'), qF = numField('filter', 'Find', '', 'cf-q');
  const strip = h('div', { class: 'cf-strip' }, procGroup, h('div', { class: 'cf-fields' }, tF, dF, qF));

  // ---------- the part ----------
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': 'The part, with its edges and corners called out' });
  const foot = h('div', { class: 'cf-foot', 'aria-live': 'polite' });
  const part = h('section', { class: 'cf-card cf-part' }, h('div', { class: 'cf-box' }, svg), foot);

  // ---------- the loupe ----------
  const lsvg = sv(null, 'svg', { class: 'cf-lsvg', role: 'img' });
  const lhead = h('div', { class: 'cf-lhead' });
  const lnums = h('div', { class: 'cf-lnums', 'aria-live': 'polite' });
  const lrule = h('div', { class: 'cf-rule' });
  const loupe = h('section', { class: 'cf-card cf-loupe' }, lhead, lsvg, lnums, lrule);
  root.append(h('div', { class: 'cf' }, strip, part, h('div', { class: 'cf-side' }, loupe, ctx.outputs)));

  const rowsFor = (p) => (D?.rows || []).filter((r) => r.p === p);
  const keyOf = (r) => `${r.p}|${r.f}`;
  const selRow = () => D?.rows.find((r) => keyOf(r) === selKey) || null;
  const pick = (r, focus) => { selKey = keyOf(r); if (focus) focusAfter = `pin-${selKey}`; drawPart(); drawLoupe(); };

  // label column placement: keep boxes apart, inside [top, bottom]
  const place = (items, top, bottom, gap) => {
    items.sort((a, b) => a.y - b.y);
    let y = top;
    for (const it of items) { it.ly = Math.max(it.y, y); y = it.ly + gap; }
    let over = items.length ? items[items.length - 1].ly - bottom : 0;
    for (let i = items.length - 1; i >= 0 && over > 0; i--) {
      const lim = i === items.length - 1 ? bottom : items[i + 1].ly - gap;
      if (items[i].ly > lim) items[i].ly = lim;
    }
    return items;
  };
  const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function drawPart() {
    const keep = focusAfter || document.activeElement?.getAttribute?.('data-h');
    svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 800), H = Math.max(260, svg.clientHeight || 560);
    const defs = sv(svg, 'defs'); hatch(defs);
    const mk = sv(defs, 'marker', { id: 'cf-ar', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(mk, 'path', { d: 'M0,0 L10,5 L0,10 z', class: 'cf-ah' });
    if (!D) { svg.setAttribute('viewBox', `0 0 ${W} ${H}`); return; }
    const process = ctx.raw.process;
    if (process === 'all') return drawAll(W, H);
    const p = PARTS[process] ? process : 'mill';
    const narrow = W < 620;
    // drawing 0..560 × 50..390, label gutters left and right (or below on narrow)
    const gutter = narrow ? 0 : 214;
    const vbX = -gutter, vbW = 560 + 2 * gutter, vbY = narrow ? 60 : 40, vbH = narrow ? 330 : 370;
    // fit the viewBox to the box, keeping the aspect
    const sc = Math.min(W / vbW, H / vbH);
    const vw = W / sc, vh = H / sc;
    svg.setAttribute('viewBox', `${vbX - (vw - vbW) / 2} ${vbY - (vh - vbH) / 2} ${vw} ${vh}`);
    const g = sv(svg, 'g');
    const info = PARTS[p](g, { depth: D.depth });
    const rows = rowsFor(p);
    const byName = new Map(rows.map((r, i) => [r.f, { r, i }]));
    const all = Object.keys(info.anchors);
    // features filtered away stay drawn, faint, without a pin
    for (const f of all) if (!byName.has(f)) { const [x, y] = info.anchors[f]; sv(g, 'circle', { cx: x, cy: y, r: 5, class: 'cf-thin cf-off' }); }
    // numbers in the guide's order
    const items = rows.filter((r) => info.anchors[r.f]).map((r) => ({ r, n: rows.indexOf(r) + 1, x: info.anchors[r.f][0], y: info.anchors[r.f][1] }));
    if (!selKey || !D.rows.some((r) => keyOf(r) === selKey) || !selKey.startsWith(`${p}|`)) selKey = items[0] ? keyOf(items[0].r) : null;
    // thickness t on the drawing, where the process has a wall
    if (info.tDim) {
      const [x0, x1, y] = info.tDim;
      sv(g, 'line', { x1: x0 - 18, y1: y, x2: x0, y2: y, class: 'cf-dim', 'marker-end': 'url(#cf-ar)' });
      sv(g, 'line', { x1: x1 + 18, y1: y, x2: x1, y2: y, class: 'cf-dim', 'marker-end': 'url(#cf-ar)' });
      sv(g, 'text', { x: x1 + 22, y: y + 4, class: 'cf-t cf-t-b' }, `t ${n3(D.t)}`);
    }
    // pocket depth on the milled part: drag the floor
    if (info.depth) {
      const { x, y0, y1 } = info.depth;
      sv(g, 'line', { x1: x, y1: y0, x2: x, y2: y1, class: 'cf-dim', 'marker-start': 'url(#cf-ar)', 'marker-end': 'url(#cf-ar)' });
      sv(g, 'text', { x: x + 10, y: (y0 + y1) / 2 + 4, class: 'cf-t cf-t-b' }, `depth ${n3(D.depth)}`);
      const kg = sv(g, 'g', { class: 'cf-knob', tabindex: 0, role: 'slider', 'data-h': 'depth', 'aria-label': `Pocket depth ${n3(D.depth)} mm; arrow keys change it`, 'aria-valuenow': D.depth });
      sv(kg, 'circle', { cx: x, cy: y1, r: 12 }); sv(kg, 'circle', { cx: x, cy: y1, r: 5 });
      kg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 5 : 1; const d = { ArrowUp: -st, ArrowDown: st, ArrowLeft: -st, ArrowRight: st }[e.key];
        if (!d) return; e.preventDefault(); focusAfter = 'depth'; ctx.set('depth', String(Math.max(1, Math.round(D.depth + d))));
      });
      kg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); capture(kg, e); dragging = true; focusAfter = 'depth'; kg.focus();
        const m = svg.getScreenCTM();
        const move = (ev) => {
          const yy = (ev.clientY - m.f) / m.d;       // drawing units
          const dep = ((yy - 110 - 24) / 170) * 60;  // inverse of the drawing's depth mapping
          ctx.set('depth', String(clamp(Math.round(dep), 1, 60)));
        };
        const up = () => { kg.removeEventListener('pointermove', move); dragging = false; drawPart(); };
        kg.addEventListener('pointermove', move);
        kg.addEventListener('pointerup', up, { once: true });
        kg.addEventListener('pointercancel', up, { once: true });
      });
    }
    // labels: gutters beside the part, or two rows below it on narrow
    const boxW = 202, boxH = 36;
    let lefts = [], rights = [];
    if (!narrow) {
      for (const it of items) (it.x < 280 ? lefts : rights).push(it);
      place(lefts, 60, 380, boxH + 8); place(rights, 60, 380, boxH + 8);
      for (const it of lefts) { it.lx = -gutter + 6; it.side = 'l'; }
      for (const it of rights) { it.lx = 560 + gutter - 6 - boxW; it.side = 'r'; }
    } else {
      for (const it of items) it.side = 'none';
    }
    for (const it of items) {
      const r = it.r, k = keyOf(r), on = k === selKey;
      const pg = sv(svg, 'g', { class: `cf-pin${r.key ? '' : ' cf-minor'}${on ? ' cf-sel' : ''}`, tabindex: 0, role: 'button', 'data-h': `pin-${k}`,
        'aria-pressed': String(on), 'aria-label': `${it.n}. ${r.f}: recommended ${r.rec}, minimum ${r.min}` });
      if (it.side !== 'none') {
        const bx = it.lx, by = it.ly - boxH / 2;
        const ex = it.side === 'l' ? bx + boxW : bx;
        sv(pg, 'path', { class: 'cf-lead', d: `M${it.x + (it.side === 'l' ? -9 : 9)},${it.y} L${ex + (it.side === 'l' ? 14 : -14)},${it.ly} L${ex},${it.ly}` });
        sv(pg, 'rect', { x: bx, y: by, width: boxW, height: boxH, rx: 4, class: 'cf-lbox' });
        sv(pg, 'text', { x: bx + 8, y: by + 14, class: 'cf-name' }, `${it.n}  ${trunc(r.f, 31)}`);
        const vt = sv(pg, 'text', { x: bx + 8, y: by + 29, class: 'cf-t' });
        sv(vt, 'tspan', { class: 'cf-t-rec' }, trunc(r.rec, 17));
        sv(vt, 'tspan', { class: 'cf-t-soft', dx: 6 }, trunc(`min ${r.min}`, 12));
      }
      const pr = narrow ? 15 : 9;
      sv(pg, 'circle', { cx: it.x, cy: it.y, r: pr + 5, class: 'cf-halo' });
      sv(pg, 'circle', { cx: it.x, cy: it.y, r: pr, class: 'cf-pin-dot' });
      const pn = sv(pg, 'text', { x: it.x, y: it.y + pr * 0.38, 'text-anchor': 'middle', class: 'cf-pin-n' }, String(it.n));
      if (narrow) pn.style.fontSize = '16px';
      pg.addEventListener('click', () => pick(r, true));
      pg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r, true); return; }
        const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault();
        const ord = items.slice().sort((a, b) => a.n - b.n);
        const j = ord.findIndex((x) => x.r === r); const nx = ord[(j + d + ord.length) % ord.length];
        pick(nx.r, true);
      });
    }
    if (keep) { const el = svg.querySelector(`[data-h="${CSS.escape(keep)}"]`); if (el) { if (document.activeElement !== el) el.focus({ preventScroll: true }); if (!dragging && focusAfter === keep) focusAfter = null; } }
  }

  function drawAll(W, H) {
    const narrow = W < 620;
    const cols = narrow ? 2 : 4, rowsN = Math.ceil(8 / cols);
    const pw = 560, ph = 360, gap = 24;
    const vbW = cols * pw + (cols - 1) * gap, vbH = rowsN * (ph + 30) + (rowsN - 1) * gap;
    const sc = Math.min(W / vbW, H / vbH);
    const vw = W / sc, vh = H / sc;
    svg.setAttribute('viewBox', `${-(vw - vbW) / 2} ${-(vh - vbH) / 2} ${vw} ${vh}`);
    const procs = PROCS.slice(0, 8).map((x) => x[0]);
    if (!selKey || !D.rows.some((r) => keyOf(r) === selKey)) selKey = D.rows[0] ? keyOf(D.rows[0]) : null;
    procs.forEach((p, i) => {
      const cx = (i % cols) * (pw + gap), cy = Math.floor(i / cols) * (ph + 30 + gap);
      const panel = sv(svg, 'g', { class: 'cf-panel', transform: `translate(${cx},${cy})` });
      sv(panel, 'rect', { x: 0, y: 0, width: pw, height: ph + 30, rx: 10, class: 'cf-panel-bg' });
      const title = sv(panel, 'text', { x: 16, y: 34, class: 'cf-panel-t', 'font-size': 26 }, PROCS.find((x) => x[0] === p)[1]);
      title.style.fontSize = '26px';
      const g = sv(panel, 'g', { transform: 'translate(0,-30)' });
      const info = PARTS[p](g, { depth: D.depth });
      for (const el of g.querySelectorAll('text')) el.remove();
      panel.addEventListener('click', (e) => { if (!e.target.closest('.cf-pin')) ctx.set('process', p); });
      const rows = rowsFor(p);
      rows.forEach((r, j) => {
        const a = info.anchors[r.f]; if (!a) return;
        const k = keyOf(r), on = k === selKey;
        const pg = sv(panel, 'g', { class: `cf-pin${r.key ? '' : ' cf-minor'}${on ? ' cf-sel' : ''}`, tabindex: 0, role: 'button', 'data-h': `pin-${k}`,
          transform: 'translate(0,-30)', 'aria-pressed': String(on), 'aria-label': `${PROCS.find((x) => x[0] === p)[1]}, ${r.f}: recommended ${r.rec}` });
        sv(pg, 'circle', { cx: a[0], cy: a[1], r: 26, class: 'cf-halo' });
        sv(pg, 'circle', { cx: a[0], cy: a[1], r: 17, class: 'cf-pin-dot' });
        const t = sv(pg, 'text', { x: a[0], y: a[1] + 7, 'text-anchor': 'middle', class: 'cf-pin-n' }, String(j + 1));
        t.style.fontSize = '20px';
        pg.addEventListener('click', () => pick(r, true));
        pg.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r, true); return; }
          const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault();
          const i2 = D.rows.indexOf(r); pick(D.rows[(i2 + d + D.rows.length) % D.rows.length], true);
        });
      });
      if (!rows.length) panel.setAttribute('class', 'cf-panel cf-off');
    });
    const keep = focusAfter || document.activeElement?.getAttribute?.('data-h');
    if (keep) { const el = svg.querySelector(`[data-h="${CSS.escape(keep)}"]`); if (el) { if (document.activeElement !== el) el.focus({ preventScroll: true }); if (focusAfter === keep) focusAfter = null; } }
  }

  // ---------- loupe: the selected edge to scale ----------
  function drawLoupe() {
    const r = selRow();
    lsvg.replaceChildren();
    const W = Math.max(240, lsvg.clientWidth || 360), H = 250;
    lsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!r) {
      lhead.replaceChildren(h('h2', {}, 'Nothing selected'));
      lnums.replaceChildren(); lrule.replaceChildren(h('span', {}, res?.warnings?.[0] || ''));
      return;
    }
    const [kind, useT, where] = KIND[`${r.p}|${r.f}`] || ['text', false];
    const list = D.rows;
    const idx = list.indexOf(r);
    const step = (d) => pick(list[(idx + d + list.length) % list.length], false);
    lhead.replaceChildren(h('h2', {}, r.f), h('span', {}, `${r.process}${where ? ` · ${where}` : ''}`),
      h('div', { class: 'cf-nav' }, h('button', { type: 'button', 'aria-label': 'Previous feature', onclick: () => step(-1) }, '‹'),
        h('button', { type: 'button', 'aria-label': 'Next feature', onclick: () => step(1) }, '›')));
    lsvg.setAttribute('aria-label', `${r.f}, drawn to scale: recommended ${r.rec}, minimum ${r.min}`);
    lnums.replaceChildren(
      h('span', {}, 'Recommended'), h('b', { class: 'cf-rec' }, r.rec),
      h('span', {}, 'Minimum'), h('b', { class: 'cf-min' }, r.min));
    lrule.replaceChildren(h('div', {}, 'Rule ', h('b', {}, r.rule)), h('p', {}, r.why));

    const rec = r.recMm, min = r.minMm, t = D.t;
    const defs = sv(lsvg, 'defs');
    const cp = sv(defs, 'clipPath', { id: 'cf-lclip' }); sv(cp, 'rect', { x: 0, y: 0, width: W, height: H });
    const g = sv(lsvg, 'g', { 'clip-path': 'url(#cf-lclip)' });
    if (kind === 'text' || (rec == null && min == null)) {
      sv(g, 'text', { x: W / 2, y: H / 2 - 6, 'text-anchor': 'middle', class: 'cf-t cf-t-rec', style: 'font-size:16px' }, r.rec);
      sv(g, 'text', { x: W / 2, y: H / 2 + 18, 'text-anchor': 'middle', class: 'cf-t cf-t-soft' }, 'an angle, not a size: nothing to scale');
      return;
    }
    // field of view in mm, centred on the corner
    const big = Math.max(rec || 0, min || 0, kind === 'relief' ? (rec || 0) * 2 : 0);
    const F = Math.max(big * 2.3, useT ? t * 1.7 : 0, 0.6);
    const s = (Math.min(W, H) / 2 - 16) / F;              // px per mm
    const ox = W / 2 + (kind === 'out' || kind === 'cham' || kind === 'sharp' ? s * F * 0.25 : kind === 'rib' ? 0 : -s * F * 0.2);
    const oy = H / 2 + (kind === 'rib' ? s * F * 0.35 : kind === 'bend' ? -s * F * 0.1 : s * F * 0.2);
    const X = (x) => ox + x * s, Y = (y) => oy + y * s;     // mm, y down
    // millimetre grid
    const gstep = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((v) => v * s >= 16) || 20;
    for (let x = Math.floor(-2 * F / gstep) * gstep; X(x) <= W; x += gstep) if (X(x) >= 0) sv(g, 'line', { x1: X(x), y1: 0, x2: X(x), y2: H, class: 'cf-lgrid' });
    for (let y = Math.floor(-2 * F / gstep) * gstep; Y(y) <= H; y += gstep) if (Y(y) >= 0) sv(g, 'line', { x1: 0, y1: Y(y), x2: W, y2: Y(y), class: 'cf-lgrid' });
    const E = F * 3;                                        // far edge
    const P = (pts) => pts.map((p, i) => (typeof p === 'string' ? p : `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`)).join(' ');
    const arc = (R, x, y, sweep) => `A${(R * s).toFixed(1)} ${(R * s).toFixed(1)} 0 0 ${sweep} ${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
    const label = (x, y, text, cls, anchor = 'start') => {
      const tx = sv(g, 'text', { x, y, class: `cf-t ${cls}`, 'text-anchor': anchor }, text);
      const b = tx.getBBox?.(); if (b && b.width) g.insertBefore(sv(null, 'rect', { x: b.x - 3, y: b.y - 1, width: b.width + 6, height: b.height + 2, rx: 3, fill: 'var(--surface)', opacity: 0.9 }), tx);
    };
    const R = rec || 0, M = min ?? null;
    if (kind === 'in') {
      // material: a wall on the left and a floor below, meeting in an inside corner at (0,0)
      const wL = useT ? t : E, wB = useT ? t : E;
      sv(g, 'path', { class: 'cf-lmat', d: `${P([[-wL, -E], [0, -E], [0, -R]])} ${R > 0 ? arc(R, R, 0, 0) : ''} ${P([[E, 0], [E, wB], [-wL, wB]]).replace(/^M/, 'L')} Z` });
      sv(g, 'path', { class: 'cf-lsharp', d: P([[0, -E], [0, 0], [E, 0]]) });
      sv(g, 'path', { class: 'cf-ledge', d: `${P([[0, -E], [0, -R]])} ${R > 0 ? arc(R, R, 0, 0) : ''} ${P([[E, 0]]).replace(/^M/, 'L')}` });
      if (R > 0) sv(g, 'path', { class: 'cf-lrec', d: `${P([[0, -R]])} ${arc(R, R, 0, 0)}` });
      if (M > 0) sv(g, 'path', { class: 'cf-lmin', d: `${P([[0, -M]])} ${arc(M, M, 0, 0)}` });
      if (R > 0) { sv(g, 'path', { class: 'cf-dim', d: P([[R, -R], [R - R * 0.707, -R + R * 0.707]]) }); label(X(R) + 6, Y(-R) - 4, `R ${n3(R)}`, 'cf-t-rec'); }
      if (M > 0 && M !== R) label(X(M) + 6, Y(0) - 6, `min R ${n3(M)}`, 'cf-t-min');
    } else if (kind === 'out' || kind === 'sharp') {
      // a block in the lower left, its outside corner at (0,0) rounded
      sv(g, 'path', { class: 'cf-lmat', d: `${P([[-E, 0], [-R, 0]])} ${R > 0 ? arc(R, 0, R, 1) : ''} ${P([[0, E], [-E, E]]).replace(/^M/, 'L')} Z` });
      if (useT && kind === 'out' && r.p !== 'fdm' && r.p !== 'sheet') {
        // the wall behind the corner, t thick
        sv(g, 'path', { class: 'cf-lsharp', d: P([[-E, t], [-t, t], [-t, E]]) });
      }
      sv(g, 'path', { class: 'cf-lsharp', d: P([[-E, 0], [0, 0], [0, E]]) });
      sv(g, 'path', { class: 'cf-ledge', d: `${P([[-E, 0], [-R, 0]])} ${R > 0 ? arc(R, 0, R, 1) : ''} ${P([[0, E]]).replace(/^M/, 'L')}` });
      if (R > 0) sv(g, 'path', { class: 'cf-lrec', d: `${P([[-R, 0]])} ${arc(R, 0, R, 1)}` });
      if (M > 0) sv(g, 'path', { class: 'cf-lmin', d: `${P([[-M, 0]])} ${arc(M, 0, M, 1)}` });
      if (R > 0) label(X(0) + 8, Y(0) - 4, `R ${n3(R)}`, 'cf-t-rec');
      else label(X(0) + 8, Y(0) - 4, 'sharp edge', 'cf-t-rec');
      if (M > 0 && M !== R) label(X(0) + 8, Y(0) + 12, `min R ${n3(M)}`, 'cf-t-min');
    } else if (kind === 'cham') {
      // chamfer R long on the top face, at the angle the guide gives (45° unless it says otherwise)
      const ang = Number((String(r.rec).match(/×\s*(\d+(?:\.\d+)?)°/) || [])[1]) || 45;
      const V = R * Math.tan((ang * Math.PI) / 180);
      sv(g, 'path', { class: 'cf-lmat', d: P([[-E, 0], [-R, 0], [0, V], [0, E], [-E, E]]) + ' Z' });
      sv(g, 'path', { class: 'cf-lsharp', d: P([[-E, 0], [0, 0], [0, E]]) });
      sv(g, 'path', { class: 'cf-ledge', d: P([[-E, 0], [-R, 0], [0, V], [0, E]]) });
      sv(g, 'path', { class: 'cf-lrec', d: P([[-R, 0], [0, V]]) });
      if (M > 0) sv(g, 'path', { class: 'cf-lmin', d: P([[-M, 0], [0, M]]) });
      label(X(0) + 8, Y(0) - 4, `${n3(R)} × ${n3(ang)}°`, 'cf-t-rec');
      if (M > 0 && M !== R) label(X(0) + 8, Y(0) + 12, `min ${n3(M)}`, 'cf-t-min');
    } else if (kind === 'rib') {
      // a floor with a rib standing on it (rib 0.6 t thick), base fillets both sides
      const w = (useT ? t : 1) * 0.6 / 2;
      sv(g, 'path', { class: 'cf-lmat', d: `${P([[-E, 0], [-w - R, 0]])} ${arc(R, -w, -R, 0)} ${P([[-w, -E], [w, -E], [w, -R]]).replace(/^M/, 'L')} ${arc(R, w + R, 0, 0)} ${P([[E, 0], [E, t], [-E, t]]).replace(/^M/, 'L')} Z` });
      sv(g, 'path', { class: 'cf-ledge', d: `${P([[-E, 0], [-w - R, 0]])} ${arc(R, -w, -R, 0)} ${P([[-w, -E]]).replace(/^M/, 'L')} M${X(w)},${Y(-E)} ${P([[w, -R]]).replace(/^M/, 'L')} ${arc(R, w + R, 0, 0)} ${P([[E, 0]]).replace(/^M/, 'L')}` });
      sv(g, 'path', { class: 'cf-lrec', d: `${P([[-w - R, 0]])} ${arc(R, -w, -R, 0)} M${X(w)},${Y(-R)} ${arc(R, w + R, 0, 0)}` });
      if (M > 0) sv(g, 'path', { class: 'cf-lmin', d: `${P([[-w - M, 0]])} ${arc(M, -w, -M, 0)} M${X(w)},${Y(-M)} ${arc(M, w + M, 0, 0)}` });
      label(X(w + R) + 6, Y(-R) - 6, `R ${n3(R)}`, 'cf-t-rec');
      if (M > 0 && M !== R) label(X(-w - R) - 6, Y(-R) - 6, `min R ${n3(M)}`, 'cf-t-min', 'end');
    } else if (kind === 'bend') {
      // sheet t thick: flange to the left, leg going up, inside radius R
      const Ro = R + t;
      sv(g, 'path', { class: 'cf-lmat', d: `${P([[-E, 0], [-R, 0]])} ${arc(R, 0, -R, 0)} ${P([[0, -E], [t, -E], [t, -R]]).replace(/^M/, 'L')} ${arc(Ro, -R, t, 1)} ${P([[-E, t]]).replace(/^M/, 'L')} Z` });
      sv(g, 'path', { class: 'cf-ledge', d: `${P([[-E, t], [-R, t]])} ${arc(Ro, t, -R, 0)} ${P([[t, -E]]).replace(/^M/, 'L')}` });
      sv(g, 'path', { class: 'cf-lrec', d: `${P([[-R, 0]])} ${arc(R, 0, -R, 0)}` });
      if (M > 0) sv(g, 'path', { class: 'cf-lmin', d: `${P([[-M, 0]])} ${arc(M, 0, -M, 0)}` });
      label(X(-R) - 6, Y(-R) - 4, `inside R ${n3(R)}`, 'cf-t-rec', 'end');
      if (M > 0 && M !== R) label(X(-M) - 6, Y(-M) + 14, `min ${n3(M)}`, 'cf-t-min', 'end');
    } else if (kind === 'relief') {
      // a flat blank edge with a relief slot at the bend line: width = rec
      const wR = R, dR = R * 2;
      sv(g, 'path', { class: 'cf-lmat', d: P([[-E, -E], [0, -E], [0, -wR / 2], [-dR, -wR / 2], [-dR, wR / 2], [0, wR / 2], [0, E], [-E, E]]) + ' Z' });
      sv(g, 'path', { class: 'cf-lrec', d: P([[0, -wR / 2], [-dR, -wR / 2], [-dR, wR / 2], [0, wR / 2]]) });
      sv(g, 'line', { x1: X(-E), y1: Y(0), x2: X(0), y2: Y(0), class: 'cf-lsharp' });
      label(X(0) + 6, Y(0) + 4, `${n3(R)} wide`, 'cf-t-rec');
      label(X(-E * 0.9), Y(0) - 6, 'bend line', 'cf-t-soft');
    }
    // wall thickness t, scrubbable, where the drawing shows a wall
    if (useT && kind !== 'relief') {
      const sg = sv(lsvg, 'g', { class: 'cf-scrub', tabindex: 0, role: 'slider', 'data-h': 'scrub-t', 'aria-label': `Wall thickness t ${n3(t)} mm; drag sideways or use arrow keys`, 'aria-valuenow': t });
      const txt = `t ${n3(t)} mm  ⇆`;
      sv(sg, 'rect', { x: 8, y: H - 30, width: txt.length * 7 + 14, height: 22, rx: 4 });
      sv(sg, 'text', { x: 15, y: H - 15, class: 'cf-t cf-t-b' }, txt);
      const setT = (v) => ctx.set('t', String(Math.round(clamp(v, 0.2, 50) * 10) / 10));
      sg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 1 : 0.1; const d = { ArrowRight: st, ArrowUp: st, ArrowLeft: -st, ArrowDown: -st }[e.key];
        if (!d) return; e.preventDefault(); focusAfter = 'scrub-t'; setT(t + d);
      });
      sg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); capture(sg, e); sg.focus(); focusAfter = 'scrub-t';
        const x0 = e.clientX, t0 = t;
        const move = (ev) => setT(t0 * Math.pow(2, (ev.clientX - x0) / 120));
        const up = () => { sg.removeEventListener('pointermove', move); };
        sg.addEventListener('pointermove', move);
        sg.addEventListener('pointerup', up, { once: true });
        sg.addEventListener('pointercancel', up, { once: true });
      });
    }
    // scale bar
    const bar = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((v) => v * s >= 40) || 20;
    const bx = W - 16 - bar * s, by = H - 14;
    sv(lsvg, 'line', { x1: bx, y1: by, x2: W - 16, y2: by, stroke: 'var(--ink)', 'stroke-width': 2 });
    sv(lsvg, 'text', { x: W - 16, y: by - 5, 'text-anchor': 'end', class: 'cf-t cf-t-soft' }, `${bar} mm · grid ${gstep}`);
    const keep = focusAfter || null;
    if (keep === 'scrub-t') { lsvg.querySelector('[data-h="scrub-t"]')?.focus({ preventScroll: true }); focusAfter = null; }
  }

  function drawStrip() {
    const cur = ctx.raw.process;
    for (const b of procBtns) { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    tF.sync(); dF.sync(); qF.sync();
    dF.style.display = cur === 'mill' || cur === 'all' ? '' : 'none';
  }
  function drawFoot() {
    foot.replaceChildren(...(res?.warnings || []).map((w) => h('div', { class: 'cf-w' }, w)),
      ...(res?.notes || []).slice(0, 3).map((w) => h('div', { class: 'cf-n' }, w)));
  }

  const draw = () => { drawStrip(); drawPart(); drawLoupe(); drawFoot(); };
  ctx.onResult((r) => { res = r; D = r.draw || null; draw(); });
  new ResizeObserver(() => { if (!dragging) { drawPart(); drawLoupe(); } }).observe(svg);
}
