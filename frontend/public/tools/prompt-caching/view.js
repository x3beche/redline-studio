// Prompt Caching Planner, custom page.
//   Stack    - the prompt as layers, top = first token. Each layer's colour is
//              how often it changes; its bar shows how often it was read from
//              cache / written / sent uncached in the replay. Drag the grip
//              (or Up/Down on it) to reorder; click the slot under a layer to
//              put a cache breakpoint there; click the chip to change how
//              often the part changes; names and token counts edit in place.
//   Timeline - the call trace on a minute axis: one column per call, one row
//              per layer (read, written, uncached), each cache entry's life
//              as a line under its breakpoint row, the cost of each call
//              against the uncached cost. Drag a call along the axis, click to
//              select, double-click empty space to add; keys on a call:
//              Left/Right move, U changes the user, Delete removes, N adds.
// Everything drawn comes from run()'s result.trace.

import { money } from './tool.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const int = (v) => Math.round(v).toLocaleString('en-US');
const CHANGES = ['never', 'per day', 'per user', 'per call'];
const VCLASS = { never: 'v0', 'per day': 'v1', 'per user': 'v2', 'per call': 'v3' };
const USERS = ['A', 'B', 'C', 'D', 'E'];
const fmtT = (t) => String(Math.round(t * 10) / 10);

export function page(root, ctx) {
  let res = null, T = null, sel = -1; // sel = index into T.calls (sorted)
  const wrap = h('div', { class: 'pc' });
  root.append(wrap);
  const parts = () => structuredClone(ctx.raw.parts || []);
  const refocus = (k) => requestAnimationFrame(() => root.querySelector(`[data-k="${k}"]`)?.focus());

  // ---------- stack ----------
  const modelSel = h('select', { class: 'pc-sel', 'aria-label': 'Model', onchange: (e) => ctx.set('model', e.target.value) },
    ctx.manifest.inputs.find((d) => d.key === 'model').options.map(([v, t]) => h('option', { value: v }, t)));
  const ttlSeg = h('div', { class: 'pc-seg', role: 'group', 'aria-label': 'Cache lifetime' });
  const sugBtn = h('button', { class: 'k-btn pc-sug', hidden: true, onclick: () => { if (T?.suggested) ctx.set('parts', T.suggested.map((p) => ({ name: p.name, tokens: String(p.tokens), changes: p.changes, bp: p.bp ? 'yes' : 'no' }))); } });
  const stackEl = h('div', { class: 'pc-stack', role: 'list', 'aria-label': 'Prompt parts, first token at the top' });
  const stackSub = h('span', { class: 'pc-sub' });
  const stackCard = h('section', { class: 'pc-card pc-stackcard' },
    h('div', { class: 'pc-head' }, h('h2', {}, 'Prompt, top to bottom'), stackSub),
    h('div', { class: 'pc-bar' }, modelSel, ttlSeg,
      h('button', { class: 'k-btn', onclick: () => { const p = parts(); p.push({ name: `Part ${p.length + 1}`, tokens: '500', changes: 'per call', bp: 'no' }); ctx.set('parts', p); } }, '+ Part')),
    sugBtn, stackEl,
    h('div', { class: 'pc-legend' }, CHANGES.map((c) => h('span', {}, h('i', { class: `sw ${VCLASS[c]}` }), c)),
      h('span', {}, h('i', { class: 'sw st-r' }), 'read'), h('span', {}, h('i', { class: 'sw st-w' }), 'written'), h('span', {}, h('i', { class: 'sw st-p' }), 'uncached')),
    h('div', { class: 'pc-help' }, 'Drag a grip, or focus it and press Up/Down, to move a part. Click the line under a part to place or remove a breakpoint. The chip cycles how often the part changes.'));

  // ---------- stats ----------
  const stats = h('div', { class: 'pc-stats', 'aria-live': 'polite' });
  const perDayIn = h('input', { class: 'pc-num', type: 'text', inputmode: 'decimal', 'aria-label': 'Calls per day', spellcheck: 'false',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null && v >= 0) ctx.set('calls_day', v); } });
  const warnBox = h('div', { class: 'pc-warns', role: 'status' });

  // ---------- timeline ----------
  const svg = sv('svg', { class: 'pc-tl', tabindex: '-1', role: 'application', 'aria-label': 'Call timeline' });
  const detail = h('div', { class: 'pc-detail', 'aria-live': 'polite' });
  const userSel = h('select', { class: 'pc-sel', 'aria-label': 'User of the selected call', onchange: (e) => editCall(sel, { user: e.target.value }) }, USERS.map((u) => h('option', { value: u }, `user ${u}`)));
  const traceTa = h('textarea', { class: 'pc-ta', rows: '8', spellcheck: 'false', 'aria-label': 'Call trace, minute and user per line', hidden: true });
  let taT = null;
  traceTa.addEventListener('input', () => { clearTimeout(taT); taT = setTimeout(() => ctx.set('calls', traceTa.value), 350); });
  const editBtn = h('button', { class: 'k-btn', 'aria-pressed': 'false', onclick: () => { traceTa.hidden = !traceTa.hidden; editBtn.setAttribute('aria-pressed', String(!traceTa.hidden)); if (!traceTa.hidden) { traceTa.value = ctx.raw.calls || ''; traceTa.focus(); } } }, 'Edit trace as text');
  const tlCard = h('section', { class: 'pc-card pc-tlcard' },
    h('div', { class: 'pc-head' }, h('h2', {}, 'Calls'), h('span', { class: 'pc-sub', id: 'pc-tlsub' })),
    h('div', { class: 'pc-bar' },
      h('button', { class: 'k-btn', onclick: () => addCall() }, '+ Call'),
      h('button', { class: 'k-btn', onclick: () => { if (sel >= 0) removeCall(sel); } }, 'Delete call'), userSel, editBtn,
      h('span', { class: 'pc-legend pc-tll' }, h('span', {}, h('i', { class: 'sw st-r' }), 'read'), h('span', {}, h('i', { class: 'sw st-w' }), 'written'), h('span', {}, h('i', { class: 'sw st-p' }), 'uncached'), h('span', {}, h('i', { class: 'sw st-ttl' }), 'cache entry alive'))),
    h('div', { class: 'pc-tlbox' }, svg), detail, traceTa,
    h('div', { class: 'pc-help' }, 'Drag a call along the axis; double-click empty space to add one. On a selected call: Left/Right move it (Shift: 5 min), U changes the user, N adds the next call, Delete removes it.'));

  const notes = h('details', { class: 'pc-notes' }, h('summary', {}, 'Notes and assumptions'));
  const left = h('div', { class: 'pc-col pc-left' }, stackCard);
  const right = h('div', { class: 'pc-col pc-right' }, stats, warnBox, tlCard, notes, h('div', { class: 'pc-out' }, ctx.outputs));
  wrap.append(left, right);

  // ---------- calls editing (the trace text is the input) ----------
  function writeCalls(list) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    ctx.set('calls', sorted.map((c) => `${fmtT(c.t)} ${c.user}`).join('\n'));
    return sorted;
  }
  const callList = () => (T ? T.calls.map((c) => ({ t: c.t, user: c.user })) : []);
  function editCall(i, patch) {
    if (i < 0) return;
    const list = callList();
    const keep = list[i];
    Object.assign(keep, patch);
    const sorted = writeCalls(list);
    sel = sorted.indexOf(keep);
  }
  function removeCall(i) { const list = callList(); list.splice(i, 1); writeCalls(list); sel = Math.min(i, list.length - 1); refocus(`c:${sel}`); }
  function addCall(t, user) {
    const list = callList();
    const at = t ?? (sel >= 0 && list[sel] ? list[sel].t + 1 : (list.length ? list[list.length - 1].t + 1 : 0));
    const c = { t: Math.max(0, Math.round(at * 10) / 10), user: user || (sel >= 0 && list[sel] ? list[sel].user : 'A') };
    list.push(c);
    const sorted = writeCalls(list);
    sel = sorted.indexOf(c);
    refocus(`c:${sel}`);
  }

  // ---------- draw: stack ----------
  let drag = null;
  function drawStack() {
    const P = T.parts;
    const active = document.activeElement;
    if (stackEl.contains(active) && active.tagName === 'INPUT' && stackEl.dataset.n === String(P.length)) { updateStackStats(); return; }
    stackEl.dataset.n = String(P.length);
    const maxTok = Math.max(1, ...P.map((p) => p.tokens));
    stackEl.replaceChildren(...P.flatMap((p, i) => {
      const nameIn = h('input', { class: 'pc-name', type: 'text', spellcheck: 'false', 'aria-label': `Name of part ${i + 1}`, 'data-k': `n:${i}` });
      nameIn.value = p.name;
      const tokIn = h('input', { class: 'pc-tok', type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': `Tokens of ${p.name}`, 'data-k': `t:${i}` });
      tokIn.value = String(p.tokens);
      for (const [el, key] of [[nameIn, 'name'], [tokIn, 'tokens']]) {
        let t0 = null;
        el.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(() => { const q = parts(); const r = q[p.row]; if (!r) return; r[key] = el.value; ctx.set('parts', q); }, 300); });
      }
      const chip = h('button', { class: `pc-chip ${VCLASS[p.changes]}`, 'data-k': `c:${i}`, title: 'How often the text of this part changes - click to cycle',
        onclick: () => { const q = parts(); q[p.row].changes = CHANGES[(CHANGES.indexOf(p.changes) + 1) % 4]; ctx.set('parts', q); refocus(`c:${i}`); } }, p.changes);
      const grip = h('button', { class: 'pc-grip', 'aria-label': `Move ${p.name}: Up and Down arrows`, 'data-k': `g:${i}`, title: 'Drag to reorder' }, h('i'), h('i'), h('i'));
      grip.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!d) return; e.preventDefault(); move(i, i + d); refocus(`g:${clamp(i + d, 0, P.length - 1)}`);
      });
      grip.addEventListener('pointerdown', (e) => startDrag(e, i));
      const del = h('button', { class: 'k-btn k-x', 'aria-label': `Remove ${p.name}`, onclick: () => { const q = parts(); q.splice(p.row, 1); ctx.set('parts', q); } }, '×');
      const bar = h('div', { class: 'pc-lbar', 'data-i': i });
      const flags = h('div', { class: 'pc-flags', 'data-i': i });
      const px = 40 + Math.round(46 * Math.sqrt(p.tokens / maxTok));
      const layer = h('div', { class: `pc-layer ${VCLASS[p.changes]}`, role: 'listitem', 'data-i': i, style: `min-height:${px}px` },
        grip, h('div', { class: 'pc-lmain' }, h('div', { class: 'pc-lrow' }, h('span', { class: 'pc-idx' }, String(i + 1)), nameIn, tokIn, h('span', { class: 'pc-tu' }, 'tok'), chip, del), bar, flags));
      const slot = h('button', { class: 'pc-slot', 'data-i': i, 'data-k': `s:${i}`, onclick: () => { const q = parts(); q[p.row].bp = p.bp ? 'no' : 'yes'; ctx.set('parts', q); refocus(`s:${i}`); } });
      return [layer, slot];
    }));
    updateStackStats();
  }
  function updateStackStats() {
    const P = T.parts;
    for (const el of stackEl.querySelectorAll('.pc-lbar')) {
      const p = P[Number(el.dataset.i)]; if (!p) continue;
      const r = p.stat.r, w = p.stat.w, u = Math.max(0, 1 - r - w);
      el.replaceChildren(h('span', { class: 'pc-sbar' }, h('i', { class: 'st-r', style: `flex:${r}` }), h('i', { class: 'st-w', style: `flex:${w}` }), h('i', { class: 'st-p', style: `flex:${u}` })),
        h('span', { class: 'pc-stxt' }, r > 0 ? `read ${Math.round(r * 100)} %` : '', r > 0 && w > 0 ? ' · ' : '', w > 0 ? `written ${Math.round(w * 100)} %` : '', r === 0 && w === 0 ? 'uncached on every call' : ''));
    }
    for (const el of stackEl.querySelectorAll('.pc-flags')) {
      const p = P[Number(el.dataset.i)]; if (!p) continue;
      el.replaceChildren(...p.flags.map((f) => h('div', {}, f)));
    }
    for (const el of stackEl.querySelectorAll('.pc-layer')) {
      const i = Number(el.dataset.i); const p = P[i]; if (!p) continue;
      el.classList.toggle('cached', p.stat.r >= 0.5);
      el.classList.toggle('flagged', p.flags.length > 0);
    }
    for (const el of stackEl.querySelectorAll('.pc-slot')) {
      const i = Number(el.dataset.i); const p = P[i]; if (!p) continue;
      const on = p.bp;
      const auto = T.prov === 'openai';
      const bad = p.bpFlags.length > 0;
      el.className = `pc-slot${on ? ' on' : ''}${bad ? ' bad' : ''}${auto ? ' auto' : ''}${T.prov === 'google' && i === T.gemB ? ' gem' : ''}`;
      el.setAttribute('aria-pressed', String(on));
      el.setAttribute('aria-label', `${on ? 'Remove' : 'Place'} a cache breakpoint after ${p.name} (prefix ${int(T.cum[i])} tokens)`);
      const label = on
        ? `${T.prov === 'google' ? (i === T.gemB ? 'explicit cache boundary' : 'breakpoint (not used)') : auto ? 'breakpoint (ignored: automatic caching)' : 'cache_control'} · ${int(T.cum[i])} tok${bad ? ` - ${p.bpFlags.join('; ')}` : ''}`
        : `${int(T.cum[i])} tok`;
      el.replaceChildren(...[h('span', { class: 'pc-line' }), h('span', { class: 'pc-mark' }), h('span', { class: 'pc-slab' }, label), on ? null : h('span', { class: 'pc-add' }, '+ breakpoint')].filter(Boolean));
      el.title = label;
    }
  }
  function move(from, to) {
    const P = T.parts; if (to < 0 || to >= P.length || to === from) return;
    const q = parts();
    const rows = P.map((p) => q[p.row]);
    const [x] = rows.splice(from, 1); rows.splice(to, 0, x);
    ctx.set('parts', rows);
  }
  function startDrag(e, i) {
    if (e.button !== 0) return;
    e.preventDefault();
    const layers = [...stackEl.querySelectorAll('.pc-layer')];
    const el = layers[i];
    const y0 = e.clientY;
    const ind = h('div', { class: 'pc-ind' });
    drag = { i, to: i };
    el.classList.add('dragging');
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch { /* ended pointer */ }
    const mv = (ev) => {
      el.style.transform = `translateY(${ev.clientY - y0}px)`;
      const mids = layers.map((l) => { const r = l.getBoundingClientRect(); return r.top + r.height / 2; });
      let to = mids.filter((m, j) => j !== i && m < ev.clientY).length;
      drag.to = to;
      const ref = layers.filter((_, j) => j !== i)[to];
      if (ref) stackEl.insertBefore(ind, ref); else stackEl.append(ind);
    };
    const up = () => {
      grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      el.style.transform = ''; el.classList.remove('dragging'); ind.remove();
      const to = drag.to; drag = null;
      if (to !== i) { move(i, to); refocus(`g:${to}`); }
    };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  }

  // ---------- draw: timeline ----------
  let geo = null, cdrag = null;
  function drawTimeline() {
    svg.replaceChildren();
    const P = T.parts, C = T.calls;
    const W = Math.max(300, Math.round(svg.parentElement.clientWidth || 700));
    const LAB = 26, R = 10, TOP = 30, RH = 17, GAP = 3, COST = 46;
    const n = P.length;
    const rowsH = n * (RH + GAP);
    const H = TOP + rowsH + 30 + COST + 6;
    const tMax = Math.max(30, (C.length ? C[C.length - 1].t : 0) + Math.min(T.ttlMin, 10) + 1);
    const X = (t) => LAB + (clamp(t, 0, tMax) / tMax) * (W - LAB - R);
    geo = { W, LAB, R, tMax, X, inv: (x) => clamp(((x - LAB) / (W - LAB - R)) * tMax, 0, tMax) };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 240, 720, 1440].find((s) => (tMax / s) * 58 < W - LAB) || 1440;
    for (let t = 0; t <= tMax + 1e-9; t += step) {
      const x = X(t);
      svg.append(sv('line', { x1: x, x2: x, y1: TOP - 4, y2: TOP + rowsH, class: 'pc-grid' }));
      svg.append(sv('text', { x, y: TOP + rowsH + 13, class: 'pc-ax', 'text-anchor': t === 0 ? 'start' : 'middle' }, t >= 60 && step >= 60 ? `${t / 60} h` : `${t} min`));
    }
    // rows
    P.forEach((p, i) => {
      const y = TOP + i * (RH + GAP);
      svg.append(sv('rect', { x: LAB, y, width: W - LAB - R, height: RH, class: `pc-rowbg ${VCLASS[p.changes]}` }));
      svg.append(sv('text', { x: LAB - 6, y: y + RH / 2 + 4, class: 'pc-rowlab', 'text-anchor': 'end' }, String(i + 1)));
      if (p.bp) svg.append(sv('line', { x1: LAB, x2: W - R, y1: y + RH + 1.5, y2: y + RH + 1.5, class: `pc-bpl${p.bpFlags.length ? ' bad' : ''}` }));
    });
    // cache entries alive
    const users = [...new Set(T.segs.map((s) => s.user).filter(Boolean))];
    for (const s of T.segs) {
      const y = TOP + s.b * (RH + GAP) + RH - 3;
      const k = s.user ? users.indexOf(s.user) % 3 + 1 : 0;
      const x1 = X(s.from), x2 = X(Math.min(s.to, tMax));
      const seg = sv('rect', { x: x1, y, width: Math.max(1, x2 - x1), height: 3, class: `pc-ttl u${k}` });
      seg.append(sv('title', {}, `Entry after part ${s.b + 1}${s.user ? `, user ${s.user}` : ''}: alive ${fmtT(s.from)}-${fmtT(s.to)} min, ${s.writes} write, ${s.reads} read${s.reads === 1 ? '' : 's'}`));
      svg.append(seg);
      if (s.to <= tMax) svg.append(sv('line', { x1: x2, x2, y1: y - 2, y2: y + 5, class: `pc-exp u${k}` }));
    }
    // calls
    const cw = clamp(((W - LAB - R) / tMax) * 0.45, 3, 9);
    const maxCost = Math.max(1e-12, ...C.map((c) => Math.max(c.cost, c.base)));
    const cy = TOP + rowsH + 30;
    svg.append(sv('text', { x: LAB - 6, y: cy + COST / 2 + 3, class: 'pc-rowlab', 'text-anchor': 'end' }, '$'));
    svg.append(sv('line', { x1: LAB, x2: W - R, y1: cy + COST, y2: cy + COST, class: 'pc-grid' }));
    C.forEach((c, k) => {
      const x = X(c.t);
      const g = sv('g', { class: `pc-call${k === sel ? ' on' : ''}`, tabindex: '0', role: 'button', 'data-k': `c:${k}`, 'data-idx': k,
        'aria-label': `Call at ${fmtT(c.t)} min, user ${c.user}: read ${int(c.read)}, written ${int(c.write)}, uncached ${int(c.plain)} tokens, ${money(c.cost)}` });
      g.append(sv('rect', { x: x - 9, y: 0, width: 18, height: TOP + rowsH, class: 'pc-callhit' }));
      g.append(sv('path', { d: `M${x - 6},${TOP - 16} h12 l-6,8 z`, class: `pc-tri${c.read > 0 ? ' hit' : ''}` }));
      g.append(sv('text', { x, y: TOP - 19, class: 'pc-user', 'text-anchor': 'middle' }, c.user));
      [...c.layers].forEach((st, i) => {
        g.append(sv('rect', { x: x - cw / 2, y: TOP + i * (RH + GAP) + 2, width: cw, height: RH - 6, rx: 1, class: `pc-cell st-${st}` }));
      });
      const hb = (c.base / maxCost) * (COST - 4), hc = (c.cost / maxCost) * (COST - 4);
      g.append(sv('rect', { x: x - cw / 2, y: cy + COST - hc, width: cw, height: hc, class: `pc-cost${c.cost > c.base ? ' over' : ''}` }));
      g.append(sv('line', { x1: x - cw / 2 - 2, x2: x + cw / 2 + 2, y1: cy + COST - hb, y2: cy + COST - hb, class: 'pc-base' }));
      svg.append(g);
    });
    svg.append(sv('text', { x: LAB, y: cy - 3, class: 'pc-ax' }, W < 560 ? 'cost per call; tick = without cache' : 'cost of each call (bar) against the same call without caching (tick)'));
    root.querySelector('#pc-tlsub').textContent = `${C.length} calls over ${fmtT(C.length ? C[C.length - 1].t - C[0].t : 0)} min · ${T.modelName} · TTL ${T.ttl}`;
    drawDetail();
  }
  function drawDetail() {
    const c = T.calls[sel];
    if (!c) { detail.replaceChildren(h('span', { class: 'pc-sub' }, 'Click a call to see what it paid.')); userSel.disabled = true; return; }
    userSel.disabled = false; userSel.value = USERS.includes(c.user) ? c.user : 'A';
    detail.replaceChildren(h('b', {}, `${fmtT(c.t)} min, user ${c.user}: `),
      h('span', { class: 'st-rt' }, `read ${int(c.read)}`), ' · ', h('span', { class: 'st-wt' }, `written ${int(c.write)}`), ' · ', `uncached ${int(c.plain)} tokens → `,
      h('b', {}, money(c.cost)), ` (without cache ${money(c.base)})`);
  }
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.pc-call');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    const k = Number(g.dataset.idx);
    sel = k; g.focus({ preventScroll: true });
    const list = callList(); const item = list[k];
    const r = svg.getBoundingClientRect(); const sx = geo.W / r.width;
    const x0 = e.clientX; let moved = false;
    cdrag = { item, list };
    try { svg.setPointerCapture(e.pointerId); } catch { /* ended pointer */ }
    let raf = 0;
    const mv = (ev) => {
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      if (!moved) return;
      item.t = Math.round(geo.inv((ev.clientX - r.left) * sx) * 10) / 10;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const sorted = writeCalls(list); sel = sorted.indexOf(item); });
    };
    const up = () => {
      svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
      cdrag = null;
      if (!moved) { drawTimeline(); }
      refocus(`c:${sel}`);
    };
    svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  });
  svg.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pc-call') || !geo) return;
    const r = svg.getBoundingClientRect();
    addCall(geo.inv((e.clientX - r.left) * (geo.W / r.width)));
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest?.('.pc-call'); if (!g) return;
    const k = Number(g.dataset.idx); sel = k;
    const c = T.calls[k];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 0.5); editCall(k, { t: Math.max(0, Math.round((c.t + d) * 10) / 10) }); refocus(`c:${sel}`); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCall(k); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); editCall(k, { user: USERS[(USERS.indexOf(c.user) + 1) % USERS.length] }); refocus(`c:${sel}`); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'Insert') { e.preventDefault(); addCall(c.t + 1, c.user); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drawTimeline(); refocus(`c:${k}`); }
  });
  svg.addEventListener('focusin', (e) => { const g = e.target.closest?.('.pc-call'); if (g && Number(g.dataset.idx) !== sel) { sel = Number(g.dataset.idx); for (const x of svg.querySelectorAll('.pc-call.on')) x.classList.remove('on'); g.classList.add('on'); drawDetail(); } });

  // ---------- stats ----------
  function drawStats() {
    const save = T.avgBase - T.avgCost;
    const pct = T.avgBase > 0 ? Math.round((save / T.avgBase) * 100) : 0;
    const tone = save > 0 ? 'ok' : save < 0 ? 'bad' : '';
    if (document.activeElement !== perDayIn) perDayIn.value = String(T.perDay);
    stats.replaceChildren(...[
      h('div', { class: `pc-stat ${tone}` }, h('span', {}, 'Per call'), h('b', {}, money(T.avgCost)), h('em', {}, `${money(T.avgBase)} without caching`)),
      h('div', { class: `pc-stat ${tone}` }, h('span', {}, 'Saving'), h('b', {}, `${pct} %`), h('em', {}, save < 0 ? 'caching costs more here' : 'per call, on input')),
      h('div', { class: `pc-stat ${tone}` }, h('span', {}, 'Per month'), h('b', {}, money(T.monthSave)), h('label', { class: 'pc-em' }, 'at ', perDayIn, ' calls/day')),
      h('div', { class: 'pc-stat' }, h('span', {}, 'Calls with a hit'), h('b', {}, `${Math.round(T.hitRate * 100)} %`), h('em', {}, `${Math.round(T.readShare * 100)} % of input tokens from cache`)),
      T.suggested ? h('div', { class: 'pc-stat warn' }, h('span', {}, 'Suggested order'), h('b', {}, money(T.sugCost)), h('em', {}, `${money(T.sugMonth)}/month less`)) : null].filter(Boolean));
  }

  function draw() {
    if (!res || !T) return;
    modelSel.value = T.model;
    ttlSeg.replaceChildren(...[['5m', '5 min'], ['1h', '1 h'], ['24h', '24 h']].map(([v, t]) => h('button', {
      class: v === T.ttl ? 'on' : '', 'aria-pressed': String(v === T.ttl), 'data-k': `ttl:${v}`, disabled: T.prov === 'anthropic' && v === '24h' ? true : null,
      title: T.prov === 'anthropic' ? (v === '1h' ? 'write 2x input' : v === '5m' ? 'write 1.25x input' : 'not offered by Anthropic') : T.prov === 'openai' ? (v === '24h' ? 'extended retention, where offered' : v === '1h' ? 'not an OpenAI setting' : 'in-memory, 5-10 min idle') : 'explicit cache TTL (storage billed per hour)',
      onclick: () => { ctx.set('ttl', v); refocus(`ttl:${v}`); } }, t)));
    stackSub.textContent = `${int(T.total)} tokens · min cacheable ${int(T.min)}`;
    sugBtn.hidden = !T.suggested;
    sugBtn.textContent = T.suggested ? `Apply suggested order (stable to volatile): ${money(T.sugMonth)}/month less` : '';
    if (sel >= T.calls.length) sel = T.calls.length - 1;
    drawStack(); drawStats(); drawTimeline();
    const w = res.warnings || [];
    warnBox.replaceChildren(...w.map((t) => h('div', {}, t)));
    warnBox.hidden = !w.length;
    notes.replaceChildren(h('summary', {}, 'Notes and assumptions'), ...(res.notes || []).map((t) => h('p', {}, t)));
    if (!traceTa.hidden && document.activeElement !== traceTa) traceTa.value = ctx.raw.calls || '';
  }
  ctx.onResult((r) => { res = r; T = r.trace || null; draw(); });
  let rw = 0;
  new ResizeObserver(() => { const w = svg.parentElement.clientWidth; if (Math.abs(w - rw) > 4) { rw = w; if (T && !cdrag) drawTimeline(); } }).observe(svg.parentElement);
}
