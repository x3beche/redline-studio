// FMEA Lite: the page is the risk matrix.
//   Matrix  - severity (up) against occurrence (right), cells heat-mapped by
//             S x O. Each failure mode is a dot in its cell: its rank inside,
//             red when it needs action, the ring around it is its detection
//             score (full ring = cannot be detected). The action threshold is
//             the amber staircase (in RPN mode for the selected mode's D), the
//             "always act at severity >= N" rule the hatched band on top.
//             Drag a dot to re-score S and O; click it to edit its row; click
//             a cell to filter the list to it. "After action" shows the
//             revised scores with arrows from before to after; dragging there
//             sets the revised S and O.
//   List    - the modes in risk order as cards with a score bar (threshold
//             tick on it) and the Pareto line after the modes holding 80 %.
//   Editor  - the selected row: text, S/O/D steppers with their scale words,
//             the planned action and the scores after it.
// Every score, rank, share and status shown comes from run()'s result.fmea.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

// Scale words (AIAG FMEA 4th ed., shortened).
const WORDS = {
  s: ['No effect', 'Minor, few notice', 'Minor, noticed', 'Degraded, annoys', 'Degraded comfort', 'Secondary function lost',
    'Primary function degraded', 'Primary function lost', 'Safety / regulation, with warning', 'Safety / regulation, no warning'],
  o: ['Remote, prevented', 'Low, isolated', 'Low', 'Moderate, occasional', 'Moderate', 'Moderate, frequent',
    'High, repeated', 'High', 'Very high', 'Almost certain'],
  d: ['Almost certain to catch', 'Very high chance', 'High chance', 'Moderately high', 'Moderate', 'Low chance',
    'Very low chance', 'Remote', 'Very remote', 'Cannot be detected'],
};
const BLANK = { item: '', mode: '', effect: '', cause: '', s: '5', o: '5', d: '5', action: '', rs: '', ro: '', rd: '' };

// Matrix geometry (SVG user units).
const W = 600, H = 598, L = 58, T = 34, C = 52;
const X = (o) => L + (o - 0.5) * C;
const Y = (s) => T + (10.5 - s) * C;
const heat = (p) => (p < 9 ? 0 : p < 20 ? 1 : p < 36 ? 2 : p < 60 ? 3 : 4);
const OFFS = { 1: [[0, 0]], 2: [[-13, 0], [13, 0]], 3: [[-12, -10], [12, -10], [0, 11]], 4: [[-12, -12], [12, -12], [-12, 12], [12, 12]] };
const offsets = (n) => OFFS[n] || Array.from({ length: n }, (_, i) => [((i % 3) - 1) * 15, (Math.floor(i / 3) - 1) * 15]);
const radius = (n) => (n <= 2 ? 11 : n <= 4 ? 9 : 6.5);

export function page(root, ctx) {
  const state = { sel: null, filter: null, after: false, drag: null, press: null, tipFor: null, edRow: undefined };
  const rowsNow = () => structuredClone(ctx.raw.modes || []);
  const setRows = (rows) => ctx.set('modes', rows);
  const fm = () => ctx.result?.fmea || null;
  const useD = () => (ctx.raw.method || 'rpn') !== 'so';
  const scoreName = () => (useD() ? 'RPN' : 'S×O');

  // ---------- skeleton ----------
  const stats = h('div', { class: 'fm-stats', 'aria-live': 'polite' });

  const methodSeg = h('div', { class: 'fm-seg', role: 'group', 'aria-label': 'Score' });
  const viewSeg = h('div', { class: 'fm-seg', role: 'group', 'aria-label': 'Positions' });
  const thrIn = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Action threshold', spellcheck: 'false' });
  const sevIn = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Always act at severity', spellcheck: 'false' });
  const thrLbl = h('span', {}, 'Act at RPN ≥');
  thrIn.addEventListener('input', () => ctx.set(useD() ? 'rpnMin' : 'soMin', thrIn.value));
  sevIn.addEventListener('input', () => ctx.set('sevMin', sevIn.value));

  const svg = sv('svg', { class: 'fm-svg', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Risk matrix: severity against occurrence' });
  const defs = sv('defs');
  const hatch = sv('pattern', { id: 'fm-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  hatch.append(sv('rect', { width: 3, height: 8, style: 'fill: var(--tool-hatch)' }));
  const head = sv('marker', { id: 'fm-head', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  head.append(sv('path', { d: 'M0,0 L10,5 L0,10 z', class: 'fm-arrow-head' }));
  defs.append(hatch, head);
  const gCells = sv('g'), gOver = sv('g'), gAxes = sv('g'), gGhost = sv('g'), gDots = sv('g');
  svg.append(defs, gCells, gOver, gAxes, gGhost, gDots);
  const tip = h('div', { class: 'fm-tip', role: 'status' });
  const stage = h('div', { class: 'fm-stage' }, svg, tip);

  const legend = h('div', { class: 'fm-legend' });
  const mxPanel = h('section', { class: 'fm-panel fm-mxp' },
    h('div', { class: 'fm-head' }, h('h2', {}, 'Risk matrix'), methodSeg,
      h('label', { class: 'fm-f' }, thrLbl, thrIn),
      h('label', { class: 'fm-f' }, h('span', {}, 'Always act at S ≥'), sevIn),
      h('span', { class: 'fm-grow' }), viewSeg),
    stage, legend);

  const listHead = h('div', { class: 'fm-head' });
  const list = h('div', { class: 'fm-list' });
  const listPanel = h('section', { class: 'fm-panel fm-listp' }, listHead, list);

  const edHead = h('div', { class: 'fm-head' });
  const ed = h('div', { class: 'fm-ed' });
  const edPanel = h('section', { class: 'fm-panel fm-edp' }, edHead, ed);

  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const all = h('details', { class: 'fm-panel fm-all' }, h('summary', {}, 'All failure modes as a table'), ctx.form);
  root.append(h('div', { class: 'fm' }, stats,
    h('div', { class: 'fm-work' }, mxPanel, listPanel, edPanel),
    h('div', { class: 'fm-bottom' }, h('div', { class: 'fm-msgs' }, warns, notes, all), ctx.outputs)));

  // ---------- helpers ----------
  const byRow = (row) => fm()?.modes.find((m) => m.row === row) || null;
  const posOf = (m, after = state.after) => (after && m.after ? { s: m.after.s, o: m.after.o } : { s: m.s, o: m.o });
  const dRef = () => {
    const f = fm(); if (!f || !f.modes.length) return 5;
    const m = byRow(state.sel) || f.modes[0];
    return state.after && m.after ? m.after.d : m.d;
  };
  const select = (row, focusEditor = false) => {
    state.sel = row; render(ctx.result);
    if (focusEditor) ed.querySelector('input')?.focus();
  };
  const moveTo = (row, k, s, o, d) => {
    const rows = rowsNow(); const r = rows[row - 1]; if (!r) return;
    const cur = byRow(row);
    if (k === 'a') {
      r.rs = String(s); r.ro = String(o);
      if (d != null) r.rd = String(d);
      else if (useD() && String(r.rd ?? '').trim() === '' && cur) r.rd = String(cur.d);
    } else { r.s = String(s); r.o = String(o); if (d != null) r.d = String(d); }
    state.sel = row; setRows(rows);
  };
  const pointCell = (e) => {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return { o: clamp(Math.round((q.x - L) / C + 0.5), 1, 10), s: clamp(Math.round(10.5 - (q.y - T) / C), 1, 10) };
  };

  // ---------- tooltip ----------
  const showTip = (g) => {
    const f = fm(); const m = g && byRow(+g.dataset.row); if (!m || !f) { tip.style.display = 'none'; state.tipFor = null; return; }
    state.tipFor = g.dataset.row + g.dataset.k;
    const aft = g.dataset.k === 'a' && m.after;
    const sc = aft ? m.after : m;
    const why = aft ? m.after.why : m.why;
    tip.replaceChildren(
      h('b', {}, `#${m.rank} ${m.mode}`), h('div', { class: 'soft' }, m.item),
      h('div', { class: 'm' }, `S ${sc.s} × O ${sc.o}${f.method === 'rpn' ? ` × D ${sc.d}` : ''} = ${scoreName()} ${sc.score}`),
      aft ? h('div', { class: 'soft' }, `after action; before: ${m.score}`) : h('div', { class: 'soft' }, `${pct(m.share)} % of the total risk`),
      why.length ? h('div', { class: 'bad' }, `Needs action: ${why.join(', ')}`) : h('div', { class: 'soft' }, 'Below the thresholds'),
      m.action ? h('div', {}, `Action: ${m.action}`) : (m.act ? h('div', { class: 'bad' }, 'No action planned') : null));
    tip.style.display = 'block';
    const sr = stage.getBoundingClientRect(), gr = g.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = gr.right - sr.left + 8, y = gr.top - sr.top - 6;
    if (x + tw > sr.width - 4) x = gr.left - sr.left - tw - 8;
    if (x < 4) x = 4;
    y = clamp(y, 4, Math.max(4, sr.height - th - 4));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const hideTip = () => { tip.style.display = 'none'; state.tipFor = null; };

  // ---------- matrix ----------
  function drawMatrix(f) {
    gCells.replaceChildren(); gOver.replaceChildren(); gAxes.replaceChildren(); gGhost.replaceChildren(); gDots.replaceChildren();
    const counts = new Map();
    if (f) for (const m of f.modes) { const p = posOf(m); const k = `${p.s},${p.o}`; counts.set(k, (counts.get(k) || 0) + 1); }
    for (let s = 1; s <= 10; s++) for (let o = 1; o <= 10; o++) {
      const r = sv('rect', { x: X(o) - C / 2, y: Y(s) - C / 2, width: C, height: C, class: `fm-cell h${heat(s * o)}`, 'data-s': s, 'data-o': o });
      r.append(sv('title', {}, `S ${s}, O ${o} (S×O ${s * o}): click to list the modes here`));
      gCells.append(r);
      if (!state.compact && !counts.get(`${s},${o}`)) gCells.append(sv('text', { x: X(o) + C / 2 - 4, y: Y(s) + C / 2 - 4, class: 'fm-cnt', 'text-anchor': 'end' }, s * o));
    }
    if (state.filter) gOver.append(sv('rect', { x: X(state.filter.o) - C / 2 + 1.5, y: Y(state.filter.s) - C / 2 + 1.5, width: C - 3, height: C - 3, class: 'fm-cellsel' }));

    // Severity rule: rows S >= sevLimit, hatched.
    const sevLimit = f ? f.sevLimit : (+ctx.raw.sevMin || 9);
    if (sevLimit <= 10) {
      const yb = Y(Math.max(1, Math.ceil(sevLimit))) + C / 2;
      gOver.append(sv('rect', { x: L, y: T, width: 10 * C, height: yb - T, class: 'fm-sevband' }),
        sv('line', { x1: L, x2: L + 10 * C, y1: yb, y2: yb, class: 'fm-sevline' }));
      gAxes.append(sv('text', { x: L, y: T - 10, class: 'fm-lbl bad' }, state.compact ? `S ≥ ${sevLimit}: always act` : `Hatched: S ≥ ${sevLimit}, act whatever the score`));
    }
    // Action threshold staircase.
    const limit = f ? f.limit : null;
    if (limit) {
      const dd = f.method === 'rpn' ? dRef() : 1;
      const pts = [];
      for (let o = 1; o <= 10; o++) {
        const smin = Math.ceil(limit / (o * dd));
        const y = smin > 10 ? T : smin <= 1 ? T + 10 * C : Y(smin) + C / 2;
        pts.push([X(o) - C / 2, y], [X(o) + C / 2, y]);
      }
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
      gOver.append(sv('path', { d, class: 'fm-thr' }));
      const lbl = state.compact ? (f.method === 'rpn' ? `RPN ≥ ${limit} @ D${dd}` : `S×O ≥ ${limit}`) : (f.method === 'rpn' ? `Amber: RPN ≥ ${limit} at D ${dd}` : `Amber: S×O ≥ ${limit}`);
      gAxes.append(sv('text', { x: L + 10 * C, y: T - 10, class: 'fm-lbl warn', 'text-anchor': 'end' }, lbl));
    }
    // Axes.
    for (let i = 1; i <= 10; i++) {
      gAxes.append(sv('text', { x: L - 10, y: Y(i) + 4, class: 'fm-tick', 'text-anchor': 'end' }, i));
      gAxes.append(sv('text', { x: X(i), y: T + 10 * C + 16, class: 'fm-tick', 'text-anchor': 'middle' }, i));
    }
    const yb = T + 10 * C;
    gAxes.append(sv('text', { x: L, y: yb + 36, class: 'fm-lbl' }, 'remote'),
      sv('text', { x: L + 5 * C, y: yb + 36, class: 'fm-lbl b', 'text-anchor': 'middle' }, 'Occurrence O →'),
      sv('text', { x: L + 10 * C, y: yb + 36, class: 'fm-lbl', 'text-anchor': 'end' }, 'almost certain'));
    const rot = (x, y, s, cls, anchor) => sv('text', { x, y, class: cls, 'text-anchor': anchor, transform: `rotate(-90 ${x} ${y})` }, s);
    gAxes.append(rot(22, yb, 'no effect', 'fm-lbl', 'start'), rot(22, T + 5 * C, 'Severity S →', 'fm-lbl b', 'middle'), rot(22, T, 'hazardous', 'fm-lbl', 'end'));

    if (!f || !f.modes.length) {
      gDots.append(sv('rect', { x: L + 2 * C, y: T + 4.4 * C, width: 6 * C, height: 1.2 * C, rx: 6, class: 'fm-halo' }),
        sv('text', { x: L + 5 * C, y: T + 5.1 * C, class: 'fm-lbl b', 'text-anchor': 'middle' }, 'No scored failure modes: add one on the right'));
      return;
    }
    // Dot positions, cells shared by several modes spread inside the cell.
    const place = (key) => {
      const groups = new Map();
      for (const m of f.modes) { const p = key(m); const k = `${p.s},${p.o}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
      const at = new Map();
      for (const [, ms] of groups) {
        const offs = offsets(ms.length), r = radius(ms.length);
        ms.forEach((m, i) => { const p = key(m); at.set(m.row, { x: X(p.o) + offs[i][0], y: Y(p.s) + offs[i][1], r }); });
      }
      return at;
    };
    const now = place((m) => posOf(m));
    if (state.after) {
      const before = place((m) => posOf(m, false));
      for (const m of f.modes) {
        if (!m.after) continue;
        const a = before.get(m.row), b = now.get(m.row);
        const g = sv('g', { class: 'fm-ghost' });
        g.append(sv('circle', { cx: a.x, cy: a.y, r: a.r }), sv('text', { x: a.x, y: a.y + 3.5, 'text-anchor': 'middle' }, m.rank));
        g.append(sv('title', {}, `#${m.rank} before: S ${m.s}, O ${m.o}${f.method === 'rpn' ? `, D ${m.d}` : ''} = ${m.score}`));
        gGhost.append(g);
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (len > a.r + b.r + 8) {
          const ux = dx / len, uy = dy / len;
          gGhost.append(sv('path', { class: 'fm-arrow', d: `M${a.x + ux * (a.r + 2)},${a.y + uy * (a.r + 2)} L${b.x - ux * (b.r + 7)},${b.y - uy * (b.r + 7)}` }));
        }
      }
    }
    const inFilter = (m) => { if (!state.filter) return true; const p = posOf(m); return p.s === state.filter.s && p.o === state.filter.o; };
    // Lowest rank drawn last (on top).
    for (const m of [...f.modes].reverse()) {
      const p = now.get(m.row), k = state.after && m.after ? 'a' : (state.after ? 'a' : 'b');
      const sc = state.after && m.after ? m.after : m;
      const act = (state.after && m.after ? m.after.why : m.why).length > 0;
      const g = sv('g', {
        class: `fm-dot${act ? ' act' : ''}${m.row === state.sel ? ' is-sel' : ''}${inFilter(m) ? '' : ' dim'}${state.drag?.row === m.row ? ' dragging' : ''}`,
        transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: 'button', 'data-row': m.row, 'data-k': k,
        'aria-label': `Rank ${m.rank}, ${m.mode}: S ${sc.s}, O ${sc.o}${f.method === 'rpn' ? `, D ${sc.d}` : ''}, ${scoreName()} ${sc.score}${act ? ', needs action' : ''}. Arrow keys move it, plus and minus change detection, Enter edits.`,
      });
      g.append(sv('circle', { r: p.r + 9, class: 'sel' }));
      if (m.act && !m.action && !(state.after && m.after)) g.append(sv('circle', { r: p.r + 6.5, class: 'open' }));
      if (f.method === 'rpn') {
        const rr = p.r + 2.8, circ = 2 * Math.PI * rr;
        g.append(sv('circle', { r: rr, class: 'dtrack' }),
          sv('circle', { r: rr, class: 'darc', transform: 'rotate(-90)', 'stroke-dasharray': `${(circ * sc.d) / 10} ${circ}` }));
      }
      g.append(sv('circle', { r: p.r, class: 'core' }));
      if (p.r >= 8) g.append(sv('text', { y: 4, class: 'num', 'text-anchor': 'middle' }, m.rank));
      gDots.append(g);
    }
  }

  // Pointer: drag a dot to re-score, click a dot to select, click a cell to filter.
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const dot = e.target.closest('.fm-dot'), cell = e.target.closest('.fm-cell');
    if (!dot && !cell) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (dot) {
      const row = +dot.dataset.row; const m = byRow(row);
      const p = m ? posOf(m, dot.dataset.k === 'a') : null;
      state.drag = { row, k: dot.dataset.k, x0: e.clientX, y0: e.clientY, moved: false, s: p?.s, o: p?.o };
      dot.focus({ preventScroll: true });
    } else state.press = { s: +cell.dataset.s, o: +cell.dataset.o, x0: e.clientX, y0: e.clientY };
  });
  svg.addEventListener('pointermove', (e) => {
    const d = state.drag;
    if (!d) {
      const g = e.target.closest?.('.fm-dot');
      if (g && state.tipFor !== g.dataset.row + g.dataset.k) showTip(g); else if (!g && state.tipFor) hideTip();
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    d.moved = true;
    const c = pointCell(e);
    for (const r of gCells.querySelectorAll('.drop')) r.classList.remove('drop');
    gCells.querySelector(`.fm-cell[data-s="${c.s}"][data-o="${c.o}"]`)?.classList.add('drop');
    if (c.s !== d.s || c.o !== d.o) { d.s = c.s; d.o = c.o; moveTo(d.row, d.k, c.s, c.o); }
  });
  const endPress = (e) => {
    const d = state.drag, p = state.press;
    state.drag = null; state.press = null;
    try { svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d) {
      if (!d.moved) select(d.row); else render(ctx.result);
      const g = gDots.querySelector(`.fm-dot[data-row="${d.row}"]`); g?.focus({ preventScroll: true });
      if (g) showTip(g);
    } else if (p && e.type === 'pointerup' && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) {
      state.filter = state.filter && state.filter.s === p.s && state.filter.o === p.o ? null : { s: p.s, o: p.o };
      render(ctx.result);
    }
  };
  svg.addEventListener('pointerup', endPress);
  svg.addEventListener('pointercancel', endPress);
  svg.addEventListener('pointerleave', () => { if (!state.drag) hideTip(); });
  svg.addEventListener('focusin', (e) => { const g = e.target.closest('.fm-dot'); if (g) showTip(g); });
  svg.addEventListener('focusout', () => { if (!state.drag) hideTip(); });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.fm-dot'); if (!g) return;
    const row = +g.dataset.row, k = g.dataset.k, m = byRow(row); if (!m) return;
    const sc = k === 'a' && m.after ? m.after : m;
    let { s, o, d } = sc; let used = true, dChanged = false;
    if (e.key === 'ArrowUp') s++; else if (e.key === 'ArrowDown') s--;
    else if (e.key === 'ArrowRight') o++; else if (e.key === 'ArrowLeft') o--;
    else if ((e.key === '+' || e.key === '=') && useD()) { d++; dChanged = true; } else if (e.key === '-' && useD()) { d--; dChanged = true; }
    else if (e.key === 'Enter' || e.key === ' ') { select(row, true); e.preventDefault(); return; }
    else if (e.key === 'Escape') { state.filter = null; render(ctx.result); return; }
    else used = false;
    if (!used) return;
    e.preventDefault();
    state.refocus = { row, k };
    moveTo(row, k, clamp(s, 1, 10), clamp(o, 1, 10), dChanged ? clamp(d, 1, 10) : null);
  });

  // ---------- stats, list ----------
  function drawStats(res) {
    stats.replaceChildren(...(res.values || []).map((v) => h('div', { class: `fm-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || null },
      h('span', {}, v.label), h('b', {}, String(v.value)))));
    stats.hidden = !(res.values || []).length;
  }

  function drawList(f) {
    const addBtn = h('button', { class: 'k-btn', onclick: addMode }, '+ Add mode');
    listHead.replaceChildren(...[h('h2', {}, 'Risk order'), h('span', { class: 'fm-sub' }, f ? `by ${f.method === 'rpn' ? 'RPN = S×O×D' : 'S×O'}` : ''),
      state.filter ? h('span', { class: 'fm-chip' }, `S ${state.filter.s} · O ${state.filter.o}`,
        h('button', { 'aria-label': 'Clear the cell filter', title: 'Show all', onclick: () => { state.filter = null; render(ctx.result); } }, '×')) : null,
      h('span', { class: 'fm-grow' }), addBtn].filter(Boolean));
    list.replaceChildren();
    if (!f || !f.modes.length) { list.append(h('div', { class: 'fm-empty' }, 'No scored failure modes yet.')); return; }
    const top = Math.max(f.limit, ...f.modes.map((m) => m.score), ...f.modes.map((m) => m.after?.score || 0)) * 1.08;
    const w = (v) => `${(100 * v) / top}%`;
    const shown = f.modes.filter((m) => { if (!state.filter) return true; const p = posOf(m); return p.s === state.filter.s && p.o === state.filter.o; });
    if (!shown.length) list.append(h('div', { class: 'fm-empty' }, `No failure mode in S ${state.filter.s}, O ${state.filter.o}. Drag a dot here to score it so.`));
    for (const m of shown) {
      const aft = state.after && m.after;
      const act = (aft ? m.after.why : m.why).length > 0;
      const bar = h('div', { class: 'fm-bar', title: `${scoreName()} ${m.score}${m.after ? ` → ${m.after.score}` : ''}; threshold ${f.limit}` });
      if (aft) bar.append(h('i', { class: 'was', style: `width:${w(m.score)}` }), h('i', { class: `aft${act ? ' act' : ''}`, style: `width:${w(m.after.score)}` }));
      else bar.append(h('i', { class: 'b', style: `width:${w(m.score)}` }));
      bar.append(h('span', { class: 't', style: `left:${w(f.limit)}` }));
      const sc = aft ? m.after : m;
      const why = aft ? m.after.why : m.why;
      const card = h('div', { class: `fm-card${m.act ? ' act' : ''}${m.row === state.sel ? ' is-sel' : ''}`, tabindex: 0, role: 'button',
        'aria-pressed': String(m.row === state.sel), 'data-row': m.row,
        onclick: () => select(m.row), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(m.row, true); } } },
      h('div', { class: 'fm-c1' }, h('span', { class: 'fm-rank' }, `#${m.rank}`),
        h('span', { class: 'fm-name', title: `${m.item}: ${m.mode}` }, m.mode, ' ', h('small', {}, m.item)),
        h('span', { class: 'fm-score' }, aft ? h('small', {}, `${m.score} → `) : null, sc.score)),
      bar,
      h('div', { class: 'fm-c3' },
        h('span', { class: 'm' }, `S${sc.s} O${sc.o}${f.method === 'rpn' ? ` D${sc.d}` : ''}`),
        h('span', {}, `${pct(m.share)} %`),
        why.length ? h('span', { class: 'fm-tag bad' }, `act: ${why.join(', ')}`) : h('span', { class: `fm-tag ${aft && m.act ? 'ok' : 'ok'}` }, aft && m.act ? 'cleared' : 'below threshold')),
      m.action ? h('div', { class: 'fm-act', title: m.action }, `→ ${m.action}`)
        : m.act ? h('div', { class: 'fm-act open' }, 'OPEN: no action planned') : null);
      list.append(card);
      if (!state.filter && m.rank === f.vital && f.vital < f.modes.length) {
        list.append(h('div', { class: 'fm-pareto', title: 'Pareto: the modes above hold 80 % of the total score' }, `80 % of the risk is in these ${f.vital} of ${f.modes.length}`));
      }
    }
  }

  // ---------- editor ----------
  const edFields = {};
  function stepper(key, label, after) {
    const inp = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': label, spellcheck: 'false' });
    const words = h('div', { class: 'w' });
    const base = { rs: 's', ro: 'o', rd: 'd' }[key];
    const cur = () => {
      const r = rowsNow()[state.sel - 1] || {};
      const v = String(r[key] ?? '').trim();
      return v === '' && base ? +r[base] : +v;
    };
    const bump = (n) => { const v = cur(); setField(key, String(clamp(Number.isFinite(v) ? v + n : 5, 1, 10))); };
    inp.addEventListener('input', () => setField(key, inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); } if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); } });
    const box = h('div', { class: `fm-step${after ? ' after' : ''}` },
      h('div', { class: 'k' }, h('span', {}, label)),
      h('div', { class: 'row' }, h('button', { type: 'button', 'aria-label': `${label} down`, onclick: () => bump(-1) }, '−'), inp,
        h('button', { type: 'button', 'aria-label': `${label} up`, onclick: () => bump(1) }, '+')),
      h('div', { class: 'w' }, words));
    edFields[key] = { inp, words, box, base };
    return box;
  }
  function setField(key, value) {
    const rows = rowsNow(); const r = rows[state.sel - 1]; if (!r) return;
    r[key] = value; setRows(rows);
  }
  function textField(key, label, area) {
    const inp = area ? h('textarea', { rows: 2, spellcheck: 'true' }) : h('input', { type: 'text', spellcheck: 'false' });
    inp.addEventListener('input', () => setField(key, inp.value));
    edFields[key] = { inp };
    return h('label', {}, label, inp);
  }
  const edSum = h('div', { class: 'fm-sum', 'aria-live': 'polite' });
  const edAfterSum = h('div', { class: 'fm-sum' });
  function buildEditor() {
    const rows = rowsNow();
    for (const k of Object.keys(edFields)) delete edFields[k];
    state.edRow = state.sel;
    if (!rows[state.sel - 1]) {
      edHead.replaceChildren(h('h2', {}, 'Failure mode'));
      ed.replaceChildren(h('div', { class: 'fm-empty' }, 'Click a dot or a card to edit it, or add a mode.'), h('div', {}, h('button', { class: 'k-btn', onclick: addMode }, '+ Add mode')));
      return;
    }
    edHead.replaceChildren(h('h2', { id: 'fm-edt' }, 'Failure mode'), h('span', { class: 'fm-sub', id: 'fm-edsub' }), h('span', { class: 'fm-grow' }),
      h('button', { class: 'k-btn fm-danger', onclick: delMode, title: 'Delete this failure mode' }, 'Delete'));
    ed.replaceChildren(
      h('div', { class: 'two' }, textField('item', 'Item / function'), textField('mode', 'Failure mode')),
      textField('effect', 'Effect'), textField('cause', 'Cause'),
      h('div', { class: 'fm-sc' }, stepper('s', 'Severity S'), stepper('o', 'Occurrence O'), stepper('d', 'Detection D')),
      edSum,
      textField('action', 'Planned action', true),
      h('div', { class: 'fm-sec' }, 'After the action (blank = unchanged)'),
      h('div', { class: 'fm-sc' }, stepper('rs', 'S after', true), stepper('ro', 'O after', true), stepper('rd', 'D after', true)),
      edAfterSum);
    syncEditor();
  }
  function syncEditor() {
    const r = rowsNow()[state.sel - 1]; if (!r) return;
    const f = fm(); const m = byRow(state.sel); const rpn = useD();
    for (const [k, fd] of Object.entries(edFields)) {
      if (document.activeElement !== fd.inp) fd.inp.value = r[k] ?? '';
      if (fd.base) fd.inp.placeholder = String(r[fd.base] ?? '');
      if (fd.words) {
        const v = +(String(r[k] ?? '').trim() || (fd.base ? r[fd.base] : ''));
        const w = WORDS[fd.base || k];
        fd.words.textContent = Number.isInteger(v) && v >= 1 && v <= 10 ? w[v - 1] : 'Whole number 1-10';
        const bad = String(r[k] ?? '').trim() !== '' && !(Number.isInteger(v) && v >= 1 && v <= 10);
        fd.inp.classList.toggle('fm-bad', bad);
        fd.inp.style.color = bad ? 'var(--danger)' : '';
      }
      if ((k === 'd' || k === 'rd') && fd.box) { fd.box.style.opacity = rpn ? '' : '.45'; fd.inp.disabled = !rpn; }
    }
    const sub = document.getElementById('fm-edsub');
    if (sub) sub.textContent = m ? `#${m.rank} of ${f.modes.length} · row ${m.row}` : `row ${state.sel}, not scored`;
    if (!m) { edSum.replaceChildren(h('span', { class: 'bad' }, 'Not scored: S, O' + (rpn ? ' and D' : '') + ' must be whole numbers 1-10.')); edAfterSum.hidden = true; return; }
    edSum.replaceChildren(h('span', {}, `${f.method === 'rpn' ? `${m.s} × ${m.o} × ${m.d}` : `${m.s} × ${m.o}`} =`), h('span', { class: 'm' }, `${scoreName()} ${m.score}`),
      h('span', {}, `${pct(m.share)} % of the risk`),
      m.why.length ? h('span', { class: 'bad' }, `needs action (${m.why.join(', ')})`) : h('span', { class: 'ok' }, 'below the thresholds'));
    edAfterSum.hidden = false;
    edAfterSum.replaceChildren(...(m.after
      ? [h('span', {}, 'After:'), h('span', { class: 'm' }, `${scoreName()} ${m.after.score}`), h('span', {}, `from ${m.score}`),
        m.after.why.length ? h('span', { class: 'warn' }, `still ${m.after.why.join(', ')}`) : h('span', { class: 'ok' }, 'below the thresholds')]
      : [h('span', { class: 'soft' }, 'Not re-scored. Fill the after scores, or drag the dot in the "After action" view.')]));
  }
  function addMode() {
    const rows = rowsNow(); rows.push({ ...BLANK, mode: 'New failure mode' });
    state.sel = rows.length; state.filter = null; state.edRow = undefined; setRows(rows);
    const m = edFields.mode?.inp; if (m) { m.focus(); m.select(); }
  }
  function delMode() {
    const rows = rowsNow(); if (!rows[state.sel - 1]) return;
    rows.splice(state.sel - 1, 1); state.sel = null; state.edRow = undefined; setRows(rows);
  }

  // ---------- header controls ----------
  function drawControls(f) {
    const method = ctx.raw.method || 'rpn';
    methodSeg.replaceChildren(...[['rpn', 'RPN S×O×D'], ['so', 'S×O']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(method === v), onclick: () => ctx.set('method', v) }, t)));
    const has = !!f?.modes.some((m) => m.after);
    viewSeg.replaceChildren(...[[false, 'Before'], [true, 'After action']].map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(state.after === v), title: v && !has ? 'No revised scores yet: drag a dot in this view to re-score it' : null,
        onclick: () => { state.after = v; state.filter = null; render(ctx.result); } }, t)));
    thrLbl.textContent = method === 'so' ? 'Act at S×O ≥' : 'Act at RPN ≥';
    const tk = method === 'so' ? 'soMin' : 'rpnMin';
    if (document.activeElement !== thrIn) thrIn.value = ctx.raw[tk] ?? '';
    if (document.activeElement !== sevIn) sevIn.value = ctx.raw.sevMin ?? '';
    thrIn.classList.toggle('fm-bad', !(ctx.input[tk] > 0));
    sevIn.classList.toggle('fm-bad', !(ctx.input.sevMin > 0));
    const rpn = method === 'rpn';
    const dot = (cls, fill) => `<svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">${cls}<circle r="5.5" fill="${fill}" stroke="var(--surface)"/></svg>`;
    legend.innerHTML = `<span>S×O <span class="fm-ramp"><i style="background:var(--tool-h0)"></i><i style="background:var(--tool-h1)"></i><i style="background:var(--tool-h2)"></i><i style="background:var(--tool-h3)"></i><i style="background:var(--tool-h4)"></i></span> 100</span>`
      + `<span>${dot('', 'var(--danger)')}needs action</span><span>${dot('', 'var(--tool-dot)')}below thresholds</span>`
      + (rpn ? `<span><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><circle r="6.5" fill="none" stroke="var(--line)" stroke-width="2.5"/><circle r="6.5" fill="none" stroke="var(--tool-det)" stroke-width="2.5" stroke-dasharray="28.6 41" transform="rotate(-90)"/></svg>ring = detection D (full = cannot detect)</span>` : '')
      + `<span>${dot('<circle r="8" fill="none" stroke="var(--danger)" stroke-dasharray="3 2.5"/>', 'var(--danger)')}no action planned</span>`
      + (state.after ? `<span><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><circle r="5.5" fill="var(--surface)" stroke="var(--tool-ghost)" stroke-dasharray="3 2"/></svg>before the action</span>` : '')
      + `<span style="flex-basis:100%">Drag a dot to re-score it${state.after ? ' after its action' : ''} · click a dot to edit, a cell to filter · focused dot: arrows move it${rpn ? ', + / − detection' : ''}, Enter edits, Esc clears the filter</span>`;
  }

  function drawMsgs(res) {
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
  }

  // ---------- render ----------
  function render(res) {
    if (!res) return;
    const f = res.fmea || null;
    const rows = ctx.raw.modes || [];
    if (!rows[state.sel - 1]) state.sel = f?.modes[0]?.row ?? (rows.length ? 1 : null);
    const act = document.activeElement;
    const refocus = state.refocus || (act?.closest?.('.fm-dot') ? { row: +act.dataset.row, k: act.dataset.k } : null)
      || (act?.classList?.contains('fm-card') ? { card: +act.dataset.row } : null);
    state.refocus = null;
    drawControls(f);
    drawStats(res);
    drawMatrix(f);
    drawList(f);
    if (state.edRow !== state.sel) buildEditor(); else syncEditor();
    drawMsgs(res);
    if (refocus?.row) {
      const g = gDots.querySelector(`.fm-dot[data-row="${refocus.row}"]`);
      if (g) { g.focus({ preventScroll: true }); showTip(g); }
    } else if (refocus?.card) list.querySelector(`.fm-card[data-row="${refocus.card}"]`)?.focus({ preventScroll: true });
    else if (state.tipFor) { const g = gDots.querySelector(`.fm-dot[data-row="${parseInt(state.tipFor, 10)}"]`); if (g) showTip(g); else hideTip(); }
  }
  // Below ~500 px the matrix is drawn at half size: larger text, shorter labels.
  new ResizeObserver(() => {
    const c = stage.clientWidth < 500;
    if (c !== !!state.compact) { state.compact = c; svg.classList.toggle('compact', c); render(ctx.result); }
  }).observe(stage);
  ctx.onResult((res) => render(res));
}
