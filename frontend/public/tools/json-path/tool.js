// JSON path explorer: walk every node of a JSON document, list the access
// path of each field in the style you write code in, filter by key or value,
// and read the value at a path you type.
//
// Path syntaxes:
//   JavaScript  data.users[0]["first name"]      (ECMAScript member access)
//   JSONPath    $.users[0]['first name']          (RFC 9535, normalized paths)
//   jq          .users[0]."first name"            (jq manual, "Object Identifier-Index")
//   Python      data["users"][0]["first name"]
//   JSON Pointer /users/0/first name              (RFC 6901; ~ -> ~0, / -> ~1)

const MAX_NODES = 200000;

const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const STYLES = {
  js: { root: (r) => r, key: (k) => (isIdent(k) ? `.${k}` : `[${JSON.stringify(k)}]`), idx: (i) => `[${i}]` },
  jsonpath: { root: () => '$', key: (k) => (isIdent(k) ? `.${k}` : `['${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`), idx: (i) => `[${i}]` },
  jq: { root: () => '', key: (k) => (isIdent(k) && !k.includes('$') ? `.${k}` : `.${JSON.stringify(k)}`), idx: (i) => `[${i}]`, empty: '.' },
  python: { root: (r) => r, key: (k) => `[${JSON.stringify(k)}]`, idx: (i) => `[${i}]` },
  pointer: { root: () => '', key: (k) => `/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, idx: (i) => `/${i}`, empty: '' },
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function preview(v, n = 70) {
  const t = typeOf(v);
  if (t === 'array') return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (t === 'object') { const k = Object.keys(v); return `{${k.length} key${k.length === 1 ? '' : 's'}: ${k.slice(0, 4).join(', ')}${k.length > 4 ? ', …' : ''}}`; }
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Read a typed path in any of the five styles into steps: string key, number index or '*'. */
export function parsePath(p, rootVar = 'data') {
  let s = String(p ?? '').trim();
  if (!s) return { steps: [] };
  if (s.startsWith('/') || s === '') { // JSON Pointer
    return { steps: s.split('/').slice(1).map((t) => (/^(0|[1-9]\d*)$/.test(t) ? Number(t) : t === '*' ? '*' : t.replace(/~1/g, '/').replace(/~0/g, '~'))) };
  }
  // Drop the root: $ (JSONPath) or the variable name (JS/Python), when a path follows it.
  if (s.startsWith('$')) s = s.slice(1);
  else if (s.startsWith(rootVar) && /^[.[]/.test(s.slice(rootVar.length))) s = s.slice(rootVar.length);
  else if (s === rootVar) s = '';
  const steps = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      i++;
      if (s[i] === '"') { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s.slice(i)); if (!m) return { error: `unclosed quote at ${i + 1}` }; steps.push(JSON.parse(m[0])); i += m[0].length; continue; }
      if (s[i] === '*') { steps.push('*'); i++; continue; }
      const m = /^[^.[\]]+/.exec(s.slice(i));
      if (!m) { if (i >= s.length) break; return { error: `nothing after "." at ${i}` }; }
      steps.push(m[0]); i += m[0].length;
    } else if (c === '[') {
      const rest = s.slice(i);
      let m;
      if ((m = /^\[\s*(-?\d+)\s*\]/.exec(rest))) steps.push(Number(m[1]));
      else if ((m = /^\[\s*\*\s*\]/.exec(rest))) steps.push('*');
      else if ((m = /^\[\s*"((?:[^"\\]|\\.)*)"\s*\]/.exec(rest))) steps.push(JSON.parse(`"${m[1]}"`));
      else if ((m = /^\[\s*'((?:[^'\\]|\\.)*)'\s*\]/.exec(rest))) steps.push(m[1].replace(/\\(.)/g, '$1'));
      else return { error: `cannot read "${rest.slice(0, 12)}" at ${i + 1}` };
      i += m[0].length;
    } else if (!steps.length && i === 0) {
      const m = /^[^.[\]]+/.exec(s); steps.push(m[0]); i += m[0].length;
    } else return { error: `unexpected "${c}" at ${i + 1}` };
  }
  return { steps };
}

function get(doc, steps) {
  let cur = [doc];
  for (const st of steps) {
    const next = [];
    for (const v of cur) {
      if (st === '*') { if (v && typeof v === 'object') next.push(...Object.values(v)); }
      else if (typeof st === 'number' && Array.isArray(v)) { const k = st < 0 ? v.length + st : st; if (k in v) next.push(v[k]); }
      else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, String(st))) next.push(v[String(st)]);
    }
    cur = next;
  }
  return cur;
}

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

export function run({ json, filter, style, rootVar, pick, wildcard, leaves }) {
  const warnings = [];
  const text = String(json ?? '').trim();
  if (!text) return { warnings: ['Paste a JSON document to explore.'] };
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    const loc = locate(text);
    if (!loc) return { warnings: [`Not valid JSON: ${e.message}`] };
    const before = text.slice(0, loc.pos);
    return { warnings: [`Not valid JSON at line ${before.split('\n').length}, column ${loc.pos - before.lastIndexOf('\n')}: ${loc.msg} (near "${text.slice(Math.max(0, loc.pos - 15), loc.pos + 15).replace(/\s+/g, ' ')}").`] };
  }
  const S = STYLES[style] || STYLES.js;
  const rv = String(rootVar || '').trim() || 'data';
  const fmtPath = (steps) => {
    const body = steps.map((st) => (st === '*' ? (style === 'pointer' ? '/*' : style === 'jq' ? '[]' : '[*]') : typeof st === 'number' ? S.idx(st) : S.key(st))).join('');
    const r = S.root(rv);
    if (!body) return S.empty ?? r;
    return r + body;
  };

  // Walk depth first, keeping paths as step arrays.
  const nodes = [];
  let count = 0, maxDepth = 0, truncated = false;
  const walk = (v, steps) => {
    if (count >= MAX_NODES) { truncated = true; return; }
    count++;
    maxDepth = Math.max(maxDepth, steps.length);
    const t = typeOf(v);
    const leaf = t !== 'object' && t !== 'array' || (t === 'array' ? v.length === 0 : Object.keys(v).length === 0);
    nodes.push({ steps, v, t, leaf });
    if (t === 'array') v.forEach((x, i) => walk(x, [...steps, i]));
    else if (t === 'object') for (const k of Object.keys(v)) walk(v[k], [...steps, k]);
  };
  walk(doc, []);
  if (truncated) warnings.push(`The document has over ${MAX_NODES} nodes; only the first ${MAX_NODES} are listed.`);

  const f = String(filter || '').trim().toLowerCase();
  const matches = (n) => {
    if (!f) return true;
    const last = n.steps[n.steps.length - 1];
    if (last != null && String(last).toLowerCase().includes(f)) return true;
    if (n.leaf && n.t !== 'object' && n.t !== 'array' && String(n.v).toLowerCase().includes(f)) return true;
    return fmtPath(n.steps).toLowerCase().includes(f) && f.length > 2 && /[.[/$]/.test(f);
  };
  let rows;
  let hits = nodes.filter((n) => n.steps.length && (!leaves || n.leaf) && matches(n));
  if (wildcard) {
    // Array indices -> [*]; one row per distinct path with how often it occurs.
    const groups = new Map();
    for (const n of hits) {
      const st = n.steps.map((x) => (typeof x === 'number' ? '*' : x));
      const key = JSON.stringify(st);
      const g = groups.get(key) || { steps: st, n: 0, types: new Set(), ex: n.v };
      g.n++; g.types.add(n.t); groups.set(key, g);
    }
    rows = [...groups.values()].map((g) => [fmtPath(g.steps), [...g.types].join(' | '), `${g.n}×`, preview(g.ex)]);
    hits = [...groups.values()].map((g) => ({ steps: g.steps }));
  } else {
    rows = hits.map((n) => [fmtPath(n.steps), n.t, preview(n.v)]);
  }
  const MAXROWS = 500;
  if (rows.length > MAXROWS) warnings.push(`${rows.length} paths match; the table shows the first ${MAXROWS}. Type a filter to narrow it.`);

  const values = [
    { label: 'Nodes', value: count, hint: `${nodes.filter((n) => n.leaf).length} leaves` },
    { label: 'Depth', value: maxDepth },
    { label: f ? 'Matches' : 'Paths', value: rows.length },
  ];
  if (rows.length) values.push({ label: f ? 'First match' : 'First path', value: rows[0][0], tone: 'ok' });

  const texts = [{ title: 'Paths', body: rows.map((r) => r[0]).join('\n'), lang: 'text' }];
  const pk = String(pick || '').trim();
  if (pk) {
    const pr = parsePath(pk, rv);
    if (pr.error) warnings.push(`Cannot read the path "${pk}": ${pr.error}.`);
    else {
      const got = get(doc, pr.steps);
      values.push({ label: 'At the path', value: got.length ? (got.length === 1 ? typeOf(got[0]) : `${got.length} values`) : 'nothing', tone: got.length ? 'ok' : 'warn', hint: fmtPath(pr.steps) });
      if (got.length) texts.unshift({ title: 'Value at path', body: JSON.stringify(got.length === 1 ? got[0] : got, null, 2), lang: 'json' });
      else warnings.push(`Nothing at ${fmtPath(pr.steps)}: check the key spelling and array indices (they start at 0).`);
    }
  }
  return {
    values,
    tables: [{ title: wildcard ? 'Distinct paths (array indices as *)' : 'Paths', columns: wildcard ? ['Path', 'Type', 'Occurs', 'Example'] : ['Path', 'Type', 'Value'], rows: rows.slice(0, MAXROWS) }],
    texts,
    warnings,
    notes: ['The filter matches a key or a value (case-insensitive); with a path character (. [ / $) it also matches the path.', 'Type any path in any of the five styles under "Read the value at" to see what is there; [*] or .* takes every item.'],
  };
}
