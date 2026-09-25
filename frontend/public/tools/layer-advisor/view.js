// Layer Assignment Advisor page: the board's cross-section is the interface.
// The stack grows symmetrically about its core: drag its top or bottom edge
// out to add a pair of layers, in to remove one. Click a layer to read what it
// is for; the return path of every signal layer, the mirror pairs that keep the
// copper balanced, the power islands and the vias are drawn on the stack.
// Every role, reference, count and check comes from tool.js run().

const NS = 'http://www.w3.org/2000/svg';
const COUNTS = [2, 4, 6, 8, 10, 12];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
function s(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}

const CHIP = { S: 'SIG', SP: 'SIG+PWR', G: 'GND', P: 'PWR', M: 'GND pour' };
const isPlane = (r) => r === 'G' || r === 'P' || r === 'M';
const isSig = (r) => r === 'S' || r === 'SP';

// A short name for what a signal layer is, read from run()'s "Use it for".
function kindOf(use, role) {
  if (!isSig(role)) return '';
  if (/stripline, shielded/.test(use)) return 'stripline';
  if (/dual stripline/.test(use)) return 'dual stripline';
  if (/pours/.test(use)) return 'microstrip + pours';
  if (/microstrip/.test(use)) return 'microstrip';
  return '';
}

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));

  let res = null;
  let sel = 0;          // selected layer index
  let drag = null;      // {n} while dragging an edge
  let seen = null;      // last layer count, to keep the selection sensible

  // ---------- controls ----------
  const seg = (label, items, key) => {
    const g = h('div', { class: 'la-seg', role: 'radiogroup', 'aria-label': label });
    const btns = items.map(([v, t, title]) => h('button', { type: 'button', role: 'radio', 'data-v': v, title: title || null,
      onclick: () => ctx.set(key, v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return; e.preventDefault();
        const i = clamp(items.findIndex((it) => it[0] === v) + d, 0, items.length - 1);
        ctx.set(key, items[i][0]);
        requestAnimationFrame(() => g.querySelector(`[data-v="${items[i][0]}"]`)?.focus());
      } }, t));
    g.append(...btns);
    g.sync = (cur) => btns.forEach((b) => { const on = b.dataset.v === String(cur); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    return g;
  };
  const countSeg = seg('Copper layers', COUNTS.map((n) => [String(n), String(n), `${n} copper layers`]), 'layers');
  const prioSeg = seg('Priority', [['general', 'Routing capacity', 'Most signal layers'], ['emc', 'EMC first', 'More planes, every signal beside ground']], 'priority');

  const railsOut = h('output', { class: 'la-rails-n', 'aria-live': 'polite' });
  const railsSet = (d) => { const n = clamp(Math.round(ctx.input.rails || 1) + d, 1, 8); ctx.set('rails', String(n)); };
  const rails = h('div', { class: 'la-rails', role: 'group', 'aria-label': 'Power rails to distribute' },
    h('span', { class: 'la-cap' }, 'Rails'),
    h('button', { type: 'button', class: 'la-step', 'aria-label': 'One rail fewer', onclick: () => railsSet(-1) }, '−'),
    railsOut,
    h('button', { type: 'button', class: 'la-step', 'aria-label': 'One rail more', onclick: () => railsSet(1) }, '+'));
  const fastBtn = h('button', { type: 'button', class: 'la-toggle', 'aria-pressed': 'false', title: 'Rise times under ~1 ns: DDR, USB, PCIe, fast MCU buses',
    onclick: () => ctx.set('fast', !ctx.input.fast) }, h('i', { 'aria-hidden': 'true' }), 'Fast edges');

  const bar = h('div', { class: 'la-bar' },
    h('div', { class: 'la-group' }, h('span', { class: 'la-cap' }, 'Layers'), countSeg),
    h('div', { class: 'la-group' }, h('span', { class: 'la-cap' }, 'Priority'), prioSeg),
    rails, fastBtn,
    h('span', { class: 'la-tip' }, 'Drag the top or bottom edge of the board to add or remove a pair · click a layer'));

  // ---------- the stack ----------
  const svg = s(null, 'svg', { class: 'la-svg', role: 'group', 'aria-label': 'Cross-section of the board, one band per copper layer' });
  const box = h('div', { class: 'la-box' }, svg);
  const legend = h('div', { class: 'la-legend' },
    h('span', {}, h('i', { class: 'lg-cu' }), 'copper'),
    h('span', {}, h('i', { class: 'lg-pp' }), 'prepreg'),
    h('span', {}, h('i', { class: 'lg-core' }), 'core'),
    h('span', {}, h('i', { class: 'lg-gnd' }), 'return to GND'),
    h('span', {}, h('i', { class: 'lg-pwr' }), 'return to PWR'),
    h('span', {}, h('i', { class: 'lg-mir' }), 'mirror pair'),
    h('span', { class: 'la-ns' }, 'not to scale'));
  const stage = h('section', { class: 'la-stage' }, bar, box, legend);

  // ---------- side ----------
  const insp = h('section', { class: 'la-card la-insp', 'aria-live': 'polite' });
  const checks = h('section', { class: 'la-card la-checks' });
  const warns = h('div', { class: 'la-warns', role: 'status' });
  const notes = h('details', { class: 'la-notes' });
  const side = h('aside', { class: 'la-side' }, insp, warns, checks, notes, ctx.outputs);

  root.append(h('div', { class: 'la' }, stage, side));

  // ---------- reading the result ----------
  const stackOf = () => (res && Array.isArray(res.stack) ? res.stack : []);
  const rowsOf = () => res?.tables?.[0]?.rows || [];
  const nowN = () => (drag ? drag.n : stackOf().length || Number(ctx.input.layers) || 4);

  // Which layers a warning or note speaks about.
  const layerHits = (text) => [...String(text).matchAll(/\bL(\d{1,2})\b/g)].map((m) => Number(m[1]) - 1);

  // ---------- drawing ----------
  function draw() {
    const st = stackOf();
    svg.replaceChildren();
    if (!st.length) return;
    const n = st.length;
    const rows = rowsOf();
    const W = Math.max(300, box.clientWidth), H = Math.max(360, box.clientHeight);
    const narrow = W < 620;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const x0 = narrow ? 104 : 190, x1 = W - (narrow ? 60 : 210);
    // pitch per layer: sized to the board shown, frozen while an edge is dragged
    // so the edges keep landing on the ghost marks under the pointer
    const P = drag ? drag.P : Math.min(66, (H - 40) / Math.max(n + 2, 8));
    const cy = H / 2;
    const fitMax = Math.min(12, Math.floor((H - 24) / P / 2) * 2);
    const top = cy - (n * P) / 2, bot = cy + (n * P) / 2;
    const cu = clamp(P * 0.24, 4, 11);
    const yOf = (i) => top + i * P + P / 2;          // copper centre of layer i
    const vx = x1 - (narrow ? 26 : 40);             // signal via
    const gx = vx - (narrow ? 22 : 30);             // ground stitching via
    const warnText = [...(res.warnings || [])].join(' ');
    const unbalanced = new Set((res.notes || []).filter((t) => /mirrors/.test(t)).flatMap(layerHits));

    // ghost extents: where the edges land for every layer count
    const ghost = s(svg, 'g', { class: 'la-ghost' });
    for (const k of COUNTS) {
      if (k < n || k > fitMax) continue;
      const d = (k * P) / 2;
      for (const y of [cy - d, cy + d]) s(ghost, 'line', { x1: x0 - 6, x2: x1 + 6, y1: y, y2: y, class: k === n ? 'on' : '' });
      s(ghost, 'text', { x: 12, y: cy - d + 4, class: k === n ? 'on' : '' }, String(k));
      s(ghost, 'text', { x: 12, y: cy + d + 4, class: k === n ? 'on' : '' }, String(k));
    }

    // dielectric: prepreg between a layer pair, core inside
    const board = s(svg, 'g', { class: 'la-board' });
    s(board, 'rect', { x: x0, y: top, width: x1 - x0, height: bot - top, class: 'la-pp' });
    for (let i = 0; i < n - 1; i++) {
      const core = n === 2 || i % 2 === 1;
      if (core) s(board, 'rect', { x: x0, y: yOf(i) + cu / 2, width: x1 - x0, height: P - cu, class: 'la-core' });
      if (P >= 30 && !narrow) s(board, 'text', { x: x0 + 8, y: yOf(i) + P / 2 + 3.5, class: 'la-dtxt' }, core ? 'core' : 'prepreg');
    }
    // solder mask on the outside
    s(board, 'rect', { x: x0, y: top - 3, width: x1 - x0, height: 3, class: 'la-mask' });
    s(board, 'rect', { x: x0, y: bot, width: x1 - x0, height: 3, class: 'la-mask' });

    // copper
    const railN = Math.max(1, Math.round(ctx.input.rails || 1));
    const hole = (x) => [x - 8, x + 8];
    const segments = (a, b, gaps) => { // [a,b] minus gaps
      let out = [[a, b]];
      for (const [g0, g1] of gaps) out = out.flatMap(([p, q]) => (g1 <= p || g0 >= q ? [[p, q]] : [[p, g0], [g1, q]].filter(([u, v]) => v - u > 1)));
      return out;
    };
    const fastLayers = new Set();
    st.forEach((l, i) => {
      const use = rows[i]?.[3] || '';
      if (ctx.input.fast && /stripline, shielded/.test(use)) fastLayers.add(i);
    });
    if (ctx.input.fast && !fastLayers.size) st.forEach((l, i) => { if ((i === 0) && isSig(l.role)) fastLayers.add(i); });

    st.forEach((l, i) => {
      const y = yOf(i) - cu / 2;
      const g = s(svg, 'g', { class: `la-layer${i === sel ? ' sel' : ''}${unbalanced.has(i) ? ' unbal' : ''}`, 'data-i': i,
        tabindex: i === sel ? 0 : -1, role: 'button', 'aria-pressed': String(i === sel),
        'aria-label': `Layer ${l.layer}: ${l.name}${isSig(l.role) ? `, reference ${l.ref}` : ''}` });
      s(g, 'rect', { x: x0 - (narrow ? 96 : 176), y: yOf(i) - P / 2, width: x1 - x0 + (narrow ? 96 : 176) + (narrow ? 54 : 200), height: P, class: 'la-hit' });
      const viaGaps = [hole(vx)];
      if (l.role === 'G' || l.role === 'M') { /* the stitching via connects to ground */ } else viaGaps.push(hole(gx));
      if (l.role === 'G') {
        for (const [a, b] of segments(x0, x1, viaGaps)) s(g, 'rect', { x: a, y, width: b - a, height: cu, class: 'la-cu' });
      } else if (l.role === 'P') {
        const k = Math.min(railN, 6);
        const cuts = [];
        for (let j = 1; j < k; j++) { const x = x0 + ((x1 - x0) * j) / k; cuts.push([x - 4, x + 4]); }
        for (const [a, b] of segments(x0, x1, [...viaGaps, ...cuts])) s(g, 'rect', { x: a, y, width: b - a, height: cu, class: 'la-cu' });
        for (let j = 0; j < k; j++) {
          const cx = x0 + ((x1 - x0) * (j + 0.5)) / k;
          if ((x1 - x0) / k > 44) s(g, 'text', { x: cx, y: y - 5, class: 'la-isl', 'text-anchor': 'middle' }, k < railN && j === k - 1 ? `R${j + 1}…${railN}` : `R${j + 1}`);
        }
        if (/islands/.test(warnText)) s(g, 'rect', { x: x0 - 3, y: y - 3, width: x1 - x0 + 6, height: cu + 6, class: 'la-warnbox' });
      } else if (l.role === 'M') {
        const w = x1 - x0;
        const cuts = [[x0 + w * 0.28, x0 + w * 0.33], [x0 + w * 0.61, x0 + w * 0.64]];
        for (const [a, b] of segments(x0, x1, [...viaGaps, ...cuts])) s(g, 'rect', { x: a, y, width: b - a, height: cu, class: 'la-cu' });
        for (const [a, b] of cuts) s(g, 'rect', { x: a + 3, y, width: b - a - 6, height: cu, class: 'la-cu' });
      } else {
        // signal: trace cross-sections, pours on SP layers
        const pitch = narrow ? 18 : 24, tw = narrow ? 7 : 10;
        let x = x0 + 12;
        const pourEnd = l.role === 'SP' ? x0 + (x1 - x0) * 0.3 : null;
        if (pourEnd) { s(g, 'rect', { x: x0, y, width: pourEnd - x0, height: cu, class: 'la-cu' }); x = pourEnd + 12; }
        while (x + tw < gx - 14) {
          const fast = fastLayers.has(i) && Math.abs(x - (x0 + (x1 - x0) * (pourEnd ? 0.55 : 0.45))) < pitch / 2;
          s(g, 'rect', { x, y, width: tw, height: cu, rx: 1, class: fast ? 'la-cu la-fast' : 'la-cu' });
          if (fast && !narrow) s(g, 'text', { x: x + tw / 2, y: y - 4, class: 'la-fasttxt', 'text-anchor': 'middle' }, 'fast');
          x += pitch;
        }
        // via pads
        s(g, 'rect', { x: vx - 7, y, width: 14, height: cu, rx: 1, class: 'la-cu' });
      }
      if (l.role === 'G' || l.role === 'M') s(g, 'rect', { x: gx - 6, y, width: 12, height: cu, class: 'la-cu' });

      // left: layer name and role chip
      const lx = narrow ? 40 : 56;
      s(g, 'text', { x: lx, y: yOf(i) + 4, class: 'la-lname' }, `L${l.layer}`);
      const chip = CHIP[l.role];
      const cw = chip.length * 6.6 + 12;
      const cx = x0 - 12 - cw;
      if (!narrow) {
        s(g, 'rect', { x: cx, y: yOf(i) - 9, width: cw, height: 18, rx: 3, class: `la-chip r-${l.role}` });
        s(g, 'text', { x: cx + cw / 2, y: yOf(i) + 4, class: 'la-chiptxt', 'text-anchor': 'middle' }, chip);
      } else {
        s(g, 'rect', { x: x0 - 16, y: yOf(i) - 6, width: 8, height: 12, rx: 2, class: `la-chip r-${l.role}` });
      }
      if (i === sel) s(g, 'rect', { x: x0 - 3, y: yOf(i) - P / 2 + 1, width: x1 - x0 + 6, height: P - 2, class: 'la-selbox' });
    });

    // vias: a signal via through everything, a ground stitching via beside it
    s(svg, 'rect', { x: vx - 3, y: top - 2, width: 6, height: bot - top + 4, class: 'la-barrel' });
    s(svg, 'rect', { x: gx - 3, y: top - 2, width: 6, height: bot - top + 4, class: 'la-barrel' });
    if (!narrow && P >= 22) {
      s(svg, 'text', { x: vx, y: top - 10, class: 'la-vtxt', 'text-anchor': 'middle' }, 'via');
      s(svg, 'text', { x: gx, y: bot + 18, class: 'la-vtxt', 'text-anchor': 'middle' }, 'GND stitch');
    }

    // mirror pairs on the left: balance of copper about the centre
    const mx = narrow ? 30 : 34;
    s(svg, 'line', { x1: x0 - 4, x2: x1 + 4, y1: cy, y2: cy, class: 'la-centre' });
    for (let i = 0; i < n / 2; i++) {
      const j = n - 1 - i, bad = unbalanced.has(i) || unbalanced.has(j);
      const ax = mx - (n / 2 - 1 - i) * (narrow ? 3 : 4) + (narrow ? 0 : 0);
      const lx0 = narrow ? 36 : 50;
      s(svg, 'path', { d: `M${lx0},${yOf(i)} H${ax} V${yOf(j)} H${lx0}`, class: `la-mir${bad ? ' bad' : ''}` });
      if (bad && !narrow) s(svg, 'text', { x: ax - 4, y: cy - 6 - i * 12, class: 'la-mirtxt', 'text-anchor': 'end' }, '');
    }

    // right: return path of each signal layer to its plane(s)
    const rx = x1 + (narrow ? 8 : 14);
    st.forEach((l, i) => {
      if (!isSig(l.role)) return;
      const refs = [];
      if (i > 0 && isPlane(st[i - 1].role)) refs.push(i - 1);
      if (i < n - 1 && isPlane(st[i + 1].role)) refs.push(i + 1);
      refs.forEach((k, m) => {
        const pw = st[k].role === 'P';
        const a = yOf(i), b = yOf(k);
        const bow = narrow ? 10 : 14 + m * 0;
        s(svg, 'path', { d: `M${x1 + 2},${a + (b > a ? 3 : -3)} C${rx + bow},${a} ${rx + bow},${b} ${x1 + 2},${b + (b > a ? -3 : 3)}`,
          class: `la-ret ${pw ? 'pwr' : 'gnd'}`, 'marker-end': `url(#la-arr-${pw ? 'p' : 'g'})` });
      });
      if (!refs.length) s(svg, 'text', { x: rx, y: yOf(i) + 4, class: 'la-noref' }, narrow ? '!' : 'no reference plane');
      if (!narrow) {
        const kind = kindOf(rows[i]?.[3] || '', l.role);
        s(svg, 'text', { x: rx + 24, y: yOf(i) + (kind ? 0 : 4), class: `la-ref ${refs.length ? '' : 'bad'}` }, `ref ${l.ref}`);
        if (kind) s(svg, 'text', { x: rx + 24, y: yOf(i) + 12, class: 'la-kind' }, kind);
      }
    });
    const defs = s(svg, 'defs');
    for (const [id, cls] of [['la-arr-g', 'gnd'], ['la-arr-p', 'pwr']]) {
      const m = s(defs, 'marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      s(m, 'path', { d: 'M0,0 L8,4 L0,8 z', class: `la-arrhead ${cls}` });
    }

    // a two-layer board with fast edges: the warning sits on the board
    if (n === 2 && ctx.input.fast) {
      s(svg, 'rect', { x: x0 - 4, y: top - 8, width: x1 - x0 + 8, height: bot - top + 16, class: 'la-warnbox' });
      s(svg, 'text', { x: (x0 + x1) / 2, y: bot + 26, class: 'la-warntxt', 'text-anchor': 'middle' }, narrow ? 'no solid plane: fast edges radiate' : 'no solid plane under fast edges: large loops, radiates');
    }

    // edge handles: drag out to add a pair, in to remove one
    for (const [edge, y] of [['top', top - 3], ['bottom', bot + 3]]) {
      const hw = 64, hx = (x0 + x1) / 2 - hw / 2 - (narrow ? 0 : 30);
      const g = s(svg, 'g', { class: 'la-handle', tabindex: 0, role: 'slider', 'aria-label': `Board ${edge} edge: copper layer count`,
        'aria-valuemin': 2, 'aria-valuemax': 12, 'aria-valuenow': n, 'aria-valuetext': `${n} layers`, 'data-edge': edge });
      s(g, 'rect', { x: hx - 8, y: y - 12, width: hw + 16, height: 24, class: 'la-hhit' });
      s(g, 'rect', { x: hx, y: y - 5, width: hw, height: 10, rx: 5, class: 'la-hbar' });
      for (let k = -1; k <= 1; k++) s(g, 'line', { x1: hx + hw / 2 + k * 8, x2: hx + hw / 2 + k * 8, y1: y - 2.5, y2: y + 2.5, class: 'la-hgrip' });
      if (drag && drag.edge === edge) s(g, 'text', { x: hx + hw + 14, y: y + 4, class: 'la-htxt' }, `${n} layers`);
      g.addEventListener('pointerdown', (e) => startDrag(e, edge, cy, P, fitMax));
      g.addEventListener('keydown', (e) => {
        const out = edge === 'top' ? { ArrowUp: 2, ArrowDown: -2 } : { ArrowDown: 2, ArrowUp: -2 };
        const d = out[e.key] ?? (e.key === 'PageUp' ? 2 : e.key === 'PageDown' ? -2 : e.key === 'Home' ? -12 : e.key === 'End' ? 12 : null);
        if (d == null) return;
        e.preventDefault();
        const k = clamp(n + d, 2, 12);
        if (k !== n) { refocus = edge; ctx.set('layers', String(k)); }
      });
    }
    if (refocus) { const f = refocus; refocus = null; svg.querySelector(`.la-handle[data-edge="${f}"]`)?.focus(); }
    if (refocusLayer != null) { const i = refocusLayer; refocusLayer = null; svg.querySelector(`.la-layer[data-i="${i}"]`)?.focus(); }
  }
  let refocus = null, refocusLayer = null;

  function startDrag(e, edge, cy, P, fitMax) {
    e.preventDefault();
    capture(e.currentTarget, e);
    const pt = svg.createSVGPoint();
    const toY = (ev) => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()).y; };
    drag = { edge, n: stackOf().length, P };
    const move = (ev) => {
      const d = Math.abs(toY(ev) - cy);
      const k = clamp(Math.round(d / P) * 2, 2, fitMax);
      if (k !== drag.n) { drag.n = k; ctx.set('layers', String(k)); }
    };
    const up = () => { drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); draw(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.la-layer');
    if (!g) return;
    sel = Number(g.dataset.i); refocusLayer = sel; draw(); side_();
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('.la-layer');
    if (!g) return;
    const n = stackOf().length;
    const d = { ArrowDown: 1, ArrowUp: -1, Home: -99, End: 99 }[e.key];
    if (d == null) return;
    e.preventDefault();
    sel = clamp(Number(g.dataset.i) + d, 0, n - 1); refocusLayer = sel; draw(); side_();
  });

  // ---------- side panels ----------
  function side_() {
    const st = stackOf(), rows = rowsOf();
    const l = st[sel], r = rows[sel];
    insp.replaceChildren();
    if (l && r) {
      const hits = [...(res.warnings || []), ...(res.notes || [])].filter((t) => layerHits(t).includes(sel));
      insp.append(
        h('div', { class: 'la-insp-head' },
          h('b', {}, `L${l.layer}`), h('span', { class: `la-pill r-${l.role}` }, r[1]),
          h('span', { class: 'la-pos' }, sel === 0 ? 'top' : sel === st.length - 1 ? 'bottom' : `inner ${sel} of ${st.length - 2}`)),
        h('dl', { class: 'la-dl' },
          h('dt', {}, 'Reference'), h('dd', { class: l.ref === 'none' ? 'bad' : '' }, r[2]),
          h('dt', {}, 'Use it for'), h('dd', {}, r[3])),
        ...hits.map((t) => h('p', { class: 'la-hit-note' }, t)));
    }
    // checks: run()'s values, as a list of pass / fix lines
    checks.replaceChildren(h('div', { class: 'la-title' }, res?.tables?.[0]?.title || 'Stack'));
    for (const v of res?.values || []) {
      checks.append(h('div', { class: `la-check t-${v.tone || 'none'}` },
        h('i', { 'aria-hidden': 'true' }), h('span', {}, v.label), h('b', {}, String(v.value)),
        v.hint ? h('em', {}, v.hint) : null));
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    const ns = (res?.notes || []);
    notes.replaceChildren(h('summary', {}, `Notes (${ns.length})`), ...ns.map((t) => h('p', {}, t)));
    notes.hidden = !ns.length;
  }

  function sync() {
    const inp = ctx.raw;
    countSeg.sync(String(inp.layers));
    prioSeg.sync(inp.priority === 'emc' ? 'emc' : 'general');
    railsOut.textContent = String(Math.max(1, Math.round(ctx.input.rails || 1)));
    fastBtn.setAttribute('aria-pressed', String(!!ctx.input.fast));
  }

  ctx.onResult((r) => {
    res = r;
    const n = stackOf().length;
    if (n && seen !== n) { sel = seen == null ? Math.min(sel, n - 1) : clamp(sel, 0, n - 1); seen = n; }
    if (sel >= n) sel = Math.max(0, n - 1);
    sync(); draw(); side_();
  });
  new ResizeObserver(() => draw()).observe(box);
}
