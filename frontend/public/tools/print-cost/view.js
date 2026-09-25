// Print Time & Cost: the page is the print as the slicer lays it down.
//   Filament  - the spools to pick from; the chosen one shows how much of a
//               1 kg spool this part eats.
//   Layer     - one layer at the part's corner, to scale: the wall perimeters
//               and the grid infill as real beads. Drag the inner wall edge to
//               add or drop walls, drag the infill knob to open or close the
//               grid (that is the infill %).
//   Part      - the cube-equivalent block (drag its corner to change the
//               volume) and where its volume goes: shell, infill, air, support.
//   Nozzle    - the bead in section under the nozzle: drag its side for the
//               line width, its top for the layer height; below, the melt flow
//               against what a hot end can melt (drag it to set the speed).
//   Ticket    - the time, the filament and the cost stacked up with the
//               rates beside the part they price, and time and cost across
//               infill (drag the cursor).
// Every number drawn comes from run()'s result.job.

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
const p3 = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const money = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
const hmShort = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const ZOOMS = [[8, 'fit'], [20, '20 px/mm'], [40, '40 px/mm']];
const VKEY = 'redline.tool.print-cost.view';
const loadView = () => { try { return { zoom: 20, ...(JSON.parse(localStorage.getItem(VKEY) || '{}')) }; } catch { return { zoom: 20 }; } };
const saveView = (v) => { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch { /* private window */ } };

export function page(root, ctx) {
  const ver = location.search.match(/[?&]v=(\w+)/) ? `?v=${RegExp.$1}` : '';
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href + ver }));
  const view = loadView();
  let J = null, res = null, refocus = null;

  // ---------- small parts ----------
  const numField = (key, label, unit, opts = {}) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': opts.aria || `${label}${unit ? ` in ${unit}` : ''}`,
      placeholder: opts.placeholder || '', oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: `pc-num${opts.cls ? ` ${opts.cls}` : ''}`, title: opts.title || null },
      label ? h('span', {}, label) : null, inp, unit ? h('small', {}, unit) : null);
    w.sync = (v, ph) => { if (document.activeElement !== inp) inp.value = v ?? ''; if (ph != null) inp.placeholder = ph; };
    w.bad = (b) => inp.classList.toggle('pc-bad', !!b);
    return w;
  };
  const panel = (cls, title, ...tools) => {
    const head = h('div', { class: 'pc-head' }, h('span', { class: 'pc-cap' }, title), ...tools);
    const box = h('section', { class: `pc-panel ${cls}` }, head);
    return { box, head };
  };
  const svgBox = (label) => {
    const s = sv(null, 'svg', { role: 'group', 'aria-label': label });
    return s;
  };

  // ---------- filament spools ----------
  const matDef = ctx.manifest.inputs.find((d) => d.key === 'material');
  const MATS = matDef.options.map(([v, t]) => ({ v, name: t.replace(/\s*\(.*$/, ''), rho: (t.match(/([\d.]+)(?:\s*g\/cm³)?\)\s*$/) || [])[1] }));
  const spoolRow = h('div', { class: 'pc-spools', role: 'radiogroup', 'aria-label': 'Filament' });
  const spoolBtns = MATS.map((m) => {
    const s = sv(null, 'svg', { viewBox: '0 0 40 40', class: 'pc-reel', 'aria-hidden': 'true' });
    const b = h('button', { type: 'button', role: 'radio', 'data-v': m.v, class: 'pc-spool', title: `${m.name}, ${m.rho} g/cm³`,
      onclick: () => ctx.set('material', m.v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const n = MATS[clamp(MATS.indexOf(m) + d, 0, MATS.length - 1)].v;
        ctx.set('material', n); requestAnimationFrame(() => spoolRow.querySelector(`[data-v="${n}"]`)?.focus());
      } }, s, h('span', { class: 'pc-spool-t' }, h('b', {}, m.name), h('small', {}, `${m.rho} g/cm³`)));
    b.reel = s;
    return b;
  });
  spoolRow.append(...spoolBtns);
  const fPrice = numField('price', 'Filament', 'per kg', { aria: 'Filament price per kg' });
  const fCur = numField('currency', '', '', { aria: 'Currency', cls: 'pc-cur' });
  fCur.querySelector('input').setAttribute('inputmode', 'text');
  const top = h('div', { class: 'pc-top' }, spoolRow, h('div', { class: 'pc-top-f' }, fPrice, fCur));

  // ---------- layer (the corner) ----------
  const zoomSeg = h('div', { class: 'pc-seg', role: 'radiogroup', 'aria-label': 'Zoom' },
    ZOOMS.map(([z, t]) => h('button', { type: 'button', role: 'radio', 'data-z': z, onclick: () => { view.zoom = z; saveView(view); drawLayer(); syncZoom(); } }, t)));
  const syncZoom = () => zoomSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.z) === view.zoom)));
  const fWalls = numField('walls', 'Walls', 'lines');
  const fInfill = numField('infill', 'Infill', '%');
  const layer = panel('pc-layer', 'One layer at the corner, to scale', h('span', { class: 'pc-fields' }, fWalls, fInfill), zoomSeg);
  const layerSvg = svgBox('One layer of the part at its corner: wall perimeters and grid infill. Drag the wall edge or the infill knob.');
  layerSvg.classList.add('pc-drag');
  const layerLegend = h('div', { class: 'pc-legend' });
  const layerHint = h('div', { class: 'pc-hint' }, 'Drag the inner wall edge to change the walls, the round knob to open or close the infill grid. Arrow keys on a focused handle.');
  layer.box.append(layerLegend, h('div', { class: 'pc-svgwrap' }, layerSvg), layerHint);

  // ---------- part ----------
  const fVol = numField('volume', 'Volume', 'cm³');
  const fArea = numField('area', 'Surface', 'cm²', { title: 'Surface area from CAD; empty = estimated as a cube' });
  const fSup = numField('support', 'Support', '% of vol.');
  const part = panel('pc-part', 'The part');
  const partSvg = svgBox('The part as its cube-equivalent block; drag the corner to change the volume');
  partSvg.classList.add('pc-drag');
  const volBar = h('div', { class: 'pc-volbar' });
  part.box.append(h('div', { class: 'pc-part-body' }, h('div', { class: 'pc-svgwrap pc-part-svg' }, partSvg), h('div', { class: 'pc-part-f' }, fVol, fArea, fSup)), volBar);

  // ---------- nozzle ----------
  const fLine = numField('line', 'Line', 'mm');
  const fLayer = numField('layer', 'Layer', 'mm');
  const fSpeed = numField('speed', 'Speed', 'mm/s');
  const fEff = numField('efficiency', 'Efficiency', '%', { title: 'Average share of the nominal speed actually reached' });
  const noz = panel('pc-noz', 'Nozzle and melt flow', h('span', { class: 'pc-fields' }, fLine, fLayer));
  const beadSvg = svgBox('The bead in section: drag its side for the line width, its top for the layer height');
  beadSvg.classList.add('pc-drag');
  const flowSvg = svgBox('Melt flow against what a hot end melts: drag to set the print speed');
  flowSvg.classList.add('pc-drag');
  noz.box.append(h('div', { class: 'pc-svgwrap pc-bead' }, beadSvg), h('div', { class: 'pc-flow-f' }, fSpeed, fEff), h('div', { class: 'pc-svgwrap pc-flow' }, flowSvg));

  // ---------- ticket ----------
  const fRate = numField('rate', '', 'per h', { aria: 'Machine rate per hour' });
  const fPower = numField('power', '', 'W', { aria: 'Printer power in W' });
  const fKwh = numField('kwh', '', 'per kWh', { aria: 'Energy price per kWh' });
  const fFail = numField('failure', '', '%', { aria: 'Failure margin in %' });
  const tTime = h('div', { class: 'pc-tt' });
  const tStack = h('div', { class: 'pc-stack' });
  const mkLine = (cls, t, ...fields) => {
    const how = h('span', { class: 'pc-line-how' }), val = h('b', {});
    const row = h('div', { class: 'pc-line' }, h('i', { class: cls }), h('span', { class: 'pc-line-t' }, t), how, h('span', { class: 'pc-line-f' }, ...fields), val);
    row.how = how; row.val = val; return row;
  };
  const lnMat = mkLine('pc-c-mat', 'Material');
  const lnMach = mkLine('pc-c-mach', 'Machine', fRate);
  const lnEn = mkLine('pc-c-en', 'Energy', fPower, fKwh);
  const lnMarg = mkLine('pc-c-marg', 'Margin', fFail);
  const tLines = h('div', { class: 'pc-lines' }, lnMat, lnMach, lnEn, lnMarg);
  const sweepSvg = svgBox('Time and cost against infill; drag the cursor to set the infill');
  sweepSvg.classList.add('pc-drag');
  const ticket = h('section', { class: 'pc-panel pc-ticket' },
    h('div', { class: 'pc-tk-main' }, tTime, h('div', { class: 'pc-tk-cost' }, tStack, tLines)),
    h('div', { class: 'pc-tk-sweep' }, h('div', { class: 'pc-head' }, h('span', { class: 'pc-cap' }, 'Across infill'),
      h('span', { class: 'pc-key pc-ax-tk' }, 'time, h ←'), h('span', { class: 'pc-key pc-ax-ck' }, '→ total cost'), h('span', { class: 'pc-key' }, 'drag the dot')),
    h('div', { class: 'pc-svgwrap pc-sweep' }, sweepSvg)));

  const warnBox = h('div', { class: 'pc-warns', 'aria-live': 'polite' });
  const side = h('aside', { class: 'pc-side' }, part.box, noz.box, h('div', { class: 'pc-out' }, ctx.outputs));
  const layout = h('div', { class: 'pc' }, top, h('div', { class: 'pc-mainc' }, layer.box, warnBox), ticket, side);
  root.append(layout);

  // =====================================================================
  // Layer: the corner of one layer at true scale
  // =====================================================================
  let layerGeo = null, layerDrag = null, frozenK = null;
  function drawLayer() {
    const svg = layerSvg;
    svg.replaceChildren();
    if (!J) return;
    const W = Math.max(280, svg.clientWidth || 700), H = Math.max(240, svg.clientHeight || 460);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 520;
    const mL = narrow ? 30 : 58, mT = 50, mR = 16, mB = 34;
    const side = J.side;
    // 'fit' shows the whole section; otherwise the chosen px/mm
    const fit = Math.min((W - mL - mR) / side, (H - mT - mB) / side);
    const sc = view.zoom === 8 ? fit : view.zoom;
    const X = (x) => mL + x * sc, Y = (y) => mT + y * sc;
    const vw = (W - mL - mR) / sc, vh = (H - mT - mB) / sc; // mm visible
    const defs = sv(svg, 'defs');
    const clip = sv(defs, 'clipPath', { id: 'pc-view' });
    sv(clip, 'rect', { x: mL - 1, y: mT - 1, width: W - mL - mR + 2, height: H - mT - mB + 2 });
    const g = sv(svg, 'g', { 'clip-path': 'url(#pc-view)' });
    const pw = Math.min(side, vw + 2), ph = Math.min(side, vh + 2);
    sv(g, 'rect', { x: X(0), y: Y(0), width: pw * sc, height: ph * sc, class: 'pc-l-part' });
    const t = J.wallThickness, lw = J.line;
    const inner = side - 2 * t;
    // infill grid (clipped to the inside of the walls)
    if (!J.solid && J.infillSpacing && inner > 0) {
      const ic = sv(defs, 'clipPath', { id: 'pc-inner' });
      sv(ic, 'rect', { x: X(t), y: Y(t), width: inner * sc, height: inner * sc });
      const gi = sv(g, 'g', { 'clip-path': 'url(#pc-inner)' });
      const s = J.infillSpacing;
      const lim = Math.min(side - t, Math.max(vw, vh) + t + s);
      for (let x = t + s / 2; x < lim; x += s) {
        sv(gi, 'line', { x1: X(x), x2: X(x), y1: Y(t), y2: Y(Math.min(side - t, vh + 2)), class: 'pc-l-infill', 'stroke-width': Math.max(1, lw * sc * 0.92) });
        sv(gi, 'line', { y1: Y(x), y2: Y(x), x1: X(t), x2: X(Math.min(side - t, vw + 2)), class: 'pc-l-infill', 'stroke-width': Math.max(1, lw * sc * 0.92) });
      }
    }
    // wall perimeters, outermost first
    const nW = J.solid ? Math.ceil(side / (2 * lw)) : Math.round(J.walls);
    for (let k = 0; k < nW; k++) {
      const o = (k + 0.5) * lw, s2 = side - 2 * o;
      if (s2 <= 0) break;
      sv(g, 'rect', { x: X(o), y: Y(o), width: s2 * sc, height: s2 * sc, rx: Math.min(lw * sc, 6), class: `pc-l-wall${k % 2 ? ' pc-l-wall2' : ''}`, 'stroke-width': Math.max(1, lw * sc * 0.92) });
    }
    sv(g, 'rect', { x: X(0), y: Y(0), width: pw * sc, height: ph * sc, class: 'pc-l-edge' });
    // continuation marks where the part runs on past the view
    if (side > vw) sv(svg, 'text', { x: W - mR - 2, y: mT - 8, class: 'pc-t pc-soft', 'text-anchor': 'end' }, `part runs on to ${p3(side)} mm →`);
    else dimH(svg, X(0), X(side), mT - 30, `${p3(side)} mm (cube-equivalent)`, mT - 4);
    if (side <= vh) dimV(svg, X(side) + 16, Y(0), Y(side), `${p3(side)}`);

    // wall dimension and handle
    const yH = Y(Math.min(side, vh) * 0.62);
    const wx = X(Math.min(t, side / 2));
    dimH(svg, X(0), wx, mT - 12, `${J.walls} × ${fx(lw)} = ${fx(t)} mm`, mT - 2, t * sc < 70 ? 'start' : 'middle');
    const wh = sv(svg, 'g', { class: 'pc-handle pc-h-wall', tabindex: 0, role: 'slider', 'data-h': 'walls', 'aria-label': 'Wall count',
      'aria-valuemin': 0, 'aria-valuemax': 12, 'aria-valuenow': J.walls, 'aria-valuetext': `${J.walls} walls, ${fx(t)} mm` });
    sv(wh, 'rect', { x: wx - 9, y: yH - 30, width: 18, height: 60, class: 'pc-hit' });
    sv(wh, 'line', { x1: wx, x2: wx, y1: yH - 26, y2: yH + 26, class: 'pc-h-bar' });
    sv(wh, 'rect', { x: wx - 4, y: yH - 12, width: 8, height: 24, rx: 3, class: 'pc-h-grip' });
    // infill dimension and knob, near the middle of the view
    if (!J.solid && J.infillSpacing && inner > 0) {
      const s = J.infillSpacing;
      const cxmm = Math.min(side - t, vw) * 0.55;
      let k = layerDrag === 'infill' && frozenK != null ? frozenK : Math.max(0, Math.floor((cxmm - t - s / 2) / s));
      const xa = t + s / 2 + k * s, xb = xa + s;
      const yk = Y(Math.min(side - t, vh) * 0.3 + t * 0.5);
      if (xb < Math.min(side - t, vw + 1)) {
        sv(svg, 'line', { x1: X(xa), x2: X(xb), y1: yk, y2: yk, class: 'pc-dim', 'marker-start': 'url(#pc-arr)', 'marker-end': 'url(#pc-arr)' });
        const lab = `${fx(s)} mm · ${p3(J.infill)} %`;
        const tw = lab.length * 6.6 + 10;
        sv(svg, 'rect', { x: (X(xa) + X(xb)) / 2 - tw / 2, y: yk - 26, width: tw, height: 17, rx: 3, class: 'pc-tagbg' });
        sv(svg, 'text', { x: (X(xa) + X(xb)) / 2, y: yk - 13, class: 'pc-t pc-t-in', 'text-anchor': 'middle' }, lab);
        const kn = sv(svg, 'g', { class: 'pc-handle pc-h-in', tabindex: 0, role: 'slider', 'data-h': 'infill', 'aria-label': 'Infill',
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(J.infill), 'aria-valuetext': `${p3(J.infill)} % infill, lines ${fx(s)} mm apart` });
        sv(kn, 'circle', { cx: X(xb), cy: yk, r: 14, class: 'pc-hit' });
        sv(kn, 'circle', { cx: X(xb), cy: yk, r: 7.5, class: 'pc-h-knob' });
        layerGeo = { sc, X, xa, t, k };
      } else layerGeo = { sc, X, xa: t + s / 2, t };
    } else {
      layerGeo = { sc, X, xa: t + lw, t };
      if (!J.solid && inner > 0) {
        const kn = sv(svg, 'g', { class: 'pc-handle pc-h-in', tabindex: 0, role: 'slider', 'data-h': 'infill', 'aria-label': 'Infill', 'aria-valuenow': 0, 'aria-valuemin': 0, 'aria-valuemax': 100 });
        const cx = X(Math.min(t + 6 * lw, side / 2)), cy = Y(Math.min(side, vh) * 0.3);
        sv(kn, 'circle', { cx, cy, r: 14, class: 'pc-hit' });
        sv(kn, 'circle', { cx, cy, r: 7.5, class: 'pc-h-knob' });
        sv(svg, 'text', { x: cx + 14, y: cy + 4, class: 'pc-t pc-t-in' }, 'no infill: hollow');
      }
    }
    if (J.solid) {
      const cx = X(Math.min(side, vw) / 2), cy = Y(Math.min(side, vh) / 2);
      sv(svg, 'rect', { x: cx - 120, y: cy - 16, width: 240, height: 28, rx: 4, class: 'pc-tagbg pc-tag-warn' });
      sv(svg, 'text', { x: cx, y: cy + 3, class: 'pc-t pc-t-warn', 'text-anchor': 'middle' }, 'walls fill the part: prints solid');
    }
    const defs2 = sv(defs, 'marker', { id: 'pc-arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(defs2, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'pc-arrhead' });
    // scale bar
    const step = niceStep(Math.min(vw, side) / 3, 1);
    const bx = mL, by = H - 12;
    sv(svg, 'line', { x1: bx, x2: bx + step * sc, y1: by, y2: by, class: 'pc-scale' });
    sv(svg, 'text', { x: bx + step * sc + 6, y: by + 4, class: 'pc-t pc-soft' }, `${p3(step)} mm · ${p3(sc)} px/mm`);
    // the part runs on past the bottom of the view: fade it out
    if (side > vh) {
      const fg = sv(defs, 'linearGradient', { id: 'pc-fade', x1: 0, x2: 0, y1: 0, y2: 1 });
      sv(fg, 'stop', { offset: 0, class: 'pc-fade0' }); sv(fg, 'stop', { offset: 1, class: 'pc-fade1' });
      sv(svg, 'rect', { x: mL - 2, y: H - mB - 40, width: Math.min(pw * sc + 4, W - mL - mR + 2), height: 41, fill: 'url(#pc-fade)' });
    }
    layerLegend.replaceChildren(
      h('span', { class: 'pc-key' }, h('i', { class: 'pc-k-wall' }), `walls, ${fx(J.shellShare, 0)} % of the volume`),
      h('span', { class: 'pc-key' }, h('i', { class: 'pc-k-infill' }), `grid infill, ${p3(J.infill)} %`),
      h('span', { class: 'pc-key' }, `${J.layers} layers of ${fx(J.layer)} mm; top and bottom skins not drawn`));
    if (refocus) { svg.querySelector(`[data-h="${refocus}"]`)?.focus(); }
  }
  function dimH(svg, xa, xb, y, label, ext, anchor = 'middle') {
    sv(svg, 'line', { x1: xa, x2: xa, y1: y - 4, y2: ext, class: 'pc-ext' });
    sv(svg, 'line', { x1: xb, x2: xb, y1: y - 4, y2: ext, class: 'pc-ext' });
    sv(svg, 'line', { x1: xa, x2: xb, y1: y, y2: y, class: 'pc-dim' });
    sv(svg, 'text', { x: anchor === 'start' ? xa : (xa + xb) / 2, y: y - 4, class: 'pc-t', 'text-anchor': anchor }, label);
  }
  function dimV(svg, x, ya, yb, label) {
    sv(svg, 'line', { x1: x, x2: x, y1: ya, y2: yb, class: 'pc-dim' });
    sv(svg, 'text', { x: x + 4, y: (ya + yb) / 2, class: 'pc-t', transform: `rotate(90 ${x + 4} ${(ya + yb) / 2})`, 'text-anchor': 'middle' }, label);
  }
  const svgX = (svg, e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  layerSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('[data-h]');
    if (!g || !J) return;
    layerDrag = g.dataset.h; frozenK = layerGeo?.k ?? null; capture(layerSvg, e); e.preventDefault();
  });
  layerSvg.addEventListener('pointermove', (e) => {
    if (!layerDrag || !layerGeo || !J) return;
    const [x] = svgX(layerSvg, e);
    const mm = (x - layerGeo.X(0)) / layerGeo.sc;
    if (layerDrag === 'walls') {
      const n = clamp(Math.round(mm / J.line), 0, 12);
      if (n !== J.walls) ctx.set('walls', String(n));
    } else {
      // the knob sits on grid line k + 1: x = t + s / 2 + (k + 1) s, so the spacing follows the pointer
      const s = (mm - layerGeo.t) / ((layerGeo.k ?? 0) + 1.5);
      const inf = s <= 0 ? 100 : clamp(Math.round((200 * J.line) / s), 1, 100);
      if (inf !== Math.round(J.infill)) ctx.set('infill', String(inf));
    }
  });
  const endLayer = () => { layerDrag = null; frozenK = null; };
  layerSvg.addEventListener('pointerup', endLayer);
  layerSvg.addEventListener('pointercancel', endLayer);
  layerSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-h]');
    if (!g || !J) return;
    const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (!st) return; e.preventDefault();
    refocus = g.dataset.h;
    if (g.dataset.h === 'walls') ctx.set('walls', String(clamp(Math.round(J.walls) + Math.sign(st), 0, 12)));
    else ctx.set('infill', String(clamp(Math.round(J.infill) + st, 0, 100)));
  });

  // =====================================================================
  // Part: the block and where its volume goes
  // =====================================================================
  let partGeo = null, partDrag = null;
  function drawPart() {
    const svg = partSvg;
    svg.replaceChildren();
    if (!J) return;
    const W = Math.max(150, svg.clientWidth || 180), H = Math.max(120, svg.clientHeight || 150);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    // the cube drawn with a log size scale: 1 cm³ small, 1000 cm³ filling the box
    const maxS = Math.min(W * 0.62 / 1.25, (H - 26) / 1.72); // the drawn block is 1.25 s wide and 1.72 s tall
    const sPx = clamp(maxS * (0.25 + 0.75 * clamp(Math.log10(J.volume) / 3, 0, 1)), 18, maxS);
    const cx = W * 0.44, base = H - 16;
    const c30 = Math.cos(Math.PI / 6) * 0.72, s30 = 0.5 * 0.72;
    const a = sPx * c30, b = sPx * s30;
    const P = {
      fb: [cx, base], fl: [cx - a, base - b], fr: [cx + a, base - b],
      tb: [cx, base - sPx], tl: [cx - a, base - b - sPx], tr: [cx + a, base - b - sPx], tt: [cx, base - 2 * b - sPx],
    };
    const poly = (pts, cls) => sv(svg, 'path', { d: `M${pts.map((p) => p.join(',')).join('L')}Z`, class: cls });
    poly([P.fl, P.fb, P.tb, P.tl], 'pc-cube-l');
    poly([P.fb, P.fr, P.tr, P.tb], 'pc-cube-r');
    poly([P.tl, P.tb, P.tr, P.tt], 'pc-cube-t');
    // shell thickness shown on the top face as an inner outline (exaggerated at least 2 px)
    const sh = clamp(J.wallThickness / J.side, 0.04, 0.45);
    const lerp = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
    const ctr = [(P.tl[0] + P.tr[0]) / 2, (P.tt[1] + P.tb[1]) / 2];
    poly([P.tl, P.tb, P.tr, P.tt].map((p) => lerp(p, ctr, sh * 2)), 'pc-cube-in');
    sv(svg, 'text', { x: P.fr[0] + 6, y: (P.fr[1] + P.tr[1]) / 2 + 4, class: 'pc-t pc-soft' }, `${p3(J.side)} mm`);
    // the corner handle: drag up / right to grow
    const hd = sv(svg, 'g', { class: 'pc-handle', tabindex: 0, role: 'slider', 'data-h': 'vol', 'aria-label': 'Part volume',
      'aria-valuenow': J.volume, 'aria-valuetext': `${p3(J.volume)} cm³` });
    sv(hd, 'circle', { cx: P.tr[0], cy: P.tr[1], r: 13, class: 'pc-hit' });
    sv(hd, 'circle', { cx: P.tr[0], cy: P.tr[1], r: 6, class: 'pc-h-knob' });
    partGeo = { cx, base, v0: J.volume, y0: null };
    if (refocus === 'vol') svg.querySelector('[data-h="vol"]')?.focus();

    // volume split: part volume = shell + infill + air; support beside it
    const V = J.volume, sup = J.supportVolume;
    const tot = V + sup;
    const air = Math.max(0, V - J.shell - J.infillVolume);
    const seg = (v, cls, t) => (v > 0 ? h('div', { class: `pc-vseg ${cls}`, style: `flex:${v / tot}`, title: t }) : null);
    volBar.replaceChildren(
      h('div', { class: 'pc-vbar' },
        seg(Math.min(V, J.shell), 'pc-v-shell', `shell ${p3(J.shell)} cm³`),
        seg(J.infillVolume, 'pc-v-infill', `infill ${p3(J.infillVolume)} cm³`),
        seg(air, 'pc-v-air', `air ${p3(air)} cm³`),
        seg(sup, 'pc-v-sup', `support ${p3(sup)} cm³`)),
      h('div', { class: 'pc-vleg' },
        h('span', {}, h('i', { class: 'pc-v-shell' }), `shell ${p3(Math.min(V, J.shell))}`),
        h('span', {}, h('i', { class: 'pc-v-infill' }), `infill ${p3(J.infillVolume)}`),
        h('span', {}, h('i', { class: 'pc-v-air' }), `air ${p3(air)}`),
        sup > 0 ? h('span', {}, h('i', { class: 'pc-v-sup' }), `support ${p3(sup)}`) : null,
        h('span', { class: 'pc-vtot' }, `printed ${p3(J.printed)} cm³`)));
  }
  partSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('[data-h]');
    if (!g || !J) return;
    const [x, y] = svgX(partSvg, e);
    partDrag = { x, y, v0: J.volume }; capture(partSvg, e); e.preventDefault();
  });
  partSvg.addEventListener('pointermove', (e) => {
    if (!partDrag || !J) return;
    const [x, y] = svgX(partSvg, e);
    const d = (x - partDrag.x) - (y - partDrag.y); // up and right grows
    const v = partDrag.v0 * Math.pow(10, d / 160);
    const n = Number(clamp(v, 0.1, 50000).toPrecision(v < 10 ? 2 : 3));
    if (n !== J.volume) ctx.set('volume', String(n));
  });
  const endPart = () => { partDrag = null; };
  partSvg.addEventListener('pointerup', endPart);
  partSvg.addEventListener('pointercancel', endPart);
  partSvg.addEventListener('keydown', (e) => {
    if (!J || !e.target.closest?.('[data-h]')) return;
    const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!st) return; e.preventDefault();
    const step = J.volume >= 100 ? 10 : J.volume >= 10 ? 1 : 0.1;
    refocus = 'vol';
    ctx.set('volume', String(Number(clamp(J.volume + st * step, 0.1, 50000).toPrecision(4))));
  });

  // =====================================================================
  // Nozzle: the bead in section, and the melt flow
  // =====================================================================
  let beadGeo = null, beadDrag = null;
  function drawBead() {
    const svg = beadSvg;
    svg.replaceChildren();
    if (!J) return;
    const W = Math.max(200, svg.clientWidth || 340), H = Math.max(120, svg.clientHeight || 150);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const sc = Math.min(62, (H - 60) / (3 * J.layer + 0.9), (W * 0.36) / Math.max(J.line, 0.2)); // px/mm
    const cx = W * 0.36, baseY = H - 18;
    const lw = J.line * sc, lh = J.layer * sc;
    const bad = J.layer > 0.8 * J.line;
    sv(svg, 'line', { x1: 8, x2: W - 8, y1: baseY, y2: baseY, class: 'pc-bed' });
    // three layers, three beads each; the top middle one is the one being laid
    for (let r = 0; r < 3; r++) {
      for (let c = -1; c <= 1; c++) {
        const x = cx + c * lw - lw / 2, y = baseY - (r + 1) * lh;
        const top = r === 2 && c === 0;
        sv(svg, 'rect', { x: x + 0.5, y: y + 0.5, width: lw - 1, height: lh - 1, rx: Math.min(lh / 2, lw / 2), class: `pc-beadr${top ? ' pc-beadr-now' : ''}${top && bad ? ' pc-bad-s' : ''}` });
      }
    }
    // nozzle
    const ny = baseY - 3 * lh;
    const nd = Math.max(lw * 0.9, 8);
    sv(svg, 'path', { d: `M${cx - nd / 2},${ny - 2} L${cx - nd * 1.6},${ny - 26} L${cx - nd * 1.6},${ny - 44} L${cx + nd * 1.6},${ny - 44} L${cx + nd * 1.6},${ny - 26} L${cx + nd / 2},${ny - 2} Z`, class: 'pc-nozzle' });
    // speed arrow
    sv(svg, 'path', { d: `M${cx + nd * 1.6 + 10},${ny - 20} l30,0 m-6,-4 l6,4 l-6,4`, class: 'pc-speed' });
    sv(svg, 'text', { x: cx + nd * 1.6 + 46, y: ny - 16, class: 'pc-t' }, `${p3(J.speed)} mm/s`);
    // dimensions: line width under the bed, layer height at the right
    const x0 = cx - lw / 2, x1 = cx + lw / 2, yT = ny, yB = ny + lh;
    sv(svg, 'line', { x1: x0, x2: x1, y1: yT - 6, y2: yT - 6, class: 'pc-dim' });
    sv(svg, 'text', { x: cx, y: baseY + 13, class: 'pc-t', 'text-anchor': 'middle' }, `line ${fx(J.line)}`);
    sv(svg, 'line', { x1: cx + lw * 1.5 + 8, x2: cx + lw * 1.5 + 8, y1: yT, y2: yB, class: 'pc-dim' });
    sv(svg, 'text', { x: cx + lw * 1.5 + 13, y: yT + lh / 2 + 4, class: `pc-t${bad ? ' pc-t-bad' : ''}` }, bad ? `layer ${fx(J.layer)} > 80 % of line` : `layer ${fx(J.layer)}`);
    // handles: right edge (line), top edge (layer)
    const hl = sv(svg, 'g', { class: 'pc-handle', tabindex: 0, role: 'slider', 'data-h': 'line', 'aria-label': 'Line width in mm', 'aria-valuenow': J.line });
    sv(hl, 'rect', { x: x1 - 8, y: yT, width: 16, height: lh, class: 'pc-hit' });
    sv(hl, 'line', { x1: x1, x2: x1, y1: yT + 2, y2: yB - 2, class: 'pc-h-bar' });
    const hy = sv(svg, 'g', { class: 'pc-handle', tabindex: 0, role: 'slider', 'data-h': 'layer', 'aria-label': 'Layer height in mm', 'aria-valuenow': J.layer });
    sv(hy, 'rect', { x: x0, y: yT - 8, width: lw, height: 12, class: 'pc-hit' });
    sv(hy, 'line', { x1: x0 + 2, x2: x1 - 2, y1: yT, y2: yT, class: 'pc-h-bar' });
    sv(svg, 'text', { x: W - 8, y: 14, class: 'pc-t pc-soft', 'text-anchor': 'end' }, `bead ${fx(J.line)} × ${fx(J.layer)} mm`);
    beadGeo = { sc, cx, yB };
    if (refocus === 'line' || refocus === 'layer') svg.querySelector(`[data-h="${refocus}"]`)?.focus();
  }
  beadSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('[data-h]');
    if (!g || !J) return;
    beadDrag = g.dataset.h; capture(beadSvg, e); e.preventDefault();
  });
  beadSvg.addEventListener('pointermove', (e) => {
    if (!beadDrag || !beadGeo || !J) return;
    const [x, y] = svgX(beadSvg, e);
    if (beadDrag === 'line') {
      const v = Math.round(clamp((2 * (x - beadGeo.cx)) / beadGeo.sc, 0.2, 1.2) * 100) / 100;
      if (v !== J.line) ctx.set('line', String(v));
    } else {
      const v = Math.round(clamp((beadGeo.yB - y) / beadGeo.sc, 0.04, 1) * 100) / 100;
      if (v !== J.layer) ctx.set('layer', String(v));
    }
  });
  const endBead = () => { beadDrag = null; };
  beadSvg.addEventListener('pointerup', endBead);
  beadSvg.addEventListener('pointercancel', endBead);
  beadSvg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-h]');
    if (!g || !J) return;
    const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!st) return; e.preventDefault();
    refocus = g.dataset.h;
    const k = g.dataset.h, cur = J[k];
    ctx.set(k, String(Math.round(clamp(cur + st * 0.01, k === 'line' ? 0.2 : 0.04, k === 'line' ? 1.2 : 1) * 100) / 100));
  });

  let flowGeo = null, flowDrag = false;
  function drawFlow() {
    const svg = flowSvg;
    svg.replaceChildren();
    if (!J) return;
    const W = Math.max(200, svg.clientWidth || 340), H = 62;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 10, R = 12, y = 26, bh = 12;
    const max = Math.max(25, Math.ceil((J.flow * 1.15) / 5) * 5);
    const X = (f) => L + (W - L - R) * clamp(f / max, 0, 1);
    sv(svg, 'rect', { x: X(0), y, width: X(J.flowTypical) - X(0), height: bh, class: 'pc-f-ok' });
    sv(svg, 'rect', { x: X(J.flowTypical), y, width: X(J.flowLimit) - X(J.flowTypical), height: bh, class: 'pc-f-warn' });
    sv(svg, 'rect', { x: X(J.flowLimit), y, width: X(max) - X(J.flowLimit), height: bh, class: 'pc-f-bad' });
    for (let f = 0; f <= max; f += 5) {
      sv(svg, 'line', { x1: X(f), x2: X(f), y1: y + bh, y2: y + bh + 4, class: 'pc-ext' });
      sv(svg, 'text', { x: X(f), y: y + bh + 15, class: 'pc-t pc-soft', 'text-anchor': 'middle' }, String(f));
    }
    sv(svg, 'text', { x: X(J.flowLimit) + 4, y: y + bh - 2, class: 'pc-t pc-soft' }, 'over a hot end');
    // effective flow: a thin tick
    sv(svg, 'line', { x1: X(J.effectiveFlow), x2: X(J.effectiveFlow), y1: y - 2, y2: y + bh + 2, class: 'pc-f-eff' });
    const over = J.flow > J.flowLimit;
    const g = sv(svg, 'g', { class: `pc-handle${over ? ' pc-h-bad' : ''}`, tabindex: 0, role: 'slider', 'data-h': 'speed', 'aria-label': 'Print speed, as melt flow',
      'aria-valuenow': J.speed, 'aria-valuetext': `${p3(J.speed)} mm/s, ${p3(J.flow)} mm³/s nominal` });
    sv(g, 'rect', { x: X(J.flow) - 10, y: y - 10, width: 20, height: bh + 20, class: 'pc-hit' });
    sv(g, 'path', { d: `M${X(J.flow)},${y + bh} l-6,-${bh + 8} l12,0 z`, class: 'pc-h-knob' });
    const lab = `${p3(J.flow)} mm³/s nominal, ${p3(J.effectiveFlow)} average`;
    const lx = clamp(X(J.flow), L + 110, W - R - 110);
    sv(svg, 'text', { x: lx, y: 11, class: `pc-t${over ? ' pc-t-bad' : ''}`, 'text-anchor': 'middle' }, lab);
    flowGeo = { X, max, L, R, W };
    if (refocus === 'speed') svg.querySelector('[data-h="speed"]')?.focus();
  }
  const flowAt = (e) => {
    const [x] = svgX(flowSvg, e);
    const { max, L, R, W } = flowGeo;
    const f = clamp(((x - L) / (W - L - R)) * max, 0.2, max);
    const sp = Math.round(f / (J.line * J.layer));
    if (sp > 0 && sp !== J.speed) ctx.set('speed', String(sp));
  };
  flowSvg.addEventListener('pointerdown', (e) => { if (!J || !flowGeo) return; flowDrag = true; capture(flowSvg, e); flowAt(e); e.preventDefault(); });
  flowSvg.addEventListener('pointermove', (e) => { if (flowDrag) flowAt(e); });
  flowSvg.addEventListener('pointerup', () => { flowDrag = false; });
  flowSvg.addEventListener('pointercancel', () => { flowDrag = false; });
  flowSvg.addEventListener('keydown', (e) => {
    if (!J || !e.target.closest?.('[data-h]')) return;
    const st = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 20, PageDown: -20 }[e.key];
    if (!st) return; e.preventDefault(); refocus = 'speed';
    ctx.set('speed', String(clamp(Math.round(J.speed) + st, 5, 1000)));
  });

  // =====================================================================
  // Ticket
  // =====================================================================
  function drawTicket() {
    if (!J) { tTime.replaceChildren(); tStack.replaceChildren(); return; }
    const c = J.cost, cur = J.currency;
    tTime.replaceChildren(
      h('div', { class: 'pc-cap' }, 'Print time'),
      h('div', { class: 'pc-big' }, J.timeText),
      h('div', { class: 'pc-sub' }, `${p3(J.hours)} h · ${J.layers} layers`),
      h('div', { class: 'pc-cap pc-gap' }, 'Filament'),
      h('div', { class: 'pc-mid' }, `${p3(J.mass)} g`),
      h('div', { class: 'pc-sub' }, `${p3(J.filamentLength)} m of Ø1.75 · ${J.materialName}`));
    const parts = [
      ['material', 'Material', c.material, 'pc-c-mat'],
      ['machine', 'Machine', c.machine, 'pc-c-mach'],
      ['energy', 'Energy', c.energy, 'pc-c-en'],
      ['margin', 'Failure margin', c.margin, 'pc-c-marg'],
    ];
    const tot = Math.max(1e-9, c.total);
    tStack.replaceChildren(
      h('div', { class: 'pc-stack-head' }, h('span', { class: 'pc-cap' }, 'Cost'), h('b', { class: 'pc-big pc-total' }, `${money(c.total)}`, h('small', {}, ` ${cur}`))),
      h('div', { class: 'pc-sbar' }, parts.map(([, t, v, cls]) => (v > 0 ? h('div', { class: `pc-sseg ${cls}`, style: `flex:${v / tot}`, title: `${t}: ${money(v)} ${cur}` }) : null))));
    lnMat.how.textContent = `${p3(J.mass)} g × ${p3(J.price)} per kg`;
    lnMach.how.textContent = `${p3(J.hours)} h ×`;
    lnEn.how.textContent = `${p3(J.energyKwh)} kWh:`;
    lnMarg.how.textContent = 'on top';
    for (const [ln, v] of [[lnMat, c.material], [lnMach, c.machine], [lnEn, c.energy], [lnMarg, c.margin]]) ln.val.textContent = money(v);
  }

  let sweepGeo = null, sweepDrag = false, hoverInf = null;
  function drawSweep() {
    const svg = sweepSvg;
    svg.replaceChildren();
    if (!J) return;
    const W = Math.max(220, svg.clientWidth || 360), H = Math.max(110, svg.clientHeight || 150);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 50, R = 50, T = 10, B = 22;
    const sw = J.sweep;
    const tMax = Math.max(...sw.map((p) => p.time)) / 3600 * 1.05, cMax = Math.max(...sw.map((p) => p.total)) * 1.05;
    const X = (i) => L + (W - L - R) * (i / 100);
    const YT = (hh) => T + (H - T - B) * (1 - hh / tMax), YC = (c) => T + (H - T - B) * (1 - c / cMax);
    for (let k = 0; k <= 3; k++) {
      const y = T + ((H - T - B) * k) / 3;
      sv(svg, 'line', { x1: L, x2: W - R, y1: y, y2: y, class: 'pc-grid' });
      sv(svg, 'text', { x: L - 5, y: y + 4, class: 'pc-t pc-soft pc-ax-t', 'text-anchor': 'end' }, `${p3(tMax * (1 - k / 3))}`);
      sv(svg, 'text', { x: W - R + 5, y: y + 4, class: 'pc-t pc-soft pc-ax-c' }, p3(cMax * (1 - k / 3)));
    }
    for (let i = 0; i <= 100; i += 20) sv(svg, 'text', { x: X(i), y: H - 6, class: 'pc-t pc-soft', 'text-anchor': 'middle' }, `${i} %`);
    const path = (Yf, key, cls, div = 1) => sv(svg, 'path', { d: sw.map((p, i) => `${i ? 'L' : 'M'}${X(p.infill).toFixed(1)},${Yf(p[key] / div).toFixed(1)}`).join(''), class: cls });
    // time and cost both follow the printed volume, so one curve carries both axes
    path(YT, 'time', 'pc-sw-time', 3600);
    const x = X(J.infill);
    sv(svg, 'line', { x1: x, x2: x, y1: T, y2: H - B, class: 'pc-sw-cur' });
    const g = sv(svg, 'g', { class: 'pc-handle', tabindex: 0, role: 'slider', 'data-h': 'sweep', 'aria-label': 'Infill', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(J.infill) });
    sv(g, 'circle', { cx: x, cy: YT(J.hours), r: 6, class: 'pc-h-knob' });
    void YC;
    const hi = hoverInf != null ? sw.reduce((a, b) => (Math.abs(b.infill - hoverInf) < Math.abs(a.infill - hoverInf) ? b : a)) : null;
    if (hi) {
      sv(svg, 'line', { x1: X(hi.infill), x2: X(hi.infill), y1: T, y2: H - B, class: 'pc-sw-hover' });
      const tx = clamp(X(hi.infill) + 6, L, W - R - 150);
      sv(svg, 'text', { x: tx, y: T + 12, class: 'pc-t' }, `${hi.infill} %: ${hmShort(hi.time)}, ${p3(hi.mass)} g, ${money(hi.total)} ${J.currency}`);
    }
    sweepGeo = { L, R, W };
    if (refocus === 'sweep') svg.querySelector('[data-h="sweep"]')?.focus();
  }
  const infAt = (e) => { const [x] = svgX(sweepSvg, e); const { L, R, W } = sweepGeo; return clamp(((x - L) / (W - L - R)) * 100, 0, 100); };
  sweepSvg.addEventListener('pointerdown', (e) => { if (!sweepGeo) return; sweepDrag = true; capture(sweepSvg, e); e.preventDefault(); const v = Math.round(infAt(e)); if (v !== Math.round(J.infill)) ctx.set('infill', String(v)); });
  sweepSvg.addEventListener('pointermove', (e) => {
    if (!sweepGeo || !J) return;
    const v = infAt(e);
    if (sweepDrag) { const r = Math.round(v); if (r !== Math.round(J.infill)) ctx.set('infill', String(r)); return; }
    hoverInf = v; drawSweep();
  });
  sweepSvg.addEventListener('pointerleave', () => { hoverInf = null; if (!sweepDrag) drawSweep(); });
  sweepSvg.addEventListener('pointerup', () => { sweepDrag = false; });
  sweepSvg.addEventListener('pointercancel', () => { sweepDrag = false; });
  sweepSvg.addEventListener('keydown', (e) => {
    if (!J || !e.target.closest?.('[data-h]')) return;
    const st = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!st) return; e.preventDefault(); refocus = 'sweep';
    ctx.set('infill', String(clamp(Math.round(J.infill) + st, 0, 100)));
  });

  // ---------- spools ----------
  function drawSpools() {
    const raw = ctx.raw;
    spoolBtns.forEach((b) => {
      const on = b.dataset.v === raw.material;
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
      const s = b.reel; s.replaceChildren();
      sv(s, 'circle', { cx: 20, cy: 20, r: 18, class: 'pc-reel-flange' });
      sv(s, 'circle', { cx: 20, cy: 20, r: 14, class: 'pc-reel-wind' });
      sv(s, 'circle', { cx: 20, cy: 20, r: 5, class: 'pc-reel-hub' });
      if (on && J) {
        // share of a 1 kg spool this part uses, as an arc on the winding
        const u = clamp(J.spoolShare, 0, 1);
        if (u >= 0.999) sv(s, 'circle', { cx: 20, cy: 20, r: 11, class: 'pc-reel-use' });
        else if (u > 0) {
          const a = u * 2 * Math.PI, x = 20 + 11 * Math.sin(a), y = 20 - 11 * Math.cos(a);
          sv(s, 'path', { d: `M20,9 A11,11 0 ${u > 0.5 ? 1 : 0} 1 ${x.toFixed(2)},${y.toFixed(2)}`, class: 'pc-reel-use' });
        }
      }
    });
    const sel = spoolBtns.find((b) => b.dataset.v === raw.material);
    spoolBtns.forEach((b) => b.querySelector('.pc-spool-use')?.remove());
    if (sel && J) sel.querySelector('.pc-spool-t').append(h('small', { class: 'pc-spool-use' }, `${p3(J.spoolShare * 100)} % of 1 kg`));
  }

  // ---------- all ----------
  function syncFields() {
    const r = ctx.raw;
    fPrice.sync(r.price); fCur.sync(r.currency); fWalls.sync(r.walls); fInfill.sync(r.infill);
    fVol.sync(r.volume); fArea.sync(r.area, J && J.areaEstimated ? `≈ ${p3(J.area)}` : ''); fSup.sync(r.support);
    fLine.sync(r.line); fLayer.sync(r.layer); fSpeed.sync(r.speed); fEff.sync(r.efficiency);
    fRate.sync(r.rate); fPower.sync(r.power); fKwh.sync(r.kwh); fFail.sync(r.failure);
    fLayer.bad(J && J.layer > 0.8 * J.line);
    fSpeed.bad(J && J.flow > J.flowLimit);
  }
  function draw() {
    syncZoom(); syncFields();
    const warns = res?.warnings || [];
    warnBox.replaceChildren(...warns.map((w) => h('div', {}, w)));
    warnBox.hidden = !warns.length;
    drawSpools(); drawLayer(); drawPart(); drawBead(); drawFlow(); drawTicket(); drawSweep();
    refocus = null;
  }
  ctx.onResult((r) => { res = r; J = r.job || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [layerSvg, partSvg, beadSvg, flowSvg, sweepSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !J) return;
      sizes = now; drawLayer(); drawPart(); drawBead(); drawFlow(); drawSweep();
    });
  }).observe(layout);
}
