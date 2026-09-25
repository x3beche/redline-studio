// Decoupling Planner: the page is the supply network itself.
//   Spec   - the requirement as one sentence you edit: the supply, the ripple it
//            may show and the current step, giving the target impedance.
//   Board  - the IC with its supply pins, and the planned capacitors placed
//            around it, drawn to their package size, with vias as the mounting
//            you chose. Pins are added on the IC; the package and the mounting
//            are picked from footprints.
//   Chart  - |Z| of the network against frequency, each capacitor group's own
//            curve in its board colour. Drag the target line up or down, drag
//            the band's ends; the plan is redone and redrawn.
// Every number shown comes from run()'s result (values and result.plot); the
// page only draws it. The per-group curves are the same series R-L-C that
// run() sums, drawn from the parts it returns.
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
const compact = (v) => fmtEng(v, '', 2).replace(/\s+/g, '');
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const GCOL = ['var(--tool-g0)', 'var(--tool-g1)', 'var(--tool-g2)', 'var(--tool-g3)', 'var(--tool-g4)', 'var(--tool-g5)'];
const PKG_MM = { '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], '1206': [3.2, 1.6], 'polymer (B case)': [3.5, 2.8] };
const MOUNTS = [[0.3, 'via in pad'], [0.5, 'vias at pads'], [1, 'short trace'], [2, 'long trace']];
// 1-2-5 steps for the band ends
const step125 = (v, d) => {
  const seq = [];
  for (let e = 0; e <= 10; e++) for (const m of [1, 2, 5]) seq.push(m * 10 ** e);
  if (d > 0) return seq.find((x) => x > v * 1.0001) ?? v;
  return [...seq].reverse().find((x) => x < v * 0.9999) ?? v;
};

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const P = () => ctx.result?.plot;
  const state = { hi: null, drag: null, geo: null };

  // ---------- fields ----------
  const fields = {};
  const field = (key, label, unit, aria, after) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, 'data-fk': `f-${key}`,
      oninput: (e) => ctx.set(key, e.target.value) });
    const el = h('label', { class: 'dp-f' }, label ? h('span', {}, label) : null, inp, unit ? h('span', {}, unit) : null, after || null);
    fields[key] = inp;
    return el;
  };

  // ---------- spec sentence ----------
  const target = h('span', { class: 'dp-target' });
  const verdict = h('span', { class: 'dp-verdict' });
  const spec = h('section', { class: 'dp-panel dp-spec', 'aria-label': 'Requirement' },
    field('vdd', 'A', 'V supply', 'Supply voltage in V'),
    field('ripple', 'may move', '%', 'Allowed ripple in %'),
    field('istep', 'when the load steps by', 'A,', 'Transient current step in A'),
    h('span', {}, 'so the network must stay under'), target,
    h('span', { class: 'dp-grow' }), verdict);

  // ---------- board ----------
  const bdraw = h('div', { class: 'dp-bdraw' });
  const legend = h('div', { class: 'dp-legend', role: 'list', 'aria-label': 'Capacitor plan' });
  const pkgRow = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': 'Small capacitor package' }, h('span', { class: 'dp-cap' }, 'small caps'));
  const mountRow = h('div', { class: 'dp-pick-row', role: 'radiogroup', 'aria-label': 'Mounting' }, h('span', { class: 'dp-cap' }, 'mounting'));
  const bulkBtn = h('button', { type: 'button', class: 'dp-toggle', 'aria-pressed': 'false', onclick: () => ctx.set('bulk', !ctx.raw.bulk) }, '100 µF polymer bulk allowed');
  const board = h('section', { class: 'dp-panel dp-board', 'aria-label': 'Board around the IC' },
    h('div', { class: 'dp-head' }, h('h2', {}, 'Board around the IC'), h('span', { class: 'dp-grow' }), field('pins', 'supply pins', '', 'Supply pins, power/ground pairs')),
    bdraw, legend,
    h('div', { class: 'dp-pick' }, pkgRow, mountRow,
      h('div', { class: 'dp-pick-row' }, h('span', { class: 'dp-cap' }, 'ceramics'), field('derate', 'keep', '% of C', 'Effective capacitance after DC bias, %'), bulkBtn)));

  // ---------- chart ----------
  const cdraw = h('div', { class: 'dp-cdraw' });
  const warns = h('div', { class: 'dp-warns', 'aria-live': 'polite' });
  const chart = h('section', { class: 'dp-panel dp-chart', 'aria-label': 'Impedance against frequency' },
    h('div', { class: 'dp-head' }, h('h2', {}, 'Impedance of the network'), h('span', { class: 'dp-sub' }, 'drag the target line and the band ends'),
      h('span', { class: 'dp-grow' }), field('freg', 'band', 'Hz', 'Regulator bandwidth, the band starts here'), field('fmax', '–', 'Hz', 'Highest frequency to cover'),
      field('lmount', 'mount', 'nH', 'Mounting inductance per capacitor, nH')),
    cdraw, warns,
    h('div', { class: 'dp-foot' }, h('span', {}, 'Target line: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' ripple ±0.5 % (', h('kbd', {}, 'Shift'), ' 0.1)'),
      h('span', {}, 'Band ends: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' 1-2-5 steps'),
      h('span', {}, 'Hover a group to see its parts and its curve')));
  const out = h('section', { class: 'dp-out' }, ctx.outputs);
  root.append(h('div', { class: 'dp' }, spec, board, chart, out));

  // package and mounting pickers, drawn as footprints
  const footprint = (lmm, wmm, sc, viaOff) => {
    const L = lmm * sc, Wd = wmm * sc, w = 46, hh = 22;
    const s = sv('svg', { width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, 'aria-hidden': 'true' });
    const x0 = w / 2 - L / 2, y0 = hh / 2 - Wd / 2, pad = L * 0.3;
    s.append(sv('rect', { x: 0, y: 0, width: w, height: hh, rx: 3, class: 'board' }));
    s.append(sv('rect', { x: x0, y: y0, width: pad, height: Wd, class: 'pad' }), sv('rect', { x: x0 + L - pad, y: y0, width: pad, height: Wd, class: 'pad' }));
    if (viaOff != null) for (const px of [x0 + pad / 2, x0 + L - pad / 2]) {
      if (viaOff > 0) s.append(sv('line', { x1: px, y1: hh / 2, x2: px, y2: hh / 2 + viaOff, stroke: 'var(--tool-cu)', 'stroke-width': 1.6 }));
      s.append(sv('circle', { cx: px, cy: hh / 2 + viaOff, r: 1.8, class: 'via' }));
    }
    return s;
  };
  const pkgBtns = ['0201', '0402', '0603'].map((p) => h('button', { type: 'button', class: 'dp-opt', role: 'radio', 'data-v': p,
    onclick: () => ctx.set('pkg', p) }, footprint(...PKG_MM[p], 14), h('b', {}, p)));
  pkgRow.append(...pkgBtns);
  const mountBtns = MOUNTS.map(([v, name]) => h('button', { type: 'button', class: 'dp-opt', role: 'radio', 'data-v': v, title: `${name}, about ${v} nH`,
    onclick: () => ctx.set('lmount', String(v)) }, footprint(1.6, 0.8, 14, v <= 0.3 ? 0 : v <= 0.5 ? 6 : v <= 1 ? 8 : 10), h('b', {}, `${v} nH`), h('span', {}, name)));
  mountRow.append(...mountBtns);
  const radioKeys = (row, btns, key, fmt = (v) => v) => row.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
    const i = btns.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); const n = btns[clamp(i + d, 0, btns.length - 1)];
    ctx.set(key, fmt(n.dataset.v)); requestAnimationFrame(() => n.focus());
  });
  radioKeys(pkgRow, pkgBtns, 'pkg');
  radioKeys(mountRow, mountBtns, 'lmount');

  const syncFields = () => {
    const raw = ctx.raw, inp = ctx.input;
    for (const [k, i] of Object.entries(fields)) {
      if (document.activeElement !== i) i.value = raw[k] ?? '';
      i.classList.toggle('bad', String(raw[k] ?? '').trim() !== '' && inp[k] == null);
    }
    for (const b of pkgBtns) { const on = b.dataset.v === (raw.pkg || '0402'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    const lm = inp.lmount;
    let any = false;
    for (const b of mountBtns) { const on = Math.abs(Number(b.dataset.v) - lm) < 1e-9; any ||= on; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    if (!any) mountBtns[0].tabIndex = 0;
    bulkBtn.setAttribute('aria-pressed', String(!!raw.bulk));
  };

  // ---------- highlight a group ----------
  const setHi = (i) => {
    state.hi = i;
    for (const svg of root.querySelectorAll('.dp-bdraw svg, .dp-cdraw svg')) {
      svg.classList.toggle('focus', i != null);
      for (const el of svg.querySelectorAll('[data-g]')) el.classList.toggle('hi', Number(el.dataset.g) === i);
    }
    for (const r of legend.children) r.classList.toggle('hi', Number(r.dataset.g) === i);
  };

  // ---------- board drawing ----------
  function drawBoard() {
    const p = P();
    bdraw.replaceChildren();
    legend.replaceChildren();
    if (!p) return;
    const W = Math.max(280, bdraw.clientWidth || 420);
    const H = Math.round(clamp(W * 0.64, 220, 300));
    const cx = W / 2, cy = H / 2;
    const a = clamp(W * 0.11, 34, 50);
    const sc = clamp(W / 38, 7, 12);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `IC with ${p.pins} supply pins and ${p.parts.reduce((s, q) => s + q.n, 0)} capacitors around it` });
    svg.append(sv('rect', { x: 0, y: 0, width: W, height: H, class: 'board' }));
    for (let x = 12; x < W; x += 24) svg.append(sv('line', { x1: x, y1: 0, x2: x, y2: H, class: 'plane-l', opacity: 0.35 }));
    const world = sv('g');
    svg.append(world);
    // a point on a square ring of half-side d, t in [0, 1)
    const ring = (d, t) => {
      const u = ((t % 1) + 1) % 1 * 8 * d, side = Math.floor(u / (2 * d)), off = u - side * 2 * d - d;
      return [[off, -d, 0], [d, off, 90], [-off, d, 0], [-d, -off, 90]][side];
    };
    // IC and its pins
    const icg = sv('g', { class: 'icf', tabindex: 0, role: 'spinbutton', 'data-fk': 'ic', 'aria-label': 'Supply pins, arrow keys change', 'aria-valuenow': p.pins });
    icg.append(sv('rect', { x: -a, y: -a, width: 2 * a, height: 2 * a, rx: 4, class: 'ic' }));
    const shown = Math.min(p.pins, 48);
    for (let j = 0; j < shown; j++) {
      const [x, y, rot] = ring(a - 3, (j + 0.5) / shown);
      const g = sv('g', { transform: `translate(${x},${y}) rotate(${rot})` });
      g.append(sv('rect', { x: -4.5, y: -2, width: 4, height: 4, class: 'pin-v' }), sv('rect', { x: 0.5, y: -2, width: 4, height: 4, class: 'pin-g' }));
      icg.append(g);
    }
    icg.append(txt(0, -a * 0.3, 'IC', 'ic-t b', 'middle'));
    icg.append(txt(0, -a * 0.3 + 14, `${p.pins} pin pairs${p.pins > shown ? ` (${shown} drawn)` : ''}`, 'ic-t sm m', 'middle'));
    for (const [d, x, path] of [[-1, -16, 'M-4,0 H4'], [1, 16, 'M-4,0 H4 M0,-4 V4']]) {
      const g = sv('g', { class: 'ictl', 'data-pins': d, transform: `translate(${x},${a * 0.42})` });
      g.append(sv('rect', { x: -11, y: -9, width: 22, height: 18, rx: 4 }), sv('path', { d: path }), sv('title', {}, d > 0 ? 'One more supply pin' : 'One supply pin less'));
      icg.append(g);
    }
    world.append(icg);
    // Small ceramics hug the IC on rings; the bigger parts (0805 and up, the
    // polymer) sit in a column beside it, as they would near the supply entry.
    const via = p.lmount <= 0.3 ? 0 : p.lmount <= 0.5 ? 0.9 : p.lmount <= 1 ? 1.6 : 2.6;
    const part = (q, gi, x, y, rot, outward) => {
      const [lmm, wmm] = PKG_MM[q.pkg] || [1, 0.5];
      const L = lmm * sc, Wd = wmm * sc, pad = L * 0.28;
      const pg = sv('g', { transform: `translate(${x},${y}) rotate(${rot})` });
      // vias on the outer side, the trace to them as long as the mounting says
      for (const px of [-L / 2 + pad / 2, L / 2 - pad / 2]) {
        const vy = outward * via * Wd;
        if (via > 0) pg.append(sv('line', { x1: px, y1: 0, x2: px, y2: vy, stroke: 'var(--tool-cu)', 'stroke-width': Math.max(1, Wd * 0.35) }));
        pg.append(sv('circle', { cx: px, cy: vy, r: Math.max(1.3, Math.min(3, Wd * 0.28)), class: 'via' }));
      }
      pg.append(sv('rect', { x: -L / 2, y: -Wd / 2, width: pad, height: Wd, class: 'pad' }), sv('rect', { x: L / 2 - pad, y: -Wd / 2, width: pad, height: Wd, class: 'pad' }),
        sv('rect', { x: -L / 2 + pad, y: -Wd / 2, width: L - 2 * pad, height: Wd, fill: GCOL[gi % GCOL.length] }));
      return pg;
    };
    const big = (q) => !['0201', '0402', '0603'].includes(q.pkg);
    let d = a + 7, extX = a + 4, extY = a + 4;
    p.parts.forEach((q, gi) => {
      if (big(q)) return;
      const [lmm, wmm] = PKG_MM[q.pkg] || [1, 0.5];
      const L = lmm * sc, Wd = wmm * sc;
      const g = sv('g', { class: 'grp', 'data-g': gi });
      const pitch = L + Math.max(3, L * 0.45);
      const rowGap = Wd + 4 + via * Wd;
      let left = q.n, row = 0;
      while (left > 0) {
        const dr = d + Wd / 2 + row * rowGap;
        const n = Math.min(left, Math.max(1, Math.floor((8 * dr) / pitch)));
        for (let j = 0; j < n; j++) {
          // the first group lines up with the pins; the others are turned a little
          const [x, y, rot] = ring(dr, (j + 0.5) / n + row * 0.013 + (gi ? 0.0625 + gi * 0.11 : 0));
          const outward = rot === 0 ? (y < 0 ? -1 : 1) : (x < 0 ? 1 : -1);
          g.append(part(q, gi, x, y, rot, outward));
          const e = Math.max(Math.abs(x), Math.abs(y)) + Wd / 2 + via * Wd + 3;
          extX = Math.max(extX, e); extY = Math.max(extY, e);
        }
        left -= n; row++;
      }
      d += row * rowGap + 3;
      world.append(g);
    });
    // the column of big parts, left of the rings
    const bigs = p.parts.map((q, gi) => [q, gi]).filter(([q]) => big(q));
    if (bigs.length) {
      const items = [];
      for (const [q, gi] of bigs) for (let j = 0; j < q.n; j++) items.push([q, gi]);
      const size = (q) => (PKG_MM[q.pkg] || [3, 1.5]).map((v) => v * sc);
      const colW = Math.max(...items.map(([q]) => size(q)[0]));
      const perCol = Math.max(1, Math.floor((2 * Math.max(extY, 60)) / Math.max(...items.map(([q]) => size(q)[1] * (1 + via) + 6))));
      const cols = Math.ceil(items.length / perCol);
      items.forEach(([q, gi], i) => {
        const col = Math.floor(i / perCol), k = i % perCol, inCol = Math.min(perCol, items.length - col * perCol);
        const [L, Wd] = size(q);
        const pitchY = Math.max(...items.map(([qq]) => size(qq)[1] * (1 + via) + 6));
        const x = -(extX + 14 + colW / 2 + col * (colW + 10));
        const y = (k - (inCol - 1) / 2) * pitchY - via * Wd / 2;
        let g = world.querySelector(`g.grp[data-g="${gi}"]`);
        if (!g) { g = sv('g', { class: 'grp', 'data-g': gi }); world.append(g); }
        g.append(part(q, gi, x, y, 0, 1));
      });
      const left = extX + 14 + cols * (colW + 10);
      extY = Math.max(extY, (Math.min(perCol, items.length) * Math.max(...items.map(([q]) => size(q)[1] * (1 + via) + 6))) / 2 + 4);
      // centre the whole scene: rings at the right of centre by half the column
      const shift = (left - extX) / 2;
      extX = (left + extX) / 2;
      world.dataset.shift = shift;
    }
    // fit everything on the board
    const shift = Number(world.dataset.shift || 0);
    const f = Math.min(1.9, (H / 2 - 8) / extY, (W / 2 - 8) / extX); // zoom to fit the plan
    world.setAttribute('transform', `translate(${cx + shift * f},${cy}) scale(${f})`);
    bdraw.append(svg);

    // legend: one row per group
    p.parts.forEach((q, gi) => {
      const row = h('div', { class: 'dp-row', role: 'listitem', tabindex: 0, 'data-g': gi,
        onmouseenter: () => setHi(gi), onmouseleave: () => setHi(null), onfocus: () => setHi(gi), onblur: () => setHi(null) },
      h('i', { style: `background:${GCOL[gi % GCOL.length]}` }),
      h('b', {}, `${q.n} × ${E(q.cNom, 'F')} ${q.polymer ? 'polymer' : q.pkg}`),
      h('span', {}, `SRF ${E(q.srf, 'Hz')} · ${E(q.l, 'H')}`));
      legend.append(row);
    });
  }

  // ---------- chart ----------
  function drawChart(frozen) {
    const p = P();
    for (const el of cdraw.querySelectorAll('svg')) el.remove();
    if (!p) return;
    const W = Math.max(300, cdraw.clientWidth || 800);
    const narrow = W < 560;
    const H = Math.round(clamp(W * 0.44, 250, 390));
    const L = 52, R = 12, T = 12, B = 30;
    const fr = p.f[0], fh = p.f[p.f.length - 1];
    let g = frozen;
    if (!g) {
      const zs = [...p.z, p.target];
      const zlo = 10 ** Math.floor(Math.log10(Math.min(...zs) / 3));
      const zhi = 10 ** Math.ceil(Math.log10(Math.max(...zs) * 5));
      g = { f0: fr / (narrow ? 3 : 5), f1: fh * (narrow ? 3 : 5), zlo, zhi };
    }
    const X = (f) => L + (W - L - R) * Math.log10(f / g.f0) / Math.log10(g.f1 / g.f0);
    const Yu = (z) => T + (H - T - B) * (1 - Math.log10(z / g.zlo) / Math.log10(g.zhi / g.zlo));
    const Y = (z) => Yu(clamp(z, g.zlo, g.zhi));
    state.geo = { ...g, X, Y, L, R, T, B, W, H };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': `Impedance against frequency; target ${E(p.target, 'Ω')}` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'dp-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-l' }));
    const clip = sv('clipPath', { id: 'dp-clip' });
    clip.append(sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
    defs.append(pat, clip); svg.append(defs);
    svg.append(sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'plot' }));
    // outside the band: regulator on the left, package and die on the right
    const xa = X(fr), xb = X(fh);
    svg.append(sv('rect', { x: L, y: T, width: Math.max(0, xa - L), height: H - T - B, class: 'outband' }),
      sv('rect', { x: xb, y: T, width: Math.max(0, W - R - xb), height: H - T - B, class: 'outband' }));
    if (xa - L > 64) svg.append(txt((L + xa) / 2, T + 16, 'regulator', 'soft sm', 'middle'));
    if (W - R - xb > 64) svg.append(txt((xb + W - R) / 2, T + 16, 'package, die', 'soft sm', 'middle'));
    // grid
    for (let z = g.zlo; z <= g.zhi * 1.001; z *= 10) {
      svg.append(sv('line', { x1: L, x2: W - R, y1: Y(z), y2: Y(z), class: 'grid' }));
      svg.append(txt(L - 5, Y(z) + 3, E(z, 'Ω', 2), 'm sm soft', 'end'));
    }
    const dstep = narrow ? 100 : 10;
    for (let f = 10 ** Math.ceil(Math.log10(g.f0)); f <= g.f1 * 1.001; f *= dstep) {
      svg.append(sv('line', { x1: X(f), x2: X(f), y1: T, y2: H - B, class: 'grid' }));
      svg.append(txt(X(f), H - B + 14, E(f, 'Hz', 2), 'm sm soft', 'middle'));
    }
    // forbidden: above the target, inside the band
    svg.append(sv('rect', { x: xa, y: T, width: xb - xa, height: Y(p.target) - T, class: 'forbid' }));
    // each group's own curve
    const path = (zs, Yf = Y) => zs.map((z, i) => `${i ? 'L' : 'M'}${X(p.f[i]).toFixed(1)},${Yf(z).toFixed(1)}`).join('');
    p.parts.forEach((k, gi) => {
      const zs = p.f.map((f) => { const om = 2 * Math.PI * f; return Math.hypot(k.esr, om * k.l - 1 / (om * k.c)) / k.n; });
      svg.append(sv('path', { d: path(zs, Yu), class: 'pc', stroke: GCOL[gi % GCOL.length], 'data-g': gi, 'clip-path': 'url(#dp-clip)' }));
      // resonance tick on the axis
      if (k.srf >= g.f0 && k.srf <= g.f1) svg.append(sv('path', { d: `M${X(k.srf)},${H - B} l-4,6 h8 Z`, fill: GCOL[gi % GCOL.length], 'data-g': gi, class: 'pc-mk' }));
    });
    // the network, red where it is over the target
    svg.append(sv('path', { d: path(p.z), class: 'net' }));
    let seg = '';
    p.z.forEach((z, i) => { if (z > p.target * 1.0001) seg += `${seg && p.z[i - 1] > p.target * 1.0001 ? 'L' : 'M'}${X(p.f[i]).toFixed(1)},${Y(z).toFixed(1)}`; });
    if (seg) svg.append(sv('path', { d: seg, class: 'net-bad' }));
    // worst point
    const w = p.worst;
    svg.append(sv('circle', { cx: X(w.f), cy: Y(w.z), r: 5, class: 'worst', stroke: p.met ? 'var(--ok)' : 'var(--danger)' }));
    const wl = `worst ${E(w.z, 'Ω')} at ${E(w.f, 'Hz')}`;
    const wx = clamp(X(w.f), L + wl.length * 3.1 + 4, W - R - wl.length * 3.1 - 4);
    const wy = Y(w.z) + (Y(w.z) > Y(p.target) + 26 ? -12 : 20);
    svg.append(sv('rect', { x: wx - wl.length * 3.1 - 4, y: wy - 11, width: wl.length * 6.2 + 8, height: 15, rx: 3, class: 'lbl-bg', opacity: 0.9 }),
      txt(wx, wy, wl, `m sm b ${p.met ? 'ok-t' : 'danger'}`, 'middle'));

    // handles: target line, band ends
    const yt = Y(p.target);
    const th = sv('g', { class: 'hd t', tabindex: 0, role: 'slider', 'data-fk': 'hd-target', 'data-drag': 'target',
      'aria-label': 'Target impedance; moves the allowed ripple', 'aria-valuetext': `${E(p.target, 'Ω')}` });
    const kx = xa + 16;
    th.append(sv('rect', { x: xa, y: yt - 8, width: xb - xa, height: 16, class: 'hit' }), sv('line', { x1: xa, y1: yt, x2: xb, y2: yt, class: 'tline' }),
      sv('rect', { x: kx - 7, y: yt - 7, width: 14, height: 14, rx: 3, class: 'knob' }), sv('rect', { x: kx - 10, y: yt - 10, width: 20, height: 20, rx: 5, class: 'ring' }));
    svg.append(th);
    const tl = `target ${E(p.target, 'Ω')}`;
    svg.append(sv('rect', { x: kx + 12, y: yt - 18, width: tl.length * 6.4 + 6, height: 14, rx: 2, class: 'lbl-bg', opacity: 0.85 }), txt(kx + 15, yt - 7, tl, 'm sm tgt-t'));
    for (const [key, x, f] of [['freg', xa, fr], ['fmax', xb, fh]]) {
      const fg = sv('g', { class: 'hd f', tabindex: 0, role: 'slider', 'data-fk': `hd-${key}`, 'data-drag': key,
        'aria-label': key === 'freg' ? 'Regulator bandwidth, start of the band' : 'Highest frequency, end of the band', 'aria-valuetext': E(f, 'Hz') });
      const ky = H - B - 12;
      fg.append(sv('rect', { x: x - 8, y: T, width: 16, height: H - T - B, class: 'hit' }), sv('line', { x1: x, y1: T, x2: x, y2: H - B, class: 'fline' }),
        sv('circle', { cx: x, cy: ky, r: 6.5, class: 'knob' }), sv('circle', { cx: x, cy: ky, r: 10, class: 'ring' }));
      svg.append(fg);
      const lab = E(f, 'Hz', 2);
      const lx = key === 'freg' ? x + 10 : x - 10;
      svg.append(sv('rect', { x: key === 'freg' ? lx - 2 : lx - lab.length * 6.2 - 2, y: ky - 22, width: lab.length * 6.2 + 4, height: 14, rx: 2, class: 'lbl-bg', opacity: 0.85 }),
        txt(lx, ky - 11, lab, 'm sm b', key === 'freg' ? 'start' : 'end'));
    }
    cdraw.append(svg);
    if (state.hi != null) setHi(state.hi);
  }

  // ---------- the spec sentence and warnings ----------
  function drawText() {
    const r = ctx.result || {};
    const p = P();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    const v = (label) => (r.values || []).find((x) => x.label === label);
    target.textContent = p ? `|Z| ≤ ${E(p.target, 'Ω')}` : '–';
    if (p) {
      const n = v('Capacitors');
      verdict.className = `dp-verdict ${p.met ? 'ok' : 'bad'}`;
      verdict.textContent = `${n?.value ?? '–'} capacitors · worst ${E(p.worst.z, 'Ω')} at ${E(p.worst.f, 'Hz')} · ${p.met ? 'meets it' : 'misses it'}`;
    } else { verdict.className = 'dp-verdict'; verdict.textContent = ''; }
  }

  // ---------- pointer and keys ----------
  bdraw.addEventListener('click', (e) => {
    const c = e.target.closest?.('g.ictl'); if (!c) return;
    const pins = P()?.pins ?? 1;
    ctx.set('pins', String(clamp(pins + Number(c.dataset.pins), 1, 200)));
  });
  bdraw.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('g.icf')) return;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault(); ctx.set('pins', String(clamp((P()?.pins ?? 1) + d, 1, 200)));
  });
  const setRipple = (z) => {
    const inp = ctx.input; if (!(inp.vdd > 0 && inp.istep > 0)) return;
    const rip = clamp((z * inp.istep) / inp.vdd * 100, 0.1, 50);
    ctx.set('ripple', String(Number(rip.toPrecision(rip < 1 ? 1 : 2))));
  };
  const valueAt = (clientX, clientY) => {
    const g = state.drag?.geo || state.geo; const rect = cdraw.getBoundingClientRect();
    const x = (clientX - rect.left) * (g.W / rect.width), y = (clientY - rect.top) * (g.H / rect.height);
    const f = g.f0 * (g.f1 / g.f0) ** ((x - g.L) / (g.W - g.L - g.R));
    const z = g.zlo * (g.zhi / g.zlo) ** (1 - (y - g.T) / (g.H - g.T - g.B));
    return { f, z };
  };
  cdraw.addEventListener('pointerdown', (e) => {
    const hd = e.target.closest?.('[data-drag]'); if (!hd) return;
    e.preventDefault(); hd.focus({ preventScroll: true }); capture(cdraw, e);
    const g = state.geo;
    state.drag = { key: hd.dataset.drag, geo: g, frozen: { f0: g.f0, f1: g.f1, zlo: g.zlo, zhi: g.zhi } };
  });
  cdraw.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    const { f, z } = valueAt(e.clientX, e.clientY);
    const p = P(); if (!p) return;
    const fr = p.f[0], fh = p.f[p.f.length - 1];
    if (d.key === 'target') setRipple(z);
    else if (d.key === 'freg') ctx.set('freg', compact(Number(clamp(f, 100, fh / 12).toPrecision(2))));
    else if (d.key === 'fmax') ctx.set('fmax', compact(Number(clamp(f, fr * 12, 1e9).toPrecision(2))));
  });
  const end = () => { if (state.drag) { state.drag = null; drawChart(); } };
  cdraw.addEventListener('pointerup', end);
  cdraw.addEventListener('pointercancel', end);
  cdraw.addEventListener('keydown', (e) => {
    const hd = e.target.closest?.('[data-drag]'); if (!hd) return;
    const inp = ctx.input;
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault();
    if (hd.dataset.drag === 'target') { const r = (inp.ripple || 5) + d * (e.shiftKey ? 0.1 : 0.5); ctx.set('ripple', String(Number(clamp(r, 0.1, 50).toFixed(1)))); }
    else if (hd.dataset.drag === 'freg') ctx.set('freg', compact(step125(inp.freg || 50e3, d)));
    else if (hd.dataset.drag === 'fmax') ctx.set('fmax', compact(step125(inp.fmax || 100e6, d)));
  });

  // ---------- draw ----------
  const drawAll = () => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    syncFields(); drawText(); drawBoard(); drawChart(state.drag?.frozen);
    if (fk && document.activeElement?.getAttribute?.('data-fk') !== fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };
  ctx.onResult(drawAll);
  let lw = 0;
  new ResizeObserver(() => { const w = cdraw.clientWidth + bdraw.clientWidth * 1000; if (w !== lw) { lw = w; drawAll(); } }).observe(root);
}
