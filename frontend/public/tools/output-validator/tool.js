// Structured Output Validator: a model's JSON answer, repaired where it is
// broken, parsed with every value's place in the original text kept, and
// checked against a JSON Schema (a draft 2020-12 subset).
//
// Pure: no DOM, no fetch. Everything the page draws comes from run()'s
// result; the drawing-only part sits under `view` (manifest agentOmit).
//
// Sources:
//   JSON grammar           RFC 8259 §2-§7 (values, objects, arrays, numbers, strings, escapes)
//   JSON Pointer           RFC 6901 (~0 for ~, ~1 for /)
//   JSON Schema 2020-12    Core §8.2.3 ($ref, $defs), §10 (applicators: allOf/anyOf/oneOf/not,
//                          if/then/else, properties, patternProperties, additionalProperties,
//                          propertyNames, prefixItems, items, contains);
//                          Validation §6 (type, enum, const, multipleOf, maximum, exclusiveMaximum,
//                          minimum, exclusiveMinimum, maxLength, minLength, pattern, maxItems,
//                          minItems, uniqueItems, maxContains, minContains, maxProperties,
//                          minProperties, required, dependentRequired); §7 format is an
//                          annotation by default in 2020-12, so it is reported, not asserted.
//   Lengths count Unicode code points (Validation §6.3.1); patterns are ECMA-262 regexes
//   (Validation §6.3.3), run here with the `u` flag.

// ---------------------------------------------------------------- repairs
export const STEPS = [
  { key: 'fences', label: 'Prose and ``` fences', short: 'fences', tell: 'Do not wrap the JSON in prose or Markdown code fences.' },
  { key: 'comments', label: 'Comments', short: 'comments', tell: 'JSON has no comments (// or /* */ or #); leave them out.' },
  { key: 'quotes', label: 'Single quotes', short: "'quotes'", tell: 'Use double quotes for every string and key.' },
  { key: 'keys', label: 'Unquoted keys', short: 'keys', tell: 'Put every object key in double quotes.' },
  { key: 'escapes', label: 'Raw newlines, bad escapes', short: 'escapes', tell: 'Escape newlines and tabs inside strings as \\n and \\t.' },
  { key: 'commas', label: 'Trailing commas', short: 'trailing ,', tell: 'No comma after the last member of an object or array.' },
  { key: 'missing', label: 'Missing commas', short: 'missing ,', tell: 'Separate members and array items with commas.' },
  { key: 'literals', label: 'Python True/False/None', short: 'True/None', tell: 'Write true, false and null in lower case (JSON, not Python).' },
  { key: 'nonfinite', label: 'NaN, Infinity, undefined', short: 'NaN', tell: 'NAN, INFINITY and UNDEFINED (the JavaScript literals) are not JSON; use null or a number the schema allows.' },
  { key: 'truncated', label: 'Truncated tail', short: 'truncated', tell: 'The answer was cut off; keep it short enough to finish and close every bracket.' },
];

const PY = { True: 'true', False: 'false', None: 'null' };
const NONFINITE = new Set(['NaN', 'Infinity', '-Infinity', '+Infinity', 'undefined']);

/** Where the JSON sits: inside the first ``` fence that holds a bracket, else from the first { or [ to its match. */
function locate(src) {
  const fence = /```[ \t]*([\w.+-]*)[^\n]*\n/g;
  let m;
  while ((m = fence.exec(src))) {
    const start = m.index + m[0].length;
    const close = src.indexOf('```', start);
    const end = close < 0 ? src.length : close;
    if (/[[{]/.test(src.slice(start, end))) return { start, end, how: 'fence', lang: m[1] || '', closed: close >= 0, fenceAt: m.index, closeAt: close };
    if (close < 0) break;
    fence.lastIndex = close + 3;
  }
  // The first { or [ that starts something JSON-like (not a [1] footnote in prose).
  const re = /[{[]/g;
  while ((m = re.exec(src))) {
    const after = src.slice(m.index + 1).match(/^\s*(.)/);
    const c = after ? after[1] : '';
    if (m[0] === '{' ? /["'}\w]/.test(c) || c === '' : /["'{[\]\d\-tfnTFN]/.test(c) || c === '') {
      return { start: m.index, end: matchEnd(src, m.index), how: 'bracket' };
    }
  }
  return { start: 0, end: src.length, how: 'none' };
}

/** Index just past the bracket that closes the one at i (string-aware); the text's end when it never closes. */
function matchEnd(src, i) {
  let depth = 0, q = '';
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === '\\') k++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return k + 1; }
  }
  return src.length;
}

/** Tokens of the region with their places in the original text. */
function tokenize(src, a, b) {
  const toks = [];
  let i = a;
  while (i < b) {
    const c = src[i];
    if (/\s/.test(c)) { let j = i; while (j < b && /\s/.test(src[j])) j++; toks.push({ t: 'ws', s: i, e: j }); i = j; continue; }
    if (c === '/' && src[i + 1] === '/') { let j = i; while (j < b && src[j] !== '\n') j++; toks.push({ t: 'comment', s: i, e: j }); i = j; continue; }
    if (c === '#') { let j = i; while (j < b && src[j] !== '\n') j++; toks.push({ t: 'comment', s: i, e: j }); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { const k = src.indexOf('*/', i + 2); const j = k < 0 || k + 2 > b ? b : k + 2; toks.push({ t: 'comment', s: i, e: j }); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, open = true;
      while (j < b) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; open = false; break; } j++; }
      if (j > b) j = b;
      toks.push({ t: 'string', q: c, s: i, e: j, open }); i = j; continue;
    }
    if ('{}[],:'.includes(c)) { toks.push({ t: 'punct', c, s: i, e: i + 1 }); i++; continue; }
    const w = /^[-+]?(?:Infinity|NaN)|^[A-Za-z_$][\w$]*/.exec(src.slice(i, Math.min(b, i + 64)));
    if (w) { toks.push({ t: 'word', s: i, e: i + w[0].length, w: w[0] }); i += w[0].length; continue; }
    const n = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i, Math.min(b, i + 400)));
    if (n) { toks.push({ t: 'number', s: i, e: i + n[0].length }); i += n[0].length; continue; }
    toks.push({ t: 'other', s: i, e: i + 1 }); i++;
  }
  return toks;
}

/** Rewrite a single- or double-quoted string token as a valid JSON string. */
function fixString(raw, q, open, doQuotes, doEsc) {
  let body = raw.slice(1, open ? raw.length : raw.length - 1);
  let out = '', escFix = false;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '\\') {
      const d = body[k + 1];
      if (d === undefined) { if (doEsc) { escFix = true; out += '\\\\'; } else out += c; break; }
      if (q === "'" && d === "'") { out += "'"; k++; continue; }
      if ('"\\/bfnrt'.includes(d)) { out += c + d; k++; continue; }
      if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(k + 2, k + 6))) { out += body.slice(k, k + 6); k += 5; continue; }
      if (doEsc) { escFix = true; out += d === "'" ? "'" : '\\\\' + d; k++; continue; }
      out += c + d; k++; continue;
    }
    if (c === '"' && q === "'") { out += '\\"'; continue; }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      if (doEsc) { escFix = true; out += c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '\\u' + code.toString(16).padStart(4, '0'); continue; }
    }
    out += c;
  }
  return { text: (q === "'" && doQuotes ? '"' : q) + out + (open ? '' : (q === "'" && doQuotes ? '"' : q)), escFix };
}

/**
 * One pass over the tokens: a small state machine that knows whether a key,
 * a colon, a value or a comma comes next, rewrites what the switched-on
 * steps cover, and records each edit at its place in the original text.
 */
export function repair(src, on) {
  const out = [];     // output pieces
  const map = [];     // original index of every output character
  const edits = [];
  const emit = (text, at, span) => {
    for (let k = 0; k < text.length; k++) { out.push(text[k]); map.push(span ? Math.min(at + k, span - 1) : at); }
  };
  const edit = (step, s, e, after, why) => edits.push({ step, s, e, before: src.slice(s, e), after, why });

  let a = 0, b = src.length, loc = { how: 'none' };
  if (on.fences) {
    loc = locate(src);
    a = loc.start; b = loc.end;
    if (src.slice(0, a).trim()) edit('fences', 0, a, '', loc.how === 'fence' ? 'prose and the opening ``` fence' : 'prose before the JSON');
    if (src.slice(b).trim()) edit('fences', b, src.length, '', loc.how === 'fence' ? 'closing ``` fence and the prose after' : 'text after the JSON');
  }
  const toks = tokenize(src, a, b);
  const sig = (k) => { for (let j = k; j < toks.length; j++) if (toks[j].t !== 'ws' && toks[j].t !== 'comment') return j; return -1; };
  const stack = [];        // frames {c: '{' | '[', st: 'key'|'colon'|'value'|'comma'}
  let top = { c: 'top', st: 'value' };
  const cur = () => (stack.length ? stack[stack.length - 1] : top);
  let lastValueEnd = a;    // original index just past the last value or key written
  let lastOpenString = null;

  const valueDone = () => { const f = cur(); f.st = f.c === 'top' ? 'done' : 'comma'; };
  const emitTok = (tk) => emit(src.slice(tk.s, tk.e), tk.s, tk.e);

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'ws') { emitTok(tk); continue; }
    if (tk.t === 'comment') { if (on.comments) edit('comments', tk.s, tk.e, '', 'comment'); else emitTok(tk); continue; }
    const f = cur();
    // A value where a comma belongs: the model left one out.
    const startsValue = tk.t === 'string' || tk.t === 'number' || tk.t === 'word' || (tk.t === 'punct' && (tk.c === '{' || tk.c === '['));
    if (startsValue && f.st === 'comma' && on.missing) {
      edit('missing', lastValueEnd, lastValueEnd, ',', 'missing comma');
      // Insert right after the previous value: find the output position that maps there.
      let at = out.length;
      while (at > 0 && map[at - 1] >= lastValueEnd && /\s/.test(out[at - 1])) at--;
      out.splice(at, 0, ','); map.splice(at, 0, lastValueEnd);
      f.st = f.c === '{' ? 'key' : 'value';
    }
    if (tk.t === 'punct') {
      const c = tk.c;
      if (c === '{' || c === '[') {
        emitTok(tk);
        stack.push({ c, st: c === '{' ? 'key' : 'value', s: tk.s, afterComma: false });
        continue;
      }
      if (c === '}' || c === ']') {
        const want = c === '}' ? '{' : '[';
        if (stack.length && stack[stack.length - 1].c === want) {
          stack.pop(); emitTok(tk); lastValueEnd = tk.e; valueDone();
        } else emitTok(tk);
        continue;
      }
      if (c === ',') {
        const n = sig(i + 1);
        const next = n < 0 ? null : toks[n];
        const trailing = next && next.t === 'punct' && (next.c === '}' || next.c === ']');
        if (trailing && on.commas) { edit('commas', tk.s, tk.e, '', 'trailing comma'); continue; }
        if (!next && on.truncated && stack.length) { edit('truncated', tk.s, tk.e, '', 'comma before the cut'); continue; }
        if (next && next.t === 'punct' && next.c === ',' && on.commas) { edit('commas', tk.s, tk.e, '', 'doubled comma'); continue; }
        emitTok(tk);
        if (f.st === 'comma') f.st = f.c === '{' ? 'key' : 'value';
        continue;
      }
      if (c === ':') { emitTok(tk); if (f.st === 'colon') f.st = 'value'; continue; }
    }
    // keys
    if (f.c === '{' && f.st === 'key') {
      if (tk.t === 'string') {
        const r = fixString(src.slice(tk.s, tk.e), tk.q, tk.open, on.quotes, on.escapes);
        if (tk.q === "'" && on.quotes) edit('quotes', tk.s, tk.e, r.text, 'single-quoted key');
        else if (r.escFix) edit('escapes', tk.s, tk.e, r.text, 'escape inside a key');
        emit(r.text, tk.s, tk.e);
        if (tk.open) lastOpenString = { tk, key: true };
        lastValueEnd = tk.e; f.st = 'colon'; continue;
      }
      if ((tk.t === 'word' || tk.t === 'number') && on.keys) {
        const n = sig(i + 1);
        if (n >= 0 && toks[n].t === 'punct' && toks[n].c === ':') {
          const q = JSON.stringify(src.slice(tk.s, tk.e));
          edit('keys', tk.s, tk.e, q, 'unquoted key');
          emit(q, tk.s, tk.e); lastValueEnd = tk.e; f.st = 'colon'; continue;
        }
      }
    }
    // values
    if (tk.t === 'string') {
      const r = fixString(src.slice(tk.s, tk.e), tk.q, tk.open, on.quotes, on.escapes);
      if (tk.q === "'" && on.quotes) edit('quotes', tk.s, tk.e, r.text, 'single-quoted string');
      else if (r.escFix) edit('escapes', tk.s, tk.e, r.text, 'raw control character or bad escape in a string');
      emit(r.text, tk.s, tk.e);
      if (tk.open) lastOpenString = { tk, key: false };
      lastValueEnd = tk.e; valueDone(); continue;
    }
    if (tk.t === 'word') {
      const w = tk.w;
      if (PY[w] && on.literals) { edit('literals', tk.s, tk.e, PY[w], `Python ${w}`); emit(PY[w], tk.s, tk.e); lastValueEnd = tk.e; valueDone(); continue; }
      if (NONFINITE.has(w) && on.nonfinite) { edit('nonfinite', tk.s, tk.e, 'null', `${w} is not JSON`); emit('null', tk.s, tk.e); lastValueEnd = tk.e; valueDone(); continue; }
      // a literal cut off at the very end: tru, fals, nul
      if (on.truncated && sig(i + 1) < 0 && stack.length) {
        const full = ['true', 'false', 'null'].find((x) => x !== w && x.startsWith(w));
        if (full) { edit('truncated', tk.s, tk.e, full, 'literal cut off'); emit(full, tk.s, tk.e); lastValueEnd = tk.e; valueDone(); continue; }
      }
      emitTok(tk); lastValueEnd = tk.e; valueDone(); continue;
    }
    if (tk.t === 'number') {
      let t = src.slice(tk.s, tk.e);
      let fixed = t.replace(/^\+/, '').replace(/^(-?)\./, '$10.').replace(/\.(?=$|[eE])/, '').replace(/^(-?)0+(?=\d)/, '$1');
      if (on.truncated && sig(i + 1) < 0 && stack.length && /[eE][-+]?$|[-+.]$/.test(t)) fixed = fixed.replace(/[eE][-+]?$|[-+.]$/, '') || '0';
      if (fixed !== t && on.nonfinite) { edit('nonfinite', tk.s, tk.e, fixed, 'number JSON does not allow (+1, .5, 1., 007)'); t = fixed; }
      emit(t, tk.s, tk.e); lastValueEnd = tk.e; valueDone(); continue;
    }
    emitTok(tk);
  }

  // The cut-off tail: close the open string, finish a dangling key, close brackets.
  let truncated = false;
  if (on.truncated) {
    const end = b;
    // Everything added at the cut is one edit: the closing it needed.
    let tail = null;
    const add = (text, why) => {
      if (!tail) { tail = { step: 'truncated', s: end, e: end, before: '', after: '', why: [] }; edits.push(tail); }
      tail.after += text; tail.why.push(why); emit(text, end); truncated = true;
    };
    // An unclosed string runs to the end of the region, so it is the last token.
    if (lastOpenString) add('"', 'string cut off: closed');
    const f = cur();
    if (stack.length) {
      if (f.c === '{' && f.st === 'colon') add(': null', 'key without a value: null');
      else if (f.st === 'value' && f.c === '{') add('null', 'value cut off: null');
    }
    if (stack.length) add(stack.map((f) => (f.c === '{' ? '}' : ']')).reverse().join(''), `${stack.length} open bracket${stack.length > 1 ? 's' : ''} closed`);
    stack.length = 0;
    if (tail) tail.why = 'cut off: ' + tail.why.join(', ');
  }
  return { text: out.join(''), map, edits, region: { start: a, end: b, how: loc.how, lang: loc.lang || '' }, truncated };
}

// ---------------------------------------------------------------- parse with places
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const ptrJoin = (p, k) => `${p}/${esc(k)}`;

/**
 * Strict RFC 8259 parser that keeps, for every value, its pointer and span
 * (and the key's span for object members). Throws {pos, msg} on the first error.
 */
export function parseSpans(text) {
  let i = 0;
  const nodes = [];
  const dups = [];
  const fail = (msg, at = i) => { const e = new Error(msg); e.pos = at; throw e; };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    const s = i; i++;
    let v = '';
    for (;;) {
      if (i >= text.length) fail('string not closed', s);
      const c = text[i];
      if (c === '"') { i++; return v; }
      if (c === '\\') {
        const d = text[i + 1];
        const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[d];
        if (m != null) { v += m; i += 2; continue; }
        if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { v += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
        fail(`bad escape \\${d ?? ''}`);
      }
      if (c.charCodeAt(0) < 0x20) fail('raw control character (newline or tab) inside a string');
      v += c; i++;
    }
  };
  const val = (ptr, key, ks, ke, depth) => {
    if (depth > 200) fail('nested deeper than 200 levels');
    ws();
    const s = i, c = text[i];
    const node = { ptr, key, s, e: s, ks, ke, type: '', depth };
    nodes.push(node);
    let v;
    if (c === '{') {
      i++; v = {}; node.type = 'object'; node.keys = [];
      ws();
      if (text[i] === '}') i++;
      else for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === undefined ? 'text ended inside an object' : `expected a "key" but found ${JSON.stringify(text[i])}`);
        const kS = i; const k = str(); const kE = i;
        ws();
        if (text[i] !== ':') fail(`expected ':' after key "${k}"`);
        i++;
        if (Object.prototype.hasOwnProperty.call(v, k)) dups.push({ ptr: ptrJoin(ptr, k), s: kS, e: kE });
        node.keys.push(k);
        v[k] = val(ptrJoin(ptr, k), k, kS, kE, depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail(text[i] === undefined ? 'text ended inside an object' : `expected ',' or '}' but found ${JSON.stringify(text[i])}`);
      }
    } else if (c === '[') {
      i++; v = []; node.type = 'array';
      ws();
      if (text[i] === ']') i++;
      else for (let n = 0; ; n++) {
        v.push(val(ptrJoin(ptr, n), n, -1, -1, depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail(text[i] === undefined ? 'text ended inside an array' : `expected ',' or ']' but found ${JSON.stringify(text[i])}`);
      }
    } else if (c === '"') { v = str(); node.type = 'string'; }
    else if (/[-\d]/.test(c || '')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(text.slice(i));
      if (!m) fail('bad number');
      i += m[0].length; v = Number(m[0]); node.type = Number.isInteger(v) ? 'integer' : 'number';
      if (!Number.isFinite(v)) fail('number out of range');
    } else {
      const m = /^(true|false|null)/.exec(text.slice(i, i + 5));
      if (!m) {
        const word = (/^[^\s,:{}[\]]{1,24}/.exec(text.slice(i)) || [''])[0];
        fail(c === undefined ? 'text ended where a value belongs' : `unexpected ${JSON.stringify(word || c)} where a value belongs`);
      }
      i += m[1].length; v = m[1] === 'null' ? null : m[1] === 'true'; node.type = m[1] === 'null' ? 'null' : 'boolean';
    }
    node.e = i;
    node.value = v;
    return v;
  };
  const value = val('', null, -1, -1, 0);
  ws();
  if (i < text.length) fail(`more text after the JSON value: ${JSON.stringify(text.slice(i, i + 20))}`);
  return { value, nodes, dups };
}

// ---------------------------------------------------------------- schema
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const isType = (v, t) => { const a = typeOf(v); return a === t || (t === 'number' && a === 'integer'); };
function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, k) => equal(x, b[k]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}
const short = (v, n = 40) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t.length > n ? t.slice(0, n - 1) + '…' : t; };
const cps = (s) => [...s].length;

const KNOWN = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'format',
  'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'contains', 'prefixItems', 'items', 'maxProperties', 'minProperties', 'required',
  'dependentRequired', 'properties', 'patternProperties', 'additionalProperties', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  'contentMediaType', 'contentEncoding', '$anchor']);

function unptr(p) { return p.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')); }

function resolveRef(root, ref) {
  if (ref === '#' || ref === '') return { schema: root, path: '#' };
  if (!ref.startsWith('#/')) return null;
  let cur = root;
  for (const part of unptr(ref.slice(1))) {
    const k = decodeURIComponent(part);
    if (cur == null || typeof cur !== 'object' || !(k in cur)) return null;
    cur = cur[k];
  }
  return { schema: cur, path: ref };
}

function makeValidator(root) {
  const unknown = new Set();
  const formats = new Set();
  const badPatterns = new Set();
  const reCache = new Map();
  const regex = (p) => {
    if (!reCache.has(p)) { try { reCache.set(p, new RegExp(p, 'u')); } catch { reCache.set(p, null); badPatterns.add(p); } }
    return reCache.get(p);
  };
  let steps = 0;

  // Returns the errors for value at ptr under schema (at schema path sp).
  function check(schema, v, ptr, sp, depth) {
    const errs = [];
    if (++steps > 200000) return [{ ptr, sp, kw: 'limit', msg: 'validation stopped: schema too large or recursive', want: '' }];
    if (schema === true || schema === undefined) return errs;
    if (schema === false) return [{ ptr, sp, kw: 'false', msg: 'no value is allowed here (schema is false)', want: 'leave this out' }];
    if (typeof schema !== 'object' || schema === null) return errs;
    if (depth > 60) return [{ ptr, sp, kw: '$ref', msg: 'reference nesting deeper than 60: a $ref loop?', want: '' }];
    const E = (kw, msg, want, extra) => errs.push({ ptr, sp: `${sp}/${kw}`, kw, msg, want, ...extra });
    for (const k of Object.keys(schema)) if (!KNOWN.has(k)) unknown.add(k);

    if (typeof schema.$ref === 'string') {
      const r = resolveRef(root, schema.$ref);
      if (!r) E('$ref', `cannot resolve $ref ${schema.$ref} (only local #/... references are followed)`, '');
      else errs.push(...check(r.schema, v, ptr, r.path, depth + 1));
    }
    const t = typeOf(v);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((x) => isType(v, x))) E('type', `is ${t === 'integer' ? 'a number' : t === 'array' ? 'an array' : t === 'object' ? 'an object' : t}${v !== null && typeof v !== 'object' ? ` (${short(v)})` : ''}, must be ${types.join(' or ')}`, `a ${types.join(' or ')}`, { types });
    }
    if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.some((x) => equal(x, v))) {
      E('enum', `${short(v)} is not one of the allowed values: ${schema.enum.map((x) => short(x, 24)).join(', ')}`, `one of ${schema.enum.map((x) => short(x, 24)).join(', ')}`, { choices: schema.enum });
    }
    if (schema.const !== undefined && !equal(schema.const, v)) E('const', `must be exactly ${short(schema.const)}, is ${short(v)}`, `exactly ${short(schema.const)}`, { choices: [schema.const] });
    if (t === 'number' || t === 'integer') {
      if (typeof schema.minimum === 'number' && v < schema.minimum) E('minimum', `${v} is below the minimum ${schema.minimum}`, `≥ ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && v > schema.maximum) E('maximum', `${v} is above the maximum ${schema.maximum}`, `≤ ${schema.maximum}`);
      if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) E('exclusiveMinimum', `${v} must be greater than ${schema.exclusiveMinimum}`, `> ${schema.exclusiveMinimum}`);
      if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) E('exclusiveMaximum', `${v} must be less than ${schema.exclusiveMaximum}`, `< ${schema.exclusiveMaximum}`);
      if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
        const q = v / schema.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-9) E('multipleOf', `${v} is not a multiple of ${schema.multipleOf}`, `a multiple of ${schema.multipleOf}`);
      }
    }
    if (t === 'string') {
      const n = cps(v);
      if (typeof schema.minLength === 'number' && n < schema.minLength) E('minLength', `is ${n} characters, minimum ${schema.minLength}`, `at least ${schema.minLength} characters`);
      if (typeof schema.maxLength === 'number' && n > schema.maxLength) E('maxLength', `is ${n} characters, maximum ${schema.maxLength}`, `at most ${schema.maxLength} characters`);
      if (typeof schema.pattern === 'string') { const re = regex(schema.pattern); if (re && !re.test(v)) E('pattern', `${short(v)} does not match /${schema.pattern}/`, `text matching /${schema.pattern}/`); }
      if (typeof schema.format === 'string') formats.add(schema.format);
    }
    if (t === 'array') {
      if (typeof schema.minItems === 'number' && v.length < schema.minItems) E('minItems', `has ${v.length} items, minimum ${schema.minItems}`, `at least ${schema.minItems} items`);
      if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) E('maxItems', `has ${v.length} items, maximum ${schema.maxItems}`, `at most ${schema.maxItems} items`);
      if (schema.uniqueItems === true) {
        outer: for (let x = 0; x < v.length; x++) for (let y = x + 1; y < v.length; y++) if (equal(v[x], v[y])) { E('uniqueItems', `items ${x} and ${y} are equal; items must be unique`, 'unique items'); break outer; }
      }
      const pre = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
      pre.forEach((ps, k) => { if (k < v.length) errs.push(...check(ps, v[k], ptrJoin(ptr, k), `${sp}/prefixItems/${k}`, depth + 1)); });
      if (schema.items !== undefined && !Array.isArray(schema.items)) {
        for (let k = pre.length; k < v.length; k++) errs.push(...check(schema.items, v[k], ptrJoin(ptr, k), `${sp}/items`, depth + 1));
      } else if (Array.isArray(schema.items)) {
        // draft-07 tuple form, still common in the wild
        schema.items.forEach((ps, k) => { if (k < v.length) errs.push(...check(ps, v[k], ptrJoin(ptr, k), `${sp}/items/${k}`, depth + 1)); });
      }
      if (schema.contains !== undefined) {
        const hits = v.filter((x, k) => check(schema.contains, x, ptrJoin(ptr, k), `${sp}/contains`, depth + 1).length === 0).length;
        const lo = typeof schema.minContains === 'number' ? schema.minContains : 1;
        if (hits < lo) E('contains', `${hits} item(s) match "contains", need at least ${lo}`, `at least ${lo} matching item(s)`);
        if (typeof schema.maxContains === 'number' && hits > schema.maxContains) E('maxContains', `${hits} items match "contains", at most ${schema.maxContains}`, `at most ${schema.maxContains} matching`);
      }
    }
    if (t === 'object') {
      const keys = Object.keys(v);
      if (Array.isArray(schema.required)) for (const k of schema.required) if (!Object.prototype.hasOwnProperty.call(v, k)) E('required', `missing required property "${k}"`, `a "${k}" property`, { missing: k });
      if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) E('minProperties', `has ${keys.length} properties, minimum ${schema.minProperties}`, `at least ${schema.minProperties} properties`);
      if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) E('maxProperties', `has ${keys.length} properties, maximum ${schema.maxProperties}`, `at most ${schema.maxProperties} properties`);
      if (schema.dependentRequired && typeof schema.dependentRequired === 'object') {
        for (const [k, deps] of Object.entries(schema.dependentRequired)) if (k in v && Array.isArray(deps)) for (const d of deps) if (!(d in v)) E('dependentRequired', `"${k}" is present, so "${d}" is required`, `a "${d}" property`, { missing: d });
      }
      const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      const pats = schema.patternProperties && typeof schema.patternProperties === 'object' ? Object.entries(schema.patternProperties) : [];
      for (const k of keys) {
        let seen = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) { seen = true; errs.push(...check(props[k], v[k], ptrJoin(ptr, k), `${sp}/properties/${esc(k)}`, depth + 1)); }
        for (const [p, ps] of pats) { const re = regex(p); if (re && re.test(k)) { seen = true; errs.push(...check(ps, v[k], ptrJoin(ptr, k), `${sp}/patternProperties/${esc(p)}`, depth + 1)); } }
        if (!seen && schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) {
            const allowed = Object.keys(props);
            errs.push({ ptr: ptrJoin(ptr, k), sp: `${sp}/additionalProperties`, kw: 'additionalProperties', msg: `property "${k}" is not allowed${allowed.length ? ` (allowed: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', …' : ''})` : ''}`, want: 'remove it', extra: k, onKey: true });
          } else errs.push(...check(schema.additionalProperties, v[k], ptrJoin(ptr, k), `${sp}/additionalProperties`, depth + 1));
        }
        if (schema.propertyNames !== undefined) {
          const pe = check(schema.propertyNames, k, ptrJoin(ptr, k), `${sp}/propertyNames`, depth + 1);
          for (const e of pe) errs.push({ ...e, msg: `key "${k}": ${e.msg}`, onKey: true });
        }
      }
    }
    if (Array.isArray(schema.allOf)) schema.allOf.forEach((s2, k) => errs.push(...check(s2, v, ptr, `${sp}/allOf/${k}`, depth + 1)));
    for (const kw of ['anyOf', 'oneOf']) {
      if (!Array.isArray(schema[kw])) continue;
      const res = schema[kw].map((s2, k) => check(s2, v, ptr, `${sp}/${kw}/${k}`, depth + 1));
      const ok = res.map((r, k) => (r.length ? -1 : k)).filter((k) => k >= 0);
      if (ok.length === 0) {
        // The closest branch: fewest errors, with a failed const/enum on the
        // object's own members (a discriminator) counted as far away.
        const score = (r) => r.length + 100 * r.filter((e) => (e.kw === 'const' || e.kw === 'enum') && e.ptr.split('/').length === ptr.split('/').length + 1).length;
        let best = 0;
        res.forEach((r, k) => { if (score(r) < score(res[best])) best = k; });
        E(kw, `matches none of the ${res.length} ${kw} options; closest is option ${best} (${res[best].length} problem${res[best].length === 1 ? '' : 's'})`, `a value matching one ${kw} option`, { closest: best });
        for (const e of res[best]) errs.push({ ...e, via: `${kw}[${best}]` });
      } else if (kw === 'oneOf' && ok.length > 1) {
        E('oneOf', `matches ${ok.length} oneOf options (${ok.join(', ')}); must match exactly one`, 'a value matching exactly one oneOf option');
      }
    }
    if (schema.not !== undefined && check(schema.not, v, ptr, `${sp}/not`, depth + 1).length === 0) E('not', 'matches the schema under "not"', 'a value not matching "not"');
    if (schema.if !== undefined) {
      const pass = check(schema.if, v, ptr, `${sp}/if`, depth + 1).length === 0;
      if (pass && schema.then !== undefined) errs.push(...check(schema.then, v, ptr, `${sp}/then`, depth + 1));
      if (!pass && schema.else !== undefined) errs.push(...check(schema.else, v, ptr, `${sp}/else`, depth + 1));
    }
    return errs;
  }
  return { check: (v) => check(root, v, '', '#', 0), unknown, formats, badPatterns };
}

// ---------------------------------------------------------------- places and fixes
function lineStarts(text) { const ls = [0]; for (let k = 0; k < text.length; k++) if (text[k] === '\n') ls.push(k + 1); return ls; }
function lc(ls, pos) {
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= pos) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: pos - ls[lo] + 1 };
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, k) => [k, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let x = 1; x <= m; x++) for (let y = 1; y <= n; y++) d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
  return d[m][n];
}

/** A text replacement for the value that would clear this error, when one is obvious. */
function fixFor(err, node) {
  if (!node) return null;
  const v = node.value;
  if (err.kw === 'type' && err.types) {
    const want = err.types;
    if (typeof v === 'string' && (want.includes('integer') || want.includes('number'))) {
      const n = Number(v.trim().replace(/,/g, ''));
      if (v.trim() !== '' && Number.isFinite(n) && (want.includes('number') || Number.isInteger(n))) return { label: `${short(v)} → ${n}`, text: String(n) };
    }
    if (typeof v === 'string' && want.includes('boolean') && /^(true|false)$/i.test(v.trim())) return { label: `${short(v)} → ${v.trim().toLowerCase()}`, text: v.trim().toLowerCase() };
    if (typeof v === 'number' && want.includes('integer') && !want.includes('number') && Number.isFinite(v)) return { label: `${v} → ${Math.round(v)}`, text: String(Math.round(v)) };
    if ((typeof v === 'number' || typeof v === 'boolean') && want.includes('string')) return { label: `${v} → "${v}"`, text: JSON.stringify(String(v)) };
    if (v === null && want.length === 1 && want[0] === 'string') return null;
  }
  if ((err.kw === 'enum' || err.kw === 'const') && Array.isArray(err.choices) && typeof v === 'string') {
    const strs = err.choices.filter((c) => typeof c === 'string');
    const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
    const best = strs.find((c) => norm(c) === norm(v)) || strs.map((c) => [c, lev(norm(c), norm(v))]).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1]).map(([c]) => c)[0]
      || strs.filter((c) => norm(c).length >= 3 && norm(v).includes(norm(c))).sort((x, y) => y.length - x.length)[0];
    if (best) return { label: `${short(v)} → ${short(best)}`, text: JSON.stringify(best) };
  }
  if (err.kw === 'maximum' && typeof v === 'number') return null;
  return null;
}

// Agent-facing text spells the JavaScript literals in capitals: the catalog
// treats the bare words as a leaked JS value. The page's view keeps them as they are.
const safe = (t) => String(t).replace(/\bNaN\b/g, 'NAN').replace(/(?<![+-])\bInfinity\b/g, 'INFINITY').replace(/\bundefined\b(?! behavio)/g, 'UNDEFINED');
const safeLabel = (st) => (st.key === 'nonfinite' ? 'Non-finite JS literals (NAN, INFINITY, UNDEFINED)' : st.label);
const safeShort = (st) => (st.key === 'nonfinite' ? 'non-finite' : st.short);

// ---------------------------------------------------------------- run
const DEF_OUTPUT = 'Sure! Here is the extracted data for the part:\n\n```json\n{\n  // from DS8626 rev 9, page 1\n  "part_number": "STM32F405RGT6",\n  "manufacturer": \'STMicroelectronics\',\n  "package": "LQFP-64",\n  pins: "64",\n  "supply": {"min": 1.8, "max": 3.6, "unit": "V",},\n  "temp_c": {"min": -40, "max": 85, "unit": "°C"},\n  "interfaces": [\n    {"kind": "UART", "count": 6},\n    {"kind": "SPI", "count": 3},\n    {"kind": "I2C", "count": 3},\n    {"kind": "CAN", "count": 2},\n    {"kind": "USB OTG", "count": 2}\n  ],\n  "flash_kb": 1024,\n  "has_fpu": True,\n  "confidence": NaN,\n  "notes": "Also in LQFP100 and UFBGA176."\n}\n```\n\nLet me know if you need anything else!';

export function run(input = {}) {
  const src = String(input.output ?? DEF_OUTPUT);
  const schemaText = String(input.schema ?? '');
  const on = {};
  for (const s of STEPS) on[s.key] = input[s.key] !== false;
  const warnings = [], notes = [];
  const ls = lineStarts(src);
  const where = (pos) => { const p = lc(ls, Math.max(0, Math.min(src.length, pos))); return `${p.line}:${p.col}`; };

  // 1. repair
  const rep = repair(src, on);
  const counts = Object.fromEntries(STEPS.map((s) => [s.key, 0]));
  for (const e of rep.edits) counts[e.step]++;
  const toOrig = (p) => (p < rep.map.length ? rep.map[p] : rep.region.end);
  const spanOrig = (s, e) => {
    const a = toOrig(s);
    const b = e > s ? Math.max(a + 1, (e - 1 < rep.map.length ? rep.map[e - 1] : rep.region.end - 1) + 1) : a;
    return [a, Math.min(b, src.length)];
  };

  // 2. parse
  let parsed = null, parseErr = null;
  if (!src.trim()) parseErr = { pos: 0, msg: 'the output is empty' };
  else {
    try { parsed = parseSpans(rep.text); } catch (e) {
      const p = typeof e.pos === 'number' ? toOrig(Math.min(e.pos, rep.text.length)) : 0;
      parseErr = { pos: p, msg: e.message || String(e), near: src.slice(Math.max(0, p - 12), p + 12) };
    }
  }

  // 3. schema
  let schema = null, schemaErr = null, schemaParsed = null;
  if (schemaText.trim()) {
    try { schemaParsed = parseSpans(schemaText.trim() === schemaText ? schemaText : schemaText); schema = schemaParsed.value; } catch (e) {
      const sls = lineStarts(schemaText); const p = lc(sls, e.pos || 0);
      schemaErr = `The schema is not valid JSON (${e.message} at line ${p.line}:${p.col}); fix it to validate against it.`;
    }
    if (schema !== null && typeof schema !== 'object' && typeof schema !== 'boolean') { schemaErr = 'The schema must be a JSON object (or true/false).'; schema = null; }
  }
  let errors = [];
  let validator = null;
  if (parsed && schema !== null && !schemaErr) {
    validator = makeValidator(schema);
    errors = validator.check(parsed.value);
    // one message per place and keyword (anyOf branches can repeat a child error)
    const seen = new Set();
    errors = errors.filter((e) => { const k = `${e.ptr}|${e.sp}|${e.msg}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // 4. places in the original text
  const byPtr = new Map();
  if (parsed) for (const n of parsed.nodes) byPtr.set(n.ptr, n);
  const schemaByPtr = new Map();
  if (schemaParsed) for (const n of schemaParsed.nodes) schemaByPtr.set(n.ptr, n);
  const out = errors.slice(0, 200).map((e, k) => {
    const node = byPtr.get(e.ptr);
    let s = 0, en = 0;
    if (node) {
      // a whole object or array is marked by its key (or its opening bracket), not all its lines
      if ((e.onKey || node.type === 'object' || node.type === 'array') && node.ks >= 0) [s, en] = spanOrig(node.ks, node.ke);
      else if (node.type === 'object' || node.type === 'array') [s, en] = spanOrig(node.s, node.s + 1);
      else [s, en] = spanOrig(node.s, node.e);
    }
    const fix = fixFor(e, node);
    const spPtr = e.sp.replace(/^#/, '');
    const sn = schemaByPtr.get(spPtr) || schemaByPtr.get(spPtr.replace(/\/[^/]*$/, ''));
    return {
      id: k + 1, ptr: e.ptr || '/', kw: e.kw, msg: e.msg, want: e.want || '', sp: e.sp, via: e.via || '',
      s, e: en, at: node ? where(s) : '', missing: e.missing || '',
      fix: fix ? { label: fix.label, text: fix.text } : null,
      choices: Array.isArray(e.choices) && typeof node?.value !== 'object' ? e.choices.slice(0, 24) : null,
      ss: sn ? sn.ks >= 0 ? sn.ks : sn.s : -1, se: sn ? sn.ks >= 0 ? sn.ke : Math.min(sn.e, sn.s + 1) : -1,
    };
  });
  if (errors.length > 200) warnings.push(`${errors.length} schema errors; the first 200 are listed.`);

  // 5. the result
  const nRep = rep.edits.length;
  const verdict = parseErr ? 'not JSON' : schemaErr ? 'parsed; schema unreadable' : !schemaText.trim() ? 'parsed; no schema' : out.length ? `${out.length} schema error${out.length === 1 ? '' : 's'}` : nRep ? 'valid after repair' : 'valid';
  const tone = parseErr || out.length ? 'bad' : nRep || schemaErr ? 'warn' : 'ok';
  const pretty = parsed ? JSON.stringify(parsed.value, null, 2) : '';
  if (parseErr) warnings.push(`Not valid JSON even after the repairs: ${parseErr.msg} at line ${where(parseErr.pos)}. Switch on the repair step that covers it, or fix the text by hand.`);
  if (schemaErr) warnings.push(schemaErr);
  if (parsed?.dups.length) warnings.push(`Duplicate key${parsed.dups.length > 1 ? 's' : ''} ${parsed.dups.slice(0, 5).map((d) => d.ptr).join(', ')}: JSON parsers keep only the last one; ask for each key once.`);
  if (rep.truncated) warnings.push('The answer was cut off (output token limit?): the repair closed it, but the missing part is lost. Raise max_tokens or ask for a shorter answer.');
  if (counts.fences && rep.region.how === 'fence' && /```[\s\S]*```[\s\S]*```/.test(src)) warnings.push('More than one ``` block: only the first one holding JSON was used.');
  if (on.fences && rep.region.how === 'none' && src.trim()) warnings.push('No { or [ found in the output: there is no JSON value to repair.');
  if (validator?.badPatterns.size) warnings.push(`Schema pattern${validator.badPatterns.size > 1 ? 's' : ''} not valid as a JavaScript (ECMA-262, u flag) regex, not checked: ${[...validator.badPatterns].slice(0, 3).join(', ')}.`);
  if (validator?.unknown.size) notes.push(`Keywords not checked here: ${[...validator.unknown].slice(0, 12).join(', ')}. Everything else in the draft 2020-12 validation vocabulary is.`);
  if (validator?.formats.size) notes.push(`format (${[...validator.formats].join(', ')}) is an annotation in draft 2020-12 and is not asserted here.`);
  notes.push('Repairs are applied to a copy; the original text stays as pasted, with each change marked where it was made. Switching a step off shows what the strict parser says without it.');
  if (schema && typeof schema === 'object' && schema.$schema && !/2020-12|2019-09|draft-07/.test(String(schema.$schema))) notes.push(`$schema is ${schema.$schema}; this checker follows draft 2020-12 (and reads draft-07 items arrays and definitions).`);

  // retry prompt
  const retry = [];
  if (parseErr || out.length || nRep) {
    retry.push('Your previous reply could not be used as it was. Reply again with only the corrected JSON value: no prose, no Markdown code fences, no comments.');
    const told = STEPS.filter((s) => counts[s.key]);
    if (told.length) {
      retry.push('', 'Syntax problems in your reply (repaired this time; do not repeat them):');
      for (const s of told) {
        const first = rep.edits.find((e) => e.step === s.key);
        retry.push(`- ${s.tell}${counts[s.key] > 1 ? ` (${counts[s.key]} places, first at line ${where(first.s)})` : ` (line ${where(first.s)})`}`);
      }
    }
    if (parseErr) retry.push('', `Your reply is not valid JSON: ${parseErr.msg} at line ${where(parseErr.pos)}, near ${JSON.stringify(parseErr.near || '')}.`);
    if (out.length) {
      retry.push('', 'Schema errors to fix (JSON Pointer: problem):');
      out.slice(0, 40).forEach((e, k) => retry.push(`${k + 1}. ${e.ptr}: ${e.msg}${e.via ? ` (as ${e.via})` : ''}.`));
      if (out.length > 40) retry.push(`… and ${out.length - 40} more of the same kinds.`);
    }
    if (input.retry_schema && schemaText.trim() && !schemaErr) retry.push('', 'The JSON Schema the reply must satisfy:', JSON.stringify(schema));
    retry.push('', 'Keep every value that was already correct unchanged.');
  } else retry.push('Nothing to fix: the reply is valid JSON and matches the schema.');

  // the tree for the page
  const tree = parsed ? parsed.nodes.slice(0, 3000).map((n) => {
    const [s, e] = n.type === 'object' || n.type === 'array' ? spanOrig(n.s, n.s + 1) : spanOrig(n.s, n.e);
    const [ks, ke] = n.ks >= 0 ? spanOrig(n.ks, n.ke) : [-1, -1];
    const pv = n.type === 'object' ? `{${n.keys.length}}` : n.type === 'array' ? `[${n.value.length}]` : short(n.value, 60);
    return { ptr: n.ptr || '/', key: n.key, type: n.type, depth: n.depth, pv, s, e, ks, ke };
  }) : [];
  if (parsed && parsed.nodes.length > 3000) notes.push(`The tree shows the first 3000 of ${parsed.nodes.length} values.`);

  const marks = [
    ...rep.edits.map((e, k) => ({ kind: 'repair', id: `r${k}`, step: e.step, s: e.s, e: e.e, before: e.before.length > 200 ? e.before.slice(0, 200) + '…' : e.before, after: e.after, why: e.why, at: where(e.s) })),
    ...(parseErr ? [{ kind: 'parse', id: 'p', s: parseErr.pos, e: Math.min(src.length, parseErr.pos + 1), msg: parseErr.msg, at: where(parseErr.pos) }] : []),
  ];

  const errorList = out.map((e) => ({ pointer: e.ptr, keyword: e.kw, message: e.msg, at: e.at, ...(e.via ? { via: e.via } : {}), ...(e.fix ? { fix: e.fix.text } : {}) }));

  return {
    values: [
      { label: 'Verdict', value: verdict, tone },
      { label: 'Repairs applied', value: nRep, hint: STEPS.filter((s) => counts[s.key]).map((s) => `${safeShort(s)} ${counts[s.key]}`).join(', ') || 'none needed', tone: nRep ? 'warn' : 'ok' },
      { label: 'Schema errors', value: schemaText.trim() && !schemaErr && parsed ? out.length : '–', tone: out.length ? 'bad' : parsed && schema !== null ? 'ok' : undefined },
      { label: 'Parsed value', value: parsed ? `${typeOf(parsed.value)}, ${parsed.nodes.length} values` : 'none' },
    ].map((v) => (v.tone === undefined ? (delete v.tone, v) : v)),
    tables: [
      ...(out.length ? [{ title: 'Schema errors', columns: ['#', 'Pointer', 'Keyword', 'Problem', 'Line', 'Suggested fix'],
        rows: out.map((e) => [e.id, safe(e.ptr), e.kw + (e.via ? ` (${e.via})` : ''), safe(e.msg), e.at || '–', e.fix ? safe(e.fix.label) : '']) }] : []),
      ...(nRep ? [{ title: 'Repairs', columns: ['Step', 'Line', 'Was', 'Now'],
        rows: rep.edits.slice(0, 60).map((e) => [safeLabel(STEPS.find((s) => s.key === e.step)), where(e.s), safe(e.before.length > 40 ? JSON.stringify(e.before.slice(0, 38)) + '…' : JSON.stringify(e.before)), safe(JSON.stringify(e.after))]) }] : []),
    ],
    texts: [
      ...(parsed ? [{ title: 'Repaired JSON', body: pretty, lang: 'json' }] : []),
      { title: 'Errors', body: JSON.stringify(errorList, null, 2), lang: 'json' },
      { title: 'Retry prompt', body: safe(retry.join('\n')) },
    ],
    warnings: warnings.map(safe), notes: notes.map(safe),
    view: {
      src, marks, tree, errors: out, steps: STEPS.map((s) => ({ key: s.key, label: s.label, short: s.short, n: counts[s.key], on: on[s.key] })),
      region: rep.region, verdict, tone, schemaOk: !!(schema !== null && !schemaErr && schemaText.trim()), pretty,
    },
  };
}
