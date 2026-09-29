// Override Syntax Migrator: old BitBake `_append` / `_prepend` / `_remove` /
// `_${PN}` override syntax rewritten to the colon syntax (Honister 3.4,
// BitBake 1.52 and later), with every change traced to the rule that made it.
//
// The conversion is a line-for-line port of openembedded-core
// scripts/contrib/convert-overrides.py version 0.9.3 (Richard Purdie, 2021):
// the same override, short-override, package-variable, image-variable and
// skip lists, the same regular expressions, applied in the same order per
// line: skip strings (with the ptest exception), the literal Python `subs`,
// then the package-variable, override and short-override patterns, then the
// pkg_postinst:ontarget repair. Two optional passes from the same folder
// follow it: convert-variable-renames.py 0.1 (Kirkstone's renamed variables,
// also listed as BB_RENAMED_VARIABLES in meta/conf/bitbake.conf) and
// convert-srcuri.py 0.1 (git:// SRC_URI entries get branch= and GitHub gets
// protocol=https).
//
// On top of the scripts, it marks what a human should look at: a rewrite
// inside a quoted value, a comment or a function body, an override word that
// runs on into a longer name (`_arm` in `_armhf`), and old syntax that is
// still there afterwards - BitBake 2.x stops with "contains an operation
// using the old override syntax" (bitbake/lib/bb/data_smart.py setVar) - with
// the override name to add when that is the reason.
//
// Pure: no DOM. Imports nothing.

// ---------------------------------------------------------------- the lists
// convert-overrides.py 0.9.3, verbatim.
export const OVERRIDE_WORDS = [
  'append', 'prepend', 'remove',
  'qemuarm', 'qemux86', 'qemumips', 'qemuppc', 'qemuriscv', 'qemuall',
  'genericx86', 'edgerouter', 'beaglebone-yocto',
  'armeb', 'arm', 'armv5', 'armv6', 'armv4', 'powerpc64', 'aarch64', 'riscv32', 'riscv64', 'x86', 'mips64', 'powerpc',
  'mipsarch', 'x86-x32', 'mips16e', 'microblaze', 'e5500-64b', 'mipsisa32', 'mipsisa64',
  'class-native', 'class-target', 'class-cross-canadian', 'class-cross', 'class-devupstream',
  'tune-', 'pn-', 'forcevariable',
  'libc-musl', 'libc-glibc', 'libc-newlib', 'libc-baremetal',
  'task-configure', 'task-compile', 'task-install', 'task-clean', 'task-image-qa', 'task-rm_work', 'task-image-complete', 'task-populate-sdk',
  'toolchain-clang', 'mydistro', 'nios2', 'sdkmingw32', 'overrideone', 'overridetwo',
  'linux-gnux32', 'linux-muslx32', 'linux-gnun32', 'mingw32', 'poky', 'darwin', 'linuxstdbase',
  'linux-gnueabi', 'eabi',
  'virtclass-multilib', 'virtclass-mcextend',
];
// "only with whitespace following or another override" (arc would match arch)
export const SHORT_WORDS = ['arc', 'mips', 'mipsel', 'sh4'];
export const PACKAGE_VARS = ['FILES', 'RDEPENDS', 'RRECOMMENDS', 'SUMMARY', 'DESCRIPTION', 'RSUGGESTS', 'RPROVIDES', 'RCONFLICTS', 'PKG', 'ALLOW_EMPTY',
  'pkg_postrm', 'pkg_postinst_ontarget', 'pkg_postinst', 'INITSCRIPT_NAME', 'INITSCRIPT_PARAMS', 'DEBIAN_NOAUTONAME', 'ALTERNATIVE',
  'PKGE', 'PKGV', 'PKGR', 'USERADD_PARAM', 'GROUPADD_PARAM', 'CONFFILES', 'SYSTEMD_SERVICE', 'LICENSE', 'SECTION', 'pkg_preinst',
  'pkg_prerm', 'RREPLACES', 'GROUPMEMS_PARAM', 'SYSTEMD_AUTO_ENABLE', 'SKIP_FILEDEPS', 'PRIVATE_LIBS', 'PACKAGE_ADD_METADATA',
  'INSANE_SKIP', 'DEBIANNAME', 'SYSTEMD_SERVICE_ESCAPED'];
export const IMAGE_VARS = ['IMAGE_CMD', 'EXTRA_IMAGECMD', 'IMAGE_TYPEDEP', 'CONVERSION_CMD', 'COMPRESS_CMD'];
const SKIPS = ['parser_append', 'recipe_to_append', 'extra_append', 'to_remove', 'show_appends', 'applied_appends', 'file_appends', 'handle_remove',
  'expanded_removes', 'color_remove', 'test_remove', 'empty_remove', 'toaster_prepend', 'num_removed', 'licfiles_append', '_write_append',
  'no_report_remove', 'test_prepend', 'test_append', 'multiple_append', 'test_remove', 'shallow_remove', 'do_remove_layer', 'first_append',
  'parser_remove', 'to_append', 'no_remove', 'bblayers_add_remove', 'bblayers_remove', 'apply_append', 'is_x86', 'base_dep_prepend',
  'autotools_dep_prepend', 'go_map_arm', 'alt_remove_links', 'systemd_append_file', 'file_append', 'process_file_darwin',
  'run_loaddata_poky', 'determine_if_poky_env', 'do_populate_poky_src', 'libc_cv_include_x86_isa_level', 'test_rpm_remove', 'do_install_armmultilib',
  'get_appends_for_files', 'test_doubleref_remove', 'test_bitbakelayers_add_remove', 'elf32_x86_64', 'colour_remove', 'revmap_remove',
  'test_rpm_remove', 'test_bitbakelayers_add_remove', 'recipe_append_file', 'log_data_removed', 'recipe_append', 'systemd_machine_unit_append',
  'recipetool_append', 'changetype_remove', 'try_appendfile_wc', 'test_qemux86_directdisk', 'test_layer_appends', 'tgz_removed'];
// Literal rewrites of Python in OE's own classes; a line that has one is not
// touched by the patterns.
const SUBS = [
  ['r = re.compile(r"([^:]+):\\s*(.*)")', 'r = re.compile(r"(^.+?):\\s+(.*)")'],
  ["val = d.getVar('%s_%s' % (var, pkg))", "val = d.getVar('%s:%s' % (var, pkg))"],
  ["f.write('%s_%s: %s\\n' % (var, pkg, encode(val)))", "f.write('%s:%s: %s\\n' % (var, pkg, encode(val)))"],
  ["d.getVar('%s_%s' % (scriptlet_name, pkg))", "d.getVar('%s:%s' % (scriptlet_name, pkg))"],
  ['ret.append(v + "_" + p)', 'ret.append(v + ":" + p)'],
];
// convert-variable-renames.py 0.1 (= BB_RENAMED_VARIABLES in meta/conf/bitbake.conf
// plus bitbake_renamed_vars in bitbake/lib/bb/data_smart.py).
export const RENAMES = {
  BB_ENV_WHITELIST: 'BB_ENV_PASSTHROUGH', BB_ENV_EXTRAWHITE: 'BB_ENV_PASSTHROUGH_ADDITIONS',
  BB_HASHCONFIG_WHITELIST: 'BB_HASHCONFIG_IGNORE_VARS', BB_SETSCENE_ENFORCE_WHITELIST: 'BB_SETSCENE_ENFORCE_IGNORE_TASKS',
  BB_HASHBASE_WHITELIST: 'BB_BASEHASH_IGNORE_VARS', BB_HASHTASK_WHITELIST: 'BB_TASKHASH_IGNORE_TASKS',
  CVE_CHECK_PN_WHITELIST: 'CVE_CHECK_SKIP_RECIPE', CVE_CHECK_WHITELIST: 'CVE_CHECK_IGNORE',
  MULTI_PROVIDER_WHITELIST: 'BB_MULTI_PROVIDER_ALLOWED', PNBLACKLIST: 'SKIP_RECIPE',
  SDK_LOCAL_CONF_BLACKLIST: 'ESDK_LOCALCONF_REMOVE', SDK_LOCAL_CONF_WHITELIST: 'ESDK_LOCALCONF_ALLOW',
  SDK_INHERIT_BLACKLIST: 'ESDK_CLASS_INHERIT_DISABLE', SSTATE_DUPWHITELIST: 'SSTATE_ALLOW_OVERLAP_FILES',
  SYSROOT_DIRS_BLACKLIST: 'SYSROOT_DIRS_IGNORE', UNKNOWN_CONFIGURE_WHITELIST: 'UNKNOWN_CONFIGURE_OPT_IGNORE',
  ICECC_USER_CLASS_BL: 'ICECC_CLASS_DISABLE', ICECC_SYSTEM_CLASS_BL: 'ICECC_CLASS_DISABLE',
  ICECC_USER_PACKAGE_WL: 'ICECC_RECIPE_ENABLE', ICECC_USER_PACKAGE_BL: 'ICECC_RECIPE_DISABLE',
  ICECC_SYSTEM_PACKAGE_BL: 'ICECC_RECIPE_DISABLE', LICENSE_FLAGS_WHITELIST: 'LICENSE_FLAGS_ACCEPTED',
};
const REMOVED = ['BB_STAMP_WHITELIST', 'BB_STAMP_POLICY', 'INHERIT_BLACKLIST', 'TUNEABI_WHITELIST'];
// Overrides OE-Core sets that start with a listed word (class-nativesdk
// starts with class-native): a match on them is right, not a stray prefix.
const KNOWN_OVERRIDES = ['class-nativesdk', 'armv7a', 'armv7ve', 'armv8a', 'armv8-2a', 'x86-64', 'qemux86-64', 'qemuarm64', 'qemuarmv5', 'qemumips64', 'qemuppc64', 'qemuriscv32', 'qemuriscv64', 'mipsarchn32', 'mipsarchn64', 'mipsarcho32', 'powerpc64le', 'aarch64_be', 'riscv64gc', 'libc-musl-x32'];
const CONTEXT_WORDS = ['blacklist', 'whitelist', 'abort'];

const words = (s) => String(s ?? '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
const uniq = (a) => [...new Set(a)];

// ---------------------------------------------------------------- one line as cells
// A line is kept as its original characters, each with the text it has become
// (':' for a converted '_', '' for a character a rename swallowed, a longer
// string where text was inserted) and the change it belongs to. Every rule
// works on the rendered text and writes back through the cells, so each
// change stays tied to the characters of the original it came from.
class Line {
  constructor(text) {
    this.cells = [...text].map((o) => ({ o, n: o, ch: null }));
    this.changes = [];
  }
  get text() { return this.cells.map((c) => c.n).join(''); }
  // rendered offset -> [cell, offset inside the cell's text]
  at(pos) {
    let p = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const L = this.cells[i].n.length;
      if (pos < p + L) return [i, pos - p];
      p += L;
    }
    return [this.cells.length, 0];
  }
  // replace rendered [a, b) with text; returns the index of the first cell touched
  replace(a, b, text, change) {
    const [c0, o0] = this.at(a);
    const [c1raw, o1raw] = b > a ? this.at(b - 1) : [c0, o0 - 1];
    const c1 = Math.max(c0, c1raw), o1 = b > a ? o1raw + 1 : o0;
    const first = this.cells[Math.min(c0, this.cells.length - 1)];
    if (!first) return -1;
    const last = this.cells[Math.min(c1, this.cells.length - 1)];
    const tail = c0 === c1 ? first.n.slice(o1) : last.n.slice(o1);
    first.n = first.n.slice(0, o0) + text + tail;
    for (let i = c0 + 1; i <= c1 && i < this.cells.length; i++) this.cells[i].n = '';
    for (let i = c0; i <= c1 && i < this.cells.length; i++) this.cells[i].ch = change;
    return c0;
  }
  // the column (1-based, original) a rendered offset came from
  col(pos) { return Math.min(this.at(pos)[0], this.cells.length - 1) + 1; }
}

// Run a global regex on the line's rendered text; for each match, `edit(m)`
// returns [start, end, text, meta] to apply (or null). Matches are collected
// first and applied right to left: the same result as Python's re.sub, which
// scans the unmodified string.
function sweep(line, re, edit, rule, ctx) {
  const s = line.text;
  re.lastIndex = 0;
  const edits = [];
  let m;
  while ((m = re.exec(s))) {
    const e = edit(m);
    if (e) edits.push(e);
    if (m[0].length === 0) re.lastIndex++;
  }
  for (const [a, b, text, meta] of edits.reverse()) {
    const key = `${ctx.n}:${line.col(a)}`;
    const before = s.slice(a, b);
    if (before === text) continue;
    if (ctx.keep.has(key)) { ctx.kept.push(key); continue; }
    const change = { key, line: ctx.n, col: line.col(a), rule, before, after: text, ...meta };
    line.replace(a, b, text, change);
    line.changes.push(change);
  }
}

// ---------------------------------------------------------------- context of a line
// Which lines sit inside a shell or python function body.
function bodies(lines) {
  const inBody = new Array(lines.length).fill(false);
  let depth = 0, py = false;
  lines.forEach((ln, i) => {
    const t = ln.replace(/\s+$/, '');
    if (py) {
      if (t && !/^\s/.test(t) && !t.startsWith('#')) py = false;
      else { inBody[i] = true; return; }
    }
    if (depth > 0) {
      inBody[i] = true;
      if (/^\}\s*$/.test(t)) depth = 0;
      return;
    }
    if (/^\s*def\s+\w+\s*\(.*\)\s*:/.test(t)) { py = true; return; }
    if (/^\s*(fakeroot\s+)?(python\s+)?[\w\-.${}:]*\s*\(\s*\)\s*\{\s*$/.test(t)) depth = 1;
  });
  return inBody;
}

// where on a line a rendered position is: 'comment', 'value' (inside quotes
// after an assignment operator) or 'name'
function place(text, pos) {
  if (/^\s*#/.test(text)) return 'comment';
  const op = /^(\s*(?:export\s+)?[^\s=?+.]*(?:\[[^\]]*\])?\s*)(\?\?=|\?=|:=|\+=|=\+|=\.|\.=|=)/.exec(text);
  if (op && pos >= op[1].length + op[2].length) {
    const q = /(["'])(?:(?!\1).)*\1?/.exec(text.slice(op[0].length));
    const qs = q ? op[0].length + q.index : -1;
    if (q && pos >= qs && pos < qs + q[0].length) return 'value';
    const hash = text.indexOf('#', q ? qs + q[0].length : op[0].length);
    if (hash >= 0 && pos > hash) return 'comment';
    return 'value';
  }
  const hash = text.search(/\s#/);
  if (hash >= 0 && pos > hash) return 'comment';
  return 'name';
}

// ---------------------------------------------------------------- run
export function run(input) {
  const src = String(input.text ?? '').replace(/\r\n?/g, '\n');
  const addOv = words(input.overrides).map((w) => w.toLowerCase());
  const drop = new Set(words(input.drop));
  const addSkip = words(input.skip);
  const addPkg = words(input.packageVars);
  const keep = new Set(words(input.keep));
  const doRenames = input.renames !== false;
  const doSrcuri = input.srcuri !== false;
  const warnings = [], notes = [];

  const badOv = addOv.filter((w) => !/^[a-z0-9][a-z0-9-]*$/.test(w));
  if (badOv.length) warnings.push(`Not an override name: ${badOv.join(', ')}. Overrides are lower-case letters, digits and dashes (BitBake manual, Conditional Syntax); they were left out.`);
  const userOv = uniq(addOv.filter((w) => /^[a-z0-9][a-z0-9-]*$/.test(w)));
  // the script puts --override values first: vars = args.override; vars += [...]
  const ovList = uniq([...userOv, ...OVERRIDE_WORDS]).filter((w) => !drop.has(w) || ['append', 'prepend', 'remove'].includes(w));
  const shortList = SHORT_WORDS.filter((w) => !drop.has(w));
  const pkgList = uniq([...PACKAGE_VARS, ...addPkg, ...IMAGE_VARS]).filter((w) => !drop.has(w));
  const skipList = [...addSkip, ...SKIPS];
  const dropped = [...drop].filter((w) => OVERRIDE_WORDS.includes(w) || SHORT_WORDS.includes(w) || PACKAGE_VARS.includes(w) || IMAGE_VARS.includes(w));
  if (dropped.includes('append') || dropped.includes('prepend') || dropped.includes('remove')) notes.push('append, prepend and remove cannot be taken off the list; they are the operations themselves.');
  const realDrop = dropped.filter((w) => !['append', 'prepend', 'remove'].includes(w));
  if (realDrop.length) warnings.push(`Taken off the script's built-in lists: ${realDrop.join(', ')}. The output no longer matches convert-overrides.py; put them back unless they caused wrong rewrites here.`);

  // the patterns, built exactly as the script builds them
  const varsRe = ovList.map((exp) => [exp, new RegExp(`((^|[#'"\\s\\-\\+])[A-Za-z0-9_\\-:\${}\\.]+)_${esc(exp)}`, 'g')]);
  const shortRe = shortList.map((exp) => [exp, new RegExp(`((^|[#'"\\s\\-\\+])[A-Za-z0-9_\\-:\${}\\.]+)_${esc(exp)}([\\('"\\s:])`, 'g')]);
  const pkgRe = pkgList.map((exp) => [exp, new RegExp(`(^|[#'"\\s\\-\\+]+)${esc(exp)}_([$a-z"'\\s%\\[<{\\\\\\*].)`, 'g')]);

  const lines = src.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const inBody = bodies(lines);
  // lines that continue a value from the line before (a trailing backslash)
  const contd = lines.map((_, i) => i > 0 && /\\\s*$/.test(lines[i - 1]) && !inBody[i]);
  for (let i = 1; i < lines.length; i++) if (contd[i - 1] && /\\\s*$/.test(lines[i - 1])) contd[i] = !inBody[i];
  const ctxBase = { keep, kept: [] };
  const out = [];
  const findings = [];
  const usage = {};
  const bump = (k) => { usage[k] = (usage[k] || 0) + 1; };

  lines.forEach((raw, i) => {
    const n = i + 1;
    // Python iterates file lines with their '\n', and the patterns see it
    const L = new Line(raw + '\n');
    const ctx = { ...ctxBase, n };
    let skipped = null;
    // 1. skip strings (the ptest exception is the script's)
    for (const s of skipList) {
      if (raw.includes(s)) {
        skipped = s;
        if (raw.includes('ptest_append') || raw.includes('ptest_remove') || raw.includes('ptest_prepend')) skipped = null;
      }
    }
    // 2. literal Python rewrites; a line with one skips the patterns
    let subbed = false;
    for (const [a, b] of SUBS) {
      const t = L.text;
      if (t.includes(a)) {
        let at = t.indexOf(a);
        const hits = [];
        while (at >= 0) { hits.push(at); at = t.indexOf(a, at + a.length); }
        for (const h of hits.reverse()) sweepOne(L, h, h + a.length, b, 'python', {}, ctx);
        subbed = true;
      }
    }
    if (!skipped && !subbed) {
      // 3. variables that take a package name: RDEPENDS_${PN} -> RDEPENDS:${PN}
      for (const [exp, re] of pkgRe) {
        sweep(L, re, (m) => { const p = m.index + m[1].length + exp.length; return [p, p + 1, ':', { name: exp }]; }, 'package', ctx);
      }
      // 4. override words: _append, _arm, _class-native ...
      for (const [exp, re] of varsRe) {
        sweep(L, re, (m) => { const p = m.index + m[1].length; return [p, p + 1, ':', { name: exp }]; },
          ['append', 'prepend', 'remove'].includes(exp) ? 'operation' : userOv.includes(exp) ? 'yours' : 'override', ctx);
      }
      // 5. short overrides, only before ( ' " whitespace or :
      for (const [exp, re] of shortRe) {
        sweep(L, re, (m) => { const p = m.index + m[1].length; return [p, p + 1, ':', { name: exp }]; }, 'override', ctx);
      }
    } else if (skipped) {
      const t = raw;
      if (/_(append|prepend|remove)\b/.test(t)) findings.push({ line: n, kind: 'skipped', sev: 'note', text: `Left alone: the script skips any line containing "${skipped}".` });
    }
    // 6. the script's repair: pkg_postinst_ontarget stays one name
    {
      const t = L.text;
      let at = t.indexOf('pkg_postinst:ontarget');
      while (at >= 0) {
        const p = at + 'pkg_postinst'.length;
        const [ci] = L.at(p);
        const cell = L.cells[ci];
        if (cell && cell.ch && cell.o === '_') {
          L.changes = L.changes.filter((c) => c !== cell.ch);
          cell.n = '_'; cell.ch = null;
        } else if (cell) {
          sweepOne(L, p, p + 1, '_', 'repair', {}, ctx);
        }
        at = L.text.indexOf('pkg_postinst:ontarget', at + 1);
      }
    }
    // 7. Kirkstone renames (plain substring replace, as the script does)
    if (doRenames && !raw.includes('BB_RENAMED_VARIABLE')) {
      for (const [from, to] of Object.entries(RENAMES)) {
        let t = L.text;
        if (!t.includes(from)) continue;
        const hits = [];
        let at = t.indexOf(from);
        while (at >= 0) { hits.push(at); at = t.indexOf(from, at + from.length); }
        for (const h of hits.reverse()) sweepOne(L, h, h + from.length, to, 'rename', { name: from }, ctx);
      }
      for (const r of REMOVED) if (raw.includes(r)) findings.push({ line: n, kind: 'removed', sev: 'error', text: `${r} has been removed (convert-variable-renames.py): delete it or rework what it did.` });
      if (!/^\s*#/.test(raw)) {
        for (const w of CONTEXT_WORDS) if (new RegExp(w, 'i').test(L.text)) findings.push({ line: n, kind: 'wording', sev: 'note', text: `Contains "${w}": convert-variable-renames.py asks for a look, the name may have a new term.` });
      }
    }
    // 8. git SRC_URI: branch= and GitHub protocol=https (convert-srcuri.py)
    if (doSrcuri) {
      const matchline = (l) => !(l.includes('MIRROR') || l.includes('.*') || l.includes('GNOME_GIT'));
      let t = L.text;
      if ((t.includes('git://') || t.includes('gitsm://')) && !t.includes('branch=') && matchline(t)) {
        if (t.endsWith('"\n')) sweepOne(L, t.length - 2, t.length - 1, ';branch=master"', 'srcuri', { name: 'branch' }, ctx);
        else { const m = /\s*\\$/.exec(t.slice(0, -1)); if (m) sweepOne(L, m.index, t.length - 1, ';branch=master \\', 'srcuri', { name: 'branch' }, ctx); }
      }
      t = L.text;
      if ((t.includes('git://') || t.includes('gitsm://')) && t.includes('github.com') && !t.includes('protocol=https') && matchline(t)) {
        if (t.includes('protocol=git')) {
          const hits = []; let at = t.indexOf('protocol=git');
          while (at >= 0) { hits.push(at); at = t.indexOf('protocol=git', at + 1); }
          for (const h of hits.reverse()) sweepOne(L, h, h + 12, 'protocol=https', 'srcuri', { name: 'protocol' }, ctx);
        } else if (t.endsWith('"\n')) sweepOne(L, t.length - 2, t.length - 1, ';protocol=https"', 'srcuri', { name: 'protocol' }, ctx);
        else { const m = /\s*\\$/.exec(t.slice(0, -1)); if (m) sweepOne(L, m.index, t.length - 1, ';protocol=https \\', 'srcuri', { name: 'protocol' }, ctx); }
      }
    }

    // drop the trailing newline cell again
    const cells = L.cells.slice(0, -1);
    const conv = cells.map((c) => c.n).join('') + (L.cells[L.cells.length - 1].n.replace(/\n$/, ''));
    L.changes.sort((a, b) => a.col - b.col);

    // flags on the changes: where they sit, whether the word runs on
    const tok = (t, p) => {
      const isT = (ch) => /[A-Za-z0-9_\-${}.:/%]/.test(ch);
      let a = p, b = p;
      while (a > 0 && isT(t[a - 1])) a--;
      while (b < t.length && isT(t[b])) b++;
      return t.slice(a, Math.max(b, p + 1)).slice(0, 60);
    };
    for (const c of L.changes) {
      const rp = cells.slice(0, c.col - 1).map((x) => x.n).join('').length;
      c.word = tok(raw, c.col - 1);
      c.wordc = tok(conv, rp);
      if (c.rule === 'operation' || c.rule === 'override' || c.rule === 'yours') bump(c.name);
      if (c.rule === 'package') bump(`pkg:${c.name}`);
      const where = inBody[i] ? 'code' : contd[i] ? (/^\s*#/.test(raw) ? 'comment' : 'value') : place(raw, c.col - 1);
      if (where === 'comment') c.flag = { kind: 'comment', text: 'In a comment: harmless, but check the comment still says what it meant.' };
      else if (where === 'code') c.flag = { kind: 'code', text: 'Inside a function body: this is shell or Python text, not a variable name. Check it is a datastore name (d.getVar, a FILES entry), not an identifier.' };
      else if (where === 'value' && c.rule !== 'srcuri' && c.rule !== 'rename') c.flag = { kind: 'value', text: 'Inside a quoted value: likely a file name or a word, not an override. Keep the original unless it names a variable.' };
      if (c.rule === 'operation' || c.rule === 'override' || c.rule === 'yours') {
        // the rendered text right after ":<name>"
        const pos = cells.slice(0, c.col).map((x) => x.n).join('').length + c.name.length;
        const nx = conv.slice(pos, pos + 2);
        const full = (conv.slice(pos - c.name.length).match(/^[A-Za-z0-9-]+/) || [''])[0];
        if (/^[A-Za-z0-9]/.test(nx) && !ovList.includes(full) && !KNOWN_OVERRIDES.includes(full)) c.flag = { kind: 'partial', text: `"${c.name}" is only the start of "${full}": the script's pattern has no end boundary, so the whole word became an override. Right if "${full}" is an override; keep the original if it is part of a name.` };
        else if (/^_[a-z]/.test(nx) && !c.flag) {
          const rest = (conv.slice(pos + 1).match(/^[a-z0-9-]+/) || [''])[0];
          if (!ovList.includes(rest)) c.flag = { kind: 'runs-on', text: `The name runs on as "_${rest}" after the override word: probably one identifier (a function called ..._${c.name}_${rest}), or "${rest}" is an override the list does not know.` };
        }
      }
    }

    // what is left of the old syntax, and names that look like overrides
    const code = /^\s*#/.test(conv) ? '' : conv.replace(/\s+#.*$/, '');
    const lhs = /^\s*(?:export\s+)?(?:(?:fakeroot\s+)?python\s+)?([A-Za-z0-9_\-.${}:/~+]+)\s*(?:\[[^\]]*\])?\s*(\(\s*\)\s*\{|\?\?=|\?=|:=|\+=|=\+|=\.|\.=|=)/.exec(code);
    if (lhs) {
      const name = lhs[1];
      const old = /_(append|prepend|remove)(?![A-Za-z0-9])/.exec(name);
      if (old) {
        findings.push({ line: n, kind: 'old-syntax', sev: inBody[i] ? 'warn' : 'error', name,
          text: `"${name}" still has _${old[1]}: BitBake 2.x stops parsing with "contains an operation using the old override syntax".` });
      }
      // a known override still behind an underscore: the script's patterns
      // need the name before it to start after a quote, blank, # - or +, so
      // PREFERRED_PROVIDER_virtual/kernel_mymachine is never matched
      const left = !old && ovList.filter((w) => !['append', 'prepend', 'remove'].includes(w) && !w.endsWith('-'))
        .find((w) => new RegExp(`_${esc(w)}(?![A-Za-z0-9_-])`).test(name));
      if (left) {
        findings.push({ line: n, kind: 'missed', sev: 'warn', name,
          text: `"${name}" still has _${left}, a listed override the script's pattern did not reach (a / or similar before it). BitBake 2.x reads it as a different variable, silently. Write it as ${name.replace(new RegExp(`_${esc(left)}(?![A-Za-z0-9_-])`), ':' + left)} by hand.` });
      }
      const after = /:(append|prepend|remove)_([a-z0-9][a-z0-9-]*)/.exec(name);
      const tailOv = /^[A-Z][A-Z0-9_]*[A-Z0-9]_([a-z][a-z0-9-]*)(?::|$)/.exec(name) || /^(?:do|pkg)_[a-z_]+?:(?:append|prepend|remove)_([a-z][a-z0-9-]*)$/.exec(name);
      const cand = after ? after[2] : tailOv ? tailOv[1] : null;
      if (cand && !ovList.includes(cand)) {
        const fn = /\(\s*\)\s*\{/.test(lhs[2]);
        findings.push({ line: n, kind: 'unknown-override', sev: after ? 'error' : 'warn', name, suggest: cand,
          text: after
            ? (fn
              ? `"${name}": if "${cand}" is an override (a MACHINE or DISTRO), add it; if the function is just called ..._${after[1]}_${cand}, rename it - BitBake 2.x refuses any name containing _${after[1]}, converted or not.`
              : `"_${cand}" was not converted: "${cand}" is not on the override list. If it is a MACHINE, DISTRO or other override, add it.`)
            : `"${name}" ends in "_${cand}", which looks like an override the list does not know (a MACHINE or DISTRO name?). Add it if it is one.` });
      }
    }
    for (const ch of L.changes) if (ch.rule === 'rename') findings.push({ line: n, kind: 'renamed', sev: 'note', text: `${ch.before} was renamed to ${ch.after} (Kirkstone 4.0, BB_RENAMED_VARIABLES).` });

    out.push({ n, orig: raw, conv, changes: L.changes, segs: segments(cells) });
  });

  // ---------------------------------------------------------------- results
  const changes = out.flatMap((l) => l.changes);
  const flagged = changes.filter((c) => c.flag);
  const errors = findings.filter((f) => f.sev === 'error');
  const suggest = uniq(findings.filter((f) => f.suggest).map((f) => f.suggest));
  const converted = out.map((l) => l.conv).join('\n') + (src.endsWith('\n') ? '\n' : '');
  const keptKeys = ctxBase.kept;
  const staleKeep = [...keep].filter((k) => !keptKeys.includes(k));

  if (!src.trim()) warnings.push('Nothing to convert: paste a recipe, bbappend, .inc, .bbclass or .conf.');
  if (errors.length) warnings.push(`${errors.length} line${errors.length > 1 ? 's' : ''} will still stop BitBake 2.x: ${errors.slice(0, 4).map((f) => `line ${f.line}`).join(', ')}${errors.length > 4 ? ' ...' : ''}. See the review list.`);
  if (suggest.length) warnings.push(`Names that look like overrides but are not on the list: ${suggest.join(', ')}. Add the ones that are MACHINE, DISTRO or other overrides (--override in the script) and convert again.`);
  if (flagged.length) notes.push(`${flagged.length} rewrite${flagged.length > 1 ? 's' : ''} marked for a human (the script matches loosely; its header says so). Keep the original where the text was not an override.`);
  if (staleKeep.length) notes.push(`Kept-original marks that match no change any more (the text moved): ${staleKeep.join(', ')}.`);
  notes.push('Faithful to convert-overrides.py 0.9.3: every line is matched as if it ended with a newline, as Python reads it; a file is one pass, so run it again after adding overrides, as you would the script.');

  const byRule = (r) => changes.filter((c) => c.rule === r).length;
  const values = [
    { label: 'Lines changed', value: out.filter((l) => l.changes.length).length, hint: `of ${out.length}` },
    { label: 'Rewrites', value: changes.length, hint: `${byRule('operation')} operations, ${byRule('override') + byRule('yours')} overrides, ${byRule('package')} package names` },
    { label: 'For a human', value: flagged.length, tone: flagged.length ? 'warn' : 'ok' },
    { label: 'Still stops BitBake', value: errors.length, tone: errors.length ? 'bad' : 'ok' },
  ];
  if (doRenames) values.push({ label: 'Renamed variables', value: byRule('rename') });
  if (doSrcuri) values.push({ label: 'SRC_URI fixes', value: byRule('srcuri') });
  if (keptKeys.length) values.push({ label: 'Kept original', value: keptKeys.length });

  const RULE = { operation: 'operation', override: 'override', yours: 'your override', package: 'package name', python: 'python rewrite', repair: 'repair', rename: 'rename', srcuri: 'SRC_URI' };
  const tables = [];
  if (changes.length) {
    tables.push({ title: 'Rewrites', columns: ['Line', 'Rule', 'Before', 'After', 'Look at'],
      rows: changes.slice(0, 80).map((c) => [c.line, `${RULE[c.rule] || c.rule}${c.name ? ' ' + c.name : ''}`, c.word || c.before.replace(/\n/g, ''), c.wordc || c.after.replace(/\n/g, ''), c.flag ? c.flag.kind : '']) });
    if (changes.length > 80) notes.push(`Rewrites table shows the first 80 of ${changes.length}; the converted text has them all.`);
  }
  if (findings.length) {
    tables.push({ title: 'Review', columns: ['Line', 'Severity', 'Finding'], rows: findings.slice(0, 60).map((f) => [f.line, f.sev, f.text]) });
  }

  const texts = [{ title: 'Converted', body: converted || '\n' }, { title: 'Diff', body: diff(out) }];

  const usedOv = Object.entries(usage).filter(([k]) => !k.startsWith('pkg:')).map(([k, v]) => [k, v]);
  const usedPkg = Object.entries(usage).filter(([k]) => k.startsWith('pkg:')).map(([k, v]) => [k.slice(4), v]);
  return {
    values, tables, texts, warnings, notes,
    view: {
      lines: out.map((l) => ({ n: l.n, orig: l.orig, conv: l.conv, segs: l.segs,
        changes: l.changes.map((c) => ({ key: c.key, col: c.col, rule: c.rule, name: c.name || '', before: c.before.replace(/\n/g, ''), after: c.after.replace(/\n/g, ''), word: c.word, wordc: c.wordc, flag: c.flag || null })) })),
      kept: keptKeys,
      findings,
      suggest,
      lists: {
        user: userOv, builtin: OVERRIDE_WORDS.filter((w) => !['append', 'prepend', 'remove'].includes(w)), short: SHORT_WORDS,
        pkg: [...PACKAGE_VARS, ...IMAGE_VARS], userPkg: addPkg, dropped: realDrop, usedOv, usedPkg,
      },
    },
  };
}

// one edit at a rendered range, through sweep's bookkeeping
function sweepOne(L, a, b, text, rule, meta, ctx) {
  const s = L.text;
  const key = `${ctx.n}:${L.col(a)}`;
  const before = s.slice(a, b);
  if (before === text) return;
  if (ctx.keep.has(key) && rule !== 'repair') { ctx.kept.push(key); return; }
  const change = { key, line: ctx.n, col: L.col(a), rule, before, after: text, ...meta };
  L.replace(a, b, text, change);
  L.changes.push(change);
}

// the line as runs: [original text, converted text, change key | '']
function segments(cells) {
  const segs = [];
  for (const c of cells) {
    const k = c.ch ? c.ch.key : '';
    const last = segs[segs.length - 1];
    if (last && last[2] === k) { last[0] += c.o; last[1] += c.n; } else segs.push([c.o, c.n, k]);
  }
  return segs;
}

// a unified-style diff of the changed lines, 1 line of context
function diff(out) {
  const changed = out.filter((l) => l.orig !== l.conv).map((l) => l.n);
  if (!changed.length) return 'No changes.\n';
  const lines = ['--- original', '+++ converted'];
  const show = new Set();
  for (const n of changed) for (let k = n - 1; k <= n + 1; k++) if (k >= 1 && k <= out.length) show.add(k);
  let prev = 0;
  for (const n of [...show].sort((a, b) => a - b)) {
    if (n !== prev + 1) lines.push(`@@ line ${n} @@`);
    const l = out[n - 1];
    if (l.orig === l.conv) lines.push(' ' + l.orig);
    else lines.push('-' + l.orig, '+' + l.conv);
    prev = n;
  }
  return lines.join('\n') + '\n';
}
