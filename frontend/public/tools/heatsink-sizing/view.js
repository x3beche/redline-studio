// Heat Sink Sizing: the page is the thermal path. A section through the part,
// its interface and the heat sink, with the temperature profile drawn over it
// on a real °C scale: junction, case, sink and ambient as dots, the drops
// between them as slopes. Drag the Tj max, margin and ambient lines on the
// axis and the heat arrow into the die; click the interface to pick a
// material. Below, the catalogue sink classes on a θSA ruler; beside, the
// sink's size at each air flow as cubes to click. Every temperature, θ and
// size drawn comes from run()'s result (result.path).

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
const f3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const f0 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v)));
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};

// Case-to-sink interfaces for a TO-220-sized contact (rule of thumb, catalogue
// ranges); a TO-247 is roughly half. Sets θCS only.
const TIMS = [
  ['Phase-change pad', 0.4], ['Thermal grease, thin', 0.5], ['Graphite pad', 0.6],
  ['Dry metal contact', 1.2], ['Mica + grease (insulated)', 1.3], ['Silicone pad (insulated)', 1.5],
];
const FLOWS = [['natural', 'still air'], ['1', '1 m/s'], ['2.5', '2.5 m/s'], ['5', '5 m/s']];

export function page(root, ctx) {
  let res = null, P = null;
  let drag = null;      // {kind, frozen}
  let focusKey = null;  // which handle to keep focused across redraws
  let menu = null;
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));

  // ---------- top strip: every number, typed ----------
  const fields = {};
  const numField = (key, label, unit, title, sw) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'hs-num', title: title || null }, sw ? h('i', { class: 'hs-sw', style: `--c: var(${sw})` }) : null, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    fields[key] = inp;
    return w;
  };
  const top = h('div', { class: 'hs-top' },
    h('div', { class: 'hs-group' }, h('span', { class: 'hs-cap' }, 'Heat'), numField('p', 'P', 'W', 'Power the part dissipates', '--tool-hot')),
    h('div', { class: 'hs-group' }, h('span', { class: 'hs-cap' }, 'Limits'),
      numField('tjmax', 'Tj max', '°C', 'Maximum junction temperature (datasheet)', '--danger'),
      numField('margin', 'margin', '°C', 'Design margin below Tj max'),
      numField('ta', 'Ta', '°C', 'Ambient air at the heat sink', '--tool-cold')),
    h('div', { class: 'hs-group' }, h('span', { class: 'hs-cap' }, 'Path'),
      numField('rjc', 'θJC', '°C/W', 'Junction to case (datasheet)'),
      numField('rcs', 'θCS', '°C/W', 'Case to sink: the interface', '--tool-tim'),
      numField('rja', 'θJA bare', '°C/W', 'Package junction to ambient with no sink (optional)')));

  // ---------- the section ----------
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': 'Section through the part and heat sink with the temperature profile' });
  const box = h('div', { class: 'hs-box' }, svg);
  const stageWarn = h('div', { class: 'hs-warns', 'aria-live': 'polite' });
  const stage = h('section', { class: 'hs-stage' },
    h('div', { class: 'hs-head' }, h('span', { class: 'hs-cap' }, 'Thermal path, temperature to scale'),
      h('span', { class: 'hs-hint' }, 'drag the lines on the axis and the heat arrow · click the interface')),
    box, stageWarn);

  // ---------- the ruler ----------
  const rsvg = sv(null, 'svg', { role: 'img', 'aria-label': 'Heat sink classes against the allowed sink-to-ambient resistance' });
  const ruler = h('section', { class: 'hs-ruler' },
    h('div', { class: 'hs-head' }, h('span', { class: 'hs-cap' }, 'Which heat sink: catalogue classes by θSA, °C/W (log)'),
      h('span', { class: 'hs-hint' }, 'green: every one of the class is good enough')),
    h('div', { class: 'hs-box' }, rsvg));

  // ---------- the cubes ----------
  const cubes = h('div', { class: 'hs-cubes', role: 'radiogroup', 'aria-label': 'Air flow' });
  const cubeNote = h('div', { class: 'hs-notes' });
  const side = h('aside', { class: 'hs-side' },
    h('section', { class: 'hs-card hs-flows' },
      h('div', { class: 'hs-head' }, h('span', { class: 'hs-cap' }, 'Sink size by air flow'), h('span', { class: 'hs-hint' }, 'click to choose')),
      cubes, cubeNote),
    ctx.outputs);

  root.append(h('div', { class: 'hs' }, top, stage, ruler, side));
  new ResizeObserver(() => { drawStage(); drawRuler(); }).observe(box);
  new ResizeObserver(() => drawRuler()).observe(rsvg.parentNode);

  ctx.onResult((r) => {
    res = r; P = r.path || null;
    const raw = ctx.raw;
    for (const [k, inp] of Object.entries(fields)) {
      if (document.activeElement !== inp) inp.value = raw[k] ?? '';
      inp.classList.toggle('hs-bad', String(raw[k] ?? '').trim() !== '' && ctx.input[k] == null);
    }
    stageWarn.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    drawStage(); drawRuler(); drawCubes();
  });

  // ---------- drag and keys on the handles ----------
  svg.addEventListener('pointerdown', (e) => {
    const hd = e.target.closest?.('[data-h]');
    if (!hd || !P) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    drag = { kind: hd.dataset.h, frozen: scaleNow, y0: e.clientY, p0: P.p };
    focusKey = hd.dataset.h;
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const y = e.clientY - r.top;
    const sc = drag.frozen;
    const T = Math.round(sc.inv(y));
    if (drag.kind === 'tjmax') ctx.set('tjmax', String(T));
    else if (drag.kind === 'margin') ctx.set('margin', String(clamp(Math.round((P.tjmax - T)), 0, 200)));
    else if (drag.kind === 'ta') ctx.set('ta', String(T));
    else if (drag.kind === 'p') {
      const v = drag.p0 * Math.exp(-(e.clientY - drag.y0) / 90);
      ctx.set('p', String(roundP(clamp(v, 0.1, 2000))));
    }
  });
  const endDrag = () => { if (drag) { drag = null; drawStage(); } };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('keydown', (e) => {
    const hd = e.target.closest?.('[data-h]');
    if (!hd || !P) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    focusKey = hd.dataset.h;
    const k = hd.dataset.h;
    if (k === 'tjmax') ctx.set('tjmax', String(Math.round(P.tjmax + d * step)));
    else if (k === 'margin') ctx.set('margin', String(clamp(Math.round(P.margin - d * step), 0, 200)));
    else if (k === 'ta') ctx.set('ta', String(Math.round(P.ta + d * step)));
    else if (k === 'p') ctx.set('p', String(roundP(clamp(P.p * (d > 0 ? (e.shiftKey ? 1.25 : 1.05) : 1 / (e.shiftKey ? 1.25 : 1.05)), 0.1, 2000))));
  });
  svg.addEventListener('focusout', () => { if (!drag) setTimeout(() => { if (!svg.contains(document.activeElement)) focusKey = null; }, 0); });

  function roundP(v) { const d = v < 10 ? 10 : v < 100 ? 1 : 0.2; return Math.round(v * d) / d; }

  // ---------- the section ----------
  let scaleNow = null;
  function drawStage() {
    const W = box.clientWidth, H = box.clientHeight;
    if (W < 40 || H < 40) return;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!P) {
      sv(svg, 'text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'hs-bare-t hs-badt' }, (res?.warnings || ['Fill in the power and temperatures.'])[0].slice(0, 90));
      return;
    }
    const narrow = W < 560;
    const ax = narrow ? 42 : 58, x0 = ax + 14, x1 = W - (narrow ? 8 : 14);
    const top = 24, bot = H - 26;
    // temperature scale (frozen while a line is dragged, so it does not run away)
    // the profile: the design point, or when no sink can do it, the part on a perfect sink
    const T = P.ok ? { tj: P.tj, tc: P.tc, ts: P.ts } : P.perfect;
    let sc = drag?.frozen;
    if (!sc) {
      const span = Math.max(20, P.tjmax - P.ta);
      const lo = Math.min(P.ta, T.ts, T.tc) - 0.1 * span, hi = Math.max(P.tjmax, T.tj) + 0.16 * span;
      const k = (bot - top) / (hi - lo);
      sc = { lo, hi, y: (t) => bot - (t - lo) * k, inv: (y) => lo + (bot - y) / k };
    }
    scaleNow = sc;
    const Y = sc.y;
    const fx = (f) => x0 + f * (x1 - x0);

    const defs = sv(svg, 'defs');
    const pat = sv(defs, 'pattern', { id: 'hs-hatch', width: '7', height: '7', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    sv(pat, 'line', { x1: 0, y1: 0, x2: 0, y2: 7 });
    const mk = sv(defs, 'marker', { id: 'hs-ar', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto' });
    sv(mk, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'hs-wind-h' });

    // axis and grid
    const st = niceStep(sc.hi - sc.lo, Math.max(3, Math.floor((bot - top) / 46)));
    sv(svg, 'line', { x1: ax, x2: ax, y1: top - 8, y2: bot, class: 'hs-axis' });
    for (let t = Math.ceil(sc.lo / st) * st; t <= sc.hi + 1e-9; t += st) {
      sv(svg, 'line', { x1: ax + 1, x2: x1, y1: Y(t), y2: Y(t), class: 'hs-grid' });
      sv(svg, 'line', { x1: ax - 4, x2: ax, y1: Y(t), y2: Y(t), class: 'hs-tick' });
      sv(svg, 'text', { x: ax - 7, y: Y(t) + 4, 'text-anchor': 'end', class: 'hs-tick-t' }, f3(t));
    }
    sv(svg, 'text', { x: ax - 7, y: top - 12, 'text-anchor': 'end', class: 'hs-tick-t' }, '°C');

    // the path as a layered wall, left to right: heat in | die | case | interface | sink base | fins | air
    const HH = bot - top;
    const cubeHi = P.cube ? P.cube[1] : null;
    const finEnd = cubeHi ? clamp(0.27 + (cubeHi / 110) * 0.36, 0.4, 0.6) : 0.44;
    const Z = { die: [0.08, 0.12], tab: [0.12, 0.19], tim: [0.19, 0.215], base: [0.215, 0.26], fins: [0.26, finEnd] };
    const airX = finEnd + 0.03;
    const sy0 = top + 4, sy1 = bot;
    const slab = (z, cls, extra = {}) => sv(svg, 'rect', { x: fx(z[0]), y: sy0, width: Math.max(3, fx(z[1]) - fx(z[0])), height: sy1 - sy0, class: cls, ...extra });
    slab(Z.die, 'hs-die');
    slab(Z.tab, 'hs-tab');
    const sinkCls = `hs-sink${P.ok ? '' : ' hs-none'}`;
    slab(Z.base, sinkCls);
    const nf = clamp(Math.round(HH / 30), 6, 16);
    const pitch = (sy1 - sy0) / nf;
    const len = 12 + ({ natural: 0, 1: 10, 2.5: 20, 5: 32 }[P.air] || 0);
    for (let i = 0; i < nf; i++) {
      const y = sy0 + pitch * (i + 0.5) - 2.5;
      sv(svg, 'rect', { x: fx(Z.fins[0]), y, width: fx(Z.fins[1]) - fx(Z.fins[0]), height: 5, class: sinkCls });
      if (i < nf - 1) sv(svg, 'line', { x1: fx(Z.fins[1]) + 6, x2: fx(Z.fins[1]) + 6 + len, y1: y + pitch / 2 + 2.5, y2: y + pitch / 2 + 2.5, class: 'hs-wind', 'marker-end': 'url(#hs-ar)' });
    }
    // interface: click for a material
    const timR = slab(Z.tim, 'hs-tim', { 'pointer-events': 'none' });
    const timHit = sv(svg, 'rect', { x: fx(Z.tim[0]) - 6, y: sy0, width: fx(Z.tim[1]) - fx(Z.tim[0]) + 12, height: sy1 - sy0, class: 'hs-timhit',
      tabindex: '0', role: 'button', 'aria-label': `Interface θCS ${f3(P.theta.cs)} °C/W: choose a material` });
    svg.insertBefore(timHit, timR);
    timHit.addEventListener('click', (e) => openMenu(e, timHit));
    timHit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(e, timHit); } });
    // captions under the wall
    const zc = (a, b, t, anchor = 'middle') => sv(svg, 'text', { x: anchor === 'middle' ? (fx(a) + fx(b)) / 2 : fx(a), y: bot + 17, 'text-anchor': anchor, class: 'hs-zone' }, t);
    if (narrow) zc(Z.die[0], Z.tim[1], 'part');
    else { zc(Z.die[0], Z.die[1], 'die'); zc(Z.tab[0], Z.tab[1], 'case'); zc(Z.tim[0] - 0.01, Z.tim[1] + 0.01, 'tim'); }
    zc(Z.fins[0] - 0.04, Z.fins[1], narrow ? 'sink' : 'heat sink'); zc(airX, 0, `air, ${FLOWS.find((f) => f[0] === P.air)?.[1] || ''}`, 'start');
    // sink size over the fins
    if (P.cube) {
      const t = sv(svg, 'text', { x: narrow ? x1 - 2 : fx(Z.fins[0]), y: sy0 - 7, 'text-anchor': narrow ? 'end' : 'start', class: 'hs-sinklab' });
      sv(t, 'tspan', {}, `≈ ${f0(P.cube[0])}–${f0(P.cube[1])} mm cube`);
      if (!narrow) sv(t, 'tspan', { class: 'hs-soft' }, `  ${f3(P.volume[0])}–${f3(P.volume[1])} cm³`);
    } else {
      sv(svg, 'text', { x: fx(Z.fins[0]), y: sy0 - 7, class: 'hs-bare-t hs-badt' }, 'no heat sink is good enough');
    }

    // limits: Tj max, the margin band, ambient
    sv(svg, 'rect', { x: ax, y: Y(P.tjmax), width: x1 - ax, height: Math.max(0, Y(P.tj) - Y(P.tjmax)), class: 'hs-band' });
    sv(svg, 'line', { x1: ax, x2: x1, y1: Y(P.tjmax), y2: Y(P.tjmax), class: 'hs-tjmax' });
    sv(svg, 'line', { x1: ax, x2: x1, y1: Y(P.ta), y2: Y(P.ta), class: 'hs-ta' });
    const colX = x1 - 196, colW = 12;
    const lt = (y, cls, a, b) => { const t = sv(svg, 'text', { x: narrow ? x1 - 2 : colX - 12, y, 'text-anchor': 'end', class: `hs-line-t hs-halo ${cls}` }); sv(t, 'tspan', {}, a); if (b) sv(t, 'tspan', { class: 'hs-soft' }, b); };
    lt(Y(P.tjmax) - 6, 'hs-hot', `Tj max ${f3(P.tjmax)} °C`, P.margin > 0 ? `  margin ${f3(P.margin)}` : '');
    lt(Y(P.ta) + 16, 'hs-cold', `ambient ${f3(P.ta)} °C`);
    // the bare part, no sink
    if (P.tjBare != null) {
      const need = P.tjBare > P.tj;
      if (P.tjBare <= sc.hi) {
        sv(svg, 'line', { x1: fx(0), x2: fx(Z.tab[1]), y1: Y(P.tjBare), y2: Y(P.tjBare), class: 'hs-bare' });
        sv(svg, 'text', { x: fx(0), y: Y(P.tjBare) - 5, class: `hs-bare-t hs-halo${need ? ' hs-badt' : ''}` }, `no sink: Tj ${f3(P.tjBare)} °C${need ? ', too hot' : ', fine'}`);
      } else {
        sv(svg, 'text', { x: fx(0), y: sy0 - 7, class: 'hs-bare-t hs-badt' }, `↑ no sink: Tj ${f3(P.tjBare)} °C`);
      }
    }

    // the temperature profile through the wall
    const xs = { j0: fx(Z.die[0]), j1: fx(Z.die[1]), c: fx(Z.tab[1]), s0: fx(Z.tim[1]), s1: fx(Z.fins[0] + 0.02), a0: fx(airX), a1: x1 };
    const d = `M${xs.j0},${Y(T.tj)} H${xs.j1} L${xs.c},${Y(T.tc)} L${xs.s0},${Y(T.ts)} H${xs.s1} L${xs.a0},${Y(P.ta)} H${xs.a1}`;
    sv(svg, 'path', { d, class: `hs-profile${P.ok ? '' : ' hs-over'}` });
    const node = (x, t, a, b, anchor, dx, dy) => {
      sv(svg, 'circle', { cx: x, cy: Y(t), r: 4.5, class: 'hs-node' });
      if (!a) return;
      const tx = sv(svg, 'text', { x: x + dx, y: Y(t) + dy, 'text-anchor': anchor, class: 'hs-node-t hs-halo' });
      sv(tx, 'tspan', {}, a); if (b) sv(tx, 'tspan', { class: 'hs-soft' }, b);
    };
    node((xs.j0 + xs.j1) / 2, T.tj, `Tj ${f3(T.tj)}`, P.ok ? '' : ' even on a perfect sink', 'start', -10, -10);
    node(xs.c, T.tc, `case ${f3(T.tc)}`, '', 'start', 7, -9);
    node(xs.s1, T.ts, `sink ${f3(T.ts)}`, T.ts > 70 ? ' hot to touch' : '', 'start', 7, -9);
    node(xs.a0, P.ta, '', '');
    // the answer, on the sink-to-air slope
    const ax2 = (xs.s1 + xs.a0) / 2, ay2 = P.ok ? (Y(P.ts) + Y(P.ta)) / 2 : Y(P.ta) - 40;
    const ans = sv(svg, 'g', { class: `hs-answer${P.ok ? '' : ' hs-bad'}` });
    const label = P.ok ? `θSA ≤ ${f3(P.theta.sa)} °C/W` : `no θSA is enough: ${f3(P.perfect.over)} °C over`;
    const tw = label.length * 7.9 + 16;
    const bx = clamp(ax2 - tw / 2, x0, x1 - tw);
    sv(ans, 'rect', { x: bx, y: ay2 - 13, width: tw, height: 24, rx: 4 });
    sv(ans, 'text', { x: bx + tw / 2, y: ay2 + 4, 'text-anchor': 'middle' }, label);

    // the budget column: Tj max down to ambient, split into the drops
    let segs = [
      { a: P.tjmax, b: P.tj, cls: 'hs-seg-m', t: 'margin', v: `${f3(P.margin)} °C` },
      { a: P.tj, b: P.tc, cls: 'hs-seg-jc', t: `θJC ${f3(P.theta.jc)}`, v: `${f3(P.drop.jc)} °C` },
      { a: P.tc, b: P.ts, cls: 'hs-seg-cs', t: `θCS ${f3(P.theta.cs)}`, v: `${f3(P.drop.cs)} °C` },
      { a: P.ts, b: P.ta, cls: 'hs-seg-sa', t: `θSA ${f3(P.theta.sa)}`, v: `${f3(P.drop.sa)} °C` },
    ];
    if (!P.ok) segs.splice(1, 3,
      { a: P.perfect.tj, b: P.perfect.tc, cls: 'hs-seg-jc hs-seg-over', t: `θJC ${f3(P.theta.jc)}`, v: `${f3(P.drop.jc)} °C` },
      { a: P.perfect.tc, b: P.ta, cls: 'hs-seg-cs', t: `θCS ${f3(P.theta.cs)}`, v: `${f3(P.drop.cs)} °C` });
    segs = segs.filter((sg) => Math.abs(sg.a - sg.b) > 1e-9).sort((p1, p2) => Math.max(p2.a, p2.b) - Math.max(p1.a, p1.b));
    const colG = sv(narrow ? null : svg, 'g', { class: 'hs-col' });
    const colTop = Y(Math.max(P.tjmax, T.tj));
    sv(colG, 'rect', { x: colX - 4, y: colTop - 22, width: x1 - colX + 4, height: Y(P.ta) - colTop + 30, class: 'hs-col-bg' });
    sv(colG, 'text', { x: colX, y: colTop - 8, class: 'hs-zone' }, narrow ? 'budget' : 'budget, P × θ');
    let lastY = -1e9;
    for (const sg of segs) {
      const ya = Y(Math.max(sg.a, sg.b)), yb = Y(Math.min(sg.a, sg.b));
      sv(colG, 'rect', { x: colX, y: ya, width: colW, height: Math.max(1, yb - ya), class: `hs-seg ${sg.cls}` });
      let ly = Math.max((ya + yb) / 2 + 4, lastY + 15);
      lastY = ly;
      if (Math.abs(ly - 4 - (ya + yb) / 2) > 3) sv(colG, 'path', { d: `M${colX + colW},${(ya + yb) / 2} L${colX + colW + 5},${ly - 4}`, class: 'hs-drop' });
      const t = sv(colG, 'text', { x: colX + colW + 7, y: ly, class: 'hs-drop-t' });
      sv(t, 'tspan', { class: 'hs-v' }, narrow ? sg.v : sg.t); if (!narrow) sv(t, 'tspan', {}, `  ${sg.v}`);
    }

    // handles on the axis and the heat arrow
    const handle = (key, y, cls, label, now) => {
      const g2 = sv(svg, 'g', { class: `hs-handle ${cls}`, 'data-h': key, tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuenow': now });
      sv(g2, 'rect', { x: ax - 12, y: y - 10, width: 24, height: 20, class: 'hs-hit' });
      sv(g2, 'circle', { cx: ax, cy: y, r: 10, class: 'hs-ring' });
      if (key === 'margin') sv(g2, 'path', { d: `M${ax},${y - 7} L${ax + 7},${y} L${ax},${y + 7} L${ax - 7},${y} z`, class: 'hs-knob' });
      else sv(g2, 'circle', { cx: ax, cy: y, r: 6.5, class: 'hs-knob' });
    };
    handle('ta', Y(P.ta), 'hs-h-cold', `Ambient ${f3(P.ta)} °C: drag or arrow keys`, P.ta);
    if (P.margin > 0) handle('margin', Y(P.tj), 'hs-h-margin', `Margin ${f3(P.margin)} °C: drag or arrow keys`, P.margin);
    handle('tjmax', Y(P.tjmax), 'hs-h-hot', `Tj max ${f3(P.tjmax)} °C: drag or arrow keys`, P.tjmax);
    // heat arrow into the die from the left, thicker with more power; its knob drags up and down
    const ay = sy0 + (sy1 - sy0) * 0.62;
    const aw = clamp(5 + Math.log10(Math.max(P.p, 0.1) + 1) * 10, 5, 34);
    const tail = fx(0) + 10, tip = fx(Z.die[0]) - 1;
    if (tip - tail > 26) sv(svg, 'path', { d: `M${tail},${ay - aw / 2} H${tip - 12} V${ay - aw / 2 - 6} L${tip},${ay} L${tip - 12},${ay + aw / 2 + 6} V${ay + aw / 2} H${tail} z`, class: 'hs-heat' });
    const hp = sv(svg, 'g', { class: 'hs-handle hs-h-p', 'data-h': 'p', tabindex: '0', role: 'slider', 'aria-label': `Power ${f3(P.p)} W: drag up or down, or arrow keys`, 'aria-valuenow': P.p });
    sv(hp, 'rect', { x: tail - 14, y: ay - 14, width: 28, height: 28, class: 'hs-hit' });
    sv(hp, 'circle', { cx: tail, cy: ay, r: 11, class: 'hs-ring' });
    sv(hp, 'circle', { cx: tail, cy: ay, r: 7.5, class: 'hs-knob' });
    sv(svg, 'text', { x: tail - 6, y: ay - aw / 2 - 12, class: 'hs-heat-t hs-halo' }, `P ${f3(P.p)} W`);
    sv(svg, 'text', { x: tail - 6, y: ay + aw / 2 + 22, class: 'hs-drop-t' }, '↕ drag');
    if (focusKey) svg.querySelector(`[data-h="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  // ---------- interface menu ----------
  function openMenu(e, anchor) {
    closeMenu();
    const r = stage.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const cur = ctx.input.rcs;
    menu = h('div', { class: 'hs-menu', role: 'menu' },
      h('div', { class: 'hs-menu-head' }, 'Case-to-sink interface θCS, TO-220 size (a TO-247 is about half)'),
      TIMS.map(([t, v]) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(cur === v),
        onclick: () => { ctx.set('rcs', String(v)); closeMenu(); anchor.focus?.(); } }, h('span', {}, t), h('span', {}, `${v} °C/W`))));
    menu.style.left = `${clamp(a.right - r.left + 8, 4, r.width - 256)}px`;
    menu.style.top = `${clamp(a.top - r.top + 20, 30, r.height - 230)}px`;
    stage.append(menu);
    menu.querySelector('button')?.focus();
    menu.addEventListener('keydown', (ev) => {
      const items = [...menu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { closeMenu(); anchor.focus?.(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  }
  function outside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('pointerdown', outside); } }

  // ---------- the ruler ----------
  function drawRuler() {
    const bx = rsvg.parentNode;
    const W = bx.clientWidth, H = bx.clientHeight;
    if (W < 40 || H < 40 || !P) { rsvg.replaceChildren(); return; }
    rsvg.replaceChildren();
    rsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 560;
    const lx = narrow ? 8 : 244, rx = W - 16, t0 = 8, axY = H - 22;
    const lo = Math.log10(0.1), hi = Math.log10(40);
    const X = (v) => lx + (Math.log10(clamp(v, 0.1, 40)) - lo) / (hi - lo) * (rx - lx);
    const sa = P.theta.sa;
    if (sa > 0) sv(rsvg, 'rect', { x: X(0.1), y: t0, width: X(sa) - X(0.1), height: axY - t0, class: 'hs-ok-zone' });
    const rows = P.classes.length, rh = (axY - t0 - 4) / rows;
    P.classes.forEach((c, i) => {
      const y = t0 + i * rh;
      const bh = Math.min(14, rh - 6);
      sv(rsvg, 'rect', { x: X(c.lo), y: y + (rh - bh) / 2, width: Math.max(2, X(c.hi) - X(c.lo)), height: bh, rx: 3, class: `hs-cls-bar hs-${c.fit}` });
      if (!narrow) {
        sv(rsvg, 'text', { x: 8, y: y + rh / 2 + 4, class: `hs-cls-t hs-${c.fit}` }, c.name.length > 40 ? c.name.slice(0, 39) + '…' : c.name);
        const late = X(c.hi) > rx - 150;
        sv(rsvg, 'text', { x: late ? X(c.lo) - 6 : X(c.hi) + 6, y: y + rh / 2 + 4, 'text-anchor': late ? 'end' : 'start', class: 'hs-cls-s' }, c.size);
      } else {
        const late = X(c.hi) > rx - 120;
        sv(rsvg, 'text', { x: late ? X(c.lo) - 5 : X(c.hi) + 5, y: y + rh / 2 + 4, 'text-anchor': late ? 'end' : 'start', class: 'hs-cls-s' }, c.name.replace(/ \(.*\)|, .*$/, '').slice(0, 24));
      }
    });
    sv(rsvg, 'line', { x1: lx, x2: rx, y1: axY, y2: axY, class: 'hs-axis' });
    for (const v of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 40]) {
      sv(rsvg, 'line', { x1: X(v), x2: X(v), y1: axY, y2: axY + 4, class: 'hs-tick' });
      sv(rsvg, 'text', { x: X(v), y: axY + 16, 'text-anchor': 'middle', class: 'hs-tick-t' }, v);
    }
    if (sa > 0) {
      sv(rsvg, 'line', { x1: X(sa), x2: X(sa), y1: t0 - 2, y2: axY, class: 'hs-limit' });
      const right = X(sa) < (lx + rx) / 2;
      sv(rsvg, 'text', { x: X(sa) + (right ? 5 : -5), y: t0 + 10, 'text-anchor': right ? 'start' : 'end', class: 'hs-limit-t' }, `yours ≤ ${f3(sa)} °C/W`);
    } else {
      sv(rsvg, 'text', { x: (lx + rx) / 2, y: (t0 + axY) / 2 + 4, 'text-anchor': 'middle', class: 'hs-bare-t hs-badt hs-halo' }, 'θJC + θCS use up the whole budget: no class is good enough');
    }
  }

  // ---------- the cubes ----------
  function drawCubes() {
    cubes.replaceChildren();
    if (!P) return;
    const flows = P.flows;
    const maxSide = flows ? Math.max(...flows.map((f) => f.cube[1])) : 1;
    FLOWS.forEach(([key, name]) => {
      const f = flows?.find((x) => x.key === key);
      const on = P.air === key;
      const b = h('button', { type: 'button', role: 'radio', class: 'hs-cube', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-v': key,
        title: f ? `${f.name}: ${f3(f.volume[0])}–${f3(f.volume[1])} cm³` : name,
        onclick: () => ctx.set('air', key),
        onkeydown: (e) => {
          const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
          const i = clamp(FLOWS.findIndex((x) => x[0] === key) + d, 0, 3); ctx.set('air', FLOWS[i][0]);
          requestAnimationFrame(() => cubes.querySelector(`[data-v="${FLOWS[i][0]}"]`)?.focus());
        } });
      const g = sv(null, 'svg', { viewBox: '-46 -92 92 96', 'aria-hidden': 'true' });
      if (f) {
        const s = (f.cube[1] / maxSide) * 44, sl = (f.cube[0] / maxSide) * 44;
        iso(g, s, false); iso(g, sl, true);
      } else {
        sv(g, 'text', { x: 0, y: -30, 'text-anchor': 'middle', class: 'hs-cls-s' }, '–');
      }
      b.append(g, h('b', {}, name),
        h('span', {}, f ? `${f0(f.cube[0])}–${f0(f.cube[1])} mm` : 'no sink'),
        h('span', {}, f ? `${f3(f.volume[0])}–${f3(f.volume[1])} cm³` : ''));
      cubes.append(b);
    });
    cubeNote.textContent = P.ok ? 'Fin envelope of a well-designed extrusion, as a cube: dashed is the best case. Vertical fins, free air in and out.' : 'No heat sink reaches the θSA needed: see the warnings.';
  }
  function iso(g, s, dashed) {
    // an isometric cube standing on (0,0)
    const c = Math.cos(Math.PI / 6) * s, d = s / 2;
    const A = [0, 0], B = [c, -d], C = [0, -2 * d], D = [-c, -d];
    const up = (p) => [p[0], p[1] - s];
    const pts = (a) => a.map((p) => p.join(',')).join(' ');
    if (dashed) { sv(g, 'polygon', { points: pts([A, B, up(B), up(C), up(D), D]), class: 'hs-lo' }); return; }
    sv(g, 'polygon', { points: pts([D, A, up(A), up(D)]), class: 'hs-f2' });
    sv(g, 'polygon', { points: pts([A, B, up(B), up(A)]), class: 'hs-f3' });
    sv(g, 'polygon', { points: pts([up(A), up(B), up(C), up(D)]), class: 'hs-f1' });
    void C;
  }
}
