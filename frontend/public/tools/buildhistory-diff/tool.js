// Buildhistory Diff: what changed between two Yocto builds of one image,
// read from the files buildhistory.bbclass writes under
// buildhistory/images/<machine>/<libc>/<image>/.
//
// Formats, as poky writes them (meta/classes/buildhistory.bbclass,
// buildhistory_get_installed and buildhistory_list_files, checked against
// kirkstone):
//   installed-package-sizes.txt  "<KiB>\tKiB\t<pkg>", largest first
//                                (oe-pkgdata-util read-value PKGSIZE rounds
//                                bytes to KiB: (b + 512) // 1024)
//   installed-package-info.txt   "<pkg> <PACKAGE> <PN> <PV> <KiB>"
//                                (read-value "PACKAGE,PN,PV,PKGSIZE" -n)
//   installed-packages.txt       package file names: name_ver_arch.ipk,
//                                name_ver_arch.deb, name-ver-rel.arch.rpm
//   installed-package-names.txt  one name per line
//   image-info.txt               "VAR = value", IMAGESIZE = du -ks of the rootfs
//   files-in-image.txt           find -printf "%M %-10u %-10g %10s %p -> %l"
//                                sorted by path; the size can be missing for
//                                device nodes under pseudo
// Every line is recognised on its own, so several files can be pasted into
// one box. A package whose name differs only in digits (kernel-image-zimage-
// 5.15.71 -> -5.15.120) is paired the way buildhistory_analysis.py pairs
// them (numeric_removal: digits -> X; here a whole digit run, so 71 and 120 match).

// buildhistory_analysis.py: monitor_numeric_threshold = 10 (per cent).
const BH_THRESHOLD_PCT = 10;
const DEV_SUFFIX = /-(dev|dbg|staticdev|src|ptest|doc)$/;

const MAX_ROWS = 400;     // rows kept for the drawing; the rest are summed
const MAX_FILES = 600;    // file rows kept for the drawing

// ---------------- version compare ----------------
// dpkg's verrevcmp (lib/dpkg/version.c): letters sort before non-letters,
// '~' before everything, digit runs compared as numbers. Epoch "N:" first,
// then upstream, then the revision after the last '-'.
function order(c) {
  if (c === '~') return -1;
  if (/\d/.test(c)) return 0;
  if (!c) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}
function verrevcmp(a, b) {
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let first = 0;
    while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
      const ac = order(a[i] || ''), bc = order(b[j] || '');
      if (ac !== bc) return ac - bc;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    while (i < a.length && /\d/.test(a[i]) && j < b.length && /\d/.test(b[j])) {
      if (!first) first = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (i < a.length && /\d/.test(a[i])) return 1;
    if (j < b.length && /\d/.test(b[j])) return -1;
    if (first) return first;
  }
  return 0;
}
export function vercmp(a, b) {
  const split = (v) => {
    const m = /^(\d+):(.*)$/.exec(v);
    const epoch = m ? Number(m[1]) : 0;
    const rest = m ? m[2] : v;
    const k = rest.lastIndexOf('-');
    return [epoch, k > 0 ? rest.slice(0, k) : rest, k > 0 ? rest.slice(k + 1) : ''];
  };
  const [ea, ua, ra] = split(String(a)), [eb, ub, rb] = split(String(b));
  if (ea !== eb) return Math.sign(ea - eb);
  return Math.sign(verrevcmp(ua, ub) || verrevcmp(ra, rb));
}

// ---------------- parsing ----------------
const RE_FILE = /^([-dlcbpsD])([-rwxsStT]{9})[.+@]?\s+(\S+)\s+(\S+)\s+(\d*)\s*\.(\/.*)$/;
const RE_SIZE = /^(\d+)\s+KiB\s+(\S+)$/;
const RE_INFO5 = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/;
const RE_INFO4 = /^(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/;
const RE_IPK = /^([^_\s/]+)_([^_\s]+)_([^_\s]+)\.(ipk|deb)$/;
const RE_RPM = /^(\S+)-([^-\s]+)-([^-\s]+)\.([^.\s]+)\.rpm$/;
const RE_VAR = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;

/** One pasted build: packages, files and image-info variables, with what could not be read. */
export function parseBuild(text) {
  const pk = new Map();       // name -> {kib?, ver?, pn?}
  const files = new Map();    // path -> {mode, user, group, size, target}
  const vars = {};
  const kinds = new Set();
  const bad = [];
  const pkg = (n) => { if (!pk.has(n)) pk.set(n, {}); return pk.get(n); };
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = RE_FILE.exec(line))) {
      let path = m[6], target = '';
      const k = path.indexOf(' -> ');
      if (k >= 0) { target = path.slice(k + 4); path = path.slice(0, k); }
      path = path.replace(/\/+$/, '') || '/';
      files.set(path, { mode: m[1] + m[2], user: m[3], group: m[4], size: m[5] === '' ? 0 : Number(m[5]), target });
      kinds.add('files-in-image.txt');
    } else if ((m = RE_SIZE.exec(line))) {
      pkg(m[2]).kib = Number(m[1]); kinds.add('installed-package-sizes.txt');
    } else if ((m = RE_VAR.exec(line))) {
      vars[m[1]] = m[2].trim(); kinds.add('image-info.txt');
    } else if ((m = RE_INFO5.exec(line))) {
      const p = pkg(m[1]); p.pn = m[3]; p.ver = m[4]; p.kib = Number(m[5]); kinds.add('installed-package-info.txt');
    } else if ((m = RE_INFO4.exec(line))) {
      // PV empty: oe-pkgdata-util joins an empty value, so one field fewer
      const p = pkg(m[1]); p.pn = m[3]; p.kib = Number(m[4]); kinds.add('installed-package-info.txt');
    } else if ((m = RE_IPK.exec(line))) {
      const p = pkg(m[1]); p.ver = m[2]; kinds.add('installed-packages.txt');
    } else if ((m = RE_RPM.exec(line))) {
      const p = pkg(m[1]); p.ver = `${m[2]}-${m[3]}`; kinds.add('installed-packages.txt');
    } else if (RE_NAME.test(line)) {
      pkg(line); kinds.add('installed-package-names.txt');
    } else {
      bad.push({ line: i + 1, text: line.length > 70 ? line.slice(0, 67) + '...' : line });
    }
  });
  return { pk, files, vars, kinds: [...kinds], bad };
}

// ---------------- helpers ----------------
const pct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : (b > 0 ? 100 : 0));
const r1 = (v) => Math.round(v * 10) / 10;
const kibOf = (bytes) => Math.round(bytes / 1024 * 10) / 10;
const signed = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);
// digit runs, not single digits, so 5.15.71 and 5.15.120 pair
const noDigits = (s) => s.replace(/[0-9]+/g, 'X');

function dirKey(path, depth) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

// Words of a package name that a file path would contain: openssh-sshd -> sshd,
// openssh; libssl3 -> libssl; python3-json -> json, python3.
const GENERIC = new Set(['lib', 'bin', 'dev', 'dbg', 'common', 'base', 'utils', 'util', 'core', 'data', 'tools', 'modules', 'module', 'image', 'kernel', 'misc', 'extra', 'plugins', 'conf', 'locale']);
function tokensFor(name, pn) {
  const out = new Set();
  const add = (t) => { t = (t || '').toLowerCase(); if (t.length >= 3 && /[a-z]/.test(t) && !GENERIC.has(t)) out.add(t); };
  for (const src of [name, pn].filter(Boolean)) {
    for (const t of src.split(/[-_]/)) { add(t); add(t.replace(/\d+$/, '')); }
  }
  return [...out];
}
function matches(path, f, toks) {
  const low = path.toLowerCase();
  const segs = low.split('/');
  const base = segs[segs.length - 1];
  return toks.some((t) => {
    const tl = t.toLowerCase();
    return base.startsWith(tl) || segs.slice(0, -1).some((s) => s === tl || s.startsWith(tl + '.') || s.startsWith(tl + '-'))
      || (f && f.target && f.target.toLowerCase().split('/').pop().startsWith(tl)) || base === tl;
  });
}

// ---------------- run ----------------
export function run(input) {
  const A = parseBuild(input.before);
  const B = parseBuild(input.after);
  const FA = parseBuild(input.filesBefore);
  const FB = parseBuild(input.filesAfter);
  // files may come in either box; the files boxes may carry packages too
  const merge = (x, y) => {
    for (const [k, v] of y.pk) x.pk.set(k, { ...(x.pk.get(k) || {}), ...v });
    for (const [k, v] of y.files) x.files.set(k, v);
    Object.assign(x.vars, y.vars);
    x.kinds = [...new Set([...x.kinds, ...y.kinds])];
    return x;
  };
  merge(A, FA); merge(B, FB);
  const badA = [...A.bad, ...FA.bad], badB = [...B.bad, ...FB.bad];

  const warnings = [], notes = [];
  const depth = Math.max(1, Math.min(4, Math.round(Number(input.depth) || 2)));
  const hasPk = A.pk.size + B.pk.size > 0;
  const hasFiles = A.files.size + B.files.size > 0;
  let by = input.by === 'dirs' || (input.by !== 'packages' && !hasPk && hasFiles) ? 'dirs' : 'packages';
  if (by === 'packages' && !hasPk && hasFiles) by = 'dirs';

  if (!hasPk && !hasFiles) {
    warnings.push('Neither build has anything this tool reads. Paste installed-package-sizes.txt, installed-package-info.txt, installed-packages.txt, installed-package-names.txt or files-in-image.txt from buildhistory/images/<machine>/<libc>/<image>/.');
  } else {
    if (hasPk && (A.pk.size === 0 || B.pk.size === 0)) warnings.push(`Build ${A.pk.size === 0 ? 'A (before)' : 'B (after)'} has no package lines, so every package shows as ${A.pk.size === 0 ? 'added' : 'removed'}. Paste the same file from both builds.`);
    if (hasFiles && (A.files.size === 0 || B.files.size === 0)) warnings.push(`files-in-image.txt is only in build ${A.files.size === 0 ? 'B' : 'A'}; the file diff needs it from both.`);
  }
  for (const [side, bad] of [['A (before)', badA], ['B (after)', badB]]) {
    if (bad.length) warnings.push(`Build ${side}: ${bad.length} line${bad.length > 1 ? 's' : ''} not read (line ${bad[0].line}: "${bad[0].text}"${bad[1] ? `; line ${bad[1].line}: "${bad[1].text}"` : ''}). They are left out; check they are from a buildhistory file.`);
  }

  // ---------- packages ----------
  const rows = [];
  const sizeKnown = { a: false, b: false };
  const verKnown = { a: false, b: false };
  for (const [, p] of A.pk) { if (p.kib != null) sizeKnown.a = true; if (p.ver) verKnown.a = true; }
  for (const [, p] of B.pk) { if (p.kib != null) sizeKnown.b = true; if (p.ver) verKnown.b = true; }
  if (hasPk && A.pk.size && B.pk.size && sizeKnown.a !== sizeKnown.b) warnings.push(`Sizes are only in build ${sizeKnown.a ? 'A' : 'B'}: paste installed-package-sizes.txt or installed-package-info.txt from both builds for size deltas.`);

  const names = new Set([...A.pk.keys(), ...B.pk.keys()]);
  // pair removed/added names that differ only in digits (kernel/module ABI names)
  const onlyA = [...names].filter((n) => A.pk.has(n) && !B.pk.has(n));
  const onlyB = new Map();
  for (const n of names) if (B.pk.has(n) && !A.pk.has(n)) {
    const k = noDigits(n);
    if (!onlyB.has(k)) onlyB.set(k, []);
    onlyB.get(k).push(n);
  }
  const renamed = new Map();  // old -> new
  for (const n of onlyA) {
    const list = onlyB.get(noDigits(n));
    if (list && list.length && /\d/.test(n)) renamed.set(n, list.shift());
  }
  const renamedTo = new Set(renamed.values());

  for (const n of names) {
    if (renamedTo.has(n)) continue;
    const nb = renamed.get(n);
    const pa = A.pk.get(n), pb = B.pk.get(nb || n);
    const row = { name: nb ? `${n} → ${nb}` : n, key: n, newName: nb || null,
      a: pa && pa.kib != null ? pa.kib : null, b: pb && pb.kib != null ? pb.kib : null,
      va: pa?.ver || '', vb: pb?.ver || '', pn: pb?.pn || pa?.pn || '' };
    if (!pa) row.st = 'added';
    else if (!pb) row.st = 'removed';
    else if (row.va && row.vb && row.va !== row.vb) row.st = vercmp(row.va, row.vb) > 0 ? 'downgraded' : 'upgraded';
    else if (nb) row.st = 'upgraded';
    else if (row.a != null && row.b != null && row.a !== row.b) row.st = 'resized';
    else row.st = 'same';
    const a0 = row.st === 'added' ? 0 : (row.a ?? 0), b0 = row.st === 'removed' ? 0 : (row.b ?? 0);
    row.d = (row.a == null && row.st !== 'added') || (row.b == null && row.st !== 'removed') ? 0 : b0 - a0;
    row.pct = row.a != null && row.b != null ? r1(pct(row.a, row.b)) : (row.st === 'added' ? 100 : row.st === 'removed' ? -100 : 0);
    rows.push(row);
  }

  // ---------- files ----------
  const fileRows = [];
  for (const path of new Set([...A.files.keys(), ...B.files.keys()])) {
    const fa = A.files.get(path), fb = B.files.get(path);
    const st = !fa ? 'added' : !fb ? 'removed'
      : (fa.size !== fb.size ? 'resized' : fa.mode !== fb.mode || fa.user !== fb.user || fa.group !== fb.group || fa.target !== fb.target ? 'changed' : 'same');
    const isFile = (f) => f && f.mode[0] === '-';
    const a = isFile(fa) ? fa.size : 0, b = isFile(fb) ? fb.size : 0;
    const what = [];
    if (fa && fb) {
      if (fa.mode !== fb.mode) what.push(`${fa.mode} → ${fb.mode}`);
      if (fa.user !== fb.user || fa.group !== fb.group) what.push(`${fa.user}:${fa.group} → ${fb.user}:${fb.group}`);
      if (fa.target !== fb.target) what.push(`→ ${fb.target || '(not a link)'}`);
    }
    fileRows.push({ path, st, a, b, d: b - a, mode: (fb || fa).mode, target: (fb || fa).target || '', what: what.join('; ') });
  }
  // A path that differs only in digit runs (zImage-5.15.71 -> zImage-5.15.120,
  // /lib/modules/<ver>/...) is one file that moved, shown as one row.
  const fileView = [];
  {
    const added = new Map();
    for (const f of fileRows) if (f.st === 'added') {
      const k = noDigits(f.path) + '|' + f.mode[0];
      if (!added.has(k)) added.set(k, []);
      added.get(k).push(f);
    }
    const used = new Set();
    for (const f of fileRows) {
      if (f.st === 'removed') {
        const list = added.get(noDigits(f.path) + '|' + f.mode[0]);
        const g = list && /\d/.test(f.path) ? list.shift() : null;
        if (g) { used.add(g); fileView.push({ ...g, st: g.b === f.a && g.mode === f.mode ? 'moved' : 'resized', from: f.path, a: f.a, d: g.b - f.a }); continue; }
      }
      if (!used.has(f)) fileView.push(f);
    }
    for (let i = fileView.length - 1; i >= 0; i--) if (used.has(fileView[i]) && !fileView[i].from) fileView.splice(i, 1);
  }
  const fileChanged = fileView.filter((f) => f.st !== 'same');
  const fsum = (side) => [...side.files.values()].reduce((s, f) => s + (f.mode[0] === '-' ? f.size : 0), 0);
  const filesTotalA = fsum(A), filesTotalB = fsum(B);

  // file permission findings in the new build
  if (B.files.size) {
    const suid = fileRows.filter((f) => f.st !== 'removed' && /^-..s|^-.....s/.test(f.mode) && (f.st === 'added' || !(A.files.get(f.path) && /^-..s|^-.....s/.test(A.files.get(f.path).mode))));
    if (A.files.size && suid.length) warnings.push(`New setuid/setgid file${suid.length > 1 ? 's' : ''} in build B: ${suid.slice(0, 4).map((f) => f.path).join(', ')}. Check it is intended; drop the bit in the recipe's do_install (chmod u-s) if not.`);
    const ww = fileRows.filter((f) => f.st !== 'removed' && f.mode[0] === '-' && f.mode[8] === 'w');
    if (ww.length) warnings.push(`World-writable file${ww.length > 1 ? 's' : ''} in build B: ${ww.slice(0, 4).map((f) => `${f.path} (${f.mode})`).join(', ')}. Any user can change ${ww.length > 1 ? 'them' : 'it'}; set the mode in do_install (install -m 0644) or a ROOTFS_POSTPROCESS_COMMAND.`);
  }

  // ---------- directory rows (when the bars are directories) ----------
  let unit = 'KiB';
  let items = rows;
  if (by === 'dirs') {
    const dirs = new Map();
    for (const f of fileRows) {
      const k = dirKey(f.path, depth);
      if (!dirs.has(k)) dirs.set(k, { name: k, key: k, a: 0, b: 0, inA: 0, inB: 0, va: '', vb: '', pn: '' });
      const d = dirs.get(k);
      if (A.files.has(f.path)) { d.a += f.a; d.inA++; }
      if (B.files.has(f.path)) { d.b += f.b; d.inB++; }
    }
    items = [...dirs.values()].map((d) => {
      const st = !d.inA ? 'added' : !d.inB ? 'removed' : d.a !== d.b ? 'resized' : 'same';
      const a = kibOf(d.a), b = kibOf(d.b);
      return { name: d.name, key: d.key, a: d.inA ? a : null, b: d.inB ? b : null, va: `${d.inA} file${d.inA === 1 ? '' : 's'}`, vb: `${d.inB} file${d.inB === 1 ? '' : 's'}`, pn: '', st,
        d: r1(b - a), pct: d.inA && d.inB ? r1(pct(a, b)) : (st === 'added' ? 100 : -100), newName: null };
    });
  }

  // ---------- totals ----------
  const tot = (side) => items.reduce((s, r) => s + (r[side] ?? 0), 0);
  const totalA = r1(tot('a')), totalB = r1(tot('b'));
  const count = (st) => items.filter((r) => r.st === st).length;
  const counts = { added: count('added'), removed: count('removed'), upgraded: count('upgraded'), downgraded: count('downgraded'), resized: count('resized'), same: count('same') };
  const imgA = Number(A.vars.IMAGESIZE), imgB = Number(B.vars.IMAGESIZE);
  const haveImg = Number.isFinite(imgA) && imgA > 0 && Number.isFinite(imgB) && imgB > 0;
  const sizesAny = by === 'dirs' || sizeKnown.a || sizeKnown.b;

  // ---------- filter, sort ----------
  const show = input.show || 'changed';
  const minKiB = Math.max(0, Number(input.minKiB) || 0);
  const pass = (r) => {
    if (show === 'all') return true;
    if (r.st === 'same') return false;
    if (show === 'changed') return r.st !== 'resized' || Math.abs(r.d) >= minKiB;
    if (show === 'added') return r.st === 'added';
    if (show === 'removed') return r.st === 'removed';
    if (show === 'version') return r.st === 'upgraded' || r.st === 'downgraded';
    if (show === 'size') return r.d !== 0 && Math.abs(r.d) >= minKiB;
    return true;
  };
  const cmp = {
    abs: (x, y) => Math.abs(y.d) - Math.abs(x.d) || x.name.localeCompare(y.name),
    growth: (x, y) => y.d - x.d || x.name.localeCompare(y.name),
    shrink: (x, y) => x.d - y.d || x.name.localeCompare(y.name),
    name: (x, y) => x.name.localeCompare(y.name),
    after: (x, y) => (y.b ?? -1) - (x.b ?? -1) || x.name.localeCompare(y.name),
  }[input.sort] || ((x, y) => Math.abs(y.d) - Math.abs(x.d) || x.name.localeCompare(y.name));
  const shown = items.filter(pass).sort(cmp);
  const hiddenSmall = show === 'changed' || show === 'size' ? items.filter((r) => r.st === 'resized' && Math.abs(r.d) < minKiB).length : 0;
  const top = Math.max(1, Math.min(MAX_ROWS, Math.round(Number(input.top) || 30)));
  const listed = shown.slice(0, top);
  const rest = shown.slice(top);
  const restD = r1(rest.reduce((s, r) => s + r.d, 0));
  const unlistedD = r1(totalB - totalA - listed.reduce((s, r) => s + r.d, 0));

  // ---------- focus ----------
  let focusRow = items.find((r) => r.key === String(input.focus || '').trim() || r.name === String(input.focus || '').trim() || r.newName === String(input.focus || '').trim());
  if (String(input.focus || '').trim() && !focusRow) notes.push(`"${String(input.focus).trim()}" is not in either build; showing the largest change instead.`);
  if (!focusRow) focusRow = listed[0] || null;
  let focus = null;
  if (focusRow) {
    let fl = [];
    let how = '';
    if (by === 'dirs') {
      fl = fileView.filter((f) => f.st !== 'same' && (f.path === focusRow.key || f.path.startsWith(focusRow.key === '/' ? '/' : focusRow.key + '/')) && (focusRow.key !== '/' || f.path.split('/').filter(Boolean).length <= 1));
      how = `files under ${focusRow.key}`;
    } else if (hasFiles) {
      const toks = tokensFor(focusRow.newName || focusRow.key, focusRow.pn).concat(focusRow.newName ? tokensFor(focusRow.key, '') : []);
      fl = fileView.filter((f) => f.st !== 'same' && (matches(f.path, f, toks) || (f.from && matches(f.from, null, toks))));
      how = toks.length ? `files whose path matches ${toks.map((t) => `"${t}"`).join(', ')} (files-in-image.txt has no owning package)` : '';
    }
    fl.sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || x.path.localeCompare(y.path));
    focus = { ...focusRow, how, files: fl.slice(0, 60), filesMore: Math.max(0, fl.length - 60) };
  }

  // ---------- warnings about what changed ----------
  if (sizesAny && totalA > 0 && Math.abs(pct(totalA, totalB)) >= BH_THRESHOLD_PCT) {
    warnings.push(`The ${by === 'dirs' ? 'rootfs files' : 'installed packages'} ${totalB > totalA ? 'grew' : 'shrank'} ${Math.abs(r1(pct(totalA, totalB)))}% (${signed(totalB - totalA, 0)} KiB), past buildhistory's 10% reporting threshold. Check the largest rows are intended before this image ships.`);
  }
  if (by === 'packages') {
    const devAdded = rows.filter((r) => (r.st === 'added') && DEV_SUFFIX.test(r.key));
    if (devAdded.length) warnings.push(`Development/debug package${devAdded.length > 1 ? 's' : ''} added to the image: ${devAdded.map((r) => r.key).join(', ')}. Usually pulled in by IMAGE_FEATURES (dev-pkgs, dbg-pkgs, ptest-pkgs) or an IMAGE_INSTALL line; remove them for a production image.`);
    const down = rows.filter((r) => r.st === 'downgraded');
    if (down.length) warnings.push(`Version went down: ${down.map((r) => `${r.key} ${r.va} → ${r.vb}`).join(', ')}. Check PREFERRED_VERSION, layer priorities (BBFILE_PRIORITY) and bbappends; a downgrade can reintroduce fixed CVEs.`);
    if (renamed.size) notes.push(`Paired by name with digits ignored (as buildhistory_analysis.py does): ${[...renamed].slice(0, 4).map(([a, b]) => `${a} → ${b}`).join(', ')}${renamed.size > 4 ? ` and ${renamed.size - 4} more` : ''}. Kernel and module packages carry the kernel version in their name.`);
  }
  if (!sizesAny && hasPk) notes.push('No sizes in these files: the list shows added, removed and version changes only. installed-package-sizes.txt or installed-package-info.txt adds sizes.');
  if (haveImg && sizesAny && by === 'packages') notes.push(`IMAGESIZE (du -ks of the rootfs) went ${imgA} → ${imgB} KiB (${signed(imgB - imgA)}). It counts files the packages do not own (postinst output, ldconfig cache, the package database), so it differs from the package sum.`);
  if (hiddenSmall) notes.push(`${hiddenSmall} size change${hiddenSmall > 1 ? 's' : ''} under ${minKiB} KiB hidden (Min change).`);
  notes.push('Sizes are PKGSIZE rounded to KiB by oe-pkgdata-util - installed bytes, not the space on a compressed or block-rounded filesystem.');

  // ---------- image-info variables ----------
  const varRows = [];
  for (const k of new Set([...Object.keys(A.vars), ...Object.keys(B.vars)])) {
    if (k === 'IMAGESIZE') continue;
    const x = A.vars[k] ?? '', y = B.vars[k] ?? '';
    if (x === y) continue;
    const xs = x.split(/\s+/).filter(Boolean), ys = y.split(/\s+/).filter(Boolean);
    const add = ys.filter((t) => !xs.includes(t)), rem = xs.filter((t) => !ys.includes(t));
    varRows.push([k, [...add.map((t) => '+' + t), ...rem.map((t) => '-' + t)].join(' ') || `${x} → ${y}`]);
  }

  // ---------- result ----------
  const label = by === 'dirs' ? 'Directory' : 'Package';
  const values = [
    { label: `Build A total`, value: totalA, unit: 'KiB', hint: `${by === 'dirs' ? A.files.size + ' paths' : A.pk.size + ' packages'}` },
    { label: `Build B total`, value: totalB, unit: 'KiB', hint: `${by === 'dirs' ? B.files.size + ' paths' : B.pk.size + ' packages'}` },
    { label: 'Change', value: `${signed(totalB - totalA, 0)}`, unit: 'KiB', hint: `${signed(r1(pct(totalA, totalB)), 1)}%`, tone: sizesAny && Math.abs(pct(totalA, totalB)) >= BH_THRESHOLD_PCT ? 'warn' : 'ok' },
    { label: 'Added / removed', value: `${counts.added} / ${counts.removed}` },
    { label: 'Version up / down', value: `${counts.upgraded} / ${counts.downgraded}`, tone: counts.downgraded ? 'warn' : undefined },
    { label: 'Size only', value: counts.resized },
  ].map((v) => (v.tone ? v : (delete v.tone, v)));
  if (haveImg) values.push({ label: 'IMAGESIZE (du -ks)', value: `${imgA} → ${imgB}`, unit: 'KiB', hint: `${signed(imgB - imgA)} KiB` });
  if (hasFiles && by === 'packages') values.push({ label: 'Files changed', value: fileChanged.length, hint: `${fileChanged.filter((f) => f.st === 'added').length} added, ${fileChanged.filter((f) => f.st === 'removed').length} removed, ${fileChanged.filter((f) => f.from).length} moved` });

  const fmtK = (v) => (v == null ? '–' : String(v));
  const tables = [{
    title: `${label} changes, ${input.sort === 'name' ? 'by name' : 'largest first'} (${Math.min(listed.length, 25)} of ${shown.length})`,
    columns: [label, 'Status', 'A KiB', 'B KiB', 'Δ KiB', 'Δ %', by === 'dirs' ? 'Files' : 'Version'],
    rows: listed.slice(0, 25).map((r) => [r.name, r.st, fmtK(r.a), fmtK(r.b), r.a == null && r.b == null ? '–' : signed(r.d, by === 'dirs' ? 1 : 0), r.a != null && r.b != null ? signed(r.pct, 1) : '–',
      by === 'dirs' ? `${r.va} → ${r.vb}` : (r.va && r.vb && r.va !== r.vb ? `${r.va} → ${r.vb}` : r.vb || r.va || '')]),
  }];
  if (hasFiles && fileChanged.length) {
    const fl = [...fileChanged].sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || x.path.localeCompare(y.path)).slice(0, 15);
    tables.push({ title: `Largest file changes (${fl.length} of ${fileChanged.length})`, columns: ['Path', 'Status', 'A bytes', 'B bytes', 'Δ bytes', 'Other'],
      rows: fl.map((f) => [f.from ? `${f.from} → ${f.path}` : f.path, f.st, f.st === 'added' ? '–' : f.a, f.st === 'removed' ? '–' : f.b, (f.d > 0 ? '+' : '') + f.d, f.what || (f.target ? '→ ' + f.target : '')]) });
  }
  if (varRows.length) tables.push({ title: 'image-info.txt variables that changed', columns: ['Variable', 'Change'], rows: varRows });

  // buildhistory-diff style text
  const rep = [];
  rep.push(`Changes between build A and build B (${by === 'dirs' ? `files-in-image.txt, directories to depth ${depth}` : A.kinds.concat(B.kinds).filter((k, i, a) => a.indexOf(k) === i && k !== 'files-in-image.txt' && k !== 'image-info.txt').join(', ') || 'no package files'}):`);
  if (sizesAny) rep.push(`  total changed from ${totalA} KiB to ${totalB} KiB (${signed(r1(pct(totalA, totalB)), 1)}%)`);
  if (haveImg) rep.push(`  IMAGESIZE changed from ${imgA} to ${imgB} (${signed(r1(pct(imgA, imgB)), 0)}%)`);
  const listFor = (st) => items.filter((r) => r.st === st).sort(cmp);
  for (const r of listFor('added').slice(0, 40)) rep.push(`  + ${r.newName || r.key}${r.vb ? ' ' + r.vb : ''}${r.b != null ? ` (${r.b} KiB)` : ''}`);
  for (const r of listFor('removed').slice(0, 40)) rep.push(`  - ${r.key}${r.va ? ' ' + r.va : ''}${r.a != null ? ` (${r.a} KiB)` : ''}`);
  for (const r of [...listFor('upgraded'), ...listFor('downgraded')].slice(0, 40)) rep.push(`  ${r.name}: ${r.st === 'downgraded' ? 'DOWNGRADED' : 'PV changed'} ${r.va || '?'} -> ${r.vb || '?'}${r.a != null && r.b != null && r.a !== r.b ? `, size ${r.a} -> ${r.b} KiB (${signed(r.pct, 0)}%)` : ''}`);
  for (const r of listFor('resized').filter((r) => Math.abs(r.d) >= minKiB).slice(0, 40)) rep.push(`  ${r.name}: size changed from ${r.a} to ${r.b} KiB (${signed(r.pct, 0)}%)${Math.abs(r.pct) < BH_THRESHOLD_PCT ? '  [under 10%: buildhistory-diff would not report it]' : ''}`);
  for (const [k, v] of varRows) rep.push(`  ${k}: ${v}`);
  const texts = [{ title: 'Report', body: rep.join('\n') + '\n' }];

  return {
    values, tables, texts, warnings, notes,
    draw: {
      by, unit, depth, sizes: sizesAny, totals: { a: totalA, b: totalB, imgA: haveImg ? imgA : null, imgB: haveImg ? imgB : null, filesA: filesTotalA, filesB: filesTotalB },
      counts, kinds: { a: A.kinds, b: B.kinds }, bad: { a: badA.length, b: badB.length }, npk: { a: A.pk.size, b: B.pk.size }, nfiles: { a: A.files.size, b: B.files.size },
      rows: listed.map(({ name, key, newName, a, b, d, pct: p, va, vb, st, pn }) => ({ name, key, newName, a, b, d, pct: p, va, vb, st, pn })),
      shownCount: shown.length, restCount: rest.length, restD, unlistedD,
      focus, hasFiles, filesChanged: fileChanged.length, vars: varRows,
      topFiles: by === 'packages' ? [...fileChanged].sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, Math.min(MAX_FILES, 30)) : [],
    },
  };
}
