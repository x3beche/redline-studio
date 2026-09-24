// Type scale: the page is a live typographic specimen.
//   Ratio strip  - the musical intervals (minor second .. golden ratio) on a log
//                  axis; click one or drag the marker (fluid: one marker per
//                  screen size) - between the marks it is a custom ratio.
//   Viewport     - (fluid) every step's clamp() drawn against viewport width on
//                  a log size axis; drag the cursor to set the width the
//                  specimen is shown at, drag the min / max marks to move them.
//   Specimen     - one line per step, set at its real size and line height,
//                  with its role, variable, px / rem and line height beside it;
//                  drag the body line (or its grip) to change the base size.
//                  Steps under the readability limits are marked on the line.
//   In use       - a short article set in the scale; then the output panel.
// Every size shown comes from run()'s result.scale; in fluid mode the page
// evaluates each step's clamp() line (slope, intercept, min, max) at the
// chosen width, as the browser would.

const NS = 'http://www.w3.org/2000/svg';
const INTERVALS = [
  { r: 1.067, key: '1.067', name: 'Minor second', short: 'm2' },
  { r: 1.125, key: '1.125', name: 'Major second', short: 'M2' },
  { r: 1.2, key: '1.2', name: 'Minor third', short: 'm3' },
  { r: 1.25, key: '1.25', name: 'Major third', short: 'M3' },
  { r: 1.333, key: '1.333', name: 'Perfect fourth', short: 'P4' },
  { r: 1.414, key: '1.414', name: 'Augmented fourth', short: 'A4' },
  { r: 1.5, key: '1.5', name: 'Perfect fifth', short: 'P5' },
  { r: 1.618, key: '1.618', name: 'Golden ratio', short: 'φ' },
];
const MAX_KEYS = ['1.125', '1.2', '1.25', '1.333', '1.414', '1.5', '1.618']; // ratioMax's options
const R_LO = 1.03, R_HI = 1.72;
const SAMPLE = {
  h: ['Rhythm', 'Headings set the pace', 'A scale you can read', 'Sections and parts', 'Smaller headings', 'Minor heading'],
  body: 'Body text sets the rhythm for everything else on the page.',
  small: 'Captions, footnotes, labels and legal text',
};

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function page(root, ctx) {
  const F = (v, d = 4) => ctx.fmtNum(v, d);
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);

  let res = null, inp = ctx.input;
  let width = null;              // viewport width the fluid specimen is shown at
  let activeThumb = 'min';       // which ratio marker a click on the strip moves

  // ---------------- controls bar ----------------
  const field = (key, attrs = {}) => {
    const el = h('input', { type: 'text', class: 'ts-num', inputmode: 'decimal', spellcheck: 'false', 'data-key': key, ...attrs,
      oninput: (e) => ctx.set(key, e.target.value) });
    return el;
  };
  const seg = (key, opts, label) => h('div', { class: 'ts-seg', role: 'group', 'aria-label': label },
    opts.map(([v, t]) => h('button', { type: 'button', 'data-seg': key, 'data-v': String(v), onclick: () => ctx.set(key, v) }, t)));
  const stepper = (key, lo, hi, label) => {
    const out = h('output', { class: 'ts-stepv', 'data-out': key });
    const bump = (d) => ctx.set(key, String(clamp(Math.round(Number(ctx.raw[key]) || 0) + d, lo, hi)));
    return h('div', { class: 'ts-stepper', role: 'group', 'aria-label': label },
      h('button', { type: 'button', 'aria-label': `${label}: fewer`, onclick: () => bump(-1) }, '−'), out,
      h('button', { type: 'button', 'aria-label': `${label}: more`, onclick: () => bump(1) }, '+'));
  };
  const lab = (t, ...kids) => h('label', { class: 'ts-ctl' }, h('span', {}, t), ...kids);
  const fBase = field('base', { 'aria-label': 'Body size in px' });
  const fBaseMax = field('baseMax', { 'aria-label': 'Body size at the large viewport in px' });
  const fVwMin = field('vwMin', { 'aria-label': 'Small viewport width in px' });
  const fVwMax = field('vwMax', { 'aria-label': 'Large viewport width in px' });
  const fPrefix = h('input', { type: 'text', class: 'ts-num ts-prefix', spellcheck: 'false', 'data-key': 'prefix', 'aria-label': 'Variable prefix',
    oninput: (e) => ctx.set('prefix', e.target.value) });
  const selNames = h('select', { 'aria-label': 'Variable names', onchange: (e) => ctx.set('naming', e.target.value) },
    h('option', { value: 'numeric' }, '--step-0, -1 …'), h('option', { value: 'tshirt' }, '--step-base, -lg …'), h('option', { value: 'headings' }, '--step-body, -h1 …'));
  const chkRound = h('input', { type: 'checkbox', onchange: (e) => ctx.set('rounding', e.target.checked) });
  const fluidOnly = [];
  const fl = (el) => { fluidOnly.push(el); return el; };
  const bar = h('div', { class: 'ts-bar' },
    seg('fluid', [[false, 'Static'], [true, 'Fluid']], 'Mode'),
    lab('Body', fBase, h('i', {}, 'px')),
    fl(lab('at large', fBaseMax, h('i', {}, 'px'))),
    fl(lab('Viewports', fVwMin, h('i', {}, '–'), fVwMax, h('i', {}, 'px'))),
    lab('Headings', stepper('up', 0, 10, 'Steps up')),
    lab('Small', stepper('down', 0, 3, 'Steps down')),
    seg('unit', [['rem', 'rem'], ['px', 'px']], 'CSS unit'),
    lab('Names', selNames),
    lab('Prefix', h('i', {}, '--'), fPrefix),
    h('label', { class: 'ts-ctl ts-chk' }, chkRound, h('span', {}, 'Whole px')));

  // ---------------- ratio strip ----------------
  const ratioSvg = sv('svg', { class: 'ts-ratio-svg', role: 'group', 'aria-label': 'Ratio: musical intervals' });
  const fRatio = field('custom', { 'aria-label': 'Ratio' });
  fRatio.oninput = (e) => setRatio('min', Number(e.target.value), true);
  const fRatioMax = field('customMax', { 'aria-label': 'Ratio at the large viewport' });
  fRatioMax.oninput = (e) => setRatio('max', Number(e.target.value), true);
  const ratioName = h('span', { class: 'ts-rname' });
  const ratioNameMax = h('span', { class: 'ts-rname' });
  const ratioHead = h('div', { class: 'ts-rhead' },
    h('span', { class: 'ts-h' }, 'Ratio'),
    h('span', { class: 'ts-rval' }, h('span', { class: 'ts-tag ts-tag-min' }, 'small'), fRatio, ratioName),
    fl(h('span', { class: 'ts-rval' }, h('span', { class: 'ts-tag ts-tag-max' }, 'large'), fRatioMax, ratioNameMax,
      h('button', { type: 'button', class: 'ts-link', onclick: () => ctx.set('ratioMax', 'same') }, 'same as small'))));
  const ratioBox = h('section', { class: 'ts-panel ts-ratio' }, ratioHead, ratioSvg);

  // ---------------- viewport chart ----------------
  const vpSvg = sv('svg', { class: 'ts-vp-svg', role: 'group', 'aria-label': 'Font size against viewport width' });
  const vpNote = h('span', { class: 'ts-sub' });
  const vpBox = fl(h('section', { class: 'ts-panel ts-vp' }, h('div', { class: 'ts-phead' }, h('span', { class: 'ts-h' }, 'Viewport width'), vpNote), vpSvg));

  // ---------------- specimen ----------------
  const ladder = h('div', { class: 'ts-ladder' });
  const specNote = h('span', { class: 'ts-sub' });
  const specBox = h('section', { class: 'ts-panel ts-spec' }, h('div', { class: 'ts-phead' }, h('span', { class: 'ts-h' }, 'Specimen'), specNote), ladder);

  // ---------------- side ----------------
  const sample = h('article', { class: 'ts-article' });
  const sampleNote = h('span', { class: 'ts-sub' });
  const warns = h('div', { class: 'ts-warns', 'aria-live': 'polite' });
  const notes = h('details', { class: 'ts-notes' });
  const side = h('aside', { class: 'ts-side' },
    h('section', { class: 'ts-panel ts-inuse' }, h('div', { class: 'ts-phead' }, h('span', { class: 'ts-h' }, 'In use'), sampleNote), sample),
    warns, notes);

  root.classList.add('ts-root');
  root.append(h('div', { class: 'ts' }, bar, h('div', { class: 'ts-grid' },
    h('div', { class: 'ts-main' }, ratioBox, vpBox, specBox, ctx.outputs), side)));
  ctx.outputs.classList.add('ts-out');
  // The CSS is what this tool is for: open on it unless a tab was chosen before.
  let tabChosen = null;
  try { tabChosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }

  // ---------------- helpers ----------------
  const steps = () => res?.scale?.steps || [];
  const fluid = () => !!res?.scale?.fluid;
  const sizeAt = (s, w) => {
    if (!fluid()) return s.min;
    const lo = Math.min(s.min, s.max), hi = Math.max(s.min, s.max);
    return clamp(s.intercept + s.slope * w, lo, hi);
  };
  const curW = () => {
    const sc = res.scale;
    return width == null ? Math.round((sc.vwMin + sc.vwMax) / 2) : width;
  };
  const nearestInterval = (r, list) => list.find((iv) => Math.abs(iv.r - r) < 0.004);
  function setRatio(which, r, typed = false) {
    if (!(r > 1)) return;
    r = Math.round(r * 1000) / 1000;
    if (which === 'min') {
      const iv = nearestInterval(r, INTERVALS);
      if (iv) ctx.setMany(typed ? { ratio: iv.key } : { ratio: iv.key, custom: String(iv.r) });
      else ctx.setMany(typed ? { ratio: 'custom' } : { ratio: 'custom', custom: String(r) });
    } else {
      const iv = nearestInterval(r, INTERVALS.filter((x) => MAX_KEYS.includes(x.key)));
      if (iv) ctx.setMany(typed ? { ratioMax: iv.key } : { ratioMax: iv.key, customMax: String(iv.r) });
      else ctx.setMany(typed ? { ratioMax: 'custom' } : { ratioMax: 'custom', customMax: String(r) });
    }
  }
  const keepFocus = (fn) => {
    const k = document.activeElement?.dataset?.focus;
    fn();
    if (k) root.querySelector(`[data-focus="${k}"]`)?.focus({ preventScroll: true });
  };
  const drag = (el, onMove, onStart) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const st = onStart ? onStart(e) : null;
      if (st === false) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('ts-dragging');
      const move = (ev) => onMove(ev, st);
      const up = () => { el.releasePointerCapture(e.pointerId); el.classList.remove('ts-dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      onMove(e, st);
    });
  };
  const svgX = (svg, e) => e.clientX - svg.getBoundingClientRect().left;
  const svgY = (svg, e) => e.clientY - svg.getBoundingClientRect().top;

  // ---------------- ratio strip drawing ----------------
  let rGeom = null;
  function drawRatio() {
    const W = Math.max(280, ratioSvg.clientWidth || ratioBox.clientWidth - 20), H = 80;
    ratioSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); ratioSvg.setAttribute('height', H);
    const L = 14, R = 14, axisY = 46;
    const X = (r) => L + ((Math.log(r) - Math.log(R_LO)) / (Math.log(R_HI) - Math.log(R_LO))) * (W - L - R);
    const Rof = (x) => Math.exp(Math.log(R_LO) + ((x - L) / (W - L - R)) * (Math.log(R_HI) - Math.log(R_LO)));
    rGeom = { X, Rof };
    const sc = res.scale;
    const single = (X(1.25) - X(1.2)) > 78;
    const full = single || (X(1.333) - X(1.2)) > 92;
    if (!full) { ratioSvg.setAttribute('viewBox', `0 0 ${W} ${H + 12}`); ratioSvg.setAttribute('height', H + 12); }
    const g = [];
    // Equal-tempered semitones as a faint keyboard behind the named intervals.
    for (let k = 1; k <= 9; k++) { const x = X(2 ** (k / 12)); g.push(sv('line', { x1: x, x2: x, y1: axisY - 5, y2: axisY + 5, class: 'ts-semi' })); }
    g.push(sv('line', { x1: L, x2: W - R, y1: axisY, y2: axisY, class: 'ts-axis-line' }));
    const cur = [sc.ratio, sc.fluid ? sc.ratioMax : null];
    for (const iv of INTERVALS) {
      const x = X(iv.r);
      const on = cur.some((c) => c != null && Math.abs(c - iv.r) < 0.0005);
      const tick = sv('g', { class: `ts-iv${on ? ' ts-on' : ''}`, tabindex: '0', role: 'button', 'data-focus': `iv-${iv.key}`,
        'aria-label': `${iv.name}, ratio ${iv.r}`, 'data-r': iv.r });
      tick.append(sv('title', {}, `${iv.name} ${iv.r}`));
      tick.append(sv('rect', { x: x - 18, y: 4, width: 36, height: H - 8, class: 'ts-iv-hit' }));
      tick.append(sv('line', { x1: x, x2: x, y1: axisY - 10, y2: axisY + 10, class: 'ts-iv-tick' }));
      const k = INTERVALS.indexOf(iv);
      tick.append(sv('text', { x, y: single || !full ? 26 : k % 2 ? 26 : 12, 'text-anchor': 'middle', class: 'ts-iv-name' }, full ? iv.name : iv.short));
      tick.append(sv('text', { x, y: axisY + (full || k % 2 === 0 ? 22 : 34), 'text-anchor': 'middle', class: 'ts-iv-r' }, String(iv.r)));
      tick.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRatio(activeThumb, iv.r); } });
      g.push(tick);
    }
    const thumb = (which, r, cls, label) => {
      const x = X(clamp(r, R_LO, R_HI));
      const t = sv('g', { class: `ts-thumb ${cls}`, tabindex: '0', role: 'slider', 'data-focus': `thumb-${which}`,
        'aria-label': label, 'aria-valuemin': '1.01', 'aria-valuemax': '3', 'aria-valuenow': String(r) });
      const up = which === 'min';
      t.append(sv('path', { d: up ? `M${x},${axisY - 3} l-6,-9 h12 z` : `M${x},${axisY + 3} l-6,9 h12 z` }));
      t.append(sv('circle', { cx: x, cy: axisY, r: 5 }));
      if (r > R_HI || r < R_LO) t.append(sv('text', { x: x + (r > R_HI ? -10 : 10), y: axisY - 12, 'text-anchor': r > R_HI ? 'end' : 'start', class: 'ts-iv-r' }, `${r} ›`));
      t.addEventListener('keydown', (e) => {
        let nr = null;
        if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowUp')) nr = r + 0.005;
        else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowDown')) nr = r - 0.005;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nr = (INTERVALS.find((iv) => iv.r > r + 0.0005) || INTERVALS[7]).r;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nr = ([...INTERVALS].reverse().find((iv) => iv.r < r - 0.0005) || INTERVALS[0]).r;
        if (nr != null) { e.preventDefault(); activeThumb = which; setRatio(which, Math.max(1.01, nr)); }
      });
      t.addEventListener('focus', () => { activeThumb = which; });
      return t;
    };
    if (sc.fluid) g.push(thumb('max', sc.ratioMax, 'ts-thumb-max', `Ratio at ${sc.vwMax} px viewport`));
    g.push(thumb('min', sc.ratio, 'ts-thumb-min', sc.fluid ? `Ratio at ${sc.vwMin} px viewport` : 'Ratio'));
    ratioSvg.replaceChildren(...g);
  }
  drag(ratioSvg, (e, st) => {
    if (!rGeom || !st) return;
    if (Math.abs(e.clientX - st.x0) > 3) st.moved = true;
    if (st.iv && !st.moved) return setRatio(st.which, st.iv);
    let r = rGeom.Rof(svgX(ratioSvg, e));
    // Snap to a named interval within 6 px of it.
    for (const iv of INTERVALS) if (Math.abs(rGeom.X(iv.r) - rGeom.X(r)) < 6) r = iv.r;
    setRatio(st.which, clamp(r, 1.01, R_HI));
  }, (e) => {
    if (!rGeom || !res?.scale) return false;
    const x = svgX(ratioSvg, e), sc = res.scale;
    let which = activeThumb;
    if (sc.fluid) {
      const dMin = Math.abs(rGeom.X(sc.ratio) - x), dMax = Math.abs(rGeom.X(sc.ratioMax) - x);
      which = Math.abs(dMin - dMax) < 3 ? activeThumb : dMin < dMax ? 'min' : 'max';
    } else which = 'min';
    activeThumb = which;
    const iv = e.target.closest?.('.ts-iv');
    return { which, x0: e.clientX, iv: iv ? Number(iv.dataset.r) : null, moved: false };
  });

  // ---------------- viewport chart drawing ----------------
  let vGeom = null;
  function drawVp() {
    const sc = res.scale;
    const W = Math.max(280, vpSvg.clientWidth || vpBox.clientWidth - 20), H = 168;
    vpSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); vpSvg.setAttribute('height', H);
    const L = 40, R = 64, T = 18, B = 26;
    const xa = Math.max(0, Math.min(320, sc.vwMin - 40)), xb = sc.vwMax + Math.max(120, (sc.vwMax - sc.vwMin) * 0.15);
    const all = steps().flatMap((s) => [s.min, s.max]);
    const ylo = Math.min(8.5, Math.min(...all) * 0.9), yhi = Math.max(...all) * 1.12;
    const X = (w) => L + ((w - xa) / (xb - xa)) * (W - L - R);
    const Wof = (x) => xa + ((x - L) / (W - L - R)) * (xb - xa);
    const Y = (v) => T + (1 - (Math.log(v) - Math.log(ylo)) / (Math.log(yhi) - Math.log(ylo))) * (H - T - B);
    vGeom = { X, Wof, xa, xb };
    const w = clamp(curW(), xa, xb);
    const g = [];
    // The fluid range between the two viewports.
    g.push(sv('rect', { x: X(sc.vwMin), y: T, width: X(sc.vwMax) - X(sc.vwMin), height: H - T - B, class: 'ts-range' }));
    // Readability limit: below 12 px as a shaded band.
    const y12 = Y(sc.limits.text);
    if (y12 < H - B) {
      g.push(sv('rect', { x: L, y: y12, width: W - L - R, height: H - B - y12, class: 'ts-lowband' }));
      g.push(sv('text', { x: L + 4, y: Math.min(H - B - 3, y12 + 11), class: 'ts-lowtxt' }, `below ${sc.limits.text} px: too small to read`));
    }
    for (const v of [12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512].filter((v) => v > ylo && v < yhi)) {
      g.push(sv('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'ts-gl' }));
      g.push(sv('text', { x: L - 5, y: Y(v) + 3, 'text-anchor': 'end', class: 'ts-ax' }, String(v)));
    }
    g.push(sv('text', { x: 4, y: 10, class: 'ts-ax' }, 'px'));
    // A curve's label names the step as the specimen does: body and small
    // first (step 0 and -1 also carry any headings CSS maps down to them).
    const chartLabel = (s) => (s.roles.includes('body') ? 'body' : s.roles.includes('small') ? 'small' : s.roles[0] || s.name);
    for (const s of steps()) {
      const cls = `ts-curve${s.n === 0 ? ' ts-curve-body' : ''}${s.flags.length ? ' ts-curve-bad' : ''}`;
      g.push(sv('path', { d: `M${X(xa)},${Y(s.min)}H${X(sc.vwMin)}L${X(sc.vwMax)},${Y(s.max)}H${X(xb)}`, class: cls, 'data-n': s.n }));
      g.push(sv('text', { x: W - R + 6, y: Y(s.max) + 3, class: `ts-clabel${s.n === 0 ? ' ts-clabel-body' : ''}` }, chartLabel(s)));
    }
    // Min / max viewport handles.
    for (const [key, v] of [['vwMin', sc.vwMin], ['vwMax', sc.vwMax]]) {
      const x = X(v);
      const hd = sv('g', { class: 'ts-vwh', tabindex: '0', role: 'slider', 'data-focus': key, 'aria-label': key === 'vwMin' ? 'Small viewport' : 'Large viewport',
        'aria-valuenow': String(v) });
      hd.append(sv('line', { x1: x, x2: x, y1: T, y2: H - B, class: 'ts-vwline' }));
      hd.append(sv('rect', { x: x - 22, y: H - B + 3, width: 44, height: 16, rx: 3, class: 'ts-vwtab' }));
      hd.append(sv('text', { x, y: H - B + 15, 'text-anchor': 'middle', class: 'ts-vwtxt' }, String(v)));
      hd.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return; e.preventDefault();
        const nv = v + d * (e.shiftKey ? 100 : 10);
        if (key === 'vwMin' ? nv >= 200 && nv < sc.vwMax - 40 : nv > sc.vwMin + 40 && nv <= 3840) ctx.set(key, String(nv));
      });
      g.push(hd);
    }
    // The width cursor, with each step's size where it crosses.
    const cx = X(w);
    const cur = sv('g', { class: 'ts-cursor', tabindex: '0', role: 'slider', 'data-focus': 'cursor', 'aria-label': 'Viewport width shown',
      'aria-valuenow': String(Math.round(w)), 'aria-valuemin': String(Math.round(xa)), 'aria-valuemax': String(Math.round(xb)) });
    cur.append(sv('line', { x1: cx, x2: cx, y1: T - 4, y2: H - B, class: 'ts-curline' }));
    for (const s of steps()) cur.append(sv('circle', { cx, cy: Y(sizeAt(s, w)), r: s.n === 0 ? 4 : 3, class: s.n === 0 ? 'ts-dot ts-dot-body' : 'ts-dot' }));
    const lbl = `${Math.round(w)} px`;
    cur.append(sv('rect', { x: cx - 28, y: 0, width: 56, height: 15, rx: 3, class: 'ts-curtab' }));
    cur.append(sv('text', { x: cx, y: 11, 'text-anchor': 'middle', class: 'ts-curtxt' }, lbl));
    cur.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (e.key === 'Home') { width = sc.vwMin; e.preventDefault(); return render(); }
      if (e.key === 'End') { width = sc.vwMax; e.preventDefault(); return render(); }
      if (!d) return; e.preventDefault();
      width = clamp(Math.round(w + d * (e.shiftKey ? 100 : 10)), Math.round(xa), Math.round(xb)); render();
    });
    g.push(cur);
    vpSvg.replaceChildren(...g);
    vpNote.textContent = `sizes grow linearly from ${sc.vwMin} to ${sc.vwMax} px wide, then stop · drag the cursor to view the specimen at any width`;
  }
  drag(vpSvg, (e, st) => {
    if (!vGeom || !st) return;
    const sc = res.scale;
    const v = Math.round(clamp(vGeom.Wof(svgX(vpSvg, e)), vGeom.xa, vGeom.xb) / 10) * 10;
    if (st.what === 'cursor') { width = clamp(Math.round(vGeom.Wof(svgX(vpSvg, e))), Math.round(vGeom.xa), Math.round(vGeom.xb)); render(); }
    else if (st.what === 'vwMin' && v >= 200 && v < sc.vwMax - 40 && v !== sc.vwMin) ctx.set('vwMin', String(v));
    else if (st.what === 'vwMax' && v > sc.vwMin + 40 && v <= 3840 && v !== sc.vwMax) ctx.set('vwMax', String(v));
  }, (e) => {
    if (!vGeom || !res?.scale) return false;
    const x = svgX(vpSvg, e), y = svgY(vpSvg, e), sc = res.scale;
    const H = vpSvg.clientHeight;
    const nearMin = Math.abs(vGeom.X(sc.vwMin) - x), nearMax = Math.abs(vGeom.X(sc.vwMax) - x);
    const onTabs = y > H - 30;
    if (onTabs || Math.min(nearMin, nearMax) < 5) {
      if (nearMin < 26 && nearMin <= nearMax) return { what: 'vwMin' };
      if (nearMax < 26) return { what: 'vwMax' };
    }
    return { what: 'cursor' };
  });

  // ---------------- specimen drawing ----------------
  const MAX_ROW = 220;
  function drawLadder() {
    const sc = res.scale;
    const w = sc.fluid ? curW() : null;
    const rows = steps().map((s) => {
      const px = sizeAt(s, w);
      const lhPx = px * s.lh;
      const body = s.n === 0;
      const bad = s.flags.includes('below-12') || s.flags.includes('body-below-16');
      const grows = s.flags.includes('grows-over-2.5x');
      const rolesTxt = s.roles.length ? s.roles.join(' · ') : (s.n > 0 ? 'display' : s.n < 0 ? 'fine print' : 'body');
      const sampleTxt = s.n > 0 ? SAMPLE.h[(Math.max(1, Math.min(6, Number((s.roles[0] || 'h6').slice(1)) || 1))) - 1] : body ? SAMPLE.body : SAMPLE.small;
      const meta = h('div', { class: 'ts-meta' },
        h('div', { class: 'ts-role' }, rolesTxt, h('span', { class: 'ts-stepn' }, `step ${s.n}`)),
        h('code', { class: 'ts-var', title: s.css }, s.var));
      const nums = h('div', { class: 'ts-nums' },
        h('div', { class: 'ts-size' }, h('b', {}, `${F(px)} px`), h('span', {}, ` ${F(px / sc.rem)} rem`)),
        sc.fluid ? h('div', { class: 'ts-range-txt' }, `${F(s.min)} → ${F(s.max)}`) : null,
        h('div', { class: 'ts-lh' }, `lh ${F(s.lh, 3)} · ${F(lhPx, 3)} px`));
      const cropped = lhPx > MAX_ROW;
      // Headings may wrap to a second line at their true line height (two
      // lines while they fit in MAX_ROW); the body stays one line for its grip.
      const lines = body ? 1 : 2 * lhPx <= MAX_ROW ? 2 : 1;
      const line = h('div', { class: `ts-line${lines > 1 ? ' ts-wrap' : ''}`,
        style: `font-size:${px}px;line-height:${s.lh};${lines > 1 ? `max-height:${2 * lhPx}px` : `height:${Math.min(lhPx, MAX_ROW)}px`}`,
        'data-n': s.n }, sampleTxt);
      const lineWrap = h('div', { class: `ts-linebox${cropped ? ' ts-cropped' : ''}` }, line);
      const flagsEl = [];
      if (s.flags.includes('below-12')) flagsEl.push(h('div', { class: 'ts-flag ts-bad' }, `${F(Math.min(s.min, s.max), 3)} px — below ${sc.limits.text} px, too small for text people must read`));
      if (s.flags.includes('body-below-16')) flagsEl.push(h('div', { class: 'ts-flag ts-warn' }, `Body below ${sc.limits.body} px — hard to read on phones`));
      if (grows) flagsEl.push(h('div', { class: 'ts-flag ts-warn' }, `Grows ${F(s.max / s.min, 3)}× between the viewports — text zoom may not reach 200 %`));
      if (cropped) flagsEl.push(h('div', { class: 'ts-flag' }, `Line box ${F(lhPx, 3)} px tall, shown cropped`));
      const spec = h('div', { class: 'ts-specwrap' }, lineWrap, ...flagsEl);
      const row = h('div', { class: `ts-row${body ? ' ts-body' : ''}${bad ? ' ts-row-bad' : grows ? ' ts-row-warn' : ''}`, 'data-n': s.n }, meta, spec, nums);
      if (body) {
        const target = sc.fluid && Math.abs(w - sc.vwMax) < Math.abs(w - sc.vwMin) ? 'baseMax' : 'base';
        const cur = target === 'baseMax' ? sc.baseMax : sc.base;
        const at = sc.fluid ? ` at ${target === 'baseMax' ? sc.vwMax : sc.vwMin} px` : '';
        const grip = h('div', { class: 'ts-grip', tabindex: '0', role: 'slider', 'data-focus': 'grip', 'aria-label': `Body size${at}, px`,
          'aria-valuenow': String(cur), 'aria-valuemin': '8', 'aria-valuemax': '40', title: `Drag up or down to set the body size${at}` },
        h('span', { class: 'ts-grip-bars', 'aria-hidden': 'true' }), h('span', { class: 'ts-grip-txt' }, `${F(cur)} px${at}`));
        grip.addEventListener('keydown', (e) => {
          const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return; e.preventDefault();
          ctx.set(target, String(clamp(Math.round((cur + d * (e.shiftKey ? 0.25 : 1)) * 100) / 100, 8, 40)));
        });
        lineWrap.append(grip);
        row.dataset.target = target;
      }
      return row;
    });
    keepFocus(() => ladder.replaceChildren(...rows));
    specNote.textContent = sc.fluid
      ? `set at ${Math.round(curW())} px viewport width · drag the body line to resize the base`
      : `each step ×${F(sc.ratio)} · drag the body line to resize the base`;
  }
  // Dragging the body line: the ladder is persistent, the rows are redrawn.
  drag(ladder, (e, st) => {
    if (!st) return;
    const d = ((e.clientX - st.x) - (e.clientY - st.y)) / 8;
    const v = clamp(Math.round((st.v + d) * 4) / 4, 8, 40);
    if (v !== st.last) { st.last = v; ctx.set(st.target, String(v)); }
  }, (e) => {
    const row = e.target.closest('.ts-body');
    if (!row || !(e.target.closest('.ts-linebox'))) return false;
    const target = row.dataset.target || 'base';
    const sc = res.scale;
    return { x: e.clientX, y: e.clientY, target, v: target === 'baseMax' ? sc.baseMax : sc.base, last: null };
  });
  ladder.addEventListener('pointerover', (e) => hover(e.target.closest('[data-n]')?.dataset.n));
  ladder.addEventListener('pointerleave', () => hover(null));
  const hover = (n) => {
    for (const el of root.querySelectorAll('.ts-hot')) el.classList.remove('ts-hot');
    if (n == null) return;
    for (const el of root.querySelectorAll(`[data-n="${n}"]`)) if (!el.classList.contains('ts-line')) el.classList.add('ts-hot');
  };

  // ---------------- in use ----------------
  function drawSample() {
    const sc = res.scale;
    const w = sc.fluid ? curW() : null;
    const role = (r) => steps().find((s) => s.roles.includes(r));
    const el = (tag, r, text) => {
      const s = role(r) || role('body');
      if (!s) return null;
      const px = sizeAt(s, w);
      return h(tag, { style: `font-size:${px}px;line-height:${s.lh}`, 'data-n': s.n, title: `${s.var}: ${F(px)} px` }, text);
    };
    sample.replaceChildren(
      el('h1', 'h1', 'Choosing a type scale'),
      el('p', 'small', 'Design notes · 4 min read'),
      el('p', 'body', 'A modular scale multiplies one body size by the same ratio at every step, so headings relate to the text the way intervals relate in music. Small ratios keep dense interfaces calm; large ones make pages with few headings dramatic.'),
      el('h2', 'h2', 'Why ratios work'),
      el('p', 'body', 'Each level is visibly larger than the next, yet all belong to one family.'),
      el('h3', 'h3', 'In practice'),
      el('p', 'body', 'Pick the body size first, then the ratio, then trim the steps you do not use.'),
      el('h4', 'h4', 'Line height'),
      el('p', 'small', 'Body text at 1.5, headings about 1.2 on a 4 px grid.'));
    sampleNote.textContent = sc.fluid ? `at ${Math.round(curW())} px wide` : 'headings, body and small text';
  }

  // ---------------- sync ----------------
  function syncBar() {
    const raw = ctx.raw;
    const put = (el, v) => { if (document.activeElement !== el) el.value = v ?? ''; };
    put(fBase, raw.base); put(fBaseMax, raw.baseMax); put(fVwMin, raw.vwMin); put(fVwMax, raw.vwMax); put(fPrefix, raw.prefix);
    const sc = res?.scale;
    put(fRatio, sc ? String(sc.ratio) : (raw.ratio === 'custom' ? raw.custom : raw.ratio));
    put(fRatioMax, sc ? String(sc.ratioMax) : raw.customMax);
    const nm = (r) => INTERVALS.find((iv) => Math.abs(iv.r - r) < 0.0005)?.name || 'custom';
    ratioName.textContent = sc ? nm(sc.ratio) : '';
    ratioNameMax.textContent = sc ? (inp.ratioMax === 'same' ? 'same as small' : nm(sc.ratioMax)) : '';
    selNames.value = raw.naming; chkRound.checked = !!raw.rounding;
    for (const b of bar.querySelectorAll('[data-seg]')) b.setAttribute('aria-pressed', String(String(raw[b.dataset.seg]) === b.dataset.v));
    for (const o of bar.querySelectorAll('[data-out]')) o.textContent = String(raw[o.dataset.out]);
    for (const el of fluidOnly) el.hidden = !raw.fluid;
    root.classList.toggle('ts-is-fluid', !!raw.fluid);
  }

  function render() {
    syncBar();
    if (!res?.scale) {
      ladder.replaceChildren(h('div', { class: 'ts-empty' }, (res?.warnings || ['No scale.']).join(' ')));
      ratioSvg.replaceChildren(); vpSvg.replaceChildren(); sample.replaceChildren();
    } else {
      keepFocus(() => { drawRatio(); if (fluid()) drawVp(); });
      drawLadder();
      drawSample();
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(h('summary', {}, 'Notes and assumptions'), ...(res?.notes || []).map((n) => h('p', {}, n)));
  }

  ctx.onResult((r, input) => {
    res = r; inp = input; render();
    if (!tabChosen) { const b = [...ctx.outputs.querySelectorAll('.k-tab')].find((x) => x.textContent === 'CSS'); if (b) { tabChosen = 'CSS'; b.click(); } }
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w !== lastW && res?.scale) { lastW = w; keepFocus(() => { drawRatio(); if (fluid()) drawVp(); }); }
  }).observe(root);
}
