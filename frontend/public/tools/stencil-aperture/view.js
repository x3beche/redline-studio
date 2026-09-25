// Stencil Aperture: the page is the aperture cut in the foil.
//   Net      - the aperture opened out like a box net, to scale: the opening
//              the paste leaves through in the middle, the four walls it has
//              to slide past folded flat around it (a circle's wall unrolled
//              as a strip). Area ratio = middle / flaps, so a thicker foil
//              visibly grows the flaps. The dashed outline is how deep the
//              flaps may get before the area ratio drops to 0.66. Drag the
//              copper corner (pad size), the aperture edge (area reduction)
//              or a flap edge (foil thickness).
//   Section  - a cut across the narrow side: pad, foil, paste brick, with the
//              aspect ratio W/T and its limit line; drag the foil top.
//   Foils    - the aperture's area ratio on each standard foil; click one to
//              use it, drag the marker for any thickness.
// Every number drawn comes from run()'s result.stencil.

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
const f2 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(2));
const mm = (v) => String(Number(v.toFixed(v < 1 ? 3 : 2)));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ } };

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let S = null;                 // result.stencil
  let warnings = [];
  let drag = null;              // {kind, fit}
  let fitNet = null, fitSec = null, fitChart = null;
  let focusKey = null;

  // ---------- toolbar ----------
  const shapeSeg = h('div', { class: 'sa-seg', role: 'radiogroup', 'aria-label': 'Aperture shape' });
  const shapes = [['rect', 'Rectangle'], ['round', 'Circle']];
  const shapeBtns = shapes.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v,
    onclick: () => ctx.set('shape', v),
    onkeydown: (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); const n = v === 'rect' ? 'round' : 'rect'; ctx.set('shape', n);
      requestAnimationFrame(() => shapeSeg.querySelector(`[data-v="${n}"]`)?.focus());
    } }, t));
  shapeSeg.append(...shapeBtns);
  const num = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'sa-num', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const fL = num('padL', 'Pad L', 'mm', 'Pad length, or the diameter for a circle');
  const fW = num('padW', 'W', 'mm', 'Pad width');
  const fR = num('reduce', 'Aperture', '% of pad', 'Aperture area as a percentage of the pad area');
  const fT = num('thick', 'Foil', 'µm', 'Stencil foil thickness');
  const fN = num('count', '×', 'apertures', 'Apertures of this size, for the total paste volume');
  const bar = h('div', { class: 'sa-bar' }, shapeSeg, h('div', { class: 'sa-fields' }, fL, fW, fR, fT, fN));

  // ---------- net ----------
  const netSvg = sv(null, 'svg', { class: 'sa-svg', role: 'group', 'aria-label': 'Aperture opened out: the opening and its walls, to scale' });
  const netHead = h('div', { class: 'sa-head' });
  const netWarn = h('div', { class: 'sa-warns', 'aria-live': 'polite' });
  const net = h('section', { class: 'sa-card sa-net' }, netHead, h('div', { class: 'sa-box' }, netSvg),
    h('div', { class: 'sa-hint' }, 'Drag the copper corner for the pad, the aperture edge for the area reduction, a wall edge for the foil thickness. Handles take arrow keys (Shift = ×10).'));

  // ---------- section ----------
  const secSvg = sv(null, 'svg', { class: 'sa-svg', role: 'group', 'aria-label': 'Section across the narrow side of the aperture' });
  const secHead = h('div', { class: 'sa-head' });
  const sec = h('section', { class: 'sa-card sa-sec' }, secHead, h('div', { class: 'sa-box' }, secSvg));

  // ---------- foils ----------
  const chSvg = sv(null, 'svg', { class: 'sa-svg', role: 'group', 'aria-label': 'Area ratio of this aperture on each standard foil' });
  const chHead = h('div', { class: 'sa-head' });
  const chart = h('section', { class: 'sa-card sa-foil' }, chHead, h('div', { class: 'sa-box' }, chSvg));

  const out = h('div', { class: 'sa-out' }, ctx.outputs);
  root.append(h('div', { class: 'sa' }, bar, h('div', { class: 'sa-l' }, net, netWarn), h('div', { class: 'sa-r' }, sec, chart, out)));

  // ---------- setting inputs from the drawing ----------
  const setThick = (t) => ctx.set('thick', String(Math.round(clamp(t, 30, 300))));
  const setReduce = (p) => ctx.set('reduce', String(Math.round(clamp(p, 10, 130))));
  const setPad = (L, W) => {
    const r = (v) => String(Number(clamp(v, 0.05, 30).toFixed(v < 1 ? 3 : 2)));
    if (S.shape === 'round') ctx.set('padL', r(L));
    else ctx.setMany({ padL: r(L), padW: r(W) });
  };
  // keyboard on a handle
  function keyStep(kind, e) {
    const big = e.shiftKey ? 10 : 1;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    focusKey = kind;
    if (kind === 'thick' || kind === 'secthick' || kind === 'chart') setThick(S.thick + d * 5 * big);
    else if (kind === 'reduce') setReduce(S.pct + d * big);
    else if (kind === 'pad') {
      const st = 0.01 * big;
      if (S.shape === 'round') setPad(S.padL + d * st, S.padL);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setPad(S.padL, Math.max(0.05, S.padW + d * st));
      else setPad(Math.max(0.05, S.padL + d * st), S.padW);
    }
  }
  function handle(parent, kind, x, y, label, value, cls = '') {
    const g = sv(parent, 'g', { class: `sa-h ${cls}`, tabindex: '0', role: 'slider', 'data-h': kind,
      'aria-label': label, 'aria-valuetext': value });
    sv(g, 'circle', { cx: x, cy: y, r: 13, class: 'hit' });
    sv(g, 'circle', { cx: x, cy: y, r: 6, class: 'knob' });
    g.addEventListener('keydown', (e) => keyStep(kind, e));
    g.addEventListener('focus', () => { focusKey = kind; });
    return g;
  }
  const svgPt = (svg, e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // ---------- net drawing ----------
  function drawNet() {
    const svg = netSvg; svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 700), H = Math.max(220, svg.clientHeight || 460);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const round = S.shape === 'round';
    const T = S.thick / 1000, TL = S.tMaxArea / 1000;          // mm
    const horizPad = S.padL, vertPad = round ? S.padL : S.padW; // pad as drawn
    const ax = round ? S.l : (S.padL >= S.padW ? S.l : S.w);    // aperture as drawn
    const ay = round ? S.l : (S.padL >= S.padW ? S.w : S.l);
    const depth = Math.max(T, Math.min(TL, T * 3));
    let fit = drag?.fit;
    if (!fit) {
      const X = round ? Math.max(horizPad, Math.PI * ax, ax + 2 * depth) : Math.max(horizPad, ax + 2 * depth);
      const Y = round ? Math.max(vertPad, ax) + 0.18 * ax + depth + 0.05 * ax : Math.max(vertPad, ay + 2 * depth);
      const mx = W < 500 ? W * 0.34 : Math.min(150, W * 0.24), s = Math.min((W - mx) / X, (H - 150) / Y);
      fit = { s, cx: W / 2, cy: round ? 70 + (Math.max(vertPad, ax) * s) / 2 + (H - 110 - Y * s) / 2 : 68 + (H - 68 - 72) / 2 };
    }
    fitNet = fit;
    const { s, cx, cy } = fit;
    const bad = !S.areaOk, warn = S.marginal;
    const defs = sv(svg, 'defs');
    const pat = sv(defs, 'pattern', { id: 'sa-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    sv(pat, 'line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'sa-hatchline' });
    // grid of 0.1 mm / 1 mm behind, for scale
    const g0 = sv(svg, 'g', { class: 'sa-grid' });
    const step = s * 0.1 >= 10 ? 0.1 : s * 0.5 >= 10 ? 0.5 : 1;
    for (let v = cx % (step * s); v < W; v += step * s) sv(g0, 'line', { x1: v, y1: 0, x2: v, y2: H });
    for (let v = cy % (step * s); v < H; v += step * s) sv(g0, 'line', { x1: 0, y1: v, x2: W, y2: v });
    sv(svg, 'text', { x: 10, y: H - 10, class: 'sa-t soft' }, `grid ${step} mm · ${f3(s)} px/mm`);

    const flapCls = `sa-flap${bad ? ' bad' : warn ? ' warn' : ''}`;
    if (!round) {
      const hw = (ax * s) / 2, hh = (ay * s) / 2, d = T * s, dl = TL * s;
      // pad
      const pw = (horizPad * s) / 2, ph = (vertPad * s) / 2;
      sv(svg, 'rect', { x: cx - pw, y: cy - ph, width: 2 * pw, height: 2 * ph, class: 'sa-pad' });
      // limit ghost (walls allowed up to the area-ratio limit)
      const gh = sv(svg, 'g', { class: 'sa-ghost' });
      sv(gh, 'path', { d: `M${cx - hw},${cy - hh - dl}h${2 * hw}v${dl}h${dl}v${2 * hh}h${-dl}v${dl}h${-2 * hw}v${-dl}h${-dl}v${-2 * hh}h${dl}z` });
      // flaps
      const flaps = [[cx - hw, cy - hh - d, 2 * hw, d], [cx - hw, cy + hh, 2 * hw, d], [cx - hw - d, cy - hh, d, 2 * hh], [cx + hw, cy - hh, d, 2 * hh]];
      for (const [x, y, w, hgt] of flaps) {
        sv(svg, 'rect', { x, y, width: w, height: hgt, class: flapCls });
        sv(svg, 'rect', { x, y, width: w, height: hgt, fill: 'url(#sa-hatch)', class: 'sa-flaphatch' });
      }
      // opening
      sv(svg, 'rect', { x: cx - hw, y: cy - hh, width: 2 * hw, height: 2 * hh, class: 'sa-open' });
      // labels in the opening
      const big = Math.min(hw, hh) > 26;
      sv(svg, 'text', { x: cx, y: cy - (big ? 4 : 0), class: 'sa-t in', 'text-anchor': 'middle', 'dominant-baseline': 'middle' },
        `opening ${f3(S.area)} mm²`);
      if (big) sv(svg, 'text', { x: cx, y: cy + 12, class: 'sa-t in soft', 'text-anchor': 'middle' }, `${mm(ax)} × ${mm(ay)} mm`);
      // wall label on top flap, outside
      const wl = `walls ${f3(S.wallArea)} mm²`;
      if (d >= 16 && hw > 60) sv(svg, 'text', { x: cx, y: cy - hh - d / 2, class: `sa-t ${bad ? 'bad' : 'soft'}`, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, wl);
      else sv(svg, 'text', { x: cx + 14, y: cy - hh - d - 6, class: `sa-t ${bad ? 'bad' : 'soft'}` }, wl);
      // ghost label, over the ghost's top left corner
      sv(svg, 'text', { x: Math.max(6, cx - hw - Math.max(d, dl)), y: cy - hh - Math.max(d, dl) - 6, class: `sa-t ${dl > d ? 'warn' : 'bad'}` },
        dl > d ? `AR 0.66 at ${Math.round(S.tMaxArea)} µm` : `past the ${Math.round(S.tMaxArea)} µm limit`);
      // dimension: aperture length below
      const yd = cy + Math.max(hh + Math.max(d, dl), ph) + 20;
      dimH(svg, cx - hw, cx + hw, yd, `${mm(ax)} mm`);
      dimV(svg, cx + Math.max(hw + d, pw) + 22, cy - hh, cy + hh, `${mm(ay)}`);
      // T dimension on the left flap
      if (d > 4) sv(svg, 'text', { x: cx - hw - d / 2, y: cy + hh + d + 14, class: 'sa-t', 'text-anchor': 'middle' }, `T ${Math.round(S.thick)} µm`);
      // pad label
      sv(svg, 'text', { x: cx - pw, y: yd + 34, class: 'sa-t cu' }, `copper pad ${mm(horizPad)} × ${mm(vertPad)} mm${S.pct !== 100 ? ` · aperture ${Math.round(S.pct)} % of its area` : ''}`);
      // handles
      handle(svg, 'pad', cx + pw, cy + ph, 'Pad size (arrows: left/right length, up/down width)', `${mm(horizPad)} by ${mm(vertPad)} mm`, 'cu');
      handle(svg, 'reduce', cx + hw, cy, 'Aperture area, % of pad', `${Math.round(S.pct)} %`, 'ap');
      handle(svg, 'thick', cx, cy - hh - d, 'Foil thickness', `${Math.round(S.thick)} µm`, bad ? 'bad' : 'wall');
    } else {
      const r = (ax * s) / 2, pr = (horizPad * s) / 2;
      const cyc = cy;
      sv(svg, 'circle', { cx, cy: cyc, r: pr, class: 'sa-pad' });
      sv(svg, 'circle', { cx, cy: cyc, r, class: 'sa-open' });
      sv(svg, 'text', { x: cx, y: cyc, class: 'sa-t in', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, r > 40 ? `opening ${f3(S.area)} mm²` : `${f3(S.area)} mm²`);
      sv(svg, 'text', { x: cx + pr * 0.75 + 12, y: cyc - pr * 0.75, class: 'sa-t cu' }, `copper pad Ø ${mm(horizPad)} mm${S.pct !== 100 ? ` · aperture ${Math.round(S.pct)} %` : ''}`);
      dimH(svg, cx - r, cx + r, cyc + Math.max(pr, r) + 18, `Ø ${mm(ax)}`);
      // unrolled wall strip
      const len = Math.PI * ax * s, d = T * s, dl = TL * s;
      const y0 = cyc + Math.max(pr, r) + 42;
      sv(svg, 'rect', { x: cx - len / 2, y: y0, width: len, height: dl, class: 'sa-ghost-r' });
      sv(svg, 'rect', { x: cx - len / 2, y: y0, width: len, height: d, class: flapCls });
      sv(svg, 'rect', { x: cx - len / 2, y: y0, width: len, height: d, fill: 'url(#sa-hatch)', class: 'sa-flaphatch' });
      sv(svg, 'path', { d: `M${cx - r},${cyc} Q${cx - len / 2},${cyc + r} ${cx - len / 2},${y0}`, class: 'sa-lead' });
      sv(svg, 'path', { d: `M${cx + r},${cyc} Q${cx + len / 2},${cyc + r} ${cx + len / 2},${y0}`, class: 'sa-lead' });
      sv(svg, 'text', { x: cx, y: y0 + Math.max(d, dl) + 16, class: `sa-t ${bad ? 'bad' : ''}`, 'text-anchor': 'middle' },
        `wall unrolled: π·Ø ${f3(S.perim)} × T ${f3(T)} = ${f3(S.wallArea)} mm²`);
      if (dl > d + 3) sv(svg, 'text', { x: cx + len / 2 + 6, y: y0 + dl, class: 'sa-t warn' }, `AR 0.66 at ${Math.round(S.tMaxArea)} µm`);
      handle(svg, 'pad', cx + pr * Math.SQRT1_2, cyc + pr * Math.SQRT1_2, 'Pad diameter', `${mm(horizPad)} mm`, 'cu');
      handle(svg, 'reduce', cx + r, cyc, 'Aperture area, % of pad', `${Math.round(S.pct)} %`, 'ap');
      handle(svg, 'thick', cx, y0 + d, 'Foil thickness', `${Math.round(S.thick)} µm`, bad ? 'bad' : 'wall');
    }
    // the ratio, big, top left
    const tone = bad ? 'bad' : warn ? 'warn' : 'ok';
    const gR = sv(svg, 'g', { class: 'sa-ratio' });
    sv(gR, 'text', { x: 12, y: 26, class: `sa-big ${tone}` }, f2(S.areaRatio));
    sv(gR, 'text', { x: 12, y: 44, class: 'sa-t soft' }, `area ratio = ${f3(S.area)} / ${f3(S.wallArea)}`);
    sv(gR, 'text', { x: 12, y: 58, class: `sa-t ${tone}` }, bad ? 'below 0.66: paste stays in' : warn ? 'just above 0.66: marginal' : 'IPC-7525 ≥ 0.66: releases');
    netHead.replaceChildren(h('b', {}, 'Aperture, opened out'), h('span', {}, ' to scale · opening in the middle, its walls folded flat around it'));
  }
  function dimH(svg, x1, x2, y, label) {
    const g = sv(svg, 'g', { class: 'sa-dim' });
    sv(g, 'line', { x1, y1: y, x2, y2: y });
    sv(g, 'line', { x1, y1: y - 5, x2: x1, y2: y + 5 }); sv(g, 'line', { x1: x2, y1: y - 5, x2, y2: y + 5 });
    sv(svg, 'text', { x: (x1 + x2) / 2, y: y + 14, class: 'sa-t', 'text-anchor': 'middle' }, label);
  }
  function dimV(svg, x, y1, y2, label) {
    const g = sv(svg, 'g', { class: 'sa-dim' });
    sv(g, 'line', { x1: x, y1, x2: x, y2 });
    sv(g, 'line', { x1: x - 5, y1, x2: x + 5, y2: y1 }); sv(g, 'line', { x1: x - 5, y1: y2, x2: x + 5, y2 });
    sv(svg, 'text', { x: x + 8, y: (y1 + y2) / 2 + 4, class: 'sa-t' }, label);
  }

  // ---------- section drawing ----------
  function drawSec() {
    const svg = secSvg; svg.replaceChildren();
    const W = Math.max(240, svg.clientWidth || 420), H = Math.max(150, svg.clientHeight || 200);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const w = S.w, T = S.thick / 1000, TA = S.tMaxAspect / 1000;
    const padN = S.shape === 'round' ? S.padL : Math.min(S.padL, S.padW);
    let fit = drag?.kind === 'secthick' ? drag.fit : null;
    if (!fit) {
      const spanX = Math.max(w, padN) * 2.1, spanY = Math.max(T, TA) * 1.25 + 0.035;
      const s = Math.min((W - 120) / spanX, (H - 62) / spanY);
      fit = { s, cx: W / 2 - 20, base: H - 30 };
    }
    fitSec = fit;
    const { s, cx, base } = fit;
    const bad = !S.aspectOk;
    const cu = 0.035 * s;
    // board and pad
    sv(svg, 'rect', { x: 0, y: base, width: W, height: 30, class: 'sa-board' });
    sv(svg, 'rect', { x: cx - (padN * s) / 2, y: base - cu, width: padN * s, height: cu, class: 'sa-cu' });
    const top = base - cu - T * s;
    // foil
    const hw = (w * s) / 2;
    sv(svg, 'rect', { x: 0, y: top, width: cx - hw, height: T * s, class: `sa-foilsec${bad ? ' bad' : ''}` });
    sv(svg, 'rect', { x: cx + hw, y: top, width: W - 110 - (cx + hw) + 110, height: T * s, class: `sa-foilsec${bad ? ' bad' : ''}` });
    // paste brick
    sv(svg, 'rect', { x: cx - hw, y: top, width: 2 * hw, height: T * s, class: 'sa-paste' });
    // aspect limit line
    const ya = base - cu - TA * s;
    sv(svg, 'line', { x1: cx - hw - 30, y1: ya, x2: cx + hw + 30, y2: ya, class: 'sa-limit' });
    sv(svg, 'text', { x: W - 8, y: ya - 5, class: 'sa-t warn', 'text-anchor': 'end' }, `W/T = 1.5 at ${Math.round(S.tMaxAspect)} µm`);
    // dims
    dimH(svg, cx - hw, cx + hw, top - 16, `W ${mm(w)} mm`);
    const xT = cx - hw - 26;
    const g = sv(svg, 'g', { class: 'sa-dim' });
    sv(g, 'line', { x1: xT, y1: top, x2: xT, y2: base - cu });
    sv(svg, 'text', { x: xT - 6, y: (top + base - cu) / 2 + 4, class: 'sa-t', 'text-anchor': 'end' }, `T ${Math.round(S.thick)} µm`);
    sv(svg, 'text', { x: 8, y: H - 10, class: 'sa-t on' }, `pad ${mm(padN)} mm · paste brick ${f3(S.vol)} nL${S.count > 1 ? ` × ${S.count} = ${f3(S.volTotal)} nL` : ''}`);
    handle(svg, 'secthick', cx + hw + 20, top, 'Foil thickness', `${Math.round(S.thick)} µm`, bad ? 'bad' : 'wall');
    secHead.replaceChildren(h('b', {}, 'Section across W'),
      h('span', { class: `sa-pill ${bad ? 'bad' : 'ok'}` }, `aspect ${f2(S.aspect)}`),
      h('span', {}, bad ? ' below 1.5: narrower than the foil can release' : ' ≥ 1.5 IPC-7525'));
  }

  // ---------- foil chart ----------
  function drawChart() {
    const svg = chSvg; svg.replaceChildren();
    const W = Math.max(240, svg.clientWidth || 420), H = Math.max(140, svg.clientHeight || 200);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 40, R = 14, T = 12, B = 26;
    const tMin = 60, tMaxX = 210;
    const ys = [...S.foils.map((f) => f.area), S.areaRatio];
    const yMax = Math.max(1, Math.min(4, Math.max(...ys) * 1.08));
    const X = (t) => L + ((clamp(t, tMin, tMaxX) - tMin) / (tMaxX - tMin)) * (W - L - R);
    const Y = (v) => T + (1 - clamp(v, 0, yMax) / yMax) * (H - T - B);
    fitChart = { X, inv: (px) => tMin + ((px - L) / (W - L - R)) * (tMaxX - tMin) };
    sv(svg, 'rect', { x: L, y: Y(S.arMin), width: W - L - R, height: Y(0) - Y(S.arMin), class: 'sa-band bad' });
    sv(svg, 'rect', { x: L, y: Y(0.7), width: W - L - R, height: Y(S.arMin) - Y(0.7), class: 'sa-band warn' });
    for (let v = 0; v <= yMax + 1e-9; v += yMax > 2 ? 1 : 0.25) {
      sv(svg, 'line', { x1: L, y1: Y(v), x2: W - R, y2: Y(v), class: 'sa-gl' });
      sv(svg, 'text', { x: L - 5, y: Y(v) + 3, class: 'sa-ax', 'text-anchor': 'end' }, v.toFixed(v % 1 ? 2 : 0));
    }
    sv(svg, 'text', { x: L + 4, y: Y(0) - 4, class: 'sa-t bad' }, 'AR < 0.66: no release');
    // curve through the standard foils
    sv(svg, 'path', { class: 'sa-curve', d: S.foils.filter((f) => f.t >= tMin && f.t <= tMaxX).map((f, i) => `${i ? 'L' : 'M'}${X(f.t)},${Y(f.area)}`).join('') });
    // limit
    if (S.tMax >= tMin && S.tMax <= tMaxX) {
      sv(svg, 'line', { x1: X(S.tMax), y1: T, x2: X(S.tMax), y2: H - B, class: 'sa-limit' });
      sv(svg, 'text', { x: X(S.tMax) + 4, y: T + 10, class: 'sa-t warn' }, `max ${Math.round(S.tMax)} µm`);
    }
    // current foil
    const xc = X(S.thick);
    sv(svg, 'line', { x1: xc, y1: T, x2: xc, y2: H - B, class: 'sa-cur' });
    // foils
    let lastLab = -99;
    for (const f of S.foils) {
      if (f.t < tMin || f.t > tMaxX) continue;
      const g = sv(svg, 'g', { class: `sa-foildot ${f.ok ? 'ok' : 'bad'}${Math.abs(f.t - S.thick) < 0.5 ? ' on' : ''}`, tabindex: '0', role: 'button',
        'aria-label': `${f.t} µm foil: area ratio ${f2(f.area)}, aspect ${f2(f.aspect)}, ${f.ok ? 'prints' : 'does not print'}` });
      sv(g, 'circle', { cx: X(f.t), cy: Y(f.area), r: 10, class: 'hit' });
      sv(g, 'circle', { cx: X(f.t), cy: Y(f.area), r: 4.5, class: 'dot' });
      if (X(f.t) - lastLab >= 24) { sv(g, 'text', { x: X(f.t), y: H - B + 13, class: 'sa-ax', 'text-anchor': 'middle' }, String(f.t)); lastLab = X(f.t); }
      const pick = () => { focusKey = null; setThick(f.t); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    }
    const hc = handle(svg, 'chart', xc, Y(S.areaRatio), 'Foil thickness', `${Math.round(S.thick)} µm, area ratio ${f2(S.areaRatio)}`, S.areaOk ? 'wall' : 'bad');
    hc.classList.add('sa-curh');
    sv(svg, 'text', { x: L, y: H - 2, class: 'sa-ax' }, 'foil µm →');
    chHead.replaceChildren(h('b', {}, 'On other foils'), h('span', {}, ` click a foil · thickest that prints ${Math.round(S.tMax)} µm (${S.limitBy === 'area' ? 'area ratio' : 'aspect ratio'} decides)`));
  }

  // ---------- dragging (one capture on each svg; the drawing is redrawn under the pointer) ----------
  function wireDrag(svg) {
    svg.addEventListener('pointerdown', (e) => {
      const hEl = e.target.closest?.('.sa-h');
      if (!hEl || !S) return;
      e.preventDefault();
      const kind = hEl.dataset.h;
      drag = { kind, fit: kind === 'chart' ? null : kind === 'secthick' ? fitSec : fitNet, svg };
      hEl.focus({ preventScroll: true }); focusKey = kind;
      capture(svg, e);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || drag.svg !== svg || !S) return;
      const p = svgPt(svg, e);
      const k = drag.kind;
      if (k === 'chart') { setThick(fitChart.inv(p.x)); return; }
      if (k === 'secthick') {
        const { s, base } = drag.fit; const cu = 0.035 * s;
        setThick(((base - cu - p.y) / s) * 1000); return;
      }
      const { s, cx, cy } = drag.fit;
      const round = S.shape === 'round';
      if (k === 'pad') {
        if (round) setPad((2 * Math.hypot(p.x - cx, p.y - cy)) / s, 0);
        else setPad((2 * Math.abs(p.x - cx)) / s, (2 * Math.abs(p.y - cy)) / s);
      } else if (k === 'reduce') {
        const half = round ? Math.hypot(p.x - cx, p.y - cy) : Math.abs(p.x - cx);
        const padAlong = S.padL; // drawn horizontally
        const kx = (2 * half) / s / (round ? S.padL : padAlong);
        setReduce(kx * kx * 100);
      } else if (k === 'thick') {
        if (round) {
          const r = (S.l * s) / 2, pr = (S.padL * s) / 2;
          const y0 = cy + Math.max(pr, r) + 42;
          setThick(((p.y - y0) / s) * 1000);
        } else {
          const ay = S.padL >= S.padW ? S.w : S.l;
          setThick(((cy - (ay * s) / 2 - p.y) / s) * 1000);
        }
      }
    });
    const end = () => { if (drag && drag.svg === svg) { drag = null; svg.classList.remove('dragging'); draw(); } };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
  wireDrag(netSvg); wireDrag(secSvg); wireDrag(chSvg);

  function draw() {
    if (!S) return;
    drawNet(); drawSec(); drawChart();
    if (focusKey) {
      const el = root.querySelector(`.sa-h[data-h="${focusKey}"]`);
      if (el && document.activeElement !== el && (document.activeElement === document.body || !document.activeElement || document.activeElement.closest?.('.sa-svg'))) el.focus({ preventScroll: true });
    }
  }

  ctx.onResult((res, input) => {
    const raw = ctx.raw;
    shapeBtns.forEach((b) => { const on = b.dataset.v === (raw.shape || 'rect'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    fL.sync(raw.padL); fW.sync(raw.padW); fR.sync(raw.reduce); fT.sync(raw.thick); fN.sync(raw.count);
    fW.hidden = raw.shape === 'round';
    fL.querySelector('span').textContent = raw.shape === 'round' ? 'Pad Ø' : 'Pad L';
    warnings = res.warnings || [];
    netWarn.replaceChildren(...warnings.map((w) => h('div', {}, w)));
    netWarn.hidden = !warnings.length;
    S = res.stencil || null;
    root.querySelector('.sa').classList.toggle('empty', !S);
    if (!S) { netSvg.replaceChildren(); secSvg.replaceChildren(); chSvg.replaceChildren(); netHead.textContent = 'Give the pad size and the foil thickness.'; return; }
    draw();
  });
  new ResizeObserver(() => { if (!drag) draw(); }).observe(net);
}
