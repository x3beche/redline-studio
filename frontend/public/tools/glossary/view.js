// The project record: this tool's term list is one shared document per
// project in the app (/api/tools/data/glossary?project=<name>), so every room
// and every agent (MCP tool_data) reads the same list. It is loaded when the
// tool opens and written back only when "Save to project" is pressed.
// run() stays pure: the record reaches it as ordinary inputs, via api.set.
// Opened as a file there is no app to ask, and the panel says so.

const TOOL = 'glossary';
const KEYS = ['terms'];          // the inputs that make up the record

const st = { project: null, loaded: false, busy: false, msg: '', tone: '', updated: null, saved: null };
let ctx = null;                 // the latest (el, api) the kit gave us

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const current = () => Object.fromEntries(KEYS.map((k) => [k, ctx.api.raw[k] ?? null]));
const dirty = () => {
  if (st.saved == null) return true;
  const was = JSON.parse(st.saved);
  return KEYS.some((k) => !(k in was) || JSON.stringify(ctx.api.raw[k] ?? null) !== JSON.stringify(was[k]));
};
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};
const url = () => `/api/tools/data/${TOOL}?project=${encodeURIComponent(st.project)}`;

async function load() {
  st.busy = true; st.msg = `Loading project "${st.project}"…`; st.tone = ''; draw();
  try {
    const r = await fetch(url());
    if (!r.ok) throw new Error(`the app answered ${r.status}`);
    const body = await r.json();
    const data = body.data || {};
    const has = KEYS.filter((k) => k in data);
    st.loaded = true; st.busy = false; st.updated = body.updated || null;
    if (!has.length) {
      st.saved = null;
      st.msg = `Nothing saved for project "${st.project}" yet. The form shows your last edit or the example: change it and press Save to project.`;
      st.tone = 'warn'; draw();
      return;
    }
    st.saved = JSON.stringify(Object.fromEntries(has.map((k) => [k, data[k]])));
    st.msg = `Loaded project "${st.project}".`; st.tone = 'ok';
    for (const k of has) ctx.api.set(k, structuredClone(data[k]));
  } catch (e) {
    st.loaded = true; st.busy = false;
    st.msg = `Could not load the project record (${e.message || e}). The form still works; save again later.`; st.tone = 'bad';
    draw();
  }
}

async function save() {
  st.busy = true; st.msg = 'Saving…'; st.tone = ''; draw();
  const data = current();
  try {
    const r = await fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json','X-Redline-CSRF':'1' }, body: JSON.stringify({ data }) });
    if (!r.ok) {
      let why = String(r.status);
      try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
      throw new Error(r.status === 403 ? `not allowed to edit this project (${why})` : why);
    }
    const body = await r.json();
    st.saved = JSON.stringify(data); st.updated = body.updated || new Date().toISOString();
    st.msg = `Saved to project "${st.project}".`; st.tone = 'ok';
  } catch (e) {
    st.msg = `Not saved: ${e.message || e}.`; st.tone = 'bad';
  }
  st.busy = false; draw();
}

function draw() {
  if (!ctx) return;
  const tone = (t) => `var(${t === 'bad' ? '--danger' : t === 'warn' ? '--warn' : t === 'ok' ? '--ok' : '--ink-soft'})`;
  const changed = st.loaded && !st.busy && dirty();
  const project = $('input', { type: 'text', value: st.project, 'aria-label': 'Project', spellcheck: 'false',
    style: 'width:9em;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--sunken);color:var(--ink);font:12px ui-monospace,monospace',
    onchange: (e) => {
      const p = e.target.value.trim() || 'default';
      if (p === st.project) return;
      if (st.saved != null && dirty() && !confirm(`Load project "${p}"? Unsaved changes here stay in the form only if "${p}" has no record yet.`)) { e.target.value = st.project; return; }
      st.project = p; st.saved = null; load();
    } });
  project.value = st.project;
  ctx.el.replaceChildren($('div', { class: 'k-block' },
    $('div', { class: 'k-title' }, 'Project record'),
    $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      $('label', { style: 'font-size:12px;color:var(--ink-soft);display:flex;gap:6px;align-items:center' }, 'Project', project),
      $('button', { class: 'k-btn k-primary', disabled: st.busy, onclick: save }, st.busy ? 'Working…' : 'Save to project'),
      $('button', { class: 'k-btn', disabled: st.busy, title: 'Load the saved record again (replaces the form)',
        onclick: () => { if (!dirty() || st.saved == null || confirm('Replace the form with the saved record?')) load(); } }, 'Reload'),
      $('span', { style: `font-size:12px;color:${changed ? 'var(--warn)' : 'var(--ink-soft)'}` },
        st.updated ? `Last saved ${when(st.updated)}` : 'Never saved', changed ? ' · unsaved changes' : '')),
    st.msg ? $('div', { role: 'status', style: `font-size:12px;margin-top:6px;color:${tone(st.tone)}` }, st.msg) : null,
    $('div', { style: 'font-size:11px;color:var(--ink-soft);margin-top:4px' },
      `Agents read and write the same record with the MCP tool tool_data (id "${TOOL}", project "${st.project}").`)));
}

export function view(el, result, input, api) {
  ctx = { el, api };
  if (!/^https?:/.test(location.protocol)) {
    el.replaceChildren($('div', { class: 'k-block' }, $('div', { class: 'k-title' }, 'Project record'),
      $('div', { style: 'font-size:12px;color:var(--ink-soft)' },
        'Open this tool in the app to load and save the project\'s shared record. Opened as a file it works on the form only: copy the JSON output to keep what you typed.')));
    return;
  }
  if (st.project == null) {
    let p = null;
    try { p = new URLSearchParams(location.search).get('project'); } catch { /* no query */ }
    st.project = (p || 'default').trim() || 'default';
  }
  if (!st.loaded && !st.busy) { load(); return; }
  draw();
}

// ---------------------------------------------------------------------------
// The page ("layout": "custom"): the glossary is a dictionary, and a document
// is where its words are used.
//   Document  - the pasted text set as a page; every acronym run() found is a
//               mark in it: defined ones underlined, undefined ones in red.
//               Point at a mark for its meaning; click a defined one to open
//               its entry, an undefined one to add it. "Edit" turns the page
//               into a text box.
//   Book      - the entries A-Z under letter heads, with a thumb index down
//               the edge and the see-also references drawn as arcs in the
//               margin (a dangling one ends in a red stub). Click an entry to
//               edit it in place; the domain tabs and search narrow the book.
// Every entry, flag, count and mark comes from run()'s result (book, marks,
// unknown); the page only lays them out.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const DOMS = ['all', 'project', 'cad', 'pcb', 'web', 'embedded', 'mobile'];
const DOM_TABS = [['any', 'Any'], ['project', 'Project'], ['cad', 'CAD'], ['pcb', 'PCB'], ['web', 'Web'], ['embedded', 'Embedded'], ['mobile', 'Mobile']];
const letterOf = (t) => { const c = String(t).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };

export function page(root, k) {
  const st = { sel: null, edit: false, add: null, focusRow: null };
  const res = () => k.result || {};
  const rows = () => structuredClone(k.raw.terms || []);

  // ---------- skeleton ----------
  const search = $('input', { type: 'search', class: 'gl-search', placeholder: 'Search terms and meanings', 'aria-label': 'Search the glossary', spellcheck: 'false' });
  search.addEventListener('input', () => k.set('filter', search.value));
  const domTabs = $('div', { class: 'gl-doms', role: 'tablist', 'aria-label': 'Domain' });

  const modeBtn = $('button', { class: 'k-btn', type: 'button' });
  const docStat = $('span', { class: 'gl-sub' });
  const page = $('div', { class: 'gl-page', 'aria-live': 'off' });
  const ta = $('textarea', { class: 'gl-ta', spellcheck: 'false', 'aria-label': 'Document text', placeholder: 'Paste a note, a spec or a README: the acronyms it uses are marked against the glossary.' });
  ta.addEventListener('input', () => k.set('text', ta.value));
  const tip = $('div', { class: 'gl-tip', role: 'tooltip' });
  const missing = $('div', { class: 'gl-missing' });
  const docPanel = $('section', { class: 'gl-panel gl-docp' },
    $('div', { class: 'gl-head' }, $('h2', {}, 'Document'), docStat, $('span', { class: 'gl-grow' }), modeBtn),
    $('div', { class: 'gl-sheet' }, page, ta, tip), missing);
  modeBtn.addEventListener('click', () => { st.edit = !st.edit; render(); if (st.edit) ta.focus(); });
  page.addEventListener('dblclick', () => { st.edit = true; render(); ta.focus(); });

  const bookStat = $('span', { class: 'gl-sub' });
  const addBtn = $('button', { class: 'k-btn k-primary', type: 'button', onclick: () => openAdd('') }, '+ New term');
  const addBox = $('div', { class: 'gl-add' });
  const entries = $('div', { class: 'gl-entries' });
  const arcs = sv('svg', { class: 'gl-arcs', 'aria-hidden': 'true' });
  const scroller = $('div', { class: 'gl-scroll' }, $('div', { class: 'gl-leaves' }, arcs, entries));
  const thumbs = $('nav', { class: 'gl-thumbs', 'aria-label': 'Jump to letter' });
  const bookPanel = $('section', { class: 'gl-panel gl-bookp' },
    $('div', { class: 'gl-head' }, $('h2', {}, 'Glossary'), bookStat, $('span', { class: 'gl-grow' }), addBtn),
    $('div', { class: 'gl-tools' }, domTabs, search), addBox,
    $('div', { class: 'gl-book' }, scroller, thumbs));

  const warns = $('div', { class: 'k-warns', role: 'alert' });
  const record = $('div', { class: 'gl-record' });
  const all = $('details', { class: 'gl-panel gl-all' }, $('summary', {}, 'All rows as a table'), k.form);
  root.append($('div', { class: 'gl' },
    $('div', { class: 'gl-work' }, $('div', { class: 'gl-col gl-left' }, docPanel, warns, record), bookPanel),
    $('div', { class: 'gl-bottom' }, all, k.outputs)));

  // ---------- actions ----------
  const setRows = (r) => k.set('terms', r);
  const select = (row, focus) => {
    st.sel = st.sel === row && !focus ? null : row; st.focusRow = focus ? row : null; render();
    const el = entries.querySelector(`[data-row="${row}"]`);
    if (el) { el.scrollIntoView({ block: 'nearest' }); if (focus) (el.querySelector('input') || el).focus(); }
  };
  function openAdd(term) {
    st.add = { term, expansion: '', definition: '', domain: k.raw.domain && k.raw.domain !== 'any' ? k.raw.domain : 'all', see: '' };
    render();
    const f = addBox.querySelector(term ? '[name=expansion]' : '[name=term]'); if (f) f.focus();
  }
  const commitAdd = () => {
    const a = st.add; if (!a || !a.term.trim()) return;
    const r = rows(); r.push({ term: a.term.trim(), expansion: a.expansion.trim(), definition: a.definition.trim(), domain: a.domain, see: a.see.trim() });
    st.add = null; st.sel = r.length - 1; setRows(r);
  };
  const editField = (row, key, value) => { const r = rows(); if (!r[row]) return; r[row][key] = value; setRows(r); };
  const del = (row) => { const r = rows(); r.splice(row, 1); st.sel = null; setRows(r); };

  // ---------- tooltip ----------
  const showTip = (el) => {
    const term = el.dataset.term; const b = (res().book || []).find((e) => e.term.toLowerCase() === term.toLowerCase());
    tip.replaceChildren(b
      ? $('div', {}, $('b', {}, b.term), b.expansion ? ` ${b.expansion}` : '', b.definition ? $('div', { class: 'gl-tipdef' }, b.definition) : null,
        $('div', { class: 'gl-tipsoft' }, `${b.domain} · click to open the entry`))
      : $('div', {}, $('b', {}, term), $('div', { class: 'gl-tipbad' }, 'Not in the glossary'), $('div', { class: 'gl-tipsoft' }, 'click to add it')));
    tip.style.display = 'block';
    const sr = tip.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
    let x = r.left - sr.left, y = r.bottom - sr.top + 6;
    x = Math.max(4, Math.min(x, sr.width - tip.offsetWidth - 4));
    if (y + tip.offsetHeight > sr.height && r.top - sr.top - tip.offsetHeight - 6 > 0) y = r.top - sr.top - tip.offsetHeight - 6;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const hideTip = () => { tip.style.display = 'none'; };

  // ---------- document ----------
  function drawDoc() {
    const text = String(k.raw.text ?? '');
    const marks = res().marks || [];
    const b = res().book || [];
    const selTerm = st.sel != null ? b.find((e) => e.row === st.sel)?.term.toLowerCase() : null;
    const nodes = [];
    let at = 0;
    for (const m of marks) {
      if (m.start < at) continue;
      nodes.push(text.slice(at, m.start));
      const on = selTerm && m.term.toLowerCase() === selTerm;
      const btn = $('button', { type: 'button', class: `gl-m ${m.known ? 'gl-known' : 'gl-unknown'}${on ? ' gl-on' : ''}`, 'data-term': m.term,
        'aria-label': `${m.term}: ${m.known ? 'defined, open the entry' : 'not in the glossary, add it'}` }, text.slice(m.start, m.end));
      btn.addEventListener('pointerenter', () => showTip(btn)); btn.addEventListener('pointerleave', hideTip);
      btn.addEventListener('focus', () => showTip(btn)); btn.addEventListener('blur', hideTip);
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); hideTip();
        const hit = b.find((x) => x.term.toLowerCase() === m.term.toLowerCase());
        if (hit) select(hit.row); else openAdd(m.term);
      });
      nodes.push(btn);
      at = m.end;
    }
    nodes.push(text.slice(at));
    if (!text.trim()) nodes.splice(0, nodes.length, $('span', { class: 'gl-empty' }, 'No document yet. Press Edit (or double-click here) and paste a note, a spec or a README: every acronym in it is marked against the glossary.'));
    page.replaceChildren(...nodes);
    page.hidden = st.edit; ta.hidden = !st.edit;
    if (document.activeElement !== ta) ta.value = text;
    modeBtn.textContent = st.edit ? 'Done' : 'Edit';
    modeBtn.setAttribute('aria-pressed', String(st.edit));

    const un = res().unknown || [];
    const used = new Set(marks.map((m) => m.term.toLowerCase()));
    docStat.textContent = text.trim() ? `${used.size} acronym${used.size === 1 ? '' : 's'} · ${un.length} not defined` : '';
    missing.replaceChildren(...(un.length ? [$('span', { class: 'gl-mlabel' }, 'Not in the glossary:'),
      ...un.map((u) => $('button', { type: 'button', class: 'gl-chip', title: `…${u.ctx}…`, onclick: () => openAdd(u.term) },
        $('b', {}, u.term), $('span', {}, `×${u.count}`), $('i', {}, '+ add')))]
      : text.trim() ? [$('span', { class: 'gl-ok' }, 'Every acronym in the document is in the glossary.')] : []));
  }

  // ---------- book ----------
  function field(label, name, value, onCommit, opts = {}) {
    const c = opts.area ? $('textarea', { name, rows: 2, spellcheck: 'false' }) : $('input', { type: 'text', name, spellcheck: 'false' });
    c.value = value ?? '';
    c.addEventListener('change', () => onCommit(c.value));
    if (!opts.area) c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); c.blur(); } });
    return $('label', { class: `gl-f${opts.wide ? ' gl-wide' : ''}` }, $('span', {}, label), c);
  }
  function domSel(value, onCommit) {
    const s = $('select', { name: 'domain' }, DOMS.map((d) => $('option', { value: d, selected: d === value }, d)));
    s.addEventListener('change', () => onCommit(s.value));
    return $('label', { class: 'gl-f' }, $('span', {}, 'Domain'), s);
  }

  function drawAdd() {
    const a = st.add;
    if (!a) { addBox.replaceChildren(); addBox.hidden = true; return; }
    addBox.hidden = false;
    const exists = (res().book || []).find((e) => e.term.toLowerCase() === a.term.trim().toLowerCase());
    const inp = (name, label, wide) => {
      const c = $('input', { type: 'text', name, spellcheck: 'false', placeholder: label });
      c.value = a[name];
      c.addEventListener('input', () => { a[name] = c.value; if (name === 'term') hint.textContent = dupText(); });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') { st.add = null; render(); } });
      return $('label', { class: `gl-f${wide ? ' gl-wide' : ''}` }, $('span', {}, label), c);
    };
    const dupText = () => {
      const x = (res().book || []).find((e) => e.term.toLowerCase() === a.term.trim().toLowerCase());
      return x ? `${x.term} is already in the glossary (${x.expansion || x.definition}); a second row needs its own domain.` : '';
    };
    const hint = $('div', { class: 'gl-hint' }, exists ? dupText() : '');
    const dom = domSel(a.domain, (v) => { a.domain = v; });
    addBox.replaceChildren($('div', { class: 'gl-addgrid' },
      inp('term', 'Term'), inp('expansion', 'Stands for', true), dom, inp('definition', 'Meaning', true), inp('see', 'See also')),
    hint,
    $('div', { class: 'gl-row' }, $('button', { class: 'k-btn k-primary', type: 'button', onclick: commitAdd }, 'Add to glossary'),
      $('button', { class: 'k-btn', type: 'button', onclick: () => { st.add = null; render(); } }, 'Cancel'),
      $('span', { class: 'gl-sub' }, 'Enter adds, Esc cancels')));
  }

  function drawBook() {
    const r = res();
    const book = r.book || [];
    const shown = book.filter((e) => e.shown);
    const probs = book.filter((e) => e.issues.length || e.dangling.length).length;
    bookStat.textContent = `${shown.length}${shown.length !== book.length ? ` of ${book.length}` : ''} term${book.length === 1 ? '' : 's'}${probs ? ` · ${probs} flagged` : ''}`;
    if (document.activeElement !== search) search.value = k.raw.filter || '';
    const dom = k.raw.domain || 'any';
    domTabs.replaceChildren(...DOM_TABS.map(([v, t]) => {
      const n = v === 'any' ? book.length : book.filter((e) => e.domain === v || e.domain === 'all').length;
      return $('button', { type: 'button', role: 'tab', class: 'gl-dom', 'aria-selected': String(v === dom), onclick: () => k.set('domain', v) },
        t, n ? $('small', {}, String(n)) : null);
    }));

    const byLetter = new Map();
    for (const e of shown) { const L = letterOf(e.term); if (!byLetter.has(L)) byLetter.set(L, []); byLetter.get(L).push(e); }
    const kids = [];
    for (const [L, list] of byLetter) {
      kids.push($('div', { class: 'gl-letter', id: `gl-L-${L}` }, L));
      for (const e of list) kids.push(entryEl(e, book));
    }
    if (!shown.length) kids.push($('div', { class: 'gl-empty' }, book.length ? 'No term matches the search or the domain.' : 'The glossary is empty. Press + New term, or click a red acronym in the document.'));
    entries.replaceChildren(...kids);

    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
    thumbs.replaceChildren(...letters.map((L) => {
      const n = byLetter.get(L)?.length || 0;
      return $('button', { type: 'button', class: 'gl-thumb', disabled: !n, 'aria-label': n ? `${L}: ${n} term${n === 1 ? '' : 's'}` : `${L}: none`,
        onclick: () => { const t = entries.querySelector(`#gl-L-${L === '#' ? '\\#' : L}`); if (t) scroller.scrollTo({ top: t.offsetTop - 4, behavior: 'smooth' }); } }, L);
    }));
    requestAnimationFrame(drawArcs);
  }

  function entryEl(e, book) {
    const sel = st.sel === e.row;
    const bad = e.issues.length || e.dangling.length;
    const see = e.see.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    const seeLinks = see.map((s) => {
      const t = book.find((x) => x.term.toLowerCase() === s.toLowerCase());
      return t ? $('button', { type: 'button', class: 'gl-see', onclick: (ev) => { ev.stopPropagation(); select(t.row); } }, t.term)
        : $('span', { class: 'gl-see gl-dangle', title: 'Not in the glossary' }, s);
    });
    const art = $('article', { class: `gl-e${sel ? ' gl-sel' : ''}${bad ? ' gl-bad' : ''}`, 'data-row': e.row, 'data-term': e.term.toLowerCase(), tabindex: '0',
      'aria-label': `${e.term}${e.expansion ? ', ' + e.expansion : ''}` });
    const head = $('div', { class: 'gl-ehead' },
      $('b', { class: 'gl-term' }, e.term),
      e.expansion ? $('span', { class: 'gl-exp' }, e.expansion) : null,
      $('span', { class: `gl-domtag d-${e.domain}` }, e.domain),
      e.uses ? $('span', { class: 'gl-uses', title: 'Times in the document' }, `${e.uses}× in text`) : null);
    art.append(head);
    if (!sel) {
      if (e.definition) art.append($('p', { class: 'gl-def' }, e.definition));
      if (see.length) art.append($('div', { class: 'gl-seerow' }, $('span', {}, 'see also'), ...seeLinks));
    } else {
      art.append($('div', { class: 'gl-edit', onclick: (ev) => ev.stopPropagation() },
        field('Term', 'term', e.term, (v) => editField(e.row, 'term', v)),
        field('Stands for', 'expansion', e.expansion, (v) => editField(e.row, 'expansion', v), { wide: true }),
        field('Meaning', 'definition', e.definition, (v) => editField(e.row, 'definition', v), { wide: true, area: true }),
        domSel(e.domain, (v) => editField(e.row, 'domain', v)),
        field('See also', 'see', e.see, (v) => editField(e.row, 'see', v)),
        $('div', { class: 'gl-row gl-wide' },
          $('button', { class: 'k-btn', type: 'button', onclick: () => { st.sel = null; render(); art.focus(); } }, 'Close'),
          $('span', { class: 'gl-grow' }),
          $('button', { class: 'k-btn gl-del', type: 'button', onclick: () => del(e.row) }, 'Delete term'))));
    }
    for (const i of e.issues) art.append($('div', { class: 'gl-issue' }, i));
    for (const d of e.dangling) art.append($('div', { class: 'gl-issue' }, `see also ${d}: not in the glossary`));
    art.addEventListener('click', () => { if (!sel) select(e.row); });
    art.addEventListener('keydown', (ev) => {
      if (ev.target !== art) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(e.row, true); }
      if (ev.key === 'Escape' && sel) { st.sel = null; render(); }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const all = [...entries.querySelectorAll('.gl-e')]; const i = all.indexOf(art);
        const nx = all[i + (ev.key === 'ArrowDown' ? 1 : -1)]; if (nx) nx.focus();
      }
      if (ev.key === 'Delete' && ev.shiftKey) del(e.row);
    });
    art.addEventListener('focus', () => { for (const m of page.querySelectorAll('.gl-m')) m.classList.toggle('gl-hot', m.dataset.term.toLowerCase() === e.term.toLowerCase()); });
    art.addEventListener('blur', () => { for (const m of page.querySelectorAll('.gl-hot')) m.classList.remove('gl-hot'); });
    return art;
  }

  // See-also references as arcs in the left margin of the book.
  function drawArcs() {
    arcs.replaceChildren();
    const box = entries.getBoundingClientRect();
    if (!box.height) return;
    arcs.setAttribute('height', String(entries.scrollHeight));
    arcs.setAttribute('viewBox', `0 0 26 ${entries.scrollHeight}`);
    const pos = new Map();
    for (const a of entries.querySelectorAll('.gl-e')) {
      const t = a.querySelector('.gl-term'); const r = t.getBoundingClientRect();
      pos.set(a.dataset.term, r.top - box.top + r.height / 2);
    }
    const done = new Set();
    let lane = 0;
    for (const e of (res().book || []).filter((x) => x.shown)) {
      const y1 = pos.get(e.term.toLowerCase()); if (y1 == null) continue;
      for (const s of e.see.split(/[,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        const y2 = pos.get(s);
        const key = [e.term.toLowerCase(), s].sort().join('|');
        if (y2 == null) {
          if (e.dangling.some((d) => d.toLowerCase() === s)) {
            arcs.append(sv('path', { d: `M24,${y1} H12 v-9`, class: 'gl-arc gl-arcbad' }), sv('circle', { cx: 12, cy: y1 - 11, r: 2.4, class: 'gl-arcdot' }));
          }
          continue;
        }
        if (done.has(key)) continue;
        done.add(key);
        const x = 16 - (lane++ % 3) * 5;
        const sel = st.sel != null && [e.term.toLowerCase(), s].includes((res().book || []).find((b) => b.row === st.sel)?.term.toLowerCase());
        arcs.append(sv('path', { d: `M24,${y1} H${x + 4} Q${x},${y1} ${x},${y1 + Math.sign(y2 - y1) * 4} V${y2 - Math.sign(y2 - y1) * 4} Q${x},${y2} ${x + 4},${y2} H24`, class: `gl-arc${sel ? ' gl-arcon' : ''}` }));
      }
    }
  }

  function render() {
    // An entry's editor is rebuilt on every result: keep the field that has focus.
    const act = document.activeElement;
    const keep = act && entries.contains(act) && act.name ? act.name : null;
    drawDoc(); drawAdd(); drawBook();
    if (keep) entries.querySelector(`.gl-sel [name="${keep}"]`)?.focus();
    const w = res().warnings || [];
    warns.hidden = !w.length;
    warns.replaceChildren(...w.map((x) => $('div', {}, x)));
    try { view(record, res(), k.input, { set: k.set, raw: k.raw, fmtNum: k.fmtNum }); } catch (e) { console.error(e); }
  }
  new ResizeObserver(() => requestAnimationFrame(drawArcs)).observe(entries);
  k.onResult(() => {
    if (st.sel != null && !(res().book || []).some((e) => e.row === st.sel)) st.sel = null;
    render();
    if (st.focusRow != null) st.focusRow = null;
  });
}
