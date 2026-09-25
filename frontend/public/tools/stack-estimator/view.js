// Stack Usage Estimator page: the stack itself.
//   Call tree  - every call from the entry as an indented tree; next to each
//                function its frame drawn on a shared byte axis, starting where
//                its caller's frames end - the row that reaches furthest right
//                is the deepest path. Drag the end of a frame (or press the
//                arrow keys on a row) to change its size; click a row to edit
//                the function, its calls, or add a callee.
//   Stack      - the memory region to scale, growing down from the top: the
//                deepest path, then one exception frame + handler for every
//                interrupt level that can nest, the margin, and the
//                recommended size. Drag the bottom line to set the margin.
//   Priorities - the interrupt levels as a ladder (0 = highest on top). Drag
//                a handler to another level; handlers that share a level
//                cannot nest, so only the largest one there counts.
// Every byte count drawn comes from run()'s result.stack.

const NS = 'http://www.w3.org/2000/svg';
const ARCHS = [['cm', 'Cortex-M'], ['cmfpu', 'M4F/M7 + FPU'], ['avr', 'AVR'], ['riscv', 'RISC-V']];

const CSS = `
:root { --tool-main: #2458c6; --tool-irq: #c26a00; --tool-mg: #2f855a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-main: #7d9bff; --tool-irq: #f0a33a; --tool-mg: #68b36b; } }
:root[data-theme="dark"] { --tool-main: #7d9bff; --tool-irq: #f0a33a; --tool-mg: #68b36b; }
.k-page { padding: 10px 12px 14px; }
.se { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.se svg text { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.se .halo { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.se-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.se-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); }
.se-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.se-seg button + button { border-left: 1px solid var(--line); }
.se-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
.se-fld { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.se-fld input, .se-fld select, .se-ed input { padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.se-fld input { width: 52px; text-align: right; }
.se-fld select { max-width: 190px; }
.se-sum { margin-left: auto; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.se-sum b { color: var(--ink); font-weight: 600; }
.se-sum .m { color: var(--tool-main); } .se-sum .i { color: var(--tool-irq); }
.se-sum .r { color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--tool-mg); border-radius: 4px; padding: 1px 7px; }
.se-sum .r.lb { border-left-color: var(--warn); }
.se-grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px 224px; gap: 10px; align-items: stretch; }
.se-pane { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; display: flex; flex-direction: column; }
.se-pane h2 { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--ink-soft); padding: 6px 10px 4px; display: flex; gap: 8px; align-items: baseline; }
.se-pane h2 span { margin-left: auto; font-size: 11px; font-weight: 400; }
.se-tree { overflow-y: auto; min-height: 0; height: clamp(360px, calc(100vh - 250px), 760px); }
.se-colw, .se-ladw { height: clamp(360px, calc(100vh - 250px), 760px); min-height: 0; }
.se-tree svg, .se-colw svg, .se-ladw svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.se-colw svg, .se-ladw svg { height: 100%; }
.se-ed { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); }
.se-ed label { display: inline-flex; align-items: center; gap: 5px; }
.se-ed .nm { width: 170px; } .se-ed .fr { width: 60px; text-align: right; } .se-ed .cl { width: 260px; }
.se-ed .src { font-size: 11px; }
.se-btn { padding: 2px 9px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; font-size: 12px; }
.se-btn:hover { border-color: var(--ink-soft); }
.se .row { cursor: pointer; outline: none; }
.se .row:hover .bg { fill: var(--sunken); }
.se .row:focus-visible .bg { fill: none; stroke: var(--accent); stroke-width: 2; }
.se .row.sel .bg { fill: var(--sunken); }
.se .grip { cursor: ew-resize; }
.se .knob { cursor: ns-resize; outline: none; }
.se .knob:focus-visible .kc { stroke: var(--accent); stroke-width: 3; }
.se .chip { cursor: grab; outline: none; }
.se .chip:focus-visible .cb { stroke: var(--accent); stroke-width: 2.5; }
.se .dragging, .se .dragging * { cursor: grabbing !important; }
.se .x { cursor: pointer; }
.se .x:hover { fill: var(--danger); }
.se-add { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); }
.se-add select { flex: 1; min-width: 0; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.se-bot { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 10px; align-items: start; }
.se-su textarea { width: 100%; display: block; border: 0; border-top: 1px solid var(--line-soft); background: var(--sunken); resize: vertical;
  font: 12px/1.4 "IBM Plex Mono", ui-monospace, monospace; padding: 6px 10px; border-radius: 0 0 6px 6px; }
.se-msgs { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.se-msgs:empty { display: none; }
.se-msgs div { padding: 5px 9px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); }
.se-msgs div.note { border-left-color: var(--line); color: var(--ink-soft); }
.se-left { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
@media (max-width: 1180px) {
  .se-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .se-grid > .se-tp { grid-column: 1 / -1; }
  .se-tree { height: auto; max-height: 560px; }
}
@media (max-width: 1180px) and (min-width: 721px) { .se-colw, .se-ladw { height: 480px; } }
@media (max-width: 720px) {
  .se-grid, .se-bot { grid-template-columns: minmax(0, 1fr); }
  .se-colw { height: 440px; } .se-ladw { height: 400px; }
  .se-sum { margin-left: 0; }
  .se-ed .nm, .se-ed .cl { width: 100%; } .se-ed label { flex-wrap: wrap; width: 100%; }
}
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const hex = (n) => '0x' + n.toString(16).toUpperCase();
const niceStep = (span, n) => { const r = span / n, p = 10 ** Math.floor(Math.log10(r)); return [1, 2, 4, 5, 10].map((k) => k * p).find((k) => k >= r) || 10 * p; };

export function page(root, ctx) {
  document.head.append(h('style', { text: CSS }));
  let res = null, S = null, sel = null, drag = null, frozen = null, focusKey = null;

  // ---------- toolbar ----------
  const seg = h('div', { class: 'se-seg', role: 'group', 'aria-label': 'Architecture' });
  const entrySel = h('select', { 'aria-label': 'Entry function', onchange: () => ctx.set('entry', entrySel.value) });
  const marginIn = h('input', { inputmode: 'decimal', 'aria-label': 'Safety margin in percent', onchange: () => ctx.set('margin', marginIn.value.trim()) });
  const sum = h('div', { class: 'se-sum', 'aria-live': 'polite' });
  const top = h('div', { class: 'se-top' }, seg, h('label', { class: 'se-fld' }, 'Entry', entrySel), h('label', { class: 'se-fld' }, 'Margin', marginIn, '%'), sum);

  // ---------- panes ----------
  const tsvg = document.createElementNS(NS, 'svg');
  tsvg.setAttribute('role', 'group');
  tsvg.setAttribute('aria-label', 'Call tree with frame sizes on a byte axis');
  const treeWrap = h('div', { class: 'se-tree' }, tsvg);
  const treeHead = h('span');
  const editor = h('div', { class: 'se-ed' });
  const treePane = h('section', { class: 'se-pane se-tp' }, h('h2', {}, 'Call tree · each frame drawn where its caller\'s end, in bytes of stack', treeHead), treeWrap, editor);

  const csvg = document.createElementNS(NS, 'svg');
  csvg.setAttribute('role', 'group');
  const colWrap = h('div', { class: 'se-colw' }, csvg);
  const colPane = h('section', { class: 'se-pane' }, h('h2', {}, 'Stack, to scale', h('span', {}, 'grows down')), colWrap);

  const lsvg = document.createElementNS(NS, 'svg');
  lsvg.setAttribute('role', 'group');
  lsvg.setAttribute('aria-label', 'Interrupt priority levels');
  const ladWrap = h('div', { class: 'se-ladw' }, lsvg);
  const addSel = h('select', { 'aria-label': 'Add an interrupt handler' });
  const addBtn = h('button', { class: 'se-btn', onclick: () => { if (addSel.value) addIsr(addSel.value); } }, 'Add');
  const ladPane = h('section', { class: 'se-pane' }, h('h2', {}, 'Interrupt priorities', h('span', {}, '0 = highest')), ladWrap, h('div', { class: 'se-add' }, 'Handler', addSel, addBtn));

  const suIn = h('textarea', { rows: 6, spellcheck: 'false', placeholder: 'cat build/*.su   (GCC -fstack-usage)', 'aria-label': '.su data' });
  suIn.addEventListener('input', () => ctx.set('su', suIn.value));
  const suCount = h('span');
  const suPane = h('section', { class: 'se-pane se-su' }, h('h2', {}, 'GCC .su data (frames for functions left blank)', suCount), suIn);
  const msgs = h('div', { class: 'se-msgs', 'aria-live': 'polite' });
  root.append(h('div', { class: 'se' }, top, h('div', { class: 'se-grid' }, treePane, colPane, ladPane),
    h('div', { class: 'se-bot' }, h('div', { class: 'se-left' }, suPane, msgs), ctx.outputs)));

  // ---------- input edits ----------
  const table = () => (ctx.raw.funcs || []).map((r) => ({ ...r }));
  const isrTable = () => (ctx.raw.isrs || []).map((r) => ({ ...r }));
  const rowOf = (t, name) => t.findIndex((r) => String(r.name ?? '').trim() === name);
  function setFrame(name, v) {
    const t = table(), i = rowOf(t, name);
    if (i >= 0) t[i].frame = String(v); else t.push({ name, frame: String(v), calls: '' });
    ctx.set('funcs', t);
  }
  function setLevel(name, lv) {
    const t = isrTable(), i = rowOf(t, name);
    if (i >= 0) t[i].level = String(lv); else t.push({ name, level: String(lv) });
    ctx.set('isrs', t);
  }
  function addIsr(name) { const t = isrTable(); if (rowOf(t, name) < 0) t.push({ name, level: '0' }); ctx.set('isrs', t); }
  function removeIsr(name) { ctx.set('isrs', isrTable().filter((r) => String(r.name ?? '').trim() !== name)); }
  const nodeOf = (name) => S?.nodes.find((n) => n.name === name);

  // ---------- toolbar sync ----------
  function syncTop() {
    const raw = ctx.raw;
    seg.replaceChildren(...ARCHS.map(([v, t]) => h('button', { 'aria-pressed': String((raw.arch || 'cm') === v), onclick: () => ctx.set('arch', v) }, t)));
    const names = S ? S.nodes.map((n) => n.name) : [];
    const cur = String(raw.entry ?? '').trim() || 'main';
    if (!names.includes(cur)) names.unshift(cur);
    entrySel.replaceChildren(...names.map((n) => h('option', { value: n, selected: n === cur }, n)));
    if (document.activeElement !== marginIn) marginIn.value = raw.margin ?? '';
    if (document.activeElement !== suIn) suIn.value = raw.su ?? '';
    const suLines = String(raw.su ?? '').split('\n').filter((l) => l.trim()).length;
    suCount.textContent = suLines ? `${suLines} line${suLines > 1 ? 's' : ''}` : 'empty';
    if (!S) { sum.replaceChildren(h('b', {}, 'no result')); return; }
    sum.replaceChildren(
      h('span', {}, 'path ', h('b', { class: 'm' }, S.main.bytes)),
      h('span', {}, '+ interrupts ', h('b', { class: 'i' }, S.isrSum)),
      h('span', {}, '= ', h('b', {}, (S.lowerBound ? '≥ ' : '') + S.total), ' B'),
      h('span', {}, `+${S.margin} %`),
      h('span', { class: `r${S.lowerBound ? ' lb' : ''}` }, 'stack ', h('b', {}, S.recommended), ' B  ', hex(S.recommended)));
    // handler list for Add
    const isrNames = new Set(S.isrs.map((i) => i.name));
    const cand = S.nodes.map((n) => n.name).filter((n) => !isrNames.has(n) && n !== S.entry)
      .sort((a, b) => (/Handler|IRQ|ISR|_isr|vect/i.test(b) - /Handler|IRQ|ISR|_isr|vect/i.test(a)) || a.localeCompare(b));
    addSel.replaceChildren(...cand.map((n) => h('option', { value: n }, n)));
    addBtn.disabled = !cand.length;
  }

  // ---------- call tree ----------
  function treeRows() {
    const rows = [];
    const map = new Map(S.nodes.map((n) => [n.name, n]));
    const walk = (name, depth, start, anc, pathArr, pathIdx, section, parent) => {
      const node = map.get(name);
      const rec = anc.includes(name);
      const onPath = pathArr && pathArr[pathIdx]?.name === name;
      const row = { name, depth, start, frame: node?.frame ?? null, known: !!node, rec, onPath, section, parent, worst: node?.worst ?? 0 };
      rows.push(row);
      if (rec || !node || rows.length > 160) { row.leafCut = !!(node && node.calls.length && rows.length > 160); return; }
      let pathTaken = false;
      for (const c of node.calls) {
        const take = onPath && !pathTaken && pathArr[pathIdx + 1]?.name === c;
        if (take) pathTaken = true;
        walk(c, depth + 1, start + (node.frame ?? 0), [...anc, name], take ? pathArr : null, pathIdx + 1, section, row);
      }
    };
    walk(S.entry, 0, 0, [], S.main.path, 0, 'main', null);
    const irqs = [...S.isrs].sort((a, b) => a.level - b.level);
    for (const i of irqs) walk(i.name, 0, S.excFrame, [], i.path, 0, i, null);
    // functions nothing reaches
    const seen = new Set(rows.map((r) => r.name));
    const orphans = S.nodes.filter((n) => !seen.has(n.name)).map((n) => n.name);
    return { rows, orphans };
  }

  function renderTree() {
    if (!S) { tsvg.innerHTML = ''; return; }
    const W = Math.max(300, treeWrap.clientWidth);
    const { rows, orphans } = treeRows();
    const narrow = W < 560;
    const RH = 23, headH = 26;
    const nameW = Math.min(narrow ? 150 : 250, Math.max(130, W * 0.3));
    const valX = nameW + 40;
    const x0 = valX + 10, x1 = W - 14;
    const maxB = frozen?.maxB || Math.max(16, S.main.bytes, ...S.isrs.map((i) => i.total)) * 1.06;
    const sc = (x1 - x0) / maxB;
    const X = (b) => x0 + b * sc;
    const o = [];
    // axis
    const step = niceStep(maxB, narrow ? 3 : 7);
    let y = headH;
    const sections = [];
    let lastSec = null;
    rows.forEach((r) => {
      if (r.section !== lastSec) {
        if (r.section !== 'main' && lastSec === 'main') { sections.push({ y, label: 'Interrupt handlers, each on top of its exception frame' }); y += 24; }
        lastSec = r.section;
      }
      r.y = y; y += RH;
    });
    if (orphans.length) y += 30;
    const H = y + 8;
    tsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    tsvg.setAttribute('height', H);
    for (let b = 0; b <= maxB; b += step) {
      o.push(`<line x1="${X(b)}" y1="${headH - 6}" x2="${X(b)}" y2="${H - (orphans.length ? 34 : 4)}" stroke="var(--line-soft)" stroke-width="1"/>`);
      o.push(`<text x="${X(b)}" y="${headH - 10}" font-size="10" text-anchor="middle" fill="var(--ink-soft)">${b}</text>`);
    }
    o.push(`<text x="8" y="${headH - 10}" font-size="10" fill="var(--ink-soft)">function</text><text x="${valX}" y="${headH - 10}" font-size="10" text-anchor="end" fill="var(--ink-soft)">frame</text>`);
    for (const s of sections) {
      o.push(`<line x1="0" y1="${s.y + 4}" x2="${W}" y2="${s.y + 4}" stroke="var(--line)"/>`);
      o.push(`<text x="8" y="${s.y + 18}" font-size="10.5" fill="var(--tool-irq)">${esc(s.label)}</text>`);
    }
    // deepest-path marker
    const deep = X(S.main.bytes);
    const mainRows = rows.filter((r) => r.section === 'main');
    if (mainRows.length) {
      const yb = mainRows[mainRows.length - 1].y + RH;
      o.push(`<line x1="${deep}" y1="${headH - 4}" x2="${deep}" y2="${yb}" stroke="var(--tool-main)" stroke-width="1.2" stroke-dasharray="4 3"/>`);
      o.push(`<text x="${Math.min(deep + 4, x1 - 2)}" y="${headH + 9}" font-size="10.5" font-weight="600" text-anchor="${deep > x1 - 90 ? 'end' : 'start'}" class="halo" fill="var(--tool-main)">${S.lowerBound ? '≥ ' : ''}${S.main.bytes} B deepest</text>`);
    }
    // connectors
    const indent = narrow ? 11 : 14;
    const ix = (d) => 10 + d * indent;
    for (const r of rows) {
      if (!r.parent) continue;
      const px = ix(r.parent.depth) + 3, py = r.parent.y + RH / 2 + 5;
      const cy = r.y + RH / 2;
      const hot = r.onPath && r.parent.onPath;
      o.push(`<path d="M${px},${py}V${cy}H${ix(r.depth) - 2}" fill="none" stroke="${hot ? (r.section === 'main' ? 'var(--tool-main)' : 'var(--tool-irq)') : 'var(--line)'}" stroke-width="${hot ? 1.6 : 1}"/>`);
    }
    // rows
    rows.forEach((r, k) => {
      const col = r.section === 'main' ? 'var(--tool-main)' : 'var(--tool-irq)';
      const cy = r.y + RH / 2;
      const unk = !r.known || r.frame == null;
      const key = `${k}:${r.name}`;
      const fr = r.frame ?? 0;
      const lab = clip(r.name, Math.floor((nameW - ix(r.depth) - 6) / 6.6));
      const counted = r.section === 'main' || r.section.nests;
      o.push(`<g class="row${sel === r.name ? ' sel' : ''}" data-k="${k}" data-key="${esc(key)}" data-name="${esc(r.name)}" tabindex="0" role="slider" aria-label="${esc(r.name)} frame, left and right arrows change it" aria-valuenow="${fr}" aria-valuetext="${unk ? 'unknown' : fr + ' bytes'}">`);
      o.push(`<rect class="bg" x="1" y="${r.y + 1}" width="${W - 2}" height="${RH - 2}" rx="3" fill="transparent"/>`);
      o.push(`<text x="${ix(r.depth)}" y="${cy + 4}" font-size="12" font-weight="${r.onPath ? 600 : 400}" fill="${r.rec ? 'var(--danger)' : unk ? 'var(--warn)' : r.onPath ? 'var(--ink)' : 'var(--ink-soft)'}">${esc(lab)}${r.rec ? ' ↻' : ''}</text>`);
      o.push(`<text x="${valX}" y="${cy + 4}" font-size="12" text-anchor="end" fill="${unk ? 'var(--warn)' : 'var(--ink)'}">${r.rec ? '↻' : unk ? '?' : fr}</text>`);
      // exception frame under an interrupt's root
      if (r.section !== 'main' && r.depth === 0) {
        o.push(`<rect x="${X(0)}" y="${r.y + 5}" width="${Math.max(1, S.excFrame * sc)}" height="${RH - 10}" fill="url(#se-hatch)" stroke="var(--tool-irq)" stroke-opacity="0.7"/>`);
        if (S.excFrame * sc > 30) o.push(`<text x="${X(S.excFrame / 2)}" y="${cy + 3.5}" font-size="9.5" text-anchor="middle" class="halo" fill="var(--tool-irq)">exc ${S.excFrame}</text>`);
      }
      // the frame bar
      const bx = X(r.start), bw = Math.max(unk ? 0 : 1.5, fr * sc);
      if (unk || r.rec) {
        o.push(`<line x1="${bx}" y1="${r.y + 4}" x2="${bx}" y2="${r.y + RH - 4}" stroke="${r.rec ? 'var(--danger)' : 'var(--warn)'}" stroke-width="2"/>`);
        o.push(`<text x="${bx + 6}" y="${cy + 4}" font-size="10.5" fill="${r.rec ? 'var(--danger)' : 'var(--warn)'}">${r.rec ? 'recursion: counted once' : 'no frame size: counted as 0'}</text>`);
      } else {
        o.push(`<rect x="${bx}" y="${r.y + 4}" width="${bw}" height="${RH - 8}" rx="2" fill="${col}" fill-opacity="${r.onPath && counted ? 0.55 : 0.2}" stroke="${col}" stroke-opacity="${r.onPath ? 1 : 0.55}"/>`);
        const end = r.start + fr;
        if (r.onPath && !rows.some((q) => q.parent === r && q.onPath)) {
          // leaf of a worst path: print where it ends
          const inside = bx + bw + 46 > W;
          o.push(`<text x="${inside ? bx + bw - 5 : bx + bw + 6}" y="${cy + 4}" font-size="10.5" text-anchor="${inside ? 'end' : 'start'}" class="halo" fill="${inside ? 'var(--ink)' : col}">${end} B</text>`);
        }
      }
      // grip at the frame's end
      if (!r.rec) {
        const gx = X(r.start + fr);
        o.push(`<g class="grip" data-k="${k}"><rect x="${gx - 7}" y="${r.y + 2}" width="14" height="${RH - 4}" fill="transparent"/>`
          + `<line x1="${gx}" y1="${r.y + 6}" x2="${gx}" y2="${r.y + RH - 6}" stroke="${unk ? 'var(--warn)' : col}" stroke-width="3" stroke-linecap="round"/></g>`);
      }
      o.push(`<title>${esc(`${r.name}: ${unk ? 'frame unknown' : fr + ' B'}; worst from here ${r.worst} B. Drag the end, or arrow keys.`)}</title></g>`);
    });
    if (orphans.length) {
      const oy = H - 22;
      o.push(`<text x="8" y="${oy}" font-size="10.5" fill="var(--ink-soft)">Not called from ${esc(S.entry)} or an interrupt: ${esc(clip(orphans.join(', '), Math.floor((W - 30) / 6.2) - 40))}</text>`);
    }
    tsvg.innerHTML = `<defs><pattern id="se-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--tool-irq)" stroke-width="1.6" stroke-opacity="0.6"/></pattern></defs>${o.join('')}`;
    tsvg._geo = { rows, sc, X, maxB };
    treeHead.textContent = `${rows.length} calls`;
    if (focusKey) { const f = tsvg.querySelector(`.row[data-key="${CSS_ESC(focusKey)}"]`); if (f) f.focus({ preventScroll: true }); }
  }
  const CSS_ESC = (s) => (window.CSS && window.CSS.escape ? window.CSS.escape(s) : s.replace(/"/g, '\\"'));

  // ---------- editor for the selected function ----------
  function renderEditor() {
    if (!S) { editor.replaceChildren(); return; }
    if (!sel) {
      editor.replaceChildren(h('span', {}, 'Click a function to edit its frame and calls. Drag a frame\'s end to resize it.'),
        h('button', { class: 'se-btn', style: 'margin-left:auto', onclick: () => addFunction(null) }, 'Add function'));
      return;
    }
    const t = table(), i = rowOf(t, sel);
    const n = nodeOf(sel);
    const nm = h('input', { class: 'nm', value: sel, spellcheck: 'false', 'aria-label': 'Function name' });
    const fr = h('input', { class: 'fr', inputmode: 'numeric', value: i >= 0 ? t[i].frame ?? '' : '', placeholder: n?.frame != null ? String(n.frame) : '?', 'aria-label': 'Frame bytes' });
    const cl = h('input', { class: 'cl', spellcheck: 'false', value: i >= 0 ? t[i].calls ?? '' : (n?.calls || []).join(' '), placeholder: 'callee callee …', 'aria-label': 'Calls' });
    nm.addEventListener('change', () => {
      const v = nm.value.trim(); if (!v || v === sel) return;
      const re = new RegExp(`(^|[\\s,;])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,;(])`, 'g');
      const tt = table().map((r) => ({ ...r, calls: String(r.calls ?? '').replace(re, `$1${v}`) }));
      const k = rowOf(tt, sel);
      if (k >= 0) tt[k].name = v; else tt.push({ name: v, frame: fr.value.trim(), calls: cl.value.trim() });
      const is = isrTable().map((r) => (String(r.name ?? '').trim() === sel ? { ...r, name: v } : r));
      const entry = String(ctx.raw.entry ?? '').trim() === sel ? v : ctx.raw.entry;
      sel = v; ctx.setMany({ funcs: tt, isrs: is, entry });
    });
    fr.addEventListener('change', () => {
      const tt = table(), k = rowOf(tt, sel);
      if (k >= 0) tt[k].frame = fr.value.trim(); else tt.push({ name: sel, frame: fr.value.trim(), calls: cl.value.trim() });
      ctx.set('funcs', tt);
    });
    cl.addEventListener('change', () => {
      const tt = table(), k = rowOf(tt, sel);
      if (k >= 0) tt[k].calls = cl.value.trim(); else tt.push({ name: sel, frame: '', calls: cl.value.trim() });
      ctx.set('funcs', tt);
    });
    const src = i >= 0 ? (String(t[i].frame ?? '').trim() === '' && n?.frame != null ? `frame from .su: ${n.frame} B` : '') : n ? (n.frame != null ? `from .su: ${n.frame} B` : '') : 'not in the table';
    editor.replaceChildren(
      h('label', {}, 'Function', nm), h('label', {}, 'Frame', fr, 'B'), h('label', {}, 'Calls', cl),
      n ? h('span', { class: 'src' }, `worst from here ${n.worst} B${src ? ' · ' + src : ''}`) : h('span', { class: 'src' }, src),
      h('span', { style: 'margin-left:auto;display:inline-flex;gap:6px' },
        h('button', { class: 'se-btn', onclick: () => addFunction(sel) }, 'Add callee'),
        i >= 0 ? h('button', { class: 'se-btn', onclick: () => { const tt = table(); tt.splice(rowOf(tt, sel), 1); sel = null; ctx.set('funcs', tt); } }, 'Remove') : null,
        h('button', { class: 'se-btn', onclick: () => { sel = null; renderAll(); } }, 'Done')));
  }
  function addFunction(parent) {
    const tt = table();
    let n = 1; while (tt.some((r) => r.name === `func${n}`) || nodeOf(`func${n}`)) n++;
    const name = `func${n}`;
    tt.push({ name, frame: '16', calls: '' });
    if (parent) {
      const k = rowOf(tt, parent);
      if (k >= 0) tt[k].calls = `${String(tt[k].calls ?? '').trim()} ${name}`.trim();
      else tt.push({ name: parent, frame: '', calls: name });
    }
    sel = name;
    ctx.set('funcs', tt);
  }

  // ---------- stack column ----------
  function renderColumn() {
    if (!S) { csvg.innerHTML = ''; return; }
    const W = Math.max(200, colWrap.clientWidth), H = Math.max(260, colWrap.clientHeight);
    csvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const y0 = 30, yEnd = H - 46;
    const full = frozen?.full || Math.max(S.recommended, S.total, 8);
    const sc = (yEnd - y0) / full;
    const Y = (b) => y0 + b * sc;
    const bx = 40, bw = Math.min(78, W * 0.3);
    const lx = bx + bw + 12;
    const o = [];
    o.push(`<defs><pattern id="se-hatch2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--tool-irq)" stroke-width="1.6" stroke-opacity="0.6"/></pattern>`
      + `<pattern id="se-mg" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--tool-mg)" stroke-width="1" stroke-opacity="0.5"/></pattern></defs>`);
    o.push(`<text x="${bx}" y="14" font-size="10.5" fill="var(--ink-soft)">top of stack (high address)</text>`);
    o.push(`<line x1="${bx - 6}" y1="${y0}" x2="${bx + bw + 6}" y2="${y0}" stroke="var(--ink)" stroke-width="1.5"/>`);
    // ruler
    const step = niceStep(full, 6);
    for (let b = 0; b <= full; b += step) {
      o.push(`<line x1="${bx - 5}" y1="${Y(b)}" x2="${bx}" y2="${Y(b)}" stroke="var(--ink-soft)"/>`);
      o.push(`<text x="${bx - 8}" y="${Y(b) + 3.5}" font-size="9.5" text-anchor="end" fill="var(--ink-soft)">${b}</text>`);
    }
    // blocks
    const blocks = [];
    let at = 0;
    S.main.path.forEach((p, k) => { blocks.push({ a: at, b: at + (p.frame ?? 0), label: p.name, v: p.frame, col: 'var(--tool-main)', op: k % 2 ? 0.34 : 0.5 }); at += p.frame ?? 0; });
    const nests = S.isrs.filter((i) => i.nests).sort((a, b) => b.level - a.level);
    for (const i of nests) {
      blocks.push({ a: at, b: at + S.excFrame, label: `exception frame`, v: S.excFrame, col: 'var(--tool-irq)', hatch: true, head: `level ${i.level}` });
      at += S.excFrame;
      i.path.forEach((p, k) => { blocks.push({ a: at, b: at + (p.frame ?? 0), label: p.name, v: p.frame, col: 'var(--tool-irq)', op: k % 2 ? 0.3 : 0.46 }); at += p.frame ?? 0; });
    }
    for (const bl of blocks) {
      const ya = Y(bl.a), hgt = Math.max(bl.b > bl.a ? 1 : 0, (bl.b - bl.a) * sc);
      if (hgt <= 0) continue;
      o.push(`<rect x="${bx}" y="${ya}" width="${bw}" height="${hgt}" fill="${bl.hatch ? 'url(#se-hatch2)' : bl.col}" fill-opacity="${bl.hatch ? 1 : bl.op}" stroke="${bl.col}" stroke-width="0.8"/>`);
    }
    // labels with leaders, pushed apart
    const lab = blocks.filter((b) => b.b > b.a || b.v == null).map((b) => ({ ...b, y: Y((b.a + b.b) / 2) + 3.5 }));
    const gap = 12;
    for (let k = 1; k < lab.length; k++) lab[k].y = Math.max(lab[k].y, lab[k - 1].y + gap);
    const maxY = Y(S.total) - 4;
    for (let k = lab.length - 1; k >= 0; k--) { const lim = k === lab.length - 1 ? maxY : lab[k + 1].y - gap; if (lab[k].y > lim) lab[k].y = lim; }
    const room = Math.floor((W - lx - 4) / 6.1);
    for (const l of lab) {
      const my = Y((l.a + l.b) / 2);
      o.push(`<path d="M${bx + bw + 1},${my}H${bx + bw + 5}L${lx - 3},${l.y - 3.5}" fill="none" stroke="var(--line)" stroke-width="1"/>`);
      const txt = `${clip(l.label, Math.max(4, room - 5))} ${l.v ?? '?'}`;
      o.push(`<text x="${lx}" y="${l.y}" font-size="10.5" fill="${l.hatch ? 'var(--tool-irq)' : 'var(--ink)'}">${esc(txt)}</text>`);
    }
    // worst case line and margin
    const yT = Y(S.total), yR = Y(S.recommended);
    if (yR > yT) o.push(`<rect x="${bx}" y="${yT}" width="${bw}" height="${yR - yT}" fill="url(#se-mg)" stroke="var(--tool-mg)" stroke-opacity="0.6" stroke-dasharray="3 2"/>`);
    o.push(`<line x1="${bx - 6}" y1="${yT}" x2="${W - 6}" y2="${yT}" stroke="${S.lowerBound ? 'var(--warn)' : 'var(--ink)'}" stroke-width="1.2"/>`);
    o.push(`<text x="${W - 6}" y="${yT + 13}" font-size="10.5" font-weight="600" text-anchor="end" class="halo" fill="${S.lowerBound ? 'var(--warn)' : 'var(--ink)'}">${S.lowerBound ? 'at least ' : 'worst case '}${S.total} B</text>`);
    // recommended: the handle
    o.push(`<g class="knob" tabindex="0" role="slider" aria-label="Safety margin, drag the stack size line or use arrow keys" aria-valuenow="${S.margin}" aria-valuetext="${S.margin} percent, ${S.recommended} bytes">`
      + `<rect x="0" y="${yR - 9}" width="${W}" height="18" fill="transparent"/>`
      + `<line x1="${bx - 6}" y1="${yR}" x2="${W - 6}" y2="${yR}" stroke="var(--tool-mg)" stroke-width="2.4"/>`
      + `<path class="kc" d="M${bx - 16},${yR - 6}L${bx - 8},${yR}L${bx - 16},${yR + 6}Z" fill="var(--tool-mg)" stroke="var(--surface)" stroke-width="1"/>`
      + `<text x="${W - 6}" y="${yR + 15}" font-size="11.5" font-weight="600" text-anchor="end" class="halo" fill="var(--tool-mg)">${S.recommended} B · ${hex(S.recommended)}</text>`
      + `<text x="${bx}" y="${yR + 15}" font-size="10.5" class="halo" fill="var(--ink-soft)">+${S.margin} %</text>`
      + `<title>Drag to set the safety margin</title></g>`);
    o.push(`<text x="${bx}" y="${H - 8}" font-size="10" fill="var(--ink-soft)">_Min_Stack_Size = ${hex(S.recommended)};</text>`);
    csvg.innerHTML = o.join('');
    csvg.setAttribute('aria-label', `Stack to scale: deepest path ${S.main.bytes} bytes, interrupts ${S.isrSum} bytes, recommended ${S.recommended} bytes`);
    csvg._geo = { Y, sc, y0, full };
  }

  // ---------- priority ladder ----------
  function renderLadder() {
    if (!S) { lsvg.innerHTML = ''; return; }
    const W = Math.max(180, ladWrap.clientWidth), H = Math.max(240, ladWrap.clientHeight);
    lsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const maxLv = Math.max(15, ...S.isrs.map((i) => Math.ceil(i.level)));
    const minLv = Math.min(0, ...S.isrs.map((i) => Math.floor(i.level)));
    const n = maxLv - minLv + 1;
    const y0 = 8, rh = Math.max(14, Math.min(34, (H - y0 - 30) / n));
    const Y = (lv) => y0 + (lv - minLv) * rh;
    const lx = 30;
    const o = [];
    for (let lv = minLv; lv <= maxLv; lv++) {
      const y = Y(lv);
      o.push(`<rect x="${lx}" y="${y}" width="${W - lx - 4}" height="${rh}" fill="${lv % 2 ? 'transparent' : 'var(--sunken)'}" fill-opacity="0.6"/>`);
      if (rh >= 16 || lv % 5 === 0) o.push(`<text x="${lx - 6}" y="${y + rh / 2 + 3.5}" font-size="10" text-anchor="end" fill="var(--ink-soft)">${lv}</text>`);
    }
    const byLv = new Map();
    for (const i of S.isrs) { if (!byLv.has(i.level)) byLv.set(i.level, []); byLv.get(i.level).push(i); }
    // nesting chain: counted handlers, lowest priority first
    const chain = S.isrs.filter((i) => i.nests).sort((a, b) => b.level - a.level);
    if (chain.length > 1) {
      const pts = chain.map((i) => Y(i.level) + rh / 2);
      o.push(`<path d="M${lx + 6},${pts[0]}V${pts[pts.length - 1]}" stroke="var(--tool-irq)" stroke-width="1.4" stroke-dasharray="3 2"/>`);
      for (const p of pts.slice(1)) o.push(`<path d="M${lx + 2},${p + 5}L${lx + 6},${p}L${lx + 10},${p + 5}" fill="none" stroke="var(--tool-irq)" stroke-width="1.4"/>`);
    }
    const cx0 = lx + 16, cw0 = W - cx0 - 6;
    for (const [lv, list] of byLv) {
      const w = cw0 / list.length;
      list.forEach((i, k) => {
        const x = cx0 + k * w, y = Y(lv) + 1.5, ch = rh - 3;
        const dim = !i.nests;
        const room = Math.floor((w - 38) / 6.2);
        o.push(`<g class="chip" data-name="${esc(i.name)}" tabindex="0" role="slider" aria-label="${esc(i.name)} priority level, up and down arrows move it, Delete removes it" aria-valuenow="${i.level}">`
          + `<rect class="cb" x="${x + 1}" y="${y}" width="${w - 3}" height="${ch}" rx="3" fill="var(--tool-irq)" fill-opacity="${dim ? 0.08 : 0.26}" stroke="var(--tool-irq)" stroke-opacity="${dim ? 0.45 : 1}" ${dim ? 'stroke-dasharray="3 2"' : ''}/>`
          + (room >= 3 ? `<text x="${x + 6}" y="${y + ch / 2 + 3.5}" font-size="${ch < 16 ? 9.5 : 10.5}" fill="${dim ? 'var(--ink-soft)' : 'var(--ink)'}">${esc(clip(i.name.replace(/_IRQHandler$|_Handler$/, ''), room))}</text>` : '')
          + (w > 60 ? `<text x="${x + w - 18}" y="${y + ch / 2 + 3.5}" font-size="9.5" text-anchor="end" fill="${dim ? 'var(--ink-soft)' : 'var(--tool-irq)'}">${i.total}</text>` : '')
          + `<text class="x" data-x="${esc(i.name)}" x="${x + w - 8}" y="${y + ch / 2 + 3.5}" font-size="11" text-anchor="middle" fill="var(--ink-soft)">×</text>`
          + `<title>${esc(`${i.name}: level ${i.level}, ${i.bytes} B handler + ${S.excFrame} B exception frame = ${i.total} B${dim ? '. Shares its level with a larger handler, so it cannot nest on top of it and is not counted.' : ''}`)}</title></g>`);
      });
    }
    if (!S.isrs.length) o.push(`<text x="${W / 2}" y="${H / 2}" font-size="11" text-anchor="middle" fill="var(--ink-soft)">No interrupts: add a handler below</text>`);
    o.push(`<text x="${lx}" y="${H - 8}" font-size="10" fill="var(--ink-soft)">${S.isrs.length ? `${chain.length} level${chain.length === 1 ? '' : 's'} nest · ${S.isrSum} B` : ''}</text>`);
    lsvg.innerHTML = o.join('');
    lsvg._geo = { Y, rh, minLv, maxLv };
  }

  function renderMsgs() {
    const w = res?.warnings || [];
    msgs.replaceChildren(...w.map((t) => h('div', {}, t)), ...(res?.notes || []).slice(0, 1).map((t) => h('div', { class: 'note' }, t)));
  }

  function renderAll() {
    if (drag) return;
    syncTop(); renderTree(); renderEditor(); renderColumn(); renderLadder(); renderMsgs();
  }

  // ---------- interaction: tree ----------
  const svgPt = (svg, e) => { const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; return [(e.clientX - r.left) * (vb.width / r.width), (e.clientY - r.top) * (vb.height / r.height)]; };
  tsvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.grip'), row = e.target.closest('.row');
    if (!row || !S) return;
    const r = tsvg._geo.rows[Number(row.dataset.k)];
    focusKey = row.dataset.key;
    const px = svgPt(tsvg, e)[0];
    if (!g && !(px > tsvg._geo.X(r.start) - 2 && px < tsvg._geo.X(r.start + (r.frame ?? 0)) + 8)) {
      sel = r.name; renderTree(); renderEditor(); return;
    }
    if (r.rec) return;
    e.preventDefault();
    sel = r.name;
    drag = { kind: 'frame', name: r.name, x0: svgPt(tsvg, e)[0], f0: r.frame ?? 0, sc: tsvg._geo.sc, moved: false };
    frozen = { maxB: tsvg._geo.maxB, full: csvg._geo?.full };
    tsvg.classList.add('dragging');
    tsvg.setPointerCapture(e.pointerId);
  });
  tsvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.kind !== 'frame') return;
    const dx = svgPt(tsvg, e)[0] - drag.x0;
    const v = Math.max(0, Math.round((drag.f0 + dx / drag.sc) / 4) * 4);
    if (v !== drag.last) { drag.last = v; setFrame(drag.name, v); }
  });
  const endTree = () => {
    if (!drag || drag.kind !== 'frame') return;
    drag = null; frozen = null; tsvg.classList.remove('dragging'); renderAll();
  };
  tsvg.addEventListener('pointerup', endTree);
  tsvg.addEventListener('pointercancel', endTree);
  tsvg.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.row');
    if (!row || !S) return;
    const k = Number(row.dataset.k), r = tsvg._geo.rows[k];
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = tsvg.querySelector(`.row[data-k="${k + (e.key === 'ArrowUp' ? -1 : 1)}"]`);
      if (next) { next.focus(); focusKey = next.dataset.key; }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = r.name; renderEditor(); renderTree(); editor.querySelector('.fr')?.focus(); return; }
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || r.rec) return;
    e.preventDefault();
    focusKey = row.dataset.key;
    setFrame(r.name, Math.max(0, (r.frame ?? 0) + dir * (e.shiftKey ? 16 : 4)));
  });
  tsvg.addEventListener('focusout', () => { requestAnimationFrame(() => { if (!tsvg.contains(document.activeElement)) focusKey = null; }); });

  // ---------- interaction: margin handle ----------
  csvg.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.knob');
    if (!k || !S) return;
    e.preventDefault();
    k.focus({ preventScroll: true });
    drag = { kind: 'margin' };
    frozen = { full: csvg._geo.full, maxB: tsvg._geo?.maxB };
    csvg.classList.add('dragging');
    csvg.setPointerCapture(e.pointerId);
  });
  csvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.kind !== 'margin' || !S) return;
    const { y0, sc } = csvg._geo;
    const bytes = (svgPt(csvg, e)[1] - y0) / sc;
    const m = Math.max(0, Math.min(300, Math.round(((bytes / Math.max(1, S.total)) - 1) * 100 / 5) * 5));
    if (String(m) !== String(ctx.raw.margin)) {
      ctx.set('margin', String(m));
    }
  });
  const endCol = () => { if (!drag || drag.kind !== 'margin') return; drag = null; frozen = null; csvg.classList.remove('dragging'); renderAll(); csvg.querySelector('.knob')?.focus({ preventScroll: true }); };
  csvg.addEventListener('pointerup', endCol);
  csvg.addEventListener('pointercancel', endCol);
  csvg.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.knob') || !S) return;
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    ctx.set('margin', String(Math.max(0, S.margin + dir * 5)));
    requestAnimationFrame(() => csvg.querySelector('.knob')?.focus({ preventScroll: true }));
  });

  // ---------- interaction: ladder ----------
  lsvg.addEventListener('pointerdown', (e) => {
    const x = e.target.closest('.x');
    if (x) { removeIsr(x.dataset.x); return; }
    const c = e.target.closest('.chip');
    if (!c || !S) return;
    e.preventDefault();
    c.focus({ preventScroll: true });
    drag = { kind: 'level', name: c.dataset.name };
    lsvg.classList.add('dragging');
    lsvg.setPointerCapture(e.pointerId);
  });
  lsvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.kind !== 'level') return;
    const { minLv, maxLv, rh } = lsvg._geo;
    const y = svgPt(lsvg, e)[1];
    const lv = Math.max(minLv, Math.min(maxLv, Math.floor((y - 8) / rh) + minLv));
    const cur = S.isrs.find((i) => i.name === drag.name);
    if (cur && cur.level !== lv && drag.last !== lv) { drag.last = lv; setLevel(drag.name, lv); }
  });
  const endLad = () => {
    if (!drag || drag.kind !== 'level') return;
    const n = drag.name; drag = null; lsvg.classList.remove('dragging'); renderAll();
    lsvg.querySelector(`.chip[data-name="${CSS_ESC(n)}"]`)?.focus({ preventScroll: true });
  };
  lsvg.addEventListener('pointerup', endLad);
  lsvg.addEventListener('pointercancel', endLad);
  lsvg.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('.chip');
    if (!c || !S) return;
    const i = S.isrs.find((q) => q.name === c.dataset.name);
    if (!i) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeIsr(i.name); return; }
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    setLevel(i.name, Math.max(0, i.level + dir));
    requestAnimationFrame(() => lsvg.querySelector(`.chip[data-name="${CSS_ESC(i.name)}"]`)?.focus({ preventScroll: true }));
  });

  // ---------- result ----------
  ctx.onResult((r) => {
    res = r;
    S = r.stack || null;
    if (sel && S && !S.nodes.some((n) => n.name === sel) && !(ctx.raw.funcs || []).some((f) => String(f.name ?? '').trim() === sel)) {
      // an unknown callee stays selectable
      const called = S.nodes.some((n) => n.calls.includes(sel));
      if (!called) sel = null;
    }
    if (drag) {
      // keep drawing the thing being dragged
      syncTop();
      if (drag.kind === 'frame') { renderTree(); renderColumn(); }
      if (drag.kind === 'margin') renderColumn();
      if (drag.kind === 'level') { renderLadder(); renderColumn(); renderTree(); }
      return;
    }
    renderAll();
  });
  new ResizeObserver(() => { if (!drag) { renderTree(); renderColumn(); renderLadder(); } }).observe(root);
}
