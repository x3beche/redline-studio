// Print Guideline Checker: the page is a test coupon on the build plate.
// Eight stations stand on one plate, each a feature of your part drawn at its
// own magnification with a scale bar: the thin wall, the overhang, the bridge,
// the hole, the pin, the fine detail, the clearance between two parts and the
// drain hole. Your value is the solid shape, the process's limit the dashed
// ghost; the feature takes the colour of its verdict. Drag the feature itself
// (the wall's face, the overhang's tip, the bridge's far pillar, a hole's
// rim ...) or type the value. Under each station: how the same value fares on
// every process - click one to switch. Below the plate, the expected
// tolerance against part size (drag the size).
// Every number drawn comes from run()'s result.coupon.

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
const num = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Number(v.toPrecision(3))));
const niceBar = (mm) => { const p = 10 ** Math.floor(Math.log10(mm)), m = mm / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; };

const PROCS = [
  ['fdm', 'FDM', 'FDM / FFF, filament through a nozzle'],
  ['sla', 'SLA', 'SLA / resin, cured layer by layer in a vat'],
  ['sls', 'SLS', 'SLS nylon, powder sintered by a laser'],
  ['mjf', 'MJF', 'HP Multi Jet Fusion, powder fused under a printhead'],
];
const NOZZLES = [0.2, 0.25, 0.4, 0.6, 0.8, 1.0];
const TITLE = { wall: 'Thin wall', overhang: 'Overhang', bridge: 'Bridge', hole: 'Hole', pin: 'Pin / post', detail: 'Fine detail', clearance: 'Clearance', escape: 'Drain hole' };
const SUB = { wall: 'thinnest wall', overhang: 'from vertical', bridge: 'longest span', hole: 'smallest Ø', pin: 'thinnest Ø', detail: 'text, emboss', clearance: 'mating parts', escape: 'hollow parts' };
const VERDICT = { pass: 'passes', limit: 'at the limit', fail: 'fails', skip: 'not checked', none: 'no limit', invalid: 'not valid' };
const step = (key, v) => (key === 'overhang' ? 1 : key === 'bridge' ? 0.5 : (v ?? 1) >= 2 ? 0.1 : 0.05);
const roundTo = (v, s) => Math.round(v / s) * s;

function icon(kind) {
  const s = sv(null, 'svg', { viewBox: '0 0 32 24', class: 'pg-ico', 'aria-hidden': 'true' });
  if (kind === 'fdm') {
    sv(s, 'path', { d: 'M11 2h10v6l-3 5h-4l-3-5z', class: 'pg-ico-m' });
    sv(s, 'path', { d: 'M4 21h24M8 18h16', class: 'pg-ico-l' });
  } else if (kind === 'sla') {
    sv(s, 'path', { d: 'M8 3h16v3H8z', class: 'pg-ico-m' });
    sv(s, 'path', { d: 'M13 6v6h6V6', class: 'pg-ico-l' });
    sv(s, 'path', { d: 'M4 14v7h24v-7', class: 'pg-ico-l' });
    sv(s, 'path', { d: 'M5 18h22', class: 'pg-ico-f' });
  } else {
    sv(s, 'path', { d: 'M4 10h24v11H4z', class: 'pg-ico-f' });
    sv(s, 'path', { d: 'M4 10h24v11H4z', class: 'pg-ico-l' });
    if (kind === 'sls') sv(s, 'path', { d: 'M16 1l-4 9', class: 'pg-ico-beam' });
    else sv(s, 'path', { d: 'M6 3h20v4H6z', class: 'pg-ico-m' });
  }
  return s;
}

export function page(root, ctx) {
  const ver = location.search.match(/[?&]v=(\w+)/) ? `?v=${RegExp.$1}` : '';
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href + ver }));
  let C = null, res = null, refocus = null;

  // ---------- top: process, nozzle, score ----------
  const procRow = h('div', { class: 'pg-procs', role: 'radiogroup', 'aria-label': 'Process' });
  const procBtns = PROCS.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title, class: 'pg-proc',
    onclick: () => ctx.set('process', v),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return; e.preventDefault();
      const i = clamp(PROCS.findIndex((p) => p[0] === v) + d, 0, PROCS.length - 1);
      ctx.set('process', PROCS[i][0]); requestAnimationFrame(() => procRow.querySelector(`[data-v="${PROCS[i][0]}"]`)?.focus());
    } }, icon(v), h('span', {}, t)));
  procRow.append(...procBtns);
  const nozInp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Nozzle diameter in mm', oninput: (e) => ctx.set('nozzle', e.target.value) });
  const nozSeg = h('div', { class: 'pg-seg', role: 'radiogroup', 'aria-label': 'Nozzle' },
    NOZZLES.map((n) => h('button', { type: 'button', role: 'radio', 'data-n': n, onclick: () => ctx.set('nozzle', String(n)) }, String(n))));
  const nozBox = h('div', { class: 'pg-noz' }, h('span', { class: 'pg-cap' }, 'Nozzle'), nozSeg, h('label', { class: 'pg-num' }, nozInp, h('small', {}, 'mm')));
  const score = h('div', { class: 'pg-score', 'aria-live': 'polite' });
  const top = h('div', { class: 'pg-top' }, procRow, nozBox, score);

  // ---------- the coupon ----------
  const plate = h('div', { class: 'pg-plate' });
  const stations = {};
  for (const key of ['wall', 'overhang', 'bridge', 'hole', 'pin', 'detail', 'clearance', 'escape']) {
    const def = ctx.manifest.inputs.find((d) => d.key === key);
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${def.label} in ${def.unit}`, placeholder: '–',
      oninput: (e) => ctx.set(key, e.target.value) });
    const chip = h('span', { class: 'pg-chip' });
    const clear = h('button', { type: 'button', class: 'pg-x', title: 'Skip this check', 'aria-label': `Skip ${def.label}`, onclick: () => ctx.set(key, '') }, '×');
    const svg = sv(null, 'svg', { class: 'pg-svg', role: 'group', 'aria-label': `${def.label}: drag the feature to change it` });
    const procs = h('div', { class: 'pg-by' });
    const why = h('div', { class: 'pg-why' });
    const add = h('button', { type: 'button', class: 'pg-add' });
    const st = h('article', { class: 'pg-st', 'data-k': key },
      h('header', {}, h('div', { class: 'pg-st-t' }, h('b', {}, TITLE[key]), h('small', {}, SUB[key])), chip,
        h('label', { class: 'pg-num' }, inp, h('small', {}, def.unit.replace(' from vertical', ''))), clear),
      h('div', { class: 'pg-svgwrap' }, svg, add), why, procs);
    stations[key] = { st, svg, inp, chip, procs, why, clear, add, geo: null, frozen: null };
    plate.append(st);
    wireStation(key);
  }
  const tolSvg = sv(null, 'svg', { class: 'pg-tol-svg', role: 'group', 'aria-label': 'Expected tolerance against part size; drag the point to set the size' });
  const sizeInp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Largest dimension in mm', oninput: (e) => ctx.set('size', e.target.value) });
  const tolHead = h('div', { class: 'pg-tol-read' });
  const tol = h('section', { class: 'pg-tol' },
    h('div', { class: 'pg-tol-head' }, h('span', { class: 'pg-cap' }, 'Expected tolerance'), h('label', { class: 'pg-num' }, h('span', {}, 'Largest dimension'), sizeInp, h('small', {}, 'mm')), tolHead),
    h('div', { class: 'pg-svgwrap pg-tol-wrap' }, tolSvg));
  const findings = h('section', { class: 'pg-find' });
  const side = h('aside', { class: 'pg-side' }, findings, h('div', { class: 'pg-out' }, ctx.outputs));
  const layout = h('div', { class: 'pg' }, top, h('div', { class: 'pg-main' }, plate, tol), side);
  root.append(layout);

  // =====================================================================
  // Stations
  // =====================================================================
  function wireStation(key) {
    const S = () => stations[key];
    const svg = () => S().svg;
    const setV = (v) => {
      const c = C.checks.find((x) => x.key === key);
      const s = step(key, v);
      const r = Number(roundTo(v, s).toFixed(s < 0.1 ? 2 : 1));
      if (r !== c.value) ctx.set(key, String(r));
    };
    const s0 = stations[key];
    s0.svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest?.('[data-h]');
      if (!g || !C) return;
      S().frozen = { ...S().geo }; capture(svg(), e); e.preventDefault();
    });
    s0.svg.addEventListener('pointermove', (e) => {
      const f = S().frozen;
      if (!f) return;
      const r = svg().getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      setV(f.valueAt(x, y));
    });
    const end = () => { S().frozen = null; };
    s0.svg.addEventListener('pointerup', end);
    s0.svg.addEventListener('pointercancel', end);
    s0.svg.addEventListener('keydown', (e) => {
      if (!C || !e.target.closest?.('[data-h]')) return;
      const c = C.checks.find((x) => x.key === key);
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (!d || c.value == null) return;
      e.preventDefault(); refocus = key;
      setV(Math.max(0, c.value + d * step(key, c.value)));
    });
    s0.add.addEventListener('click', () => {
      const c = C?.checks.find((x) => x.key === key);
      if (!c) return;
      const v = c.limit != null ? c.limit : { overhang: 45, bridge: 10, escape: 5 }[key] ?? 1;
      ctx.set(key, String(v));
    });
  }

  function drawStation(c) {
    const S = stations[c.key];
    const { st, svg, inp, chip, procs, why, add } = S;
    const skip = c.value == null;
    const notApplicable = c.key === 'escape' && c.limit == null;
    st.className = `pg-st pg-v-${c.verdict}`;
    if (document.activeElement !== inp) inp.value = ctx.raw[c.key] ?? '';
    chip.textContent = notApplicable && skip ? 'not needed' : VERDICT[c.verdict];
    S.clear.hidden = skip;
    why.textContent = c.verdict === 'fail' ? `Needs ${c.sense === 'min' ? 'at least' : 'at most'} ${num(c.limit)} ${c.unit}: ${c.why}.`
      : c.verdict === 'limit' ? `Within 25 % of the ${num(c.limit)} ${c.unit} limit: print a test.`
        : c.verdict === 'none' && !skip ? (c.key === 'escape' ? 'FDM parts are not hollowed: no drain hole needed.' : 'Self-supporting in a powder bed: no limit.')
          : '';
    // by process
    procs.replaceChildren(...PROCS.map(([p, t]) => {
      const b = c.byProcess[p];
      const on = p === C.process;
      return h('button', { type: 'button', class: `pg-bp pg-v-${b.verdict || 'skip'}${on ? ' pg-on' : ''}`, title: `${t}: limit ${b.limit == null ? 'none' : `${num(b.limit)} ${c.unit}`}${b.verdict ? `, your value ${VERDICT[b.verdict]}` : ''}. Click to switch.`,
        onclick: () => ctx.set('process', p) }, h('i', {}), h('span', {}, t), h('small', {}, b.limit == null ? '–' : `${c.sense === 'min' ? '≥' : '≤'}${num(b.limit)}`));
    }));
    // drawing
    svg.replaceChildren();
    const W = Math.max(150, svg.clientWidth || 240), H = Math.max(120, svg.clientHeight || 170);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const plateY = H - 16;
    sv(svg, 'rect', { x: -2, y: plateY, width: W + 4, height: 18, class: 'pg-bed' });
    add.hidden = !skip;
    if (skip) {
      add.textContent = notApplicable ? 'Not needed for FDM (add anyway)' : `Not checked. Add at ${c.limit != null ? `${num(c.limit)} ${c.unit}` : 'a value'}`;
    }
    const v = skip ? (c.limit ?? { overhang: 45, bridge: 10, escape: 5 }[c.key] ?? 1) : c.value;
    const L = c.limit;
    const frozen = S.frozen;
    const g = DRAW[c.key](svg, { W, H, plateY, v, L, c, skip, frozen });
    S.geo = g || null;
    if (refocus === c.key) svg.querySelector('[data-h]')?.focus();
  }

  // Each drawing returns { valueAt(x, y) } for its drag, with the scale it drew at
  // (frozen during a drag so the feature grows under the pointer instead of the scale shrinking).
  const cls = (c, skip) => `pg-feat${skip ? ' pg-ghosted' : ''}`;
  const handle = (svg, c, attrs) => {
    const g = sv(svg, 'g', { class: 'pg-handle', tabindex: c.value == null ? -1 : 0, role: 'slider', 'data-h': c.key,
      'aria-label': c.label, 'aria-valuenow': c.value ?? '', 'aria-valuetext': c.value == null ? 'not checked' : `${num(c.value)} ${c.unit}, ${VERDICT[c.verdict]}` });
    return g;
  };
  const scaleBar = (svg, sc, W, y) => {
    const mm = niceBar(Math.max(0.05, (W * 0.28) / sc));
    const x0 = 10;
    sv(svg, 'line', { x1: x0, x2: x0 + mm * sc, y1: y, y2: y, class: 'pg-scale' });
    sv(svg, 'text', { x: x0 + mm * sc + 5, y: y + 3.5, class: 'pg-t pg-soft' }, `${num(mm)} mm`);
  };
  const ghostDash = 'pg-ghost';
  const label = (svg, x, y, text, anchor = 'middle', extra = '') => sv(svg, 'text', { x, y, class: `pg-t ${extra}`, 'text-anchor': anchor }, text);
  const dimH = (svg, xa, xb, y, text, extra = '') => {
    sv(svg, 'line', { x1: xa, x2: xb, y1: y, y2: y, class: 'pg-dim', 'marker-start': 'url(#pg-a)', 'marker-end': 'url(#pg-a)' });
    label(svg, (xa + xb) / 2, y - 5, text, 'middle', extra);
  };
  const arrowDefs = (svg) => {
    const d = sv(svg, 'defs');
    const m = sv(d, 'marker', { id: 'pg-a', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    sv(m, 'path', { d: 'M0,1 L10,5 L0,9 z', class: 'pg-ah' });
    return d;
  };
  const valTxt = (c, v) => `${num(v)}${c.unit === '°' ? '°' : ' mm'}`;
  const limTxt = (c) => (c.limit == null ? 'no limit' : `limit ${c.sense === 'min' ? '≥' : '≤'} ${num(c.limit)}${c.unit === '°' ? '°' : ''}`);

  const DRAW = {};
  // a fin standing on the plate and a round post; thickness to scale
  DRAW.wall = (svg, o) => widthFeature(svg, o, { top: 0.22, span: 3.2, round: false, what: 'wall' });
  DRAW.pin = (svg, o) => widthFeature(svg, o, { top: 0.3, span: 3.6, round: true, what: 'pin' });
  function widthFeature(svg, { W, plateY, v, L, c, skip, frozen }, opt) {
    arrowDefs(svg);
    const ext = Math.max(v, L ?? 0) * opt.span;
    const sc = frozen?.sc ?? (W - 30) / ext;
    const cx = W / 2, top = plateY * opt.top + 18;
    const hw = (v * sc) / 2;
    if (L != null) sv(svg, 'rect', { x: cx - (L * sc) / 2, y: top - 8, width: L * sc, height: plateY - top + 8, class: ghostDash });
    if (opt.round) {
      sv(svg, 'path', { d: `M${cx - hw},${plateY} L${cx - hw},${top + hw * 0.5} Q${cx - hw},${top} ${cx},${top} Q${cx + hw},${top} ${cx + hw},${top + hw * 0.5} L${cx + hw},${plateY} Z`, class: cls(c, skip) });
    } else sv(svg, 'rect', { x: cx - hw, y: top, width: 2 * hw, height: plateY - top, class: cls(c, skip) });
    if (L != null) label(svg, cx + (L * sc) / 2 + 4, top - 12, limTxt(c), 'start', 'pg-soft');
    dimH(svg, cx - hw, cx + hw, (top + plateY) / 2, valTxt(c, v), 'pg-val');
    const g = handle(svg, c);
    sv(g, 'rect', { x: cx + hw - 8, y: top, width: 16, height: plateY - top, class: 'pg-hit' });
    sv(g, 'line', { x1: cx + hw, x2: cx + hw, y1: top + 4, y2: plateY - 4, class: 'pg-grip' });
    scaleBar(svg, sc, W, 14);
    return { sc, valueAt: (x) => Math.max(0.05, (2 * Math.abs(x - cx)) / sc) };
  }
  DRAW.overhang = (svg, { W, plateY, v, L, c, skip }) => {
    arrowDefs(svg);
    const px = W * 0.3, len = Math.min(plateY - 26, W * 0.62);
    const a = (clamp(v, 0, 90) * Math.PI) / 180;
    const tip = [px + len * Math.sin(a), plateY - len * Math.cos(a)];
    // the leaning wall as a thick band from the plate
    const t = 12;
    sv(svg, 'path', { d: `M${px - t},${plateY} L${tip[0] - t},${tip[1]} L${tip[0]},${tip[1]} L${px},${plateY} Z`, class: cls(c, skip) });
    if (L != null) {
      const la = (L * Math.PI) / 180;
      sv(svg, 'line', { x1: px, y1: plateY, x2: px + len * Math.sin(la), y2: plateY - len * Math.cos(la), class: `${ghostDash} pg-ghost-line` });
      const lx = px + len * Math.sin(la) + 4, far = lx > W - 90;
      label(svg, far ? W - 6 : lx, plateY - len * Math.cos(la) - (far ? 14 : 4), limTxt(c), far ? 'end' : 'start', 'pg-soft');
    }
    sv(svg, 'line', { x1: px, y1: plateY, x2: px, y2: plateY - len, class: 'pg-vert' });
    const r = 38;
    if (v > 0.5) sv(svg, 'path', { d: `M${px},${plateY - r} A${r},${r} 0 0 1 ${px + r * Math.sin(a)},${plateY - r * Math.cos(a)}`, class: 'pg-dim' });
    label(svg, px + 6, plateY - r - 6, valTxt(c, v), 'start', 'pg-val');
    if (c.verdict === 'fail') for (let k = 1; k <= 3; k++) {
      const q = 0.45 + k * 0.17, x = px + (tip[0] - px) * q, y = plateY + (tip[1] - plateY) * q;
      sv(svg, 'path', { d: `M${x},${y + 2} q-2,7 0,11 q2,-4 0,-11`, class: 'pg-drip' });
    }
    const g = handle(svg, c);
    sv(g, 'circle', { cx: tip[0], cy: tip[1], r: 14, class: 'pg-hit' });
    sv(g, 'circle', { cx: tip[0], cy: tip[1], r: 6, class: 'pg-knob' });
    label(svg, W - 8, 16, '0° vertical · 90° ceiling', 'end', 'pg-soft');
    return { valueAt: (x, y) => clamp((Math.atan2(x - px, plateY - y) * 180) / Math.PI, 0, 90) };
  };
  DRAW.bridge = (svg, { W, plateY, v, L, c, skip, frozen }) => {
    arrowDefs(svg);
    const pw = 16, ext = Math.max(v, L ?? 0) * 1.18;
    const sc = frozen?.sc ?? (W - 2 * pw - 34) / ext;
    const x0 = 14 + pw, x1 = x0 + v * sc, top = plateY * 0.42;
    sv(svg, 'rect', { x: x0 - pw, y: top, width: pw, height: plateY - top, class: cls(c, skip) });
    sv(svg, 'rect', { x: x1, y: top, width: pw, height: plateY - top, class: cls(c, skip) });
    const sag = c.verdict === 'fail' ? Math.min(26, 6 + (v / (L || v) - 1) * 30) : 0;
    sv(svg, 'path', { d: `M${x0 - pw},${top} L${x1 + pw},${top} L${x1 + pw},${top + 7} L${x1},${top + 7} Q${(x0 + x1) / 2},${top + 7 + 2 * sag} ${x0},${top + 7} L${x0 - pw},${top + 7} Z`, class: cls(c, skip) });
    if (L != null) {
      const xl = x0 + L * sc;
      sv(svg, 'line', { x1: xl, x2: xl, y1: top - 14, y2: plateY, class: `${ghostDash} pg-ghost-line` });
      label(svg, xl + (xl > W - 70 ? -4 : 4), top - 18, limTxt(c), xl > W - 70 ? 'end' : 'start', 'pg-soft');
    }
    dimH(svg, x0, x1, top + 34 + sag, valTxt(c, v), 'pg-val');
    const g = handle(svg, c);
    sv(g, 'rect', { x: x1 - 4, y: top, width: pw + 8, height: plateY - top, class: 'pg-hit' });
    sv(g, 'line', { x1: x1 + pw / 2, x2: x1 + pw / 2, y1: top + 16, y2: plateY - 8, class: 'pg-grip' });
    scaleBar(svg, sc, W, 14);
    return { sc, valueAt: (x) => Math.max(0.5, (x - x0) / sc) };
  };
  DRAW.hole = (svg, o) => roundHole(svg, o, false);
  DRAW.escape = (svg, o) => roundHole(svg, o, true);
  function roundHole(svg, { W, plateY, v, L, c, skip, frozen }, hollow) {
    arrowDefs(svg);
    const ext = Math.max(v, L ?? 0) * (hollow ? 2.6 : 2.1);
    const room = Math.min(W - 24, plateY - 30);
    const sc = frozen?.sc ?? room / ext;
    const bw = ext * sc, cx = W / 2, by = plateY - bw * 0.92, cy = by + bw * 0.46;
    if (hollow) {
      // a hollow shell in section with the drain hole in its floor seen from below: drawn as a shell with the hole in the side
      sv(svg, 'rect', { x: cx - bw / 2, y: by, width: bw, height: plateY - by, rx: 6, class: cls(c, skip) });
      sv(svg, 'rect', { x: cx - bw / 2 + 7, y: by + 7, width: bw - 14, height: plateY - by - 14, rx: 3, class: 'pg-cavity' });
      for (let k = 0; k < 7; k++) sv(svg, 'circle', { cx: cx - bw / 2 + 14 + ((k * 37) % (bw - 28)), cy: plateY - 12 - ((k * 13) % 14), r: 1.6, class: 'pg-grain' });
    } else sv(svg, 'rect', { x: cx - bw / 2, y: by, width: bw, height: plateY - by, class: cls(c, skip) });
    const r = (v * sc) / 2;
    sv(svg, 'circle', { cx, cy, r, class: 'pg-bore' });
    if (L != null) sv(svg, 'circle', { cx, cy, r: (L * sc) / 2, class: ghostDash });
    if (hollow && c.verdict === 'fail') label(svg, cx, plateY - 24, 'trapped', 'middle', 'pg-bad');
    dimH(svg, cx - r, cx + r, cy, valTxt(c, v), 'pg-val pg-onbore');
    if (L != null) label(svg, cx, by - 6, limTxt(c), 'middle', 'pg-soft');
    const g = handle(svg, c);
    sv(g, 'circle', { cx: cx + r * 0.707, cy: cy - r * 0.707, r: 12, class: 'pg-hit' });
    sv(g, 'circle', { cx: cx + r * 0.707, cy: cy - r * 0.707, r: 5.5, class: 'pg-knob' });
    scaleBar(svg, sc, W, 14);
    return { sc, valueAt: (x, y) => Math.max(0.05, (2 * Math.hypot(x - cx, y - cy)) / sc) };
  }
  DRAW.detail = (svg, { W, plateY, v, L, c, skip, frozen }) => {
    arrowDefs(svg);
    const ext = Math.max(v, L ?? 0) * 7.5;
    const sc = frozen?.sc ?? (W - 30) / ext;
    const base = plateY * 0.62, x0 = 15;
    sv(svg, 'rect', { x: 0, y: base, width: W, height: plateY - base, class: 'pg-feat pg-body' });
    // three raised ribs of the detail width, gaps of the same width
    const w = v * sc, hgt = Math.min(26, Math.max(8, w * 0.8));
    let x = x0 + (L != null ? L * sc * 1.5 : 0);
    const ribs = [];
    for (let k = 0; k < 3; k++) { sv(svg, 'rect', { x, y: base - hgt, width: w, height: hgt, class: cls(c, skip) }); ribs.push(x); x += 2 * w; }
    if (L != null) {
      sv(svg, 'rect', { x: x0, y: base - hgt, width: L * sc, height: hgt, class: ghostDash });
      label(svg, x0, base - hgt - 8, limTxt(c), 'start', 'pg-soft');
    }
    dimH(svg, ribs[1], ribs[1] + w, base + 18, valTxt(c, v), 'pg-val');
    const g = handle(svg, c);
    const hx = ribs[2] + w;
    sv(g, 'rect', { x: hx - 8, y: base - hgt - 4, width: 16, height: hgt + 8, class: 'pg-hit' });
    sv(g, 'line', { x1: hx, x2: hx, y1: base - hgt, y2: base, class: 'pg-grip' });
    scaleBar(svg, sc, W, 14);
    // the value follows the last rib's right edge: x0' + 5 w = pointer
    const start = ribs[0];
    return { sc, valueAt: (px) => Math.max(0.05, (px - start) / 5 / sc) };
  };
  DRAW.clearance = (svg, { W, plateY, v, L, c, skip, frozen }) => {
    arrowDefs(svg);
    // a peg in a slot, the gap to scale with the peg drawn a fixed width
    const ext = Math.max(v, L ?? 0);
    const sc = frozen?.sc ?? (W * 0.16) / ext;
    const cx = W / 2, pegW = W * 0.3, top = plateY * 0.24, slotTop = plateY * 0.5;
    const g2 = v * sc;
    // the body with the slot
    sv(svg, 'path', { d: `M8,${slotTop} L${cx - pegW / 2 - g2},${slotTop} L${cx - pegW / 2 - g2},${plateY - 12} L${cx + pegW / 2 + g2},${plateY - 12} L${cx + pegW / 2 + g2},${slotTop} L${W - 8},${slotTop} L${W - 8},${plateY} L8,${plateY} Z`, class: `pg-feat pg-body${skip ? ' pg-ghosted' : ''}` });
    // the peg (the other part), gap all round
    sv(svg, 'rect', { x: cx - pegW / 2, y: top, width: pegW, height: plateY - 12 - g2 - top, class: cls(c, skip) });
    if (L != null) {
      const gl = L * sc;
      sv(svg, 'rect', { x: cx - pegW / 2 - gl, y: slotTop, width: pegW + 2 * gl, height: plateY - 12 - slotTop, class: ghostDash });
      label(svg, cx, top - 8, limTxt(c), 'middle', 'pg-soft');
    }
    if (c.verdict === 'fail') label(svg, cx, slotTop - 8, 'fuses', 'middle', 'pg-bad');
    dimH(svg, cx + pegW / 2, cx + pegW / 2 + g2, slotTop - 10, '', 'pg-val');
    label(svg, cx + pegW / 2 + g2 + 4, slotTop - 12, valTxt(c, v), 'start', 'pg-val');
    const g = handle(svg, c);
    const hx = cx + pegW / 2 + g2;
    sv(g, 'rect', { x: hx - 8, y: slotTop, width: 16, height: plateY - 12 - slotTop, class: 'pg-hit' });
    sv(g, 'line', { x1: hx, x2: hx, y1: slotTop + 6, y2: plateY - 18, class: 'pg-grip' });
    scaleBar(svg, sc, W, 14);
    return { sc, valueAt: (x) => Math.max(0.02, (x - (cx + pegW / 2)) / sc) };
  };

  // =====================================================================
  // Tolerance against size
  // =====================================================================
  let tolGeo = null, tolDrag = false;
  function drawTol() {
    const svg = tolSvg;
    svg.replaceChildren();
    const T = C?.tolerance;
    const raw = ctx.raw;
    if (document.activeElement !== sizeInp) sizeInp.value = raw.size ?? '';
    if (!T) { tolHead.textContent = 'Give the largest dimension to get the expected tolerance.'; tolGeo = null; return; }
    tolHead.replaceChildren(h('b', {}, `± ${num(T.tol)} mm`), ` on ${num(T.size)} mm: ±${num(T.pct)} %, at least ±${num(T.min)} mm`);
    const W = Math.max(260, svg.clientWidth || 600), H = Math.max(70, svg.clientHeight || 90);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const Lm = 44, R = 14, top = 8, B = 20;
    const xMax = tolDrag && tolGeo ? tolGeo.xMax : Math.max(T.knee * 2.5, T.size * 1.6, 20);
    const yStep = niceBar(Math.max(T.min, (T.pct / 100) * xMax) * 1.1 / 2);
    const yMax = yStep * Math.ceil((Math.max(T.min, (T.pct / 100) * xMax) * 1.1) / yStep);
    const X = (s) => Lm + (W - Lm - R) * (s / xMax), Y = (t) => top + (H - top - B) * (1 - t / yMax);
    for (let t = 0; t <= yMax + 1e-9; t += yStep) {
      sv(svg, 'line', { x1: Lm, x2: W - R, y1: Y(t), y2: Y(t), class: 'pg-grid' });
      sv(svg, 'text', { x: Lm - 5, y: Y(t) + 4, class: 'pg-t pg-soft', 'text-anchor': 'end' }, `±${num(t)}`);
    }
    const stp = niceBar(xMax / 5);
    for (let s = 0; s <= xMax + 1e-9; s += stp) sv(svg, 'text', { x: X(s), y: H - 5, class: 'pg-t pg-soft', 'text-anchor': 'middle' }, `${num(s)}${s === 0 ? ' mm' : ''}`);
    // the curve: floor then proportional; the band under it
    const pts = [[0, T.min], [Math.min(T.knee, xMax), T.min], [xMax, Math.max(T.min, (T.pct / 100) * xMax)]];
    sv(svg, 'path', { d: `M${X(0)},${Y(0)} ${pts.map(([s, t]) => `L${X(s)},${Y(t)}`).join(' ')} L${X(xMax)},${Y(0)} Z`, class: 'pg-tol-band' });
    sv(svg, 'path', { d: pts.map(([s, t], i) => `${i ? 'L' : 'M'}${X(s)},${Y(t)}`).join(' '), class: 'pg-tol-line' });
    if (T.knee < xMax) sv(svg, 'text', { x: Math.max(Lm + 4, X(T.knee) - 6), y: Y(T.min) - 6, class: 'pg-t pg-soft', 'text-anchor': X(T.knee) - Lm > 200 ? 'end' : 'start' }, `floor ±${num(T.min)} up to ${num(T.knee)} mm, then ±${num(T.pct)} %`);
    sv(svg, 'line', { x1: X(T.size), x2: X(T.size), y1: Y(T.tol), y2: Y(0), class: 'pg-dim' });
    const g = sv(svg, 'g', { class: 'pg-handle', tabindex: 0, role: 'slider', 'data-h': 'size', 'aria-label': 'Largest dimension', 'aria-valuenow': T.size, 'aria-valuetext': `${num(T.size)} mm, ± ${num(T.tol)} mm` });
    sv(g, 'circle', { cx: X(T.size), cy: Y(T.tol), r: 13, class: 'pg-hit' });
    sv(g, 'circle', { cx: X(T.size), cy: Y(T.tol), r: 6, class: 'pg-knob' });
    tolGeo = { X, Lm, R, W, xMax };
    if (refocus === 'size') g.focus();
  }
  tolSvg.addEventListener('pointerdown', (e) => {
    if (!tolGeo || !e.target.closest?.('[data-h]')) return;
    tolDrag = true; capture(tolSvg, e); e.preventDefault();
  });
  tolSvg.addEventListener('pointermove', (e) => {
    if (!tolDrag || !tolGeo) return;
    const r = tolSvg.getBoundingClientRect();
    const { Lm, R, W, xMax } = tolGeo;
    const s = clamp(((e.clientX - r.left - Lm) / (W - Lm - R)) * xMax, 1, xMax);
    const v = Math.round(s >= 100 ? s / 5 : s) * (s >= 100 ? 5 : 1);
    if (v !== C.tolerance.size) ctx.set('size', String(v));
  });
  const endTol = () => { if (tolDrag) { tolDrag = false; drawTol(); } };
  tolSvg.addEventListener('pointerup', endTol);
  tolSvg.addEventListener('pointercancel', endTol);
  tolSvg.addEventListener('keydown', (e) => {
    if (!C?.tolerance || !e.target.closest?.('[data-h]')) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!d) return; e.preventDefault(); refocus = 'size';
    const s = C.tolerance.size, st2 = s >= 100 ? 5 : 1;
    ctx.set('size', String(Math.max(1, s + d * st2)));
  });

  // =====================================================================
  function draw() {
    const raw = ctx.raw;
    procBtns.forEach((b) => { const on = b.dataset.v === raw.process; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    const fdm = raw.process === 'fdm';
    nozBox.hidden = !fdm;
    nozSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(C && Number(b.dataset.n) === C.nozzle)));
    if (document.activeElement !== nozInp) nozInp.value = raw.nozzle ?? '';
    const warns = res?.warnings || [];
    findings.replaceChildren(h('div', { class: 'pg-cap' }, warns.length ? 'To fix' : 'Findings'),
      ...(warns.length ? warns.map((w) => h('div', { class: 'pg-fw' }, w)) : [h('div', { class: 'pg-ok' }, 'Every checked feature is within the process limits.')]),
      ...(res?.notes || []).slice(0, 2).map((n) => h('div', { class: 'pg-note' }, n)));
    if (!C) { score.replaceChildren(); return; }
    const k = C.counts;
    score.replaceChildren(
      h('b', { class: k.fail ? 'pg-bad' : k.marginal ? 'pg-warn' : 'pg-good' }, `${k.pass + k.marginal} of ${k.checked}`),
      h('span', {}, ' pass'),
      h('span', { class: 'pg-sc-bits' },
        h('i', { class: 'pg-dot pg-v-pass' }), `${k.pass} `, h('i', { class: 'pg-dot pg-v-limit' }), `${k.marginal} `, h('i', { class: 'pg-dot pg-v-fail' }), `${k.fail}`),
      h('small', {}, C.name));
    for (const c of C.checks) drawStation(c);
    drawTol();
    refocus = null;
  }
  ctx.onResult((r) => { res = r; C = r.coupon || null; draw(); });
  let sizes = '', raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const now = [...Object.values(stations).map((s) => s.svg), tolSvg].map((e) => `${e.clientWidth}x${e.clientHeight}`).join();
      if (now === sizes || !C) return;
      sizes = now; for (const c of C.checks) drawStation(c); drawTol();
    });
  }).observe(layout);
}
