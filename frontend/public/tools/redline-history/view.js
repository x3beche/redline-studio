// The live half of Redline History: "Load notes" reads the app's notes
// (/api/revisions, open and archived), keeps the fields run() uses, and
// writes them into the Notes input with api.set - so run(), the Prompt and
// the JSON all work on what was loaded. Notes are loaded once when the tool
// opens and again on the button. It also lists the repeated areas as
// buttons (click to see one's timeline) and shows that timeline's drawings.
// Opened as a file there is no app to ask: it says so, and a pasted JSON
// list still works.

const st = { loaded: false, busy: false, msg: '', tone: '', at: null };
let ctx = null;

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

const compact = (x) => {
  const o = { id: x.id ?? x._id, created_at: x.created_at, kind: x.kind || 'cad', model: x.model || null, part: x.part || null,
    status: x.status, summary: x.summary || String(x.comment || '').slice(0, 140) };
  const t = x.camera && Array.isArray(x.camera.target) ? x.camera.target : null;
  if (t && t.every((v) => Number.isFinite(Number(v)))) o.target = t.map((v) => Math.round(Number(v) * 10) / 10);
  if (typeof o.part === 'string' && o.part.length > 100) o.part = o.part.slice(0, 100);
  return o;
};

async function load() {
  st.busy = true; st.msg = 'Reading the notes…'; st.tone = ''; draw();
  try {
    const got = await Promise.all(['/api/revisions', '/api/revisions?archived=true'].map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${u} answered ${r.status}`);
      return r.json();
    }));
    const byId = new Map();
    for (const list of got) for (const x of Array.isArray(list) ? list : []) byId.set(x.id ?? x._id, compact(x));
    const notes = [...byId.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    st.loaded = true; st.busy = false; st.at = new Date();
    st.msg = notes.length ? `${notes.length} notes loaded from the app.` : 'The app has no notes yet.'; st.tone = notes.length ? 'ok' : 'warn';
    if (notes.length) ctx.api.set('notes', '[' + notes.map((n) => JSON.stringify(n)).join(',\n') + ']');
    else draw();
  } catch (e) {
    st.loaded = true; st.busy = false;
    st.msg = `Could not read the notes (${e.message || e}). Paste them as JSON instead.`; st.tone = 'bad';
    draw();
  }
}

function draw() {
  if (!ctx) return;
  const { el, result, api } = ctx;
  const tone = `var(${st.tone === 'bad' ? '--danger' : st.tone === 'warn' ? '--warn' : st.tone === 'ok' ? '--ok' : '--ink-soft'})`;
  const areas = (result.tables || []).find((t) => t.columns[0] === 'Area');
  const line = (result.tables || []).find((t) => String(t.title || '').startsWith('Timeline: '));
  const focus = line ? line.title.slice('Timeline: '.length) : null;
  const chips = areas && areas.rows.length ? $('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px' },
    areas.rows.slice(0, 16).map((r) => $('button', {
      class: `k-btn${r[0] === focus ? ' k-primary' : ''}`, title: `Show the timeline of ${r[0]}`,
      style: 'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      onclick: () => api.set('area', r[0]) }, `${r[0].length > 42 ? r[0].slice(0, 41) + '…' : r[0]} · ${r[1]}`))) : null;

  // The drawings of the timeline shown, oldest first (the app keeps the PNG per note).
  let shots = null;
  if (line && st.at && /^https?:/.test(location.protocol)) {   // only notes that came from the app have drawings
    const ids = line.rows.map((r) => r[4]).filter((id) => id && id !== '–').slice(-8);
    if (ids.length) {
      shots = $('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:8px' },
        ids.map((id) => {
          const row = line.rows.find((r) => r[4] === id);
          const img = $('img', { src: `/api/revisions/${encodeURIComponent(id)}/image`, alt: row[2], loading: 'lazy',
            style: 'width:100%;aspect-ratio:4/3;object-fit:cover;border:1px solid var(--line);border-radius:4px;background:var(--sunken)' });
          const fig = $('figure', { style: 'margin:0;min-width:0' }, img,
            $('figcaption', { style: 'font-size:11px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: row[2] },
              `${row[0].slice(5)} · ${row[1]}${row[3] ? ' · again' : ''}`));
          img.addEventListener('error', () => fig.remove());   // an example note has no drawing
          return fig;
        }));
    }
  }

  if (!/^https?:/.test(location.protocol)) {
    el.replaceChildren($('div', { class: 'k-block' }, $('div', { class: 'k-title' }, 'Notes from the app'),
      $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to load the notes live. Opened as a file it cannot reach them: paste /api/revisions as JSON into Notes.'),
      chips));
    return;
  }
  el.replaceChildren($('div', { class: 'k-block' },
    $('div', { class: 'k-title' }, 'Notes from the app'),
    $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      $('button', { class: 'k-btn k-primary', disabled: st.busy, onclick: load }, st.busy ? 'Loading…' : st.loaded ? 'Reload notes' : 'Load notes'),
      $('span', { role: 'status', style: `font-size:12px;color:${tone}` }, st.msg,
        st.at ? ` (${st.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '')),
    chips,
    shots ? $('div', { class: 'k-title', style: 'margin:10px 0 0' }, `Drawings: ${focus}`) : null,
    shots));
}

export function view(el, result, input, api) {
  ctx = { el, result, api };
  if (/^https?:/.test(location.protocol) && !st.loaded && !st.busy) { load(); return; }
  draw();
}
