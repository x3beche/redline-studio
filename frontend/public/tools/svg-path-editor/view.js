// SVG Path Editor page: the path itself on an artboard in output units.
//   Artboard  - the path at full precision (fill + ink), the written path
//               after rounding on top (accent), every node: end points as
//               squares, control points as circles on their handle lines.
//               Drag a node (snaps to the chosen decimals, Alt = free), or
//               focus it and use the arrow keys. Ctrl + wheel zooms, drag the
//               background to pan, Fit brings it all back. Where rounding
//               moves a node, a red tick joins where it was to where it is
//               written.
//   Precision - one bar per decimals setting: the characters it writes and
//               the largest node shift it causes; click one to use it.
//   Tape      - the output string, cut per segment: hover a piece and its
//               segment lights up on the artboard, click it to select it.
// Every number shown comes from run()'s result (result.drawing, result.ladder).
import { moveNode, serialize } from './tool.js';

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
const CMD = { M: 'move', L: 'line', H: 'horizontal line', V: 'vertical line', C: 'cubic curve', S: 'smooth cubic', Q: 'quadratic curve', T: 'smooth quadratic', A: 'arc', Z: 'close' };
const DEC_LABEL = { 0: '0', 1: '1', 2: '2', 3: '3', 4: '4', keep: 'all' };
const FULL = { mode: 'absolute', dec: null, compact: false, shorthand: false };

function niceStep(minUnits) {
  const p = 10 ** Math.floor(Math.log10(minUnits));
  for (const m of [1, 2, 5, 10]) if (m * p >= minUnits) return m * p;
  return 10 * p;
}

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const byKey = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));

  // ---------------- toolbar ----------------
  const modeSeg = h('div', { class: 'spe-seg', role: 'radiogroup', 'aria-label': 'Coordinates' },
    byKey.mode.options.map(([v, t]) => h('button', { role: 'radio', 'data-v': v, title: t,
      onclick: () => ctx.set('mode', v) }, { shortest: 'Shortest', relative: 'Relative', absolute: 'Absolute' }[v] || t)));
  const toggle = (key, label, title) => h('label', { class: 'spe-tog', title },
    h('input', { type: 'checkbox', 'data-k': key, onchange: (e) => ctx.set(key, e.target.checked) }), label);
  const numField = (key, label, title) => h('label', { class: 'spe-num', title },
    h('span', {}, label), h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'data-k': key,
      oninput: (e) => ctx.set(key, e.target.value) }));
  const undoBtn = h('button', { class: 'k-btn', title: 'Undo the last edit (Ctrl+Z)', onclick: () => undo() }, 'Undo');
  const toolbar = h('section', { class: 'spe-bar', 'aria-label': 'Output style' },
    h('div', { class: 'spe-grp' }, h('span', { class: 'spe-cap' }, 'Write'), modeSeg),
    h('div', { class: 'spe-grp' }, toggle('compact', 'Compact', byKey.compact.label), toggle('shorthand', 'H / V', byKey.shorthand.label)),
    h('div', { class: 'spe-grp' }, h('span', { class: 'spe-cap' }, 'Transform'),
      numField('tx', 'x +', 'Translate x, in output units'), numField('ty', 'y +', 'Translate y'), numField('scale', '×', byKey.scale.help)),
    h('div', { class: 'spe-grp spe-end' }, undoBtn));

  // ---------------- artboard ----------------
  const svg = sv('svg', { class: 'spe-svg', role: 'group', 'aria-label': 'Path and its nodes' });
  const boardHead = h('div', { class: 'spe-bhead' });
  const zoomBtns = h('div', { class: 'spe-zoom' },
    h('button', { class: 'k-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.5) }, '+'),
    h('button', { class: 'k-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.5) }, '−'),
    h('button', { class: 'k-btn', title: 'Fit the path (0)', onclick: () => { cam = null; drawBoard(); } }, 'Fit'));
  const boardBox = h('div', { class: 'spe-boardbox' }, svg);
  const help = h('div', { class: 'spe-help' }, 'Drag a node; it snaps to the chosen decimals (hold ', h('kbd', {}, 'Alt'), ' for free). Focused node: ',
    h('kbd', {}, '←'), h('kbd', {}, '→'), h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' 0.1 unit, ', h('kbd', {}, 'Shift'), ' 1 unit. ',
    h('kbd', {}, 'Ctrl'), ' + wheel zooms, drag the background to pan.');
  const board = h('section', { class: 'spe-card spe-board' }, h('div', { class: 'spe-head' }, boardHead, zoomBtns), boardBox, help);

  // ---------------- rail: precision ladder + node + figures ----------------
  const ladder = h('div', { class: 'spe-ladder', role: 'radiogroup', 'aria-label': 'Decimals' });
  const inspector = h('div', { class: 'spe-insp' });
  const figs = h('dl', { class: 'spe-figs' });
  const rail = h('section', { class: 'spe-card spe-rail' },
    h('div', { class: 'spe-head' }, h('h2', {}, 'Decimals'), h('span', { class: 'spe-sub' }, 'characters · largest shift')), ladder,
    h('div', { class: 'spe-head spe-topline' }, h('h2', {}, 'Node')), inspector,
    h('div', { class: 'spe-head spe-topline' }, h('h2', {}, 'Path')), figs);

  // ---------------- tape ----------------
  const tapeHead = h('div', { class: 'spe-head' });
  const tape = h('div', { class: 'spe-tape', 'aria-label': 'Output path, one piece per segment' });
  const tapeCard = h('section', { class: 'spe-card' }, tapeHead, tape);

  // ---------------- source + outputs ----------------
  const src = h('textarea', { class: 'spe-src', rows: 5, spellcheck: 'false', 'aria-label': 'Path data (input)',
    placeholder: byKey.d.placeholder, oninput: (e) => { pushUndo(); ctx.set('d', e.target.value); } });
  const warns = h('div', { class: 'spe-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'spe-notes' });
  const srcCard = h('section', { class: 'spe-card' },
    h('div', { class: 'spe-head' }, h('h2', {}, 'Input path'), h('span', { class: 'spe-sub' }, 'paste a d attribute or a whole <path>; edits on the artboard write it back in full precision')),
    h('div', { class: 'spe-srcwrap' }, src), notes);

  root.append(h('div', { class: 'spe' }, toolbar, warns,
    h('div', { class: 'spe-main' }, board, rail),
    tapeCard,
    h('div', { class: 'spe-foot' }, srcCard, ctx.outputs)));

  // ---------------- state ----------------
  let res = null, D = null;
  let sel = null;          // {seg, slot}
  let hoverSeg = null;
  let cam = null;          // {cx, cy, k} in output units; null = fit
  let frozen = null;       // camera held while dragging
  const undoStack = [];
  const pushUndo = () => {
    const d = ctx.raw.d;
    if (undoStack[undoStack.length - 1] !== d) undoStack.push(d);
    if (undoStack.length > 100) undoStack.shift();
    undoBtn.disabled = !undoStack.length;
  };
  const undo = () => {
    const d = undoStack.pop();
    undoBtn.disabled = !undoStack.length;
    if (d != null) ctx.set('d', d);
  };
  undoBtn.disabled = true;
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target !== src) { e.preventDefault(); undo(); }
  });

  const sameNode = (a, b) => a && b && a.seg === b.seg && a.slot === b.slot && a.kind === b.kind;
  const nodeOf = (key) => D && key && D.nodes.find((n) => sameNode(n, key));

  // ---------------- camera ----------------
  let W = 800, H = 460;
  const fitCam = () => {
    const b = D.outBox;
    const pad = 44;
    const bw = Math.max(b.w, 1e-9), bh = Math.max(b.h, 1e-9);
    const k = Math.min((W - 2 * pad - 24) / (b.w || bh || 1), (H - 2 * pad - 20) / (b.h || bw || 1));
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, k: Number.isFinite(k) && k > 0 ? k : 1 };
  };
  const curCam = () => frozen || cam || fitCam();
  const zoomBy = (m, px = W / 2, py = H / 2) => {
    const c = curCam();
    const ux = c.cx + (px - W / 2) / c.k, uy = c.cy + (py - H / 2) / c.k;
    const k = Math.min(1e5, Math.max(1e-4, c.k * m));
    cam = { k, cx: ux - (px - W / 2) / k, cy: uy - (py - H / 2) / k };
    drawBoard();
  };

  // ---------------- editing ----------------
  const stepUnits = () => (D.dec == null ? 0.01 : 10 ** -D.dec);
  const snap = (v, free) => { if (free) return v; const s = stepUnits(); return Math.round(v / s) * s; };
  // Output units -> input units (the inverse of translate + scale).
  const toIn = (o, axis) => (o - D.transform[axis === 'x' ? 'tx' : 'ty']) / D.transform.scale;
  const writeNode = (n, ox, oy) => {
    const segs = res.segments.map((s) => ({ c: s.c, a: [...s.a] }));
    const moved = moveNode(segs, n.seg, n.slot, toIn(ox, 'x'), toIn(oy, 'y'));
    // Full precision absolute, so nothing but the moved node changes.
    const d = serialize(moved, FULL).d;
    if (d !== ctx.raw.d) ctx.set('d', d);
  };

  // ---------------- draw: artboard ----------------
  function drawBoard() {
    const had = svg.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    svg.replaceChildren();
    W = Math.max(280, Math.round(boardBox.clientWidth || 800));
    H = Math.max(260, Math.round(boardBox.clientHeight || 460));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) {
      svg.append(sv('text', { x: 16, y: 30, class: 'soft' }, 'No path to draw: see the message above.'));
      boardHead.replaceChildren(h('h2', {}, 'Artboard'));
      return;
    }
    const c = curCam();
    const X = (x) => W / 2 + (x - c.cx) * c.k, Y = (y) => H / 2 + (y - c.cy) * c.k;
    const ux0 = c.cx - W / 2 / c.k, ux1 = c.cx + W / 2 / c.k, uy0 = c.cy - H / 2 / c.k, uy1 = c.cy + H / 2 / c.k;

    // Background: pan surface.
    const bg = sv('rect', { class: 'spe-bg', x: 0, y: 0, width: W, height: H });
    svg.append(bg);
    // Grid: a unit grid when a unit is big enough to see, labelled majors.
    const minor = niceStep(9 / c.k), major = niceStep(64 / c.k);
    const grid = sv('g', { class: 'spe-grid' });
    if (minor < major) {
      for (let x = Math.ceil(ux0 / minor) * minor; x <= ux1; x += minor) grid.append(sv('line', { x1: X(x), x2: X(x), y1: 0, y2: H, class: 'mi' }));
      for (let y = Math.ceil(uy0 / minor) * minor; y <= uy1; y += minor) grid.append(sv('line', { y1: Y(y), y2: Y(y), x1: 0, x2: W, class: 'mi' }));
    }
    const lab = sv('g', { class: 'spe-rule' });
    for (let x = Math.ceil(ux0 / major) * major; x <= ux1; x += major) {
      grid.append(sv('line', { x1: X(x), x2: X(x), y1: 0, y2: H, class: Math.abs(x) < major / 1e6 ? 'ax' : 'ma' }));
      lab.append(sv('text', { x: X(x) + 3, y: 11 }, f(x, 6)));
    }
    for (let y = Math.ceil(uy0 / major) * major; y <= uy1; y += major) {
      grid.append(sv('line', { y1: Y(y), y2: Y(y), x1: 0, x2: W, class: Math.abs(y) < major / 1e6 ? 'ax' : 'ma' }));
      if (Y(y) > 18) lab.append(sv('text', { x: 3, y: Y(y) - 3 }, f(y, 6)));
    }
    svg.append(grid, lab);

    // The output viewBox (from the Element text: bbox + 1 unit each side), dashed.
    const b = D.outBox;
    svg.append(sv('rect', { class: 'spe-vb', x: X(b.x - 1), y: Y(b.y - 1), width: (b.w + 2) * c.k, height: (b.h + 2) * c.k }));

    // Bounding box dimensions.
    const dimY = Y(b.y) - 16, dimX = X(b.x + b.w) + 16;
    const dims = sv('g', { class: 'spe-dim' });
    if (b.w * c.k > 30) {
      dims.append(sv('path', { d: `M${X(b.x)},${dimY - 4}v8M${X(b.x + b.w)},${dimY - 4}v8M${X(b.x)},${dimY}H${X(b.x + b.w)}` }));
      dims.append(sv('text', { x: (X(b.x) + X(b.x + b.w)) / 2, y: dimY - 5, 'text-anchor': 'middle', class: 'halo' }, `${f(b.w, 5)}`));
    }
    if (b.h * c.k > 30) {
      dims.append(sv('path', { d: `M${dimX - 4},${Y(b.y)}h8M${dimX - 4},${Y(b.y + b.h)}h8M${dimX},${Y(b.y)}V${Y(b.y + b.h)}` }));
      dims.append(sv('text', { x: dimX + 5, y: (Y(b.y) + Y(b.y + b.h)) / 2 + 4, class: 'halo' }, `${f(b.h, 5)}`));
    }
    svg.append(dims);

    // Input path at full precision, placed by translate + scale.
    const T = D.transform;
    const mIn = `matrix(${T.scale * c.k},0,0,${T.scale * c.k},${W / 2 + (T.tx - c.cx) * c.k},${H / 2 + (T.ty - c.cy) * c.k})`;
    const mOut = `matrix(${c.k},0,0,${c.k},${W / 2 - c.cx * c.k},${H / 2 - c.cy * c.k})`;
    svg.append(sv('path', { class: 'spe-fill', d: D.fullD, transform: mIn }));
    // The written (rounded) path, straight from the Path output.
    const outText = (res.texts || []).find((t) => t.title === 'Path');
    if (outText) svg.append(sv('path', { class: 'spe-out', d: outText.body, transform: mOut }));
    // Segments one by one: hover to light the tape, click to select.
    const segG = sv('g');
    D.segD.forEach((d, i) => {
      if (D.cmds[i] === 'M') return;
      const on = hoverSeg === i || (sel && sel.seg === i);
      const g = sv('g', { class: `spe-segp${on ? ' on' : ''}`, 'data-seg': i });
      g.append(sv('path', { d, transform: mIn, class: 'vis' }), sv('path', { d, transform: mIn, class: 'hit' }));
      g.addEventListener('pointerenter', () => setHover(i));
      g.addEventListener('pointerleave', () => setHover(null));
      g.addEventListener('click', () => { const n = D.nodes.find((x) => x.seg === i && x.kind === 'end'); if (n) select(n, true); });
      segG.append(g);
    });
    svg.append(segG);

    // Subpath starts: a small arrow along the first segment's direction.
    D.nodes.forEach((n) => {
      if (D.cmds[n.seg] !== 'M' || n.kind !== 'end') return;
      const nx = D.nodes.find((m) => m.seg > n.seg && m.kind === 'end');
      const tx = nx ? (nx.kind === 'end' ? nx.ox : n.ox) : n.ox, ty = nx ? nx.oy : n.oy;
      const ang = Math.atan2(Y(ty) - Y(n.oy), X(tx) - X(n.ox));
      if (!nx || !Number.isFinite(ang)) return;
      const px = X(n.ox) + Math.cos(ang) * 16, py = Y(n.oy) + Math.sin(ang) * 16;
      svg.append(sv('path', { class: 'spe-dir', d: `M${px + Math.cos(ang) * 6},${py + Math.sin(ang) * 6}L${px + Math.cos(ang + 2.5) * 6},${py + Math.sin(ang + 2.5) * 6}L${px + Math.cos(ang - 2.5) * 6},${py + Math.sin(ang - 2.5) * 6}Z` }));
    });

    // Handle lines.
    const hl = sv('g', { class: 'spe-hl' });
    for (const n of D.nodes) {
      if (n.kind !== 'ctrl') continue;
      hl.append(sv('line', { x1: X(n.ax), y1: Y(n.ay), x2: X(n.ox), y2: Y(n.oy) }));
      if (n.bx != null) hl.append(sv('line', { x1: X(n.bx), y1: Y(n.by), x2: X(n.ox), y2: Y(n.oy) }));
    }
    svg.append(hl);

    // Rounding shifts: a red tick from where the node is to where it is written.
    const sh = sv('g', { class: 'spe-shift' });
    const bigShift = D.size > 0 ? D.size * 0.01 : Infinity;
    for (const n of D.nodes) {
      if (n.shift * c.k < 1.2) continue;
      sh.append(sv('line', { x1: X(n.ox), y1: Y(n.oy), x2: X(n.rx), y2: Y(n.ry), class: n.shift > bigShift ? 'bad' : '' }));
      sh.append(sv('circle', { cx: X(n.rx), cy: Y(n.ry), r: 2.2, class: n.shift > bigShift ? 'bad' : '' }));
    }
    svg.append(sh);

    // Nodes.
    const nodesG = sv('g');
    const worst = D.nodes.reduce((a, n) => (!a || n.shift > a.shift ? n : a), null);
    for (const n of D.nodes) {
      const x = X(n.ox), y = Y(n.oy);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const on = sameNode(n, sel);
      const key = `${n.seg}.${n.slot}.${n.kind}`;
      const g = sv('g', { class: `spe-node ${n.kind}${on ? ' on' : ''}${n.shift > bigShift ? ' bad' : ''}`, tabindex: 0, role: 'button', 'data-key': key,
        'aria-label': `${n.kind === 'end' ? 'End point' : 'Control point'} of segment ${n.seg} (${CMD[D.cmds[n.seg]]}) at ${f(n.ox, 6)}, ${f(n.oy, 6)}` });
      g.append(sv('circle', { class: 'grab', cx: x, cy: y, r: 11 }));
      if (n.kind === 'end') g.append(sv('rect', { class: 'mark', x: x - 4.5, y: y - 4.5, width: 9, height: 9 }));
      else g.append(sv('circle', { class: 'mark', cx: x, cy: y, r: 4.2 }));
      g.append(sv('circle', { class: 'ring', cx: x, cy: y, r: 9 }));
      g.addEventListener('pointerdown', (e) => startDrag(e, n));
      g.addEventListener('keydown', (e) => keyNode(e, n));
      g.addEventListener('focus', () => { if (!sameNode(sel, n)) { sel = { seg: n.seg, slot: n.slot, kind: n.kind }; drawRail(); drawTape(); highlightSeg(); } });
      nodesG.append(g);
    }
    svg.append(nodesG);

    // Labels: the selected node's coordinates as written, and the worst shift.
    const sn = nodeOf(sel);
    const tag = (x, y, text, cls) => {
      const w = text.length * 6.6 + 10;
      const lx = Math.min(W - w - 4, Math.max(4, x + 12)), ly = Math.max(16, y - 12);
      svg.append(sv('rect', { class: `spe-tag ${cls || ''}`, x: lx, y: ly - 12, width: w, height: 17, rx: 3 }));
      svg.append(sv('text', { class: `spe-tagt ${cls || ''}`, x: lx + 5, y: ly }, text));
    };
    if (worst && worst.shift > bigShift && !sameNode(worst, sel)) tag(X(worst.ox), Y(worst.oy), `rounding moves this ${f(worst.shift, 3)}`, 'bad');
    if (sn) tag(X(sn.ox), Y(sn.oy), `${f(sn.rx, 8)}, ${f(sn.ry, 8)}`, '');

    // Pan (background) and zoom (Ctrl + wheel).
    bg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const c0 = curCam(), x0 = e.clientX, y0 = e.clientY;
      const r = svg.getBoundingClientRect(), s = W / r.width;
      svg.classList.add('panning');
      const move = (ev) => { cam = { k: c0.k, cx: c0.cx - (ev.clientX - x0) * s / c0.k, cy: c0.cy - (ev.clientY - y0) * s / c0.k }; drawBoard(); };
      const up = () => { svg.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });

    boardHead.replaceChildren(h('h2', {}, 'Artboard'),
      h('span', { class: 'spe-sub' }, `output units · ${f(c.k, 3)} px per unit · grid ${f(minor < major ? minor : major, 3)}`),
      h('span', { class: 'spe-legend' },
        h('span', {}, h('i', { class: 'lg-in' }), 'full precision'), h('span', {}, h('i', { class: 'lg-out' }), 'as written'),
        h('span', {}, h('i', { class: 'lg-sh' }), 'rounding shift')));
    if (had) svg.querySelector(`[data-key="${had}"]`)?.focus({ preventScroll: true });
  }

  svg.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !D) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * 0.002), (e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height));
  }, { passive: false });
  svg.addEventListener('keydown', (e) => {
    if (e.target.closest?.('.spe-node')) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-') zoomBy(1 / 1.5);
    else if (e.key === '0') { cam = null; drawBoard(); }
  });

  function startDrag(e, n) {
    e.preventDefault();
    e.stopPropagation();
    pushUndo();
    frozen = curCam();
    sel = { seg: n.seg, slot: n.slot, kind: n.kind };
    const key = `${n.seg}.${n.slot}.${n.kind}`;
    svg.querySelector(`[data-key="${key}"]`)?.focus({ preventScroll: true });
    const r0 = svg.getBoundingClientRect();
    const c = frozen;
    const grabX = (e.clientX - r0.left) * (W / r0.width), grabY = (e.clientY - r0.top) * (H / r0.height);
    const offX = W / 2 + (n.ox - c.cx) * c.k - grabX, offY = H / 2 + (n.oy - c.cy) * c.k - grabY;
    let pending = null;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width) + offX, py = (ev.clientY - r.top) * (H / r.height) + offY;
      pending = [snap(c.cx + (px - W / 2) / c.k, ev.altKey), snap(c.cy + (py - H / 2) / c.k, ev.altKey)];
      requestAnimationFrame(() => {
        if (!pending) return;
        const cur = nodeOf(sel) || n;
        const [ox, oy] = pending; pending = null;
        writeNode(cur, ox, oy);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      frozen = null; cam = cam || c; drawBoard();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    drawRail(); drawTape();
  }

  function keyNode(e, n) {
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[e.key]) {
      e.preventDefault();
      // Arrow keys: 0.1 unit (1 at 0 decimals), Shift ten times that.
      const s = (D.dec === 0 ? 1 : 0.1) * (e.shiftKey ? 10 : 1);
      pushUndo();
      cam = cam || curCam();
      writeNode(n, snap(n.ox + dirs[e.key][0] * s), snap(n.oy + dirs[e.key][1] * s));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); select(n, true);
    }
  }

  function select(n, focusField) {
    sel = { seg: n.seg, slot: n.slot, kind: n.kind };
    drawBoard(); drawRail(); drawTape();
    if (focusField) inspector.querySelector('input')?.focus();
  }
  function setHover(i) {
    if (hoverSeg === i) return;
    hoverSeg = i;
    highlightSeg();
  }
  function highlightSeg() {
    for (const g of svg.querySelectorAll('.spe-segp')) g.classList.toggle('on', +g.dataset.seg === hoverSeg || (sel && +g.dataset.seg === sel.seg));
    for (const p of tape.querySelectorAll('.pc')) p.classList.toggle('hov', +p.dataset.seg === hoverSeg);
    for (const p of tape.querySelectorAll('.pc')) p.classList.toggle('sel', !!sel && +p.dataset.seg === sel.seg);
  }

  // ---------------- draw: rail ----------------
  function drawRail() {
    ladder.replaceChildren();
    const lad = (res && res.ladder) || [];
    const before = D ? D.before : 1;
    const cur = String(ctx.raw.decimals);
    for (const r of lad) {
      const on = r.decimals === cur;
      const w = Math.max(1, Math.min(100, (r.chars / before) * 100));
      ladder.append(h('button', { class: `spe-rung${on ? ' on' : ''}${r.over ? ' over' : ''}`, role: 'radio', 'aria-checked': String(on),
        title: `${r.decimals === 'keep' ? 'Keep all decimals' : `${r.decimals} decimal${r.decimals === '1' ? '' : 's'}`}: ${r.chars} characters, nodes move up to ${f(r.shift, 3)}`,
        onclick: () => ctx.set('decimals', r.decimals),
        onkeydown: (e) => {
          const i = lad.indexOf(r);
          const j = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1 : null;
          if (j == null || !lad[j]) return;
          e.preventDefault(); ctx.set('decimals', lad[j].decimals);
          requestAnimationFrame(() => ladder.querySelector('.spe-rung.on')?.focus());
        } },
      h('span', { class: `dp${r.decimals === 'keep' ? ' all' : ''}` }, DEC_LABEL[r.decimals]),
      h('span', { class: 'bar' }, h('i', { style: `width:${w}%` })),
      h('span', { class: 'ch' }, String(r.chars)),
      h('span', { class: 'sh' }, r.shift ? f(r.shift, 2) : '0')));
    }
    if (lad.length) ladder.append(h('div', { class: 'spe-lnote' }, `bar = share of the ${before} input characters; red = a node moves over 1 % of the drawing`));

    inspector.replaceChildren();
    const n = nodeOf(sel);
    if (!D) return;
    if (!n) {
      inspector.append(h('div', { class: 'spe-sub' }, 'Click a node or a segment (or Tab into the artboard) to read and type its position.'));
    } else {
      const coord = (axis) => {
        const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${axis} (input units)` });
        inp.value = f(axis === 'x' ? n.x : n.y, 10);
        inp.addEventListener('change', () => {
          const v = ctx.parseEng(inp.value);
          if (v == null) { inp.classList.add('bad'); return; }
          pushUndo();
          const T = D.transform;
          const ox = axis === 'x' ? v * T.scale + T.tx : n.ox, oy = axis === 'y' ? v * T.scale + T.ty : n.oy;
          writeNode(n, ox, oy);
        });
        return h('label', {}, axis, inp);
      };
      const idx = D.nodes.findIndex((m) => sameNode(m, n));
      const go = (d) => { const m = D.nodes[(idx + d + D.nodes.length) % D.nodes.length]; sel = { seg: m.seg, slot: m.slot, kind: m.kind }; drawBoard(); drawRail(); drawTape(); };
      inspector.append(
        h('div', { class: 'spe-nhead' }, h('b', {}, `#${n.seg} ${D.cmds[n.seg]}`), h('span', {}, `${CMD[D.cmds[n.seg]]} · ${n.kind === 'end' ? 'end point' : 'control point'}`),
          h('span', { class: 'spe-nav' }, h('button', { class: 'k-btn', 'aria-label': 'Previous node', onclick: () => go(-1) }, '‹'), h('button', { class: 'k-btn', 'aria-label': 'Next node', onclick: () => go(1) }, '›'))),
        h('div', { class: 'spe-xy' }, coord('x'), coord('y')),
        h('div', { class: 'spe-wr' }, 'written as ', h('code', {}, `${f(n.rx, 8)}, ${f(n.ry, 8)}`),
          n.shift ? h('span', { class: n.shift > D.size * 0.01 ? 'bad' : '' }, ` · moved ${f(n.shift, 2)}`) : ' · exact'));
    }

    figs.replaceChildren();
    for (const v of (res.values || [])) {
      if (v.label === 'Characters') continue;
      figs.append(h('dt', {}, v.label), h('dd', { class: v.tone === 'warn' ? 'warn' : '' }, String(v.value), v.hint ? h('small', {}, v.hint) : null));
    }
  }

  // ---------------- draw: tape ----------------
  function drawTape() {
    tape.replaceChildren();
    if (!D) { tapeHead.replaceChildren(h('h2', {}, 'Output')); return; }
    const pct = D.before ? (1 - D.after / D.before) * 100 : 0;
    const meter = h('span', { class: 'spe-meter', title: `${D.after} of ${D.before} characters` }, h('i', { style: `width:${Math.min(100, (D.after / Math.max(1, D.before)) * 100)}%` }));
    tapeHead.replaceChildren(h('h2', {}, 'Output'), h('span', { class: 'spe-sub' }, h('b', {}, String(D.after)), ' characters from ', h('b', {}, String(D.before)),
      ` · ${pct >= 0 ? f(pct, 3) + ' % shorter' : f(-pct, 3) + ' % longer'}`), meter,
    h('span', { class: 'spe-legend' }, h('span', {}, h('code', {}, 'C'), ' absolute'), h('span', {}, h('code', { class: 'rel' }, 'c'), ' relative'),
      h('span', {}, 'hover a piece to find it')));
    D.pieces.forEach((p) => {
      const m = /^(\s*)([A-Za-z]?)(.*)$/.exec(p.text);
      const span = h('span', { class: `pc${p.rel ? ' rel' : ''}`, 'data-seg': p.seg, title: `segment ${p.seg}: ${CMD[D.cmds[p.seg]]}${m[2] ? '' : ' (command letter repeated, so left out)'}` },
        m[1], m[2] ? h('b', {}, m[2]) : null, m[3]);
      span.addEventListener('pointerenter', () => setHover(p.seg));
      span.addEventListener('pointerleave', () => setHover(null));
      span.addEventListener('click', () => { const n = D.nodes.find((x) => x.seg === p.seg && x.kind === 'end'); if (n) select(n, false); });
      tape.append(span);
    });
    highlightSeg();
  }

  // ---------------- sync ----------------
  function syncControls() {
    const raw = ctx.raw;
    for (const b of modeSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === raw.mode));
    for (const el of root.querySelectorAll('[data-k]')) {
      if (el.type === 'checkbox') el.checked = !!raw[el.dataset.k];
      else if (document.activeElement !== el) el.value = raw[el.dataset.k] ?? '';
      if (el.type === 'text') { const t = String(raw[el.dataset.k] ?? '').trim(); el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null); }
    }
    if (document.activeElement !== src) src.value = raw.d ?? '';
  }
  modeSeg.addEventListener('keydown', (e) => {
    const opts = byKey.mode.options.map((o) => o[0]);
    const i = opts.indexOf(ctx.raw.mode);
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
    if (j == null) return;
    e.preventDefault();
    const v = opts[(j + opts.length) % opts.length];
    ctx.set('mode', v);
    requestAnimationFrame(() => modeSeg.querySelector(`[data-v="${v}"]`)?.focus());
  });

  ctx.onResult((r) => {
    const prevBox = D && D.outBox;
    res = r; D = r.drawing || null;
    // A different path (not a node moved) gets a fresh fit.
    if (D && prevBox && !frozen && cam && (Math.abs(prevBox.w - D.outBox.w) > prevBox.w * 0.5 || Math.abs(prevBox.x - D.outBox.x) > Math.max(prevBox.w, prevBox.h))) cam = null;
    if (sel && !nodeOf(sel)) sel = null;
    syncControls();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is written'), ...(r.notes || []).map((t) => h('div', {}, t)));
    drawBoard(); drawRail(); drawTape();
  });
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const w = boardBox.clientWidth, hh = boardBox.clientHeight;
    if (w !== lastW || hh !== lastH) { lastW = w; lastH = hh; drawBoard(); }
  }).observe(boardBox);
}
