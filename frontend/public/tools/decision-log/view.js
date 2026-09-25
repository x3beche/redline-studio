// Decision Log, custom page: the project's decisions as threads over time.
//   Timeline - one horizontal thread per question: a decision and everything
//              that superseded it share a track, the arrow runs from the old
//              record to the one that replaced it, so the right end of each
//              thread is what stands now. The node shows the status (filled
//              green accepted, dashed amber proposed, grey superseded, red
//              rejected); its ring has four quarters - context, decision,
//              alternatives, consequences - red where a required part is
//              missing, and a red dot marks a record with a problem.
//              Drag a node along the time axis to re-date it (arrow keys on a
//              focused node, Shift for a week); drag the selected node's link
//              knob onto another node to say "superseded by that one".
//   Record   - the selected ADR as a card: status, date, the four parts, the
//              successor; "Supersede with a new decision" starts the next one.
//   Project  - the log is one shared record per project in the app
//              (/api/tools/data/decision-log?project=<name>), loaded when the
//              page opens and written back with "Save to project"; agents read
//              and write the same record with the MCP tool tool_data.
// Status, completeness, problems, next ID and filtering all come from run()'s
// result.adr; the page only lays the records out on the time axis.

const TOOL = 'decision-log';
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DAY = 86400000;
const toDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (d) => new Date(d * DAY).toISOString().slice(0, 10);
const today = () => { const n = new Date(); return fromDay(Math.round(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAY)); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected'];
const PARTS = [['context', 'Context', 'The forces and constraints that made a decision necessary.'],
  ['decision', 'Decision', 'What was chosen, in one or two sentences.'],
  ['alternatives', 'Alternatives', 'What was turned down, and why.'],
  ['consequences', 'Consequences', 'What gets easier or harder because of it.']];

const CSS = `
:root { --tool-acc: #2f855a; --tool-prop: #b7791f; --tool-old: #93a1ae; --tool-rej: #c0392b; --tool-thread: #c8d2db; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-acc: #5cbf7a; --tool-prop: #e8a735; --tool-old: #5f6f7c; --tool-rej: #e57373; --tool-thread: #2b3945; } }
:root[data-theme="dark"] { --tool-acc: #5cbf7a; --tool-prop: #e8a735; --tool-old: #5f6f7c; --tool-rej: #e57373; --tool-thread: #2b3945; }
.k-page { padding: 12px; }
.dl { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); align-items: start; }
@media (max-width: 1040px) { .dl { grid-template-columns: minmax(0, 1fr); } }
.dl-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.dl-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); min-height: 40px; }
.dl-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.dl-sub { font-size: 11.5px; color: var(--ink-soft); }
.dl-grow { flex: 1; }
.dl-f { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.dl-f input, .dl-f select { padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font-size: 12px; }
.dl-f input { width: 10em; font-family: "IBM Plex Mono", ui-monospace, monospace; }
.dl-proj { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; margin-bottom: 12px; font-size: 12px; }
.dl-proj .msg { font-size: 11.5px; color: var(--ink-soft); }
.dl-proj .msg.ok { color: var(--ok); } .dl-proj .msg.bad { color: var(--danger); } .dl-proj .msg.warn { color: var(--warn); }
.dl-stage { position: relative; padding: 2px 4px 0; }
.dl-svg { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
.dl-ax { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.dl-grid { stroke: var(--line-soft); }
.dl-today { stroke: var(--accent); stroke-dasharray: 3 3; }
.dl-todayt { font: 600 10.5px "IBM Plex Sans", sans-serif; fill: var(--accent); }
.dl-thread { stroke: var(--tool-thread); stroke-width: 2; }
.dl-undated { fill: var(--sunken); }
.dl-arrow { fill: none; stroke: var(--tool-old); stroke-width: 1.8; marker-end: url(#dl-head); }
.dl-arrowh { fill: var(--tool-old); }
.dl-node { cursor: grab; outline: none; }
.dl-node:active { cursor: grabbing; }
.dl-node .core { stroke-width: 2; }
.dl-node.accepted .core { fill: var(--tool-acc); stroke: var(--tool-acc); }
.dl-node.proposed .core { fill: var(--surface); stroke: var(--tool-prop); stroke-dasharray: 3 2; }
.dl-node.superseded .core { fill: var(--tool-old); stroke: var(--tool-old); }
.dl-node.deprecated .core { fill: var(--surface); stroke: var(--tool-old); }
.dl-node.rejected .core { fill: var(--tool-rej); stroke: var(--tool-rej); }
.dl-node .x { stroke: var(--surface); stroke-width: 2; }
.dl-node .q { fill: none; stroke-width: 3; }
.dl-node .q.has { stroke: var(--ink-soft); opacity: .55; }
.dl-node .q.opt { stroke: var(--line); }
.dl-node .q.miss { stroke: var(--danger); }
.dl-node .sel { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0; }
.dl-node.is-sel .sel { opacity: 1; }
.dl-node:focus-visible .sel { opacity: 1; stroke-dasharray: 4 2; }
.dl-node .bad { fill: var(--danger); stroke: var(--surface); stroke-width: 1.5; }
.dl-node .id { font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.dl-node .tt { font: 12px "IBM Plex Sans", sans-serif; fill: var(--ink); }
.dl-node.superseded .tt, .dl-node.rejected .tt, .dl-node.deprecated .tt { fill: var(--ink-soft); }
.dl-node .dt { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.dl-node.dim { opacity: .3; }
.dl-node.dragging .core { stroke: var(--accent); }
.dl-link { cursor: crosshair; outline: none; }
.dl-link circle { fill: var(--surface); stroke: var(--accent); stroke-width: 1.8; }
.dl-link path { stroke: var(--accent); stroke-width: 1.8; fill: none; }
.dl-link:focus-visible circle { stroke-width: 3; }
.dl-rubber { stroke: var(--accent); stroke-width: 2; stroke-dasharray: 5 4; fill: none; marker-end: url(#dl-headA); pointer-events: none; }
.dl-hint { font: 600 11.5px "IBM Plex Sans", sans-serif; fill: var(--accent); pointer-events: none; }
.dl-tip { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--accent); pointer-events: none; }
.dl-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 6px 10px 8px; border-top: 1px solid var(--line-soft); font-size: 11px; color: var(--ink-soft); align-items: center; }
.dl-legend svg { vertical-align: middle; margin-right: 4px; }
.dl-now { display: grid; gap: 4px; padding: 8px 10px; border-top: 1px solid var(--line-soft); }
.dl-now .row { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.dl-now .row > span:first-child { min-width: 64px; }
.dl-chip { border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 1px 9px; font-size: 11.5px; cursor: pointer; color: var(--ink); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-chip b { font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600; margin-right: 4px; }
.dl-chip.acc { border-color: var(--tool-acc); } .dl-chip.prop { border-color: var(--tool-prop); border-style: dashed; }

/* the record card */
.dl-card { display: grid; gap: 8px; padding: 10px 12px 12px; }
.dl-card label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ink-soft); min-width: 0; }
.dl-card input[type=text], .dl-card textarea, .dl-card select { width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font-size: 12.5px; }
.dl-card textarea { resize: vertical; min-height: 44px; line-height: 1.4; }
.dl-card .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.dl-card .bad { border-color: var(--danger) !important; }
.dl-card .two { display: grid; grid-template-columns: 7.5em minmax(0, 1fr) auto; gap: 6px; align-items: end; }
.dl-card .lh { display: flex; justify-content: space-between; gap: 6px; }
.dl-card .lh em { font-style: normal; color: var(--danger); font-weight: 600; }
.dl-card .lh i { font-style: normal; opacity: .8; }
.dl-st { display: flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.dl-st button { flex: 1; border: 0; background: transparent; padding: 4px 2px; font-size: 11.5px; color: var(--ink-soft); cursor: pointer; }
.dl-st button + button { border-left: 1px solid var(--line); }
.dl-st button[aria-pressed="true"] { color: var(--ink); font-weight: 600; background: var(--sunken); box-shadow: inset 0 -3px 0 var(--c); }
.dl-issues { display: grid; gap: 3px; font-size: 11.5px; color: var(--danger); }
.dl-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dl-danger { color: var(--danger); }
.dl-empty { padding: 16px 12px; font-size: 12px; color: var(--ink-soft); }
.dl-foot { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; margin-top: 12px; }
@media (max-width: 1040px) { .dl-foot { grid-template-columns: minmax(0, 1fr); } }
.dl-msgs { display: grid; gap: 8px; min-width: 0; }
.dl-msgs .k-warns:empty, .dl-msgs .k-notes:empty { display: none; }
.dl-all { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.dl-all summary { cursor: pointer; padding: 7px 10px; font-size: 12px; font-weight: 500; }
.dl-all .k-form { border: 0; border-top: 1px solid var(--line-soft); border-radius: 0 0 6px 6px; }
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const state = { sel: null, drag: null, link: null, scale: null, W: 800, edRow: undefined };
  const adr = () => ctx.result?.adr || null;
  const rowsNow = () => structuredClone(ctx.raw.decisions || []);
  const setRows = (rows) => ctx.set('decisions', rows);
  const recOf = (row) => adr()?.records.find((r) => r.row === row) || null;
  const byId = (id) => adr()?.records.find((r) => r.id.toUpperCase() === String(id).trim().toUpperCase()) || null;

  // ---------- project record ----------
  const proj = { name: null, loaded: false, busy: false, msg: '', tone: '', updated: null, saved: null };
  const projBar = h('div', { class: 'dl-panel dl-proj' });
  const projUrl = () => `/api/tools/data/${TOOL}?project=${encodeURIComponent(proj.name)}`;
  const dirty = () => proj.saved == null || JSON.stringify(ctx.raw.decisions ?? null) !== JSON.stringify(JSON.parse(proj.saved).decisions ?? null);
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  async function load() {
    proj.busy = true; proj.msg = `Loading project "${proj.name}"…`; proj.tone = ''; drawProj();
    try {
      const r = await fetch(projUrl());
      if (!r.ok) throw new Error(`the app answered ${r.status}`);
      const body = await r.json();
      const data = body.data || {};
      proj.loaded = true; proj.busy = false; proj.updated = body.updated || null;
      if (!('decisions' in data)) {
        proj.saved = null;
        proj.msg = `Nothing saved for project "${proj.name}" yet: this is your last edit or the example. Change it and press Save to project.`;
        proj.tone = 'warn'; drawProj(); return;
      }
      proj.saved = JSON.stringify({ decisions: data.decisions });
      proj.msg = `Loaded project "${proj.name}".`; proj.tone = 'ok';
      state.sel = null; state.edRow = undefined;
      ctx.set('decisions', structuredClone(data.decisions));
      drawProj();
    } catch (e) {
      proj.loaded = true; proj.busy = false;
      proj.msg = `Could not load the project record (${e.message || e}). The page still works; save again later.`; proj.tone = 'bad'; drawProj();
    }
  }
  async function save() {
    proj.busy = true; proj.msg = 'Saving…'; proj.tone = ''; drawProj();
    const data = { decisions: ctx.raw.decisions ?? null };
    try {
      const r = await fetch(projUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body: JSON.stringify({ data }) });
      if (!r.ok) {
        let why = String(r.status);
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 403 ? `not allowed to edit this project (${why})` : why);
      }
      const body = await r.json();
      proj.saved = JSON.stringify(data); proj.updated = body.updated || new Date().toISOString();
      proj.msg = `Saved to project "${proj.name}".`; proj.tone = 'ok';
    } catch (e) { proj.msg = `Not saved: ${e.message || e}.`; proj.tone = 'bad'; }
    proj.busy = false; drawProj();
  }
  function drawProj() {
    if (!/^https?:/.test(location.protocol)) {
      projBar.replaceChildren(h('b', {}, 'Project record'), h('span', { class: 'msg' }, 'Open this tool in the app to load and save the project\'s shared log. As a file it works on this page only: copy the JSON output to keep it.'));
      return;
    }
    const inp = h('input', { type: 'text', 'aria-label': 'Project', spellcheck: 'false' });
    inp.value = proj.name;
    inp.addEventListener('change', () => {
      const p = inp.value.trim() || 'default';
      if (p === proj.name) return;
      if (proj.saved != null && dirty() && !confirm(`Load project "${p}"? Unsaved changes here stay only if "${p}" has no record yet.`)) { inp.value = proj.name; return; }
      proj.name = p; proj.saved = null; load();
    });
    const changed = proj.loaded && !proj.busy && dirty();
    projBar.replaceChildren(h('label', { class: 'dl-f' }, 'Project', inp),
      h('button', { class: 'k-btn k-primary', type: 'button', disabled: proj.busy, onclick: save }, proj.busy ? 'Working…' : 'Save to project'),
      h('button', { class: 'k-btn', type: 'button', disabled: proj.busy, title: 'Load the saved record again (replaces this log)',
        onclick: () => { if (!dirty() || proj.saved == null || confirm('Replace this log with the saved record?')) load(); } }, 'Reload'),
      h('span', { class: `msg${changed ? ' warn' : ''}` }, proj.updated ? `Last saved ${when(proj.updated)}` : 'Never saved', changed ? ' · unsaved changes' : ''),
      proj.msg ? h('span', { class: `msg ${proj.tone}`, role: 'status' }, proj.msg) : null,
      h('span', { class: 'msg', style: 'flex-basis:100%' }, `Agents read and write the same log with the MCP tool tool_data (id "${TOOL}", project "${proj.name}").`));
  }

  // ---------- skeleton ----------
  const statusSel = h('select', { 'aria-label': 'Show' }, (ctx.manifest.inputs.find((d) => d.key === 'status')?.options || []).map(([v, t]) => h('option', { value: v }, t)));
  statusSel.addEventListener('change', () => ctx.set('status', statusSel.value));
  const findIn = h('input', { type: 'text', 'aria-label': 'Search', placeholder: 'search', spellcheck: 'false' });
  findIn.addEventListener('input', () => ctx.set('filter', findIn.value));
  const count = h('span', { class: 'dl-sub' });
  const addBtn = h('button', { class: 'k-btn k-primary', type: 'button', onclick: () => addRecord() }, '+ New decision');
  const svg = sv('svg', { class: 'dl-svg', role: 'group', 'aria-label': 'Decisions on a time axis, one thread per question' });
  const stage = h('div', { class: 'dl-stage' }, svg);
  const legend = h('div', { class: 'dl-legend' });
  const now = h('div', { class: 'dl-now' });
  const tlPanel = h('section', { class: 'dl-panel' },
    h('div', { class: 'dl-head' }, h('h2', {}, 'Decisions over time'), count, h('span', { class: 'dl-grow' }),
      h('label', { class: 'dl-f' }, 'Show', statusSel), h('label', { class: 'dl-f' }, findIn), addBtn),
    stage, now, legend);
  const cardHead = h('div', { class: 'dl-head' });
  const card = h('div', { class: 'dl-card' });
  const cardPanel = h('section', { class: 'dl-panel' }, cardHead, card);
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const all = h('details', { class: 'dl-all' }, h('summary', {}, 'All records as a table'), ctx.form);
  root.append(projBar, h('div', { class: 'dl' }, tlPanel, cardPanel),
    h('div', { class: 'dl-foot' }, h('div', { class: 'dl-msgs' }, warns, notes, all), ctx.outputs));

  // ---------- timeline ----------
  let geo = null;
  function layout(a) {
    // Threads: records joined by superseded-by links share a track.
    const recs = a.records;
    const parent = new Map(recs.map((r) => [r.row, r.row]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const r of recs) {
      const nu = r.by ? recs.find((x) => x.id.toUpperCase() === r.by.toUpperCase()) : null;
      if (nu && nu !== r) parent.set(find(r.row), find(nu.row));
    }
    const groups = new Map();
    for (const r of recs) { const k = find(r.row); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const key = (r) => (r.date ? toDay(r.date) : Infinity);
    const tracks = [...groups.values()].map((g) => g.sort((x, y) => key(x) - key(y) || x.row - y.row))
      .sort((x, y) => key(x[0]) - key(y[0]) || x[0].row - y[0].row);
    return tracks;
  }
  function drawTimeline(a) {
    svg.replaceChildren();
    if (!a || !a.records.length) {
      svg.setAttribute('viewBox', `0 0 ${state.W} 140`); svg.setAttribute('height', 140);
      svg.append(sv('text', { x: state.W / 2, y: 70, class: 'dl-ax', 'text-anchor': 'middle' }, 'No decisions yet: press "+ New decision".'));
      geo = null; return;
    }
    const W = state.W, narrow = W < 560;
    const tracks = layout(a);
    const dated = a.records.filter((r) => r.date);
    const undated = a.records.filter((r) => !r.date);
    const TH = 72, T = 40;
    const UW = undated.length ? (narrow ? 84 : 120) : 0;
    const L = 22, R = 18 + UW;
    const PW = W - L - R;
    let scale = state.scale;
    if (!scale || !state.drag) {
      const days = dated.map((r) => toDay(r.date));
      const t0 = toDay(today());
      let lo = days.length ? Math.min(...days) : t0 - 14, hi = days.length ? Math.max(...days, Math.min(t0, Math.max(...days) + 60)) : t0 + 14;
      const pad = Math.max(3, (hi - lo) * 0.08);
      lo -= pad; hi += pad + (narrow ? 12 : 18) * ((hi - lo) / Math.max(PW, 1)) * 6;
      if (hi - lo < 21) { const m = (hi + lo) / 2; lo = m - 10.5; hi = m + 10.5; }
      scale = { lo, hi };
      state.scale = scale;
    }
    const X = (d) => L + ((d - scale.lo) / (scale.hi - scale.lo)) * PW;
    const H = T + tracks.length * TH + 12;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    geo = { L, PW, T, TH, scale, X, W, H, UW };

    const defs = sv('defs');
    for (const [id, cls] of [['dl-head', 'dl-arrowh'], ['dl-headA', '']]) {
      const m = sv('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      m.append(sv('path', { d: 'M0,0 L10,5 L0,10 z', class: cls || null, style: cls ? null : 'fill:var(--accent)' }));
      defs.append(m);
    }
    svg.append(defs);

    // time axis: months, with weeks when the span is short
    const span = scale.hi - scale.lo;
    const g0 = sv('g');
    const d0 = new Date(Math.ceil(scale.lo) * DAY), d1 = new Date(Math.floor(scale.hi) * DAY);
    if (span <= 120) {
      for (let d = Math.ceil(scale.lo); d <= scale.hi; d++) {
        const dt = new Date(d * DAY);
        if (dt.getUTCDay() !== 1) continue;
        g0.append(sv('line', { x1: X(d), x2: X(d), y1: T - 10, y2: H - 8, class: 'dl-grid' }));
        if (PW / (span / 7) > 44) g0.append(sv('text', { x: X(d) + 3, y: T - 14, class: 'dl-ax' }, `${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}`));
      }
    } else {
      const every = span > 900 ? 6 : span > 400 ? 3 : 1;
      for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); Date.UTC(y, m, 1) <= d1.getTime(); m++) {
        if (m > 11) { m = 0; y++; }
        const d = Date.UTC(y, m, 1) / DAY;
        if (d < scale.lo || m % every) continue;
        g0.append(sv('line', { x1: X(d), x2: X(d), y1: T - 10, y2: H - 8, class: 'dl-grid' }),
          sv('text', { x: X(d) + 3, y: T - 14, class: 'dl-ax' }, m === 0 || X(d) < L + 40 ? `${MON[m]} ${y}` : MON[m]));
      }
    }
    const td = toDay(today());
    if (td >= scale.lo && td <= scale.hi) {
      g0.append(sv('line', { x1: X(td), x2: X(td), y1: T - 26, y2: H - 8, class: 'dl-today' }),
        sv('text', { x: X(td) - 4, y: T - 28, class: 'dl-todayt', 'text-anchor': 'end' }, 'today'));
    }
    if (UW) {
      g0.append(sv('rect', { x: W - UW - 6, y: T - 22, width: UW, height: H - T + 14, rx: 4, class: 'dl-undated' }),
        sv('text', { x: W - UW / 2 - 6, y: T - 8, class: 'dl-ax', 'text-anchor': 'middle' }, 'no valid date'));
    }
    svg.append(g0);

    // threads, arrows, nodes
    const pos = new Map();
    tracks.forEach((tr, ti) => {
      const y = T + ti * TH + 18;
      let ux = 0;
      for (const r of tr) {
        const x = r.date ? X(toDay(r.date)) : W - UW + 14 + (ux++ % 2) * 0;
        pos.set(r.row, { x, y: r.date ? y : y, undated: !r.date });
      }
      const xs = tr.filter((r) => r.date).map((r) => pos.get(r.row).x);
      if (xs.length > 1) svg.append(sv('line', { x1: Math.min(...xs), x2: Math.max(...xs), y1: y, y2: y, class: 'dl-thread' }));
    });
    for (const r of a.records) {
      if (!r.by) continue;
      const nu = byId(r.by); if (!nu || nu === r) continue;
      const p = pos.get(r.row), q = pos.get(nu.row);
      const dir = q.x >= p.x ? 1 : -1;
      if (Math.abs(q.x - p.x) < 30) continue;
      svg.append(sv('path', { class: 'dl-arrow', d: `M${p.x + dir * 15},${p.y - 4} C${p.x + dir * 30},${p.y - 20} ${q.x - dir * 30},${q.y - 20} ${q.x - dir * 15},${q.y - 5}` }));
    }
    for (const tr of tracks) {
      tr.forEach((r, k) => {
        const p = pos.get(r.row);
        const next = tr.slice(k + 1).find((x) => pos.get(x.row).x > p.x + 4);
        const room = (next ? pos.get(next.row).x - 18 : (p.undated ? W - 8 : L + PW + (UW ? -4 : 14))) - (p.x - 12);
        svg.append(nodeFor(r, p, Math.max(40, room), a));
      });
    }
    // the link knob on the selected node
    const sr = state.sel != null ? recOf(state.sel) : null;
    if (sr && pos.has(sr.row)) {
      const p = pos.get(sr.row);
      const k = sv('g', { class: 'dl-link', tabindex: 0, role: 'button', 'aria-label': `Drag onto the record that supersedes ${sr.id}` });
      k.append(sv('path', { d: `M${p.x + 18},${p.y} L${p.x + 25},${p.y}` }), sv('circle', { cx: p.x + 31, cy: p.y, r: 6 }));
      k.append(sv('title', {}, `Drag onto another decision: ${sr.id} is superseded by it`));
      svg.append(k);
      geo.linkFrom = p;
    }
    geo.pos = pos;
  }
  function nodeFor(r, p, room, a) {
    const sel = r.row === state.sel;
    const g = sv('g', { class: `dl-node ${r.status}${sel ? ' is-sel' : ''}${r.shown ? '' : ' dim'}${state.drag?.row === r.row ? ' dragging' : ''}`,
      transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: 'button', 'data-row': r.row,
      'aria-label': `${r.id}, ${r.status}, ${r.date || 'no date'}: ${r.title || 'untitled'}${r.missing.length ? `; missing ${r.missing.join(', ')}` : ''}${r.issues.length ? `; ${r.issues.length} problem(s)` : ''}. Arrow keys change the date, Enter edits.` });
    g.append(sv('circle', { r: 18, class: 'sel' }));
    // Ring quarters: context (top right), decision, alternatives, consequences, clockwise.
    const need = (k) => (k === 'context' ? true : k === 'decision' ? r.status !== 'proposed' : r.status !== 'proposed');
    PARTS.forEach(([k], i) => {
      const a0 = -Math.PI / 2 + i * Math.PI / 2 + 0.16, a1 = a0 + Math.PI / 2 - 0.32, rr = 13;
      const cls = r.has[k] ? 'has' : need(k) ? 'miss' : 'opt';
      g.append(sv('path', { class: `q ${cls}`, d: `M${rr * Math.cos(a0)},${rr * Math.sin(a0)} A${rr},${rr} 0 0 1 ${rr * Math.cos(a1)},${rr * Math.sin(a1)}` }));
    });
    g.append(sv('circle', { r: 8, class: 'core' }));
    if (r.status === 'rejected') g.append(sv('path', { class: 'x', d: 'M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5' }));
    if (r.status === 'superseded') g.append(sv('path', { class: 'x', d: 'M-4,0 L4,0' }));
    if (r.issues.length) g.append(sv('circle', { cx: 11, cy: -11, r: 4.5, class: 'bad' }));
    const idW = r.id.length * 7.2;
    g.append(sv('text', { x: -10, y: 30, class: 'id' }, r.id));
    const dtx = sv('text', { x: -10 + idW + 6, y: 30, class: 'dt' }, room > idW + 90 ? (r.date || r.rawDate || '') : '');
    g.append(dtx);
    const chars = Math.floor((room - 4) / 6.3);
    if (chars >= 4 && r.title) g.append(sv('text', { x: -10, y: 44, class: 'tt' }, r.title.length > chars ? r.title.slice(0, chars - 1) + '…' : r.title));
    g.append(sv('title', {}, `${r.id} · ${r.status} · ${r.date || r.rawDate || 'no date'}\n${r.title}${r.issues.length ? `\n${r.issues.join('\n')}` : ''}`));
    return g;
  }

  // pointer: drag a node along time; drag the link knob onto another node; click to select
  const svgPt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  const dayAt = (x) => Math.round(geo.scale.lo + ((x - geo.L) / geo.PW) * (geo.scale.hi - geo.scale.lo));
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !geo) return;
    const knob = e.target.closest('.dl-link'), node = e.target.closest('.dl-node');
    if (!knob && !node) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (knob) { state.link = { from: state.sel, x: svgPt(e).x, y: svgPt(e).y }; return; }
    const row = +node.dataset.row;
    state.drag = { row, x0: e.clientX, y0: e.clientY, moved: false, day: null };
    node.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    if (state.link) {
      const q = svgPt(e); state.link.x = q.x; state.link.y = q.y;
      drawRubber(e); return;
    }
    const d = state.drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    d.moved = true;
    const q = svgPt(e);
    if (q.x > geo.L + geo.PW + 4) return;   // into the no-date zone: leave the date alone
    const day = dayAt(clamp(q.x, geo.L, geo.L + geo.PW));
    if (day === d.day) return;
    d.day = day;
    const rows = rowsNow(); if (!rows[d.row]) return;
    rows[d.row].date = fromDay(day);
    state.sel = d.row;
    setRows(rows);
  });
  function drawRubber(e) {
    svg.querySelector('.dl-rubber')?.remove(); svg.querySelector('.dl-hint')?.remove();
    const f = geo.linkFrom; if (!f) return;
    svg.append(sv('path', { class: 'dl-rubber', d: `M${f.x + 31},${f.y} L${state.link.x},${state.link.y}` }));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.dl-node');
    const src = recOf(state.link.from), dst = over ? recOf(+over.dataset.row) : null;
    const msg = dst && dst !== src ? `${src.id} superseded by ${dst.id}` : 'drop on the decision that replaces it';
    svg.append(sv('text', { class: 'dl-hint', x: clamp(state.link.x + 10, 4, geo.W - 220), y: clamp(state.link.y - 10, 14, geo.H - 4) }, msg));
  }
  const endPress = (e) => {
    try { svg.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (state.link) {
      const over = e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.dl-node') : null;
      const from = state.link.from; state.link = null;
      const src = recOf(from), dst = over ? recOf(+over.dataset.row) : null;
      if (src && dst && dst !== src) supersede(src.row, dst.id); else render();
      return;
    }
    const d = state.drag; state.drag = null;
    if (!d) return;
    if (!d.moved) { select(d.row); } else { state.scale = null; render(); }
    svg.querySelector(`.dl-node[data-row="${d.row}"]`)?.focus({ preventScroll: true });
  };
  svg.addEventListener('pointerup', endPress);
  svg.addEventListener('pointercancel', endPress);
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.dl-node');
    if (e.target.closest('.dl-link') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.querySelector('[data-k="superseded_by"]')?.focus(); return; }
    if (!g) return;
    const row = +g.dataset.row;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(row); card.querySelector('[data-k="title"]')?.focus(); return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const rows = rowsNow(); const r = rows[row]; if (!r) return;
    const cur = recOf(row)?.date || today();
    r.date = fromDay(toDay(cur) + step * (e.shiftKey ? 7 : 1));
    state.sel = row; state.refocus = row; state.scale = null;
    setRows(rows);
  });

  // ---------- editing ----------
  function select(row) { state.sel = row; render(); }
  function supersede(oldRow, newId) {
    const rows = rowsNow(); const r = rows[oldRow]; if (!r) return;
    r.status = 'superseded'; r.superseded_by = newId;
    state.sel = oldRow; setRows(rows);
  }
  function addRecord(from) {
    const a = adr(); const rows = rowsNow();
    const id = a?.next || 'ADR-001';
    const rec = { id, date: today(), title: '', status: 'proposed', context: '', decision: '', alternatives: '', consequences: '', superseded_by: '' };
    if (from != null && rows[from]) {
      const old = rows[from];
      rec.title = old.title ? `${old.title} (revised)` : '';
      rec.status = 'accepted';
      rec.context = `Replaces ${old.id}${old.title ? ` (${old.title})` : ''}. `;
      old.status = 'superseded'; old.superseded_by = id;
    }
    rows.push(rec);
    state.sel = rows.length - 1; state.edRow = undefined; state.scale = null;
    setRows(rows);
    const t = card.querySelector(from != null ? '[data-k="context"]' : '[data-k="title"]');
    if (t) { t.focus(); if (from != null) t.setSelectionRange(t.value.length, t.value.length); }
  }
  function delRecord() {
    const rows = rowsNow(); const r = rows[state.sel]; if (!r) return;
    if (!confirm(`Delete ${r.id || 'this record'}? A decided record is better marked deprecated or superseded, so its reason stays readable.`)) return;
    rows.splice(state.sel, 1); state.sel = null; state.edRow = undefined; setRows(rows);
  }
  const setField = (k, v) => { const rows = rowsNow(); const r = rows[state.sel]; if (!r) return; r[k] = v; if (k === 'date') state.scale = null; setRows(rows); };
  const fields = {};
  function buildCard() {
    state.edRow = state.sel;
    for (const k of Object.keys(fields)) delete fields[k];
    const rows = ctx.raw.decisions || [];
    const r = rows[state.sel];
    if (!r) {
      cardHead.replaceChildren(h('h2', {}, 'Record'));
      card.replaceChildren(h('div', { class: 'dl-empty' }, 'Click a decision on the timeline to read and edit it, or start a new one.'),
        h('div', { class: 'dl-row' }, h('button', { class: 'k-btn', type: 'button', onclick: () => addRecord() }, '+ New decision')));
      return;
    }
    const inp = (k, label, cls, ph) => {
      const el = h('input', { type: 'text', class: cls || null, spellcheck: 'false', 'data-k': k, placeholder: ph || null, 'aria-label': label });
      el.addEventListener('input', () => setField(k, el.value));
      fields[k] = el;
      return h('label', {}, label, el);
    };
    const st = h('div', { class: 'dl-st', role: 'group', 'aria-label': 'Status' });
    fields.status = st;
    const by = h('select', { 'data-k': 'superseded_by', 'aria-label': 'Superseded by' });
    by.addEventListener('change', () => {
      const rows2 = rowsNow(); const rr = rows2[state.sel]; if (!rr) return;
      rr.superseded_by = by.value;
      if (by.value && rr.status !== 'superseded') rr.status = 'superseded';
      setRows(rows2);
    });
    fields.superseded_by = by;
    const todayBtn = h('button', { class: 'k-btn', type: 'button', title: 'Set the date to today', onclick: () => { setField('date', today()); } }, 'Today');
    cardHead.replaceChildren(h('h2', { id: 'dl-cardt' }), h('span', { class: 'dl-grow' }),
      h('button', { class: 'k-btn', type: 'button', title: 'Add a new record that replaces this one, and mark this one superseded', onclick: () => addRecord(state.sel) }, 'Supersede with a new decision'),
      h('button', { class: 'k-btn dl-danger', type: 'button', onclick: delRecord }, 'Delete'));
    card.replaceChildren(
      st,
      h('div', { class: 'two' }, inp('id', 'ID', 'mono'), inp('date', 'Date', 'mono', 'YYYY-MM-DD'), todayBtn),
      inp('title', 'Title', null, 'the decision in a few words'),
      ...PARTS.map(([k, label, help]) => {
        const ta = h('textarea', { rows: k === 'context' || k === 'decision' ? 3 : 2, 'data-k': k, placeholder: help, 'aria-label': label });
        ta.addEventListener('input', () => setField(k, ta.value));
        const flag = h('em');
        fields[k] = ta; fields[`${k}Flag`] = flag;
        return h('label', {}, h('span', { class: 'lh' }, h('span', {}, label), flag), ta);
      }),
      h('label', {}, 'Superseded by', by),
      h('div', { class: 'dl-issues', id: 'dl-issues' }));
    syncCard();
  }
  function syncCard() {
    const rows = ctx.raw.decisions || [];
    const r = rows[state.sel]; if (!r) return;
    const rec = recOf(state.sel);
    const t = document.getElementById('dl-cardt');
    if (t) t.textContent = rec ? `${rec.id}` : 'Record';
    for (const k of ['id', 'date', 'title', ...PARTS.map(([kk]) => kk)]) {
      const el = fields[k]; if (!el) continue;
      if (document.activeElement !== el) el.value = r[k] ?? '';
    }
    fields.date?.classList.toggle('bad', !!String(r.date ?? '').trim() && !rec?.date);
    fields.id?.classList.toggle('bad', !!rec?.issues.some((w) => /no ID|used twice/.test(w)));
    const status = rec?.status || 'proposed';
    const col = { proposed: 'var(--tool-prop)', accepted: 'var(--tool-acc)', superseded: 'var(--tool-old)', deprecated: 'var(--tool-old)', rejected: 'var(--tool-rej)' };
    fields.status.replaceChildren(...STATUSES.map((s) => h('button', { type: 'button', 'aria-pressed': String(status === s), style: `--c:${col[s]}`,
      onclick: () => { const rows2 = rowsNow(); const rr = rows2[state.sel]; if (!rr) return; rr.status = s; if (s !== 'superseded') rr.superseded_by = ''; setRows(rows2); } }, s)));
    const others = (adr()?.records || []).filter((x) => x.row !== state.sel);
    const cur = String(r.superseded_by ?? '');
    fields.superseded_by.replaceChildren(h('option', { value: '' }, '(none: this decision stands or was not replaced)'),
      ...others.map((x) => h('option', { value: x.id, selected: x.id.toUpperCase() === cur.toUpperCase() }, `${x.id} · ${x.title || 'untitled'}`)),
      cur && !others.some((x) => x.id.toUpperCase() === cur.toUpperCase()) ? h('option', { value: cur, selected: true }, `${cur} (not in the log)`) : null);
    for (const [k] of PARTS) {
      const miss = rec && (rec.missing.includes(k) || (k === 'decision' && !rec.has.decision && rec.status !== 'proposed'));
      fields[`${k}Flag`].textContent = miss ? 'missing' : '';
      fields[k].classList.toggle('bad', !!miss);
    }
    const iss = document.getElementById('dl-issues');
    if (iss) iss.replaceChildren(...(rec?.issues || []).map((w) => h('div', {}, w)));
  }

  // ---------- header, now, legend ----------
  function drawHead(a, res) {
    if (document.activeElement !== statusSel) statusSel.value = ctx.raw.status || 'all';
    if (document.activeElement !== findIn) findIn.value = ctx.raw.filter ?? '';
    const shown = a ? a.records.filter((r) => r.shown).length : 0;
    count.textContent = a ? (shown === a.records.length ? `${a.records.length} records` : `${shown} of ${a.records.length} match`) : '';
    addBtn.title = a ? `Adds ${a.next}, dated today` : null;
  }
  function drawNow(a) {
    if (!a) { now.replaceChildren(); return; }
    const chip = (r, cls) => h('button', { class: `dl-chip ${cls}`, type: 'button', onclick: () => { select(r.row); svg.querySelector(`.dl-node[data-row="${r.row}"]`)?.focus({ preventScroll: true }); } }, h('b', {}, r.id), r.title || 'untitled');
    const acc = a.records.filter((r) => r.status === 'accepted');
    const prop = a.records.filter((r) => r.status === 'proposed');
    now.replaceChildren(...[
      h('div', { class: 'row' }, h('span', {}, 'In force'), ...(acc.length ? acc.map((r) => chip(r, 'acc')) : [h('span', {}, 'none accepted yet')])),
      prop.length ? h('div', { class: 'row' }, h('span', {}, 'Open'), ...prop.map((r) => chip(r, 'prop'))) : null].filter(Boolean));
  }
  function drawLegend() {
    const dot = (fill, stroke, dash) => `<svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><circle r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="2" ${dash ? 'stroke-dasharray="3 2"' : ''}/></svg>`;
    legend.innerHTML = `<span>${dot('var(--tool-acc)', 'var(--tool-acc)')}accepted</span><span>${dot('var(--surface)', 'var(--tool-prop)', true)}proposed</span>`
      + `<span>${dot('var(--tool-old)', 'var(--tool-old)')}superseded</span><span>${dot('var(--surface)', 'var(--tool-old)')}deprecated</span><span>${dot('var(--tool-rej)', 'var(--tool-rej)')}rejected</span>`
      + '<span><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><path d="M1.4,-7.9 A8,8 0 0 1 7.9,-1.4" stroke="var(--ink-soft)" stroke-width="2.5" fill="none" opacity=".6"/><path d="M7.9,1.4 A8,8 0 0 1 1.4,7.9" stroke="var(--danger)" stroke-width="2.5" fill="none"/><path d="M-1.4,7.9 A8,8 0 0 1 -7.9,1.4" stroke="var(--ink-soft)" stroke-width="2.5" fill="none" opacity=".6"/><path d="M-7.9,-1.4 A8,8 0 0 1 -1.4,-7.9" stroke="var(--ink-soft)" stroke-width="2.5" fill="none" opacity=".6"/></svg>ring: context, decision, alternatives, consequences (red = missing)</span>'
      + '<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="var(--danger)"/></svg>has a problem</span>'
      + '<span style="flex-basis:100%">Drag a decision along the axis to re-date it · drag the selected one\'s knob onto the decision that replaced it · focused: ← → one day, Shift a week, Enter edits</span>';
  }

  // ---------- render ----------
  function render() {
    const res = ctx.result; if (!res) return;
    const a = res.adr || null;
    const rows = ctx.raw.decisions || [];
    if (state.sel != null && !rows[state.sel]) state.sel = null;
    if (state.sel == null && a?.records.length && state.edRow === undefined) {
      const firstOpen = a.records.find((r) => r.status === 'proposed') || a.records[a.records.length - 1];
      state.sel = firstOpen.row;
    }
    const act = document.activeElement;
    const refocus = state.refocus ?? (act?.closest?.('.dl-node') ? +act.dataset.row : null);
    state.refocus = null;
    drawHead(a, res);
    drawTimeline(a);
    drawNow(a);
    if (state.edRow !== state.sel) buildCard(); else syncCard();
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((w) => h('div', {}, w)));
    if (refocus != null && (act === document.body || !document.contains(act) || act?.closest?.('.dl-node'))) svg.querySelector(`.dl-node[data-row="${refocus}"]`)?.focus({ preventScroll: true });
    if (proj.loaded) drawProj();
  }
  new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth - 8);
    if (w > 0 && Math.abs(w - state.W) > 2) { state.W = w; state.scale = null; render(); }
  }).observe(stage);
  state.W = Math.max(300, stage.clientWidth - 8 || 800);
  drawLegend();
  ctx.onResult(() => render());
  if (/^https?:/.test(location.protocol)) {
    let p = null;
    try { p = new URLSearchParams(location.search).get('project'); } catch { /* no query */ }
    proj.name = (p || 'default').trim() || 'default';
    load();
  } else drawProj();
}
