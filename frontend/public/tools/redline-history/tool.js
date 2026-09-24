// Redline History Diff: every note drawn on the same area of a model,
// in time order, with what became of it - so a spot that keeps coming back
// (fixed, then re-marked) stands out.
//
// "Same area", in the order the data allows:
//   1. the same model and the same part (a CAD body, a web selector) when
//      the note names one;
//   2. otherwise the same model and a camera target within `radius` of the
//      area's first note - the orbit camera looks at what is being marked,
//      so its target is a fair stand-in for the spot (an approximation: two
//      notes can look at one point from different sides);
//   3. otherwise the model alone (PCB notes carry no camera).
// Clustering is greedy in time order: a note joins the first area whose
// seed target is within the radius, else it starts a new one.
//
// Outcomes are the note statuses: applied, rejected, queued, draft. A note
// that lands on an area where an earlier note was already applied is a
// "came back": the first fix did not settle it.

const norm = (s) => String(s ?? '').trim();
const OPEN = new Set(['queued', 'draft', 'working', 'running']);

/** A JSON array, an object with an array inside, or JSON lines -> {list, bad}. */
function parseNotes(text) {
  const s = norm(text);
  if (!s) return { list: [], bad: [] };
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return { list: j, bad: [] };
    if (j && typeof j === 'object') {
      const arr = Object.values(j).find(Array.isArray);
      if (arr) return { list: arr, bad: [] };
      return { list: [j], bad: [] };
    }
  } catch { /* try JSON lines */ }
  const list = [], bad = [];
  s.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim().replace(/,$/, '');
    if (!l || l === '[' || l === ']') return;
    try { list.push(JSON.parse(l)); } catch { bad.push(i + 1); }
  });
  return { list, bad };
}

const vec = (t) => (Array.isArray(t) && t.length === 3 && t.every((x) => Number.isFinite(Number(x))) ? t.map(Number) : null);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const day = (iso) => (norm(iso) ? norm(iso).slice(0, 16).replace('T', ' ') : '–');
const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function run({ notes, room, by, radius, min, area }) {
  const warnings = [];
  const { list, bad } = parseNotes(notes);
  if (bad.length) warnings.push(`${bad.length === 1 ? 'Line' : 'Lines'} ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? '…' : ''} ${bad.length === 1 ? 'is' : 'are'} not JSON and ${bad.length === 1 ? 'was' : 'were'} skipped. Paste the notes as a JSON array or one JSON object per line.`);
  if (!list.length) return { warnings: [...warnings, 'No notes to read. In the app press "Load notes"; elsewhere paste /api/revisions as JSON.'] };
  const r = Number.isFinite(radius) && radius > 0 ? radius : 30;
  if (!(radius > 0)) warnings.push('Radius must be above 0 mm; 30 mm is used.');
  const minRepeat = Number.isFinite(min) && min >= 2 ? Math.round(min) : 2;

  // ---- normalise ----
  let noDate = 0;
  const all = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const id = norm(n.id ?? n._id);
    const created = norm(n.created_at ?? n.created);
    if (!created) noDate++;
    all.push({
      id, created, room: norm(n.kind ?? n.room) || 'cad', model: norm(n.model) || '(no model)',
      part: norm(n.part), status: norm(n.status) || 'draft',
      text: norm(n.summary) || norm(n.comment),
      target: vec(n.target) || vec(n.camera?.target),
    });
  }
  if (noDate) warnings.push(`${noDate} note(s) have no created_at: they sort last and the timeline may be out of order.`);
  const want = room && room !== 'all' ? room : null;
  const notesIn = all.filter((n) => !want || n.room === want)
    .sort((a, b) => (a.created || '~').localeCompare(b.created || '~'));
  if (!notesIn.length) return { warnings: [...warnings, `No ${want} notes among the ${all.length} read.`] };

  // ---- group into areas ----
  const mode = by || 'auto';
  const areas = [];
  const byKey = new Map();
  // -> {key, seed}: seed is set only for an area found by camera target.
  const place = (n) => {
    if (mode === 'model') return { key: n.model };
    if (n.part && mode !== 'place') return { key: `${n.model} › ${short(n.part, 60)}` };
    if (n.target && mode !== 'part') {
      // The nearest area of this model whose first note's target is within the radius.
      let best = null, bd = Infinity;
      for (const a of areas) {
        if (a.model !== n.model || !a.seed) continue;
        const d = dist(a.seed, n.target);
        if (d <= r && d < bd) { best = a; bd = d; }
      }
      if (best) return { key: best.key };
      let k = `${n.model} @ (${n.target.map((x) => Math.round(x)).join(', ')})`;
      if (byKey.has(k)) k += ` #${areas.length + 1}`;
      return { key: k, seed: n.target };
    }
    return { key: n.model };
  };
  for (const n of notesIn) {
    const p = place(n);
    let a = byKey.get(p.key);
    if (!a) {
      a = { key: p.key, model: n.model, seed: p.seed || null, notes: [] };
      byKey.set(p.key, a); areas.push(a);
    }
    a.notes.push(n);
  }

  // ---- outcomes per area ----
  for (const a of areas) {
    let appliedBefore = false;
    a.back = 0;
    for (const n of a.notes) {
      if (appliedBefore) { n.back = true; a.back++; }
      if (n.status === 'applied') appliedBefore = true;
    }
    a.applied = a.notes.filter((n) => n.status === 'applied').length;
    a.rejected = a.notes.filter((n) => n.status === 'rejected').length;
    a.open = a.notes.filter((n) => OPEN.has(n.status)).length;
  }
  const hot = areas.filter((a) => a.notes.length >= minRepeat)
    .sort((x, y) => y.notes.length - x.notes.length || (y.notes.at(-1).created || '').localeCompare(x.notes.at(-1).created || ''));

  // ---- the area to show in full ----
  const q = norm(area).toLowerCase();
  const focus = q ? (hot.find((a) => a.key.toLowerCase().includes(q)) || areas.find((a) => a.key.toLowerCase().includes(q))) : hot[0];
  if (q && !focus) warnings.push(`No area matches "${area}": pick one from the list (model, part or @ coordinates).`);

  const applied = notesIn.filter((n) => n.status === 'applied').length;
  const rejected = notesIn.filter((n) => n.status === 'rejected').length;
  const inHot = hot.reduce((s, a) => s + a.notes.length, 0);
  const back = areas.reduce((s, a) => s + a.back, 0);

  const tables = [{
    title: hot.length ? `Areas with ${minRepeat} or more notes` : `No area has ${minRepeat} or more notes`,
    columns: ['Area', 'Notes', 'First', 'Last', 'Applied', 'Rejected', 'Open', 'Came back', 'Latest note'],
    rows: hot.map((a) => [a.key, a.notes.length, day(a.notes[0].created), day(a.notes.at(-1).created), a.applied, a.rejected, a.open, a.back, short(a.notes.at(-1).text)]),
  }];
  if (focus) {
    tables.push({
      title: `Timeline: ${focus.key}`,
      columns: ['When', 'Status', 'Note', 'Came back?', 'ID'],
      rows: focus.notes.map((n) => [day(n.created), n.status, n.text || '–', n.back ? 'yes' : '', n.id || '–']),
    });
  }
  const top = hot.slice(0, 10);
  const charts = top.length ? [{
    title: 'Notes per area (most marked first)', type: 'bars', x: top.map((a) => short(a.key.split(/ › | @ /).pop(), 18)),
    series: [{ name: 'applied', y: top.map((a) => a.applied) }, { name: 'rejected', y: top.map((a) => a.rejected) }, { name: 'open', y: top.map((a) => a.open) }],
  }] : [];

  if (back) warnings.push(`${back} note(s) landed on an area that already had an applied fix. Read that area's timeline before changing the spot again: a later note may undo or redo earlier work.`);
  const notesOut = [
    mode === 'model' ? 'Grouped by model only.' : `Grouped by model and part; notes without a part by camera target within ${r} mm of the area's first note (an approximation of the marked spot).`,
    '"Came back" counts notes that follow an applied note in the same area. A camera aimed at the whole model (its centre) gathers unrelated notes into one area: lower the radius or group by part to split them.',
  ];
  return {
    values: [
      { label: 'Notes', value: notesIn.length, hint: want ? `${want} only` : ((k) => `${k} room${k === 1 ? '' : 's'}`)(new Set(notesIn.map((n) => n.room)).size) },
      { label: 'Areas', value: areas.length },
      { label: 'Marked again', value: hot.length, hint: `areas with ≥ ${minRepeat} notes` },
      { label: 'Notes in them', value: notesIn.length ? `${Math.round((100 * inHot) / notesIn.length)} %` : '–', hint: `${inHot} notes` },
      { label: 'Came back', value: back, tone: back ? 'warn' : 'ok', hint: 'after an applied fix' },
      { label: 'Applied', value: applied + rejected ? `${Math.round((100 * applied) / (applied + rejected))} %` : '–', hint: `${applied} applied, ${rejected} rejected` },
    ],
    charts,
    tables,
    warnings,
    notes: notesOut,
  };
}
