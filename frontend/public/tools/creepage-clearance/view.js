// Creepage & Clearance: the page is the gap itself. Across the top, a test
// coupon cut through the board: the seven places IPC-2221 names, each with
// its two conductors drawn at the spacing it needs at this voltage, to one
// scale - click the place your conductors are. Below, that place up close:
// drag the second conductor to your gap and watch it meet (or cross) the
// keep-out. Beside it, table 6-1 as the staircase it is, with the voltage
// and your gap as lines to drag. Every number drawn comes from run()
// (result.spacing).

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
const sig = (v, n = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(n))));
function drag(e, move, end) {
  e.preventDefault();
  const mv = (ev) => move(ev);
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); end?.(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
// a gap as someone would write it on a drawing
const roundGap = (g) => (g < 0.2 ? Math.round(g * 100) / 100 : g < 2 ? Math.round(g * 20) / 20 : g < 10 ? Math.round(g * 10) / 10 : Math.round(g * 2) / 2);
const roundV = (v) => (v < 20 ? Math.round(v * 2) / 2 : v < 200 ? Math.round(v) : v < 1000 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10);

const PLACES = {
  B1: { short: 'inner layer', kind: 'inner' },
  B2: { short: 'outer, bare', kind: 'bare' },
  B3: { short: 'bare > 3050 m', kind: 'bare', alt: true },
  B4: { short: 'under mask', kind: 'mask' },
  A5: { short: 'coated assy', kind: 'coat' },
  A6: { short: 'leads, bare', kind: 'leads' },
  A7: { short: 'leads, coated', kind: 'leads', coat: true },
};
const PRESETS = [['5', 'dc', '5 V'], ['12', 'dc', '12 V'], ['24', 'dc', '24 V'], ['48', 'dc', '48 V'],
  ['120', 'rms', '120 V AC'], ['230', 'rms', '230 V AC'], ['400', 'dc', '400 V DC'], ['800', 'dc', '800 V DC']];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let S = null, res = null;
  let freeze = null;       // close-up scale held while dragging
  let chartFreeze = null;  // chart axes held while dragging
  let refocusSel = null;

  // ---------- toolbar ----------
  const vInp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Voltage between the conductors, V',
    oninput: (e) => ctx.set('voltage', e.target.value) });
  const gInp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Your spacing, mm', placeholder: '–',
    oninput: (e) => ctx.set('actual', e.target.value) });
  const kindSeg = h('div', { class: 'cc-seg', role: 'radiogroup', 'aria-label': 'Voltage is' });
  const KINDS = [['dc', 'DC / peak'], ['rms', 'AC rms']];
  const kindBtns = KINDS.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('kind', v),
    onkeydown: (e) => { const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault();
      const n = KINDS[clamp(KINDS.findIndex((k) => k[0] === v) + d, 0, 1)][0]; ctx.set('kind', n); refocusSel = `.cc-seg [data-v="${n}"]`; } }, t));
  kindSeg.append(...kindBtns);
  const presetBar = h('div', { class: 'cc-presets', 'aria-label': 'Common voltages' },
    PRESETS.map(([v, k, t]) => h('button', { type: 'button', 'data-v': `${v}${k}`, onclick: () => ctx.setMany({ voltage: v, kind: k }) }, t)));
  const top = h('div', { class: 'cc-top' },
    h('label', { class: 'cc-num cc-big' }, h('span', {}, 'Voltage'), vInp, h('small', {}, 'V')), kindSeg,
    h('span', { class: 'cc-peak', 'aria-live': 'polite' }),
    presetBar,
    h('label', { class: 'cc-num cc-gapnum' }, h('span', {}, 'Your gap'), gInp, h('small', {}, 'mm')));
  const peakEl = top.querySelector('.cc-peak');

  // ---------- coupon ----------
  const couponSvg = sv(null, 'svg', { class: 'cc-coupon-svg', role: 'radiogroup', 'aria-label': 'Where the conductors are: seven places on the board, each at the spacing it needs' });
  const coupon = h('section', { class: 'cc-card cc-coupon' },
    h('div', { class: 'cc-head' }, h('span', { class: 'cc-cap' }, 'Where are the conductors?'), h('span', { class: 'cc-sub' })),
    h('div', { class: 'cc-box' }, couponSvg));
  const couponSub = coupon.querySelector('.cc-sub');

  // ---------- close-up ----------
  const closeSvg = sv(null, 'svg', { class: 'cc-close-svg', role: 'group', 'aria-label': 'The two conductors up close, to scale' });
  const closeHead = h('div', { class: 'cc-head' });
  const warnBox = h('div', { class: 'cc-warns', 'aria-live': 'polite' });
  const close = h('section', { class: 'cc-card cc-close' }, closeHead, h('div', { class: 'cc-box' }, closeSvg), warnBox);

  // ---------- staircase ----------
  const stairSvg = sv(null, 'svg', { class: 'cc-stair-svg', role: 'group', 'aria-label': 'IPC-2221 table 6-1: spacing against voltage' });
  const stairHead = h('div', { class: 'cc-head' });
  const stair = h('section', { class: 'cc-card cc-stair' }, stairHead, h('div', { class: 'cc-box' }, stairSvg));

  const outs = h('div', { class: 'cc-outs' }, ctx.outputs);
  const layout = h('div', { class: 'cc' }, top, coupon, close, stair, outs);
  root.append(layout);

  // ---------- a location drawn: shared by the coupon and the close-up ----------
  // x0: left conductor's inner edge, gapPx: the gap, y: the board's top face.
  function drawPlace(g, code, x0, gapPx, y, cw, bounds, big, slabH) {
    const P = PLACES[code];
    const slab = slabH || (big ? 70 : 34), cuH = big ? 10 : 5;
    const L = bounds ? bounds[0] : x0 - cw - 60, R = bounds ? bounds[1] : x0 + gapPx + cw + 60;
    sv(g, 'rect', { x: L, y, width: R - L, height: slab, class: 'cc-fr4' });
    let cy = y - cuH, lead = P.kind === 'leads';
    if (P.kind === 'inner') cy = y + slab / 2 - cuH / 2;
    const c1 = [x0 - cw, cy, cw, cuH], c2 = [x0 + gapPx, cy, cw, cuH];
    if (lead) {
      // pads, solder fillets, the leads rising to the part body
      const bodyY = y - (big ? 70 : 30), bodyH = big ? 26 : 12;
      sv(g, 'rect', { x: x0 - cw * 0.6, y: bodyY, width: gapPx + cw * 1.2, height: bodyH, rx: 2, class: 'cc-body' });
      for (const [cx, dir] of [[x0 - cw / 2, -1], [x0 + gapPx + cw / 2, 1]]) {
        const lw = big ? 4 : 2;
        sv(g, 'path', { d: `M${cx - dir * cw * 0.1},${bodyY + bodyH * 0.6}h${dir * cw * 0.25}V${y - cuH - lw / 2}h${dir * cw * 0.35}`, class: 'cc-lead', 'stroke-width': lw });
      }
      sv(g, 'rect', { x: c1[0], y: c1[1], width: c1[2], height: c1[3], class: 'cc-cu' });
      sv(g, 'rect', { x: c2[0], y: c2[1], width: c2[2], height: c2[3], class: 'cc-cu' });
    } else {
      sv(g, 'rect', { x: c1[0], y: c1[1], width: c1[2], height: c1[3], class: 'cc-cu' });
      sv(g, 'rect', { x: c2[0], y: c2[1], width: c2[2], height: c2[3], class: 'cc-cu' });
    }
    // coatings
    if (P.kind === 'mask') {
      const t = big ? 5 : 3;
      sv(g, 'path', { d: `M${L},${y}V${y - t}H${c1[0] - t}V${cy - t}H${c1[0] + cw + t}V${y - t}H${c2[0] - t}V${cy - t}H${c2[0] + cw + t}V${y - t}H${R}V${y}Z`, class: 'cc-mask' });
    }
    if (P.kind === 'coat' || P.coat) {
      const t = big ? 9 : 5;
      const topY = lead ? y - (big ? 70 : 30) - t : cy - t;
      if (lead) sv(g, 'path', { d: `M${L},${y}V${y - t}H${c1[0] - t}V${topY}H${c2[0] + cw + t}V${y - t}H${R}V${y}Z`, class: 'cc-coat' });
      else sv(g, 'path', { d: `M${L},${y}V${y - t}H${c1[0] - t}V${topY}H${c1[0] + cw + t}V${y - t}H${c2[0] - t}V${topY}H${c2[0] + cw + t}V${y - t}H${R}V${y}Z`, class: 'cc-coat' });
    }
    if (P.alt) {
      const mx = R - (big ? 70 : 22), my = y - (big ? 44 : 22), s = big ? 16 : 8;
      sv(g, 'path', { d: `M${mx - s * 1.6},${my + s}l${s},${-s * 1.3}l${s * 0.6},${s * 0.7}l${s * 0.5},${-s * 0.5}l${s * 1.1},${s * 1.1}z`, class: 'cc-mtn' });
      if (big) sv(g, 'text', { x: mx - s * 1.6, y: my + s + 14, class: 'cc-small' }, 'above 3050 m');
    }
    return { c1, c2, slab, cy, cuH, L, R };
  }

  // ---------- coupon ----------
  function drawCoupon() {
    const svg = couponSvg;
    svg.replaceChildren();
    const W = Math.max(300, svg.clientWidth || 900);
    const perRow = W < 620 ? 4 : 7;
    const rows = Math.ceil(7 / perRow);
    const rowH = 150;
    const H = rows * rowH + 4;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const sw = W / perRow;
    const cw = Math.max(10, Math.min(22, sw * 0.1));
    const maxNeed = Math.max(...S.cols.map((c) => c.mm), S.actual || 0);
    const k = (sw - 2 * cw - 34) / maxNeed; // px per mm, one scale for all
    S.cols.forEach((c, i) => {
      const r = Math.floor(i / perRow), j = i % perRow;
      const ox = j * sw, oy = r * rowH;
      const sel = c.code === S.col;
      const g = sv(svg, 'g', { class: `cc-station${sel ? ' cc-sel' : ''}`, role: 'radio', tabindex: sel ? 0 : -1, 'aria-checked': String(sel),
        'data-c': c.code, 'aria-label': `${c.code} ${c.name}: ${sig(c.mm)} mm` });
      sv(g, 'rect', { x: ox + 3, y: oy + 3, width: sw - 6, height: rowH - 6, rx: 5, class: 'cc-st-bg' });
      const gap = c.mm * k;
      const x0 = ox + sw / 2 - gap / 2;
      const y = oy + 64;
      const clip = sv(sv(svg, 'defs'), 'clipPath', { id: `cc-clip-${c.code}` });
      sv(clip, 'rect', { x: ox + 6, y: oy + 4, width: sw - 12, height: 100 });
      const gg = sv(g, 'g', { 'clip-path': `url(#cc-clip-${c.code})` });
      const geo = drawPlace(gg, c.code, x0, gap, y, cw, [ox + 8, ox + sw - 8], false);
      // the needed gap, and your gap as a tick against it
      sv(g, 'path', { d: `M${x0},${geo.cy - 16}v8M${x0 + gap},${geo.cy - 16}v8M${x0},${geo.cy - 12}H${x0 + gap}`, class: 'cc-dimln' });
      sv(g, 'text', { x: ox + 10, y: oy + 18, class: 'cc-code' }, c.code);
      const tight = sw < 140;
      sv(g, 'text', { x: tight ? ox + 10 : ox + sw - 10, y: oy + (tight ? 33 : 18), 'text-anchor': tight ? 'start' : 'end', class: 'cc-need' }, `${sig(c.mm)} mm`);
      sv(g, 'text', { x: ox + sw / 2, y: oy + 118, 'text-anchor': 'middle', class: 'cc-name' }, PLACES[c.code].short);
      if (S.actual != null) {
        const okc = S.actual >= c.mm - 1e-9;
        sv(g, 'text', { x: ox + sw / 2, y: oy + 136, 'text-anchor': 'middle', class: `cc-verdict ${okc ? 'cc-ok' : 'cc-bad'}` },
          okc ? `${sig(S.actual)} mm ok` : `${sig(S.actual)} mm short`);
      }
      g.addEventListener('click', () => ctx.set('category', c.code));
      g.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('category', c.code); return; }
        if (!d) return; e.preventDefault();
        const n = S.cols[clamp(i + d, 0, 6)].code;
        ctx.set('category', n); refocusSel = `.cc-station[data-c="${n}"]`;
      });
    });
    couponSub.textContent = `at ${sig(S.vpk, 4)} V peak, all to one scale · click a place`;
  }

  // ---------- close-up ----------
  function drawClose() {
    const svg = closeSvg;
    svg.replaceChildren();
    const W = Math.max(280, svg.clientWidth || 600), H = Math.max(220, svg.clientHeight || 340);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const need = S.need, gap = S.actual;
    const cw = Math.min(90, W * 0.14);
    let k = (W - 2 * cw - 150) / (Math.max(need, gap ?? need) * 1.25);
    if (freeze) k = freeze.k;
    const gapPx = (gap ?? need) * k;
    const x0 = Math.max(cw + 30, (W - gapPx) / 2);
    const P = PLACES[S.col];
    const slab = H < 300 ? 44 : 64;
    const above = (P.kind === 'leads' ? 84 : 0) + 58;   // keep-out top and its label over the conductors
    const below = slab + 64;                            // potentials and your dimension under the board
    const y = Math.round(Math.max(above + 8, (H - above - below) / 2 + above));
    const defs = sv(svg, 'defs');
    const pat = sv(defs, 'pattern', { id: 'cc-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' });
    sv(pat, 'line', { x1: 0, y1: 0, x2: 0, y2: 7, class: `cc-hatch-ln ${S.ok === false ? 'cc-bad' : 'cc-ok'}` });
    const g = sv(svg, 'g');
    const geo = drawPlace(g, S.col, x0, gapPx, y, cw, [8, W - 8], true, slab);
    // keep-out: the needed spacing from the left conductor
    const kx = x0, kw = need * k;
    const ky = y - above + 30;
    sv(svg, 'rect', { x: kx, y: ky, width: kw, height: y + geo.slab - ky, fill: 'url(#cc-hatch)', class: `cc-keep ${S.ok === false ? 'cc-bad' : 'cc-ok'}` });
    sv(svg, 'path', { d: `M${kx + kw},${ky}V${y + geo.slab}`, class: `cc-keep-edge ${S.ok === false ? 'cc-bad' : 'cc-ok'}` });
    // potentials
    const py = y + geo.slab + 17;
    sv(svg, 'text', { x: x0 - cw / 2, y: py, 'text-anchor': 'middle', class: 'cc-pot' }, `${sig(S.vpk, 4)} V pk`);
    sv(svg, 'text', { x: x0 + gapPx + cw / 2, y: py, 'text-anchor': 'middle', class: 'cc-pot' }, '0 V');
    // needed dimension above
    const dy = ky - 12;
    sv(svg, 'path', { d: `M${kx},${dy - 6}v12M${kx + kw},${dy - 6}v12M${kx},${dy}H${kx + kw}`, class: 'cc-dim' });
    sv(svg, 'text', { x: clamp(kx + kw / 2, 110, W - 110), y: dy - 8, 'text-anchor': 'middle', class: 'cc-dim-t' }, `needs ${sig(need)} mm · ${sig(need / 0.0254)} mil`);
    // your gap below the board
    const by = y + geo.slab + 34;
    if (gap != null) {
      const cls = S.ok ? 'cc-ok' : 'cc-bad';
      sv(svg, 'path', { d: `M${x0},${by - 7}v14M${x0 + gapPx},${by - 7}v14M${x0},${by}H${x0 + gapPx}`, class: `cc-dim ${cls}` });
      sv(svg, 'text', { x: clamp(x0 + gapPx / 2, 110, W - 110), y: by + 19, 'text-anchor': 'middle', class: `cc-dim-t ${cls}` },
        `yours ${sig(gap)} mm · ${S.ok ? `margin ${sig(S.diff)}` : `short by ${sig(-S.diff)}`}`);
    } else {
      sv(svg, 'text', { x: x0 + gapPx / 2, y: by + 10, 'text-anchor': 'middle', class: 'cc-dim-t cc-soft' }, 'drag the right conductor to your gap');
    }
    // the handle on the right conductor
    const hx = x0 + gapPx + cw / 2, hy = geo.cy - 18;
    const hd = sv(svg, 'g', { class: 'cc-handle', tabindex: 0, role: 'slider', 'aria-label': 'Your spacing, mm; drag, or arrow keys (Shift for bigger steps)',
      'aria-valuenow': gap ?? '', 'aria-valuetext': gap == null ? 'not set' : `${sig(gap)} mm` });
    sv(hd, 'rect', { x: x0 + gapPx - 6, y: geo.cy - 34, width: cw + 12, height: geo.cuH + 44, class: 'cc-handle-hit' });
    sv(hd, 'path', { d: `M${hx - 14},${hy}h28M${hx - 14},${hy}l6,-5v10zM${hx + 14},${hy}l-6,-5v10z`, class: 'cc-handle-arr' });
    const setGap = (g2) => ctx.set('actual', String(roundGap(clamp(g2, 0.01, 200))));
    hd.addEventListener('pointerdown', (e) => {
      freeze = { k };
      const r = svg.getBoundingClientRect();
      const startX = e.clientX, startGap = gap ?? need;
      drag(e, (ev) => setGap(startGap + ((ev.clientX - startX) * (W / r.width)) / k), () => { freeze = null; draw(); });
    });
    hd.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const cur = gap ?? need, st = e.shiftKey ? 0.5 : cur < 1 ? 0.05 : 0.1;
      setGap(Math.max(0.01, cur + d * st)); refocusSel = '.cc-handle';
    });
    closeHead.replaceChildren(h('span', { class: 'cc-cap' }, `${S.col} · ${S.colName}`),
      h('span', { class: `cc-badge ${S.ok == null ? '' : S.ok ? 'cc-ok' : 'cc-bad'}` }, S.ok == null ? `needs ${sig(S.need)} mm` : S.ok ? 'meets IPC-2221' : 'too close'));
  }

  // ---------- the staircase ----------
  function drawStair() {
    const svg = stairSvg;
    svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 440), H = Math.max(200, svg.clientHeight || 340);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ml = 44, mr = 30, mt = 12, mb = 30;
    let vMax = Math.max(1000, S.vpk * 1.5, S.maxV ? Math.min(S.maxV * 1.3, 5000) : 0);
    let yMax = Math.max(20, S.need * 2, (S.actual ?? 0) * 2);
    if (chartFreeze) { vMax = chartFreeze.vMax; yMax = chartFreeze.yMax; }
    const vMin = 1, yMin = 0.03;
    const X = (v) => ml + Math.log(clamp(v, vMin, vMax) / vMin) / Math.log(vMax / vMin) * (W - ml - mr);
    const Y = (mm) => mt + (1 - Math.log(clamp(mm, yMin, yMax) / yMin) / Math.log(yMax / yMin)) * (H - mt - mb);
    const inv = (x) => vMin * Math.pow(vMax / vMin, (x - ml) / (W - ml - mr));
    const invY = (y) => yMin * Math.pow(yMax / yMin, 1 - (y - mt) / (H - mt - mb));
    // grid
    for (const v of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
      if (v > vMax) continue;
      sv(svg, 'path', { d: `M${X(v)},${mt}V${H - mb}`, class: 'cc-grid' });
      sv(svg, 'text', { x: X(v), y: H - mb + 13, 'text-anchor': 'middle', class: 'cc-tick' }, v >= 1000 ? `${v / 1000}k` : v);
    }
    sv(svg, 'text', { x: W - mr, y: H - 3, 'text-anchor': 'end', class: 'cc-tick' }, 'V peak');
    for (const mm of [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]) {
      if (mm > yMax) continue;
      sv(svg, 'path', { d: `M${ml},${Y(mm)}H${W - mr}`, class: 'cc-grid' });
      sv(svg, 'text', { x: ml - 5, y: Y(mm) + 3, 'text-anchor': 'end', class: 'cc-tick' }, mm);
    }
    sv(svg, 'text', { x: 4, y: mt + 8, class: 'cc-tick' }, 'mm');
    // SELV
    const selv = S.kind === 'rms' ? 42.4 : 60;
    sv(svg, 'path', { d: `M${X(selv)},${mt}V${H - mb}`, class: 'cc-selv' });
    sv(svg, 'text', { x: X(selv) + 3, y: mt + 10, class: 'cc-tick' }, 'SELV');
    // each column as a staircase
    const stepPath = (ci) => {
      let d = '', prev = vMin;
      S.bands.forEach((top, i) => {
        const mm = S.table[i][ci];
        d += `${d ? 'L' : 'M'}${X(prev).toFixed(1)},${Y(mm).toFixed(1)}L${X(Math.min(top, vMax)).toFixed(1)},${Y(mm).toFixed(1)}`;
        prev = top;
      });
      const base = S.table[S.table.length - 1][ci];
      for (let i = 1; i <= 24; i++) { const v = 500 * Math.pow(vMax / 500, i / 24); d += `L${X(v).toFixed(1)},${Y(base + S.perVolt[ci] * (v - 500)).toFixed(1)}`; }
      return d;
    };
    const selI = S.cols.findIndex((c) => c.code === S.col);
    // too-close region under the selected staircase
    sv(svg, 'path', { d: `${stepPath(selI)}L${X(vMax)},${H - mb}L${X(vMin)},${H - mb}Z`, class: 'cc-under' });
    S.cols.forEach((c, i) => {
      if (i === selI) return;
      const g = sv(svg, 'g', { class: 'cc-other', 'data-c': c.code });
      sv(g, 'path', { d: stepPath(i), class: 'cc-step-o' });
      sv(g, 'path', { d: stepPath(i), class: 'cc-step-hit' });
      sv(g, 'title', {}, `${c.code} ${c.name} - click to use`);
      g.addEventListener('click', () => ctx.set('category', c.code));
    });
    sv(svg, 'path', { d: stepPath(selI), class: 'cc-step' });
    // right-edge labels for every column, nudged apart
    const ends = S.cols.map((c, i) => ({ c, i, y: Y(S.table[S.table.length - 1][i] + S.perVolt[i] * (vMax - 500)) })).sort((a, b) => a.y - b.y);
    let last = -99;
    for (const e of ends) { const y = Math.max(e.y, last + 10); last = y; sv(svg, 'text', { x: W - mr + 3, y: y + 3, class: `cc-endlbl${e.i === selI ? ' cc-sel-t' : ''}` }, e.c.code); }

    // voltage cursor
    const vx = X(S.vpk);
    const vg = sv(svg, 'g', { class: 'cc-vcur', tabindex: 0, role: 'slider', 'aria-label': 'Voltage; drag sideways, or arrow keys', 'aria-valuenow': S.voltage, 'aria-valuetext': `${sig(S.voltage, 4)} V ${S.kind === 'rms' ? 'rms' : 'peak'}` });
    sv(vg, 'rect', { x: vx - 8, y: mt, width: 16, height: H - mt - mb, class: 'cc-hit' });
    sv(vg, 'path', { d: `M${vx},${mt}V${H - mb}`, class: 'cc-vline' });
    sv(vg, 'path', { d: `M${vx},${H - mb}l-6,9h12z`, class: 'cc-vknob' });
    const setV = (vpk) => ctx.set('voltage', String(roundV(S.kind === 'rms' ? vpk / Math.SQRT2 : vpk)));
    vg.addEventListener('pointerdown', (e) => {
      chartFreeze = { vMax, yMax };
      const r = svg.getBoundingClientRect();
      drag(e, (ev) => setV(clamp(inv((ev.clientX - r.left) * (W / r.width)), 1, vMax)), () => { chartFreeze = null; draw(); });
    });
    vg.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const v = S.voltage, st = e.shiftKey ? v * 0.25 : v < 20 ? 1 : v < 200 ? 5 : 10;
      ctx.set('voltage', String(roundV(Math.max(1, v + d * st)))); refocusSel = '.cc-vcur';
    });
    // your gap as a line
    if (S.actual != null) {
      const gy = Y(S.actual);
      const gg = sv(svg, 'g', { class: `cc-gcur ${S.ok ? 'cc-ok' : 'cc-bad'}`, tabindex: 0, role: 'slider', 'aria-label': 'Your gap; drag up or down, or arrow keys', 'aria-valuenow': S.actual, 'aria-valuetext': `${sig(S.actual)} mm` });
      sv(gg, 'rect', { x: ml, y: gy - 7, width: W - ml - mr, height: 14, class: 'cc-hit' });
      sv(gg, 'path', { d: `M${ml},${gy}H${W - mr}`, class: 'cc-gline' });
      sv(gg, 'path', { d: `M${ml},${gy}l-8,-6v12z`, class: 'cc-gknob' });
      gg.addEventListener('pointerdown', (e) => {
        chartFreeze = { vMax, yMax };
        const r = svg.getBoundingClientRect();
        drag(e, (ev) => ctx.set('actual', String(roundGap(clamp(invY((ev.clientY - r.top) * (H / r.height)), yMin, yMax)))), () => { chartFreeze = null; draw(); });
      });
      gg.addEventListener('keydown', (e) => {
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const cur = S.actual, st = e.shiftKey ? 0.5 : cur < 1 ? 0.05 : 0.1;
        ctx.set('actual', String(roundGap(Math.max(0.01, cur + d * st)))); refocusSel = '.cc-gcur';
      });
      // where your gap runs out
      if (S.maxV > 0 && S.maxV < vMax) {
        const mx = X(S.maxV);
        sv(svg, 'circle', { cx: mx, cy: gy, r: 4, class: 'cc-maxpt' });
        const txt = `good to ${sig(S.maxV, 3)} V pk`;
        const right = mx + 8 + txt.length * 6.4 < W - mr;
        sv(svg, 'text', { x: right ? mx + 8 : mx - 8, y: gy - 7, 'text-anchor': right ? 'start' : 'end', class: 'cc-maxt' }, txt);
      }
      // your operating point
      sv(svg, 'circle', { cx: vx, cy: gy, r: 6, class: `cc-pt ${S.ok ? 'cc-ok' : 'cc-bad'}` });
    }
    // the need at this voltage
    sv(svg, 'circle', { cx: vx, cy: Y(S.need), r: 4, class: 'cc-needpt' });
    const nt = `${sig(S.need)} mm`;
    sv(svg, 'text', { x: vx + 7, y: Y(S.need) + 13, class: 'cc-needt' }, nt);
    stairHead.replaceChildren(h('span', { class: 'cc-cap' }, 'Table 6-1: spacing against voltage'),
      h('span', { class: 'cc-sub' }, `band ${S.band} V · drag the lines`));
  }

  function drawTop() {
    const raw = ctx.raw;
    if (document.activeElement !== vInp) vInp.value = raw.voltage ?? '';
    if (document.activeElement !== gInp) gInp.value = raw.actual ?? '';
    for (const b of kindBtns) { const on = b.dataset.v === (raw.kind === 'rms' ? 'rms' : 'dc'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const b of presetBar.children) b.setAttribute('aria-pressed', String(b.dataset.v === `${String(raw.voltage).trim()}${raw.kind === 'rms' ? 'rms' : 'dc'}`));
    peakEl.textContent = S ? (S.kind === 'rms' ? `= ${sig(S.vpk, 4)} V peak` : 'peak') : '';
  }

  function draw() {
    // a redraw replaces the drawing: keep keyboard focus on the same handle
    if (!refocusSel && root.contains(document.activeElement) && document.activeElement instanceof SVGElement) {
      const a = document.activeElement, c = (a.getAttribute('class') || '').split(' ')[0];
      const key = ['data-c', 'data-k', 'data-id'].find((k) => a.hasAttribute(k));
      if (c) refocusSel = `.${c}${key ? `[${key}="${a.getAttribute(key)}"]` : ''}`;
    }
    drawTop();
    const w = res?.warnings || [];
    warnBox.replaceChildren(...w.map((t) => h('div', {}, t)));
    warnBox.hidden = !w.length;
    if (!S) { couponSvg.replaceChildren(); closeSvg.replaceChildren(); stairSvg.replaceChildren(); return; }
    drawCoupon(); drawClose(); drawStair();
    if (refocusSel) { const el = root.querySelector(refocusSel); refocusSel = null; el?.focus(); }
  }

  ctx.onResult((r) => { res = r; S = r.spacing || null; draw(); });
  let rsz = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rsz); rsz = requestAnimationFrame(() => { if (S) draw(); }); });
  for (const el of [layout, closeSvg.parentNode, stairSvg.parentNode]) ro.observe(el);
}
