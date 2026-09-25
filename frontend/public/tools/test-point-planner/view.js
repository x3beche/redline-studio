// Test Point Planner: the board, to scale, with the test pads on it, is the page.
//   Board - the outline (drag its corner for the size), the edge band the
//           fixture needs, each pad at its size with its probe keep-out
//           (half the pitch: two keep-outs touching = the pitch). Clashes are
//           drawn between the pads, edge and side problems at the pad. Drag a
//           pad to move it; arrows nudge, Delete takes it off, F flips side.
//   Nets  - every net with its kind, priority and how many test points it
//           needs; drag one onto the board (or press Enter) to place a pad.
// Placing and moving write "@x,y side" into the net list, so the text stays
// the one input; every number drawn comes from run()'s result.plan.
const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
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
const num = (v, d = 2) => String(Number(Number(v).toFixed(d)));

const KINDS = ['power', 'gnd', 'debug', 'clock', 'hs', 'analog', 'control', 'signal'];
const KIND_WORDS = new Set([...KINDS, 'ground', 'pwr', 'rail', 'supply', 'prog', 'swd', 'jtag', 'clk', 'highspeed', 'diff', 'sense', 'ctrl', 'sig', 'io', 'gpio']);
const POS = /^@?-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;
const SIDE = /^(top|t|bottom|bot|b)$/i;
const PRIO = [['must', 'Must have'], ['should', 'Should have'], ['optional', 'Optional'], ['avoid', 'Avoid: no stub']];
const METHODS = [['bed', 'Bed of nails'], ['flying', 'Flying probe'], ['pogo', 'Pogo fixture'], ['manual', 'Bench']];

// ---------- the net list, edited as text ----------
function tokensOf(line) {
  const l = line.trim();
  const csv = !/\s/.test(l) && l.includes(',') && !l.includes('@');
  return l.split(csv ? /,/ : /\t|;|,\s+|\s+/).filter(Boolean);
}
function withPos(line, x, y, side) {
  const t = tokensOf(line);
  const keep = [t[0], ...t.slice(1).filter((w) => !POS.test(w) && !SIDE.test(w))];
  if (x != null) keep.push(`@${num(x)},${num(y)}`, side);
  return keep.join(' ');
}
function withKind(line, kind) {
  const t = tokensOf(line);
  return [t[0], kind, ...t.slice(1).filter((w) => !KIND_WORDS.has(w.toLowerCase()))].join(' ');
}

export function page(root, ctx) {
  const F = (v, d = 3) => ctx.fmtNum(v, d);
  const st = { view: null, snap: 0.1, sel: null, focusLine: null, drag: null, pending: null, geo: null, chipDrag: null };
  const P = () => ctx.result?.plan;

  // ---------- layout ----------
  const segMethod = h('div', { class: 'tp-seg', role: 'group', 'aria-label': 'Test method' });
  const segView = h('div', { class: 'tp-seg', role: 'group', 'aria-label': 'Side shown' });
  const segSnap = h('div', { class: 'tp-seg', role: 'group', 'aria-label': 'Snap' });
  const field = (key, label, unit, aria) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': aria, oninput: (e) => ctx.set(key, e.target.value) });
    return { el: h('label', { class: 'tp-f' }, label, inp, unit), inp, key };
  };
  const fBw = field('bw', 'board', '×', 'Board width in mm');
  const fBh = field('bh', '', 'mm', 'Board height in mm');
  const fRate = field('rating', 'probe', 'A', 'Probe current rating in A');
  const rules = h('div', { class: 'tp-rules', 'aria-live': 'polite' });
  const boardDraw = h('div', { class: 'tp-draw' });
  const issues = h('div', { class: 'tp-issues' });
  const board = h('section', { class: 'tp-card tp-board', 'aria-label': 'The board' },
    h('div', { class: 'tp-head' }, h('h2', {}, 'Board'), segMethod, h('span', { class: 'grow' }), segView, segSnap,
      h('span', { class: 'tp-f' }, fBw.el, fBh.el), fRate.el),
    rules, boardDraw, issues,
    h('div', { class: 'tp-foot' }, h('span', {}, 'Drag a net from the list onto the board; drag pads to move them, the corner to size the board.'),
      h('span', {}, h('kbd', {}, '←'), h('kbd', {}, '→'), ' move', ' · ', h('kbd', {}, 'Shift'), ' fine', ' · ', h('kbd', {}, 'F'), ' flip side', ' · ', h('kbd', {}, 'Del'), ' remove')));

  const trayHead = h('span', { class: 'sub' });
  const list = h('div', { class: 'tp-list', role: 'list' });
  const src = h('textarea', { spellcheck: 'false', 'aria-label': 'Net list, one per line', oninput: (e) => ctx.set('nets', e.target.value) });
  const warns = h('div', { class: 'k-warns tp-warns', 'aria-live': 'polite' });
  const tray = h('section', { class: 'tp-card tp-tray', 'aria-label': 'Nets' },
    h('div', { class: 'tp-head' }, h('h2', {}, 'Nets'), trayHead),
    warns, list,
    h('details', { class: 'tp-src' }, h('summary', {}, 'Net list as text: NAME [kind] [current] [@x,y] [side], or a KiCad netlist'), src));
  root.append(h('div', { class: 'tp' }, board, tray, h('section', { class: 'tp-out' }, ctx.outputs)));

  const lines = () => String(ctx.raw.nets ?? '').split('\n');
  const commit = (ls, soon) => (soon ? setSoon({ nets: ls.join('\n') }) : ctx.set('nets', ls.join('\n')));
  const setSoon = (obj) => {
    const first = !st.pending;
    st.pending = { ...(st.pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = st.pending; st.pending = null; ctx.setMany(p); });
  };
  // A KiCad netlist has no room for positions: turn it into a list first.
  const asList = () => {
    const p = P();
    if (p && p.format !== 'list') {
      const ls = ['# net  [kind]  [current]  [@x,y]  [side]', ...p.nets.map((n) => n.name)];
      return { ls, lineOf: (name) => ls.indexOf(name) };
    }
    const ls = lines();
    return { ls, lineOf: (name) => p?.nets.find((n) => n.name === name)?.line ?? -1 };
  };
  const viewSide = () => {
    const p = P();
    return st.view || (p?.M.sides === 'top' ? 'top' : 'bottom');
  };
  const padSide = (pd) => (pd.side === 'both' ? 'top' : pd.side);

  const placeNet = (name, x, y) => {
    const p = P(); if (!p) return;
    const { ls, lineOf } = asList();
    const li = lineOf(name);
    const side = viewSide();
    const placedHere = p.pads.filter((d) => d.name === name);
    if (li >= 0 && !POS.test(tokensOf(ls[li]).find((w) => POS.test(w)) || '')) {
      ls[li] = withPos(ls[li], x, y, side);
      st.focusLine = li;
    } else {
      const after = Math.max(li, ...placedHere.map((d) => d.line ?? -1));
      ls.splice(after + 1, 0, `${name} @${num(x)},${num(y)} ${side}`);
      st.focusLine = after + 1;
    }
    commit(ls);
  };
  const movePad = (pd, x, y, soon) => {
    const ls = lines();
    if (pd.line == null || ls[pd.line] == null) return;
    ls[pd.line] = withPos(ls[pd.line], x, y, pd.sideGiven || padSide(pd));
    commit(ls, soon);
  };
  const removePad = (pd) => {
    const p = P(); const ls = lines();
    if (pd.line == null) return;
    const net = p.nets.find((n) => n.name === pd.name);
    if (net && net.line === pd.line) ls[pd.line] = withPos(ls[pd.line], null);
    else ls.splice(pd.line, 1);
    st.sel = null;
    commit(ls);
  };
  const flipPad = (pd) => {
    const ls = lines();
    if (pd.line == null) return;
    ls[pd.line] = withPos(ls[pd.line], pd.x, pd.y, padSide(pd) === 'top' ? 'bottom' : 'top');
    st.focusLine = pd.line;
    commit(ls);
  };
  const setKind = (name, kind) => {
    const { ls, lineOf } = asList();
    const li = lineOf(name); if (li < 0) return;
    ls[li] = withKind(ls[li], kind);
    commit(ls);
  };
  // A free spot for a new pad: on the pitch grid, inside the edge band, clear of the others.
  const freeSpot = () => {
    const p = P(); const M = p.M;
    const bw = p.bw || 50, bh = p.bh || 40;
    const same = p.pads.filter((d) => padSide(d) === viewSide());
    const m = (p.bw ? M.edge : 0) + M.pad;
    for (let y = m; y <= bh - m + 1e-9; y += M.pitch) {
      for (let x = m; x <= bw - m + 1e-9; x += M.pitch) {
        if (same.every((d) => Math.hypot(d.x - x, d.y - y) >= M.pitch)) return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
      }
    }
    return [bw / 2, bh / 2];
  };

  // ---------- the board ----------
  function drawBoard() {
    const p = P();
    boardDraw.style.minHeight = `${boardDraw.offsetHeight}px`; // keep the page still while redrawing
    boardDraw.replaceChildren();
    if (!p) return;
    const M = p.M;
    const W = Math.max(300, boardDraw.clientWidth || 800);
    const narrow = W < 560;
    const bw = p.bw || 50, bh = p.bh || 40;
    let ex0 = 0, ey0 = 0, ex1 = bw, ey1 = bh;
    for (const d of p.pads) { ex0 = Math.min(ex0, d.x - 3); ey0 = Math.min(ey0, d.y - 3); ex1 = Math.max(ex1, d.x + 3); ey1 = Math.max(ey1, d.y + 3); }
    const frozen = st.drag?.geo; // keep the mapping still while dragging
    if (frozen) { ex0 = frozen.ex0; ey0 = frozen.ey0; }
    let L = narrow ? 30 : 40;
    const T = 24, R = narrow ? 70 : 96, B = 18;
    const Hmax = narrow ? 420 : clamp(window.innerHeight - 250, 380, 620);
    const s = st.drag?.s ?? Math.min((W - L - R) / (ex1 - ex0), (Hmax - T - B) / (ey1 - ey0));
    L = frozen ? frozen.L : L + Math.max(0, (W - L - R - (ex1 - ex0) * s) / 2);
    const X = (x) => L + (x - ex0) * s, Y = (y) => T + (y - ey0) * s;
    const H = T + (ey1 - ey0) * s + B;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': `Board ${F(bw)} by ${F(bh)} mm with ${p.pads.length} placed test pads` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'tp-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-l' }));
    defs.append(pat);
    svg.append(defs);
    // the board and the edge band the fixture needs
    if (p.bw && p.bh) {
      svg.append(sv('rect', { x: X(0), y: Y(0), width: bw * s, height: bh * s, rx: 3, class: 'pcb' }));
      const e = M.edge;
      if (2 * e < bw && 2 * e < bh) {
        svg.append(sv('path', { d: `M${X(0)},${Y(0)} h${bw * s} v${bh * s} h${-bw * s} Z M${X(e)},${Y(e)} v${(bh - 2 * e) * s} h${(bw - 2 * e) * s} v${-(bh - 2 * e) * s} Z`,
          class: 'edgeband', 'fill-rule': 'evenodd' }));
        svg.append(txt(X(e) + 4, Y(e / 2) + 3.5, `keep ≥ ${F(M.edge)} mm from the edge`, 'sm warn-t'));
      }
    } else {
      svg.append(sv('rect', { x: X(0), y: Y(0), width: bw * s, height: bh * s, class: 'nopcb' }));
      svg.append(txt(X(bw / 2), Y(bh / 2), 'board size not set: no edge check · drag the corner or type it above', 'soft', 'middle'));
    }
    // the probe pitch grid
    if (M.pitch * s >= 9) {
      for (let y = M.pitch; y < bh; y += M.pitch) for (let x = M.pitch; x < bw; x += M.pitch) svg.append(sv('circle', { cx: X(x), cy: Y(y), r: 0.8, class: 'dot' }));
    }
    // rulers
    const step = [1, 2, 5, 10, 20, 50].find((v) => v * s >= 38) || 100;
    for (let x = 0; x <= bw + 1e-9; x += step) svg.append(sv('line', { x1: X(x), y1: T - 6, x2: X(x), y2: T - 2, class: 'tick' }), txt(X(x), T - 9, String(x), 'm sm soft', 'middle'));
    for (let y = 0; y <= bh + 1e-9; y += step) svg.append(sv('line', { x1: L - 6, y1: Y(y), x2: L - 2, y2: Y(y), class: 'tick' }), txt(L - 8, Y(y) + 3, String(y), 'm sm soft', 'end'));
    svg.append(txt(X(bw) + 6, T - 9, 'mm', 'm sm soft'));
    // problems per pad
    const bad = new Map();
    const note = (i, lvl) => { const cur = bad.get(i); if (!cur || lvl === 'bad') bad.set(i, lvl); };
    for (const is of p.issues) {
      const lvl = is.level === 'under preferred' ? 'warn' : 'bad';
      note(is.i, lvl); if (is.j != null) note(is.j, lvl);
    }
    const vs = viewSide();
    // keep-outs first, then clash lines, then pads on top
    p.pads.forEach((d, i) => {
      const other = padSide(d) !== vs && M.sides !== 'both';
      if (other) return;
      const lvl = p.issues.some((q) => q.type === 'pitch' && (q.i === i || q.j === i) && q.level === 'too close') ? 'bad'
        : p.issues.some((q) => q.type === 'pitch' && (q.i === i || q.j === i)) ? 'warn' : '';
      svg.append(sv('circle', { cx: X(d.x), cy: Y(d.y), r: (M.pitch / 2) * s, class: `keep ${lvl}` }));
    });
    for (const q of p.issues) {
      if (q.type !== 'pitch') continue;
      const a = p.pads[q.i], b = p.pads[q.j];
      const cls = q.level === 'too close' ? 'clash' : 'clash warn';
      svg.append(sv('line', { x1: X(a.x), y1: Y(a.y), x2: X(b.x), y2: Y(b.y), class: cls }));
      const mx = (X(a.x) + X(b.x)) / 2, my = (Y(a.y) + Y(b.y)) / 2;
      const lab = `${F(q.d)} mm < ${F(M.pitch)}`;
      svg.append(sv('rect', { x: mx - lab.length * 3.2 - 3, y: my - 24, width: lab.length * 6.4 + 6, height: 14, rx: 2, class: 'bg', opacity: 0.9 }),
        txt(mx, my - 13.5, lab, `m sm b ${q.level === 'too close' ? 'danger' : 'warn-t'}`, 'middle'));
    }
    const rPad = Math.max(3.5, (M.pad / 2) * s);
    const late = []; // problem labels, drawn over everything at full strength
    p.pads.forEach((d, i) => {
      const other = padSide(d) !== vs && M.sides !== 'both';
      const net = p.nets.find((n) => n.name === d.name);
      const kind = net?.kind || 'signal';
      const cls = `pad${other ? ' other' : ''}${bad.get(i) === 'bad' ? ' bad' : ''}${st.sel === d.line ? ' sel' : ''}`;
      const g = sv('g', { class: cls, tabindex: 0, role: 'button', 'data-pad': i, 'data-fk': `pad${d.line}`,
        'aria-label': `${d.name} test pad at ${num(d.x)}, ${num(d.y)} mm, ${padSide(d)}${bad.get(i) ? ', has a problem' : ''}. Arrows move, F flips, Delete removes.` });
      g.append(sv('circle', { cx: X(d.x), cy: Y(d.y), r: Math.max(rPad + 6, 11), class: 'hit' }),
        sv('circle', { cx: X(d.x), cy: Y(d.y), r: rPad, class: `padc k-${kind}` }),
        sv('circle', { cx: X(d.x), cy: Y(d.y), r: rPad * 0.45, class: 'gold' }),
        sv('circle', { cx: X(d.x), cy: Y(d.y), r: rPad + 4, class: 'ring' }));
      // a neighbour just to the right: put the name above instead
      const crowded = p.pads.some((o, j) => j !== i && Math.abs(o.y - d.y) < 2 && o.x > d.x && (o.x - d.x) * s < d.name.length * 6.4 + 14);
      const lx = X(d.x) + rPad + 4, ly = Y(d.y) + 3.5;
      if (crowded) g.append(txt(X(d.x) - rPad - 4, ly, d.name, `m sm ${other ? 'soft' : 'silk b'}`, 'end'));
      else g.append(txt(lx, ly, d.name, `m sm ${other ? 'soft' : 'silk b'}`));
      if (st.sel === d.line) g.append(txt(lx, ly + 12, `${num(d.x)}, ${num(d.y)} · ${padSide(d)}`, 'm sm soft'));
      const probs = p.issues.filter((q) => q.i === i && q.type !== 'pitch');
      probs.forEach((q, k) => late.push(txt(lx, ly + 12 * (k + (st.sel === d.line ? 2 : 1)), q.type === 'edge' ? `${F(q.e)} mm to the edge` : `on the ${padSide(d)}: probes on the ${M.sides}`, 'm sm b danger')));
      svg.append(g);
    });
    svg.append(...late);
    // the corner sizes the board
    const cg = sv('g', { class: 'corner', tabindex: 0, role: 'slider', 'data-fk': 'corner', 'data-drag': 'corner',
      'aria-label': 'Board size: arrows change width and height', 'aria-valuetext': `${F(bw)} by ${F(bh)} mm` });
    cg.append(sv('rect', { x: X(bw) - 12, y: Y(bh) - 12, width: 24, height: 24, fill: 'transparent' }),
      sv('rect', { x: X(bw) - 6, y: Y(bh) - 6, width: 12, height: 12, rx: 2, class: 'knob' }),
      sv('rect', { x: X(bw) - 9, y: Y(bh) - 9, width: 18, height: 18, rx: 4, class: 'ring' }));
    svg.append(cg);
    svg.append(txt(X(bw) + 12, Y(bh) + 4, `${F(bw)} × ${F(bh)}`, 'm sm b'));
    if (st.chipDrag?.over) {
      const [x, y] = st.chipDrag.over;
      svg.append(sv('circle', { cx: X(x), cy: Y(y), r: (M.pitch / 2) * s, class: 'drop' }));
    }
    st.geo = { s, ex0, ey0, L, T, W, H };
    boardDraw.append(svg);
    boardDraw.style.minHeight = '';
  }

  // ---------- the rules and the problems, as text ----------
  function drawRules() {
    const p = P();
    rules.replaceChildren();
    issues.replaceChildren();
    if (!p) return;
    const M = p.M;
    const placed = p.pads.length;
    rules.append(h('span', {}, h('b', {}, String(p.total)), ' test points', p.missingGnd ? '' : ` (${p.gndTotal} GND)`, ` · ${placed} placed`),
      h('span', {}, 'pad ', h('b', {}, `≥ ${F(M.pad)}`), ' mm'),
      h('span', {}, 'pitch ', h('b', {}, F(M.pitch)), ` (≥ ${F(M.pitchMin)}) mm`),
      h('span', {}, 'edge ', h('b', {}, `≥ ${F(M.edge)}`), ' mm'),
      h('span', {}, 'probed from ', h('b', {}, M.sides === 'both' ? 'both sides' : `the ${M.sides}`)));
    for (const q of p.issues) {
      const a = p.pads[q.i];
      const what = q.type === 'pitch' ? `${a.name} – ${p.pads[q.j].name}: ${F(q.d)} mm apart, ${F(M.pitch)} preferred, ${F(M.pitchMin)} least`
        : q.type === 'edge' ? `${a.name}: ${F(q.e)} mm from the edge, keep ≥ ${F(M.edge)} mm` : `${a.name}: on the ${padSide(a)}, ${M.name} probes the ${M.sides}`;
      issues.append(h('button', { type: 'button', class: `tp-issue${q.level === 'under preferred' ? ' warn' : ''}`,
        onclick: () => { st.sel = a.line; redraw(); root.querySelector(`[data-fk="pad${a.line}"]`)?.focus(); } }, h('b', {}, q.level), what));
    }
  }

  // ---------- the net tray ----------
  function drawTray() {
    const p = P();
    list.replaceChildren();
    if (!p) { trayHead.textContent = ''; return; }
    const count = (name) => p.pads.filter((d) => d.name === name).length;
    const mustOpen = p.nets.filter((n) => n.prio === 'must' && count(n.name) < Math.max(1, n.n)).length;
    trayHead.textContent = `${p.nets.length} nets · ${mustOpen ? `${mustOpen} must-have not placed` : 'all must-haves placed'}`;
    trayHead.style.color = mustOpen ? '' : 'var(--ok)';
    const byPrio = (pr) => p.nets.filter((n) => n.prio === pr);
    for (const [pr, title] of PRIO) {
      const ns = byPrio(pr);
      if (!ns.length) continue;
      list.append(h('div', { class: 'tp-grp' }, h('span', {}, title), h('span', {}, `${ns.reduce((a, n) => a + n.n, 0)} TP`)));
      for (const n of ns) {
        const k = count(n.name);
        const need = n.n;
        const done = need > 0 ? k >= need : k > 0;
        const sel = h('select', { 'aria-label': `Kind of ${n.name}`, title: n.guessed ? 'guessed from the name: pick to set it' : 'kind',
          onchange: (e) => setKind(n.name, e.target.value), onpointerdown: (e) => e.stopPropagation() },
          KINDS.map((kd) => h('option', { value: kd, selected: kd === n.kind }, kd + (kd === n.kind && n.guessed ? '?' : ''))));
        const chip = h('div', { class: `tp-chip${done ? ' done' : ''}${pr === 'avoid' ? ' avoid' : ''}`, role: 'listitem', tabindex: 0, 'data-net': n.name,
          title: `${n.name}: ${n.kind}, ${pr}. Drag onto the board or press Enter to place a pad.`,
          'aria-label': `${n.name}, ${n.kind}, ${pr}, ${k} of ${need} placed. Enter places a pad.` },
          h('i', { style: `background: var(--tool-k-${n.kind})` }),
          h('span', { class: 'nm' }, n.name, n.amps ? h('small', {}, ` ${F(n.amps)} A`) : null),
          sel,
          h('span', { class: `cnt${done ? ' ok' : ''}` }, need > 0 ? `${k}/${need}` : k ? `${k}` : '–'));
        list.append(chip);
      }
    }
  }

  // ---------- pointer and keys ----------
  const toMm = (e) => {
    const g = st.drag?.geo || st.geo; const svg = boardDraw.querySelector('svg'); if (!g || !svg) return null;
    const r = svg.getBoundingClientRect();
    const k = g.W / r.width;
    const x = ((e.clientX - r.left) * k - g.L) / g.s + g.ex0, y = ((e.clientY - r.top) * k - g.T) / g.s + g.ey0;
    return { x, y, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  };
  const snap = (v) => Math.round(v / st.snap) * st.snap;
  boardDraw.addEventListener('pointerdown', (e) => {
    const p = P(); if (!p) return;
    const padEl = e.target.closest('[data-pad]');
    const corner = e.target.closest('[data-drag="corner"]');
    if (!padEl && !corner) { if (st.sel != null) { st.sel = null; redraw(); } return; }
    e.preventDefault();
    boardDraw.setPointerCapture(e.pointerId);
    const m = toMm(e);
    if (padEl) {
      const d = p.pads[Number(padEl.getAttribute('data-pad'))];
      st.sel = d.line;
      st.drag = { kind: 'pad', pd: { ...d }, m0: m, s: st.geo.s, geo: { ...st.geo }, moved: false };
      padEl.focus({ preventScroll: true });
      redraw();
    } else {
      st.drag = { kind: 'corner', m0: m, bw: p.bw || 50, bh: p.bh || 40, s: st.geo.s, geo: { ...st.geo } };
      corner.focus({ preventScroll: true });
    }
  });
  boardDraw.addEventListener('pointermove', (e) => {
    const d = st.drag; if (!d) return;
    const m = toMm(e); if (!m) return;
    if (d.kind === 'pad') {
      const x = snap(d.pd.x + (m.x - d.m0.x)), y = snap(d.pd.y + (m.y - d.m0.y));
      if (!d.moved && Math.hypot(x - d.pd.x, y - d.pd.y) < 1e-9) return;
      d.moved = true;
      movePad(d.pd, x, y, true);
    } else if (d.kind === 'corner') {
      const bw = clamp(Math.round((d.bw + (m.x - d.m0.x)) * 2) / 2, 5, 500), bh = clamp(Math.round((d.bh + (m.y - d.m0.y)) * 2) / 2, 5, 500);
      setSoon({ bw: num(bw, 1), bh: num(bh, 1) });
    }
  });
  const endDrag = () => { if (st.drag) { st.drag = null; redraw(); } };
  boardDraw.addEventListener('pointerup', endDrag);
  boardDraw.addEventListener('pointercancel', endDrag);
  boardDraw.addEventListener('keydown', (e) => {
    const p = P(); if (!p) return;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.target.closest('[data-drag="corner"]')) {
      if (!dir) return;
      e.preventDefault();
      const st1 = e.shiftKey ? 0.5 : 1;
      ctx.setMany({ bw: num(Math.max(5, (p.bw || 50) + dir[0] * st1), 1), bh: num(Math.max(5, (p.bh || 40) + dir[1] * st1), 1) });
      return;
    }
    const padEl = e.target.closest('[data-pad]'); if (!padEl) return;
    const d = p.pads[Number(padEl.getAttribute('data-pad'))];
    if (dir) {
      e.preventDefault();
      const stp = st.snap > 1 ? st.snap : e.shiftKey ? 0.1 : 0.5;
      st.sel = d.line;
      movePad(d, Math.round((d.x + dir[0] * stp) * 100) / 100, Math.round((d.y + dir[1] * stp) * 100) / 100);
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removePad(d); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); flipPad(d); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = st.sel === d.line ? null : d.line; redraw(); }
  });
  // nets from the tray onto the board
  const ghost = h('div', { class: 'tp-ghost', hidden: true });
  document.body.append(ghost);
  list.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('[data-net]'); if (!chip || e.target.closest('select') || !P()) return;
    e.preventDefault();
    chip.setPointerCapture(e.pointerId);
    chip.focus({ preventScroll: true });
    st.chipDrag = { name: chip.getAttribute('data-net'), x0: e.clientX, y0: e.clientY, moved: false, over: null, el: chip };
  });
  list.addEventListener('pointermove', (e) => {
    const c = st.chipDrag; if (!c) return;
    if (!c.moved && Math.hypot(e.clientX - c.x0, e.clientY - c.y0) < 5) return;
    c.moved = true;
    ghost.hidden = false; ghost.textContent = c.name;
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
    const m = toMm(e);
    const over = m && m.inside ? [snap(m.x), snap(m.y)] : null;
    if (String(over) !== String(c.over)) { c.over = over; drawBoard(); }
  });
  const chipEnd = () => {
    const c = st.chipDrag; if (!c) return;
    st.chipDrag = null; ghost.hidden = true;
    if (!c.moved) { const [x, y] = freeSpot(); placeNet(c.name, x, y); return; }
    if (c.over) placeNet(c.name, c.over[0], c.over[1]); else drawBoard();
  };
  list.addEventListener('pointerup', chipEnd);
  list.addEventListener('pointercancel', () => { st.chipDrag = null; ghost.hidden = true; drawBoard(); });
  list.addEventListener('keydown', (e) => {
    const chip = e.target.closest('[data-net]'); if (!chip || e.target.closest('select')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const [x, y] = freeSpot(); placeNet(chip.getAttribute('data-net'), x, y); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...list.querySelectorAll('[data-net]')]; const i = all.indexOf(chip);
      all[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, all.length - 1)]?.focus();
    }
  });

  // ---------- result -> page ----------
  const sync = (inp, v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
  function redraw() {
    const ae = document.activeElement;
    const fk = ae?.getAttribute?.('data-fk');
    const net = ae?.getAttribute?.('data-net');
    let target = null;
    if (st.focusLine != null) { st.sel = st.focusLine; target = `pad${st.focusLine}`; st.focusLine = null; }
    drawBoard(); drawRules(); drawTray();
    if (target) root.querySelector(`[data-fk="${target}"]`)?.focus({ preventScroll: true });
    else if (net) list.querySelector(`[data-net="${CSS.escape(net)}"]`)?.focus({ preventScroll: true });
    else if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  }
  function renderAll() {
    const raw = ctx.raw, res = ctx.result || {};
    sync(src, raw.nets);
    for (const f of [fBw, fBh, fRate]) {
      sync(f.inp, raw[f.key]);
      f.inp.classList.toggle('bad', String(raw[f.key] ?? '').trim() !== '' && ctx.parseEng(raw[f.key]) == null);
    }
    segMethod.replaceChildren(...METHODS.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String((raw.method || 'bed') === k),
      onclick: () => { st.view = null; ctx.set('method', k); } }, t)));
    const vs = res.plan ? viewSide() : 'bottom';
    segView.replaceChildren(...['top', 'bottom'].map((sd) => h('button', { type: 'button', 'aria-pressed': String(vs === sd),
      title: `Show and place on the ${sd}`, onclick: () => { st.view = sd; redraw(); renderAll(); } }, sd === 'top' ? 'Top' : 'Bottom')));
    segSnap.replaceChildren(...[[0.1, '0.1 mm'], [1.27, '1.27 grid']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(st.snap === v),
      title: 'Snap for dragged pads', onclick: () => { st.snap = v; renderAll(); } }, t)));
    // warnings that the drawing already shows as problems are left to it
    warns.replaceChildren(...(res.warnings || []).filter((w) => !/probe-access problem/.test(w)).map((w) => h('div', {}, w)));
    if (!res.plan) {
      boardDraw.replaceChildren(h('div', { class: 'tp-foot', style: 'padding:30px 12px' }, (res.warnings || []).join(' ')));
      rules.replaceChildren(); issues.replaceChildren(); list.replaceChildren(); trayHead.textContent = '';
      return;
    }
    redraw();
  }
  ctx.onResult(renderAll);
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (P()) redraw(); });
  }).observe(root);
}
