// Copper Area Thermal: the page is the board seen from above. The pour is
// drawn to scale around the package and coloured by its temperature (the fin
// profile from run()); drag a corner to grow it, scrub the watts on the
// package, and read the temperatures off a thermometer whose colour ramp is
// the same one the copper is painted with. A board-edge section picks the
// stitched layers and copper weight; Tj against area sits below it.
// Every number drawn comes from run()'s result (result.thermal).

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
// Drags listen on the window: the drawing is rebuilt on every result, so the
// element that took the pointerdown is gone by the next move.
function drag(e, move, end) {
  e.preventDefault();
  const mv = (ev) => move(ev);
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); end?.(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
const sig = (v, n = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(n))));
const deg = (v) => (v == null || !Number.isFinite(v) ? '–' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const round3 = (v) => String(Number(v.toPrecision(3)));

// Packages drawn to scale: body w × l, thermal pad area (the manifest's hints), leads.
const PACKAGES = [
  { id: 'qfn3', name: 'QFN 3×3', pad: 3, body: [3, 3], padWH: [1.7, 1.7], leads: 'qfn' },
  { id: 'so8ep', name: 'SO-8 EP', pad: 6, body: [3.9, 4.9], padWH: [2.4, 2.5], leads: 'so' },
  { id: 'sot223', name: 'SOT-223', pad: 11, body: [6.5, 3.5], padWH: [3.0, 3.6], leads: 'sot', tab: true },
  { id: 'qfn5', name: 'QFN 5×5', pad: 12, body: [5, 5], padWH: [3.5, 3.5], leads: 'qfn' },
  { id: 'dpak', name: 'DPAK', pad: 40, body: [6.6, 6.1], padWH: [6.6, 6.1], leads: 'dpak', tab: true },
  { id: 'd2pak', name: 'D²PAK', pad: 90, body: [10.2, 9.2], padWH: [10.2, 8.8], leads: 'dpak', tab: true },
];
const OZ = [['0.5', '0.5 oz', 18], ['1', '1 oz', 35], ['2', '2 oz', 70], ['3', '3 oz', 105]];
const LAYERS = [['1', 'Top only'], ['2', 'Top + bottom'], ['4', 'All 4 layers']];

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let T = null;        // result.thermal
  let res = null;
  let frozen = null;   // view extents held while a drag is running
  let tFrozen = null;
  let lastE = 20;

  // ---------- number fields (the keyboard path for everything) ----------
  const fields = {};
  const numField = (key, label, unit, title) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title || label,
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'ct-num', title: title || null }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    fields[key] = inp;
    return w;
  };
  const syncFields = () => {
    const raw = ctx.raw;
    for (const [k, inp] of Object.entries(fields)) if (document.activeElement !== inp) inp.value = raw[k] ?? '';
  };

  // package chips
  const pkgBar = h('div', { class: 'ct-pkgs', role: 'radiogroup', 'aria-label': 'Package' });
  const pkgBtns = PACKAGES.map((p) => h('button', { type: 'button', role: 'radio', 'data-v': p.id, title: `${p.name}: thermal pad ≈ ${p.pad} mm²`,
    onclick: () => ctx.set('pad', String(p.pad)),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const n = PACKAGES[clamp(PACKAGES.indexOf(p) + d, 0, PACKAGES.length - 1)];
      ctx.set('pad', String(n.pad)); requestAnimationFrame(() => pkgBar.querySelector(`[data-v="${n.id}"]`)?.focus());
    } }, p.name));
  pkgBar.append(...pkgBtns);

  const top = h('div', { class: 'ct-top' },
    h('div', { class: 'ct-group' }, h('span', { class: 'ct-cap' }, 'Package'), pkgBar, numField('pad', 'pad', 'mm²', 'Package thermal pad area, mm²')),
    h('div', { class: 'ct-group ct-fields' },
      numField('p', 'P', 'W', 'Power in the part, W'),
      numField('area', 'Cu', 'mm²', 'Copper area on one layer, mm²'),
      numField('tjc', 'θJB', '°C/W', 'Junction to board, °C/W (θJC bottom for tab or exposed-pad parts)'),
      numField('ta', 'Ta', '°C', 'Ambient, °C'),
      numField('tjmax', 'Tj max', '°C', 'Maximum junction temperature, °C'),
      numField('air', 'air', 'm/s', 'Air speed, m/s; 0 = still air, board vertical')));

  // ---------- the board, from above ----------
  const planSvg = sv(null, 'svg', { class: 'ct-plan-svg', role: 'group', 'aria-label': 'Copper pour around the package, seen from above, to scale' });
  const planNote = h('div', { class: 'ct-plan-note' });
  const planWarn = h('div', { class: 'ct-warns', 'aria-live': 'polite' });
  const plan = h('section', { class: 'ct-plan' }, h('div', { class: 'ct-box' }, planSvg), planNote, planWarn);

  // ---------- thermometer (the colour ramp) ----------
  const thermoSvg = sv(null, 'svg', { class: 'ct-thermo-svg', role: 'group', 'aria-label': 'Temperatures from ambient to the junction limit' });
  const thermo = h('section', { class: 'ct-thermo' }, h('div', { class: 'ct-cap ct-pad' }, 'Temperature'), h('div', { class: 'ct-box' }, thermoSvg));

  // ---------- board edge section + curve + outputs ----------
  const stackSvg = sv(null, 'svg', { class: 'ct-stack-svg', viewBox: '0 0 340 132', role: 'group', 'aria-label': 'Board edge: copper layers carrying the pour' });
  const ozSeg = h('div', { class: 'ct-seg', role: 'radiogroup', 'aria-label': 'Copper weight' });
  const ozBtns = OZ.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('oz', v),
    onkeydown: (e) => segNav(e, OZ.map((o) => o[0]), v, 'oz', ozSeg) }, t));
  ozSeg.append(...ozBtns);
  const layerSeg = h('div', { class: 'ct-seg', role: 'radiogroup', 'aria-label': 'Layers with this area, stitched with vias' });
  const layerBtns = LAYERS.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('layers', v),
    onkeydown: (e) => segNav(e, LAYERS.map((o) => o[0]), v, 'layers', layerSeg) }, t));
  layerSeg.append(...layerBtns);
  function segNav(e, vals, v, key, seg) {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return; e.preventDefault();
    const n = vals[clamp(vals.indexOf(v) + d, 0, vals.length - 1)];
    ctx.set(key, n); requestAnimationFrame(() => seg.querySelector(`[data-v="${n}"]`)?.focus());
  }
  const stackFacts = h('div', { class: 'ct-facts' });
  const stack = h('section', { class: 'ct-card ct-stack' },
    h('div', { class: 'ct-head' }, h('span', { class: 'ct-cap' }, 'Board edge'), layerSeg, ozSeg),
    stackSvg, stackFacts);

  const curveSvg = sv(null, 'svg', { class: 'ct-curve-svg', role: 'group', 'aria-label': 'Junction temperature against copper area' });
  const curveHead = h('div', { class: 'ct-head' });
  const curve = h('section', { class: 'ct-card ct-curve' }, curveHead, h('div', { class: 'ct-box' }, curveSvg));

  const side = h('aside', { class: 'ct-side' }, stack, curve, ctx.outputs);
  const layout = h('div', { class: 'ct' }, top, plan, thermo, side);
  root.append(layout);

  // ---------- colours: the ramp, read from the theme ----------
  const probe = h('i', { style: 'display:none' });
  root.append(probe);
  const rgb = (v) => { probe.style.color = `var(${v})`; const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0]; return m.slice(0, 3).map(Number); };
  let RAMP = [];
  const readRamp = () => { RAMP = ['--tool-t0', '--tool-t1', '--tool-t2', '--tool-t3'].map(rgb); };
  const tLo = () => T.ta, tHi = () => Math.max(T.tjmax ?? T.tj, T.tBoard + 1);
  const colour = (t) => {
    const u = clamp((t - tLo()) / (tHi() - tLo()), 0, 1) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(u)), f = u - i;
    const c = RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f));
    return `rgb(${c.join(',')})`;
  };

  // ---------- the plan ----------
  const pkgFor = (pad) => PACKAGES.find((p) => Math.abs(p.pad - pad) < 1e-9) || null;

  function drawPlan() {
    const svg = planSvg;
    svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 600), H = Math.max(260, svg.clientHeight || 500);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const side = Math.sqrt(T.area), padSide = Math.sqrt(T.pad);
    const need = typeof T.aNeed === 'number' ? Math.sqrt(T.aNeed) : null;
    // half-extent in mm: the pour, the needed pour if it is not absurd, a floor for tiny parts
    let E = Math.max(side * 0.62, need && need < side * 3 ? need * 0.6 : 0, 9);
    if (frozen) E = Math.max(frozen.E, side * 0.56);
    lastE = E;
    const k = Math.min(W, H) / (2 * E) * 0.94; // px per mm
    const cx = W / 2, cy = H / 2 + 6;
    const X = (x) => cx + x * k, Y = (y) => cy + y * k;
    const defs = sv(svg, 'defs');

    // board and a 1 mm / 5 mm grid, like the layout editor
    sv(svg, 'rect', { x: 0, y: 0, width: W, height: H, class: 'ct-fr4' });
    const g5 = E > 30 ? 10 : 5, g1 = E > 30 ? 5 : 1;
    const gridPath = (step) => {
      let d = '';
      const n = Math.ceil((Math.max(W, H) / k) / step) + 2;
      for (let i = -n; i <= n; i++) {
        const x = X(i * step), y = Y(i * step);
        if (x >= 0 && x <= W) d += `M${x.toFixed(1)},0V${H}`;
        if (y >= 0 && y <= H) d += `M0,${y.toFixed(1)}H${W}`;
      }
      return d;
    };
    if (g1 * k > 5) sv(svg, 'path', { d: gridPath(g1), class: 'ct-grid1' });
    sv(svg, 'path', { d: gridPath(g5), class: 'ct-grid5' });

    // the pour, painted with the fin profile (the model's round fin of the same area)
    const corner = side / Math.SQRT2;
    const grad = sv(defs, 'radialGradient', { id: 'ct-heat', gradientUnits: 'userSpaceOnUse', cx: X(0), cy: Y(0), r: corner * k });
    const prof = T.profile;
    sv(grad, 'stop', { offset: 0, 'stop-color': colour(prof[0][1]) });
    for (const [r, t] of prof) sv(grad, 'stop', { offset: clamp(r / corner, 0, 1).toFixed(4), 'stop-color': colour(t) });
    sv(grad, 'stop', { offset: 1, 'stop-color': colour(prof[prof.length - 1][1]) });
    sv(svg, 'rect', { x: X(-side / 2), y: Y(-side / 2), width: side * k, height: side * k, fill: 'url(#ct-heat)', class: 'ct-pour' });
    // the equivalent round fin the model uses
    sv(svg, 'circle', { cx: X(0), cy: Y(0), r: T.radius * k, class: 'ct-fin' });
    // isotherms at round temperatures between the edge and the pad
    const tE = T.tEdge, tB = T.tBoard;
    const span = tB - tE;
    if (span > 1.5) {
      const step = [1, 2, 5, 10, 20, 50].find((s) => span / s <= 5) || 100;
      for (let t = Math.ceil((tE + 0.3) / step) * step; t < tB - 0.3; t += step) {
        let r = null;
        for (let i = 1; i < prof.length; i++) {
          const [r0, t0] = prof[i - 1], [r1, t1] = prof[i];
          if ((t0 - t) * (t1 - t) <= 0 && t0 !== t1) { r = r0 + (r1 - r0) * (t0 - t) / (t0 - t1); break; }
        }
        if (r == null || r * k < padSide * k * 0.7 + 6) continue;
        sv(svg, 'circle', { cx: X(0), cy: Y(0), r: r * k, class: 'ct-iso' });
        if (r * k > 34) sv(svg, 'text', { x: X(-r * 0.7071) - 3, y: Y(r * 0.7071) + 11, 'text-anchor': 'end', class: 'ct-iso-t' }, `${t} °C`);
      }
    }

    // the needed area, dashed
    if (need && Math.abs(need - side) / side > 0.02 && need * k < Math.max(W, H) * 1.6) {
      sv(svg, 'rect', { x: X(-need / 2), y: Y(-need / 2), width: need * k, height: need * k, class: `ct-need ${need > side ? 'ct-need-more' : ''}` });
      const txt = `Tj ${deg(T.tjmax)} °C at ${sig(T.aNeed)} mm²`;
      if (need > side) {
        const lx = X(need / 2), ly = Y(need / 2);
        if (ly + 16 < H) sv(svg, 'text', { x: Math.min(lx, W - 6), y: ly + 14, class: 'ct-need-t ct-need-more', 'text-anchor': 'end' }, `needed: ${txt}`);
      } else if (need * k > 150) {
        sv(svg, 'text', { x: X(-need / 2) + 5, y: Y(-need / 2) + 14, class: 'ct-need-t' }, `limit: ${txt}`);
      }
    }

    // air flow
    if (T.air > 0) {
      for (let i = 0; i < 5; i++) {
        const y = 24 + (H - 48) * (i + 0.5) / 5;
        sv(svg, 'path', { d: `M8,${y}h${Math.min(60, W * 0.08)}m-6,-4l6,4l-6,4`, class: 'ct-air' });
      }
      sv(svg, 'text', { x: 8, y: 18, class: 'ct-air-t' }, `air ${sig(T.air)} m/s →`);
    }

    // the package, to scale
    const pk = pkgFor(T.pad);
    const g = sv(svg, 'g', { class: 'ct-pkg' });
    if (pk) {
      const [bw, bl] = pk.body;
      const [pw, pl] = pk.padWH;
      if (pk.leads === 'qfn') {
        const n = pk.id === 'qfn3' ? 4 : 6, pitch = pk.id === 'qfn3' ? 0.5 : 0.65;
        for (let s = 0; s < 4; s++) for (let i = 0; i < n; i++) {
          const o = (i - (n - 1) / 2) * pitch, L = 0.4, w = 0.25;
          const [x, y, ww, hh] = s === 0 ? [o - w / 2, -bl / 2, w, L] : s === 1 ? [o - w / 2, bl / 2 - L, w, L] : s === 2 ? [-bw / 2, o - w / 2, L, w] : [bw / 2 - L, o - w / 2, L, w];
          sv(g, 'rect', { x: X(x), y: Y(y), width: ww * k, height: hh * k, class: 'ct-lead' });
        }
        sv(g, 'rect', { x: X(-bw / 2), y: Y(-bl / 2), width: bw * k, height: bl * k, class: 'ct-body' });
        sv(g, 'rect', { x: X(-pw / 2), y: Y(-pl / 2), width: pw * k, height: pl * k, class: 'ct-tab' });
      } else if (pk.leads === 'so') {
        for (let s = -1; s <= 1; s += 2) for (let i = 0; i < 4; i++) {
          const y = (i - 1.5) * 1.27;
          sv(g, 'rect', { x: X(s < 0 ? -3 : bw / 2), y: Y(y - 0.21), width: (3 - bw / 2) * k, height: 0.42 * k, class: 'ct-lead' });
        }
        sv(g, 'rect', { x: X(-bw / 2), y: Y(-bl / 2), width: bw * k, height: bl * k, class: 'ct-body' });
        sv(g, 'rect', { x: X(-pw / 2), y: Y(-pl / 2), width: pw * k, height: pl * k, class: 'ct-tab' });
      } else if (pk.leads === 'sot') {
        // tab on top edge, three leads below
        sv(g, 'rect', { x: X(-pw / 2), y: Y(-bl / 2 - 1.6), width: pw * k, height: (1.6 + 1.2) * k, class: 'ct-tab' });
        for (let i = -1; i <= 1; i++) sv(g, 'rect', { x: X(i * 2.3 - 0.35), y: Y(bl / 2), width: 0.7 * k, height: 1.6 * k, class: 'ct-lead' });
        sv(g, 'rect', { x: X(-bw / 2), y: Y(-bl / 2), width: bw * k, height: bl * k, class: 'ct-body' });
      } else {
        // DPAK / D2PAK: tab under the body and above it, two leads below
        const tabTop = -bl / 2 - (pk.id === 'dpak' ? 1.0 : 1.4);
        sv(g, 'rect', { x: X(-pw / 2), y: Y(tabTop), width: pw * k, height: (pl + (pk.id === 'dpak' ? 1.0 : 1.4) - 1) * k, class: 'ct-tab' });
        const lp = pk.id === 'dpak' ? 2.29 : 2.54;
        for (const i of [-1, 1]) sv(g, 'rect', { x: X(i * lp - 0.4), y: Y(bl / 2), width: 0.8 * k, height: (pk.id === 'dpak' ? 2.7 : 4.5) * k, class: 'ct-lead' });
        sv(g, 'rect', { x: X(-bw / 2 + 0.3), y: Y(-bl / 2 + 0.6), width: (bw - 0.6) * k, height: (bl - 0.6) * k, class: 'ct-body' });
      }
    } else {
      const b = padSide * 1.35;
      sv(g, 'rect', { x: X(-b / 2), y: Y(-b / 2), width: b * k, height: b * k, class: 'ct-body' });
      sv(g, 'rect', { x: X(-padSide / 2), y: Y(-padSide / 2), width: padSide * k, height: padSide * k, class: 'ct-tab' });
    }

    // the watts, scrubbed on the part itself
    const pwr = sv(svg, 'g', { class: 'ct-watts', tabindex: 0, role: 'slider', 'aria-label': 'Power in the part, W; drag up or down, or arrow keys',
      'aria-valuenow': T.p, 'aria-valuetext': `${sig(T.p)} W` });
    // on the part when it is big enough to hold the label, else just above it
    const bodyHalf = pk ? Math.max(pk.body[1], pk.padWH[1]) / 2 + (pk.tab ? 1.6 : 0) : padSide * 0.7;
    const small = bodyHalf * 2 * k < 60;
    const pwY = small ? Y(-bodyHalf) - 26 : Y(0);
    if (small) sv(svg, 'path', { d: `M${X(0)},${pwY + 14}V${Y(-bodyHalf) - 2}`, class: 'ct-dim' });
    sv(pwr, 'rect', { x: X(0) - 38, y: pwY - 14, width: 76, height: 28, rx: 4, class: 'ct-watts-box' });
    sv(pwr, 'text', { x: X(0), y: pwY + 5, 'text-anchor': 'middle', class: 'ct-watts-t' }, `${sig(T.p)} W`);
    sv(pwr, 'path', { d: `M${X(0) + 30},${pwY - 7}l3,-4l3,4M${X(0) + 30},${pwY + 7}l3,4l3,-4`, class: 'ct-watts-arr' });
    bindScrub(pwr, (dy) => ctx.set('p', round3(clamp(dragStart.p * Math.exp(-dy / 120), 0.01, 200))),
      (dir, big) => ctx.set('p', round3(clamp(T.p * (big ? 1.25 : 1.05) ** dir, 0.01, 200))), () => ({ p: T.p }));

    // pad temperature next to the part, edge temperature on the rim
    const padLbl = sv(svg, 'g', { class: 'ct-lbl' });
    const lx = X(0) + (small ? Math.max(bodyHalf * k, 10) + 8 : 44), ly = small ? Y(0) + 4 : pwY + 26;
    sv(padLbl, 'text', { x: lx, y: ly, class: 'ct-lbl-t' }, `pad ${deg(T.tBoard)} °C`);
    sv(padLbl, 'text', { x: lx, y: ly + 14, class: 'ct-lbl-s' }, `Tj ${deg(T.tj)} °C`);
    const ex = X(side / 2), ey = Y(0);
    const edgeInside = ex + 96 > W;
    if (edgeInside) sv(svg, 'text', { x: ex - 6, y: Y(side / 2) - 7, 'text-anchor': 'end', class: 'ct-lbl-t ct-edge-t' }, `edge ${deg(T.tEdge)} °C`);
    else sv(svg, 'text', { x: ex + 8, y: ey + 4, class: 'ct-lbl-t ct-edge-t' }, `edge ${deg(T.tEdge)} °C`);

    // dimensions of the pour
    const dy = Y(-side / 2) - 18;
    if (dy > 14) {
      sv(svg, 'path', { d: `M${X(-side / 2)},${dy - 5}v10M${X(side / 2)},${dy - 5}v10M${X(-side / 2)},${dy}H${X(side / 2)}`, class: 'ct-dim' });
      sv(svg, 'text', { x: X(0), y: dy - 5, 'text-anchor': 'middle', class: 'ct-dim-t' }, `${sig(side)} mm`);
    }
    const by = Y(side / 2) + 18;
    if (by < H - 4) sv(svg, 'text', { x: X(0), y: by, 'text-anchor': 'middle', class: 'ct-dim-s' }, `${sig(T.area)} mm² · ${sig(T.area / 645.16)} in² · per layer`);

    // scale bar
    const sb = [1, 2, 5, 10, 20, 50].find((s) => s * k >= 50) || 100;
    sv(svg, 'path', { d: `M12,${H - 14}h${sb * k}M12,${H - 18}v8M${12 + sb * k},${H - 18}v8`, class: 'ct-dim' });
    sv(svg, 'text', { x: 12 + sb * k + 6, y: H - 10, class: 'ct-dim-s' }, `${sb} mm`);

    // the corner handles
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const hx = X(sx * side / 2), hy = Y(sy * side / 2);
      const hd = sv(svg, 'g', { class: 'ct-handle', tabindex: 0, role: 'slider', 'aria-label': 'Copper pour size; drag, or arrow keys (Shift for 5 mm)',
        'aria-valuenow': sig(side), 'aria-valuetext': `${sig(side)} mm square, ${sig(T.area)} mm²` });
      sv(hd, 'rect', { x: hx - 10, y: hy - 10, width: 20, height: 20, class: 'ct-handle-hit' });
      sv(hd, 'rect', { x: hx - 5, y: hy - 5, width: 10, height: 10, class: 'ct-handle-knob' });
      hd.addEventListener('pointerdown', (e) => {
        frozen = { E };
        drag(e, (ev) => {
          const r = svg.getBoundingClientRect();
          const sx2 = (ev.clientX - r.left) * (W / r.width), sy2 = (ev.clientY - r.top) * (H / r.height);
          const half = Math.max(Math.abs(sx2 - cx), Math.abs(sy2 - cy)) / k;
          const s = clamp(2 * half, Math.max(padSide * 1.05, 2), 200);
          ctx.set('area', round3(s * s));
        }, () => { frozen = null; draw(); });
      });
      hd.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const s = clamp(side + d * (e.shiftKey ? 5 : 1), Math.max(padSide * 1.05, 2), 200);
        ctx.set('area', round3(s * s));
        refocus('.ct-handle', [sx, sy]);
      });
      hd.dataset.c = `${sx},${sy}`;
    }

    // warning on the drawing where it is
    if (T.margin != null && T.margin < 0) {
      sv(svg, 'text', { x: X(0), y: pwY - 22, 'text-anchor': 'middle', class: 'ct-hot-t' }, `over by ${deg(-T.margin)} °C`);
    }
    planNote.replaceChildren(
      h('span', {}, 'Drag a corner to size the pour, drag the watts up or down. '),
      h('span', { class: 'ct-soft' }, `Dashed circle: the round fin of the same area the model uses${T.eta < 0.4 ? ' — the far copper barely helps' : ''}.`));
  }

  let refocusSel = null;
  function refocus(sel, c) { refocusSel = c ? `${sel}[data-c="${c.join(',')}"]` : sel; }

  // pointer scrub on an SVG element: vertical drag, arrow keys
  let dragStart = null;
  function bindScrub(el, onDrag, onKey, snapshot) {
    el.addEventListener('pointerdown', (e) => {
      el.focus?.();
      dragStart = { y: e.clientY, ...snapshot() };
      frozen = { E: lastE };
      drag(e, (ev) => onDrag(ev.clientY - dragStart.y), () => { dragStart = null; frozen = null; draw(); });
    });
    el.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!d) return; e.preventDefault(); onKey(d, e.shiftKey);
      refocus(`.${el.getAttribute('class').split(' ')[0]}`);
    });
  }

  // ---------- thermometer ----------
  // Upright beside the plan on wide screens, lying under it on a phone: the
  // same drawing, the temperature axis turned.
  function drawThermo() {
    const svg = thermoSvg;
    svg.replaceChildren();
    const W = Math.max(110, svg.clientWidth || 150), H = Math.max(90, svg.clientHeight || 500);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vert = H > W;
    const lim = T.tjmax;
    let lo = Math.floor((T.ta - 5) / 10) * 10, hi = Math.ceil((Math.max(lim ?? 0, T.tj) + 12) / 10) * 10;
    if (tFrozen) { lo = Math.min(lo, tFrozen.lo); hi = Math.max(hi, tFrozen.hi); }
    const compact = W < 150;
    // along: the temperature axis; across: bar, brackets, leaders, labels
    const a0 = vert ? H - 16 : 22, a1 = vert ? 14 : W - 26;
    const bx = vert ? (compact ? 24 : 30) : 46, bw = 12;
    const kx = bx + bw + 4, mx = kx + (vert ? (compact ? 10 : 14) : 8), labelX = mx + (vert ? (compact ? 10 : 16) : 8);
    const A = (t) => a0 + (t - lo) / (hi - lo) * (a1 - a0);
    // (along, across) -> svg point
    const P = (al, ac) => (vert ? [ac, al] : [al, ac]);
    const M = (al, ac) => { const [x, y] = P(al, ac); return `${x.toFixed(1)},${y.toFixed(1)}`; };
    const rect = (al0, al1, ac0, ac1, attrs) => {
      const [x0, y0] = P(Math.min(al0, al1), ac0), [x1, y1] = P(Math.max(al0, al1), ac1);
      return sv(svg, 'rect', { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), ...attrs });
    };
    const text = (al, ac, str, attrs) => { const [x, y] = P(al, ac); return sv(svg, 'text', { x, y, ...attrs }, str); };
    const defs = sv(svg, 'defs');
    const lg = sv(defs, 'linearGradient', vert ? { id: 'ct-ramp', x1: 0, y1: 1, x2: 0, y2: 0 } : { id: 'ct-ramp', x1: 0, y1: 0, x2: 1, y2: 0 });
    for (let i = 0; i <= 12; i++) { const t = lo + (hi - lo) * i / 12; sv(lg, 'stop', { offset: i / 12, 'stop-color': colour(t) }); }
    // ticks
    const step = (hi - lo) > 120 ? 20 : 10;
    const tstep = vert ? step : ((hi - lo) / step > 8 ? step * 2 : step);
    for (let t = lo; t <= hi; t += tstep) {
      sv(svg, 'path', { d: `M${M(A(t), bx - 4)}L${M(A(t), bx)}`, class: 'ct-tick' });
      if (vert) text(A(t) + 3, bx - 6, t, { 'text-anchor': 'end', class: 'ct-tick-t' });
      else text(A(t), bx - 7, t, { 'text-anchor': 'middle', class: 'ct-tick-t' });
    }
    if (!vert) text(a0 - 4, bx + bw - 1, '°C', { 'text-anchor': 'end', class: 'ct-tick-t' });
    rect(a0, a1, bx, bx + bw, { fill: 'url(#ct-ramp)', class: 'ct-ramp' });
    if (lim != null) rect(A(lim), a1, bx, bx + bw, { class: 'ct-over' });
    // brackets for the resistances, the value along them (upright only)
    const bracket = (t0, t1, str) => {
      const y0 = A(t0), y1 = A(t1);
      if (!vert || Math.abs(y0 - y1) < 3) return;
      sv(svg, 'path', { d: `M${M(y0, kx)}L${M(y0, kx + 3)}L${M(y1, kx + 3)}L${M(y1, kx)}`, class: 'ct-brk' });
      const ym = (y0 + y1) / 2;
      if (Math.abs(y0 - y1) > str.length * 6 + 6) sv(svg, 'text', { x: kx + 8, y: ym, transform: `rotate(-90 ${kx + 8} ${ym})`, 'text-anchor': 'middle', class: 'ct-brk-t' }, str);
    };
    bracket(T.ta, T.tBoard, `θca ${sig(T.thetaCa)} °C/W`);
    bracket(T.tBoard, T.tj, `θJB ${sig(T.tjc)}`);
    if (lim != null) rect(A(Math.min(T.tj, lim)), A(Math.max(T.tj, lim)), bx - 2, bx + bw + 2, { class: `ct-margin ct-${T.tone}` });
    // marks: upright, labels to the right nudged apart; lying, labels below in two rows
    const used = [];
    const place = (al, width) => {
      if (vert) { let y = al; for (const u of used) if (Math.abs(u.a - y) < 13) y = u.a + (y >= u.a ? 13 : -13); used.push({ a: y }); return { a: y, row: 0 }; }
      for (let row = 0; row < 3; row++) {
        const lo2 = al - width / 2, hi2 = al + width / 2;
        if (!used.some((u) => u.row === row && !(hi2 < u.lo - 4 || lo2 > u.hi + 4))) { used.push({ row, lo: lo2, hi: hi2 }); return { a: clamp(al, width / 2 + 2, W - width / 2 - 2), row }; }
      }
      return { a: al, row: 2 };
    };
    const lblAc = (row) => labelX + 6 + row * 14;
    const mark = (t, str, cls, strong) => {
      const q = place(A(t), str.length * 6.8);
      if (vert) {
        sv(svg, 'path', { d: `M${M(A(t), bx + bw)}L${M(A(t), mx)}L${M(q.a, labelX - 3)}`, class: `ct-mk ${cls}` });
        text(q.a + 3.5, labelX, str, { class: `ct-mk-t ${cls} ${strong ? 'ct-strong' : ''}` });
      } else {
        sv(svg, 'path', { d: `M${M(A(t), bx + bw)}L${M(A(t), lblAc(q.row) - 10)}`, class: `ct-mk ${cls}` });
        text(q.a, lblAc(q.row), str, { 'text-anchor': 'middle', class: `ct-mk-t ${cls} ${strong ? 'ct-strong' : ''}` });
      }
    };
    // draggable: ambient and the limit
    const handle = (key, t, str, cls) => {
      const al = A(t);
      const g = sv(svg, 'g', { class: `ct-thandle ${cls}`, tabindex: 0, role: 'slider', 'aria-label': `${str === 'Ta' ? 'Ambient' : 'Max junction'} °C; drag, or arrow keys`,
        'aria-valuenow': t, 'aria-valuetext': `${deg(t)} °C`, 'data-k': key });
      rect(al - 9, al + 9, vert ? 0 : bx - 16, vert ? W : bx + bw + 4, { class: 'ct-thandle-hit' });
      g.append(svg.lastChild);
      const d = vert ? `M${M(al, bx - 6)}L${M(al, bx + bw + 2)}` : `M${M(al, bx - 3)}L${M(al, bx + bw + 3)}`;
      sv(g, 'path', { d, class: 'ct-thandle-line' });
      sv(g, 'path', { d: vert ? `M${M(al, bx - 6)}l-7,-5v10z` : `M${M(al, bx + bw + 3)}l-5,7h10z`, class: 'ct-thandle-knob' });
      const lab = `${str} ${deg(t)}`;
      if (vert) {
        const q = place(al, 0);
        sv(g, 'path', { d: `M${M(al, mx)}L${M(q.a, labelX - 3)}`, class: 'ct-thandle-line ct-thin' });
        text(q.a + 3.5, labelX, lab, { class: 'ct-mk-t ct-strong' }); g.append(svg.lastChild);
      } else {
        const q = place(al, lab.length * 6.8);
        text(q.a, lblAc(q.row), lab, { 'text-anchor': 'middle', class: 'ct-mk-t ct-strong' }); g.append(svg.lastChild);
      }
      g.addEventListener('pointerdown', (e) => {
        tFrozen = { lo, hi };
        drag(e, (ev) => {
          const r = svg.getBoundingClientRect();
          const pos = vert ? (ev.clientY - r.top) * (H / r.height) : (ev.clientX - r.left) * (W / r.width);
          const v = Math.round(lo + (pos - a0) / (a1 - a0) * (hi - lo));
          ctx.set(key, String(key === 'ta' ? clamp(v, -40, (T.tjmax ?? 200) - 1) : clamp(v, T.ta + 1, 250)));
        }, () => { tFrozen = null; draw(); });
      });
      g.addEventListener('keydown', (e) => {
        const dd = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (!dd) return; e.preventDefault();
        ctx.set(key, String(Math.round(t + dd * (e.shiftKey ? 10 : 1))));
        refocus(`.ct-thandle[data-k="${key}"]`);
      });
    };
    mark(T.tj, `Tj ${deg(T.tj)}`, `ct-tj ct-${T.tone}`, true);
    if (lim != null) {
      const u = used[used.length - 1];
      const m = `${T.margin >= 0 ? 'margin ' : 'over '}${deg(Math.abs(T.margin))}`;
      if (vert) { text(u.a + 15, labelX, m, { class: `ct-margin-t ct-${T.tone}` }); used.push({ a: u.a + 13 }); }
    }
    if (lim != null) handle('tjmax', lim, 'max', 'ct-lim');
    handle('ta', T.ta, 'Ta', 'ct-amb');
    mark(T.tBoard, `pad ${deg(T.tBoard)}`, '');
    mark(T.tEdge, `edge ${deg(T.tEdge)}`, 'ct-soft');
  }

  // ---------- board edge ----------
  function drawStack() {
    const svg = stackSvg;
    svg.replaceChildren();
    const W = 340, x0 = 30, x1 = 310, top = 40, th = 46;
    const n = T.layers;
    sv(svg, 'rect', { x: x0, y: top, width: x1 - x0, height: th, class: 'ct-fr4-edge' });
    const cu = clamp(2 + T.oz * 1.6, 2, 7);
    const ys = n === 1 ? [top - cu] : n === 2 ? [top - cu, top + th] : [top - cu, top + th / 3 - cu / 2, top + 2 * th / 3 - cu / 2, top + th];
    // the pour on each layer (inner reference planes too when not stitched)
    const all = [top - cu, top + th / 3 - cu / 2, top + 2 * th / 3 - cu / 2, top + th];
    for (const y of all) {
      const on = ys.includes(y);
      sv(svg, 'rect', { x: on ? 70 : 60, y, width: on ? 200 : 0, height: cu, class: on ? 'ct-cu' : 'ct-cu-off' });
    }
    // the part on top and the stitching vias
    sv(svg, 'rect', { x: 150, y: top - cu - 12, width: 40, height: 12, rx: 1, class: 'ct-edge-pkg' });
    sv(svg, 'text', { x: 170, y: top - cu - 16, 'text-anchor': 'middle', class: 'ct-stk-t' }, `${sig(T.p)} W`);
    if (n > 1) for (const vx of [156, 164, 172, 180]) sv(svg, 'rect', { x: vx, y: top - cu, width: 3, height: th + 2 * cu, class: 'ct-via' });
    // heat leaving both faces
    const arrow = (x, y, up) => sv(svg, 'path', { d: up ? `M${x},${y}v-16m-4,5l4,-5l4,5` : `M${x},${y}v16m-4,-5l4,5l4,-5`, class: 'ct-heat-arr' });
    for (const x of [90, 120, 220, 250]) { arrow(x, top - cu - 4, true); arrow(x, top + th + cu + 4, false); }
    sv(svg, 'text', { x: 268, y: top - cu - 8, class: 'ct-stk-t' }, `h ${sig(T.hConv + T.hRad, 2)}`);
    sv(svg, 'text', { x: 268, y: top + th + cu + 18, class: 'ct-stk-t' }, n === 1 ? 'through FR4' : `h ${sig(T.hConv + T.hRad, 2)}`);
    sv(svg, 'text', { x: x0, y: top + th / 2 + 4, class: 'ct-stk-s' }, 'FR4 1.6');
    sv(svg, 'text', { x: 70, y: 124, class: 'ct-stk-s' }, `${sig(T.copperUm)} µm of copper spreads the heat`);
    stackFacts.replaceChildren(
      h('span', {}, 'fin efficiency ', h('b', { class: T.eta < 0.4 ? 'ct-warn-t' : '' }, `${Math.round(T.eta * 100)} %`)),
      h('span', {}, 'h ', h('b', {}, `${sig(T.hConv, 2)} conv + ${sig(T.hRad, 2)} rad`), ' W/m²K per face'),
      h('span', {}, 'θ copper–air ', h('b', {}, `${sig(T.thetaCa)} °C/W`)),
      h('span', {}, 'θ junction–air ', h('b', {}, `${sig(T.thetaJa)} °C/W`)));
    for (const b of ozBtns) { const on = Number(b.dataset.v) === T.oz; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const b of layerBtns) { const on = Number(b.dataset.v) === T.layers; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    void W;
  }

  // ---------- Tj against area ----------
  function drawCurve() {
    const svg = curveSvg;
    svg.replaceChildren();
    const W = Math.max(260, svg.clientWidth || 340), H = Math.max(140, svg.clientHeight || 200);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pts = T.curve;
    const ml = 34, mr = 10, mt = 10, mb = 26;
    const a0 = pts[0][0], a1 = pts[pts.length - 1][0];
    const lim = T.tjmax;
    const yLo = Math.floor(T.ta / 10) * 10;
    const yHi = Math.ceil(Math.max((lim ?? T.tj) * 1.3, T.tj * 1.1, yLo + 40) / 10) * 10;
    const X = (a) => ml + Math.log(a / a0) / Math.log(a1 / a0) * (W - ml - mr);
    const Yv = (t) => mt + (1 - (clamp(t, yLo - 5, yHi * 3) - yLo) / (yHi - yLo)) * (H - mt - mb);
    const clip = sv(sv(svg, 'defs'), 'clipPath', { id: 'ct-cclip' });
    sv(clip, 'rect', { x: ml, y: mt, width: W - ml - mr, height: H - mt - mb });
    // grid
    for (const a of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) {
      if (a < a0 || a > a1) continue;
      sv(svg, 'path', { d: `M${X(a)},${mt}V${H - mb}`, class: 'ct-cgrid' });
      if (/^[125]/.test(String(a)) && (String(a)[0] !== '2' || W > 330)) sv(svg, 'text', { x: X(a), y: H - mb + 12, 'text-anchor': 'middle', class: 'ct-tick-t' }, a >= 1000 ? `${a / 1000}k` : a);
    }
    sv(svg, 'text', { x: W - mr, y: H - 3, 'text-anchor': 'end', class: 'ct-tick-t' }, 'copper area, mm²');
    const ys = (yHi - yLo) > 150 ? 50 : 20;
    for (let t = yLo; t <= yHi; t += ys) {
      sv(svg, 'path', { d: `M${ml},${Yv(t)}H${W - mr}`, class: 'ct-cgrid' });
      sv(svg, 'text', { x: ml - 4, y: Yv(t) + 3, 'text-anchor': 'end', class: 'ct-tick-t' }, t);
    }
    if (lim != null) {
      sv(svg, 'rect', { x: ml, y: mt, width: W - ml - mr, height: Math.max(0, Yv(lim) - mt), class: 'ct-over' });
      sv(svg, 'path', { d: `M${ml},${Yv(lim)}H${W - mr}`, class: 'ct-limline' });
    }
    const d = pts.map(([a, t], i) => `${i ? 'L' : 'M'}${X(a).toFixed(1)},${Yv(t).toFixed(1)}`).join('');
    sv(svg, 'path', { d, class: 'ct-cline', 'clip-path': 'url(#ct-cclip)' });
    if (typeof T.aNeed === 'number' && T.aNeed >= a0 && T.aNeed <= a1) {
      sv(svg, 'path', { d: `M${X(T.aNeed)},${Yv(lim)}V${H - mb}`, class: 'ct-needline' });
    }
    // the point, dragged along area
    const px = X(clamp(T.area, a0, a1)), py = clamp(Yv(T.tj), mt, H - mb);
    const g = sv(svg, 'g', { class: 'ct-cpt', tabindex: 0, role: 'slider', 'aria-label': 'Copper area on the curve; drag sideways, or arrow keys',
      'aria-valuenow': T.area, 'aria-valuetext': `${sig(T.area)} mm², Tj ${deg(T.tj)} °C` });
    sv(g, 'rect', { x: ml, y: mt, width: W - ml - mr, height: H - mt - mb, class: 'ct-cpt-hit' });
    sv(g, 'path', { d: `M${px},${py}V${H - mb}`, class: 'ct-cpt-line' });
    sv(g, 'circle', { cx: px, cy: py, r: 5.5, class: `ct-cpt-dot ct-${T.tone}` });
    g.addEventListener('pointerdown', (e) => {
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const xx = (ev.clientX - r.left) * (W / r.width);
        const a = a0 * Math.pow(a1 / a0, clamp((xx - ml) / (W - ml - mr), 0, 1));
        ctx.set('area', round3(Math.max(a, T.pad)));
      };
      drag(e, move);
      move(e);
    });
    g.addEventListener('keydown', (e) => {
      const dd = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!dd) return; e.preventDefault();
      ctx.set('area', round3(Math.max(T.pad, T.area * (e.shiftKey ? 1.25 : 1.05) ** dd)));
      refocus('.ct-cpt');
    });
    curveHead.replaceChildren(
      h('span', { class: 'ct-cap' }, `Tj against copper area at ${sig(T.p)} W`),
      h('span', { class: 'ct-soft' }, T.pMax != null ? `${sig(T.pMax)} W allowed at this area` : ''));
  }

  function drawTop() {
    syncFields();
    const cur = pkgFor(T?.pad ?? Number(ctx.raw.pad));
    for (const b of pkgBtns) { const on = cur && b.dataset.v === cur.id; b.setAttribute('aria-checked', String(!!on)); b.tabIndex = on || (!cur && b === pkgBtns[0]) ? 0 : -1; }
  }

  function drawWarnings() {
    const w = res?.warnings || [];
    planWarn.replaceChildren(...w.map((t) => h('div', {}, t)));
    planWarn.hidden = !w.length;
  }

  function draw() {
    // a redraw replaces the drawing: keep keyboard focus on the same handle
    if (!refocusSel && root.contains(document.activeElement) && document.activeElement instanceof SVGElement) {
      const a = document.activeElement, c = (a.getAttribute('class') || '').split(' ')[0];
      const key = ['data-c', 'data-k', 'data-id'].find((k) => a.hasAttribute(k));
      if (c) refocusSel = `.${c}${key ? `[${key}="${a.getAttribute(key)}"]` : ''}`;
    }
    drawTop();
    drawWarnings();
    if (!T) {
      planSvg.replaceChildren(); thermoSvg.replaceChildren(); stackSvg.replaceChildren(); curveSvg.replaceChildren();
      planNote.textContent = 'Give the power and the copper area to see the board.';
      return;
    }
    readRamp();
    drawPlan(); drawThermo(); drawStack(); drawCurve();
    if (refocusSel) { const el = root.querySelector(refocusSel); refocusSel = null; el?.focus(); }
  }

  ctx.onResult((r) => { res = r; T = r.thermal || null; draw(); });
  let rsz = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rsz); rsz = requestAnimationFrame(() => { if (T) draw(); }); });
  for (const el of [layout, planSvg.parentNode, thermoSvg.parentNode, curveSvg.parentNode]) ro.observe(el);
  new MutationObserver(() => { if (T) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
}
