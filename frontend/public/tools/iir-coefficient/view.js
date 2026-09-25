// EMA / IIR coefficient, custom page: the filter shown as what it does.
//   Scope  - a noisy step goes in, the smoothed signal comes out, sample by
//            sample. The time constant is a handle on the output curve: drag
//            it (or click anywhere on the scope) to say "settle this fast",
//            and that sets α. 95 % / 99 % settling and the noise left over
//            are marked on the trace.
//   Ruler  - α on a log scale with every right shift 1/2^k as a notch; drag
//            the pointer, or click a notch to use a shift.
//   Bode   - the magnitude response against an analog RC; drag the -3 dB
//            corner along the frequency axis to set the cutoff.
// What you grab is what you specify: the scope and ruler set α, a notch sets
// a shift, the corner sets a cutoff. Every number shown comes from run()'s
// result (result.response and the chart data); the traces are the filter
// y += α (x - y) from tool.js run over a demo signal.
import { filterSignal } from './tool.js';
import { fmtEng, fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sig = (v, d = 4) => String(Number(v.toPrecision(d)));
const FS_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 250, 500, 1000, 2000, 4000, 5000, 8000, 10000, 16000, 20000, 44100, 48000, 96000, 100000, 1e6];

// Seeded Gaussian noise, so the demo signal does not flicker between results.
function noiseSeq(n, seed = 7) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}
const NOISE = [['0', 'Clean'], ['0.08', 'Noise 8 %'], ['0.2', 'Noise 20 %']];

export function page(root, ctx) {
  const st = { noise: 0.08, drag: null, span: null, bodeLo: null, alphaLo: null, res: null, noiseCache: null };
  try { const v = localStorage.getItem('redline.iir.noise'); const n = Number(v); if (v != null && NOISE.some(([v]) => Number(v) === n)) st.noise = n; } catch { /* storage off */ }

  // ------------------------------------------------------------ controls
  const field = (key, label, unit, step, width = 8) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', id: `iir-${key}`, style: `width:${width}ch`,
      oninput: (e) => ctx.set(key, e.target.value),
      onkeydown: (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const cur = ctx.input[key];
        if (cur == null) return;
        const nv = step(cur, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        inp.value = nv; ctx.set(key, nv);
      } });
    const wrap = h('label', { class: 'iir-f', for: `iir-${key}` }, h('span', { class: 'iir-fl' }, label), inp, unit ? h('span', { class: 'iir-fu' }, unit) : null);
    return { inp, wrap };
  };
  const mul = (v, dir, big) => sig(v * (big ? 1.25 : 1.05) ** dir);
  const fsF = field('fs', 'Sample rate fs', 'Hz', (v, dir) => {
    const i = dir > 0 ? FS_STEPS.findIndex((x) => x > v * 1.0001) : FS_STEPS.findLastIndex((x) => x < v * 0.9999);
    return String(i < 0 ? v : FS_STEPS[i]);
  });
  const fcF = field('fc', 'Cutoff fc', 'Hz', mul);
  const alF = field('alpha', 'α', '', (v, dir, big) => sig(clamp(v * (big ? 1.25 : 1.05) ** dir, 1e-6, 1)), 9);
  const kF = field('k', 'Shift k', '', (v, dir) => String(clamp(Math.round(v) + dir, 0, 30)), 4);
  const modeBtn = (m, t) => h('button', { class: 'iir-seg', 'data-m': m, 'aria-pressed': 'false', onclick: () => ctx.set('mode', m) }, t);
  const modeBtns = [modeBtn('cutoff', 'Cutoff'), modeBtn('alpha', 'α'), modeBtn('shift', 'Shift')];
  const methBtn = (m, t, title) => h('button', { class: 'iir-seg', 'data-m': m, 'aria-pressed': 'false', title, onclick: () => ctx.set('method', m) }, t);
  const methBtns = [methBtn('exact', 'exact −3 dB', 'α puts the true −3 dB point at fc'), methBtn('rc', 'RC τ', 'α matches an RC with τ = 1/(2π fc)')];
  const meth = h('span', { class: 'iir-segs', role: 'group', 'aria-label': 'Cutoff means' }, methBtns);
  const kMinus = h('button', { class: 'k-btn iir-kb', 'aria-label': 'Shift one less', onclick: () => ctx.set('k', String(clamp(Math.round(ctx.input.k ?? 4) - 1, 0, 30))) }, '−');
  const kPlus = h('button', { class: 'k-btn iir-kb', 'aria-label': 'Shift one more', onclick: () => ctx.set('k', String(clamp(Math.round(ctx.input.k ?? 4) + 1, 0, 30))) }, '+');
  kF.wrap.append(kMinus, kPlus);
  const spec = h('div', { class: 'iir-spec' });
  const big = h('div', { class: 'iir-big', 'aria-live': 'polite' });
  const bar = h('section', { class: 'iir-bar' },
    fsF.wrap,
    h('div', { class: 'iir-by' }, h('span', { class: 'iir-fl' }, 'Set by'), h('span', { class: 'iir-segs', role: 'group', 'aria-label': 'Start from' }, modeBtns)),
    spec, big);

  // ------------------------------------------------------------ drawings
  const noiseBtns = NOISE.map(([v, t]) => h('button', { class: 'iir-seg', 'data-v': v, 'aria-pressed': 'false',
    onclick: () => { st.noise = Number(v); try { localStorage.setItem('redline.iir.noise', v); } catch { /* */ } st.noiseCache = null; drawAll(); } }, t));
  const scopeSvg = sv('svg', { class: 'iir-svg iir-scope', role: 'img' });
  const scopeCap = h('div', { class: 'iir-cap' });
  const scope = h('section', { class: 'iir-panel iir-p-scope' },
    h('div', { class: 'iir-head' }, h('span', { class: 'iir-h' }, 'Step in, smoothed out'),
      h('span', { class: 'iir-soft' }, 'drag the τ handle or click the trace'),
      h('span', { class: 'iir-segs iir-right', role: 'group', 'aria-label': 'Demo input' }, noiseBtns)),
    scopeSvg, scopeCap);
  const rulerSvg = sv('svg', { class: 'iir-svg iir-ruler', role: 'img' });
  const ruler = h('section', { class: 'iir-panel iir-p-ruler' },
    h('div', { class: 'iir-head' }, h('span', { class: 'iir-h' }, 'Coefficient ', h('span', { class: 'iir-nocase' }, 'α')),
      h('span', { class: 'iir-soft' }, 'drag the pointer; click a notch to use a right shift y += (x − y) >> k')),
    rulerSvg);
  const bodeSvg = sv('svg', { class: 'iir-svg iir-bode', role: 'img' });
  const bode = h('section', { class: 'iir-panel iir-p-bode' },
    h('div', { class: 'iir-head' }, h('span', { class: 'iir-h' }, 'Magnitude'),
      h('span', { class: 'iir-key iir-key-ema' }, 'EMA'), h('span', { class: 'iir-key iir-key-rc' }, 'analog RC, same corner'),
      h('span', { class: 'iir-soft iir-right' }, 'drag the corner')),
    bodeSvg);
  const warns = h('div', { class: 'iir-warns', 'aria-live': 'polite' });
  const consts = h('div', { class: 'iir-consts' });
  const notes = h('div', { class: 'iir-notes' });
  root.append(h('div', { class: 'iir' }, bar, warns,
    h('div', { class: 'iir-cols' },
      h('div', { class: 'iir-col' }, scope, ruler, consts, notes),
      h('div', { class: 'iir-col' }, bode, ctx.outputs))));

  // ------------------------------------------------------------ drag plumbing
  // Capture on the persistent <svg>, so redrawing its content mid-drag keeps the drag.
  function dragSurface(svgEl, kind, onPoint, onKey) {
    svgEl.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('[data-drag]');
      const k = t ? t.dataset.drag : (e.target.closest('.iir-noclick') ? null : kind);
      if (!k || e.button !== 0) return;
      e.preventDefault();
      svgEl.setPointerCapture(e.pointerId);
      st.drag = k;
      svgEl.classList.add('is-drag');
      onPoint(k, e);
    });
    svgEl.addEventListener('pointermove', (e) => { if (st.drag && svgEl.hasPointerCapture(e.pointerId)) onPoint(st.drag, e); });
    const end = (e) => {
      if (!svgEl.hasPointerCapture?.(e.pointerId) && !st.drag) return;
      st.drag = null; svgEl.classList.remove('is-drag');
      st.span = null; st.bodeLo = null; st.alphaLo = null;
      drawAll();
    };
    svgEl.addEventListener('pointerup', end);
    svgEl.addEventListener('pointercancel', end);
    svgEl.addEventListener('keydown', onKey);
  }
  const local = (svgEl, e) => {
    const r = svgEl.getBoundingClientRect();
    const vb = svgEl.viewBox.baseVal;
    return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
  };
  const setAlpha = (a) => ctx.setMany({ mode: 'alpha', alpha: sig(clamp(a, 1e-6, 1), 4) });
  const refocus = (svgEl, sel) => requestAnimationFrame(() => svgEl.querySelector(sel)?.focus());

  // scope geometry, shared by the drawing and the drag
  let sg = null;
  dragSurface(scopeSvg, 'tau', (k, e) => {
    if (!sg) return;
    const p = local(scopeSvg, e);
    const n = (p.x - sg.x0) / sg.dx - sg.n0;
    const tau = clamp(n, 0.3, sg.N * 2);
    setAlpha(1 - Math.exp(-1 / tau));
  }, (e) => {
    if (!e.target.closest('.iir-tau') || !st.res) return;
    const f = { ArrowRight: 1.05, ArrowLeft: 1 / 1.05, ArrowUp: 1.05, ArrowDown: 1 / 1.05 }[e.key];
    if (!f) return;
    e.preventDefault();
    const tau = Math.max(0.3, st.res.tauN * (e.shiftKey ? f ** 5 : f));
    setAlpha(1 - Math.exp(-1 / tau));
    refocus(scopeSvg, '.iir-tau');
  });

  let rg = null;
  dragSurface(rulerSvg, 'alpha', (k, e) => {
    if (!rg) return;
    const p = local(rulerSvg, e);
    setAlpha(10 ** (rg.lo + ((p.x - rg.x0) / (rg.x1 - rg.x0)) * (0 - rg.lo)));
  }, (e) => {
    const notch = e.target.closest('.iir-notch');
    if (notch && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.setMany({ mode: 'shift', k: notch.dataset.k }); refocus(rulerSvg, '.iir-apt'); return; }
    if (!e.target.closest('.iir-apt') || !st.res) return;
    const a = st.res.alpha;
    let na = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') na = a * (e.shiftKey ? 1.25 : 1.05);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') na = a / (e.shiftKey ? 1.25 : 1.05);
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const k = clamp(st.res.kNear + (e.key === 'PageUp' ? -1 : 1), 0, 14);
      e.preventDefault(); ctx.setMany({ mode: 'shift', k: String(k) }); refocus(rulerSvg, '.iir-apt'); return;
    }
    if (na == null) return;
    e.preventDefault(); setAlpha(na); refocus(rulerSvg, '.iir-apt');
  });
  rulerSvg.addEventListener('click', (e) => {
    const notch = e.target.closest('.iir-notch');
    if (notch) ctx.setMany({ mode: 'shift', k: notch.dataset.k });
  });

  let bg = null;
  const setFc = (f) => ctx.setMany({ mode: 'cutoff', fc: sig(f, 4) });
  dragSurface(bodeSvg, 'corner', (k, e) => {
    if (!bg) return;
    const p = local(bodeSvg, e);
    const lf = bg.l0 + ((p.x - bg.x0) / (bg.x1 - bg.x0)) * (bg.l1 - bg.l0);
    setFc(clamp(10 ** lf, bg.fs * 1e-7, bg.fs * 0.49));
  }, (e) => {
    if (!e.target.closest('.iir-corner') || !st.res) return;
    const f = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!f) return;
    e.preventDefault();
    const cur = st.res.f3db ?? ctx.input.fc ?? 1;
    setFc(clamp(cur * 10 ** (f / (e.shiftKey ? 6 : 48)), st.res.fs * 1e-7, st.res.fs * 0.49));
    refocus(bodeSvg, '.iir-corner');
  });

  // ------------------------------------------------------------ result in
  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  ctx.onResult((res) => {
    const raw = ctx.raw;
    syncVal(fsF.inp, String(raw.fs ?? ''));
    syncVal(fcF.inp, String(raw.fc ?? ''));
    syncVal(alF.inp, String(raw.alpha ?? ''));
    syncVal(kF.inp, String(raw.k ?? ''));
    const mode = ['alpha', 'shift'].includes(raw.mode) ? raw.mode : 'cutoff';
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
    for (const b of methBtns) b.setAttribute('aria-pressed', String(b.dataset.m === (raw.method === 'rc' ? 'rc' : 'exact')));
    spec.replaceChildren(...(mode === 'cutoff' ? [fcF.wrap, meth] : mode === 'alpha' ? [alF.wrap] : [kF.wrap]));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (res.response) st.res = { ...res.response, charts: res.charts };
    document.querySelector('.iir')?.classList.toggle('iir-stale', !res.response);
    drawAll();
  });
  const ro = new ResizeObserver(() => drawAll());
  ro.observe(scope); ro.observe(bode); ro.observe(ruler);

  function drawAll() {
    for (const b of noiseBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === st.noise));
    const r = st.res;
    if (!r) return;
    const q = r.settle;
    big.replaceChildren(
      h('span', { class: 'iir-bl' }, 'α ='), h('b', {}, fmtNum(r.alpha, 6)),
      h('span', { class: 'iir-bs' }, `−3 dB ${r.f3db != null ? fmtEng(r.f3db, 'Hz', 4) : '–'} · τ ${fmtNum(r.tauN, 4)} samples (${fmtEng(r.tauS, 's')})`));
    consts.replaceChildren(
      cst('float', `${fmtNum(r.alpha, 6)}f`, r.src),
      cst('shift', `>> ${r.kNear}`, `α = 1/${2 ** r.kNear}, −3 dB ${r.shifts[r.kNear]?.f3db != null ? fmtEng(r.shifts[r.kNear].f3db, 'Hz') : '–'}`),
      cst('Q15', String(r.q15), `${fmtNum(r.q15 / 32768, 5)} after rounding`),
      cst('settle 63/95/99 %', `${q.p63} / ${q.p95} / ${q.p99}`, `samples; 99 % in ${fmtEng(q.p99 / r.fs, 's')}`));
    drawScope(r); drawRuler(r); drawBode(r);
  }
  const cst = (k, v, hint) => h('div', { class: 'iir-c' }, h('span', {}, k), h('b', {}, v), h('i', {}, hint));

  // ------------------------------------------------------------ scope
  function drawScope(r) {
    const W = Math.max(300, Math.round(scopeSvg.clientWidth || scope.clientWidth - 24 || 800));
    const H = W < 520 ? 260 : 330;
    scopeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    scopeSvg.setAttribute('height', H);
    const q = r.settle;
    // the window: the 99 % point well inside, frozen while dragging so the handle stays under the pointer
    const want = Math.ceil(Math.max(24, q.p99 * 1.35 + 6) / 0.86);
    const N = st.drag === 'tau' && st.span ? st.span : clamp(want, 30, 4000);
    st.span = N;
    const n0 = Math.round(N * 0.14);
    const L = 44, R = W < 520 ? 12 : 116, T = 18, B = 40;
    const dx = (W - L - R) / N;
    const x0 = L;
    const yv = (v) => T + (1.18 - v) * ((H - T - B) / 1.36);
    sg = { x0, dx, n0, N };
    if (!st.noiseCache || st.noiseCache.length !== N + 1) st.noiseCache = noiseSeq(N + 1);
    const clean = Array.from({ length: N + 1 }, (_, n) => (n >= n0 ? 1 : 0));
    const noisy = clean.map((v, n) => v + st.noise * st.noiseCache[n]);
    const yc = filterSignal(r.alpha, clean);
    const yn = filterSignal(r.alpha, noisy);
    const X = (n) => x0 + n * dx;
    const kids = [];
    // grid
    for (const [v, lab] of [[0, '0'], [1, '1']]) {
      kids.push(sv('line', { x1: L, x2: W - R, y1: yv(v), y2: yv(v), class: 'iir-grid0' }));
      kids.push(sv('text', { x: L - 6, y: yv(v) + 4, class: 'iir-ax', 'text-anchor': 'end' }, lab));
    }
    for (const lvl of [0.632, 0.95, 0.99]) kids.push(sv('line', { x1: X(n0), x2: W - R, y1: yv(lvl), y2: yv(lvl), class: 'iir-lvl' }));
    kids.push(sv('text', { x: L - 6, y: yv(0.632) + 4, class: 'iir-ax', 'text-anchor': 'end' }, '63 %'));
    // time axis: samples after the step, and seconds
    const tickStep = niceStep(N / Math.max(3, Math.floor((W - L - R) / 90)));
    for (let t = 0; n0 + t <= N; t += tickStep) {
      const x = X(n0 + t);
      kids.push(sv('line', { x1: x, x2: x, y1: H - B, y2: H - B + 4, class: 'iir-tick' }));
      kids.push(sv('text', { x, y: H - B + 16, class: 'iir-ax', 'text-anchor': 'middle' }, String(t)));
      if (t) kids.push(sv('text', { x, y: H - B + 29, class: 'iir-ax iir-ax2', 'text-anchor': 'middle' }, fmtEng(t / r.fs, 's')));
    }
    kids.push(sv('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'iir-axis' }));
    kids.push(sv('text', { x: L, y: H - B + 29, class: 'iir-ax iir-ax2' }, 'samples after the step'));
    // input
    const pts = (arr) => arr.map((v, n) => `${X(n).toFixed(1)},${yv(v).toFixed(1)}`).join(' ');
    kids.push(sv('polyline', { points: pts(st.noise ? noisy : clean), class: 'iir-in' }));
    if (dx >= 4.5) for (let n = 0; n <= N; n++) kids.push(sv('circle', { cx: X(n), cy: yv(st.noise ? noisy[n] : clean[n]), r: 1.8, class: 'iir-indot' }));
    if (st.noise) kids.push(sv('polyline', { points: pts(yn), class: 'iir-outn' }));
    kids.push(sv('polyline', { points: pts(yc), class: 'iir-out' }));
    if (dx >= 4.5) for (let n = n0; n <= N; n++) kids.push(sv('circle', { cx: X(n), cy: yv(yc[n]), r: 2.2, class: 'iir-outdot' }));
    // settle marks from the result
    for (const [n, lvl, lab] of [[q.p95, 0.95, `95 % · ${q.p95}`], [q.p99, 0.99, `99 % · ${q.p99} (${fmtEng(q.p99 / r.fs, 's')})`]]) {
      if (n0 + n > N) continue;
      const x = X(n0 + n);
      kids.push(sv('line', { x1: x, x2: x, y1: yv(lvl) - 8, y2: H - B, class: 'iir-settle' }));
      kids.push(sv('text', { ...place(x, lab.length * 6.7, L, W - R, 4), y: yv(lvl) - (lvl > 0.97 ? 12 : -14), class: 'iir-lab' }, lab));
    }
    // τ handle: on the clean output at 63.2 %
    const tx = X(n0 + r.tauN), ty = yv(1 - Math.exp(-1));
    const inView = n0 + r.tauN <= N;
    if (inView) {
      kids.push(sv('line', { x1: X(n0), x2: tx, y1: H - B - 10, y2: H - B - 10, class: 'iir-dim' }));
      kids.push(sv('path', { d: `M${X(n0)} ${H - B - 14}v8M${tx} ${H - B - 14}v8`, class: 'iir-dim' }));
      kids.push(sv('line', { x1: tx, x2: tx, y1: ty, y2: H - B - 10, class: 'iir-taul' }));
      const lab = `τ = ${fmtNum(r.tauN, 4)} samples · ${fmtEng(r.tauS, 's')}`;
      kids.push(sv('text', { ...place(tx, lab.length * 7.3, L, W - R), y: ty + 20, class: 'iir-taulab' }, lab));
      const g = sv('g', { class: 'iir-tau', tabindex: 0, role: 'slider', 'data-drag': 'tau', 'aria-label': 'Time constant',
        'aria-valuenow': fmtNum(r.tauN, 4), 'aria-valuetext': lab + '. Arrows change it.' });
      g.append(sv('circle', { cx: tx, cy: ty, r: 16, class: 'iir-hit' }), sv('circle', { cx: tx, cy: ty, r: 7, class: 'iir-knob' }));
      kids.push(g);
    } else {
      kids.push(sv('text', { x: W - R - 4, y: yv(0.3), class: 'iir-lab', 'text-anchor': 'end' }, `τ = ${fmtNum(r.tauN, 4)} samples, past the window`));
    }
    // step marker
    kids.push(sv('path', { d: `M${X(n0)} ${H - B}v6`, class: 'iir-axis' }));
    kids.push(sv('text', { x: X(n0), y: T - 4, class: 'iir-ax', 'text-anchor': 'middle' }, 'step'));
    // noise left over, from the result's variance ratio
    if (R > 60) {
      const bx = W - R + 18;
      const ratio = Math.sqrt(r.nvr);
      kids.push(sv('text', { x: bx - 4, y: yv(1.16), class: 'iir-lab' }, 'RMS noise'));
      if (st.noise) {
        const s = st.noise, sOut = st.noise * ratio;
        kids.push(sv('path', { d: `M${bx} ${yv(1 + s)}h6M${bx + 3} ${yv(1 + s)}V${yv(1 - s)}M${bx} ${yv(1 - s)}h6`, class: 'iir-nin' }));
        kids.push(sv('path', { d: `M${bx + 22} ${yv(1 + sOut)}h6M${bx + 25} ${yv(1 + sOut)}V${yv(1 - sOut)}M${bx + 22} ${yv(1 - sOut)}h6`, class: 'iir-nout' }));
        kids.push(sv('text', { x: bx - 2, y: yv(1 - s) + 14, class: 'iir-ax' }, 'in'));
        kids.push(sv('text', { x: bx + 20, y: yv(1 - s) + 14, class: 'iir-ax' }, 'out'));
      }
      kids.push(sv('text', { x: bx - 4, y: yv(0.62), class: 'iir-lab' }, `× ${fmtNum(ratio, 3)}`));
      kids.push(sv('text', { x: bx - 4, y: yv(0.62) + 14, class: 'iir-ax' }, `σ² × ${fmtNum(r.nvr, 3)}`));
    }
    scopeSvg.replaceChildren(...kids);
    scopeSvg.setAttribute('aria-label', `Step response: 63 % after ${fmtNum(r.tauN, 4)} samples, 99 % after ${q.p99}`);
    scopeCap.textContent = `Input: a unit step${st.noise ? ` with ${st.noise * 100} % white noise` : ''} at fs = ${fmtEng(r.fs, 'Hz')}. Output: y += α (x − y) with α = ${fmtNum(r.alpha, 5)}.`;
  }
  // a label beside x: to the right if it fits, else to the left, else pinned inside [lo, hi]
  function place(x, w, lo, hi, gap = 12) {
    if (x + gap + w <= hi) return { x: x + gap, 'text-anchor': 'start' };
    if (x - gap - w >= lo) return { x: x - gap, 'text-anchor': 'end' };
    return { x: hi, 'text-anchor': 'end' };
  }
  function niceStep(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    const m = v / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  // ------------------------------------------------------------ α ruler
  function drawRuler(r) {
    const W = Math.max(300, Math.round(rulerSvg.clientWidth || ruler.clientWidth - 24 || 800));
    const H = 96;
    rulerSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    rulerSvg.setAttribute('height', H);
    const want = Math.min(-3, Math.floor(Math.log10(r.alpha) - 0.6));
    const lo = st.drag === 'alpha' && st.alphaLo != null ? st.alphaLo : want;
    st.alphaLo = lo;
    const x0 = 16, x1 = W - 16, yb = 58;
    const X = (a) => x0 + ((Math.log10(a) - lo) / (0 - lo)) * (x1 - x0);
    rg = { x0, x1, lo };
    const kids = [];
    // below the Q15 LSB: α rounds to zero there
    const q = 1 / 32768;
    if (q > 10 ** lo) {
      kids.push(sv('rect', { x: x0, y: yb - 14, width: X(q) - x0, height: 14, class: 'iir-q15' }));
      if (X(q) - x0 > 70) kids.push(sv('text', { x: x0 + 4, y: yb - 4, class: 'iir-ax' }, '< 1 LSB of Q15'));
    }
    kids.push(sv('line', { x1: x0, x2: x1, y1: yb, y2: yb, class: 'iir-axis' }));
    for (let d = lo; d <= 0; d++) {
      for (let m = 1; m < 10; m++) {
        const a = m * 10 ** d;
        if (a > 1) break;
        const x = X(a);
        kids.push(sv('line', { x1: x, x2: x, y1: yb, y2: yb + (m === 1 ? 9 : 4), class: 'iir-tick' }));
      }
      kids.push(sv('text', { x: X(10 ** d), y: yb + 22, class: 'iir-ax', 'text-anchor': d === 0 ? 'end' : 'middle' }, d === 0 ? '1' : d >= -2 ? String(10 ** d) : `1e${d}`));
    }
    // right-shift notches
    const every = (x1 - x0) / (-lo / Math.log10(2)) < 22 ? 2 : 1;
    for (const s of r.shifts) {
      if (s.alpha < 10 ** lo) continue;
      const x = X(s.alpha), on = r.mode === 'shift' && s.k === Math.round(ctx.input.k ?? -1);
      const g = sv('g', { class: `iir-notch iir-noclick${on ? ' is-on' : ''}${s.k === r.kNear ? ' is-near' : ''}`, 'data-k': s.k, tabindex: 0, role: 'button',
        'aria-label': `Use right shift ${s.k}: α = 1/${2 ** s.k}${s.f3db != null ? `, −3 dB at ${fmtEng(s.f3db, 'Hz')}` : ''}` });
      g.append(sv('rect', { x: x - 9, y: yb - 38, width: 18, height: 38, class: 'iir-hit' }));
      g.append(sv('path', { d: `M${x} ${yb}V${yb - 12}`, class: 'iir-nl' }));
      if (s.k % every === 0 || on) g.append(sv('text', { x, y: yb - 18, class: 'iir-nt', 'text-anchor': 'middle' }, s.k ? `>>${s.k}` : '1'));
      g.append(sv('title', {}, `>> ${s.k}: α = 1/${2 ** s.k}, −3 dB ${s.f3db != null ? fmtEng(s.f3db, 'Hz') : '–'}. Click to use it.`));
      kids.push(g);
    }
    // the pointer
    const x = X(r.alpha);
    const ptr = sv('g', { class: 'iir-apt', tabindex: 0, role: 'slider', 'data-drag': 'alpha', 'aria-label': 'Coefficient α',
      'aria-valuenow': fmtNum(r.alpha, 5), 'aria-valuetext': `α ${fmtNum(r.alpha, 5)}. Arrows change it, Page Up/Down steps shifts.` });
    ptr.append(sv('rect', { x: x - 12, y: yb - 4, width: 24, height: 40, class: 'iir-hit' }));
    ptr.append(sv('path', { d: `M${x} ${yb + 1}l-8 13h16z`, class: 'iir-knob' }));
    const lab = `α ${fmtNum(r.alpha, 5)}`;
    const anchor = x > W - 70 ? 'end' : x < 70 ? 'start' : 'middle';
    ptr.append(sv('text', { x, y: yb + 34, class: 'iir-alab', 'text-anchor': anchor }, lab));
    kids.push(ptr);
    rulerSvg.replaceChildren(...kids);
  }

  // ------------------------------------------------------------ Bode
  function drawBode(r) {
    const W = Math.max(280, Math.round(bodeSvg.clientWidth || bode.clientWidth - 24 || 500));
    const H = W < 420 ? 250 : 290;
    bodeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    bodeSvg.setAttribute('height', H);
    const ch = r.charts?.[0];
    if (!ch) { bodeSvg.replaceChildren(); return; }
    const fx = ch.x, ema = ch.series[0].y, rc = ch.series[1].y;
    const fN = r.fs / 2;
    const l1 = Math.log10(fN);
    const want = Math.floor(Math.log10(Math.min(fx[0], fN / 1e3)));
    const l0 = st.drag === 'corner' && st.bodeLo != null ? st.bodeLo : want;
    st.bodeLo = l0;
    const L = 42, R = 14, T = 14, B = 36;
    const x0 = L, x1 = W - R;
    const dbMin = Math.min(-40, Math.floor(Math.min(...ema) / 10) * 10);
    const X = (f) => x0 + ((Math.log10(f) - l0) / (l1 - l0)) * (x1 - x0);
    const Y = (db) => T + (db / dbMin) * (H - T - B);
    bg = { x0, x1, l0, l1, fs: r.fs };
    const kids = [];
    // fs/10 and up: the one-pole stops looking like an RC
    if (fN / 5 > 10 ** l0) kids.push(sv('rect', { x: X(r.fs / 10), y: T, width: x1 - X(r.fs / 10), height: H - T - B, class: 'iir-fast' }));
    for (let db = 0; db >= dbMin; db -= 10) {
      kids.push(sv('line', { x1: x0, x2: x1, y1: Y(db), y2: Y(db), class: db ? 'iir-grid' : 'iir-grid0' }));
      kids.push(sv('text', { x: x0 - 5, y: Y(db) + 4, class: 'iir-ax', 'text-anchor': 'end' }, String(db)));
    }
    for (let d = Math.ceil(l0); d <= l1; d++) {
      const x = X(10 ** d);
      kids.push(sv('line', { x1: x, x2: x, y1: T, y2: H - B, class: 'iir-grid' }));
      kids.push(sv('text', { x, y: H - B + 15, class: 'iir-ax', 'text-anchor': 'middle' }, fmtEng(10 ** d, 'Hz')));
    }
    kids.push(sv('text', { x: x0, y: H - 6, class: 'iir-ax iir-ax2' }, 'dB · frequency, log'));
    kids.push(sv('line', { x1: x0, x2: x1, y1: Y(-3), y2: Y(-3), class: 'iir-m3' }));
    kids.push(sv('text', { x: x1 - 6, y: Y(-3) + 14, class: 'iir-ax iir-warnt', 'text-anchor': 'end' }, '−3 dB'));
    const pl = (ys) => fx.map((f, i) => (Math.log10(f) >= l0 ? `${X(f).toFixed(1)},${Y(ys[i]).toFixed(1)}` : null)).filter(Boolean).join(' ');
    kids.push(sv('polyline', { points: pl(rc), class: 'iir-rc' }));
    kids.push(sv('polyline', { points: pl(ema), class: 'iir-ema' }));
    // Nyquist
    kids.push(sv('line', { x1: x1, x2: x1, y1: T, y2: H - B, class: 'iir-nyq' }));
    kids.push(sv('text', { x: x1 - 4, y: H - B - 6, class: 'iir-lab', 'text-anchor': 'end' }, `fs/2 = ${fmtEng(fN, 'Hz')}`));
    const last = ema[ema.length - 1];
    const fy = Y(last) + 16 < H - B - 22 ? Y(last) + 16 : Y(last) - 10;
    kids.push(sv('text', { x: x1 - 4, y: fy, class: 'iir-ax', 'text-anchor': 'end' }, `floor ${fmtNum(last, 3)} dB`));
    // corner
    const fc = r.f3db;
    if (fc != null) {
      const x = X(fc), y = Y(-3);
      kids.push(sv('line', { x1: x, x2: x, y1: y, y2: H - B, class: 'iir-taul' }));
      const lab = `−3 dB at ${fmtEng(fc, 'Hz', 4)}`;
      kids.push(sv('text', { ...place(x, lab.length * 7.3, x0, x1), y: y - 10, class: 'iir-taulab' }, lab));
      const g = sv('g', { class: 'iir-corner', tabindex: 0, role: 'slider', 'data-drag': 'corner', 'aria-label': 'Cutoff frequency',
        'aria-valuenow': sig(fc, 4), 'aria-valuetext': `${lab}. Arrows move it.` });
      g.append(sv('circle', { cx: x, cy: y, r: 16, class: 'iir-hit' }), sv('circle', { cx: x, cy: y, r: 7, class: 'iir-knob' }));
      kids.push(g);
    } else {
      kids.push(sv('text', { x: (x0 + x1) / 2, y: Y(-3) + 18, class: 'iir-badlab', 'text-anchor': 'middle' }, 'never reaches −3 dB below fs/2'));
    }
    if (fN / 5 > 10 ** l0) kids.push(sv('text', { x: X(r.fs / 10) + 4, y: T + 12, class: 'iir-ax iir-warnt' }, '> fs/10'));
    bodeSvg.replaceChildren(...kids);
    bodeSvg.setAttribute('aria-label', `Magnitude response, −3 dB at ${fc != null ? fmtEng(fc, 'Hz') : 'none'}`);
  }
}
