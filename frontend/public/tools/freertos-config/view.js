// FreeRTOS Config & Heap Sizer, drawn as the things themselves:
//  - the heap: configTOTAL_HEAP_SIZE as one long bar, filled block by block
//    in creation order (task stacks, TCBs, queue storage, the idle and timer
//    tasks); drag its end to resize the heap;
//  - the tasks on their priority rows, each as wide as its stack: drag a task
//    up or down to change its priority, drag its right edge to change its
//    stack;
//  - the NVIC priority ladder with the configMAX_SYSCALL line: drag the line,
//    drag an ISR to another priority, click its API tag to say whether it
//    calls FromISR functions.
// Every number drawn comes from run()'s result (result.view).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
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
const title = (el, text) => { el.append(s('title', {}, text)); return el; };
const kib = (b) => (Math.abs(b) >= 1024 ? `${Number((b / 1024).toFixed(Math.abs(b) % 1024 ? 1 : 0))} KiB` : `${b} B`);
const sizeText = (b) => (b % 1024 === 0 ? `${b / 1024}K` : String(b));
const KCOL = {
  stack: 'var(--tool-stack)', tcb: 'var(--tool-tcb)', queue: 'var(--tool-queue)', 'binary semaphore': 'var(--tool-sync)',
  'counting semaphore': 'var(--tool-sync)', mutex: 'var(--tool-sync)', 'recursive mutex': 'var(--tool-sync)', 'event group': 'var(--tool-sync)',
  'stream buffer': 'var(--tool-buf)', 'message buffer': 'var(--tool-buf)', timer: 'var(--tool-timer)',
};
const OBJ_KINDS = ['queue', 'binary semaphore', 'counting semaphore', 'mutex', 'recursive mutex', 'event group', 'stream buffer', 'message buffer', 'timer'];

export function page(root, ctx) {
  const wrap = h('div', { class: 'fr' });
  root.append(wrap);
  let res = null, V = null;
  let frozenHeap = null, frozenTasks = null, frozenIsr = null, dragging = false;
  let selTask = null, selIsr = null, focusId = null;

  const raf = (() => { let pend = null, id = 0; return (fn) => { pend = fn; if (!id) id = requestAnimationFrame(() => { id = 0; const f = pend; pend = null; f && f(); }); }; })();
  const drag = (el, ev, move, done) => {
    dragging = true;
    try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
    const mv = (e) => move(e);
    const up = (e) => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      dragging = false; done && done(e);
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const svgX = (svg, e) => { const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal; return ((e.clientX - r.left) / r.width) * vb.width; };
  const svgY = (svg, e) => { const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal; return ((e.clientY - r.top) / r.height) * vb.height; };
  const track = (el, id) => { el.setAttribute('data-id', id); el.addEventListener('focus', () => { focusId = id; }); };
  const refocus = (svg) => { if (focusId) { const el = svg.querySelector(`[data-id="${CSS.escape(focusId)}"]`); if (el && document.activeElement !== el && svg.contains(document.activeElement) === false && wantFocus) { el.focus({ preventScroll: true }); } } };
  let wantFocus = false;

  // ---------- heap ----------
  const heapSvg = s('svg', { class: 'fr-svg', role: 'group', 'aria-label': 'Heap' });
  const heapSub = h('span', { class: 'fr-sub' });
  const heapLegend = h('div', { class: 'fr-legend' });
  const objList = h('div', { class: 'fr-objs' });
  const heapCard = h('section', { class: 'fr-card' },
    h('div', { class: 'fr-head' }, h('h2', {}, 'Heap'), heapSub),
    heapSvg, heapLegend,
    h('div', { class: 'fr-help' }, 'Drag the heap\'s end (or focus it: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' 256 B, ', h('kbd', {}, 'Shift'), ' 1 KiB). Hover a block for its size. Objects below; tasks on the priority rows.'),
    objList);

  // ---------- tasks ----------
  const taskSvg = s('svg', { class: 'fr-svg', role: 'group', 'aria-label': 'Tasks by priority' });
  const taskEd = h('div', { class: 'fr-ed' });
  const taskSub = h('span', { class: 'fr-sub' });
  const taskCard = h('section', { class: 'fr-card' },
    h('div', { class: 'fr-head' }, h('h2', {}, 'Tasks by priority'), taskSub,
      h('span', { class: 'fr-right' }, h('button', { class: 'k-btn', type: 'button', onclick: () => {
        const rows = (ctx.raw.tasks || []).map((r) => ({ ...r }));
        rows.push({ name: `task${rows.length + 1}`, stack: '256', priority: '1', fpu: 'no' });
        selTask = rows.length - 1; ctx.set('tasks', rows);
      } }, '+ Task'))),
    taskSvg, taskEd,
    h('div', { class: 'fr-help' }, 'Drag a task up/down for priority, its right edge for stack. Focused: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' priority, ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' stack ±16 words, ', h('kbd', {}, 'Del'), ' remove.'));

  // ---------- NVIC ----------
  const isrSvg = s('svg', { class: 'fr-svg', role: 'group', 'aria-label': 'Interrupt priorities' });
  const isrEd = h('div', { class: 'fr-ed' });
  const isrSub = h('span', { class: 'fr-sub' });
  const isrCard = h('section', { class: 'fr-card' },
    h('div', { class: 'fr-head' }, h('h2', {}, 'Interrupt priorities'), isrSub,
      h('span', { class: 'fr-right' }, h('button', { class: 'k-btn', type: 'button', onclick: () => {
        const rows = (ctx.raw.isrs || []).map((r) => ({ ...r }));
        rows.push({ name: `IRQ${rows.length}`, priority: String(V ? Math.min(V.nvic.lowest, V.nvic.syscall + 1) : 6), fromIsr: 'yes' });
        selIsr = rows.length - 1; ctx.set('isrs', rows);
      } }, '+ ISR'))),
    isrSvg, isrEd,
    h('div', { class: 'fr-help' }, 'Drag the syscall line or an ISR; click an ISR\'s API tag to toggle FromISR use. Focused: ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), '.'));

  // ---------- settings ----------
  const set = h('div', { class: 'fr-set' });
  const setCard = h('section', { class: 'fr-card' }, h('div', { class: 'fr-head' }, h('h2', {}, 'Kernel settings')), set);
  const fields = {};
  const field = (key, label, opts = {}) => {
    let el;
    if (opts.options) {
      el = h('select', { onchange: (e) => ctx.set(key, e.target.value) }, opts.options.map(([v, t]) => h('option', { value: v }, t)));
    } else if (opts.bool) {
      el = h('input', { type: 'checkbox', onchange: (e) => ctx.set(key, e.target.checked) });
      fields[key] = el;
      return h('label', { class: 'chk', title: opts.tip || null }, el, label);
    } else {
      el = h('input', { type: 'text', spellcheck: 'false', oninput: (e) => ctx.set(key, e.target.value) });
    }
    fields[key] = el;
    return h('label', { title: opts.tip || null }, label, el);
  };
  const man = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));
  const opts = (k) => man[k].options.map((o) => (Array.isArray(o) ? o : [o, o]));
  set.append(
    field('port', 'Port', { options: opts('port') }),
    field('heap', 'Heap scheme', { options: opts('heap') }),
    field('totalHeap', 'configTOTAL_HEAP_SIZE'),
    field('cpuHz', 'CPU clock Hz'),
    field('tickHz', 'Tick rate Hz'),
    field('maxPriorities', 'MAX_PRIORITIES'),
    field('minimalStack', 'MINIMAL_STACK words'),
    field('maxNameLen', 'MAX_TASK_NAME_LEN'),
    field('prioBits', '__NVIC_PRIO_BITS'),
    field('subBits', 'Sub-priority bits', { tip: 'PRIGROUP: FreeRTOS needs 0' }),
    field('timerQueueLength', 'Timer queue length'),
    field('notifyEntries', 'Notification entries'),
    field('tlsPointers', 'TLS pointers'),
    field('newlib', 'Newlib reentrant', { options: opts('newlib') }),
    field('stackCheck', 'Stack overflow check', { options: opts('stackCheck') }),
    h('div', { class: 'fr-checks' },
      field('useTimers', 'Timers', { bool: true }),
      field('trace', 'Trace facility', { bool: true, tip: '+8 B per TCB, +8 B per queue' }),
      field('runtimeStats', 'Run-time stats', { bool: true }),
      field('staticAlloc', 'Static allocation', { bool: true }),
      field('queueSets', 'Queue sets', { bool: true })));

  const warns = h('div', { class: 'fr-warns', role: 'status' });
  const notes = h('details', { class: 'fr-notes' }, h('summary', {}, 'Notes'));
  wrap.append(
    h('div', { class: 'fr-main' }, warns, heapCard, h('div', { class: 'fr-two' }, taskCard, isrCard), notes),
    h('div', { class: 'fr-side' }, setCard, ctx.outputs));

  // ================= heap =================
  function drawHeap() {
    heapSvg.replaceChildren();
    const W = Math.max(300, heapCard.clientWidth - 2 || 800);
    const narrow = W < 600;
    const L = 10, R = narrow ? 14 : 20, T = 26, BH = narrow ? 54 : 64, H = T + BH + 34;
    heapSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); heapSvg.setAttribute('height', H);
    const domain = frozenHeap || Math.max(V.total, V.used + (V.total - V.usable), V.suggest) * 1.18;
    const X = (b) => L + (b / domain) * (W - L - R);
    const defs = s('defs');
    const pat = s('pattern', { id: 'fr-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--danger)', 'stroke-width': 2, 'stroke-opacity': 0.5 }));
    defs.append(pat); heapSvg.append(defs);
    // the array itself
    heapSvg.append(s('rect', { x: X(0), y: T, width: X(V.total) - X(0), height: BH, class: 'fr-free' }));
    // blocks
    for (const b of V.blocks) {
      const x = X(b.start), w = Math.max(0.8, X(b.start + b.size) - x - (X(b.size) - X(0) > 3 ? 1 : 0));
      const g = s('g', { class: `fr-blk ${b.group}` });
      g.append(title(s('rect', { x, y: T, width: w, height: BH, fill: KCOL[b.kind] || 'var(--tool-s0)', 'fill-opacity': b.group === 'kernel' ? 0.55 : 0.9 }),
        `${b.owner} · ${b.part}\nrequested ${b.req} B, takes ${b.size} B${b.size > b.req ? ` (+${b.size - b.req} header/alignment)` : ''}\nheap offset ${b.start}..${b.start + b.size - 1}`));
      if (w > 44) {
        const lbl = w > 90 ? `${b.owner} ${b.part === 'stack' ? 'stack' : b.part}` : b.owner;
        const t = s('text', { x: x + 4, y: T + 16, class: 'fr-bl' }, lbl.length * 6.4 > w - 6 ? lbl.slice(0, Math.max(1, Math.floor((w - 8) / 6.4))) : lbl);
        heapSvg.append(g, t);
        if (w > 60) heapSvg.append(s('text', { x: x + 4, y: T + 30, class: 'fr-bl soft' }, kib(b.size)));
      } else heapSvg.append(g);
    }
    // overflow past the end
    if (V.free < 0) {
      heapSvg.append(s('rect', { x: X(V.usable), y: T - 3, width: X(V.used) - X(V.usable), height: BH + 6, fill: 'url(#fr-hatch)', stroke: 'var(--danger)' }));
      heapSvg.append(s('text', { x: X(V.usable) + 4, y: T + BH + 14, class: 'fr-ax bad' }, `${-V.free} B short`));
    } else if (X(V.usable) - X(V.used) > 70) {
      const mx = (X(V.used) + X(V.usable)) / 2;
      heapSvg.append(s('text', { x: mx, y: T + BH / 2 + 4, class: 'fr-free-t', 'text-anchor': 'middle' }, `free ${kib(V.free)}`));
    }
    // suggested size tick
    const sx = X(V.suggest);
    heapSvg.append(title(s('line', { x1: sx, x2: sx, y1: T - 4, y2: T + BH + 4, class: 'fr-sug' }), `Suggested: ${V.suggest} B (used + 20 %)`));
    if (Math.abs(sx - X(V.total)) > 60) heapSvg.append(s('text', { x: sx, y: T + BH + 26, class: 'fr-ax', 'text-anchor': 'middle' }, `suggest ${sizeText(V.suggest)}`));
    // axis
    const step = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072].find((st) => (domain / st) * 70 < (W - L - R)) || 262144;
    for (let b = 0; b <= domain; b += step) {
      heapSvg.append(s('line', { x1: X(b), x2: X(b), y1: T + BH, y2: T + BH + 4, class: 'fr-tick' }));
      if (X(b) < X(V.total) - 30 || X(b) > X(V.total) + 30) heapSvg.append(s('text', { x: X(b), y: T + BH + 14, class: 'fr-ax', 'text-anchor': 'middle' }, b ? kib(b) : '0'));
    }
    // used marker + the end handle
    if (!narrow) heapSvg.append(s('text', { x: X(0), y: T - 8, class: 'fr-ax' }, `used ${V.used} B · ${V.pct.toFixed(1)} %`));
    const ex = X(V.total);
    const hd = s('g', { class: 'fr-hdl', tabindex: 0, role: 'slider', 'aria-label': 'configTOTAL_HEAP_SIZE', 'aria-valuenow': V.total, 'aria-valuetext': `${V.total} bytes` });
    track(hd, 'heap-end');
    hd.append(s('rect', { x: ex - 8, y: T - 18, width: 16, height: BH + 36, fill: 'transparent' }));
    hd.append(s('line', { x1: ex, x2: ex, y1: T - 6, y2: T + BH + 6, class: 'fr-end' }));
    hd.append(s('rect', { x: ex - 4, y: T + BH / 2 - 12, width: 8, height: 24, rx: 2, class: 'fr-grip ring' }));
    const lt = `${sizeText(V.total)} = ${V.total} B`;
    hd.append(s('text', { x: Math.min(W - R, Math.max(ex, 90)), y: T - 8, class: 'fr-ax strong', 'text-anchor': 'end' }, narrow ? `TOTAL_HEAP_SIZE ${sizeText(V.total)}` : `configTOTAL_HEAP_SIZE ${lt}`));
    const setTotal = (b) => ctx.set('totalHeap', sizeText(Math.max(512, Math.round(b))));
    hd.addEventListener('pointerdown', (e) => {
      e.preventDefault(); frozenHeap = domain; wantFocus = true; hd.focus({ preventScroll: true });
      drag(hd, e, (m) => { const b = ((svgX(heapSvg, m) - L) / (W - L - R)) * frozenHeap; const snap = m.shiftKey ? 1024 : 256; raf(() => setTotal(Math.round(b / snap) * snap)); },
        () => { frozenHeap = null; drawHeap(); });
    });
    hd.addEventListener('keydown', (e) => {
      const d = e.shiftKey ? 1024 : 256;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); wantFocus = true; setTotal(Math.floor(V.total / d) * d + d); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); wantFocus = true; setTotal(Math.ceil(V.total / d) * d - d); }
    });
    heapSvg.append(hd);
    heapSub.replaceChildren(h('b', { class: V.free < 0 ? 'bad' : V.free < V.usable * 0.1 ? 'warn' : '' }, `${V.used} / ${V.usable} B`), ` usable in ${V.scheme} · free ${V.free} B · suggested ${V.suggest} B `,
      V.suggest !== V.total ? h('button', { class: 'k-btn fr-mini', type: 'button', onclick: () => ctx.set('totalHeap', sizeText(V.suggest)) }, `Use ${sizeText(V.suggest)}`) : null);
    // legend by kind
    const sums = new Map();
    for (const b of V.blocks) {
      const k = b.kind === 'stack' ? 'Task stacks' : b.kind === 'tcb' ? 'TCBs' : b.kind === 'queue' ? (b.group === 'kernel' ? 'Timer queue' : 'Queues') : /semaphore|mutex|event/.test(b.kind) ? 'Semaphores, mutexes, events' : /buffer/.test(b.kind) ? 'Stream/message buffers' : 'Timers';
      const c = KCOL[b.kind] || 'var(--tool-s0)';
      if (!sums.has(k)) sums.set(k, { c, n: 0 });
      sums.get(k).n += b.size;
    }
    heapLegend.replaceChildren(...[...sums].map(([k, v]) => h('span', {}, h('i', { style: `background:${v.c}` }), `${k} `, h('b', {}, `${v.n} B`))),
      h('span', { class: 'soft' }, `TCB ${V.sizes.TCB} B · Queue_t ${V.sizes.QS} B · lighter = kernel (idle, timer service)`));
  }

  // ---------- objects (inline rows under the heap) ----------
  function drawObjects() {
    const rows = (ctx.raw.objects || []);
    const bytes = new Map();
    for (const b of V.blocks) if (b.group === 'object') { const base = b.owner.replace(/\[\d+\]$/, ''); bytes.set(base, (bytes.get(base) || 0) + b.size); }
    const had = objList.contains(document.activeElement) ? document.activeElement.dataset.cell : null;
    objList.replaceChildren(h('div', { class: 'fr-orow head' }, h('span', {}, 'Kind'), h('span', {}, 'Name'), h('span', {}, 'Length'), h('span', {}, 'Item B'), h('span', {}, 'Count'), h('span', {}, 'Heap'), h('span', {})));
    const upd = (i, k, v) => { const r = rows.map((x) => ({ ...x })); r[i][k] = v; ctx.set('objects', r); };
    rows.forEach((r, i) => {
      const kind = String(r.kind || '').toLowerCase();
      const usesLen = ['queue', 'counting semaphore', 'stream buffer', 'message buffer'].includes(kind);
      const inp = (k, ph, enabled = true) => {
        const el = h('input', { type: 'text', spellcheck: 'false', 'data-cell': `${i}-${k}`, 'aria-label': `${r.name || 'object'} ${k}`, placeholder: ph, disabled: !enabled, oninput: (e) => upd(i, k, e.target.value) });
        el.value = enabled ? (r[k] ?? '') : ''; return el;
      };
      const sel = h('select', { 'data-cell': `${i}-kind`, 'aria-label': 'kind', onchange: (e) => upd(i, 'kind', e.target.value) }, OBJ_KINDS.map((k) => h('option', { value: k, selected: k === kind }, k)));
      const name = String(r.name || '').trim();
      objList.append(h('div', { class: 'fr-orow' },
        h('span', { class: 'sw', style: `--c:${KCOL[kind] || 'var(--line)'}` }, sel),
        inp('name', 'name'), inp('length', usesLen ? (kind === 'queue' ? 'items' : kind === 'counting semaphore' ? 'max' : 'bytes') : '–', usesLen),
        inp('itemSize', kind === 'queue' ? 'bytes' : '–', kind === 'queue'), inp('count', '1'),
        h('span', { class: 'b' }, bytes.has(name) ? `${bytes.get(name)} B` : '–'),
        h('button', { class: 'k-btn k-x', type: 'button', 'aria-label': `Remove ${name}`, title: 'Remove', onclick: () => { const x = rows.map((y) => ({ ...y })); x.splice(i, 1); ctx.set('objects', x); } }, '×')));
    });
    objList.append(h('div', { class: 'fr-oadd' }, ...['queue', 'mutex', 'binary semaphore', 'event group', 'stream buffer', 'timer'].map((k) => h('button', { class: 'k-btn', type: 'button', onclick: () => {
      const x = rows.map((y) => ({ ...y }));
      x.push({ kind: k, name: `${k.split(' ')[0]}${x.length + 1}`, length: k === 'queue' ? '8' : k === 'stream buffer' ? '256' : '', itemSize: k === 'queue' ? '4' : '', count: '1' });
      ctx.set('objects', x);
    } }, `+ ${k}`))));
    if (had) { const el = objList.querySelector(`[data-cell="${had}"]`); if (el) { el.focus(); if (el.setSelectionRange) { const n = el.value.length; el.setSelectionRange(n, n); } } }
  }

  // ================= tasks =================
  function taskRef(t) {
    if (t.row >= 0) return { type: 'task', row: t.row };
    return t.row === -1 ? { type: 'idle' } : { type: 'timer' };
  }
  function setTaskStack(t, words) {
    words = Math.max(32, Math.min(65535, Math.round(words)));
    const r = taskRef(t);
    if (r.type === 'task') { const rows = ctx.raw.tasks.map((x) => ({ ...x })); rows[r.row].stack = String(words); ctx.set('tasks', rows); }
    else ctx.set(r.type === 'idle' ? 'minimalStack' : 'timerStack', String(words));
  }
  function setTaskPrio(t, p) {
    p = Math.max(0, Math.min(V.maxPrio - 1, p));
    const r = taskRef(t);
    if (r.type === 'task') { const rows = ctx.raw.tasks.map((x) => ({ ...x })); rows[r.row].priority = String(p); ctx.set('tasks', rows); }
    else if (r.type === 'timer') ctx.set('timerPriority', String(p));
  }
  function drawTasks() {
    taskSvg.replaceChildren();
    const W = Math.max(280, taskCard.clientWidth - 2 || 600);
    const LW = 58, pad = 8, rowH = 32;
    const prios = V.maxPrio;
    const shown = Math.min(prios, 32);
    const H = shown * rowH + 20;
    taskSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); taskSvg.setAttribute('height', H);
    const byP = new Map();
    for (const t of V.tasks) { const p = Math.min(t.prio, prios - 1); if (!byP.has(p)) byP.set(p, []); byP.get(p).push(t); }
    const avail = W - LW - pad * 2;
    const maxRow = Math.max(256, ...[...byP.values()].map((ts) => ts.reduce((a, t) => a + t.words, 0) + ts.length * 24));
    const scale = frozenTasks ? frozenTasks.scale : Math.min(0.6, avail / (maxRow * 1.15));
    const Y = (p) => 8 + (shown - 1 - Math.min(p, shown - 1)) * rowH;
    for (let p = 0; p < shown; p++) {
      const y = Y(p);
      taskSvg.append(s('rect', { x: 0, y, width: W, height: rowH, class: p % 2 ? 'fr-row alt' : 'fr-row' }));
      taskSvg.append(s('text', { x: 8, y: y + rowH / 2 + 4, class: 'fr-ax' }, `prio ${p}`));
    }
    taskSvg.append(s('line', { x1: LW - 4, x2: LW - 4, y1: 8, y2: 8 + shown * rowH, class: 'fr-tick' }));
    for (const [p, ts] of byP) {
      let x = LW + pad;
      for (const t of ts) {
        const w = Math.max(46, t.words * scale);
        const y = Y(p) + 4, hh = rowH - 8;
        const id = t.row >= 0 ? `task-${t.row}` : t.row === -1 ? 'task-idle' : 'task-timer';
        const bad = t.issues.length > 0;
        const g = s('g', { class: `fr-chip ${t.system ? 'sys' : ''} ${bad ? 'bad' : ''} ${selTask === t.row && t.row >= 0 ? 'sel' : ''}`, tabindex: 0, role: 'button',
          'aria-label': `${t.name}, priority ${t.prio}, stack ${t.words} words${bad ? ', ' + t.issues.join('; ') : ''}` });
        track(g, id);
        g.append(title(s('rect', { x, y, width: w, height: hh, rx: 3, class: 'body ring' }),
          `${t.name}: priority ${t.prio}, stack ${t.words} words = ${t.words * 4} B\nsaved context ${t.ctxWords} words${t.fpu ? ' (with FPU)' : ''}${t.issues.length ? '\n! ' + t.issues.join('\n! ') : ''}`));
        // the saved context sits at the top of the stack
        const cw = Math.min(w - 4, t.ctxWords * scale);
        g.append(s('rect', { x: x + w - cw - 1, y: y + 1, width: cw, height: hh - 2, class: 'ctx' }));
        const label = `${t.name} · ${t.words}w${t.fpu ? ' · FPU' : ''}`;
        g.append(s('text', { x: x + 5, y: y + hh / 2 + 4, class: 'fr-cl' }, label.length * 6.2 > w - 12 ? t.name.slice(0, Math.max(2, Math.floor((w - 12) / 6.2))) : label));
        // right-edge resize grip
        const grip = s('rect', { x: x + w - 6, y, width: 8, height: hh, class: 'grip' });
        g.append(grip);
        taskSvg.append(g);
        const startX = x;
        g.addEventListener('pointerdown', (e) => {
          e.preventDefault(); wantFocus = true; g.focus({ preventScroll: true });
          if (t.row >= 0 && selTask !== t.row) { selTask = t.row; drawTaskEd(); }
          const onGrip = e.target === grip;
          frozenTasks = { scale };
          const y0 = svgY(taskSvg, e);
          let moved = false;
          drag(g, e, (m) => {
            if (onGrip) {
              const words = Math.round(((svgX(taskSvg, m) - startX) / frozenTasks.scale) / 16) * 16;
              raf(() => setTaskStack(t, words));
            } else if (t.row !== -1) {
              const dy = svgY(taskSvg, m) - y0;
              if (Math.abs(dy) > 4) moved = true;
              g.setAttribute('transform', `translate(0 ${dy})`);
            }
          }, (u) => {
            frozenTasks = null;
            if (!onGrip && moved) {
              const yy = svgY(taskSvg, u);
              const p2 = shown - 1 - Math.floor((yy - 8) / rowH);
              g.removeAttribute('transform');
              if (p2 !== t.prio) { setTaskPrio(t, p2); return; }
            }
            drawTasks();
          });
        });
        g.addEventListener('keydown', (e) => {
          wantFocus = true;
          const st = e.shiftKey ? 64 : 16;
          if (e.key === 'ArrowUp' && t.row !== -1) { e.preventDefault(); setTaskPrio(t, t.prio + 1); }
          else if (e.key === 'ArrowDown' && t.row !== -1) { e.preventDefault(); setTaskPrio(t, t.prio - 1); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setTaskStack(t, t.words + st); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); setTaskStack(t, t.words - st); }
          else if ((e.key === 'Delete' || e.key === 'Backspace') && t.row >= 0) { e.preventDefault(); const rows = ctx.raw.tasks.map((x) => ({ ...x })); rows.splice(t.row, 1); selTask = null; focusId = null; ctx.set('tasks', rows); }
          else if (e.key === 'Enter' && t.row >= 0) { selTask = t.row; drawTaskEd(); }
        });
        x += w + 6;
      }
    }
    if (prios > shown) taskSvg.append(s('text', { x: W - 8, y: 20, class: 'fr-ax', 'text-anchor': 'end' }, `showing priorities 0-${shown - 1} of ${prios}`));
    const n = V.tasks.filter((t) => !t.system).length;
    taskSub.textContent = `${n} tasks + IDLE${V.tasks.some((t) => t.name === 'Tmr Svc' && t.system) ? ' + Tmr Svc' : ''} · configMAX_PRIORITIES ${prios} · dark end = saved context`;
    if (wantFocus) refocus(taskSvg);
  }
  function drawTaskEd() {
    taskEd.replaceChildren();
    const rows = ctx.raw.tasks || [];
    if (selTask == null || !rows[selTask]) { taskEd.append(h('span', { class: 'fr-sub' }, 'Click a task to edit its name, stack and FPU use.')); return; }
    const r = rows[selTask];
    const upd = (k, v) => { const x = rows.map((y) => ({ ...y })); x[selTask][k] = v; ctx.set('tasks', x); };
    const inp = (k, label, w) => { const el = h('input', { type: 'text', spellcheck: 'false', style: w ? `width:${w}px` : null, oninput: (e) => upd(k, e.target.value) }); el.value = r[k] ?? ''; return h('label', {}, label, el); };
    const fpu = h('input', { type: 'checkbox', onchange: (e) => upd('fpu', e.target.checked ? 'yes' : 'no') });
    fpu.checked = /^y/i.test(String(r.fpu || ''));
    taskEd.append(inp('name', 'Name', 130), inp('stack', 'Stack words', 70), inp('priority', 'Priority', 50), h('label', { class: 'chk' }, fpu, 'Uses FPU'),
      h('button', { class: 'k-btn', type: 'button', onclick: () => { const x = rows.map((y) => ({ ...y })); x.splice(selTask, 1); selTask = null; ctx.set('tasks', x); } }, 'Remove'));
  }

  // ================= NVIC =================
  function setIsr(i, patch) { const rows = ctx.raw.isrs.map((x) => ({ ...x })); Object.assign(rows[i], patch); ctx.set('isrs', rows); }
  function drawIsrs() {
    isrSvg.replaceChildren();
    const N = V.nvic;
    const W = Math.max(280, isrCard.clientWidth - 2 || 500);
    const levels = Math.min(N.levels, 32);
    const rowH = levels > 16 ? 18 : 24, LW = 84, T = 8;
    const H = T + levels * rowH + 26;
    isrSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); isrSvg.setAttribute('height', H);
    const Y = (p) => T + p * rowH;
    const sys = frozenIsr != null ? frozenIsr : N.syscall;
    for (let p = 0; p < levels; p++) {
      const zone = N.basepri ? (p < sys ? 'fast' : 'api') : 'api';
      isrSvg.append(s('rect', { x: 0, y: Y(p), width: W, height: rowH, class: `fr-lvl ${zone}` }));
      isrSvg.append(s('text', { x: 6, y: Y(p) + rowH / 2 + 4, class: 'fr-ax' }, `${p}`));
      isrSvg.append(s('text', { x: 28, y: Y(p) + rowH / 2 + 4, class: 'fr-ax soft' }, `0x${((p << N.shift) & 0xFF).toString(16).toUpperCase().padStart(2, '0')}`));
    }
    // kernel priority (PendSV, SysTick)
    const ky = Y(N.lowest);
    isrSvg.append(s('text', { x: W - 8, y: ky + rowH / 2 + 4, class: 'fr-ax', 'text-anchor': 'end' }, 'PendSV · SysTick (kernel)'));
    // the ISRs
    const byP = new Map();
    for (const i of V.isrs) { const p = Math.min(i.prio, levels - 1); if (!byP.has(p)) byP.set(p, []); byP.get(p).push(i); }
    for (const [p, list] of byP) {
      let x = LW;
      for (const it of list) {
        const w = Math.min(W - x - 8, Math.max(90, it.name.length * 6.7 + 50));
        if (w < 40) break;
        const y = Y(p) + 2, hh = rowH - 4;
        const g = s('g', { class: `fr-isr ${it.status} ${selIsr === it.row ? 'sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${it.name}, priority ${it.prio}, ${it.calls ? 'calls' : 'does not call'} FromISR${it.issues.length ? ', ' + it.issues.join('; ') : ''}` });
        track(g, `isr-${it.row}`);
        g.append(title(s('rect', { x, y, width: w, height: hh, rx: 3, class: 'body ring' }), `${it.name}: priority ${it.prio} (NVIC byte 0x${it.raw.toString(16).toUpperCase()})\n${it.issues.join('\n') || (it.status === 'fast' ? 'Above the kernel: never masked, must not call the API' : 'Masked by critical sections; may call FromISR')}`));
        const nm = it.name.length * 6.7 > w - 46 ? it.name.slice(0, Math.max(2, Math.floor((w - 52) / 6.7))) + '…' : it.name;
        g.append(s('text', { x: x + 5, y: y + hh / 2 + 4, class: 'fr-cl' }, nm));
        const tag = s('g', { class: `api ${it.calls ? 'on' : ''}` });
        tag.append(s('rect', { x: x + w - 36, y: y + 2, width: 32, height: hh - 4, rx: 2 }));
        tag.append(s('text', { x: x + w - 20, y: y + hh / 2 + 3.5, 'text-anchor': 'middle' }, 'API'));
        title(tag, it.calls ? 'Calls FromISR functions (click to toggle)' : 'Does not call the RTOS (click to toggle)');
        g.append(tag);
        isrSvg.append(g);
        tag.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
        tag.addEventListener('click', (e) => { e.stopPropagation(); wantFocus = true; focusId = `isr-${it.row}`; setIsr(it.row, { fromIsr: it.calls ? 'no' : 'yes' }); });
        g.addEventListener('pointerdown', (e) => {
          e.preventDefault(); wantFocus = true; g.focus({ preventScroll: true });
          if (selIsr !== it.row) { selIsr = it.row; drawIsrEd(); }
          const y0 = svgY(isrSvg, e);
          let moved = false;
          drag(g, e, (m) => { const dy = svgY(isrSvg, m) - y0; if (Math.abs(dy) > 4) moved = true; g.setAttribute('transform', `translate(0 ${dy})`); },
            (u) => {
              g.removeAttribute('transform');
              if (moved) { const p2 = Math.max(0, Math.min(N.lowest, Math.floor((svgY(isrSvg, u) - T) / rowH))); if (p2 !== it.prio) { setIsr(it.row, { priority: String(p2) }); return; } }
              drawIsrs();
            });
        });
        g.addEventListener('keydown', (e) => {
          wantFocus = true;
          if (e.key === 'ArrowUp') { e.preventDefault(); setIsr(it.row, { priority: String(Math.max(0, it.prio - 1)) }); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setIsr(it.row, { priority: String(Math.min(N.lowest, it.prio + 1)) }); }
          else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setIsr(it.row, { fromIsr: it.calls ? 'no' : 'yes' }); }
          else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const rows = ctx.raw.isrs.map((x) => ({ ...x })); rows.splice(it.row, 1); selIsr = null; focusId = null; ctx.set('isrs', rows); }
        });
        x += w + 6;
      }
    }
    // the syscall line
    if (N.basepri) {
      const ly = Y(sys);
      const hd = s('g', { class: 'fr-sys', tabindex: 0, role: 'slider', 'aria-label': 'configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY', 'aria-valuenow': sys });
      track(hd, 'syscall');
      hd.append(s('rect', { x: 0, y: ly - 7, width: W, height: 14, fill: 'transparent' }));
      hd.append(s('line', { x1: 0, x2: W, y1: ly, y2: ly, class: 'line ring' }));
      const lab = W < 460 ? `SYSCALL ${sys}` : `configMAX_SYSCALL ${sys} (0x${((sys << N.shift) & 0xFF).toString(16).toUpperCase()})`;
      hd.append(s('rect', { x: W - lab.length * 6.3 - 18, y: ly - 9, width: lab.length * 6.3 + 12, height: 18, rx: 3, class: 'tag' }));
      hd.append(s('text', { x: W - 12, y: ly + 4, class: 'fr-tagt', 'text-anchor': 'end' }, lab));
      isrSvg.append(hd);
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault(); wantFocus = true; hd.focus({ preventScroll: true });
        drag(hd, e, (m) => { const p = Math.max(1, Math.min(N.lowest, Math.round((svgY(isrSvg, m) - T) / rowH))); if (p !== frozenIsr) { frozenIsr = p; raf(() => ctx.set('maxSyscall', String(p))); } },
          () => { frozenIsr = null; drawIsrs(); });
      });
      hd.addEventListener('keydown', (e) => {
        wantFocus = true;
        if (e.key === 'ArrowUp') { e.preventDefault(); ctx.set('maxSyscall', String(Math.max(1, sys - 1))); }
        if (e.key === 'ArrowDown') { e.preventDefault(); ctx.set('maxSyscall', String(Math.min(N.lowest, sys + 1))); }
      });
    }
    const fy = T + levels * rowH + 16;
    isrSvg.append(s('text', { x: 6, y: fy, class: 'fr-ax' }, N.basepri ? (W < 460 ? 'above: no RTOS calls · below: FromISR ok' : 'above the line: never masked, no RTOS calls · below: FromISR ok') : 'Armv6-M: no BASEPRI - critical sections mask every interrupt'));
    isrSub.textContent = N.basepri ? `${N.bits} priority bits · value << ${N.shift} in the NVIC byte` : 'ARM_CM0: PRIMASK only';
    if (wantFocus) refocus(isrSvg);
  }
  function drawIsrEd() {
    isrEd.replaceChildren();
    const rows = ctx.raw.isrs || [];
    if (selIsr == null || !rows[selIsr]) { isrEd.append(h('span', { class: 'fr-sub' }, 'Click an ISR to rename it.')); return; }
    const r = rows[selIsr];
    const el = h('input', { type: 'text', spellcheck: 'false', style: 'width:180px', oninput: (e) => setIsr(selIsr, { name: e.target.value }) }); el.value = r.name ?? '';
    const pr = h('input', { type: 'text', spellcheck: 'false', style: 'width:50px', oninput: (e) => setIsr(selIsr, { priority: e.target.value }) }); pr.value = r.priority ?? '';
    isrEd.append(h('label', {}, 'Name', el), h('label', {}, 'Priority', pr),
      h('button', { class: 'k-btn', type: 'button', onclick: () => { const x = rows.map((y) => ({ ...y })); x.splice(selIsr, 1); selIsr = null; ctx.set('isrs', x); } }, 'Remove'));
  }

  function syncSettings() {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement === el) continue;
      if (el.type === 'checkbox') el.checked = !!raw[k];
      else el.value = raw[k] ?? '';
    }
    fields.timerQueueLength.disabled = !raw.useTimers;
  }

  let lastW = 0;
  const redraw = () => { if (!V) return; drawHeap(); drawTasks(); drawIsrs(); };
  new ResizeObserver(() => { const w = wrap.clientWidth; if (w !== lastW) { lastW = w; redraw(); } }).observe(wrap);

  ctx.onResult((result) => {
    res = result;
    V = res && res.view;
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    if (!V) return;
    drawHeap(); drawObjects(); drawTasks(); drawTaskEd(); drawIsrs(); drawIsrEd(); syncSettings();
    if (wantFocus && focusId) {
      const el = wrap.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    }
    wantFocus = false;
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((n) => h('div', {}, n)));
    notes.hidden = !(res.notes || []).length;
  });
}
