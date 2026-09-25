// JSON Diff Viewer, custom page: the two documents side by side, joined.
//
//   Sheet   - A (before) left, B (after) right, both pretty-printed the way the
//             line diff reads them. Every changed run of lines is tinted and
//             joined across the middle by a ribbon (red: only in A, green:
//             only in B, amber: changed). Lines that differ only by a number
//             inside the tolerance are dotted, not tinted. Click a key in the
//             text to ignore that key everywhere, or - inside a list item -
//             to match lists by it. The ruler at the right edge shows where
//             the changes are; click it to scroll there. "Edit A/B" turns a
//             side into its text; below 760 px the sheet is one column.
//   Changes - the field differences (path, A value, B value); click one to
//             bring its lines into view. Above them the number drift strip:
//             every number that differs, placed by how much (log scale), and
//             the tolerance as a handle you drag - numbers left of it count
//             as equal.
// Lines, hunks, field paths, line numbers and drifts all come from run()'s
// result.view; counts from result.values.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
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
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const LH = 20;          // row height, px
const MAX_LINES = 6000; // rows drawn per side
const NICE = [1, 2, 5];
const fmtTol = (t) => (t === 0 ? '0' : t >= 0.01 && t < 1e4 ? String(+t.toPrecision(3)) : t.toExponential(0).replace('e+', 'e'));

/** Tokens of one pretty-printed line: indent, key, value parts. */
function tokens(line) {
  const m = /^(\s*)("(?:[^"\\]|\\.)*")(: )(.*)$/.exec(line);
  const out = [];
  let rest = line, ind = '';
  if (m) { ind = m[1]; out.push({ t: 'ind', s: ind }, { t: 'key', s: m[2] }, { t: 'p', s: ': ' }); rest = m[4]; }
  else { const k = /^(\s*)(.*)$/.exec(line); ind = k[1]; out.push({ t: 'ind', s: ind }); rest = k[2]; }
  const c = /,$/.test(rest) ? ',' : '';
  const v = c ? rest.slice(0, -1) : rest;
  let t = 'p';
  if (/^"/.test(v)) t = 'str';
  else if (/^-?\d/.test(v)) t = 'num';
  else if (v === 'true' || v === 'false') t = 'bool';
  else if (v === 'null') t = 'null';
  out.push({ t, s: v });
  if (c) out.push({ t: 'p', s: c });
  return out;
}

export function page(root, ctx) {
  const st = { edit: null, narrow: false, focus: null, menu: null };
  let view = null;

  // ---------------------------------------------------------------- toolbar
  const summary = h('div', { class: 'jd-summary', 'aria-live': 'polite' });
  const modeBtns = [['index', 'By position'], ['key', 'By key'], ['unordered', 'As sets']].map(([v, t]) =>
    h('button', { class: 'jd-seg', 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('arrays', v) }, t));
  const keyIn = h('input', { type: 'text', class: 'jd-keyin', spellcheck: 'false', 'aria-label': 'Key field', oninput: (e) => ctx.set('key', e.target.value) });
  const keyWrap = h('label', { class: 'jd-keywrap' }, 'key ', keyIn);
  const ignChips = h('span', { class: 'jd-chips' });
  const ignAdd = h('input', { type: 'text', class: 'jd-ignadd', spellcheck: 'false', placeholder: 'add a key', 'aria-label': 'Add a key to ignore',
    onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { addIgnore(e.target.value.trim()); e.target.value = ''; } } });
  const sortCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('sort', e.target.checked) });
  const bar = h('section', { class: 'jd-panel jd-bar' },
    summary,
    h('div', { class: 'jd-row' },
      h('span', { class: 'jd-h' }, 'Lists'), h('span', { class: 'jd-segs', role: 'group', 'aria-label': 'Compare arrays' }, modeBtns), keyWrap,
      h('span', { class: 'jd-sep' }),
      h('span', { class: 'jd-h' }, 'Ignoring'), ignChips, ignAdd,
      h('span', { class: 'jd-sep' }),
      h('label', { class: 'jd-cb' }, sortCb, ' sort keys')));

  // ---------------------------------------------------------------- sheet
  const editA = h('button', { class: 'k-btn jd-sbtn', onclick: () => toggleEdit('a') }, 'Edit A');
  const editB = h('button', { class: 'k-btn jd-sbtn', onclick: () => toggleEdit('b') }, 'Edit B');
  const swapBtn = h('button', { class: 'k-btn jd-sbtn', title: 'Swap A and B', onclick: () => ctx.setMany({ a: ctx.raw.b, b: ctx.raw.a }) }, 'Swap');
  const headA = h('div', { class: 'jd-colhead' }, h('span', { class: 'jd-side jd-side-a' }, 'A'), h('span', { class: 'jd-soft' }, 'before / expected'), h('span', { class: 'jd-grow' }), h('span', { class: 'jd-soft jd-small jd-na' }), editA);
  const headB = h('div', { class: 'jd-colhead' }, h('span', { class: 'jd-side jd-side-b' }, 'B'), h('span', { class: 'jd-soft' }, 'after / actual'), h('span', { class: 'jd-grow' }), h('span', { class: 'jd-soft jd-small jd-nb' }), editB, swapBtn);
  const heads = h('div', { class: 'jd-heads' }, headA, h('div', { class: 'jd-gutterhead' }), headB);
  const sheetErr = h('div', { class: 'jd-err', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'jd-scroll' });
  const ruler = h('div', { class: 'jd-ruler', title: 'Where the changes are: click to scroll there' });
  const legend = h('div', { class: 'jd-legend' },
    h('span', {}, h('i', { class: 'jd-lg-del' }), 'only in A'), h('span', {}, h('i', { class: 'jd-lg-add' }), 'only in B'),
    h('span', {}, h('i', { class: 'jd-lg-chg' }), 'changed'), h('span', {}, h('i', { class: 'jd-lg-tol' }), 'number within tolerance (equal)'),
    h('span', { class: 'jd-soft' }, 'Click a key to ignore it or match lists by it.'));
  const sheet = h('section', { class: 'jd-panel jd-sheetpanel' }, heads, sheetErr, h('div', { class: 'jd-sheetbody' }, scroller, ruler), legend);

  // ---------------------------------------------------------------- changes
  const tolIn = h('input', { type: 'text', class: 'jd-tolin', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Number tolerance',
    oninput: (e) => ctx.set('tolerance', e.target.value) });
  const strip = h('div', { class: 'jd-strip' });
  const stripNote = h('div', { class: 'jd-soft jd-small' });
  const list = h('div', { class: 'jd-list', role: 'list' });
  const listHead = h('div', { class: 'jd-row jd-listhead' }, h('span', { class: 'jd-h' }, 'Field changes'), h('span', { class: 'jd-soft jd-small jd-listcount' }));
  const side = h('section', { class: 'jd-panel jd-changes' },
    h('div', { class: 'jd-row' }, h('span', { class: 'jd-h' }, 'Number tolerance'), h('span', { class: 'jd-grow' }), h('label', { class: 'jd-soft jd-small' }, '± ', tolIn)),
    strip, stripNote, listHead, list);

  const notes = h('div', { class: 'jd-notes' });
  root.append(h('div', { class: 'jd-page' }, bar, sheet, side, h('div', { class: 'jd-out' }, ctx.outputs, notes)));

  // ---------------------------------------------------------------- actions
  const ignored = () => String(ctx.raw.ignore || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  function addIgnore(k) { const l = ignored(); if (!l.includes(k)) l.push(k); ctx.set('ignore', l.join(', ')); }
  function removeIgnore(k) { ctx.set('ignore', ignored().filter((x) => x !== k).join(', ')); }
  function toggleEdit(side) { st.edit = st.edit === side ? null : side; drawSheet(); }
  function closeMenu() { if (st.menu) { st.menu.remove(); st.menu = null; } }
  function openMenu(btn, key, inItem) {
    closeMenu();
    const items = [h('button', { class: 'jd-mi', onclick: () => { closeMenu(); addIgnore(key); } }, `Ignore "${key}" everywhere`)];
    if (inItem) items.push(h('button', { class: 'jd-mi', onclick: () => { closeMenu(); ctx.setMany({ arrays: 'key', key }); } }, `Match list items by "${key}"`));
    const r = btn.getBoundingClientRect(), pr = sheet.getBoundingClientRect();
    const m = h('div', { class: 'jd-menu', role: 'menu', style: `left:${Math.min(r.left - pr.left, pr.width - 240)}px;top:${r.bottom - pr.top + 2}px` }, items);
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); btn.focus(); } });
    sheet.append(m);
    st.menu = m;
    items[0].focus();
  }
  document.addEventListener('pointerdown', (e) => { if (st.menu && !st.menu.contains(e.target) && !e.target.closest('.jd-key')) closeMenu(); });

  // ---------------------------------------------------------------- the sheet
  function lineRow(text, no, cls, key, inItem, side, idx) {
    const code = h('span', { class: 'jd-code' });
    for (const tk of tokens(text)) {
      if (tk.t === 'key' && key != null) code.append(h('button', { class: 'jd-key', tabindex: '-1', 'data-key': key, 'data-item': inItem ? '1' : '', title: `Click: ignore "${key}"${inItem ? ' or match lists by it' : ''}` }, tk.s));
      else code.append(tk.t === 'ind' ? tk.s : h('span', { class: `jd-${tk.t}` }, tk.s));
    }
    return h('div', { class: `jd-ln ${cls}`, 'data-side': side, 'data-i': idx, title: text.length > 60 ? text.trim() : null }, h('span', { class: 'jd-no' }, no), code);
  }

  function classify() {
    // per-line class from the line diff's hunks, and the hunks themselves
    const A = view.a, B = view.b;
    const ca = new Array(A.length).fill(''), cb = new Array(B.length).fill('');
    const hunks = [];
    const ops = view.ops || [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i][0] === ' ') { i++; continue; }
      const hk = { a0: null, a1: null, b0: null, b1: null, del: 0, add: 0 };
      let j = i;
      while (j < ops.length && ops[j][0] !== ' ') {
        const [op, a, b] = ops[j];
        if (op === '-') { hk.del++; if (hk.a0 == null) hk.a0 = a; hk.a1 = a + 1; }
        else { hk.add++; if (hk.b0 == null) hk.b0 = b; hk.b1 = b + 1; }
        j++;
      }
      // the insertion point on the side that has no lines
      const prev = ops[i - 1], next = ops[j];
      if (hk.a0 == null) { hk.a0 = hk.a1 = prev ? prev[1] + 1 : next ? next[1] : 0; }
      if (hk.b0 == null) { hk.b0 = hk.b1 = prev ? prev[2] + 1 : next ? next[2] : 0; }
      hk.kind = hk.del && hk.add ? 'chg' : hk.del ? 'del' : 'add';
      for (let k = hk.a0; k < hk.a1; k++) ca[k] = hk.kind;
      for (let k = hk.b0; k < hk.b1; k++) cb[k] = hk.kind;
      hunks.push(hk);
      i = j;
    }
    // numbers equal within the tolerance: their lines are not a difference
    for (const n of view.numeric) if (n.within) { if (n.la != null && ca[n.la]) ca[n.la] = 'tol'; if (n.lb != null && cb[n.lb]) cb[n.lb] = 'tol'; }
    for (const hk of hunks) {
      const all = (arr, a0, a1) => { for (let k = a0; k < a1; k++) if (arr[k] !== 'tol') return false; return true; };
      if (all(ca, hk.a0, hk.a1) && all(cb, hk.b0, hk.b1)) hk.kind = 'tol';
    }
    // lines holding a field difference get a mark
    const fa = new Map(), fb = new Map();
    for (const f of view.fields) { if (f.la != null) fa.set(f.la, f); if (f.lb != null) fb.set(f.lb, f); }
    return { ca, cb, hunks, fa, fb };
  }

  function drawSheet() {
    closeMenu();
    const narrow = (scroller.clientWidth || root.clientWidth) < 700;
    st.narrow = narrow;
    sheet.classList.toggle('is-narrow', narrow);
    editA.setAttribute('aria-pressed', String(st.edit === 'a'));
    editB.setAttribute('aria-pressed', String(st.edit === 'b'));
    editA.textContent = st.edit === 'a' ? 'Done' : 'Edit A';
    editB.textContent = st.edit === 'b' ? 'Done' : 'Edit B';
    const keepTop = scroller.scrollTop;
    scroller.replaceChildren();
    ruler.replaceChildren();
    const editor = (side) => {
      const ta = h('textarea', { class: 'jd-edit', spellcheck: 'false', 'aria-label': side === 'a' ? 'A, JSON text' : 'B, JSON text',
        oninput: (e) => ctx.set(side, e.target.value), onblur: () => setTimeout(() => { if (!document.activeElement?.classList?.contains('jd-edit')) drawSheet(); }, 0) });
      ta.value = String(ctx.raw[side] ?? '');
      return ta;
    };
    if (!view) {
      // unreadable input: both sides as text, so it can be fixed
      scroller.append(h('div', { class: 'jd-cols jd-cols-edit' }, editor('a'), h('div'), editor('b')));
      return;
    }
    const { ca, cb, hunks, fa, fb } = classify();
    const A = view.a.slice(0, MAX_LINES), B = view.b.slice(0, MAX_LINES);
    const cut = view.a.length > MAX_LINES || view.b.length > MAX_LINES;
    const mark = (f) => (f ? ` has-field f-${f.change.split(' ')[0]}` : '');
    if (narrow) {
      // one column: the line diff in order, removed lines then added ones
      const pane = h('div', { class: 'jd-pane jd-uni' });
      if (st.edit) pane.append(editor(st.edit));
      else if (view.ops) {
        for (const [op, a, b] of view.ops) {
          if (op === ' ') pane.append(lineRow(view.b[b], `${a + 1}`, '', view.keysB[b], view.itemB[b], 'b', b));
          else if (op === '-') pane.append(lineRow(view.a[a], `−${a + 1}`, `is-${ca[a] || 'del'}${mark(fa.get(a))}`, view.keysA[a], view.itemA[a], 'a', a));
          else pane.append(lineRow(view.b[b], `+${b + 1}`, `is-${cb[b] || 'add'}${mark(fb.get(b))}`, view.keysB[b], view.itemB[b], 'b', b));
          if (pane.childElementCount > MAX_LINES) break;
        }
      } else B.forEach((l, i) => pane.append(lineRow(l, i + 1, '', view.keysB[i], view.itemB[i], 'b', i)));
      scroller.append(pane);
    } else {
      const paneA = h('div', { class: 'jd-pane jd-pa' }), paneB = h('div', { class: 'jd-pane jd-pb' });
      if (st.edit === 'a') paneA.append(editor('a'));
      else A.forEach((l, i) => paneA.append(lineRow(l, i + 1, ca[i] ? `is-${ca[i]}${mark(fa.get(i))}` : mark(fa.get(i)), view.keysA[i], view.itemA[i], 'a', i)));
      if (st.edit === 'b') paneB.append(editor('b'));
      else B.forEach((l, i) => paneB.append(lineRow(l, i + 1, cb[i] ? `is-${cb[i]}${mark(fb.get(i))}` : mark(fb.get(i)), view.keysB[i], view.itemB[i], 'b', i)));
      // the ribbons between them
      const rows = Math.max(st.edit ? 0 : Math.max(A.length, B.length), 1);
      const G = 56;
      const g = sv('svg', { class: 'jd-gutter', width: G, height: rows * LH, viewBox: `0 0 ${G} ${rows * LH}`, 'aria-hidden': 'true' });
      if (!st.edit) {
        for (const hk of hunks) {
          if (hk.a0 >= MAX_LINES && hk.b0 >= MAX_LINES) continue;
          const ya0 = hk.a0 * LH, ya1 = hk.a1 * LH, yb0 = hk.b0 * LH, yb1 = hk.b1 * LH;
          const c = G / 2;
          g.append(sv('path', { class: `jd-rib jd-rib-${hk.kind}`,
            d: `M0,${ya0} C${c},${ya0} ${c},${yb0} ${G},${yb0} L${G},${yb1} C${c},${yb1} ${c},${ya1} 0,${ya1} Z` }));
          const mid = (ya0 + ya1) / 2, midb = (yb0 + yb1) / 2;
          if (hk.kind !== 'tol') g.append(sv('text', { class: 'jd-ribn', x: c, y: (mid + midb) / 2 + 4, 'text-anchor': 'middle' }, hk.kind === 'add' ? `+${hk.add}` : hk.kind === 'del' ? `−${hk.del}` : `${hk.del}→${hk.add}`));
        }
      }
      scroller.append(h('div', { class: 'jd-cols' }, paneA, g, paneB));
      // the ruler: whole documents, scaled
      const tot = Math.max(view.a.length, view.b.length, 1);
      for (const hk of hunks) {
        const y0 = Math.min(hk.a0, hk.b0) / tot * 100, y1 = Math.max(hk.a1, hk.b1) / tot * 100;
        ruler.append(h('i', { class: `jd-rk jd-rk-${hk.kind}`, style: `top:${y0}%;height:max(3px, ${y1 - y0}%)` }));
      }
    }
    if (cut) scroller.append(h('div', { class: 'jd-soft jd-small jd-cut' }, `The sheet shows the first ${MAX_LINES} lines of each side; the Line diff tab has all of them.`));
    scroller.scrollTop = keepTop;
    if (st.focus) focusField(st.focus, false);
  }

  scroller.addEventListener('click', (e) => {
    const k = e.target.closest('.jd-key');
    if (k) openMenu(k, k.dataset.key, !!k.dataset.item);
  });
  ruler.addEventListener('click', (e) => {
    const r = ruler.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    scroller.scrollTop = f * scroller.scrollHeight - scroller.clientHeight / 2;
  });

  function focusField(f, scroll = true) {
    st.focus = f;
    for (const el of scroller.querySelectorAll('.is-focus')) el.classList.remove('is-focus');
    for (const el of list.querySelectorAll('.is-on')) el.classList.remove('is-on');
    const li = list.querySelector(`[data-path="${CSS.escape(f.path)}"][data-change="${CSS.escape(f.change)}"]`);
    if (li) li.classList.add('is-on');
    const rows = [];
    if (f.la != null) rows.push(scroller.querySelector(`.jd-ln[data-side="a"][data-i="${f.la}"]`));
    if (f.lb != null) rows.push(scroller.querySelector(`.jd-ln[data-side="b"][data-i="${f.lb}"]`));
    for (const r of rows) if (r) r.classList.add('is-focus');
    const r0 = rows.find(Boolean);
    if (r0 && scroll) {
      const top = r0.offsetTop - scroller.clientHeight / 3;
      scroller.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  // ---------------------------------------------------------------- changes list
  function drawList() {
    list.replaceChildren();
    const fields = view ? view.fields : [];
    list.parentElement.querySelector('.jd-listcount').textContent = view ? `${fields.length}` : '';
    if (!fields.length) { list.append(h('div', { class: 'jd-soft jd-empty' }, view ? 'No field differs.' : '')); return; }
    for (const f of fields.slice(0, 500)) {
      const kind = f.change.split(' ')[0];
      const b = h('button', { class: `jd-item jd-i-${kind}`, role: 'listitem', 'data-path': f.path, 'data-change': f.change, onclick: () => focusField(f) },
        h('span', { class: 'jd-badge' }, f.change),
        h('span', { class: 'jd-path' }, f.path),
        h('span', { class: 'jd-vals' },
          f.a !== '–' ? h('span', { class: 'jd-va' }, f.a) : null,
          f.a !== '–' && f.b !== '–' ? h('span', { class: 'jd-soft' }, ' → ') : null,
          f.b !== '–' ? h('span', { class: 'jd-vb' }, f.b) : null));
      list.append(b);
    }
  }

  // ---------------------------------------------------------------- tolerance strip
  const tolSeries = (lo, hi) => { const out = []; for (let e = lo; e <= hi; e++) for (const n of NICE) out.push(n * 10 ** e); return out; };
  function drawStrip() {
    strip.replaceChildren();
    const nums = view ? view.numeric : [];
    const tol = view ? view.tolerance : Number(ctx.input.tolerance) || 0;
    const W = Math.max(240, strip.clientWidth || 300), H = 92, pad = 16;
    const ds = nums.map((n) => n.d).filter((d) => d > 0);
    let lo = ds.length ? Math.floor(Math.log10(Math.min(...ds))) - 1 : -9;
    let hi = ds.length ? Math.ceil(Math.log10(Math.max(...ds))) + 1 : 3;
    if (tol > 0) { lo = Math.min(lo, Math.floor(Math.log10(tol)) - 1); hi = Math.max(hi, Math.ceil(Math.log10(tol)) + 1); }
    if (hi - lo < 4) { lo -= 2; hi += 1; }
    const X0 = pad + 46; // room for the "exact" slot at the left
    const X = (d) => X0 + ((Math.log10(d) - lo) / (hi - lo)) * (W - X0 - pad);
    const svg = sv('svg', { class: 'jd-stripsvg', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const axisY = 64;
    const tx = tol > 0 ? X(Math.min(Math.max(tol, 10 ** lo), 10 ** hi)) : pad;
    svg.append(sv('rect', { class: 'jd-eqband', x: pad - 6, y: 6, width: Math.max(0, tx - pad + 6), height: axisY - 6 }));
    svg.append(sv('line', { class: 'jd-axis', x1: X0, x2: W - pad, y1: axisY, y2: axisY }));
    svg.append(sv('line', { class: 'jd-tickl', x1: pad, x2: pad, y1: axisY - 3, y2: axisY + 3 }));
    svg.append(sv('text', { class: 'jd-tick', x: pad - 4, y: axisY + 16 }, 'exact'));
    svg.append(sv('text', { class: 'jd-bandlab', x: pad, y: 18 }, 'equal'));
    svg.append(sv('text', { class: 'jd-bandlab', x: W - pad, y: 18, 'text-anchor': 'end' }, 'differs'));
    const step = Math.max(1, Math.ceil((hi - lo) / Math.max(2, Math.floor((W - X0) / 54))));
    for (let e = lo; e <= hi; e++) {
      const x = X(10 ** e);
      svg.append(sv('line', { class: 'jd-tickl', x1: x, x2: x, y1: axisY - 3, y2: axisY + 3 }));
      if ((e - lo) % step === 0) svg.append(sv('text', { class: 'jd-tick', x, y: axisY + 16, 'text-anchor': 'middle' }, e === 0 ? '1' : `1e${e}`));
    }
    // one dot per differing number, stacked where they crowd
    const placed = [];
    for (const n of nums) {
      const x = n.d > 0 ? X(n.d) : X0;
      let row = 0;
      while (placed.some((p) => p.row === row && Math.abs(p.x - x) < 10) && row < 3) row++;
      placed.push({ x, row });
      const c = sv('circle', { class: `jd-dot${n.within ? ' is-within' : ''}`, cx: x, cy: axisY - 11 - row * 11, r: 4.5 });
      c.append(sv('title', {}, `${n.path}: ${n.a} → ${n.b}, differs by ${+n.d.toPrecision(3)}${n.within ? ' (within tolerance: equal)' : ''}`));
      svg.append(c);
    }
    // the handle
    const hd = sv('g', { class: 'jd-handle', tabindex: '0', role: 'slider', 'aria-label': 'Number tolerance', 'aria-valuetext': tol ? `± ${fmtTol(tol)}` : 'exact' });
    hd.append(sv('line', { x1: tx, x2: tx, y1: 4, y2: axisY + 2 }), sv('rect', { x: tx - 6, y: 2, width: 12, height: 12, rx: 2 }));
    svg.append(hd);
    strip.append(svg);
    const series = tolSeries(lo, hi);
    const setTol = (t) => ctx.set('tolerance', t === 0 ? '0' : fmtTol(t));
    const fromX = (px) => {
      if (px < (pad + X0) / 2) return 0;
      const d = 10 ** (lo + ((px - X0) / (W - X0 - pad)) * (hi - lo));
      let best = series[0];
      for (const s of series) if (Math.abs(Math.log10(s) - Math.log10(d)) < Math.abs(Math.log10(best) - Math.log10(d))) best = s;
      return best;
    };
    const toLocal = (e) => { const r = svg.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const mv = (ev) => { const t = fromX(toLocal(ev)); if (t !== (view ? view.tolerance : 0)) setTol(t); };
      mv(e);
      svg.addEventListener('pointermove', mv);
      svg.addEventListener('pointerup', () => { svg.removeEventListener('pointermove', mv); hd.focus({ preventScroll: true }); }, { once: true });
    });
    hd.addEventListener('keydown', (e) => {
      const i = tol > 0 ? series.findIndex((s) => s >= tol * 0.999) : -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setTol(series[Math.min(series.length - 1, i + 1)]); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setTol(i <= 0 ? 0 : series[i - 1]); }
      else if (e.key === 'Home') { e.preventDefault(); setTol(0); }
    });
    const within = nums.filter((n) => n.within).length;
    stripNote.textContent = nums.length
      ? `${nums.length} number${nums.length === 1 ? '' : 's'} differ; ${within} within ± ${fmtTol(tol)} count${within === 1 ? 's' : ''} as equal. Drag the handle or use the arrow keys.`
      : 'No number differs between A and B.';
  }

  // ---------------------------------------------------------------- result in
  const sync = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  ctx.onResult((r) => {
    const raw = ctx.raw;
    const hadHandle = document.activeElement?.closest?.('.jd-handle');
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.arrays || 'index')));
    keyWrap.hidden = (raw.arrays || 'index') !== 'key';
    sync(keyIn, String(raw.key ?? ''));
    sync(tolIn, String(raw.tolerance ?? ''));
    sortCb.checked = !!ctx.input.sort;
    ignChips.replaceChildren(...(ignored().length ? ignored().map((k) => h('button', { class: 'jd-chip', title: `Stop ignoring "${k}"`, onclick: () => removeIgnore(k) }, k, h('span', { 'aria-hidden': 'true' }, ' ×'))) : [h('span', { class: 'jd-soft jd-small' }, 'nothing')]));
    view = r.view || null;
    sheet.classList.toggle('is-stale', !view);
    const vals = Object.fromEntries((r.values || []).map((v) => [v.label, v]));
    summary.replaceChildren();
    if (vals.Result) {
      summary.append(h('span', { class: `jd-result is-${vals.Result.tone}` }, vals.Result.value),
        h('span', { class: 'jd-count jd-c-chg' }, h('b', {}, vals.Changed?.value ?? 0), ' changed'),
        h('span', { class: 'jd-count jd-c-add' }, h('b', {}, vals.Added?.value ?? 0), ' added'),
        h('span', { class: 'jd-count jd-c-del' }, h('b', {}, vals.Removed?.value ?? 0), ' removed'),
        h('span', { class: 'jd-count' }, 'lines ', h('b', {}, vals.Lines?.value ?? ''), h('span', { class: 'jd-soft' }, ` (${vals.Lines?.hint ?? ''})`)),
        vals.Result.hint ? h('span', { class: 'jd-soft jd-small' }, vals.Result.hint) : null);
    } else summary.append(h('span', { class: 'jd-result is-bad' }, 'Cannot compare'));
    sheetErr.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    sheet.querySelector('.jd-na').textContent = view ? `${view.a.length} lines` : '';
    sheet.querySelector('.jd-nb').textContent = view ? `${view.b.length} lines` : '';
    notes.replaceChildren(...(r.notes || []).map((n) => h('div', {}, n)));
    if (st.focus && view) st.focus = view.fields.find((f) => f.path === st.focus.path && f.change === st.focus.change) || null;
    // keep typing in an editor: redraw everything but the textarea being typed in
    const typing = document.activeElement?.classList?.contains('jd-edit');
    if (!typing) drawSheet();
    drawList();
    drawStrip();
    if (hadHandle) strip.querySelector('.jd-handle')?.focus({ preventScroll: true });
  });

  let rt = 0, lastW = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => {
      const w = root.clientWidth;
      if (Math.abs(w - lastW) < 4) return;
      lastW = w;
      if (!document.activeElement?.classList?.contains('jd-edit')) drawSheet();
      drawStrip();
    });
  }).observe(root);
}
