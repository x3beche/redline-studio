// Kconfig Diff, drawn as the thing itself: the diff, symbol by symbol,
// grouped by subsystem, with A's value, B's value and what kind of change it
// is (added, removed, built-in <-> module, value, dropped by a dependency).
// Every row is a switch: click it (or focus it and press Space) to put the
// change into the fragment or take it out; the fragment on the right follows.
// The strip across the top is a map of where the changes are - click a
// subsystem to jump to it. The two source files sit above the diff: paste,
// drop a file, swap them, or say whether each is a full .config or a
// defconfig. Everything drawn comes from run()'s result.draw.

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const KIND = {
  added: { label: 'added', short: '+', cls: 'k-add' },
  removed: { label: 'removed', short: '−', cls: 'k-rem' },
  tomodule: { label: 'built-in → module', short: 'y→m', cls: 'k-tri' },
  builtin: { label: 'module → built-in', short: 'm→y', cls: 'k-tri' },
  changed: { label: 'value', short: '~', cls: 'k-chg' },
  dropped: { label: 'dropped by a dependency', short: '⤓', cls: 'k-drop' },
  default: { label: 'default (defconfig)', short: 'd', cls: 'k-def' },
  toolchain: { label: 'toolchain', short: 'cc', cls: 'k-def' },
};
const FILTERS = [
  ['all', 'All'], ['added', 'Added'], ['removed', 'Removed'], ['tri', 'y ↔ m'], ['changed', 'Values'],
  ['dropped', 'Dropped'], ['default', 'Default / toolchain'], ['frag', 'In fragment'],
];
const LS = 'redline.kconfig-diff.view';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* private window */ } };

function chip(v, side, kind, known) {
  if (v == null) {
    return h('span', { class: 'v v-none', title: known === 'full' ? 'not in this .config: not visible, a dependency is off' : 'not in this defconfig: at its default' },
      known === 'full' ? 'not visible' : 'default');
  }
  if (v === 'y') return h('span', { class: 'v v-y', title: 'y: built in' }, 'y');
  if (v === 'm') return h('span', { class: 'v v-m', title: 'm: module' }, 'm');
  if (v === 'n') return h('span', { class: 'v v-n', title: 'n: # CONFIG_X is not set' }, 'n');
  return h('span', { class: 'v v-s', title: v }, v);
}

export function page(root, ctx) {
  const st = { filter: 'all', q: '', closed: {}, ...load() };
  let res = null, focusSym = null, typing = null;
  const wrap = h('div', { class: 'kcd' });
  root.append(wrap);

  // ---------- sources ----------
  const src = {};
  const srcCard = (key, label) => {
    const ta = h('textarea', { spellcheck: 'false', rows: 9, 'aria-label': `Config ${label}`, placeholder: 'Paste a .config or defconfig, or drop the file here',
      oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set(key, v), 250); } });
    ta.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop'); });
    ta.addEventListener('dragleave', () => card.classList.remove('drop'));
    ta.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('drop');
      const f = e.dataTransfer?.files?.[0];
      if (f) f.text().then((t) => { ta.value = t; ctx.set(key, t); });
    });
    const kindKey = key === 'a' ? 'kindA' : 'kindB';
    const seg = h('span', { class: 'seg', role: 'group', 'aria-label': `Config ${label} is` },
      [['auto', 'auto'], ['full', '.config'], ['defconfig', 'defconfig']].map(([v, t]) =>
        h('button', { type: 'button', 'data-v': v, onclick: () => ctx.set(kindKey, v) }, t)));
    const stat = h('span', { class: 'stat' });
    const unread = h('div', { class: 'unread' });
    const card = h('div', { class: `src src-${key}` },
      h('div', { class: 'srchead' }, h('b', { class: 'tag' }, label), h('span', { class: 'what' }, key === 'a' ? 'before' : 'after'), stat, seg),
      ta, unread);
    src[key] = { ta, seg, stat, unread, kindKey };
    return card;
  };
  const swap = h('button', { class: 'k-btn', type: 'button', title: 'Swap A and B', onclick: () => {
    const r = ctx.raw;
    ctx.setMany({ a: r.b, b: r.a, kindA: r.kindB, kindB: r.kindA, picks: '' });
    sync(true);
  } }, 'Swap A ↔ B');
  const srcDetails = h('details', { class: 'kcd-src' });
  try { srcDetails.open = localStorage.getItem(LS + '.src') === '1'; } catch { /* ignore */ }
  srcDetails.addEventListener('toggle', () => { try { localStorage.setItem(LS + '.src', srcDetails.open ? '1' : '0'); } catch { /* ignore */ } });
  const srcSum = h('span', { class: 'srcsum' });
  srcDetails.append(h('summary', {}, h('b', {}, 'Source files'), srcSum),
    h('div', { class: 'srcs' }, srcCard('a', 'A'), srcCard('b', 'B')),
    h('div', { class: 'srcbar' }, swap, h('span', { class: 'hint' }, 'A full .config lists every visible symbol; a defconfig (make savedefconfig) only the ones that differ from their default.')));

  // ---------- map + filters ----------
  const head = h('div', { class: 'kcd-head' });
  const map = h('div', { class: 'kcd-map', role: 'list', 'aria-label': 'Changes by subsystem' });
  const filt = h('div', { class: 'kcd-filters', role: 'group', 'aria-label': 'Show' });
  const q = h('input', { type: 'search', class: 'q', placeholder: 'Filter symbols', 'aria-label': 'Filter symbols', spellcheck: 'false',
    oninput: (e) => { st.q = e.target.value; save(st); drawRows(); } });
  q.value = st.q || '';
  const bulk = h('span', { class: 'bulk' },
    h('button', { class: 'k-btn', type: 'button', title: 'Put every shown change that has a B value in the fragment', onclick: () => bulkSet(true) }, 'All shown in'),
    h('button', { class: 'k-btn', type: 'button', title: 'Take every shown change out of the fragment', onclick: () => bulkSet(false) }, 'All shown out'),
    h('button', { class: 'k-btn', type: 'button', title: 'Forget the + and − overrides', onclick: () => ctx.set('picks', '') }, 'Defaults'));
  const board = h('div', { class: 'kcd-board', role: 'grid', 'aria-label': 'Differences; Space puts a change in the fragment or takes it out' });
  const legend = h('div', { class: 'kcd-legend' },
    h('span', {}, h('i', { class: 'sw k-add' }), 'added'), h('span', {}, h('i', { class: 'sw k-rem' }), 'removed'),
    h('span', {}, h('i', { class: 'sw k-tri' }), 'y ↔ m'), h('span', {}, h('i', { class: 'sw k-chg' }), 'value'),
    h('span', {}, h('i', { class: 'sw k-drop' }), 'dropped by a dependency'), h('span', {}, h('i', { class: 'sw k-def' }), 'default / toolchain'),
    h('span', { class: 'keys' }, 'Click a row or press ', h('kbd', {}, 'Space'), ' to put it in the fragment or take it out; ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move, ', h('kbd', {}, 'Enter'), ' on a group folds it.'));
  const diffCard = h('section', { class: 'kcd-card' }, head, map, h('div', { class: 'kcd-tools' }, filt, q, bulk), board, legend);

  // ---------- side ----------
  const warns = h('div', { class: 'kcd-warns', role: 'status', 'aria-live': 'polite' });
  const fragHead = h('div', { class: 'kcd-fraghead' });
  const nameIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Fragment file name', class: 'name',
    oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set('name', v), 250); } });
  const notes = h('details', { class: 'kcd-notes' }, h('summary', {}, 'Notes'));
  wrap.append(
    h('div', { class: 'kcd-col main' }, srcDetails, diffCard),
    h('div', { class: 'kcd-col side' }, h('div', { class: 'kcd-frag' }, fragHead, h('label', { class: 'nm' }, 'File', nameIn)), warns, ctx.outputs, notes));

  // ---------- picks ----------
  const picksOf = () => {
    const add = new Set(), skip = new Set();
    for (const t of String(ctx.raw.picks || '').split(/[\s,;]+/)) {
      const m = /^([+-])(?:CONFIG_)?([A-Za-z0-9_]+)$/.exec(t);
      if (!m) continue;
      if (m[1] === '+') { add.add(m[2]); skip.delete(m[2]); } else { skip.add(m[2]); add.delete(m[2]); }
    }
    return { add, skip };
  };
  const writePicks = (add, skip) => ctx.set('picks', [...[...skip].sort().map((s) => '-' + s), ...[...add].sort().map((s) => '+' + s)].join(' '));
  const canInclude = (r) => r.b != null || r.kind === 'dropped' || (r.kind === 'default' && r.a === 'y' && res?.draw?.kindA === 'defconfig');
  function toggle(r, want) {
    const { add, skip } = picksOf();
    const on = want ?? !r.inc;
    if (on && !canInclude(r)) return;
    add.delete(r.sym); skip.delete(r.sym);
    if (on !== r.byDefault) (on ? add : skip).add(r.sym);
    focusSym = r.sym;
    writePicks(add, skip);
  }
  function bulkSet(on) {
    const { add, skip } = picksOf();
    for (const r of shownRows()) {
      if (on && !canInclude(r)) continue;
      add.delete(r.sym); skip.delete(r.sym);
      if (on !== r.byDefault) (on ? add : skip).add(r.sym);
    }
    writePicks(add, skip);
  }

  // ---------- filtering ----------
  const matches = (r) => {
    const f = st.filter;
    if (f === 'tri' && r.kind !== 'tomodule' && r.kind !== 'builtin') return false;
    if (f === 'default' && r.kind !== 'default' && r.kind !== 'toolchain') return false;
    if (f === 'frag' && !r.inc) return false;
    if (!['all', 'tri', 'default', 'frag'].includes(f) && r.kind !== f) return false;
    const qq = (st.q || '').trim().toUpperCase().replace(/^CONFIG_/, '');
    if (qq && !r.sym.includes(qq) && !String(r.a ?? '').toUpperCase().includes(qq) && !String(r.b ?? '').toUpperCase().includes(qq)) return false;
    return true;
  };
  const shownRows = () => (res?.draw?.groups || []).flatMap((g) => g.rows.filter(matches));

  // ---------- drawing ----------
  function drawHead(d) {
    const c = d.counts;
    const n = (k) => c[k] || 0;
    head.replaceChildren(
      h('h2', {}, 'Differences'),
      h('span', { class: 'sum' },
        h('b', {}, String(n('added') + n('removed') + n('tomodule') + n('builtin') + n('changed'))), ' changes · ',
        h('b', { class: 'c-add' }, `+${n('added')}`), ' ', h('b', { class: 'c-rem' }, `−${n('removed')}`), ' ',
        h('b', { class: 'c-tri' }, `${n('tomodule') + n('builtin')} y↔m`), ' ', h('b', { class: 'c-chg' }, `${n('changed')} values`),
        n('dropped') ? [' · ', h('b', { class: 'c-drop' }, `${n('dropped')} dropped`)] : null,
        ` · ${d.same} identical`));
    // the map: one block per subsystem, width by its number of changes
    const groups = d.groups.filter((g) => g.rows.some((r) => r.kind !== 'default' && r.kind !== 'toolchain'));
    const other = d.groups.filter((g) => !groups.includes(g));
    const total = groups.reduce((a, g) => a + g.rows.length, 0) || 1;
    map.replaceChildren(...groups.map((g) => {
      const segs = ['added', 'removed', 'tomodule', 'builtin', 'changed', 'dropped'].filter((k) => g.counts[k]);
      return h('button', { type: 'button', role: 'listitem', class: 'blk', style: `flex-grow:${g.rows.length}; flex-basis:${Math.max(64, (g.rows.length / total) * 600)}px`,
        title: `${g.name}: ${segs.map((k) => `${g.counts[k]} ${KIND[k].label}`).join(', ')}`,
        onclick: () => jump(g.name) },
      h('span', { class: 'bn' }, g.name),
      h('span', { class: 'bbar' }, segs.map((k) => h('i', { class: KIND[k].cls, style: `flex-grow:${g.counts[k]}` }))),
      h('span', { class: 'bc' }, String(g.rows.length)));
    }), ...(other.length ? [h('button', { type: 'button', role: 'listitem', class: 'blk soft', title: other.map((g) => g.name).join(', '),
      onclick: () => { st.filter = 'default'; save(st); drawAll(); } },
    h('span', { class: 'bn' }, 'defaults'), h('span', { class: 'bbar' }, h('i', { class: 'k-def', style: 'flex-grow:1' })),
    h('span', { class: 'bc' }, String(other.reduce((a, g) => a + g.rows.length, 0))))] : []));
    const cnt = { all: d.groups.reduce((a, g) => a + g.rows.length, 0), added: n('added'), removed: n('removed'), tri: n('tomodule') + n('builtin'),
      changed: n('changed'), dropped: n('dropped'), default: n('default') + n('toolchain'), frag: d.fragCount };
    filt.replaceChildren(...FILTERS.filter(([k]) => k === 'all' || k === 'frag' || cnt[k]).map(([k, t]) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.filter === k), onclick: () => { st.filter = k; save(st); drawAll(); } },
        t, h('span', { class: 'n' }, String(cnt[k])))));
  }

  function jump(name) {
    if (st.filter !== 'all' && !(res.draw.groups.find((g) => g.name === name)?.rows.some(matches))) { st.filter = 'all'; save(st); drawAll(); }
    delete st.closed[name]; save(st); drawRows();
    const el = board.querySelector(`[data-group="${CSS.escape(name)}"]`);
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
  }

  function drawRows() {
    const d = res?.draw;
    if (!d) return;
    const hadFocus = board.contains(document.activeElement);
    const keep = hadFocus ? document.activeElement.getAttribute('data-sym') || document.activeElement.getAttribute('data-group') : null;
    board.replaceChildren();
    let any = false;
    for (const g of d.groups) {
      const rows = g.rows.filter(matches);
      if (!rows.length) continue;
      any = true;
      const closed = !!st.closed[g.name];
      const inN = g.rows.filter((r) => r.inc).length;
      const gh = h('div', { class: 'grp', role: 'row', tabindex: '-1', 'data-group': g.name, 'aria-expanded': String(!closed),
        onclick: () => { st.closed[g.name] = !closed; if (!st.closed[g.name]) delete st.closed[g.name]; save(st); drawRows(); } },
      h('span', { class: 'caret', 'aria-hidden': 'true' }, closed ? '▸' : '▾'),
      h('b', {}, g.name),
      h('span', { class: 'gc' }, ['added', 'removed', 'tomodule', 'builtin', 'changed', 'dropped', 'default', 'toolchain'].filter((k) => g.counts[k]).map((k) =>
        h('span', { class: `gk ${KIND[k].cls}`, title: KIND[k].label }, `${KIND[k].short} ${g.counts[k]}`))),
      h('span', { class: 'gin' }, `${inN} in fragment`));
      board.append(gh);
      if (closed) continue;
      for (const r of rows) board.append(rowEl(r, d));
    }
    if (!any) {
      board.append(h('div', { class: 'empty' }, d.groups.length ? 'No difference matches this filter.' :
        (d.sides.a.symbols && d.sides.b.symbols ? 'The two configs set every symbol the same way.' : 'Paste config A and config B in Source files above.')));
    }
    const target = keep && (board.querySelector(`[data-sym="${CSS.escape(keep)}"]`) || board.querySelector(`[data-group="${CSS.escape(keep)}"]`));
    const f = focusSym && board.querySelector(`[data-sym="${CSS.escape(focusSym)}"]`);
    const first = board.querySelector('.row, .grp');
    for (const el of board.querySelectorAll('.row, .grp')) el.tabIndex = -1;
    const roving = target || f || first;
    if (roving) roving.tabIndex = 0;
    if (hadFocus && roving) roving.focus({ preventScroll: true });
  }

  function rowEl(r, d) {
    const k = KIND[r.kind];
    const can = r.inc || canInclude(r);
    const el = h('div', { class: `row ${k.cls}${r.inc ? ' inc' : ''}${r.dep ? ' risk' : ''}${can ? '' : ' fixed'}`, role: 'row', tabindex: '-1', 'data-sym': r.sym,
      'aria-checked': String(!!r.inc), 'aria-label': `CONFIG_${r.sym}: ${r.a ?? 'absent'} to ${r.b ?? 'absent'}, ${k.label}${r.inc ? ', in fragment' : ''}`,
      title: [r.la ? `A line ${r.la}` : '', r.lb ? `B line ${r.lb}` : '', r.why].filter(Boolean).join(' · ') || null,
      onclick: () => toggle(r) },
    h('span', { class: 'box', 'aria-hidden': 'true' }, r.inc ? '✓' : ''),
    h('span', { class: 'sym' }, h('span', { class: 'pre' }, 'CONFIG_'), r.sym),
    h('span', { class: 'vals' }, chip(r.a, 'a', r.kind, d.kindA), h('span', { class: 'arr', 'aria-hidden': 'true' }, '→'), chip(r.b, 'b', r.kind, d.kindB)),
    h('span', { class: `kind ${k.cls}` }, k.label),
    h('span', { class: 'why' }, r.dep ? h('span', { class: 'dep' }, `⚠ ${r.dep}`) : (k.cls === 'k-tri' ? '' : r.why) || (r.inc !== r.byDefault ? (r.inc ? 'added to the fragment by hand' : 'left out by hand') : '')));
    return el;
  }

  board.addEventListener('keydown', (e) => {
    const items = [...board.querySelectorAll('.row, .grp')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (j) => { e.preventDefault(); const t = items[Math.max(0, Math.min(items.length - 1, j))]; for (const x of items) x.tabIndex = -1; t.tabIndex = 0; t.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'PageDown') go(i + 10);
    else if (e.key === 'PageUp') go(i - 10);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); items[i].click(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && items[i].classList.contains('grp')) {
      const name = items[i].getAttribute('data-group');
      const want = e.key === 'ArrowLeft';
      if (!!st.closed[name] !== want) { e.preventDefault(); items[i].click(); }
    }
  });

  function drawSide(d) {
    fragHead.replaceChildren(
      h('h2', {}, 'Fragment'),
      h('span', { class: 'fsum' }, h('b', {}, String(d.fragCount)), ` line${d.fragCount === 1 ? '' : 's'}`,
        d.risky ? [' · ', h('b', { class: 'c-warn' }, `${d.risky} at risk`)] : ' · none at risk'),
      h('span', { class: 'fhint' }, 'for SRC_URI += "file://', h('code', {}, d.name), '"'));
    const w = res.warnings || [];
    warns.replaceChildren(...w.map((x) => h('div', {}, x)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((x) => h('div', {}, x)));
  }

  function drawSources(d) {
    for (const key of ['a', 'b']) {
      const s = d.sides[key], S = src[key];
      const kind = key === 'a' ? d.kindA : d.kindB;
      S.stat.replaceChildren(h('b', {}, String(s.symbols)), ' symbols · ', kind === 'full' ? 'full .config' : 'defconfig',
        s.unreadCount ? [' · ', h('b', { class: 'c-warn' }, `${s.unreadCount} unread`)] : null,
        s.dups ? [' · ', h('b', { class: 'c-warn' }, `${s.dups} repeated`)] : null);
      const cur = ctx.raw[S.kindKey] || 'auto';
      for (const b of S.seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === cur));
      S.unread.replaceChildren(...s.unread.map((u) => h('div', {}, h('span', { class: 'ln' }, `line ${u.line}`), ' ', u.text)));
    }
    srcSum.replaceChildren(...[
      h('span', { class: 'ss' }, h('b', { class: 'tag' }, 'A'), ` ${d.sides.a.symbols} symbols, ${d.kindA === 'full' ? '.config' : 'defconfig'}`),
      h('span', { class: 'ss' }, h('b', { class: 'tag' }, 'B'), ` ${d.sides.b.symbols} symbols, ${d.kindB === 'full' ? '.config' : 'defconfig'}`),
      (d.sides.a.unreadCount || d.sides.b.unreadCount) ? h('b', { class: 'c-warn' }, `${d.sides.a.unreadCount + d.sides.b.unreadCount} lines unread`) : null,
      h('span', { class: 'open' }, 'paste · drop · swap')].filter(Boolean));
  }

  function sync(force) {
    const r = ctx.raw;
    for (const key of ['a', 'b']) if ((force || document.activeElement !== src[key].ta) && src[key].ta.value !== (r[key] ?? '')) src[key].ta.value = r[key] ?? '';
    if (force || document.activeElement !== nameIn) nameIn.value = r.name ?? '';
  }

  function drawAll() {
    const d = res?.draw;
    if (!d) return;
    drawHead(d); drawRows(); drawSide(d); drawSources(d);
  }

  // The fragment is what this page is for: its tab first, unless the person
  // picked another one before (the kit remembers that).
  let firstTab = false;
  try { firstTab = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`) == null; } catch { /* ignore */ }
  ctx.onResult((r) => {
    res = r; sync(false); drawAll();
    if (firstTab) { firstTab = false; ctx.outputs.querySelector('.k-tab')?.click(); }
  });
}
