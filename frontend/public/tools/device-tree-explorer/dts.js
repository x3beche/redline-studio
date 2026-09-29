// Device tree source, read the way cpp + dtc read it: a C preprocessor pass
// (#include, #define with arguments, #if/#ifdef), then dtc's grammar
// (dtc/dtc-parser.y, dtc/dtc-lexer.l): /dts-v1/, labels, &label and &{/path}
// node references, /delete-node/, /delete-property/, property values made of
// "strings", <cells> (with /bits/ and (expressions)), [bytes] and &refs, and
// overlays (/plugin/ with &label { } or fragment@N { target = <&x>;
// __overlay__ { } }). Pure: no DOM, runs in the browser and in Node.

// ---------------------------------------------------------------------------
// C preprocessor (the subset DTS files use)
// ---------------------------------------------------------------------------

/** Remove comments, keeping every newline so line numbers stay true. */
function stripComments(text) {
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const body = text.slice(i, end < 0 ? n : end + 2);
      out += ' ' + body.replace(/[^\n]/g, '');
      i = end < 0 ? n : end + 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const IDENT = /[A-Za-z_]/;
const IDCH = /[A-Za-z0-9_]/;

/** Split "a, (b, c), d" at top-level commas. */
function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      cur += s.slice(i, j + 1); i = j; continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

/** Expand macros in one line of text, the way cpp does (recursion-safe). */
export function expandMacros(text, macros, hide = new Set(), depth = 0, used = null) {
  if (depth > 40) return text;
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < n && /[0-9A-Za-z_.]/.test(text[j])) j++;
      out += text.slice(i, j); i = j; continue;
    }
    if (!IDENT.test(c)) { out += c; i++; continue; }
    let j = i; while (j < n && IDCH.test(text[j])) j++;
    const name = text.slice(i, j);
    const m = macros.get(name);
    if (!m || hide.has(name)) { out += name; i = j; continue; }
    if (m.params) {
      let k = j; while (k < n && /\s/.test(text[k])) k++;
      if (text[k] !== '(') { out += name; i = j; continue; }
      let d = 0, e = k;
      for (; e < n; e++) {
        if (text[e] === '(') d++;
        else if (text[e] === ')') { d--; if (d === 0) break; }
      }
      if (e >= n) { out += name; i = j; continue; }   // unbalanced: leave as written
      const args = splitArgs(text.slice(k + 1, e));
      const argx = args.map((a) => expandMacros(a, macros, hide, depth + 1, used));
      let body = m.body;
      // #param (stringize) and a ## b (paste), then plain substitution
      body = body.replace(/#\s*([A-Za-z_]\w*)/g, (all, p) => {
        const ix = m.params.indexOf(p); return ix >= 0 ? JSON.stringify(args[ix] ?? '') : all;
      });
      body = body.replace(/[A-Za-z_]\w*/g, (w) => {
        const ix = m.params.indexOf(w); return ix >= 0 ? (argx[ix] ?? '') : w;
      });
      body = body.replace(/\s*##\s*/g, '');
      if (used) used.add(name);
      const h2 = new Set(hide); h2.add(name);
      out += expandMacros(body, macros, h2, depth + 1, used);
      i = e + 1;
    } else {
      if (used) used.add(name);
      const h2 = new Set(hide); h2.add(name);
      out += expandMacros(m.body, macros, h2, depth + 1, used);
      i = j;
    }
  }
  return out;
}

const DIRECTIVE = /^\s*#\s*(include|define|undef|ifdef|ifndef|if|elif|else|endif|error|warning|pragma|line)(?![\w-])\s*(.*)$/;

/**
 * Run the preprocessor over the main file and whatever it includes.
 * files: [{name, text}], headers: {path: text}
 * -> {lines: [{text, file, line}], macros, problems, included, missing}
 */
export function preprocess(mainName, files, headers = {}, macros = new Map()) {
  const lines = [];
  const problems = [];
  const included = [];
  const missing = [];
  const find = (want) => {
    if (headers[want] != null) return { name: want, text: headers[want], header: true };
    const base = want.split('/').pop();
    const f = files.find((x) => x.name === want) || files.find((x) => x.name.split('/').pop() === base);
    return f ? { name: f.name, text: f.text, header: false } : null;
  };
  const evalIf = (expr, file, line) => {
    let e = expr.replace(/\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, x) => (macros.has(x) ? '1' : '0'))
      .replace(/\bdefined\s+([A-Za-z_]\w*)/g, (_, x) => (macros.has(x) ? '1' : '0'));
    e = expandMacros(e, macros).replace(/\b[A-Za-z_]\w*\b/g, '0');
    try { return evalExpr(e) !== 0n; } catch {
      problems.push({ sev: 'warn', file, line, msg: `could not evaluate #if ${expr.trim()} - treated as false` });
      return false;
    }
  };
  const run = (name, text, depth) => {
    if (depth > 12) { problems.push({ sev: 'error', file: name, line: 1, msg: 'includes nest deeper than 12 - is a file including itself?' }); return; }
    const raw = stripComments(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n');
    const stack = [];   // {on, done, outer}
    const active = () => stack.every((s) => s.on);
    for (let k = 0; k < raw.length; k++) {
      let t = raw[k];
      const lineNo = k + 1;
      // a directive may continue over backslash-newlines
      if (DIRECTIVE.test(t)) {
        while (/\\\s*$/.test(t) && k + 1 < raw.length) { t = t.replace(/\\\s*$/, ' ') + raw[++k]; }
      }
      const d = DIRECTIVE.exec(t);
      if (d) {
        const [, kw, rest] = d;
        if (kw === 'ifdef' || kw === 'ifndef') {
          const on = macros.has(rest.trim().split(/\s+/)[0]) === (kw === 'ifdef');
          stack.push({ on, done: on });
        } else if (kw === 'if') {
          const on = active() ? evalIf(rest, name, lineNo) : false;
          stack.push({ on, done: on });
        } else if (kw === 'elif') {
          const top = stack[stack.length - 1];
          if (!top) problems.push({ sev: 'warn', file: name, line: lineNo, msg: '#elif without #if' });
          else if (top.done) top.on = false;
          else { top.on = evalIf(rest, name, lineNo); top.done = top.on; }
        } else if (kw === 'else') {
          const top = stack[stack.length - 1];
          if (!top) problems.push({ sev: 'warn', file: name, line: lineNo, msg: '#else without #if' });
          else { top.on = !top.done; top.done = true; }
        } else if (kw === 'endif') {
          if (!stack.length) problems.push({ sev: 'warn', file: name, line: lineNo, msg: '#endif without #if' });
          stack.pop();
        } else if (!active()) {
          // skipped branch
        } else if (kw === 'include') {
          const m = /^[<"]([^>"]+)[>"]/.exec(rest.trim());
          if (!m) problems.push({ sev: 'error', file: name, line: lineNo, msg: `#include ${rest.trim()} is not "file" or <file>` });
          else {
            const f = find(m[1]);
            if (!f) {
              missing.push(m[1]);
              problems.push({ sev: m[1].startsWith('dt-bindings/') ? 'warn' : 'error', file: name, line: lineNo,
                msg: m[1].startsWith('dt-bindings/')
                  ? `header <${m[1]}> is not bundled: macros from it stay unresolved - paste it as a file tab named ${m[1]}`
                  : `#include "${m[1]}" is not among the files - add it as a tab named ${m[1].split('/').pop()}` });
            } else {
              if (!f.header && !included.includes(f.name)) included.push(f.name);
              run(f.name, f.text, depth + 1);
            }
          }
        } else if (kw === 'define') {
          const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
          if (m) macros.set(m[1], { params: m[2] ? m[3].split(',').map((x) => x.trim()).filter(Boolean) : null, body: m[4].trim(), file: name, line: lineNo });
        } else if (kw === 'undef') {
          macros.delete(rest.trim());
        } else if (kw === 'error') {
          problems.push({ sev: 'error', file: name, line: lineNo, msg: `#error ${rest.trim()}` });
        }
        continue;
      }
      if (!active()) continue;
      // dtc's own include
      const di = /^\s*\/include\/\s*"([^"]+)"\s*$/.exec(t);
      if (di) {
        const f = find(di[1]);
        if (!f) { missing.push(di[1]); problems.push({ sev: 'error', file: name, line: lineNo, msg: `/include/ "${di[1]}" is not among the files` }); }
        else { if (!f.header && !included.includes(f.name)) included.push(f.name); run(f.name, f.text, depth + 1); }
        continue;
      }
      lines.push({ text: /[A-Za-z_]/.test(t) ? expandMacros(t, macros) : t, file: name, line: lineNo });
    }
    if (stack.length) problems.push({ sev: 'warn', file: name, line: raw.length, msg: `${stack.length} #if/#ifdef not closed by #endif` });
  };
  const main = files.find((f) => f.name === mainName);
  run(mainName, main ? main.text : '', 0);
  return { lines, macros, problems, included, missing };
}

// ---------------------------------------------------------------------------
// Integer expressions (dtc: 64-bit, C precedence)
// ---------------------------------------------------------------------------
const M64 = (1n << 64n) - 1n;

function lexExpr(s) {
  const toks = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)([uUlL]*)/.exec(s.slice(i));
      toks.push({ t: 'n', v: parseIntLit(m[1]) }); i += m[0].length; continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^'])'/.exec(s.slice(i));
      if (!m) throw new Error('bad character literal');
      toks.push({ t: 'n', v: BigInt(charCode(m[1])) }); i += m[0].length; continue;
    }
    const two = s.slice(i, i + 2);
    if (['<<', '>>', '<=', '>=', '==', '!=', '&&', '||'].includes(two)) { toks.push({ t: 'o', v: two }); i += 2; continue; }
    if ('+-*/%&|^~!<>()?:'.includes(c)) { toks.push({ t: 'o', v: c }); i++; continue; }
    if (IDENT.test(c)) { let j = i; while (j < s.length && IDCH.test(s[j])) j++; throw new Error(`unresolved name ${s.slice(i, j)}`); }
    throw new Error(`unexpected ${c}`);
  }
  return toks;
}
function parseIntLit(t) {
  if (/^0[xX]/.test(t)) return BigInt(t);
  if (/^0[0-7]+$/.test(t)) return BigInt('0o' + t.slice(1));
  return BigInt(t);
}
function charCode(e) {
  if (e.length === 1) return e.charCodeAt(0);
  const map = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
  return map[e[1]] ?? e.charCodeAt(1);
}
const BIN = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

export function evalExpr(s) {
  const toks = lexExpr(s); let p = 0;
  const peek = () => toks[p];
  const want = (v) => { if (peek()?.v !== v) throw new Error(`expected ${v}`); p++; };
  const unary = () => {
    const t = toks[p++];
    if (!t) throw new Error('expression ends early');
    if (t.t === 'n') return t.v;
    if (t.v === '(') { const v = cond(); want(')'); return v; }
    if (t.v === '-') return (-unary()) & M64;
    if (t.v === '+') return unary();
    if (t.v === '~') return (~unary()) & M64;
    if (t.v === '!') return unary() === 0n ? 1n : 0n;
    throw new Error(`unexpected ${t.v}`);
  };
  const bin = (lvl) => {
    if (lvl >= BIN.length) return unary();
    let a = bin(lvl + 1);
    while (peek() && peek().t === 'o' && BIN[lvl].includes(peek().v)) {
      const op = toks[p++].v; const b = bin(lvl + 1);
      switch (op) {
        case '||': a = a || b ? 1n : 0n; break;
        case '&&': a = a && b ? 1n : 0n; break;
        case '|': a |= b; break; case '^': a ^= b; break; case '&': a &= b; break;
        case '==': a = a === b ? 1n : 0n; break; case '!=': a = a !== b ? 1n : 0n; break;
        case '<': a = a < b ? 1n : 0n; break; case '>': a = a > b ? 1n : 0n; break;
        case '<=': a = a <= b ? 1n : 0n; break; case '>=': a = a >= b ? 1n : 0n; break;
        case '<<': a = (a << (b & 63n)) & M64; break; case '>>': a >>= (b & 63n); break;
        case '+': a = (a + b) & M64; break; case '-': a = (a - b) & M64; break;
        case '*': a = (a * b) & M64; break;
        case '/': if (b === 0n) throw new Error('division by zero'); a /= b; break;
        case '%': if (b === 0n) throw new Error('division by zero'); a %= b; break;
        default: break;
      }
    }
    return a;
  };
  const cond = () => {
    const c = bin(0);
    if (peek()?.v === '?') { p++; const a = cond(); want(':'); const b = cond(); return c ? a : b; }
    return c;
  };
  const v = cond();
  if (p < toks.length) throw new Error(`unexpected ${toks[p].v}`);
  return v;
}

// ---------------------------------------------------------------------------
// dtc grammar
// ---------------------------------------------------------------------------

export class Node {
  constructor(name, parent) {
    this.name = name; this.parent = parent;
    this.children = []; this.labels = []; this.props = new Map();
    this.defs = []; this.omit = false;
  }
  child(name) { return this.children.find((c) => c.name === name); }
  get path() {
    if (!this.parent) return '/';
    const up = this.parent.path;
    return (up === '/' ? '' : up) + '/' + this.name;
  }
}

class Syntax extends Error {}

/**
 * Parse preprocessed lines into the tree. ctx = {root, labels: Map, problems,
 * deleted: [], overlay: bool, fileTag}. For overlays, root is the base tree's.
 */
export function parseInto(lines, ctx) {
  const src = lines.map((l) => l.text).join('\n');
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  let pos = 0;
  const locAt = (at) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
    const l = lines[lo] || { file: '?', line: 0 };
    return { file: l.file, line: l.line };
  };
  const err = (msg, at = pos) => { throw new Syntax(`${msg}`, { cause: at }); };
  const ws = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  const peek = (s) => { ws(); return src.startsWith(s, pos); };
  const eat = (s) => { if (peek(s)) { pos += s.length; return true; } return false; };
  const expect = (s, what) => { if (!eat(s)) err(`expected '${s}'${what ? ' ' + what : ''} but found ${near()}`); };
  const near = () => { ws(); const t = src.slice(pos, pos + 18).split('\n')[0]; return t ? `'${t}'` : 'the end of the file'; };
  const NAMECH = /[A-Za-z0-9,._+*#?@-]/;
  const name = () => { ws(); const s0 = pos; while (pos < src.length && NAMECH.test(src[pos])) pos++; return src.slice(s0, pos); };
  const labelAhead = () => {
    ws();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/.exec(src.slice(pos, pos + 80));
    return m ? m : null;
  };
  const ref = () => {   // after '&'
    if (src[pos] === '{') {
      const e = src.indexOf('}', pos); if (e < 0) err('unclosed &{');
      const p = src.slice(pos + 1, e).trim(); pos = e + 1; return { path: p };
    }
    const s0 = pos; while (pos < src.length && /[A-Za-z0-9_]/.test(src[pos])) pos++;
    if (pos === s0) err('expected a label after &');
    return { label: src.slice(s0, pos) };
  };
  const findPath = (p) => {
    if (p === '/') return ctx.root;
    let n = ctx.root;
    for (const part of p.split('/').filter(Boolean)) {
      const next = n.children.find((c) => c.name === part) || (n.children.filter((c) => c.name.split('@')[0] === part).length === 1 ? n.children.find((c) => c.name.split('@')[0] === part) : null);
      if (!next) return null;
      n = next;
    }
    return n;
  };
  const resolve = (r) => (r.path != null ? (r.path.startsWith('/') ? findPath(r.path) : (ctx.aliases?.get(r.path) ? findPath(ctx.aliases.get(r.path)) : null)) : ctx.labels.get(r.label));
  const addLabel = (lab, node, at) => {
    const had = ctx.labels.get(lab);
    if (had && had !== node) ctx.problems.push({ sev: 'error', ...locAt(at), msg: `label ${lab} is on two nodes: ${had.path} and ${node.path}`, nodes: [had.path, node.path] });
    ctx.labels.set(lab, node);
    if (!node.labels.includes(lab)) node.labels.push(lab);
  };

  // ---- values ----
  const cells = (bits) => {
    const items = [];
    const mask = (1n << BigInt(bits)) - 1n;
    for (;;) {
      ws();
      if (src[pos] === '>') { pos++; break; }
      if (pos >= src.length) err('unclosed <');
      const at = pos;
      const c = src[pos];
      if (c === '&') { pos++; const r = ref(); items.push({ ref: r, at: locAt(at) }); continue; }
      if (c === '(') {
        let d = 0, e = pos;
        for (; e < src.length; e++) { if (src[e] === '(') d++; else if (src[e] === ')') { d--; if (d === 0) break; } }
        if (e >= src.length) err('unclosed ( in cells');
        const text = src.slice(pos, e + 1); pos = e + 1;
        try { items.push({ n: evalExpr(text) & mask }); } catch (x) {
          ctx.problems.push({ sev: 'error', ...locAt(at), msg: `cannot evaluate ${text.replace(/\s+/g, ' ').slice(0, 60)}: ${x.message}` });
          items.push({ n: 0n, bad: true });
        }
        continue;
      }
      const lab = labelAhead();
      if (lab) { pos += lab[0].length; continue; }   // a label inside cells marks a position; not needed here
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)[uUlL]*|^'(\\.|[^'])'/.exec(src.slice(pos, pos + 40));
      if (m) {
        pos += m[0].length;
        const v = m[2] != null ? BigInt(charCode(m[2])) : parseIntLit(m[1]);
        if (v > mask) ctx.problems.push({ sev: 'warn', ...locAt(at), msg: `${m[0]} does not fit in ${bits} bits - truncated` });
        items.push({ n: v & mask });
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos, pos + 80));
      if (id) {
        pos += id[0].length;
        ctx.problems.push({ sev: 'error', ...locAt(at), msg: `${id[0]} is not a number: a macro no included header defines (include its header or paste it as a file tab)`, macro: id[0] });
        items.push({ n: 0n, bad: true, name: id[0] });
        continue;
      }
      err(`unexpected ${near()} inside < >`);
    }
    return { t: 'cells', bits, v: items };
  };
  const string = () => {
    pos++;  // opening quote
    let out = '';
    while (pos < src.length && src[pos] !== '"') {
      if (src[pos] === '\\') {
        const n2 = src[pos + 1];
        const x = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(pos + 1));
        const o = /^([0-7]{1,3})/.exec(src.slice(pos + 1));
        if (x) { out += String.fromCharCode(parseInt(x[1], 16)); pos += 1 + x[0].length; continue; }
        if (o) { out += String.fromCharCode(parseInt(o[1], 8)); pos += 1 + o[0].length; continue; }
        out += String.fromCharCode(charCode('\\' + n2)); pos += 2; continue;
      }
      if (src[pos] === '\n') err('string runs past the end of the line');
      out += src[pos++];
    }
    if (src[pos] !== '"') err('unclosed string');
    pos++;
    return { t: 'str', v: out };
  };
  const bytes = () => {
    const e = src.indexOf(']', pos); if (e < 0) err('unclosed [');
    const body = src.slice(pos + 1, e).replace(/\s+/g, ''); pos = e + 1;
    if (!/^([0-9a-fA-F]{2})*$/.test(body)) err('[ ] must hold pairs of hex digits');
    return { t: 'bytes', v: body.match(/../g) || [] };
  };
  const value = () => {
    const parts = [];
    for (;;) {
      ws();
      const lab = labelAhead(); if (lab) { pos += lab[0].length; ws(); }
      if (src[pos] === '"') parts.push(string());
      else if (src[pos] === '<') { pos++; parts.push(cells(32)); }
      else if (src.startsWith('/bits/', pos)) {
        pos += 6; ws();
        const m = /^[0-9]+/.exec(src.slice(pos)); if (!m) err('expected a width after /bits/');
        pos += m[0].length; const bits = Number(m[0]);
        if (![8, 16, 32, 64].includes(bits)) err('/bits/ must be 8, 16, 32 or 64');
        expect('<'); parts.push(cells(bits));
      } else if (src[pos] === '[') parts.push(bytes());
      else if (src[pos] === '&') { const at = pos; pos++; parts.push({ t: 'ref', v: ref(), at: locAt(at) }); }
      else err(`expected a value but found ${near()}`);
      ws();
      const lab2 = labelAhead(); if (lab2) { pos += lab2[0].length; ws(); }
      if (src[pos] === ',') { pos++; continue; }
      break;
    }
    return parts;
  };

  // ---- nodes ----
  const setProp = (node, pname, val, at) => {
    const loc = { ...locAt(at), tag: ctx.fileTag };
    const had = node.props.get(pname);
    const entry = { action: 'set', value: val, ...loc };
    if (had && !had.deleted) { had.value = val; had.trail.push(entry); had.file = loc.file; had.line = loc.line; }
    else if (had) { had.deleted = false; had.value = val; had.trail.push(entry); had.file = loc.file; had.line = loc.line; node.props.delete(pname); node.props.set(pname, had); }
    else node.props.set(pname, { name: pname, value: val, trail: [entry], file: loc.file, line: loc.line, deleted: false });
  };
  const body = (node) => {
    for (;;) {
      ws();
      if (pos >= src.length) err(`node ${node.path} is not closed with }`);
      if (src[pos] === '}') { pos++; expect(';', `after the } of ${node.path}`); return; }
      const at = pos;
      if (eat('/delete-property/')) {
        const pn = name(); expect(';');
        const had = node.props.get(pn);
        const loc = { ...locAt(at), tag: ctx.fileTag };
        if (!had) ctx.problems.push({ sev: 'info', ...loc, msg: `/delete-property/ ${pn}: ${node.path} has no such property`, nodes: [node.path] });
        else { had.deleted = true; had.trail.push({ action: 'delete', ...loc }); had.file = loc.file; had.line = loc.line; }
        continue;
      }
      if (eat('/delete-node/')) {
        ws();
        let victim = null, what;
        if (src[pos] === '&') { pos++; const r = ref(); victim = resolve(r); what = r.label ? '&' + r.label : `&{${r.path}}`; }
        else { what = name(); victim = node.child(what) || null; }
        expect(';');
        if (!victim) ctx.problems.push({ sev: 'info', ...locAt(at), msg: `/delete-node/ ${what}: no such node under ${node.path}`, nodes: [node.path] });
        else removeNode(victim, at);
        continue;
      }
      if (eat('/omit-if-no-ref/')) { ws(); }
      const labs = [];
      for (let m = labelAhead(); m; m = labelAhead()) { labs.push([m[1], pos]); pos += m[0].length; }
      const nm = name();
      if (!nm) err(`expected a property or node name but found ${near()}`);
      ws();
      if (src[pos] === '{') {
        pos++;
        let kid = node.child(nm);
        if (!kid) { kid = new Node(nm, node); node.children.push(kid); }
        kid.defs.push({ ...locAt(at), tag: ctx.fileTag });
        for (const [l, lat] of labs) addLabel(l, kid, lat);
        body(kid);
        continue;
      }
      if (src[pos] === '=') { pos++; const v = value(); expect(';', `after the value of ${nm}`); setProp(node, nm, v, at); continue; }
      if (src[pos] === ';') { pos++; setProp(node, nm, [], at); continue; }
      err(`expected '=', ';' or '{' after ${nm} but found ${near()}`);
    }
  };
  const removeNode = (victim, at) => {
    if (!victim.parent) { ctx.problems.push({ sev: 'error', ...locAt(at), msg: 'cannot delete the root node' }); return; }
    const walk = (n) => { for (const l of n.labels) if (ctx.labels.get(l) === n) ctx.labels.delete(l); n.children.forEach(walk); };
    walk(victim);
    ctx.deleted.push({ path: victim.path, ...locAt(at), tag: ctx.fileTag });
    victim.parent.children = victim.parent.children.filter((c) => c !== victim);
  };

  // ---- top level ----
  ctx.memreserve ||= [];
  const pending = [];   // fragment roots of an overlay, handled after parsing
  try {
    for (;;) {
      ws();
      if (pos >= src.length) break;
      const at = pos;
      if (eat('/dts-v1/')) { expect(';'); ctx.v1 = true; continue; }
      if (eat('/plugin/')) { expect(';'); ctx.plugin = true; continue; }
      if (eat('/memreserve/')) {
        ws(); const a = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(src.slice(pos)); if (!a) err('expected an address after /memreserve/');
        pos += a[0].length; ws(); const b = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(src.slice(pos)); if (!b) err('expected a size after the /memreserve/ address');
        pos += b[0].length; expect(';');
        ctx.memreserve.push({ start: parseIntLit(a[1]), size: parseIntLit(b[1]), ...locAt(at) });
        continue;
      }
      if (eat('/delete-node/')) {
        ws(); if (src[pos] !== '&') err('/delete-node/ at the top level takes &label or &{/path}');
        pos++; const r = ref(); expect(';');
        const v = resolve(r);
        if (!v) ctx.problems.push({ sev: 'error', ...locAt(at), msg: `/delete-node/ &${r.label || `{${r.path}}`}: no such node`, undef: r.label });
        else removeNode(v, at);
        continue;
      }
      if (eat('/omit-if-no-ref/')) { ws(); }
      const labs = [];
      for (let m = labelAhead(); m; m = labelAhead()) { labs.push([m[1], pos]); pos += m[0].length; }
      ws();
      let target = null;
      if (src[pos] === '/') {
        pos++;
        if (ctx.plugin && ctx.overlay) {
          // fragment form: parse into a scratch root, apply below
          const scratch = new Node('', null);
          const save = { root: ctx.root, labels: ctx.labels };
          pending.push(scratch);
          ctx.root = scratch; ctx.labels = new Map(save.labels);
          expect('{'); body(scratch);
          ctx.root = save.root; ctx.labels = save.labels;
          continue;
        }
        target = ctx.root;
      } else if (src[pos] === '&') {
        pos++; const r = ref();
        target = resolve(r);
        if (!target) {
          ctx.problems.push({ sev: 'error', ...locAt(at), undef: r.label || r.path,
            msg: ctx.overlay ? `overlay target &${r.label || `{${r.path}}`} is not in the base tree - fdt apply / dtoverlay fails` : `&${r.label || `{${r.path}}`} is not defined before this point (dtc: "Label or path not found")` });
          // parse the block anyway into a throwaway node so the rest still reads
          target = new Node(r.label || r.path, null);
        }
      } else err(`expected / or &label at the top level but found ${near()}`);
      if (target.parent || target === ctx.root) target.defs.push({ ...locAt(at), tag: ctx.fileTag });
      for (const [l, lat] of labs) addLabel(l, target, lat);
      expect('{'); body(target);
    }
  } catch (e) {
    if (!(e instanceof Syntax)) throw e;
    const at = typeof e.cause === 'number' ? e.cause : pos;
    ctx.problems.push({ sev: 'error', ...locAt(at), msg: `syntax: ${e.message} - the rest of this file was not read`, fatal: true });
  }
  // apply overlay fragments: fragment@N { target = <&x> | target-path = "/p"; __overlay__ { ... } }
  for (const scratch of pending) {
    for (const frag of scratch.children) {
      const ov = frag.child('__overlay__');
      if (!ov) continue;
      const tp = frag.props.get('target'), tpath = frag.props.get('target-path');
      let target = null, what = '';
      const ref0 = tp && tp.value[0]?.t === 'cells' ? tp.value[0].v.find((x) => x.ref) : null;
      if (ref0) { what = ref0.ref.label ? '&' + ref0.ref.label : `&{${ref0.ref.path}}`; target = resolve(ref0.ref); }
      else if (tpath && tpath.value[0]?.t === 'str') { what = tpath.value[0].v; target = findPath(what); }
      const floc = frag.defs[0] || { file: '?', line: 0 };
      if (!target) { ctx.problems.push({ sev: 'error', file: floc.file, line: floc.line, undef: ref0?.ref.label, msg: `${frag.name}: target ${what || '(none)'} is not in the base tree` }); continue; }
      mergeInto(target, ov, ctx);
    }
  }
  return ctx;
}

/** Copy a parsed overlay node (props with their trails, children, labels) onto a base node. */
function mergeInto(dst, src, ctx) {
  dst.defs.push(...src.defs);
  for (const l of src.labels) { ctx.labels.set(l, dst); if (!dst.labels.includes(l)) dst.labels.push(l); }
  for (const [k, p] of src.props) {
    const had = dst.props.get(k);
    if (had) { had.trail.push(...p.trail); had.value = p.value; had.deleted = p.deleted; had.file = p.file; had.line = p.line; }
    else dst.props.set(k, p);
  }
  for (const c of src.children) {
    let d = dst.child(c.name);
    if (!d) { d = new Node(c.name, dst); dst.children.push(d); }
    mergeInto(d, c, ctx);
  }
}

// ---------------------------------------------------------------------------
// Printing values
// ---------------------------------------------------------------------------
export const hex = (v) => '0x' + BigInt(v).toString(16);
export function fmtCell(x) {
  if (x.ref) return x.ref.label ? '&' + x.ref.label : `&{${x.ref.path}}`;
  if (x.name) return x.name;
  return x.n < 10n ? x.n.toString() : hex(x.n);
}
export function fmtValue(parts) {
  if (!parts || !parts.length) return '';
  return parts.map((p) => {
    if (p.t === 'str') return JSON.stringify(p.v);
    if (p.t === 'bytes') return `[${p.v.join(' ')}]`;
    if (p.t === 'ref') return p.v.label ? '&' + p.v.label : `&{${p.v.path}}`;
    return `${p.bits !== 32 ? `/bits/ ${p.bits} ` : ''}<${p.v.map(fmtCell).join(' ')}>`;
  }).join(', ');
}
/** All numbers of a property as one list (refs count as one cell). */
export function cellList(prop) {
  const out = [];
  for (const p of prop?.value || []) if (p.t === 'cells') out.push(...p.v);
  return out;
}
export function strings(prop) { return (prop?.value || []).filter((p) => p.t === 'str').map((p) => p.v); }
