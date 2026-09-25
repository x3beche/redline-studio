// Current Sense: the page is the measurement chain itself.
//   Top row  - the load current, the shunt (drawn as its package, with Kelvin
//              sense lines), the amplifier with its gain steps, the ADC.
//   Scales   - under each stage its own scale: amperes, millivolts across the
//              shunt, volts and codes at the ADC. A ribbon carries the current
//              range through the chain. Drag Imax on the current scale, the
//              shunt-voltage limit on the millivolt scale and the used share of
//              the ADC on the volt scale; the chain follows.
//   Shunts   - the standard shunts nearby, each with its power and resolution;
//              click one to design around it.
// Every number drawn comes from run()'s result.chain; the page only draws it.
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
const E = (v, u, d = 3) => fmtEng(v, u, d);
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const niceStep = (span, n) => {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const two = (v) => Number(Number(v).toPrecision(2));
const GAINSETS = [['ina18x', 'INA180/181, INA240', '20…200'], ['ina21x', 'INA21x', '50…1000'], ['ina199', 'INA199', '50…200'], ['any', 'Any gain', 'op-amp']];
const SIZE_MM = { '0603': [1.6, 0.8], '0805': [2, 1.25], '1206': [3.2, 1.6], '2010': [5, 2.5], '2512': [6.3, 3.2], '2512 wide / 3921': [10, 5.2], '4-terminal / 5930': [15, 7.6] };

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const C = () => ctx.result?.chain;
  const state = { drag: null, geo: null };

  // ---------- frame ----------
  const radio = (label, items, key) => {
    const g = h('div', { class: 'cs-seg', role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title,
      onclick: () => ctx.set(key, v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
        e.preventDefault(); const i = clamp(items.findIndex((x) => x[0] === v) + d, 0, items.length - 1);
        ctx.set(key, items[i][0]); requestAnimationFrame(() => g.querySelector(`[data-v="${items[i][0]}"]`)?.focus());
      } }, t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const dirSeg = radio('Direction', [['uni', '0 … Imax', 'Unidirectional'], ['bi', '± Imax', 'Bidirectional, output at mid-scale']], 'dir');
  const gainSeg = radio('Amplifier gains available', GAINSETS.map(([v, t, s]) => [v, t, s]), 'gains');
  const draw = h('div', { class: 'cs-draw' });
  const over = h('div', { class: 'cs-over' });
  draw.append(over);
  const warns = h('div', { class: 'cs-warns', 'aria-live': 'polite' });
  const flow = h('div', { class: 'cs-flow', hidden: true });
  const chainPanel = h('section', { class: 'cs-panel cs-chain', 'aria-label': 'Measurement chain' },
    h('div', { class: 'cs-head' }, h('h2', {}, 'Measurement chain'), h('span', { class: 'cs-sub' }, 'drag the handles on the scales'),
      h('span', { class: 'cs-grow' }), h('span', { class: 'cs-lab' }, 'current'), dirSeg, h('span', { class: 'cs-lab' }, 'amplifier'), gainSeg),
    draw, flow, warns,
    h('div', { class: 'cs-foot' }, h('span', {}, 'On a handle: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' step, ', h('kbd', {}, 'Shift'), ' fine'),
      h('span', {}, 'Orange: Imax · purple: shunt-voltage limit · green: share of the ADC range to use')));
  const list = h('div', { class: 'cs-list', role: 'group', 'aria-label': 'Standard shunt values nearby' });
  const notes = h('div', { class: 'cs-notes' });
  const shunts = h('section', { class: 'cs-panel cs-shunts', 'aria-label': 'Shunt values nearby' },
    h('div', { class: 'cs-head' }, h('h2', {}, 'Shunts nearby'), h('span', { class: 'cs-sub' }, 'click one to design around it; the gain follows')),
    list, h('div', { class: 'cs-key' }, h('span', {}, h('i', { style: 'background:var(--tool-amp)' }), 'power at Imax'),
      h('span', {}, h('i', { style: 'background:var(--tool-v)' }), 'current per ADC step (longer is finer)')), notes);
  const out = h('section', { class: 'cs-out' }, ctx.outputs);
  root.append(h('div', { class: 'cs' }, chainPanel, shunts, out));

  // ---------- fields on the drawing ----------
  const fields = {};
  const field = (key, label, unit, aria, cls = '') => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, 'data-fk': `f-${key}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    const el = h('label', { class: `cs-f ${cls}` }, label ? h('span', {}, label) : null, inp, unit ? h('span', {}, unit) : null);
    fields[key] = { el, inp }; over.append(el);
  };
  field('imax', 'Imax', 'A', 'Full-scale current in A');
  field('vsh', 'limit', 'mV', 'Largest shunt voltage in mV');
  field('vos', 'Vos', 'µV', 'Amplifier input offset, maximum, in µV');
  field('vfs', 'full scale', 'V', 'ADC full-scale voltage', 'on-body');
  field('bits', '', 'bits', 'ADC resolution in bits', 'on-body');
  field('head', 'use', '%', 'Share of the ADC range used at Imax, %');
  const place = (el, x, y, anchor = 'start') => {
    el.style.display = ''; el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
    el.style.transform = anchor === 'end' ? 'translateX(-100%)' : anchor === 'middle' ? 'translateX(-50%)' : '';
  };
  const syncFields = () => {
    const raw = ctx.raw, inp = ctx.input;
    for (const [k, { inp: i }] of Object.entries(fields)) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && inp[k] == null);
    }
    dirSeg.sync(raw.dir || 'uni'); gainSeg.sync(raw.gains || 'ina18x');
  };

  // ---------- setters from the drawing ----------
  const setImax = (v) => ctx.set('imax', String(two(clamp(v, 0.001, 1e4))));
  const setVsh = (mv) => ctx.set('vsh', String(Number(clamp(mv, 1, 500).toPrecision(mv >= 10 ? 2 : 1))));
  const setUse = (pct) => ctx.set('head', String(Math.round(clamp(pct, 10, 100))));

  // ---------- the drawing ----------
  function drawChain() {
    const c = C();
    const W = Math.max(320, draw.clientWidth || 1000);
    for (const el of draw.querySelectorAll('svg')) el.remove();
    if (!c) { for (const f of Object.values(fields)) f.el.style.display = 'none'; return; }
    const narrow = W < 640;
    const x1 = narrow ? W * 0.17 : W * 0.12, x2 = narrow ? W * 0.5 : W * 0.4, x4 = narrow ? W * 0.83 : W * 0.82;
    const xa = (x2 + x4) / 2 + (narrow ? 0 : 10);
    const yW = 118;                        // the power wire
    const yT = narrow ? 70 : 214, yB = narrow ? 330 : 404; // scales
    const H = yB + 34;
    // narrow: the fields leave the drawing for a row under it
    for (const f of Object.values(fields)) {
      if (narrow && f.el.parentNode !== flow) { flow.append(f.el); f.el.style.cssText = ''; }
      if (!narrow && f.el.parentNode !== over) over.append(f.el);
    }
    flow.hidden = !narrow;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': 'Current, shunt, amplifier and ADC, each above its scale' });
    const add = (...els) => { svg.append(...els); return els[0]; };
    const line = (a, b, c2, d, cls) => sv('line', { x1: a, y1: b, x2: c2, y2: d, class: cls });

    // --- scales
    const bi = c.bi;
    const iHi = c.imax * 1.25, iLo = bi ? -iHi : 0;
    const vsTop = Math.max(c.vshMax, c.vsFull) * 1.3, vsLo = bi ? -vsTop : 0;
    const vTop = Math.max(c.vfs, c.vout * 1.04), vLo = Math.min(0, c.vlo);
    const Y = (v, lo, hi) => yB - ((v - lo) / (hi - lo)) * (yB - yT);
    const YI = (v) => Y(v, iLo, iHi), YS = (v) => Y(v, vsLo, vsTop), YV = (v) => Y(v, vLo, vTop);
    state.geo = { YI, YS, YV, iLo, iHi, vsLo, vsTop, vLo, vTop, yT, yB };

    // ribbons: the current range carried through the chain
    const top = [YI(c.imax), YS(c.vsFull), YV(c.vout)];
    const bot = bi ? [YI(-c.imax), YS(-c.vsFull), YV(c.vlo)] : [YI(0), YS(0), YV(c.vref)];
    const xs = [x1, x2, x4];
    add(sv('path', { d: `M${xs[0]},${top[0]} L${xs[1]},${top[1]} L${xs[2]},${top[2]} L${xs[2]},${bot[2]} L${xs[1]},${bot[1]} L${xs[0]},${bot[0]} Z`, class: 'rib' }));
    add(sv('path', { d: `M${xs[0]},${top[0]} L${xs[1]},${top[1]} L${xs[2]},${top[2]}`, class: 'rib-e' }));
    add(sv('path', { d: `M${xs[0]},${bot[0]} L${xs[1]},${bot[1]} L${xs[2]},${bot[2]}`, class: 'rib-e' }));
    if (bi) add(sv('path', { d: `M${x1},${YI(0)} L${x2},${YS(0)} L${x4},${YV(c.vref)}`, class: 'rib-z' }));
    // ribbon labels: what each hop multiplies by
    const mid = (a, b) => (a + b) / 2;
    const rl = (x, y, s) => { add(sv('rect', { x: x - s.length * 3.3 - 5, y: y - 11, width: s.length * 6.6 + 10, height: 16, rx: 3, class: 'lbl-bg', opacity: 0.9 })); add(txt(x, y + 1, s, 'm sm b', 'middle')); };
    rl(mid(x1, x2), mid(mid(top[0], bot[0]), mid(top[1], bot[1])), `× ${E(c.r, 'Ω')}`);
    rl(mid(x2, x4), mid(mid(top[1], bot[1]), mid(top[2], bot[2])), `× ${fmtNum(c.gain, 3)}${bi ? ` + ${E(c.vref, 'V')}` : ''}`);

    // axis helper
    const axis = (x, lo, hi, Yf, fmt, side, cls) => {
      add(line(x, yT, x, yB, 'axis'));
      const st = niceStep(hi - lo, narrow ? 4 : 6);
      for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + 1e-9; v += st) {
        const y = Yf(v);
        add(line(x - 4, y, x + 4, y, 'tick'));
        add(txt(x + side * 8, y + 3.5, fmt(Math.abs(v) < st / 1e6 ? 0 : v), `m sm soft ${cls || ''}`, side < 0 ? 'end' : 'start'));
      }
    };
    axis(x1, iLo, iHi, YI, (v) => E(v, 'A', 2), -1);
    axis(x2, vsLo, vsTop, YS, (v) => `${fmtNum(v * 1000, 3)}`, -1);
    add(txt(x2 - 8, yT - 8, 'mV', 'm sm soft', 'end'));
    axis(x4, vLo, vTop, YV, (v) => `${fmtNum(v, 3)}`, -1);
    add(txt(x4 - 8, yT - 8, 'V', 'm sm soft', 'end'));
    // codes, on the right of the volt scale
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const v = q * c.vfs;
      add(line(x4, YV(v), x4 + 5, YV(v), 'tick'), txt(x4 + 8, YV(v) + 3.5, String(Math.round(q * c.codes)), 'm sm soft'));
    }
    add(txt(x4 + 8, yT - 8, 'codes', 'm sm soft'));

    // ADC: over the full scale -> red; unused part above the "use" line -> spare
    if (c.vout > c.vfs) add(sv('rect', { x: x4 - 12, y: YV(c.vout), width: 24, height: YV(c.vfs) - YV(c.vout), class: 'over' }), line(x4 - 14, YV(c.vfs), x4 + 14, YV(c.vfs), 'over-e'));
    // mV scale: over the limit
    add(sv('rect', { x: x2 - 12, y: YS(vsTop), width: 24, height: YS(c.vshMax) - YS(vsTop), class: 'over' }));
    if (bi) add(sv('rect', { x: x2 - 12, y: YS(-c.vshMax), width: 24, height: YS(vsLo) - YS(-c.vshMax), class: 'over' }));
    // offset error: a band around zero on the mV scale
    if (c.vos) {
      const yo0 = YS(c.vos * 1e-6), yo1 = YS(bi ? -c.vos * 1e-6 : 0);
      add(sv('rect', { x: x2 - 7, y: yo0, width: 14, height: Math.max(2, yo1 - yo0), class: 'off' }));
      add(txt(x2 + 12, YS(0) + (bi ? 14 : -6), narrow ? `offset ±${E(c.offI, 'A')}` : `offset ±${fmtNum(c.vos, 3)} µV = ${E(c.offI, 'A')}`, 'm sm mv-t'));
    }

    // markers at full current
    const mark = (x, y, label, cls, side = 1) => {
      add(line(x - 9, y, x + 9, y, 'mark'));
      add(txt(x + side * 14, y + 4, label, `m b ${cls}`, side < 0 ? 'end' : 'start'));
    };
    mark(x2, YS(c.vsFull), `${fmtNum(c.vsFull * 1000, 3)} mV`, 'mv-t', 1);
    const markV = (v, label) => {
      add(line(x4 - 9, YV(v), x4 + 9, YV(v), 'mark'));
      if (!narrow) add(txt(x4 + 50, YV(v) + 4, label, `m b ${c.over && v === c.vout ? 'danger' : 'v-t'}`));
      else add(txt(x4 - 12, YV(v) - 5, label.split(' · ')[0], `m sm b ${c.over && v === c.vout ? 'danger' : 'v-t'}`, 'end'));
    };
    markV(c.vout, `${fmtNum(c.vout, 3)} V · ${c.counts} codes`);
    if (bi) { mark(x2, YS(-c.vsFull), `−${fmtNum(c.vsFull * 1000, 3)} mV`, 'mv-t', 1); markV(c.vlo, `${fmtNum(c.vlo, 3)} V`); }

    // resolution note at the ADC
    add(txt(x4 + 8, yB + 22, narrow ? `1 step = ${E(c.perStep, 'A')}` : `1 step = ${E(c.lsb, 'V')} = ${E(c.perStep, 'A')}`, 'm sm b', narrow ? 'end' : 'start'));
    if (narrow) svg.lastChild.setAttribute('x', W - 4);
    add(txt(x4 - 8, yB + 22, narrow ? '' : `${fmtNum(c.usedPct, 3)} % of range used`, 'm sm soft', 'end'));

    // --- handles
    const handle = (cls, key, x, y, label, aria, valuetext, labelSide = -1) => {
      const g = sv('g', { class: `hd ${cls}`, tabindex: 0, role: 'slider', 'data-fk': `hd-${key}`, 'data-drag': key, 'aria-label': aria, 'aria-valuetext': valuetext });
      g.append(sv('rect', { x: x - 14, y: y - 10, width: 50, height: 20, class: 'hit' }),
        line(x, y, x + 30, y, 'line'),
        sv('rect', { x: x - 7, y: y - 7, width: 14, height: 14, rx: 3, class: 'knob' }),
        sv('rect', { x: x - 10, y: y - 10, width: 20, height: 20, rx: 5, class: 'ring' }));
      svg.append(g);
      if (label) add(txt(x + labelSide * 30, y - 6, label, `m sm b ${cls === 'i' ? 'i-t' : cls === 'mv' ? 'mv-t' : 'ok-t'}`, labelSide < 0 ? 'end' : 'start'));
      return g;
    };
    handle('i', 'imax', x1, YI(c.imax), '', 'Full-scale current', `${E(c.imax, 'A')}`);
    handle('mv', 'vsh', x2, YS(c.vshMax), '', 'Shunt voltage limit', `${fmtNum(c.vshMax * 1000, 3)} mV`);
    const yUse = YV(c.vref + c.use * (bi ? c.vfs / 2 : c.vfs));
    handle('use', 'head', x4, yUse, '', 'Share of the ADC range to use', `${Math.round(c.use * 100)} %`);
    if (bi) add(sv('line', { x1: x4, y1: YV(c.vref - c.use * c.vfs / 2), x2: x4 + 30, y2: YV(c.vref - c.use * c.vfs / 2), stroke: 'var(--ok)', 'stroke-width': 2, 'stroke-dasharray': '5 3' }));
    if (!narrow) {
      place(fields.imax.el, x1 - 48, YI(c.imax) - 10, 'end');
      place(fields.vsh.el, x2 - 48, YS(c.vshMax) - 10, 'end');
      place(fields.head.el, x4 - 48, yUse - 10, 'end');
    }
    if (narrow) { drawStagesNarrow(svg, c, x1, x2, x4); draw.prepend(svg); return; }

    // --- the stages, on the top row
    // current source
    const rs = 20;
    add(sv('path', { d: `M${x1 + rs},${yW} H${x2 - 60}`, class: 'wire-i' }));
    add(sv('circle', { cx: x1, cy: yW, r: rs, class: 'src' }), sv('path', { d: `M${x1 - 9},${yW} H${x1 + 7} m-6,-6 l6,6 l-6,6`, class: 'wire-i', 'stroke-width': 2 }));
    add(txt(x1, yW - rs - 10, narrow ? 'I' : 'load current', 'soft sm', 'middle'));
    add(txt(x1, yW + rs + 18, `${bi ? '±' : ''}${E(c.imax, 'A')}`, 'm lg b i-t', 'middle'));
    // arrow on the wire
    const xa1 = (x1 + x2) / 2 - 20;
    add(sv('path', { d: `M${xa1},${yW - 6} l10,6 l-10,6 Z`, class: 'arrow-i' }));
    if (bi) add(sv('path', { d: `M${xa1 + 22},${yW - 6} l-10,6 l10,6 Z`, class: 'arrow-i' }));

    // shunt package, top view, scaled to its size code
    const [lmm, wmm] = SIZE_MM[c.size] || [6.3, 3.2];
    const pw = clamp(lmm * 15, 76, 150), ph = clamp(wmm * 15, 28, 60);
    const sx0 = x2 - pw / 2, sy0 = yW - ph / 2;
    add(sv('path', { d: `M${x2 + pw / 2},${yW} H${x2 + pw / 2 + (narrow ? 16 : 34)} V${yW + 44}`, class: 'wire-i' }));
    add(line(x2 + pw / 2 + (narrow ? 4 : 22), yW + 44, x2 + pw / 2 + (narrow ? 28 : 46), yW + 44, 'gnd'),
      line(x2 + pw / 2 + (narrow ? 8 : 26), yW + 48, x2 + pw / 2 + (narrow ? 24 : 42), yW + 48, 'gnd'));
    add(sv('rect', { x: sx0, y: sy0, width: pw, height: ph, rx: 2, class: 'body' }));
    const padW = pw * 0.24;
    add(sv('rect', { x: sx0, y: sy0, width: padW, height: ph, class: 'pad' }), sv('rect', { x: sx0 + pw - padW, y: sy0, width: padW, height: ph, class: 'pad' }));
    const heat = clamp(c.p / Math.max(c.sizeW || 1, 0.01), 0.1, 1);
    add(sv('rect', { x: sx0 + padW + 3, y: sy0 + ph * 0.28, width: pw - 2 * padW - 6, height: ph * 0.44, class: 'elem', 'fill-opacity': 0.35 + 0.6 * heat }));
    add(txt(x2, sy0 + ph / 2 + 4, E(c.r, 'Ω'), 'm b body-t', 'middle'));
    // Kelvin sense lines from the pads' inner edges up to the amplifier
    const ks = [sx0 + padW - 3, sx0 + pw - padW + 3];
    const yAmp = 60;
    add(sv('path', { d: `M${ks[0]},${sy0 + 2} V${yAmp - 7} H${xa - 30}`, class: 'sense' }), sv('path', { d: `M${ks[1]},${sy0 + 2} V${yAmp + 7} H${xa - 30}`, class: 'sense' }));
    add(sv('circle', { cx: ks[0], cy: sy0 + 2, r: 2.5, class: 'mv-t' }), sv('circle', { cx: ks[1], cy: sy0 + 2, r: 2.5, class: 'mv-t' }));
    add(txt(x2, yW + ph / 2 + 16, `${E(c.p, 'W')} at Imax`, `m sm ${c.p > 1 ? 'danger b' : 'soft'}`, 'middle'));
    add(txt(x2, yW + ph / 2 + 29, c.size ? `rating ≥ ${E(c.rating, 'W')} · ${c.size}` : `rating ≥ ${E(c.rating, 'W')} · off chip`, 'm sm soft', 'middle'));
    if (!narrow) add(txt(sx0 - 6, yAmp - 12, 'Kelvin sense', 'mv-t sm', 'end'));

    // amplifier
    const aw = narrow ? 44 : 58, ahh = narrow ? 28 : 34;
    add(sv('path', { d: `M${xa - 30},${yAmp - ahh} L${xa - 30 + aw},${yAmp} L${xa - 30},${yAmp + ahh} Z`, class: 'amp' }));
    add(txt(xa - 26, yAmp - 3, '+', 'body-t sm'), txt(xa - 26, yAmp + 12, '−', 'body-t sm'));
    add(txt(xa - 30 + aw * 0.38, yAmp + 4, `×${fmtNum(c.gain, 3)}`, 'm b body-t', 'middle'));
    add(sv('path', { d: `M${xa - 30 + aw},${yAmp} H${x4 - 30}`, class: 'sig' }));
    add(txt((xa - 30 + aw + x4 - 30) / 2, yAmp - 6, `${fmtNum(c.vout, 3)} V at Imax`, 'm sm v-t', 'middle'));
    if (bi) add(sv('path', { d: `M${xa - 4},${yAmp + ahh * 0.5} V${yAmp + ahh + 10}`, class: 'sig', 'stroke-dasharray': '3 3' }), txt(xa - 4, yAmp + ahh + 22, `REF ${E(c.vref, 'V')}`, 'm sm v-t', 'middle'));
    // gain steps under it
    if (c.gains) {
      const gw = narrow ? 30 : 38;
      const gx0 = xa - ((c.gains.length * (gw + 3)) - 3) / 2 + (narrow ? -6 : 0);
      c.gains.forEach((g, i) => {
        const on = g === c.gain, too = g > c.gNeed * 1.0001;
        const gg = sv('g', { class: `gchip${on ? ' on' : ''}${too ? ' too' : ''}` });
        gg.append(sv('rect', { x: gx0 + i * (gw + 3), y: yW + (bi ? 26 : 10), width: gw, height: 16, rx: 3 }),
          txt(gx0 + i * (gw + 3) + gw / 2, yW + (bi ? 26 : 10) + 12, String(g), 'm sm', 'middle'),
          sv('title', {}, too ? `${g}: overflows the ADC range` : on ? `${g}: used` : `${g}: fits, less resolution`));
        svg.append(gg);
      });
      add(txt(xa, yW + (bi ? 26 : 10) + 30, `needs ≤ ${fmtNum(c.gNeed, 3)}`, 'm sm soft', 'middle'));
    } else add(txt(xa, yW + 22, `gain ${fmtNum(c.gain, 3)} with resistors`, 'm sm soft', 'middle'));
    place(fields.vos.el, xa - 30, yAmp - ahh - 24, 'start');

    // ADC
    const bw = 124, bh = 70;
    const bx0 = x4 - 30, by0 = yAmp - 30;
    add(sv('rect', { x: bx0, y: by0, width: bw, height: bh, rx: 4, class: 'adc' }));
    add(txt(bx0 + 8, by0 + 16, 'ADC', 'body-t b'));
    place(fields.vfs.el, bx0 + 8, by0 + 22);
    place(fields.bits.el, bx0 + 8, by0 + 44);
    // pointer from the ADC down to its scale
    add(line(x4, by0 + bh, x4, yT - 16, 'tick'));
    add(line(x1, yW + rs + 26, x1, yT - 16, 'tick'), line(x2, yW + ph / 2 + 36, x2, yT - 16, 'tick'));

    draw.prepend(svg);
  }

  // Narrow: each scale gets a small header for its stage instead of the drawn row.
  function drawStagesNarrow(svg, c, x1, x2, x4) {
    const add = (el) => svg.append(el);
    const hd = (x, y, a, b, cls) => { add(txt(x, y, a, `sm soft`, 'middle')); add(txt(x, y + 16, b, `m b ${cls}`, 'middle')); };
    hd(x1, 14, 'current', `${c.bi ? '±' : ''}${E(c.imax, 'A')}`, 'i-t');
    hd(x2, 14, `shunt · ${E(c.p, 'W')}`, E(c.r, 'Ω'), 'mv-t');
    hd(x4, 14, `×${fmtNum(c.gain, 3)} → ADC`, `${fmtNum(c.vout, 3)} V`, c.over ? 'danger' : 'v-t');
    add(txt(x1, 50, c.size ? `rating ≥ ${E(c.rating, 'W')}, ${c.size}` : `≥ ${E(c.rating, 'W')}`, 'm sm soft', 'start'));
    svg.lastChild.setAttribute('x', 4);
    add(txt(x4 + 30, 50, `${c.counts} codes`, 'm sm soft', 'end'));
  }

  // ---------- shunts nearby ----------
  function drawList() {
    const c = C();
    list.replaceChildren();
    if (!c) return;
    const maxP = Math.max(...c.neighbours.map((n) => n.p));
    const steps = c.neighbours.map((n) => n.perStep).filter((v) => v != null);
    const best = Math.min(...steps), worst = Math.max(...steps);
    for (const n of c.neighbours) {
      const on = Math.abs(n.r - c.r) < 1e-12;
      const res = n.perStep == null ? 0 : worst === best ? 1 : 0.25 + 0.75 * (worst - n.perStep) / (worst - best);
      list.append(h('button', { type: 'button', class: `cs-opt${n.gain == null ? ' over' : ''}`, 'aria-pressed': String(on), 'data-fk': `sh-${n.r}`,
        title: `${E(n.r, 'Ω')}: ${fmtNum(n.mv, 3)} mV at Imax, ${E(n.p, 'W')}, gain ${n.gain ?? 'overflows'}`,
        onclick: () => setVsh(n.mv) },
      h('span', { class: 'top' }, h('b', {}, E(n.r, 'Ω')), h('span', { class: 'm' }, `${fmtNum(n.mv, 3)} mV`)),
      h('span', { class: 'm' }, E(n.p, 'W')),
      h('div', { class: 'bar p' }, h('i', { style: `width:${(n.p / maxP) * 100}%` })),
      h('span', { class: 'm' }, n.gain == null ? 'overflows' : `×${fmtNum(n.gain, 3)} · ${E(n.perStep, 'A')}`),
      h('div', { class: 'bar res' }, h('i', { style: `width:${res * 100}%` }))));
    }
  }

  // ---------- pointer and keys ----------
  const valueAt = (key, clientY) => {
    const g = state.geo; if (!g) return null;
    const rect = draw.getBoundingClientRect();
    const y = clientY - rect.top;
    const f = (yB) => (g.yB - y) / (g.yB - g.yT);
    if (key === 'imax') return g.iLo + f() * (g.iHi - g.iLo);
    if (key === 'vsh') return (g.vsLo + f() * (g.vsTop - g.vsLo)) * 1000;
    if (key === 'head') {
      const c = C(); const v = g.vLo + f() * (g.vTop - g.vLo);
      return ((v - c.vref) / (c.bi ? c.vfs / 2 : c.vfs)) * 100;
    }
    return null;
  };
  const apply = (key, v) => {
    if (v == null) return;
    if (key === 'imax') setImax(Math.max(0.01, v));
    else if (key === 'vsh') setVsh(v);
    else if (key === 'head') setUse(v);
  };
  draw.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.('[data-drag]'); if (!g) return;
    e.preventDefault(); g.focus({ preventScroll: true }); capture(draw, e);
    // scales stay put during a drag, so the handle follows the pointer
    state.drag = { key: g.dataset.drag, geo: state.geo };
  });
  draw.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    const keep = state.geo; state.geo = d.geo;
    const v = valueAt(d.key, e.clientY);
    state.geo = keep;
    apply(d.key, v);
  });
  const end = () => { state.drag = null; };
  draw.addEventListener('pointerup', end);
  draw.addEventListener('pointercancel', end);
  draw.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('[data-drag]'); if (!g) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key]; if (!d) return;
    e.preventDefault();
    const c = C(); if (!c) return;
    const fine = e.shiftKey;
    if (g.dataset.drag === 'imax') { const st = 10 ** Math.floor(Math.log10(c.imax)) * (fine ? 0.1 : 0.5); setImax(c.imax + d * st); }
    if (g.dataset.drag === 'vsh') setVsh(c.vshMax * 1000 + d * (fine ? 1 : 5));
    if (g.dataset.drag === 'head') setUse(c.use * 100 + d * (fine ? 1 : 5));
  });

  // ---------- draw ----------
  const drawAll = () => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    const r = ctx.result || {};
    syncFields();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(r.notes || []).map((w) => h('div', {}, w)));
    drawChain(); drawList();
    if (fk && document.activeElement?.getAttribute?.('data-fk') !== fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  ctx.onResult(drawAll);
  let lastW = 0;
  new ResizeObserver(() => { const w = draw.clientWidth; if (Math.abs(w - lastW) > 1) { lastW = w; drawAll(); } }).observe(draw);
}
