// Assembly order from a pasted list of parts and what each goes onto.
// A topological sort (Kahn's algorithm) of the "goes onto" graph; among the
// parts that are ready, the choice follows the chosen strategy:
//   input  - keep the pasted order wherever the dependencies allow
//   group  - stay with the same approach direction, then the same tool, so the
//            assembly is turned over and tools are changed as rarely as possible
//            (the usual DFA goal: minimise reorientations and tool changes,
//            Boothroyd-Dewhurst DFA).
// A part with "blocks: <side>" closes that side; it is placed as late as the
// graph allows, and any later part that needs that side without sitting on the
// blocker is reported as an access conflict.

const DIRS = { top: 'top', up: 'top', above: 'top', bottom: 'bottom', below: 'bottom', under: 'bottom', down: 'bottom',
  front: 'front', back: 'back', rear: 'back', left: 'left', right: 'right', side: 'side', inside: 'inside' };
const SPLIT = /\s*(?:->|→|=>|\s+after\s+|\s+onto\s+|\s+into\s+|\s+on\s+|\s+needs\s+|\s+requires\s+)\s*/i;
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// "30s", "2 min", "1.5m", "90" (seconds) -> seconds, or null.
function seconds(t) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hours?)?$/i.exec(String(t).trim());
  if (!m) return null;
  const v = Number(m[1]);
  const u = (m[2] || 's').toLowerCase();
  return u.startsWith('h') ? v * 3600 : u.startsWith('m') ? v * 60 : v;
}
function fmtTime(sec) {
  const s = Math.round(sec);
  if (s >= 3600) { const m = Math.round((s % 3600) / 60); return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`; }
  if (s >= 60) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${s} s`;
}

function parse(text) {
  const parts = new Map();      // key -> part
  const problems = [];
  const warnings = [];
  const spelled = new Map();    // key -> first spelling seen, for unlisted parts
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+(#|\/\/).*$/, '').trim();
    if (!line || /^(#|\/\/)/.test(line)) return;
    const [headRaw, ...attrs] = line.split('|');
    const head = headRaw.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim();
    const [nameRaw, depsRaw] = head.split(SPLIT, 2);
    const name = (nameRaw || '').trim();
    if (!name) { problems.push(`line ${i + 1}: no part name in "${raw.trim()}"`); return; }
    const key = norm(name);
    const p = parts.get(key) || { key, name, deps: [], line: i + 1, idx: parts.size, tool: '', from: '', time: null, blocks: [], note: [] };
    if (parts.has(key)) warnings.push(`"${name}" is listed twice (lines ${p.line} and ${i + 1}); the two lines are merged.`);
    for (const d of String(depsRaw || '').split(/\s*[,;]\s*/)) {
      if (!d.trim()) continue;
      p.deps.push(d.trim());
      if (!spelled.has(norm(d))) spelled.set(norm(d), d.trim());
    }
    for (const a of attrs) {
      const m = /^\s*([a-z ]+?)\s*[:=]\s*(.*?)\s*$/i.exec(a);
      if (!m) { if (a.trim()) p.note.push(a.trim()); continue; }
      const k = m[1].toLowerCase().trim(), v = m[2];
      if (/^(tool|tools|with)$/.test(k)) p.tool = v;
      else if (/^(from|access|dir|direction|side)$/.test(k)) {
        const d = DIRS[v.toLowerCase()];
        if (d) p.from = d; else { p.from = v.toLowerCase(); problems.push(`line ${i + 1}: direction "${v}" is not top/bottom/front/back/left/right/side/inside; kept as written`); }
      } else if (/^(time|t|takes)$/.test(k)) {
        const s = seconds(v);
        if (s == null) problems.push(`line ${i + 1}: time "${v}" not understood (write 30s, 2 min)`); else p.time = s;
      } else if (/^(blocks|closes|covers)$/.test(k)) {
        for (const x of v.split(/\s*[,;]\s*/)) if (x) p.blocks.push(DIRS[x.toLowerCase()] || x.toLowerCase());
      } else if (/^(note|notes|qty|fastener|fasteners|torque)$/.test(k)) p.note.push(k === 'note' || k === 'notes' ? v : `${k} ${v}`);
      else { problems.push(`line ${i + 1}: unknown field "${m[1]}" kept as a note`); p.note.push(`${m[1]}: ${v}`); }
    }
    parts.set(key, p);
  });
  // Dependencies on parts that are not listed become base parts of their own.
  for (const p of [...parts.values()]) {
    p.deps = [...new Set(p.deps.map(norm))];
    if (p.deps.includes(p.key)) { warnings.push(`"${p.name}" goes onto itself; that dependency is ignored.`); p.deps = p.deps.filter((d) => d !== p.key); }
    for (const d of p.deps) {
      if (!parts.has(d)) {
        const name = spelled.get(d) || d;
        parts.set(d, { key: d, name, deps: [], line: 0, idx: -1, tool: '', from: '', time: null, blocks: [], note: ['not listed'], implicit: true });
        warnings.push(`"${name}" (needed by "${p.name}") is not in the list; it is added as a starting part.`);
      }
    }
  }
  return { parts, problems, warnings };
}

export function run({ text, strategy }) {
  const { parts, problems, warnings } = parse(text);
  if (!parts.size) return { warnings: ['Paste one part per line, e.g. "main pcb -> bottom case | tool: PH1 | from: top".'] };
  const all = [...parts.values()].sort((a, b) => (a.implicit === b.implicit ? a.idx - b.idx : a.implicit ? -1 : 1));
  all.forEach((p, i) => { p.order = i; });

  // Transitive "sits on" sets, for the access check.
  const below = new Map();
  const reach = (p, seen = new Set()) => {
    if (below.has(p.key)) return below.get(p.key);
    if (seen.has(p.key)) return new Set();
    seen.add(p.key);
    const s = new Set();
    for (const d of p.deps) { s.add(d); for (const x of reach(parts.get(d), seen)) s.add(x); }
    below.set(p.key, s);
    return s;
  };
  for (const p of all) reach(p);

  // Kahn's algorithm with a choice rule.
  const placed = new Set();
  const seq = [];
  let prev = null;
  while (seq.length < all.length) {
    const ready = all.filter((p) => !placed.has(p.key) && p.deps.every((d) => placed.has(d)));
    if (!ready.length) break;
    const score = (p) => {
      let s = 0;
      // A blocker waits while other parts still need its side from inside.
      if (p.blocks.some((side) => all.some((q) => q !== p && !placed.has(q.key) && q.from === side && !reach(q).has(p.key)))) s += 1000;
      if (strategy === 'group' && prev) {
        if (!(p.from && prev.from && p.from === prev.from)) s += 20;
        if (!(p.tool && prev.tool && norm(p.tool) === norm(prev.tool))) s += 10;
      }
      return s + p.order / 1000;
    };
    const pick = ready.reduce((a, b) => (score(b) < score(a) ? b : a));
    seq.push(pick); placed.add(pick.key); prev = pick;
  }
  const cyc = all.filter((p) => !placed.has(p.key));
  if (cyc.length) {
    warnings.unshift(`Circular dependency: ${cyc.map((p) => `"${p.name}"`).join(', ')} wait for each other. Break the loop (one of them must go first); they are listed last.`);
    seq.push(...cyc);
  }

  // Levels: parts on the same level do not depend on each other.
  const level = new Map();
  const lev = (p, stack = new Set()) => {
    if (level.has(p.key)) return level.get(p.key);
    if (stack.has(p.key)) return 1;
    stack.add(p.key);
    const l = 1 + Math.max(0, ...p.deps.map((d) => lev(parts.get(d), stack)));
    level.set(p.key, l);
    return l;
  };
  for (const p of all) lev(p);

  // Access conflicts: a later part needs a side closed by an earlier blocker
  // and does not sit on that blocker.
  const conflicts = [];
  seq.forEach((b, i) => {
    for (const side of b.blocks) {
      for (const q of seq.slice(i + 1)) {
        if (q.from === side && !reach(q).has(b.key)) conflicts.push({ q, b, side });
      }
    }
  });
  for (const { q, b, side } of conflicts) {
    warnings.push(`Access: "${q.name}" needs the ${side} after "${b.name}" has closed it, and nothing lets it go first. Break the chain that holds it back, or, if it mounts on the outside, add "${b.name}" to its "->" list.`);
  }

  let toolChanges = 0, turns = 0, time = 0, timed = 0;
  let lastTool = '', lastFrom = '';
  for (const p of seq) {
    if (p.tool) { if (lastTool && norm(p.tool) !== norm(lastTool)) toolChanges++; lastTool = p.tool; }
    if (p.from) { if (lastFrom && p.from !== lastFrom) turns++; lastFrom = p.from; }
    if (p.time != null) { time += p.time; timed++; }
  }
  const tools = [...new Set(seq.filter((p) => p.tool).map((p) => p.tool))];
  const depth = Math.max(...seq.map((p) => level.get(p.key)));

  const verb = (p) => (p.deps.length ? `Fit ${p.name} onto ${p.deps.map((d) => parts.get(d).name).join(' and ')}` : `Place ${p.name}`);
  const steps = seq.map((p, i) => {
    const how = [p.from && `from the ${p.from}`, p.tool && `with ${p.tool}`].filter(Boolean).join(', ');
    const extra = [...p.note.filter((n) => n !== 'not listed'), p.blocks.length ? `closes the ${p.blocks.join(', ')}` : ''].filter(Boolean).join('; ');
    return `${i + 1}. ${verb(p)}${how ? ` (${how})` : ''}.${extra ? ` ${extra[0].toUpperCase()}${extra.slice(1)}.` : ''}${p.time != null ? ` [${fmtTime(p.time)}]` : ''}`;
  });
  const id = (p) => 'p' + all.indexOf(p);
  const mermaid = ['flowchart BT', ...all.map((p) => `  ${id(p)}["${seq.indexOf(p) + 1}. ${p.name.replace(/"/g, "'")}"]`),
    ...all.flatMap((p) => p.deps.map((d) => `  ${id(p)} --> ${id(parts.get(d))}`))].join('\n') + '\n';

  if (problems.length) warnings.push(`Could not read everything: ${problems.join('; ')}.`);
  return {
    values: [
      { label: 'Steps', value: seq.length },
      { label: 'Tool changes', value: toolChanges, hint: `${tools.length} tool${tools.length === 1 ? '' : 's'}`, tone: toolChanges <= Math.max(0, tools.length - 1) ? 'ok' : 'warn' },
      { label: 'Reorientations', value: turns, hint: 'approach direction changes', tone: turns <= 1 ? 'ok' : 'warn' },
      { label: 'Levels', value: depth, hint: 'longest chain of parts' },
      { label: 'Total time', value: timed ? fmtTime(time) : '–', hint: timed ? `${timed} of ${seq.length} steps timed` : 'add | time: 30s' },
      { label: 'Access conflicts', value: conflicts.length, tone: conflicts.length ? 'bad' : 'ok' },
    ],
    warnings,
    tables: [{
      title: strategy === 'group' ? 'Order (grouped by direction and tool)' : 'Order (as listed where possible)',
      columns: ['#', 'Part', 'Onto', 'From', 'Tool', 'Level', 'Time', 'Note'],
      rows: seq.map((p, i) => [i + 1, p.name, p.deps.map((d) => parts.get(d).name).join(', ') || '–', p.from || '–', p.tool || '–',
        level.get(p.key), p.time != null ? fmtTime(p.time) : '–',
        [...p.note, p.blocks.length ? `closes ${p.blocks.join(', ')}` : ''].filter(Boolean).join('; ')]),
    }],
    texts: [
      { title: 'Steps', body: steps.join('\n') + '\n' },
      { title: 'Mermaid', body: mermaid, lang: 'mermaid' },
    ],
    notes: [
      'Line format: part -> what it goes onto (comma-separated) | tool: … | from: top/bottom/front/back/left/right | time: 30s | blocks: top | note: …',
      'Parts on the same level do not depend on each other: they can be built in parallel or as sub-assemblies.',
      'A part with "blocks: top" (a lid, a cover) is held back until every part that needs the top from inside is in.',
    ],
  };
}
