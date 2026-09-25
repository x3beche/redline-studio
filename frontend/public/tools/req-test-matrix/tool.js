// Requirement <-> Test Matrix: a requirements traceability matrix (RTM).
// Each requirement is traced forward to the verifications that prove it,
// each verification backward to what it covers, and the gaps are listed -
// the bidirectional traceability ISO/IEC/IEEE 29148:2018 asks for.
//
// Status of a requirement, from the results of the tests that cover it:
//   no evidence  - nothing covers it (a gap)
//   failing      - any covering test failed
//   blocked      - none failed, one could not be run
//   verified     - covered, and every covering test passed
//   partly run   - some passed, some not run yet
//   not run      - covered, nothing run yet
// Verification methods are the IADT set (inspection, analysis,
// demonstration, test) from the INCOSE SE Handbook and ISO/IEC/IEEE 29148.

const RESULTS = ['not run', 'pass', 'fail', 'blocked'];
const ORDER = ['no evidence', 'failing', 'blocked', 'not run', 'partly run', 'verified'];

const norm = (s) => String(s ?? '').trim();
const idKey = (s) => norm(s).toUpperCase();

/** "REQ-1, REQ-2 REQ-3; req-4" -> ["REQ-1", ...] (commas, semicolons, spaces). */
function refs(text) {
  return norm(text).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}

function statusOf(results) {
  if (!results.length) return 'no evidence';
  if (results.includes('fail')) return 'failing';
  if (results.includes('blocked')) return 'blocked';
  const pass = results.filter((r) => r === 'pass').length;
  if (pass === results.length) return 'verified';
  return pass ? 'partly run' : 'not run';
}

const TONE = { 'no evidence': '✗ gap', failing: '✗ failing', blocked: '! blocked', 'not run': '… not run', 'partly run': '… partly run', verified: '✓ verified' };

export function run({ reqs, tests, show }) {
  const R = (Array.isArray(reqs) ? reqs : []).filter((r) => norm(r.id) || norm(r.text));
  const T = (Array.isArray(tests) ? tests : []).filter((t) => norm(t.id) || norm(t.name) || norm(t.covers));
  const warnings = [];
  const notes = [];
  if (!R.length) return { warnings: ['No requirements: add rows with an ID (REQ-01) and the requirement text.'] };

  // ---- requirements, IDs checked ----
  const req = new Map();
  R.forEach((r, i) => {
    const id = norm(r.id);
    if (!id) { warnings.push(`Requirement row ${i + 1} ("${norm(r.text).slice(0, 40)}") has no ID: give it one so tests can point at it.`); return; }
    if (req.has(idKey(id))) { warnings.push(`Requirement ID ${id} is used twice: IDs must be unique or the trace is ambiguous.`); return; }
    if (!norm(r.text)) warnings.push(`${id} has no text: say what must be true, in one testable sentence.`);
    req.set(idKey(id), { id, text: norm(r.text), priority: norm(r.priority) || 'should', method: norm(r.method) || 'test', tests: [] });
  });

  // ---- tests, traced to requirements ----
  const seenT = new Set();
  const orphans = [], unknown = [];
  T.forEach((t, i) => {
    const id = norm(t.id) || `row ${i + 1}`;
    if (!norm(t.id)) warnings.push(`Test row ${i + 1} ("${norm(t.name).slice(0, 40)}") has no ID.`);
    else if (seenT.has(idKey(id))) warnings.push(`Test ID ${id} is used twice.`);
    seenT.add(idKey(id));
    const result = RESULTS.includes(norm(t.result)) ? norm(t.result) : 'not run';
    const list = refs(t.covers);
    if (!list.length) orphans.push(id);
    for (const ref of list) {
      const r = req.get(idKey(ref));
      if (!r) unknown.push([id, ref]);
      else if (!r.tests.some((x) => x.id === id)) r.tests.push({ id, name: norm(t.name), result });
    }
  });
  if (unknown.length) warnings.push(`Tests point at requirements that do not exist: ${unknown.map(([t, r]) => `${t} → ${r}`).join(', ')}. Fix the ID or add the requirement.`);
  if (orphans.length) warnings.push(`Tests that cover no requirement: ${orphans.join(', ')}. Say what each proves, or drop it from the matrix.`);

  const all = [...req.values()].map((r) => ({ ...r, status: statusOf(r.tests.map((t) => t.result)) }));
  const count = (s) => all.filter((r) => r.status === s).length;
  const gaps = all.filter((r) => r.status === 'no evidence');
  const mustGaps = gaps.filter((r) => r.priority === 'must');
  const failing = all.filter((r) => r.status === 'failing');
  if (mustGaps.length) warnings.push(`Must-have requirements with no verification: ${mustGaps.map((r) => r.id).join(', ')}. Plan a ${[...new Set(mustGaps.map((r) => r.method))].join('/')} for each before release.`);
  if (failing.length) warnings.push(`Failing: ${failing.map((r) => `${r.id} (${r.tests.filter((t) => t.result === 'fail').map((t) => t.id).join(', ')})`).join('; ')}. Fix the design or change the requirement - do not ship on a failed test.`);

  const n = all.length;
  const covered = n - gaps.length;
  const verified = count('verified');
  const pct = (x) => (n ? `${Math.round((100 * x) / n)} %` : '–');

  const filter = show || 'all';
  const pick = (r) => filter === 'all' || (filter === 'gaps' && r.status === 'no evidence')
    || (filter === 'open' && r.status !== 'verified') || (filter === 'failing' && (r.status === 'failing' || r.status === 'blocked'));
  const rows = all.filter(pick).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id, undefined, { numeric: true }));

  const tables = [{
    title: filter === 'all' ? 'Traceability matrix' : `Traceability matrix - ${filter} only`,
    columns: ['Requirement', 'Priority', 'Method', 'Covered by', 'Status', 'Text'],
    rows: rows.map((r) => [r.id, r.priority, r.method,
      r.tests.length ? r.tests.map((t) => `${t.id} (${t.result})`).join(', ') : '–', TONE[r.status], r.text]),
  }];
  if (!rows.length) notes.push(`Nothing is ${filter === 'gaps' ? 'uncovered' : filter}.`);

  // The classic grid, requirement x test, while it still fits on a screen.
  const testIds = [...new Set(T.map((t, i) => norm(t.id) || `row ${i + 1}`))];
  if (testIds.length && testIds.length <= 12) {
    const mark = { pass: '✓', fail: '✗', blocked: '!', 'not run': '○' };
    tables.push({
      title: 'Grid (✓ pass, ✗ fail, ! blocked, ○ not run)',
      columns: ['', ...testIds],
      rows: all.map((r) => [r.id, ...testIds.map((tid) => { const t = r.tests.find((x) => x.id === tid); return t ? mark[t.result] : ''; })]),
    });
  }

  const md = ['| Requirement | Priority | Method | Covered by | Status |', '|---|---|---|---|---|',
    ...all.map((r) => `| ${r.id} ${r.text.replace(/\|/g, '\\|')} | ${r.priority} | ${r.method} | ${r.tests.map((t) => `${t.id} (${t.result})`).join(', ') || '-'} | ${r.status} |`)];

  notes.push('Covered = at least one verification points at the requirement; verified = every one of them passed.',
    'A requirement whose method is inspection, analysis or demonstration still needs a record in the Tests list (an inspection report, a calculation) to count as covered.');

  // For the page's drawing only (agents do not get it: manifest agentOmit):
  // both lists with their row in the input, and every link between them.
  const tIn = Array.isArray(tests) ? tests : [], rIn = Array.isArray(reqs) ? reqs : [];
  const tRows = tIn.map((t, i) => i).filter((i) => tIn[i] && (norm(tIn[i].id) || norm(tIn[i].name) || norm(tIn[i].covers)));
  const rRow = new Map();
  rIn.forEach((r, i) => { if (r && norm(r.id) && !rRow.has(idKey(r.id))) rRow.set(idKey(r.id), i); });
  const trace = {
    show: filter,
    reqs: all.map((r) => ({ id: r.id, text: r.text, priority: r.priority, method: r.method, status: r.status,
      tests: r.tests.map((t) => t.id), row: rRow.get(idKey(r.id)), shown: pick(r) })),
    unnamed: rIn.map((r, i) => (r && !norm(r.id) && norm(r.text) ? { row: i, text: norm(r.text) } : null)).filter(Boolean),
    tests: tRows.map((row, i) => {
      const t = tIn[row];
      const list = refs(t.covers);
      return { id: norm(t.id) || `row ${i + 1}`, name: norm(t.name), row, hasId: !!norm(t.id),
        result: RESULTS.includes(norm(t.result)) ? norm(t.result) : 'not run',
        covers: list.filter((x) => req.has(idKey(x))).map((x) => req.get(idKey(x)).id),
        unknown: list.filter((x) => !req.has(idKey(x))) };
    }),
  };
  return {
    trace,
    values: [
      { label: 'Requirements', value: n },
      { label: 'Covered', value: pct(covered), hint: `${covered} of ${n}`, tone: gaps.length ? 'warn' : 'ok' },
      { label: 'Verified', value: pct(verified), hint: `${verified} passed`, tone: verified === n ? 'ok' : undefined },
      { label: 'Gaps', value: gaps.length, hint: mustGaps.length ? `${mustGaps.length} must-have` : 'no evidence', tone: mustGaps.length ? 'bad' : gaps.length ? 'warn' : 'ok' },
      { label: 'Failing', value: failing.length, tone: failing.length ? 'bad' : 'ok' },
      { label: 'Tests', value: T.length, hint: orphans.length ? `${orphans.length} cover nothing` : undefined },
    ],
    charts: [{ title: 'Requirements by status', type: 'bars', x: ORDER, series: [{ name: 'requirements', y: ORDER.map(count) }] }],
    tables,
    texts: [{ title: 'Matrix (Markdown)', body: md.join('\n') + '\n', lang: 'markdown' }],
    warnings,
    notes,
  };
}
