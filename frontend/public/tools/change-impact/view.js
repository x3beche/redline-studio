// Change Impact Estimator page: the project's dependency graph, one lane per
// room, each part placed by how deep it sits in the chain (what it depends on
// is to its left). Click a part to say "this changes": the impact runs out
// to the right along the links - every part it reaches is lit by its hop
// count with its weight, the links the change travels are drawn heavy, and
// each lane says how much of the room is touched. Shift-click adds a second
// changed part. Hover a lit part to see the path that reaches it. Drag from a
// part's right-hand port onto another part to make that one depend on it;
// the selected part's links are listed below with a remove button each.
// "Stop at" cuts the reach at N hops. Keyboard: Tab to a part, Enter makes
// it the change, Space adds / removes it, arrows move between parts.
// Every hop, weight, count, path and level shown comes from run()'s
// result.graph and result.values.

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
const ROOMS = ['pcb', 'embedded', 'cad', 'mobile', 'web', 'analyze'];
const ROOM_NAME = { pcb: 'PCB', embedded: 'Embedded', cad: '3D / CAD', mobile: 'Mobile', web: 'Web', analyze: 'Analyze' };
const split = (s) => String(s ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
const LANEW = 136, COLW = 206, NW = 168, NH = 40, ROWH = 52, LPAD = 12, TOP = 26;

export function page(root, ctx) {
  const F = (v, d = 3) => ctx.fmtNum(v, d);
  const state = { sel: null, hover: null, link: null, refocus: null };
  const G = () => ctx.result?.graph || null;
  const rowsNow = () => structuredClone(ctx.raw.items || []);
  const setRows = (rows, extra) => (extra ? ctx.setMany({ items: rows, ...extra }) : ctx.set('items', rows));
  const changedList = () => split(ctx.raw.changed);
  const lc = (s) => String(s).toLowerCase();

  // ---------- skeleton ----------
  const stats = h('div', { class: 'ci-stats', 'aria-live': 'polite' });
  const chips = h('div', { class: 'ci-chips' });
  const hopSeg = h('div', { class: 'ci-seg', role: 'group', 'aria-label': 'Stop at hops' });
  const svg = sv('svg', { class: 'ci-svg', role: 'group', 'aria-label': 'Dependency graph by room' });
  const defs = sv('defs');
  defs.innerHTML = '<marker id="ci-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--line)"/></marker>'
    + '<marker id="ci-ahh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--tool-hot)"/></marker>'
    + '<marker id="ci-ahp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--accent)"/></marker>';
  const gLanes = sv('g'), gEdges = sv('g'), gNodes = sv('g'), gTmp = sv('g');
  svg.append(defs, gLanes, gEdges, gNodes, gTmp);
  const tip = h('div', { class: 'ci-tip', role: 'status' });
  const stage = h('div', { class: 'ci-stage' }, svg, tip);
  const legend = h('div', { class: 'ci-legend' });
  legend.innerHTML = '<span><i class="sw chg"></i>changed</span><span><i class="sw h1"></i>1 hop (w = weight 1)</span><span><i class="sw h2"></i>2 hops (0.5)</span><span><i class="sw h3"></i>3+ hops</span><span><i class="sw off"></i>not reached</span><span><i class="ln"></i>link the change travels</span>'
    + '<span class="ci-keys">Click a part: it is the change · Shift-click: add another · drag from the ● on a part\'s right onto another: that one depends on it · focused part: Enter sets, Space adds, arrows move</span>';
  const graphP = h('section', { class: 'ci-panel' },
    h('div', { class: 'ci-head' }, h('h2', {}, 'Dependencies by room'), h('span', { class: 'ci-sub' }, 'what a part depends on is to its left'),
      h('span', { class: 'ci-grow' }), chips, h('span', { class: 'ci-lbl' }, 'Stop at'), hopSeg),
    stage, legend);
  const insp = h('section', { class: 'ci-panel ci-insp' });
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const all = h('details', { class: 'ci-panel ci-all' }, h('summary', {}, 'All parts as a table'), ctx.form);
  root.append(h('div', { class: 'ci' }, stats, graphP,
    h('div', { class: 'ci-bottom' }, h('div', { class: 'ci-col' }, insp, warns, notes, all), ctx.outputs)));

  // ---------- actions ----------
  const setChanged = (names) => ctx.set('changed', names.join(', '));
  const makeOnly = (name) => { state.sel = name; state.refocus = name; setChanged([name]); };
  const toggleChanged = (name) => {
    const cur = changedList(); const i = cur.findIndex((c) => lc(c) === lc(name));
    if (i >= 0) cur.splice(i, 1); else cur.push(name);
    state.sel = name; state.refocus = name; setChanged(cur);
  };
  const addDep = (from, to) => { // `to` depends on `from`
    if (lc(from) === lc(to)) return;
    const rows = rowsNow(); const r = rows.find((x) => lc(String(x.name).trim()) === lc(to)); if (!r) return;
    const d = split(r.deps); if (d.some((x) => lc(x) === lc(from))) return;
    d.push(from); r.deps = d.join(', '); state.sel = to; setRows(rows);
  };
  const removeDep = (from, to) => {
    const rows = rowsNow(); const r = rows.find((x) => lc(String(x.name).trim()) === lc(to)); if (!r) return;
    r.deps = split(r.deps).filter((x) => lc(x) !== lc(from)).join(', '); setRows(rows);
  };

  // ---------- layout ----------
  let pos = new Map(); // name -> {x, y}
  function layout(g) {
    const byName = new Map(g.nodes.map((n) => [n.name, n]));
    const depth = new Map(), onStack = new Set();
    const dOf = (n) => {
      if (depth.has(n)) return depth.get(n);
      if (onStack.has(n)) return 0;
      onStack.add(n);
      const d = Math.max(-1, ...(byName.get(n)?.deps || []).map(dOf)) + 1;
      onStack.delete(n); depth.set(n, d); return d;
    };
    for (const n of g.nodes) dOf(n.name);
    const lanes = ROOMS.filter((r) => g.nodes.some((n) => n.room === r));
    const maxD = Math.max(0, ...depth.values());
    pos = new Map();
    let y = TOP;
    const laneBox = [];
    for (const room of lanes) {
      const cols = new Map();
      for (const n of g.nodes.filter((x) => x.room === room)) {
        const d = depth.get(n.name); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n.name);
      }
      const rows = Math.max(1, ...[...cols.values()].map((c) => c.length));
      const hh = rows * ROWH + LPAD * 2 - (ROWH - NH);
      for (const [d, names] of cols) names.forEach((nm, k) => pos.set(nm, { x: LANEW + 16 + d * COLW, y: y + LPAD + k * ROWH }));
      laneBox.push({ room, y, h: hh });
      y += hh + 6;
    }
    return { lanes: laneBox, W: LANEW + 16 + (maxD + 1) * COLW - (COLW - NW) + 24, H: y + 4 };
  }

  // ---------- drawing ----------
  const pathOf = (g, name) => {
    const by = new Map(g.nodes.map((n) => [n.name, n])); const p = [name];
    while (by.get(p[0])?.via && p.length < 99) p.unshift(by.get(p[0]).via);
    return p;
  };
  const cls = (n) => (n.changed ? 'chg' : n.hops == null ? 'off' : n.hops === 1 ? 'h1' : n.hops === 2 ? 'h2' : 'h3');
  const short = (s, n = 21) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function draw() {
    const g = G();
    gLanes.replaceChildren(); gEdges.replaceChildren(); gNodes.replaceChildren(); gTmp.replaceChildren();
    if (!g || !g.nodes.length) {
      svg.setAttribute('viewBox', '0 0 800 120');
      svg.append(gTmp);
      gTmp.append(sv('text', { x: 20, y: 60, class: 'ci-lt soft' }, 'No parts yet: add one below.'));
      return;
    }
    const L = layout(g);
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    svg.style.minWidth = `${Math.round(L.W * 0.72)}px`;
    const roomRow = new Map((g.rooms || []).map((r) => [r.room, r]));
    // column guides
    const maxX = L.W - 24;
    for (let x = LANEW + 16, d = 0; x < maxX; x += COLW, d++) {
      gLanes.append(sv('text', { x: x + NW / 2, y: 16, class: 'ci-col', 'text-anchor': 'middle' }, d === 0 ? 'depends on nothing' : `${d} step${d > 1 ? 's' : ''} down the chain`));
    }
    for (const ln of L.lanes) {
      const rr = roomRow.get(ln.room);
      const touched = rr && (rr.n || rr.changed);
      gLanes.append(sv('rect', { x: 0, y: ln.y, width: L.W, height: ln.h, rx: 6, class: `ci-lane${touched ? ' hit' : ''}` }));
      gLanes.append(sv('text', { x: 12, y: ln.y + 20, class: 'ci-lt b' }, ROOM_NAME[ln.room] || ln.room));
      if (rr) {
        const parts = [];
        if (rr.changed) parts.push(`${rr.changed} changed`);
        if (rr.n) parts.push(`${rr.n} affected`);
        gLanes.append(sv('text', { x: 12, y: ln.y + 36, class: 'ci-lt hot' }, parts.join(' · ')));
        if (rr.n) {
          gLanes.append(sv('text', { x: 12, y: ln.y + 51, class: 'ci-lt soft' }, `weight ${F(rr.w)} · nearest ${rr.nearest}`));
          const bw = Math.min(LANEW - 24, rr.w * 40);
          gLanes.append(sv('rect', { x: 12, y: ln.y + 57, width: LANEW - 24, height: 4, rx: 2, class: 'ci-wtrack' }),
            sv('rect', { x: 12, y: ln.y + 57, width: bw, height: 4, rx: 2, class: 'ci-wbar' }));
        }
      } else gLanes.append(sv('text', { x: 12, y: ln.y + 36, class: 'ci-lt soft' }, 'untouched'));
    }
    // edges
    const by = new Map(g.nodes.map((n) => [n.name, n]));
    const hovPath = state.hover ? pathOf(g, state.hover) : [];
    const onPath = (a, b) => { const i = hovPath.indexOf(a); return i >= 0 && hovPath[i + 1] === b; };
    const cyc = new Set(g.cycles.flat());
    for (const n of g.nodes) for (const d of n.deps) {
      const a = pos.get(d), b = pos.get(n.name); if (!a || !b) continue;
      const dn = by.get(d);
      const hot = n.hops != null && dn.hops != null && n.hops === dn.hops + 1;
      const pth = onPath(d, n.name);
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x - 2, y2 = b.y + NH / 2;
      let dd;
      if (x2 > x1 + 10) { const k = Math.max(40, (x2 - x1) * 0.45); dd = `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`; } else {
        const top = Math.min(a.y, b.y) - 16; dd = `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${top} ${(x1 + x2) / 2},${top} S${x2 - 60},${y2} ${x2},${y2}`;
      }
      const e = sv('path', { d: dd, class: `ci-edge${hot ? ' hot' : ''}${pth ? ' pth' : ''}${cyc.has(d) && cyc.has(n.name) ? ' cyc' : ''}${state.sel === n.name || state.sel === d ? ' sel' : ''}`,
        'data-from': d, 'data-to': n.name, 'marker-end': pth ? 'url(#ci-ahp)' : hot ? 'url(#ci-ahh)' : 'url(#ci-ah)' });
      e.append(sv('title', {}, `${n.name} depends on ${d}. Click to select ${n.name}.`));
      gEdges.append(sv('path', { d: dd, class: 'ci-ehit', 'data-from': d, 'data-to': n.name }), e);
    }
    // nodes
    for (const n of g.nodes) {
      const p = pos.get(n.name); if (!p) continue;
      const c = cls(n);
      const nd = sv('g', { class: `ci-node ${c}${state.sel === n.name ? ' is-sel' : ''}${hovPath.includes(n.name) ? ' pth' : ''}`, transform: `translate(${p.x} ${p.y})`,
        tabindex: 0, role: 'button', 'data-name': n.name, 'aria-pressed': String(n.changed),
        'aria-label': `${n.name}, ${ROOM_NAME[n.room]}: ${n.changed ? 'changed' : n.hops == null ? 'not reached' : `${n.hops} hop${n.hops > 1 ? 's' : ''}, weight ${F(n.weight)}`}. Enter: this is the change. Space: add or remove.` });
      nd.append(sv('rect', { x: -4, y: -4, width: NW + 8, height: NH + 8, rx: 9, class: 'ring' }),
        sv('rect', { width: NW, height: NH, rx: 6, class: 'box' }),
        sv('text', { x: 10, y: 16, class: 'nm' }, short(n.name)),
        sv('text', { x: 10, y: 31, class: 'meta' }, n.changed ? 'changed' : n.hops == null ? (g.start.length ? 'not reached' : 'click: this changes') : `${n.hops} hop${n.hops > 1 ? 's' : ''} · w ${F(n.weight)}`));
      if (n.hops != null && !n.changed) nd.append(sv('circle', { cx: NW - 16, cy: NH / 2, r: 10, class: 'badge' }), sv('text', { x: NW - 16, y: NH / 2 + 4, class: 'bn', 'text-anchor': 'middle' }, n.hops));
      nd.append(sv('circle', { cx: NW, cy: NH / 2, r: 6, class: 'port', 'data-port': n.name }));
      nd.append(sv('title', {}, `${n.name} (${ROOM_NAME[n.room]})${n.deps.length ? `\ndepends on: ${n.deps.join(', ')}` : ''}\nDrag the ● onto another part to make it depend on this one.`));
      gNodes.append(nd);
    }
  }

  // ---------- tooltip ----------
  function showTip(name) {
    const g = G(); const n = g?.nodes.find((x) => x.name === name); const p = pos.get(name);
    if (!n || !p) { tip.style.display = 'none'; return; }
    const path = n.hops != null && !n.changed ? pathOf(g, name) : null;
    tip.replaceChildren(h('b', {}, n.name), h('div', { class: 'soft' }, ROOM_NAME[n.room]),
      n.changed ? h('div', {}, 'Changed') : path ? h('div', {}, `${n.hops} hop${n.hops > 1 ? 's' : ''}, weight ${F(n.weight)}`) : h('div', { class: 'soft' }, g.start.length ? 'Not reached by the change' : 'Click to make this the change'),
      path ? h('div', { class: 'm' }, path.join(' → ')) : null,
      n.deps.length ? h('div', { class: 'soft' }, `Depends on ${n.deps.join(', ')}`) : null);
    tip.style.display = 'block';
    const sr = stage.getBoundingClientRect(), nb = gNodes.querySelector(`.ci-node[data-name="${CSS.escape(name)}"]`)?.getBoundingClientRect();
    if (!nb) return;
    let x = nb.left - sr.left + stage.scrollLeft, y = nb.bottom - sr.top + 6;
    if (x + tip.offsetWidth > stage.scrollWidth - 4) x = stage.scrollWidth - tip.offsetWidth - 4;
    if (y + tip.offsetHeight > stage.clientHeight) y = nb.top - sr.top - tip.offsetHeight - 6;
    tip.style.left = `${Math.max(4, x)}px`; tip.style.top = `${Math.max(4, y)}px`;
  }
  const hideTip = () => { tip.style.display = 'none'; };

  // ---------- pointer ----------
  const svgPt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  const nodeAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el?.closest?.('.ci-node')?.dataset.name || null;
  };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const port = e.target.closest?.('[data-port]');
    const node = e.target.closest?.('.ci-node');
    const edge = e.target.closest?.('[data-to]');
    if (port) {
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      const p = pos.get(port.dataset.port);
      state.link = { from: port.dataset.port, x0: p.x + NW, y0: p.y + NH / 2 };
      return;
    }
    if (node) state.press = { name: node.dataset.name, x: e.clientX, y: e.clientY, shift: e.shiftKey || e.metaKey || e.ctrlKey };
    else if (edge) { state.sel = edge.dataset.to; render(); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (state.link) {
      const q = svgPt(e); const over = nodeAt(e);
      gTmp.replaceChildren(sv('path', { d: `M${state.link.x0},${state.link.y0} L${q.x},${q.y}`, class: 'ci-tmp' }));
      for (const el of gNodes.querySelectorAll('.drop')) el.classList.remove('drop');
      if (over && over !== state.link.from) gNodes.querySelector(`.ci-node[data-name="${CSS.escape(over)}"]`)?.classList.add('drop');
      return;
    }
    const nm = e.target.closest?.('.ci-node')?.dataset.name || null;
    if (nm !== state.hover) { state.hover = nm; draw(); if (nm) showTip(nm); else hideTip(); }
  });
  svg.addEventListener('pointerup', (e) => {
    if (state.link) {
      const over = nodeAt(e); const from = state.link.from; state.link = null; gTmp.replaceChildren();
      try { svg.releasePointerCapture(e.pointerId); } catch { /* released */ }
      if (over && over !== from) addDep(from, over); else draw();
      return;
    }
    const p = state.press; state.press = null;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) { if (p.shift) toggleChanged(p.name); else makeOnly(p.name); }
  });
  svg.addEventListener('pointerleave', () => { if (!state.link && state.hover) { state.hover = null; draw(); hideTip(); } });
  svg.addEventListener('focusin', (e) => {
    const n = e.target.closest?.('.ci-node'); if (!n) return;
    showTip(n.dataset.name);
    if (state.sel !== n.dataset.name) { state.sel = n.dataset.name; drawInspector(); for (const el of gNodes.querySelectorAll('.ci-node')) el.classList.toggle('is-sel', el.dataset.name === state.sel); }
  });
  svg.addEventListener('focusout', () => hideTip());
  svg.addEventListener('keydown', (e) => {
    const n = e.target.closest?.('.ci-node'); if (!n) return;
    const name = n.dataset.name;
    if (e.key === 'Enter') { e.preventDefault(); makeOnly(name); return; }
    if (e.key === ' ') { e.preventDefault(); toggleChanged(name); return; }
    const names = [...gNodes.querySelectorAll('.ci-node')].map((x) => x.dataset.name);
    const p = pos.get(name); let best = null, bd = Infinity;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    for (const m of names) {
      if (m === name) continue; const q = pos.get(m);
      const dx = q.x - p.x, dy = q.y - p.y;
      const along = dx * dir[0] + dy * dir[1]; if (along <= 0) continue;
      const d = along + 2.5 * Math.abs(dx * dir[1] + dy * dir[0]);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) gNodes.querySelector(`.ci-node[data-name="${CSS.escape(best)}"]`)?.focus();
  });

  // ---------- inspector ----------
  function drawInspector() {
    const g = G();
    const rows = ctx.raw.items || [];
    const idx = rows.findIndex((r) => lc(String(r.name ?? '').trim()) === lc(state.sel ?? ''));
    const n = g?.nodes.find((x) => x.name === state.sel);
    const addBtn = h('button', { class: 'k-btn', onclick: addItem }, '+ Add part');
    if (idx < 0) {
      insp.replaceChildren(h('div', { class: 'ci-head' }, h('h2', {}, 'Part'), h('span', { class: 'ci-grow' }), addBtn),
        h('div', { class: 'ci-empty' }, 'Click a part in the graph to edit it.'));
      return;
    }
    const r = rows[idx];
    const nameIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Part name', value: r.name ?? '' });
    nameIn.addEventListener('change', () => rename(r.name, nameIn.value));
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); });
    const roomSel = h('select', { 'aria-label': 'Room', onchange: (e) => { const rs = rowsNow(); rs[idx].room = e.target.value; setRows(rs); } },
      ROOMS.map((ro) => h('option', { value: ro, selected: ro === r.room }, ROOM_NAME[ro])));
    const deps = n ? n.deps : split(r.deps);
    const others = (g?.nodes || []).map((x) => x.name).filter((x) => x !== n?.name && !deps.includes(x));
    const addSel = h('select', { 'aria-label': 'Add a dependency', onchange: (e) => { if (e.target.value) addDep(e.target.value, n?.name || r.name); } },
      h('option', { value: '' }, '+ depends on…'), others.map((o) => h('option', { value: o }, o)));
    const users = (g?.nodes || []).filter((x) => n && x.deps.includes(n.name)).map((x) => x.name);
    const isCh = changedList().some((c) => lc(c) === lc(r.name));
    insp.replaceChildren(
      h('div', { class: 'ci-head' }, h('h2', {}, 'Part'), n ? h('span', { class: `ci-pill ${cls(n)}` }, n.changed ? 'changed' : n.hops == null ? 'not reached' : `${n.hops} hop${n.hops > 1 ? 's' : ''} · weight ${F(n.weight)}`) : null,
        h('span', { class: 'ci-grow' }), addBtn,
        h('button', { class: 'k-btn ci-danger', onclick: () => delItem(idx), title: 'Delete this part and the links to it' }, 'Delete')),
      h('div', { class: 'ci-ib' },
        h('div', { class: 'ci-row2' }, h('label', { class: 'ci-f wide' }, h('span', {}, 'Name'), nameIn), h('label', { class: 'ci-f' }, h('span', {}, 'Room'), roomSel)),
        h('div', { class: 'ci-acts' },
          h('button', { class: 'k-btn k-primary', onclick: () => makeOnly(n?.name || r.name) }, 'This is the change'),
          h('button', { class: 'k-btn', onclick: () => toggleChanged(n?.name || r.name) }, isCh ? 'Remove from the change' : 'Add to the change')),
        h('div', { class: 'ci-sec' }, 'Depends on'),
        h('div', { class: 'ci-deps' }, deps.map((d) => h('span', { class: 'ci-dep' }, d,
          h('button', { type: 'button', 'aria-label': `Remove the link to ${d}`, title: 'Remove this link', onclick: () => removeDep(d, n?.name || r.name) }, '×'))), addSel),
        h('div', { class: 'ci-sec' }, 'Used by'),
        h('div', { class: 'ci-deps' }, users.length ? users.map((u) => h('button', { type: 'button', class: 'ci-dep go', onclick: () => { state.sel = u; render(); } }, u)) : h('span', { class: 'ci-sub' }, 'nothing depends on it'))));
  }
  function rename(oldName, nv) {
    const name = nv.trim(); if (!name || name === oldName) return;
    const rows = rowsNow();
    for (const r of rows) {
      if (String(r.name).trim() === String(oldName).trim()) r.name = name;
      r.deps = split(r.deps).map((d) => (lc(d) === lc(String(oldName).trim()) ? name : d)).join(', ');
    }
    const ch = changedList().map((c) => (lc(c) === lc(String(oldName).trim()) ? name : c)).join(', ');
    state.sel = name; setRows(rows, { changed: ch });
  }
  function addItem() {
    const rows = rowsNow(); let k = 1; while (rows.some((r) => lc(r.name) === `new part ${k}`)) k++;
    const g = G(); const cur = g?.nodes.find((x) => x.name === state.sel);
    const name = `New part ${k}`;
    rows.push({ name, room: cur?.room || 'pcb', deps: cur ? cur.name : '' });
    state.sel = name; setRows(rows);
    requestAnimationFrame(() => { const i = insp.querySelector('input'); if (i) { i.focus(); i.select(); } });
  }
  function delItem(idx) {
    const rows = rowsNow(); const nm = String(rows[idx]?.name ?? '').trim(); rows.splice(idx, 1);
    for (const r of rows) r.deps = split(r.deps).filter((d) => lc(d) !== lc(nm)).join(', ');
    const ch = changedList().filter((c) => lc(c) !== lc(nm)).join(', ');
    state.sel = null; setRows(rows, { changed: ch });
  }

  // ---------- header ----------
  function drawTop(res) {
    const vals = res.values || [];
    stats.replaceChildren(...vals.filter((v) => v.label !== 'Changed').map((v) => h('div', { class: `ci-stat${v.tone ? ` ${v.tone}` : ''}`, title: v.hint || null },
      h('span', {}, v.label), h('b', {}, typeof v.value === 'number' ? F(v.value, 4) : String(v.value), v.unit ? h('small', {}, ` ${v.unit}`) : null),
      v.hint ? h('em', {}, v.hint) : null)));
    stats.hidden = !vals.length;
    const g = G();
    const st = g?.start || [];
    chips.replaceChildren(h('span', { class: 'ci-lbl' }, 'Change:'),
      ...(st.length ? st.map((s) => h('span', { class: 'ci-chip' }, s, h('button', { type: 'button', 'aria-label': `Remove ${s} from the change`, onclick: () => toggleChanged(s) }, '×')))
        : [h('span', { class: 'ci-sub' }, 'click a part')]));
    const mh = String(ctx.raw.maxHops ?? '0').trim();
    hopSeg.replaceChildren(...[['0', 'all'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String((mh === '' ? '0' : mh) === v), title: v === '0' ? 'No limit' : `Stop at ${v} hop${v > 1 ? 's' : ''}`, onclick: () => ctx.set('maxHops', v) }, t)));
  }

  function render() {
    const res = ctx.result || {};
    const g = G();
    if (state.sel && !g?.nodes.some((n) => n.name === state.sel)) {
      const rows = ctx.raw.items || [];
      if (!rows.some((r) => String(r.name ?? '').trim() === state.sel)) state.sel = null;
    }
    if (!state.sel && g?.nodes.length) state.sel = g.start[0] || g.nodes[0].name;
    const act = document.activeElement;
    const refocus = state.refocus || (act?.closest?.('.ci-node') ? act.dataset.name : null);
    state.refocus = null;
    drawTop(res); draw(); drawInspector();
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res.warnings || []).length;
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (refocus && (act === document.body || act?.closest?.('.ci-node') || !act)) {
      const el = gNodes.querySelector(`.ci-node[data-name="${CSS.escape(refocus)}"]`);
      if (el && act?.closest?.('.ci-node')) el.focus({ preventScroll: true });
    }
  }
  ctx.onResult(() => render());
}
