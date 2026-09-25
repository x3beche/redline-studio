// printf format checker: each conversion against the type of its argument,
// by the C11 rules (ISO/IEC 9899:2011 7.21.6.1 fprintf: conversion
// specifiers, length modifiers; 6.5.2.2p6 default argument promotions),
// with the integer type sizes and <stdint.h>/<inttypes.h> typedefs of the
// chosen target. Severity follows GCC -Wformat: a size mismatch is undefined
// behaviour that prints garbage ('error'); same size but a different type
// (int vs long on a 32-bit MCU) is a -Wformat warning that happens to work
// ('warning'); signedness only is -Wformat-signedness ('note').

// ---------------- targets ----------------
export const TARGETS = {
  arm: { name: 'arm-none-eabi / ESP-IDF 5 (32-bit MCU, newlib)', int: 4, long: 4, ptr: 4, ld: 8, dbl: 8,
    td: { int8_t: 'signed char', uint8_t: 'unsigned char', int16_t: 'short', uint16_t: 'unsigned short', int32_t: 'long', uint32_t: 'unsigned long',
      int64_t: 'long long', uint64_t: 'unsigned long long', size_t: 'unsigned int', ssize_t: 'int', ptrdiff_t: 'int', intptr_t: 'int', uintptr_t: 'unsigned int',
      intmax_t: 'long long', uintmax_t: 'unsigned long long' } },
  ilp32: { name: '32-bit Linux (glibc: arm-linux-gnueabihf, i686)', int: 4, long: 4, ptr: 4, ld: 12, dbl: 8,
    td: { int8_t: 'signed char', uint8_t: 'unsigned char', int16_t: 'short', uint16_t: 'unsigned short', int32_t: 'int', uint32_t: 'unsigned int',
      int64_t: 'long long', uint64_t: 'unsigned long long', size_t: 'unsigned int', ssize_t: 'int', ptrdiff_t: 'int', intptr_t: 'int', uintptr_t: 'unsigned int',
      intmax_t: 'long long', uintmax_t: 'unsigned long long' } },
  lp64: { name: '64-bit Linux / macOS (LP64)', int: 4, long: 8, ptr: 8, ld: 16, dbl: 8,
    td: { int8_t: 'signed char', uint8_t: 'unsigned char', int16_t: 'short', uint16_t: 'unsigned short', int32_t: 'int', uint32_t: 'unsigned int',
      int64_t: 'long', uint64_t: 'unsigned long', size_t: 'unsigned long', ssize_t: 'long', ptrdiff_t: 'long', intptr_t: 'long', uintptr_t: 'unsigned long',
      intmax_t: 'long', uintmax_t: 'unsigned long' } },
  llp64: { name: '64-bit Windows (LLP64)', int: 4, long: 4, ptr: 8, ld: 8, dbl: 8,
    td: { int8_t: 'signed char', uint8_t: 'unsigned char', int16_t: 'short', uint16_t: 'unsigned short', int32_t: 'int', uint32_t: 'unsigned int',
      int64_t: 'long long', uint64_t: 'unsigned long long', size_t: 'unsigned long long', ssize_t: 'long long', ptrdiff_t: 'long long', intptr_t: 'long long', uintptr_t: 'unsigned long long',
      intmax_t: 'long long', uintmax_t: 'unsigned long long' } },
  avr: { name: 'AVR 8-bit (avr-gcc, avr-libc: 16-bit int)', int: 2, long: 4, ptr: 2, ld: 4, dbl: 4,
    td: { int8_t: 'signed char', uint8_t: 'unsigned char', int16_t: 'int', uint16_t: 'unsigned int', int32_t: 'long', uint32_t: 'unsigned long',
      int64_t: 'long long', uint64_t: 'unsigned long long', size_t: 'unsigned int', ssize_t: 'int', ptrdiff_t: 'int', intptr_t: 'int', uintptr_t: 'unsigned int',
      intmax_t: 'long long', uintmax_t: 'unsigned long long' } },
};
// Common embedded typedefs (FreeRTOS on 32-bit ports, ESP-IDF, STM32 HAL, Arduino).
const EXTRA_TD = { bool: '_Bool', TickType_t: 'uint32_t', BaseType_t: 'long', UBaseType_t: 'unsigned long', esp_err_t: 'int',
  HAL_StatusTypeDef: 'int', byte: 'unsigned char', boolean: '_Bool', wint_t: 'unsigned int', off_t: 'long', time_t: 'long long' };
// Return types of common functions.
const FUNCS_RET = { strlen: 'size_t', sizeof: 'size_t', abs: 'int', labs: 'long', llabs: 'long long', strerror: 'char*', getenv: 'char*',
  HAL_GetTick: 'uint32_t', millis: 'unsigned long', micros: 'unsigned long', xTaskGetTickCount: 'TickType_t', esp_get_free_heap_size: 'uint32_t',
  fabs: 'double', sqrt: 'double', sin: 'double', cos: 'double', pow: 'double', fabsf: 'float', sqrtf: 'float', atoi: 'int', atol: 'long', strtoul: 'unsigned long', strtol: 'long',
  esp_err_to_name: 'char*', pcTaskGetName: 'char*', uxTaskGetStackHighWaterMark: 'UBaseType_t', xPortGetFreeHeapSize: 'size_t' };
// printf-like functions: name -> index of the format argument.
const PRINTF = { printf: 0, fprintf: 1, sprintf: 1, snprintf: 2, dprintf: 1, asprintf: 1, printk: 0, syslog: 1, iprintf: 0, siprintf: 1, sniprintf: 2,
  ESP_LOGE: 1, ESP_LOGW: 1, ESP_LOGI: 1, ESP_LOGD: 1, ESP_LOGV: 1, ets_printf: 0, LOG_ERR: 0, LOG_WRN: 0, LOG_INF: 0, LOG_DBG: 0, shell_print: 1,
  SEGGER_RTT_printf: 1, chprintf: 1, tfp_printf: 0, xprintf: 0, Serial_printf: 0 };

const INT_RANK = { _Bool: 0, char: 1, 'signed char': 1, 'unsigned char': 1, short: 2, 'unsigned short': 2, int: 3, 'unsigned int': 3,
  long: 4, 'unsigned long': 4, 'long long': 5, 'unsigned long long': 5 };
const FLOATS = { float: 1, double: 2, 'long double': 3 };
const isInt = (t) => t in INT_RANK;
const isFloat = (t) => t in FLOATS;
const isPtr = (t) => typeof t === 'string' && t.endsWith('*');
const unsignedOf = (t) => ({ char: 'unsigned char', 'signed char': 'unsigned char', short: 'unsigned short', int: 'unsigned int', long: 'unsigned long', 'long long': 'unsigned long long' }[t] || t);
const isUnsigned = (t) => t.startsWith('unsigned') || t === '_Bool';

function sizeOf(t, T) {
  if (isPtr(t)) return T.ptr;
  return { _Bool: 1, char: 1, 'signed char': 1, 'unsigned char': 1, short: 2, 'unsigned short': 2, int: T.int, 'unsigned int': T.int,
    long: T.long, 'unsigned long': T.long, 'long long': 8, 'unsigned long long': 8, float: 4, double: T.dbl, 'long double': T.ld }[t] ?? null;
}

// ---------------- type names ----------------
const BASIC = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool']);
const QUAL = /\b(const|volatile|static|extern|register|inline|restrict|__restrict|auto|_Atomic|IRAM_ATTR|__IO|__I|__O)\b/g;

/** Resolve a type spelling to {t: canonical, name: spelling} or null. */
function typeOf(text, env) {
  let s = String(text).replace(QUAL, ' ').replace(/\s+/g, ' ').trim();
  let stars = 0;
  s = s.replace(/\s*\*/g, () => { stars++; return ''; }).trim();
  if (!s) return null;
  const words = s.split(' ');
  let base;
  if (words.every((w) => BASIC.has(w))) {
    const has = (w) => words.includes(w);
    const longs = words.filter((w) => w === 'long').length;
    if (has('void')) base = 'void';
    else if (has('_Bool')) base = '_Bool';
    else if (has('float')) base = 'float';
    else if (has('double')) base = longs ? 'long double' : 'double';
    else if (has('char')) base = has('unsigned') ? 'unsigned char' : has('signed') ? 'signed char' : 'char';
    else {
      const k = has('short') ? 'short' : longs >= 2 ? 'long long' : longs === 1 ? 'long' : 'int';
      base = has('unsigned') ? unsignedOf(k) : k;
    }
  } else if (words.length === 2 && (words[0] === 'enum')) base = 'int';
  else if (words.length === 2 && (words[0] === 'struct' || words[0] === 'union')) base = `struct ${words[1]}`;
  else if (words.length === 1 && env.td[words[0]] != null) {
    const r = typeOf(env.td[words[0]], env);
    if (!r) return null;
    base = r.t.replace(/\*+$/, ''); stars += (r.t.match(/\*/g) || []).length;
  } else if (words.length === 1 && /^[A-Za-z_]\w*$/.test(words[0]) && /(_t|_T|Type|Def)$/.test(words[0])) {
    return { t: '?', name: words[0] + '*'.repeat(stars), unknownType: words[0] };
  } else return null;
  return { t: base + '*'.repeat(stars), name: s + (stars ? ' ' + '*'.repeat(stars) : ''), spelled: stars ? undefined : s };
}

// ---------------- lexing ----------------
/** Remove comments, keep strings; returns text with the same line breaks. */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2);
      const body = src.slice(i, j < 0 ? src.length : j + 2);
      out += body.replace(/[^\n]/g, ' '); i = j < 0 ? src.length : j + 2;
    } else { out += c; i++; }
  }
  return out;
}

/** From the '(' at index i: the top-level comma-separated arguments and the index after ')'. */
function splitArgs(src, i) {
  const args = []; let depth = 0, cur = '', j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'") {
      let k = j + 1;
      while (k < src.length && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
      cur += src.slice(j, k + 1); j = k; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(cur.trim()); return { args: args.filter((a, k) => a !== '' || k < args.length - 1 || args.length > 1), end: j + 1 }; }
      depth--;
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null;
}

/** A format argument: string literals and PRI macros concatenated. null when not a literal. */
function formatText(arg, T) {
  let s = arg.trim(), out = '', any = false;
  const re = /^\s*(?:(?:u8|u|U|L)?"((?:[^"\\]|\\.)*)"|(PRI[diouxX](?:8|16|32|64|MAX|PTR|LEAST\d+|FAST\d+)))/;
  while (s.trim()) {
    const m = re.exec(s);
    if (!m) return null;
    if (m[1] != null) { out += m[1].replace(/\\"/g, '"'); any = true; }
    else {
      const w = /PRI([diouxX])(\w+)/.exec(m[2]);
      const bits = w[2].replace(/LEAST|FAST/, '');
      const t = bits === 'MAX' ? T.td.intmax_t : bits === 'PTR' ? T.td.intptr_t : T.td[`int${bits}_t`];
      const len = { 'signed char': 'hh', short: 'h', int: '', long: 'l', 'long long': 'll' }[t] ?? '';
      out += len + w[1];
    }
    s = s.slice(m[0].length);
  }
  return any ? out : null;
}

// ---------------- format specs ----------------
const SPEC = /%(\d+\$)?([-+ #0']*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|j|z|t|L|q|I64|I32)?(.)?/g;

function expected(len, conv, T) {
  const L = len || '';
  if ('di'.includes(conv)) return { cat: 'int', t: { '': 'int', hh: 'int', h: 'int', l: 'long', ll: 'long long', q: 'long long', I64: 'long long', I32: 'int', j: T.td.intmax_t, z: T.td.ssize_t, t: T.td.ptrdiff_t }[L] };
  if ('ouxX'.includes(conv)) return { cat: 'int', t: unsignedOf({ '': 'int', hh: 'int', h: 'int', l: 'long', ll: 'long long', q: 'long long', I64: 'long long', I32: 'int', j: T.td.intmax_t, z: T.td.ssize_t, t: T.td.ptrdiff_t }[L]) };
  if ('fFeEgGaA'.includes(conv)) return { cat: 'float', t: L === 'L' ? 'long double' : 'double' };
  if (conv === 'c') return { cat: 'int', t: 'int' };
  if (conv === 's') return { cat: 'str', t: L === 'l' ? 'wchar_t*' : 'char*' };
  if (conv === 'p') return { cat: 'ptr', t: 'void*' };
  if (conv === 'n') return { cat: 'n', t: 'int*' };
  return null;
}

// Default argument promotions (C11 6.5.2.2p6): small ints -> int (or unsigned int when int cannot hold them), float -> double.
function promote(t, T) {
  if (t === 'float') return 'double';
  if (isInt(t) && INT_RANK[t] < 3) return sizeOf(t, T) < T.int || !isUnsigned(t) ? 'int' : 'unsigned int';
  return t;
}

// Usual arithmetic conversions, simplified (C11 6.3.1.8).
function arith(a, b, T) {
  if (isFloat(a) || isFloat(b)) return (FLOATS[a] || 0) >= (FLOATS[b] || 0) ? a : b;
  a = promote(a, T); b = promote(b, T);
  if (a === b) return a;
  const ua = isUnsigned(a), ub = isUnsigned(b);
  if (ua === ub) return INT_RANK[a] >= INT_RANK[b] ? a : b;
  const [u, s] = ua ? [a, b] : [b, a];
  if (INT_RANK[u] >= INT_RANK[s]) return u;
  if (sizeOf(s, T) > sizeOf(u, T)) return s;
  return unsignedOf(s);
}

// ---------------- expressions ----------------
function topSplit(expr, ops) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") { let k = i + 1; while (k < expr.length && expr[k] !== c) k += expr[k] === '\\' ? 2 : 1; cur += expr.slice(i, k + 1); i = k; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth === 0 && i > 0) {
      const op = ops.find((o) => expr.startsWith(o, i));
      const prev = expr.slice(0, i).trimEnd().slice(-1);
      // a binary operator follows an operand (not another operator or '(')
      if (op && prev && !/[-+*/%&|^<>=!(,?:~]/.test(prev) && !(op === '-' && expr[i + 1] === '>') && !(op === '>' && expr[i - 1] === '-')) {
        parts.push({ text: cur, op: parts.length ? parts.at(-1).nextOp : null }); parts.at(-1).nextOp = op;
        cur = ''; i += op.length - 1; continue;
      }
    }
    cur += c;
  }
  parts.push({ text: cur });
  return parts;
}

function literalType(e, T) {
  if (/^(?:u8|u|U|L)?"/.test(e)) return { t: 'char*', name: 'string literal' };
  if (/^(?:u|U|L)?'(?:[^'\\]|\\.[^']*)'$/.test(e)) return { t: 'int', name: 'character constant (int)' };
  let m = /^(\d+\.\d*|\.\d+|\d+(?=[eE]))([eE][-+]?\d+)?([fFlL]?)$/.exec(e);
  if (m) return m[3] && /f/i.test(m[3]) ? { t: 'float', name: 'float constant' } : m[3] ? { t: 'long double', name: 'long double constant' } : { t: 'double', name: 'double constant' };
  m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)([uU]?(?:ll|LL|l|L)?[uU]?)$/.exec(e);
  if (m) {
    const v = Number(m[1].toLowerCase().startsWith('0b') ? parseInt(m[1].slice(2), 2) : m[1]);
    const suf = m[2].toLowerCase(), u = suf.includes('u'), ll = suf.includes('ll'), l = !ll && suf.includes('l');
    const dec = !/^0[xXbB]/.test(m[1]) && !/^0\d/.test(m[1]);
    const imax = 2 ** (8 * T.int - 1), lmax = 2 ** (8 * T.long - 1);
    let t;
    if (ll) t = 'long long';
    else if (l) t = v < lmax || u ? 'long' : 'long long';
    else if (v < imax) t = 'int';
    else if (!dec && !u && v < imax * 2) t = 'unsigned int';
    else if (v < lmax) t = 'long';
    else if (!dec && !u && v < lmax * 2) t = 'unsigned long';
    else t = 'long long';
    if (u) t = unsignedOf(t);
    return { t, name: `integer constant (${t})` };
  }
  return null;
}

function exprType(expr, env, depth = 0) {
  const T = env.T;
  let e = expr.trim();
  if (!e || depth > 12) return null;
  // whole expression in parentheses
  while (/^\(.*\)$/.test(e) && splitArgs(e, 0)?.end === e.length) e = e.slice(1, -1).trim();
  // a bare type name (types-only mode: printf("%d", uint32_t))
  const asType = typeOf(e, env);
  if (asType && !env.vars[e] && (/[\s*]/.test(e) || BASIC.has(e) || env.td[e] != null)) return asType;
  const lit = literalType(e, T);
  if (lit) return lit;
  // cast: (type) expr
  const cm = /^\(([^()]+)\)\s*(.+)$/s.exec(e);
  if (cm) { const t = typeOf(cm[1], env); if (t) return { ...t, name: t.name + ' (cast)' }; }
  // conditional
  if (/\?/.test(e)) {
    const q = topSplit(e, ['?']);
    if (q.length > 1) { const br = q.slice(1).map((p) => p.text).join('?'); const [x, y] = topSplit(br, [':']).map((p) => exprType(p.text, env, depth + 1)); if (x && y && x.t === y.t) return x; if (x && y && x.t !== '?' && y.t !== '?' && (isInt(x.t) || isFloat(x.t)) && (isInt(y.t) || isFloat(y.t))) return { t: arith(x.t, y.t, T), name: 'conditional' }; return null; }
  }
  // comparisons and logic give int
  if (topSplit(e, ['==', '!=', '<=', '>=', '&&', '||']).length > 1) return { t: 'int', name: 'comparison (int)' };
  if (/^!/.test(e)) return { t: 'int', name: 'logical not (int)' };
  // binary arithmetic
  const shifts = topSplit(e, ['<<', '>>']);
  if (shifts.length > 1) { const l = exprType(shifts[0].text, env, depth + 1); return l && l.t !== '?' ? { t: promote(l.t, T), name: 'shift' } : null; }
  const parts = topSplit(e, ['+', '-', '*', '/', '%', '&', '|', '^']);
  if (parts.length > 1) {
    const ts = parts.map((p) => exprType(p.text, env, depth + 1));
    if (ts.some((t) => !t || t.t === '?')) return null;
    if (ts.some((t) => isPtr(t.t))) { const p = ts.find((t) => isPtr(t.t)); return ts.filter((t) => isPtr(t.t)).length > 1 ? { t: T.td.ptrdiff_t, name: 'pointer difference (ptrdiff_t)' } : p; }
    return { t: ts.map((t) => t.t).reduce((a, b) => arith(a, b, T)), name: 'arithmetic' };
  }
  // unary
  if (/^[-+~]/.test(e)) { const t = exprType(e.slice(1), env, depth + 1); return t && t.t !== '?' ? { t: promote(t.t, T), name: t.name } : t; }
  if (/^sizeof\b/.test(e) || /^_?Alignof\b/.test(e)) return { t: T.td.size_t, name: 'size_t (sizeof)' };
  if (/^&/.test(e)) { const t = exprType(e.slice(1), env, depth + 1); return t && t.t !== '?' ? { t: t.t + '*', name: 'address of ' + t.name } : { t: 'void*', name: 'address (pointer)', guess: true }; }
  if (/^\*/.test(e)) { const t = exprType(e.slice(1), env, depth + 1); return t && isPtr(t.t) ? { t: t.t.slice(0, -1), name: t.name.replace(/\s*\*$/, '') } : null; }
  // postfix ++/--
  e = e.replace(/(\+\+|--)$/, '').replace(/^(\+\+|--)/, '');
  // function call
  const fm = /^([A-Za-z_][\w.>-]*)\s*\(/.exec(e);
  if (fm && e.endsWith(')')) {
    const fname = fm[1].split(/\.|->/).pop();
    const r = env.funcs[fname] || FUNCS_RET[fname];
    if (r) { const t = typeOf(r, env); if (t) return { ...t, name: `${t.name} (${fname}() returns)` }; }
    return null;
  }
  // indexing
  const im = /^(.+)\[[^\]]*\]$/s.exec(e);
  if (im) {
    const base = exprType(im[1], env, depth + 1);
    if (base && isPtr(base.t)) return { t: base.t.slice(0, -1), name: base.name.replace(/\s*\*$/, '').replace(/\[\]$/, '') + ' element' };
    return null;
  }
  // member access: look the member name up among declarations
  const mm = /(?:\.|->)\s*([A-Za-z_]\w*)$/.exec(e);
  if (mm) { const v = env.vars[mm[1]]; return v ? { ...v, name: v.name + ` (member ${mm[1]})`, member: true } : null; }
  if (/^[A-Za-z_]\w*$/.test(e)) {
    if (env.vars[e]) return env.vars[e];
    if (e === 'true' || e === 'false') return { t: 'int', name: 'bool constant (int)' };
    if (e === 'NULL') return { t: 'void*', name: 'NULL' };
    if (/^[A-Z][A-Z0-9_]+$/.test(e)) return null; // a macro: its type is unknown
  }
  return null;
}

// ---------------- declarations ----------------
function collectDecls(src, env, unparsed) {
  const text = stripComments(src).replace(/^\s*#.*$/gm, '');
  // typedefs first
  for (const m of text.matchAll(/\btypedef\s+([^;{}]+?)\s+(\**)\s*([A-Za-z_]\w*)\s*;/g)) {
    const t = typeOf(m[1] + m[2], env);
    if (t && t.t !== '?') env.td[m[3]] = t.t.replace(/^struct /, 'struct ');
    else if (t) env.td[m[3]] = m[1];
    env.types.add(m[3]);
  }
  // function prototypes/definitions and their parameters
  for (const m of text.matchAll(/(^|[;{}\n])\s*([A-Za-z_][\w\s*]*?[\s*])([A-Za-z_]\w*)\s*\(([^()]*)\)\s*[;{]/g)) {
    const rt = typeOf(m[2], env);
    if (rt && !/^(if|while|for|switch|return|sizeof)$/.test(m[3])) env.funcs[m[3]] = m[2];
    for (const p of m[4].split(',')) declare(p, env);
  }
  // statements
  for (let st of text.split(/[;{}]/)) {
    st = st.replace(/^\s*(for|while|if|switch)\s*\(/, '').replace(/\btypedef\b.*$/s, '');
    declare(st, env, unparsed);
  }
}

function declare(stmt, env, unparsed) {
  let s = stmt.trim();
  if (!s || /^(return|case|default|goto|break|continue|else)\b/.test(s)) return;
  // cut initialisers at top level: 'uint32_t a = 3, b = f(x)' -> declarators
  const parts = topSplit(s, [',']).length ? splitTop(s) : [s];
  const first = parts[0].split(/=(?!=)/)[0].trim();
  const m = /^((?:[A-Za-z_]\w*\s+|[A-Za-z_]\w*\s*\*+\s*)+?)(\**)\s*([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)$/.exec(first);
  if (!m) return;
  const t = typeOf(m[1] + m[2], env);
  if (!t) return;
  const baseSpell = m[1].trim();
  const add = (stars, name, arr) => {
    const tt = typeOf(baseSpell + stars + (arr ? '*' : ''), env);
    if (!tt) return;
    env.vars[name] = { ...tt, name: `${baseSpell}${stars ? ' ' + stars : ''}${arr ? '[]' : ''}`.replace(QUAL, '').replace(/\s+/g, ' ').trim(), spelled: baseSpell.replace(QUAL, '').trim() };
  };
  add(m[2], m[3], !!m[4]);
  for (const p of parts.slice(1)) {
    const d = /^\s*(\**)\s*([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)/.exec(p.split(/=(?!=)/)[0]);
    if (d) add(d[1], d[2], !!d[3]);
  }
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------- the check ----------------
const INT_SPELL = { int: 'int', 'unsigned int': 'unsigned', long: 'long', 'unsigned long': 'unsigned long', 'long long': 'long long', 'unsigned long long': 'unsigned long long' };
function fixFor(arg, conv, T) {
  const spelled = arg.spelled || '';
  const std = /^(u?)int(8|16|32|64|max|ptr)_t$/.exec(spelled);
  const signedConv = 'di'.includes(conv);
  const letter = signedConv ? (std && std[1] ? 'u' : 'd') : conv === 'c' ? 'd' : conv;
  if (std && isInt(arg.t)) {
    const sz = std[2].toUpperCase();
    const L = 'diouxX'.includes(letter) ? letter : (std[1] ? 'u' : 'd');
    return `"%" PRI${L}${sz} (from <inttypes.h>)`;
  }
  if (spelled === 'size_t') return '%zu';
  if (spelled === 'ssize_t') return '%zd';
  if (spelled === 'ptrdiff_t') return '%td';
  const t = arg.t;
  if (isFloat(t)) return t === 'long double' ? '%Lf' : '%f';
  if (isPtr(t)) return /char\*$/.test(t) ? '%s' : '%p with a (void *) cast';
  if (isInt(t)) {
    const p = promote(t, T);
    const len = { int: '', 'unsigned int': '', long: 'l', 'unsigned long': 'l', 'long long': 'll', 'unsigned long long': 'll' }[p] ?? '';
    let c = 'diouxX'.includes(conv) ? conv : 'd';
    if (isUnsigned(p) && 'di'.includes(c)) c = 'u';
    if (!isUnsigned(p) && 'ouxX'.includes(c) && c === 'u') c = 'd';
    const small = { char: 'hh', 'signed char': 'hh', 'unsigned char': 'hh', short: 'h', 'unsigned short': 'h' }[t];
    return `%${small && conv !== 'c' ? small : len}${c}`;
  }
  return null;
}

function judge(exp, arg, T, len) {
  if (!arg || arg.t === '?') return { sev: 'unknown', why: arg?.unknownType ? `type ${arg.unknownType} unknown: add a typedef line` : 'type not known: add its declaration' };
  const a = promote(arg.t, T), x = exp.t;
  if (exp.cat === 'n') return { sev: 'warning', why: '%n writes to memory: a security risk, and disabled in many libcs' };
  if (exp.cat === 'str') {
    if (a === 'char*') return { sev: 'ok' };
    if (a === 'unsigned char*' || a === 'signed char*') return { sev: 'note', why: 'pointer signedness differs (-Wpointer-sign)' };
    if (a === 'void*') return { sev: 'warning', why: '%s expects char *, got void *' };
    if (isPtr(a)) return { sev: 'error', why: `%s expects char *, got ${a.replace('*', ' *')}` };
    return { sev: 'error', why: `%s expects a string (char *) but gets a ${a}: crashes or prints garbage` };
  }
  if (exp.cat === 'ptr') {
    if (a === 'void*') return { sev: 'ok' };
    if (isPtr(a)) return { sev: 'note', why: '%p formally wants void *: cast it ((void *)p) for -Wpedantic' };
    if (isInt(a) && sizeOf(a, T) === T.ptr) return { sev: 'warning', why: `%p expects a pointer, got ${a} (same size here)` };
    return { sev: 'error', why: `%p expects a pointer, got ${a}` };
  }
  if (exp.cat === 'float') {
    if (isFloat(a)) return a === x ? { sev: 'ok' } : sizeOf(a, T) === sizeOf(x, T) ? { sev: 'warning', why: `${x} expected, ${a} given (same size here)` } : { sev: 'error', why: `${x} expected, ${a} given: wrong size` };
    return { sev: 'error', why: `a float conversion with an integer argument: prints garbage, integers are not converted (or cast it: (double)x)` };
  }
  // integer conversions
  if (isFloat(a)) return { sev: 'error', why: `an integer conversion with a ${a === 'double' && arg.t === 'float' ? 'float (promoted to double)' : a} argument: prints garbage (or cast the value to an integer)` };
  if (isPtr(a)) return { sev: sizeOf(a, T) === sizeOf(x, T) ? 'warning' : 'error', why: 'a pointer given to an integer conversion: use %p' };
  if (!isInt(a)) return { sev: 'error', why: `${a} cannot be printed with an integer conversion` };
  if (a === x) return { sev: 'ok' };
  // %hh / %h take the promoted int of a char or short (C11 7.21.6.1p7)
  if ((len === 'hh' || len === 'h') && INT_RANK[arg.t] < 3) return { sev: 'ok' };
  const sa = sizeOf(a, T), sx = sizeOf(x, T);
  if (sa !== sx) return { sev: 'error', why: `expects ${x} (${sx} bytes), gets ${a} (${sa} bytes): the wrong number of bytes is read, this and later values print wrong` };
  if (unsignedOf(a) === unsignedOf(x)) return { sev: 'note', why: `signedness differs: ${x} expected, ${a} given (-Wformat-signedness)` };
  return { sev: 'warning', why: `expects ${x}, gets ${a}: same size on this target, so it prints right, but GCC -Wformat warns and it breaks on other targets` };
}

export function run({ code, decls, target, extra }) {
  const T = TARGETS[target] || TARGETS.arm;
  const env = { T, td: { ...T.td, ...EXTRA_TD, wchar_t: 'unsigned int' }, vars: {}, funcs: {}, types: new Set(Object.keys({ ...T.td, ...EXTRA_TD })) };
  const funcs = { ...PRINTF };
  const warnings = [], notes = [];
  for (const part of String(extra || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^([A-Za-z_]\w*)(?::(\d+))?$/.exec(part);
    if (m) funcs[m[1]] = Number(m[2] || 0); else warnings.push(`Could not read "${part}" in extra functions: write name:index, e.g. my_log:1.`);
  }
  const src = String(code || '');
  if (!src.trim()) return { warnings: ['Paste code with printf calls, e.g. printf("%d\\n", x);'] };
  collectDecls(String(decls || ''), env);
  collectDecls(src, env);
  const clean = stripComments(src);
  const lineOf = (idx) => clean.slice(0, idx).split('\n').length;

  const rows = [], problems = [], callsOut = [];
  // the same checks, structured for the page: one entry per call, its format
  // split into literal text and conversions, one item per checked argument
  const sizeOfT = (t) => (t && t !== '?' ? sizeOf(t, T) : null);
  let cur = null;
  const item = (o) => { cur.items.push(o); return cur.items.length - 1; };
  let calls = 0, convs = 0, errs = 0, warns = 0, unknowns = 0, info = 0;
  const unread = [];
  let usesFloat = false, usesLL = false;
  const callRe = /(?<![\w])([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = callRe.exec(clean))) {
    const name = m[1];
    if (!(name in funcs)) continue;
    // skip declarations/definitions of the function itself (int printf(const char *fmt, ...))
    const before = clean.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(int|void)\s+$/.test(before)) continue;
    const sp = splitArgs(clean, m.index + m[0].length - 1);
    if (!sp) { unread.push(`line ${lineOf(m.index)}: ${name}( has no closing parenthesis`); continue; }
    calls++;
    const line = lineOf(m.index);
    const fi = funcs[name];
    const fmtArg = sp.args[fi];
    if (fmtArg == null) { unread.push(`line ${line}: ${name}() has no format argument at position ${fi + 1}`); continue; }
    const fmt = formatText(fmtArg, T);
    const label = `${name} (line ${line})`;
    cur = { name, line, fmtSrc: fmtArg, fmt, fi, args: sp.args.slice(fi + 1), items: [], segs: [] };
    callsOut.push(cur);
    if (fmt == null) {
      item({ kind: 'nonliteral', spec: '(format)', expr: fmtArg, sev: 'warning', why: 'the format is not a string literal, so it cannot be checked; a user-controlled format is a security hole (-Wformat-security)', fix: `${name}("%s", …)` });
      rows.push([label, '(format)', fmtArg.slice(0, 32), '–', 'string literal', 'warning: format is not a literal, cannot be checked (-Wformat-security)']);
      problems.push(`${label}: the format is not a string literal (${fmtArg.slice(0, 40)}), so it cannot be checked, and a user-controlled format is a security hole (-Wformat-security). Use ${name}("%s", ${fmtArg.slice(0, 20)}).`);
      warns++;
      continue;
    }
    const rest = sp.args.slice(fi + 1);
    let ai = 0;
    const take = () => ({ expr: rest[ai++] });
    SPEC.lastIndex = 0;
    let s, lastEnd = 0;
    while ((s = SPEC.exec(fmt))) {
      const [whole, pos, , width, prec, len, conv] = s;
      if (s.index > lastEnd) cur.segs.push({ text: fmt.slice(lastEnd, s.index) });
      lastEnd = s.index + whole.length;
      if (conv === '%' && !pos && !width && prec == null && !len) { cur.segs.push({ text: '%%' }); continue; }
      const seg = { spec: whole, items: [] };
      cur.segs.push(seg);
      const it = (o) => { seg.items.push(item({ spec: whole, ...o })); };
      convs++;
      if (pos) {
        it({ kind: 'positional', sev: 'warning', why: 'positional arguments are POSIX, not C; newlib-nano and avr-libc do not support them' }); problems.push(`${label}: positional argument ${whole} is POSIX, not C; newlib-nano and avr-libc do not support it.`); warns++; continue; }
      if (!conv || !'diouxXfFeEgGaAcspn'.includes(conv) || (len === 'L' && !'fFeEgGaA'.includes(conv))) {
        rows.push([label, whole, '–', '–', '–', 'error: not a valid conversion']); errs++;
        it({ kind: 'invalid', sev: 'error', why: 'not a valid conversion' });
        problems.push(`${label}: "${whole}" is not a valid conversion.`); continue;
      }
      if ('fFeEgGaA'.includes(conv)) usesFloat = true;
      if (len === 'll' && 'diouxX'.includes(conv)) usesLL = true;
      for (const star of [width === '*' ? 'width' : null, prec === '*' ? 'precision' : null].filter(Boolean)) {
        const { expr } = take();
        if (expr == null) { it({ kind: 'star', star, expected: 'int', readBytes: T.int, sev: 'error', why: `the * ${star} has no argument` }); rows.push([label, `* (${star})`, '(missing)', '–', 'int', 'error']); errs++; problems.push(`${label}: the * ${star} in ${whole} has no argument.`); continue; }
        const at = exprType(expr, env);
        const v = judge({ cat: 'int', t: 'int' }, at, T);
        it({ kind: 'star', star, expr, type: at ? at.name : null, t: at?.t ?? null, promoted: at && at.t !== '?' ? promote(at.t, T) : null, expected: 'int',
          argBytes: at && at.t !== '?' ? sizeOfT(promote(at.t, T)) : null, readBytes: T.int, sev: v.sev, why: v.why || null });
        rows.push([label, `* (${star})`, expr, at ? at.name : '?', 'int', v.sev === 'ok' ? 'ok' : `${v.sev}: ${v.why}`]);
        if (v.sev === 'error') errs++; else if (v.sev === 'warning') warns++; else if (v.sev === 'unknown') unknowns++;
      }
      const exp = expected(len, conv, T);
      const { expr } = take();
      if (expr == null) {
        it({ kind: 'conv', conv, expected: exp.t, readBytes: sizeOfT(exp.t), sev: 'error', why: 'no argument: printf reads whatever is in the next register or on the stack', missing: true });
        rows.push([label, whole, '(missing)', '–', exp.t, 'error: no argument']); errs++;
        problems.push(`${label}: ${whole} has no argument: printf reads whatever is in the next register or on the stack.`); continue;
      }
      const at = exprType(expr, env);
      const v = judge(exp, at, T, len);
      let verdict = v.sev === 'ok' ? 'ok' : `${v.sev}: ${v.why}`;
      const fix = v.sev === 'error' || v.sev === 'warning' ? fixFor(at, conv, T) : null;
      if (fix && v.sev !== 'unknown') verdict += ` → use ${fix}`;
      it({ kind: 'conv', conv, expr, type: at ? at.name : null, t: at?.t ?? null, promoted: at && at.t !== '?' ? promote(at.t, T) : null, expected: exp.t,
        argBytes: at && at.t !== '?' ? sizeOfT(promote(at.t, T)) : null, readBytes: sizeOfT(exp.t), sev: v.sev, why: v.why || null, fix: fix && v.sev !== 'unknown' ? fix : null });
      if (at?.member) verdict += ' (member looked up by name)';
      rows.push([label, whole, expr.length > 32 ? expr.slice(0, 30) + '…' : expr, at ? at.name + (at.t !== '?' && at.name.replace(/\s|const|volatile/g, '') !== at.t && !at.name.startsWith(at.t) ? ` = ${at.t.replace('*', ' *')}` : '') : '?', exp.t.replace('*', ' *'), verdict]);
      if (v.sev === 'error') { errs++; problems.push(`${label}: ${whole} with ${expr}: ${v.why}${fix ? `. Use ${fix}` : ''}.`); }
      else if (v.sev === 'warning') { warns++; problems.push(`${label}: ${whole} with ${expr}: ${v.why}${fix ? `. Use ${fix}` : ''}.`); }
      else if (v.sev === 'unknown') unknowns++;
      else if (v.sev === 'note') info++;
      if (conv === 'n') problems.push(`${label}: %n writes the count into memory; it is a classic exploit vector and many embedded libcs ignore it.`);
    }
    if (fmt.length > lastEnd) cur.segs.push({ text: fmt.slice(lastEnd) });
    if (ai < rest.length) {
      for (const expr of rest.slice(ai)) {
        const at = exprType(expr, env);
        item({ kind: 'extra', expr, type: at ? at.name : null, t: at?.t ?? null, argBytes: at && at.t !== '?' ? sizeOfT(promote(at.t, T)) : null, sev: 'warning', why: 'more arguments than conversions (-Wformat-extra-args): a conversion is probably missing' });
      }
      rows.push([label, '(none)', rest.slice(ai).join(', ').slice(0, 32), '–', '–', `warning: ${rest.length - ai} extra argument(s), ignored`]);
      warns++; problems.push(`${label}: ${rest.length - ai} more argument(s) than conversions (-Wformat-extra-args): a conversion is probably missing.`);
    }
  }
  if (!calls) {
    return { warnings: [`No printf-style call found. Known: printf, fprintf, snprintf, sprintf, printk, ESP_LOGx, LOG_INF … Add your own under "Extra printf-like functions" as name:index.`, ...unread] };
  }
  if (unread.length) warnings.push(`Could not read: ${unread.join('; ')}.`);
  if (unknowns) warnings.push(`${unknowns} argument(s) of unknown type: add their declarations (e.g. "uint32_t ticks;" or "typedef uint32_t tick_t;") in the declarations box, then they are checked.`);
  if (usesFloat && target === 'arm') notes.push('Float conversions: newlib-nano (--specs=nano.specs) leaves %f out unless you link with -u _printf_float; without it floats print as nothing.');
  if (usesFloat && target === 'avr') notes.push('Float conversions: avr-libc prints "?" for %f unless you link with -Wl,-u,vfprintf -lprintf_flt -lm. double is 32-bit on AVR.');
  if (usesLL && target === 'avr') warnings.push('avr-libc printf does not support %ll: 64-bit values print wrong. Split into two 32-bit halves.');
  if (target === 'arm') notes.push('arm-none-eabi: int32_t/uint32_t are long, so "%d"/"%u" with them warns (and %lu with them is right); use PRId32/PRIu32 for portable code.');
  notes.push('Severity: error = wrong size, undefined behaviour, prints garbage; warning = GCC -Wformat warns but the size is right on this target; note = signedness or pedantic only.',
    'Types come from your declarations (both boxes), casts, literals and common functions; struct members are looked up by member name only. Add __attribute__((format(printf, n, m))) to your own log functions to get these checks from GCC itself.');
  const values = [
    { label: 'Calls checked', value: calls },
    { label: 'Conversions', value: convs },
    { label: 'Errors', value: errs, tone: errs ? 'bad' : 'ok', hint: 'wrong size or missing' },
    { label: 'Warnings', value: warns, tone: warns ? 'warn' : 'ok', hint: '-Wformat level' },
    { label: 'Unknown types', value: unknowns, tone: unknowns ? 'warn' : 'ok' },
    { label: 'Target', value: { arm: 'arm-none-eabi', ilp32: '32-bit Linux', lp64: 'LP64', llp64: 'Win64', avr: 'AVR' }[target] || 'arm-none-eabi', hint: T.name },
  ];
  return {
    calls: callsOut, target: { id: TARGETS[target] ? target : 'arm', name: T.name, int: T.int, long: T.long, ptr: T.ptr, dbl: T.dbl, ld: T.ld },
    values, warnings, notes,
    tables: [{ title: 'Conversions and their arguments', columns: ['Call', 'Conversion', 'Argument', 'Its type', 'Expected', 'Verdict'], rows }],
    texts: problems.length ? [{ title: 'Problems', body: problems.join('\n') + '\n' }] : [],
  };
}
