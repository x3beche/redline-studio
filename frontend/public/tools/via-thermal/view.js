// Via Current & Thermal: the board cut open through the first row of the via
// field is the page. Current enters the barrels from above; each barrel is
// tinted by how hot it runs.
//   Section  - to scale. Drag the drill dimension, the board's bottom face
//              (length), the current label (scrub); the wall detail beside it
//              shows the plating, drag its inner face.
//   Heat     - a thermometer from the board temperature: the allowed rise as a
//              band (drag its top), the barrel's temperature at your current,
//              and the drop across the board for the heat you move.
//   Field    - the pad from above: click or drag over the grid to set how many
//              vias there are; the ones still missing for your current dashed.
//   Drills   - the drill sizes side by side, to scale: click one.
// Every number shown comes from run()'s result.via.
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

const FILLS = [['none', 'Open'], ['epoxy', 'Epoxy'], ['conductive', 'Ag epoxy'], ['solder', 'Solder'], ['copper', 'Cu filled']];
const NUMS = [
  ['drill', 'drill', 'mm'], ['plating', 'plating', 'µm'], ['length', 'length', 'mm'], ['count', 'vias', ''],
  ['current', 'current', 'A'], ['dtmax', 'allowed rise', '°C'], ['power', 'heat', 'W'], ['ambient', 'board', '°C'],
];

export function page(root, ctx) {
  const F = (v, d = 3) => ctx.fmtNum(v, d);
  const eng = (v, u) => {
    const a = Math.abs(v);
    const [m, p] = a >= 1 || a === 0 ? [1, ''] : a >= 1e-3 ? [1e3, 'm'] : a >= 1e-6 ? [1e6, 'µ'] : [1e9, 'n'];
    return `${F(v * m, 3)} ${p}${u}`;
  };

  // ---------- layout ----------
  const fields = {};
  const bar = h('div', { class: 'vt-card vt-bar' });
  for (const [key, label, unit] of NUMS) {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} ${unit}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = inp;
    bar.append(h('label', { class: 'vt-f' }, label, inp, unit || null));
  }
  const layerSeg = h('div', { class: 'vt-seg', role: 'group', 'aria-label': 'Rate as' });
  const fillSeg = h('div', { class: 'vt-seg', role: 'group', 'aria-label': 'Via fill' });
  bar.append(h('span', { class: 'vt-f' }, 'rate as', layerSeg), h('span', { class: 'vt-f' }, 'fill', fillSeg));

  const secHead = h('div', { class: 'vt-head' }, h('h2', {}, 'Section A–A'), h('span', { class: 'sub' }, 'through the first row, to scale'));
  const secBig = h('span', { class: 'big' });
  secHead.append(secBig);
  const secDraw = h('div', { class: 'vt-draw' });
  const sec = h('section', { class: 'vt-card vt-sec', 'aria-label': 'Board section through the vias' }, secHead, secDraw,
    h('div', { class: 'vt-foot' }, h('span', {}, 'Drag the drill dimension, the board’s bottom face, the plating in the detail, or scrub the current.'),
      h('span', {}, h('kbd', {}, '←'), h('kbd', {}, '→'), ' on a focused handle, ', h('kbd', {}, 'Shift'), ' for fine steps')));

  const thDraw = h('div', { class: 'vt-draw' });
  const thermo = h('section', { class: 'vt-card vt-thermo', 'aria-label': 'Temperature' },
    h('div', { class: 'vt-head' }, h('h2', {}, 'Temperature')), thDraw,
    h('div', { class: 'vt-foot' }, 'Drag the limit line.'));

  const padDraw = h('div', { class: 'vt-draw' });
  const padSub = h('span', { class: 'sub' });
  const pad = h('section', { class: 'vt-card vt-pad', 'aria-label': 'Via field, top view' },
    h('div', { class: 'vt-head' }, h('h2', {}, 'Via field'), padSub), padDraw,
    h('div', { class: 'vt-foot' }, 'Click or drag across the grid to set the count; ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' one via.'));

  const drDraw = h('div', { class: 'vt-draw' });
  const drills = h('section', { class: 'vt-card vt-drills', 'aria-label': 'Drill sizes' },
    h('div', { class: 'vt-head' }, h('h2', {}, 'Drill'), h('span', { class: 'sub' }, 'to scale, same plating; A per via at the allowed rise')), drDraw);

  const warns = h('div', { class: 'k-warns vt-warns', 'aria-live': 'polite' });
  const side = h('section', { class: 'vt-side' }, warns);
  root.append(h('div', { class: 'vt' }, bar, sec, thermo, pad, drills, side, h('section', { class: 'vt-out' }, ctx.outputs)));

  // ---------- state ----------
  const st = { drag: null, geo: {}, pending: null };
  const V = () => ctx.result?.via;
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
  const handle = (fk, cls, label, valueText) => sv('g', { class: `h ${cls}`, tabindex: 0, role: 'slider', 'data-fk': fk, 'data-drag': fk,
    'aria-label': label, 'aria-valuetext': valueText });
  const defs = () => {
    const d = sv('defs');
    const p = sv('pattern', { id: 'vt-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    p.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-l' }));
    const a = sv('marker', { id: 'vt-arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    a.append(sv('path', { d: 'M0,1 L9,5 L0,9 Z', class: 'dim-f' }));
    d.append(p, a);
    return d;
  };

  // ---------- section ----------
  function drawSection() {
    const v = V();
    secDraw.style.minHeight = `${secDraw.offsetHeight}px`; // keep the page still while redrawing
    secDraw.replaceChildren();
    if (!v) return;
    const W = Math.max(300, secDraw.clientWidth || 700);
    const wide = W >= 620;
    const insetW = wide ? 200 : 0;
    const Hmain = wide ? 440 : 440;
    const L = wide ? 56 : 16, R = (wide ? 76 : 64) + insetW, T = 92, B = wide ? 118 : 172;
    const c = Math.max(1, Math.min(v.n, Math.ceil(Math.sqrt(v.n))));
    const p = Math.max(1.0, 2.5 * v.drill); // drawing pitch only
    const boardW = (c + 1) * p;
    const s = st.drag?.s ?? Math.min((W - L - R) / boardW, (Hmain - T - B) / v.length, 420);
    const bw = boardW * s, bh = v.length * s;
    const bx0 = L + (W - L - R - bw) / 2, by0 = T + (Hmain - T - B - bh) / 2, bx1 = bx0 + bw, by1 = by0 + bh;
    const foil = Math.max(2, 0.035 * s);
    const tpx = Math.max(1.5, v.tp * s);
    const Dpx = v.drill * s;
    const H = wide ? Hmain : Hmain + 190;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': `Section through ${c} of ${v.n} vias` });
    svg.append(defs());
    // laminate with a glass weave
    svg.append(sv('rect', { x: bx0, y: by0, width: bw, height: bh, class: 'fr4' }));
    const weaveStep = Math.max(9, bh / 7);
    for (let y = by0 + weaveStep / 2; y < by1 - 2; y += weaveStep) svg.append(sv('line', { x1: bx0 + 2, y1: y, x2: bx1 - 2, y2: y, class: 'weave' }));
    // copper on both faces
    svg.append(sv('rect', { x: bx0, y: by0 - foil, width: bw, height: foil, class: 'cu' }),
      sv('rect', { x: bx0, y: by1, width: bw, height: foil, class: 'cu' }));
    svg.append(txt(bx0 + 4, by0 + 13, 'laminate', 'fr4-t sm'));
    // vias
    const tone = v.tone || 'none';
    const cxs = [];
    for (let i = 0; i < c; i++) {
      const cx = bx0 + (i + 1) * p * s;
      cxs.push(cx);
      const x0 = cx - Dpx / 2, x1 = cx + Dpx / 2;
      const inner = Math.max(0, Dpx - 2 * tpx);
      svg.append(sv('rect', { x: x0 + tpx, y: by0 - foil, width: inner, height: bh + 2 * foil, class: v.fill === 'none' ? 'hole' : `fill-${v.fill}` }));
      svg.append(sv('rect', { x: x0, y: by0 - foil, width: tpx, height: bh + 2 * foil, class: 'cu' }),
        sv('rect', { x: x1 - tpx, y: by0 - foil, width: tpx, height: bh + 2 * foil, class: 'cu' }));
      // current in from the top copper
      if (v.I > 0) {
        const wStroke = clamp(2 + 7 * (v.iPer / Math.max(v.iOne, 1e-9)), 2, 12);
        svg.append(sv('path', { d: `M${cx},${T - 34} V${by0 - foil - 8}`, class: `cur`, 'stroke-width': wStroke }),
          sv('path', { d: `M${cx - wStroke / 2 - 4},${by0 - foil - 10} L${cx},${by0 - foil - 1} L${cx + wStroke / 2 + 4},${by0 - foil - 10} Z`, class: 'cur-f' }));
      }
    }
    if (v.n > c) svg.append(txt(bx1 - 4, by1 + foil + 13, `${c} of ${v.n} shown: row 1`, 'soft sm', 'end'));
    // current: a bus above, its label scrubs the value
    const busY = T - 34;
    if (v.I > 0) svg.append(sv('line', { x1: cxs[0] - 10, y1: busY, x2: cxs[cxs.length - 1] + 10, y2: busY, class: 'cur', 'stroke-width': 3 }));
    const curLab = v.I > 0 ? `I ${F(v.I)} A` : 'I 0 A';
    const cg = handle('cur', 'ew', 'Total current in A, scrub left or right', curLab);
    const cw = curLab.length * 7.4 + 18;
    const cxl = clamp((cxs[0] + cxs[cxs.length - 1]) / 2, L + cw / 2, W - R - cw / 2);
    cg.append(sv('rect', { x: cxl - cw / 2, y: busY - 32, width: cw, height: 20, rx: 10, class: 'pill' }),
      txt(cxl, busY - 18, `‹ ${curLab} ›`, 'm pill-t', 'middle'),
      sv('rect', { x: cxl - cw / 2 - 3, y: busY - 35, width: cw + 6, height: 26, rx: 12, class: 'ring' }));
    svg.append(cg);
    if (v.I > 0) svg.append(txt(cxs[cxs.length - 1] + 14, busY + 4, `${F(v.iPer)} A per via`, 'm soft'));
    else svg.append(txt(cxl + cw / 2 + 8, busY - 18, 'no current: heat only', 'soft sm'));
    // the temperature of the barrels
    if (v.I > 0) {
      const lab = `+${F(v.rise)} °C`;
      const lx = cxs[0] + Dpx / 2 + 8, ly = (by0 + by1) / 2 + 4;
      svg.append(sv('rect', { x: lx - 3, y: ly - 12, width: lab.length * 7 + 6, height: 16, rx: 2, class: 'bg', opacity: 0.9 }),
        txt(lx, ly, lab, `m b ${tone === 'ok' ? 'ok-t' : tone === 'warn' ? 'warn-t' : 'danger'}`));
    }
    // drill dimension, its right end is the handle
    const cx0 = cxs[0], yd = by1 + foil + 30;
    svg.append(sv('line', { x1: cx0 - Dpx / 2, y1: by1 + foil + 3, x2: cx0 - Dpx / 2, y2: yd + 5, class: 'ext' }),
      sv('line', { x1: cx0 + Dpx / 2, y1: by1 + foil + 3, x2: cx0 + Dpx / 2, y2: yd + 5, class: 'ext' }),
      sv('line', { x1: cx0 - Dpx / 2, y1: yd, x2: cx0 + Dpx / 2, y2: yd, class: 'dim', 'marker-start': 'url(#vt-arr)', 'marker-end': 'url(#vt-arr)' }));
    const dLab = `⌀ ${num(v.drill, 3)} mm drill`;
    if (wide || cx0 - Dpx / 2 - 6 > dLab.length * 6.6) svg.append(txt(cx0 - Dpx / 2 - 6, yd + 4, dLab, 'm b', 'end'));
    else svg.append(txt(cx0 + Dpx / 2 + 14, yd + 4, dLab, 'm b'));
    const dg = handle('drill', 'ew', 'Drilled hole diameter', `${num(v.drill, 3)} mm`);
    dg.append(sv('circle', { cx: cx0 + Dpx / 2, cy: yd, r: 12, fill: 'transparent' }), sv('circle', { cx: cx0 + Dpx / 2, cy: yd, r: 6, class: 'knob' }),
      sv('circle', { cx: cx0 + Dpx / 2, cy: yd, r: 10, class: 'ring' }));
    svg.append(dg);
    const barrel = `barrel ${F(v.aMm2 * 1e3)}×10⁻³ mm² · ${F(v.aMil2)} mil²`;
    if (wide || cx0 - Dpx / 2 - 6 > dLab.length * 6.6) svg.append(txt(cx0 + Dpx / 2 + 14, yd + 4, barrel, 'm soft sm'));
    else svg.append(txt(cx0 + Dpx / 2 + 14, yd + 17, barrel, 'm soft sm'));
    // length dimension on the right, the bottom end is the handle
    const xl = bx1 + 16;
    svg.append(sv('line', { x1: bx1 + 2, y1: by0 - foil, x2: xl + 6, y2: by0 - foil, class: 'ext' }),
      sv('line', { x1: bx1 + 2, y1: by1 + foil, x2: xl + 6, y2: by1 + foil, class: 'ext' }),
      sv('line', { x1: xl, y1: by0 - foil, x2: xl, y2: by1 + foil, class: 'dim', 'marker-start': 'url(#vt-arr)', 'marker-end': 'url(#vt-arr)' }));
    const lt = txt(xl + 8, (by0 + by1) / 2 + 4, `${num(v.length, 3)} mm`, 'm b');
    svg.append(lt);
    const lg = handle('len', 'ns', 'Via length', `${num(v.length, 3)} mm`);
    lg.append(sv('rect', { x: xl - 12, y: by1 + foil - 12, width: 24, height: 24, fill: 'transparent' }),
      sv('rect', { x: xl - 9, y: by1 + foil - 3, width: 18, height: 6, rx: 3, class: 'knob' }),
      sv('rect', { x: xl - 12, y: by1 + foil - 6, width: 24, height: 12, rx: 6, class: 'ring' }));
    svg.append(lg);
    svg.append(txt(bx0, by0 - foil - 4, 'top copper', 'soft sm'), txt(bx0, by1 + foil + 12, 'bottom copper', 'soft sm'));
    if (v.P > 0) {
      svg.append(txt(bx1 - 2, by0 - foil - 4, `${F(v.P)} W in ↓`, 'm sm b heat-f', 'end'));
      if (v.n <= c) svg.append(txt(bx1 - 2, by1 + foil + 12, `↓ ${F(v.dTboard)} °C cooler`, 'm sm heat-f', 'end'));
    }
    // the numbers along the path
    const yl = by1 + foil + (wide ? 64 : 58);
    const rows = [
      ['Electrical', `R ${eng(v.rOne, 'Ω')} per via · ${eng(v.rArr, 'Ω')} for ${v.n}` + (v.I > 0 ? ` · drop ${eng(v.drop, 'V')} · ${eng(v.pDiss, 'W')} lost` : '') + ` · at ${F(v.tC)} °C`],
      ['Thermal', `Rθ ${F(v.rthOne)} K/W per via · ${F(v.rthArr)} K/W for ${v.n}` + (v.P > 0 ? ` · ${F(v.P)} W → ${F(v.dTboard)} °C across` : '') + ` · ${v.fillName.toLowerCase()}`],
    ];
    rows.forEach(([k, t], i) => {
      if (wide) {
        const tt = txt(L, yl + i * 17, '', 'm');
        const parts = t.split(' · ');
        const hot = i && v.boardTone && v.boardTone !== 'ok';
        tt.append(sv('tspan', { class: 'b', fill: i ? 'var(--tool-heat)' : 'var(--tool-cur)' }, `${k.padEnd(11)}`), sv('tspan', { x: L + 82 }, parts.slice(0, 2).join(' · ')),
          sv('tspan', { class: hot ? (v.boardTone === 'bad' ? 'danger' : 'warn-t') : '' }, parts.length > 2 ? ' · ' + parts.slice(2).join(' · ') : ''));
        svg.append(tt);
      } else {
        const parts = t.split(' · ');
        const y = yl + i * 46;
        svg.append(txt(12, y, k, `b sm`, 'start'));
        svg.lastChild.setAttribute('fill', i ? 'var(--tool-heat)' : 'var(--tool-cur)');
        svg.append(txt(12, y + 13, parts.slice(0, 2).join(' · '), 'm sm'));
        if (parts.length > 2) svg.append(txt(12, y + 26, parts.slice(2).join(' · '), `m sm ${i && v.boardTone === 'bad' ? 'danger' : 'soft'}`));
      }
    });
    svg.append(txt(wide ? L : 12, wide ? yl + 40 : Hmain - 6, `vias drawn ${F(p)} mm apart (pitch does not enter the calculation)`, 'soft sm'));
    // the wall detail
    const ix = wide ? W - insetW + 6 : 12, iy = wide ? T - 30 : Hmain + 20, iw = wide ? insetW - 18 : Math.min(W - 24, 360), ih = 150;
    const dom = 150; // µm across the window
    const k = iw / dom;
    const u0 = 40; // µm of laminate at the left
    const xw = ix + u0 * k, xin = ix + (u0 + v.plating) * k;
    svg.append(sv('rect', { x: ix, y: iy, width: iw, height: ih, class: 'frame' }));
    svg.append(sv('rect', { x: ix, y: iy + 22, width: u0 * k, height: ih - 50, class: 'fr4' }),
      sv('rect', { x: xw, y: iy + 22, width: v.plating * k, height: ih - 50, class: 'cu' }),
      sv('rect', { x: xin, y: iy + 22, width: Math.max(0, ix + iw - xin), height: ih - 50, class: v.fill === 'none' ? 'hole' : `fill-${v.fill}` }));
    svg.append(txt(ix + 6, iy + 14, `Wall detail ×${F((k * 1000) / s, 2)}`, 'b sm'));
    svg.append(txt(ix + 3, iy + 34, 'laminate', 'fr4-t sm'), txt(ix + iw - 4, iy + ih - 34, v.fill === 'none' ? 'hole' : 'fill', 'soft sm', 'end'));
    // IPC-6012 averages as ticks
    for (const [um, lab] of [[20, 'C2'], [25, 'C3']]) {
      const x = xw + um * k;
      svg.append(sv('line', { x1: x, y1: iy + ih - 28, x2: x, y2: iy + ih - 20, class: 'dim' }), txt(lab === 'C2' ? x - 2 : x + 2, iy + ih - 6, `${lab} ${um}`, 'm sm soft', lab === 'C2' ? 'end' : 'start'));
    }
    const pg = handle('plat', 'ew', 'Plating thickness in micrometres', `${num(v.plating, 1)} µm`);
    pg.append(sv('rect', { x: xin - 10, y: iy + 22, width: 20, height: ih - 50, fill: 'transparent' }),
      sv('line', { x1: xin, y1: iy + 22, x2: xin, y2: iy + ih - 28, stroke: 'var(--accent)', 'stroke-width': 2 }),
      sv('circle', { cx: xin, cy: iy + 22 + (ih - 50) / 2, r: 6, class: 'knob' }),
      sv('circle', { cx: xin, cy: iy + 22 + (ih - 50) / 2, r: 10, class: 'ring' }));
    svg.append(pg);
    svg.append(txt(Math.min(xin + 8, ix + iw - 50), iy + 40, `${num(v.plating, 1)} µm`, 'm b'));
    // leader from the first via's left wall to the detail
    const wx = cx0 - Dpx / 2 + tpx / 2, wy = by0 + bh * 0.3;
    svg.append(sv('circle', { cx: wx, cy: wy, r: Math.max(6, tpx * 2.5), class: 'lead' }));
    if (wide) svg.append(sv('path', { d: `M${wx},${wy - Math.max(6, tpx * 2.5)} C${wx},${iy + ih / 2 - 60} ${ix - 40},${iy + ih / 2} ${ix},${iy + ih / 2}`, class: 'lead' }));
    st.geo.sec = { s, k, xw, cx0, Dpx };
    secDraw.append(svg);
    secDraw.style.minHeight = '';
    // headline
    secBig.replaceChildren();
    secBig.append(`${F(v.iOne)} A per via · ${F(v.iArr)} A for ${v.n} at +${F(v.dT)} °C`);
    secBig.style.color = v.I > 0 ? (v.iArr >= v.I ? 'var(--ok)' : 'var(--danger)') : '';
  }

  // ---------- thermometer ----------
  function drawThermo(Htarget) {
    const v = V();
    thDraw.style.minHeight = `${thDraw.offsetHeight}px`; // keep the page still while redrawing
    thDraw.replaceChildren();
    if (!v) return;
    const W = Math.max(170, thDraw.clientWidth || 190);
    const H = clamp(Htarget || 440, 300, 520);
    const top = 34, bot = H - 58;
    const span = Math.max(v.dT * 1.8, v.rise * 1.15, v.dTboard * 1.15, 5);
    const Y = (dt) => bot - (clamp(dt, 0, span) / span) * (bot - top);
    const tx = 64, tw = 16;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Temperature scale' });
    svg.append(defs());
    // allowed band and past it
    svg.append(sv('rect', { x: tx - 20, y: Y(v.dT), width: W - tx + 8, height: bot - Y(v.dT), class: 'okband' }),
      sv('rect', { x: tx - 20, y: top, width: W - tx + 8, height: Y(v.dT) - top, class: 'badband' }));
    // ticks
    const step = [1, 2, 5, 10, 20, 50, 100, 200].find((x) => span / x <= 8) || 500;
    for (let t = 0; t <= span + 1e-9; t += step) {
      svg.append(sv('line', { x1: tx - 14, y1: Y(t), x2: tx - 8, y2: Y(t), class: 'tick' }), txt(tx - 18, Y(t) + 3, `${F(v.ta + t)}`, 'm sm soft', 'end'));
    }
    svg.append(txt(8, top - 14, '°C', 'm sm soft'));
    // tube and bulb, filled to the barrel temperature
    svg.append(sv('rect', { x: tx - tw / 2, y: top - 6, width: tw, height: bot - top + 10, rx: tw / 2, class: 'tube' }),
      sv('circle', { cx: tx, cy: bot + 16, r: 14, class: 'tube' }));
    const tone = v.tone || 'ok';
    const fillCls = v.I > 0 ? `t-${tone}` : 'heat-f';
    const lvl = v.I > 0 ? v.rise : v.dTboard;
    svg.append(sv('rect', { x: tx - 4, y: Y(lvl), width: 8, height: bot - Y(lvl) + 6, rx: 4, class: fillCls }),
      sv('circle', { cx: tx, cy: bot + 16, r: 9, class: fillCls }));
    svg.append(txt(tx, bot + 48, `board ${F(v.ta)} °C`, 'm sm soft', 'middle'));
    // the barrel at your current
    if (v.I > 0) {
      const y = Y(v.rise);
      svg.append(sv('path', { d: `M${tx + 10},${y} l8,-5 v10 Z`, class: `t-${tone}` }));
      svg.append(txt(tx + 22, y - 2, `${F(v.ta + v.rise)} °C`, `m b ${tone === 'ok' ? 'ok-t' : tone === 'warn' ? 'warn-t' : 'danger'}`));
      svg.append(txt(tx + 22, y + 10, `barrels, +${F(v.rise)}`, 'sm soft'));
      if (v.rise > span) svg.append(txt(tx + 22, top + 4, 'off the scale ↑', 'sm danger'));
    }
    // heat through the board: the top face, kept clear of the barrels' label
    if (v.P > 0) {
      let y = Y(v.dTboard);
      const yb = v.I > 0 ? Y(v.rise) : -1e3;
      const ly = Math.abs(y - yb) < 30 ? (y <= yb ? yb - 30 : yb + 30) : y;
      svg.append(sv('path', { d: `M${tx + 10},${y} l8,-5 v10 Z`, class: 'heat-f' }));
      svg.append(txt(tx + 22, ly - 2, `${F(v.ta + v.dTboard)} °C`, 'm b heat-f'));
      svg.append(txt(tx + 22, ly + 10, `top face at ${F(v.P)} W`, 'sm soft'));
      if (v.dTboard > span) svg.append(txt(tx + 22, top + 4, 'off the scale ↑', 'sm danger'));
    }
    // the limit: drag it
    const yl = Y(v.dT);
    const g = handle('dt', 'ns', 'Allowed temperature rise', `${F(v.dT)} °C`);
    g.append(sv('rect', { x: tx - 20, y: yl - 10, width: W - tx + 8, height: 20, fill: 'transparent' }),
      sv('line', { x1: tx - 20, y1: yl, x2: W - 4, y2: yl, class: 'lim' }),
      sv('rect', { x: W - 58, y: yl - 9, width: 54, height: 18, rx: 9, class: 'pill' }),
      txt(W - 31, yl + 4, `+${F(v.dT)}`, 'm sm pill-t', 'middle'),
      sv('rect', { x: W - 61, y: yl - 12, width: 60, height: 24, rx: 12, class: 'ring' }));
    svg.append(g);
    svg.append(txt(W - 6, yl - 14, 'limit', 'sm danger', 'end'));
    st.geo.th = { top, bot, span };
    thDraw.append(svg);
    thDraw.style.minHeight = '';
  }

  // ---------- via field ----------
  function drawField() {
    const v = V();
    padDraw.style.minHeight = `${padDraw.offsetHeight}px`; // keep the page still while redrawing
    padDraw.replaceChildren();
    if (!v) return;
    const W = Math.max(260, padDraw.clientWidth || 360);
    const want = Math.max(v.n, v.needed || 0, 4);
    const g = clamp(Math.ceil(Math.sqrt(want)) + 1, 3, 7);
    const cs = Math.min((W - 60) / g, 200 / g + 12);
    const x0 = (W - g * cs) / 2, y0 = 28;
    const H = y0 + g * cs + 34;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
    const fg = sv('g', { class: 'field', tabindex: 0, role: 'slider', 'data-fk': 'field', 'aria-label': 'Number of vias',
      'aria-valuenow': v.n, 'aria-valuemin': 1, 'aria-valuemax': g * g });
    fg.append(sv('rect', { x: x0 - 8, y: y0 - 8, width: g * cs + 16, height: g * cs + 16, rx: 6, class: 'padcu' }));
    const p = Math.max(1.0, 2.5 * v.drill);
    const ro = clamp((v.drill / p) * cs * 0.9, 4, cs * 0.42), ri = ro * Math.max(0.2, 1 - (2 * v.tp) / v.drill);
    for (let i = 0; i < g * g; i++) {
      const cx = x0 + (i % g + 0.5) * cs, cy = y0 + (Math.floor(i / g) + 0.5) * cs;
      const cg = sv('g', { class: 'cell', 'data-cell': i });
      cg.append(sv('rect', { x: cx - cs / 2, y: cy - cs / 2, width: cs, height: cs, fill: 'transparent' }));
      if (i < v.n) {
        cg.append(sv('circle', { cx, cy, r: ro, class: 'cu' }), sv('circle', { cx, cy, r: ri, class: v.fill === 'none' ? 'hole' : `fill-${v.fill}` }));
        if (v.tone) cg.append(sv('circle', { cx, cy, r: ro + 3, fill: 'none', class: `s-${v.tone}`, 'stroke-width': 2 }));
      } else if (v.needed && i < v.needed) cg.append(sv('circle', { cx, cy, r: ro, class: 'miss' }));
      else cg.append(sv('circle', { cx, cy, r: ro, class: 'ghost' }));
      fg.append(cg);
    }
    svg.append(fg);
    if (v.n > g * g) svg.append(txt(W / 2, y0 + g * cs / 2, `${v.n} vias`, 'b', 'middle'));
    // section line through the first row
    const ys = y0 + cs / 2;
    svg.append(sv('line', { x1: x0 - 20, y1: ys, x2: x0 + g * cs + 20, y2: ys, class: 'secline' }),
      txt(x0 - 22, ys + 4, 'A', 'b', 'end'), txt(x0 + g * cs + 22, ys + 4, 'A', 'b'));
    const need = v.needed;
    const msg = v.I > 0 ? (need > v.n ? `${need - v.n} more needed: ${need} for ${F(v.I)} A` : `${need} needed for ${F(v.I)} A, ${v.n} placed`) : `${v.n} placed`;
    svg.append(txt(W / 2, H - 10, msg, `m ${v.I > 0 && need > v.n ? 'danger' : 'soft'}`, 'middle'));
    st.geo.field = { x0, y0, cs, g };
    padDraw.append(svg);
    padDraw.style.minHeight = '';
    padSub.textContent = `${v.n} via${v.n > 1 ? 's' : ''} · ${F(v.iArr)} A`;
  }

  // ---------- drill ladder ----------
  function drawDrills() {
    const v = V();
    drDraw.style.minHeight = `${drDraw.offsetHeight}px`; // keep the page still while redrawing
    drDraw.replaceChildren();
    if (!v || !v.drills.length) return;
    const W = Math.max(240, drDraw.clientWidth || 360);
    const n = v.drills.length;
    const cw = W / n;
    const maxD = Math.max(...v.drills.map((d) => d.d));
    const k = Math.min((cw - 8) / maxD, 34 / maxD);
    const H = 48 + maxD * k + 30;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Drill sizes' });
    const cy = 10 + (maxD * k) / 2;
    v.drills.forEach((d, i) => {
      const cx = cw * (i + 0.5);
      const on = Math.abs(d.d - v.drill) < 1e-6;
      const fits = v.I > 0 ? d.i * v.n >= v.I : null;
      const g = sv('g', { class: 'dr', tabindex: 0, role: 'button', 'data-fk': `dr${i}`, 'data-drill': d.d, 'aria-pressed': String(on),
        'aria-label': `${d.d} mm drill: ${F(d.i)} A per via, ${F(d.rth)} K/W` });
      g.append(sv('rect', { x: cx - cw / 2 + 1, y: 1, width: cw - 2, height: H - 2, rx: 4, class: 'box' }));
      const r = (d.d / 2) * k, ri = Math.max(0, r - Math.max(1.2, v.tp * k));
      g.append(sv('circle', { cx, cy, r, class: 'cu' }), sv('circle', { cx, cy, r: ri, class: v.fill === 'none' ? 'hole' : `fill-${v.fill}` }));
      g.append(txt(cx, H - 32, String(d.d), `m ${on ? 'b' : ''}`, 'middle'),
        txt(cx, H - 18, `${F(d.i, 2)} A`, `m sm ${fits == null ? 'soft' : fits ? 'ok-t' : 'danger'}`, 'middle'),
        txt(cx, H - 6, `${F(d.rth, 2)}`, 'm sm soft', 'middle'));
      svg.append(g);
    });
    drDraw.append(svg);
    drDraw.style.minHeight = '';
  }

  // ---------- pointer and keys ----------
  const svgX = (box, e) => {
    const svg = box.querySelector('svg'); const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
  };
  const start = (box, e, kind, extra = {}) => {
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const pt = svgX(box, e);
    const v = V();
    st.drag = { kind, box, x: pt.x, y: pt.y, v: { ...v }, ...extra };
    box.querySelector(`[data-fk="${kind}"]`)?.focus({ preventScroll: true });
  };
  secDraw.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-drag]'); if (!hEl || !V()) return;
    start(secDraw, e, hEl.getAttribute('data-drag'), { s: st.geo.sec.s, k: st.geo.sec.k });
  });
  thDraw.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-drag]'); if (!hEl || !V()) return;
    start(thDraw, e, 'dt', { th: { ...st.geo.th } });
  });
  const cellAt = (e) => {
    const f = st.geo.field; if (!f) return null;
    const pt = svgX(padDraw, e);
    const c = Math.floor((pt.x - f.x0) / f.cs), r = Math.floor((pt.y - f.y0) / f.cs);
    if (c < 0 || r < 0 || c >= f.g || r >= f.g) return null;
    return r * f.g + c;
  };
  padDraw.addEventListener('pointerdown', (e) => {
    const i = cellAt(e); if (i == null || !V()) return;
    e.preventDefault();
    padDraw.setPointerCapture(e.pointerId);
    padDraw.querySelector('[data-fk="field"]')?.focus({ preventScroll: true });
    const v = V();
    const next = i + 1 === v.n && v.n > 1 ? i : i + 1;
    st.drag = { kind: 'field', box: padDraw };
    if (next !== v.n) ctx.set('count', String(next));
  });
  const move = (e) => {
    const d = st.drag; if (!d) return;
    if (d.kind === 'field') {
      const i = cellAt(e); if (i != null && i + 1 !== V()?.n) setSoon({ count: String(i + 1) });
      return;
    }
    const pt = svgX(d.box, e);
    const dx = pt.x - d.x, dy = pt.y - d.y;
    if (d.kind === 'drill') {
      const minD = 2 * d.v.tp + 0.05;
      setSoon({ drill: num(clamp(Math.round((d.v.drill + (2 * dx) / d.s) * 200) / 200, minD, 3), 3) });
    } else if (d.kind === 'len') {
      setSoon({ length: num(clamp(Math.round((d.v.length + dy / d.s) * 20) / 20, 0.1, 6), 2) });
    } else if (d.kind === 'plat') {
      const maxUm = Math.min(70, (d.v.drill / 2) * 1000 - 20);
      setSoon({ plating: num(clamp(Math.round(d.v.plating + dx / d.k), 5, maxUm), 0) });
    } else if (d.kind === 'cur') {
      const step = d.v.I >= 20 ? 1 : 0.1;
      setSoon({ current: num(clamp(Math.round((d.v.I + (dx / 6) * step) / step) * step, 0, 500), 2) });
    } else if (d.kind === 'dt') {
      const t = d.th;
      const val = ((t.bot - pt.y) / (t.bot - t.top)) * t.span;
      setSoon({ dtmax: num(clamp(Math.round(val), 1, 100), 0) });
    }
  };
  const end = () => { if (st.drag) { st.drag = null; redraw(renderAll); } };
  for (const box of [secDraw, thDraw, padDraw]) {
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }
  drDraw.addEventListener('click', (e) => { const g = e.target.closest('[data-drill]'); if (g) ctx.set('drill', g.getAttribute('data-drill')); });
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-fk]'); const v = V(); if (!t || !v) return;
    const fk = t.getAttribute('data-fk');
    if (fk.startsWith('dr') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.set('drill', t.getAttribute('data-drill')); return; }
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) {
      if (fk === 'field' && (e.key === 'PageUp' || e.key === 'PageDown')) { e.preventDefault(); ctx.set('count', String(Math.max(1, v.n + (e.key === 'PageUp' ? 5 : -5)))); }
      return;
    }
    const fine = e.shiftKey;
    const upd = {
      drill: () => ({ drill: num(clamp(v.drill + dir * (fine ? 0.01 : 0.05), 2 * v.tp + 0.05, 3), 3) }),
      len: () => ({ length: num(clamp(v.length + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) * (fine ? 0.05 : 0.1), 0.1, 6), 2) }),
      plat: () => ({ plating: num(clamp(v.plating + dir * (fine ? 1 : 5), 5, 70), 0) }),
      cur: () => ({ current: num(Math.max(0, v.I + dir * (fine ? 0.1 : 1)), 2) }),
      dt: () => ({ dtmax: num(clamp(v.dT + dir * (fine ? 1 : 5), 1, 100), 0) }),
      field: () => ({ count: String(Math.max(1, v.n + dir)) }),
    }[fk];
    if (upd) { e.preventDefault(); ctx.setMany(upd()); }
  });

  // ---------- result -> page ----------
  const sync = (inp, val) => { if (document.activeElement !== inp) inp.value = val ?? ''; };
  function renderAll() {
    const raw = ctx.raw, res = ctx.result || {};
    for (const [key] of NUMS) {
      sync(fields[key], raw[key]);
      fields[key].classList.toggle('bad', String(raw[key] ?? '').trim() !== '' && ctx.parseEng(raw[key]) == null);
    }
    layerSeg.replaceChildren(...[['external', 'external'], ['internal', 'internal']].map(([k, t]) =>
      h('button', { type: 'button', 'aria-pressed': String((raw.layer || 'external') === k), onclick: () => ctx.set('layer', k),
        title: k === 'external' ? 'IPC-2221 external conductor, k = 0.048' : 'IPC-2221 internal conductor, k = 0.024 (conservative)' }, t)));
    fillSeg.replaceChildren(...FILLS.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String((raw.fill || 'none') === k),
      onclick: () => ctx.set('fill', k) }, t)));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    if (!res.via) {
      for (const d of [secDraw, thDraw, padDraw, drDraw]) d.replaceChildren();
      secDraw.append(h('div', { class: 'vt-foot', style: 'padding:30px 12px' }, (res.warnings || []).join(' ')));
      secBig.textContent = '';
      return;
    }
    drawSection();
    const secH = secDraw.querySelector('svg')?.getAttribute('height');
    drawThermo(window.innerWidth > 700 ? Number(secH) : 340);
    drawField();
    drawDrills();
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
