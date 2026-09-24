// The project record: this tool's decision records is one shared document per
// project in the app (/api/tools/data/decision-log?project=<name>), so every room
// and every agent (MCP tool_data) reads the same list. It is loaded when the
// tool opens and written back only when "Save to project" is pressed.
// run() stays pure: the record reaches it as ordinary inputs, via api.set.
// Opened as a file there is no app to ask, and the panel says so.

const TOOL = 'decision-log';
const KEYS = ['decisions'];          // the inputs that make up the record

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
