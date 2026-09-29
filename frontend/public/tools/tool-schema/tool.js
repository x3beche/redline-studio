// Tool / Function Schema Builder: one tool's parameters as a JSON Schema
// tree, written out for Anthropic, OpenAI and MCP, with an example call
// validated against it and lint for what makes models call tools badly.
//
// Schema keywords follow JSON Schema 2020-12 Validation (type, enum,
// required, properties, additionalProperties, items, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, multipleOf, minLength, maxLength,
// pattern, format, minItems, maxItems).
// Provider shapes (as of 2026-09 - verify at the provider's docs):
//   Anthropic tools[]: {name, description, input_schema, strict?}; name
//     ^[a-zA-Z0-9_-]{1,64}$; strict needs additionalProperties: false on every
//     object; numeric and string-length constraints are not enforced under
//     strict - the SDKs move them into the description, as done here.
//   OpenAI tools[]: {type: "function", function: {name, description,
//     parameters, strict}}; strict needs additionalProperties: false and every
//     property listed in required - an optional one becomes nullable.
//   MCP tools/list: {name, title?, description, inputSchema} (type object).

export const AS_OF = '2026-09';
const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
const FORMATS = ['date-time', 'date', 'time', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'uuid', 'regex'];
const VAGUE_TOOL = /^(do|run|execute|exec|handle|process|tool|function|func|helper|util|utils|action|call|invoke|go|main|test|api|request)([_-]?\d*)$/i;
const VAGUE_PARAM = /^(data|input|inputs|value|val|arg\d*|args|param\d*|params|x|y|obj|object|info|thing|stuff|options|opts|payload|body|content|misc|extra|other|config)$/i;
const NUM_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const STR_KEYS = ['minLength', 'maxLength'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const typesOf = (s) => (Array.isArray(s?.type) ? s.type : s?.type ? [s.type] : []);
const mainType = (s) => typesOf(s).find((t) => t !== 'null') || (s?.enum ? typeof s.enum[0] === 'number' ? 'number' : 'string' : s?.properties ? 'object' : s?.items ? 'array' : '');

// ---------------- JSON with a position on error ----------------
export function parseJSON(text) {
  try { return { value: JSON.parse(text) }; } catch (e) {
    const m = /position (\d+)/.exec(e.message) || /at (\d+)/.exec(e.message);
    let line = null, col = null;
    if (m) { const pos = Number(m[1]); const pre = text.slice(0, pos); line = pre.split('\n').length; col = pos - pre.lastIndexOf('\n'); }
    const lc = /line (\d+) column (\d+)/.exec(e.message);
    if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
    return { error: e.message.replace(/^JSON\.parse: /, '').replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, ''), line, col };
  }
}

// ---------------- splitting at the top level ----------------
function splitTop(s, seps) {
  const out = []; let depth = 0, cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); const end = j < 0 ? s.length : j + 2; cur += s.slice(i, end); i = end - 1; continue; }
    if (c === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); const end = j < 0 ? s.length : j; cur += s.slice(i, end); i = end - 1; continue; }
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && !(c === '>' && s[i - 1] === '=')) depth--;
    if (depth === 0 && seps.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function matching(s, open) {
  const pairs = { '(': ')', '{': '}', '[': ']', '<': '>' };
  let depth = 0, q = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === s[open]) depth++;
    else if (c === pairs[s[open]]) { depth--; if (!depth) return i; }
  }
  return -1;
}
const lead = (s) => { // leading comment of a member/param -> [description, rest]
  let t = s.trim(); const desc = [];
  for (;;) {
    let m = /^\/\*\*?([\s\S]*?)\*\/\s*/.exec(t);
    if (m) { desc.push(m[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter((l) => l && !l.startsWith('@')).join(' ')); t = t.slice(m[0].length); continue; }
    m = /^\/\/(.*)\n?\s*/.exec(t);
    if (m) { desc.push(m[1].trim()); t = t.slice(m[0].length); continue; }
    break;
  }
  return [desc.filter(Boolean).join(' '), t.trim()];
};
function literal(v) {
  const t = String(v).trim();
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(t)) return Number(t);
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === 'null' || t === 'None' || t === 'undefined') return null;
  const m = /^(["'`])([\s\S]*)\1$/.exec(t);
  if (m) return m[2];
  if (t === '[]') return [];
  return undefined;
}

// ---------------- TypeScript ----------------
function tsType(t, warn) {
  t = t.trim().replace(/^readonly\s+/, '');
  const alts = splitTop(t, ['|']).map((x) => x.trim()).filter(Boolean);
  if (alts.length > 1) {
    const nul = alts.some((a) => a === 'null' || a === 'undefined');
    const rest = alts.filter((a) => a !== 'null' && a !== 'undefined');
    let s;
    if (rest.every((a) => literal(a) !== undefined && typeof literal(a) !== 'object')) {
      const vals = rest.map(literal);
      s = { type: typeof vals[0] === 'number' ? (vals.every(Number.isInteger) ? 'integer' : 'number') : typeof vals[0] === 'boolean' ? 'boolean' : 'string', enum: vals };
    } else if (rest.length === 1) s = tsType(rest[0], warn);
    else s = { anyOf: rest.map((a) => tsType(a, warn)) };
    return nul ? { ...s, _nullable: true } : s;
  }
  if (t.endsWith('[]')) return { type: 'array', items: tsType(t.slice(0, -2), warn) };
  let m = /^(?:Array|ReadonlyArray)<([\s\S]+)>$/.exec(t);
  if (m) return { type: 'array', items: tsType(m[1], warn) };
  m = /^Record<\s*string\s*,([\s\S]+)>$/.exec(t);
  if (m) return { type: 'object', additionalProperties: tsType(m[1], warn) };
  if (t.startsWith('{')) return tsObject(t.slice(1, matching(t, 0)), warn);
  if (t.startsWith('(') && t.endsWith(')')) return tsType(t.slice(1, -1), warn);
  const lit = literal(t);
  if (lit !== undefined && lit !== null && typeof lit !== 'object') return { type: typeof lit === 'number' ? 'number' : typeof lit === 'boolean' ? 'boolean' : 'string', enum: [lit] };
  const prim = { string: 'string', number: 'number', boolean: 'boolean', bigint: 'integer', integer: 'integer', int: 'integer', object: 'object' }[t];
  if (prim) return prim === 'object' ? { type: 'object', properties: {} } : { type: prim };
  if (t === 'Date') return { type: 'string', format: 'date-time' };
  if (t === 'any' || t === 'unknown') { warn(`Type "${t}" has no schema; left as string - give it a real type.`); return { type: 'string' }; }
  warn(`Type "${t}" is not a primitive, array, union or object literal - left as string. Inline its fields to get them in the schema.`);
  return { type: 'string' };
}
function tsObject(body, warn) {
  const props = {}; const req = [];
  let pending = '';
  for (const raw of splitTop(body, [';', ',', '\n'])) {
    let [desc, rest] = lead(raw);
    if (!rest) { if (desc) pending = pending ? `${pending} ${desc}` : desc; continue; }
    if (pending) { desc = desc ? `${pending} ${desc}` : pending; pending = ''; }
    const m = /^(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(\?)?\s*:\s*([\s\S]+)$/.exec(rest);
    if (!m) { if (rest.trim()) warn(`Could not read the member "${rest.trim().slice(0, 40)}".`); continue; }
    const s = tsType(m[3], warn);
    if (desc) s.description = desc;
    if (s._nullable) delete s._nullable; else if (!m[2]) req.push(m[1]);
    props[m[1]] = s;
  }
  const o = { type: 'object', properties: props };
  if (req.length) o.required = req;
  return o;
}
export function fromTypeScript(src, warn) {
  let s = String(src || '');
  let name = null, desc = '';
  const fm = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(s)
    || /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(s);
  if (fm) {
    name = fm[2]; desc = fm[1] ? lead(`/**${fm[1]}*/`)[0] : '';
    const open = fm.index + fm[0].length - 1;
    const close = matching(s, open);
    if (close < 0) { warn('The parameter list has no closing parenthesis.'); return null; }
    const params = splitTop(s.slice(open + 1, close), [',']).map((p) => p.trim()).filter(Boolean);
    // One destructured object parameter: ({a, b}: {a: string; b?: number})
    if (params.length === 1) {
      const [, rest] = lead(params[0]);
      const dm = /^(?:\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s*:\s*(\{[\s\S]*\})\s*(?:=\s*\{\s*\})?$/.exec(rest);
      if (dm && rest.startsWith('{')) return { schema: tsObject(dm[1].slice(1, matching(dm[1], 0)), warn), name, desc };
    }
    const props = {}; const req = [];
    for (const p of params) {
      const [d, rest] = lead(p);
      const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(rest);
      if (!m) { warn(`Could not read the parameter "${rest.slice(0, 40)}".`); continue; }
      let sch = m[3] ? tsType(m[3], warn) : null;
      const dv = m[4] != null ? literal(m[4]) : undefined;
      if (!sch) { sch = dv !== undefined && dv !== null ? { type: typeof dv === 'number' ? (Number.isInteger(dv) ? 'integer' : 'number') : typeof dv === 'boolean' ? 'boolean' : 'string' } : { type: 'string' }; if (dv === undefined) warn(`Parameter "${m[1]}" has no type; string assumed.`); }
      if (dv !== undefined && dv !== null) { sch.default = dv; if (sch.type === 'number' && Number.isInteger(dv) && !/\./.test(m[4])) sch.type = 'integer'; }
      if (d) sch.description = d;
      const optional = m[2] || m[4] != null || sch._nullable;
      delete sch._nullable;
      if (!optional) req.push(m[1]);
      props[m[1]] = sch;
    }
    const o = { type: 'object', properties: props }; if (req.length) o.required = req;
    return { schema: o, name, desc };
  }
  const im = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:export\s+)?(?:interface\s+([A-Za-z_$][\w$]*)[^{]*|type\s+([A-Za-z_$][\w$]*)\s*=\s*)\{/.exec(s);
  if (im) {
    const open = im.index + im[0].length - 1;
    const close = matching(s, open);
    if (close < 0) { warn('The type body has no closing brace.'); return null; }
    return { schema: tsObject(s.slice(open + 1, close), warn), name: im[2] || im[3], desc: im[1] ? lead(`/**${im[1]}*/`)[0] : '' };
  }
  if (s.trim().startsWith('{')) return { schema: tsObject(s.trim().slice(1, matching(s.trim(), 0)), warn), name: null, desc: '' };
  warn('No TypeScript function, interface or type literal found.');
  return null;
}

// ---------------- Python ----------------
function pyType(t, warn) {
  t = t.trim();
  const alts = splitTop(t, ['|']).map((x) => x.trim());
  if (alts.length > 1) {
    const rest = alts.filter((a) => a !== 'None');
    const s = rest.length === 1 ? pyType(rest[0], warn) : { anyOf: rest.map((a) => pyType(a, warn)) };
    return rest.length < alts.length ? { ...s, _nullable: true } : s;
  }
  let m = /^(?:typing\.)?Optional\[([\s\S]+)\]$/.exec(t);
  if (m) return { ...pyType(m[1], warn), _nullable: true };
  m = /^(?:typing\.)?Union\[([\s\S]+)\]$/.exec(t);
  if (m) return pyType(splitTop(m[1], [',']).join('|'), warn);
  m = /^(?:typing\.)?Literal\[([\s\S]+)\]$/.exec(t);
  if (m) {
    const vals = splitTop(m[1], [',']).map(literal).filter((v) => v !== undefined);
    return { type: typeof vals[0] === 'number' ? (vals.every(Number.isInteger) ? 'integer' : 'number') : typeof vals[0] === 'boolean' ? 'boolean' : 'string', enum: vals };
  }
  m = /^(?:typing\.)?(?:list|List|Sequence|tuple|Tuple|set|Set|Iterable)\[([\s\S]+?)(?:,\s*\.\.\.)?\]$/.exec(t);
  if (m) return { type: 'array', items: pyType(splitTop(m[1], [','])[0], warn) };
  if (/^(list|List|tuple|set)$/.test(t)) return { type: 'array', items: { type: 'string' } };
  m = /^(?:typing\.)?(?:dict|Dict|Mapping)\[\s*str\s*,([\s\S]+)\]$/.exec(t);
  if (m) return { type: 'object', additionalProperties: pyType(m[1], warn) };
  const prim = { str: 'string', int: 'integer', float: 'number', bool: 'boolean', dict: 'object', Dict: 'object', bytes: 'string' }[t];
  if (prim) return prim === 'object' ? { type: 'object', properties: {} } : { type: prim };
  if (/^(datetime|datetime\.datetime)$/.test(t)) return { type: 'string', format: 'date-time' };
  if (/^(date|datetime\.date)$/.test(t)) return { type: 'string', format: 'date' };
  if (t === 'Any') { warn('Type "Any" has no schema; left as string - give it a real type.'); return { type: 'string' }; }
  warn(`Type "${t}" is not a builtin, Optional, Literal, list or dict - left as string. Give the model its fields as separate parameters or a TypedDict inline.`);
  return { type: 'string' };
}
export function fromPython(src, warn) {
  const s = String(src || '');
  const fm = /def\s+([A-Za-z_]\w*)\s*\(/.exec(s);
  if (!fm) { warn('No Python "def name(...)" found.'); return null; }
  const open = fm.index + fm[0].length - 1;
  const close = matching(s, open);
  if (close < 0) { warn('The parameter list has no closing parenthesis.'); return null; }
  // Docstring and its Args: section (Google style).
  const after = s.slice(close + 1);
  const dm = /^[^:]*:\s*(?:\n\s*)?(?:[rRuU]?)("""|''')([\s\S]*?)\1/.exec(after);
  const doc = dm ? dm[2] : '';
  const argDesc = {};
  let summary = '';
  if (doc) {
    const lines = doc.split('\n');
    summary = lines.map((l) => l.trim()).filter(Boolean)[0] || '';
    let inArgs = false, cur = null, ind = 0;
    for (const l of lines) {
      if (/^\s*(Args|Arguments|Parameters)\s*:\s*$/.test(l)) { inArgs = true; continue; }
      if (inArgs && /^\s*(Returns|Raises|Yields|Examples?|Notes?)\s*:\s*$/.test(l)) { inArgs = false; continue; }
      if (!inArgs) continue;
      const am = /^(\s*)(\*{0,2}[A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*(.*)$/.exec(l);
      const li = /^(\s*)/.exec(l)[1].length;
      if (am && (cur == null || li <= ind)) { cur = am[2]; ind = li; argDesc[cur] = am[3].trim(); }
      else if (cur && l.trim()) argDesc[cur] += ' ' + l.trim();
    }
  }
  const props = {}; const req = [];
  for (const p of splitTop(s.slice(open + 1, close), [','])) {
    const t = p.trim();
    if (!t || t === 'self' || t === 'cls' || t === '*' || t === '/' || t.startsWith('*')) continue;
    const m = /^([A-Za-z_]\w*)\s*(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/.exec(t);
    if (!m) { warn(`Could not read the parameter "${t.slice(0, 40)}".`); continue; }
    const dv = m[3] != null ? literal(m[3]) : undefined;
    let sch = m[2] ? pyType(m[2], warn) : null;
    if (!sch) { sch = dv != null ? { type: typeof dv === 'number' ? (Number.isInteger(dv) ? 'integer' : 'number') : typeof dv === 'boolean' ? 'boolean' : 'string' } : { type: 'string' }; warn(`Parameter "${m[1]}" has no type hint; ${sch.type} assumed.`); }
    if (dv !== undefined && dv !== null) sch.default = dv;
    if (m[3] != null && dv === undefined) warn(`The default of "${m[1]}" (${m[3].trim()}) is not a literal; left out.`);
    if (argDesc[m[1]]) sch.description = argDesc[m[1]];
    const optional = m[3] != null || sch._nullable;
    delete sch._nullable;
    if (!optional) req.push(m[1]);
    props[m[1]] = sch;
  }
  const o = { type: 'object', properties: props }; if (req.length) o.required = req;
  return { schema: o, name: fm[1], desc: summary };
}

// ---------------- the tree ----------------
function cons(s) {
  const c = [];
  const t = mainType(s);
  if (s.minimum != null && s.maximum != null) c.push(`${s.minimum}..${s.maximum}`);
  else if (s.minimum != null) c.push(`≥ ${s.minimum}`); else if (s.maximum != null) c.push(`≤ ${s.maximum}`);
  if (s.exclusiveMinimum != null) c.push(`> ${s.exclusiveMinimum}`);
  if (s.exclusiveMaximum != null) c.push(`< ${s.exclusiveMaximum}`);
  if (s.multipleOf != null) c.push(`×${s.multipleOf}`);
  if (s.minLength != null || s.maxLength != null) c.push(`len ${s.minLength ?? 0}..${s.maxLength ?? '∞'}`);
  if (s.pattern) c.push(`/${s.pattern}/`);
  if (s.format) c.push(s.format);
  if (s.minItems != null || s.maxItems != null) c.push(`${s.minItems ?? 0}..${s.maxItems ?? '∞'} items`);
  if (t === 'object' && s.additionalProperties === false) c.push('closed');
  return c.join(', ');
}
export function buildTree(schema) {
  const nodes = [];
  const walk = (s, ptr, id, name, depth, required, parent, kind, index, count) => {
    const n = { id, ptr, name, kind, depth, parent, index, count, required,
      type: typesOf(s).join('|') || mainType(s) || (s.anyOf ? 'anyOf' : 'any'),
      main: mainType(s), desc: typeof s.description === 'string' ? s.description : '',
      enum: Array.isArray(s.enum) ? s.enum : null, def: s.default !== undefined ? JSON.stringify(s.default) : '', cons: cons(s),
      lints: [], errors: [], children: 0 };
    nodes.push(n);
    if (isObj(s.properties)) {
      const keys = Object.keys(s.properties);
      const req = Array.isArray(s.required) ? s.required : [];
      n.children = keys.length;
      keys.forEach((k, i) => walk(isObj(s.properties[k]) ? s.properties[k] : {}, [...ptr, 'properties', k], id ? `${id}.${k}` : k, k, depth + 1, req.includes(k), id, 'prop', i, keys.length));
    } else if (isObj(s.items)) {
      n.children = 1;
      walk(s.items, [...ptr, 'items'], `${id}[]`, '[item]', depth + 1, null, id, 'items', 0, 1);
    }
  };
  walk(schema, [], '', '(parameters)', 0, null, null, 'root', 0, 1);
  return nodes;
}

// ---------------- validation of an example ----------------
const FMT_RE = {
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/, date: /^\d{4}-\d{2}-\d{2}$/, time: /^\d{2}:\d{2}(:\d{2})?/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, uri: /^[a-z][a-z0-9+.-]*:\S+$/i, uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/, hostname: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
};
const jt = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
export function validate(v, s, id, path, errs) {
  if (!isObj(s)) return;
  const add = (msg, node = id, at = path) => errs.push({ node, path: at || '/', msg });
  const ts = typesOf(s);
  const actual = jt(v);
  if (ts.length && !ts.some((t) => t === actual || (t === 'number' && actual === 'integer'))) { add(`is ${actual === 'integer' ? 'a number' : actual === 'object' ? 'an object' : actual === 'array' ? 'an array' : actual === 'string' ? 'a string' : actual} (${JSON.stringify(v).slice(0, 30)}), expected ${ts.join(' or ')}`); return; }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) add(`${JSON.stringify(v)} is not one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof v === 'string') {
    if (s.minLength != null && [...v].length < s.minLength) add(`is ${[...v].length} characters, minimum ${s.minLength}`);
    if (s.maxLength != null && [...v].length > s.maxLength) add(`is ${[...v].length} characters, maximum ${s.maxLength}`);
    if (s.pattern) { try { if (!new RegExp(s.pattern, 'u').test(v)) add(`does not match /${s.pattern}/`); } catch { /* bad pattern: linted */ } }
    if (s.format && FMT_RE[s.format] && !FMT_RE[s.format].test(v)) add(`is not a valid ${s.format}`);
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) add(`${v} is below the minimum ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) add(`${v} is above the maximum ${s.maximum}`);
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) add(`${v} must be above ${s.exclusiveMinimum}`);
    if (s.exclusiveMaximum != null && v >= s.exclusiveMaximum) add(`${v} must be below ${s.exclusiveMaximum}`);
    if (s.multipleOf && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) add(`${v} is not a multiple of ${s.multipleOf}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) add(`has ${v.length} items, minimum ${s.minItems}`);
    if (s.maxItems != null && v.length > s.maxItems) add(`has ${v.length} items, maximum ${s.maxItems}`);
    if (isObj(s.items)) v.forEach((x, i) => validate(x, s.items, `${id}[]`, `${path}/${i}`, errs));
  }
  if (isObj(v)) {
    const props = isObj(s.properties) ? s.properties : {};
    for (const k of Array.isArray(s.required) ? s.required : []) if (!(k in v)) add(`required "${k}" is missing`, id ? `${id}.${k}` : k, `${path}/${k}`);
    for (const [k, x] of Object.entries(v)) {
      const cid = id ? `${id}.${k}` : k;
      if (k in props) validate(x, props[k], cid, `${path}/${k}`, errs);
      else if (s.additionalProperties === false) add(`"${k}" is not a parameter (additionalProperties is false)`);
      else if (isObj(s.additionalProperties)) validate(x, s.additionalProperties, cid, `${path}/${k}`, errs);
      else add(`"${k}" is not a defined parameter - the schema allows it, but a model sending it means the description is unclear`);
    }
  }
}

// ---------------- provider rewrites ----------------
function walkObjects(s, fn) {
  if (!isObj(s)) return;
  fn(s);
  if (isObj(s.properties)) Object.values(s.properties).forEach((x) => walkObjects(x, fn));
  if (isObj(s.items)) walkObjects(s.items, fn);
  if (isObj(s.additionalProperties)) walkObjects(s.additionalProperties, fn);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[k])) s[k].forEach((x) => walkObjects(x, fn));
}
export function anthropicStrict(schema) {
  const s = clone(schema);
  walkObjects(s, (o) => {
    if (mainType(o) === 'object' || o.properties) o.additionalProperties = false;
    const moved = [];
    for (const k of [...NUM_KEYS, ...STR_KEYS]) if (o[k] != null) { moved.push(`${k} ${o[k]}`); delete o[k]; }
    if (o.minItems != null && o.minItems > 1) { moved.push(`minItems ${o.minItems}`); delete o.minItems; }
    if (o.maxItems != null) { moved.push(`maxItems ${o.maxItems}`); delete o.maxItems; }
    if (moved.length) o.description = `${o.description ? o.description.replace(/\s*$/, ' ') : ''}(${moved.join(', ')})`.trim();
  });
  return s;
}
export function openaiStrict(schema) {
  const s = clone(schema);
  walkObjects(s, (o) => {
    if (!(mainType(o) === 'object' || o.properties)) return;
    o.additionalProperties = false;
    const props = isObj(o.properties) ? o.properties : (o.properties = {});
    const req = new Set(Array.isArray(o.required) ? o.required : []);
    for (const [k, p] of Object.entries(props)) {
      if (req.has(k)) continue;
      const ts = typesOf(p);
      if (ts.length) { if (!ts.includes('null')) p.type = [...ts, 'null']; }
      else props[k] = { anyOf: [p, { type: 'null' }] };
      if (Array.isArray(p.enum) && !p.enum.includes(null)) p.enum = [...p.enum, null];
    }
    o.required = Object.keys(props);
  });
  return s;
}

// ---------------- lint ----------------
function lint(nodes, schema, name, description, strict, add) {
  const tool = [];
  if (!name) tool.push('The tool has no name.');
  else {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) tool.push(`Name "${name}" must match ^[a-zA-Z0-9_-]{1,64}$ for Anthropic and OpenAI (MCP also allows dots).`);
    if (VAGUE_TOOL.test(name) || name.length < 4) tool.push(`Name "${name}" says nothing about what the tool does: use verb_object, e.g. search_parts, create_ticket.`);
  }
  const d = String(description || '').trim();
  if (!d) tool.push('The tool has no description: the model decides when to call it from this text alone. Say what it does, when to use it (and when not), and what it returns.');
  else if (d.length < 60) tool.push(`The description is ${d.length} character${d.length === 1 ? '' : 's'}: say what the tool does, when to use it and what it returns (3-4 sentences is typical).`);
  const root = nodes[0];
  root.lints.push(...tool);
  const params = nodes.filter((n) => n.kind === 'prop');
  const top = params.filter((n) => n.depth === 1);
  if (top.length > 15) add(root, `${top.length} top-level parameters: models pick arguments less reliably with many; split the tool or group rarely used options.`);
  if (params.length > 40) add(root, `${params.length} parameters in all: consider a smaller tool surface.`);
  const get = (ptr) => ptr.reduce((o, k) => (o == null ? o : o[k]), schema);
  const optional = [];
  for (const n of nodes) {
    if (n.kind === 'root') continue;
    const s = get(n.ptr) || {};
    if (n.kind === 'prop') {
      if (!n.desc.trim()) add(n, `"${n.name}" has no description: say what it is, its unit and format${n.enum ? ', and what each value means' : ''}.`);
      else if (n.desc.trim().length < 12) add(n, `"${n.name}": the description "${n.desc.trim()}" is too thin to call it right.`);
      if (VAGUE_PARAM.test(n.name)) add(n, `"${n.name}" is a vague parameter name: name it for what it holds (e.g. part_number, max_results).`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n.name)) add(n, `"${n.name}": use letters, digits and underscores in parameter names.`);
      if (n.required === false && strict) { n.lints.push('optional: required + nullable under OpenAI strict'); optional.push(n.id); }
    }
    if (n.enum) {
      const text = (n.desc || '').toLowerCase();
      const said = n.enum.filter((v) => text.includes(String(v).toLowerCase())).length;
      if (n.enum.length > 1 && said < Math.ceil(n.enum.length / 2) && n.enum.some((v) => typeof v === 'string')) add(n, `"${n.name}" is an enum of ${n.enum.length} values without saying what each means: list them in the description ("resistor: fixed resistors; ic: ...").`);
      if (n.def && !n.enum.some((v) => JSON.stringify(v) === n.def)) add(n, `"${n.name}": the default ${n.def} is not one of the enum values.`);
      if (!n.enum.length) add(n, `"${n.name}": an empty enum accepts nothing.`);
    }
    for (const t of typesOf(s)) if (!TYPES.includes(t)) add(n, `"${n.name}": "${t}" is not a JSON Schema type (${TYPES.join(', ')}).`);
    if (!typesOf(s).length && !s.enum && !s.anyOf && !s.oneOf && !s.$ref) add(n, `"${n.name}" has no type: give it one so the model knows what to send.`);
    if (s.minimum != null && s.maximum != null && s.minimum > s.maximum) add(n, `"${n.name}": minimum ${s.minimum} is above maximum ${s.maximum}.`);
    if (s.minLength != null && s.maxLength != null && s.minLength > s.maxLength) add(n, `"${n.name}": minLength is above maxLength.`);
    if (s.default !== undefined && typeof s.default === 'number' && ((s.minimum != null && s.default < s.minimum) || (s.maximum != null && s.default > s.maximum))) add(n, `"${n.name}": the default ${s.default} is outside ${s.minimum ?? '-∞'}..${s.maximum ?? '∞'}.`);
    if (s.pattern) { try { new RegExp(s.pattern, 'u'); } catch { add(n, `"${n.name}": pattern /${s.pattern}/ is not a valid regular expression.`); } }
    if (s.format && !FORMATS.includes(s.format)) add(n, `"${n.name}": format "${s.format}" is not a standard JSON Schema format.`);
    if (n.main === 'array' && !isObj(s.items)) add(n, `"${n.name}" is an array without items: say what the elements are.`);
    if (n.main === 'object' && n.kind === 'prop' && !n.children && !isObj(s.additionalProperties)) add(n, `"${n.name}" is an object with no properties: the model has to guess its keys.`);
    if (n.main === 'object' && n.depth >= 3) add(n, `"${n.name}" is nested ${n.depth} levels deep: flatten it - models fill deep objects less reliably.`);
    if (Array.isArray(s.required)) for (const k of s.required) if (!isObj(s.properties) || !(k in s.properties)) add(n, `"${n.name}" requires "${k}", which is not among its properties.`);
  }
  if (optional.length) add(root, `${optional.length} optional parameter${optional.length > 1 ? 's' : ''} (${optional.slice(0, 6).join(', ')}${optional.length > 6 ? ', …' : ''}): OpenAI strict mode needs every property required, so they are written there as required and nullable - the model sends null for "not given". Make a parameter required if it always has a value.`);
  if (Array.isArray(schema.required)) for (const k of schema.required) if (!isObj(schema.properties) || !(k in schema.properties)) add(root, `required lists "${k}", which is not a parameter.`);
  if (mainType(schema) !== 'object') add(root, 'The parameters must be a JSON Schema of type "object" (all three providers require it).');
}

// ---------------- a sample call ----------------
/** Arguments that satisfy the schema: required fields, defaults, first enum values. */
export function sample(s, depth = 0) {
  if (!isObj(s) || depth > 6) return null;
  if (s.default !== undefined) return clone(s.default);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const t = mainType(s);
  if (t === 'object') {
    const o = {};
    const req = Array.isArray(s.required) ? s.required : [];
    for (const [k, v] of Object.entries(isObj(s.properties) ? s.properties : {})) if (req.includes(k) || depth === 0) o[k] = sample(v, depth + 1);
    return o;
  }
  if (t === 'array') { const n = Math.max(1, s.minItems || 0); return Array.from({ length: Math.min(n, 3) }, () => sample(s.items, depth + 1)); }
  if (t === 'integer' || t === 'number') { let v = s.minimum ?? (s.exclusiveMinimum != null ? s.exclusiveMinimum + 1 : 1); if (s.maximum != null && v > s.maximum) v = s.maximum; return v; }
  if (t === 'boolean') return false;
  if (t === 'string') {
    const f = { 'date-time': '2026-09-29T12:00:00Z', date: '2026-09-29', email: 'name@example.com', uri: 'https://example.com', uuid: '123e4567-e89b-12d3-a456-426614174000' }[s.format];
    if (f) return f;
    let v = 'example'; if (s.minLength && v.length < s.minLength) v = v.padEnd(s.minLength, 'x'); if (s.maxLength && v.length > s.maxLength) v = v.slice(0, s.maxLength);
    return v;
  }
  return null;
}

// ---------------- run ----------------
export function run(input) {
  const warnings = [];
  const notes = [];
  const warn = (m) => warnings.push(m);
  let name = String(input.name ?? '').trim();
  const description = String(input.description ?? '');
  const strict = input.strict === true || input.strict === 'true';
  const source = ['schema', 'typescript', 'python'].includes(input.source) ? input.source : 'schema';
  let schema = null;
  let parseError = null;
  let imported = null;
  if (source === 'schema') {
    const text = String(input.schema ?? '').trim();
    if (!text) { schema = { type: 'object', properties: {} }; warn('The schema is empty: add parameters.'); }
    else {
      const p = parseJSON(text);
      if (p.error) { parseError = { msg: p.error, line: p.line, col: p.col }; warn(`The schema is not valid JSON${p.line ? ` (line ${p.line}, column ${p.col})` : ''}: ${p.error}`); }
      else if (!isObj(p.value)) warn('The schema must be a JSON object.');
      else {
        let v = p.value;
        const wrap = v.input_schema ? 'an Anthropic tool' : v.inputSchema ? 'an MCP tool' : v.function?.parameters ? 'an OpenAI tool' : v.type === 'function' && v.parameters ? 'an OpenAI (Responses) tool' : v.parameters && !v.properties ? 'a function definition' : null;
        if (wrap) {
          const inner = v.input_schema || v.inputSchema || v.function?.parameters || v.parameters;
          const nm = v.name || v.function?.name; const ds = v.description || v.function?.description;
          notes.push(`Read the parameters out of ${wrap} definition${nm ? ` "${nm}"` : ''}.`);
          imported = { name: nm || null, desc: ds || '' };
          v = inner;
        }
        schema = isObj(v) ? v : null;
        if (!schema) warn('The parameters are not a JSON object.');
      }
    }
  } else {
    const r = source === 'typescript' ? fromTypeScript(input.signature, warn) : fromPython(input.signature, warn);
    if (r) {
      schema = r.schema;
      imported = { name: r.name ? r.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : null, desc: r.desc };
      notes.push(`Built from the ${source === 'typescript' ? 'TypeScript' : 'Python'} signature${r.name ? ` "${r.name}"` : ''}: ${Object.keys(schema.properties || {}).length} parameters. Check the types - a signature carries no ranges or enum meanings.`);
    }
  }
  if (!name && imported?.name) name = imported.name;
  const toolDesc = description.trim() || imported?.desc || '';
  if (!schema) schema = { type: 'object', properties: {} };

  const nodes = buildTree(schema);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lintList = [];
  lint(nodes, schema, name, toolDesc, strict, (n, m) => { n.lints.push(m); lintList.push({ node: n.id, msg: m }); });
  for (const m of nodes[0].lints) if (!lintList.some((l) => l.msg === m)) lintList.unshift({ node: '', msg: m });

  // Example call.
  const exText = String(input.example ?? '').trim();
  let exErrors = [], exParse = null, exValid = null;
  if (exText && parseError) notes.push('The example call is not checked while the schema does not parse.');
  if (exText && !parseError) {
    const p = parseJSON(exText);
    if (p.error) { exParse = `${p.error}${p.line ? ` (line ${p.line}, column ${p.col})` : ''}`; warn(`The example call is not valid JSON: ${exParse}`); }
    else {
      validate(p.value, schema, '', '', exErrors);
      exValid = exErrors.length === 0;
      for (const e of exErrors) { const n = byId.get(e.node) || nodes[0]; n.errors.push(e.msg); }
    }
  }

  // Outputs.
  const base = clone(schema);
  const aSchema = strict ? anthropicStrict(base) : base;
  const oSchema = strict ? openaiStrict(base) : base;
  const anthropic = { name: name || 'tool_name', description: toolDesc, input_schema: aSchema, ...(strict ? { strict: true } : {}) };
  const openai = { type: 'function', function: { name: name || 'tool_name', description: toolDesc, parameters: oSchema, ...(strict ? { strict: true } : {}) } };
  const mcp = { name: name || 'tool_name', title: (name || 'tool').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), description: toolDesc, inputSchema: base };
  const j = (o) => JSON.stringify(o, null, 2) + '\n';

  const params = nodes.filter((n) => n.kind === 'prop');
  const values = [
    { label: 'Parameters', value: nodes[0].children, hint: `${params.length} fields in all` },
    { label: 'Required', value: params.filter((n) => n.depth === 1 && n.required).length },
    { label: 'Deepest nesting', value: Math.max(0, ...params.map((n) => n.depth)) },
    { label: 'Lint findings', value: lintList.length, tone: lintList.length ? 'warn' : 'ok' },
    { label: 'Example call', value: exParse ? 'not JSON' : exValid == null ? '–' : exValid ? 'valid' : `${exErrors.length} error${exErrors.length > 1 ? 's' : ''}`, tone: exParse || exValid === false ? 'bad' : exValid ? 'ok' : undefined },
  ];
  values.forEach((v) => { if (v.tone === undefined) delete v.tone; });
  const tables = [
    { title: 'Parameters', columns: ['Path', 'Type', 'Required', 'Constraints', 'Default', 'Description'],
      rows: params.map((n) => [n.id, n.enum ? `${n.type} enum(${n.enum.map((v) => JSON.stringify(v)).join(', ')})` : n.type, n.required ? 'yes' : 'no', n.cons, n.def, n.desc]) },
  ];
  if (exErrors.length) tables.push({ title: 'Example call errors', columns: ['Path', 'Error'], rows: exErrors.map((e) => [e.path, e.msg]) });
  if (lintList.length) tables.push({ title: 'Lint', columns: ['Where', 'Finding'], rows: lintList.map((l) => [l.node || '(tool)', l.msg]) });
  for (const l of lintList) warnings.push(l.msg);
  for (const e of exErrors) warnings.push(`Example call ${e.path}: ${e.msg}`);

  if (strict) notes.push('Strict mode: Anthropic gets additionalProperties: false on every object and its numeric/length limits moved into the descriptions (not enforced under strict); OpenAI gets every property required, the optional ones nullable. Your own code should still check ranges.');
  notes.push(`Provider rules as of ${AS_OF}; check the Anthropic tool-use, OpenAI function-calling and MCP tools pages before relying on a keyword. OpenAI shown in the Chat Completions shape; the Responses API takes the same fields without the "function" wrapper.`);

  const tree = { sample: JSON.stringify(sample(schema), null, 2), nodes, schema, name, description: toolDesc, strict, source, parseError, exParse, exErrors, importedName: imported?.name || null };
  return {
    values, tables,
    texts: [{ title: 'Anthropic', body: j(anthropic), lang: 'json' }, { title: 'OpenAI', body: j(openai), lang: 'json' }, { title: 'MCP', body: j(mcp), lang: 'json' }],
    warnings, notes, tree,
  };
}
