// Motor Driver Current Limit, custom page: the driver board and the coil current.
//
// Left, the driver carrier as it sits on the bench: the chip, the sense
// resistors and the VREF trimpot with a meter probe on its wiper. Turn the
// trimpot (drag round it, or focus it and use the arrows) and the meter reads
// the VREF you set; the current follows. Click the sense resistors' arrows to
// swap them for another common value. Right, the coil current over one
// electrical cycle: the chopper limit is a line you drag up or down (that
// solves for VREF instead), with the RMS and full-step levels, the motor's
// rating (draggable too), and the driver's limits as shaded bands. VREF for
// other currents sits on the right-hand axis.
//
// Every number drawn is from run()'s result.motor (and result.values).
import { fmtEng, fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
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
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const A = (v) => fmtEng(v, 'A');
const V = (v) => `${fmtNum(v, 3)} V`;

const DRIVERS = [
  ['a4988', 'A4988', 'stepper'], ['drv8825', 'DRV8825', 'stepper'], ['tmc22xx', 'TMC2208/09', 'stepper'],
  ['a4950', 'A4950', 'brushed DC'], ['drv8870', 'DRV8870', 'brushed DC'], ['custom', 'Other', 'gain × Rs'],
];
const RS = [0.05, 0.068, 0.1, 0.11, 0.15, 0.2, 0.22, 0.25, 0.33, 0.5];
// resistor marking: 0.068 -> R068, 0.11 -> R110, 1.5 -> 1R50
const marking = (r) => (r < 1 ? 'R' + String(Math.round(r * 1000)).padStart(3, '0') : String(r.toFixed(2)).replace('.', 'R'));

export function page(root, ctx) {
  const st = { yMax: null, vMax: null, drag: null, focus: null };

  // ------------------------------------------------------------ band
  const drvSeg = h('div', { class: 'mc-drivers', role: 'radiogroup', 'aria-label': 'Driver' });
  const solveSeg = h('div', { class: 'mc-seg', role: 'radiogroup', 'aria-label': 'Solve for' });
  const kindSeg = h('div', { class: 'mc-seg', role: 'radiogroup', 'aria-label': 'Currents are given as' });
  const extra = h('div', { class: 'mc-extra' });
  const band = h('div', { class: 'mc-band' }, drvSeg,
    h('div', { class: 'mc-bgroup' }, h('span', { class: 'mc-cap' }, 'Set by'), solveSeg),
    h('div', { class: 'mc-bgroup' }, h('span', { class: 'mc-cap' }, 'Currents as'), kindSeg), extra);

  const boardHead = h('div', { class: 'mc-phead' });
  const board = h('div', { class: 'mc-board' });
  const boardPanel = h('section', { class: 'mc-panel mc-boardpanel' }, boardHead, board);
  const scopeHead = h('div', { class: 'mc-phead' });
  const scope = h('div', { class: 'mc-scope' });
  const scopePanel = h('section', { class: 'mc-panel mc-scopepanel' }, scopeHead, scope);
  const warns = h('div', { class: 'mc-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'mc-notes' });
  root.append(h('div', { class: 'mc-page' }, band, boardPanel, scopePanel,
    h('div', { class: 'mc-foot' }, warns, notes), h('div', { class: 'mc-out' }, ctx.outputs)));

  // ------------------------------------------------------------ inputs
  const raw = () => ctx.raw;
  function setVref(v) { ctx.setMany({ mode: 'current', vref: String(Math.max(0, Math.round(v * 1000) / 1000)) }); }
  function setPeak(ipk, m) {
    ipk = Math.max(0.01, Math.round(ipk * 100) / 100);
    const given = m.stepper && m.kind === 'rms' ? ipk / Math.SQRT2 : ipk;
    ctx.setMany({ mode: 'vref', iset: String(Math.round(given * 1000) / 1000) });
  }
  function stepRs(d, m) {
    const i = RS.findIndex((r) => r >= m.rs - 1e-9);
    let j;
    if (i < 0) j = d < 0 ? RS.length - 1 : RS.length - 1;
    else if (Math.abs(RS[i] - m.rs) < 1e-9) j = i + d;
    else j = d > 0 ? i : i - 1;
    j = Math.max(0, Math.min(RS.length - 1, j));
    ctx.set('rs', String(RS[j]));
  }

  function drawBand(m) {
    const r = raw();
    const opt = (cur, value, label, sub, fn) => h('button', { class: `mc-opt${String(cur) === String(value) ? ' is-on' : ''}`, role: 'radio',
      'aria-checked': String(String(cur) === String(value)), onclick: fn }, h('b', {}, label), sub ? h('small', {}, sub) : null);
    drvSeg.replaceChildren(...DRIVERS.map(([v, l, s]) => opt(r.driver, v, l, s, () => { st.yMax = null; ctx.set('driver', v); })));
    solveSeg.replaceChildren(opt(r.mode, 'current', 'Trimpot', 'current from VREF', () => ctx.set('mode', 'current')),
      opt(r.mode, 'vref', 'Current', 'VREF from current', () => ctx.set('mode', 'vref')));
    kindSeg.replaceChildren(opt(r.kind, 'peak', 'Peak', 'chopper limit', () => ctx.set('kind', 'peak')),
      opt(r.kind, 'rms', 'RMS', 'per coil', () => ctx.set('kind', 'rms')));
    const kids = [];
    if (r.driver === 'custom') {
      const g = h('input', { type: 'text', class: 'mc-num', 'aria-label': 'Gain, VREF over sense voltage', onchange: (e) => ctx.set('gain', e.target.value) });
      g.value = r.gain ?? '';
      kids.push(h('label', { class: 'mc-bgroup' }, h('span', { class: 'mc-cap' }, 'Gain'), g));
    }
    if (r.driver === 'tmc22xx') kids.push(h('div', { class: 'mc-bgroup' }, h('span', { class: 'mc-cap' }, 'vsense'),
      h('div', { class: 'mc-seg', role: 'radiogroup', 'aria-label': 'TMC sense range' },
        opt(r.vsense, '0', '325 mV', 'default', () => ctx.set('vsense', '0')), opt(r.vsense, '1', '180 mV', 'vsense=1', () => ctx.set('vsense', '1')))));
    extra.replaceChildren(...kids);
  }

  // ------------------------------------------------------------ the board
  function drawBoard(m, res) {
    const W = 440, H = 440;
    const over = m.vrefMax != null && m.vref > m.vrefMax;
    const vsOver = m.vsMax != null && m.vsense > m.vsMax;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mc-bsvg', role: 'group', 'aria-label': `${m.name} driver board` });
    // the carrier
    const bx = 70, by = 70, bw = 250, bh = 300;
    svg.append(sv('rect', { x: bx, y: by, width: bw, height: bh, rx: 10, class: 'mc-pcb' }));
    for (let k = 0; k < 8; k++) {
      for (const x of [bx + 16, bx + bw - 16]) {
        svg.append(sv('circle', { cx: x, cy: by + 36 + k * 33, r: 9, class: 'mc-pad' }));
        svg.append(sv('circle', { cx: x, cy: by + 36 + k * 33, r: 4, class: 'mc-hole' }));
      }
    }
    // coil outputs on the right header (stepper) / motor outputs (DC)
    const outs = m.stepper ? ['2B', '2A', '1A', '1B'] : ['OUT2', 'OUT1'];
    outs.forEach((t, k) => svg.append(sv('text', { x: bx + bw + 4, y: by + 36 + (k + 2) * 33 + 4, class: 'mc-pin' }, t)));
    svg.append(sv('text', { x: bx + bw + 4, y: by + 36 + 4, class: 'mc-pin' }, m.stepper ? 'VMOT' : 'VM'));
    svg.append(sv('text', { x: bx + bw + 4, y: by + 36 + 33 + 4, class: 'mc-pin' }, 'GND'));
    // the driver chip
    const cx = bx + bw / 2 + 6, cy = by + 196, cs = 78;
    svg.append(sv('rect', { x: cx - cs / 2, y: cy - cs / 2, width: cs, height: cs, rx: 4, class: 'mc-chip' }));
    for (let k = 0; k < 6; k++) for (const s of [-1, 1]) {
      svg.append(sv('rect', { x: cx - cs / 2 + 10 + k * 11, y: s < 0 ? cy - cs / 2 - 6 : cy + cs / 2 + 1, width: 6, height: 5, class: 'mc-lead' }));
      svg.append(sv('rect', { x: s < 0 ? cx - cs / 2 - 6 : cx + cs / 2 + 1, y: cy - cs / 2 + 10 + k * 11, width: 5, height: 6, class: 'mc-lead' }));
    }
    svg.append(sv('circle', { cx: cx - cs / 2 + 9, cy: cy - cs / 2 + 9, r: 2.5, class: 'mc-dot' }));
    const chipName = m.name.replace('custom driver', 'driver');
    chipName.split('/').forEach((t, k, all) => svg.append(sv('text', { x: cx, y: cy + 5 + (k - (all.length - 1) / 2) * 15, class: 'mc-chipname', 'text-anchor': 'middle' }, (k ? '/' : '') + t)));

    // sense resistors, under the chip
    const ry = by + bh - 42;
    const rsG = sv('g', { class: `mc-rs${vsOver ? ' is-bad' : ''}` });
    for (const x of [cx - 52, cx + 8]) {
      rsG.append(sv('rect', { x, y: ry, width: 44, height: 22, rx: 2, class: 'mc-res' }));
      rsG.append(sv('rect', { x, y: ry, width: 8, height: 22, class: 'mc-term' }));
      rsG.append(sv('rect', { x: x + 36, y: ry, width: 8, height: 22, class: 'mc-term' }));
      rsG.append(sv('text', { x: x + 22, y: ry + 15, class: 'mc-mark', 'text-anchor': 'middle' }, marking(m.rs)));
    }
    svg.append(rsG);
    // resistor callout and its stepper
    const ly = ry + 42;
    svg.append(sv('path', { d: `M${cx - 30} ${ry + 22} V${ly - 2}`, class: 'mc-leader' }));
    const rsBox = sv('g', { class: 'mc-rsbox' });
    const btn = (x, dir, label) => {
      const g = sv('g', { class: 'mc-step', tabindex: 0, role: 'button', 'aria-label': `${label} sense resistor` });
      g.append(sv('rect', { x, y: ly, width: 24, height: 24, rx: 4, class: 'mc-stepbg' }));
      g.append(sv('path', { d: dir < 0 ? `M${x + 15} ${ly + 7} l-6 5 6 5` : `M${x + 9} ${ly + 7} l6 5 -6 5`, class: 'mc-steparrow' }));
      g.addEventListener('click', () => stepRs(dir, m));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.focus = dir < 0 ? 0 : 1; stepRs(dir, m); } });
      return g;
    };
    rsBox.append(btn(cx - 118, -1, 'Smaller'));
    rsBox.append(sv('text', { x: cx - 30, y: ly + 17, class: 'mc-rsval', 'text-anchor': 'middle' }, `Rs ${fmtEng(m.rs, 'Ω')}`));
    rsBox.append(btn(cx + 34, 1, 'Larger'));
    svg.append(rsBox);
    svg.append(sv('text', { x: cx - 30, y: ly + 42, class: `mc-sub mc-big${vsOver ? ' is-bad' : ''}`, 'text-anchor': 'middle' },
      `sense ${fmtEng(m.vsense, 'V')} at the limit${m.vsMax ? ` · max ${fmtEng(m.vsMax, 'V')}` : ''}`));
    svg.append(sv('text', { x: cx - 30, y: ly + 58, class: 'mc-sub mc-big', 'text-anchor': 'middle' },
      `${fmtEng(m.prs, 'W')} in Rs · use a ≥ ${fmtEng(m.prsRating, 'W')} part`));

    // the trimpot, a meter on its wiper
    const tx = bx + 92, ty = by + 76, tr = 34;
    const vMax = st.drag === 'knob' && st.vMax ? st.vMax : (m.vrefMax ?? Math.max(3.3, Math.ceil(m.vref * 1.3 * 2) / 2));
    const vTop = st.drag === 'knob' && st.vMax ? st.vMax : vMax * 1.15;
    st.vScale = vTop;
    const a0 = -225, a1 = 45; // degrees from +x, clockwise on screen
    const ang = (v) => (a0 + (Math.max(0, Math.min(vTop, v)) / vTop) * (a1 - a0)) * Math.PI / 180;
    const pt = (v, r) => [tx + r * Math.cos(ang(v)), ty + r * Math.sin(ang(v))];
    const arc = (v1, v2, r) => { const [x1, y1] = pt(v1, r), [x2, y2] = pt(v2, r); const large = ((v2 - v1) / vTop) * 270 > 180 ? 1 : 0; return `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}`; };
    const R = tr + 16;
    svg.append(sv('path', { d: arc(0, vTop, R), class: 'mc-arc' }));
    if (m.vrefMax) svg.append(sv('path', { d: arc(m.vrefMax, vTop, R), class: 'mc-arc-bad' }));
    svg.append(sv('path', { d: arc(0, m.vref, R), class: `mc-arc-on${over ? ' is-bad' : ''}` }));
    const tstep = vTop > 4 ? 1 : vTop > 2 ? 0.5 : 0.25;
    for (let v = 0; v <= vTop + 1e-9; v += tstep) {
      const [x1, y1] = pt(v, R + 4), [x2, y2] = pt(v, R + 9), [x3, y3] = pt(v, R + 18);
      svg.append(sv('line', { x1, y1, x2, y2, class: 'mc-tickl' }));
      if (Math.abs(v - Math.round(v)) < 1e-9 || tstep >= 0.5 && vTop <= 3) svg.append(sv('text', { x: x3, y: y3 + 3.5, class: 'mc-tick', 'text-anchor': 'middle' }, fmtNum(v, 2)));
    }
    const knob = sv('g', { class: `mc-knob${st.drag === 'knob' ? ' is-drag' : ''}`, tabindex: 0, role: 'slider',
      'aria-label': 'VREF trimpot', 'aria-valuemin': 0, 'aria-valuemax': fmtNum(vTop, 3), 'aria-valuenow': fmtNum(m.vref, 3), 'aria-valuetext': V(m.vref) });
    knob.append(sv('circle', { cx: tx, cy: ty, r: tr + 12, class: 'mc-knobhit' }));
    knob.append(sv('rect', { x: tx - tr - 4, y: ty - tr - 4, width: 2 * tr + 8, height: 2 * tr + 8, rx: 6, class: 'mc-potbody' }));
    knob.append(sv('circle', { cx: tx, cy: ty, r: tr, class: 'mc-pot' }));
    const [sx, sy] = pt(m.vref, tr - 5), [ex, ey] = [2 * tx - sx, 2 * ty - sy];
    knob.append(sv('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: 'mc-slot' }));
    knob.append(sv('circle', { cx: sx, cy: sy, r: 3.5, class: 'mc-slotdot' }));
    knob.addEventListener('pointerdown', (e) => startKnob(e, m, tx, ty, a0, a1));
    knob.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (!d) return;
      e.preventDefault(); st.focus = 'knob';
      setVref(m.vref + d * (e.shiftKey ? 0.1 : 0.01));
    });
    svg.append(knob);
    svg.append(sv('text', { x: tx, y: ty + tr + 36, class: 'mc-cap2', 'text-anchor': 'middle' }, 'VREF trimpot'));

    // the meter: probe on the wiper, reading VREF
    const mx = 300, my = 16, mw = 132, mh = 72;
    svg.append(sv('path', { d: `M${mx + 8} ${my + mh} C${mx - 30} ${my + mh + 40} ${tx + 60} ${ty - 30} ${tx + 4} ${ty - 2}`, class: 'mc-probe' }));
    svg.append(sv('circle', { cx: tx + 2, cy: ty - 1, r: 3, class: 'mc-probetip' }));
    svg.append(sv('rect', { x: mx, y: my, width: mw, height: mh, rx: 6, class: 'mc-meter' }));
    svg.append(sv('rect', { x: mx + 8, y: my + 8, width: mw - 16, height: 38, rx: 3, class: `mc-lcd${over || m.clipped ? ' is-bad' : ''}` }));
    svg.append(sv('text', { x: mx + mw - 14, y: my + 36, class: 'mc-lcdtext', 'text-anchor': 'end' }, fmtNum(m.vref, 3)));
    svg.append(sv('text', { x: mx + 14, y: my + 22, class: 'mc-lcdunit' }, 'V'));
    svg.append(sv('text', { x: mx + mw / 2, y: my + 62, class: `mc-sub${over ? ' is-bad' : ''}`, 'text-anchor': 'middle' },
      m.vrefMax ? `VREF · max ${V(m.vrefMax)}` : 'VREF'));

    // over range, on the drawing
    if (over) svg.append(sv('text', { x: tx, y: ty - tr - 30, class: 'mc-badlab', 'text-anchor': 'middle' }, m.clipped ? 'clipped at 2.5 V' : 'above VREF range'));
    if (vsOver) svg.append(sv('text', { x: cx - 30, y: ry - 8, class: 'mc-badlab', 'text-anchor': 'middle' }, 'sense voltage too high'));
    board.replaceChildren(svg);
    const mode = raw().mode === 'current' ? 'turn the trimpot: VREF sets the current' : 'drag the limit on the right: VREF follows';
    boardHead.replaceChildren(h('span', { class: 'mc-h' }, `${m.name} carrier`), h('span', { class: 'mc-soft' }, mode));
    if (st.focus === 'knob') { board.querySelector('.mc-knob')?.focus({ preventScroll: true }); st.focus = null; }
    else if (st.focus === 0 || st.focus === 1) { board.querySelectorAll('.mc-step')[st.focus]?.focus({ preventScroll: true }); st.focus = null; }
  }

  function startKnob(e, m, tx, ty, a0, a1) {
    e.preventDefault();
    const svg = board.querySelector('svg');
    const vTop = st.vScale;
    st.drag = 'knob'; st.vMax = vTop;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const at = (ev) => {
      const r = svg.getBoundingClientRect(), k = 440 / r.width;
      const x = (ev.clientX - r.left) * k - tx, y = (ev.clientY - r.top) * k - ty;
      let deg = Math.atan2(y, x) * 180 / Math.PI; // -180..180, clockwise positive
      // map into a0..a1 (-225..45)
      if (deg > a1 + 45) deg -= 360;
      deg = Math.max(a0, Math.min(a1, deg));
      return ((deg - a0) / (a1 - a0)) * vTop;
    };
    let last = null;
    const move = (ev) => { const v = Math.round(at(ev) * 200) / 200; if (v !== last) { last = v; setVref(v); } };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); st.drag = null; st.vMax = null; st.focus = 'knob'; render(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------ the coil current
  function drawScope(m) {
    const W = Math.max(300, (scope.clientWidth || 640)), H = Math.max(300, Math.min(520, scope.clientHeight || 420));
    const L = 54, R = W < 520 ? 70 : 268, T = 22, B = 34;
    const cap = Math.max(m.iMax ?? 0, m.ipk, m.irated ?? 0);
    const yMax = st.drag && st.yMax ? st.yMax : Math.max(0.5, Math.min(cap * 1.35, Math.max(cap, Math.min(m.iAtVrefMax ?? 0, cap * 1.3)) * 1.15));
    st.yMax = yMax;
    const pw = W - L - R, ph = H - T - B;
    // steppers swing both ways; a DC motor's current is one-sided
    const neg = m.stepper;
    const Y = (i) => (neg ? T + ph / 2 - (i / yMax) * (ph / 2) : T + ph - (i / yMax) * ph);
    const inv = (y) => (neg ? ((T + ph / 2 - y) / (ph / 2)) * yMax : ((T + ph - y) / ph) * yMax);
    const X = (deg) => L + (deg / 360) * pw;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mc-ssvg', role: 'group', 'aria-label': 'Coil current over one electrical cycle' });
    // limits as bands
    const band = (lo, hi, cls, label) => {
      if (lo >= yMax) return;
      const hiC = Math.min(hi, yMax);
      svg.append(sv('rect', { x: L, y: Y(hiC), width: pw, height: Y(lo) - Y(hiC), class: cls }));
      if (neg) svg.append(sv('rect', { x: L, y: Y(-lo), width: pw, height: Y(-hiC) - Y(-lo), class: cls }));
      if (label && Y(lo) - Y(hiC) > 12) svg.append(sv('text', { x: L + 6, y: Y(hiC) + 12, class: 'mc-bandlab' }, label));
    };
    if (m.iBare && m.iMax) band(m.iBare, m.iMax, 'mc-band-warn', `above ${A(m.iBare)}: heatsink and airflow`);
    if (m.iMax) band(m.iMax, Infinity, 'mc-band-bad', `above ${m.name}'s ${A(m.iMax)} rating`);
    // grid
    for (const d of [0, 90, 180, 270, 360]) svg.append(sv('line', { x1: X(d), x2: X(d), y1: T, y2: T + ph, class: 'mc-grid' }));
    const gstep = yMax > 3 ? 1 : yMax > 1.2 ? 0.5 : 0.25;
    for (let i = neg ? -Math.floor(yMax / gstep) * gstep : 0; i <= yMax + 1e-9; i += gstep) {
      svg.append(sv('line', { x1: L, x2: L + pw, y1: Y(i), y2: Y(i), class: Math.abs(i) < 1e-9 ? 'mc-zero' : 'mc-grid' }));
      svg.append(sv('text', { x: L - 6, y: Y(i) + 3.5, class: 'mc-tick', 'text-anchor': 'end' }, fmtNum(i, 3)));
    }
    svg.append(sv('text', { x: 12, y: T + ph / 2, class: 'mc-axlab', transform: `rotate(-90 12 ${T + ph / 2})`, 'text-anchor': 'middle' }, neg ? 'coil current, A' : 'motor current, A'));
    ['0°', '90°', '180°', '270°', '360°'].forEach((t, k) => svg.append(sv('text', { x: X(k * 90), y: T + ph + 14, class: 'mc-tick', 'text-anchor': 'middle' }, t)));
    svg.append(sv('text', { x: L + pw / 2, y: T + ph + 28, class: 'mc-axlab', 'text-anchor': 'middle' },
      m.stepper ? 'one electrical cycle = 4 full steps (microstepping)' : 'time: the chopper holds the current at the trip level'));

    // the current
    if (m.stepper) {
      const path = (f) => { let d = ''; for (let k = 0; k <= 180; k++) { const deg = k * 2; d += `${k ? 'L' : 'M'}${X(deg).toFixed(1)} ${Y(m.ipk * f(deg * Math.PI / 180)).toFixed(1)}`; } return d; };
      svg.append(sv('path', { d: path(Math.cos), class: 'mc-wave mc-wave-b' }));
      svg.append(sv('path', { d: path(Math.sin), class: 'mc-wave' }));
      svg.append(sv('text', { x: X(90), y: Y(m.ipk) - 8, class: 'mc-wlab', 'text-anchor': 'middle' }, 'coil A'));
      svg.append(sv('text', { x: X(0) + 6, y: Y(m.ipk) + 16, class: 'mc-wlab mc-wlab-b' }, 'coil B'));
    } else {
      // chopper ripple under the trip level (illustrative shape)
      let d = `M${X(0)} ${Y(0)} L${X(20)} ${Y(m.ipk)}`;
      for (let deg = 20; deg < 350; deg += 22) d += ` L${X(deg + 16)} ${Y(m.ipk * 0.86)} L${X(deg + 22)} ${Y(m.ipk)}`;
      svg.append(sv('path', { d, class: 'mc-wave' }));
    }

    // level lines with labels at the right
    const lines = [];
    const label = (y, text, cls) => lines.push({ y, text, cls });
    if (m.stepper) {
      svg.append(sv('line', { x1: L, x2: L + pw, y1: Y(m.irms), y2: Y(m.irms), class: 'mc-rms' }));
      label(Y(m.irms), `rms ${A(m.irms)}`, 'mc-lab-rms');
      if (m.fullStep != null && Math.abs(m.fullStep - m.irms) > 1e-6) {
        svg.append(sv('line', { x1: L, x2: L + pw, y1: Y(m.fullStep), y2: Y(m.fullStep), class: 'mc-full' }));
        label(Y(m.fullStep), `full step ${A(m.fullStep)}`, 'mc-lab-soft');
      }
    }
    if (m.iAtVrefMax && m.iAtVrefMax < yMax) {
      svg.append(sv('line', { x1: L, x2: L + pw, y1: Y(m.iAtVrefMax), y2: Y(m.iAtVrefMax), class: 'mc-ceiling' }));
      label(Y(m.iAtVrefMax), `VREF at max: ${A(m.iAtVrefMax)}`, 'mc-lab-soft');
    }
    // motor rating: draggable
    if (m.irated) {
      const hot = m.ipk > m.irated * 1.05;
      const g = sv('g', { class: `mc-rated${hot ? ' is-bad' : ''}`, tabindex: 0, role: 'slider', 'aria-label': 'Motor rated current',
        'aria-valuenow': fmtNum(m.irated, 3), 'aria-valuetext': A(m.irated) });
      g.append(sv('rect', { x: L, y: Y(m.irated) - 7, width: pw, height: 14, class: 'mc-hit' }));
      g.append(sv('line', { x1: L, x2: L + pw, y1: Y(m.irated), y2: Y(m.irated), class: 'mc-ratedline' }));
      g.append(sv('rect', { x: L + pw - 22, y: Y(m.irated) - 5, width: 16, height: 10, rx: 2, class: 'mc-ratedgrip' }));
      g.addEventListener('pointerdown', (e) => startLine(e, 'rated', m, inv, yMax));
      g.addEventListener('keydown', (e) => keyLine(e, 'rated', m));
      svg.append(g);
      label(Y(m.irated), `motor ${A(m.irated)} · ${fmtNum(m.ofRated, 3)} %`, hot ? 'mc-lab-bad' : 'mc-lab-ok');
    }
    // the chopper limit: draggable
    const bad = m.iMax && m.ipk > m.iMax;
    const g = sv('g', { class: `mc-limit${bad ? ' is-bad' : ''}${st.drag === 'limit' ? ' is-drag' : ''}`, tabindex: 0, role: 'slider',
      'aria-label': 'Chopper current limit, peak', 'aria-valuenow': fmtNum(m.ipk, 3), 'aria-valuetext': `${A(m.ipk)} peak` });
    g.append(sv('rect', { x: L, y: Y(m.ipk) - 8, width: pw, height: 16, class: 'mc-hit' }));
    g.append(sv('line', { x1: L, x2: L + pw, y1: Y(m.ipk), y2: Y(m.ipk), class: 'mc-limitline' }));
    if (neg) g.append(sv('line', { x1: L, x2: L + pw, y1: Y(-m.ipk), y2: Y(-m.ipk), class: 'mc-limitline mc-mirror' }));
    g.append(sv('rect', { x: L + pw - 30, y: Y(m.ipk) - 7, width: 24, height: 14, rx: 3, class: 'mc-grip' }));
    g.append(sv('path', { d: `M${L + pw - 18} ${Y(m.ipk) - 4} l-3 3 h6z M${L + pw - 18} ${Y(m.ipk) + 4} l-3 -3 h6z`, class: 'mc-griparrow' }));
    g.addEventListener('pointerdown', (e) => startLine(e, 'limit', m, inv, yMax));
    g.addEventListener('keydown', (e) => keyLine(e, 'limit', m));
    svg.append(g);
    label(Y(m.ipk), `limit ${A(m.ipk)} peak`, bad ? 'mc-lab-bad' : 'mc-lab-limit');

    // labels on the right, pushed apart
    lines.sort((a, b) => a.y - b.y);
    for (let k = 1; k < lines.length; k++) if (lines[k].y - lines[k - 1].y < 14) lines[k].y = lines[k - 1].y + 14;
    for (const l of lines) svg.append(sv('text', { x: L + pw + 8, y: l.y + 4, class: `mc-lvl ${l.cls}` }, W < 520 ? l.text.split(' ').slice(0, 2).join(' ') : l.text));

    // VREF for other currents, on a second axis
    if (W >= 520) {
      const x0 = L + pw + 156;
      svg.append(sv('text', { x: x0, y: T - 8, class: 'mc-axlab' }, 'VREF for a peak of'));
      let prevY = Infinity;
      const pts = m.ladder.filter((p) => p.i <= yMax);
      if (pts.length) svg.append(sv('line', { x1: x0, x2: x0, y1: Y(0), y2: Y(pts.at(-1).i), class: 'mc-tickl' }));
      for (const p of pts) {
        const over = m.vrefMax && p.vref > m.vrefMax;
        const ty = Math.min(Y(p.i), prevY - 12);
        prevY = ty;
        svg.append(sv('path', { d: `M${x0} ${Y(p.i)} h4 L${x0 + 10} ${ty} h2`, class: 'mc-tickl', fill: 'none' }));
        svg.append(sv('text', { x: x0 + 14, y: ty + 3.5, class: `mc-tick${over ? ' is-bad' : ''}` }, `${fmtNum(p.i, 2)} A → ${fmtNum(p.vref, 3)} V`));
      }
    }
    scope.replaceChildren(svg);
    const res = ctx.result;
    const vref = res.values?.find((v) => v.label === 'VREF');
    scopeHead.replaceChildren(h('span', { class: 'mc-h' }, 'Coil current'),
      h('span', { class: 'mc-soft' }, `VREF ${vref?.value ?? fmtNum(m.vref, 3)} V ↔ ${A(m.ipk)} peak, ${A(m.irms)} ${m.stepper ? 'rms' : ''} · drag the limit or the motor rating`));
    if (st.focus === 'limit' || st.focus === 'rated') { scope.querySelector(st.focus === 'limit' ? '.mc-limit' : '.mc-rated')?.focus({ preventScroll: true }); st.focus = null; }
  }

  function startLine(e, which, m, inv, yMax) {
    e.preventDefault();
    const svg = scope.querySelector('svg');
    st.drag = which; st.yMax = yMax;
    const W = svg.viewBox.baseVal.width;
    const at = (ev) => { const r = svg.getBoundingClientRect(); return inv((ev.clientY - r.top) * (W / r.width)); };
    let last = null;
    const move = (ev) => {
      const i = Math.max(0.05, Math.min(yMax, at(ev)));
      const q = Math.round(i * (which === 'rated' ? 20 : 100)) / (which === 'rated' ? 20 : 100);
      if (q === last) return; last = q;
      if (which === 'rated') ctx.set('irated', String(q)); else setPeak(q, m);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); st.drag = null; st.focus = which; render(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function keyLine(e, which, m) {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    st.focus = which;
    const step = e.shiftKey ? 0.1 : which === 'rated' ? 0.05 : 0.01;
    if (which === 'rated') ctx.set('irated', String(Math.max(0.05, Math.round((m.irated + d * step) * 100) / 100)));
    else setPeak(m.ipk + d * step, m);
  }

  // ------------------------------------------------------------ result in
  function render() {
    const res = ctx.result || {};
    const m = res.motor;
    drawBand(m);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    boardPanel.classList.toggle('is-stale', !m);
    scopePanel.classList.toggle('is-stale', !m);
    if (!m) return;
    drawBoard(m, res);
    drawScope(m);
  }
  ctx.onResult(render);
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (ctx.result?.motor && !st.drag) drawScope(ctx.result.motor); }); }).observe(scope);
}
