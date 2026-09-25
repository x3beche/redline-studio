// Fuse & Polyfuse Selector: the page is the fuse's time-current plane.
//   Chart  - current across, time up, both log: the normal current the fuse
//            carries for ever, the rating chosen from the standard ladder
//            (under the axis), the UL 248-14 points where it has to have
//            opened, the inrush pulse it must survive with the melting-I²t
//            line its curve has to stay above, and the fault it must clear.
//            Drag the normal current, the fault and the inrush point; the
//            thermometer at the side re-rates it for the ambient.
//   Parts  - the three kinds of fuse drawn; click one. The chosen one wears
//            its rating and voltage the way a real part is marked.
//   Pulse  - the inrush current against time: pick its shape, drag its
//            peak and its length; the I²t is the shaded area.
// Every number shown comes from run()'s result (result.fuse, result.values).
import { fmtEng } from '../kit/eng.js';

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
const sv = (parent, tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const A = (v) => fmtEng(v, 'A', 3);
const tS = (s) => (s >= 3600 ? `${f(s / 3600)} h` : s >= 60 ? `${f(s / 60)} min` : fmtEng(s, 's', 3));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
// 3 significant figures, for values dragged on a log scale
const round3 = (v) => Number(Number(v).toPrecision(v < 1 ? 2 : 3));

function svgBox(cls, label, draw, minW = 160) {
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': label });
  const box = h('div', { class: `fu-box ${cls}` }, svg);
  let last = '';
  new ResizeObserver(() => {
    const key = `${box.clientWidth}x${box.clientHeight}`;
    if (key !== last) { last = key; draw(); }
  }).observe(box);
  return { svg, box, size: () => [Math.max(minW, box.clientWidth), Math.max(100, box.clientHeight)] };
}
function dragger(svg, el, fn, onStart) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); capture(svg, e); onStart?.();
    const vb = svg.viewBox.baseVal;
    const at = (ev) => { const r = svg.getBoundingClientRect(); fn((ev.clientX - r.left) * (vb.width / r.width), (ev.clientY - r.top) * (vb.height / r.height)); };
    const up = () => { svg.removeEventListener('pointermove', at); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up); };
    svg.addEventListener('pointermove', at); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  });
}

const TYPES = [['fast', 'Fast-acting'], ['slow', 'Time-delay'], ['ptc', 'PTC resettable']];
const SHAPES = [['none', 'None'], ['exp', 'Cap charge'], ['rect', 'Rectangle'], ['tri', 'Triangle'], ['sine', 'Half sine']];
const PULSES = [['1000', '1 k'], ['10000', '10 k'], ['100000', '100 k']];

export function page(root, ctx) {
  let F = null, R = null, focusKey = null;

  const num = (key, label, unit, title, width = 54) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': title, style: `width:${width}px`,
      oninput: (e) => ctx.set(key, e.target.value.trim()) });
    const w = h('label', { class: 'fu-num', title }, h('span', {}, label), inp, unit ? h('small', {}, unit) : null);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const seg = (label, key, items, cls = '') => {
    const g = h('div', { class: `fu-seg ${cls}`, role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, glyph]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title: t, onclick: () => ctx.set(key, v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const i = clamp(items.findIndex((it) => it[0] === v) + d, 0, items.length - 1);
        ctx.set(key, items[i][0]); requestAnimationFrame(() => g.querySelector(`[data-v="${items[i][0]}"]`)?.focus());
      } }, glyph || t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };

  // ---------- chart ----------
  const inomF = num('inom', 'Normal', 'A', 'Normal operating current, A');
  const faultF = num('ifault', 'Fault', 'A', 'Fault current available, A');
  const vF = num('vcirc', 'Circuit', 'V', 'Circuit voltage, V', 46);
  const tF = num('temp', 'Ambient', '°C', 'Ambient temperature around the fuse, °C', 42);
  const chart = svgBox('fu-chartbox', 'Time-current plane', () => drawChart());
  const thermo = svgBox('fu-thermobox', 'Ambient temperature', () => drawThermo(), 40);
  const warn = h('div', { class: 'fu-warns', 'aria-live': 'polite' });
  const legend = h('div', { class: 'fu-legend' });
  const pChart = h('section', { class: 'fu-panel fu-chart' },
    h('div', { class: 'fu-head' }, h('h2', {}, 'Time against current'), h('span', { class: 'fu-sub' }, 'log–log · drag the lines and the pulse'), h('div', { class: 'fu-grow' }), inomF, faultF, vF, tF),
    h('div', { class: 'fu-plot' }, thermo.box, chart.box), legend, warn);

  // ---------- parts ----------
  const parts = h('div', { class: 'fu-parts', role: 'radiogroup', 'aria-label': 'Fuse type' });
  const facts = h('dl', { class: 'fu-facts' });
  const pParts = h('section', { class: 'fu-panel fu-partsp' }, h('div', { class: 'fu-head' }, h('h2', {}, 'The part')), parts, facts);

  // ---------- pulse ----------
  const shapeSeg = seg('Inrush pulse shape', 'wave', SHAPES.map(([v, t]) => [v, t, glyph(v)]), 'fu-shapes');
  const pulseSeg = seg('Inrush pulses over life', 'pulses', PULSES);
  const ipkF = num('ipk', 'peak', 'A', 'Inrush peak current, A', 46);
  const tpF = num('tp', '', 'ms', 'Inrush duration (τ for exponential), ms', 46);
  const pulse = svgBox('fu-pulsebox', 'Inrush pulse', () => drawPulse());
  const pulseFoot = h('div', { class: 'fu-pfoot' });
  const pPulse = h('section', { class: 'fu-panel fu-pulse' },
    h('div', { class: 'fu-head' }, h('h2', {}, 'Inrush'), shapeSeg, h('div', { class: 'fu-grow' }), ipkF, tpF),
    pulse.box, h('div', { class: 'fu-pbar' }, h('span', { class: 'fu-sub' }, 'pulses over life'), pulseSeg, pulseFoot));

  root.append(h('div', { class: 'fu' }, pChart, pParts, pPulse, h('div', { class: 'fu-out' }, ctx.outputs)));

  const refocus = (svg) => {
    if (!focusKey) return;
    const el = svg.querySelector(`[data-key="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  };
  const keyed = (g, key, title, onKey) => {
    g.setAttribute('tabindex', '0'); g.setAttribute('data-key', key); g.setAttribute('role', 'slider'); g.setAttribute('aria-label', title);
    g.addEventListener('keydown', (e) => { if (onKey(e)) { e.preventDefault(); focusKey = key; } });
    g.addEventListener('focus', () => { focusKey = key; });
    g.addEventListener('blur', () => setTimeout(() => { if (focusKey === key && !g.ownerSVGElement?.contains(document.activeElement)) focusKey = null; }, 0));
    sv(g, 'title', {}, `${title}: drag, or arrow keys (Shift = bigger steps)`);
  };
  const mul = (e) => (e.shiftKey ? 1.25 : 1.05);

  // ---------- the time-current chart ----------
  function drawChart() {
    if (!F) return;
    const svg = chart.svg; svg.replaceChildren();
    const [W, H] = chart.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const narrow = W < 520;
    const L = 50, Rm = 14, T = 26, B = 64;
    const rating = F.pick || F.minRating;
    const xs = [F.inom, rating, F.ifault, F.ipk, F.minRating].filter((v) => v > 0);
    const x0 = 10 ** Math.floor(Math.log10(Math.min(...xs) / 1.6));
    const x1 = 10 ** Math.ceil(Math.log10(Math.max(...xs, rating * 10) * 1.6));
    const tmin = F.tp && F.tp * 1e-3 < 2e-4 ? 1e-5 : 1e-4, tmax = 10800;
    const X = (i) => L + ((Math.log10(i) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))) * (W - L - Rm);
    const Y = (t) => T + ((Math.log10(tmax) - Math.log10(clamp(t, tmin, tmax))) / (Math.log10(tmax) - Math.log10(tmin))) * (H - T - B);
    const Ix = (px) => 10 ** (Math.log10(x0) + ((px - L) / (W - L - Rm)) * (Math.log10(x1) - Math.log10(x0)));
    const Ty = (py) => 10 ** (Math.log10(tmax) - ((py - T) / (H - T - B)) * (Math.log10(tmax) - Math.log10(tmin)));
    const yB = H - B;
    const defs = sv(svg, 'defs');
    const pt = sv(defs, 'pattern', { id: 'fu-hatch', patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' });
    sv(pt, 'line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'fu-hatch-l' });
    const clip = sv(defs, 'clipPath', { id: 'fu-clip' });
    sv(clip, 'rect', { x: L, y: T, width: W - L - Rm, height: yB - T });

    // grid
    for (let d = x0; d <= x1 * 1.0001; d *= 10) {
      for (const m of [1, 2, 5]) {
        const v = d * m; if (v > x1 * 1.0001) break;
        sv(svg, 'line', { x1: X(v), x2: X(v), y1: T, y2: yB, class: m === 1 ? 'fu-grid1' : 'fu-grid' });
        if (m === 1 || (!narrow && W > 640)) sv(svg, 'text', { x: X(v), y: yB + 12, class: 'fu-ax', 'text-anchor': 'middle' }, A(v).replace(' ', ''));
      }
    }
    for (const t of [1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1, 10, 60, 600, 3600, 10800]) {
      if (t < tmin) continue;
      sv(svg, 'line', { x1: L, x2: W - Rm, y1: Y(t), y2: Y(t), class: 'fu-grid1' });
      sv(svg, 'text', { x: L - 5, y: Y(t) + 3, class: 'fu-ax', 'text-anchor': 'end' }, tS(t).replace(' ', ''));
    }
    sv(svg, 'text', { x: W - Rm, y: H - 4, class: 'fu-ax', 'text-anchor': 'end' }, 'current →');
    sv(svg, 'text', { x: L - 5, y: T - 12, class: 'fu-ax', 'text-anchor': 'end' }, 'time');
    const plot = sv(svg, 'g', { 'clip-path': 'url(#fu-clip)' });

    // may-never-open (fuse) / may-trip (PTC) band
    if (F.pick) {
      const a = F.ptc ? F.pick : F.pick, b = F.ptc ? F.trip : F.pick * 1.35;
      sv(plot, 'rect', { x: X(a), y: T, width: X(b) - X(a), height: yB - T, class: 'fu-maybe' });
      if (X(b) - X(a) > 12) {
        const mx = (X(a) + X(b)) / 2 + 3, my = Y(10);
        sv(plot, 'text', { x: mx, y: my, class: 'fu-t fu-sm fu-maybe-t', 'text-anchor': 'middle', transform: `rotate(-90 ${mx} ${my})` }, F.ptc ? 'may or may not trip' : 'may never open');
      }
    }
    // the pulse zone: the fuse's short-time curve must stay above the
    // melting-I²t line (the pulse's own I²t divided by the pulse factor)
    if (!F.ptc && F.needI2t > 0) {
      const pts = [];
      for (let k = 0; k <= 40; k++) { const i = 10 ** (Math.log10(x0) + (k / 40) * (Math.log10(x1) - Math.log10(x0))); pts.push([i, F.needI2t / (i * i)]); }
      const line = pts.map(([i, t], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(t).toFixed(1)}`).join('');
      sv(plot, 'path', { d: `${line} L${X(x1)},${yB} L${X(x0)},${yB} Z`, class: 'fu-melt-zone' });
      sv(plot, 'path', { d: line, class: 'fu-melt' });
      const own = pts.map(([i]) => [i, F.i2t / (i * i)]).map(([i, t], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(t).toFixed(1)}`).join('');
      sv(plot, 'path', { d: own, class: 'fu-own' });
      // label the melting line where it crosses the middle of the plot
      const tl = 0.01;
      const il = Math.sqrt(F.needI2t / tl);
      if (il > x0 && il < x1) {
        const t1 = `melting I²t ≥ ${fmtEng(F.needI2t, 'A²s', 3)}`, t2 = 'the fuse\'s curve stays above';
        const right = X(il) + 8 + t2.length * 6.1 < W - Rm;
        const lx = right ? X(il) + 6 : Math.max(X(il) - 8, L + t1.length * 6.1 + 4), ly = Y(tl), an = right ? 'start' : 'end';
        sv(svg, 'text', { x: lx, y: ly, class: 'fu-t fu-sm fu-melt-t', 'text-anchor': an }, t1);
        if (!narrow) sv(svg, 'text', { x: lx, y: ly + 12, class: 'fu-t fu-sm fu-soft', 'text-anchor': an }, t2);
      }
    }
    // UL opening points
    const ulLabels = [];
    if (F.pick && F.ul.length) {
      const [p1, p2] = F.ul;
      sv(plot, 'path', { d: `M${X(p1.x * F.pick)},${T} V${Y(p1.t)} H${X(p2.x * F.pick)} V${Y(p2.t)} H${W - Rm}`, class: 'fu-ul' });
      for (const p of F.ul) {
        const x = X(p.x * F.pick), y = Y(p.t);
        sv(svg, 'path', { d: `M${x},${y - 5} l5,5 l-5,5 l-5,-5 z`, class: 'fu-ul-pt' });
        ulLabels.push({ x: x + 8, y: y + 14, text: `${f(p.x * 100)} % opens ≤ ${tS(p.t)}` });
      }
    }

    // vertical current lines
    const vline = (i, cls, label, sub, key, set, title) => {
      if (!(i > 0)) return null;
      const x = X(clamp(i, x0, x1));
      const g = sv(svg, 'g', { class: `fu-v ${cls}` });
      sv(g, 'line', { x1: x, x2: x, y1: T, y2: yB, class: 'fu-v-ln' });
      const tw = Math.max(label.length * 6.8, (sub || '').length * 6.1) + 12;
      const right = x + tw + 4 < W - Rm;
      const tx = right ? x + 4 : x - tw - 4;
      if (key) {
        sv(g, 'rect', { x: x - 7, y: T, width: 14, height: yB - T, class: 'fu-hit' });
        sv(g, 'rect', { x: x - 5, y: yB - 16, width: 10, height: 16, rx: 3, class: 'fu-knob' });
      }
      g.dataset.lx = tx; g.dataset.lw = tw; g.dataset.x = x;
      const lab = sv(g, 'g', { class: 'fu-v-lab' });
      sv(lab, 'rect', { x: tx, y: 0, width: tw, height: sub ? 30 : 17, rx: 3, class: 'fu-v-cap' });
      sv(lab, 'text', { x: tx + 6, y: 12, class: 'fu-t fu-b fu-v-t' }, label);
      if (sub) sv(lab, 'text', { x: tx + 6, y: 25, class: 'fu-t fu-sm fu-v-s' }, sub);
      if (key) {
        dragger(svg, g, (px) => set(round3(clamp(Ix(px), x0, x1))), () => { focusKey = key; g.focus({ preventScroll: true }); });
        keyed(g, key, title, (e) => {
          const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
          if (!d) return false;
          set(round3(i * mul(e) ** d)); return true;
        });
      }
      return g;
    };
    const lines = [];
    lines.push(vline(F.inom, 'fu-v-nom', `normal ${A(F.inom)}`, F.ptc ? 'must hold' : 'carried for ever', 'inom', (v) => ctx.set('inom', String(v)), 'Normal operating current'));
    if (F.minRating && (!F.pick || Math.abs(X(F.minRating) - X(F.pick)) > 3)) lines.push(vline(F.minRating, 'fu-v-min', `min ${A(F.minRating)}`, F.ptc ? 'hold at ambient' : '75 % derated'));
    if (F.pick) lines.push(vline(F.pick, 'fu-v-pick', `${A(F.pick)} ${F.ptc ? 'hold' : 'fuse'}`, `standard ${F.ptc ? 'hold' : 'rating'}`));
    if (F.trip) lines.push(vline(F.trip, 'fu-v-trip', `trip ~${A(F.trip)}`, '≈ 2 × hold'));
    if (F.ifault) lines.push(vline(F.ifault, `fu-v-fault ${F.tone || ''}`, `fault ${A(F.ifault)}`, F.ratio != null ? `${f(F.ratio, 3)} × ${F.ptc ? 'trip' : 'rating'}` : 'no rating fits',
      'ifault', (v) => ctx.set('ifault', String(v)), 'Fault current available'));
    // stack the labels so none overlap: row by row from the top
    const rows = [], taken = [];
    for (const g of lines.filter(Boolean).sort((a, b) => Number(a.dataset.x) - Number(b.dataset.x))) {
      const lx = Number(g.dataset.lx), lw = Number(g.dataset.lw);
      let r = 0;
      while (rows[r] != null && rows[r] > lx - 4) r++;
      rows[r] = lx + lw;
      g.querySelector('.fu-v-lab').setAttribute('transform', `translate(0,${T + 4 + r * 34})`);
      taken.push({ x: lx, y: T + 4 + r * 34, w: lw, h: 30 });
    }
    for (const u of ulLabels) {
      const w = u.text.length * 6.1;
      let y = u.y;
      const over = () => taken.some((b) => u.x < b.x + b.w && b.x < u.x + w && y - 10 < b.y + b.h && b.y < y + 3);
      for (let k = 0; k < 8 && over(); k++) y += 14;
      sv(svg, 'text', { x: Math.min(u.x, W - Rm - w), y, class: 'fu-t fu-sm fu-ul-t' }, u.text);
      taken.push({ x: u.x, y: y - 10, w, h: 13 });
    }

    // the inrush point
    if (F.wave !== 'none' && F.ipk && F.tp) {
      const x = X(clamp(F.ipk, x0, x1)), y = Y(F.tp * 1e-3);
      const bad = !F.ptc ? (F.type === 'fast' && F.ipk > 10 * rating) : (F.trip && F.ipk > F.trip && F.tp > 5);
      const g = sv(svg, 'g', { class: `fu-pulse-pt${bad ? ' bad' : ''}` });
      sv(g, 'circle', { cx: x, cy: y, r: 14, class: 'fu-hit' });
      sv(g, 'rect', { x: x - 7, y: y - 7, width: 14, height: 14, rx: 2, transform: `rotate(45 ${x} ${y})`, class: 'fu-pp' });
      const lab = `inrush ${A(F.ipk)} · ${tS(F.tp * 1e-3)}`;
      const right = x + 14 + lab.length * 6.7 < W - Rm;
      sv(g, 'text', { x: right ? x + 14 : x - 14, y: y + 4, class: 'fu-t fu-b fu-pp-t', 'text-anchor': right ? 'start' : 'end' }, lab);
      if (!F.ptc && F.i2t > 0) sv(g, 'text', { x: right ? x + 14 : x - 14, y: y + 17, class: 'fu-t fu-sm fu-soft', 'text-anchor': right ? 'start' : 'end' }, `I²t ${fmtEng(F.i2t, 'A²s', 3)}`);
      dragger(svg, g, (px, py) => ctx.setMany({ ipk: String(round3(clamp(Ix(px), x0, x1))), tp: String(round3(clamp(Ty(py), tmin, 10) * 1e3)) }),
        () => { focusKey = 'pp'; g.focus({ preventScroll: true }); });
      keyed(g, 'pp', 'Inrush pulse: left/right = peak current, up/down = duration', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { ctx.set('ipk', String(round3(F.ipk * mul(e) ** (e.key === 'ArrowRight' ? 1 : -1)))); return true; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { ctx.set('tp', String(round3(F.tp * (e.shiftKey ? 2 : 1.25) ** (e.key === 'ArrowUp' ? 1 : -1)))); return true; }
        return false;
      });
    }

    // the standard ladder under the axis
    const ly = yB + 30;
    sv(svg, 'text', { x: L - 5, y: ly + 4, class: 'fu-ax', 'text-anchor': 'end' }, F.ptc ? 'holds' : 'ratings');
    sv(svg, 'line', { x1: L, x2: W - Rm, y1: ly, y2: ly, class: 'fu-ladder' });
    let lastX = -99;
    for (const v of F.list) {
      if (v < x0 || v > x1) continue;
      const x = X(v), on = v === F.pick, low = v < F.minRating * 0.9999;
      sv(svg, 'line', { x1: x, x2: x, y1: ly - (on ? 8 : 5), y2: ly + (on ? 8 : 5), class: `fu-rung${on ? ' on' : low ? ' low' : ''}` });
      if (on || (x - lastX > 30 && !narrow)) {
        sv(svg, 'text', { x, y: ly + 18, class: `fu-t fu-sm ${on ? 'fu-rung-on' : 'fu-soft'}`, 'text-anchor': 'middle' }, f(v));
        lastX = x;
      }
    }
    sv(svg, 'text', { x: X(Math.max(x0, F.minRating)) - 4, y: ly - 9, class: 'fu-t fu-sm fu-soft', 'text-anchor': 'end' }, narrow ? '' : 'too small ←');
    refocus(svg);
  }

  // ---------- thermometer ----------
  function drawThermo() {
    if (!F) return;
    const svg = thermo.svg; svg.replaceChildren();
    const [W, H] = thermo.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const T0 = -40, T1 = 125, top = 34, bot = H - 64;
    const Y = (t) => bot - ((t - T0) / (T1 - T0)) * (bot - top);
    const x = 16;
    sv(svg, 'rect', { x: x - 5, y: top - 6, width: 10, height: bot - top + 12, rx: 5, class: 'fu-th-tube' });
    sv(svg, 'circle', { cx: x, cy: bot + 12, r: 9, class: 'fu-th-bulb' });
    sv(svg, 'rect', { x: x - 2.5, y: Y(F.temp), width: 5, height: bot + 6 - Y(F.temp), class: 'fu-th-fill' });
    sv(svg, 'text', { x: 2, y: 14, class: 'fu-t fu-sm fu-soft' }, 'ambient');
    for (const r of F.temps) {
      const y = Y(r.t);
      sv(svg, 'line', { x1: x + 6, x2: x + 11, y1: y, y2: y, class: 'fu-th-tick' });
      sv(svg, 'text', { x: x + 13, y: y + 3, class: 'fu-t fu-sm fu-soft' }, `${r.t}°`);
      sv(svg, 'text', { x: W - 3, y: y + 3, class: `fu-t fu-sm ${r.std === F.pick ? 'fu-th-same' : 'fu-th-diff'}`, 'text-anchor': 'end' }, r.std != null ? f(r.std) : '–');
    }
    sv(svg, 'text', { x: W - 3, y: top - 12, class: 'fu-t fu-sm fu-soft', 'text-anchor': 'end' }, F.ptc ? 'hold' : 'fuse');
    const g = sv(svg, 'g', { class: 'fu-th-h' });
    const y = Y(clamp(F.temp, T0, T1));
    sv(g, 'rect', { x: 0, y: top - 8, width: W, height: bot - top + 16, class: 'fu-hit' });
    sv(g, 'rect', { x: x - 9, y: y - 5, width: 18, height: 10, rx: 3, class: 'fu-knob' });
    sv(svg, 'text', { x: W / 2, y: bot + 38, class: 'fu-t fu-b', 'text-anchor': 'middle' }, `${f(F.temp)} °C`);
    sv(svg, 'text', { x: W / 2, y: bot + 51, class: 'fu-t fu-sm fu-soft', 'text-anchor': 'middle' }, `K_T ${f(F.kT, 3)}`);
    const Ty = (py) => T0 + ((bot - py) / (bot - top)) * (T1 - T0);
    dragger(svg, g, (px, py) => ctx.set('temp', String(Math.round(clamp(Ty(py), T0, T1)))), () => { focusKey = 'temp'; g.focus({ preventScroll: true }); });
    keyed(g, 'temp', 'Ambient temperature', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!d) return false;
      ctx.set('temp', String(clamp(Math.round(F.temp) + d * (e.shiftKey ? 10 : 1), T0, T1))); return true;
    });
    refocus(svg);
  }

  // ---------- the parts ----------
  function drawParts() {
    parts.replaceChildren(...TYPES.map(([v, name]) => {
      const on = F.type === v;
      const s = sv(null, 'svg', { viewBox: '0 0 120 64', class: 'fu-body', 'aria-hidden': 'true' });
      const mark = on ? `${f(F.pick)}A${F.vcirc ? ` ${f(F.vcirc)}V` : ''}` : '';
      if (v === 'ptc') {
        sv(s, 'rect', { x: 26, y: 18, width: 68, height: 28, rx: 3, class: 'fu-ptc' });
        sv(s, 'rect', { x: 18, y: 18, width: 10, height: 28, rx: 1, class: 'fu-cap' });
        sv(s, 'rect', { x: 92, y: 18, width: 10, height: 28, rx: 1, class: 'fu-cap' });
        sv(s, 'text', { x: 60, y: 36, class: 'fu-mark', 'text-anchor': 'middle' }, on && F.pick ? `${f(F.pick)}A hold` : 'PTC');
      } else {
        sv(s, 'rect', { x: 22, y: 20, width: 76, height: 24, rx: 11, class: 'fu-glass' });
        sv(s, 'rect', { x: 8, y: 17, width: 20, height: 30, rx: 3, class: 'fu-cap' });
        sv(s, 'rect', { x: 92, y: 17, width: 20, height: 30, rx: 3, class: 'fu-cap' });
        if (v === 'fast') sv(s, 'path', { d: 'M28,32 C45,31 75,33 92,32', class: 'fu-wire' });
        else {
          let d = 'M28,32 L40,32';
          for (let k = 0; k < 7; k++) d += ` Q${43 + k * 5},${k % 2 ? 40 : 24} ${45 + k * 5},32`;
          sv(s, 'path', { d, class: 'fu-wire' });
          sv(s, 'path', { d: 'M78,32 L92,32', class: 'fu-wire' });
          sv(s, 'circle', { cx: 78, cy: 32, r: 3, class: 'fu-blob' });
        }
        if (mark) sv(s, 'text', { x: 60, y: 14, class: 'fu-mark fu-mark-top', 'text-anchor': 'middle' }, mark);
      }
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', class: 'fu-part', 'data-v': v,
        onclick: () => ctx.set('type', v),
        onkeydown: (e) => {
          const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!d) return; e.preventDefault();
          const i = clamp(TYPES.findIndex((t) => t[0] === v) + d, 0, TYPES.length - 1);
          ctx.set('type', TYPES[i][0]); requestAnimationFrame(() => parts.querySelector(`[data-v="${TYPES[i][0]}"]`)?.focus());
        } }, s, h('span', {}, name));
    }));
    facts.replaceChildren(...(R.values || []).flatMap((v) => [
      h('dt', { title: v.hint || null }, v.label),
      h('dd', { class: v.tone ? `fu-${v.tone}` : null, title: v.hint || null }, String(v.value), v.unit ? h('small', {}, ` ${v.unit}`) : null)]));
  }

  // ---------- the pulse ----------
  function drawPulse() {
    if (!F) return;
    const svg = pulse.svg; svg.replaceChildren();
    const [W, H] = pulse.size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (F.wave === 'none' || !F.ipk || !F.tp) {
      sv(svg, 'text', { x: W / 2, y: H / 2, class: 'fu-t fu-soft', 'text-anchor': 'middle' }, F.wave === 'none' ? 'No inrush: pick a shape' : 'Give the peak and the duration');
      return;
    }
    const L = 48, Rm = 12, T = 16, B = 22;
    const span = F.wave === 'exp' ? 5 * F.tp : 1.5 * F.tp;
    const X = (t) => L + (t / span) * (W - L - Rm), Y = (i) => T + (1 - i / (F.ipk * 1.18)) * (H - T - B);
    const shape = (t) => {
      const tp = F.tp;
      switch (F.wave) {
        case 'rect': return t <= tp ? F.ipk : 0;
        case 'tri': return t <= tp ? F.ipk * (1 - t / tp) : 0;
        case 'sine': return t <= tp ? F.ipk * Math.sin((Math.PI * t) / tp) : 0;
        default: return F.ipk * Math.exp(-t / tp);
      }
    };
    const n = 120, pts = [];
    for (let k = 0; k <= n; k++) { const t = (k / n) * span; pts.push([t, shape(t)]); }
    if (F.wave === 'rect') pts.splice(0, pts.length, [0, 0], [0, F.ipk], [F.tp, F.ipk], [F.tp, 0], [span, 0]);
    const d = pts.map(([t, i], k) => `${k ? 'L' : 'M'}${X(t).toFixed(1)},${Y(i).toFixed(1)}`).join('');
    sv(svg, 'line', { x1: L, x2: W - Rm, y1: Y(0), y2: Y(0), class: 'fu-axis' });
    sv(svg, 'line', { x1: L, x2: L, y1: T, y2: Y(0), class: 'fu-axis' });
    sv(svg, 'path', { d: `${d} L${X(span)},${Y(0)} L${X(0)},${Y(0)} Z`, class: 'fu-area' });
    sv(svg, 'path', { d, class: 'fu-wave' });
    sv(svg, 'text', { x: L - 10, y: Y(F.ipk) + 3, class: 'fu-ax', 'text-anchor': 'end' }, A(F.ipk).replace(' ', ''));
    sv(svg, 'text', { x: X(F.tp), y: H - 6, class: 'fu-ax', 'text-anchor': 'middle' }, `${F.wave === 'exp' ? 'τ ' : ''}${tS(F.tp * 1e-3)}`);
    sv(svg, 'line', { x1: X(F.tp), x2: X(F.tp), y1: Y(0), y2: Y(0) + 4, class: 'fu-axis' });
    if (F.i2t > 0) sv(svg, 'text', { x: X(span * 0.55), y: Y(F.ipk * 0.72), class: 'fu-t fu-b fu-area-t' }, `I²t ${fmtEng(F.i2t, 'A²s', 3)}`);
    // peak handle (vertical) and length handle (horizontal)
    const pk = sv(svg, 'g', { class: 'fu-ph' });
    const px0 = F.wave === 'sine' ? X(F.tp / 2) : X(0);
    sv(pk, 'rect', { x: px0 - 7, y: Y(F.ipk) - 7, width: 14, height: 14, rx: 3, class: 'fu-knob' });
    dragger(svg, pk, (px, py) => ctx.set('ipk', String(round3(clamp(F.ipk * 1.18 * (1 - (py - T) / (H - T - B)), 0.01, 1e4)))), () => { focusKey = 'ipk'; pk.focus({ preventScroll: true }); });
    keyed(pk, 'ipk', 'Inrush peak current', (e) => {
      const dd = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dd) return false; ctx.set('ipk', String(round3(F.ipk * mul(e) ** dd))); return true;
    });
    const ln = sv(svg, 'g', { class: 'fu-ph fu-ph-t' });
    const yl = F.wave === 'rect' ? Y(F.ipk / 2) : Y(shape(F.tp));
    sv(ln, 'rect', { x: X(F.tp) - 5, y: yl - 8, width: 10, height: 16, rx: 3, class: 'fu-knob' });
    dragger(svg, ln, (px) => ctx.set('tp', String(round3(clamp(((px - L) / (W - L - Rm)) * span, span * 0.02, span * 0.95)))), () => { focusKey = 'tp'; ln.focus({ preventScroll: true }); });
    keyed(ln, 'tp', 'Inrush duration', (e) => {
      const dd = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dd) return false; ctx.set('tp', String(round3(F.tp * mul(e) ** dd))); return true;
    });
    refocus(svg);
  }

  function glyph(v) {
    const s = sv(null, 'svg', { viewBox: '0 0 26 14', width: 26, height: 14, 'aria-hidden': 'true', class: 'fu-glyph' });
    const d = { none: 'M1,12 H25', exp: 'M2,12 V2 C6,9 12,11 25,12', rect: 'M2,12 V2 H16 V12 H25', tri: 'M2,12 V2 L16,12 H25', sine: 'M2,12 C4,-1 14,-1 16,12 H25' }[v];
    sv(s, 'path', { d });
    return s;
  }

  ctx.onResult((r) => {
    R = r; F = r.fuse || null;
    const raw = ctx.raw;
    inomF.sync(raw.inom); faultF.sync(raw.ifault); vF.sync(raw.vcirc); tF.sync(raw.temp); ipkF.sync(raw.ipk); tpF.sync(raw.tp);
    shapeSeg.sync(raw.wave); pulseSeg.sync(raw.pulses);
    warn.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    if (!F) { chart.svg.replaceChildren(); thermo.svg.replaceChildren(); pulse.svg.replaceChildren(); return; }
    pulseFoot.replaceChildren(...(F.ptc ? [h('span', {}, 'a PTC is checked against its trip current')] : F.i2t > 0
      ? [h('span', {}, 'melting I²t ≥ '), h('b', {}, fmtEng(F.needI2t, 'A²s', 3)), h('span', {}, ` (÷ ${f(F.factor * 100)} %)`)] : []));
    legend.replaceChildren(...[
      h('span', {}, h('i', { class: 'fu-k-nom' }), 'normal'),
      h('span', {}, h('i', { class: 'fu-k-pick' }), F.ptc ? 'hold / trip' : 'rating'),
      !F.ptc ? h('span', {}, h('i', { class: 'fu-k-ul' }), 'UL 248-14: must have opened') : null,
      !F.ptc && F.i2t > 0 ? h('span', {}, h('i', { class: 'fu-k-melt' }), 'melting I²t the fuse needs') : null,
      !F.ptc && F.i2t > 0 ? h('span', {}, h('i', { class: 'fu-k-own' }), 'the pulse\'s own I²t') : null,
      h('span', {}, h('i', { class: `fu-k-fault ${F.tone || ''}` }), 'fault')].filter(Boolean));
    drawChart(); drawThermo(); drawParts(); drawPulse();
  });
}
