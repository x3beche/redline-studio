// Override Syntax Migrator, drawn as the migration itself: the original file
// on the left (paste or type into it), the converted file on the right, and
// between them a ribbon for every changed line, one strand per rewrite in the
// colour of the rule that made it (operation, override, package name,
// rename, SRC_URI). Rewrites a human should look at are amber, lines that
// will still stop BitBake 2.x red.
//   Click a rewrite on the right (or focus it and press Enter) to keep the
//   original text there; click it again to convert it. Suggested override
//   names are one click from the list; the override list is chips: add your
//   MACHINE/DISTRO names, take a built-in one off.
// Everything drawn comes from run()'s result.view; the kit keeps the inputs.

const NS = 'http://www.w3.org/2000/svg';
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
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

const LH = 20, PAD = 6;
const RULES = {
  operation: ['op', 'operation', ':append :prepend :remove'],
  override: ['ov', 'override', 'a built-in override'],
  yours: ['yo', 'your override', 'a name you added'],
  package: ['pk', 'package name', 'RDEPENDS:${PN} and friends'],
  rename: ['rn', 'rename', 'Kirkstone variable renames'],
  srcuri: ['sr', 'SRC_URI', 'git branch= / protocol=https'],
  python: ['py', 'python', "the script's literal Python rewrites"],
  repair: ['py', 'repair', 'pkg_postinst_ontarget kept'],
};
const cls = (c) => (RULES[c.rule] || RULES.python)[0];
const words = (s) => String(s ?? '').split(/[\s,]+/).filter(Boolean);

export function page(root, ctx) {
  let res = null;
  let focusKey = null;

  // ------------------------------------------------------------ top strip
  const renames = h('input', { type: 'checkbox', onchange: (e) => ctx.set('renames', e.target.checked) });
  const srcuri = h('input', { type: 'checkbox', onchange: (e) => ctx.set('srcuri', e.target.checked) });
  const stats = h('div', { class: 'om-stats', 'aria-live': 'polite' });
  const legend = h('div', { class: 'om-legend' }, Object.entries(RULES).filter(([k]) => k !== 'repair').map(([, [c, name, tip]]) =>
    h('span', { title: tip }, h('i', { class: `sw ${c}` }), name)),
  h('span', { title: 'a rewrite a human should look at' }, h('i', { class: 'sw fl' }), 'look at'),
  h('span', { title: 'the original was kept here' }, h('i', { class: 'sw kp' }), 'kept'));
  const top = h('div', { class: 'om-top' },
    h('div', { class: 'om-passes' },
      h('span', { class: 'om-pass on', title: 'scripts/contrib/convert-overrides.py 0.9.3, always on' }, 'Override syntax'),
      h('label', { class: 'om-pass', title: 'scripts/contrib/convert-variable-renames.py' }, renames, 'Variable renames'),
      h('label', { class: 'om-pass', title: 'scripts/contrib/convert-srcuri.py' }, srcuri, 'git SRC_URI')),
    stats);

  // ------------------------------------------------------------ the two files
  const gut = h('div', { class: 'om-gut', 'aria-hidden': 'true' });
  const hl = h('pre', { class: 'om-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'om-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'Original file (old syntax)',
    oninput: () => { sizeTa(); schedule(); } });
  const left = h('div', { class: 'om-pane om-left' }, hl, ta);
  const rib = sv('svg', { class: 'om-rib', 'aria-hidden': 'true' });
  const conv = h('div', { class: 'om-pane om-right', role: 'group', 'aria-label': 'Converted file' });
  const body = h('div', { class: 'om-body' }, gut, left, h('div', { class: 'om-ribwrap' }, rib), conv);
  const diffCard = h('section', { class: 'om-card om-diff' },
    h('div', { class: 'om-heads' },
      h('div', { class: 'om-h' }, h('b', {}, 'Original'), h('span', {}, 'paste a recipe, bbappend, class or conf')),
      h('div', { class: 'om-h om-hr' }, h('b', {}, 'Converted'), h('span', {}, 'click a rewrite to keep the original'))),
    body, legend);

  // ------------------------------------------------------------ review + lists
  const review = h('div', { class: 'om-review' });
  const reviewCard = h('section', { class: 'om-card' }, h('div', { class: 'om-h' }, h('b', {}, 'For a human'), h('span', { class: 'om-rsub' })), review);
  const addIn = h('input', { type: 'text', spellcheck: 'false', placeholder: 'add: mymachine mydistro', 'aria-label': 'Add override names',
    onkeydown: (e) => { if (e.key === 'Enter') { addOverrides(e.target.value); e.target.value = ''; } } });
  const ovBox = h('div', { class: 'om-chips' });
  const allBox = h('div', { class: 'om-chips om-all' });
  let showAll = false;
  const allBtn = h('button', { class: 'k-btn om-small', 'aria-expanded': 'false', onclick: () => { showAll = !showAll; drawLists(); } }, 'All built-in');
  const pkgIn = h('input', { type: 'text', spellcheck: 'false', placeholder: 'add: MY_PKG_VAR', 'aria-label': 'Add package variables',
    onkeydown: (e) => { if (e.key === 'Enter') { const cur = words(ctx.raw.packageVars); ctx.set('packageVars', [...cur, ...words(e.target.value)].join(' ')); e.target.value = ''; } } });
  const pkgBox = h('div', { class: 'om-chips' });
  const skipIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Extra skip strings', placeholder: 'my_append_helper',
    oninput: (e) => ctx.set('skip', e.target.value) });
  const listCard = h('section', { class: 'om-card' },
    h('div', { class: 'om-h' }, h('b', {}, 'Treated as overrides'), h('span', {}, 'a _name is converted only if it is here')),
    h('div', { class: 'om-lists' },
      h('div', { class: 'om-addrow' }, addIn, allBtn), ovBox, allBox,
      h('div', { class: 'om-sub' }, 'Variables that take a package name'), h('div', { class: 'om-addrow' }, pkgIn), pkgBox,
      h('label', { class: 'om-sub om-skip' }, 'Lines containing these are left alone', skipIn)));

  const outCard = h('div', { class: 'om-out' }, ctx.outputs);
  root.append(h('div', { class: 'om' }, top, diffCard, h('div', { class: 'om-low' }, reviewCard, listCard, outCard)));

  // ------------------------------------------------------------ input plumbing
  let timer = null;
  function schedule() {
    drawLeft(ta.value);
    clearTimeout(timer);
    timer = setTimeout(() => ctx.set('text', ta.value), ta.value.length > 20000 ? 250 : 90);
  }
  function sizeTa() {
    const n = ta.value.split('\n').length;
    ta.style.height = `${n * LH + PAD * 2 + 14}px`;
  }
  ta.addEventListener('scroll', () => { hl.style.transform = `translateX(${-ta.scrollLeft}px)`; });
  function addOverrides(text) {
    const cur = words(ctx.raw.overrides);
    const add = words(text).map((w) => w.toLowerCase()).filter((w) => !cur.includes(w));
    if (add.length) ctx.set('overrides', [...cur, ...add].join(' '));
  }
  function toggleKeep(key) {
    const cur = words(ctx.raw.keep);
    focusKey = key;
    ctx.set('keep', (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]).join(' '));
  }
  const kept = () => new Set(words(ctx.raw.keep));

  // ------------------------------------------------------------ drawing
  function lineY(i) { return PAD + i * LH; }

  function drawLeft(text) {
    const V = res && res.view;
    const same = V && text === String(ctx.raw.text ?? '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const byN = new Map(same ? V.lines.map((l) => [l.n, l]) : []);
    const keptBy = new Map();
    if (same) for (const k of V.kept) { const [n, c] = k.split(':').map(Number); if (!keptBy.has(n)) keptBy.set(n, []); keptBy.get(n).push(c); }
    const errs = new Map();
    if (same) for (const f of V.findings) if (f.sev === 'error' || f.sev === 'warn') errs.set(f.line, f.sev === 'error' ? 'err' : 'wrn');
    gut.replaceChildren(...lines.map((_, i) => {
      const l = byN.get(i + 1);
      const e = errs.get(i + 1);
      return h('div', { class: `${l && l.changes.length ? 'chg' : ''} ${e || ''}` }, String(i + 1));
    }));
    hl.replaceChildren(...lines.map((ln, i) => {
      const l = byN.get(i + 1);
      const row = h('span', { class: `ln${l && l.changes.length ? ' chg' : ''}${errs.has(i + 1) ? ' ' + errs.get(i + 1) : ''}` });
      if (!l) { row.textContent = ln || ' '; return row; }
      const kc = keptBy.get(i + 1) || [];
      let col = 1;
      for (const [o, , key] of l.segs) {
        if (key) {
          const c = l.changes.find((x) => x.key === key);
          row.append(h('mark', { class: `${c ? cls(c) : ''}${c && c.flag ? ' fl' : ''}${key === focusKey ? ' cur' : ''}` }, o));
        } else if (kc.some((k) => k >= col && k < col + o.length)) {
          // kept-original positions: underline the original character
          let p = 0;
          for (const k of kc.filter((k) => k >= col && k < col + o.length).sort((a, b) => a - b)) {
            row.append(o.slice(p, k - col), h('mark', { class: 'kp' }, o.slice(k - col, k - col + 1)));
            p = k - col + 1;
          }
          row.append(o.slice(p));
        } else row.append(o);
        col += o.length;
      }
      if (!row.textContent) row.textContent = ' ';
      return row;
    }));
  }

  function drawRight() {
    const V = res.view;
    const errs = new Map(V.findings.filter((f) => f.sev !== 'note').map((f) => [f.line, f.sev === 'error' ? 'err' : 'wrn']));
    const prevFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    conv.replaceChildren(h('pre', { class: 'om-cv' }, V.lines.map((l) => {
      const row = h('span', { class: `ln${l.changes.length ? ' chg' : ''}${errs.has(l.n) ? ' ' + errs.get(l.n) : ''}`, 'data-n': l.n });
      for (const [, nText, key] of l.segs) {
        if (!key) { row.append(nText); continue; }
        const c = l.changes.find((x) => x.key === key);
        if (!c) { row.append(nText); continue; }
        const tip = `${RULES[c.rule] ? RULES[c.rule][1] : c.rule}${c.name ? ' ' + c.name : ''}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}${c.flag ? '\n' + c.flag.text : ''}\nClick or Enter: keep the original`;
        row.append(h('span', { class: `ch ${cls(c)}${c.flag ? ' fl' : ''}${key === focusKey ? ' cur' : ''}`, tabindex: '0', role: 'button',
          'data-key': key, title: tip, 'aria-label': `Line ${l.n}: ${tip}`,
          onclick: () => toggleKeep(key),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleKeep(key); } },
          onfocus: () => { focusKey = key; markCur(); } }, nText || '∅'));
      }
      if (!row.textContent) row.textContent = ' ';
      return row;
    })));
    const want = focusKey || prevFocus;
    if (want && document.activeElement === document.body) {
      const el = conv.querySelector(`[data-key="${CSS.escape(want)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }
  function markCur() {
    for (const el of root.querySelectorAll('.cur')) el.classList.remove('cur');
    if (!focusKey) return;
    conv.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.classList.add('cur');
    drawLeft(ta.value);
    drawRibbon();
  }

  function drawRibbon() {
    const V = res.view;
    const W = 56;
    const H = V.lines.length * LH + PAD * 2 + 14;
    rib.setAttribute('viewBox', `0 0 ${W} ${H}`);
    rib.setAttribute('width', W); rib.setAttribute('height', H);
    rib.replaceChildren();
    const errs = new Map(V.findings.filter((f) => f.sev !== 'note').map((f) => [f.line, f.sev]));
    const keptBy = new Map();
    for (const k of V.kept) { const n = Number(k.split(':')[0]); keptBy.set(n, (keptBy.get(n) || 0) + 1); }
    V.lines.forEach((l, i) => {
      const nk = keptBy.get(l.n) || 0;
      const strands = [...l.changes.map((c) => ({ c })), ...Array.from({ length: nk }, () => ({ kept: true }))];
      if (!strands.length && !errs.has(l.n)) return;
      const y0 = lineY(i) + 2, y1 = y0 + LH - 4;
      if (strands.length) {
        // strands side by side at the ends, pinched to a bundle in the middle
        const n = strands.length, sh = (y1 - y0) / n, mid = (y0 + y1) / 2, pinch = Math.min(1, 10 / (y1 - y0));
        strands.forEach((s, k) => {
          const a = y0 + k * sh, b = a + sh;
          const ma = mid + (a - mid) * pinch, mb = mid + (b - mid) * pinch;
          const d = `M0,${a} C${W * 0.4},${a} ${W * 0.35},${ma} ${W / 2},${ma} S${W * 0.6},${a} ${W},${a} L${W},${b} C${W * 0.6},${b} ${W * 0.65},${mb} ${W / 2},${mb} S${W * 0.4},${b} 0,${b} Z`;
          const p = sv('path', { d, class: `st ${s.kept ? 'kp' : cls(s.c)}${s.c && s.c.flag ? ' fl' : ''}${s.c && s.c.key === focusKey ? ' cur' : ''}` });
          if (s.c) {
            p.append(sv('title', {}, `line ${l.n}: ${s.c.before} -> ${s.c.after}${s.c.flag ? ' (look at)' : ''}`));
            p.addEventListener('click', () => { const el = conv.querySelector(`[data-key="${CSS.escape(s.c.key)}"]`); if (el) el.focus(); });
          }
          rib.append(p);
        });
      }
      const e = errs.get(l.n);
      if (e) {
        rib.append(sv('circle', { cx: W / 2, cy: (y0 + y1) / 2, r: 6.5, class: `dot ${e === 'error' ? 'err' : 'wrn'}` }));
        rib.append(sv('text', { x: W / 2, y: (y0 + y1) / 2 + 3.5, 'text-anchor': 'middle', class: 'dtx' }, '!'));
      } else if (l.changes.some((c) => c.flag)) {
        rib.append(sv('circle', { cx: W / 2, cy: (y0 + y1) / 2, r: 3, class: 'dot wrn' }));
      }
    });
  }

  function goLine(n, key) {
    const el = key ? conv.querySelector(`[data-key="${CSS.escape(key)}"]`) : conv.querySelector(`[data-n="${n}"]`);
    const scroller = body;
    scroller.scrollTop = Math.max(0, lineY(n - 1) - scroller.clientHeight / 3);
    if (el && key) { focusKey = key; el.focus({ preventScroll: true }); markCur(); }
  }

  function drawReview() {
    const V = res.view;
    const k = kept();
    const items = [];
    const sevRank = { error: 0, warn: 1, note: 3 };
    for (const f of V.findings) items.push({ line: f.line, rank: sevRank[f.sev] ?? 2, sev: f.sev, text: f.text, suggest: f.suggest });
    for (const l of V.lines) for (const c of l.changes) if (c.flag) items.push({ line: l.n, rank: 2, sev: 'look', text: c.flag.text, change: c });
    for (const key of V.kept) items.push({ line: Number(key.split(':')[0]), rank: 4, sev: 'kept', text: `Original kept at column ${key.split(':')[1]}.`, keptKey: key });
    items.sort((a, b) => a.rank - b.rank || a.line - b.line);
    root.querySelector('.om-rsub').textContent = items.length ? `${items.filter((i) => i.sev === 'error').length} will stop BitBake, ${items.filter((i) => i.sev === 'look').length} rewrites to check` : '';
    if (!items.length) { review.replaceChildren(h('div', { class: 'om-empty' }, 'Nothing needs a look: every rewrite is a plain variable-name override.')); return; }
    review.replaceChildren(...items.map((it) => {
      const acts = [];
      if (it.suggest && !words(ctx.raw.overrides).includes(it.suggest)) acts.push(h('button', { class: 'k-btn om-small', onclick: () => addOverrides(it.suggest) }, `Add ${it.suggest}`));
      if (it.change) acts.push(h('button', { class: 'k-btn om-small', onclick: () => toggleKeep(it.change.key) }, 'Keep original'));
      if (it.keptKey) acts.push(h('button', { class: 'k-btn om-small', onclick: () => toggleKeep(it.keptKey) }, 'Convert'));
      return h('div', { class: `om-item ${it.sev}` },
        h('button', { class: 'om-ln', title: 'Show the line', onclick: () => goLine(it.line, it.change && it.change.key) }, `${it.line}`),
        h('div', { class: 'om-it' },
          it.change ? h('code', {}, `${it.change.word} → ${it.change.wordc}`, it.change.name ? h('small', {}, ` ${it.change.name}`) : null) : null,
          h('span', {}, it.text)),
        acts.length ? h('div', { class: 'om-acts' }, acts) : null);
    }));
    void k;
  }

  function chip(name, count, opts = {}) {
    return h('span', { class: `om-chip${opts.user ? ' user' : ''}${count ? ' used' : ''}${opts.dropped ? ' dropped' : ''}` },
      h('span', { class: 'nm' }, name), count ? h('b', {}, String(count)) : null,
      opts.onx ? h('button', { class: 'x', title: opts.xtitle, 'aria-label': `${opts.xtitle} ${name}`, onclick: opts.onx }, opts.dropped ? '↺' : '×') : null);
  }
  function drawLists() {
    const L = res.view.lists;
    const used = new Map(L.usedOv);
    const drop = words(ctx.raw.drop);
    const setDrop = (list) => ctx.set('drop', list.join(' '));
    ovBox.replaceChildren(...[
      ...L.user.map((w) => chip(w, used.get(w) || 0, { user: true, xtitle: 'Remove', onx: () => ctx.set('overrides', words(ctx.raw.overrides).filter((x) => x.toLowerCase() !== w).join(' ')) })),
      ...['append', 'prepend', 'remove'].map((w) => chip(w, used.get(w) || 0)),
      ...[...L.builtin, ...L.short].filter((w) => used.has(w) && !L.user.includes(w)).map((w) => chip(w, used.get(w), { xtitle: 'Take off the list', onx: () => setDrop([...drop, w]) })),
      ...L.dropped.map((w) => chip(w, 0, { dropped: true, xtitle: 'Put back', onx: () => setDrop(drop.filter((x) => x !== w)) })),
      res.view.suggest.filter((w) => !L.user.includes(w)).length ? h('span', { class: 'om-sugg' }, 'suggested:', res.view.suggest.filter((w) => !L.user.includes(w)).map((w) =>
        h('button', { class: 'om-chip add', title: `Add ${w} as an override`, onclick: () => addOverrides(w) }, `+ ${w}`))) : null].filter(Boolean));
    allBtn.setAttribute('aria-expanded', String(showAll));
    allBtn.textContent = showAll ? 'Hide built-in' : `All built-in (${L.builtin.length + L.short.length})`;
    allBox.hidden = !showAll;
    if (showAll) {
      allBox.replaceChildren(...[...L.builtin, ...L.short].filter((w) => !used.has(w)).map((w) => {
        const d = drop.includes(w);
        return chip(w, 0, { dropped: d, xtitle: d ? 'Put back' : 'Take off the list', onx: () => setDrop(d ? drop.filter((x) => x !== w) : [...drop, w]) });
      }));
    }
    const usedP = new Map(L.usedPkg);
    pkgBox.replaceChildren(
      ...L.userPkg.map((w) => chip(w, usedP.get(w) || 0, { user: true, xtitle: 'Remove', onx: () => ctx.set('packageVars', words(ctx.raw.packageVars).filter((x) => x !== w).join(' ')) })),
      ...L.pkg.filter((w) => usedP.has(w)).map((w) => chip(w, usedP.get(w))),
      h('span', { class: 'om-more' }, `+ ${L.pkg.filter((w) => !usedP.has(w)).length} more built in`));
  }

  function drawStats() {
    const v = Object.fromEntries((res.values || []).map((x) => [x.label, x]));
    const item = (label, text, cls2) => (v[label] ? h('span', { class: cls2 || '' }, h('b', {}, String(v[label].value)), ` ${text}`) : null);
    stats.replaceChildren(...[item('Lines changed', 'lines changed'), item('Rewrites', 'rewrites'),
      item('For a human', 'to look at', v['For a human'] && v['For a human'].value ? 'wrn' : ''),
      item('Still stops BitBake', 'still stop BitBake', v['Still stops BitBake'] && v['Still stops BitBake'].value ? 'err' : 'ok'),
      item('Renamed variables', 'renamed'), item('SRC_URI fixes', 'SRC_URI fixes'), item('Kept original', 'kept original')].filter(Boolean));
    const w = (res.warnings || []).filter((x) => /^Not an override|^Taken off|^Nothing/.test(x));
    if (w.length) stats.append(h('span', { class: 'err' }, w.join(' ')));
  }

  ctx.onResult((r) => {
    res = r;
    if (!r || !r.view) return;
    const raw = ctx.raw;
    renames.checked = raw.renames !== false;
    srcuri.checked = raw.srcuri !== false;
    if (document.activeElement !== skipIn) skipIn.value = raw.skip || '';
    const t = String(raw.text ?? '');
    if (document.activeElement !== ta && ta.value !== t) ta.value = t;
    sizeTa();
    drawLeft(ta.value);
    drawRight();
    drawRibbon();
    drawReview();
    drawLists();
    drawStats();
  });
}
