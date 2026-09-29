// Layer & Release Map: the Yocto release line (codename, version, release,
// LTS, end of life) and a bblayers.conf stack checked the way BitBake checks
// it when it reads the layers.
//
// The checks follow bitbake/lib/bb (scarthgap, bitbake 2.8):
//   cookerdata.py  - LAYERSERIES_CORENAMES is taken from the first layer that
//                    sets it (openembedded-core/meta); a layer whose
//                    LAYERSERIES_COMPAT_<c> shares no name with it is fatal
//                    ("Layer X is not compatible with the core layer which only
//                    supports these series"); no LAYERSERIES_COMPAT is a
//                    warning; a BBFILE_COLLECTIONS name twice is fatal.
//                    LAYERSERIES_COMPAT_<c> is deleted after each layer, so a
//                    layer that copies ${LAYERSERIES_COMPAT_core} gets nothing.
//   cooker.py      - handleCollections(): LAYERDEPENDS_<c> must name enabled
//                    collections, "name (>= N)" is compared with LAYERVERSION_
//                    <name>; a non-integer BBFILE_PRIORITY is an error; an unset
//                    one becomes (highest priority of its dependencies) + 1;
//                    BBFILE_PATTERN_<c> unset is an error; LAYERRECOMMENDS only
//                    logs.
//   parse/parse_py/ConfHandler.py - lines ending in "\" join (after rstrip);
//                    a "#" line inside a continued value is NOT a comment, the
//                    "#" and the path stay in the value.
// Release dates: Yocto Project ref-manual "Release process" (LTS every two
// years, supported four; stable releases seven months) and
// wiki.yoctoproject.org/wiki/Releases. Data as of 2026-09.

export const AS_OF = '2026-09';

// src: 'docs' = stated in poky documentation/ref-manual/release-process.rst;
// 'wiki' = release month from wiki.yoctoproject.org/wiki/Releases;
// 'rule' = EOL estimated from the 7-month stable window (non-LTS);
// 'plan' = planned, not released as of AS_OF - verify.
export const RELEASES = [
  { name: 'zeus', ver: '3.0', rel: '2019-10', eol: '2020-08', lts: false, src: 'wiki', eolSrc: 'wiki' },
  { name: 'dunfell', ver: '3.1', rel: '2020-04', eol: '2024-04', lts: true, src: 'docs', eolSrc: 'docs', note: 'first LTS; two years at first, extended to four' },
  { name: 'gatesgarth', ver: '3.2', rel: '2020-10', eol: '2021-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'hardknott', ver: '3.3', rel: '2021-04', eol: '2022-04', lts: false, src: 'wiki', eolSrc: 'wiki', note: 'kept a year, longer than the usual 7 months' },
  { name: 'honister', ver: '3.4', rel: '2021-10', eol: '2022-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'kirkstone', ver: '4.0', rel: '2022-05', eol: '2026-05', lts: true, src: 'docs', eolSrc: 'docs', note: 'the docs say supported until May 2026; point releases (4.0.3x) kept coming into 2026 - check the wiki for any extension' },
  { name: 'langdale', ver: '4.1', rel: '2022-10', eol: '2023-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'mickledore', ver: '4.2', rel: '2023-05', eol: '2023-11', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'nanbield', ver: '4.3', rel: '2023-11', eol: '2024-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'scarthgap', ver: '5.0', rel: '2024-04', eol: '2028-04', lts: true, src: 'docs', eolSrc: 'docs' },
  { name: 'styhead', ver: '5.1', rel: '2024-10', eol: '2025-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'walnascar', ver: '5.2', rel: '2025-04', eol: '2025-11', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'whinlatter', ver: '5.3', rel: '2025-10', eol: '2026-05', lts: false, src: 'wiki', eolSrc: 'rule' },
  { name: 'wrynose', ver: '6.0', rel: '2026-04', eol: '2030-04', lts: true, src: 'plan', eolSrc: 'rule', note: 'LTS by the two-year cadence; name, date and EOL not checked against a released branch here - verify' },
  { name: '6.1 (TBC)', ver: '6.1', rel: '2026-10', eol: '2027-05', lts: false, src: 'plan', eolSrc: 'rule', note: 'next stable, planned; codename not confirmed here' },
];
// Older names still seen in LAYERSERIES_COMPAT lines, so they read as releases.
const OLDER = ['sumo', 'thud', 'warrior', 'rocko', 'pyro', 'morty'];

const mon = (s) => { const m = /^(\d{4})-(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : 0; };
const status = (r) => (mon(r.rel) > mon(AS_OF) ? 'planned' : mon(r.eol) < mon(AS_OF) ? 'eol' : 'supported');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monText = (s) => { const m = /^(\d{4})-(\d{2})$/.exec(s || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s; };

// ---------------- conf parsing (ConfHandler rules) ----------------
/** Logical lines: "\" continuations joined; each with its first line number. */
function logicalLines(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    let s = src[i];
    if (!s.trim()) continue;
    const start = i + 1;
    s = s.replace(/\s+$/, '');
    const inner = [];
    let confusing = false;
    while (s.endsWith('\\') && i + 1 < src.length) {
      const next = src[++i].replace(/\s+$/, '');
      if (s.trimStart().startsWith('#') && !(next.trimStart().startsWith('#')) && next) confusing = true;
      if (next.trimStart().startsWith('#') && !s.trimStart().startsWith('#')) inner.push({ line: i + 1, text: next.trim() });
      s = s.slice(0, -1) + next;
    }
    out.push({ line: start, text: s, commentsInside: inner, confusing });
  }
  return out;
}

const ASSIGN = /^\s*(?:export\s+)?([A-Za-z0-9_\-.${}/+]+?)((?::(?:append|prepend|remove))?)\s*(\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=)\s*(["'])([\s\S]*)\4\s*$/;

/** Assignments of one conf file: [{name, suffix, op, value, line, commentsInside}]. */
function assignments(text) {
  const list = [], unread = [];
  for (const l of logicalLines(text)) {
    const t = l.text.trim();
    if (t.startsWith('#')) {
      if (l.confusing) unread.push({ line: l.line, text: 'a comment line ending in "\\" runs into a line that is not a comment - BitBake stops with "confusing multiline, partially commented expression"' });
      continue;
    }
    const m = ASSIGN.exec(l.text);
    if (!m) {
      if (!/^\s*(include|require|inherit|addpylib|export|unset)\b/.test(t)) unread.push({ line: l.line, text: t.slice(0, 80) });
      continue;
    }
    list.push({ name: m[1], suffix: m[2].replace(':', ''), op: m[3], value: m[5], line: l.line, commentsInside: l.commentsInside });
  }
  return { list, unread };
}

/** Simple variable store with ${VAR} expansion (inline python ${@...} is kept as is). */
function store(list, seed = {}) {
  const vars = { ...seed };
  for (const a of list) {
    if (a.suffix === 'remove') continue;
    const cur = vars[a.name];
    const v = a.value;
    if (a.suffix === 'append' || a.op === '.=') vars[a.name] = (cur || '') + v;
    else if (a.suffix === 'prepend' || a.op === '=.') vars[a.name] = v + (cur || '');
    else if (a.op === '+=') vars[a.name] = cur ? `${cur} ${v}` : v;
    else if (a.op === '=+') vars[a.name] = cur ? `${v} ${cur}` : v;
    else if (a.op === '?=' || a.op === '??=') { if (cur == null) vars[a.name] = v; }
    else vars[a.name] = v;
  }
  return vars;
}
function expand(value, vars, depth = 0) {
  if (depth > 8) return value;
  return String(value).replace(/\$\{([A-Za-z0-9_\-]+)\}/g, (all, k) => (vars[k] != null ? expand(vars[k], vars, depth + 1) : all));
}
const dropPython = (v) => String(v).replace(/\$\{@[^}]*\}/g, ' ');

// ---------------- versions ----------------
function vercmp(a, b) {
  const pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}
const OPS = { '>=': (c) => c >= 0, '>': (c) => c > 0, '=': (c) => c === 0, '==': (c) => c === 0, '<=': (c) => c <= 0, '<': (c) => c < 0 };

/** "core (>= 12) openembedded-layer" -> [{name, ops:['>= 12']}] (bb.utils.explode_dep_versions2). */
function explodeDeps(s) {
  const out = [];
  if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) return s.replace(/\(.*$/, '').split(/\s+/).filter(Boolean).map((name) => ({ name, ops: [] }));
  const re = /([^\s()]+)(?:\s*\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(s))) out.push({ name: m[1], ops: m[2] ? [m[2].trim()] : [] });
  return out;
}

// ---------------- layer.conf blocks ----------------
const HEAD = /^\s*(?:==>\s*(.+?)\s*<==|#+\s*(?:file|layer|path)\s*:\s*(\S+))\s*$/i;
function splitBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  lines.forEach((ln, i) => {
    const m = HEAD.exec(ln);
    if (m) { cur = { path: (m[1] || m[2]).trim(), start: i, end: i, lines: [] }; blocks.push(cur); return; }
    if (!cur) { if (!ln.trim()) return; cur = { path: '', start: i, end: i, lines: [] }; blocks.push(cur); }
    cur.lines.push(ln); cur.end = i;
  });
  return blocks.map((b) => ({ ...b, text: b.lines.join('\n'), dir: b.path.replace(/\/+$/, '').replace(/\/conf\/layer\.conf$/, '').replace(/\/layer\.conf$/, '') }));
}
const parts = (p) => String(p).split('/').filter((x) => x && x !== '.');
/** How many trailing path components two paths share. */
function tailMatch(a, b) {
  const x = parts(a), y = parts(b);
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}
export function shortName(p) {
  const x = parts(p);
  if (!x.length) return p || '?';
  const last = x[x.length - 1];
  return last === 'meta' && x.length > 1 ? `${x[x.length - 2]}/meta` : last;
}

function parseLayerConf(text) {
  const { list, unread } = assignments(text);
  const vars = store(list);
  const colls = dropPython(vars.BBFILE_COLLECTIONS || '').split(/\s+/).filter(Boolean);
  const lineOf = (name) => { const a = [...list].reverse().find((x) => x.name === name); return a ? a.line : 0; };
  const copiesCompat = (c) => /\$\{LAYERSERIES_COMPAT_/.test(vars[`LAYERSERIES_COMPAT_${c}`] || '');
  return {
    unread,
    corenames: vars.LAYERSERIES_CORENAMES != null ? dropPython(vars.LAYERSERIES_CORENAMES).split(/\s+/).filter(Boolean) : null,
    collections: colls.map((c) => {
      const compatRaw = vars[`LAYERSERIES_COMPAT_${c}`];
      return {
        name: c,
        priorityRaw: vars[`BBFILE_PRIORITY_${c}`] != null ? String(expand(vars[`BBFILE_PRIORITY_${c}`], vars)).trim() : null,
        priorityLine: lineOf(`BBFILE_PRIORITY_${c}`),
        pattern: vars[`BBFILE_PATTERN_${c}`] != null,
        depends: explodeDeps(dropPython(expand(vars[`LAYERDEPENDS_${c}`] || '', vars))),
        dependsPython: /\$\{@/.test(vars[`LAYERDEPENDS_${c}`] || ''),
        dependsBad: (() => { const t = dropPython(vars[`LAYERDEPENDS_${c}`] || ''); return (t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length; })(),
        recommends: explodeDeps(dropPython(expand(vars[`LAYERRECOMMENDS_${c}`] || '', vars))),
        compat: compatRaw == null || copiesCompat(c) ? null : dropPython(compatRaw).split(/\s+/).filter(Boolean),
        copiesCompat: copiesCompat(c),
        version: vars[`LAYERVERSION_${c}`] != null ? String(vars[`LAYERVERSION_${c}`]).trim() : null,
      };
    }),
  };
}

// ---------------- bblayers.conf ----------------
function parseBblayers(text) {
  const { list, unread } = assignments(text);
  const issues = [];
  const vars = store(list, { TOPDIR: '${TOPDIR}' });
  const raw = vars.BBLAYERS;
  if (raw == null) return { paths: [], issues: [{ level: 'error', text: 'No BBLAYERS assignment found in bblayers.conf.' }], unread, vars };
  // Keep ${TOPDIR} and friends readable: expand only variables set in the file.
  const own = { ...vars }; delete own.TOPDIR;
  const words = expand(raw, own).split(/\s+/).filter(Boolean);
  const paths = [];
  let hashNext = false;
  for (const w of words) {
    if (w === '\\') continue;
    if (w.startsWith('#')) {
      const p = w.slice(1);
      hashNext = !p;
      if (p) { paths.push({ path: p, hashed: true }); }
      continue;
    }
    paths.push({ path: w.replace(/\/+$/, ''), hashed: hashNext });
    hashNext = false;
  }
  const hashedLines = list.filter((a) => a.commentsInside.length).flatMap((a) => a.commentsInside.map((c) => c.line));
  if (paths.some((p) => p.hashed)) {
    issues.push({ level: 'error', text: `A "#" line inside the continued BBLAYERS value (line ${hashedLines.join(', ') || '?'}) is not a comment: BitBake keeps "#" as a word, then stops with "The following layer directories do not exist: #". Delete the line or move it out of the quoted value.` });
  }
  return { paths, issues, unread, vars };
}

// ---------------- run ----------------
export function run(input) {
  const warnings = [], notes = [];
  const off = new Set(String(input.off || '').split(/[\s,]+/).filter(Boolean));
  const bb = parseBblayers(input.bblayers);
  const blocks = splitBlocks(input.layerconfs);
  for (const u of bb.unread) notes.push(`bblayers.conf line ${u.line} not read: ${u.text}`);

  // Match each BBLAYERS path to the pasted layer.conf with the longest shared tail.
  const used = new Set();
  const seenPath = new Set();
  const uniq = bb.paths.filter((p) => { if (seenPath.has(p.path)) { warnings.push(`${p.path} is listed twice in BBLAYERS; BitBake reads its layer.conf twice and stops on the duplicated BBFILE_COLLECTIONS. Remove one line.`); return false; } seenPath.add(p.path); return true; });
  const layers = uniq.map((p, i) => {
    let best = -1, bestN = 0;
    blocks.forEach((b, j) => {
      if (!b.path) return;
      const n = tailMatch(p.path, b.dir);
      if (n > bestN || (n === bestN && n > 0 && used.has(best) && !used.has(j))) { best = j; bestN = n; }
    });
    // A single unnamed block when there is one layer.
    if (best < 0 && blocks.length === 1 && !blocks[0].path && bb.paths.length === 1) best = 0;
    if (best >= 0) used.add(best);
    const name = shortName(p.path);
    return { index: i, path: p.path, name, hashed: p.hashed, excluded: off.has(name) || off.has(p.path), block: best, conf: best >= 0 ? parseLayerConf(blocks[best].text) : null };
  });
  const unmatched = blocks.map((b, j) => ({ b, j })).filter(({ j }) => !used.has(j));

  // Core series: the first enabled layer that sets LAYERSERIES_CORENAMES.
  const active = layers.filter((l) => !l.excluded);
  const coreLayer = active.find((l) => l.conf && l.conf.corenames && l.conf.corenames.length);
  const coreSeries = coreLayer ? coreLayer.conf.corenames : [];
  const knownName = (n) => RELEASES.some((r) => r.name === n) || OLDER.includes(n);
  const targetName = input.target && input.target !== 'auto' ? input.target : (coreSeries[0] || 'scarthgap');
  const target = RELEASES.find((r) => r.name === targetName) || RELEASES.find((r) => r.name === 'scarthgap');
  const explicit = input.target && input.target !== 'auto';

  // Collections of enabled layers.
  const nodes = [];
  for (const l of layers) {
    const colls = l.conf ? l.conf.collections : [];
    if (!colls.length) nodes.push({ layer: l, coll: null });
    for (const c of colls) nodes.push({ layer: l, coll: c });
  }
  const enabled = nodes.filter((n) => !n.layer.excluded && n.coll);
  const byColl = new Map();
  for (const n of enabled) byColl.set(n.coll.name, [...(byColl.get(n.coll.name) || []), n]);

  // Priorities: explicit, or (highest of its dependencies) + 1 (cooker.calc_layer_priority).
  const prio = new Map();
  let minPrio = 0;
  for (const n of enabled) {
    const v = n.coll.priorityRaw;
    if (v != null && v !== '' && /^-?\d+$/.test(v)) { prio.set(n.coll.name, Number(v)); if (!minPrio || Number(v) < minPrio) minPrio = Number(v); }
  }
  const calc = (name, seen = new Set()) => {
    if (prio.has(name)) return prio.get(name);
    if (seen.has(name)) return minPrio;
    seen.add(name);
    const n = (byColl.get(name) || [])[0];
    if (!n) return minPrio;
    let mx = minPrio;
    for (const d of n.coll.depends) if (byColl.has(d.name)) mx = Math.max(mx, calc(d.name, seen));
    prio.set(name, mx + 1);
    return mx + 1;
  };
  for (const n of enabled) calc(n.coll.name);

  // ---------- findings per node ----------
  const missing = new Map(); // name -> [who]
  const usedIds = new Set();
  const items = nodes.map((n) => {
    const l = n.layer, c = n.coll;
    const issues = [];
    const add = (level, text) => issues.push({ level, text });
    let id = c ? c.name : l.path;
    if (usedIds.has(id)) id = `${id}@${l.path}`;
    usedIds.add(id);
    const item = {
      id, path: l.path, name: l.name, collection: c ? c.name : null, block: l.block, excluded: l.excluded, hashed: l.hashed,
      priority: c && prio.has(c.name) ? prio.get(c.name) : null, prioritySet: !!(c && c.priorityRaw != null && /^-?\d+$/.test(c.priorityRaw)),
      compat: c && c.compat ? c.compat : [], version: c ? c.version : null, deps: [], recs: [], issues, provided: !!c,
      readyTarget: null, readyCore: null,
    };
    if (l.excluded) { add('info', 'excluded (what-if): left out of BBLAYERS'); return item; }
    if (l.hashed) add('warn', `the "#" in front of ${l.path} is inside the quoted BBLAYERS value, so the layer is still included (and "#" becomes a bogus layer path)`);
    if (!c) {
      if (l.conf && !l.conf.collections.length) add('error', 'the pasted layer.conf sets no BBFILE_COLLECTIONS, so BitBake treats it as no layer at all');
      else add('info', 'no layer.conf pasted for this path - not checked');
      return item;
    }
    if ((byColl.get(c.name) || []).length > 1) add('error', `BBFILE_COLLECTIONS "${c.name}" is also set by ${byColl.get(c.name).filter((x) => x !== n).map((x) => x.layer.name).join(', ')}: BitBake stops with "Found duplicated BBFILE_COLLECTIONS". Two copies of one layer are in BBLAYERS, or one layer.conf was copied without renaming.`);
    if (c.priorityRaw != null && !/^-?\d+$/.test(c.priorityRaw)) add('error', `BBFILE_PRIORITY_${c.name} = "${c.priorityRaw}" is not an integer: BitBake reports "invalid value for BBFILE_PRIORITY".`);
    else if (c.priorityRaw == null) add('info', `no BBFILE_PRIORITY_${c.name}: BitBake computes ${item.priority} (highest dependency + 1)`);
    if (!c.pattern) add('error', `BBFILE_PATTERN_${c.name} is not set: BitBake reports "BBFILE_PATTERN_${c.name} not defined". Add BBFILE_PATTERN_${c.name} = "^\${LAYERDIR}/".`);
    // Series.
    if (c.copiesCompat) add('error', `LAYERSERIES_COMPAT_${c.name} copies another layer's value; BitBake deletes each layer's LAYERSERIES_COMPAT right after reading it, so the reference stays unexpanded and BitBake stops with "Layer ${c.name} is not compatible with the core layer". Write the release names out, e.g. "${coreSeries[0] || target.name}".`);
    else if (!c.compat || !c.compat.length) add('warn', `no LAYERSERIES_COMPAT_${c.name}: BitBake warns "should set LAYERSERIES_COMPAT_${c.name}". Add LAYERSERIES_COMPAT_${c.name} = "${coreSeries.join(' ') || target.name}" once it is tested there.`);
    else {
      const unknown = c.compat.filter((x) => !knownName(x) && !/\$\{/.test(x));
      if (unknown.length) add('info', `LAYERSERIES_COMPAT names not in the release list: ${unknown.join(', ')}`);
      if (coreSeries.length) {
        item.readyCore = c.compat.some((x) => coreSeries.includes(x));
        if (!item.readyCore) add('error', `LAYERSERIES_COMPAT_${c.name} = "${c.compat.join(' ')}" has no "${coreSeries.join(' ')}": BitBake stops with "Layer ${c.name} is not compatible with the core layer which only supports these series: ${coreSeries.join(' ')}". Use the layer's ${coreSeries[0]} branch, or port it and add ${coreSeries[0]}.`);
      }
      item.readyTarget = c.compat.includes(target.name);
      if (explicit && !coreSeries.includes(target.name) && !item.readyTarget) add('migrate', `not declared for ${target.name} yet (declares ${c.compat.join(' ')}): check for a ${target.name} branch before moving`);
    }
    // Dependencies.
    if (c.dependsBad) add('error', `LAYERDEPENDS_${c.name} has unbalanced parentheses: BitBake stops with "Error parsing LAYERDEPENDS_${c.name}". Write it like "core (>= 12) openembedded-layer".`);
    for (const d of c.depends) {
      const dep = { name: d.name, ops: d.ops, state: 'ok', text: '' };
      const there = byColl.get(d.name);
      if (!there) {
        dep.state = 'missing';
        const inList = nodes.find((x) => x.coll && x.coll.name === d.name);
        dep.text = inList && inList.layer.excluded ? `excluded ${inList.layer.name}` : 'not in BBLAYERS';
        add('error', `LAYERDEPENDS_${c.name} names "${d.name}", which is not enabled: BitBake reports "Layer '${c.name}' depends on layer '${d.name}', but this layer is not enabled in your configuration". ${inList ? `It is ${inList.layer.name}${inList.layer.excluded ? ' (excluded above)' : ''}.` : `Add the layer that sets BBFILE_COLLECTIONS += "${d.name}" to BBLAYERS.`}`);
        missing.set(d.name, [...(missing.get(d.name) || []), id]);
      } else {
        for (const op of d.ops) {
          const m = /^(>=|<=|==|=|>|<)\s*(\S+)$/.exec(op);
          const ver = there[0].coll.version;
          if (!m) { dep.state = 'bad'; dep.text = `cannot read "${op}"`; add('error', `LAYERDEPENDS_${c.name}: "(${op})" is not a version condition BitBake can parse.`); continue; }
          if (ver == null) { dep.state = 'bad'; dep.text = `needs ${op}, no LAYERVERSION`; add('error', `needs ${d.name} ${op} but ${d.name} sets no LAYERVERSION_${d.name}: BitBake reports it as an error. Use matching branches of both layers.`); continue; }
          if (!OPS[m[1]](vercmp(ver, m[2]))) { dep.state = 'bad'; dep.text = `needs ${op}, has ${ver}`; add('error', `needs ${d.name} ${op}, but LAYERVERSION_${d.name} is ${ver}: the two layers are from different releases. Check out matching branches.`); } else dep.text = `${op} (has ${ver})`;
        }
      }
      item.deps.push(dep);
    }
    if (c.dependsPython) add('info', `LAYERDEPENDS_${c.name} has inline python (\${@...}); only its literal names are checked`);
    for (const r of c.recommends) {
      const ok = byColl.has(r.name);
      item.recs.push({ name: r.name, state: ok ? 'ok' : 'absent' });
      if (!ok) add('info', `recommends ${r.name} (not enabled; BitBake only logs this)`);
    }
    return item;
  });

  // Priority ties among enabled collections.
  const byPrio = new Map();
  for (const it of items) if (!it.excluded && it.collection && it.priority != null) byPrio.set(it.priority, [...(byPrio.get(it.priority) || []), it.id]);
  const ties = [...byPrio.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[0] - a[0]).map(([p, v]) => ({ priority: p, ids: v }));

  // Stack order: priority high to low, then BBLAYERS order.
  const order = [...items].sort((a, b) => (a.excluded - b.excluded) || ((b.priority ?? -1e9) - (a.priority ?? -1e9)) || (layers.indexOf(layers.find((l) => l.path === a.path)) - layers.indexOf(layers.find((l) => l.path === b.path))));

  // ---------- global findings ----------
  for (const i of bb.issues) (i.level === 'error' ? warnings : notes).push(i.text);
  if (!bb.paths.length && bb.vars.BBLAYERS != null) warnings.push('BBLAYERS is empty.');
  if (!coreLayer) {
    const coreNode = enabled.find((n) => n.coll.name === 'core');
    if (coreNode) warnings.push(enabled.some((n) => n.coll.compat && n.coll.compat.length)
      ? 'The core layer.conf sets no LAYERSERIES_CORENAMES, so BitBake stops with "No core layer found to work with layer ...". Use openembedded-core/meta from a release branch.'
      : `The core layer.conf sets no LAYERSERIES_CORENAMES, so there is no series to check against; this page uses the target ${target.name}.`);
    else if (enabled.length) warnings.push(`No enabled layer sets LAYERSERIES_CORENAMES (openembedded-core/meta or poky/meta), so the series check uses the target ${target.name}. ${nodes.some((n) => /(^|\/)meta$/.test(n.layer.path) && !n.coll) ? 'Paste meta/conf/layer.conf too.' : 'Add openembedded-core/meta (or poky/meta) to BBLAYERS.'}`);
  }
  if (coreSeries.length && explicit && !coreSeries.includes(target.name)) {
    const ready = items.filter((i) => !i.excluded && i.readyTarget).length, total = items.filter((i) => !i.excluded && i.collection).length;
    notes.push(`Target ${target.name} (${target.ver}) differs from the core's series ${coreSeries.join(' ')}: ${ready} of ${total} layers already declare ${target.name}. Moving means every layer's ${target.name} branch, core included.`);
  }
  const st = status(target);
  if (st === 'eol') warnings.push(`${target.name} (${target.ver}) is past its end of life (${monText(target.eol)}${target.eolSrc === 'rule' ? ', estimated' : ''}): no more security fixes from the Yocto Project. Plan a move to ${RELEASES.filter((r) => r.lts && status(r) === 'supported').map((r) => `${r.name} ${r.ver}`).join(' or ') || 'a supported LTS'}.`);
  else if (st === 'planned') notes.push(`${target.name} (${target.ver}) is planned for ${monText(target.rel)}, not released as of ${monText(AS_OF)}: layers will not declare it yet.`);
  else if (!target.lts) notes.push(`${target.name} is a stable (non-LTS) release: about seven months of fixes, until ${monText(target.eol)}${target.eolSrc === 'rule' ? ' (estimated)' : ''}.`);
  const errs = items.flatMap((i) => i.issues.filter((x) => x.level === 'error').map((x) => `${i.collection || i.name}: ${x.text}`));
  const wrns = items.flatMap((i) => i.issues.filter((x) => x.level === 'warn').map((x) => `${i.collection || i.name}: ${x.text}`));
  warnings.push(...errs, ...wrns);
  const notReady = items.filter((i) => i.issues.some((x) => x.level === 'migrate'));
  if (notReady.length) warnings.push(`Not declared for ${target.name} yet: ${notReady.map((i) => i.collection).join(', ')}. Before moving, check each layer for a ${target.name} branch (git ls-remote --heads <layer repo> ${target.name}); a layer with none has to be ported or replaced.`);
  for (const t of ties) notes.push(`Priority ${t.priority} is shared by ${t.ids.join(', ')}: if two of them carry the same recipe, the higher version wins, not the layer. Give the one meant to override a higher BBFILE_PRIORITY.`);
  for (const { b } of unmatched) notes.push(`Pasted layer.conf ${b.path || '(no header)'} matches no BBLAYERS path${b.path ? '' : ' - start each file with a line "==> path/conf/layer.conf <==" (what tail -n +1 */conf/layer.conf prints)'}.`);
  for (const l of layers) for (const u of (l.conf ? l.conf.unread : [])) notes.push(`${l.name} layer.conf line ${u.line} not read: ${u.text}`);

  // ---------- release list with how many layers declare each ----------
  const decl = items.filter((i) => !i.excluded && i.compat.length);
  const releases = RELEASES.map((r) => ({ ...r, status: status(r), declared: decl.filter((i) => i.compat.includes(r.name)).length }));

  const nErr = errs.length + bb.issues.filter((i) => i.level === 'error').length;
  const values = [
    { label: 'Target release', value: `${target.name} ${target.ver}`, hint: `${target.lts ? 'LTS, ' : ''}${st === 'eol' ? 'end of life' : st}${explicit ? '' : ' (from core)'}`, tone: st === 'eol' ? 'bad' : st === 'planned' ? 'warn' : 'ok' },
    { label: 'Core series', value: coreSeries.join(' ') || '–', hint: coreLayer ? coreLayer.name : 'no core layer.conf' },
    { label: 'Support ends', value: monText(target.eol), hint: `${target.eolSrc === 'rule' ? 'estimated, ' : ''}as of ${monText(AS_OF)}`, tone: st === 'eol' ? 'bad' : undefined },
    { label: 'Layers', value: items.filter((i) => !i.excluded).length, hint: `${items.filter((i) => i.provided && !i.excluded).length} with layer.conf${off.size ? `, ${items.filter((i) => i.excluded).length} excluded` : ''}` },
    { label: `Declare ${target.name}`, value: `${items.filter((i) => !i.excluded && i.readyTarget).length}/${items.filter((i) => !i.excluded && i.collection).length}`, tone: items.some((i) => !i.excluded && i.collection && !i.readyTarget) ? 'warn' : 'ok' },
    { label: 'BitBake errors', value: nErr, tone: nErr ? 'bad' : 'ok', hint: nErr ? 'would stop parsing' : 'none found' },
  ];

  const statusOf = (i) => (i.excluded ? 'excluded' : i.issues.some((x) => x.level === 'error') ? 'error' : i.issues.some((x) => x.level === 'warn') ? 'warn' : !i.provided ? 'unchecked' : i.issues.some((x) => x.level === 'migrate') ? 'not ready' : 'ok');
  const tables = [
    { title: 'Layer stack (priority high to low)', columns: ['Layer', 'Collection', 'Priority', 'Declares', `Has ${target.name}`, 'Depends', 'Status'],
      rows: order.map((i) => [i.name, i.collection || '–', i.priority == null ? '–' : `${i.priority}${i.prioritySet ? '' : ' (computed)'}`, i.compat.join(' ') || '–',
        i.provided ? (i.readyTarget ? 'yes' : 'no') : '–', i.deps.map((d) => `${d.name}${d.state === 'ok' ? '' : ` [${d.state}]`}`).join(' ') || '–', statusOf(i)]) },
    { title: `Yocto releases (as of ${monText(AS_OF)})`, columns: ['Codename', 'Version', 'Released', 'LTS', 'Support ends', 'Status'],
      rows: releases.map((r) => [r.name, r.ver, monText(r.rel), r.lts ? 'LTS' : '', `${monText(r.eol)}${r.eolSrc === 'rule' ? ' (est.)' : ''}`, r.status + (r.src === 'plan' ? ' - verify' : '')]) },
  ];

  const kept = layers.filter((l) => !l.excluded);
  const bbtext = ['BBLAYERS ?= " \\', ...kept.filter((l, i) => kept.findIndex((x) => x.path === l.path) === i).map((l) => `  ${l.path} \\`), '"'].join('\n');
  const report = [
    `Target ${target.name} ${target.ver}${target.lts ? ' LTS' : ''}, support until ${monText(target.eol)}${target.eolSrc === 'rule' ? ' (est.)' : ''}; core series ${coreSeries.join(' ') || 'unknown'}.`,
    '',
    ...order.map((i) => `${String(i.priority ?? '-').padStart(3)}  ${(i.collection || '-').padEnd(26)} ${i.name.padEnd(28)} ${statusOf(i)}${i.issues.filter((x) => x.level !== 'info').map((x) => `\n       ${x.level}: ${x.text}`).join('')}`),
  ].join('\n');

  notes.push(`Release data as of ${monText(AS_OF)}; estimated end dates use the 7-month stable window. Verify at wiki.yoctoproject.org/wiki/Releases.`);

  return {
    values, tables,
    texts: [{ title: 'bblayers.conf', body: bbtext + '\n', lang: 'conf' }, { title: 'Report', body: report + '\n' }],
    warnings, notes,
    map: {
      asOf: AS_OF, target: target.name, explicit, coreSeries, releases,
      stack: order.map((i) => ({ ...i, status: statusOf(i) })),
      missing: [...missing.entries()].map(([name, by]) => ({ name, by })),
      ties, blocks: blocks.map((b) => ({ path: b.path, start: b.start, end: b.end })),
      errors: nErr,
    },
  };
}
