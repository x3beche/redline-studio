// The live half of the Agent Queue Inspector: Refresh takes a snapshot of
// the app - /api/queue, and per room /api/run and /api/activity, plus the
// notes' statuses from /api/revisions - stamps it with the time it was
// taken and writes it into the Snapshot input with api.set, so run(), the
// Prompt and the JSON all describe the same moment. It refreshes once when
// the tool opens, and every 30 s while "Keep refreshing" is ticked.
// Opened as a file there is no app to ask: it says so, and a pasted
// snapshot still works.

const ROOMS = ['cad', 'pcb', 'web', 'embedded', 'mobile'];
const LOG_LINES = 100;
const EVERY = 30;               // seconds between automatic refreshes
const st = { loaded: false, busy: false, msg: '', tone: '', auto: false, timer: null };
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

async function get(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u.split('?')[0]} answered ${r.status}`);
  return r.json();
}

async function refresh() {
  if (st.busy) return;
  st.busy = true; st.msg = 'Taking a snapshot…'; st.tone = ''; draw();
  try {
    const [queue, open, archived, runs, logs] = await Promise.all([
      get('/api/queue'),
      get('/api/revisions'),
      get('/api/revisions?archived=true').catch(() => []),
      Promise.all(ROOMS.map((r) => get(`/api/run?room=${r}`).catch(() => null))),
      Promise.all(ROOMS.map((r) => get(`/api/activity?room=${r}&limit=${LOG_LINES}`).catch(() => []))),
    ]);
    const snap = {
      at: new Date().toISOString(),
      queue: (Array.isArray(queue) ? queue : []).map((x) => ({ id: x.id ?? x._id, kind: x.kind || 'cad', summary: x.summary || String(x.comment || '').slice(0, 120),
        queued_at: x.queued_at || null, created_at: x.created_at || null })),
      runs: Object.fromEntries(ROOMS.map((r, i) => [r, runs[i]]).filter(([, v]) => v && typeof v === 'object')
        .map(([r, v]) => [r, { status: v.status, percent: v.percent, title: v.title, started_at: v.started_at, finished_at: v.finished_at }])),
      activity: Object.fromEntries(ROOMS.map((r, i) => [r, (Array.isArray(logs[i]) ? logs[i] : [])
        .map((l) => ({ at: l.at, text: String(l.text || '').slice(0, 160), level: l.level }))]).filter(([, v]) => v.length)),
      revisions: [...new Map([...(Array.isArray(archived) ? archived : []), ...(Array.isArray(open) ? open : [])]
        .map((x) => [x.id ?? x._id, { kind: x.kind || 'cad', status: x.status }])).values()],
    };
    st.loaded = true; st.busy = false;
    st.msg = `Snapshot at ${new Date(snap.at).toLocaleTimeString()}: ${snap.queue.length} queued, ${Object.keys(snap.runs).length} rooms with a run.`; st.tone = 'ok';
    ctx.api.set('snapshot', JSON.stringify(snap));
  } catch (e) {
    st.loaded = true; st.busy = false;
    st.msg = `Could not reach the app (${e.message || e}). Paste a snapshot instead.`; st.tone = 'bad';
    draw();
  }
}

function setAuto(on) {
  st.auto = on;
  clearInterval(st.timer); st.timer = null;
  if (on) st.timer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, EVERY * 1000);
  draw();
}

function draw() {
  if (!ctx) return;
  const tone = `var(${st.tone === 'bad' ? '--danger' : st.tone === 'warn' ? '--warn' : st.tone === 'ok' ? '--ok' : '--ink-soft'})`;
  if (!/^https?:/.test(location.protocol)) {
    ctx.el.replaceChildren($('div', { class: 'k-block' }, $('div', { class: 'k-title' }, 'Live snapshot'),
      $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to read the queue, runs and logs live. Opened as a file it cannot reach them: paste a snapshot JSON instead.')));
    return;
  }
  ctx.el.replaceChildren($('div', { class: 'k-block' },
    $('div', { class: 'k-title' }, 'Live snapshot'),
    $('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      $('button', { class: 'k-btn k-primary', disabled: st.busy, onclick: refresh }, st.busy ? 'Reading…' : 'Refresh'),
      $('label', { style: 'font-size:12px;color:var(--ink-soft);display:flex;gap:5px;align-items:center' },
        $('input', { type: 'checkbox', checked: st.auto, onchange: (e) => setAuto(e.target.checked) }), `Keep refreshing (every ${EVERY} s)`),
      $('span', { role: 'status', style: `font-size:12px;color:${tone}` }, st.msg))));
}

export function view(el, result, input, api) {
  ctx = { el, api };
  if (/^https?:/.test(location.protocol) && !st.loaded && !st.busy) { refresh(); return; }
  draw();
}
