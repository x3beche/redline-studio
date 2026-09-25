// DOM Selector Finder: the page is the parsed document.
//   Tree       - every element of the pasted HTML as a DOM tree, its id and
//                class tokens coloured by how long they survive (test ids,
//                hand-written names, state/utility classes, build hashes struck
//                through). Click an element (or arrow to it and press Enter)
//                to find the selector for it; the target row is marked, the
//                other search matches carry numbers you can click.
//   Selector   - the best unique selector on a stability ruler (position ...
//                test id), and the ladder of every candidate: point at one and
//                the tree lights up everything it matches - one hit on the
//                target is unique, anything else is shown where it lands.
//   Markup     - the HTML itself, editable.
// Everything shown comes from run()'s result (dom, values, warnings).

const NS = 'http://www.w3.org/2000/svg';
const RH = 24;
const MODES = [['text', 'Text'], ['attr', 'Attribute'], ['selector', 'Selector'], ['line', 'Line']];
const PLACE = { text: 'Sign in', attr: 'name=email', selector: 'form button', line: '12' };
const RULER = [[10, 'position'], [40, 'tag'], [55, 'class'], [62, 'type'], [76, 'aria'], [86, 'name'], [92, 'id'], [100, 'test id']];
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
const band = (s) => (s >= 80 ? 'hi' : s >= 50 ? 'mid' : 'lo');

export function page(root, ctx) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);

  let res = null;
  let pinned = null;   // a candidate clicked in the ladder
  let hover = null;    // a candidate pointed at
  let focusRow = null; // the row that holds the tree's tab stop

  // ---------------- find bar ----------------
  const seg = h('div', { class: 'sf-seg', role: 'group', 'aria-label': 'Find the element by' },
    MODES.map(([v, t]) => h('button', { type: 'button', 'data-mode': v, onclick: () => ctx.set('find', v) }, t)));
  const q = h('input', { type: 'text', class: 'sf-q', spellcheck: 'false', 'aria-label': 'Search', oninput: (e) => ctx.set('query', e.target.value) });
  const matchOut = h('span', { class: 'sf-mout' });
  const bumpNth = (d) => {
    const n = res?.dom?.found.length || 1;
    const cur = res?.dom?.nth || 1;
    ctx.set('nth', String(((cur - 1 + d + n) % n) + 1));
  };
  const matchBox = h('span', { class: 'sf-match', role: 'group', 'aria-label': 'Which match' },
    h('button', { type: 'button', 'aria-label': 'Previous match', onclick: () => bumpNth(-1) }, '‹'), matchOut,
    h('button', { type: 'button', 'aria-label': 'Next match', onclick: () => bumpNth(1) }, '›'));
  const bar = h('div', { class: 'sf-bar' }, h('span', { class: 'sf-h' }, 'Find'), seg, q, matchBox,
    h('span', { class: 'sf-tip' }, 'or click an element in the tree'));

  // ---------------- tree ----------------
  const tree = sv('svg', { class: 'sf-tree', role: 'tree', 'aria-label': 'Elements of the pasted HTML' });
  const treeNote = h('span', { class: 'sf-sub' });
  const legend = h('div', { class: 'sf-legend' },
    h('span', { class: 'sf-lg sf-k-test' }, 'test id'), h('span', { class: 'sf-lg sf-k-ok' }, 'stable name'),
    h('span', { class: 'sf-lg sf-k-soft' }, 'state / utility'), h('span', { class: 'sf-lg sf-k-bad' }, 'generated: changes every build'),
    h('span', { class: 'sf-lg sf-lg-hit' }, 'matched by the selector'), h('span', { class: 'sf-lg sf-lg-miss' }, 'also matched: not unique'));
  const treeBox = h('section', { class: 'sf-panel sf-treebox' },
    h('div', { class: 'sf-phead' }, h('span', { class: 'sf-h' }, 'Document'), treeNote), h('div', { class: 'sf-treewrap' }, tree), legend);

  // ---------------- markup ----------------
  const ta = h('textarea', { class: 'sf-src', rows: '10', spellcheck: 'false', 'aria-label': 'HTML', oninput: (e) => ctx.set('html', e.target.value) });
  const srcNote = h('span', { class: 'sf-sub' });
  const srcBox = h('details', { class: 'sf-panel sf-srcbox', open: true },
    h('summary', {}, h('span', { class: 'sf-h' }, 'Markup'), srcNote), ta);

  // ---------------- selector ----------------
  const bestSel = h('code', { class: 'sf-best' });
  const bestMeta = h('div', { class: 'sf-bestmeta' });
  const ruler = sv('svg', { class: 'sf-ruler', role: 'img' });
  const roleLine = h('div', { class: 'sf-role' });
  const selBox = h('section', { class: 'sf-panel sf-selbox' },
    h('div', { class: 'sf-phead' }, h('span', { class: 'sf-h' }, 'Best selector'), h('span', { class: 'sf-sub' }, 'unique in this HTML, most stable first')),
    bestSel, bestMeta, ruler, roleLine);
  const ladder = h('div', { class: 'sf-ladder', role: 'list' });
  const ladBox = h('section', { class: 'sf-panel sf-ladbox' },
    h('div', { class: 'sf-phead' }, h('span', { class: 'sf-h' }, 'Candidates'), h('span', { class: 'sf-sub' }, 'point at one to see what it matches · click to pin')), ladder);
  const warns = h('div', { class: 'sf-warns', 'aria-live': 'polite' });
  const notes = h('details', { class: 'sf-notes' });

  root.classList.add('sf-root');
  ctx.outputs.classList.add('sf-out');
  root.append(h('div', { class: 'sf' }, bar,
    h('div', { class: 'sf-grid' },
      h('div', { class: 'sf-left' }, treeBox, srcBox),
      h('aside', { class: 'sf-right' }, selBox, warns, ladBox, ctx.outputs, notes))));

  // ---------------- helpers ----------------
  const active = () => {
    const c = res?.dom?.cands || [];
    return c.find((x) => x.sel === hover) || c.find((x) => x.sel === pinned) || c.find((x) => x.sel === res.dom.best) || null;
  };
  const pick = (i) => {
    const n = res.dom.nodes[i];
    if (!n || !n.nth) return;
    pinned = null; hover = null; focusRow = i;
    ctx.setMany({ find: 'line', query: String(n.line), nth: String(n.nth) });
  };
  const tokUsed = (sel, t, kind) => {
    if (!sel) return false;
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'id') return new RegExp(`#${esc(t)}(?![\\w-])|\\[id="${esc(t)}"\\]`).test(sel);
    if (kind === 'cls') return new RegExp(`\\.${esc(t)}(?![\\w-])|\\[class~="${esc(t)}"\\]`).test(sel);
    return new RegExp(`\\[${esc(t)}[=\\]]`).test(sel);
  };

  // ---------------- tree drawing ----------------
  let rowEls = [];
  function drawTree() {
    const d = res.dom;
    const W = Math.max(300, tree.parentElement.clientWidth || 600);
    const N = d.nodes.length;
    const H = N * RH + 8;
    tree.setAttribute('viewBox', `0 0 ${W} ${H}`); tree.setAttribute('width', W); tree.setAttribute('height', H);
    const act = active();
    const hits = new Set(act ? act.hits : []);
    const X = (n) => 48 + n.depth * 16;
    const Y = (i) => 4 + i * RH;
    const g = [];
    // Band behind the target and the hits.
    d.nodes.forEach((n, i) => {
      if (i === d.target) g.push(sv('rect', { x: 0, y: Y(i), width: W, height: RH, class: 'sf-tband' }));
      else if (hits.has(i)) g.push(sv('rect', { x: 0, y: Y(i), width: W, height: RH, class: 'sf-mband' }));
    });
    // Connectors.
    const conn = [];
    d.nodes.forEach((n, i) => {
      if (n.parent < 0 || n.parent >= N) return;
      const p = d.nodes[n.parent];
      conn.push(`M${X(p)},${Y(n.parent) + RH - 5}V${Y(i) + RH / 2}H${X(n) - 3}`);
    });
    // The path from the root down to the target, drawn stronger.
    const path = [];
    for (let i = d.target; i >= 0 && i < N; i = d.nodes[i].parent) path.unshift(i);
    const pconn = path.slice(1).map((i) => { const n = d.nodes[i], p = d.nodes[n.parent]; return `M${X(p)},${Y(n.parent) + RH - 5}V${Y(i) + RH / 2}H${X(n) - 3}`; });
    g.push(sv('path', { d: conn.join(''), class: 'sf-conn' }));
    g.push(sv('path', { d: pconn.join(''), class: 'sf-pconn' }));
    const onPath = new Set(path);
    const cw = 7.25; // px per character at 12 px mono
    rowEls = [];
    d.nodes.forEach((n, i) => {
      const y = Y(i) + RH / 2 + 4;
      const x = X(n);
      const row = sv('g', { class: `sf-row${n.nth ? '' : ' sf-row-off'}${i === d.target ? ' sf-row-target' : ''}`, role: 'treeitem',
        tabindex: i === (focusRow ?? d.target) ? '0' : '-1', 'data-i': i, 'aria-selected': String(i === d.target),
        'aria-level': String(n.depth + 1), 'aria-label': `${n.tag}${n.id ? ` id ${n.id.v}` : ''}${n.cls.length ? ` class ${n.cls.map((c) => c.v).join(' ')}` : ''}, line ${n.line}` });
      row.append(sv('rect', { x: 0, y: Y(i), width: W, height: RH, class: 'sf-rowhit' }));
      row.append(sv('text', { x: 30, y, 'text-anchor': 'end', class: 'sf-ln' }, String(n.line)));
      // Hit marker in the gutter.
      if (hits.has(i)) row.append(sv('rect', { x: 35, y: Y(i) + 7, width: 6, height: 10, rx: 1, class: i === d.target ? 'sf-hit-ok' : 'sf-hit-bad' }));
      row.append(sv('circle', { cx: x, cy: Y(i) + RH / 2, r: onPath.has(i) ? 3.5 : 2.5, class: onPath.has(i) ? 'sf-dot sf-dot-path' : 'sf-dot' }));
      const t = sv('text', { x: x + 8, y, class: 'sf-code' });
      let used = 0;
      const room = Math.floor((W - x - 16) / cw);
      const add = (txt, cls, why) => {
        if (used >= room) return false;
        let s = txt;
        if (used + s.length > room) s = s.slice(0, Math.max(1, room - used - 1)) + '…';
        used += s.length;
        const sp = sv('tspan', { class: cls }, s);
        if (why) sp.append(sv('title', {}, why));
        t.append(sp);
        return true;
      };
      const sel = act?.sel;
      const isT = i === d.target;
      add(n.tag, 'sf-tag');
      if (n.id) add(`#${n.id.v}`, `sf-k-${n.id.k}${isT && tokUsed(sel, n.id.v, 'id') ? ' sf-used' : ''}`, n.id.why ? `id ${n.id.why}` : 'id');
      for (const c of n.cls) add(`.${c.v}`, `sf-k-${c.k}${isT && tokUsed(sel, c.v, 'cls') ? ' sf-used' : ''}`, c.why || 'class');
      for (const [a, v, kind] of n.attrs) add(` ${a}="${v}"`, `${kind ? 'sf-k-test' : 'sf-attr'}${isT && tokUsed(sel, a, 'attr') ? ' sf-used' : ''}`);
      if (n.text) add(`  "${n.text}"`, 'sf-txt');
      row.append(t);
      // Search matches carry their number; click one to take it.
      const fi = d.found.indexOf(i);
      if (d.found.length > 1 && fi >= 0) {
        const bx = Math.min(W - 14, x + 8 + used * cw + 14);
        const m = sv('g', { class: `sf-fnum${fi + 1 === d.nth ? ' sf-fnum-on' : ''}` });
        m.append(sv('circle', { cx: bx, cy: Y(i) + RH / 2, r: 8 }));
        m.append(sv('text', { x: bx, y: Y(i) + RH / 2 + 3.5, 'text-anchor': 'middle' }, String(fi + 1)));
        row.append(m);
      }
      // A fragile best selector is flagged on the target itself.
      const bc = isT ? d.cands.find((c) => c.sel === d.best) : null;
      if (isT && (!bc || bc.score < 50) && W > 520) {
        row.append(sv('text', { x: W - 10, y, 'text-anchor': 'end', class: 'sf-flag' }, bc ? 'fragile: add a data-testid' : 'no unique selector: add a data-testid'));
      }
      g.push(row);
      rowEls[i] = row;
    });
    const keep = document.activeElement?.closest?.('.sf-row') ? Number(document.activeElement.dataset.i) : null;
    tree.replaceChildren(...g);
    if (keep != null && rowEls[keep]) rowEls[keep].focus({ preventScroll: true });
    treeNote.textContent = `${d.total} element${d.total === 1 ? '' : 's'}${d.total > d.nodes.length ? ` (first ${d.nodes.length} drawn)` : ''} · target on line ${d.nodes[d.target]?.line}`;
  }
  tree.addEventListener('click', (e) => {
    const r = e.target.closest?.('.sf-row');
    if (r && res?.dom) pick(Number(r.dataset.i));
  });
  tree.addEventListener('keydown', (e) => {
    const r = e.target.closest?.('.sf-row');
    if (!r || !res?.dom) return;
    const i = Number(r.dataset.i), N = res.dom.nodes.length;
    let j = null;
    if (e.key === 'ArrowDown') j = Math.min(N - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = N - 1;
    else if (e.key === 'ArrowLeft') j = res.dom.nodes[i].parent >= 0 ? res.dom.nodes[i].parent : i;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(i); return; }
    if (j == null) return;
    e.preventDefault();
    r.setAttribute('tabindex', '-1');
    focusRow = j;
    rowEls[j].setAttribute('tabindex', '0');
    rowEls[j].focus();
    rowEls[j].scrollIntoView?.({ block: 'nearest' });
  });

  // ---------------- selector side ----------------
  function drawSelector() {
    const d = res.dom;
    const best = d.cands.find((c) => c.sel === d.best);
    bestSel.textContent = best ? best.sel : 'no unique selector';
    bestSel.className = `sf-best sf-b-${best ? band(best.score) : 'none'}`;
    bestMeta.replaceChildren(best
      ? h('span', {}, h('b', {}, `${best.score}`), ' / 100 · ', best.kind, best.why ? h('span', { class: 'sf-why' }, ` · ${best.why}`) : null)
      : h('span', { class: 'sf-why' }, 'add a data-testid to the element'));
    // Stability ruler: the ranks of each kind, every unique candidate as a tick, the best as the marker.
    const W = Math.max(260, ruler.parentElement.clientWidth - 22), H = 50, L = 8, R = 8;
    ruler.setAttribute('viewBox', `0 0 ${W} ${H}`); ruler.setAttribute('height', H);
    ruler.setAttribute('aria-label', best ? `Stability ${best.score} of 100` : 'No unique selector');
    const X = (s) => L + (s / 100) * (W - L - R);
    const g = [
      sv('rect', { x: X(0), y: 18, width: X(50) - X(0), height: 6, class: 'sf-z-lo' }),
      sv('rect', { x: X(50), y: 18, width: X(80) - X(50), height: 6, class: 'sf-z-mid' }),
      sv('rect', { x: X(80), y: 18, width: X(100) - X(80), height: 6, class: 'sf-z-hi' }),
    ];
    for (const [s, t] of RULER) {
      g.push(sv('line', { x1: X(s), x2: X(s), y1: 25, y2: 30, class: 'sf-rtick' }));
      if ((W > 480 || s !== 92) && (W > 330 || [10, 55, 86, 100].includes(s))) g.push(sv('text', { x: X(s), y: 42, 'text-anchor': s === 100 ? 'end' : s === 10 ? 'start' : 'middle', class: 'sf-rtxt' }, t));
    }
    for (const c of d.cands.filter((x) => x.unique && x.sel !== d.best)) g.push(sv('line', { x1: X(c.score), x2: X(c.score), y1: 15, y2: 27, class: 'sf-rcand' }));
    if (best) {
      g.push(sv('path', { d: `M${X(best.score)},16 l-5,-8 h10 z`, class: `sf-rmark sf-b-${band(best.score)}` }));
      g.push(sv('text', { x: Math.min(W - 20, Math.max(20, X(best.score))), y: 7, 'text-anchor': 'middle', class: 'sf-rval' }, String(best.score)));
    }
    ruler.replaceChildren(...g);
    roleLine.replaceChildren(d.role
      ? h('span', {}, 'role ', h('b', {}, d.role), d.name ? h('span', {}, ' · name ', h('b', {}, `“${d.name}”`)) : h('span', { class: 'sf-why' }, ' · no accessible name'))
      : h('span', { class: 'sf-why' }, 'no ARIA role: role-based locators do not apply'));
  }

  function drawLadder() {
    const d = res.dom;
    const act = active();
    const keep = document.activeElement?.dataset?.sel;
    ladder.replaceChildren(...d.cands.map((c) => {
      const b = h('button', { type: 'button', role: 'listitem', class: `sf-cand${c.unique ? '' : ' sf-cand-no'}${act && act.sel === c.sel ? ' sf-cand-on' : ''}${pinned === c.sel ? ' sf-cand-pin' : ''}`,
        'data-sel': c.sel, title: c.why || c.kind, 'aria-pressed': String(pinned === c.sel),
        onpointerenter: () => { hover = c.sel; drawTree(); markLadder(); },
        onpointerleave: () => { hover = null; drawTree(); markLadder(); },
        onfocus: () => { hover = c.sel; drawTree(); markLadder(); },
        onblur: () => { hover = null; drawTree(); markLadder(); },
        onclick: () => { pinned = pinned === c.sel ? null : c.sel; drawTree(); markLadder(); } },
      h('span', { class: 'sf-meter' }, h('span', { class: `sf-fill sf-b-${c.unique ? band(c.score) : 'none'}`, style: `width:${c.score}%` })),
      h('span', { class: 'sf-score' }, String(c.score)),
      h('code', { class: 'sf-csel' }, c.sel),
      h('span', { class: `sf-n${c.unique ? ' sf-n-u' : c.n ? ' sf-n-m' : ''}` }, c.unique ? 'unique' : c.n ? `${c.n} matches` : 'none'));
      return b;
    }));
    if (keep) ladder.querySelector(`[data-sel="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
  }
  function markLadder() {
    const act = active();
    for (const b of ladder.children) {
      b.classList.toggle('sf-cand-on', !!act && b.dataset.sel === act.sel);
      b.classList.toggle('sf-cand-pin', b.dataset.sel === pinned);
      b.setAttribute('aria-pressed', String(b.dataset.sel === pinned));
    }
  }

  // ---------------- sync ----------------
  function syncBar() {
    const raw = ctx.raw;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === raw.find));
    if (document.activeElement !== q) q.value = raw.query ?? '';
    q.placeholder = PLACE[raw.find] || '';
    if (document.activeElement !== ta) ta.value = raw.html ?? '';
    const n = res?.dom?.found.length || 0;
    matchBox.hidden = n < 2;
    matchOut.textContent = `match ${res?.dom?.nth || 1} of ${n}`;
    srcNote.textContent = res?.dom ? `${String(raw.html || '').split('\n').length} lines · the target is on line ${res.dom.nodes[res.dom.target]?.line}` : '';
  }

  function render() {
    syncBar();
    if (!res?.dom) {
      tree.replaceChildren(); ladder.replaceChildren(); ruler.replaceChildren();
      tree.setAttribute('height', 40);
      tree.append(sv('text', { x: 12, y: 24, class: 'sf-txt' }, (res?.warnings || ['Nothing to show.'])[0].slice(0, 110)));
      bestSel.textContent = '–'; bestMeta.replaceChildren(); roleLine.replaceChildren();
      treeNote.textContent = '';
    } else {
      if (pinned && !res.dom.cands.some((c) => c.sel === pinned)) pinned = null;
      if (focusRow != null && focusRow >= res.dom.nodes.length) focusRow = null;
      drawTree(); drawSelector(); drawLadder();
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(h('summary', {}, 'How stability is ranked'), ...(res?.notes || []).map((n) => h('p', {}, n)));
  }

  let tabChosen = null;
  try { tabChosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
  ctx.onResult((r) => {
    res = r; render();
    // The code lines are what this tool is for: open on them unless a tab was chosen before.
    if (!tabChosen) { const b = [...ctx.outputs.querySelectorAll('.k-tab')].find((x) => x.textContent === 'Code'); if (b) { tabChosen = 'Code'; b.click(); } }
  });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w !== lastW && res?.dom) { lastW = w; drawTree(); drawSelector(); }
  }).observe(root);
}
