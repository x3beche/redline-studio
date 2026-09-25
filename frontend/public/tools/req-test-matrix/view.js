// Requirement <-> Test Matrix: the page is the trace itself, a patch bay.
//   Left     - the requirements, each a card with its priority, how it is
//              verified and its status (colour strip), a port on its right.
//   Right    - the tests and verification records, a port on their left,
//              their result as a chip (click to step it: not run, pass,
//              fail, blocked).
//   Between  - one wire per "this test proves that requirement", coloured
//              by the test's result. A requirement with no wire shows a red
//              open stub (a gap); a test with none, a dangling port; a test
//              naming a requirement that does not exist wires into a ghost
//              card at the foot of the list.
//   Wire up by dragging from a port to a card on the other side (or with
//   the checkboxes in the inspector); select a wire and press Delete, or its
//   x, to unwire. Selecting a card lights its wires and opens it in the
//   inspector for editing.
// The project record (one shared list per project in the app, the same one
// agents read with tool_data) is loaded when the tool opens and saved on
// "Save to project". Every status and count shown comes from run()'s
// result (trace, values); the page only draws and edits the inputs.

const TOOL = 'req-test-matrix';
const KEYS = ['reqs', 'tests'];
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
const served = () => /^https?:/.test(location.protocol);
const norm = (s) => String(s ?? '').trim();
const up = (s) => norm(s).toUpperCase();
const refsOf = (text) => norm(text).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

const ORDER = ['no evidence', 'failing', 'blocked', 'not run', 'partly run', 'verified'];
const SCLS = { 'no evidence': 'gap', failing: 'fail', blocked: 'blk', 'not run': 'nr', 'partly run': 'part', verified: 'ver' };
const SWORD = { 'no evidence': 'gap', failing: 'failing', blocked: 'blocked', 'not run': 'not run', 'partly run': 'partly run', verified: 'verified' };
const RESULTS = ['not run', 'pass', 'fail', 'blocked'];
const RCLS = { 'not run': 'nr', pass: 'pass', fail: 'fail', blocked: 'blk' };
const METHOD = { test: 'T', analysis: 'A', inspection: 'I', demonstration: 'D' };
const SHOW = [['all', 'All'], ['open', 'Not verified'], ['gaps', 'Gaps'], ['failing', 'Failing']];

export function page(root, ctx) {
  const rec = { project: null, loaded: false, busy: false, msg: '', tone: '', updated: null, saved: null };
  const st = { sel: null, wire: null, drag: null, arm: null, lastSelKey: null };
  const T = () => ctx.result?.trace || null;
  const rowsOf = (k) => structuredClone(ctx.raw[k] || []);

  // ---------- skeleton ----------
  const projIn = h('input', { type: 'text', 'aria-label': 'Project', spellcheck: 'false', class: 'rt-proj' });
  const saveBtn = h('button', { class: 'k-btn k-primary', type: 'button' }, 'Save to project');
  const reloadBtn = h('button', { class: 'k-btn', type: 'button', title: 'Load the saved record again (replaces what is here)' }, 'Reload');
  const recMsg = h('span', { class: 'rt-msg', role: 'status' });
  const recBox = h('div', { class: 'rt-rec' }, h('label', { class: 'rt-f' }, h('span', {}, 'Project'), projIn), saveBtn, reloadBtn, recMsg);
  const showSeg = h('div', { class: 'rt-seg', role: 'group', 'aria-label': 'Highlight' });
  const ribbon = h('div', { class: 'rt-ribbon', role: 'img' });
  const ribKey = h('div', { class: 'rt-ribkey' });
  const big = h('div', { class: 'rt-big' });
  const top = h('section', { class: 'rt-panel rt-top' },
    h('div', { class: 'rt-toprow' }, recBox, h('span', { class: 'rt-grow' }), h('span', { class: 'rt-k' }, 'Highlight'), showSeg),
    h('div', { class: 'rt-cover' }, big, h('div', { class: 'rt-ribwrap' }, ribbon, ribKey)));

  const reqCol = h('div', { class: 'rt-col rt-reqs' });
  const testCol = h('div', { class: 'rt-col rt-tests' });
  const gutter = h('div', { class: 'rt-gutter', 'aria-hidden': 'true' });
  const wires = sv('svg', { class: 'rt-wires' });
  const bay = h('div', { class: 'rt-bay' }, reqCol, gutter, testCol, wires);
  const reqHead = h('div', { class: 'rt-colhead' });
  const testHead = h('div', { class: 'rt-colhead' });
  const armBar = h('div', { class: 'rt-arm', role: 'status' });
  const bayPanel = h('section', { class: 'rt-panel rt-baypanel' },
    h('div', { class: 'rt-bayhead' }, reqHead, h('div', { class: 'rt-gh' }), testHead), armBar, bay,
    h('div', { class: 'rt-legend' },
      h('span', {}, h('i', { class: 'lw pass' }), 'pass'), h('span', {}, h('i', { class: 'lw fail' }), 'fail'),
      h('span', {}, h('i', { class: 'lw blk' }), 'blocked'), h('span', {}, h('i', { class: 'lw nr' }), 'not run'),
      h('span', {}, h('i', { class: 'lw gap' }), 'no evidence'),
      h('span', { class: 'rt-hint' }, 'Drag from a port to a card on the other side to wire it · click a wire, then Delete to unwire · click a result to step it')));
  const insp = h('section', { class: 'rt-panel rt-insp', 'aria-label': 'Inspector' });

  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const tables = h('details', { class: 'rt-panel rt-tables' }, h('summary', {}, 'Both lists as tables'), ctx.form);
  root.append(h('div', { class: 'rt' }, top,
    h('div', { class: 'rt-work' }, bayPanel, insp),
    h('div', { class: 'rt-bottom' }, h('div', { class: 'rt-msgs' }, warns, notes, tables), ctx.outputs)));

  // ---------- project record (the live half) ----------
  const current = () => Object.fromEntries(KEYS.map((k) => [k, ctx.raw[k] ?? null]));
  const dirty = () => {
    if (rec.saved == null) return true;
    const was = JSON.parse(rec.saved);
    return KEYS.some((k) => !(k in was) || JSON.stringify(ctx.raw[k] ?? null) !== JSON.stringify(was[k]));
  };
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  const url = () => `/api/tools/data/${TOOL}?project=${encodeURIComponent(rec.project)}`;
  async function load() {
    rec.busy = true; rec.msg = `Loading "${rec.project}"…`; rec.tone = ''; drawRec();
    try {
      const r = await fetch(url());
      if (!r.ok) throw new Error(`the app answered ${r.status}`);
      const body = await r.json();
      const data = body.data || {};
      const has = KEYS.filter((k) => k in data);
      rec.loaded = true; rec.busy = false; rec.updated = body.updated || null;
      if (!has.length) {
        rec.saved = null; rec.msg = `Nothing saved for "${rec.project}" yet: edit, then save.`; rec.tone = 'warn'; drawRec(); return;
      }
      rec.saved = JSON.stringify(Object.fromEntries(has.map((k) => [k, data[k]])));
      rec.msg = `Loaded "${rec.project}".`; rec.tone = 'ok';
      st.sel = null;
      ctx.setMany(Object.fromEntries(has.map((k) => [k, structuredClone(data[k])])));
    } catch (e) {
      rec.loaded = true; rec.busy = false;
      rec.msg = `Could not load the record (${e.message || e}); editing here still works.`; rec.tone = 'bad'; drawRec();
    }
  }
  async function save() {
    rec.busy = true; rec.msg = 'Saving…'; rec.tone = ''; drawRec();
    const data = current();
    try {
      const r = await fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify({ data }) });
      if (!r.ok) {
        let why = String(r.status);
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 403 ? `not allowed to edit this project (${why})` : why);
      }
      const body = await r.json();
      rec.saved = JSON.stringify(data); rec.updated = body.updated || new Date().toISOString();
      rec.msg = `Saved to "${rec.project}".`; rec.tone = 'ok';
    } catch (e) { rec.msg = `Not saved: ${e.message || e}.`; rec.tone = 'bad'; }
    rec.busy = false; drawRec();
  }
  saveBtn.addEventListener('click', save);
  reloadBtn.addEventListener('click', () => { if (!dirty() || rec.saved == null || confirm('Replace what is here with the saved record?')) load(); });
  projIn.addEventListener('change', () => {
    const p = projIn.value.trim() || 'default';
    if (p === rec.project) return;
    if (rec.saved != null && dirty() && !confirm(`Load project "${p}"? Unsaved changes here stay only if "${p}" has no record yet.`)) { projIn.value = rec.project; return; }
    rec.project = p; rec.saved = null; load();
  });
  function drawRec() {
    const live = served();
    projIn.disabled = !live; saveBtn.disabled = !live || rec.busy; reloadBtn.disabled = !live || rec.busy;
    if (document.activeElement !== projIn) projIn.value = rec.project || 'default';
    saveBtn.textContent = rec.busy ? 'Working…' : 'Save to project';
    const changed = live && rec.loaded && !rec.busy && dirty();
    recMsg.className = `rt-msg ${changed ? 'warn' : rec.tone}`;
    recMsg.textContent = !live ? 'Opened as a file: copy the JSON output to keep your edits'
      : changed ? `unsaved changes${rec.updated ? ` · last saved ${when(rec.updated)}` : ''}`
        : rec.msg || (rec.updated ? `Last saved ${when(rec.updated)}` : '');
    recMsg.title = `Agents read and write the same record with the MCP tool tool_data (id "${TOOL}", project "${rec.project}").`;
  }

  // ---------- edits (all through the inputs) ----------
  const setTests = (rows) => ctx.set('tests', rows);
  const link = (tRow, reqId, on) => {
    const rows = rowsOf('tests'); const t = rows[tRow]; if (!t) return;
    const list = refsOf(t.covers);
    const has = list.some((x) => up(x) === up(reqId));
    if (on && !has) list.push(reqId);
    if (!on && has) list.splice(list.findIndex((x) => up(x) === up(reqId)), 1);
    if (on === has) return;
    t.covers = list.join(', ');
    setTests(rows);
  };
  const cycle = (tRow) => {
    const rows = rowsOf('tests'); const t = rows[tRow]; if (!t) return;
    const i = RESULTS.indexOf(norm(t.result) || 'not run');
    t.result = RESULTS[(i + 1) % RESULTS.length];
    setTests(rows);
  };
  const nextId = (list, prefix) => {
    let n = list.length + 1;
    const used = new Set(list.map((x) => up(x.id)));
    const pad = (k) => `${prefix}-${String(k).padStart(2, '0')}`;
    while (used.has(pad(n))) n++;
    return pad(n);
  };
  const addReq = (id = null) => {
    const rows = rowsOf('reqs');
    rows.push({ id: id || nextId(rows, 'REQ'), text: '', priority: 'must', method: 'test' });
    st.sel = { k: 'r', row: rows.length - 1 }; st.focusText = true;
    ctx.set('reqs', rows);
  };
  const addTest = () => {
    const rows = rowsOf('tests');
    const sel = st.sel?.k === 'r' ? T()?.reqs.find((r) => r.row === st.sel.row) : null;
    rows.push({ id: nextId(rows, 'T'), name: '', covers: sel ? sel.id : '', result: 'not run' });
    st.sel = { k: 't', row: rows.length - 1 }; st.focusText = true;
    ctx.set('tests', rows);
  };
  const removeRow = (k, row) => {
    const key = k === 'r' ? 'reqs' : 'tests';
    const rows = rowsOf(key); const gone = rows[row];
    if (!gone) return;
    rows.splice(row, 1);
    st.sel = null; st.wire = null;
    if (k === 'r' && norm(gone.id)) {
      // drop the deleted requirement from every test's Covers, in one change
      const ts = rowsOf('tests');
      for (const t of ts) t.covers = refsOf(t.covers).filter((x) => up(x) !== up(gone.id)).join(', ');
      ctx.setMany({ reqs: rows, tests: ts });
    } else ctx.set(key, rows);
  };
  const renameReq = (row, id) => {
    const rows = rowsOf('reqs'); const r = rows[row]; if (!r) return;
    const old = norm(r.id); r.id = id;
    if (old && id && up(old) !== up(id)) {
      const ts = rowsOf('tests');
      for (const t of ts) t.covers = refsOf(t.covers).map((x) => (up(x) === up(old) ? id : x)).join(', ');
      ctx.setMany({ reqs: rows, tests: ts });
    } else ctx.set('reqs', rows);
  };
  const setField = (k, row, field, value) => {
    const key = k === 'r' ? 'reqs' : 'tests';
    const rows = rowsOf(key); if (!rows[row]) return;
    rows[row][field] = value; ctx.set(key, rows);
  };

  // ---------- cards ----------
  const selKey = () => (st.sel ? `${st.sel.k}:${st.sel.row}` : null);
  const related = () => {
    // what the selection lights up: its own card, the cards wired to it
    const t = T(); const on = new Set();
    if (!t || !st.sel) return null;
    if (st.sel.k === 'r') {
      const r = t.reqs.find((x) => x.row === st.sel.row); if (!r) return null;
      on.add(`r:${r.row}`);
      for (const x of t.tests) if (x.covers.includes(r.id)) on.add(`t:${x.row}`);
    } else if (st.sel.k === 't') {
      const x = t.tests.find((y) => y.row === st.sel.row); if (!x) return null;
      on.add(`t:${x.row}`);
      for (const id of x.covers) { const r = t.reqs.find((q) => q.id === id); if (r) on.add(`r:${r.row}`); }
      for (const u of x.unknown) on.add(`g:${up(u)}`);
    }
    return on;
  };

  function reqCard(r, lit) {
    const k = `r:${r.row}`;
    const card = h('div', {
      class: `rt-card rt-req s-${SCLS[r.status]}${selKey() === k ? ' is-sel' : ''}${lit && !lit.has(k) ? ' dim' : ''}${r.shown ? '' : ' off'}${st.arm?.k === 't' ? ' can-drop' : ''}`,
      'data-k': 'r', 'data-row': r.row, 'data-id': r.id, tabindex: 0, role: 'button',
      'aria-label': `${r.id}, ${r.priority}, verified by ${r.method}: ${r.text}. Status ${r.status}, ${r.tests.length} verification${r.tests.length === 1 ? '' : 's'}.${st.arm?.k === 't' ? ' Enter wires the armed test to it.' : ''}`,
    },
    h('div', { class: 'rt-c1' },
      h('b', { class: 'rt-id' }, r.id),
      h('span', { class: `rt-prio ${r.priority}` }, r.priority),
      h('span', { class: 'rt-meth', title: `verified by ${r.method}` }, METHOD[r.method] || '?', h('span', { class: 'w' }, ` ${r.method}`)),
      h('span', { class: 'rt-grow' }),
      h('span', { class: `rt-st s-${SCLS[r.status]}` }, SWORD[r.status])),
    h('div', { class: 'rt-text' }, r.text || h('i', { class: 'soft' }, 'no text yet')),
    h('button', { class: `rt-port${r.tests.length ? ' on' : ' open'}`, type: 'button', 'data-port': 'r', 'data-row': r.row,
      'aria-label': `Port of ${r.id}: drag to a test to wire it, or press Enter and then Enter on a test` }));
    return card;
  }
  function testCard(t, lit) {
    const k = `t:${t.row}`;
    const orphan = !t.covers.length && !t.unknown.length;
    const card = h('div', {
      class: `rt-card rt-test r-${RCLS[t.result]}${selKey() === k ? ' is-sel' : ''}${lit && !lit.has(k) ? ' dim' : ''}${orphan ? ' orphan' : ''}${st.arm?.k === 'r' ? ' can-drop' : ''}`,
      'data-k': 't', 'data-row': t.row, 'data-id': t.id, tabindex: 0, role: 'button',
      'aria-label': `${t.id}: ${t.name}. Result ${t.result}. Covers ${t.covers.join(', ') || 'nothing'}.${st.arm?.k === 'r' ? ' Enter wires the armed requirement to it.' : ''}`,
    },
    h('button', { class: `rt-port${orphan ? ' open' : ' on'}`, type: 'button', 'data-port': 't', 'data-row': t.row,
      'aria-label': `Port of ${t.id}: drag to a requirement to wire it, or press Enter and then Enter on a requirement` }),
    h('div', { class: 'rt-c1' },
      h('b', { class: `rt-id${t.hasId ? '' : ' bad'}` }, t.id),
      h('span', { class: 'rt-grow' }),
      h('button', { class: `rt-res r-${RCLS[t.result]}`, type: 'button', 'data-cycle': t.row, title: 'Click to step: not run, pass, fail, blocked',
        'aria-label': `Result of ${t.id}: ${t.result}. Press to change.` }, t.result)),
    h('div', { class: 'rt-text' }, t.name || h('i', { class: 'soft' }, 'no name yet')),
    orphan ? h('div', { class: 'rt-orph' }, 'covers nothing') : null);
    return card;
  }
  function ghostCard(id, lit) {
    const k = `g:${up(id)}`;
    return h('div', { class: `rt-card rt-ghost${lit && !lit.has(k) ? ' dim' : ''}`, 'data-k': 'g', 'data-id': id },
      h('div', { class: 'rt-c1' }, h('b', { class: 'rt-id' }, id), h('span', { class: 'rt-grow' }), h('span', { class: 'rt-st s-gap' }, 'not in the list')),
      h('div', { class: 'rt-text' }, 'A test points here, but there is no such requirement. ',
        h('button', { class: 'rt-link', type: 'button', 'data-addghost': id }, 'Add it')),
      h('span', { class: 'rt-port ghost' }));
  }

  // ---------- wires ----------
  function drawWires() {
    wires.replaceChildren();
    const t = T(); if (!t) return;
    const box = bay.getBoundingClientRect();
    wires.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    wires.setAttribute('width', box.width); wires.setAttribute('height', box.height);
    const portAt = (sel) => {
      const p = bay.querySelector(sel); if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    };
    const lit = related();
    const gw = gutter.getBoundingClientRect().width;
    const path = (a, b) => { const dx = Math.max(24, (b.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
    const hit = [];
    for (const x of t.tests) {
      const b = portAt(`.rt-test[data-row="${x.row}"] .rt-port`); if (!b) continue;
      for (const id of x.covers) {
        const r = t.reqs.find((q) => q.id === id);
        const a = r && portAt(`.rt-req[data-row="${r.row}"] .rt-port`); if (!a) continue;
        const key = `${r.row}>${x.row}`;
        const on = !lit || (lit.has(`r:${r.row}`) && lit.has(`t:${x.row}`));
        const sel = st.wire === key;
        const d = path(a, b);
        const faded = !r.shown;
        wires.append(sv('path', { d, class: `rt-w r-${RCLS[x.result]}${on ? '' : ' dim'}${sel ? ' sel' : ''}${faded ? ' off' : ''}` }));
        const hp = sv('path', { d, class: 'rt-whit', tabindex: 0, role: 'button', 'data-w': key, 'data-t': x.row, 'data-id': id,
          'aria-label': `Wire ${id} to ${x.id} (${x.result}). Delete removes it.` });
        hit.push(hp);
        if (sel) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const g = sv('g', { class: 'rt-cut', 'data-cut': key, 'data-t': x.row, 'data-id': id, transform: `translate(${mx} ${my})` });
          g.append(sv('circle', { r: 9 }), sv('path', { d: 'M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5' }), sv('title', {}, `Unwire ${id} from ${x.id}`));
          hit.push(g);
        }
      }
      for (const u of x.unknown) {
        const a = portAt(`.rt-ghost[data-id="${CSS.escape(u)}"] .rt-port`); if (!a) continue;
        wires.append(sv('path', { d: path(a, b), class: `rt-w unk${lit && !lit.has(`t:${x.row}`) ? ' dim' : ''}` }));
      }
    }
    // gaps: an open red stub from each requirement nothing proves
    for (const r of t.reqs) {
      if (r.tests.length) continue;
      const a = portAt(`.rt-req[data-row="${r.row}"] .rt-port`); if (!a) continue;
      const len = Math.min(gw * 0.42, 70);
      wires.append(sv('path', { d: `M${a.x},${a.y} h${len}`, class: `rt-stub${lit && !lit.has(`r:${r.row}`) ? ' dim' : ''}${r.shown ? '' : ' off'}` }),
        sv('path', { d: `M${a.x + len - 4},${a.y - 4} l8,8 M${a.x + len + 4},${a.y - 4} l-8,8`, class: 'rt-stubx' }));
      if (gw > 120) wires.append(sv('text', { x: a.x + 8, y: a.y - 6, class: 'rt-stubt' }, r.priority === 'must' ? 'must: no evidence' : 'no evidence'));
    }
    for (const el of hit) wires.append(el);
    if (st.drag) {
      wires.append(sv('path', { d: st.drag.from.x < st.drag.x ? path(st.drag.from, st.drag) : path(st.drag, st.drag.from), class: 'rt-w drag' }));
    }
  }

  // ---------- inspector ----------
  function drawInsp() {
    const t = T();
    const active = document.activeElement && insp.contains(document.activeElement) ? document.activeElement.dataset.f : null;
    const caret = active && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    insp.replaceChildren();
    const item = !t || !st.sel ? null : st.sel.k === 'r' ? t.reqs.find((r) => r.row === st.sel.row) : t.tests.find((x) => x.row === st.sel.row);
    if (!item) {
      const counts = ORDER.map((s) => [s, t ? t.reqs.filter((r) => r.status === s).length : 0]);
      insp.append(h('div', { class: 'rt-ih' }, h('h2', {}, 'Inspector')),
        h('div', { class: 'rt-ibody' },
          h('p', { class: 'rt-soft' }, 'Select a requirement or a test to edit it and wire it with the checkboxes.'),
          h('div', { class: 'rt-iadd' },
            h('button', { class: 'k-btn', type: 'button', onclick: () => addReq() }, '+ Requirement'),
            h('button', { class: 'k-btn', type: 'button', onclick: addTest }, '+ Test')),
          t ? h('ul', { class: 'rt-worst' }, counts.filter(([, n]) => n).map(([s, n]) => h('li', {},
            h('span', { class: `rt-st s-${SCLS[s]}` }, SWORD[s]), ' ', h('b', {}, n), ' ',
            h('span', { class: 'rt-soft' }, t.reqs.filter((r) => r.status === s).map((r) => r.id).join(', '))))) : null));
      return;
    }
    const f = (name, label, input) => h('label', { class: 'rt-if' }, h('span', {}, label), input);
    const seg = (field, options, value, k) => h('div', { class: 'rt-seg small', role: 'group', 'aria-label': field },
      options.map((o) => h('button', { type: 'button', 'aria-pressed': String(o === value), onclick: () => setField(k, item.row, field, o) }, o)));
    if (st.sel.k === 'r') {
      const raw = (ctx.raw.reqs || [])[item.row] || {};
      const idIn = h('input', { type: 'text', 'data-f': 'id', spellcheck: 'false', class: 'm' }); idIn.value = raw.id ?? '';
      idIn.addEventListener('change', () => renameReq(item.row, idIn.value.trim()));
      const txt = h('textarea', { rows: 3, 'data-f': 'text' }); txt.value = raw.text ?? '';
      txt.addEventListener('input', () => setField('r', item.row, 'text', txt.value));
      const tests = t.tests;
      insp.append(h('div', { class: 'rt-ih' }, h('h2', {}, 'Requirement ', h('span', { class: 'm' }, item.id)),
        h('span', { class: `rt-st s-${SCLS[item.status]}` }, SWORD[item.status]), h('span', { class: 'rt-grow' }),
        h('button', { class: 'k-btn rt-del', type: 'button', onclick: () => removeRow('r', item.row) }, 'Delete'),
        h('button', { class: 'k-btn k-x', type: 'button', 'aria-label': 'Close the inspector', onclick: () => { st.sel = null; render(); } }, '×')),
      h('div', { class: 'rt-ibody' },
        f('id', 'ID (renaming updates the tests)', idIn), f('text', 'Requirement - one testable sentence', txt),
        h('div', { class: 'rt-if' }, h('span', {}, 'Priority'), seg('priority', ['must', 'should', 'could'], raw.priority || 'must', 'r')),
        h('div', { class: 'rt-if' }, h('span', {}, 'Verified by'), seg('method', ['test', 'analysis', 'inspection', 'demonstration'], raw.method || 'test', 'r')),
        h('div', { class: 'rt-if' }, h('span', {}, `Proved by (${item.tests.length})`),
          tests.length ? h('div', { class: 'rt-checks' }, tests.map((x) => h('label', { class: `rt-chk r-${RCLS[x.result]}` },
            h('input', { type: 'checkbox', checked: x.covers.includes(item.id), onchange: (e) => link(x.row, item.id, e.target.checked) }),
            h('b', { class: 'm' }, x.id), h('span', { class: 'n' }, x.name), h('span', { class: `rt-res r-${RCLS[x.result]} ro` }, x.result)))) : h('span', { class: 'rt-soft' }, 'No tests yet.'),
          h('button', { class: 'k-btn', type: 'button', onclick: addTest }, `+ New test for ${item.id}`))));
    } else {
      const raw = (ctx.raw.tests || [])[item.row] || {};
      const idIn = h('input', { type: 'text', 'data-f': 'id', spellcheck: 'false', class: 'm' }); idIn.value = raw.id ?? '';
      idIn.addEventListener('change', () => setField('t', item.row, 'id', idIn.value.trim()));
      const nm = h('textarea', { rows: 2, 'data-f': 'name' }); nm.value = raw.name ?? '';
      nm.addEventListener('input', () => setField('t', item.row, 'name', nm.value));
      insp.append(h('div', { class: 'rt-ih' }, h('h2', {}, 'Test ', h('span', { class: 'm' }, item.id)),
        h('span', { class: `rt-res r-${RCLS[item.result]} ro` }, item.result), h('span', { class: 'rt-grow' }),
        h('button', { class: 'k-btn rt-del', type: 'button', onclick: () => removeRow('t', item.row) }, 'Delete'),
        h('button', { class: 'k-btn k-x', type: 'button', 'aria-label': 'Close the inspector', onclick: () => { st.sel = null; render(); } }, '×')),
      h('div', { class: 'rt-ibody' },
        f('id', 'ID', idIn), f('name', 'Test or record', nm),
        h('div', { class: 'rt-if' }, h('span', {}, 'Result'), seg('result', RESULTS, item.result, 't')),
        h('div', { class: 'rt-if' }, h('span', {}, `Covers (${item.covers.length})`),
          h('div', { class: 'rt-checks' }, t.reqs.map((r) => h('label', { class: 'rt-chk' },
            h('input', { type: 'checkbox', checked: item.covers.includes(r.id), onchange: (e) => link(item.row, r.id, e.target.checked) }),
            h('b', { class: 'm' }, r.id), h('span', { class: 'n' }, r.text)))),
          item.unknown.length ? h('div', { class: 'rt-unk' }, 'Not in the list: ', item.unknown.map((u) => h('span', { class: 'rt-tag' }, u,
            h('button', { type: 'button', 'aria-label': `Remove ${u} from Covers`, onclick: () => link(item.row, u, false) }, '×')))) : null)));
    }
    if (st.focusText) { st.focusText = false; requestAnimationFrame(() => insp.querySelector('textarea')?.focus()); }
    else if (active) {
      const el = insp.querySelector(`[data-f="${active}"]`);
      if (el) { el.focus(); if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch { /* not text */ } }
    }
  }

  // ---------- top ----------
  function drawTop(res) {
    const t = res?.trace;
    const show = ctx.raw.show || 'all';
    showSeg.replaceChildren(...SHOW.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(show === v), onclick: () => ctx.set('show', v) }, l)));
    const v = Object.fromEntries((res?.values || []).map((x) => [x.label, x]));
    const n = t ? t.reqs.length : 0;
    const num = (x) => { const m = String(x ?? '–').match(/^(\S+)\s*%$/); return m ? [m[1], h('i', {}, '%')] : String(x ?? '–'); };
    big.replaceChildren(
      h('div', { class: `rt-bn ${v.Covered?.tone || ''}` }, h('b', {}, num(v.Covered?.value)), h('span', {}, 'covered'), h('small', {}, v.Covered?.hint || '')),
      h('div', { class: `rt-bn ${v.Verified?.tone || ''}` }, h('b', {}, num(v.Verified?.value)), h('span', {}, 'verified'), h('small', {}, v.Verified?.hint || '')),
      h('div', { class: `rt-bn ${v.Gaps?.tone || ''}` }, h('b', {}, v.Gaps?.value ?? '–'), h('span', {}, 'gaps'), h('small', {}, v.Gaps?.hint || '')),
      h('div', { class: `rt-bn ${v.Failing?.tone || ''}` }, h('b', {}, v.Failing?.value ?? '–'), h('span', {}, 'failing'), h('small', {}, '')));
    ribbon.replaceChildren();
    ribKey.replaceChildren();
    if (!t || !n) return;
    ribbon.setAttribute('aria-label', ORDER.map((s) => `${t.reqs.filter((r) => r.status === s).length} ${s}`).join(', '));
    for (const s of ORDER) {
      const list = t.reqs.filter((r) => r.status === s);
      if (!list.length) continue;
      const seg = h('div', { class: `rt-rs s-${SCLS[s]}`, style: `flex-grow:${list.length}`, title: `${SWORD[s]}: ${list.map((r) => r.id).join(', ')}` },
        list.map((r) => h('button', { type: 'button', class: 'rt-rb', 'aria-label': `${r.id}, ${s}`, onclick: () => select('r', r.row, true) }, r.id)));
      ribbon.append(seg);
      ribKey.append(h('span', {}, h('i', { class: `s-${SCLS[s]}` }), `${list.length} ${SWORD[s]}`));
    }
  }

  // ---------- render ----------
  const select = (k, row, scroll = false) => {
    st.sel = st.sel && st.sel.k === k && st.sel.row === row ? null : { k, row }; st.wire = null; render();
    if (st.sel && window.innerWidth <= 1080) insp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (scroll && st.sel) bay.querySelector(`.rt-card[data-k="${k}"][data-row="${row}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  function render(res = ctx.result) {
    const t = res?.trace || null;
    drawRec(); drawTop(res);
    const focusSel = document.activeElement && bay.contains(document.activeElement)
      ? (document.activeElement.dataset.port ? `.rt-card[data-k="${document.activeElement.dataset.port}"][data-row="${document.activeElement.dataset.row}"] .rt-port`
        : document.activeElement.dataset.cycle != null ? `[data-cycle="${document.activeElement.dataset.cycle}"]`
          : document.activeElement.classList.contains('rt-card') ? `.rt-card[data-k="${document.activeElement.dataset.k}"][data-row="${document.activeElement.dataset.row}"]` : null) : null;
    if (st.sel && t && !(st.sel.k === 'r' ? t.reqs.some((r) => r.row === st.sel.row) : t.tests.some((x) => x.row === st.sel.row))) st.sel = null;
    const lit = related();
    const ghosts = t ? [...new Set(t.tests.flatMap((x) => x.unknown.map(up)))].map((u) => t.tests.flatMap((x) => x.unknown).find((y) => up(y) === u)) : [];
    reqHead.replaceChildren(h('h2', {}, 'Requirements', h('small', {}, ` ${t ? t.reqs.length : 0}`)), h('span', { class: 'rt-grow' }),
      h('button', { class: 'k-btn', type: 'button', onclick: () => addReq() }, '+ Add'));
    testHead.replaceChildren(h('h2', {}, 'Tests and records', h('small', {}, ` ${t ? t.tests.length : 0}`)), h('span', { class: 'rt-grow' }),
      h('button', { class: 'k-btn', type: 'button', onclick: addTest }, '+ Add'));
    reqCol.replaceChildren(...(t ? [...t.reqs.map((r) => reqCard(r, lit)), ...ghosts.map((g) => ghostCard(g, lit)),
      ...t.unnamed.map((u) => h('div', { class: 'rt-card rt-unnamed', 'data-k': 'u' }, h('div', { class: 'rt-c1' }, h('b', { class: 'rt-id bad' }, 'no ID')),
        h('div', { class: 'rt-text' }, u.text), h('div', { class: 'rt-orph' }, 'Give it an ID in the tables below so tests can point at it.')))]
      : [h('div', { class: 'rt-empty' }, 'No requirements yet.', h('button', { class: 'k-btn', type: 'button', onclick: () => addReq() }, '+ Add the first'))]));
    testCol.replaceChildren(...(t ? t.tests.map((x) => testCard(x, lit)) : []));
    if (t && !t.tests.length) testCol.append(h('div', { class: 'rt-empty' }, 'No tests yet.', h('button', { class: 'k-btn', type: 'button', onclick: addTest }, '+ Add one')));
    armBar.hidden = !st.arm;
    if (st.arm) armBar.replaceChildren(`Wiring ${st.arm.id}: press Enter on a ${st.arm.k === 'r' ? 'test' : 'requirement'} to wire it, Escape to stop.`,
      h('button', { class: 'k-btn', type: 'button', onclick: () => { st.arm = null; render(); } }, 'Stop'));
    bay.classList.toggle('filtering', (ctx.raw.show || 'all') !== 'all');
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(...(res?.notes || []).map((w) => h('div', {}, w)));
    drawInsp();
    requestAnimationFrame(drawWires);
    if (focusSel) bay.querySelector(focusSel)?.focus();
  }

  // ---------- interaction ----------
  const cardAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.rt-card');
  bay.addEventListener('click', (e) => {
    if (st.dragged) { st.dragged = false; return; }
    const cut = e.target.closest('.rt-cut');
    if (cut) { st.wire = null; link(+cut.dataset.t, cut.dataset.id, false); return; }
    const w = e.target.closest('.rt-whit');
    if (w) { st.wire = st.wire === w.dataset.w ? null : w.dataset.w; drawWires(); return; }
    const cy = e.target.closest('[data-cycle]');
    if (cy) { cycle(+cy.dataset.cycle); return; }
    const ag = e.target.closest('[data-addghost]');
    if (ag) { addReq(ag.dataset.addghost); return; }
    if (e.target.closest('.rt-port')) return;
    const c = e.target.closest('.rt-card');
    if (c && (c.dataset.k === 'r' || c.dataset.k === 't')) {
      if (st.arm && st.arm.k !== c.dataset.k) { wireArmed(c); return; }
      select(c.dataset.k, +c.dataset.row);
    } else if (!c && st.wire) { st.wire = null; drawWires(); }
  });
  const wireArmed = (c) => {
    const a = st.arm; st.arm = null;
    if (a.k === 'r') link(+c.dataset.row, a.id, true);
    else link(a.row, c.dataset.id, true);
  };
  bay.addEventListener('keydown', (e) => {
    const w = e.target.closest?.('.rt-whit');
    if (w && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); link(+w.dataset.t, w.dataset.id, false); return; }
    if (w && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.wire = w.dataset.w; drawWires(); return; }
    if (e.key === 'Escape' && (st.arm || st.wire)) { st.arm = null; st.wire = null; render(); return; }
    const p = e.target.closest?.('.rt-port');
    if (p && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const card = p.closest('.rt-card');
      st.arm = { k: card.dataset.k, row: +card.dataset.row, id: card.dataset.id }; render();
      bay.querySelector(`.rt-card[data-k="${card.dataset.k === 'r' ? 't' : 'r'}"]`)?.focus();
      return;
    }
    const c = e.target.classList?.contains('rt-card') ? e.target : null;
    if (c && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (st.arm && st.arm.k !== c.dataset.k && c.dataset.k !== 'g') { const k = c.dataset.k, row = c.dataset.row; wireArmed(c); requestAnimationFrame(() => bay.querySelector(`.rt-card[data-k="${k}"][data-row="${row}"]`)?.focus()); return; }
      if (c.dataset.k === 'r' || c.dataset.k === 't') select(c.dataset.k, +c.dataset.row);
    }
    if (c && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? c.nextElementSibling : c.previousElementSibling;
      if (sib?.classList.contains('rt-card')) sib.focus();
    }
  });
  bay.addEventListener('pointerdown', (e) => {
    const p = e.target.closest('.rt-port');
    if (!p || p.classList.contains('ghost')) return;
    e.preventDefault();
    const card = p.closest('.rt-card');
    const box = bay.getBoundingClientRect(), r = p.getBoundingClientRect();
    st.drag = { k: card.dataset.k, row: +card.dataset.row, id: card.dataset.id, pid: e.pointerId,
      from: { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 }, x: e.clientX - box.left, y: e.clientY - box.top };
    try { bay.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    bay.classList.add(`dragging-${st.drag.k}`);
    drawWires();
  });
  let over = null;
  bay.addEventListener('pointermove', (e) => {
    if (!st.drag || e.pointerId !== st.drag.pid) return;
    const box = bay.getBoundingClientRect();
    st.drag.x = e.clientX - box.left; st.drag.y = e.clientY - box.top; st.drag.moved = true;
    const c = cardAt(e.clientX, e.clientY);
    const ok = c && c.dataset.k !== st.drag.k && (c.dataset.k === 'r' || c.dataset.k === 't') ? c : null;
    if (over !== ok) { over?.classList.remove('drop'); ok?.classList.add('drop'); over = ok; }
    drawWires();
  });
  const endDrag = (e) => {
    if (!st.drag || e.pointerId !== st.drag.pid) return;
    const d = st.drag; st.drag = null;
    bay.classList.remove('dragging-r', 'dragging-t');
    over?.classList.remove('drop');
    const c = over; over = null;
    if (d.moved) st.dragged = true;
    if (c && e.type === 'pointerup') {
      if (d.k === 'r') link(+c.dataset.row, d.id, true);
      else link(d.row, c.dataset.id, true);
    } else drawWires();
  };
  bay.addEventListener('pointerup', endDrag);
  bay.addEventListener('pointercancel', endDrag);

  new ResizeObserver(() => drawWires()).observe(bay);
  ctx.onResult((res) => render(res));

  // ---------- start ----------
  if (served()) {
    let p = null;
    try { p = new URLSearchParams(location.search).get('project'); } catch { /* no query */ }
    rec.project = (p || 'default').trim() || 'default';
    load();
  } else rec.project = 'default';
}
