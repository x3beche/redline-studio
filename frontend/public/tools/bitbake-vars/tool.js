// BitBake Variable Resolver: the final value of one variable from the lines
// that assign it, evaluated the way BitBake's datastore does it.
//
// Pure: no DOM. The model is a port of bitbake 2.8 (Scarthgap):
//   lib/bb/parse/parse_py/ConfHandler.py  __config_regexp__, line joining
//   lib/bb/parse/ast.py  DataNode.eval     = ?= ??= := += =+ .= =. at parse time
//   lib/bb/data_smart.py setVar            :append/:prepend/:remove queued as
//                                          flags, override variants registered
//                        getVarFlag        override selection, then :append,
//                                          :prepend, ${} expansion, :remove
//                        need_overrides    OVERRIDES read until stable
//   lib/bb/data.py expandKeys              ${} in names expanded after parsing
// and the ordering in bitbake-user-manual-metadata.rst ("Examples").
//
// A value carries, per character, the statement that wrote it (p), the
// statement whose ${VAR} pulled it in (r) and that variable's name (k), so the
// final value can be drawn as segments that trace back to their lines.

// ---------------- values with provenance ----------------
const V = (s, id = -1) => ({ s, p: new Array(s.length).fill(id), r: new Array(s.length).fill(-1), k: new Array(s.length).fill('') });
const cat = (...vs) => {
  const out = { s: '', p: [], r: [], k: [] };
  for (const v of vs) { if (!v) continue; out.s += v.s; out.p.push(...v.p); out.r.push(...v.r); out.k.push(...v.k); }
  return out;
};
const cut = (v, a, b) => ({ s: v.s.slice(a, b), p: v.p.slice(a, b), r: v.r.slice(a, b), k: v.k.slice(a, b) });
const copyV = (v) => (v ? cut(v, 0, v.s.length) : null);

// ---------------- BitBake's own patterns ----------------
// ConfHandler.py __config_regexp__ (groups: 1 export, 2 var, 4 flag, 5 op, 6 quote, 7 value)
const CONFIG_RE = /^(export\s+)?([a-zA-Z0-9\-_+.${}/~:]+?)(\[([a-zA-Z0-9\-_+.][a-zA-Z0-9\-_+.@]*)\])?\s*(:=|\?\?=|\?=|\+=|=\+|=\.|\.=|=)\s*(?!'[^']*'[^']*'$)(?!"[^"]*"[^"]*"$)(['"])(.*)\6$/;
const EXPORT_RE = /^export\s+([a-zA-Z0-9\-_+.${}/~]+)$/;
const UNSET_RE = /^unset\s+([a-zA-Z0-9\-_+.${}/~:]+)$/;
const UNSET_FLAG_RE = /^unset\s+([a-zA-Z0-9\-_+.${}/~]+)\[([a-zA-Z0-9\-_+.][a-zA-Z0-9\-_+.@]+)\]$/;
const DIRECTIVE_RE = /^(include|require|inherit|inherit_defer|addtask|deltask|addhandler|EXPORT_FUNCTIONS|addpylib|include_all)\b/;
const FUNC_RE = /^(fakeroot\s+)?(python\s+)?([\w.\-+${}:]*)\s*\(\s*\)\s*\{\s*$|^python\s+[\w.\-+${}:]*\s*\{\s*$|^def\s+\w+\s*\(/;
// data_smart.py
const SETVAR_RE = /^(.*?)(:append|:prepend|:remove)(?::([^A-Z]*))?$/;
const OVERRIDE_RE = /^[a-z0-9]/; // __override_regexp__ = [a-z0-9]+ used with .match()
const EXPAND_RE = /\$\{[a-zA-Z0-9\-_+./~:]+\}/g;
const PYTHON_RE = /\$\{@(?:\{.*?\}|.)+?\}/g;

// Variables that are space-separated lists in OE-Core (bitbake.conf, image.bbclass, ...).
const LISTVARS = /^(DISTRO_FEATURES|MACHINE_FEATURES|IMAGE_INSTALL|IMAGE_FEATURES|EXTRA_IMAGE_FEATURES|CORE_IMAGE_EXTRA_INSTALL|DEPENDS|RDEPENDS|RRECOMMENDS|RSUGGESTS|RPROVIDES|RCONFLICTS|RREPLACES|PROVIDES|PACKAGES|FILES|SRC_URI|EXTRA_OECONF|EXTRA_OECMAKE|EXTRA_OEMESON|PACKAGECONFIG|KERNEL_FEATURES|INHERIT|IMAGE_FSTYPES|SYSTEMD_SERVICE|INSANE_SKIP|LICENSE_FLAGS_ACCEPTED|MACHINE_EXTRA_RRECOMMENDS|MACHINE_ESSENTIAL_EXTRA_RDEPENDS|DISTRO_EXTRA_RDEPENDS|BBMASK|BBFILES|BBLAYERS|TOOLCHAIN_HOST_TASK|TOOLCHAIN_TARGET_TASK|ROOTFS_POSTPROCESS_COMMAND|IMAGE_LINGUAS|USERADD_PACKAGES)(:|$)/;
const OP_NAME = { '=': 'set', '?=': 'set?', '??=': 'weak default', ':=': 'immediate', '+=': 'append', '=+': 'prepend', '.=': 'postdot', '=.': 'predot' };

// ---------------- the datastore ----------------
class Store {
  constructor(opts) {
    this.vars = new Map();
    this.od = new Map();          // overridedata: shortvar -> [[fullvar, override]]
    this.setter = new Map();      // var -> statement id of the last _content write
    this.dsetter = new Map();     // var -> statement id of the weak default
    this.off = opts.off; this.add = opts.add;
    this.overrides = null; this.ovset = new Set(); this.inoverride = false;
    this.python = new Set(); this.unknown = new Set(); this.errors = [];
  }
  get(name) { return this.vars.get(name); }
  ensure(name) { let v = this.vars.get(name); if (!v) { v = {}; this.vars.set(name, v); } return v; }

  updateOverrides(v) {
    // _setvar_update_overrides: FOO:a:b registers as an override of FOO:a (b)
    // and of FOO (a:b).
    let i = v.lastIndexOf(':');
    if (i < 0) return;
    let override = v.slice(i + 1), shortvar = v.slice(0, i);
    while (override && OVERRIDE_RE.test(override)) {
      if (!this.od.has(shortvar)) this.od.set(shortvar, []);
      const list = this.od.get(shortvar);
      if (!list.some(([a, b]) => a === v && b === override)) list.push([v, override]);
      override = null;
      const j = shortvar.lastIndexOf(':');
      if (j >= 0) {
        override = v.slice(j + 1); shortvar = v.slice(0, j);
        if (!shortvar.length) override = null;
      }
    }
  }

  setVar(name, val, sid) {
    this.overrides = null;
    const m = SETVAR_RE.exec(name);
    if (m) {
      const base = m[1], kw = m[2], ov = m[3] || '';
      const entry = this.ensure(base);
      (entry[kw] ||= []).push({ v: val, o: ov, sid });
      this.updateOverrides(base);
      return;
    }
    const entry = this.ensure(name);
    entry.content = val;
    this.setter.set(name, sid);
    if (name.includes(':')) this.updateOverrides(name);
  }

  needOverrides() {
    if (this.overrides !== null || this.inoverride) return;
    let prev = null;
    for (let i = 0; i < 5; i++) {
      this.inoverride = true; this.overrides = []; this.ovset = new Set();
      const got = this.getVar('OVERRIDES').v;
      this.inoverride = false;
      let list = (got ? got.s : '').split(':');
      list = list.filter((o) => !this.off.has(o));
      for (const a of this.add) if (!list.includes(a)) list.push(a);
      this.overrides = list; this.ovset = new Set(list);
      if (prev && prev.join(':') === list.join(':')) return;
      prev = list; this.overrides = null;
    }
    this.overrides = prev || []; this.ovset = new Set(this.overrides);
    this.errors.push('OVERRIDES did not settle after 5 rounds (it refers to itself through overridden variables).');
  }

  condOk(o) { if (!o) return true; return o.split(':').every((x) => this.overrides.includes(x)); }

  // getVarFlag(var, "_content", ...). With tr, records each step it takes.
  getVar(name, { expand = true, parsing = false, noweakdefault = false, tr = null, depth = 0 } = {}) {
    if (depth > 40) { this.errors.push(`Expansion of ${name} is too deep (a reference loop?).`); return { v: null, hits: [] }; }
    const local = this.vars.get(name);
    let value = null;
    let removes = [];
    let chosen = null;
    if (!parsing && this.od.has(name)) {
      this.needOverrides();
      const od = this.od.get(name);
      const active = new Map();
      for (const [r, o] of od) {
        if (this.ovset.has(o)) active.set(o, r);
        else if (o.includes(':') && o.split(':').every((x) => this.ovset.has(x))) active.set(o, r);
      }
      let match = null, mod = true;
      while (mod) {
        mod = false;
        for (const o of this.overrides) {
          for (const a of [...active.keys()]) {
            if (a.endsWith(':' + o)) {
              const t = active.get(a); active.delete(a);
              active.set(a.split(':' + o).join(''), t); mod = true;
            } else if (a === o) { match = active.get(a); active.delete(a); }
          }
        }
      }
      if (tr) {
        tr.push({ step: 'override', chosen: match, candidates: od.map(([r, o]) => ({ var: r, override: o,
          active: o.split(':').every((x) => this.ovset.has(x)), sid: this.setter.get(r) ?? firstSid(this.vars.get(r)) })) });
      }
      if (match) {
        const sub = this.getVar(match, { expand: false, depth: depth + 1 });
        value = sub.v; removes = sub.hits; chosen = match;
        if (tr) tr.push({ step: 'base', from: match, sid: this.setter.get(match) ?? -1, v: copyV(value) });
      }
    }
    if (local && value === null) {
      if (local.content !== undefined) { value = copyV(local.content); if (tr) tr.push({ step: 'base', from: name, sid: this.setter.get(name) ?? -1, v: copyV(value) }); }
      else if (local.defaultval !== undefined && !noweakdefault) { value = copyV(local.defaultval); if (tr) tr.push({ step: 'base', from: name, weak: true, sid: this.dsetter.get(name) ?? -1, v: copyV(value) }); }
    }
    if (tr && value === null) tr.push({ step: 'base', from: name, sid: -1, v: null });
    if (local && local[':append'] && !parsing) {
      this.needOverrides();
      for (const e of local[':append']) {
        const ok = this.condOk(e.o);
        const glue = ok && !!value && /\S$/.test(value.s) && /^\S/.test(e.v.s) && (LISTVARS.test(name) || /\S\s+\S/.test(value.s));
        if (ok) value = cat(value || V(''), e.v);
        if (tr) tr.push({ step: 'append', sid: e.sid, cond: e.o, applied: ok, glue, v: copyV(value) });
      }
    }
    if (local && local[':prepend'] && !parsing) {
      this.needOverrides();
      for (const e of local[':prepend']) {
        const ok = this.condOk(e.o);
        const glue = ok && !!value && /^\S/.test(value.s) && /\S$/.test(e.v.s) && (LISTVARS.test(name) || /\S\s+\S/.test(value.s));
        if (ok) value = cat(e.v, value || V(''));
        if (tr) tr.push({ step: 'prepend', sid: e.sid, cond: e.o, applied: ok, glue, v: copyV(value) });
      }
    }
    if (expand && value) {
      const refs = [];
      value = this.expandV(value, name, depth, refs);
      if (tr && refs.length) tr.push({ step: 'expand', refs, v: copyV(value) });
    }
    const hits = [];
    let all = [...removes];
    if (value && local && local[':remove'] && !parsing) {
      this.needOverrides();
      for (const e of local[':remove']) {
        const ok = this.condOk(e.o);
        if (ok) all.push(e);
        else if (tr) tr.push({ step: 'remove', sid: e.sid, cond: e.o, applied: false, words: [], v: copyV(value) });
      }
    }
    if (value && all.length && !parsing) {
      // Removes act on the expanded value (so only when it is expanded, or when
      // an override variant is read for its parser, as getVarFlag does): split
      // on single whitespace characters, keeping them (__whitespace_split__),
      // and drop every word a remove names after its own expansion.
      const full = expand ? value : this.expandV(value, name, depth);
      const exp = all.map((e) => new Set(this.expandV(e.v, null, depth).s.split(/\s+/).filter(Boolean)));
      const removed = all.map(() => []);
      const s = full.s;
      const keep = [];
      let i = 0;
      while (i < s.length) {
        let j = i;
        if (/\s/.test(s[i])) j = i + 1; else { while (j < s.length && !/\s/.test(s[j])) j++; }
        const w = s.slice(i, j);
        let skip = false;
        if (!/\s/.test(w)) all.forEach((e, n) => { if (exp[n].has(w)) { skip = true; removed[n].push({ word: w, sid: full.p[i] }); } });
        if (!skip) keep.push(cut(full, i, j));
        i = j;
      }
      all.forEach((e, n) => { if (removed[n].length) hits.push(e); });
      if (expand) value = cat(V(''), ...keep);
      if (tr) all.forEach((e, n) => tr.push({ step: 'remove', sid: e.sid, cond: e.o, applied: true, carried: removes.includes(e), words: [...exp[n]], removed: removed[n], v: copyV(value) }));
    }
    if (tr) tr.chosen = chosen;
    return { v: value, hits };
  }

  expandV(val, varname, depth, refs) {
    let cur = val;
    for (let round = 0; round < 50 && cur.s.includes('${'); round++) {
      const before = cur.s;
      let out = [], last = 0;
      EXPAND_RE.lastIndex = 0;
      let m;
      while ((m = EXPAND_RE.exec(cur.s))) {
        const key = m[0].slice(2, -1);
        out.push(cut(cur, last, m.index));
        if (varname && key === varname) {
          this.errors.push(`${varname} references itself: BitBake stops with "variable ${varname} references itself!".`);
          out.push(cut(cur, m.index, m.index + m[0].length));
        } else {
          const got = this.getVar(key, { depth: depth + 1 }).v;
          if (refs && !refs.some((x) => x.name === key)) refs.push({ name: key, value: got ? got.s : null });
          if (got === null) { this.unknown.add(key); out.push(cut(cur, m.index, m.index + m[0].length)); }
          else {
            const by = cur.r[m.index] >= 0 ? cur.r[m.index] : cur.p[m.index];
            const via = cur.k[m.index] || key;
            const g = copyV(got);
            g.r = g.r.map((x) => (x >= 0 ? x : by)); g.k = g.k.map((x) => x || via);
            out.push(g);
          }
        }
        last = m.index + m[0].length;
      }
      out.push(cut(cur, last, cur.s.length));
      cur = cat(V(''), ...out);
      PYTHON_RE.lastIndex = 0;
      for (const pm of cur.s.matchAll(PYTHON_RE)) this.python.add(pm[0]);
      if (cur.s === before) break;
    }
    return cur;
  }
}
const firstSid = (entry) => (entry && entry.content ? (entry.content.p.find((x) => x >= 0) ?? -1) : -1);

// ---------------- reading the pasted lines ----------------
const FILE_HDR = [
  /^#+\s*file:\s*(\S.*?)\s*$/i,          // # file: conf/local.conf
  /^==>\s*(.+?)\s*<==\s*$/,              // head/tail style
  /^---\s+(\S+\.(?:conf|bb|bbappend|bbclass|inc))\s*-*\s*$/,
];
const GREP_RE = /^((?:[\w.\-+/~]+\/)?[\w.\-+~%]+\.(?:conf|bb|bbappend|bbclass|inc))[:-](\d+)[:-](.*)$/;

export function parseLines(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const stmts = [];
  const files = [];
  let file = '(pasted)';
  let fileLine = 0;
  const fileIdx = (f) => { let i = files.indexOf(f); if (i < 0) { files.push(f); i = files.length - 1; } return i; };
  let i = 0;
  let inFunc = null;
  while (i < src.length) {
    const rawLine = src[i];
    let t = rawLine.trim();
    const start = i;
    let g = GREP_RE.exec(rawLine);
    let realLine = null;
    if (g) { file = g[1]; realLine = Number(g[2]); t = g[3].trim(); }
    else {
      const hdr = FILE_HDR.map((re) => re.exec(t)).find(Boolean);
      if (hdr) { file = hdr[1]; fileLine = 0; i++; fileIdx(file); continue; }
    }
    fileLine++;
    if (inFunc) {
      if (/^\}\s*$/.test(t)) inFunc = null;
      i++; continue;
    }
    if (!t || t.startsWith('#')) { i++; continue; }
    // A backslash at the end joins the next line (ConfHandler: s[:-1] + next.rstrip()).
    let s = t;
    while (s.endsWith('\\') && i + 1 < src.length) {
      i++;
      let nxt = src[i];
      const g2 = GREP_RE.exec(nxt);
      if (g2) nxt = g2[3];
      s = s.slice(0, -1) + nxt.replace(/\s+$/, '');
      fileLine++;
    }
    const base = { id: stmts.length, file, fi: fileIdx(file), line: realLine ?? fileLine, row: start, rowEnd: i, text: s };
    i++;
    const m = CONFIG_RE.exec(s);
    if (m) {
      stmts.push({ ...base, kind: m[4] ? 'flag' : 'assign', exp: !!m[1], key: m[2], flag: m[4] || null, op: m[5], value: m[7] });
      continue;
    }
    if (FUNC_RE.test(s)) {
      const nm = /(?:python\s+)?([\w.\-+${}:]*)\s*\(/.exec(s);
      stmts.push({ ...base, kind: 'func', key: nm ? nm[1] : '' });
      if (!s.startsWith('def ')) inFunc = true; else inFunc = null;
      continue;
    }
    let u = UNSET_FLAG_RE.exec(s);
    if (u) { stmts.push({ ...base, kind: 'unsetflag', key: u[1], flag: u[2] }); continue; }
    u = UNSET_RE.exec(s);
    if (u) { stmts.push({ ...base, kind: 'unset', key: u[1] }); continue; }
    u = EXPORT_RE.exec(s);
    if (u) { stmts.push({ ...base, kind: 'export', key: u[1] }); continue; }
    if (DIRECTIVE_RE.test(s)) { stmts.push({ ...base, kind: 'directive', key: '' }); continue; }
    stmts.push({ ...base, kind: 'bad', key: '' });
  }
  return { stmts, files, rows: src.length };
}

const OLD_SYNTAX = /_(append|prepend|remove)(\b|_|$)/;
const short = (f) => String(f).split('/').slice(-1)[0];
const famOf = (key) => key.replace(/:(append|prepend|remove)(:.*)?$/, '');

// ---------------- run ----------------
export function run(input) {
  const warnings = [], notes = [];
  const listOf = (s) => String(s ?? '').split(/[:\s,]+/).map((x) => x.trim()).filter(Boolean);
  const off = new Set(listOf(input.off));
  const add = listOf(input.add);
  const { stmts, files } = parseLines(input.text);
  const S = new Store({ off, add });

  // The tool's own inputs are weak defaults, so a pasted MACHINE ?= / = wins.
  const TOOL = -2;
  const weak = (k, v) => { if (String(v ?? '').trim()) { S.ensure(k).defaultval = V(String(v).trim(), TOOL); S.dsetter.set(k, TOOL); } };
  weak('OVERRIDES', input.overrides); weak('MACHINE', input.machine); weak('DISTRO', input.distro); weak('PN', input.pn);

  const last = new Map();         // var -> last statement that set _content, and how
  for (const st of stmts) {
    st.status = 'applied'; st.note = '';
    if (st.kind === 'bad') { st.status = 'unparsed'; st.note = 'not an assignment BitBake reads (it would stop with "unparsed line")'; continue; }
    if (st.kind === 'directive') { st.status = 'not followed'; st.note = 'include/inherit contents are not part of the paste'; continue; }
    if (st.kind === 'func') { st.status = 'function'; st.note = 'a function body, not a variable value'; continue; }
    if (st.kind === 'export') { st.status = 'flag'; st.note = 'marks the variable for export'; continue; }
    if (st.kind === 'unsetflag' || st.kind === 'flag') {
      st.status = 'flag'; st.note = `sets the [${st.flag}] flag, not the value`;
      if (st.kind === 'flag' && st.op !== '=' && st.op !== '??=' && st.op !== '?=') st.note += ` (${st.op})`;
      continue;
    }
    if (st.kind === 'unset') { S.vars.delete(st.key); S.od.delete(st.key); st.note = 'deletes the variable and everything queued on it'; last.delete(st.key); continue; }
    const key = st.key;
    if (!key.startsWith('__anon_') && OLD_SYNTAX.test(key)) {
      st.status = 'error'; st.note = 'old override syntax: BitBake 1.52+ stops with a fatal error here';
      continue;
    }
    // ast.py DataNode.eval
    const lit = V(st.value, st.id);
    const cur = () => { const g = S.getVar(key, { expand: false, parsing: true, noweakdefault: true }).v; return g; };
    let val = lit;
    const kwKey = /:(append|prepend|remove)(:|$)/.test(key);
    if (st.op === '?=') {
      const had = cur();
      if (had !== null) {
        const who = last.get(key);
        st.status = 'skipped'; st.note = who ? `already set by ${short(who.file)}:${who.line} (${who.op})` : "already set";
        st.skippedBy = who ? who.id : -1; st.after = copyV(had);
        continue;
      }
      st.op2 = 'set?';
    } else if (st.op === ':=') {
      S.overrides = null;
      const refs = [];
      val = S.expandV(lit, key, 0, refs);
      st.refs = refs;
    } else if (st.op === '+=') { const c = cur(); val = cat(c || V(''), V(' ', st.id), lit); st.base = c ? c.s : null; }
    else if (st.op === '=+') { const c = cur(); val = cat(lit, V(' ', st.id), c || V('')); st.base = c ? c.s : null; }
    else if (st.op === '.=') { const c = cur(); val = cat(c || V(''), lit); st.base = c ? c.s : null; }
    else if (st.op === '=.') { const c = cur(); val = cat(lit, c || V('')); st.base = c ? c.s : null; }
    if (kwKey && ['+=', '=+', '.=', '=.', '?='].includes(st.op)) {
      st.warn = `${key} ${st.op} is not a recommended operator combination (BitBake warns); use ${key} = "..."`;
    }
    if (st.op === '??=') {
      const e = S.ensure(key); e.defaultval = val; S.dsetter.set(key, st.id); S.overrides = null;
      st.after = copyV(val);
      if (e.content !== undefined) { st.status = 'shadowed'; st.note = 'a weak default, but the variable already has a value'; }
      continue;
    }
    const m = SETVAR_RE.exec(key);
    S.setVar(key, val, st.id);
    if (m) {
      st.queued = m[2]; st.cond = m[3] || '';
      st.status = 'queued'; st.note = `${m[2]} runs when the value is read, after all = += ?= lines`;
      st.after = copyV(val);
    } else {
      last.set(key, { id: st.id, line: st.line, op: st.op, file: st.file });
      st.after = copyV(S.get(key).content);
    }
  }

  // expandKeys: ${} in a name is expanded once parsing is done.
  const todo = [...S.vars.keys()].filter((k) => k.includes('${')).sort();
  const renamed = [];
  for (const k of todo) {
    S.overrides = null;
    const ek = S.expandV(V(k), null, 0).s;
    if (ek === k) continue;
    const from = S.vars.get(k);
    const to = S.ensure(ek);
    const val = from.content ?? from.defaultval;
    if (val !== undefined) {
      if (to.content !== undefined) warnings.push(`Variable key ${k} replaces the original key ${ek} after key expansion (BitBake warns): the value set for ${ek} is lost.`);
      to.content = val; S.setter.set(ek, S.setter.get(k) ?? S.dsetter.get(k) ?? -1);
      S.updateOverrides(ek);
    }
    for (const kw of [':append', ':prepend', ':remove']) if (from[kw]) (to[kw] ||= []).push(...from[kw]);
    if (S.od.has(k)) { S.od.set(ek, S.od.get(k).map(([v, o]) => [v.replace(k, ek), o])); S.od.delete(k); }
    S.vars.delete(k);
    renamed.push([k, ek]);
    S.updateOverrides(ek);
  }
  S.overrides = null;
  S.needOverrides();
  const overrides = S.overrides.slice();

  // Which variable to resolve
  const expKey = (k) => (k.includes('${') ? S.expandV(V(k), null, 0).s : k);
  for (const st of stmts) if (st.key && (st.kind === 'assign' || st.kind === 'flag')) { st.ekey = expKey(st.key); st.fam = famOf(st.ekey); st.base0 = st.fam.split(':')[0]; }
  const counts = new Map();
  for (const st of stmts) if (st.kind === 'assign' && st.base0) counts.set(st.base0, (counts.get(st.base0) || 0) + 1);
  let focus = String(input.var ?? '').trim();
  if (focus.includes('${')) focus = expKey(focus);
  if (!focus) focus = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  if (!focus) {
    return { values: [{ label: 'Variable', value: '–' }], warnings: ['No assignments were found. Paste lines like DISTRO_FEATURES:append = " systemd".'],
      eval: { stmts: [], files, focus: '', rows: [] } };
  }

  const tr = [];
  S.errors.length = 0; S.unknown.clear(); S.python.clear();
  const res = S.getVar(focus, { tr });
  const final = res.v;
  const pre = (() => { const g = S.getVar(focus, { expand: false }); return g.v; })();

  // ---------------- findings ----------------
  const rel = (st) => st.ekey && (st.fam === focus || st.fam.startsWith(focus + ':') || st.ekey === focus);
  const rows = stmts.filter((st) => st.kind === 'assign' && rel(st));
  for (const st of stmts) {
    if (st.status === 'unparsed') warnings.push(`${st.file}:${st.line} is not an assignment BitBake can read: ${st.text.slice(0, 60)}. Check the quotes and the operator.`);
    if (st.status === 'error') warnings.push(`${st.file}:${st.line} uses the old ${st.key.match(OLD_SYNTAX)[0]} syntax; BitBake 1.52 (Honister) and later stop with a fatal error. Write ${st.key.replace(/_(append|prepend|remove)/g, ':$1')}.`);
  }
  for (const st of rows) {
    if (st.warn) warnings.push(`${st.file}:${st.line}: ${st.warn}.`);
    if (st.status === 'skipped' && st.skippedBy >= 0) {
      const by = stmts[st.skippedBy];
      if (['+=', '=+', '.=', '=.'].includes(by.op)) {
        warnings.push(`${st.file}:${st.line} ${st.key} ?= was skipped because ${by.file}:${by.line} (${by.op}) ran first and created the variable, so the default "${st.value.slice(0, 50)}${st.value.length > 50 ? '…' : ''}" never applied. Use ${by.key}:append = " ${by.value.trim()}" there instead.`);
        st.trap = true;
      }
    }
  }
  // An :append glued onto the previous word.
  const glued = [];
  for (const t of tr) if (t.glue && stmts[t.sid] && !glued.includes(stmts[t.sid])) glued.push(stmts[t.sid]);
  for (const st of glued) {
    const ap = st.queued === ':append';
    const w = st.value.trim().split(/\s+/);
    warnings.push(`${st.file}:${st.line} ${st.queued} has no ${ap ? 'leading' : 'trailing'} space, so "${ap ? w[0] : w[w.length - 1]}" is glued to the neighbouring word. ${st.queued} adds exactly what is quoted; write "${ap ? ' ' : ''}${st.value.trim()}${ap ? '' : ' '}".`);
    st.glue = true;
  }
  for (const t of tr) if (t.step === 'remove' && t.applied && !t.carried && !t.removed.length) {
    const st = stmts[t.sid];
    notes.push(`${st.file}:${st.line} :remove "${st.value.trim()}" matched no word in the value.`);
    st.noop = true;
  }
  for (const u of S.unknown) if (rows.length) notes.push(`\${${u}} is not set by the pasted lines, so it stays literal (paste its assignment, or it comes from a file not shown).`);
  for (const p of S.python) notes.push(`Inline Python ${p.length > 60 ? p.slice(0, 57) + '…}' : p} is not evaluated here; BitBake runs it at expansion time.`);
  for (const e of S.errors) warnings.push(e);
  for (const [k, ek] of renamed) if (ek === focus || ek.startsWith(focus + ':')) notes.push(`Key ${k} was expanded to ${ek} after parsing.`);
  const chosen = tr.chosen;
  const ovStep = tr.find((t) => t.step === 'override');
  if (ovStep && chosen) notes.push(`${chosen} replaces ${focus}: its override is active${ovStep.candidates.filter((c) => c.active).length > 1 ? ' and highest in OVERRIDES (later entries win)' : ''}. The ${focus} = / += lines no longer matter, but ${focus}:append/:prepend/:remove still apply.`);
  if (!rows.length) warnings.push(`No line assigns ${focus}. Pick one of: ${[...counts.keys()].slice(0, 8).join(', ')}.`);

  // ---------------- segments for the drawing ----------------
  const segs = (v) => {
    if (!v) return null;
    const out = [];
    for (let i = 0; i < v.s.length; i++) {
      const lastSeg = out[out.length - 1];
      if (lastSeg && lastSeg.s === v.p[i] && lastSeg.r === v.r[i] && lastSeg.k === v.k[i]) lastSeg.t += v.s[i];
      else out.push({ t: v.s[i], s: v.p[i], r: v.r[i], k: v.k[i] });
    }
    return out;
  };
  const removedWords = [];
  for (const t of tr) if (t.step === 'remove' && t.applied) for (const w of t.removed || []) removedWords.push({ word: w.word, from: w.sid, by: t.sid });

  const stepsOut = tr.map((t) => {
    const o = { step: t.step, sid: t.sid ?? -1, v: segs(t.v) };
    if (t.step === 'override') { o.candidates = t.candidates; o.chosen = t.chosen; delete o.v; }
    if (t.step === 'base') { o.from = t.from; o.weak = !!t.weak; }
    if (t.step === 'append' || t.step === 'prepend' || t.step === 'remove') { o.cond = t.cond; o.applied = t.applied; o.glue = !!t.glue; }
    if (t.step === 'remove') { o.words = t.words; o.removed = (t.removed || []).map((w) => w.word); o.carried = !!t.carried; }
    if (t.step === 'expand') o.refs = t.refs;
    return o;
  });

  // Overrides mentioned by the lines, for the chips.
  const mentioned = new Set();
  for (const st of stmts) if (st.ekey) {
    const parts = st.ekey.split(':').slice(1).filter((p) => !['append', 'prepend', 'remove'].includes(p) && OVERRIDE_RE.test(p));
    for (const p of parts) mentioned.add(p);
  }
  const ovChips = [];
  const baseList = (() => { const save = [S.off, S.add]; S.off = new Set(); S.add = []; S.overrides = null; S.needOverrides(); const l = S.overrides.slice(); [S.off, S.add] = save; S.overrides = null; S.needOverrides(); return l; })();
  for (const o of baseList) if (o) ovChips.push({ name: o, on: !off.has(o), inList: true, used: mentioned.has(o) });
  for (const o of add) if (!baseList.includes(o)) ovChips.push({ name: o, on: true, inList: false, used: mentioned.has(o), added: true });
  for (const o of mentioned) if (!ovChips.some((c) => c.name === o)) ovChips.push({ name: o, on: false, inList: false, used: true });

  const finalStr = final ? final.s : '';
  const words = finalStr.split(/\s+/).filter(Boolean);

  // ---------------- text outputs ----------------
  const hist = [];
  hist.push('#', `# $${focus} [${rows.length} operations]`);
  for (const st of rows) {
    let op = OP_NAME[st.op] || st.op;
    const m = SETVAR_RE.exec(st.ekey);
    if (m) op = m[3] ? `${m[2]}[${m[3]}]` : m[2];
    else if (st.ekey !== focus) op = `override[${st.ekey.slice(focus.length + 1)}]:${op}`;
    const tag = st.status === 'skipped' ? ' (skipped: ' + st.note + ')' : st.status === 'error' ? ' (fatal: old syntax)' : '';
    hist.push(`#   ${op} ${st.file}:${st.line}${tag}`, `#     "${st.value}"`);
  }
  hist.push('# pre-expansion value:', `#   "${pre ? pre.s : ''}"`);
  hist.push(`${focus}="${finalStr}"`);
  const texts = [{ title: 'bitbake -e', body: hist.join('\n') + '\n' }];
  texts.push({ title: 'Final value', body: `${focus}="${finalStr}"\n` });

  // ---------------- tables and values ----------------
  const table = {
    title: `Evaluation of ${focus} (parse order, then getVar)`,
    columns: ['Step', 'Where', 'Line', 'Effect', 'Value after'],
    rows: [],
  };
  let n = 1;
  for (const st of rows) {
    const eff = st.status === 'queued' ? `queued ${st.queued}${st.cond ? ` [${st.cond}]` : ''}` : st.status === 'applied' ? (OP_NAME[st.op] || st.op) + (st.ekey !== focus ? ` ${st.ekey}` : '') : `${st.status}: ${st.note}`;
    const after = st.status === 'queued' || !st.after ? '' : st.after.s;
    table.rows.push([n++, `${st.file}:${st.line}`, st.text.length > 90 ? st.text.slice(0, 87) + '…' : st.text, eff, after.length > 90 ? after.slice(0, 87) + '…' : after]);
  }
  for (const t of stepsOut) {
    if (t.step === 'override') { table.rows.push([n++, 'getVar', '(override selection)', t.chosen ? `${t.chosen} wins` : 'no active override variant', '']); continue; }
    if (t.step === 'base') continue;
    const st = stmts[t.sid];
    const where = st ? `${st.file}:${st.line}` : 'getVar';
    const v = t.v ? t.v.map((x) => x.t).join('') : '';
    const vs = v.length > 90 ? v.slice(0, 87) + '…' : v;
    if (t.step === 'expand') table.rows.push([n++, 'getVar', 'expand ' + t.refs.map((r) => '${' + r.name + '}').join(' '), 'expanded', vs]);
    else table.rows.push([n++, where, st ? st.text : '', t.applied ? (t.step === 'remove' ? `removed ${t.removed.join(' ') || 'nothing'}` : `${t.step} applied`) : `skipped: [${t.cond}] not in OVERRIDES`, vs]);
  }

  const values = [
    { label: 'Variable', value: focus },
    { label: 'Final value', value: finalStr === '' ? '(empty)' : finalStr, hint: final === null ? 'not set' : `${words.length} word${words.length === 1 ? '' : 's'}` },
    { label: 'Lines for it', value: rows.length },
    { label: 'Override variant', value: chosen || 'none', hint: chosen ? 'replaces the base value' : 'base value used' },
    { label: 'Words removed', value: removedWords.length },
    { label: 'OVERRIDES', value: overrides.filter(Boolean).length ? overrides.filter(Boolean).join(':') : '(empty)' },
  ];
  if (warnings.length) values[1].tone = 'warn';

  const outStmts = stmts.map((st) => ({
    id: st.id, file: st.file, fi: st.fi, line: st.line, row: st.row, rowEnd: st.rowEnd, text: st.text, kind: st.kind,
    key: st.key || '', ekey: st.ekey || '', base: st.base0 || '', op: st.op || '', value: st.value ?? '', status: st.status, note: st.note,
    queued: st.queued || '', cond: st.cond ?? '', after: st.status === 'queued' ? segs(st.after) : segs(st.after),
    refs: st.refs || null, by: st.skippedBy ?? -1, trap: !!st.trap, glue: !!st.glue, noop: !!st.noop, warn: st.warn || '', rel: rows.includes(st),
    immediate: st.op === ':=',
  }));
  const vars = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));

  return {
    values,
    tables: [table],
    texts,
    warnings,
    notes,
    eval: {
      focus, files, stmts: outStmts, steps: stepsOut, final: segs(final), finalNull: final === null, pre: pre ? pre.s : null,
      removed: removedWords, overrides, chips: ovChips, vars, lazy: /\$\{/.test(pre ? pre.s : ''),
    },
  };
}
