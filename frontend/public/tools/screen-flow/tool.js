// Screen Flow Mapper: "A -> B : label" lines -> a directed graph of screens.
//   Depth = fewest taps from the start screen (breadth-first search).
//   Unreachable = no path from the start; dead end = no way out (no outgoing
//   transition and no back edge - flagged unless marked as an end with "!").
//   Cycles are found with Tarjan's strongly connected components (Tarjan 1972).
//   Layout for the drawing: layers by BFS depth (Sugiyama-style layering), order in a
//   layer by the barycentre of the parents' positions (Sugiyama, Tagawa & Toda 1981).
// Exports: Mermaid flowchart, Jetpack Navigation graph XML (<navigation>, <fragment>, <action>),
// and a JSON adjacency list.

const ARROW = /\s*(<->|<-->|-->|->|=>|→|⇒|↔)\s*/;

function splitLabel(line) {
  // "A -> B : label", "A -> B [label]", "A -|label|-> B" is not supported: keep it simple.
  let label = '';
  let rest = line;
  const br = /\[([^\]]*)\]\s*$/.exec(rest);
  if (br) { label = br[1].trim(); rest = rest.slice(0, br.index); }
  else {
    const c = rest.lastIndexOf(':');
    // a colon after the last arrow is a label separator (screen names like "Step 2: Pay" keep theirs before)
    const lastArrow = Math.max(...['->', '=>', '→', '⇒', '↔'].map((a) => rest.lastIndexOf(a)));
    if (c > lastArrow && lastArrow >= 0) { label = rest.slice(c + 1).trim(); rest = rest.slice(0, c); }
  }
  return { rest, label };
}

const cleanName = (s) => s.trim().replace(/^["']|["']$/g, '').trim();
const ident = (s, lowerFirst = true) => {
  const w = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let id = w.map((x, i) => (i === 0 && lowerFirst ? x[0].toLowerCase() + x.slice(1) : x[0].toUpperCase() + x.slice(1))).join('');
  if (!id) id = 'screen';
  if (/^\d/.test(id)) id = 's' + id;
  return id;
};

export function parseFlow(text) {
  const nodes = new Map();
  const edges = [];
  const skipped = [];
  const add = (name, line) => {
    let end = false;
    name = name.trim();
    if (name.endsWith('!')) { end = true; name = name.slice(0, -1).trim(); }
    name = cleanName(name);
    if (!name) return null;
    if (!nodes.has(name)) nodes.set(name, { name, line, end: false });
    if (end) nodes.get(name).end = true;
    return name;
  };
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)(#|\/\/).*$/, '').trim();
    if (!line) return;
    const { rest, label } = splitLabel(line);
    const parts = rest.split(ARROW);
    if (parts.length === 1) { if (!add(parts[0], i + 1)) skipped.push([i + 1, raw.trim(), 'no screen name']); return; }
    if (parts.length % 2 === 0) { skipped.push([i + 1, raw.trim(), 'could not read the arrows']); return; }
    for (let k = 0; k + 2 < parts.length; k += 2) {
      const a = add(parts[k], i + 1), b = add(parts[k + 2], i + 1), op = parts[k + 1];
      if (!a || !b) { skipped.push([i + 1, raw.trim(), 'an arrow is missing a screen on one side']); continue; }
      edges.push({ from: a, to: b, label, line: i + 1 });
      if (/<|↔/.test(op)) edges.push({ from: b, to: a, label: label ? `back: ${label}` : 'back', line: i + 1 });
    }
  });
  return { nodes, edges, skipped };
}

function tarjan(names, out) {
  let idx = 0; const index = new Map(), low = new Map(), on = new Set(), st = [], comps = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of out.get(v)) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = []; let w;
      do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v);
      comps.push(c);
    }
  };
  for (const v of names) if (!index.has(v)) strong(v);
  return comps;
}

export function run({ flow, start, goal, pkg }) {
  const warnings = [], notes = [];
  const { nodes, edges, skipped } = parseFlow(flow);
  if (!nodes.size) return { warnings: ['Write one transition per line, like "Home -> Details : tap item".'] };
  const names = [...nodes.keys()];
  const out = new Map(names.map((n) => [n, []]));
  const inn = new Map(names.map((n) => [n, []]));
  const seenEdge = new Set();
  const uniqueEdges = [];
  for (const e of edges) {
    const k = `${e.from}\u0000${e.to}\u0000${e.label}`;
    if (seenEdge.has(k)) { warnings.push(`Line ${e.line}: "${e.from} -> ${e.to}" is listed twice; drawn once.`); continue; }
    seenEdge.add(k); uniqueEdges.push(e);
    if (!out.get(e.from).includes(e.to)) out.get(e.from).push(e.to);
    if (!inn.get(e.to).includes(e.from)) inn.get(e.to).push(e.from);
  }
  const want = cleanName(String(start ?? ''));
  let s = want && nodes.has(want) ? want : null;
  if (want && !s) warnings.push(`Start screen "${want}" is not in the flow; the first screen (${names[0]}) was used.`);
  if (!s) s = names[0];

  // BFS from the start: depth and parent for shortest paths
  const depth = new Map([[s, 0]]), prev = new Map();
  const queue = [s];
  while (queue.length) {
    const v = queue.shift();
    for (const w of out.get(v)) if (!depth.has(w)) { depth.set(w, depth.get(v) + 1); prev.set(w, v); queue.push(w); }
  }
  const unreachable = names.filter((n) => !depth.has(n));
  const deadEnds = names.filter((n) => depth.has(n) && !out.get(n).length && !nodes.get(n).end);
  const ends = names.filter((n) => nodes.get(n).end);
  const comps = tarjan(names, out).filter((c) => c.length > 1 || out.get(c[0]).includes(c[0]));
  const maxDepth = Math.max(...depth.values());

  // path to goal
  const g = cleanName(String(goal ?? ''));
  let path = null;
  if (g) {
    if (!nodes.has(g)) warnings.push(`Goal screen "${g}" is not in the flow: check the spelling (names are case-sensitive).`);
    else if (!depth.has(g)) warnings.push(`"${g}" cannot be reached from ${s}: add a transition into it or change the start.`);
    else { path = [g]; while (path[0] !== s) path.unshift(prev.get(path[0])); }
  }
  const onPath = new Set();
  if (path) for (let i = 0; i + 1 < path.length; i++) onPath.add(`${path[i]}\u0000${path[i + 1]}`);

  // ---- layout data (layers by depth, unreachable in a last layer) ----
  const layerOf = (n) => (depth.has(n) ? depth.get(n) : maxDepth + 1);
  const layers = [];
  for (const n of names) (layers[layerOf(n)] ||= []).push(n);
  const pos = new Map();
  layers.forEach((L, li) => {
    if (li > 0) {
      L.sort((a, b) => {
        const bc = (x) => { const ps = inn.get(x).filter((p) => pos.has(p) && layerOf(p) < li); return ps.length ? ps.reduce((t, p) => t + pos.get(p), 0) / ps.length : 1e9; };
        return bc(a) - bc(b);
      });
    }
    L.forEach((n, i) => pos.set(n, i));
  });
  const status = (n) => (n === s ? 'start' : !depth.has(n) ? 'unreachable' : nodes.get(n).end ? 'end' : !out.get(n).length ? 'dead end' : '');
  const graph = {
    start: s,
    layers: layers.map((L) => L || []),
    nodes: names.map((n) => ({ name: n, depth: depth.has(n) ? depth.get(n) : null, layer: layerOf(n), order: pos.get(n), status: status(n), out: out.get(n).length, in: inn.get(n).length })),
    edges: uniqueEdges.map((e) => ({ from: e.from, to: e.to, label: e.label, back: layerOf(e.to) <= layerOf(e.from), onPath: onPath.has(`${e.from}\u0000${e.to}`) })),
    path,
  };

  // ---- warnings ----
  if (unreachable.length) warnings.push(`${unreachable.length} screen${unreachable.length > 1 ? 's' : ''} cannot be reached from ${s}: ${unreachable.join(', ')}. Add the transition that leads there, or it is dead code.`);
  if (deadEnds.length) warnings.push(`No way out of ${deadEnds.join(', ')}: add the back/close transition, or mark a real end screen with "!" (e.g. "Pay -> Done!").`);
  for (const [line, text, why] of skipped) warnings.push(`Line ${line} skipped (${why}): ${text}`);

  // ---- exports ----
  const mid = new Map(); const used = new Set();
  for (const n of names) { let id = ident(n); let k = id, i = 2; while (used.has(k)) k = id + i++; used.add(k); mid.set(n, k); }
  const esc = (t) => t.replace(/"/g, '#quot;');
  const mermaid = ['flowchart LR',
    ...names.map((n) => (nodes.get(n).end ? `  ${mid.get(n)}(["${esc(n)}"])` : `  ${mid.get(n)}["${esc(n)}"]`)),
    ...uniqueEdges.map((e) => `  ${mid.get(e.from)} -->${e.label ? `|"${esc(e.label)}"|` : ''} ${mid.get(e.to)}`),
    `  style ${mid.get(s)} stroke-width:3px`].join('\n') + '\n';
  const p = String(pkg ?? '').trim() || 'com.example.app';
  const xmlEsc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const nav = ['<?xml version="1.0" encoding="utf-8"?>',
    '<navigation xmlns:android="http://schemas.android.com/apk/res/android"',
    '    xmlns:app="http://schemas.android.com/apk/res-auto"',
    '    android:id="@+id/nav_graph"',
    `    app:startDestination="@id/${mid.get(s)}">`,
    ...names.flatMap((n) => {
      const acts = uniqueEdges.filter((e) => e.from === n);
      const cls = ident(n, false).replace(/(Fragment|Screen)?$/, 'Fragment');
      const head = `    <fragment\n        android:id="@+id/${mid.get(n)}"\n        android:name="${p}.${cls}"\n        android:label="${xmlEsc(n)}"`;
      if (!acts.length) return [head + ' />'];
      const actIds = new Set();
      return [head + '>', ...acts.map((e) => {
        let id = `action_${mid.get(e.from)}_to_${mid.get(e.to)}`; let k = id, i = 2; while (actIds.has(k)) k = id + i++; actIds.add(k);
        return `        <action\n            android:id="@+id/${k}"\n            app:destination="@id/${mid.get(e.to)}" />${e.label ? ` <!-- ${xmlEsc(e.label).replace(/--/g, '- -')} -->` : ''}`;
      }), '    </fragment>'];
    }),
    '</navigation>', ''].join('\n');
  const json = JSON.stringify({ start: s, screens: names.map((n) => ({ name: n, id: mid.get(n), depth: depth.get(n) ?? null, to: uniqueEdges.filter((e) => e.from === n).map((e) => ({ to: e.to, label: e.label || undefined })) })) }, null, 2) + '\n';

  const values = [
    { label: 'Screens', value: names.length },
    { label: 'Transitions', value: uniqueEdges.length },
    { label: 'Start', value: s },
    { label: 'Deepest screen', value: maxDepth, unit: maxDepth === 1 ? 'step' : 'steps', hint: names.filter((n) => depth.get(n) === maxDepth).slice(0, 3).join(', ') },
    { label: 'Unreachable', value: unreachable.length, tone: unreachable.length ? 'bad' : 'ok' },
    { label: 'Dead ends', value: deadEnds.length, tone: deadEnds.length ? 'warn' : 'ok' },
    { label: 'Loops', value: comps.length, hint: comps.length ? 'screens you can cycle between' : null },
  ];
  if (path) values.push({ label: `Path to ${g}`, value: path.join(' → '), hint: `${path.length - 1} step${path.length === 2 ? '' : 's'}`, tone: 'ok' });
  const tables = [{
    title: 'Screens',
    columns: ['Screen', 'Steps from start', 'In', 'Out', 'Leads to', 'Status'],
    rows: names.map((n) => [n, depth.has(n) ? depth.get(n) : '–', inn.get(n).length, out.get(n).length, out.get(n).join(', ') || '–', status(n) || 'ok']),
  }];
  if (path) {
    tables.push({ title: `Shortest path to ${g}`, columns: ['Step', 'From', 'To', 'Action'],
      rows: path.slice(1).map((to, i) => [i + 1, path[i], to, uniqueEdges.find((e) => e.from === path[i] && e.to === to)?.label || '–']) });
  }
  if (comps.length) tables.push({ title: 'Loops (strongly connected screens)', columns: ['#', 'Screens'], rows: comps.map((c, i) => [i + 1, c.slice().reverse().join(', ')]) });
  notes.push('Syntax: "A -> B : label" (or [label]); chains "A -> B -> C"; "A <-> B" for both ways; a screen alone on a line declares it; end a name with ! to mark an intended end screen; # starts a comment.');
  notes.push('Steps are the fewest transitions from the start screen. Click a screen in the diagram to show the shortest path to it.');
  return {
    values, tables, warnings, notes, graph,
    texts: [
      { title: 'Mermaid', body: mermaid, lang: 'mermaid' },
      { title: 'nav_graph.xml', body: nav, lang: 'xml' },
      { title: 'Graph JSON', body: json, lang: 'json' },
    ],
  };
}
