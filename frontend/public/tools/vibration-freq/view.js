// Vibration Frequency page: the part itself, ringing in its first mode, is the
// interface. Drag the free end (or the plate's edges) to change the span, drag
// the mass block to load it, drag the excitation marker on the frequency
// ruler; the f1-against-span curve under the part shares its length axis, so
// the safe spans read straight off it. Every number shown comes from run().

const SVGNS = 'http://www.w3.org/2000/svg';

const SUPPORTS = [
  ['cantilever', 'Cantilever', 'Beam fixed at one end, free at the other'],
  ['ss', 'Pinned–pinned', 'Beam simply supported at both ends'],
  ['fixed', 'Fixed–fixed', 'Beam clamped at both ends'],
  ['free', 'Free–free', 'Beam hanging free (on soft cords)'],
  ['plate', 'Plate / PCB', 'Plate with all four edges simply supported'],
];
const SECTIONS = [['rect', 'Rectangle'], ['round', 'Round rod'], ['tube', 'Tube']];
const SHORT = { steel: 'Steel', stainless: 'SS 304', alu: 'Al 6061', ti: 'Ti-6Al-4V', brass: 'Brass', copper: 'Copper', fr4: 'FR-4',
  cfrp: 'CFRP', pla: 'PLA', abs: 'ABS', petg: 'PETG', pa12: 'PA12', pc: 'PC' };

const pict = (k) => {
  const beam = '<rect class="pb" x="7" y="10" width="26" height="3"/>';
  const wallL = '<path class="pw" d="M3 3V21M3 5l3-2M3 9l3-2M3 13l3-2M3 17l3-2M3 21l3-2"/>';
  const wallR = '<path class="pw" d="M37 3V21M37 5l-3-2M37 9l-3-2M37 13l-3-2M37 17l-3-2M37 21l-3-2"/>';
  const pin = (x) => `<path class="pw" d="M${x} 13l-3 5h6z"/>`;
  const body = {
    cantilever: wallL + '<rect class="pb" x="3" y="10" width="30" height="3"/>',
    ss: '<rect class="pb" x="4" y="10" width="32" height="3"/>' + pin(7) + pin(33),
    fixed: wallL + wallR + '<rect class="pb" x="3" y="10" width="34" height="3"/>',
    free: '<path class="pw" d="M10 2V10M30 2V10" style="stroke-dasharray:2 1.5"/>' + beam.replace('x="7"', 'x="5"').replace('width="26"', 'width="30"'),
    plate: '<rect class="pp" x="6" y="4" width="28" height="16"/><path class="pw" d="M6 4H34V20H6Z" style="stroke-dasharray:2 2"/>',
  }[k];
  return `<svg viewBox="0 0 40 24" aria-hidden="true">${body}</svg>`;
};

// Bending mode shapes (Blevins table 8-1), for the drawing only.
const LAM_C = [1.87510, 4.69409, 7.85476], SIG_C = [0.734096, 1.018467, 0.999224];
const LAM_F = [4.73004, 7.85321, 10.99561], SIG_F = [0.982502, 1.000777, 0.999966];
function modeShape(shape, n) {
  const f = (x) => {
    if (shape === 'ss') return Math.sin((n + 1) * Math.PI * x);
    if (shape === 'cantilever') { const b = LAM_C[n] * x; return Math.cosh(b) - Math.cos(b) - SIG_C[n] * (Math.sinh(b) - Math.sin(b)); }
    const b = LAM_F[n] * x;
    if (shape === 'fixed') return Math.cosh(b) - Math.cos(b) - SIG_F[n] * (Math.sinh(b) - Math.sin(b));
    return Math.cosh(b) + Math.cos(b) - SIG_F[n] * (Math.sinh(b) + Math.sin(b)); // free-free
  };
  const N = 96, pts = [];
  for (let i = 0; i <= N; i++) pts.push(f(i / N));
  const mx = Math.max(...pts.map(Math.abs)) || 1;
  return pts.map((v) => v / mx);
}

const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const svg = (cls, label) => {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls);
  if (label) { s.setAttribute('role', 'group'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
  return s;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sig = (v, d = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const hz = (v) => (v >= 10000 ? `${sig(v / 1000, 3)} kHz` : `${sig(v, v >= 100 ? 3 : 3)} Hz`);
const niceLen = (v) => (v >= 200 ? Math.round(v / 5) * 5 : v >= 20 ? Math.round(v) : v >= 2 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const supports = el('div', { class: 'vf-sup', role: 'radiogroup', 'aria-label': 'Shape and supports' });
  for (const [k, name, title] of SUPPORTS) {
    const b = el('button', { class: 'vf-supb', role: 'radio', 'data-k': k, title, 'aria-label': title }, `${pict(k)}<span>${name}</span>`);
    b.addEventListener('click', () => ctx.set('shape', k));
    b.addEventListener('keydown', (e) => {
      const i = SUPPORTS.findIndex((x) => x[0] === k);
      const j = /Right|Down/.test(e.key) ? i + 1 : /Left|Up/.test(e.key) ? i - 1 : null;
      if (j == null) return;
      e.preventDefault();
      const nk = SUPPORTS[(j + SUPPORTS.length) % SUPPORTS.length][0];
      ctx.set('shape', nk);
      supports.querySelector(`[data-k="${nk}"]`).focus();
    });
    supports.append(b);
  }
  const secSeg = el('div', { class: 'vf-seg', role: 'group', 'aria-label': 'Beam section' },
    SECTIONS.map(([k, t]) => `<button data-s="${k}">${t}</button>`).join(''));
  secSeg.addEventListener('click', (e) => { const s = e.target.closest('[data-s]')?.dataset.s; if (s) ctx.set('section', s); });
  const animBtn = el('button', { class: 'vf-anim', 'aria-pressed': 'true', title: 'Animate the mode shape' }, 'Ringing');
  const head = el('div', { class: 'vf-head' });
  head.append(supports, secSeg, animBtn);

  const stageBox = el('div', { class: 'vf-stage-box' });
  const stage = svg('vf-stage', 'The part in elevation with its first mode shape; drag the free end to change the span and the mass block to load it');
  stageBox.append(stage);
  const hint = el('div', { class: 'vf-hint' });

  const fields = el('div', { class: 'vf-fields' });
  const F = [
    ['len', 'Span L', 'mm'], ['width', 'Width b', 'mm'], ['thick', 'Thickness t', 'mm'], ['dia', 'Outer Ø D', 'mm'], ['inner', 'Inner Ø d', 'mm'],
    ['mass', 'Added mass', 'g'], ['target', 'Excitation', 'Hz'], ['E', 'E', 'GPa'], ['rho', 'ρ', 'kg/m³'], ['nu', 'ν', ''],
  ];
  const fieldEls = {};
  for (const [key, label, unit] of F) {
    const f = el('label', { class: 'vf-f', for: `vf-${key}` });
    const inp = el('input', { id: `vf-${key}`, type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off' });
    inp.addEventListener('input', () => ctx.set(key, inp.value));
    f.append(el('span', {}, `${label}${unit ? ` <small>${unit}</small>` : ''}`), inp);
    fields.append(f);
    fieldEls[key] = { f, inp };
  }

  const stageCard = el('section', { class: 'vf-card vf-stagecard' });
  stageCard.append(head, stageBox, hint, fields);

  // frequency ruler
  const ruler = svg('vf-ruler', 'Frequency axis: the part\'s modes and the excitation; drag the excitation marker');
  const rulerCard = el('section', { class: 'vf-card vf-rulercard' });
  const rulerHead = el('div', { class: 'vf-rhead' },
    '<h2>Frequency</h2><span>Click a mode to see its shape · drag the ▼ excitation marker (or click the axis) · the band under it needs f1 ≥ 2× the forcing</span>');
  const rulerBox = el('div', { class: 'vf-ruler-box' });
  rulerBox.append(ruler);
  rulerCard.append(rulerHead, rulerBox);

  // read-out + section
  const read = el('section', { class: 'vf-card vf-read', 'aria-live': 'polite' });
  const big = el('div', { class: 'vf-big' });
  const verdict = el('div', { class: 'vf-verdict' });
  const secBox = el('div', { class: 'vf-sec-box' });
  const sec = svg('vf-sec', 'Cross-section, to scale; drag its edges');
  secBox.append(sec);
  const dl = el('dl', { class: 'vf-dl' });
  const warns = el('div', { class: 'vf-warns', role: 'status' });
  read.append(big, verdict, warns, secBox, dl);

  // material ladder
  const ladHead = el('div', { class: 'vf-ladhead' }, '<b>Material</b><span>f1 of this same part in each · click to use</span>');
  const ladder = el('div', { class: 'vf-ladder', role: 'radiogroup', 'aria-label': 'Material' });
  read.append(ladHead, ladder);

  const notes = el('details', { class: 'vf-notes' });
  const outCol = el('div', { class: 'vf-outcol' });
  outCol.append(ctx.outputs, notes);

  const grid = el('div', { class: 'vf' });
  const left = el('div', { class: 'vf-left' });
  left.append(stageCard, rulerCard);
  grid.append(left, read, outCol);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null;          // active drag {key, ...}
  let frozen = null;        // stage scale frozen while dragging
  let modeIx = 0;           // which mode the stage shows
  let beamGeo = null;       // for the animation: {x0, s, y, shapePts, amp}
  let pending = null;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let animate = !reduce;
  animBtn.setAttribute('aria-pressed', String(animate));
  animBtn.addEventListener('click', () => { animate = !animate; animBtn.setAttribute('aria-pressed', String(animate)); if (!animate) paintMode(1); });

  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }

  const V = () => ctx.result?.view || null;
  const isPlate = () => ctx.input.shape === 'plate';
  const tone = (f1, t) => (!(t > 0) ? '' : f1 >= 2 * t ? 'ok' : f1 >= Math.SQRT2 * t ? 'warn' : 'bad');

  // ---------------- chrome (buttons, fields) ----------------
  function syncChrome() {
    const inp = ctx.input, raw = ctx.raw;
    for (const b of supports.querySelectorAll('[data-k]')) b.setAttribute('aria-checked', String(b.dataset.k === inp.shape));
    secSeg.hidden = isPlate();
    for (const b of secSeg.querySelectorAll('[data-s]')) b.setAttribute('aria-pressed', String(b.dataset.s === inp.section));
    const sec = inp.section;
    const show = {
      len: true, width: isPlate() || sec === 'rect', thick: isPlate() || sec === 'rect', dia: !isPlate() && sec !== 'rect',
      inner: !isPlate() && sec === 'tube', mass: true, target: true, E: inp.material === 'custom', rho: inp.material === 'custom', nu: inp.material === 'custom',
    };
    for (const [key, { f, inp: i }] of Object.entries(fieldEls)) {
      f.hidden = !show[key];
      if (document.activeElement !== i) i.value = raw[key] ?? '';
      const bad = String(raw[key] ?? '').trim() !== '' && ctx.parseEng(raw[key]) == null;
      i.classList.toggle('bad', bad);
    }
    fieldEls.len.f.querySelector('span').innerHTML = `${isPlate() ? 'Long side a' : 'Span L'} <small>mm</small>`;
    fieldEls.width.f.querySelector('span').innerHTML = `${isPlate() ? 'Short side b' : 'Width b'} <small>mm</small>`;
    fieldEls.mass.f.querySelector('span').innerHTML = `${isPlate() ? 'Parts on it' : 'Added mass'} <small>g</small>`;
    hint.textContent = isPlate()
      ? 'Drag the right or bottom edge to size the plate · the component block to load it · arrow keys on a focused handle'
      : 'Drag the free end to change the span · the mass block to load it · arrow keys on a focused handle (Shift = bigger steps)';
  }

  // ---------------- stage ----------------
  function stageSize() {
    return { W: Math.max(300, stageBox.clientWidth), H: Math.max(260, stageBox.clientHeight) };
  }

  // A focusable handle.
  const H = (key, label, now, inner, extra = '') =>
    `<g class="vf-h" data-h="${key}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuenow="${esc(now)}" aria-valuetext="${esc(`${label} ${now}`)}" ${extra}>${inner}</g>`;

  function drawStage() {
    const v = V(), inp = ctx.input, raw = ctx.raw;
    const { W, H: Hh } = stageSize();
    stage.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!v) { stage.innerHTML = `<text x="${W / 2}" y="${Hh / 2}" text-anchor="middle" class="vf-empty">${esc(ctx.result?.warnings?.[0] || 'Enter the part\'s size.')}</text>`; beamGeo = null; return; }
    const plate = isPlate();
    const narrow = W < 560;
    const mL = narrow ? 44 : 64, mR = narrow ? 16 : 40;
    const Lmax = frozen?.Lmax ?? Math.max(...v.sweep.x);
    const topH = Math.round(Hh * (plate ? 0.56 : 0.5));        // part zone
    const plotT = topH + 18, plotB = Hh - 26;                   // curve zone
    let s = (W - mL - mR) / Lmax;                               // px per mm, shared by part and curve
    const out = [];
    const x0 = mL;
    const L = inp.len;
    const xE = x0 + L * s;

    // ---- the curve f1(L) below, same length axis ----
    const xs = v.sweep.x, ys = v.sweep.y;
    const tgt = v.target;
    let fLo = Math.min(...ys, v.f1), fHi = Math.max(...ys, v.f1);
    if (tgt > 0) { fLo = Math.min(fLo, tgt * 0.8); fHi = Math.max(fHi, 2.4 * tgt); }
    if (frozen?.fLo) { fLo = frozen.fLo; fHi = frozen.fHi; }
    const lf0 = Math.log10(fLo / 1.25), lf1 = Math.log10(fHi * 1.25);
    const Y = (f) => plotB - ((Math.log10(f) - lf0) / (lf1 - lf0)) * (plotB - plotT);
    const X = (mm) => x0 + mm * s;
    // grid: decades and 2, 5
    for (let d = Math.floor(lf0); d <= Math.ceil(lf1); d++) {
      for (const m of [1, 2, 5]) {
        const f = m * 10 ** d, y = Y(f);
        if (y < plotT - 1 || y > plotB + 1) continue;
        out.push(`<line class="gr${m === 1 ? ' g1' : ''}" x1="${x0}" x2="${W - mR}" y1="${y}" y2="${y}"/><text class="ax" x="${x0 - 6}" y="${y + 3.5}" text-anchor="end">${hz(f).replace(' Hz', '')}</text>`);
      }
    }
    out.push(`<text class="ax" x="${x0 - 6}" y="${plotT - 6}" text-anchor="end">Hz</text>`);
    // excitation zones as bands: f1 below √2·fe resonates, below 2·fe lacks the octave
    if (tgt > 0) {
      const y2 = clamp(Y(2 * tgt), plotT, plotB), yr = clamp(Y(Math.SQRT2 * tgt), plotT, plotB), yt = clamp(Y(tgt), plotT, plotB);
      out.push(`<rect class="z-warn" x="${x0}" y="${y2}" width="${W - mR - x0}" height="${Math.max(0, yr - y2)}"/>`);
      out.push(`<rect class="z-bad" x="${x0}" y="${yr}" width="${W - mR - x0}" height="${Math.max(0, plotB - yr)}"/>`);
      out.push(`<line class="tl" x1="${x0}" x2="${W - mR}" y1="${yt}" y2="${yt}"/>`);
      out.push(`<text class="zl" x="${W - mR - 4}" y="${y2 - 4}" text-anchor="end">2 × ${hz(tgt)} = ${hz(2 * tgt)}</text>`);
      if (yt - yr > 12 || yt >= plotB - 2) out.push(`<text class="zl zb" x="${W - mR - 4}" y="${Math.min(yr + 13, plotB - 4)}" text-anchor="end">resonance zone · under √2 × ${hz(tgt)}</text>`);
      // the longest safe span, from run()
      const sp = v.spanFor;
      if (sp && sp.twice > 0 && X(sp.twice) <= W - mR) {
        const xs2 = X(sp.twice);
        out.push(`<line class="spl" x1="${xs2}" x2="${xs2}" y1="${plotT - 4}" y2="${plotB}"/>`);
        out.push(`<text class="spt halo" x="${xs2 + 4}" y="${plotT + 24}">${plate ? 'a' : 'L'} ≤ ${sig(sp.twice, 3)} mm for 2×</text>`);
      }
    }
    // curve: log-log interpolation between the run() points
    let d = '';
    for (let i = 0; i < xs.length - 1; i++) {
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const xm = Math.exp(Math.log(xs[i]) * (1 - t) + Math.log(xs[i + 1]) * t);
        const fm = Math.exp(Math.log(ys[i]) + (Math.log(ys[i + 1]) - Math.log(ys[i])) * (Math.log(xm / xs[i]) / Math.log(xs[i + 1] / xs[i])));
        const px = X(xm);
        if (px > W - mR + 0.5) break;
        d += `${d ? 'L' : 'M'}${px.toFixed(1)},${Y(fm).toFixed(1)}`;
      }
    }
    out.push(`<path class="cv" d="${d}"/>`);
    for (let i = 0; i < xs.length; i++) if (X(xs[i]) <= W - mR) out.push(`<circle class="cvp" cx="${X(xs[i])}" cy="${Y(ys[i])}" r="2"/>`);
    // x axis: mm, under the curve
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((q) => q * s >= (narrow ? 44 : 60)) || 10000;
    for (let m = 0; m <= Lmax + 1e-9; m += step) {
      const x = X(m);
      out.push(`<line class="tick" x1="${x}" x2="${x}" y1="${plotB}" y2="${plotB + 4}"/><text class="ax" x="${x}" y="${plotB + 15}" text-anchor="middle">${sig(m, 4)}</text>`);
    }
    out.push(`<line class="axl" x1="${x0}" x2="${W - mR}" y1="${plotB}" y2="${plotB}"/>`);
    if (!narrow) out.push(`<text class="ax" x="${W - mR}" y="${plotB + 15}" text-anchor="end" dx="30">mm</text>`);
    else out.push(`<text class="ax" x="${x0 - 6}" y="${plotB + 15}" text-anchor="end">mm</text>`);
    out.push(`<text class="cap" x="${x0 + 6}" y="${plotT + 8}">f1 if the ${plate ? 'long side a' : 'span'} were …</text>`);
    // the present point
    const yP = Y(v.f1), tn = tone(v.f1, tgt);
    out.push(`<line class="now" x1="${xE}" x2="${xE}" y1="${plotT - 16}" y2="${plotB}"/>`);
    out.push(`<circle class="nowp ${tn}" cx="${xE}" cy="${yP}" r="5"/>`);
    const lbl = `${hz(v.f1)} at ${sig(L, 4)} mm`;
    const right = xE + 10 + lbl.length * 7 < W - mR;
    out.push(`<text class="nowt halo ${tn}" x="${right ? xE + 10 : xE - 10}" y="${yP - 8}" text-anchor="${right ? 'start' : 'end'}">${lbl}</text>`);

    // ---- the part ----
    const midY = Math.round(topH * (plate ? 0.5 : 0.52)) + 6;
    let partInner = '', warnAt = null;
    beamGeo = null;
    if (!plate) {
      const tMm = inp.section === 'rect' ? inp.thick : inp.dia;
      const tTrue = tMm * s;
      const tPx = clamp(tTrue, 5, 22);
      const exag = tPx / tTrue;
      const amp = Math.min(topH * 0.3, 46);
      const shape = inp.shape;
      const pts = modeShape(shape, modeIx);
      // supports
      const wallH = Math.max(60, tPx + 44);
      const wall = (x, dir) => {
        let p = `M${x} ${midY - wallH / 2}V${midY + wallH / 2}`;
        for (let yy = midY - wallH / 2 + 4; yy <= midY + wallH / 2; yy += 8) p += `M${x} ${yy}l${-dir * 8} ${8}`;
        return `<path class="wall" d="${p}"/>`;
      };
      const pinAt = (x, roller) => `<path class="sup" d="M${x} ${midY + tPx / 2}l-9 15h18z"/>${roller ? `<circle class="sup" cx="${x - 5}" cy="${midY + tPx / 2 + 19}" r="3"/><circle class="sup" cx="${x + 5}" cy="${midY + tPx / 2 + 19}" r="3"/>` : ''}<path class="gnd" d="M${x - 14} ${midY + tPx / 2 + (roller ? 23 : 16)}h28"/>`;
      if (shape === 'cantilever') partInner += wall(x0, 1);
      if (shape === 'fixed') partInner += wall(x0, 1) + wall(xE, -1);
      if (shape === 'ss') partInner += pinAt(x0, false) + pinAt(xE, true);
      if (shape === 'free') partInner += `<path class="cord" d="M${x0 + 0.224 * L * s} ${midY - tPx / 2}V${16}M${x0 + 0.776 * L * s} ${midY - tPx / 2}V16"/><path class="gnd" d="M${x0} 14H${xE}"/>`;
      // envelope (static) + the moving beam
      const env = (sgn) => pts.map((p, i) => `${i ? 'L' : 'M'}${(x0 + (i / (pts.length - 1)) * L * s).toFixed(1)},${(midY - sgn * p * amp).toFixed(1)}`).join('');
      partInner += `<path class="env" d="${env(1)}"/><path class="env" d="${env(-1)}"/>`;
      partInner += `<path class="rest" d="M${x0} ${midY}H${xE}"/>`;
      // nodes of the shown mode
      for (let i = 1; i < pts.length; i++) {
        if (pts[i - 1] * pts[i] < 0 && i > 2 && i < pts.length - 2) {
          const xn = x0 + ((i - 0.5) / (pts.length - 1)) * L * s;
          partInner += `<circle class="node" cx="${xn}" cy="${midY}" r="3.5"/>`;
        }
      }
      partInner += '<path class="beam" id="vfd-beam"/>';
      // mass block
      const withMass = inp.mass > 0 && shape !== 'free';
      const mx = shape === 'cantilever' ? xE : (x0 + xE) / 2;
      const mIx = shape === 'cantilever' ? pts.length - 1 : Math.round((pts.length - 1) / 2);
      const mSize = clamp(10 + Math.sqrt(Math.max(0, inp.mass)) * 2.2, 12, 40);
      beamGeo = { x0, s, L, y: midY, pts, amp, tPx, mx, mIx, mSize, withMass };
      partInner += `<g id="vfd-mass">${withMass ? `<rect class="mass" x="${mx - mSize / 2}" y="${midY - tPx / 2 - mSize}" width="${mSize}" height="${mSize}" rx="2"/>` : ''}</g>`;
      // dimension: L below the part
      const yD = midY + Math.max(amp, tPx / 2 + 26) + 12;
      partInner += `<path class="ext" d="M${x0} ${midY + tPx / 2 + 4}V${yD + 5}M${xE} ${midY + tPx / 2 + 4}V${yD + 5}"/>`;
      partInner += `<path class="dim" d="M${x0} ${yD}H${xE}M${x0} ${yD - 4}V${yD + 4}M${xE} ${yD - 4}V${yD + 4}"/>`;
      partInner += `<text class="dimt halo" x="${(x0 + xE) / 2}" y="${yD - 5}" text-anchor="middle">L ${esc(raw.len)} mm</text>`;
      warnAt = { x: (x0 + xE) / 2 + 52, y: yD - 9 };
      // thickness callout at the free end
      const tl = inp.section === 'rect' ? `t ${raw.thick}` : `Ø ${raw.dia}`;
      partInner += `<text class="dimt halo" x="${xE + (shape === 'fixed' ? 16 : 14)}" y="${midY + tPx / 2 + 16}">${esc(tl)} mm${exag > 1.5 ? `<tspan class="ex" x="${xE + (shape === 'fixed' ? 16 : 14)}" dy="13">depth drawn ×${sig(exag, 2)}</tspan>` : ''}</text>`;
      // where the end can go: the rail to the end of the length axis
      if (shape !== 'fixed') partInner += `<path class="rail" d="M${xE + 12} ${midY}H${W - mR}"/>${narrow ? '' : `<text class="railt" x="${W - mR}" y="${midY - 6}" text-anchor="end">drag the end · up to ${sig(Lmax, 3)} mm</text>`}`;
      // mass label + handle
      const mLabel = inp.mass > 0 ? (shape === 'free' ? `${raw.mass} g ignored (free-free)` : `${raw.mass} g at the ${v.at}`) : '+ mass';
      const mhY = midY - tPx / 2 - mSize - 12;
      partInner += H('mass', 'Added mass in grams', raw.mass,
        `<rect class="hit" x="${mx - 30}" y="${mhY - 14}" width="60" height="${mSize + 30}"/><rect class="ring" x="${mx - mSize / 2 - 4}" y="${midY - tPx / 2 - mSize - 4}" width="${mSize + 8}" height="${mSize + 8}" rx="3"/><path class="grip" d="M${mx - 6} ${mhY - 4}l6 -6 6 6M${mx - 6} ${mhY + 4}l6 6 6 -6" transform="translate(0 ${-4})"/><text class="ml halo" x="${mx}" y="${mhY - 16}" text-anchor="${shape === 'cantilever' && mx > W - 120 ? 'end' : 'middle'}">${esc(mLabel)}</text>`,
        'data-kind="ns"');
      // span handle: the free end (or right support)
      partInner += H('len', 'Span in mm', raw.len,
        `<rect class="hit" x="${xE - 12}" y="${midY - (shape === 'cantilever' ? 11 : 40)}" width="24" height="${shape === 'cantilever' ? 40 : 80}"/><circle class="knob" cx="${xE}" cy="${midY}" r="7"/><path class="grip" d="M${xE - 3} ${midY - 3}v6M${xE + 1} ${midY - 3}v6"/>`,
        'data-kind="ew"');
      // mode label
      const mf = v.modes[modeIx];
      partInner += `<text class="modet" x="${x0}" y="16">Mode ${modeIx + 1} · ${hz(mf)}${modeIx === 0 && v.withMass ? ' with the mass' : ''}${modeIx > 0 && v.withMass ? ' · bare beam' : ''}</text>`;
    } else {
      // plate, top view: a along x (shared axis), b along y
      const b = inp.width;
      const availH = topH - 60;
      const sy = Math.min(s, availH / b);
      const pH = b * sy, yT0 = 26 + (availH - pH) / 2, pW = L * s;
      const pl = v.plate?.[modeIx] || { i: 1, j: 1 };
      beamGeo = { plate: true, x0, yT0, pW, pH, i: pl.i, j: pl.j };
      partInner += `<rect class="pcb" x="${x0}" y="${yT0}" width="${pW}" height="${pH}"/>`;
      partInner += '<g id="vfd-cells"></g>';
      // nodal lines of the shown mode
      for (let k = 1; k < pl.i; k++) partInner += `<path class="nodal" d="M${x0 + (k / pl.i) * pW} ${yT0}V${yT0 + pH}"/>`;
      for (let k = 1; k < pl.j; k++) partInner += `<path class="nodal" d="M${x0} ${yT0 + (k / pl.j) * pH}H${x0 + pW}"/>`;
      // simply supported edges: small triangles along the outline
      const tri = [];
      const n1 = clamp(Math.round(pW / 26), 3, 30), n2 = clamp(Math.round(pH / 26), 2, 20);
      for (let k = 0; k <= n1; k++) { const x = x0 + (k / n1) * pW; tri.push(`M${x} ${yT0}l-3 -6h6z`, `M${x} ${yT0 + pH}l-3 6h6z`); }
      for (let k = 0; k <= n2; k++) { const y = yT0 + (k / n2) * pH; tri.push(`M${x0} ${y}l-6 -3v6z`, `M${x0 + pW} ${y}l6 -3v6z`); }
      partInner += `<path class="sst" d="${tri.join('')}"/><rect class="pedge" x="${x0}" y="${yT0}" width="${pW}" height="${pH}"/>`;
      // components (the added mass, smeared): a block in the middle as the handle
      const mSize = clamp(10 + Math.sqrt(Math.max(0, inp.mass)) * 2, 12, Math.min(40, pH * 0.5));
      const mx = x0 + pW / 2, my = yT0 + pH / 2;
      partInner += H('mass', 'Components on the plate in grams', raw.mass,
        `<rect class="hit" x="${mx - 30}" y="${my - mSize / 2 - 22}" width="60" height="${mSize + 30}"/><rect class="mass${inp.mass > 0 ? '' : ' ghost'}" x="${mx - mSize / 2}" y="${my - mSize / 2}" width="${mSize}" height="${mSize}" rx="2"/><rect class="ring" x="${mx - mSize / 2 - 4}" y="${my - mSize / 2 - 4}" width="${mSize + 8}" height="${mSize + 8}" rx="3"/><text class="ml halo" x="${mx}" y="${my - mSize / 2 - 8}" text-anchor="middle">${inp.mass > 0 ? `${esc(raw.mass)} g of parts, smeared` : '+ parts'}</text>`,
        'data-kind="ns"');
      // dims
      const yD = yT0 + pH + 16;
      partInner += `<path class="dim" d="M${x0} ${yD}H${x0 + pW}M${x0} ${yD - 4}V${yD + 4}M${x0 + pW} ${yD - 4}V${yD + 4}"/><text class="dimt halo" x="${x0 + pW / 2}" y="${yD + 13}" text-anchor="middle">a ${esc(raw.len)} mm</text>`;
      partInner += `<text class="dimt halo" x="${x0 + pW + 12}" y="${yT0 + pH / 2 + 4}">b ${esc(raw.width)} mm</text>`;
      warnAt = { x: x0 + pW / 2 + 58, y: yD + 9 };
      if (sy < s * 0.98) partInner += `<text class="ex" x="${x0 + pW + 12}" y="${yT0 + pH / 2 + 18}">b drawn ×${sig(sy / s, 2)}</text>`;
      partInner += H('len', 'Plate long side a in mm', raw.len,
        `<rect class="hit" x="${x0 + pW - 10}" y="${yT0}" width="20" height="${pH}"/><rect class="ring" x="${x0 + pW - 5}" y="${yT0 - 3}" width="10" height="${pH + 6}" rx="3"/><rect class="grip" x="${x0 + pW - 1.5}" y="${yT0 + pH / 2 - 12}" width="3" height="24" rx="1.5"/>`,
        'data-kind="ew"');
      partInner += H('width', 'Plate short side b in mm', raw.width,
        `<rect class="hit" x="${x0}" y="${yT0 + pH - 10}" width="${pW}" height="20"/><rect class="ring" x="${x0 - 3}" y="${yT0 + pH - 5}" width="${pW + 6}" height="10" rx="3"/><rect class="grip" x="${x0 + pW / 2 - 12}" y="${yT0 + pH - 1.5}" width="24" height="3" rx="1.5"/>`,
        `data-kind="ns" data-sy="${sy}"`);
      partInner += `<text class="modet" x="${x0}" y="14">Mode (${pl.i},${pl.j}) · ${hz(v.modes[modeIx])} · ${pl.i} × ${pl.j} half-waves, edges simply supported</text>`;
    }
    // warnings drawn where they apply
    const ws = ctx.result?.warnings || [];
    const geoW = ws.find((w) => /^The plate is thick|^Short, deep/.test(w));
    if (geoW && warnAt) out.push(`<g class="wmark"><circle cx="${warnAt.x}" cy="${warnAt.y}" r="8"/><text x="${warnAt.x}" y="${warnAt.y + 4}" text-anchor="middle">!</text><text class="wmt halo" x="${warnAt.x + 12}" y="${warnAt.y + 4}">${/plate/.test(geoW) ? 'thick plate: upper bound' : 'short, deep beam: upper bound'}</text><title>${esc(geoW)}</title></g>`);
    stage.innerHTML = `<g class="part">${partInner}</g>${out.join('')}`;
    // keep last warn mark on top
    const wm = stage.querySelector('.wmark'); if (wm) stage.append(wm);
    frozenOut = { Lmax, fLo, fHi, s };
    paintMode(animate ? Math.cos(phase) : 1);
  }
  let frozenOut = null;

  // ---- animation: only the beam path / plate cells change ----
  let phase = 0, lastT = 0;
  function paintMode(k) {
    if (!beamGeo) return;
    if (beamGeo.plate) {
      const g = stage.querySelector('#vfd-cells');
      if (!g) return;
      const { x0, yT0, pW, pH, i, j } = beamGeo;
      const nx = clamp(Math.round(pW / 14), 8, 60), ny = clamp(Math.round(pH / 14), 5, 40);
      let html = '';
      for (let a = 0; a < nx; a++) for (let c = 0; c < ny; c++) {
        const w = Math.sin(i * Math.PI * (a + 0.5) / nx) * Math.sin(j * Math.PI * (c + 0.5) / ny) * k;
        if (Math.abs(w) < 0.04) continue;
        html += `<rect class="${w > 0 ? 'cp' : 'cn'}" x="${(x0 + (a * pW) / nx).toFixed(1)}" y="${(yT0 + (c * pH) / ny).toFixed(1)}" width="${(pW / nx + 0.5).toFixed(1)}" height="${(pH / ny + 0.5).toFixed(1)}" style="opacity:${(Math.abs(w) * 0.75).toFixed(2)}"/>`;
      }
      g.innerHTML = html;
      return;
    }
    const b = stage.querySelector('#vfd-beam');
    if (!b) return;
    const { x0, s, L, y, pts, amp, tPx, mx, mIx, mSize, withMass } = beamGeo;
    const n = pts.length - 1;
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + (i / n) * L * s, yy = y - pts[i] * amp * k;
      top.push(`${x.toFixed(1)},${(yy - tPx / 2).toFixed(1)}`);
      bot.push(`${x.toFixed(1)},${(yy + tPx / 2).toFixed(1)}`);
    }
    b.setAttribute('d', `M${top.join('L')}L${bot.reverse().join('L')}Z`);
    if (withMass) {
      const m = stage.querySelector('#vfd-mass rect');
      if (m) m.setAttribute('y', (y - pts[mIx] * amp * k - tPx / 2 - mSize).toFixed(1));
      void mx;
    }
  }
  function tick(t) {
    if (animate && !drag && document.visibilityState !== 'hidden') {
      const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
      phase += dt * 2 * Math.PI * 0.9;
      paintMode(Math.cos(phase));
    }
    lastT = t;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- stage handles: pointer + keyboard ----
  const toMm = (evt) => {
    const r = stage.getBoundingClientRect();
    const vb = stage.viewBox.baseVal;
    return { x: ((evt.clientX - r.left) / r.width) * vb.width, y: ((evt.clientY - r.top) / r.height) * vb.height };
  };
  stage.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.vf-h');
    if (!h) return;
    e.preventDefault();
    h.focus({ preventScroll: true });
    stage.setPointerCapture(e.pointerId);
    const key = h.dataset.h, p = toMm(e);
    frozen = { ...frozenOut };
    drag = { key, y0: p.y, x0: p.x, m0: Number(ctx.input.mass) || 0, sy: Number(h.dataset.sy) || frozen.s, b0: ctx.input.width };
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toMm(e), fz = frozen;
    const { W } = stageSize();
    const x0 = W < 560 ? 44 : 64;
    if (drag.key === 'len') {
      const mm = clamp((p.x - x0) / fz.s, 1, fz.Lmax);
      setSoon({ len: String(niceLen(mm)) });
    } else if (drag.key === 'width') {
      const mm = clamp(drag.b0 + (p.y - drag.y0) / drag.sy, 1, 5000);
      setSoon({ width: String(niceLen(mm)) });
    } else if (drag.key === 'mass') {
      // up = heavier, on a log-ish scale so grams and kilos are both reachable
      const dy = drag.y0 - p.y;
      const m = Math.max(0, (drag.m0 + 1) * Math.exp(dy / 45) - 1);
      setSoon({ mass: String(m < 0.5 ? 0 : m < 20 ? Math.round(m * 2) / 2 : Math.round(m)) });
    }
  });
  const endDrag = () => { if (!drag) return; drag = null; frozen = null; stage.classList.remove('dragging'); requestAnimationFrame(() => { drawStage(); drawRuler(); }); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('keydown', (e) => {
    const h = e.target.closest('.vf-h');
    if (!h) return;
    const key = h.dataset.h, up = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0;
    if (!up) return;
    e.preventDefault();
    const inp = ctx.input, f = e.shiftKey ? 1.1 : 1.01;
    if (key === 'len') ctx.set('len', String(niceLen(clamp(inp.len * (up > 0 ? f : 1 / f), 1, 10000))));
    if (key === 'width') ctx.set('width', String(niceLen(clamp(inp.width * (up > 0 ? f : 1 / f), 1, 10000))));
    if (key === 'mass') { const m = Number(inp.mass) || 0; const st = e.shiftKey ? 10 : m >= 100 ? 5 : 1; ctx.set('mass', String(Math.max(0, m + up * st))); }
    requestAnimationFrame(() => stage.querySelector(`[data-h="${key}"]`)?.focus({ preventScroll: true }));
  });

  // ---------------- cross-section ----------------
  function drawSection() {
    const inp = ctx.input, raw = ctx.raw, v = V();
    const Wp = Math.max(160, secBox.clientWidth), Hp = 150;
    sec.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    const out = [];
    const cx = Wp / 2 - 10, cy = Hp / 2 + 4;
    const plate = isPlate();
    const secKind = plate ? 'rect' : inp.section;
    let bb, hh;
    if (secKind === 'rect') { bb = plate ? Math.min(inp.width, inp.thick * 30) : inp.width; hh = inp.thick; } else { bb = hh = inp.dia; }
    if (!(bb > 0 && hh > 0)) { sec.innerHTML = ''; return; }
    const sc = Math.min((Wp - 110) / bb, (Hp - 50) / hh);
    const w = bb * sc, h = hh * sc;
    out.push(`<path class="na" d="M${cx - w / 2 - 16} ${cy}H${cx + w / 2 + 16}"/><text class="lab" x="${cx - w / 2 - 18}" y="${cy + 3}" text-anchor="end">NA</text>`);
    if (secKind === 'rect') {
      out.push(`<rect class="${plate ? 'pcbs' : 'metal'}" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"/>`);
      if (plate) out.push(`<path class="brk" d="M${cx - w / 2} ${cy - h / 2 - 4}l-6 ${h / 2 + 4}l6 ${h / 2 + 4}M${cx + w / 2} ${cy - h / 2 - 4}l6 ${h / 2 + 4}l-6 ${h / 2 + 4}"/>`);
      if (!plate) {
        out.push(`<text class="dimt" x="${cx}" y="${cy + h / 2 + 16}" text-anchor="middle">b ${esc(raw.width)}</text>`);
        out.push(H('width', 'Section width in mm', raw.width, `<rect class="hit" x="${cx + w / 2 - 8}" y="${cy - h / 2 - 6}" width="16" height="${h + 12}"/><rect class="grip" x="${cx + w / 2 - 1.5}" y="${cy - Math.max(8, h / 3)}" width="3" height="${Math.max(16, (2 * h) / 3)}" rx="1.5"/>`, 'data-kind="ew"'));
      }
      out.push(`<text class="dimt" x="${cx + w / 2 + 14}" y="${cy - h / 2 - 6}">t ${esc(raw.thick)}</text>`);
      out.push(H('thick', 'Thickness in mm', raw.thick, `<rect class="hit" x="${cx - w / 2}" y="${cy - h / 2 - 8}" width="${w}" height="16"/><rect class="grip" x="${cx - Math.min(14, w / 3)}" y="${cy - h / 2 - 1.5}" width="${Math.min(28, (2 * w) / 3)}" height="3" rx="1.5"/>`, 'data-kind="ns"'));
    } else {
      const r = w / 2;
      out.push(`<circle class="metal" cx="${cx}" cy="${cy}" r="${r}"/>`);
      if (secKind === 'tube' && inp.inner > 0 && inp.inner < inp.dia) {
        const ri = (inp.inner * sc) / 2;
        out.push(`<circle class="hole" cx="${cx}" cy="${cy}" r="${ri}"/>`);
        out.push(`<text class="dimt" x="${cx}" y="${cy + 4}" text-anchor="middle">d ${esc(raw.inner)}</text>`);
        out.push(H('inner', 'Inner diameter in mm', raw.inner, `<circle class="hitc" cx="${cx}" cy="${cy}" r="${ri}" style="fill:none;stroke:transparent;stroke-width:12"/><circle class="gripc" cx="${cx + ri}" cy="${cy}" r="4"/>`, 'data-kind="rad"'));
      }
      out.push(`<text class="dimt" x="${cx + r + 10}" y="${cy - r + 4}">Ø ${esc(raw.dia)}</text>`);
      out.push(H('dia', 'Outer diameter in mm', raw.dia, `<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:none;stroke:transparent;stroke-width:14"/><circle class="gripc" cx="${cx + r * 0.7071}" cy="${cy + r * 0.7071}" r="4.5"/>`, 'data-kind="rad"'));
    }
    out.push(`<path class="bend" d="M${Wp - 22} ${cy - 26}V${cy + 26}M${Wp - 26} ${cy - 20}l4 -6 4 6M${Wp - 26} ${cy + 20}l4 6 4 -6"/><text class="lab" x="${Wp - 22}" y="${cy + 44}" text-anchor="middle">bends</text>`);
    out.push(`<text class="lab" x="6" y="12">${plate ? 'Plate section (slice)' : 'Section, to scale'}</text>`);
    if (v) out.push(`<text class="lab" x="6" y="${Hp - 5}">${esc(v.material)} · E ${sig(v.E, 3)} GPa · ρ ${sig(v.rho, 4)}</text>`);
    sec.innerHTML = out.join('');
    secGeo = { sc, cx, cy };
  }
  let secGeo = null, secDrag = null;
  const secPt = (e) => { const r = sec.getBoundingClientRect(), vb = sec.viewBox.baseVal; return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height }; };
  sec.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.vf-h'); if (!h || !secGeo) return;
    e.preventDefault(); h.focus({ preventScroll: true }); sec.setPointerCapture(e.pointerId);
    secDrag = { key: h.dataset.h, ...secGeo };
  });
  sec.addEventListener('pointermove', (e) => {
    if (!secDrag) return;
    const p = secPt(e), { key, sc, cx, cy } = secDrag;
    let mm;
    if (key === 'width') mm = (2 * Math.abs(p.x - cx)) / sc;
    else if (key === 'thick') mm = (2 * Math.abs(cy - p.y)) / sc;
    else mm = (2 * Math.hypot(p.x - cx, p.y - cy)) / sc;
    mm = clamp(mm, 0.1, 5000);
    if (key === 'inner') mm = Math.min(mm, ctx.input.dia * 0.98);
    setSoon({ [key]: String(niceLen(mm)) });
  });
  const secEnd = () => { secDrag = null; };
  sec.addEventListener('pointerup', secEnd); sec.addEventListener('pointercancel', secEnd);
  sec.addEventListener('keydown', (e) => {
    const h = e.target.closest('.vf-h'); if (!h) return;
    const up = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0; if (!up) return;
    e.preventDefault();
    const key = h.dataset.h, cur = Number(ctx.input[key]) || 1, f = e.shiftKey ? 1.1 : 1.02;
    ctx.set(key, String(niceLen(clamp(cur * (up > 0 ? f : 1 / f), 0.1, 5000))));
    requestAnimationFrame(() => sec.querySelector(`[data-h="${key}"]`)?.focus({ preventScroll: true }));
  });

  // ---------------- frequency ruler ----------------
  let rulerGeo = null;
  function drawRuler() {
    const v = V();
    const Wp = Math.max(300, rulerBox.clientWidth), Hp = 118;
    ruler.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!v) { ruler.innerHTML = ''; return; }
    const tgt = v.target;
    const modes = v.modes;
    let lo = Math.min(modes[0], tgt > 0 ? tgt : Infinity) / 3, hi = Math.max(modes[modes.length - 1], tgt > 0 ? 2 * tgt : 0) * 1.6;
    if (rulerDrag) { lo = rulerDrag.lo; hi = rulerDrag.hi; }
    const mL = 16, mR = 16, yA = 80;
    const X = (f) => mL + ((Math.log10(f) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (Wp - mL - mR);
    const out = [];
    out.push(`<rect class="hitbar" x="0" y="${yA - 26}" width="${Wp}" height="40"/>`);
    if (tgt > 0) {
      const a = X(Math.SQRT2 * tgt), b = X(2 * tgt);
      out.push(`<rect class="z-bad" x="${mL}" y="${yA - 14}" width="${Math.max(0, a - mL)}" height="14"/><rect class="z-warn" x="${a}" y="${yA - 14}" width="${Math.max(0, b - a)}" height="14"/><rect class="z-ok" x="${b}" y="${yA - 14}" width="${Math.max(0, Wp - mR - b)}" height="14"/>`);
    }
    out.push(`<line class="axl" x1="${mL}" x2="${Wp - mR}" y1="${yA}" y2="${yA}"/>`);
    for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) {
      for (const m of [1, 2, 5]) {
        const f = m * 10 ** d; if (f < lo || f > hi) continue;
        const x = X(f);
        out.push(`<line class="tick" x1="${x}" x2="${x}" y1="${yA}" y2="${yA + (m === 1 ? 7 : 4)}"/>`);
        if (m === 1 || (Wp > 700)) out.push(`<text class="ax" x="${x}" y="${yA + 19}" text-anchor="middle">${hz(f)}</text>`);
      }
    }
    // modes
    const levels = [];   // right edge of the last label on each level
    modes.forEach((f, i) => {
      const x = X(f), sel = i === modeIx;
      const pl = v.plate?.[i];
      const name = pl ? `(${pl.i},${pl.j})` : `f${i + 1}`;
      const tn = i === 0 ? tone(f, tgt) : '';
      // stack labels on up to three levels; a crowded one drops its Hz
      let label = `${name} ${hz(f)}`, lv = -1, flip = false, x1l = 0;
      for (const cand of [label, name]) {
        const tw = cand.length * 7 + 12;
        flip = x + tw > Wp - mR;
        const x0l = flip ? x - tw : x;
        x1l = flip ? x : x + tw;
        for (let k = 0; k < 3; k++) if (!(levels[k] > x0l)) { lv = k; break; }
        if (lv >= 0) { label = cand; break; }
      }
      if (lv < 0) { lv = 2; label = name; }
      levels[lv] = Math.max(levels[lv] ?? -1e9, x1l);
      const lift = lv * 15;
      out.push(`<g class="mode${sel ? ' sel' : ''} ${tn}" data-m="${i}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="Show mode ${name} at ${hz(f)}"><rect class="hit" x="${x - 26}" y="4" width="52" height="${yA}"/><line x1="${x}" x2="${x}" y1="${yA - 30 - lift}" y2="${yA}"/><circle cx="${x}" cy="${yA - 30 - lift}" r="${i === 0 ? 5 : 3.5}"/><text x="${flip ? x - 7 : x + 7}" y="${yA - 34 - lift}" text-anchor="${flip ? 'end' : 'start'}">${label}</text></g>`);
    });
    // excitation marker
    const tx = tgt > 0 ? X(tgt) : mL + 6;
    out.push(`<g class="vf-h exc${tgt > 0 ? '' : ' off'}" data-h="target" tabindex="0" role="slider" aria-label="Excitation frequency in Hz" aria-valuenow="${tgt}" aria-valuetext="${tgt > 0 ? hz(tgt) : 'none'}"><rect class="hit" x="${tx - 14}" y="${yA - 2}" width="28" height="36"/><path class="exm" d="M${tx} ${yA}l-7 12h14z"/><line class="exl" x1="${tx}" x2="${tx}" y1="${yA - 24}" y2="${yA}"/><text class="ext" x="${tx}" y="${Hp - 2}" text-anchor="${tx < 90 ? 'start' : tx > Wp - 90 ? 'end' : 'middle'}" dx="${tx < 90 ? -6 : 0}">${tgt > 0 ? `forcing ${hz(tgt)}` : 'no forcing · drag to set'}</text></g>`);
    ruler.innerHTML = out.join('');
    rulerGeo = { lo, hi, mL, mR, Wp };
  }
  let rulerDrag = null;
  const rPt = (e) => { const r = ruler.getBoundingClientRect(), vb = ruler.viewBox.baseVal; return ((e.clientX - r.left) / r.width) * vb.width; };
  const fAt = (x) => { const { lo, hi, mL, mR, Wp } = rulerDrag || rulerGeo; return 10 ** (Math.log10(lo) + ((x - mL) / (Wp - mL - mR)) * (Math.log10(hi) - Math.log10(lo))); };
  const niceHz = (f) => { const p = 10 ** Math.floor(Math.log10(f) - 1); return Math.round(f / p) * p; };
  ruler.addEventListener('pointerdown', (e) => {
    const m = e.target.closest('.mode');
    if (m) { modeIx = Number(m.dataset.m); drawStage(); drawRuler(); return; }
    if (!rulerGeo) return;
    e.preventDefault();
    ruler.setPointerCapture(e.pointerId);
    rulerDrag = { ...rulerGeo };
    ruler.querySelector('[data-h="target"]')?.focus({ preventScroll: true });
    setSoon({ target: String(sig(niceHz(fAt(rPt(e))), 3)) });
  });
  ruler.addEventListener('pointermove', (e) => { if (rulerDrag) setSoon({ target: String(sig(niceHz(fAt(rPt(e))), 3)) }); });
  const rEnd = () => { if (rulerDrag) { rulerDrag = null; requestAnimationFrame(drawRuler); } };
  ruler.addEventListener('pointerup', rEnd); ruler.addEventListener('pointercancel', rEnd);
  ruler.addEventListener('keydown', (e) => {
    const m = e.target.closest('.mode');
    if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); modeIx = Number(m.dataset.m); drawStage(); drawRuler(); ruler.querySelector(`[data-m="${modeIx}"]`)?.focus(); return; }
    if (!e.target.closest('[data-h="target"]')) return;
    const up = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ctx.set('target', '0'); }
    if (!up) return;
    e.preventDefault();
    const t = Number(ctx.input.target) || 0, f = e.shiftKey ? 1.25 : 1.05;
    const nt = t > 0 ? t * (up > 0 ? f : 1 / f) : 50;
    ctx.set('target', String(sig(nt, 3)));
    requestAnimationFrame(() => ruler.querySelector('[data-h="target"]')?.focus({ preventScroll: true }));
  });

  // ---------------- read-out ----------------
  function drawRead() {
    const res = ctx.result || {}, v = V();
    const vals = res.values || [];
    if (!v) {
      big.innerHTML = '<span class="vf-lab">First natural frequency</span><b>–</b>';
      verdict.textContent = ''; dl.innerHTML = '';
    } else {
      const tn = tone(v.f1, v.target);
      big.className = `vf-big ${tn}`;
      big.innerHTML = `<span class="vf-lab">First natural frequency f1</span><b>${sig(v.f1, 4)}</b><i>Hz</i>`;
      if (v.target > 0) {
        const r = v.f1 / v.target;
        verdict.className = `vf-verdict ${tn}`;
        verdict.innerHTML = `<b>${sig(r, 3)}×</b> the ${hz(v.target)} forcing · ${tn === 'ok' ? 'clear of it (≥ 2×)' : tn === 'warn' ? 'under the 2× margin' : 'will resonate (< √2×)'}`;
      } else { verdict.className = 'vf-verdict'; verdict.textContent = 'No forcing frequency set: drag the ▼ on the frequency axis.'; }
      dl.innerHTML = vals.slice(1).map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.value)} <small>${esc(x.unit || '')}</small>${x.hint ? `<br><small>${esc(x.hint)}</small>` : ''}</dd>`).join('')
        + `<dt>Higher modes</dt><dd>${v.modes.slice(1, 3).map((f) => sig(f, 4)).join(' · ')} <small>Hz</small></dd>`;
    }
    warns.innerHTML = (res.warnings || []).map((w) => `<div>${esc(w)}</div>`).join('');
    notes.innerHTML = `<summary>Model and limits (${(res.notes || []).length})</summary>${(res.notes || []).map((n) => `<div>${esc(n)}</div>`).join('')}`;
  }

  // ---------------- material ladder ----------------
  function drawLadder() {
    const v = V(), inp = ctx.input;
    const list = v?.byMaterial || [];
    const tgt = v?.target || 0;
    const max = Math.max(...list.map((m) => m.f1 || 0), v?.f1 || 0, tgt * 2) * 1.05 || 1;
    const rows = list.map((m) => ({ ...m, short: SHORT[m.key] || m.name }));
    const cust = inp.material === 'custom' && v ? [{ key: 'custom', short: 'Custom', name: 'Custom material', f1: v.f1, E: v.E, rho: v.rho }] : [{ key: 'custom', short: 'Custom…', name: 'Custom material', f1: null }];
    const thr = tgt > 0 ? (2 * tgt) / max : null;
    const focusKey = document.activeElement?.closest?.('.vf-mat')?.dataset.k;
    ladder.innerHTML = [...rows, ...cust].map((m) => {
      const sel = m.key === inp.material;
      const tn = m.f1 ? tone(m.f1, tgt) : '';
      const frac = m.f1 ? m.f1 / max : 0;
      return `<button class="vf-mat ${tn}${sel ? ' sel' : ''}" role="radio" aria-checked="${sel}" data-k="${m.key}" title="${esc(m.name)}${m.E ? ` · E ${m.E} GPa · ρ ${m.rho} kg/m³` : ''}" style="--f:${frac.toFixed(4)}${thr != null ? `;--thr:${Math.min(1, thr).toFixed(4)}` : ''}">
        <span class="mn">${esc(m.short)}</span><span class="mb">${thr != null ? '<i class="mt"></i>' : ''}<i class="mf"></i></span><span class="mv">${m.f1 ? sig(m.f1, 3) : '–'}</span></button>`;
    }).join('');
    if (focusKey) ladder.querySelector(`[data-k="${focusKey}"]`)?.focus({ preventScroll: true });
  }
  ladder.addEventListener('click', (e) => { const b = e.target.closest('.vf-mat'); if (b) ctx.set('material', b.dataset.k); });
  ladder.addEventListener('keydown', (e) => {
    const b = e.target.closest('.vf-mat'); if (!b) return;
    const all = [...ladder.querySelectorAll('.vf-mat')], i = all.indexOf(b);
    const j = /Right|Down/.test(e.key) ? i + 1 : /Left|Up/.test(e.key) ? i - 1 : null;
    if (j == null) return;
    e.preventDefault();
    const nb = all[(j + all.length) % all.length];
    ctx.set('material', nb.dataset.k);
    requestAnimationFrame(() => ladder.querySelector(`[data-k="${nb.dataset.k}"]`)?.focus());
  });

  // ---------------- wiring ----------------
  let lastShape = null;
  function redraw() {
    const inp = ctx.input, v = V();
    if (inp.shape !== lastShape) { modeIx = 0; lastShape = inp.shape; }
    if (v && modeIx >= v.modes.length) modeIx = 0;
    syncChrome();
    drawStage();
    drawSection();
    drawRuler();
    drawRead();
    drawLadder();
    // keep focus on the handle being worked
    const fk = document.activeElement?.dataset?.h;
    if (fk && !document.activeElement.isConnected) stage.querySelector(`[data-h="${fk}"]`)?.focus({ preventScroll: true });
  }
  ctx.onResult(() => {
    const focusH = document.activeElement?.closest?.('.vf-h')?.dataset.h;
    const inStage = document.activeElement && stage.contains(document.activeElement);
    const inSec = document.activeElement && sec.contains(document.activeElement);
    const inRuler = document.activeElement && ruler.contains(document.activeElement);
    redraw();
    if (focusH) (inStage ? stage : inSec ? sec : inRuler ? ruler : root).querySelector(`[data-h="${focusH}"]`)?.focus({ preventScroll: true });
  });
  new ResizeObserver(() => { if (!drag) { drawStage(); drawSection(); drawRuler(); } }).observe(stageBox);
  new ResizeObserver(() => drawRuler()).observe(rulerBox);
}
