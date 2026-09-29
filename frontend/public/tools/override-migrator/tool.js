// Override Syntax Migrator: old-style `_append` / `_${PN}` / `_machine`
// override syntax rewritten to the colon syntax BitBake 2.x (Yocto 3.4
// Honister and later) requires, optionally followed by the Kirkstone variable
// renames and the git SRC_URI fixes.
//
// Written from the documentation, not from any script's source:
//   - Yocto Project Migration Guide, Release 3.4: "Override syntax changes"
//     (what becomes `:`, which variables take package names, which suffixes
//     are not overrides: layer.conf suffixes, SRCREV_xxx, PREFERRED_VERSION_xxx);
//   - Yocto Project Migration Guide, Release 4.0: "Inclusive language
//     improvements" (the renamed and removed variables) and "Fetching changes"
//     (branch= on every git:// URL, protocol=https for GitHub);
//   - BitBake User Manual, Syntax and Operators: "Conditional Syntax
//     (Overrides)" (overrides are lower case, digits and dashes);
//   - Yocto 3.4.2 release notes (BitBake checks for the old override syntax);
//   - Yocto Reference Manual, Variables Glossary: PREFERRED_PROVIDER
//     ("always suffix this variable with the name of the provided item").
// The matching rules (which characters may come before and after a name, the
// word lists, the per-line order) were established by running
// convert-overrides.py 0.9.3, convert-variable-renames.py and
// convert-srcuri.py as black boxes on probe files and on a 150-file corpus
// of real layers, and comparing outputs byte for byte.
//
// Pure: no DOM. run(input) -> { values, tables, texts, warnings, notes, view }.

// ------------------------------------------------------------------ word lists
// The three operations, then the override names the script knows. Order
// matters only for which word gets the credit when two could convert the
// same underscore (arm before armv5: "_armv5" is credited to arm).
const OPS = ['append', 'prepend', 'remove'];
const BUILTIN = ['qemuarm', 'qemux86', 'qemumips', 'qemuppc', 'qemuriscv', 'qemuall', 'genericx86', 'edgerouter',
  'beaglebone-yocto', 'armeb', 'arm', 'armv5', 'armv6', 'armv4', 'powerpc64', 'aarch64', 'riscv32', 'riscv64', 'x86',
  'mips64', 'powerpc', 'mipsarch', 'x86-x32', 'mips16e', 'microblaze', 'e5500-64b', 'mipsisa32', 'mipsisa64',
  'class-native', 'class-target', 'class-cross-canadian', 'class-cross', 'class-devupstream', 'tune-', 'pn-',
  'forcevariable', 'libc-musl', 'libc-glibc', 'libc-newlib', 'libc-baremetal', 'task-configure', 'task-compile',
  'task-install', 'task-clean', 'task-image-qa', 'task-rm_work', 'task-image-complete', 'task-populate-sdk',
  'toolchain-clang', 'mydistro', 'nios2', 'sdkmingw32', 'overrideone', 'overridetwo', 'linux-gnux32', 'linux-muslx32',
  'linux-gnun32', 'mingw32', 'poky', 'darwin', 'linuxstdbase', 'linux-gnueabi', 'eabi', 'virtclass-multilib',
  'virtclass-mcextend'];
// Short names that would hit inside ordinary words, so they need an end.
const SHORT = ['arc', 'mips', 'mipsel', 'sh4'];
// Variables whose override is a package name (Migration 3.4: RDEPENDS,
// FILES and so on take package names such as ${PN}-ptest as overrides) ...
const PKG = ['FILES', 'RDEPENDS', 'RRECOMMENDS', 'SUMMARY', 'DESCRIPTION', 'RSUGGESTS', 'RPROVIDES', 'RCONFLICTS', 'PKG',
  'ALLOW_EMPTY', 'pkg_postrm', 'pkg_postinst_ontarget', 'pkg_postinst', 'INITSCRIPT_NAME', 'INITSCRIPT_PARAMS',
  'DEBIAN_NOAUTONAME', 'ALTERNATIVE', 'PKGE', 'PKGV', 'PKGR', 'USERADD_PARAM', 'GROUPADD_PARAM', 'CONFFILES',
  'SYSTEMD_SERVICE', 'LICENSE', 'SECTION', 'pkg_preinst', 'pkg_prerm', 'RREPLACES', 'GROUPMEMS_PARAM',
  'SYSTEMD_AUTO_ENABLE', 'SKIP_FILEDEPS', 'PRIVATE_LIBS', 'PACKAGE_ADD_METADATA', 'INSANE_SKIP', 'DEBIANNAME',
  'SYSTEMD_SERVICE_ESCAPED'];
// ... and those whose override is an image type (IMAGE_CMD_tar -> IMAGE_CMD:tar).
const IMAGE = ['IMAGE_CMD', 'EXTRA_IMAGECMD', 'IMAGE_TYPEDEP', 'CONVERSION_CMD', 'COMPRESS_CMD'];
// A line containing one of these is left alone: identifiers in BitBake and
// OE tooling that end in _append / _remove but are not overrides.
const SKIPS = [
  '_write_append', 'applied_appends', 'apply_append', 'color_remove', 'empty_remove', 'expanded_removes',
  'extra_append', 'file_append', 'first_append', 'handle_remove', 'multiple_append', 'no_remove', 'num_removed',
  'parser_append', 'parser_remove', 'recipe_append', 'shallow_remove', 'show_appends', 'test_append', 'test_prepend',
  'test_remove', 'to_append', 'to_remove', 'toaster_prepend',
];
// Whole-text rewrites for Python code the patterns would otherwise damage; a
// line containing one gets only this rewrite.
const LITERAL = [
  ['r = re.compile(r"([^:]+):\\s*(.*)")', 'r = re.compile(r"(^.+?):\\s+(.*)")'],
];

// Migration 4.0, "Inclusive language improvements": renamed variables.
const RENAMES = [
  ['BB_ENV_WHITELIST', 'BB_ENV_PASSTHROUGH'],
  ['BB_ENV_EXTRAWHITE', 'BB_ENV_PASSTHROUGH_ADDITIONS'],
  ['BB_HASHBASE_WHITELIST', 'BB_BASEHASH_IGNORE_VARS'],
  ['BB_HASHCONFIG_WHITELIST', 'BB_HASHCONFIG_IGNORE_VARS'],
  ['BB_HASHTASK_WHITELIST', 'BB_TASKHASH_IGNORE_TASKS'],
  ['BB_SETSCENE_ENFORCE_WHITELIST', 'BB_SETSCENE_ENFORCE_IGNORE_TASKS'],
  ['CVE_CHECK_PN_WHITELIST', 'CVE_CHECK_SKIP_RECIPE'],
  ['CVE_CHECK_WHITELIST', 'CVE_CHECK_IGNORE'],
  ['ICECC_USER_CLASS_BL', 'ICECC_CLASS_DISABLE'],
  ['ICECC_SYSTEM_CLASS_BL', 'ICECC_CLASS_DISABLE'],
  ['ICECC_USER_PACKAGE_WL', 'ICECC_RECIPE_ENABLE'],
  ['ICECC_USER_PACKAGE_BL', 'ICECC_RECIPE_DISABLE'],
  ['ICECC_SYSTEM_PACKAGE_BL', 'ICECC_RECIPE_DISABLE'],
  ['LICENSE_FLAGS_WHITELIST', 'LICENSE_FLAGS_ACCEPTED'],
  ['MULTI_PROVIDER_WHITELIST', 'BB_MULTI_PROVIDER_ALLOWED'],
  ['PNBLACKLIST', 'SKIP_RECIPE'],
  ['SDK_LOCAL_CONF_BLACKLIST', 'ESDK_LOCALCONF_REMOVE'],
  ['SDK_LOCAL_CONF_WHITELIST', 'ESDK_LOCALCONF_ALLOW'],
  ['SDK_INHERIT_BLACKLIST', 'ESDK_CLASS_INHERIT_DISABLE'],
  ['SSTATE_DUPWHITELIST', 'SSTATE_ALLOW_OVERLAP_FILES'],
  ['SYSROOT_DIRS_BLACKLIST', 'SYSROOT_DIRS_IGNORE'],
  ['UNKNOWN_CONFIGURE_WHITELIST', 'UNKNOWN_CONFIGURE_OPT_IGNORE'],
];
// Migration 4.0: removed outright (no new name).
const REMOVED = ['BB_STAMP_WHITELIST', 'BB_STAMP_POLICY', 'INHERIT_BLACKLIST', 'TUNEABI_WHITELIST', 'TUNEABI_OVERRIDE', 'TUNEABI'];
// Words convert-variable-renames.py asks a human to look at.
const WORDING = ['blacklist', 'whitelist', 'abort'];

// Suffixes that name something, not an override (Migration 3.4: layer.conf
// suffixes, SRCREV_xxx, PREFERRED_VERSION_xxx; Reference Manual:
// PREFERRED_PROVIDER_<item>). A lower-case tail on these is not reported.
const NAME_SUFFIX = /^(SRCREV|PREFERRED_VERSION|PREFERRED_PROVIDER|BBFILE_PATTERN|BBFILE_PRIORITY|LAYERSERIES_COMPAT|LAYERDEPENDS|LAYERRECOMMENDS|LAYERVERSION|BBFILE_COLLECTIONS)_/;
// Longer words that start with a listed name and are real overrides
// themselves (OE-core machine, tune and class overrides), so "arm" matching
// the start of "armv7a" is not worth a flag.
const KNOWN_LONGER = new Set(['class-nativesdk', 'class-crosssdk', 'powerpc64le', 'mips64el', 'mipsisa32r6', 'mipsisa32r6el',
  'mipsisa64r6', 'mipsisa64r6el', 'mips64n32', 'microblazeel', 'qemuarm64', 'qemuarmv5', 'qemux86-64', 'qemumips64',
  'qemuppc64', 'qemuriscv32', 'qemuriscv64', 'qemuloongarch64', 'genericx86-64', 'linux-gnueabihf', 'eabihf', 'armebv7a']);
const isKnownLonger = (w) => KNOWN_LONGER.has(w) || /^armv\d/.test(w) || /^armeb/.test(w);

const RULE_LABEL = { operation: 'operation', override: 'override', yours: 'your override', package: 'package name',
  rename: 'rename', srcuri: 'SRC_URI', python: 'python', repair: 'repair' };

// ------------------------------------------------------------------ helpers
const words = (s) => String(s ?? '').split(/[\s,]+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniq = (a) => [...new Set(a)];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A "word" around a change, for the tables: a run of name-ish characters.
const WORDCH = /[^\s"'()[\]=+?,;`]/;
function tokenAt(s, i) {
  if (i < 0 || i >= s.length) return '';
  let a = i, b = i + 1;
  while (a > 0 && WORDCH.test(s[a - 1])) a--;
  while (b < s.length && WORDCH.test(s[b])) b++;
  return s.slice(a, b);
}

// What comes before a name: start of line or one of # ' " whitespace - +,
// then (for the override words) a run of name characters.
const START = `(?:^|[#'"\\s\\-+])`;
const LEAD = `(${START}[A-Za-z0-9_\\-:\${}.]+)`;

function buildPasses(userOv, userPkg, drop) {
  const d = new Set(drop);
  const passes = [];
  // Order found by running the script: package and image variables first,
  // then your override names, the operations, the built-in names, and the
  // short names last (they need the colon the others leave behind).
  const pk = [...PKG, ...IMAGE].filter((w) => !d.has(w));
  for (const w of [...pk, ...userPkg.filter((w) => !pk.includes(w))]) {
    passes.push({ kind: 'pkg', w, rule: 'package', re: new RegExp(`((?:^|[#'"\\s\\-+]+))${esc(w)}_([$a-z"'\\s%\\[<{\\\\*])([^\\n])`, 'g') });
  }
  const lead = (w, rule) => passes.push({ kind: 'long', w, rule, re: new RegExp(`${LEAD}_${esc(w)}`, 'g') });
  for (const w of userOv) if (!BUILTIN.includes(w) || d.has(w)) lead(w, 'yours');
  for (const w of OPS) lead(w, 'operation');
  for (const w of BUILTIN) if (!d.has(w)) lead(w, 'override');
  for (const w of SHORT) if (!d.has(w)) passes.push({ kind: 'short', w, rule: 'override', re: new RegExp(`${LEAD}_${esc(w)}([('"\\s:])`, 'g') });
  return passes;
}

// One line through the override patterns. `t` is the line as Python reads it
// (with its newline); the rewrite only ever turns "_" into ":", so the
// positions of the original are kept.
function overridePass(t, passes) {
  const hits = [];
  let cur = t;
  for (const p of passes) {
    p.re.lastIndex = 0;
    let m, out = '', last = 0;
    while ((m = p.re.exec(cur))) {
      const us = p.kind === 'pkg' ? m.index + m[1].length + p.w.length : m.index + m[1].length;
      hits.push({ i: us, rule: p.rule, name: p.w });
      out += cur.slice(last, us) + ':';
      last = us + 1;
      if (m[0].length === 0) p.re.lastIndex++;
    }
    if (last) cur = out + cur.slice(last);
  }
  return { cur, hits };
}

// ------------------------------------------------------------------ edit model
// A line as cells: original characters (o = index), deleted ones (del) and
// inserted ones (o = null). Every edit tags the cells it touched.
class Line {
  constructor(s) { this.cells = [...s].map((t, o) => ({ t, o, e: null })); this.edits = []; }
  text() { return this.cells.map((c) => c.t).join(''); }
  locate(ci) { // cur index -> cell index
    let k = 0;
    for (let x = 0; x < this.cells.length; x++) { if (this.cells[x].t === '') continue; if (k === ci) return x; k++; }
    return this.cells.length;
  }
  origAt(ci) { const c = this.cells[this.locate(ci)]; return c ? c.o : null; }
  // replace cur[a, b) with text; returns the edit
  replace(a, b, text, info) {
    const id = this.edits.length;
    const edit = { id, ...info, before: '', after: text };
    const idx = [];
    for (let ci = a; ci < b; ci++) idx.push(this.locate(ci));
    let at = idx.length ? idx[idx.length - 1] + 1 : this.locate(a);
    let firstO = null, prevO = null;
    for (const x of idx) {
      const c = this.cells[x];
      if (c.o != null) { edit.before += c.t; if (firstO == null) firstO = c.o; c.del = c.t; c.t = ''; c.e = id; } else c.gone = true;
    }
    for (let x = (idx[0] ?? at) - 1; x >= 0; x--) if (this.cells[x].o != null) { prevO = this.cells[x].o; break; }
    const ins = [...text].map((t) => ({ t, o: null, e: id }));
    this.cells.splice(at, 0, ...ins);
    this.cells = this.cells.filter((c) => !c.gone);
    edit.o = firstO != null ? firstO : (prevO != null ? prevO + 1 : 0);
    this.edits.push(edit);
    return edit;
  }
  segs() {
    const out = [];
    for (const c of this.cells) {
      const key = c.e == null ? '' : this.edits[c.e].key;
      const o = c.o != null ? (c.del ?? c.t) : '';
      const last = out[out.length - 1];
      if (last && last[2] === key) { last[0] += o; last[1] += c.t; } else out.push([o, c.t, key]);
    }
    return out.filter((s) => s[0] !== '' || s[1] !== '');
  }
  convIndexOf(id) { // cur index of the first cell an edit inserted
    let k = 0;
    for (const c of this.cells) { if (c.t === '') continue; if (c.e === id) return k; k++; }
    return -1;
  }
}

// ------------------------------------------------------------------ structure
const NAMECH = `[A-Za-z0-9_\\-\${}.:/+~@%]`;
const ASSIGN = new RegExp(`^(\\s*(?:export\\s+)?)(${NAMECH}+?)(\\[[^\\]]*\\])?\\s*(\\?\\?=|\\?=|:=|\\+=|=\\+|\\.=|=\\.|=)`);
const FUNC = new RegExp(`^(\\s*(?:fakeroot\\s+)?(?:python\\s+)?)(${NAMECH}+?)\\s*\\(\\s*\\)\\s*\\{`);
const FUNC_OPEN = /^\s*(?:fakeroot\s+)?(?:python\s+)?[^\s(){}=]*\s*\(\s*\)\s*\{\s*$/;
const DEF_OPEN = /^def\s+\w+\s*\(.*\)\s*:\s*$/;

// Which characters of each line are inside a quoted value, and which lines
// are function bodies.
function structure(lines) {
  const info = [];
  let body = null; // 'shell' | 'def'
  let valueQuote = null; // open quote char carried over a line continuation
  for (const s of lines) {
    const it = { body: false, inValue: null };
    if (body === 'shell') {
      if (/^\}/.test(s)) { body = null; } else it.body = true;
    } else if (body === 'def') {
      if (s.trim() === '' || /^\s/.test(s)) it.body = true; else body = null;
    }
    if (!it.body) {
      const inv = new Array(s.length).fill(false);
      let q = valueQuote, start = 0;
      const am = valueQuote ? null : ASSIGN.exec(s);
      if (am) start = am[0].length;
      if (q || am) {
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (q) { if (ch === q) { q = null; } else inv[i] = true; } else if (ch === '"' || ch === "'") q = ch;
        }
        it.inValue = inv;
        valueQuote = q && /\\\s*$/.test(s) ? q : null;
      } else valueQuote = null;
      if (!body) {
        if (FUNC_OPEN.test(s)) body = 'shell';
        else if (DEF_OPEN.test(s)) body = 'def';
      }
    }
    info.push(it);
  }
  return info;
}

// ------------------------------------------------------------------ run
export function run(input = {}) {
  const text = String(input.text ?? '').replace(/\r\n?/g, '\n');
  const userOv = uniq(words(input.overrides).map((w) => w.toLowerCase()));
  const userPkg = uniq(words(input.packageVars));
  const userSkip = words(input.skip);
  const dropIn = uniq(words(input.drop));
  const keep = new Set(words(input.keep));
  const doRenames = input.renames !== false;
  const doSrcuri = input.srcuri !== false;
  const warnings = [];
  const notes = [];

  const droppable = new Set([...BUILTIN, ...SHORT, ...PKG, ...IMAGE]);
  const dropped = dropIn.filter((w) => droppable.has(w));
  const badDrop = dropIn.filter((w) => !droppable.has(w));
  const passes = buildPasses(userOv, userPkg, dropped);
  const skips = [...SKIPS, ...userSkip];
  const ovList = new Set([...OPS, ...BUILTIN.filter((w) => !dropped.includes(w)), ...SHORT.filter((w) => !dropped.includes(w)), ...userOv]);

  const raw = text.split('\n');
  const endsNL = text.endsWith('\n');
  if (endsNL) raw.pop();
  const struct = structure(raw);

  const vLines = [];
  const findings = [];
  const keptOut = [];
  const usedOv = new Map();
  const usedPkg = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  raw.forEach((s, li) => {
    const n = li + 1;
    const hasNL = li < raw.length - 1 || endsNL;
    const L = new Line(s);
    const st = struct[li];
    const lineFind = [];

    // ---- 1. override syntax
    const lit = LITERAL.find(([k]) => s.includes(k));
    let ovHits = [];
    if (lit) {
      // (literal rewrite: the whole Python expression, nothing else on the line)
      let from = 0, at;
      while ((at = L.text().indexOf(lit[0], from)) >= 0) {
        const o = L.origAt(at);
        const e = L.replace(at, at + lit[0].length, lit[1], { rule: 'python', name: 'literal rewrite' });
        e.key = `${n}:${o + 1}`;
        from = at + lit[1].length;
      }
      let at2 = -1;
      while ((at2 = L.text().indexOf('pkg_postinst:ontarget', at2 + 1)) >= 0) {
        const o = L.origAt(at2 + 12);
        const e = L.replace(at2 + 12, at2 + 13, '_', { rule: 'repair', name: 'pkg_postinst_ontarget' });
        e.key = keyFree(L, `${n}:${(o ?? 0) + 1}`, n);
      }
    }
    // A line naming a ptest_append/_prepend/_remove is never skipped (the
    // script converts it even when a skip string is on the line too).
    const skipHit = lit || /ptest_(?:append|prepend|remove)/.test(s) ? null : skips.find((k) => s.includes(k));
    const wouldHit = lit ? [] : overridePass(hasNL ? `${s}\n` : s, passes).hits.filter((h) => h.i < s.length).sort((a, b) => a.i - b.i);
    if (!lit && !skipHit) ovHits = wouldHit;
    // The one name the package pattern splits wrongly is put back whole:
    // pkg_postinst:ontarget is always pkg_postinst_ontarget (also when the
    // input already had the colon).
    const repairs = [];
    {
      const probe = [...s];
      for (const h of ovHits) probe[h.i] = ':';
      const pt = probe.join('');
      let at = -1;
      while ((at = pt.indexOf('pkg_postinst:ontarget', at + 1)) >= 0) {
        const ci = at + 12;
        if (ovHits.some((h) => h.i === ci)) ovHits = ovHits.filter((h) => h.i !== ci);
        else if (!lit && s[ci] === ':') repairs.push(ci);
      }
    }
    const afterOv = [...s];
    for (const h of ovHits) afterOv[h.i] = ':';
    for (const ci of repairs) afterOv[ci] = '_';
    const ovText = afterOv.join('');
    for (const ci of repairs) {
      const key = `${n}:${ci + 1}`;
      if (keep.has(key)) { keptOut.push(key); continue; }
      const e = L.replace(ci, ci + 1, '_', { rule: 'repair', name: 'pkg_postinst_ontarget' });
      e.key = key;
    }
    for (const h of ovHits) {
      const key = `${n}:${h.i + 1}`;
      if (keep.has(key)) { keptOut.push(key); continue; }
      const e = L.replace(h.i, h.i + 1, ':', { rule: h.rule, name: h.name });
      e.key = key;
      e.hit = h;
    }

    // ---- 2. variable renames
    const renameHits = [];
    if (doRenames) {
      for (const [from, to] of RENAMES) {
        let pos = 0, at;
        while ((at = L.text().indexOf(from, pos)) >= 0) {
          const o = L.origAt(at);
          const key = `${n}:${o + 1}`;
          if (keep.has(key)) { keptOut.push(key); pos = at + from.length; continue; }
          const e = L.replace(at, at + from.length, to, { rule: 'rename', name: from });
          e.key = key;
          renameHits.push([from, to]);
          pos = at + to.length;
        }
      }
    }

    // ---- 3. git SRC_URI
    // convert-srcuri.py leaves a line containing ".*" (regex code) alone.
    if (doSrcuri && !L.text().includes('.*')) {
      const tail = (label, add) => {
        const cur = L.text();
        let a = -1, b = -1, rep = '';
        if (hasNL && cur.endsWith('"')) { a = cur.length - 1; b = cur.length; rep = `${add}"`; } else {
          const m = /\s*\\$/.exec(cur);
          if (m) { a = m.index; b = cur.length; rep = `${add} \\`; }
        }
        if (a < 0) return;
        const o = L.origAt(a);
        const key = `${n}:${(o ?? s.length) + 1}`;
        if (keep.has(key)) { keptOut.push(key); return; }
        const e = L.replace(a, b, rep, { rule: 'srcuri', name: label });
        e.key = keyFree(L, key, n);
      };
      if (/git(?:sm)?:\/\//.test(L.text()) && !L.text().includes('branch=')) tail('branch', ';branch=master');
      const cur = L.text();
      if (/git(?:sm)?:\/\//.test(cur) && cur.includes('github.com')) {
        if (cur.includes('protocol=https')) {
          // already there: nothing to do, even if a protocol=git is on the line too
        } else if (cur.includes('protocol=git')) {
          let pos = 0, at;
          while ((at = L.text().indexOf('protocol=git', pos)) >= 0) {
            const o = L.origAt(at);
            const key = `${n}:${(o ?? 0) + 1}`;
            if (keep.has(key)) { keptOut.push(key); pos = at + 12; continue; }
            const e = L.replace(at, at + 12, 'protocol=https', { rule: 'srcuri', name: 'protocol' });
            e.key = keyFree(L, key, n);
            pos = at + 14;
          }
        } else tail('protocol', ';protocol=https');
      }
    }

    const conv = L.text();

    // ---- changes, with a flag where a human should look
    const lhsA = ASSIGN.exec(ovText);
    const lhsF = lhsA ? null : FUNC.exec(ovText);
    const lhs = lhsA || lhsF;
    const lhsSpan = lhs ? [lhs[1].length, lhs[1].length + lhs[2].length] : null;
    const changes = [];
    let lhsRunsOn = null;
    for (const e of L.edits) {
      const c = { key: e.key, col: e.o + 1, rule: e.rule, name: e.name, before: e.before, after: e.after,
        word: tokenAt(s, e.o), wordc: tokenAt(conv, Math.max(0, L.convIndexOf(e.id))), flag: null };
      if (e.hit) {
        const h = e.hit;
        const nm = h.name;
        const next = ovText.slice(h.i + 1 + nm.length);
        const ext = /^[A-Za-z0-9-]*/.exec(next)[0];
        const run = /^_([A-Za-z0-9-]+)/.exec(next);
        const isOvWord = h.rule === 'override' || h.rule === 'yours' || h.rule === 'operation';
        const partial = isOvWord && /^[A-Za-z0-9]/.test(next) && !/-$/.test(nm) && !ovList.has(nm + ext) && !isKnownLonger(nm + ext);
        const inValue = st.inValue && st.inValue[h.i];
        if (st.body) c.flag = { kind: 'code', text: 'Inside a function body: this is shell or Python text, not a variable name. Check it is a datastore name (d.getVar, a FILES entry), not an identifier.' };
        else if (partial) c.flag = { kind: 'partial', text: `"${nm}" is only the start of "${nm + ext}": the script's pattern has no end boundary, so the whole word became an override. Right if "${nm + ext}" is an override; keep the original if it is part of a name.` };
        else if (inValue) c.flag = { kind: 'value', text: 'Inside a quoted value: likely a file name or a word, not an override. Keep the original unless it names a variable.' };
        else if (run && isOvWord) c.flag = { kind: 'runs-on', text: `The name runs on as "_${run[1]}" after the override word: probably one identifier (a function called ..._${nm}_${run[1]}), or "${run[1]}" is an override the list does not know.` };
        if (h.rule === 'operation' && run && !st.body && lhsSpan && h.i >= lhsSpan[0] && h.i < lhsSpan[1] && !lhsRunsOn) lhsRunsOn = { nm, rest: run[1] };
        if (h.rule === 'package') bump(usedPkg, nm); else bump(usedOv, nm);
      }
      changes.push(c);
    }
    changes.sort((a, b) => a.col - b.col);

    // ---- findings
    if (lhs && !st.body) {
      const name = lhs[2];
      const convName = lhsA ? (ASSIGN.exec(conv) || [])[2] || name : (FUNC.exec(conv) || [])[2] || name;
      const skipped = skipHit ? wouldHit.filter((h) => h.i >= lhsSpan[0] && h.i < lhsSpan[1]) : [];
      if (skipped.length) {
        const ops = skipped.filter((h) => h.rule === 'operation');
        lineFind.push({ line: n, kind: 'skipped', sev: ops.length ? 'error' : 'warn', name,
          text: `"${name}" keeps its old syntax: the script leaves every line containing "${skipHit}" alone. ${ops.length ? `BitBake 2.x refuses a name containing _${ops[0].name}; ` : ''}write it as ${colonise(name, skipped, lhsSpan[0])} by hand if those are overrides.` });
      } else if (lhsRunsOn) {
        const { nm, rest } = lhsRunsOn;
        lineFind.push(lhsF
          ? { line: n, kind: 'unknown-override', sev: 'error', name: convName, suggest: rest,
            text: `"${convName}": if "${rest}" is an override (a MACHINE or DISTRO), add it; if the function is just called ..._${nm}_${rest}, rename it - BitBake 2.x refuses any name containing _${nm}, converted or not.` }
          : { line: n, kind: 'unknown-override', sev: 'error', name: convName, suggest: rest,
            text: `"_${rest}" was not converted: "${rest}" is not on the override list. If it is a MACHINE, DISTRO or other override, add it.` });
      } else if (lhsA && !name.includes(':')) {
        const m = /^(.*)_([a-z][a-z0-9-]*)$/.exec(name);
        const u = /^([A-Z0-9_]+)_([a-z][a-z0-9-]*)$/.exec(name);
        if (m && ovList.has(m[2])) {
          lineFind.push({ line: n, kind: 'missed', sev: 'warn', name,
            text: `"${name}" still has _${m[2]}, a listed override the script's pattern did not reach (a / or similar before it). BitBake 2.x reads it as a different variable, silently. Write it as ${m[1]}:${m[2]} by hand.` });
        } else if (u && !NAME_SUFFIX.test(name)) {
          lineFind.push({ line: n, kind: 'unknown-override', sev: 'warn', name, suggest: u[2],
            text: `"${name}" ends in "_${u[2]}", which looks like an override the list does not know (a MACHINE or DISTRO name?). Add it if it is one.` });
        }
      }
    }
    for (const [from, to] of renameHits) {
      lineFind.push({ line: n, kind: 'renamed', sev: 'note', text: `${from} was renamed to ${to} (Kirkstone 4.0, BB_RENAMED_VARIABLES).` });
    }
    // Migration 4.0: BitBake stops on renamed or removed variables, so an old
    // name still on the line (renames off, or the rename kept) is an error.
    for (const [from, to] of RENAMES) {
      if (conv.includes(from)) lineFind.push({ line: n, kind: 'renamed', sev: 'error', text: `${from} is ${to} since Kirkstone 4.0 and BitBake stops on the old name; ${doRenames ? 'rename it' : 'turn on "Also rename Kirkstone variables" or rename it by hand'}.` });
    }
    for (const r of REMOVED) {
      if (new RegExp(`(^|[^A-Za-z0-9_])${r}([^A-Za-z0-9_]|$)`).test(conv) || (r !== 'TUNEABI' && conv.includes(r) && new RegExp(`${r}([^A-Za-z0-9]|$)`).test(conv))) {
        lineFind.push({ line: n, kind: 'removed', sev: 'error', text: `${r} was removed in Kirkstone 4.0 (no new name); BitBake stops on it. Delete the setting.` });
        break;
      }
    }
    if (doRenames) {
      const low = conv.toLowerCase();
      for (const w of WORDING) if (low.includes(w)) lineFind.push({ line: n, kind: 'wording', sev: 'note', text: `Contains "${w}": convert-variable-renames.py asks for a look, the name may have a new term.` });
    }
    findings.push(...lineFind);
    vLines.push({ n, orig: s, conv, segs: L.segs(), changes });
  });

  // ------------------------------------------------------------------ result
  const allChanges = vLines.flatMap((l) => l.changes.map((c) => ({ ...c, line: l.n })));
  const count = (r) => allChanges.filter((c) => c.rule === r).length;
  const flagged = allChanges.filter((c) => c.flag).length;
  const changedLines = vLines.filter((l) => l.orig !== l.conv).length;
  const stopLines = uniq(findings.filter((f) => f.sev === 'error').map((f) => f.line));
  const suggest = uniq(findings.filter((f) => f.suggest).map((f) => f.suggest));

  const values = [
    { label: 'Lines changed', value: changedLines, hint: `of ${vLines.length}` },
    { label: 'Rewrites', value: allChanges.length, hint: `${count('operation')} operations, ${count('override') + count('yours')} overrides, ${count('package')} package names` },
    { label: 'For a human', value: flagged, tone: flagged ? 'warn' : 'ok' },
    { label: 'Still stops BitBake', value: stopLines.length, tone: stopLines.length ? 'bad' : 'ok' },
  ];
  if (doRenames) values.push({ label: 'Renamed variables', value: count('rename') });
  if (doSrcuri) values.push({ label: 'SRC_URI fixes', value: count('srcuri') });
  if (keptOut.length) values.push({ label: 'Kept original', value: keptOut.length });

  const tables = [{
    title: 'Rewrites', columns: ['Line', 'Rule', 'Before', 'After', 'Look at'],
    rows: allChanges.map((c) => [c.line, `${RULE_LABEL[c.rule] || c.rule} ${c.name}`, c.word, c.wordc, c.flag ? c.flag.kind : '']),
  }];
  const REVIEW_ROWS = 60;
  if (findings.length) tables.push({ title: 'Review', columns: ['Line', 'Severity', 'Finding'], rows: findings.slice(0, REVIEW_ROWS).map((f) => [f.line, f.sev, f.text]) });

  if (!text.trim()) warnings.push('Nothing to convert: paste a recipe, bbappend, class or conf file.');
  if (stopLines.length) {
    warnings.push(`${plural(stopLines.length, 'line')} will still stop BitBake 2.x: ${stopLines.slice(0, 4).map((l) => `line ${l}`).join(', ')}${stopLines.length > 4 ? ' ...' : ''}. See the review list.`);
  }
  if (suggest.length) warnings.push(`Names that look like overrides but are not on the list: ${suggest.join(', ')}. Add the ones that are MACHINE, DISTRO or other overrides (--override in the script) and convert again.`);
  if (dropped.length) warnings.push(`Taken off the built-in lists: ${dropped.join(', ')} (the script would still convert them).`);
  if (badDrop.length) warnings.push(`Not on the built-in lists, so nothing to take off: ${badDrop.join(', ')}.`);
  const badOv = userOv.filter((w) => !/^[a-z0-9-]+$/.test(w));
  if (badOv.length) warnings.push(`Not an override name (BitBake allows lower case, digits and dashes): ${badOv.join(', ')}.`);

  if (flagged) notes.push(`${plural(flagged, 'rewrite')} marked for a human (the script matches loosely, as the 3.4 migration guide warns). Keep the original where the text was not an override.`);
  if (findings.length > REVIEW_ROWS) notes.push(`The Review table shows the first ${REVIEW_ROWS} of ${findings.length} findings; ${findings.slice(REVIEW_ROWS).filter((f) => f.sev === 'error').length} of the rest will stop BitBake.`);
  if (keptOut.length) notes.push(`${plural(keptOut.length, 'rewrite')} kept as the original text at your request.`);
  notes.push('Behaves as convert-overrides.py 0.9.3 does: each line is matched together with its newline, as Python reads it, and a file is one pass, so run it again after adding overrides, as you would the script.');

  const texts = [
    { title: 'Converted', body: vLines.map((l) => l.conv).join('\n') + (endsNL ? '\n' : '') },
    { title: 'Diff', body: unified(vLines) },
  ];

  return {
    values, tables, texts, warnings, notes,
    view: {
      lines: vLines,
      kept: uniq(keptOut),
      findings,
      suggest,
      lists: {
        user: userOv, builtin: BUILTIN, short: SHORT, pkg: [...PKG, ...IMAGE], userPkg, dropped,
        usedOv: [...usedOv.entries()], usedPkg: [...usedPkg.entries()],
      },
    },
  };
}

// A name with the underscores the patterns would have converted as colons.
function colonise(name, hits, off) {
  const a = [...name];
  for (const h of hits) a[h.i - off] = ':';
  return a.join('');
}

// Two edits may start at the same original column (an insertion right
// after a replaced character); keep keys unique.
function keyFree(L, key, n) {
  const used = new Set(L.edits.map((e) => e.key).filter(Boolean));
  if (!used.has(key)) return key;
  let col = Number(key.split(':')[1]);
  while (used.has(`${n}:${col}`)) col++;
  return `${n}:${col}`;
}

// Unified-style diff with one line of context; hunks closer than three
// unchanged lines are merged.
function unified(vLines) {
  const ch = vLines.map((l) => l.orig !== l.conv);
  const idx = ch.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return '--- original\n+++ converted\n(no changes)\n';
  const hunks = [];
  let cur = null;
  for (const i of idx) {
    const a = Math.max(0, i - 1), b = Math.min(vLines.length - 1, i + 1);
    if (cur && a <= cur[1] + 1) cur[1] = b; else { cur = [a, b]; hunks.push(cur); }
  }
  const out = ['--- original', '+++ converted'];
  for (const [a, b] of hunks) {
    if (a > 0) out.push(`@@ line ${a + 1} @@`);
    for (let i = a; i <= b; i++) {
      if (ch[i]) out.push(`-${vLines[i].orig}`, `+${vLines[i].conv}`); else out.push(` ${vLines[i].orig}`);
    }
  }
  return out.join('\n') + '\n';
}
