// JSON to TypeScript: infer types from sample JSON and write TypeScript
// interfaces, a Zod schema and a JSON Schema (draft 2020-12) for them.
//
// Inference rules (the usual ones of quicktype / json-to-ts, stated here):
//   - every element of an array, and every sample when several are given, is
//     merged into one type; a key missing from some objects becomes optional;
//   - a value seen as null and as something else becomes `T | null`;
//   - numbers that are all whole become `integer` in the schemas (TS: number);
//   - strings that all match ISO 8601 date-time / date, e-mail, UUID or URL
//     get that format (RFC 3339, RFC 5322 simplified, RFC 4122, WHATWG URL);
//   - an object with 8+ keys that are all numbers or UUIDs is a dictionary
//     (Record<string, T>), not a type with 8 fields;
//   - identical object shapes share one named type.

const FMT = {
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  uri: /^https?:\/\/[^\s]+$/,
};
const fmtOf = (s) => Object.keys(FMT).find((k) => FMT[k].test(s)) || null;

// A type node: {str?: {fmt}, num?: {int}, bool?, nul?, arr?: node, obj?: {keys: Map<key,{t,n}>, n}, rec?: node, empty?}
const blank = () => ({});
function infer(v) {
  const t = blank();
  if (v === null) t.nul = true;
  else if (Array.isArray(v)) { t.arr = v.reduce((a, x) => merge(a, infer(x)), blank()); t.arrLen = [v.length]; }
  else if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length >= 8 && keys.every((k) => /^\d+$/.test(k) || FMT.uuid.test(k))) {
      t.rec = keys.reduce((a, k) => merge(a, infer(v[k])), blank());
    } else {
      t.obj = { n: 1, keys: new Map(keys.map((k) => [k, { t: infer(v[k]), n: 1 }])) };
    }
  } else if (typeof v === 'string') t.str = { fmt: fmtOf(v), n: 1 };
  else if (typeof v === 'number') t.num = { int: Number.isInteger(v) };
  else if (typeof v === 'boolean') t.bool = true;
  return t;
}
function merge(a, b) {
  const t = { ...a };
  if (b.nul) t.nul = true;
  if (b.bool) t.bool = true;
  if (b.num) t.num = a.num ? { int: a.num.int && b.num.int } : b.num;
  if (b.str) t.str = a.str ? { fmt: a.str.fmt === b.str.fmt ? a.str.fmt : null, n: a.str.n + b.str.n } : b.str;
  if (b.arr) { t.arr = a.arr ? merge(a.arr, b.arr) : b.arr; }
  if (b.rec) t.rec = a.rec ? merge(a.rec, b.rec) : b.rec;
  if (b.obj) {
    if (!a.obj) t.obj = b.obj;
    else {
      const keys = new Map(a.obj.keys);
      for (const [k, e] of b.obj.keys) {
        const o = keys.get(k);
        keys.set(k, o ? { t: merge(o.t, e.t), n: o.n + e.n } : e);
      }
      t.obj = { n: a.obj.n + b.obj.n, keys };
    }
  }
  return t;
}

const pascal = (s) => {
  const w = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((x) => x[0].toUpperCase() + x.slice(1));
  let r = w.join('') || 'Item';
  if (/^\d/.test(r)) r = 'T' + r;
  return r;
};
// Rough English singular for array item names: "users" -> "User", "entries" -> "Entry".
const singular = (s) => (/ies$/i.test(s) ? s.slice(0, -3) + 'y' : /(ss|us|is)$/i.test(s) ? s : /(x|ch|sh|ses)es$/i.test(s) ? s.slice(0, -2) : /s$/i.test(s) ? s.slice(0, -1) : s + 'Item');
// Where JSON.parse failed: a small strict scanner (RFC 8259 grammar) that
// returns the offset and what it expected, since engines word this differently.
function locate(src) {
  let i = 0;
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i])) i++; };
  const fail = (msg) => { throw { pos: i, msg }; };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++; ws();
      if (src[i] === '}') { i++; return; }
      for (;;) {
        ws(); if (src[i] !== '"') fail(src[i] === '}' ? 'trailing comma before }' : src[i] === "'" ? 'single quotes: JSON strings need double quotes' : 'expected a "quoted" key');
        string(); ws(); if (src[i] !== ':') fail('expected : after the key'); i++;
        value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return; }
        fail('expected , or } after a value');
      }
    }
    if (c === '[') {
      i++; ws();
      if (src[i] === ']') { i++; return; }
      for (;;) {
        ws(); if (src[i] === ']') fail('trailing comma before ]');
        value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return; }
        fail('expected , or ] after a value');
      }
    }
    if (c === '"') return string();
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i));
    if (m && m[0]) { i += m[0].length; return; }
    for (const w of ['true', 'false', 'null']) if (src.startsWith(w, i)) { i += w.length; return; }
    if (c === undefined) fail('the text ends too early (a bracket or brace is not closed)');
    fail(c === "'" ? 'single quotes: JSON strings need double quotes' : c === '/' ? 'comments are not allowed in JSON' : /[A-Za-z_]/.test(c) ? 'unquoted word: keys and strings need double quotes' : `unexpected "${c}"`);
  };
  const string = () => {
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') i++;
      else if (src[i] < ' ') fail('a raw line break or control character inside a string');
      i++;
    }
    if (src[i] !== '"') fail('a string is not closed');
    i++;
  };
  try { value(); ws(); if (i < src.length) fail('more text after the JSON value (two documents? use one per line)'); } catch (e) { return e; }
  return null;
}

const ident = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

export function run({ json, rootName, declare, nulls, exportKw }) {
  const warnings = [];
  const text = String(json ?? '').trim();
  if (!text) return { warnings: ['Paste a JSON sample: an object, an array of objects, or one JSON object per line.'] };
  let samples, how;
  try {
    samples = [JSON.parse(text)]; how = ['JSON', Array.isArray(samples?.[0]) ? 'one array' : 'one document'];
  } catch (e) {
    // Not one document: try NDJSON (one value per line) before giving up.
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const ok = [], bad = [];
    lines.forEach((l, i) => { try { ok.push(JSON.parse(l)); } catch { bad.push(i + 1); } });
    if (lines.length > 1 && ok.length && bad.length <= lines.length / 4) {
      samples = ok; how = ['NDJSON', `${ok.length} lines`];
      if (bad.length) warnings.push(`Lines ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? '…' : ''} are not JSON and were skipped.`);
    } else {
      const loc = locate(text);
      if (!loc) return { warnings: [`Not valid JSON: ${e.message}`] };
      const before = text.slice(0, loc.pos);
      const line = before.split('\n').length, col = loc.pos - before.lastIndexOf('\n');
      return { warnings: [`Not valid JSON at line ${line}, column ${col}: ${loc.msg} (near "${text.slice(Math.max(0, loc.pos - 15), loc.pos + 15).replace(/\s+/g, ' ')}").`] };
    }
  }
  let root = samples.reduce((a, s) => merge(a, infer(s)), blank());
  const rootN = pascal(String(rootName || '').trim() || 'Root');
  const nullable = nulls !== 'optional';
  const ex = exportKw ? 'export ' : '';
  const useType = declare === 'type';

  // Name every object shape, depth first, sharing names between identical shapes.
  const named = []; // {name, node}
  const sig = new Map(); // shape signature -> name
  const used = new Set();
  const shape = (t) => JSON.stringify(t, (k, v) => (v instanceof Map ? [...v.entries()].map(([kk, e]) => [kk, e.n === undefined ? e : { t: e.t, o: e.n }]) : v));
  const nameFor = (t, hint) => {
    const s = shape(t.obj);
    if (sig.has(s)) return sig.get(s);
    let nm = pascal(hint), k = 2;
    while (used.has(nm)) nm = pascal(hint) + k++;
    used.add(nm); sig.set(s, nm);
    named.push({ name: nm, node: t });
    return nm;
  };
  let fields = 0, optional = 0, depth = 0, formats = 0;
  // Walk once to assign names; children are named before parents (post-order).
  const names = new WeakMap();
  const visit = (t, hint, d, keep) => {
    depth = Math.max(depth, d);
    if (t.arr) visit(t.arr, keep ? hint : singular(hint), d + 1);
    if (t.rec) visit(t.rec, singular(hint) === hint + 'Item' ? hint + 'Value' : singular(hint), d + 1);
    if (t.obj) {
      for (const [k, e] of t.obj.keys) visit(e.t, k, d + 1);
      names.set(t, nameFor(t, hint));
    }
  };
  visit(root, rootN, 0, true); // a root array's items take the root name
  if (!root.obj && !root.arr && !root.rec) warnings.push('The sample is a single primitive value, so there is only a type alias to make.');

  // ---- TypeScript
  const ts = (t) => {
    const parts = [];
    if (t.obj) parts.push(names.get(t));
    if (t.rec) parts.push(`Record<string, ${ts(t.rec)}>`);
    if (t.arr) { const inner = ts(t.arr); parts.push(/[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`); }
    if (t.str) parts.push('string');
    if (t.num) parts.push('number');
    if (t.bool) parts.push('boolean');
    if (t.nul && (nullable || !parts.length)) parts.push('null');
    return parts.length ? parts.join(' | ') : 'unknown';
  };
  const out = [];
  for (const { name, node } of [...named].reverse()) { // root first reads best; TS does not need order
    const lines = [];
    for (const [k, e] of node.obj.keys) {
      fields++;
      const opt = e.n < node.obj.n || (!nullable && e.t.nul);
      if (opt) optional++;
      if (e.t.str?.fmt) formats++;
      const cm = e.t.str?.fmt ? ` // ${e.t.str.fmt}` : '';
      const tt = !nullable && e.t.nul ? ts({ ...e.t, nul: false }) : ts(e.t);
      lines.push(`  ${ident(k)}${opt ? '?' : ''}: ${tt};${cm}`);
    }
    out.push(useType ? `${ex}type ${name} = {\n${lines.join('\n')}\n};` : `${ex}interface ${name} {\n${lines.join('\n')}\n}`);
  }
  const alias = named.some((x) => x.name === rootN) ? (root.arr ? `${rootN}List` : `${rootN}Root`) : rootN;
  if (!root.obj) out.unshift(`${ex}type ${alias} = ${ts(root)};`);
  const tsText = out.join('\n\n');

  // ---- Zod (v3 API)
  const zfmt = { 'date-time': '.datetime({ offset: true })', date: '.date()', email: '.email()', uuid: '.uuid()', uri: '.url()' };
  const zod = (t) => {
    const parts = [];
    if (t.obj) parts.push(`${names.get(t)}Schema`);
    if (t.rec) parts.push(`z.record(z.string(), ${zod(t.rec)})`);
    if (t.arr) parts.push(`z.array(${zod(t.arr)})`);
    if (t.str) parts.push(`z.string()${t.str.fmt ? zfmt[t.str.fmt] : ''}`);
    if (t.num) parts.push(t.num.int ? 'z.number().int()' : 'z.number()');
    if (t.bool) parts.push('z.boolean()');
    const base = parts.length === 0 ? (t.nul ? 'z.null()' : 'z.unknown()') : parts.length === 1 ? parts[0] : `z.union([${parts.join(', ')}])`;
    return t.nul && parts.length ? `${base}.nullable()` : base;
  };
  const zlines = ["import { z } from 'zod';", ''];
  for (const { name, node } of named) {
    const f = [...node.obj.keys].map(([k, e]) => {
      const opt = e.n < node.obj.n;
      return `  ${ident(k)}: ${zod(e.t)}${opt ? '.optional()' : ''},`;
    });
    zlines.push(`${ex}const ${name}Schema = z.object({\n${f.join('\n')}\n});`, `${ex}type ${name} = z.infer<typeof ${name}Schema>;`, '');
  }
  if (!root.obj) zlines.push(`${ex}const ${alias}Schema = ${zod(root)};`);

  // ---- JSON Schema 2020-12
  const js = (t) => {
    const any = [];
    if (t.obj) any.push({ $ref: `#/$defs/${names.get(t)}` });
    if (t.rec) any.push({ type: 'object', additionalProperties: js(t.rec) });
    if (t.arr) any.push({ type: 'array', items: js(t.arr) });
    if (t.str) any.push(t.str.fmt ? { type: 'string', format: t.str.fmt } : { type: 'string' });
    if (t.num) any.push({ type: t.num.int ? 'integer' : 'number' });
    if (t.bool) any.push({ type: 'boolean' });
    if (t.nul) any.push({ type: 'null' });
    if (!any.length) return {};
    if (any.length === 1) return any[0];
    if (any.every((x) => Object.keys(x).length === 1 && x.type)) return { type: any.map((x) => x.type) };
    return { anyOf: any };
  };
  const defs = {};
  for (const { name, node } of named) {
    const props = {}, req = [];
    for (const [k, e] of node.obj.keys) { props[k] = js(e.t); if (e.n === node.obj.n) req.push(k); }
    defs[name] = { type: 'object', properties: props, required: req, additionalProperties: false };
  }
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: rootN, ...js(root), $defs: defs };

  const onlyNull = [];
  for (const { name, node } of named) for (const [k, e] of node.obj.keys) if (e.t.nul && !e.t.str && !e.t.num && !e.t.bool && !e.t.obj && !e.t.arr && !e.t.rec) onlyNull.push(`${name}.${k}`);
  if (onlyNull.length) warnings.push(`Only ever null in the sample: ${onlyNull.slice(0, 8).join(', ')}${onlyNull.length > 8 ? '…' : ''}. Their real type is unknown, so they are typed null; add a sample where they have a value.`);
  const nObj = named.length;
  return {
    values: [
      { label: 'Read as', value: how[0], hint: how[1] },
      { label: 'Types', value: nObj, hint: 'named object types' },
      { label: 'Fields', value: fields, hint: `${optional} optional` },
      { label: 'Depth', value: depth, hint: 'levels of nesting' },
      { label: 'Formats found', value: formats, hint: 'date-time, email, uuid, url' },
    ],
    texts: [
      { title: 'TypeScript', body: tsText, lang: 'ts' },
      { title: 'Zod', body: zlines.join('\n').trim(), lang: 'ts' },
      { title: 'JSON Schema', body: JSON.stringify(schema, null, 2), lang: 'json' },
    ],
    tables: [{ title: 'Types', columns: ['Type', 'Fields', 'Optional', 'Seen'], rows: named.map(({ name, node }) => [name, node.obj.keys.size, [...node.obj.keys].filter(([, e]) => e.n < node.obj.n).map(([k]) => k).join(', ') || '–', `${node.obj.n}×`]) }],
    warnings,
    notes: [
      'A field is optional when some sample objects lack it: give several samples (an array) so the tool can see which fields are sometimes missing.',
      'Enums are not guessed: a string field stays string even if the sample has few distinct values.',
      nulls === 'optional' ? 'Null values are typed as optional fields (field?: T); the Zod and JSON Schema outputs still allow null.' : 'Null values are typed as T | null.',
    ],
  };
}
