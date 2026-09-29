// BitBake Variable Resolver - engine.
//
// Written from the BitBake User Manual ("Syntax and Operators", "Conditional
// Syntax (Overrides)", "Key Expansion", "Examples" in
// bitbake-user-manual-metadata.rst), the Yocto Project 3.4 migration guide
// ("Override syntax changes") and behaviour observed by running snippets
// through the BitBake datastore as a black box. It does not follow any
// BitBake source file.
//
// run(input) reads the pasted lines in parse order, keeps one record per
// variable (and per override variant, e.g. A:foo), replays the immediate
// operators (= ?= ??= := += =+ .= =.) line by line, queues :append/:prepend/
// :remove, and then reads the chosen variable the way getVar does:
// override variant selection, :append, :prepend, ${} expansion, :remove.
// Every piece of text carries the line it came from, so the page can colour
// the final value by source.

const KEYWORDS = new Set(['append', 'prepend', 'remove']);
const OP_LABEL = {
  '=': 'set', '?=': 'set?', '??=': 'weak default', ':=': 'immediate',
  '+=': 'append', '=+': 'prepend', '.=': 'postdot', '=.': 'predot', unset: 'unset',
};
const APPEND_OPS = new Set(['+=', '=+', '.=', '=.']);
const DIRECTIVES = /^(inherit|inherit_defer|include|include_all|require|addtask|deltask|addhandler|addpylib|EXPORT_FUNCTIONS)\b/;
// A statement: optional export, the key (variable name, overrides, ${} in
// names), an optional [flag], the operator, and a quoted value.
const ASSIGN = /^(?:export\s+)?([A-Za-z0-9_${}\-.+/~@:]+?)(?:\[([^\]]*)\])?\s*(\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=)\s*(["'])([\s\S]*)\4\s*$/;
const REF = () => /\$\{([^{}@\s:]+)\}/g;

const short = (f) => f.split('/').slice(-1)[0];
// Longer than n + 3 characters: keep n and an ellipsis.
const cut = (s, n) => (s.length > n + 3 ? s.slice(0, n) + '…' : s);
const str = (segs) => (segs ? segs.map((g) => g.t).join('') : '');
const seg = (t, s, r = -1, k = '') => ({ t, s, r, k });
const copy = (segs) => (segs ? segs.map((g) => ({ ...g })) : null);
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
const listOf = (s) => String(s || '').split(/[:\s,]+/).filter(Boolean);

// ---------------------------------------------------------------- source

// Split the paste into rows with their file and line number. Files are marked
// by '# file: path', '==> path <==' (head/tail) or grep -n prefixes.
function readRows(text) {
  const rows = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let file = '(pasted)', base = -1;
  const grepFiles = new Set();
  rows.forEach((raw, r) => {
    let m;
    if ((m = /^\s*#\s*file:\s*(.+?)\s*$/i.exec(raw)) || (m = /^==>\s*(.+?)\s*<==\s*$/.exec(raw))) {
      file = m[1]; base = r; out.push({ row: r, marker: true });
      return;
    }
    if (/^--$/.test(raw) && grepFiles.size) { out.push({ row: r, marker: true }); return; }
    if ((m = /^([^\s:"'=]+):(\d+):(.*)$/.exec(raw)) && /[/.]/.test(m[1])) {
      grepFiles.add(m[1]);
      out.push({ row: r, file: m[1], line: Number(m[2]), content: m[3] });
      return;
    }
    if ((m = /^([^\s:"'=]+?)-(\d+)-(.*)$/.exec(raw)) && grepFiles.has(m[1])) {
      out.push({ row: r, file: m[1], line: Number(m[2]), content: m[3] });
      return;
    }
    out.push({ row: r, file, line: r - base, content: raw });
  });
  return out;
}

const blankStmt = (id, first, last, text) => ({
  id, file: first.file, fi: 0, line: first.line, row: first.row, rowEnd: last.row, text,
  kind: 'assign', key: '', ekey: '', base: '', op: '', value: '', status: 'applied', note: '',
  queued: '', cond: '', after: null, refs: null, by: -1, trap: false, glue: false, noop: false,
  warn: '', rel: false, immediate: false,
});

// Rows -> statements. Joins backslash continuations (the backslash and the
// newline go, as the manual's "Line Joining" says) and swallows function
// bodies, which are not variable values.
function readStatements(text) {
  const rows = readRows(text).filter((x) => !x.marker);
  const stmts = [];
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i];
    const c = first.content;
    if (!c.trim() || /^\s*#/.test(c)) continue;
    // Functions: name() {, python name() {, fakeroot name() {, def name():
    const fn = /^\s*(?:(?:python|fakeroot)\s+)*([\w\-.${}:+]*)\s*\(\s*\)\s*\{/.exec(c) || /^\s*python\s*\{/.exec(c);
    const def = /^def\s+([\w]+)\s*\(/.exec(c);
    if (fn || def) {
      let j = i;
      if (fn && !/\}\s*$/.test(c.replace(/^[^{]*\{/, ''))) {
        while (j + 1 < rows.length && rows[j].content.trim() !== '}') j++;
      } else if (def) {
        while (j + 1 < rows.length && /^(\s+\S|\s*$)/.test(rows[j + 1].content)) j++;
        while (j > i && !rows[j].content.trim()) j--;
      }
      const st = blankStmt(stmts.length, first, rows[j], rows.slice(i, j + 1).map((x) => x.content).join('\n'));
      const name = (fn ? fn[1] : def[1]) || '(anonymous)';
      Object.assign(st, { kind: 'function', key: name, ekey: name, base: name.split(':')[0], status: 'function', note: 'a function body, not a variable value' });
      stmts.push(st);
      i = j;
      continue;
    }
    // Continuation lines.
    let j = i, joined = c;
    while (/\\$/.test(joined) && j + 1 < rows.length) { j++; joined = joined.slice(0, -1) + rows[j].content; }
    const st = blankStmt(stmts.length, first, rows[j], rows.slice(i, j + 1).map((x) => x.content.trim()).join('\n'));
    const t = joined.trim();
    let m;
    if (DIRECTIVES.test(t)) {
      Object.assign(st, { kind: 'directive', key: t.split(/\s+/)[0], status: 'not followed', note: 'not followed: paste the lines it pulls in where it stands' });
    } else if ((m = /^unset\s+([^\s[]+)(?:\[([^\]]+)\])?\s*$/.exec(t))) {
      if (m[2]) Object.assign(st, { kind: 'flag', key: m[1], ekey: m[1], base: m[1].split(':')[0], op: 'unset', status: 'flag', note: `removes the [${m[2]}] flag, not the value` });
      else Object.assign(st, { key: m[1], ekey: m[1], base: m[1].split(':')[0], op: 'unset' });
    } else if ((m = /^export\s+([A-Za-z0-9_${}\-.+/~@:]+)\s*$/.exec(t))) {
      Object.assign(st, { kind: 'flag', key: m[1], ekey: m[1], base: m[1].split(':')[0], op: 'export', status: 'flag', note: 'marks the variable for export; the value is unchanged' });
    } else if ((m = ASSIGN.exec(t))) {
      const [, key, flag, op, , value] = m;
      Object.assign(st, { key, ekey: key, base: key.split(':')[0], op, value });
      if (flag != null) Object.assign(st, { kind: 'flag', status: 'flag', note: `sets the [${flag}] flag, not the value` });
      else if (/_(append|prepend|remove)/.test(key)) {
        // Old override syntax: BitBake 1.52+ (Yocto 3.4 Honister) stops with a fatal error.
        const base = key.split(':')[0].replace(/_(append|prepend|remove).*$/, '');
        Object.assign(st, { base, status: 'error', note: 'old _append/_prepend/_remove syntax: BitBake stops with a fatal parse error' });
      }
    } else {
      Object.assign(st, { kind: 'unparsed', status: 'unparsed', note: 'not a statement BitBake would accept' });
    }
    stmts.push(st);
    i = j;
  }
  return stmts;
}

// Key -> base variable, override variant, keyword and its condition.
//   A:foo            variant [foo]
//   A:append:foo     :append to A when foo is active
//   A:foo:append     :append to the variant A:foo
function splitKey(key) {
  const parts = key.split(':');
  const at = parts.findIndex((p, i) => i > 0 && KEYWORDS.has(p));
  const variant = at < 0 ? parts.slice(1) : parts.slice(1, at);
  return {
    base: parts[0], variant, name: [parts[0], ...variant].join(':'),
    kw: at < 0 ? '' : parts[at], cond: at < 0 ? [] : parts.slice(at + 1),
  };
}

// ---------------------------------------------------------------- datastore

class Store {
  constructor(stmts, overrides, fallback) {
    this.stmts = stmts;
    this.ov = new Set(overrides);
    this.ovList = overrides;
    this.fallback = fallback; // MACHINE / DISTRO / PN from the inputs
    this.recs = new Map(); // record name -> record
    this.variants = new Map(); // base -> [variant record names] in first-seen order
    this.problems = [];
  }

  rec(name, create = true) {
    let r = this.recs.get(name);
    if (!r && create) {
      const k = splitKey(name);
      r = { name, base: k.base, ovs: k.variant, value: null, weak: null, setBy: -1, weakBy: -1, onlyApp: false, appends: [], prepends: [], removes: [] };
      this.recs.set(name, r);
      if (k.variant.length) {
        const list = this.variants.get(k.base) || [];
        if (!list.includes(name)) list.push(name);
        this.variants.set(k.base, list);
      }
    }
    return r;
  }

  active(ovs) { return ovs.every((o) => this.ov.has(o)); }

  // Override selection, as the datastore behaves (checked against BitBake on
  // random variant sets): walk OVERRIDES from lowest to highest priority,
  // over and over while anything changes. A variant whose last override is
  // the current entry drops it (taking the place of any variant already
  // reduced to the same overrides); a variant reduced to exactly the current
  // entry becomes the value. The last one to do so wins.
  choose(base) {
    // Every variant counts, even one with only a :remove or an inactive
    // :append; if such a variant wins, the base value is used (see get()).
    const names = (this.variants.get(base) || []).filter((n) => this.recs.has(n));
    const cands = names.map((n) => {
      const r = this.recs.get(n);
      return { var: n, override: r.ovs.join(':'), active: this.active(r.ovs), sid: r.setBy >= 0 ? r.setBy : -1 };
    });
    const pending = new Map();
    for (const c of cands) if (c.active) pending.set(c.override, c.var);
    let chosen = null, moved = true;
    while (moved) {
      moved = false;
      for (const o of this.ovList) {
        for (const key of [...pending.keys()]) {
          if (!pending.has(key)) continue;
          if (key.endsWith(':' + o)) {
            const v = pending.get(key);
            pending.delete(key);
            pending.set(key.slice(0, -o.length - 1), v);
            moved = true;
          } else if (key === o) {
            chosen = pending.get(key);
            pending.delete(key);
          }
        }
      }
    }
    return { cands, chosen };
  }

  // The value of one record with its own conditional :append/:prepend (used
  // for a variant that replaces the base value).
  own(r) {
    let cur = copy(r.value || r.weak);
    for (const a of r.appends) if (this.active(a.cond)) cur = [...(cur || []), ...copy(a.segs)];
    for (const p of r.prepends) if (this.active(p.cond)) cur = [...copy(p.segs), ...(cur || [])];
    return cur;
  }

  // getVar(name): fully expanded segments, or null. With trace, also the
  // steps the page draws.
  get(name, { trace = false, cache = new Map(), stack = [] } = {}) {
    if (!trace && cache.has(name)) return cache.get(name);
    if (stack.includes(name)) {
      this.problems.push(`${name} references itself (${[...stack, name].join(' → ')}); BitBake stops with an expansion error.`);
      return { segs: null, loop: true };
    }
    const inner = { cache, stack: [...stack, name] };
    const steps = [];
    const rec = this.recs.get(name);
    const pick = this.choose(name);
    const { cands } = pick;
    let { chosen } = pick;
    // A winning variant without a value of its own leaves the base value.
    const empty = chosen && !this.own(this.recs.get(chosen)) ? chosen : null;
    if (empty) chosen = null;
    if (trace && cands.length) steps.push({ step: 'override', sid: -1, candidates: cands, chosen, ...(empty ? { empty } : {}) });

    let cur = null, carried = [];
    if (chosen) {
      const vr = this.recs.get(chosen);
      cur = this.own(vr);
      // The variant's own :remove lines come along when they match its value.
      const own = words(str(this.expand(cur, inner).segs));
      for (const rm of vr.removes) {
        if (!this.active(rm.cond)) continue;
        const ws = words(str(this.expand(rm.segs, inner).segs));
        if (ws.some((w) => own.includes(w))) carried.push(rm);
      }
      if (trace) steps.push({ step: 'base', sid: vr.setBy >= 0 ? vr.setBy : -1, v: copy(cur), from: chosen, weak: !vr.value && !!vr.weak });
    } else {
      let sid = -1, weak = false;
      if (rec && rec.value) { cur = copy(rec.value); sid = rec.setBy; } else if (rec && rec.weak) { cur = copy(rec.weak); sid = rec.weakBy; weak = true; } else if (this.fallback[name] != null && this.fallback[name] !== '') {
        cur = [seg(this.fallback[name], -2)]; sid = -2;
      }
      if (trace) steps.push({ step: 'base', sid, v: copy(cur), from: name, weak });
    }

    if (rec) {
      for (const a of rec.appends) {
        const on = this.active(a.cond);
        let glue = false;
        if (on) {
          const before = str(cur), add = str(a.segs);
          glue = !!add && /^\S/.test(add) && !/^\$\{/.test(add) && /\S$/.test(before) && /\s/.test(before.trim());
          cur = [...(cur || []), ...copy(a.segs)];
        }
        if (trace) steps.push({ step: 'append', sid: a.sid, v: copy(cur), cond: a.cond.join(':'), applied: on, glue });
      }
      for (const p of rec.prepends) {
        const on = this.active(p.cond);
        let glue = false;
        if (on) {
          const after = str(cur), add = str(p.segs);
          glue = !!add && /\S$/.test(add) && !/\}$/.test(add) && /^\S/.test(after) && /\s/.test(after.trim());
          cur = [...copy(p.segs), ...(cur || [])];
        }
        if (trace) steps.push({ step: 'prepend', sid: p.sid, v: copy(cur), cond: p.cond.join(':'), applied: on, glue });
      }
    }
    const pre = cur ? str(cur) : null;

    if (cur) {
      const ex = this.expand(cur, inner);
      if (trace && ex.refs.length) steps.push({ step: 'expand', sid: -1, v: copy(ex.segs), refs: ex.refs });
      cur = ex.segs;
    }

    const removed = [];
    const removes = [...(rec ? rec.removes.map((x) => ({ ...x, carried: false })) : []), ...carried.map((x) => ({ ...x, carried: true }))]
      .sort((a, b) => a.sid - b.sid);
    for (const rm of removes) {
      const on = rm.carried || this.active(rm.cond);
      const ws = words(str(this.expand(rm.segs, inner).segs));
      let gone = [];
      if (on && cur) {
        const res = removeWords(cur, new Set(ws), rm.sid);
        cur = res.segs; gone = res.removed;
        removed.push(...gone);
      }
      if (trace) steps.push({ step: 'remove', sid: rm.sid, v: copy(cur), cond: rm.cond.join(':'), applied: on, glue: false, words: ws, removed: gone.map((g) => g.word), carried: rm.carried });
    }
    const out = { segs: cur, pre, steps, removed, chosen, cands, empty };
    if (!trace) cache.set(name, out);
    return out;
  }

  // Replace ${NAME} by NAME's value; unknown names stay as written, and
  // ${@...} inline Python is left alone.
  expand(segs, ctx = {}) {
    const refs = [];
    if (!segs) return { segs, refs };
    const out = [];
    for (const g of segs) {
      let last = 0;
      const t = g.t;
      const re = REF();
      let m;
      while ((m = re.exec(t))) {
        const name = m[1];
        const v = this.get(name, { cache: ctx.cache || new Map(), stack: ctx.stack || [] });
        if (!refs.some((x) => x.name === name)) refs.push({ name, value: v.segs ? str(v.segs) : null });
        if (!v.segs) continue;
        if (m.index > last) out.push(seg(t.slice(last, m.index), g.s, g.r, g.k));
        const r = g.r >= 0 ? g.r : g.s;
        for (const x of v.segs) if (x.t) out.push(seg(x.t, x.s, r, g.k || name));
        last = m.index + m[0].length;
      }
      if (last < t.length) out.push(seg(t.slice(last), g.s, g.r, g.k));
    }
    return { segs: out, refs };
  }

  expandText(text) {
    return str(this.expand([seg(text, -1)]).segs);
  }
}

// :remove - every whitespace-separated word equal to one of the words goes;
// the whitespace around it stays ("Surrounding spaces and spacing are
// preserved", manual, Removal (Override Style Syntax)).
function removeWords(segs, set, by) {
  const full = str(segs);
  const drop = new Uint8Array(full.length);
  const removed = [];
  const owner = [];
  segs.forEach((g) => { for (let i = 0; i < g.t.length; i++) owner.push(g.s); });
  const re = /\S+/g;
  let m;
  while ((m = re.exec(full))) {
    if (set.has(m[0])) {
      drop.fill(1, m.index, m.index + m[0].length);
      removed.push({ word: m[0], from: owner[m.index], by });
    }
  }
  if (!removed.length) return { segs, removed };
  const out = [];
  let pos = 0;
  for (const g of segs) {
    let t = '';
    for (let i = 0; i < g.t.length; i++) if (!drop[pos + i]) t += g.t[i];
    pos += g.t.length;
    if (t) out.push({ ...g, t });
  }
  return { segs: out, removed };
}

// ---------------------------------------------------------------- parse pass

function replay(stmts, overrides, fallback) {
  const S = new Store(stmts, overrides, fallback);
  for (const st of stmts) {
    if (st.kind !== 'assign' || st.status === 'error') continue;
    st.status = 'applied'; st.note = ''; st.by = -1; st.trap = false; st.refs = null; st.queued = ''; st.cond = ''; st.immediate = false;
    const k = splitKey(st.key);
    if (st.op === 'unset') {
      S.recs.delete(k.name);
      if (!k.variant.length) for (const n of S.variants.get(k.base) || []) S.recs.delete(n);
      st.after = null;
      continue;
    }
    // The right-hand side: := expands it now (before this line's own key
    // exists), everything else keeps ${} as written.
    let segs = [seg(st.value, st.id)];
    if (st.op === ':=') {
      const ex = S.expand(segs);
      segs = ex.segs; st.refs = ex.refs; st.immediate = true;
    }
    const r = S.rec(k.name);
    if (k.kw) {
      st.status = 'queued';
      st.queued = ':' + k.kw;
      st.cond = k.cond.join(':');
      st.note = `:${k.kw} runs when the value is read, after all = += ?= lines`;
      if (st.op === '+=') segs = [seg(' ' + str(segs), st.id)];
      else if (st.op === '=+') segs = [seg(str(segs) + ' ', st.id)];
      const list = k.kw === 'append' ? r.appends : k.kw === 'prepend' ? r.prepends : r.removes;
      list.push({ sid: st.id, cond: k.cond, segs });
      st.after = copy(segs);
      continue;
    }
    const setValue = (v, appendOnly) => {
      r.onlyApp = r.value ? r.onlyApp && appendOnly : appendOnly;
      r.value = v; r.setBy = st.id;
    };
    switch (st.op) {
      case '=': case ':=': setValue(segs, false); break;
      case '?=':
        if (r.value) { st.status = 'skipped'; st.by = r.setBy; } else setValue(segs, false);
        break;
      case '??=':
        if (r.value) { st.status = 'skipped'; st.by = r.setBy; } else { r.weak = segs; r.weakBy = st.id; }
        break;
      case '+=': setValue([...(r.value || []), seg(' ' + str(segs), st.id)], true); break;
      case '.=': setValue([...(r.value || []), seg(str(segs), st.id)], true); break;
      case '=+': setValue([seg(str(segs) + ' ', st.id), ...(r.value || [])], true); break;
      case '=.': setValue([seg(str(segs), st.id), ...(r.value || [])], true); break;
      default: break;
    }
    if (st.status === 'skipped') {
      const by = stmts[st.by];
      st.note = `already set by ${short(by.file)}:${by.line} (${by.op})`;
      st.trap = r.onlyApp && APPEND_OPS.has(by.op);
      st.after = copy(r.value);
    } else {
      st.after = copy(st.op === '??=' ? r.weak : r.value);
    }
  }
  return S;
}

// After parsing, keys that contain ${} are expanded; the expanded key takes
// over an existing variable of that name (manual, "Key Expansion"). Queued
// operations of both are kept, the existing ones first.
function expandKeys(S, stmts, notes, warnings) {
  const moved = new Map();
  for (const [name, r] of [...S.recs]) {
    if (!name.includes('${')) continue;
    const to = S.expandText(name);
    if (to.includes('${') || to === name) continue;
    S.recs.delete(name);
    const had = S.recs.get(to);
    const t = S.rec(to);
    if (r.value || r.weak) {
      if (had && (had.value || had.weak)) warnings.push(`Variable key ${name} replaces the original key ${to} after key expansion (BitBake warns): the value set for ${to} is lost.`);
      t.value = r.value; t.weak = r.weak; t.setBy = r.setBy; t.weakBy = r.weakBy; t.onlyApp = r.onlyApp;
    }
    t.appends.push(...r.appends); t.prepends.push(...r.prepends); t.removes.push(...r.removes);
    moved.set(name, to);
    notes.push(`Key ${name} was expanded to ${to} after parsing.`);
  }
  for (const st of stmts) {
    if (!st.key.includes('${') || st.kind === 'function') continue;
    const e = S.expandText(st.key);
    if (!e.includes('${')) { st.ekey = e; if (st.status !== 'error') st.base = e.split(':')[0]; }
  }
  return moved;
}

// ---------------------------------------------------------------- run

export function run(input = {}) {
  const text = String(input.text ?? '');
  const stmts = readStatements(text);
  const fallback = { MACHINE: String(input.machine ?? '').trim(), DISTRO: String(input.distro ?? '').trim(), PN: String(input.pn ?? '').trim() };
  const off = new Set(listOf(input.off));
  const add = listOf(input.add);

  // OVERRIDES: the lines' own if they set it, else the input with ${MACHINE}
  // ${DISTRO} ${PN} filled in. A first pass finds it, a second uses it.
  const overridesFrom = (S) => {
    const r = S.recs.get('OVERRIDES');
    if (r && (r.value || r.weak)) return str(S.get('OVERRIDES').segs);
    return S.expandText(String(input.overrides ?? ''));
  };
  const first = replay(stmts, [], fallback);
  expandKeys(first, stmts, [], []);
  const ovString = overridesFrom(first);
  const overrides = ovString.split(':').filter((o) => !off.has(o));
  for (const a of add) if (!overrides.includes(a)) overrides.push(a);

  const S = replay(stmts, overrides.filter(Boolean), fallback);
  const notes = [], warnings = [];
  const keyNotes = [], keyWarnings = [];
  expandKeys(S, stmts, keyNotes, keyWarnings);

  // Files in order, and which variables the lines assign.
  const files = [];
  for (const st of stmts) {
    if (!files.includes(st.file)) files.push(st.file);
    st.fi = files.indexOf(st.file);
  }
  const counts = new Map();
  for (const st of stmts) if (st.kind === 'assign' && st.base) counts.set(st.base, (counts.get(st.base) || 0) + 1);
  const vars = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const focus = String(input.var ?? '').trim() || (vars[0] ? vars[0].name : '');
  for (const st of stmts) st.rel = st.kind === 'assign' && !!focus && st.base === focus;

  // getVar(focus) with its steps.
  const res = focus ? S.get(focus, { trace: true }) : { segs: null, pre: null, steps: [], removed: [], chosen: null, cands: [] };
  const final = res.segs;
  for (const t of res.steps) {
    const st = stmts[t.sid];
    if (!st) continue;
    if (t.glue) st.glue = true;
    if (t.step === 'remove' && t.applied && !t.removed.length) st.noop = true;
  }

  // Findings, in line order.
  for (const st of stmts) {
    const where = `${st.file}:${st.line}`;
    if (st.status === 'error') {
      const fixed = st.key.replace(/_(append|prepend|remove)(.*)$/, (_, kw, rest) => `:${kw}${rest.replace(/_/g, ':')}`);
      warnings.push(`${where} ${st.key} uses the old override syntax: since BitBake 1.52 (Yocto 3.4) this is a fatal parse error. Write ${fixed}.`);
      continue;
    }
    if (!st.rel) continue;
    const k = splitKey(st.ekey);
    if (k.kw && !['=', ':='].includes(st.op)) {
      warnings.push(`${where} ${st.key} ${st.op} mixes :${k.kw} with ${st.op}. :${k.kw} already queues the text; ${st.op === '+=' || st.op === '=+' ? 'the ' + st.op + ' only adds a space to it' : 'the ' + st.op + ' does not do what it does on a plain variable'}. Write ${st.key} = "…" and control the spacing in the quotes.`);
    }
    if (st.trap) {
      const by = stmts[st.by];
      warnings.push(`${where} ${st.base} ${st.op} was skipped because ${by.file}:${by.line} (${by.op}) ran first and created the variable, so the default "${cut(st.value, 50)}" never applied. Use ${st.base}:append = " ${by.value}" there instead.`);
    }
    if (st.glue) {
      warnings.push(st.queued === ':prepend'
        ? `${where} :prepend has no trailing space, so "${st.value}" is glued to the neighbouring word. :prepend adds exactly what is quoted; write "${st.value} ".`
        : `${where} :append has no leading space, so "${st.value}" is glued to the neighbouring word. :append adds exactly what is quoted; write " ${st.value}".`);
    }
  }
  warnings.push(...keyWarnings);
  warnings.push(...new Set(S.problems));

  notes.push(...keyNotes);
  if (res.empty) notes.push(`${res.empty} is the variant OVERRIDES selects, but it has no value of its own (only :remove lines or inactive :append/:prepend), so the base value of ${focus} is used.`);
  if (res.chosen) {
    const act = res.cands.filter((c) => c.active);
    notes.push(`${res.chosen} replaces ${focus}: its override is active${act.length > 1 ? ' and highest in OVERRIDES (later entries win)' : ''}. The ${focus} = / += lines no longer matter, but ${focus}:append/:prepend/:remove still apply.`);
  }
  for (const st of stmts) if (st.noop) notes.push(`${st.file}:${st.line} :remove "${st.value}" matched no word in the value.`);
  const py = new Set();
  for (const m of str(final).matchAll(/\$\{@([^\n]*?)\}(?=\s|$|[^)"'\w])/g)) py.add(m[1]);
  if (!py.size && /\$\{@/.test(str(final))) py.add(str(final).split('${@')[1] || '');
  for (const p of py) notes.push(`Inline Python \${@${p.length > 54 ? p.slice(0, 54) + '…' : p}} is not evaluated here; BitBake runs it at expansion time.`);
  if (stmts.some((s) => s.kind === 'directive')) notes.push('include / require / inherit lines are not followed: paste the lines of those files in their place to include them.');
  for (const st of stmts) if (st.kind === 'unparsed') notes.push(`${st.file}:${st.line} is not a statement BitBake would accept; it was left out.`);
  if (focus && !stmts.some((s) => s.rel) && final == null) notes.push(`No line assigns ${focus}.`);

  // OVERRIDES chips: the list, what is added, and overrides the lines use
  // that OVERRIDES does not have.
  const used = [];
  for (const st of stmts) {
    if (st.kind !== 'assign') continue;
    const k = splitKey(st.ekey);
    for (const o of [...k.variant, ...k.cond]) if (o && !o.includes('${') && !used.includes(o)) used.push(o);
  }
  const listed = [...new Set(ovString.split(':').filter(Boolean))];
  const chips = listed.map((name) => ({ name, on: !off.has(name), inList: true, used: used.includes(name) }));
  for (const a of add) if (!listed.includes(a)) chips.push({ name: a, on: true, inList: false, used: used.includes(a), added: true });
  for (const u of used) if (!listed.includes(u) && !add.includes(u)) chips.push({ name: u, on: false, inList: false, used: true });

  const removed = res.removed || [];
  const finalStr = final ? str(final) : null;
  const eval_ = {
    focus, files, stmts, steps: res.steps, final: final ? copy(final) : null, finalNull: final == null,
    pre: res.pre ?? null, removed, overrides, chips, vars, lazy: !!(res.pre && res.pre.includes('${')),
  };

  // Table: the parse, then getVar.
  const rows = [];
  const rel = stmts.filter((s) => s.rel);
  for (const st of rel) {
    let effect;
    if (st.status === 'queued') effect = `queued ${st.queued}${st.cond ? ` [${st.cond}]` : ''}`;
    else if (st.status === 'skipped') effect = `skipped: ${st.note}`;
    else if (st.status === 'error') effect = `fatal: ${st.note}`;
    else effect = `${OP_LABEL[st.op] || st.op}${st.ekey !== focus ? ' ' + st.ekey : ''}`;
    const after = st.status === 'queued' || st.status === 'error' ? '' : cut(str(st.after), 87);
    rows.push([rows.length + 1, `${st.file}:${st.line}`, cut(st.text, 87), effect, after]);
  }
  for (const t of res.steps) {
    const st = stmts[t.sid];
    if (t.step === 'override') rows.push([rows.length + 1, 'getVar', '(override selection)', t.chosen ? `${t.chosen} wins` : 'no variant active', '']);
    else if (t.step === 'expand') rows.push([rows.length + 1, 'getVar', `expand ${t.refs.map((r) => '${' + r.name + '}').join(' ')}`, 'expanded', cut(str(t.v), 87)]);
    else if (t.step === 'append' || t.step === 'prepend') {
      rows.push([rows.length + 1, `${st.file}:${st.line}`, st.text, t.applied ? `${t.step} applied` : `skipped: [${t.cond}] not in OVERRIDES`, cut(str(t.v), 87)]);
    } else if (t.step === 'remove') {
      rows.push([rows.length + 1, `${st.file}:${st.line}`, st.text, t.applied ? (t.removed.length ? `removed ${t.removed.join(' ')}` : 'removed nothing') : `skipped: [${t.cond}] not in OVERRIDES`, cut(str(t.v), 87)]);
    }
  }

  // bitbake -e style history.
  const hist = ['#', `# $${focus} [${rel.length} operations]`];
  for (const st of rel) {
    let label = OP_LABEL[st.op] || st.op;
    if (st.status === 'queued') label = `${st.queued}${st.cond ? `[${st.cond}]` : ''}`;
    else if (st.ekey !== focus && st.ekey.startsWith(focus + ':')) label = `override[${st.ekey.slice(focus.length + 1)}]:${label}`;
    hist.push(`#   ${label} ${st.file}:${st.line}${st.status === 'skipped' ? ` (skipped: ${st.note})` : st.status === 'error' ? ' (fatal: old override syntax)' : ''}`);
    hist.push(`#     "${st.value}"`);
  }
  hist.push('# pre-expansion value:', `#   ${res.pre == null ? 'None' : `"${res.pre}"`}`);
  const finalLine = finalStr == null ? `# ${focus} is not set` : `${focus}="${finalStr}"`;
  hist.push(finalLine);

  const nWords = words(finalStr).length;
  const values = [
    { label: 'Variable', value: focus || '(none)' },
    { label: 'Final value', value: finalStr == null ? '(not set)' : finalStr, hint: `${nWords} word${nWords === 1 ? '' : 's'}`, ...(warnings.length ? { tone: 'warn' } : {}) },
    { label: 'Lines for it', value: rel.length },
    { label: 'Override variant', value: res.chosen || 'none', hint: res.chosen ? 'replaces the base value' : 'base value used' },
    { label: 'Words removed', value: removed.length },
    { label: 'OVERRIDES', value: overrides.filter(Boolean).join(':') || '(empty)' },
  ];
  if (!text.trim()) notes.unshift('Paste assignment lines in parse order to resolve a variable.');

  return {
    values,
    tables: [{ title: `Evaluation of ${focus} (parse order, then getVar)`, columns: ['Step', 'Where', 'Line', 'Effect', 'Value after'], rows }],
    texts: [{ title: 'bitbake -e', body: hist.join('\n') + '\n' }, { title: 'Final value', body: finalLine + '\n' }],
    warnings,
    notes,
    eval: eval_,
  };
}
