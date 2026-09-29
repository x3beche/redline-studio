// PWM & Dead-time page: the waveforms are the interface.
//   Scope   two PWM periods: the counter (sawtooth or triangle) with the CCR1
//           line - drag it up/down (or focus it, arrows) to set the duty - and
//           OC1 / OC1N below it with the dead bands shaded.
//   Edge    one switching edge magnified: drag the OC1N rising edge (or arrows
//           on it) to set the dead time; it snaps to the DTG steps drawn under it.
//   DTG     the BDTR.DTG byte as eight bits, the range prefix coloured: click a
//           bit to flip it.
// All numbers come from run()'s result (values, wave); the page writes inputs.

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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sig = (v, d = 6) => String(Number(Number(v).toPrecision(d)));
function fmtT(s) {
  const a = Math.abs(s);
  if (a >= 1e-3) return `${sig(s * 1e3, 4)} ms`;
  if (a >= 1e-6) return `${sig(s * 1e6, 4)} µs`;
  return `${sig(s * 1e9, 4)} ns`;
}
// DT in tDTS units for a DTG byte (RM0090 §17.4.18) - the same rule as tool.js.
function dtgTicks(d) {
  if ((d & 0x80) === 0) return d;
  if ((d & 0xc0) === 0x80) return (64 + (d & 0x3f)) * 2;
  if ((d & 0xe0) === 0xc0) return (32 + (d & 0x1f)) * 8;
  return (32 + (d & 0x1f)) * 16;
}
const PRESETS = [['F103 TIM1', '72M'], ['F407 TIM1', '168M'], ['G474 TIM1', '170M'], ['H743 TIM1', '240M']];

export function page(root, ctx) {
  let res = null;
  const st = { drag: null };

  // ---------- controls ----------
  const field = (key, label, unit, attrs = {}) => {
    const inp = h('input', { class: 'pw-in', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'data-key': key, 'aria-label': label, ...attrs,
      onchange: (e) => ctx.set(key, e.target.value) });
    return h('label', { class: 'pw-field' }, h('span', {}, label), h('div', { class: 'pw-inrow' }, inp, unit ? h('small', {}, unit) : null));
  };
  const seg = (key, opts, label) => h('div', { class: 'pw-seg', role: 'group', 'aria-label': label, 'data-seg': key },
    opts.map(([v, t]) => h('button', { 'data-v': v, onclick: () => ctx.set(key, v) }, t)));
  const presetRow = h('div', { class: 'pw-presets' }, PRESETS.map(([t, v]) => h('button', { class: 'pw-chip', 'data-clk': v, onclick: () => ctx.set('fclk', v) }, `${t} ${v}Hz`)));
  const compBox = h('input', { type: 'checkbox', id: 'pw-comp', onchange: (e) => ctx.set('complementary', e.target.checked) });
  const suggBox = h('input', { type: 'checkbox', id: 'pw-sugg', onchange: (e) => ctx.set('suggest', e.target.checked) });
  const suggFields = h('div', { class: 'pw-grid4' },
    field('tdoff', 'td(off) max', 'ns'), field('tdon', 'td(on) min', 'ns'), field('tpdmax', 'driver tpd max', 'ns'), field('tpdmin', 'driver tpd min', 'ns'));
  const controls = h('section', { class: 'pw-card pw-ctl' },
    h('div', { class: 'pw-head' }, h('h2', {}, 'Timer')),
    h('div', { class: 'pw-body' },
      h('div', { class: 'pw-grid2' }, field('fclk', 'Timer clock', 'Hz'), field('freq', 'PWM frequency', 'Hz')),
      presetRow,
      h('div', { class: 'pw-grid2' }, field('duty', 'Duty', '%'), field('deadtime', 'Dead time', 'ns')),
      h('div', { class: 'pw-segrow' }, h('span', {}, 'Alignment'), seg('mode', [['center', 'Center'], ['edge', 'Edge']], 'Alignment')),
      h('div', { class: 'pw-segrow' }, h('span', {}, 'CKD'), seg('ckd', [['auto', 'Auto'], ['1', '/1'], ['2', '/2'], ['4', '/4']], 'Clock division')),
      h('div', { class: 'pw-segrow' }, h('span', {}, 'Counter'), seg('width', [['16', '16-bit'], ['32', '32-bit']], 'Counter width')),
      h('div', { class: 'pw-grid2' }, field('psc', 'PSC (empty = best)', '', { placeholder: 'auto' }),
        h('label', { class: 'pw-chk', for: 'pw-comp' }, compBox, 'Complementary OC1N')),
      h('label', { class: 'pw-chk', for: 'pw-sugg' }, suggBox, 'Suggest dead time from switch timings (AN2007-04)'),
      suggFields));

  const dtgCard = h('section', { class: 'pw-card' }, h('div', { class: 'pw-head' }, h('h2', {}, 'BDTR.DTG'), h('span', { class: 'pw-sub', id: 'pw-dtgsub' })),
    h('div', { class: 'pw-dtg', id: 'pw-dtg' }), h('div', { class: 'pw-dtgfoot', id: 'pw-dtgfoot' }));
  const altCard = h('section', { class: 'pw-card' }, h('div', { class: 'pw-head' }, h('h2', {}, 'Nearby PSC / ARR'), h('span', { class: 'pw-sub' }, 'click to use')),
    h('div', { class: 'pw-alts', id: 'pw-alts' }));

  const readout = h('div', { class: 'pw-read' });
  const warnBox = h('div', { class: 'pw-warns', 'aria-live': 'polite' });
  const scope = sv('svg', { class: 'pw-svg pw-scope', viewBox: '0 0 1000 380', role: 'img', 'aria-label': 'PWM waveforms' });
  const zoom = sv('svg', { class: 'pw-svg', viewBox: '0 0 520 300', role: 'img', 'aria-label': 'Dead time at one switching edge' });
  const scopeCard = h('section', { class: 'pw-card' }, h('div', { class: 'pw-head' }, h('h2', {}, 'Two periods'), h('span', { class: 'pw-sub', id: 'pw-scopesub' })),
    h('div', { class: 'pw-draw' }, scope));
  const zoomCard = h('section', { class: 'pw-card' }, h('div', { class: 'pw-head' }, h('h2', {}, 'Switching edge'), h('span', { class: 'pw-sub', id: 'pw-zoomsub' })),
    h('div', { class: 'pw-draw' }, zoom));
  const noteBox = h('div', { class: 'pw-notes' });

  root.append(h('div', { class: 'pw' },
    h('div', { class: 'pw-main' }, readout, warnBox, scopeCard, h('div', { class: 'pw-row2' }, zoomCard, dtgCard), noteBox),
    h('div', { class: 'pw-side' }, controls, altCard, ctx.outputs)));

  // ---------- drag plumbing ----------
  const toSvg = (svg, e) => {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  // Drags are held by the (persistent) svg, so redrawing the handle mid-drag is harmless;
  // the move maps through whatever the latest drawing registered in st.map.
  st.map = {};
  for (const svg of [scope, zoom]) {
    svg.addEventListener('pointermove', (e) => { if (st.drag?.svg === svg) st.map[st.drag.kind]?.(toSvg(svg, e)); });
    const end = () => { if (st.drag?.svg === svg) { st.drag = null; st.zspan = null; draw(); } };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  }
  function dragger(svg, el, kind, onMove) {
    st.map[kind] = onMove;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); svg.setPointerCapture(e.pointerId); st.drag = { svg, kind }; el.focus();
      if (kind === 'dt') st.zspan = st.curSpan;
    });
    if (st.drag?.kind === kind) el.classList.add('on');
  }

  // ---------- scope ----------
  function drawScope(w) {
    scope.replaceChildren();
    const L = 92, R = 976, T2 = 2 * w.T;
    const X = (t) => L + (t / T2) * (R - L);
    const cy0 = 138, cy1 = 22; // counter lane: value 0 at cy0, ARR at cy1
    const Yc = (c) => cy0 - (c / w.arr) * (cy0 - cy1);
    const lanes = [{ name: 'OC1', sub: 'high side', y: 190, list: w.hi, cls: 'hi' }, { name: 'OC1N', sub: 'low side', y: 282, list: w.lo, cls: 'lo' }];
    const LH = 52;
    // grid + time axis
    for (let k = 0; k <= 8; k++) {
      const t = (k / 8) * T2;
      scope.append(sv('line', { x1: X(t), x2: X(t), y1: 14, y2: 350, class: k % 4 ? 'g' : 'g2' }));
      scope.append(sv('text', { x: X(t), y: 368, class: 'ax', 'text-anchor': 'middle' }, fmtT(t)));
    }
    // dead bands: where neither output is on, inside a switching gap
    if (w.comp && w.dt > 0) {
      const edges = [];
      for (const [a, b] of w.ref) { if (a > 1e-15) edges.push(a); if (b < T2 - 1e-15) edges.push(b); }
      edges.forEach((t0, i) => {
        const x0 = X(t0), x1 = Math.max(X(t0 + w.dt), x0 + 2);
        scope.append(sv('rect', { x: x0, y: 160, width: x1 - x0, height: 176, class: 'band' }));
        if (i === 0) scope.append(sv('text', { x: x1 + 4, y: 172, class: 'bl' }, `DT ${sig(w.dt * 1e9, 4)} ns`));
      });
    }
    // counter
    let d = '';
    for (let k = 0; k < 2; k++) {
      const t0 = k * w.T;
      if (w.center) d += `${k ? 'L' : 'M'}${X(t0)},${Yc(w.arr)} L${X(t0 + w.T / 2)},${Yc(0)} L${X(t0 + w.T)},${Yc(w.arr)} `;
      else d += `M${X(t0)},${Yc(0)} L${X(t0 + w.T)},${Yc(w.arr)} L${X(t0 + w.T)},${Yc(0)} `;
    }
    scope.append(sv('path', { d, class: 'cnt' }));
    scope.append(sv('text', { x: L - 8, y: cy1 + 4, class: 'lab', 'text-anchor': 'end' }, `ARR ${w.arr}`));
    scope.append(sv('text', { x: L - 8, y: cy0 + 4, class: 'lab', 'text-anchor': 'end' }, '0'));
    // CCR line: the duty handle
    const yC = Yc(Math.min(w.ccr, w.arr));
    scope.append(sv('line', { x1: L, x2: R, y1: yC, y2: yC, class: 'ccr' }));
    const hnd = sv('g', { class: 'hnd', tabindex: '0', role: 'slider', 'aria-label': 'Duty (CCR1). Arrow keys: one step, Shift: 1 %',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(w.ccr / w.steps * 100)) });
    hnd.append(sv('rect', { x: 4, y: yC - 11, width: 84, height: 22, rx: 4 }), sv('text', { x: 46, y: yC + 4, 'text-anchor': 'middle' }, `CCR1 ${w.ccr}`));
    hnd.append(sv('rect', { x: L, y: yC - 8, width: R - L, height: 16, class: 'hit' }));
    scope.append(hnd);
    // The shortest duty text that still lands on this CCR.
    const setDuty = (ccr) => {
      const c = clamp(ccr, 0, w.steps);
      let txt = sig(c / w.steps * 100, 7);
      for (let d = 0; d <= 5; d++) { const t = (c / w.steps * 100).toFixed(d); if (Math.round(Number(t) / 100 * w.steps) === c) { txt = String(Number(t)); break; } }
      ctx.set('duty', txt);
    };
    dragger(scope, hnd, 'duty', (p) => setDuty(Math.round(((cy0 - clamp(p.y, cy1, cy0)) / (cy0 - cy1)) * w.arr * (w.steps / w.arr))));
    hnd.addEventListener('keydown', (e) => {
      const stp = e.shiftKey ? Math.max(1, Math.round(w.steps / 100)) : 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); st.focus = 'duty'; setDuty(w.ccr + stp); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); st.focus = 'duty'; setDuty(w.ccr - stp); }
    });
    // outputs
    for (const ln of lanes) {
      scope.append(sv('text', { x: L - 8, y: ln.y - LH / 2 + 2, class: 'ln', 'text-anchor': 'end' }, ln.name));
      scope.append(sv('text', { x: L - 8, y: ln.y - LH / 2 + 15, class: 'lab', 'text-anchor': 'end' }, ln.sub));
      let p = `M${X(0)},${ln.y}`;
      for (const [a, b] of ln.list) p += ` L${X(a)},${ln.y} L${X(a)},${ln.y - LH} L${X(b)},${ln.y - LH} L${X(b)},${ln.y}`;
      p += ` L${X(T2)},${ln.y}`;
      scope.append(sv('path', { d: p, class: `trace ${ln.cls}` }));
      if (ln.cls === 'lo' && !w.comp) scope.append(sv('text', { x: (L + R) / 2, y: ln.y - 20, class: 'lab', 'text-anchor': 'middle' }, 'complementary output off'));
    }
    root.querySelector('#pw-scopesub').textContent = `period ${fmtT(w.T)} · ${w.center ? 'center' : 'edge'}-aligned · drag the CCR1 line for duty`;
  }

  // ---------- edge zoom ----------
  function drawZoom(w) {
    zoom.replaceChildren();
    const edge = w.ref.find(([, b]) => b < 2 * w.T - 1e-15)?.[1];
    if (!w.comp || edge == null) {
      zoom.append(sv('text', { x: 260, y: 150, class: 'lab', 'text-anchor': 'middle' }, w.comp ? 'no switching edge at 0 % or 100 % duty' : 'dead time applies to complementary outputs only'));
      root.querySelector('#pw-zoomsub').textContent = '';
      return;
    }
    const span = st.zspan || Math.max(w.dt, w.dtReq, w.suggest || 0, 20 * w.tdts) * 1.9;
    st.curSpan = span;
    const t0 = edge - span * 0.35, t1 = edge + span;
    const L = 70, R = 505;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
    const tOf = (x) => t0 + ((x - L) / (R - L)) * (t1 - t0);
    const rows = [{ n: 'ref', y: 62, on: (t) => t < edge, cls: 'ref' }, { n: 'OC1', y: 142, on: (t) => t < edge, cls: 'hi' }, { n: 'OC1N', y: 222, on: (t) => t >= edge + w.dt, cls: 'lo' }];
    // step ticks of the DTG (the values the dead time can take)
    const band = [X(edge), X(edge + w.dt)];
    zoom.append(sv('rect', { x: band[0], y: 76, width: Math.max(1, band[1] - band[0]), height: 160, class: 'band' }));
    const stepS = [1, 2, 8, 16][w.range] * w.tdts;
    let lastX = -9;
    for (let d = 0; d < 256; d++) {
      const x = X(edge + dtgTicks(d) * w.tdts);
      if (x > R) break;
      if (x - lastX < 3) continue;
      lastX = x;
      zoom.append(sv('line', { x1: x, x2: x, y1: 246, y2: d === w.dtg ? 258 : 252, class: d === w.dtg ? 'tick cur' : 'tick' }));
    }
    zoom.append(sv('text', { x: L, y: 272, class: 'lab' }, `DTG steps of ${sig(stepS * 1e9, 4)} ns in this range`));
    for (const r of rows) {
      const LH = 38;
      zoom.append(sv('text', { x: L - 8, y: r.y - 12, class: 'ln', 'text-anchor': 'end' }, r.n));
      const xa = X(t0), xb = X(t1);
      let d;
      if (r.cls === 'lo') d = `M${xa},${r.y} L${X(edge + w.dt)},${r.y} L${X(edge + w.dt)},${r.y - LH} L${xb},${r.y - LH}`;
      else d = `M${xa},${r.y - LH} L${X(edge)},${r.y - LH} L${X(edge)},${r.y} L${xb},${r.y}`;
      zoom.append(sv('path', { d, class: `trace ${r.cls}` }));
    }
    if (w.suggest != null) {
      const xs = X(edge + w.suggest);
      zoom.append(sv('line', { x1: xs, x2: xs, y1: 70, y2: 240, class: `sug${w.dt < w.suggest ? ' bad' : ''}` }));
      zoom.append(sv('text', { x: xs + 3, y: 84, class: `lab${w.dt < w.suggest ? ' badt' : ''}` }, `needed ${sig(w.suggest * 1e9, 4)} ns`));
    }
    zoom.append(sv('text', { x: (band[0] + band[1]) / 2, y: 290, class: 'bl', 'text-anchor': 'middle' }, `${sig(w.dt * 1e9, 5)} ns`));
    // the handle: OC1N's rising edge
    const xh = X(edge + w.dt);
    const hnd = sv('g', { class: 'hnd v', tabindex: '0', role: 'slider', 'aria-label': 'Dead time. Arrow keys: one DTG step',
      'aria-valuenow': sig(w.dt * 1e9, 5) });
    hnd.append(sv('rect', { x: xh - 9, y: 170, width: 18, height: 60, class: 'hit' }), sv('rect', { x: xh - 4, y: 184, width: 8, height: 32, rx: 3 }));
    zoom.append(hnd);
    const setDtg = (d) => ctx.setMany({ deadtime: sig(dtgTicks(clamp(d, 0, 255)) * w.tdts * 1e9, 7), ckd: String([1, 2, 4][w.ckd]) });
    dragger(zoom, hnd, 'dt', (p) => {
      const want = Math.max(0, tOf(clamp(p.x, L, R)) - edge);
      ctx.set('deadtime', sig(want * 1e9, 5));
    });
    hnd.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); st.focus = 'dt'; setDtg(w.dtg + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); st.focus = 'dt'; setDtg(w.dtg - 1); }
    });
    root.querySelector('#pw-zoomsub').textContent = 'drag the OC1N edge to set the dead time';
  }

  // ---------- DTG bits ----------
  function drawDtg(w) {
    const box = root.querySelector('#pw-dtg');
    box.replaceChildren();
    const prefix = [1, 2, 3, 3][w.range]; // bits that select the range
    for (let b = 7; b >= 0; b--) {
      const on = (w.dtg >> b) & 1;
      const isPre = b >= 8 - prefix;
      box.append(h('button', { class: `pw-bit${on ? ' on' : ''}${isPre ? ' pre' : ''}`, 'aria-pressed': String(!!on), 'aria-label': `DTG bit ${b}`,
        title: `DTG[${b}]${isPre ? ' - range select' : ''}`,
        onclick: () => { st.focus = `bit${b}`; ctx.setMany({ deadtime: sig(dtgTicks(w.dtg ^ (1 << b)) * w.tdts * 1e9, 7), ckd: String([1, 2, 4][w.ckd]) }); },
        'data-bit': String(b) }, h('small', {}, String(b)), h('b', {}, String(on))));
    }
    const formula = [`DTG x tDTS = ${w.dtg} x`, `(64 + ${w.dtg & 0x3f}) x 2 x`, `(32 + ${w.dtg & 0x1f}) x 8 x`, `(32 + ${w.dtg & 0x1f}) x 16 x`][w.range];
    root.querySelector('#pw-dtgsub').textContent = `0x${w.dtg.toString(16).toUpperCase().padStart(2, '0')} · CKD /${[1, 2, 4][w.ckd]}`;
    root.querySelector('#pw-dtgfoot').replaceChildren(
      h('div', { class: 'pw-form' }, `${formula} ${sig(w.tdts * 1e9, 4)} ns = `, h('b', {}, `${sig(dtgTicks(w.dtg) * w.tdts * 1e9, 5)} ns`)),
      h('div', { class: 'pw-sub' }, `range ${w.range}: DTG[7:5] = ${['0xx', '10x', '110', '111'][w.range]} · longest ${sig(1008 * w.tdts * 1e9, 4)} ns · click a bit to flip it`));
  }

  function drawAlts(w) {
    const box = root.querySelector('#pw-alts');
    box.replaceChildren(h('div', { class: 'pw-altrow pw-alth' }, h('span', {}, 'PSC'), h('span', {}, 'ARR'), h('span', {}, 'frequency'), h('span', {}, 'error'), h('span', {}, 'bits')),
      ...w.alts.map((a) => h('button', { class: `pw-altrow${a.psc === w.psc && a.arr === w.arr ? ' cur' : ''}`, onclick: () => ctx.set('psc', String(a.psc)) },
        h('span', {}, String(a.psc)), h('span', {}, String(a.arr)), h('span', {}, `${sig(a.f, 7)} Hz`), h('span', {}, `${sig(a.err, 3)} %`), h('span', {}, sig(a.bits, 3)))));
    if (ctx.raw.psc !== '' && ctx.raw.psc != null) box.append(h('button', { class: 'k-btn pw-auto', onclick: () => ctx.set('psc', '') }, 'Back to the best PSC'));
  }

  function draw() {
    if (!res) return;
    const raw = ctx.raw;
    for (const inp of root.querySelectorAll('input.pw-in')) if (document.activeElement !== inp) inp.value = raw[inp.dataset.key] ?? '';
    for (const s of root.querySelectorAll('.pw-seg')) for (const b of s.children) b.setAttribute('aria-pressed', String(String(raw[s.dataset.seg]) === b.dataset.v));
    for (const c of presetRow.children) c.setAttribute('aria-pressed', String(String(raw.fclk) === c.dataset.clk));
    compBox.checked = raw.complementary !== false; suggBox.checked = !!raw.suggest;
    suggFields.hidden = !raw.suggest;
    readout.replaceChildren(...(res.values || []).map((v) => h('div', { class: `pw-v${v.tone ? ` t-${v.tone}` : ''}` },
      h('span', {}, v.label), h('b', {}, String(v.value)), v.hint ? h('em', {}, v.hint) : null)));
    warnBox.replaceChildren(...(res.warnings || []).map((x) => h('div', {}, x)));
    noteBox.replaceChildren(...(res.notes || []).map((x) => h('div', {}, x)));
    const w = res.wave;
    if (!w) { scope.replaceChildren(); zoom.replaceChildren(); return; }
    drawScope(w); drawZoom(w); drawDtg(w); drawAlts(w);
    if (st.focus) {
      const sel = st.focus === 'duty' ? scope.querySelector('.hnd') : st.focus === 'dt' ? zoom.querySelector('.hnd') : root.querySelector(`.pw-bit[data-bit="${st.focus.slice(3)}"]`);
      st.focus = null; sel?.focus();
    }
  }
  ctx.onResult((r) => { res = r; draw(); });
}
