// Wire Gauge Selector: the cable run from supply to load is the page.
//   Run     - supply, the conductors (drawn as thick as the size you look at),
//             the load. Drag the load to set the length (log ruler), scrub the
//             current on the wire, drag the drop floor on the voltage profile
//             above; every size near the pick is a faint profile, the one you
//             look at is bold, and the load's voltage sits at the load.
//   Sizes   - the conductors in section, to scale, around the pick; under each
//             its drop against the limit and its rating against the load.
//             Click one to look at it on the run.
//   Install - how the cable is laid, as pictures (click one), the bundle drawn
//             with its circuits (+/-), and the derating chain in numbers.
// Every number shown comes from run()'s result.wire.
const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
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
const num = (v, d) => String(Number(Number(v).toFixed(d)));
const LMIN = 0.1, LMAX = 300;

const METHODS = [
  ['E', 'Free air'], ['C', 'Clipped'], ['B1', 'Conduit'], ['A1', 'Insulated'],
];

// Small pictures of each installation, 80 x 44.
function methodPict(m) {
  const s = sv('svg', { viewBox: '0 0 80 44', 'aria-hidden': 'true' });
  const cable = (cx, cy, r = 6) => [sv('circle', { cx, cy, r, class: 'jacket' }), sv('circle', { cx: cx - r * 0.35, cy, r: r * 0.28, class: 'cu' }), sv('circle', { cx: cx + r * 0.35, cy, r: r * 0.28, class: 'cu' })];
  if (m === 'E') {
    s.append(sv('path', { d: 'M8,34 H72', class: 'air' }), sv('path', { d: 'M8,10 H72', class: 'air' }), ...cable(28, 22), ...cable(52, 22));
  } else if (m === 'C') {
    s.append(sv('rect', { x: 4, y: 34, width: 72, height: 8, class: 'wallf' }), ...cable(30, 27), ...cable(50, 27),
      sv('path', { d: 'M22,34 V26 A8,8 0 0 1 38,26 V34', class: 'clip' }));
  } else if (m === 'B1') {
    s.append(sv('rect', { x: 4, y: 38, width: 72, height: 5, class: 'wallf' }), sv('circle', { cx: 40, cy: 22, r: 16, class: 'conduit' }), ...cable(34, 25, 5.5), ...cable(46, 25, 5.5), ...cable(40, 15, 5.5));
  } else {
    s.append(sv('rect', { x: 4, y: 4, width: 72, height: 38, class: 'wool' }), ...cable(40, 23, 7));
    for (let x = 8; x < 76; x += 8) s.append(sv('path', { d: `M${x},6 q3,6 0,12 q-3,6 0,12 q3,6 0,10`, class: 'air' }));
  }
  return s;
}

export function page(root, ctx) {
  const F = (v, d = 3) => ctx.fmtNum(v, d);
  const st = { insp: null, drag: null, pending: null, geo: {} };
  const W_ = () => ctx.result?.wire;

  // ---------- layout ----------
  const field = (key, label, unit, aria) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria || `${label} ${unit}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    return { el: h('label', { class: 'wg-f' }, label, inp, unit || null), inp, key };
  };
  const fCur = field('current', 'I', 'A', 'Load current in A');
  const fLen = field('length', 'length', 'm', 'Cable length one way in m');
  const fV = field('voltage', 'supply', 'V', 'Supply voltage in V');
  const fDrop = field('drop', 'drop ≤', '%', 'Allowed voltage drop in %');
  const fT = field('temp', 'conductor', '°C', 'Conductor temperature in °C');
  const fAmb = field('ambient', 'ambient', '°C', 'Ambient temperature in °C');
  const fGrp = field('group', 'circuits', '', 'Loaded circuits bundled together');
  const fields = [fCur, fLen, fV, fDrop, fT, fAmb, fGrp];
  const segCircuit = h('div', { class: 'wg-seg', role: 'group', 'aria-label': 'Circuit' });
  const segSizes = h('div', { class: 'wg-seg', role: 'group', 'aria-label': 'Sizes' });
  const segMetal = h('div', { class: 'wg-seg', role: 'group', 'aria-label': 'Conductor' });
  const segStrand = h('div', { class: 'wg-seg', role: 'group', 'aria-label': 'Construction' });
  const segIns = h('div', { class: 'wg-seg', role: 'group', 'aria-label': 'Insulation' });

  const runDraw = h('div', { class: 'wg-draw' });
  const run = h('section', { class: 'wg-card wg-run', 'aria-label': 'The cable run' },
    h('div', { class: 'wg-head' }, h('h2', {}, 'Run'), h('span', { class: 'sub' }, 'supply to load'), segCircuit, h('span', { class: 'grow' }),
      fV.el, fCur.el, fLen.el, fDrop.el),
    runDraw,
    h('div', { class: 'wg-foot' }, h('span', {}, 'Drag the load along the ruler, scrub the current on the wire, drag the red floor to set the allowed drop.'),
      h('span', {}, h('kbd', {}, '←'), h('kbd', {}, '→'), h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' on a focused handle')));

  const sizeDraw = h('div', { class: 'wg-draw' });
  const sizeHead = h('span', { class: 'sub' });
  const sizes = h('section', { class: 'wg-card wg-sizes', 'aria-label': 'Conductor sizes' },
    h('div', { class: 'wg-head' }, h('h2', {}, 'Sizes'), segSizes, sizeHead), sizeDraw,
    h('div', { class: 'wg-foot' }, 'Conductors to scale, insulation schematic. Click a size to see it on the run. Bars: drop against the limit, rating against the load (the tick).'));

  const tiles = h('div', { class: 'wg-tiles', role: 'group', 'aria-label': 'Installation method' });
  const sceneDraw = h('div', { class: 'wg-draw' });
  const minus = h('button', { class: 'k-btn', type: 'button', 'aria-label': 'One circuit fewer in the bundle', onclick: () => bump(-1) }, '−');
  const plus = h('button', { class: 'k-btn', type: 'button', 'aria-label': 'One more circuit in the bundle', onclick: () => bump(1) }, '+');
  const chain = h('div', { class: 'wg-chain', 'aria-live': 'polite' });
  const inst = h('section', { class: 'wg-card wg-inst', 'aria-label': 'Installation' },
    h('div', { class: 'wg-head' }, h('h2', {}, 'Installation'), h('span', { class: 'sub' }, 'what the rating is derated for')),
    tiles, sceneDraw,
    h('div', { class: 'wg-rows' },
      h('div', {}, h('span', { class: 'wg-bundle' }, h('span', { class: 'wg-f' }, 'bundle'), minus, fGrp.el, plus), fAmb.el),
      h('div', {}, segIns, segMetal, segStrand),
      h('div', {}, fT.el, h('span', { class: 'wg-f' }, 'for the resistance'))),
    chain);

  const warns = h('div', { class: 'k-warns wg-warns', 'aria-live': 'polite' });
  root.append(h('div', { class: 'wg' }, run, sizes, inst, h('section', { class: 'wg-side' }, warns), h('section', { class: 'wg-out' }, ctx.outputs)));

  const bump = (d) => { const w = W_(); ctx.set('group', String(clamp((w ? w.nG : 1) + d, 1, 20))); };
  const setSoon = (obj) => {
    const first = !st.pending;
    st.pending = { ...(st.pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = st.pending; st.pending = null; ctx.setMany(p); });
  };
  const redraw = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  const defs = () => {
    const d = sv('defs');
    const p = sv('pattern', { id: 'wg-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    p.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-l' }));
    const a = sv('marker', { id: 'wg-arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    a.append(sv('path', { d: 'M0,1 L9,5 L0,9 Z', class: 'dim-f' }));
    d.append(p, a);
    return d;
  };
  const inspIdx = (w) => {
    if (st.insp != null && w.list[st.insp] && st.inspName === w.list[st.insp].name) return st.insp;
    st.insp = null;
    return w.best >= 0 ? w.best : w.list.length - 1;
  };
  const windowOf = (w, n) => {
    const pick = w.best >= 0 ? w.best : w.list.length - 1;
    const half = Math.floor(n / 2);
    let a = Math.max(0, pick - half);
    const b = Math.min(w.list.length - 1, a + n - 1);
    a = Math.max(0, b - n + 1);
    return [a, b];
  };
  const pad = (hEl, fk, cls, label, vt) => sv('g', { class: `h ${cls}`, tabindex: 0, role: 'slider', 'data-fk': fk, 'data-drag': fk, 'aria-label': label, 'aria-valuetext': vt });

  // ---------- the run ----------
  function drawRun() {
    const w = W_();
    runDraw.style.minHeight = `${runDraw.offsetHeight}px`; // keep the page still while redrawing
    runDraw.replaceChildren();
    if (!w) return;
    const W = Math.max(320, runDraw.clientWidth || 900);
    const narrow = W < 640;
    const H = narrow ? 300 : 280;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Cable run from supply to load' });
    svg.append(defs());
    const srcW = narrow ? 58 : 84, loadW = narrow ? 64 : 92;
    const xs = 12 + srcW;
    const xa = xs + (narrow ? 36 : 60), xb = W - 14 - loadW;
    const lenX = (m) => xa + (Math.log10(clamp(m, LMIN, LMAX) / LMIN) / Math.log10(LMAX / LMIN)) * (xb - xa);
    const xL = lenX(w.length);
    const yP0 = 30, yP1 = 128;
    const three = w.circuit === 'ac3';
    const wy = three ? [172, 190, 208] : [176, 204];
    const boxY0 = 150, boxY1 = 232;
    const ii = inspIdx(w), s = w.list[ii];
    // voltage profile
    const [a, b] = windowOf(w, narrow ? 5 : 9);
    const floorV = w.voltage - w.dvMax;
    const span = Math.max(w.dvMax * 1.9, Math.min(s.dv * 1.1, w.dvMax * 4));
    const vY = (v) => yP0 + ((w.voltage - v) / span) * (yP1 - yP0);
    svg.append(sv('rect', { x: xs, y: vY(floorV), width: W - 12 - xs, height: yP1 - vY(floorV), class: 'below' }));
    svg.append(sv('line', { x1: xs, y1: yP0, x2: W - 12, y2: yP0, class: 'grid' }), sv('line', { x1: xs, y1: yP1, x2: W - 12, y2: yP1, class: 'grid' }));
    svg.append(txt(xs - 6, yP0 + 4, `${F(w.voltage, 4)} V`, 'm sm', 'end'));
    svg.append(txt(xs - 6, vY(floorV) + 4, `${F(floorV, 4)} V`, 'm sm danger', 'end'));
    const clipY = (y) => Math.min(y, yP1);
    const used = [vY(w.voltage - w.list[inspIdx(w)].dv)];
    for (let i = a; i <= b; i++) {
      if (i === ii) continue;
      const o = w.list[i];
      const y = vY(w.voltage - o.dv);
      if (y > yP1) {
        const xc = xs + (xL - xs) * ((yP1 - yP0) / (y - yP0));
        svg.append(sv('path', { d: `M${xs},${yP0} L${xc},${yP1}`, class: 'vghost' }));
      } else {
        svg.append(sv('path', { d: `M${xs},${yP0} L${xL},${y}`, class: 'vghost' }));
        if (!narrow && xL - xs > 80 && used.every((u) => Math.abs(u - y) > 10)) {
          used.push(y);
          svg.append(txt(xL + 6, y + 3, o.name, 'm sm soft'));
        }
      }
    }
    const yL = vY(w.voltage - s.dv);
    const bad = s.dv > w.dvMax;
    svg.append(sv('path', { d: `M${xs},${yP0} L${xL},${clipY(yL)}`, class: 'vline' }));
    svg.append(sv('circle', { cx: xL, cy: clipY(yL), r: 4.5, fill: bad ? 'var(--danger)' : 'var(--tool-v)' }));
    const loadLab = `${F(w.voltage - s.dv, 4)} V at the load · −${F(s.pct)} %`;
    const lx = clamp(xL - 8, xs + loadLab.length * 6.3, W - 16);
    svg.append(sv('rect', { x: lx - loadLab.length * 6.3 - 4, y: clipY(yL) - 22, width: loadLab.length * 6.3 + 8, height: 15, class: 'bg', opacity: 0.9 }),
      txt(lx, clipY(yL) - 11, loadLab, `m b ${bad ? 'danger' : ''}`, 'end'));
    // the floor: drag it
    const yF = vY(floorV);
    const fg = pad(null, 'drop', 'ns', 'Allowed voltage drop', `${F(w.drop)} %`);
    const pl = `drop ≤ ${F(w.drop)} %`;
    const pw = pl.length * 6.6 + 16;
    fg.append(sv('rect', { x: xs, y: yF - 8, width: W - 12 - xs, height: 16, fill: 'transparent' }),
      sv('line', { x1: xs, y1: yF, x2: W - 12, y2: yF, class: 'floor' }),
      sv('rect', { x: W - 12 - pw, y: yF - 10, width: pw, height: 20, rx: 10, class: 'pill' }),
      txt(W - 12 - pw / 2, yF + 4, pl, 'm sm pill-t', 'middle'),
      sv('rect', { x: W - 15 - pw, y: yF - 13, width: pw + 6, height: 26, rx: 13, class: 'ring' }));
    svg.append(fg);
    // supply
    svg.append(sv('rect', { x: 12, y: boxY0, width: srcW, height: boxY1 - boxY0, rx: 4, class: 'box' }));
    svg.append(txt(12 + srcW / 2, boxY0 + 22, `${F(w.voltage, 4)} V`, 'm b', 'middle'),
      txt(12 + srcW / 2, boxY0 + 38, three ? 'AC 3φ' : w.circuit === 'ac1' ? 'AC 1φ' : 'DC', 'sm soft', 'middle'));
    // conductors, as thick as the inspected size
    const thick = clamp(s.d * 2.4, 2.5, 16);
    const cls = three ? ['w-pos', 'w-neg', 'w-l3'] : ['w-pos', 'w-neg'];
    wy.forEach((y, i) => {
      svg.append(sv('rect', { x: xs - 5, y: y - 5, width: 10, height: 10, rx: 2, class: 'term' }), sv('rect', { x: xL - 5, y: y - 5, width: 10, height: 10, rx: 2, class: 'term' }));
      svg.append(sv('path', { d: `M${xs},${y} H${xL}`, class: `wire ${cls[i]}`, 'stroke-width': thick + 3 }),
        sv('path', { d: `M${xs},${y} H${xL}`, class: 'core', 'stroke-width': Math.max(1, thick * 0.45), opacity: 0.8 }));
    });
    // current: scrub its pill
    const cl = `${F(w.current)} A →`;
    const cw = cl.length * 7 + 16;
    const cx = clamp(xs + 22 + cw / 2, xs + cw / 2 + 4, Math.max(xs + cw / 2 + 4, xL - cw / 2 - 4));
    const cg = pad(null, 'cur', 'ew', 'Load current in A, scrub left or right', `${F(w.current)} A`);
    cg.append(sv('rect', { x: cx - cw / 2, y: wy[0] - 30, width: cw, height: 19, rx: 9.5, class: 'pill' }), txt(cx, wy[0] - 16.5, cl, 'm pill-t', 'middle'),
      sv('rect', { x: cx - cw / 2 - 3, y: wy[0] - 33, width: cw + 6, height: 25, rx: 12, class: 'ring' }));
    svg.append(cg);
    if (!three) svg.append(txt(cx, wy[1] + thick / 2 + 16, `← ${F(w.current)} A`, 'm sm soft', 'middle'));
    if (xL - xs > 260 || !narrow) {
      const mid = (xs + xL) / 2 + (xL - xs > 300 ? 60 : 0);
      if (xL - xs > 200) svg.append(txt(mid, wy[0] - 16, `${s.name}: ${F(s.R * 1000, 3)} mΩ/m · loses ${F(s.loss)} W`, 'm sm soft', 'middle'));
    }
    // the load: drag it
    const lg = pad(null, 'load', 'ew', 'Cable length one way: drag the load', `${F(w.length)} m`);
    lg.append(sv('rect', { x: xL, y: boxY0, width: loadW, height: boxY1 - boxY0, rx: 4, class: 'loadbox' }),
      txt(xL + loadW / 2, boxY0 + 20, 'LOAD', 'sm b soft', 'middle'),
      txt(xL + loadW / 2, boxY0 + 38, `${F(w.current)} A`, 'm b', 'middle'),
      txt(xL + loadW / 2, boxY0 + 54, `${F(w.voltage - s.dv, 4)} V`, `m sm ${bad ? 'danger' : 'soft'}`, 'middle'),
      txt(xL + loadW / 2, boxY0 + 72, '⇆', 'soft', 'middle'),
      sv('rect', { x: xL - 3, y: boxY0 - 3, width: loadW + 6, height: boxY1 - boxY0 + 6, rx: 6, class: 'ring' }));
    svg.append(lg);
    // length dimension and the ruler
    const yd = boxY1 + 14;
    svg.append(sv('line', { x1: xs, y1: yd, x2: xL, y2: yd, class: 'dim', 'marker-start': 'url(#wg-arr)', 'marker-end': 'url(#wg-arr)' }));
    const dl = `${F(w.length)} m one way` + (three ? ' · √3 in the drop' : ` · ${F(2 * w.length)} m of wire`);
    svg.append(sv('rect', { x: (xs + xL) / 2 - dl.length * 3.2 - 4, y: yd - 8, width: dl.length * 6.4 + 8, height: 15, class: 'bg' }),
      txt((xs + xL) / 2, yd + 4, dl, 'm sm b', 'middle'));
    const yr = H - 20;
    svg.append(sv('line', { x1: xa, y1: yr, x2: xb, y2: yr, class: 'tick' }));
    for (const m of [0.1, 0.3, 1, 3, 10, 30, 100, 300]) {
      const x = lenX(m);
      if (narrow && [0.3, 3, 30, 100].includes(m)) continue;
      svg.append(sv('line', { x1: x, y1: yr - 3, x2: x, y2: yr + 3, class: 'tick' }), txt(x, yr + 14, `${m}${m === 300 ? ' m' : ''}`, 'm sm soft', 'middle'));
    }
    svg.append(sv('path', { d: `M${xL},${yr - 7} l-5,-7 h10 Z`, class: 'arrow' }));
    st.geo.run = { xa, xb };
    runDraw.append(svg);
    runDraw.style.minHeight = '';
  }

  // ---------- sizes ----------
  function drawSizes() {
    const w = W_();
    sizeDraw.style.minHeight = `${sizeDraw.offsetHeight}px`; // keep the page still while redrawing
    sizeDraw.replaceChildren();
    if (!w) return;
    const W = Math.max(300, sizeDraw.clientWidth || 800);
    const narrow = W < 560;
    const n = narrow ? 5 : W < 760 ? 7 : 9;
    const [a, b] = windowOf(w, n);
    const gut = narrow ? 42 : 56;
    const cells = b - a + 1;
    const cw = (W - gut - 6) / cells;
    const insT = (d) => 0.25 + 0.12 * d;
    const dOut = Math.max(...w.list.slice(a, b + 1).map((s) => s.d + 2 * insT(s.d)));
    const k = Math.min((cw - 14) / dOut, 96 / dOut);
    const rMax = (dOut * k) / 2;
    const cy = 18 + rMax;
    const yName = cy + rMax + 18;
    const yB1 = yName + 30, yB2 = yB1 + 34;
    const H = yB2 + 26;
    const ii = inspIdx(w);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Conductor sizes around the pick' });
    svg.append(defs());
    svg.append(txt(4, yB1 + 4, 'drop', 'sm soft'), txt(4, yB2 + 4, 'rating', 'sm soft'));
    const ins = w.ins === 'xlpe' ? 'XLPE' : 'PVC';
    for (let i = a; i <= b; i++) {
      const s = w.list[i];
      const x0 = gut + (i - a) * cw, cx = x0 + cw / 2;
      const isBest = i === w.best;
      const g = sv('g', { class: `sz${i === ii ? ' insp' : ''}${isBest ? ' best' : ''}`, tabindex: 0, role: 'button', 'data-fk': `sz${i}`, 'data-sz': i,
        'aria-pressed': String(i === ii), 'aria-label': `${s.name}, ${F(s.area)} mm²: drop ${F(s.pct)} %, rating ${s.I == null ? 'beyond the table' : F(s.I) + ' A'}, ${s.ok ? 'fits' : s.why === 'drop' ? 'drop too big' : 'too hot'}` });
      g.append(sv('rect', { x: x0 + 2, y: 2, width: cw - 4, height: H - 4, rx: 5, class: 'cell' }));
      const ro = ((s.d + 2 * insT(s.d)) * k) / 2, rc = (s.d * k) / 2;
      g.append(sv('circle', { cx, cy, r: ro, class: 'jacket' }), sv('circle', { cx, cy, r: rc, class: w.metal === 'al' ? 'al' : 'cu' }));
      // strands: flexible cores show many fine strands, stranded a few
      if (rc > 6 && w.metal !== 'al') {
        const ns = w.strand === 'flex' ? 3 : 2;
        for (let ring = 1; ring <= ns; ring++) g.append(sv('circle', { cx, cy, r: (rc * ring) / (ns + 0.6), class: 'strand' }));
      }
      if (isBest) g.append(txt(cx, 13, 'USE', 'sm b ok-t', 'middle'));
      g.append(txt(cx, yName, s.name, `m ${isBest ? 'b' : ''}`, 'middle'), txt(cx, yName + 13, `${F(s.area)} mm²`, 'm sm soft', 'middle'));
      // drop bar: the limit is the tick in the middle
      const bw = Math.min(cw - 16, 90), bx = cx - bw / 2;
      const fd = clamp(s.pct / (2 * w.drop), 0, 1);
      g.append(sv('rect', { x: bx, y: yB1 - 5, width: bw, height: 8, rx: 2, class: 'bar-bg' }),
        sv('rect', { x: bx, y: yB1 - 5, width: Math.max(1, fd * bw), height: 8, rx: 2, class: s.dv <= w.dvMax ? 'bar-ok' : 'bar-bad' }),
        sv('line', { x1: bx + bw / 2, y1: yB1 - 8, x2: bx + bw / 2, y2: yB1 + 6, class: 'lim' }),
        txt(cx, yB1 + 16, `${F(s.pct, 2)} %`, `m sm ${s.dv <= w.dvMax ? 'soft' : 'danger'}`, 'middle'));
      const fi = s.I == null ? 1 : clamp(s.I / (2 * w.current), 0, 1);
      const hot = s.I == null || s.I < w.current;
      g.append(sv('rect', { x: bx, y: yB2 - 5, width: bw, height: 8, rx: 2, class: 'bar-bg' }),
        sv('rect', { x: bx, y: yB2 - 5, width: Math.max(1, fi * bw), height: 8, rx: 2, class: hot ? 'bar-bad' : 'bar-ok' }),
        sv('line', { x1: bx + bw / 2, y1: yB2 - 8, x2: bx + bw / 2, y2: yB2 + 6, class: 'lim' }),
        txt(cx, yB2 + 16, s.I == null ? 'off table' : `${F(s.I)} A`, `m sm ${hot ? 'danger' : 'soft'}`, 'middle'));
      svg.append(g);
    }
    if (a > 0) svg.append(txt(gut - 4, cy + 4, '‹', 'b soft', 'end'));
    if (b < w.list.length - 1) svg.append(txt(W - 2, cy + 4, '›', 'b soft', 'end'));
    svg.append(txt(4, cy + 4, ins, 'sm soft'));
    sizeDraw.append(svg);
    sizeDraw.style.minHeight = '';
    const best = w.list[w.best];
    sizeHead.replaceChildren();
    if (best) {
      sizeHead.append(h('b', { style: 'color:var(--ok)' }, `use ${best.name}`),
        ` · set by ${w.byDrop === w.best ? 'voltage drop' : 'current'} · drop needs ≥ ${F(w.aDrop)} mm²`);
    } else sizeHead.append(h('b', { style: 'color:var(--danger)' }, 'no size fits'), ` · drop needs ≥ ${F(w.aDrop)} mm²`);
  }

  // ---------- installation ----------
  function drawInstall() {
    const w = W_();
    tiles.replaceChildren(...METHODS.map(([m, t]) => {
      const b = h('button', { type: 'button', class: 'wg-tile', 'aria-pressed': String(w ? w.method === m : m === 'C'),
        title: { E: 'In free air (method E)', C: 'Clipped to a surface (method C)', B1: 'In conduit or trunking (method B1)', A1: 'In thermal insulation (method A1)' }[m],
        onclick: () => ctx.set('method', m) }, methodPict(m), t);
      return b;
    }));
    sceneDraw.style.minHeight = `${sceneDraw.offsetHeight}px`; // keep the page still while redrawing
    sceneDraw.replaceChildren();
    chain.replaceChildren();
    if (!w) return;
    const W = Math.max(260, sceneDraw.clientWidth || 360);
    const H = 100;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `${w.nG} circuits, ${w.methName}` });
    const nShow = Math.min(w.nG, 12);
    const cores = w.circuit === 'ac3' ? 3 : 2;
    const r = 15;
    const cyc = 54;
    const pos = [];
    if (w.method === 'B1') {
      // packed inside a conduit
      const R = clamp(r * (1 + Math.sqrt(nShow) * 1.25), 22, 50);
      for (let i = 0; i < nShow; i++) {
        const ang = i === 0 && nShow > 1 ? 0 : (i / nShow) * Math.PI * 2;
        const rad = nShow === 1 ? 0 : R - r - 3 - (i % 2 ? 10 : 0);
        pos.push([W / 2 + Math.cos(ang) * rad * 0.9, cyc + 4 + Math.sin(ang) * rad * 0.9]);
      }
      svg.append(sv('rect', { x: 8, y: H - 10, width: W - 16, height: 8, class: 'wallf' }), sv('circle', { cx: W / 2, cy: cyc + 4, r: R + 2, class: 'conduit' }));
    } else {
      const gap = w.method === 'E' ? 10 : 2;
      const span = nShow * (2 * r) + (nShow - 1) * gap;
      const x0 = W / 2 - span / 2 + r;
      for (let i = 0; i < nShow; i++) pos.push([x0 + i * (2 * r + gap), w.method === 'C' ? H - 14 - r : cyc]);
      if (w.method === 'C') svg.append(sv('rect', { x: 8, y: H - 14, width: W - 16, height: 12, class: 'wallf' }));
      if (w.method === 'A1') svg.append(sv('rect', { x: 8, y: 24, width: W - 16, height: H - 30, rx: 4, class: 'wool' }));
      if (w.method === 'E') svg.append(sv('path', { d: `M12,${cyc - r - 12} H${W - 12} M12,${cyc + r + 12} H${W - 12}`, class: 'air' }));
    }
    pos.forEach(([x, y], i) => {
      svg.append(sv('circle', { cx: x, cy: y, r, class: 'jacket', 'stroke-width': i === 0 ? 2 : 1, stroke: i === 0 ? 'var(--accent)' : null }));
      for (let c = 0; c < cores; c++) {
        const ang = (c / cores) * Math.PI * 2 + Math.PI / 2;
        svg.append(sv('circle', { cx: x + Math.cos(ang) * r * 0.42, cy: y + Math.sin(ang) * r * 0.42, r: r * 0.3, class: w.metal === 'al' ? 'al' : 'cu' }));
      }
    });
    if (w.nG > nShow) svg.append(txt(W - 12, 16, `+${w.nG - nShow} more`, 'sm soft', 'end'));
    svg.append(txt(12, 16, `${w.nG} loaded circuit${w.nG > 1 ? 's' : ''} · ${F(w.Ta)} °C around`, 'sm soft'));
    sceneDraw.append(svg);
    sceneDraw.style.minHeight = '';
    // the derating chain, as numbers
    const best = w.list[w.best];
    const insName = w.ins === 'xlpe' ? 'XLPE 90 °C' : 'PVC 70 °C';
    chain.append(h('div', {}, `method ${w.method} `, h('b', {}, `×${F(w.kMeth)}`), ` · ${F(w.Ta)} °C `, h('b', {}, `×${F(w.kAmb)}`),
      ` · ${w.nG} bundled `, h('b', {}, `×${F(w.kGrp)}`), w.metal === 'al' ? [' · Al ', h('b', {}, '×0.78')] : null, ' → ', h('b', {}, `×${F(w.derate)}`),
      h('span', {}, ` (${insName})`)));
    if (best) chain.append(h('div', {}, `${best.name} rated `, h('b', { class: 'ok' }, `${F(best.I)} A`), ` ≥ ${F(w.current)} A · loses ${F(best.loss)} W · ${F(w.current / best.area)} A/mm²`));
  }

  // ---------- pointer and keys ----------
  const pt = (box, e) => {
    const svg = box.querySelector('svg'); const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
    return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
  };
  const niceLen = (m) => (m < 1 ? Math.round(m * 20) / 20 : m < 10 ? Math.round(m * 10) / 10 : m < 100 ? Math.round(m) : Math.round(m / 5) * 5);
  runDraw.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-drag]'); const w = W_(); if (!hEl || !w) return;
    e.preventDefault();
    runDraw.setPointerCapture(e.pointerId);
    const p = pt(runDraw, e);
    const kind = hEl.getAttribute('data-drag');
    const svg = runDraw.querySelector('svg');
    // the profile scale is frozen for the drag
    const yP0 = 30, yP1 = 128, ii = inspIdx(w), s = w.list[ii];
    const span = Math.max(w.dvMax * 1.9, Math.min(s.dv * 1.1, w.dvMax * 4));
    st.drag = { kind, x: p.x, y: p.y, w: { ...w }, span, yP0, yP1, W: svg.viewBox.baseVal.width };
    hEl.focus({ preventScroll: true });
  });
  runDraw.addEventListener('pointermove', (e) => {
    const d = st.drag; if (!d) return;
    const p = pt(runDraw, e);
    if (d.kind === 'load') {
      const g = st.geo.run;
      const lenX0 = g.xa + (Math.log10(clamp(d.w.length, LMIN, LMAX) / LMIN) / Math.log10(LMAX / LMIN)) * (g.xb - g.xa);
      const x = lenX0 + (p.x - d.x);
      const f = clamp((x - g.xa) / (g.xb - g.xa), 0, 1);
      setSoon({ length: num(niceLen(LMIN * Math.pow(LMAX / LMIN, f)), 2) });
    } else if (d.kind === 'cur') {
      const step = d.w.current >= 50 ? 1 : d.w.current >= 5 ? 0.5 : 0.1;
      setSoon({ current: num(Math.max(step, Math.round((d.w.current + ((p.x - d.x) / 8) * step) / step) * step), 2) });
    } else if (d.kind === 'drop') {
      const v = d.w.voltage - ((p.y - d.yP0) / (d.yP1 - d.yP0)) * d.span;
      setSoon({ drop: num(clamp(Math.round(((d.w.voltage - v) / d.w.voltage) * 1000) / 10, 0.5, 20), 1) });
    }
  });
  const end = () => { if (st.drag) { st.drag = null; redraw(renderAll); } };
  runDraw.addEventListener('pointerup', end);
  runDraw.addEventListener('pointercancel', end);
  sizeDraw.addEventListener('click', (e) => {
    const g = e.target.closest('[data-sz]'); const w = W_(); if (!g || !w) return;
    const i = Number(g.getAttribute('data-sz'));
    st.insp = i; st.inspName = w.list[i].name;
    redraw(() => { drawRun(); drawSizes(); });
    root.querySelector(`[data-fk="sz${i}"]`)?.focus({ preventScroll: true });
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-fk]'); const w = W_(); if (!t || !w) return;
    const fk = t.getAttribute('data-fk');
    if (fk.startsWith('sz')) {
      const i = Number(fk.slice(2));
      const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : (e.key === 'Enter' || e.key === ' ') ? i : null;
      if (j == null || !w.list[j]) return;
      e.preventDefault();
      st.insp = j; st.inspName = w.list[j].name;
      redraw(() => { drawRun(); drawSizes(); });
      root.querySelector(`[data-fk="sz${j}"]`)?.focus({ preventScroll: true });
      return;
    }
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    const fine = e.shiftKey;
    let upd = null;
    if (fk === 'load') {
      const m = w.length;
      const step = fine ? (m < 10 ? 0.1 : 1) : m < 1 ? 0.1 : m < 10 ? 1 : m < 100 ? 5 : 25;
      upd = { length: num(clamp(niceLen(m + dir * step), LMIN, LMAX), 2) };
    } else if (fk === 'cur') {
      upd = { current: num(Math.max(0.1, w.current + dir * (fine ? 0.1 : 1)), 2) };
    } else if (fk === 'drop') {
      upd = { drop: num(clamp(w.drop + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) * (fine ? 0.1 : 0.5), 0.5, 20), 1) };
    }
    if (upd) { e.preventDefault(); ctx.setMany(upd); }
  });

  // ---------- result -> page ----------
  const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
  const seg = (el, key, opts, def) => el.replaceChildren(...opts.map(([v, t, title]) => h('button', { type: 'button', title: title || null,
    'aria-pressed': String((ctx.raw[key] || def) === v), onclick: () => ctx.set(key, v) }, t)));
  function renderAll() {
    const raw = ctx.raw, res = ctx.result || {};
    for (const f of fields) {
      sync(f.inp, raw[f.key]);
      f.inp.classList.toggle('bad', String(raw[f.key] ?? '').trim() !== '' && ctx.parseEng(raw[f.key]) == null);
    }
    seg(segCircuit, 'circuit', [['dc', 'DC'], ['ac1', 'AC 1φ'], ['ac3', 'AC 3φ']], 'dc');
    seg(segSizes, 'sizes', [['awg', 'AWG'], ['metric', 'mm²']], 'awg');
    seg(segMetal, 'metal', [['cu', 'Cu'], ['al', 'Al']], 'cu');
    seg(segStrand, 'strand', [['stranded', 'Solid/stranded', 'Class 1-2'], ['flex', 'Flexible', 'Class 5-6']], 'stranded');
    seg(segIns, 'ins', [['pvc', 'PVC 70°'], ['xlpe', 'XLPE 90°']], 'pvc');
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    drawInstall();
    if (!res.wire) {
      runDraw.replaceChildren(h('div', { class: 'wg-foot', style: 'padding:30px 12px' }, (res.warnings || []).join(' ')));
      sizeDraw.replaceChildren(); sizeHead.textContent = '';
      return;
    }
    drawRun();
    drawSizes();
  }
  ctx.onResult(() => redraw(renderAll));
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => redraw(renderAll));
  }).observe(root);
}
