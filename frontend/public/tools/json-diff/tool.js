// JSON diff: two JSON documents compared two ways -
//   by field: a recursive walk that reports every added, removed and changed
//     value with its path (arrays by index, by a key field, or as unordered
//     sets), plus the RFC 6902 JSON Patch that turns A into B;
//   by line: both pretty-printed (keys optionally sorted) and compared with
//     Myers' O(ND) difference algorithm (E. Myers, "An O(ND) Difference
//     Algorithm and Its Variations", Algorithmica 1986), shown as a unified
//     diff with 3 lines of context (GNU diffutils format).

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const jsPath = (steps) => (steps.length ? steps.map((s) => (typeof s === 'object' ? `[${s.k}]` : typeof s === 'number' ? `[${s}]` : isIdent(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('').replace(/^\./, '') : '(root)');
const ptr = (steps) => steps.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
const short = (v, n = 60) => { if (v === undefined) return '–'; const s = JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const canon = (v) => JSON.stringify(sortKeys(v));

// Where JSON.parse failed (RFC 8259 grammar), with a reason in plain words.
function locate(src) {
  let i = 0;
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i])) i++; };
  const fail = (msg) => { throw { pos: i, msg }; };
  const str = () => { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; else if (src[i] < ' ') fail('a raw line break inside a string'); i++; } if (src[i] !== '"') fail('a string is not closed'); i++; };
  const val = () => {
    ws(); const c = src[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'; i++; ws();
      if (src[i] === close) { i++; return; }
      for (;;) {
        ws();
        if (src[i] === close) fail(`trailing comma before ${close}`);
        if (c === '{') { if (src[i] !== '"') fail(src[i] === "'" ? 'single quotes: JSON needs double quotes' : 'expected a "quoted" key'); str(); ws(); if (src[i] !== ':') fail('expected : after the key'); i++; }
        val(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === close) { i++; return; }
        fail(`expected , or ${close}`);
      }
    }
    if (c === '"') return str();
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i, i + 400));
    if (m && m[0]) { i += m[0].length; return; }
    for (const w of ['true', 'false', 'null']) if (src.startsWith(w, i)) { i += w.length; return; }
    fail(c === undefined ? 'the text ends before a bracket is closed' : c === "'" ? 'single quotes: JSON needs double quotes' : c === '/' ? 'comments are not allowed in JSON' : `unexpected "${c}"`);
  };
  try { val(); ws(); if (i < src.length) fail('more text after the JSON value'); } catch (e) { return e; }
  return null;
}
function parse(text, name) {
  try { return { v: JSON.parse(text) }; } catch (e) {
    const loc = locate(text);
    if (!loc) return { err: `${name} is not valid JSON: ${e.message}` };
    const before = text.slice(0, loc.pos);
    return { err: `${name} is not valid JSON at line ${before.split('\n').length}, column ${loc.pos - before.lastIndexOf('\n')}: ${loc.msg} (near "${text.slice(Math.max(0, loc.pos - 15), loc.pos + 15).replace(/\s+/g, ' ')}").` };
  }
}

/** Myers' greedy O(ND) diff on two line arrays -> [{op: ' '|'-'|'+', line}] */
function myers(a, b, maxD = 4000) {
  const N = a.length, M = b.length, max = N + M, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  // backtrack
  const out = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d], k = x - y;
    const pk = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + pk], py = px - pk;
    while (x > px && y > py) { out.push({ op: ' ', a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) { if (x === px) out.push({ op: '+', b: y - 1 }); else out.push({ op: '-', a: x - 1 }); }
    x = px; y = py;
  }
  return out.reverse();
}

function unified(ops, A, B, ctx = 3) {
  const lines = [];
  const idx = ops.map((o, i) => (o.op !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return '';
  let i = 0;
  while (i < idx.length) {
    let start = Math.max(0, idx[i] - ctx), end = Math.min(ops.length - 1, idx[i] + ctx);
    while (i + 1 < idx.length && idx[i + 1] - ctx <= end + 1) { i++; end = Math.min(ops.length - 1, idx[i] + ctx); }
    const hunk = ops.slice(start, end + 1);
    // line numbers for the header
    let a0 = null, b0 = null, na = 0, nb = 0;
    for (const o of hunk) {
      if (o.op !== '+') { if (a0 == null) a0 = o.a; na++; }
      if (o.op !== '-') { if (b0 == null) b0 = o.b; nb++; }
    }
    if (a0 == null) { const prev = ops.slice(0, start).reverse().find((o) => o.op !== '+'); a0 = prev ? prev.a + 1 : 0; }
    if (b0 == null) { const prev = ops.slice(0, start).reverse().find((o) => o.op !== '-'); b0 = prev ? prev.b + 1 : 0; }
    lines.push(`@@ -${na ? a0 + 1 : a0},${na} +${nb ? b0 + 1 : b0},${nb} @@`);
    for (const o of hunk) lines.push(o.op + (o.op === '+' ? B[o.b] : A[o.a]));
    i++;
  }
  return lines.join('\n');
}

export function run({ a, b, arrays, key, tolerance, ignore, sort }) {
  const warnings = [];
  const ta = String(a ?? '').trim(), tb = String(b ?? '').trim();
  if (!ta || !tb) return { warnings: ['Paste both documents: A (before / expected) and B (after / actual).'] };
  const pa = parse(ta, 'A'), pb = parse(tb, 'B');
  if (pa.err || pb.err) return { warnings: [pa.err, pb.err].filter(Boolean) };
  const tol = Math.abs(tolerance || 0);
  const ign = new Set(String(ignore || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
  const idKey = String(key || '').trim();
  const mode = ['index', 'key', 'unordered'].includes(arrays) ? arrays : 'index';
  if (mode === 'key' && !idKey) warnings.push('Arrays by key needs the key field name (e.g. id); comparing by index instead.');

  const rows = [];   // [path, change, A, B]
  const patch = [];  // RFC 6902 ops
  let patchable = true;
  const strip = (v) => {
    if (!ign.size) return v;
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !ign.has(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  const A = strip(pa.v), B = strip(pb.v);

  const cmp = (x, y, steps) => {
    const tx = typeOf(x), ty = typeOf(y);
    if (tx !== ty) {
      rows.push([jsPath(steps), 'type changed', `${tx} ${short(x)}`, `${ty} ${short(y)}`]);
      patch.push({ op: 'replace', path: ptr(steps), value: y });
      return;
    }
    if (tx === 'object') {
      for (const k of Object.keys(x)) {
        if (!(k in y)) { rows.push([jsPath([...steps, k]), 'removed', short(x[k]), '–']); patch.push({ op: 'remove', path: ptr([...steps, k]) }); }
        else cmp(x[k], y[k], [...steps, k]);
      }
      for (const k of Object.keys(y)) if (!(k in x)) { rows.push([jsPath([...steps, k]), 'added', '–', short(y[k])]); patch.push({ op: 'add', path: ptr([...steps, k]), value: y[k] }); }
      return;
    }
    if (tx === 'array') {
      const keyed = mode === 'key' && idKey && [...x, ...y].every((e) => e && typeof e === 'object' && !Array.isArray(e) && idKey in e);
      if (keyed) {
        patchable = false;
        const mx = new Map(x.map((e) => [canon(e[idKey]), e])), my = new Map(y.map((e) => [canon(e[idKey]), e]));
        if (mx.size < x.length || my.size < y.length) warnings.push(`Key "${idKey}" repeats inside ${jsPath(steps)}: later items with the same key hide earlier ones.`);
        for (const [k, e] of mx) {
          const label = [...steps, { k: `${idKey}=${k}` }];
          if (!my.has(k)) rows.push([jsPath(label), 'removed', short(e), '–']);
          else cmp(e, my.get(k), label);
        }
        for (const [k, e] of my) if (!mx.has(k)) rows.push([jsPath([...steps, { k: `${idKey}=${k}` }]), 'added', '–', short(e)]);
        return;
      }
      if (mode === 'unordered') {
        patchable = false;
        const count = (arr) => { const m = new Map(); for (const e of arr) { const c = canon(e); m.set(c, (m.get(c) || 0) + 1); } return m; };
        const cx = count(x), cy = count(y);
        for (const [c, n] of cx) { const d = n - (cy.get(c) || 0); if (d > 0) rows.push([jsPath([...steps, { k: '*' }]), d > 1 ? `removed ×${d}` : 'removed', short(JSON.parse(c)), '–']); }
        for (const [c, n] of cy) { const d = n - (cx.get(c) || 0); if (d > 0) rows.push([jsPath([...steps, { k: '*' }]), d > 1 ? `added ×${d}` : 'added', '–', short(JSON.parse(c))]); }
        return;
      }
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) cmp(x[i], y[i], [...steps, i]);
      for (let i = n; i < y.length; i++) { rows.push([jsPath([...steps, i]), 'added', '–', short(y[i])]); patch.push({ op: 'add', path: ptr([...steps, i]), value: y[i] }); }
      for (let i = x.length - 1; i >= n; i--) { rows.push([jsPath([...steps, i]), 'removed', short(x[i]), '–']); patch.push({ op: 'remove', path: ptr([...steps, i]) }); }
      return;
    }
    if (tx === 'number' && tol > 0 ? Math.abs(x - y) <= tol : x === y) return;
    rows.push([jsPath(steps), 'changed', short(x), short(y)]);
    patch.push({ op: 'replace', path: ptr(steps), value: y });
  };
  cmp(A, B, []);

  // Line diff of the pretty-printed documents.
  // For the line diff, arrays matched by key or as sets are put in a stable order first,
  // so the lines line up the way the field diff matched them.
  const order = (v) => {
    if (Array.isArray(v)) {
      const items = v.map(order);
      if (mode === 'unordered') return items.sort((p, q) => (canon(p) < canon(q) ? -1 : canon(p) > canon(q) ? 1 : 0));
      if (mode === 'key' && idKey && items.every((e) => e && typeof e === 'object' && !Array.isArray(e) && idKey in e)) {
        return items.sort((p, q) => { const x = p[idKey], y = q[idKey]; return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); });
      }
      return items;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, order(x)]));
    return v;
  };
  const fa = JSON.stringify(sort ? sortKeys(order(A)) : order(A), null, 2).split('\n');
  const fb = JSON.stringify(sort ? sortKeys(order(B)) : order(B), null, 2).split('\n');
  let udiff = '', plus = 0, minus = 0;
  if (fa.length + fb.length > 40000) warnings.push('Over 40 000 lines together: the line diff is skipped; the field diff is complete.');
  else {
    const ops = myers(fa, fb);
    if (!ops) warnings.push('The documents differ in over 4000 lines: the line diff is skipped; the field diff is complete.');
    else {
      plus = ops.filter((o) => o.op === '+').length; minus = ops.filter((o) => o.op === '-').length;
      udiff = unified(ops, fa, fb);
      udiff = udiff ? `--- A\n+++ B\n${udiff}` : '(no line differences)';
    }
  }
  const count = (w) => rows.filter((r) => r[1].startsWith(w)).length;
  const same = rows.length === 0;
  const MAXROWS = 500;
  if (rows.length > MAXROWS) warnings.push(`${rows.length} differences; the table shows the first ${MAXROWS}.`);
  if (sort === false && same && plus + minus) warnings.push('Same fields, but the key order differs: sort keys to hide order-only line changes.');
  const texts = [];
  if (udiff) texts.push({ title: 'Line diff', body: udiff, lang: 'diff' });
  texts.push({ title: 'JSON Patch', body: patchable ? JSON.stringify(patch, null, 2) : '(not written: arrays compared by key or as sets have no index paths; compare by index for a patch)', lang: 'json' });
  return {
    values: [
      { label: 'Result', value: same ? 'identical' : `${rows.length} difference${rows.length === 1 ? '' : 's'}`, tone: same ? 'ok' : 'warn', hint: [ign.size && `ignoring ${[...ign].join(', ')}`, tol && `numbers ±${tol}`].filter(Boolean).join('; ') || null },
      { label: 'Changed', value: count('changed') + count('type') },
      { label: 'Added', value: count('added') },
      { label: 'Removed', value: count('removed') },
      { label: 'Lines', value: `+${plus} −${minus}`, hint: `${fa.length} → ${fb.length} lines` },
    ],
    tables: rows.length ? [{ title: 'Field differences', columns: ['Path', 'Change', 'A', 'B'], rows: rows.slice(0, MAXROWS) }] : [],
    texts,
    warnings,
    notes: [
      mode === 'index' ? 'Arrays are compared position by position: an item inserted at the front shows as every later item changed. Use "by key" for lists of records.' : mode === 'key' ? `Array items are matched by their "${idKey}" field; paths show it as [${idKey}=…].` : 'Arrays are compared as unordered multisets of values.',
      'The JSON Patch (RFC 6902) turns A into B when its operations are applied in order.',
    ],
  };
}
