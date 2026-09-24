// Change Impact Estimator: which parts and rooms a change reaches through
// "depends on" links. Reverse reachability (breadth-first search over the reversed
// dependency graph) - the standard change impact analysis of Bohner & Arnold (1996):
// everything that transitively depends on a changed item is in its impact set.
//   hops    = shortest dependency distance from a changed item
//   weight  = 0.5^(hops-1): a direct dependant counts 1, two hops 0.5, three 0.25...
//             (rule of thumb: each hop has about even odds of really needing work)
// Cycles are reported with Tarjan's strongly connected components (Tarjan 1972).
import { fmtNum } from '../kit/eng.js';

export const ROOMS = ['pcb', 'embedded', 'cad', 'mobile', 'web', 'analyze'];
const split = (s) => String(s ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

function sccs(names, out) {
  let idx = 0; const index = new Map(), low = new Map(), on = new Set(), st = [], comps = [];
  const go = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of out.get(v) || []) {
      if (!index.has(w)) { go(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); comps.push(c); }
  };
  for (const v of names) if (!index.has(v)) go(v);
  return comps.filter((c) => c.length > 1 || (out.get(c[0]) || []).includes(c[0]));
}

export function run({ items, changed, maxHops }) {
  const warnings = [], notes = [];
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { warnings: ['Add the parts of the project, each with its room and what it depends on.'] };
  const byLower = new Map();
  const parts = [];
  rows.forEach((r, i) => {
    const name = String(r?.name ?? '').trim();
    if (!name) { if (String(r?.deps ?? '').trim()) warnings.push(`Row ${i + 1} has dependencies but no name; it was skipped.`); return; }
    if (byLower.has(name.toLowerCase())) { warnings.push(`"${name}" is listed twice; the rows were merged.`); byLower.get(name.toLowerCase()).deps.push(...split(r?.deps)); return; }
    const room = ROOMS.includes(r?.room) ? r.room : 'analyze';
    const p = { name, room, deps: split(r?.deps) };
    parts.push(p); byLower.set(name.toLowerCase(), p);
  });
  // dependants graph: dep -> items that depend on it
  const users = new Map(parts.map((p) => [p.name, []]));
  const dependsOn = new Map(parts.map((p) => [p.name, []]));
  const unknown = new Set();
  for (const p of parts) for (const d of p.deps) {
    const q = byLower.get(d.toLowerCase());
    if (!q) { unknown.add(`${d} (in ${p.name})`); continue; }
    if (!users.get(q.name).includes(p.name)) users.get(q.name).push(p.name);
    if (!dependsOn.get(p.name).includes(q.name)) dependsOn.get(p.name).push(q.name);
  }
  if (unknown.size) warnings.push(`Unknown dependencies (no row with that name): ${[...unknown].join(', ')}. Add the row or fix the spelling; those links were ignored.`);
  const cycles = sccs(parts.map((p) => p.name), dependsOn);
  if (cycles.length) warnings.push(`Circular dependencies: ${cycles.map((c) => c.reverse().join(' ↔ ')).join('; ')}. A change anywhere in a loop reaches all of it; consider an interface item both sides depend on.`);

  const start = [];
  for (const c of split(changed)) {
    const p = byLower.get(c.toLowerCase());
    if (p) { if (!start.includes(p.name)) start.push(p.name); } else warnings.push(`Changed item "${c}" is not in the table: check the spelling.`);
  }
  if (!start.length) return { warnings: [...warnings, 'Name at least one changed item (comma-separated) that is in the table.'] };
  const limit = maxHops > 0 ? Math.floor(maxHops) : Infinity;
  if (maxHops != null && maxHops < 0) warnings.push('Max hops cannot be negative: no limit was applied.');

  // BFS over dependants
  const hops = new Map(start.map((s) => [s, 0]));
  const via = new Map();
  const queue = [...start];
  while (queue.length) {
    const v = queue.shift();
    if (hops.get(v) >= limit) continue;
    for (const w of users.get(v)) if (!hops.has(w)) { hops.set(w, hops.get(v) + 1); via.set(w, v); queue.push(w); }
  }
  const pathTo = (n) => { const p = [n]; while (via.has(p[0])) p.unshift(via.get(p[0])); return p.join(' → '); };
  const byName = new Map(parts.map((p) => [p.name, p]));
  const hit = [...hops].filter(([n]) => !start.includes(n)).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const weight = (h) => Math.pow(0.5, h - 1);

  const roomRows = ROOMS.map((room) => {
    const inRoom = hit.filter(([n]) => byName.get(n).room === room);
    const changedHere = start.filter((n) => byName.get(n).room === room);
    return { room, n: inRoom.length, changed: changedHere.length, nearest: inRoom.length ? Math.min(...inRoom.map(([, h]) => h)) : null,
      w: inRoom.reduce((t, [, h]) => t + weight(h), 0), items: inRoom.map(([n]) => n) };
  }).filter((r) => r.n || r.changed);
  const roomsTouched = roomRows.filter((r) => r.n || r.changed).map((r) => r.room);
  const total = hit.reduce((t, [, h]) => t + weight(h), 0);
  const maxH = hit.length ? Math.max(...hit.map(([, h]) => h)) : 0;
  const untouched = parts.filter((p) => !hops.has(p.name)).length;

  const level = total >= 6 || roomsTouched.length >= 4 ? ['high', 'bad'] : total >= 2.5 || roomsTouched.length >= 3 ? ['medium', 'warn'] : ['low', 'ok'];
  const values = [
    { label: 'Changed', value: start.join(', ') },
    { label: 'Items affected', value: hit.length, hint: `of ${parts.length - start.length} others` },
    { label: 'Rooms touched', value: roomsTouched.length, hint: roomsTouched.join(', ') },
    { label: 'Farthest reach', value: maxH, unit: maxH === 1 ? 'hop' : 'hops' },
    { label: 'Impact score', value: fmtNum(total, 3), hint: 'direct 1, each hop halves' },
    { label: 'Impact', value: level[0], tone: level[1] },
  ];
  if (limit !== Infinity && hit.some(([, h]) => h === limit)) notes.push(`Stopped at ${limit} hop${limit > 1 ? 's' : ''}: items further out are not listed.`);
  const tables = [
    { title: 'Affected items, nearest first', columns: ['Item', 'Room', 'Hops', 'Weight', 'Reached via'],
      rows: hit.map(([n, h]) => [n, byName.get(n).room, h, fmtNum(weight(h), 3), pathTo(n)]) },
    { title: 'Per room', columns: ['Room', 'Changed here', 'Affected', 'Nearest hop', 'Weight', 'Items'],
      rows: roomRows.map((r) => [r.room, r.changed, r.n, r.nearest ?? '–', fmtNum(r.w, 3), r.items.join(', ') || '–']) },
  ];
  const charts = roomRows.length ? [{ title: 'Weighted impact per room', type: 'bars', x: roomRows.map((r) => r.room), series: [{ name: 'weight', y: roomRows.map((r) => +r.w.toFixed(3)) }] }] : [];
  const check = roomRows.filter((r) => r.n).map((r) => `## ${r.room}\n${hit.filter(([n]) => byName.get(n).room === r.room).map(([n, h]) => `- [ ] ${n} (${h === 1 ? 'direct' : `${h} hops`}: ${pathTo(n)})`).join('\n')}`).join('\n\n');
  if (!hit.length) notes.push('Nothing depends on the changed items: the change stays where it is (or the table is missing its "depends on" links).');
  notes.push(`${untouched} item${untouched === 1 ? ' is' : 's are'} not reached. Impact level: high at a score of 6 or 4+ rooms, medium at 2.5 or 3 rooms (rule of thumb for how much coordination the change needs).`);
  return { values, tables, charts, warnings, notes,
    texts: [{ title: 'Review checklist', body: `# Change: ${start.join(', ')}\n\n${check || 'Nothing else to review.'}\n`, lang: 'markdown' }] };
}
