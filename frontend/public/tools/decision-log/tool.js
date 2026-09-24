// Decision Log: Architecture Decision Records, one row each, in the form
// Michael Nygard proposed ("Documenting Architecture Decisions", 2011):
// title, status, context, decision, consequences - plus the alternatives
// that were turned down, as MADR (Markdown Any Decision Records) adds.
// A record is never edited into its opposite: a new one supersedes it, and
// the old one says "Superseded by ADR-00x". This checks that chain, the IDs
// and dates, and writes the records out as Markdown.

const STATUSES = ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'];
const norm = (s) => String(s ?? '').trim();
const key = (s) => norm(s).toUpperCase();

/** ISO 8601 calendar date, YYYY-MM-DD, and a real day. */
function isoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm(s));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] ? norm(s) : null;
}

/** ADR-007 -> {prefix 'ADR-', n 7, width 3}; used to suggest the next free ID. */
function idParts(id) {
  const m = /^(.*?)(\d+)$/.exec(norm(id));
  return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length } : null;
}

export function run({ decisions, filter, status }) {
  const rows = (Array.isArray(decisions) ? decisions : []).filter((r) => Object.values(r || {}).some((v) => norm(v)));
  const warnings = [];
  const notes = [];
  if (!rows.length) return { warnings: ['No decisions yet: add a row per decision (ID, date, title, status, context, decision).'] };

  const byId = new Map();
  const recs = [];
  rows.forEach((r, i) => {
    const id = norm(r.id);
    const where = id || `row ${i + 1}`;
    const st = STATUSES.includes(norm(r.status)) ? norm(r.status) : 'proposed';
    const rec = { i, id: id || `(row ${i + 1})`, date: norm(r.date), title: norm(r.title), status: st, context: norm(r.context),
      decision: norm(r.decision), alternatives: norm(r.alternatives), consequences: norm(r.consequences), by: norm(r.superseded_by) };
    if (!id) warnings.push(`Row ${i + 1} ("${rec.title.slice(0, 40)}") has no ID: number it (ADR-004) so others can cite it.`);
    else if (byId.has(key(id))) warnings.push(`${id} is used twice: every decision needs its own ID; renumber the newer one.`);
    else byId.set(key(id), rec);
    if (!rec.title) warnings.push(`${where} has no title: name the decision in a few words ("Buck converter for 3V3").`);
    if (!rec.decision && st !== 'proposed') warnings.push(`${where} is ${st} but does not say what was decided: fill in Decision.`);
    if (rec.date && !isoDate(rec.date)) warnings.push(`${where}: date "${rec.date}" is not a valid YYYY-MM-DD date (ISO 8601); write e.g. 2026-09-24 so the log sorts.`);
    recs.push(rec);
  });

  // ---- the supersede chain ----
  for (const r of recs) {
    if (r.status === 'superseded') {
      if (!r.by) warnings.push(`${r.id} is superseded but does not say by what: put the newer ADR's ID in "Superseded by".`);
      else if (!byId.has(key(r.by))) warnings.push(`${r.id} is superseded by ${r.by}, which is not in the log: add ${r.by} or fix the ID.`);
      else if (key(r.by) === key(r.id)) warnings.push(`${r.id} says it supersedes itself.`);
      else {
        const nu = byId.get(key(r.by));
        if (r.date && nu.date && isoDate(r.date) && isoDate(nu.date) && nu.date < r.date) warnings.push(`${r.id} (${r.date}) is superseded by ${nu.id}, dated earlier (${nu.date}): check the dates.`);
        if (nu.status === 'rejected') warnings.push(`${r.id} is superseded by ${nu.id}, which was rejected: the old decision still stands unless something else replaced it.`);
      }
    } else if (r.by) {
      warnings.push(`${r.id} names a successor (${r.by}) but its status is ${r.status}: set it to superseded, or clear the field.`);
    }
  }
  // A loop A -> B -> A means no decision is current.
  const loops = new Set();
  for (const r of recs) {
    const seen = new Set([key(r.id)]);
    let cur = r;
    while (cur && cur.status === 'superseded' && cur.by) {
      const k = key(cur.by);
      if (seen.has(k)) {
        const sig = [...seen].sort().join('|');
        if (!loops.has(sig)) { loops.add(sig); warnings.push(`Supersede loop through ${[...seen].join(' → ')} → ${cur.by}: one of them must be the current decision.`); }
        break;
      }
      seen.add(k); cur = byId.get(k);
    }
  }

  // ---- how complete each record is ----
  const quality = [];
  for (const r of recs) {
    const miss = [];
    if (!r.context) miss.push('context (the forces and constraints)');
    if (!r.alternatives && r.status !== 'proposed') miss.push('alternatives (what was turned down and why)');
    if (!r.consequences && r.status !== 'proposed') miss.push('consequences (what gets easier or harder)');
    if (!r.date) miss.push('date');
    if (miss.length) quality.push([r.id, r.title || '–', miss.join('; ')]);
  }

  // ---- what to show ----
  const f = norm(filter).toLowerCase();
  const want = status || 'all';
  const active = (r) => r.status === 'accepted' || r.status === 'proposed';
  const shown = recs.filter((r) => (want === 'all' || (want === 'active' ? active(r) : r.status === want))
    && (!f || [r.id, r.title, r.context, r.decision, r.alternatives, r.consequences].some((x) => x.toLowerCase().includes(f))));
  const sorted = [...shown].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.id.localeCompare(b.id, undefined, { numeric: true }));

  // Next free number in the most used prefix.
  const parts = recs.map((r) => idParts(r.id)).filter(Boolean);
  let next = 'ADR-001';
  if (parts.length) {
    const top = parts.reduce((a, b) => (b.n > a.n ? b : a));
    next = `${top.prefix}${String(top.n + 1).padStart(top.width, '0')}`;
  }

  const md = sorted.map((r) => [
    `# ${r.id}: ${r.title || '(untitled)'}`, '',
    `- Status: ${r.status}${r.by ? ` (superseded by ${r.by})` : ''}`,
    `- Date: ${r.date || 'not given'}`, '',
    '## Context', '', r.context || '_Not recorded._', '',
    '## Decision', '', r.decision || '_Not recorded._', '',
    '## Alternatives considered', '', r.alternatives || '_Not recorded._', '',
    '## Consequences', '', r.consequences || '_Not recorded._', ''].join('\n')).join('\n---\n\n');

  const count = (s) => recs.filter((r) => r.status === s).length;
  const tables = [{
    title: want === 'all' && !f ? 'Decisions' : `Decisions (${shown.length} of ${recs.length} shown)`,
    columns: ['ID', 'Date', 'Status', 'Title', 'Decision', 'Superseded by'],
    rows: sorted.map((r) => [r.id, r.date || '–', r.status, r.title || '–', r.decision.length > 90 ? r.decision.slice(0, 88) + '…' : r.decision || '–', r.by || '–']),
  }];
  if (quality.length) tables.push({ title: 'Records missing a part', columns: ['ID', 'Title', 'Missing'], rows: quality });
  if (!shown.length) notes.push(f ? `Nothing matches "${filter}".` : `No ${want} decisions.`);
  notes.push('Do not rewrite an accepted decision: add a new record and mark the old one superseded, so the reason for the change stays readable.');

  return {
    values: [
      { label: 'Decisions', value: recs.length },
      { label: 'Accepted', value: count('accepted'), tone: 'ok' },
      { label: 'Proposed', value: count('proposed'), hint: count('proposed') ? 'still open' : undefined, tone: count('proposed') ? 'warn' : undefined },
      { label: 'Superseded', value: count('superseded') + count('deprecated'), hint: 'incl. deprecated' },
      { label: 'Next ID', value: next },
    ],
    tables,
    texts: [{ title: 'ADRs (Markdown)', body: md ? md + '\n' : '(no records shown)\n', lang: 'markdown' }],
    warnings,
    notes,
  };
}
