// C struct layout: member offsets, alignment and the padding the compiler
// inserts, per ABI. The algorithm is the one every C ABI shares:
//   offset = round_up(offset, align(member));  offset += sizeof(member)
//   alignof(struct) = max member alignment;    sizeof(struct) = round_up(end, alignof(struct))
// Type sizes/alignments: ARM AAPCS (IHI 0042) section 5.1 and 7.1, System V
// i386 ABI table 2.1, System V x86-64 psABI figure 3.1, Microsoft x64 ABI
// "Types and storage", avr-gcc ABI (everything byte aligned, int 16-bit,
// double 32-bit by default).
// Bit-fields (GCC / Clang on SysV and AAPCS): a bit-field is placed at the next
// free bit unless it would cross a boundary of its declared type's alignment
// unit; then it starts at the next such unit. MSVC (Windows x64) starts a new
// storage unit whenever the declared type's size changes or the field does
// not fit.

// [size, align] per ABI
const ABIS = {
  armeabi: { name: 'ARM Cortex-M (arm-none-eabi, AAPCS)', word: 4, shortEnums: true, char: [1, 1], short: [2, 2], int: [4, 4], long: [4, 4], llong: [8, 8], float: [4, 4], double: [8, 8], ldouble: [8, 8], ptr: [4, 4], bool: [1, 1], enum: [4, 4], wchar: [4, 4] },
  mcu32: { name: '32-bit, int-sized enums (ESP32, RISC-V 32, ARM Linux)', word: 4, char: [1, 1], short: [2, 2], int: [4, 4], long: [4, 4], llong: [8, 8], float: [4, 4], double: [8, 8], ldouble: [8, 8], ptr: [4, 4], bool: [1, 1], enum: [4, 4], wchar: [4, 4] },
  lp64: { name: '64-bit Linux / macOS (x86-64, AArch64, RV64)', word: 8, char: [1, 1], short: [2, 2], int: [4, 4], long: [8, 8], llong: [8, 8], float: [4, 4], double: [8, 8], ldouble: [16, 16], ptr: [8, 8], bool: [1, 1], enum: [4, 4], wchar: [4, 4] },
  win64: { name: 'Windows x64 (MSVC)', word: 8, msvc: true, char: [1, 1], short: [2, 2], int: [4, 4], long: [4, 4], llong: [8, 8], float: [4, 4], double: [8, 8], ldouble: [8, 8], ptr: [8, 8], bool: [1, 1], enum: [4, 4], wchar: [2, 2] },
  i386: { name: 'x86 32-bit Linux (i386 SysV)', word: 4, char: [1, 1], short: [2, 2], int: [4, 4], long: [4, 4], llong: [8, 4], float: [4, 4], double: [8, 4], ldouble: [12, 4], ptr: [4, 4], bool: [1, 1], enum: [4, 4], wchar: [4, 4] },
  avr: { name: 'AVR 8-bit (avr-gcc)', word: 4, char: [1, 1], short: [2, 1], int: [2, 1], long: [4, 1], llong: [8, 1], float: [4, 1], double: [4, 1], ldouble: [4, 1], ptr: [2, 1], bool: [1, 1], enum: [2, 1], wchar: [2, 1] },
};

const QUAL = new Set(['const', 'volatile', 'static', 'register', 'extern', 'restrict', '__restrict', 'inline', 'mutable', '__IO', '__I', '__O', '__IM', '__OM', '__IOM']);
const KEYWORD_TYPES = new Set(['char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'bool', 'void']);

// Named integer types -> [size in bytes] or a builtin key
function builtin(words, abi) {
  const w = words.filter((x) => !QUAL.has(x));
  const uns = w.includes('unsigned');
  let rest = w.filter((x) => x !== 'unsigned' && x !== 'signed');
  if (rest.length > 1) rest = rest.filter((x) => x !== 'int');
  const k = rest.join(' ');
  const B = (key) => ({ size: abi[key][0], align: abi[key][1], name: (uns ? 'unsigned ' : '') + (k || 'int') });
  if (k === '' || k === 'int') return B('int');
  if (k === 'char') return B('char');
  if (k === 'short') return B('short');
  if (k === 'long') return B('long');
  if (k === 'long long') return B('llong');
  if (k === 'float' || k === 'float32_t') return B('float');
  if (k === 'double' || k === 'float64_t') return B('double');
  if (k === 'long double') return B('ldouble');
  if (k === '_Bool' || k === 'bool' || k === 'boolean_t') return B('bool');
  if (k === 'wchar_t') return B('wchar');
  if (/^(size_t|ssize_t|ptrdiff_t|intptr_t|uintptr_t|uintptr|off_t)$/.test(k)) return { ...B('ptr'), name: k };
  let m = /^u?int(?:_least)?(8|16|32|64)_t$/.exec(k) || /^(?:u|s|i|uint|int|U|S|I)(8|16|32|64)$/.exec(k) || /^q(7|15|31)_t$/.exec(k);
  if (m) {
    const bits = { 7: 8, 15: 16, 31: 32 }[m[1]] || Number(m[1]);
    const key = bits === 8 ? 'char' : bits === 16 ? 'short' : bits === 32 ? (abi.int[0] === 4 ? 'int' : 'long') : 'llong';
    return { size: bits / 8, align: abi[key][1], name: k };
  }
  if (k === 'char16_t') return { ...B('short'), name: k };
  if (k === 'char32_t') return { size: 4, align: abi.long[0] === 4 ? abi.long[1] : abi.int[1], name: k };
  if (k === 'uint_fast8_t' || k === 'int_fast8_t') return { ...B('char'), name: k };
  return null;
}

// ---------- tokenizer ----------
function tokenize(src, defines) {
  let text = String(src ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  text = text.replace(/\\\n/g, ' ');
  const lines = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t.startsWith('#')) return line;
    let m = /^#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/.exec(t);
    if (m) { defines[m[1]] = m[2].trim(); return ''; }
    m = /^#\s*pragma\s+pack\s*\(\s*(.*?)\s*\)/.exec(t);
    if (m) {
      const a = m[1];
      if (/pop/.test(a)) return ' __PACK_POP__ ';
      const n = /(\d+)/.exec(a);
      if (/push/.test(a)) return n ? ` __PACK_PUSH_${n[1]}__ ` : ' __PACK_PUSH_0__ ';
      return n ? ` __PACK_SET_${n[1]}__ ` : ' __PACK_SET_0__ ';
    }
    return '';
  });
  const toks = [];
  const re = /([A-Za-z_]\w*)|(0x[0-9a-fA-F]+|\d+)[uUlL]*|(\S)/g;
  let m;
  const joined = lines.join('\n');
  while ((m = re.exec(joined))) {
    if (m[1]) toks.push({ t: 'id', v: m[1] });
    else if (m[2]) toks.push({ t: 'num', v: Number(m[2]) });
    else toks.push({ t: 'p', v: m[3] });
  }
  return toks;
}

// ---------- parser ----------
function parse(src) {
  const defines = {};
  const toks = tokenize(src, defines);
  let i = 0;
  const cur = () => toks[i];
  const is = (v) => toks[i] && toks[i].v === v;
  const defs = [];      // every aggregate, in order of definition
  const tags = {};      // 'struct foo' -> def
  const typedefs = {};  // name -> typeref
  const enums = {};     // tag -> [min, max] of its enumerators
  const problems = [];
  let pack = 0; const packStack = [];

  function evalExpr(tokens) {
    // + - * / ( ) numbers, #defined names, sizeof not supported
    let k = 0;
    const val = (t) => {
      if (t.t === 'num') return t.v;
      if (t.t === 'id' && defines[t.v] != null) {
        const inner = tokenize(defines[t.v], {});
        return evalExpr(inner);
      }
      throw new Error(`unknown size "${t.v}"`);
    };
    const prim = () => {
      const t = tokens[k++];
      if (!t) throw new Error('empty size');
      if (t.v === '(') { const v = sum(); k++; return v; }
      if (t.v === '-') return -prim();
      return val(t);
    };
    const prod = () => { let v = prim(); while (tokens[k] && (tokens[k].v === '*' || tokens[k].v === '/')) { const op = tokens[k++].v; const r = prim(); v = op === '*' ? v * r : Math.floor(v / r); } return v; };
    const sum = () => { let v = prod(); while (tokens[k] && (tokens[k].v === '+' || tokens[k].v === '-')) { const op = tokens[k++].v; const r = prod(); v = op === '+' ? v + r : v - r; } return v; };
    const v = sum();
    if (!Number.isFinite(v)) throw new Error('bad size');
    return v;
  }

  function skipBalanced(open, close) { // at `open`
    let depth = 0, out = [];
    do {
      const t = toks[i++];
      if (!t) break;
      if (t.v === open) depth++;
      else if (t.v === close) depth--;
      out.push(t);
    } while (depth > 0 && i < toks.length);
    return out;
  }

  function attributes(into) {
    for (;;) {
      if (is('__attribute__') || is('__attribute')) {
        i++;
        const body = skipBalanced('(', ')');
        const txt = body.map((t) => t.v).join(' ');
        if (/\bpacked\b|__packed__/.test(txt)) into.packed = true;
        const m = /aligned\s*\(\s*(\d+)\s*\)/.exec(txt);
        if (m) into.aligned = Math.max(into.aligned || 1, Number(m[1]));
        else if (/\baligned\b/.test(txt)) into.aligned = Math.max(into.aligned || 1, 8);
      } else if (is('_Alignas') || is('alignas') || is('__declspec')) {
        const kw = cur().v; i++;
        const body = skipBalanced('(', ')');
        const txt = body.map((t) => t.v).join(' ');
        const m = /(\d+)/.exec(txt);
        if (kw === '__declspec') { if (/align/.test(txt) && m) into.aligned = Math.max(into.aligned || 1, Number(m[1])); }
        else if (m) into.aligned = Math.max(into.aligned || 1, Number(m[1]));
      } else if (cur() && cur().t === 'id' && /^_*packed_*$/i.test(cur().v)) { into.packed = true; i++; }
      else if (cur() && cur().t === 'id' && QUAL.has(cur().v)) i++;
      else break;
    }
  }

  function pragma() {
    const v = cur() && cur().t === 'id' ? cur().v : '';
    let m;
    if ((m = /^__PACK_SET_(\d+)__$/.exec(v))) { pack = Number(m[1]); i++; return true; }
    if ((m = /^__PACK_PUSH_(\d+)__$/.exec(v))) { packStack.push(pack); if (Number(m[1])) pack = Number(m[1]); i++; return true; }
    if (v === '__PACK_POP__') { pack = packStack.pop() || 0; i++; return true; }
    return false;
  }

  // type specifier -> typeref
  function spec() {
    const at = {};
    attributes(at);
    let t = cur();
    if (!t) return null;
    let kw = t.v;
    if (kw === '__PACKED_STRUCT' || kw === '__PACKED_UNION') { at.packed = true; kw = kw === '__PACKED_STRUCT' ? 'struct' : 'union'; }
    if (kw === 'struct' || kw === 'union') {
      i++;
      attributes(at);
      let tag = null;
      if (cur() && cur().t === 'id' && !is('{')) { tag = cur().v; i++; }
      attributes(at);
      if (is('{')) {
        i++;
        const def = { kind: kw, tag, members: [], packed: !!at.packed, aligned: at.aligned || 0, pack };
        while (i < toks.length && !is('}')) {
          if (pragma()) continue;
          const before = i;
          declaration(def.members, true);
          if (i === before) i++;
        }
        i++; // }
        attributes(def);
        def.packed = def.packed || !!at.packed;
        defs.push(def);
        if (tag) tags[`${kw} ${tag}`] = def;
        return { ref: 'def', def };
      }
      return { ref: 'tag', key: `${kw} ${tag}`, name: `${kw} ${tag}` };
    }
    if (kw === 'enum') {
      i++;
      let tag = null;
      if (cur() && cur().t === 'id') { tag = cur().v; i++; }
      if (is(':')) { // C23 / C++ fixed underlying type
        i++; const words = [];
        while (cur() && cur().t === 'id') words.push(toks[i++].v);
        if (is('{')) skipBalanced('{', '}');
        return { ref: 'words', words, name: `enum ${tag || ''}`.trim() };
      }
      let range = null;
      if (is('{')) {
        const body = skipBalanced('{', '}').slice(1, -1);
        // enumerator values, for -fshort-enums: name [= expr], ...
        let v = -1, lo = Infinity, hi = -Infinity, ok = true, k = 0;
        while (k < body.length) {
          const item = [];
          while (k < body.length && body[k].v !== ',') item.push(body[k++]);
          k++;
          if (!item.length) continue;
          if (item[1] && item[1].v === '=') { try { v = evalExpr(item.slice(2)); } catch { ok = false; } } else v += 1;
          if (item[0].t === 'id') defines[item[0].v] = String(v);
          lo = Math.min(lo, v); hi = Math.max(hi, v);
        }
        range = ok && Number.isFinite(lo) ? [lo, hi] : null;
        if (tag) enums[tag] = range;
      } else if (tag && enums[tag] !== undefined) range = enums[tag];
      return { ref: 'enum', name: tag ? `enum ${tag}` : 'enum', range };
    }
    // plain words: take identifiers; the last one is the declarator name
    // unless a * or ( follows or it is a type keyword
    const words = [];
    while (cur() && cur().t === 'id' && !/^__PACK_/.test(cur().v)) {
      if (is('__attribute__') || is('__attribute') || is('_Alignas') || is('alignas') || is('__declspec')) break; // the declarator reads it
      words.push(cur().v); i++;
    }
    if (!words.length) return null;
    const next = cur() && cur().v;
    const typeWords = words.filter((w) => !QUAL.has(w));
    if (next !== '*' && next !== '(' && typeWords.length > 1 && !KEYWORD_TYPES.has(words[words.length - 1])) { i--; words.pop(); }
    return { ref: 'words', words, name: words.filter((w) => !QUAL.has(w)).join(' '), aligned: at.aligned };
  }

  // one declaration: spec declarator[, declarator]... ;
  function declaration(into, inStruct) {
    const startTok = i;
    const sp = spec();
    if (!sp) { while (i < toks.length && !is(';') && !is('}')) i++; if (is(';')) i++; return; }
    if (is(';')) { // struct definition alone, or C11 anonymous member
      i++;
      if (inStruct && sp.ref === 'def' && !sp.def.tag) into.push({ name: '(anonymous ' + sp.def.kind + ')', type: sp, dims: [], ptr: 0 });
      return;
    }
    for (;;) {
      const d = { type: sp, ptr: 0, dims: [], name: null, bits: null };
      const at = {};
      while (is('*') || (cur() && cur().t === 'id' && QUAL.has(cur().v))) { if (is('*')) d.ptr++; i++; }
      attributes(at);
      if (is('(')) { // function pointer or parenthesised declarator
        i++;
        while (is('*') || (cur() && QUAL.has(cur().v))) { if (is('*')) d.ptr++; i++; }
        if (cur() && cur().t === 'id') d.name = toks[i++].v;
        while (is('[')) { i++; const e = []; while (i < toks.length && !is(']')) e.push(toks[i++]); i++; try { d.dims.push(evalExpr(e)); } catch (err) { d.err = err.message; } }
        if (is(')')) i++;
        if (is('(')) { skipBalanced('(', ')'); d.ptr = Math.max(1, d.ptr); d.fn = true; }
      } else if (cur() && cur().t === 'id') d.name = toks[i++].v;
      while (is('[')) {
        i++; const e = [];
        while (i < toks.length && !is(']')) e.push(toks[i++]);
        i++;
        if (!e.length) { d.flex = true; d.dims.push(0); continue; }
        try { d.dims.push(evalExpr(e)); } catch (err) { d.err = err.message; }
      }
      if (is(':')) {
        i++; const e = [];
        while (i < toks.length && !is(',') && !is(';') && !is('}')) e.push(toks[i++]);
        try { d.bits = evalExpr(e); } catch (err) { d.err = err.message; }
      }
      attributes(at);
      if (at.aligned) d.aligned = at.aligned;
      if (at.packed) d.packed = true;
      if (is('=')) { while (i < toks.length && !is(',') && !is(';')) i++; }
      d.src = toks.slice(startTok, i).map((t) => t.v);
      into.push(d);
      if (is(',')) { i++; continue; }
      break;
    }
    if (is(';')) i++;
    else problems.push(`Expected ";" after ${into.length ? into[into.length - 1].name || 'a member' : 'a declaration'}.`);
  }

  while (i < toks.length) {
    if (pragma()) continue;
    if (is('typedef')) {
      i++;
      const list = [];
      declaration(list, false);
      for (const d of list) if (d.name) typedefs[d.name] = d;
      continue;
    }
    const t = cur();
    if (t.v === 'struct' || t.v === 'union' || t.v === 'enum' || t.v === '__PACKED_STRUCT' || t.v === '__PACKED_UNION') {
      const before = i;
      declaration([], false);
      if (i === before) i++;
      continue;
    }
    i++;
  }
  return { defs, tags, typedefs, problems, defines };
}

// ---------- layout ----------
function layout(def, env, depth = 0) {
  if (def.cache) return def.cache;
  if (depth > 20) throw new Error('struct nesting too deep (recursive by value?)');
  const { abi } = env;
  const packLimit = def.packed ? 1 : def.pack || env.pack || 0;
  const cap = (a) => (packLimit ? Math.min(a, packLimit) : a);
  const rows = [];
  const errs = [];
  let bo = 0;         // bit offset
  let align = 1;
  let unit = null;    // MSVC bit-field storage unit
  let hasBits = false, hasFlex = false;
  const isUnion = def.kind === 'union';
  let usize = 0;

  for (const [mi, m] of def.members.entries()) {
    let info;
    try { info = typeOf(m, env, depth); } catch (e) { errs.push(`${m.name || 'member'}: ${e.message}`); continue; }
    if (m.err) errs.push(`${m.name || 'member'}: ${m.err} in its array size or bit width. #define it above the struct.`);
    let a = cap(info.align);
    if (m.aligned) a = Math.max(a, m.aligned);
    if (m.flex) { hasFlex = true; if (mi !== def.members.length - 1) errs.push(`${m.name}[] is a flexible array member but not the last member.`); }
    if (m.bits != null && !m.ptr && !m.dims.length) {
      hasBits = true;
      const S = info.size, w = m.bits;
      if (w > S * 8) { errs.push(`${m.name}: ${w}-bit field is wider than its type (${S * 8} bits).`); continue; }
      if (isUnion) { rows.push({ name: m.name || '(unnamed)', type: info.name, offset: 0, size: Math.ceil(w / 8), align: a, bits: [0, w], pad: 0 }); usize = Math.max(usize, S); align = Math.max(align, a); continue; }
      let start;
      if (abi.msvc && !def.packed) {
        if (w === 0) { if (unit) { bo = (unit.start + unit.size) * 8; unit = null; } continue; }
        if (!unit || unit.size !== S || unit.used + w > S * 8) {
          const off = Math.ceil(bo / 8);
          const s0 = Math.ceil(off / a) * a;
          unit = { start: s0, size: S, used: 0 };
          bo = (s0 + S) * 8;
        }
        start = unit.start * 8 + unit.used;
        unit.used += w;
      } else {
        const ua = def.packed ? 1 : a; // alignment unit in bytes for the no-crossing rule
        if (w === 0) { bo = Math.ceil(bo / (ua * 8)) * ua * 8; continue; }
        if (!def.packed && Math.floor(bo / (S * 8)) !== Math.floor((bo + w - 1) / (S * 8))) bo = Math.ceil(bo / (ua * 8)) * ua * 8;
        start = bo;
        bo += w;
      }
      if (m.name) align = Math.max(align, def.packed ? 1 : a);
      const byteOff = Math.floor(start / 8);
      rows.push({ name: m.name || '(unnamed)', type: `${info.name} : ${w}`, offset: byteOff, size: Math.ceil(((start % 8) + w) / 8), align: a, bits: [start - byteOff * 8, w], pad: 0, bitStart: start });
      continue;
    }
    unit = null;
    const count = m.dims.reduce((p, d) => p * d, 1);
    const size = info.size * count;
    if (isUnion) {
      rows.push({ name: m.name || '(anonymous)', type: typeLabel(m, info), offset: 0, size, align: a, pad: 0 });
      usize = Math.max(usize, size); align = Math.max(align, a); continue;
    }
    const cur = Math.ceil(bo / 8);
    const off = Math.ceil(cur / a) * a;
    rows.push({ name: m.name || '(anonymous)', type: typeLabel(m, info), offset: off, size, align: a, pad: off - cur, elem: info.size, count });
    bo = (off + size) * 8;
    align = Math.max(align, a);
  }
  if (def.aligned) align = Math.max(align, def.aligned);
  const end = isUnion ? usize : Math.ceil(bo / 8);
  const size = Math.ceil(end / align) * align;
  const res = { size, align, rows, tail: size - end, errs, hasBits, hasFlex, packLimit, isUnion };
  def.cache = res;
  return res;
}

function typeLabel(m, info) {
  return `${info.name}${m.ptr ? ' ' + '*'.repeat(m.ptr) : ''}${m.dims.map((d) => `[${d}]`).join('')}`;
}

function resolve(tref, env, depth, seen = 0) {
  if (seen > 20) throw new Error('typedef loop');
  const { abi, parsed } = env;
  if (tref.ref === 'def') { const L = layout(tref.def, env, depth + 1); return { size: L.size, align: L.align, name: tref.def.tag ? `${tref.def.kind} ${tref.def.tag}` : `${tref.def.kind} {…}` }; }
  if (tref.ref === 'tag') {
    const d = parsed.tags[tref.key];
    if (!d) throw new Error(`${tref.key} is not defined above: paste its definition too`);
    const L = layout(d, env, depth + 1);
    return { size: L.size, align: L.align, name: tref.key };
  }
  if (tref.ref === 'enum') {
    if (abi.shortEnums && tref.range) {
      // -fshort-enums: the smallest integer type that holds every enumerator
      const [lo, hi] = tref.range;
      const size = lo >= 0 ? (hi <= 0xFF ? 1 : hi <= 0xFFFF ? 2 : 4) : (lo >= -128 && hi <= 127 ? 1 : lo >= -32768 && hi <= 32767 ? 2 : 4);
      return { size, align: Math.min(size, abi.enum[1]), name: tref.name };
    }
    return { size: abi.enum[0], align: abi.enum[1], name: tref.name };
  }
  const words = tref.words.filter((w) => !QUAL.has(w));
  if (words.length === 1 && parsed.typedefs[words[0]]) {
    const td = parsed.typedefs[words[0]];
    if (td.ptr) return { size: abi.ptr[0], align: abi.ptr[1], name: words[0] };
    const inner = resolve(td.type, env, depth, seen + 1);
    const count = td.dims.reduce((p, d) => p * d, 1);
    return { size: inner.size * count, align: td.aligned ? Math.max(inner.align, td.aligned) : inner.align, name: words[0] };
  }
  const b = builtin(words, abi);
  if (!b) throw new Error(`unknown type "${words.join(' ')}": add a typedef for it above the struct (e.g. typedef uint16_t ${words.join('_')};)`);
  return b;
}

function typeOf(m, env, depth) {
  if (m.ptr) {
    let name = m.type.name || (m.type.def ? `${m.type.def.kind} {…}` : '');
    if (m.fn) name = `${name} (*)()`;
    return { size: env.abi.ptr[0], align: env.abi.ptr[1], name };
  }
  if (m.type.ref === 'words' && m.type.words.filter((w) => !QUAL.has(w)).join(' ') === 'void') throw new Error('void member');
  return resolve(m.type, env, depth);
}

// ---------- reorder: largest alignment first, then largest size ----------
function reorderedSize(L) {
  if (L.isUnion || L.hasBits) return null;
  const items = L.rows.map((r) => ({ ...r })).sort((a, b) => b.align - a.align || b.size - a.size);
  let off = 0, align = 1;
  const flex = items.findIndex((r) => r.size === 0);
  if (flex >= 0) items.push(items.splice(flex, 1)[0]);
  for (const r of items) { off = Math.ceil(off / r.align) * r.align; r.newOffset = off; off += r.size; align = Math.max(align, r.align); }
  return { size: Math.ceil(off / Math.max(align, L.align)) * Math.max(align, L.align), order: items };
}

export function run({ code, abi: abiKey, pack, which }) {
  const abi = ABIS[abiKey] || ABIS.armeabi;
  const warnings = [];
  const parsed = parse(code);
  if (!parsed.defs.length) return { warnings: ['No struct or union found. Paste a definition like: struct s { uint8_t a; uint32_t b; };'] };
  const env = { abi, parsed, pack: pack === 'natural' ? 0 : Number(pack) || 0 };
  const w = String(which ?? '').trim().replace(/^(struct|union)\s+/, '');
  let def = parsed.defs[parsed.defs.length - 1];
  if (w) {
    def = parsed.defs.find((d) => d.tag === w) || (parsed.typedefs[w] && parsed.typedefs[w].type.def) || null;
    if (!def) return { warnings: [`No struct called "${w}" in the code. Defined: ${parsed.defs.map((d) => d.tag || '(anonymous)').join(', ')}.`] };
  }
  const tdName = Object.entries(parsed.typedefs).find(([, t]) => t.type.def === def)?.[0];
  const title = def.tag ? `${def.kind} ${def.tag}` : tdName || `anonymous ${def.kind}`;
  let L;
  try { L = layout(def, env); } catch (e) { return { warnings: [e.message] }; }
  warnings.push(...parsed.problems, ...L.errs);
  const padTotal = L.rows.reduce((s, r) => s + r.pad, 0) + L.tail;
  const dataBytes = L.size - padTotal;
  const re = reorderedSize(L);

  // the byte map, for the drawing and for agents
  const cells = [];
  const byOffset = [...L.rows].sort((a, b) => a.offset - b.offset);
  let p = 0, idx = 0;
  if (L.isUnion) {
    for (const [k, r] of L.rows.entries()) cells.push({ start: 0, len: r.size, label: r.name, kind: 'member', idx: k });
    if (L.tail) cells.push({ start: L.size - L.tail, len: L.tail, label: 'pad', kind: 'pad' });
  } else {
    for (const r of byOffset) {
      if (r.offset > p) cells.push({ start: p, len: r.offset - p, label: 'pad', kind: 'pad' });
      const last = cells[cells.length - 1];
      if (r.bits && last && last.bitfield && r.offset < last.start + last.len) {
        last.label += `, ${r.name}:${r.bits[1]}`;
        last.len = Math.max(last.len, r.offset + r.size - last.start);
      } else if (r.size > 0) cells.push({ start: r.offset, len: r.size, label: r.bits ? `${r.name}:${r.bits[1]}` : r.name, kind: 'member', idx: idx++, bitfield: !!r.bits });
      p = Math.max(p, r.offset + r.size);
    }
    if (L.size > p) cells.push({ start: p, len: L.size - p, label: 'pad', kind: 'pad' });
  }

  const values = [
    { label: `sizeof(${title})`, value: `${L.size}`, unit: 'bytes', tone: 'ok' },
    { label: 'Alignment', value: `${L.align}`, unit: 'bytes' },
    { label: 'Padding', value: `${padTotal}`, unit: 'bytes', tone: padTotal ? 'warn' : 'ok', hint: `${L.size ? Math.round((100 * padTotal) / L.size) : 0} % of the struct` },
    { label: 'Members', value: `${L.rows.length}` },
  ];
  if (re) values.push({ label: 'Reordered size', value: `${re.size}`, unit: 'bytes', tone: re.size < L.size ? 'ok' : undefined, hint: re.size < L.size ? `saves ${L.size - re.size} bytes` : 'already as small as it gets' });

  const rows = byOffset.map((r) => [
    r.bits ? `${r.offset} (bit ${r.bits[0]})` : r.offset,
    r.bits ? `${r.bits[1]} bits` : r.size,
    r.name, r.type, r.align, r.pad ? `${r.pad} before` : '',
  ]);
  if (L.tail) rows.push([L.size - L.tail, L.tail, '(tail padding)', '', '', `${L.tail} at end`]);

  // other structs in the paste
  const others = parsed.defs.filter((d) => d !== def && d.tag).map((d) => {
    try { const x = layout(d, env); return [`${d.kind} ${d.tag}`, x.size, x.align]; } catch { return [`${d.kind} ${d.tag}`, '–', '–']; }
  });

  // C: annotated + static asserts
  const nameC = title.startsWith('anonymous') ? 'T' : title;
  const asserts = [`#include <stddef.h>`, `/* ${abi.name}${env.pack ? `, #pragma pack(${env.pack})` : ''} */`, `_Static_assert(sizeof(${nameC}) == ${L.size}, "${title} size");`];
  for (const r of L.rows) if (!r.bits && r.name && !r.name.startsWith('(')) asserts.push(`_Static_assert(offsetof(${nameC}, ${r.name}) == ${r.offset}, "${r.name}");`);
  const texts = [{ title: 'Static asserts', body: asserts.join('\n'), lang: 'c' }];
  if (re && re.size < L.size) {
    const lines = [`${def.kind} ${def.tag || tdName || 'reordered'} {   /* ${re.size} bytes instead of ${L.size} */`];
    for (const r of re.order) {
      const m = def.members.find((x) => (x.name || '(anonymous)') === r.name);
      const decl = m && m.src ? m.src.join(' ').replace(/\s*([[\]*;,])\s*/g, '$1').replace(/;$/, '') : `${r.type} ${r.name}`;
      lines.push(`    ${decl.replace(/,.*$/, '')};${' '.repeat(Math.max(1, 34 - decl.length))}/* offset ${r.newOffset} */`);
    }
    lines.push('};');
    texts.push({ title: 'Reordered', body: lines.join('\n'), lang: 'c' });
  }

  if (L.hasBits) warnings.push(`Bit-field layout is implementation-defined: this follows ${abi.msvc ? 'MSVC' : 'GCC/Clang'} rules. Never use bit-fields for a wire or register format shared with other compilers; check with the static asserts.`);
  if (L.packLimit === 1 && abiKey !== 'avr') warnings.push('Packed: members may be misaligned. On Cortex-M0/M0+ and RISC-V without misaligned support, a misaligned 16/32-bit access faults or is emulated; the compiler emits byte accesses when it knows, but a pointer to a packed member does not carry that knowledge.');
  if (re && re.size < L.size && padTotal > 0 && L.packLimit !== 1) warnings.push(`Ordering members largest alignment first would save ${L.size - re.size} bytes (see the Reordered tab), unless the order is fixed by a protocol or register map.`);
  const usesLongDouble = def.members.some((m) => m.type.ref === 'words' && m.type.words.includes('long') && m.type.words.includes('double'));
  if (usesLongDouble && abiKey === 'mcu32') warnings.push('long double is taken as 8 bytes (ARM, ESP32 Xtensa); on RISC-V 32 it is 16 bytes, aligned 16: check your target.');
  const usesEnum = def.members.some((m) => m.type.ref === 'enum');
  const notes = [
    `ABI: ${abi.name}. int ${abi.int[0]}, long ${abi.long[0]}, pointer ${abi.ptr[0]}, double ${abi.double[0]} (align ${abi.double[1]}) bytes.`,
    'Padding bytes have unspecified contents: memset the struct before sending or hashing it, or compare members one by one.',
  ];
  if (usesEnum) notes.push(abi.shortEnums
    ? 'arm-none-eabi-gcc uses short enums by default: an enum takes the smallest integer that holds its values (1, 2 or 4 bytes). Code built with -fno-short-enums, or linked with libraries that were, sees 4 bytes.'
    : `Enums are taken as ${abi.enum[0]} bytes (int); with -fshort-enums they shrink to the smallest integer that holds their values.`);
  if (others.length) notes.push(`Also parsed: ${others.map((o) => `${o[0]} (${o[1]} bytes)`).join(', ')}. Name one in "Struct to show" to lay it out.`);

  return {
    values,
    warnings,
    tables: [{ title: `${title} on ${abi.name}`, columns: ['Offset', 'Size', 'Member', 'Type', 'Align', 'Padding'], rows }],
    texts,
    notes,
    layout: { title, size: L.size, align: L.align, padding: padTotal, rowBytes: abi.word, cells: cells.map(({ bitfield, ...c }) => c), reorderedSize: re ? re.size : null },
  };
}
