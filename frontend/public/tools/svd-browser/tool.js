// SVD Register Browser: a CMSIS-SVD file read into peripherals, registers and
// fields; one register's value decoded field by field against it; a search
// over every name and description; and a C header for one peripheral.
//
// Everything follows the CMSIS-SVD format description (Arm, schema 1.3,
// Apache-2.0): https://arm-software.github.io/CMSIS_5/SVD/html/svd_Format_pg.html
//   - register properties (size, access, resetValue, resetMask) are inherited
//     device -> peripheral -> cluster -> register; a field inherits access
//     (and modifiedWriteValues / readAction) from its register
//   - derivedFrom copies an element; elements given again override
//   - dim / dimIncrement / dimIndex: "NAME[%s]" is an array, "NAME%s" a list
//     whose %s takes each dimIndex entry ("0-3" or "A,B,C"; default 0..dim-1)
//   - a field's bits are bitOffset+bitWidth, lsb+msb or bitRange "[msb:lsb]"
//   - numbers: decimal, 0x hex, #binary (0b accepted too); enumerated values
//     may use x for a don't-care bit in the # form ("#0xxx")
//
// The XML reader here is a small one written for this tool (no DOMParser in
// Node): elements, attributes, text, comments, CDATA and the five entities.

import { SAMPLE_SVD } from './sample-svd.js';

// ---------------- XML ----------------
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; }
  return ENT[e] ?? m;
}));
const local = (name) => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };

function parseXml(text) {
  const root = { tag: '#root', attrs: {}, kids: [], text: '', line: 1 };
  const stack = [root];
  const errors = [];
  let i = 0, line = 1, seen = 0;
  const n = text.length;
  const lineAt = (pos) => {
    for (let k = text.indexOf('\n', seen); k >= 0 && k < pos; k = text.indexOf('\n', k + 1)) line++;
    seen = Math.max(seen, pos);
    return line;
  };
  const err = (pos, msg) => { if (errors.length < 12) errors.push({ line: lineAt(pos), message: msg }); };
  const addText = (s) => { const top = stack[stack.length - 1]; if (top.kids.length === 0 || s.trim()) top.text += s; };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { addText(decode(text.slice(i))); break; }
    if (lt > i) addText(decode(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) { err(lt, 'comment never closed'); break; }
      i = e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) { err(lt, 'CDATA never closed'); break; }
      addText(text.slice(lt + 9, e)); i = e + 3; continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1; continue;
    }
    // Tag end: the first '>' outside a quoted attribute value.
    let j = lt + 1, q = '';
    for (; j < n; j++) {
      const c = text[j];
      if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      else if (c === '<') break;
    }
    if (j >= n || text[j] !== '>') { err(lt, 'tag never closed'); i = j; continue; }
    const body = text.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      const name = local(body.slice(1).trim());
      let k = stack.length - 1;
      while (k > 0 && stack[k].tag !== name) k--;
      if (k === 0) { err(lt, `</${name}> closes nothing`); continue; }
      if (k !== stack.length - 1) err(lt, `<${stack[stack.length - 1].tag}> (line ${stack[stack.length - 1].line}) not closed before </${name}>`);
      stack.length = k;
      continue;
    }
    const self = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) { err(lt, 'a tag with no name'); continue; }
    const node = { tag: local(m[1]), attrs: {}, kids: [], text: '', line: lineAt(lt) };
    const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    re.lastIndex = m[0].length;
    while ((a = re.exec(body))) node.attrs[local(a[1])] = decode(a[2] ?? a[3] ?? '');
    stack[stack.length - 1].kids.push(node);
    if (!self) stack.push(node);
  }
  if (stack.length > 1) err(n, `<${stack[stack.length - 1].tag}> (line ${stack[stack.length - 1].line}) never closed`);
  return { root, errors };
}

const kid = (node, tag) => node && node.kids.find((k) => k.tag === tag);
const kids = (node, tag) => (node ? node.kids.filter((k) => k.tag === tag) : []);
const txt = (node, tag) => { const k = kid(node, tag); if (!k) return null; const t = k.text.trim().replace(/\s+/g, ' '); return t === '' ? null : t; };

// ---------------- numbers ----------------
// scaledNonNegativeInteger: [+]?(0x|0X|#)?[0-9a-fA-F]+[kmgtKMGT]? (SVD format,
// "Data types"); 0b is accepted as many files use it.
const SCALE = { k: 1n << 10n, m: 1n << 20n, g: 1n << 30n, t: 1n << 40n };
function big(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/^\+/, '').replace(/[_']/g, '');
  let mul = 1n;
  const sc = /^(?:0x[0-9a-f]+|#?[0-9]+)([kmgt])$/i.exec(t);
  if (sc) { mul = SCALE[sc[1].toLowerCase()]; t = t.slice(0, -1); }
  try {
    if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t) * mul;
    if (/^(#|0b)[01]+$/i.test(t)) return BigInt('0b' + t.replace(/^(#|0b)/i, '')) * mul;
    if (/^[0-9]+$/.test(t)) return BigInt(t) * mul;
  } catch { /* fall through */ }
  return null;
}
const num = (s) => { const v = big(s); return v == null || v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v); };
const hex = (v, bits = 32) => '0x' + BigInt.asUintN(Math.max(1, bits), BigInt(v)).toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0');
const hexA = (a) => '0x' + a.toString(16).toUpperCase().padStart(8, '0');
const ones = (w) => (1n << BigInt(w)) - 1n;

/** A user-typed value: 0x.., 0b.., #.., decimal; _ ' and spaces as separators. */
export function parseValue(s) {
  const t = String(s ?? '').trim().replace(/[\s_']/g, '');
  if (t === '') return null;
  if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  if (/^(0b|#)[01]+$/i.test(t)) return BigInt('0b' + t.replace(/^(0b|#)/i, ''));
  if (/^\d+$/.test(t)) return BigInt(t);
  if (/^[0-9a-f]+h$/i.test(t)) return BigInt('0x' + t.slice(0, -1));
  return null;
}

// Enumerated value: a number, or #bits with x don't-care (SVD enumeratedValue.value).
function enumValue(s) {
  const t = String(s ?? '').trim();
  const p = /^(#|0b)([01x]+)$/i.exec(t);
  if (p && /x/i.test(p[2])) {
    const bits = p[2].toLowerCase();
    return { value: BigInt('0b' + bits.replace(/x/g, '0')), care: BigInt('0b' + bits.replace(/[01]/g, '1').replace(/x/g, '0')), text: t };
  }
  const v = big(t);
  return v == null ? null : { value: v, care: null, text: t };
}

// ---------------- dim ----------------
function dimList(node) {
  const dim = num(txt(node, 'dim'));
  if (!dim || dim < 1) return null;
  const inc = num(txt(node, 'dimIncrement')) ?? 0;
  const di = txt(node, 'dimIndex');
  let idx = null;
  if (di) {
    const r = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(di);
    const ra = /^\s*([A-Z])\s*-\s*([A-Z])\s*$/.exec(di);
    if (r) { const a = +r[1], b = +r[2]; idx = Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => String(a + k)); }
    else if (ra) { const a = ra[1].charCodeAt(0), b = ra[2].charCodeAt(0); idx = Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => String.fromCharCode(a + k)); }
    else idx = di.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (!idx || idx.length !== dim) idx = Array.from({ length: dim }, (_, k) => String(k));
  return { dim: Math.min(dim, 4096), inc, idx: idx.slice(0, 4096) };
}
/** One instance's name: NAME[%s] -> NAME[k] (array, k = 0..), NAME%s -> the dimIndex entry. */
function dimName(name, d, k) {
  if (name.includes('[%s]')) return name.replace('[%s]', `[${k}]`);
  return name.replace(/%s/g, d.idx[k]);
}
const subst = (s, d, k) => (s && d ? s.replace(/%s/g, d.idx[k]) : s);

// ---------------- access ----------------
const ACC = { 'read-only': 'ro', 'write-only': 'wo', 'read-write': 'rw', writeOnce: 'w1', 'read-writeOnce': 'rw1' };
const MWV = { oneToClear: 'w1c', oneToSet: 'w1s', oneToToggle: 'w1t', zeroToClear: 'w0c', zeroToSet: 'w0s', zeroToToggle: 'w0t', clear: 'wc', set: 'ws', modify: '' };
const RA = { clear: 'rc', set: 'rs', modify: 'rm', modifyExternal: 'rm' };
const tagFor = (access, mwv, ra) => [ACC[access] || 'rw', MWV[mwv] || '', RA[ra] || ''].filter(Boolean).join('/');
const MWV_TEXT = { oneToClear: 'write 1 to clear', oneToSet: 'write 1 to set', oneToToggle: 'write 1 to toggle', zeroToClear: 'write 0 to clear', zeroToSet: 'write 0 to set', zeroToToggle: 'write 0 to toggle', clear: 'any write clears', set: 'any write sets', modify: '' };
const RA_TEXT = { clear: 'a read clears it', set: 'a read sets it', modify: 'a read changes it', modifyExternal: 'a read has a side effect elsewhere' };

// ---------------- the model ----------------
function build(text) {
  const { root, errors } = parseXml(text);
  const problems = errors.map((e) => `XML line ${e.line}: ${e.message}`);
  const dev = kid(root, 'device');
  if (!dev) {
    problems.unshift('No <device> element: this is not a CMSIS-SVD file (it should start with <device ...> after the XML declaration).');
    return { ok: false, problems, peripherals: [], device: {} };
  }
  const device = {
    name: txt(dev, 'name') || '(unnamed)', vendor: txt(dev, 'vendor') || '', version: txt(dev, 'version') || '',
    description: txt(dev, 'description') || '', schema: dev.attrs.schemaVersion || '',
    cpu: txt(kid(dev, 'cpu'), 'name') || '', width: num(txt(dev, 'width')) || 32,
  };
  const props0 = { size: num(txt(dev, 'size')) || 32, access: txt(dev, 'access') || 'read-write',
    reset: big(txt(dev, 'resetValue')) ?? 0n, resetMask: big(txt(dev, 'resetMask')), mwv: null, ra: null };
  const pnodes = kids(kid(dev, 'peripherals'), 'peripheral');
  const byName = new Map();
  for (const p of pnodes) { const nm = txt(p, 'name'); if (nm && !byName.has(nm)) byName.set(nm, p); }

  // Named enumeratedValues anywhere, for derivedFrom="Name" or "A.B.C.Name".
  const enumIndex = new Map();
  const indexEnums = (node, path) => {
    for (const k of node.kids) {
      if (k.tag === 'enumeratedValues') { const nm = txt(k, 'name'); if (nm) { if (!enumIndex.has(nm)) enumIndex.set(nm, k); enumIndex.set([...path, nm].join('.'), k); } }
      else if (k.kids.length) { const nm = txt(k, 'name'); indexEnums(k, nm && k.tag !== 'enumeratedValues' ? [...path, nm] : path); }
    }
  };
  indexEnums(kid(dev, 'peripherals') || { kids: [] }, []);

  // derivedFrom at the XML level: the base's children, with every child the
  // derived element gives itself replacing the base's children of that tag;
  // a derived peripheral's own <registers> adds to / replaces by name.
  const merge = (base, own) => {
    const ownTags = new Set(own.kids.map((k) => k.tag));
    const out = { tag: own.tag, attrs: { ...own.attrs }, kids: [], text: own.text, line: own.line, derived: own.attrs.derivedFrom };
    delete out.attrs.derivedFrom;
    for (const k of base.kids) if (!ownTags.has(k.tag) || k.tag === 'registers') out.kids.push(k);
    for (const k of own.kids) {
      if (k.tag === 'registers' && kid(base, 'registers')) {
        const b = kid(base, 'registers');
        const ownNames = new Set(k.kids.map((x) => txt(x, 'name')));
        const reg = { tag: 'registers', attrs: {}, text: '', line: k.line, kids: [...b.kids.filter((x) => !ownNames.has(txt(x, 'name'))), ...k.kids] };
        out.kids = out.kids.filter((x) => x.tag !== 'registers');
        out.kids.push(reg);
      } else out.kids.push(k);
    }
    return out;
  };
  const resolvedP = new Map();
  const resolveP = (node, depth = 0) => {
    const from = node.attrs.derivedFrom;
    if (!from) return node;
    if (resolvedP.has(node)) return resolvedP.get(node);
    const base = byName.get(from) || byName.get(from.split('.').pop());
    if (!base || depth > 8) { problems.push(`${txt(node, 'name') || 'a peripheral'} (line ${node.line}): derivedFrom="${from}" names no peripheral; its registers are missing.`); resolvedP.set(node, node); return node; }
    const out = merge(resolveP(base, depth + 1), node);
    resolvedP.set(node, out);
    return out;
  };
  // Registers / clusters / fields: derivedFrom a sibling by name, or a dotted path from a peripheral.
  const findPath = (path, siblings) => {
    const sib = siblings.find((s) => txt(s, 'name') === path);
    if (sib) return sib;
    const parts = path.split('.');
    let cur = byName.get(parts[0]);
    if (!cur) return null;
    cur = resolveP(cur);
    for (const part of parts.slice(1)) {
      const regs = kid(cur, 'registers') || cur;
      const nx = regs.kids.find((k) => (k.tag === 'register' || k.tag === 'cluster') && txt(k, 'name') === part)
        || kids(kid(cur, 'fields'), 'field').find((k) => txt(k, 'name') === part);
      if (!nx) return null;
      cur = nx;
    }
    return cur;
  };
  const resolveR = (node, siblings, where, depth = 0) => {
    const from = node.attrs.derivedFrom;
    if (!from) return node;
    const base = findPath(from, siblings);
    if (!base || base === node || depth > 8) { problems.push(`${where}${txt(node, 'name') || node.tag} (line ${node.line}): derivedFrom="${from}" not found.`); return node; }
    return merge(resolveR(base, siblings, where, depth + 1), node);
  };

  const inherit = (node, up) => ({
    size: num(txt(node, 'size')) ?? up.size,
    access: txt(node, 'access') ?? up.access,
    reset: big(txt(node, 'resetValue')) ?? up.reset,
    resetMask: big(txt(node, 'resetMask')) ?? up.resetMask,
    mwv: txt(node, 'modifiedWriteValues') ?? up.mwv,
    ra: txt(node, 'readAction') ?? up.ra,
  });

  const readEnums = (ev, where) => {
    let node = ev;
    if (ev.attrs.derivedFrom) {
      const f = ev.attrs.derivedFrom;
      const base = enumIndex.get(f) || enumIndex.get(f.split('.').pop());
      if (!base) problems.push(`${where}: enumeratedValues derivedFrom="${f}" not found.`);
      else node = merge(base, ev);
    }
    const values = kids(node, 'enumeratedValue').map((e) => {
      const isDefault = /^(true|1)$/i.test(txt(e, 'isDefault') || '');
      const v = isDefault ? null : enumValue(txt(e, 'value'));
      return { name: txt(e, 'name') || '', desc: txt(e, 'description') || '', v, isDefault };
    });
    return { name: txt(node, 'name') || '', usage: txt(node, 'usage') || 'read-write', values };
  };

  const readFields = (rnode, props, where) => {
    const out = [];
    const fnodes = kids(kid(rnode, 'fields'), 'field');
    for (const raw of fnodes) {
      const f = resolveR(raw, fnodes, where);
      const d = dimList(f);
      const name0 = txt(f, 'name') || '?';
      let lsb = num(txt(f, 'bitOffset')), width = num(txt(f, 'bitWidth'));
      if (lsb != null) width = width ?? 1;
      else if (txt(f, 'lsb') != null && txt(f, 'msb') != null) { lsb = num(txt(f, 'lsb')); const msb = num(txt(f, 'msb')); width = msb != null && lsb != null ? msb - lsb + 1 : null; }
      else { const br = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(txt(f, 'bitRange') || ''); if (br) { lsb = +br[2]; width = +br[1] - +br[2] + 1; } }
      if (lsb == null || !(width >= 1)) { problems.push(`${where}${name0} (line ${f.line}): no readable bit position (bitOffset/bitWidth, lsb/msb or bitRange); field skipped.`); continue; }
      const access = txt(f, 'access') ?? props.access;
      const mwv = txt(f, 'modifiedWriteValues') ?? props.mwv;
      const ra = txt(f, 'readAction') ?? props.ra;
      const enums = kids(f, 'enumeratedValues').map((e) => readEnums(e, `${where}${name0}`));
      const n = d ? d.dim : 1;
      for (let k = 0; k < n; k++) {
        out.push({ name: d ? dimName(name0, d, k) : name0, stem: name0, desc: subst(txt(f, 'description') || '', d, k),
          lsb: lsb + (d ? k * d.inc : 0), width, access, mwv, ra, tag: tagFor(access, mwv, ra), enums, line: f.line });
      }
    }
    out.sort((a, b) => a.lsb - b.lsb);
    return out;
  };

  // A container's registers and clusters, as a tree (for the C struct) and
  // flattened into instances (for browsing and decoding).
  const readItems = (container, up, where) => {
    const items = [];
    const nodes = container ? container.kids.filter((k) => k.tag === 'register' || k.tag === 'cluster') : [];
    for (const raw of nodes) {
      const node = resolveR(raw, nodes, where);
      const props = inherit(node, up);
      const d = dimList(node);
      const name = txt(node, 'name') || '?';
      const offset = num(txt(node, 'addressOffset'));
      if (offset == null) { problems.push(`${where}${name} (line ${node.line}): no addressOffset; skipped.`); continue; }
      if (node.tag === 'cluster') {
        items.push({ kind: 'cluster', name, desc: txt(node, 'description') || '', offset, d, props,
          struct: txt(node, 'headerStructName') || '', items: readItems(node, props, `${where}${name.replace(/\[?%s\]?/, '')}.`) });
      } else {
        items.push({ kind: 'reg', name, desc: txt(node, 'description') || '', display: txt(node, 'displayName') || '', offset, d, props,
          alt: txt(node, 'alternateRegister') || txt(node, 'alternateGroup') || '', line: node.line,
          fields: readFields(node, props, `${where}${name}.`) });
      }
    }
    return items;
  };
  const flatten = (items, base, prefix, out, cprefix) => {
    for (const it of items) {
      const n = it.d ? it.d.dim : 1;
      for (let k = 0; k < n; k++) {
        const nm = it.d ? dimName(it.name, it.d, k) : it.name;
        const off = base + it.offset + (it.d ? k * it.d.inc : 0);
        if (it.kind === 'cluster') flatten(it.items, off, `${prefix}${nm}.`, out, `${cprefix}${it.name.replace(/\[?%s\]?/g, '')}_`);
        else {
          const p = it.props;
          out.push({ path: prefix + nm, name: nm, cname: cprefix + it.name.replace(/\[?%s\]?/g, ''), desc: subst(it.desc, it.d, k),
            offset: off, size: p.size, access: p.access, tag: tagFor(p.access, p.mwv, p.ra), mwv: p.mwv, ra: p.ra,
            reset: BigInt.asUintN(p.size, p.reset), resetMask: p.resetMask == null ? ones(p.size) : BigInt.asUintN(p.size, p.resetMask),
            alt: it.alt, fields: it.fields });
        }
      }
    }
    return out;
  };

  const peripherals = [];
  const seen = new Set();
  for (const raw of pnodes) {
    const node = resolveP(raw);
    const name = txt(node, 'name');
    if (!name) { problems.push(`A peripheral at line ${raw.line} has no <name>; skipped.`); continue; }
    const base = num(txt(node, 'baseAddress'));
    if (base == null) { problems.push(`${name} (line ${raw.line}): no readable baseAddress; skipped.`); continue; }
    if (seen.has(name)) problems.push(`Peripheral name ${name} appears twice (line ${raw.line}); both kept.`);
    seen.add(name);
    const props = inherit(node, props0);
    const d = dimList(node);
    const blocks = kids(node, 'addressBlock').map((b) => ({ offset: num(txt(b, 'offset')) ?? 0, size: num(txt(b, 'size')) ?? 0, usage: txt(b, 'usage') || '' }));
    const irqs = kids(node, 'interrupt').map((q) => ({ name: txt(q, 'name') || '', value: num(txt(q, 'value')) ?? -1, desc: txt(q, 'description') || '' }));
    let regsCache = null, treeCache = null;
    const n = d ? d.dim : 1;
    for (let k = 0; k < n; k++) {
      const pname = d ? dimName(name, d, k) : name;
      const pbase = base + (d ? k * d.inc : 0);
      const derivedBase = raw.attrs.derivedFrom ? (byName.get(raw.attrs.derivedFrom) ? raw.attrs.derivedFrom : raw.attrs.derivedFrom.split('.').pop()) : '';
      const per = {
        name: pname, base: pbase, group: txt(node, 'groupName') || '', desc: subst(txt(node, 'description') || '', d, k),
        derivedFrom: raw.attrs.derivedFrom || '', blocks, irqs, line: raw.line,
        struct: txt(node, 'headerStructName') || (derivedBase ? (txt(byName.get(derivedBase) || { kids: [] }, 'headerStructName') || derivedBase) : name.replace(/\[?%s\]?/g, '')),
        // Registers are read on first use: a 4 MB SVD has ten thousand of them.
        get tree() { if (!treeCache) treeCache = readItems(kid(node, 'registers'), props, `${pname}.`); return treeCache; },
        get regs() { if (!regsCache) regsCache = flatten(this.tree, 0, '', [], '').sort((a, b) => a.offset - b.offset); return regsCache; },
      };
      const blockEnd = blocks.reduce((m, b) => Math.max(m, b.offset + b.size), 0);
      per.span = blockEnd || 0;
      peripherals.push(per);
    }
  }
  peripherals.sort((a, b) => a.base - b.base || a.name.localeCompare(b.name));
  if (!peripherals.length) problems.push('The <device> lists no peripherals with a name and baseAddress.');
  return { ok: true, device, peripherals, problems };
}

// The last file parsed, kept: the page runs the tool on every click and the
// SVD text does not change between clicks. Same text, same model.
let memo = { text: null, model: null };
function model(text) {
  if (memo.text !== text) memo = { text, model: build(text) };
  return memo.model;
}

// ---------------- decoding ----------------
function matchEnum(enums, v, forWrite = false) {
  const sets = enums.filter((e) => (forWrite ? e.usage !== 'read' : e.usage !== 'write'));
  const use = sets.length ? sets : enums;
  let dflt = null;
  for (const set of use) {
    for (const e of set.values) {
      if (e.isDefault) { dflt = dflt || e; continue; }
      if (!e.v) continue;
      if (e.v.care == null ? e.v.value === v : (v & e.v.care) === e.v.value) return e;
    }
  }
  return dflt;
}
const enumChoices = (enums) => {
  const sets = enums.filter((e) => e.usage !== 'read');
  return (sets.length ? sets : enums).flatMap((s) => s.values).filter((e) => e.v)
    .map((e) => ({ name: e.name, value: e.v.value.toString(), text: e.v.text, desc: e.desc, pattern: e.v.care != null }));
};

function decodeReg(reg, v) {
  const size = reg.size;
  let covered = 0n;
  const problems = [];
  const fields = reg.fields.map((f) => {
    const mask = ones(f.width) << BigInt(f.lsb);
    if (covered & mask) problems.push(`Field ${f.name} (bits ${f.lsb + f.width - 1}:${f.lsb}) overlaps another field of ${reg.path} in the SVD.`);
    if (f.lsb + f.width > size) problems.push(`Field ${f.name} reaches bit ${f.lsb + f.width - 1}, past the ${size}-bit register ${reg.path}: an SVD error.`);
    covered |= mask;
    const fv = (v >> BigInt(f.lsb)) & ones(f.width);
    const rv = (reg.reset >> BigInt(f.lsb)) & ones(f.width);
    const rknown = ((reg.resetMask >> BigInt(f.lsb)) & ones(f.width)) === ones(f.width);
    const e = f.enums.length ? matchEnum(f.enums, fv) : null;
    return { f, fv, rv, rknown, e, mask };
  });
  const loose = v & ~covered & ones(size);
  return { fields, covered: covered & ones(size), loose, problems };
}
const bitsList = (m, size) => { const out = []; for (let b = size - 1; b >= 0; b--) if ((m >> BigInt(b)) & 1n) out.push(b); return out; };
const fmtBits = (list) => {
  const asc = [...list].sort((a, b) => a - b); const runs = [];
  for (const b of asc) { const r = runs[runs.length - 1]; if (r && r[1] === b - 1) r[1] = b; else runs.push([b, b]); }
  return runs.reverse().map(([a, b]) => (a === b ? `${a}` : `${b}:${a}`)).join(', ');
};
const fieldBits = (f) => (f.width === 1 ? `${f.lsb}` : `${f.lsb + f.width - 1}:${f.lsb}`);
const fval = (x, w) => (w === 1 ? x.toString() : w <= 4 ? `${x} (0b${x.toString(2).padStart(w, '0')})` : `${x} (${hex(x, w)})`);

// ---------------- C output ----------------
const cid = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
const ctype = (size) => (size <= 8 ? 'uint8_t' : size <= 16 ? 'uint16_t' : size <= 32 ? 'uint32_t' : 'uint64_t');
// CMSIS-Core access qualifiers: __I read-only, __O write-only, __IO read-write (core_cm*.h).
const qual = (a) => (a === 'read-only' ? '__I ' : a === 'write-only' ? '__O ' : '__IO');

function structFor(typeName, items, pre, padTo = 0) {
  const members = [];
  for (const it of items) {
    const n = it.d ? it.d.dim : 1;
    const isArr = it.d && it.name.includes('[%s]');
    if (it.kind === 'cluster') {
      const stem = cid(it.name.replace(/\[?%s\]?/g, ''));
      const tname = it.struct ? cid(it.struct) : `${typeName}_${stem}`;
      const one = structSize(it.items);
      const size = it.d && it.d.inc > one ? it.d.inc : one;
      structFor(tname, it.items, pre, size);
      if (isArr && (it.d.inc === size || n === 1)) members.push({ off: it.offset, bytes: size * n, decl: `${tname}_TypeDef ${stem}[${n}];`, note: it.desc.replace(/%s/g, 'n') });
      else for (let k = 0; k < n; k++) members.push({ off: it.offset + (it.d ? k * it.d.inc : 0), bytes: size, decl: `${tname}_TypeDef ${cid(it.d ? dimName(it.name, it.d, k).replace(/\[(\w+)\]/, '$1') : it.name)};`, note: subst(it.desc, it.d, k) });
    } else {
      const bytes = Math.ceil(it.props.size / 8);
      const q = qual(it.props.access), t = ctype(it.props.size);
      const stem = cid(it.name.replace(/\[?%s\]?/g, ''));
      if (isArr && it.d.inc === bytes) members.push({ off: it.offset, bytes: bytes * n, decl: `${q} ${t} ${stem}[${n}];`, note: it.desc.replace(/%s/g, 'n') });
      else for (let k = 0; k < n; k++) {
        const nm = it.d ? dimName(it.name, it.d, k).replace(/\[(\w+)\]/, '$1') : it.name;
        members.push({ off: it.offset + (it.d ? k * it.d.inc : 0), bytes, decl: `${q} ${t} ${cid(nm)};`, note: subst(it.desc, it.d, k) });
      }
    }
  }
  members.sort((a, b) => a.off - b.off || b.bytes - a.bytes);
  const lines = [];
  let at = 0, pad = 0;
  const reserve = (gap) => {
    if (gap <= 0) return;
    lines.push(gap % 4 === 0 && at % 4 === 0 ? `       uint32_t RESERVED${pad++}[${gap / 4}];` : `       uint8_t  RESERVED${pad++}[${gap}];`);
  };
  for (let i = 0; i < members.length;) {
    const m = members[i];
    // Registers at one offset (alternate views) go into an anonymous union.
    const same = [m];
    while (i + same.length < members.length && members[i + same.length].off === m.off) same.push(members[i + same.length]);
    if (m.off < at) { lines.push(`  /* ${m.decl.replace(/;$/, '')} at +0x${m.off.toString(16).toUpperCase()} overlaps the member before it; left out */`); i += same.length; continue; }
    reserve(m.off - at);
    const offs = `0x${m.off.toString(16).toUpperCase().padStart(3, '0')}`;
    if (same.length === 1) lines.push(`  ${m.decl.padEnd(38)} /*!< ${offs} ${m.note} */`);
    else {
      lines.push('  union {');
      for (const s of same) lines.push(`    ${s.decl.padEnd(36)} /*!< ${offs} ${s.note} */`);
      lines.push('  };');
    }
    at = m.off + Math.max(...same.map((s) => s.bytes));
    i += same.length;
  }
  if (padTo > at) reserve(padTo - at);
  pre.push(`typedef struct {\n${lines.join('\n')}\n} ${typeName}_TypeDef;`);
}
function structSize(items) {
  let end = 0;
  for (const it of items) {
    const n = it.d ? it.d.dim : 1, inc = it.d ? it.d.inc : 0;
    const one = it.kind === 'cluster' ? structSize(it.items) : Math.ceil(it.props.size / 8);
    end = Math.max(end, it.offset + (n - 1) * inc + one);
  }
  return end;
}

function cHeader(dev, per, only) {
  const T = cid(per.struct);
  const pre = [];
  if (!only) structFor(T, per.tree, pre);
  const out = [`/* ${per.name}: ${per.desc || 'peripheral'} */`, `/* From ${dev.name}${dev.version ? ' v' + dev.version : ''} (CMSIS-SVD). Needs <stdint.h> and CMSIS-Core __I/__O/__IO. */`,
    ...(only ? [`/* Macros for ${only.path} only; choose "whole peripheral" for the ${T}_TypeDef struct and every register. */`] : ['', ...pre]), '',
    `#define ${cid(per.name)}_BASE  (${hexA(per.base)}UL)`, `#define ${cid(per.name)}       ((${T}_TypeDef *) ${cid(per.name)}_BASE)`];
  for (const q of per.irqs) out.push(`/* IRQ ${q.value}: ${q.name}_IRQn${q.desc ? ' - ' + q.desc : ''} */`);
  const done = new Set();
  for (const r of only ? [only] : per.regs) {
    if (done.has(r.cname)) continue;
    done.add(r.cname);
    if (!r.fields.length) continue;
    out.push('', `/* ${r.cname.replace(/_/g, '.')}: ${r.desc || ''} */`.replace(/: \*\/$/, ' */'));
    const fdone = new Set();
    for (const f of r.fields) {
      if (fdone.has(f.name)) continue; fdone.add(f.name);
      const P = `${T}_${cid(r.cname)}_${cid(f.name)}`;
      out.push(`#define ${(P + '_Pos').padEnd(36)} (${f.lsb}U)`);
      out.push(`#define ${(P + '_Msk').padEnd(36)} (${hex(ones(f.width), Math.max(4, f.width))}UL << ${P}_Pos)  /*!< ${hex(ones(f.width) << BigInt(f.lsb), r.size)} */`);
      out.push(`#define ${P.padEnd(36)} ${P}_Msk`);
      for (const e of enumChoices(f.enums)) {
        if (e.pattern) continue;
        out.push(`#define ${(P + '_' + cid(e.name)).padEnd(36)} (${e.value}UL << ${P}_Pos)${e.desc ? `  /*!< ${e.desc} */` : ''}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

function cExpr(per, reg, v, dec) {
  const T = cid(per.struct);
  const acc = `${cid(per.name)}->${reg.path.split('.').map((p) => p.replace(/^([^[]+)/, (m) => cid(m))).join('.')}`;
  const parts = [];
  for (const d of dec.fields) {
    if (!d.fv) continue;
    const P = `${T}_${cid(reg.cname)}_${cid(d.f.name)}`;
    const choice = enumChoices(d.f.enums).find((e) => !e.pattern && e.value === d.fv.toString());
    if (choice) parts.push(`${P}_${cid(choice.name)}`);
    else if (d.fv === ones(d.f.width)) parts.push(P);
    else parts.push(`(${d.fv <= 9n ? d.fv : hex(d.fv, d.f.width)}UL << ${P}_Pos)`);
  }
  if (dec.loose) parts.push(`${hex(dec.loose, reg.size)}UL`);
  return `${acc} = ${parts.length ? parts.join('\n    | ') : '0U'};  /* ${hex(v, reg.size)}${dec.loose ? `; ${hex(dec.loose, reg.size)} is in no field` : ''} */\n`;
}

// ---------------- search ----------------
function search(m, q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hits = [];
  const score = (name, desc) => { const n = name.toLowerCase(); return n === s ? 0 : n.startsWith(s) ? 1 : n.includes(s) ? 2 : desc && desc.toLowerCase().includes(s) ? 3 : -1; };
  for (const p of m.peripherals) {
    const sp = score(p.name, p.desc);
    if (sp >= 0) hits.push({ kind: 'peripheral', peripheral: p.name, register: '', field: '', desc: p.desc, rank: sp });
    for (const r of p.regs) {
      const sr = score(r.name, r.desc);
      if (sr >= 0) hits.push({ kind: 'register', peripheral: p.name, register: r.path, field: '', desc: r.desc, rank: sr + 0.1 });
      for (const f of r.fields) {
        const sf = score(f.name, f.desc);
        if (sf >= 0) hits.push({ kind: 'field', peripheral: p.name, register: r.path, field: f.name, desc: f.desc, rank: sf + 0.2 });
      }
    }
    if (hits.length > 4000) break;
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits;
}

// Edit distance, for "did you mean" on a mistyped name.
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// ---------------- run ----------------
export function run(input) {
  const warnings = [], notes = [];
  const text = String(input.svd || '').trim() ? String(input.svd) : SAMPLE_SVD;
  const sample = text === SAMPLE_SVD;
  const m = model(text);
  warnings.push(...m.problems.slice(0, 8));
  if (m.problems.length > 8) warnings.push(`${m.problems.length - 8} more SVD problems not listed.`);
  if (!m.ok || !m.peripherals.length) {
    return withView({ values: [{ label: 'SVD', value: 'not readable', tone: 'bad' }], warnings, notes: ['Paste a CMSIS-SVD file (<device> ... <peripherals> ...) or leave the SVD empty for the built-in example.'] },
      { device: m.device || {}, peripherals: [], per: null, reg: null, hits: [], hitCount: 0, sample });
  }
  const dev = m.device;
  const P = m.peripherals;

  // Which register: peripheral + register names, "PERIPH.REG" in either box,
  // or an absolute address in the register box.
  let pname = String(input.peripheral || '').trim();
  let rname = String(input.register || '').trim();
  let per = null, reg = null;
  const addr = /^0x[0-9a-f]+$/i.test(rname) ? Number(BigInt(rname)) : null;
  if (addr != null && addr >= 0x100) {
    for (const p of P) {
      if (addr < p.base || addr >= p.base + Math.max(p.span, 0x10000)) continue;
      const r = p.regs.find((x) => addr >= p.base + x.offset && addr < p.base + x.offset + x.size / 8);
      if (r) { per = p; reg = r; if (addr !== p.base + r.offset) notes.push(`${hexA(addr)} is inside ${p.name}.${r.path} (byte ${addr - p.base - r.offset}).`); break; }
    }
    if (!reg) warnings.push(`No register of ${dev.name} at ${hexA(addr)}.`);
  }
  if (!per) {
    if (!pname && rname.includes('.')) { const i = rname.indexOf('.'); pname = rname.slice(0, i); rname = rname.slice(i + 1); }
    if (pname.includes('.')) { const i = pname.indexOf('.'); rname = rname || pname.slice(i + 1); pname = pname.slice(0, i); }
    const low = pname.toLowerCase();
    per = P.find((p) => p.name === pname) || P.find((p) => p.name.toLowerCase() === low) || null;
    if (!per && pname) {
      const near = P.filter((p) => { const n = p.name.toLowerCase(); return n.includes(low) || low.includes(n) || lev(n, low) <= 2; }).slice(0, 6).map((p) => p.name);
      warnings.push(`No peripheral called ${pname}${near.length ? ` (close: ${near.join(', ')})` : ''}; showing ${P[0].name}.`);
    }
    per = per || P.find((p) => p.regs.length) || P[0];
    if (rname) {
      const rl = rname.toLowerCase();
      reg = per.regs.find((r) => r.path === rname) || per.regs.find((r) => r.path.toLowerCase() === rl) || per.regs.find((r) => r.name.toLowerCase() === rl) || null;
      if (!reg) warnings.push(`${per.name} has no register ${rname} (it has ${per.regs.slice(0, 12).map((r) => r.path).join(', ')}${per.regs.length > 12 ? ', ...' : ''}).`);
    }
    reg = reg || per.regs[0] || null;
  }

  const values = [
    { label: 'Device', value: `${dev.name}${dev.cpu ? ' (' + dev.cpu + ')' : ''}`, hint: `${P.length} peripherals${sample ? ', built-in example' : ''}` },
    { label: 'Peripheral', value: per.name, hint: `${hexA(per.base)}${per.derivedFrom ? ', derived from ' + per.derivedFrom : ''}, ${per.regs.length} registers` },
  ];
  const tables = [], texts = [];
  let view = { device: dev, sample };

  // Peripheral list (for the map on the page; a short table for agents).
  view.peripherals = P.map((p) => ({ name: p.name, base: p.base, span: p.span || 0x400, group: p.group, desc: p.desc, from: p.derivedFrom, irqs: p.irqs.map((q) => q.value) }));
  tables.push({ title: `${dev.name} peripherals`, columns: ['Peripheral', 'Base', 'Group', 'Derived from'],
    rows: P.slice(0, 120).map((p) => [p.name, hexA(p.base), p.group, p.derivedFrom]) });
  if (P.length > 120) notes.push(`${P.length - 120} more peripherals not in the table; ask for one by name.`);

  let decoded = null, v = 0n;
  if (reg) {
    const raw = String(input.value ?? '').trim();
    const pv = parseValue(raw);
    v = pv ?? reg.reset;
    if (raw && pv == null) warnings.push(`Value "${raw}" is not a number (use 0x1A2B, 0b1010 or 6699); showing the reset value.`);
    if (pv != null && pv > ones(reg.size)) {
      warnings.push(`${raw} does not fit the ${reg.size}-bit register ${reg.path}; the bits above ${reg.size - 1} are dropped.`);
      v = pv & ones(reg.size);
    }
    decoded = decodeReg(reg, v);
    warnings.push(...decoded.problems.slice(0, 4));
    const loose = bitsList(decoded.loose, reg.size);
    if (loose.length) warnings.push(`Bit${loose.length > 1 ? 's' : ''} ${fmtBits(loose)} ${loose.length > 1 ? 'are' : 'is'} set but no field of ${reg.path} covers ${loose.length > 1 ? 'them' : 'it'}: reserved bits should be written back as read (or as the reset value).`);
    const diff = (v ^ reg.reset) & reg.resetMask & ones(reg.size);
    for (const d of decoded.fields) {
      if (d.f.enums.length && !d.e && enumChoices(d.f.enums).length) warnings.push(`${reg.path}.${d.f.name} = ${d.fv} is not one of its listed values (${enumChoices(d.f.enums).map((e) => `${e.text}=${e.name}`).join(', ')}).`);
    }
    const addrAbs = per.base + reg.offset;
    values.push(
      { label: 'Register', value: `${per.name}.${reg.path}`, hint: `${hexA(addrAbs)} (+${hex(reg.offset, 12)}), ${reg.size}-bit, ${reg.tag}` },
      { label: 'Value', value: hex(v, reg.size), hint: `${v} decimal${pv == null ? ', the reset value' : ''}` },
      { label: 'Reset', value: hex(reg.reset, reg.size), hint: reg.resetMask === ones(reg.size) ? 'all bits defined' : `mask ${hex(reg.resetMask, reg.size)}` },
      { label: 'Differs from reset', value: diff ? `bits ${fmtBits(bitsList(diff, reg.size))}` : 'no', tone: diff ? 'warn' : 'ok' });
    tables.push({ title: `${per.name}.${reg.path} = ${hex(v, reg.size)}`, columns: ['Field', 'Bits', 'Access', 'Value', 'Meaning'],
      rows: [...decoded.fields].reverse().map((d) => [d.f.name, fieldBits(d.f), d.f.tag, fval(d.fv, d.f.width),
        d.e ? `${d.e.name}${d.e.desc ? ': ' + d.e.desc : ''}` : d.f.desc]) });
    if (reg.mwv && MWV_TEXT[reg.mwv]) notes.push(`${reg.path}: ${MWV_TEXT[reg.mwv]} (modifiedWriteValues ${reg.mwv}); a read-modify-write can clear flags you did not mean to.`);
    const rc = decoded.fields.filter((d) => d.f.ra);
    if (reg.ra || rc.length) notes.push(`${reg.path}: ${reg.ra ? RA_TEXT[reg.ra] : `${rc.map((d) => d.f.name).join(', ')}: ${RA_TEXT[rc[0].f.ra]}`} - a debugger read changes the hardware too.`);
    texts.push({ title: 'C expression', body: cExpr(per, reg, v, decoded), lang: 'c' });
    view.reg = {
      path: reg.path, offset: reg.offset, addr: addrAbs, size: reg.size, tag: reg.tag, access: reg.access, desc: reg.desc,
      mwv: reg.mwv ? MWV_TEXT[reg.mwv] : '', value: hex(v, reg.size), reset: hex(reg.reset, reg.size), resetMask: hex(reg.resetMask, reg.size),
      bits: v.toString(2).padStart(reg.size, '0'), resetBits: reg.reset.toString(2).padStart(reg.size, '0'),
      known: reg.resetMask.toString(2).padStart(reg.size, '0'), loose: loose, diff: bitsList(diff, reg.size),
      fields: decoded.fields.map((d) => ({ name: d.f.name, lsb: d.f.lsb, width: d.f.width, tag: d.f.tag, access: d.f.access,
        mwv: d.f.mwv ? MWV_TEXT[d.f.mwv] || '' : '', ra: d.f.ra ? RA_TEXT[d.f.ra] || '' : '', desc: d.f.desc,
        value: d.fv.toString(), hex: hex(d.fv, d.f.width), reset: d.rknown ? d.rv.toString() : '', enumName: d.e ? d.e.name : '', enumDesc: d.e ? d.e.desc : '',
        bad: !!(d.f.enums.length && !d.e && enumChoices(d.f.enums).length), choices: enumChoices(d.f.enums) })),
    };
  } else {
    warnings.push(`${per.name} has no registers in this SVD.`);
    view.reg = null;
  }

  // The peripheral's registers.
  tables.push({ title: `${per.name} registers`, columns: ['Offset', 'Register', 'Access', 'Reset', 'Fields'],
    rows: per.regs.slice(0, 80).map((r) => [hex(r.offset, 12), r.path, r.tag, hex(r.reset, r.size),
      r.fields.length > 6 ? `${r.fields.slice(0, 5).map((f) => f.name).join(' ')} +${r.fields.length - 5}` : r.fields.map((f) => f.name).join(' ')]) });
  if (per.regs.length > 80) notes.push(`${per.name} has ${per.regs.length} registers; the table lists the first 80.`);
  // Register overlaps inside the peripheral (not alternates) and registers outside its address blocks.
  const regs = per.regs;
  let overlaps = 0;
  for (let i = 1; i < regs.length && overlaps < 3; i++) {
    const a = regs[i - 1], b = regs[i];
    if (b.offset < a.offset + a.size / 8 && !a.alt && !b.alt && b.offset !== a.offset) { warnings.push(`${per.name}: ${b.path} (+${hex(b.offset, 12)}) overlaps ${a.path} (+${hex(a.offset, 12)}, ${a.size / 8} bytes) and neither is marked alternate.`); overlaps++; }
  }
  if (per.span) {
    const out = regs.filter((r) => r.offset + r.size / 8 > per.span);
    if (out.length) warnings.push(`${per.name}: ${out.slice(0, 4).map((r) => r.path).join(', ')} ${out.length > 1 ? 'lie' : 'lies'} past the end of its addressBlock (${hex(per.span, 16)} bytes).`);
  }
  view.per = {
    name: per.name, base: per.base, desc: per.desc, group: per.group, from: per.derivedFrom, span: per.span, irqs: per.irqs,
    regs: regs.map((r) => ({ path: r.path, offset: r.offset, size: r.size, tag: r.tag, reset: hex(r.reset, r.size), desc: r.desc,
      fields: r.fields.map((f) => [f.name, f.lsb, f.width, f.tag]) })),
  };

  // Search over every peripheral, register and field.
  const q = String(input.search || '').trim();
  if (q) {
    const hits = search(m, q);
    view.hits = hits.slice(0, 60).map(({ rank, ...h }) => h);
    tables.push({ title: `Search "${q}": ${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > 25 ? ' (first 25)' : ''}`, columns: ['Where', 'Kind', 'Description'],
      rows: hits.slice(0, 25).map((h) => [[h.peripheral, h.register, h.field].filter(Boolean).join('.'), h.kind, h.desc.slice(0, 90)]) });
    view.hitCount = hits.length;
  } else { view.hits = []; view.hitCount = 0; }

  texts.push({ title: 'C header', body: cHeader(dev, per, input.header === 'peripheral' || !reg ? null : reg), lang: 'c' });
  if (per.derivedFrom) notes.push(`${per.name} is derived from ${per.derivedFrom}: same registers, its own base address; the C header reuses ${cid(per.struct)}_TypeDef.`);
  notes.push('Access tags: ro read-only, wo write-only, rw read-write, w1 write-once; /w1c write 1 to clear, /w0c write 0 to clear, /w1s write 1 to set, /rc read clears.');
  if (sample) notes.push('No SVD given: this is the built-in synthetic example device RLX32F1. Paste or drop your part\'s .svd to browse it.');
  return withView({ values, tables, texts, warnings, notes }, view);
}

// The drawing data rides along not enumerable: the page reads result.view,
// while the JSON output (and an agent's copy) stay the size of the findings.
function withView(result, view) {
  Object.defineProperty(result, 'view', { value: view, enumerable: false, configurable: true, writable: true });
  return result;
}
