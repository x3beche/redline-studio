// Crystal Load: the page is the Pierce oscillator itself.
//   Circuit - the MCU's inverter with its start-up gauge, the crystal with its
//             equivalent circuit, the stray capacitance across it and the two
//             load capacitors to ground. Step or drag a capacitor through the
//             standard values, scrub the stray capacitance, type the crystal's
//             figures where they sit on the drawing.
//   Ruler   - the load the crystal sees, CL obtained, on a scale around the
//             crystal's CL; every standard value nearby is a flag at the CL and
//             frequency error it gives. Click a flag to fit that value.
// Every number drawn comes from run()'s result.osc; the page only draws it.
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
const txt = (x, y, s, cls = '', anchor = 'start') => sv('text', { x, y, class: cls, 'text-anchor': anchor }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pf = (v) => fmtEng(v * 1e-12, 'F');
const ppmS = (p) => (p == null ? '–' : `${p >= 0 ? '+' : ''}${fmtNum(p, 3)} ppm`);
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const hz = (f) => {
  if (f == null) return '–';
  // group the digits so a few ppm are visible: 7 999 896 Hz, 32 768.13 Hz
  const dec = f < 1e5 ? 2 : f < 1e7 ? 1 : 0;
  const [i, d] = f.toFixed(dec).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${d ? '.' + d : ''} Hz`;
};

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const O = () => ctx.result?.osc;

  // ---------- frame ----------
  const seg = h('div', { class: 'xo-seg', role: 'radiogroup', 'aria-label': 'Capacitor values made in' });
  const SERIES = ['E6', 'E12', 'E24'];
  const segBtns = SERIES.map((s) => h('button', { type: 'button', role: 'radio', 'data-v': s,
    onclick: () => ctx.setMany({ series: s, cfit: '' }),
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
      e.preventDefault(); const n = SERIES[clamp(SERIES.indexOf(s) + d, 0, 2)];
      ctx.setMany({ series: n, cfit: '' }); requestAnimationFrame(() => seg.querySelector(`[data-v="${n}"]`)?.focus());
    } }, s));
  seg.append(...segBtns);
  const nearBtn = h('button', { class: 'k-btn', type: 'button', onclick: () => ctx.set('cfit', '') }, 'Use nearest');

  const schBox = h('div', { class: 'xo-draw' });
  const over = h('div', { class: 'xo-over' });
  const rulerBox = h('div', { class: 'xo-draw' });
  const chain = h('div', { class: 'xo-chain', 'aria-live': 'polite' });
  const fitIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: 'auto', 'aria-label': 'Fitted capacitor in pF, empty for the nearest standard value',
    oninput: (e) => ctx.set('cfit', e.target.value) });
  const stage = h('section', { class: 'xo-stage', 'aria-label': 'Pierce oscillator' },
    h('div', { class: 'xo-head' }, h('h2', {}, 'Pierce oscillator'),
      h('span', { class: 'xo-sub' }, 'drag or step the load capacitors, scrub the stray capacitance'),
      h('span', { class: 'xo-grow' }), h('span', { class: 'xo-sub' }, 'values'), seg, nearBtn),
    schBox,
    h('div', { class: 'xo-rulerhead' }, h('h3', {}, 'Load and pulling'), chain, h('span', { class: 'xo-grow' }),
      h('label', { class: 'xo-f', style: 'position:static' }, 'fit', fitIn, 'pF')),
    rulerBox,
    h('div', { class: 'xo-foot' },
      h('span', {}, 'On a capacitor: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' next standard value, ', h('kbd', {}, 'Home'), ' nearest'),
      h('span', {}, 'On the stray: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' ±0.5 pF (', h('kbd', {}, 'Shift'), ' 0.1)'),
      h('span', {}, 'Green band: within ±10 ppm of the crystal\'s calibration')));
  schBox.append(over);

  const warns = h('div', { class: 'k-warns xo-warns', 'aria-live': 'polite' });
  const bom = h('dl', { class: 'xo-bom' });
  const notes = h('div', { class: 'xo-notes' });
  const side = h('aside', { class: 'xo-side' }, warns,
    h('div', { class: 'xo-card' }, h('h3', {}, 'To fit'), bom), ctx.outputs, h('div', { class: 'xo-card' }, notes));
  root.append(h('div', { class: 'xo' }, stage, side));

  // ---------- fields that sit on the drawing ----------
  const fields = {};
  const field = (key, label, unit, aria, cls = '') => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, 'data-fk': `f-${key}`,
      oninput: (e) => (key === 'cl' ? ctx.setMany({ cl: e.target.value, cfit: '' }) : ctx.set(key, e.target.value)) });
    const el = h('label', { class: `xo-f ${cls}` }, label ? h('span', {}, label) : null, inp, unit ? h('span', {}, unit) : null);
    fields[key] = { el, inp };
    over.append(el);
    return el;
  };
  field('gspec', '', 'µA/V', 'MCU oscillator figure in µA/V', 'on-mcu');
  const modeSel = h('select', { 'aria-label': 'The MCU figure is', onchange: (e) => ctx.set('gmode', e.target.value) },
    h('option', { value: 'gmcritmax' }, 'Gm_crit_max'), h('option', { value: 'gm' }, 'oscillator gm'));
  const modeF = h('label', { class: 'xo-f on-mcu' }, modeSel);
  over.append(modeF);
  field('f', '', 'Hz', 'Crystal frequency in Hz');
  fields.f.inp.style.width = '72px';
  field('cl', 'CL', 'pF', 'Crystal load capacitance CL in pF');
  field('esr', 'ESR', 'Ω', 'Crystal ESR, maximum, in ohms');
  field('cm', 'Cm', 'fF', 'Motional capacitance C1 in fF (optional)');
  field('c0', 'C0', 'pF', 'Shunt capacitance C0 in pF');
  field('cs', 'Cstray', 'pF', 'Stray capacitance in pF', 'stray');
  const place = (el, x, y, anchor = 'start') => {
    el.style.display = '';
    el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
    el.style.transform = anchor === 'end' ? 'translateX(-100%)' : anchor === 'middle' ? 'translateX(-50%)' : '';
  };
  const hide = (el) => { el.style.display = 'none'; };
  const syncFields = () => {
    const raw = ctx.raw, inp = ctx.input;
    for (const [k, { inp: i }] of Object.entries(fields)) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      const bad = String(raw[k] ?? '').trim() !== '' && inp[k] == null;
      i.classList.toggle('bad', bad);
    }
    modeSel.value = raw.gmode || 'gmcritmax';
    if (document.activeElement !== fitIn) fitIn.value = raw.cfit ?? '';
  };

  // ---------- actions ----------
  const setFit = (c) => ctx.set('cfit', c == null ? '' : String(c));
  const stepFit = (d) => {
    const o = O(); if (!o || o.impossible || !o.ladder?.length) return;
    const lad = o.ladder.map((x) => x.c);
    const next = d > 0 ? lad.find((c) => c > o.cFit * 1.0001) : [...lad].reverse().find((c) => c < o.cFit * 0.9999);
    if (next != null) setFit(next);
  };
  const setStray = (v) => ctx.setMany({ cs: String(Number(Math.max(0, v).toFixed(1))), cfit: '' });

  // Keyboard focus survives a redraw.
  const keepFocus = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk && document.activeElement?.getAttribute?.('data-fk') !== fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };

  // ---------- the circuit ----------
  function drawCircuit() {
    const o = O();
    const W = Math.max(320, schBox.clientWidth || 800);
    for (const el of schBox.querySelectorAll('svg')) el.remove();
    if (!o) return;
    const narrow = W < 620;
    const cx = W / 2;
    const s = narrow ? W * 0.3 : clamp(W * 0.29, 170, 300);
    const xL = cx - s, xR = cx + s;
    const mx0 = clamp(xL - (narrow ? 44 : 90), 8, W), mx1 = clamp(xR + (narrow ? 44 : 90), 0, W - 8);
    const yM0 = 14, yM1 = 150, yPin = yM1, yS = 184, yN = 256, yC = 340, yG = 412;
    const eqBelow = narrow;
    const eqY0 = eqBelow ? yG + 40 : 272, eqH = 96;
    const H = eqBelow ? eqY0 + eqH + 16 : yG + 50;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Pierce oscillator: MCU, crystal and load capacitors' });
    const add = (...els) => { svg.append(...els); return els[0]; };
    const line = (x1, y1, x2, y2, cls) => sv('line', { x1, y1, x2, y2, class: cls });

    // --- MCU with the inverter and its start-up gauge
    add(sv('rect', { x: mx0, y: yM0, width: mx1 - mx0, height: yM1 - yM0, rx: 5, class: 'mcu' }));
    add(txt(mx0 + 10, yM0 + 17, 'MCU', 'mcu-t b'), txt(mx0 + 44, yM0 + 17, narrow ? 'oscillator' : 'oscillator amplifier', 'mcu-soft sm'));
    const yRf = yM0 + 38, yInv = yM0 + 72;
    // Rf across the inverter
    add(sv('path', { d: `M${xL},${yPin} V${yRf} H${cx - 22} M${cx + 22},${yRf} H${xR} V${yPin}`, class: 'mcu-wire' }));
    add(sv('rect', { x: cx - 22, y: yRf - 6, width: 44, height: 12, rx: 1, class: 'mcu-res' }), txt(cx, yRf - 10, 'Rf', 'mcu-soft sm', 'middle'));
    // inverter: in from OSC_IN, out to OSC_OUT
    const bad = o.startOk === false;
    add(sv('path', { d: `M${xL},${yInv} H${cx - 20} M${cx + 26},${yInv} H${xR}`, class: 'mcu-wire' }));
    add(sv('path', { d: `M${cx - 20},${yInv - 17} L${cx + 18},${yInv} L${cx - 20},${yInv + 17} Z`, class: `inv${bad ? ' bad' : ''}` }),
      sv('circle', { cx: cx + 22, cy: yInv, r: 4, class: `inv${bad ? ' bad' : ''}` }));
    add(sv('circle', { cx: xL, cy: yInv, r: 2.5, class: 'mcu-t' }), sv('circle', { cx: xR, cy: yInv, r: 2.5, class: 'mcu-t' }));
    // gauge: gm,crit against the MCU's figure
    const gy = yM1 - 26, gx0 = mx0 + 12, gx1 = mx1 - 12;
    if (o.gcrit != null) {
      const need = o.gmode === 'gm' ? o.gcrit * 5 : o.gcrit; // what the crystal asks of the amplifier
      const lim = o.gspec;
      const max = Math.max(need, lim || 0) * 1.25 || 1;
      const X = (v) => gx0 + (v / max) * (gx1 - gx0);
      const tone = o.startOk === false ? 'bad' : (o.ratio != null && o.ratio > 0.8) ? 'warn' : '';
      add(sv('rect', { x: gx0, y: gy, width: gx1 - gx0, height: 8, rx: 2, class: 'g-track' }),
        sv('rect', { x: gx0, y: gy, width: Math.max(2, X(need) - gx0), height: 8, rx: 2, class: `g-fill ${tone}` }));
      if (lim) add(line(X(lim), gy - 5, X(lim), gy + 13, 'g-lim'));
      const lbl = o.gmode === 'gm'
        ? `needs 5 × gm,crit = ${fmtNum(need, 3)} µA/V${o.gain != null ? ` · margin ${fmtNum(o.gain, 3)}×` : ''}`
        : `gm,crit ${fmtNum(o.gcrit, 3)} µA/V${o.ratio != null ? ` · ${fmtNum(o.ratio * 100, 3)} % of limit` : ''}`;
      add(txt(gx0, gy - 5, narrow ? lbl.replace(' of limit', '') : lbl, `m sm ${bad ? 'danger' : 'mcu-t'}`));
      add(txt(gx0, gy + 20, bad ? 'may not start' : o.startOk ? 'starts with margin' : 'give the MCU figure', `sm ${bad ? 'danger b' : 'mcu-soft'}`));
      add(txt(lim ? X(lim) : gx1, gy + 20, o.gmode === 'gm' ? 'gm' : 'limit', 'mcu-soft sm', 'middle'));
      place(fields.gspec.el, mx1 - 8, yM0 + 6, 'end');
      place(modeF, mx1 - 100, yM0 + 6, 'end');
      if (narrow) hide(modeF);
    } else {
      add(txt(gx0, gy + 6, 'start-up check: give frequency, ESR and C0', 'mcu-soft sm'));
      hide(fields.gspec.el); hide(modeF);
    }
    // pins
    for (const [x, name] of [[xL, 'OSC_IN'], [xR, 'OSC_OUT']]) {
      add(sv('rect', { x: x - 6, y: yPin - 2, width: 12, height: 8, class: 'pin' }));
      add(txt(x + (x < cx ? -9 : 9), yPin + 16, name, 'm sm soft', x < cx ? 'end' : 'start'));
    }

    // --- stray capacitance, across the crystal
    const strayW = 34;
    add(sv('path', { d: `M${xL},${yS} H${cx - 5} M${cx + 5},${yS} H${xR}`, class: 'stray-w' }));
    add(line(cx - 5, yS - 13, cx - 5, yS + 13, 'stray-plate'), line(cx + 5, yS - 13, cx + 5, yS + 13, 'stray-plate'));
    const sg = sv('g', { class: 'stray', tabindex: 0, role: 'slider', 'data-fk': 'stray', 'data-drag': 'stray',
      'aria-label': 'Stray capacitance, pins plus traces', 'aria-valuenow': o.cs, 'aria-valuemin': 0, 'aria-valuetext': `${fmtNum(o.cs, 3)} pF` });
    sg.append(sv('rect', { x: cx - strayW - 70, y: yS - 20, width: 2 * strayW + 140, height: 34, rx: 4, class: 'hit' }),
      sv('rect', { x: cx - 16, y: yS - 17, width: 32, height: 34, rx: 4, class: 'ring' }),
      sv('title', {}, 'Stray capacitance: drag sideways or use the arrow keys'));
    add(sg);
    if (!narrow) add(txt(cx + 14, yS - 18, 'pins + traces, as the crystal sees them', 'soft sm'));
    place(fields.cs.el, cx - 12, yS - 32, 'end');

    // --- traces from the pins to the nodes, and the nodes
    add(sv('path', { d: `M${xL},${yPin + 6} V${yG}`, class: 'wire' }), sv('path', { d: `M${xR},${yPin + 6} V${yG}`, class: 'wire' }));
    add(sv('circle', { cx: xL, cy: yS, r: 3, class: 'node' }), sv('circle', { cx: xR, cy: yS, r: 3, class: 'node' }),
      sv('circle', { cx: xL, cy: yN, r: 3.5, class: 'node' }), sv('circle', { cx: xR, cy: yN, r: 3.5, class: 'node' }));

    // --- the crystal
    add(sv('path', { d: `M${xL},${yN} H${cx - 17} M${cx + 17},${yN} H${xR}`, class: 'wire' }));
    add(line(cx - 17, yN - 18, cx - 17, yN + 18, 'xtal-plate'), line(cx + 17, yN - 18, cx + 17, yN + 18, 'xtal-plate'));
    add(sv('rect', { x: cx - 10, y: yN - 22, width: 20, height: 44, rx: 2, class: 'xtal-body' }));
    place(fields.f.el, cx - 24, yN - 44, 'end');
    place(fields.cl.el, cx + 24, yN - 44);
    // equivalent circuit, under the crystal (or under everything when narrow)
    const ew = Math.min(narrow ? W - 24 : 2 * s - 150, 420), ex0 = cx - ew / 2;
    add(sv('rect', { x: ex0, y: eqY0, width: ew, height: eqH, rx: 5, class: 'eq-box' }));
    if (!eqBelow) add(sv('path', { d: `M${cx},${yN + 22} V${eqY0}`, class: 'eq-lead' }));
    else add(sv('path', { d: `M${cx},${yN + 22} V${yN + 34} M${cx},${yG + 14} V${eqY0}`, class: 'eq-lead' }));
    add(txt(ex0 + 8, eqY0 + 14, 'inside the crystal', 'xtal-t sm b'));
    const ey = eqY0 + 44, ey2 = eqY0 + 78;
    const e0 = ex0 + 14, e1 = ex0 + ew - 14, span = e1 - e0;
    const pL = e0 + span * 0.14, pC = e0 + span * 0.46, pR = e0 + span * 0.8;
    add(sv('path', { d: `M${e0},${ey} H${pL - 14} M${pL + 14},${ey} H${pC - 4} M${pC + 4},${ey} H${pR - 12} M${pR + 12},${ey} H${e1}`, class: 'eq-w' }));
    add(sv('path', { d: `M${pL - 14},${ey} q3.5,-9 7,0 q3.5,-9 7,0 q3.5,-9 7,0 q3.5,-9 7,0`, class: 'eq-w' }));
    add(line(pC - 4, ey - 9, pC - 4, ey + 9, 'eq-w'), line(pC + 4, ey - 9, pC + 4, ey + 9, 'eq-w'));
    add(sv('rect', { x: pR - 12, y: ey - 5, width: 24, height: 10, class: 'eq-part' }));
    add(sv('path', { d: `M${e0},${ey} V${ey2} H${pC - 4} M${pC + 4},${ey2} H${e1} V${ey}`, class: 'eq-w' }));
    add(line(pC - 4, ey2 - 9, pC - 4, ey2 + 9, 'eq-w'), line(pC + 4, ey2 - 9, pC + 4, ey2 + 9, 'eq-w'));
    add(txt(pL, ey - 12, 'Lm', 'soft sm', 'middle'));
    place(fields.cm.el, pC, ey - 30, 'middle');
    place(fields.esr.el, pR, ey - 30, 'middle');
    place(fields.c0.el, pC, ey2 + 5, 'middle');
    fields.c0.el.style.transform += ' translateY(-2px)';

    // --- the load capacitors
    const capBad = o.impossible;
    const capLabel = (x, name, side) => {
      const out = (side < 0 ? -1 : 1) * (narrow ? -1 : 1); // narrow: labels inside, between the capacitors
      const lx = x + out * 34;
      const anchor = out < 0 ? 'end' : 'start';
      const g = sv('g', { class: 'cap', tabindex: 0, role: 'slider', 'data-fk': `cap-${name}`, 'data-drag': 'cap',
        'aria-label': `${name}, load capacitor; C1 and C2 move together`, 'aria-valuetext': capBad ? 'none possible' : pf(o.cFit) });
      g.append(sv('rect', { x: out > 0 ? x - 30 : lx - 96, y: yC - 42, width: 130, height: 84, rx: 5, class: 'hit' }));
      g.append(sv('rect', { x: x - 25, y: yC - 14, width: 50, height: 28, rx: 4, class: 'ring' }));
      g.append(line(x - 22, yC - 5, x + 22, yC - 5, `cap-plate${capBad ? ' bad' : ''}`), line(x - 22, yC + 5, x + 22, yC + 5, `cap-plate${capBad ? ' bad' : ''}`));
      g.append(txt(lx, yC - 16, name, 'b', anchor));
      g.append(txt(lx, yC + 4, capBad ? 'none' : pf(o.cFit), `m lg ${capBad ? 'danger b' : 'cap-v'}`, anchor));
      g.append(txt(lx, yC + 20, capBad ? 'stray ≥ CL' : `exact ${pf(o.cExact)}`, `m sm ${capBad ? 'danger' : 'soft'}`, anchor));
      g.append(sv('title', {}, 'Drag up or down, or use the arrow keys, to step through the standard values'));
      svg.append(g);
      if (!capBad && !narrow) {
        // step buttons beside the value
        const bx = out < 0 ? lx - (narrow ? 78 : 90) : lx + (narrow ? 70 : 76);
        for (const [d, dy, path] of [[1, -12, 'M-5,3 L0,-3 L5,3 Z'], [-1, 12, 'M-5,-3 L0,3 L5,-3 Z']]) {
          const sg2 = sv('g', { class: 'step', 'data-step': d, transform: `translate(${bx},${yC + dy - 4})` });
          sg2.append(sv('rect', { x: -9, y: -8, width: 18, height: 16 }), sv('path', { d: path }), sv('title', {}, d > 0 ? 'Next value up' : 'Next value down'));
          svg.append(sg2);
        }
      }
    };
    add(sv('path', { d: `M${xL},${yN} V${yC - 5} M${xL},${yC + 5} V${yG}`, class: 'wire' }));
    capLabel(xL, 'C1', -1);
    capLabel(xR, 'C2', 1);
    // ground
    add(line(xL, yG, xR, yG, 'gnd'), line(cx, yG, cx, yG + 8, 'gnd'),
      line(cx - 12, yG + 8, cx + 12, yG + 8, 'gnd'), line(cx - 7, yG + 12, cx + 7, yG + 12, 'gnd'), line(cx - 3, yG + 16, cx + 3, yG + 16, 'gnd'));
    // repaint the capacitor gaps over the wire
    add(sv('rect', { x: xL - 3, y: yC - 3.5, width: 6, height: 7, fill: 'var(--surface)' }), sv('rect', { x: xR - 3, y: yC - 3.5, width: 6, height: 7, fill: 'var(--surface)' }));

    schBox.prepend(svg);
    if (capBad) {
      add(line(xL - 16, yC - 16, xL + 16, yC + 16, 'bad-x'), line(xR - 16, yC - 16, xR + 16, yC + 16, 'bad-x'));
    }
  }

  // ---------- the ruler: load and pulling ----------
  function drawRuler() {
    const o = O();
    const W = Math.max(320, rulerBox.clientWidth || 800);
    rulerBox.replaceChildren();
    if (!o) return;
    const L = 22, R = 22;
    if (o.impossible) {
      const svg = sv('svg', { viewBox: `0 0 ${W} 70`, height: 70 });
      svg.append(txt(W / 2, 30, `The stray capacitance ${fmtNum(o.cs, 3)} pF already reaches CL ${fmtNum(o.cl, 3)} pF:`, 'danger b', 'middle'),
        txt(W / 2, 48, 'no load capacitor can bring the load down to it. Choose a crystal with a higher CL, or shorten the traces.', 'soft sm', 'middle'));
      rulerBox.append(svg);
      return;
    }
    // --- the load bar: series pair + stray against CL
    const yB = 26, bh = 14;
    const maxC = Math.max(o.cl, o.clA) * 1.18;
    const XB = (v) => L + (v / maxC) * (W - L - R);
    // --- the ruler: CL obtained around the crystal's CL
    const cands = o.ladder || [];
    let span = 2;
    for (const c of cands) if (Math.abs(c.ppm ?? 0) < 60 || o.ppm == null) span = Math.max(span, Math.abs(c.cl - o.cl));
    span = Math.min(span * 1.08, Math.max(3, o.cl * 0.6));
    const lo = o.cl - span, hi = o.cl + span;
    const yA = 132, H = 188;
    const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Load capacitance obtained and frequency pulling for each standard value' });
    // load bar
    svg.append(sv('rect', { x: L, y: yB, width: W - L - R, height: bh, rx: 2, class: 'sum-track' }));
    svg.append(sv('rect', { x: L, y: yB, width: XB(o.cSeries) - L, height: bh, class: 'sum-cap' }));
    svg.append(sv('rect', { x: XB(o.cSeries), y: yB, width: XB(o.clA) - XB(o.cSeries), height: bh, class: 'sum-stray', 'fill-opacity': 0.85 }));
    svg.append(sv('line', { x1: XB(o.cl), y1: yB - 6, x2: XB(o.cl), y2: yB + bh + 6, class: 'target' }));
    const t1 = txt(L, yB - 6, '', 'sm');
    const short = W < 560;
    t1.append(sv('tspan', { class: 'soft' }, short ? '' : 'the crystal sees  '), sv('tspan', { class: 'm cap-v' }, `${short ? 'C1 ser C2' : 'C1·C2/(C1+C2)'} ${pf(o.cSeries)}`),
      sv('tspan', { class: 'm soft' }, '  +  '), sv('tspan', { class: 'm stray-t' }, `${short ? 'stray' : 'Cstray'} ${pf(o.cs)}`),
      sv('tspan', { class: 'm soft' }, '  =  '), sv('tspan', { class: 'm b' }, `${pf(o.clA)}`));
    svg.append(t1);
    svg.append(txt(Math.min(XB(o.cl) + 4, W - R), yB + bh + 13, `CL ${pf(o.cl)}`, 'm sm b', XB(o.cl) > W - 90 ? 'end' : 'start'));

    // band ±10 ppm
    if (o.band && o.band[0] != null && o.band[1] != null) {
      const a = clamp(X(Math.min(...o.band)), L, W - R), b = clamp(X(Math.max(...o.band)), L, W - R);
      svg.append(sv('rect', { x: a, y: yA - 58, width: b - a, height: 62, class: 'band' }),
        sv('line', { x1: a, y1: yA - 58, x2: a, y2: yA + 4, class: 'band-e' }), sv('line', { x1: b, y1: yA - 58, x2: b, y2: yA + 4, class: 'band-e' }));
      if (b - a > 70) svg.append(txt((a + b) / 2, yA - 62, '±10 ppm', 'ok-t sm b', 'middle'));
    }
    svg.append(sv('line', { x1: L, y1: yA, x2: W - R, y2: yA, class: 'axis' }));
    // ticks in pF
    const stepT = span > 6 ? 2 : span > 2.5 ? 1 : 0.5;
    for (let v = Math.ceil(lo / stepT) * stepT; v <= hi + 1e-9; v += stepT) {
      svg.append(sv('line', { x1: X(v), y1: yA, x2: X(v), y2: yA + 5, class: 'tick' }));
      if (Math.abs(X(v) - X(o.cl)) > 66) svg.append(txt(X(v), yA + 17, fmtNum(v, 3), 'm sm soft', 'middle'));
    }
    svg.append(sv('line', { x1: X(o.cl), y1: yA - 58, x2: X(o.cl), y2: yA + 8, class: 'zero' }));
    svg.append(txt(X(o.cl), yA + 19, `CL ${fmtNum(o.cl, 3)} pF${o.ppm != null ? ' · 0 ppm' : ''}`, 'm sm b', 'middle'));
    svg.append(txt(L, H - 8, 'load obtained, pF  ·  higher load pulls the frequency down', 'soft sm'));
    if (o.ppm == null) svg.append(txt(W - R, H - 8, 'give C1 (motional) and C0 for the error in ppm', 'soft sm', 'end'));

    // candidate flags, two tiers when they crowd
    const shown = cands.filter((c) => c.cl >= lo - 1e-9 && c.cl <= hi + 1e-9);
    const chips = shown.map((c) => {
      const on = Math.abs(c.c - o.cFit) < 1e-9;
      const warn = on && c.ppm != null && Math.abs(c.ppm) > 10;
      const top = pf(c.c), sub = c.ppm == null ? `${fmtNum(c.cl, 3)} pF` : ppmS(c.ppm);
      const w = Math.max(top.length, sub.length) * 6.4 + 12;
      return { c, on, warn, top, sub, w, x: X(c.cl), tier: 0 };
    });
    let lastEnd = -1e9;
    for (const ch of chips) { if (ch.x - ch.w / 2 < lastEnd + 3) { ch.tier = 1; } else lastEnd = ch.x + ch.w / 2; }
    // a second pass so tier-1 chips do not overlap each other either
    let lastEnd1 = -1e9;
    for (const ch of chips) if (ch.tier === 1) { if (ch.x - ch.w / 2 < lastEnd1 + 3) ch.tier = 2; else lastEnd1 = ch.x + ch.w / 2; }
    for (const ch of chips.filter((q) => q.tier === 2)) ch.tier = 0; // rare: let it overlap the lowest row rather than vanish
    for (const ch of chips) {
      const yTop = ch.tier === 0 ? yA - 40 : yA - 78;
      const g = sv('g', { class: `cand${ch.on ? ' on' : ''}${ch.warn ? ' warn' : ''}`, tabindex: 0, role: 'button', 'data-fk': `cand-${ch.c.c}`, 'data-c': ch.c.c,
        'aria-pressed': String(ch.on), 'aria-label': `Fit ${ch.top}: load ${fmtNum(ch.c.cl, 3)} pF${ch.c.ppm != null ? `, ${ppmS(ch.c.ppm)}` : ''}` });
      const cxp = clamp(ch.x, L + ch.w / 2, W - R - ch.w / 2);
      g.append(sv('line', { x1: ch.x, y1: yTop + 30, x2: ch.x, y2: yA, class: 'stem' }),
        sv('rect', { x: cxp - ch.w / 2, y: yTop, width: ch.w, height: 30, rx: 4, class: 'chip' }),
        txt(cxp, yTop + 13, ch.top, 'm chip-t b', 'middle'), txt(cxp, yTop + 25, ch.sub, 'm sm chip-t', 'middle'),
        sv('circle', { cx: ch.x, cy: yA, r: ch.on ? 5 : 3.2, class: 'dot' }));
      if (ch.c.nearest) g.append(sv('path', { d: `M${ch.x},${yA + 6} l-4.5,7 h9 Z`, class: 'near-mk' }), sv('title', {}, 'nearest standard value'));
      svg.append(g);
    }
    // the fitted value, when it is not a standard one nearby
    if (!chips.some((q) => q.on) && o.clA >= lo && o.clA <= hi) {
      svg.append(sv('circle', { cx: X(o.clA), cy: yA, r: 5, fill: 'var(--accent)' }), txt(X(o.clA), yA - 10, `${pf(o.cFit)} (typed)`, 'm sm b', 'middle'));
    }
    rulerBox.append(svg);
    state.ruler = { X, lo, hi, L, R, W, chips: chips.map((q) => ({ x: q.x, c: q.c.c })) };
  }

  // ---------- side: chain, parts, warnings ----------
  function drawSide() {
    const r = ctx.result || {};
    const o = O();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(r.notes || []).map((w) => h('div', {}, w)));
    bom.replaceChildren();
    chain.replaceChildren();
    nearBtn.disabled = !o || !o.chosen;
    for (const b of segBtns) { const on = b.dataset.v === (o?.series || ctx.raw.series); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    if (!o || o.impossible) { if (o) bom.append(h('dt', {}, 'C1, C2'), h('dd', { style: 'color:var(--danger)' }, 'none possible')); return; }
    const warnP = o.ppm != null && Math.abs(o.ppm) > 10;
    chain.append(h('span', {}, pf(o.cFit)), h('span', { class: 'soft' }, ' each → load '), h('span', {}, pf(o.clA)),
      ...(o.ppm != null ? [h('span', { class: 'soft' }, ' → '), h('span', { class: warnP ? 'warn' : '' }, ppmS(o.ppm))] : []),
      ...(o.fActual != null ? [h('span', { class: 'soft' }, ' → '), h('span', {}, hz(o.fActual))] : []));
    const row = (k, v, style) => bom.append(h('dt', {}, k), h('dd', style ? { style } : {}, v));
    row('C1, C2', `2 × ${pf(o.cFit)}  C0G/NP0`);
    row('Series', o.chosen ? `your value${o.cFit !== o.nearest ? ` (nearest ${pf(o.nearest)})` : ''}` : `${o.series}, nearest`);
    row('Load obtained', `${pf(o.clA)} of ${pf(o.cl)}`);
    if (o.ppm != null) row('Pulling', ppmS(o.ppm), warnP ? 'color:var(--warn)' : '');
    if (o.gcrit != null) row('gm,crit', `${fmtNum(o.gcrit, 3)} µA/V`, o.startOk === false ? 'color:var(--danger)' : '');
  }

  // ---------- pointer and keys ----------
  const state = { drag: null, ruler: null };
  schBox.addEventListener('pointerdown', (e) => {
    const step = e.target.closest?.('g.step');
    if (step) { e.preventDefault(); stepFit(Number(step.dataset.step)); return; }
    const g = e.target.closest?.('[data-drag]');
    if (!g) return;
    e.preventDefault(); g.focus({ preventScroll: true }); capture(schBox, e);
    const o = O();
    state.drag = { kind: g.dataset.drag, x: e.clientX, y: e.clientY, cs: o?.cs ?? 0, acc: 0 };
  });
  schBox.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    if (d.kind === 'cap') {
      const steps = Math.trunc((d.y - e.clientY) / 18) - d.acc;
      if (steps) { d.acc += steps; stepFit(Math.sign(steps)); }
    } else if (d.kind === 'stray') {
      const v = d.cs + (e.clientX - d.x) / 24; // 1 pF per 24 px
      const q = Math.round(v * 10) / 10;
      if (q !== d.last) { d.last = q; setStray(q); }
    }
  });
  const end = () => { state.drag = null; };
  schBox.addEventListener('pointerup', end);
  schBox.addEventListener('pointercancel', end);
  schBox.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-drag]'); if (!g) return;
    const o = O(); if (!o) return;
    if (g.dataset.drag === 'cap') {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); stepFit(d); } else if (e.key === 'Home') { e.preventDefault(); setFit(null); }
    } else if (g.dataset.drag === 'stray') {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); setStray(o.cs + d * (e.shiftKey ? 0.1 : 0.5)); }
    }
  });
  // ruler: click or drag across the flags
  const pickAt = (clientX) => {
    const q = state.ruler; if (!q || !q.chips.length) return;
    const rect = rulerBox.getBoundingClientRect();
    const x = (clientX - rect.left) * (q.W / rect.width);
    const best = q.chips.reduce((b, c) => (Math.abs(c.x - x) < Math.abs(b.x - x) ? c : b));
    if (best && best.c !== O()?.cFit) setFit(best.c);
  };
  rulerBox.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('g.cand');
    e.preventDefault(); capture(rulerBox, e);
    state.rdrag = true;
    if (g) { setFit(Number(g.dataset.c)); g.focus({ preventScroll: true }); } else pickAt(e.clientX);
  });
  rulerBox.addEventListener('pointermove', (e) => { if (state.rdrag) pickAt(e.clientX); });
  rulerBox.addEventListener('pointerup', () => { state.rdrag = false; });
  rulerBox.addEventListener('pointercancel', () => { state.rdrag = false; });
  rulerBox.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('g.cand'); if (!g) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFit(Number(g.dataset.c)); }
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (d) {
      e.preventDefault();
      const all = [...rulerBox.querySelectorAll('g.cand')];
      all[clamp(all.indexOf(g) + d, 0, all.length - 1)]?.focus();
    }
  });

  // ---------- draw on every result and on resize ----------
  const drawAll = () => keepFocus(() => { syncFields(); drawCircuit(); drawRuler(); drawSide(); });
  ctx.onResult(drawAll);
  let lastW = 0;
  new ResizeObserver(() => {
    const w = schBox.clientWidth;
    if (Math.abs(w - lastW) > 1) { lastW = w; drawAll(); }
  }).observe(schBox);
}
