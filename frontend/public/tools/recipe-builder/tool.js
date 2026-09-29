// Recipe Builder & Linter: a BitBake recipe (.bb) written from choices, or a
// pasted one read, split into its anatomy (header, fetch, build, install,
// packaging) and checked for the classic mistakes.
//
// Every rule below names what in OpenEmbedded-Core enforces it. They were
// read from oe-core scarthgap (5.0, LAYERSERIES_CORENAMES "scarthgap") and
// kirkstone (4.0) on the machine this was written on:
//   meta/conf/bitbake.conf          S = "${WORKDIR}/${BP}", bindir & co, FILES:${PN}
//                                   defaults, SUMMARY ?= "${PN} version ...",
//                                   SRCREV ??= "INVALID", SRCPV = "" (scarthgap)
//   meta/classes-global/insane.bbclass  WARN_QA / ERROR_QA lists; license-checksum,
//                                   src-uri-bad, pkgvarcheck, expanded-d,
//                                   host-user-contaminated, ldflags, uppercase-pn
//   meta/classes-global/base.bbclass    "does not have the LICENSE field set"
//   meta/classes-global/package.bbclass package_setup_pkgv: the source revision is
//                                   added to PKGV when PV contains "+" (scarthgap)
//   meta/lib/oe/license.py          obsolete_license_list(); conf/licenses.conf SPDXLICENSEMAP
//   meta/classes-recipe/systemd.bbclass SYSTEMD_SERVICE:<pkg>, "Didn't find service unit"
//   meta/classes-recipe/cmake|meson.bbclass  B = "${WORKDIR}/build"
//   meta/classes-recipe/go.bbclass  git unpacked to <S>/src/${GO_IMPORT}
//   meta/conf/distro/include/default-distrovars.inc  BB_STRICT_CHECKSUM = "1"
//   bitbake/lib/bb/fetch2/git.py    branch= warning, protocol=https for github
//   bitbake/lib/bb/data_smart.py    old "_append" syntax is fatal (bitbake >= 1.52)
//   bitbake/lib/bb/parse/ast.py     ":append" with "+=" is "not a recommended operator combination"
// Walnascar (5.2) and later: from the 5.2 migration notes (UNPACKDIR, git
// unpacked to ${BP}, S must not be ${WORKDIR}/git) - not checked against a
// source tree here, and said so in the notes.

// ---------------------------------------------------------------- reference

export const RELEASES = {
  kirkstone: { name: 'kirkstone (4.0)', unpack: 'WORKDIR', gitS: '${WORKDIR}/git', srcpv: true },
  scarthgap: { name: 'scarthgap (5.0)', unpack: 'WORKDIR', gitS: '${WORKDIR}/git', srcpv: false },
  walnascar: { name: 'walnascar (5.2) or later', unpack: 'UNPACKDIR', gitS: null, srcpv: false },
};

// md5 of meta/files/common-licenses/<name> (md5sum on scarthgap).
export const COMMON_MD5 = {
  'MIT': '0835ade698e0bcf8506ecda2f7b4f302', 'Apache-2.0': '89aea4e17d99a7cacdbeed46a0096b10',
  'GPL-2.0-only': '801f80980d171dd6425610833a22dbe6', 'GPL-2.0-or-later': 'fed54355545ffd980b814dab4a3b312c',
  'GPL-3.0-only': 'c79ff39f19dfec6d293b95dea7b07891', 'GPL-3.0-or-later': '1c76c4cc354acaac30ed4d5eefea7245',
  'LGPL-2.1-only': '1a6d268fd218675ffea8be556788b780', 'LGPL-2.1-or-later': '2a4f4fd2128ea2f65047ee63fbca9f68',
  'BSD-2-Clause': 'cb641bc04cda31daea161b1bc15da69f', 'BSD-3-Clause': '550794465ba0ec5312d6919e203a55f9',
  'ISC': 'f3b90e78ea0cffb20bf5cca7947a896d', 'MPL-2.0': '815ca599c9df247a0c7f619bab123dad',
  'Zlib': '87f239f408daca8a157858e192597633',
};

// conf/licenses.conf SPDXLICENSEMAP (the names in oe.license.obsolete_license_list()).
const SPDX_MAP = Object.fromEntries(('AGPL-3=AGPL-3.0-only AGPL-3+=AGPL-3.0-or-later AGPLv3=AGPL-3.0-only AGPLv3+=AGPL-3.0-or-later AGPLv3.0=AGPL-3.0-only AGPLv3.0+=AGPL-3.0-or-later AGPL-3.0=AGPL-3.0-only AGPL-3.0+=AGPL-3.0-or-later BSD-0-Clause=0BSD GPL-1=GPL-1.0-only GPL-1+=GPL-1.0-or-later GPLv1=GPL-1.0-only GPLv1+=GPL-1.0-or-later GPLv1.0=GPL-1.0-only GPLv1.0+=GPL-1.0-or-later GPL-1.0=GPL-1.0-only GPL-1.0+=GPL-1.0-or-later GPL-2=GPL-2.0-only GPL-2+=GPL-2.0-or-later GPLv2=GPL-2.0-only GPLv2+=GPL-2.0-or-later GPLv2.0=GPL-2.0-only GPLv2.0+=GPL-2.0-or-later GPL-2.0=GPL-2.0-only GPL-2.0+=GPL-2.0-or-later GPL-3=GPL-3.0-only GPL-3+=GPL-3.0-or-later GPLv3=GPL-3.0-only GPLv3+=GPL-3.0-or-later GPLv3.0=GPL-3.0-only GPLv3.0+=GPL-3.0-or-later GPL-3.0=GPL-3.0-only GPL-3.0+=GPL-3.0-or-later LGPLv2=LGPL-2.0-only LGPLv2+=LGPL-2.0-or-later LGPLv2.0=LGPL-2.0-only LGPLv2.0+=LGPL-2.0-or-later LGPL-2.0=LGPL-2.0-only LGPL-2.0+=LGPL-2.0-or-later LGPL2.1=LGPL-2.1-only LGPL2.1+=LGPL-2.1-or-later LGPLv2.1=LGPL-2.1-only LGPLv2.1+=LGPL-2.1-or-later LGPL-2.1=LGPL-2.1-only LGPL-2.1+=LGPL-2.1-or-later LGPLv3=LGPL-3.0-only LGPLv3+=LGPL-3.0-or-later LGPL-3.0=LGPL-3.0-only LGPL-3.0+=LGPL-3.0-or-later MPL-1=MPL-1.0 MPLv1=MPL-1.0 MPLv1.1=MPL-1.1 MPLv2=MPL-2.0 MIT-X=MIT MIT-style=MIT openssl=OpenSSL PSF=PSF-2.0 PSFv2=PSF-2.0 Python-2=Python-2.0 Apachev2=Apache-2.0 Apache-2=Apache-2.0 Artisticv1=Artistic-1.0 Artistic-1=Artistic-1.0 AFL-2=AFL-2.0 AFL-1=AFL-1.2 AFLv2=AFL-2.0 AFLv1=AFL-1.2 CDDLv1=CDDL-1.0 CDDL-1=CDDL-1.0 EPLv1.0=EPL-1.0 FreeType=FTL Nauman=Naumen tcl=TCL vim=Vim SGIv1=SGI-1')
  .split(' ').map((p) => p.split('=')));

// Build classes: what each one gives the recipe.
export const BUILD = {
  cmake: { cls: 'cmake', label: 'CMake', conf: 'EXTRA_OECMAKE', installs: true },
  meson: { cls: 'meson', label: 'Meson', conf: 'EXTRA_OEMESON', installs: true },
  autotools: { cls: 'autotools', label: 'Autotools', conf: 'EXTRA_OECONF', installs: true },
  setuptools3: { cls: 'setuptools3', label: 'Python setuptools', conf: null, installs: true },
  'go-mod': { cls: 'go-mod', label: 'Go module', conf: null, installs: true },
  cargo: { cls: 'cargo', label: 'Cargo', conf: null, installs: true },
  module: { cls: 'module', label: 'Kernel module', conf: null, installs: true },
  make: { cls: null, label: 'Plain Makefile', conf: 'EXTRA_OEMAKE', installs: false },
};
const BUILD_CLASSES = ['cmake', 'meson', 'autotools', 'autotools-brokensep', 'setuptools3', 'python_setuptools_build_meta',
  'python_poetry_core', 'python_pep517', 'go', 'go-mod', 'cargo', 'module', 'qmake5', 'waf', 'scons', 'kernel'];

// Variables whose value is a space-separated list: ":append" needs a leading space.
const LIST_VARS = new Set(['SRC_URI', 'DEPENDS', 'RDEPENDS', 'RRECOMMENDS', 'RSUGGESTS', 'RPROVIDES', 'RCONFLICTS', 'RREPLACES',
  'FILES', 'PACKAGES', 'EXTRA_OECMAKE', 'EXTRA_OECONF', 'EXTRA_OEMESON', 'EXTRA_OEMAKE', 'PACKAGECONFIG', 'IMAGE_INSTALL',
  'DISTRO_FEATURES', 'MACHINE_FEATURES', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'TARGET_CFLAGS', 'TARGET_LDFLAGS', 'INSANE_SKIP',
  'SYSTEMD_SERVICE', 'KERNEL_MODULE_AUTOLOAD', 'KERNEL_MODULE_PROBECONF', 'CONFFILES', 'USERADD_PACKAGES', 'GO_INSTALL',
  'PACKAGE_BEFORE_PN', 'CORE_IMAGE_EXTRA_INSTALL', 'IMAGE_FEATURES', 'EXTRA_IMAGE_FEATURES', 'RDEPENDS', 'TOOLCHAIN_TARGET_TASK']);

// meta/classes-global/package.bbclass PACKAGEVARS (take a package name override).
const PACKAGEVARS = ['FILES', 'RDEPENDS', 'RRECOMMENDS', 'SUMMARY', 'DESCRIPTION', 'RSUGGESTS', 'RPROVIDES', 'RCONFLICTS',
  'PKG', 'ALLOW_EMPTY', 'pkg_postinst', 'pkg_postrm', 'pkg_postinst_ontarget', 'INITSCRIPT_NAME', 'INITSCRIPT_PARAMS',
  'CONFFILES', 'SYSTEMD_SERVICE', 'LICENSE', 'SECTION', 'pkg_preinst', 'pkg_prerm', 'RREPLACES', 'SYSTEMD_AUTO_ENABLE',
  'INSANE_SKIP', 'USERADD_PARAM', 'GROUPADD_PARAM', 'PRIVATE_LIBS', 'SKIP_FILEDEPS'];
// insane.bbclass pkgvarcheck: set without a package name, these do nothing.
const PKGVARCHECK = ['RDEPENDS', 'RRECOMMENDS', 'RSUGGESTS', 'RCONFLICTS', 'RPROVIDES', 'RREPLACES', 'FILES',
  'pkg_preinst', 'pkg_postinst', 'pkg_prerm', 'pkg_postrm', 'ALLOW_EMPTY'];

// Hard-coded target paths and the bitbake.conf variable for each (longest first).
const PATHS = [
  ['/usr/lib/systemd/system', '${systemd_system_unitdir}'], ['/lib/systemd/system', '${systemd_system_unitdir}'],
  ['/usr/libexec', '${libexecdir}'], ['/usr/include', '${includedir}'], ['/usr/share/doc', '${docdir}'],
  ['/usr/share/man', '${mandir}'], ['/usr/share', '${datadir}'], ['/usr/sbin', '${sbindir}'], ['/usr/bin', '${bindir}'],
  ['/usr/lib', '${libdir}'], ['/etc', '${sysconfdir}'], ['/var', '${localstatedir}'], ['/sbin', '${base_sbindir}'],
  ['/bin', '${base_bindir}'], ['/lib', '${base_libdir}'],
];

// Blocks of the anatomy and which variables belong to each.
export const BLOCKS = [
  { id: 'header', title: 'Header', what: 'what it is and under which licence' },
  { id: 'fetch', title: 'Fetch', what: 'where the source comes from and where it lands' },
  { id: 'build', title: 'Build', what: 'which class builds it, with what' },
  { id: 'install', title: 'Install', what: 'what lands in ${D}' },
  { id: 'package', title: 'Packaging', what: 'which package ships what, and what it needs at run time' },
  { id: 'other', title: 'Other', what: 'lines that belong to none of the above' },
];
const VAR_BLOCK = {
  header: ['SUMMARY', 'DESCRIPTION', 'HOMEPAGE', 'BUGTRACKER', 'SECTION', 'LICENSE', 'LIC_FILES_CHKSUM', 'AUTHOR',
    'RECIPE_MAINTAINER', 'CVE_PRODUCT', 'CVE_VERSION', 'LICENSE_FLAGS', 'NO_GENERIC_LICENSE'],
  fetch: ['SRC_URI', 'SRCREV', 'SRCREV_FORMAT', 'S', 'PV', 'PR', 'PE', 'SRCBRANCH', 'BRANCH', 'UNPACKDIR', 'GO_IMPORT',
    'SRCPV', 'UPSTREAM_CHECK_URI', 'UPSTREAM_CHECK_REGEX', 'UPSTREAM_CHECK_COMMITS', 'PYPI_PACKAGE', 'BPN'],
  build: ['DEPENDS', 'EXTRA_OECMAKE', 'EXTRA_OECONF', 'EXTRA_OEMESON', 'EXTRA_OEMAKE', 'PACKAGECONFIG', 'B', 'CFLAGS',
    'CXXFLAGS', 'LDFLAGS', 'TARGET_CC_ARCH', 'TARGET_CFLAGS', 'TARGET_LDFLAGS', 'OECMAKE_GENERATOR', 'GO_INSTALL',
    'GOBUILDFLAGS', 'CARGO_BUILD_FLAGS', 'COMPATIBLE_MACHINE', 'COMPATIBLE_HOST', 'REQUIRED_DISTRO_FEATURES',
    'BBCLASSEXTEND', 'PARALLEL_MAKE', 'SECURITY_CFLAGS', 'TOOLCHAIN', 'EXTRA_OESCONS', 'CARGO_SRC_DIR'],
  install: [],
  package: ['FILES', 'RDEPENDS', 'RRECOMMENDS', 'RSUGGESTS', 'RPROVIDES', 'RCONFLICTS', 'RREPLACES', 'PACKAGES',
    'PACKAGE_BEFORE_PN', 'SYSTEMD_SERVICE', 'SYSTEMD_AUTO_ENABLE', 'SYSTEMD_PACKAGES', 'CONFFILES', 'INITSCRIPT_NAME',
    'INITSCRIPT_PARAMS', 'ALLOW_EMPTY', 'INSANE_SKIP', 'KERNEL_MODULE_AUTOLOAD', 'KERNEL_MODULE_PROBECONF',
    'USERADD_PACKAGES', 'USERADD_PARAM', 'GROUPADD_PARAM', 'PACKAGE_ARCH', 'ALTERNATIVE', 'ALTERNATIVE_PRIORITY',
    'PRIVATE_LIBS', 'SKIP_FILEDEPS', 'PKG'],
};
const BLOCK_OF = {};
for (const [b, vs] of Object.entries(VAR_BLOCK)) for (const v of vs) BLOCK_OF[v] = b;

// ---------------------------------------------------------------- small helpers

const q = (s) => `"${s}"`;
const trimDollar = (s) => String(s ?? '').trim();
const isHex = (s, n) => new RegExp(`^[0-9a-fA-F]{${n}}$`).test(s);
// The variable a key belongs to: RDEPENDS:${PN} -> RDEPENDS; SRC_URI[sha256sum] -> SRC_URI;
// old syntax RDEPENDS_${PN} / DEPENDS_append -> RDEPENDS / DEPENDS.
function baseName(key) {
  let k = key.replace(/\[.*$/, '').split(':')[0];
  const old = /^(.*?)_(append|prepend|remove)(_.*)?$/.exec(k);
  if (old) k = old[1];
  const pv = new RegExp(`^(${PACKAGEVARS.join('|')})_(\\$\\{PN\\}|[a-z].*)$`).exec(k);
  if (pv) k = pv[1];
  return k;
}
function blockOfVar(key) {
  const b = baseName(key);
  if (BLOCK_OF[b]) return BLOCK_OF[b];
  if (/^SRCREV_|^SRC_URI$|^PV_/.test(b)) return 'fetch';
  if (/^EXTRA_OE|^PACKAGECONFIG|^CARGO_|^GO/.test(b)) return 'build';
  if (/^SYSTEMD_|^USERADD|^GROUPADD|^ALTERNATIVE/.test(b)) return 'package';
  return 'other';
}
function blockOfFunc(name) {
  const n = name.replace(/[:_](append|prepend)(:.*)?$/, '');
  if (/^do_install/.test(n)) return 'install';
  if (/^(do_configure|do_compile|do_patch|do_unpack|do_fetch)/.test(n)) return /^do_(fetch|unpack|patch)/.test(n) ? 'fetch' : 'build';
  if (/^pkg_/.test(n)) return 'package';
  return 'other';
}

// ---------------------------------------------------------------- the parser

/**
 * Reads a .bb into statements, the way bitbake's ConfHandler/BBHandler does
 * in outline: lines ending in "\" join; `name() {` .. `}` is a function;
 * VAR op "value" (__config_regexp__ operators); inherit; include/require.
 */
export function parseRecipe(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const stmts = [];
  const unread = [];
  let i = 0;
  const assignRe = /^(export\s+)?([A-Za-z0-9\-_+.${}/~:]+?)(\[([A-Za-z0-9\-_+.@]+)\])?\s*(:=|\?\?=|\?=|\+=|=\+|=\.|\.=|=)\s*(["'])([\s\S]*)\6\s*$/;
  const funcRe = /^(fakeroot\s+)?(python\s+)?([A-Za-z0-9_${}.:+\-]+)\s*\(\s*\)\s*\{\s*$/;
  while (i < lines.length) {
    const start = i;
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (t.startsWith('#')) { stmts.push({ kind: 'comment', line: start + 1, end: start + 1, raw: line }); i++; continue; }
    const fm = funcRe.exec(line);
    if (fm) {
      let j = i + 1;
      while (j < lines.length && !/^\}\s*$/.test(lines[j])) j++;
      const closed = j < lines.length;
      const body = lines.slice(i + 1, closed ? j : lines.length);
      stmts.push({ kind: 'func', line: start + 1, end: (closed ? j : lines.length - 1) + 1, name: fm[3], python: !!fm[2],
        body, bodyStart: start + 2, raw: lines.slice(i, (closed ? j : lines.length - 1) + 1).join('\n') });
      if (!closed) unread.push(`line ${start + 1}: function ${fm[3]}() has no closing "}" at the start of a line`);
      i = closed ? j + 1 : lines.length;
      continue;
    }
    // logical line: join backslash continuations
    let joined = line;
    let j = i;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) { j++; joined = joined.replace(/\\\s*$/, '') + '\n' + lines[j]; }
    const flat = joined.replace(/\n/g, ' ');
    const raw = lines.slice(i, j + 1).join('\n');
    const am = assignRe.exec(flat.trim());
    if (am) {
      stmts.push({ kind: 'assign', line: start + 1, end: j + 1, raw, var: am[2], flag: am[4] || null, op: am[5],
        value: am[7], quote: am[6], exported: !!am[1] });
    } else if (/^inherit(_defer)?\s+/.test(t)) {
      const classes = t.replace(/^inherit(_defer)?\s+/, '').replace(/#.*$/, '').trim().split(/\s+/).filter(Boolean);
      stmts.push({ kind: 'inherit', line: start + 1, end: j + 1, raw, classes });
    } else if (/^(include|require)\s+/.test(t)) {
      stmts.push({ kind: 'include', line: start + 1, end: j + 1, raw, file: t.replace(/^(include|require)\s+/, '') });
    } else if (/^(addtask|deltask|addhandler|EXPORT_FUNCTIONS|unset|export)\b/.test(t)) {
      stmts.push({ kind: 'directive', line: start + 1, end: j + 1, raw });
    } else {
      stmts.push({ kind: 'unknown', line: start + 1, end: j + 1, raw });
      unread.push(`line ${start + 1}: not a recognised statement: ${t.slice(0, 60)}`);
    }
    i = j + 1;
  }
  return { lines, stmts, unread };
}

// ---------------------------------------------------------------- the generator (Build mode)

function splitWords(s) { return String(s ?? '').trim().split(/[\s,]+/).filter(Boolean); }

/** A git URL as typed (https, ssh, git@host:path) -> the git:// SRC_URI entry with protocol and branch. */
export function gitSrcUri(url, branch) {
  let u = trimDollar(url);
  let proto = 'https';
  let m;
  if ((m = /^git@([^:]+):(.+)$/.exec(u))) { u = `${m[1]}/${m[2]}`; proto = 'ssh'; }
  else if ((m = /^(https?|ssh|git|gitsm):\/\/(.+)$/.exec(u))) {
    const scheme = m[1];
    u = m[2];
    proto = scheme === 'git' || scheme === 'gitsm' ? 'https' : scheme === 'ssh' ? 'ssh' : scheme;
    if (scheme === 'git' || scheme === 'gitsm') {
      const pm = /;protocol=([a-z]+)/.exec(u);
      if (pm) proto = pm[1];
    }
  }
  u = u.replace(/;.*$/, '').replace(/^[^@/]+@/, '');
  const params = [`protocol=${proto}`];
  params.push(branch ? `branch=${branch}` : 'nobranch=1');
  return `git://${u};${params.join(';')}`;
}

/** The recipe text for Build mode, from the choices. */
export function generate(input) {
  const rel = RELEASES[input.release] || RELEASES.scarthgap;
  const pn = trimDollar(input.pn) || 'myapp';
  const pv = trimDollar(input.pv) || '1.0';
  const build = BUILD[input.buildsys] ? input.buildsys : 'cmake';
  const B = BUILD[build];
  const src = ['git', 'tarball', 'local'].includes(input.source) ? input.source : 'git';
  const lic = trimDollar(input.license) || 'MIT';
  const svc = trimDollar(input.service);
  const conf = trimDollar(input.conffile);
  const wd = rel.unpack === 'UNPACKDIR' ? '${UNPACKDIR}' : '${WORKDIR}';
  const out = [];

  // header
  out.push(`SUMMARY = ${q(trimDollar(input.summary))}`);
  if (trimDollar(input.homepage)) out.push(`HOMEPAGE = ${q(trimDollar(input.homepage))}`);
  out.push(`LICENSE = ${q(lic)}`);
  if (lic !== 'CLOSED') {
    const md5 = trimDollar(input.licmd5);
    const file = trimDollar(input.licfile);
    if (file) out.push(`LIC_FILES_CHKSUM = "file://${build === 'go-mod' ? 'src/${GO_IMPORT}/' : ''}${file};md5=${md5}"`);
    else if (COMMON_MD5[lic]) out.push(`LIC_FILES_CHKSUM = "file://\${COMMON_LICENSE_DIR}/${lic};md5=${COMMON_MD5[lic]}"`);
  }
  out.push('');

  // fetch
  const extra = [];
  if (svc) extra.push(`file://${svc}`);
  if (conf) extra.push(`file://${conf}`);
  const localFiles = src === 'local' ? splitWords(input.files).map((f) => `file://${f}`) : [];
  let first;
  if (build === 'go-mod' && src === 'git') {
    const imp = trimDollar(input.url).replace(/^[a-z]+:\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '').replace(/;.*$/, '');
    out.push(`GO_IMPORT = ${q(imp)}`);
    first = gitSrcUri(trimDollar(input.url), trimDollar(input.branch)).replace(/^git:\/\/[^;]+/, 'git://${GO_IMPORT}');
  } else if (src === 'git') first = gitSrcUri(input.url, trimDollar(input.branch));
  else if (src === 'tarball') {
    let u = trimDollar(input.url);
    if (u.includes(`${pn}-${pv}`)) u = u.split(`${pn}-${pv}`).join('${BP}');
    else if (u.includes(pv)) u = u.split(pv).join('${PV}');
    first = u;
  }
  const all = [first, ...localFiles, ...extra].filter(Boolean);
  if (all.length <= 1) out.push(`SRC_URI = ${q(all[0] || '')}`);
  else out.push(`SRC_URI = "${all[0]} \\`, ...all.slice(1).map((a) => `           ${a} \\`), '           "');
  if (src === 'git') {
    const rev = trimDollar(input.srcrev);
    out.push(`SRCREV = ${q(rev || '${AUTOREV}')}`);
    if (/AUTOREV/.test(rev || 'AUTOREV')) out.push(`PV = "${pv}+git${rel.srcpv ? '${SRCPV}' : ''}"`);
    if (rel.gitS && build !== 'go-mod') out.push(`S = ${q(rel.gitS)}`);
  } else if (src === 'tarball') {
    out.push(`SRC_URI[sha256sum] = ${q(trimDollar(input.sha256))}`);
  } else if (src === 'local') {
    out.push(`S = ${q(rel.unpack === 'UNPACKDIR' ? '${UNPACKDIR}' : '${WORKDIR}')}`);
  }
  out.push('');

  // build
  const deps = splitWords(input.depends);
  if (build === 'cargo') out.push(`require \${BPN}-crates.inc`, '');
  if (deps.length) out.push(`DEPENDS = ${q(deps.join(' '))}`, '');
  const classes = [B.cls, ...(input.pkgconfig && ['cmake', 'meson', 'autotools'].includes(build) ? ['pkgconfig'] : []),
    ...(build === 'cargo' ? ['cargo-update-recipe-crates'] : []), ...(svc ? ['systemd'] : [])].filter(Boolean);
  if (classes.length) out.push(`inherit ${classes.join(' ')}`, '');
  const confArgs = trimDollar(input.confargs);
  if (B.conf && confArgs && build !== 'make') out.push(`${B.conf} = ${q(confArgs)}`, '');
  if (build === 'make') {
    out.push(`EXTRA_OEMAKE = "'CC=\${CC}' 'CFLAGS=\${CFLAGS}' 'LDFLAGS=\${LDFLAGS}'${confArgs ? ' ' + confArgs : ''}"`, '');
    out.push('do_compile() {', '    oe_runmake', '}', '');
  }

  // install
  const inst = [];
  const bins = splitWords(input.binaries);
  if (build === 'make') {
    inst.push('    install -d ${D}${bindir}');
    for (const b of bins.length ? bins : [pn]) inst.push(`    install -m 0755 \${B}/${b} \${D}\${bindir}/${b}`);
  }
  if (svc) {
    inst.push('    install -d ${D}${systemd_system_unitdir}');
    inst.push(`    install -m 0644 ${wd}/${svc} \${D}\${systemd_system_unitdir}/${svc}`);
  }
  if (conf) {
    inst.push('    install -d ${D}${sysconfdir}');
    inst.push(`    install -m 0644 ${wd}/${conf} \${D}\${sysconfdir}/${conf}`);
  }
  if (inst.length) out.push(B.installs ? 'do_install:append() {' : 'do_install() {', ...inst, '}', '');

  // packaging
  if (svc) out.push(`SYSTEMD_SERVICE:\${PN} = ${q(svc)}`);
  if (conf) out.push(`CONFFILES:\${PN} = "\${sysconfdir}/${conf}"`);
  const rdeps = splitWords(input.rdepends);
  if (build === 'module') out.push(`RPROVIDES:\${PN} += "kernel-module-${pn.replace(/^kernel-module-/, '')}"`);
  if (rdeps.length) out.push(`RDEPENDS:\${PN} += ${q(rdeps.join(' '))}`);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- the linter

const SEV_ORDER = { error: 0, warn: 1, info: 2 };

/** Expand the few bitbake.conf path variables a do_install uses, for reasoning about paths. */
function expandPath(p, pn) {
  const map = {
    '${D}': '', '$D': '', '${bindir}': '/usr/bin', '${sbindir}': '/usr/sbin', '${libdir}': '/usr/lib', '${libexecdir}': '/usr/libexec',
    '${includedir}': '/usr/include', '${datadir}': '/usr/share', '${docdir}': '/usr/share/doc', '${mandir}': '/usr/share/man',
    '${sysconfdir}': '/etc', '${localstatedir}': '/var', '${base_bindir}': '/bin', '${base_sbindir}': '/sbin',
    '${base_libdir}': '/lib', '${nonarch_base_libdir}': '/lib', '${nonarch_libdir}': '/usr/lib', '${prefix}': '/usr', '${exec_prefix}': '/usr',
    '${systemd_system_unitdir}': '/lib/systemd/system', '${systemd_unitdir}': '/lib/systemd', '${servicedir}': '/srv',
    '${BPN}': pn, '${PN}': pn,
  };
  let s = p;
  for (let k = 0; k < 3; k++) for (const [a, b] of Object.entries(map)) s = s.split(a).join(b);
  return s;
}

/**
 * Lints a parsed recipe. Returns findings {sev, check, block, line, msg, why, source, fix?}
 * where fix = {label, ops: [{at, del, ins: [lines]}]} (1-based line splice) or {label, set: {input: value}}.
 */
export function lint(parsed, opt) {
  const { stmts, lines } = parsed;
  const rel = RELEASES[opt.release] || RELEASES.scarthgap;
  const F = [];
  const add = (f) => F.push(f);
  const assigns = stmts.filter((s) => s.kind === 'assign');
  const funcs = stmts.filter((s) => s.kind === 'func');
  const inherits = stmts.filter((s) => s.kind === 'inherit');
  const classes = inherits.flatMap((s) => s.classes);
  const has = (c) => classes.includes(c);
  const firstAssign = (name) => assigns.find((a) => a.var === name && !a.flag);
  const allOf = (base) => assigns.filter((a) => baseName(a.var) === base);
  const lastLine = lines.length && lines[lines.length - 1] === '' ? lines.length : lines.length + 1;
  const pn = opt.pn;
  const pv = (firstAssign('PV') || {}).value ?? opt.pv;

  // Where a new line fits in a block: after the block's last statement.
  const afterBlock = (block, fallbackAfter = 0) => {
    const inB = stmts.filter((s) => s.kind !== 'comment' && blockOf(s) === block);
    return inB.length ? inB[inB.length - 1].end + 1 : fallbackAfter + 1;
  };
  const replaceLine = (n, text) => ({ at: n, del: 1, ins: [text] });

  // SRC_URI entries (all assignments, roughly as they add up)
  const srcAssigns = allOf('SRC_URI').filter((a) => !a.flag && !/:remove/.test(a.var));
  const srcEntries = srcAssigns.flatMap((a) => a.value.split(/\s+/).filter(Boolean).map((e) => ({ e, stmt: a })));
  const gitEntries = srcEntries.filter((x) => /^(git|gitsm):\/\//.test(x.e));
  const tarEntries = srcEntries.filter((x) => /^(https?|ftp):\/\/.+\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|zip|tar)(;|$)/.test(x.e));
  const fetches = srcEntries.some((x) => !/^file:\/\//.test(x.e));
  const isGo = has('go') || has('go-mod');

  // ---- header ----
  const licS = firstAssign('LICENSE');
  if (!licS) {
    add({ sev: 'error', check: 'license-missing', block: 'header', line: 1, source: 'base.bbclass',
      msg: 'No LICENSE: bitbake stops with "This recipe does not have the LICENSE field set".',
      why: 'Every recipe needs a LICENSE, an SPDX expression like "MIT" or "GPL-2.0-only & BSD-3-Clause", or "CLOSED" for in-house code.',
      fix: { label: 'Add LICENSE = "CLOSED"', ops: [{ at: afterBlock('header'), del: 0, ins: ['LICENSE = "CLOSED"'] }] } });
  } else {
    const names = licS.value.split(/[\s&|()]+/).filter(Boolean);
    const bad = names.filter((n) => SPDX_MAP[n]);
    if (bad.length) {
      let v = licS.value;
      for (const b of bad) v = v.replace(new RegExp(`(^|[\\s&|()])${b.replace(/[+.]/g, '\\$&')}(?=$|[\\s&|()])`), `$1${SPDX_MAP[b]}`);
      add({ sev: 'warn', check: 'obsolete-license', block: 'header', line: licS.line, source: 'insane.bbclass obsolete-license, licenses.conf SPDXLICENSEMAP',
        msg: `LICENSE uses the old name${bad.length > 1 ? 's' : ''} ${bad.join(', ')}; write the SPDX name (${bad.map((b) => SPDX_MAP[b]).join(', ')}).`,
        why: 'Since dunfell the licence names are SPDX identifiers; GPLv2 is ambiguous between GPL-2.0-only and GPL-2.0-or-later, so check which one the source says.',
        fix: { label: `Use ${bad.map((b) => SPDX_MAP[b]).join(', ')}`, ops: [replaceLine(licS.line, licS.raw.replace(licS.value, v))] } });
    }
  }
  const lic = licS ? licS.value.trim() : '';
  const lfc = allOf('LIC_FILES_CHKSUM')[0];
  if (lic && lic !== 'CLOSED' && !lfc && srcEntries.length) {
    const lic1 = lic.split(/[\s&|()]+/).filter(Boolean)[0];
    const spdx = SPDX_MAP[lic1] || lic1;
    add({ sev: 'error', check: 'license-checksum', block: 'header', line: licS.line, source: 'insane.bbclass license-checksum (ERROR_QA)',
      msg: 'No LIC_FILES_CHKSUM: "Recipe file fetches files and does not have license file information".',
      why: 'Point it at the licence file in the source (file://LICENSE;md5=...) so a licence change upstream breaks the build. Get the md5 with md5sum on the file, or build once and read the error.',
      fix: COMMON_MD5[spdx] ? { label: `Use \${COMMON_LICENSE_DIR}/${spdx}`, ops: [{ at: licS.line + 1, del: 0, ins: [`LIC_FILES_CHKSUM = "file://\${COMMON_LICENSE_DIR}/${spdx};md5=${COMMON_MD5[spdx]}"`] }] } : undefined });
  }
  if (lfc) {
    for (const ent of lfc.value.split(/\s+/).filter(Boolean)) {
      const md = /;md5=([^;\s]*)/.exec(ent);
      const sha = /;sha256=([^;\s]*)/.exec(ent);
      if (!/^file:\/\//.test(ent)) add({ sev: 'error', check: 'license-checksum', block: 'header', line: lfc.line, source: 'insane.bbclass license-checksum',
        msg: `LIC_FILES_CHKSUM entry "${ent}" is not a file:// URL.`, why: 'Each entry is file://<path relative to S>;md5=<md5 of that file>.' });
      else if (!md && !sha) add({ sev: 'error', check: 'license-checksum', block: 'header', line: lfc.line, source: 'insane.bbclass license-checksum',
        msg: `LIC_FILES_CHKSUM entry ${ent.replace(/^file:\/\//, '')} has no md5=.`, why: 'Without a checksum the licence file is never checked. Add ;md5=<md5sum of the file>.' });
      else if (md && !isHex(md[1], 32)) add({ sev: 'error', check: 'license-checksum', block: 'header', line: lfc.line, source: 'insane.bbclass license-checksum',
        msg: `md5 "${md[1] || '(empty)'}" in LIC_FILES_CHKSUM is not 32 hex digits.`, why: 'Run md5sum on the licence file in the unpacked source and paste the result.' });
    }
  }
  const sum = firstAssign('SUMMARY');
  if (!sum && !firstAssign('DESCRIPTION')) {
    add({ sev: 'info', check: 'missing-metadata', block: 'header', line: 1, source: 'insane.bbclass missing-metadata; bitbake.conf SUMMARY ?= "${PN} version ${PV}-${PR}"',
      msg: 'No SUMMARY: packages get "<pn> version <pv>-r0" as their description.',
      why: 'A one-line SUMMARY is what package managers and the SBOM show.',
      fix: { label: 'Add SUMMARY', ops: [{ at: 1, del: 0, ins: [`SUMMARY = "${pn || 'TODO'}: one line on what it is"`] }] } });
  }
  if (/[A-Z]/.test(pn || '')) add({ sev: 'warn', check: 'uppercase-pn', block: 'header', line: 1, source: 'insane.bbclass uppercase-pn',
    msg: `Recipe name "${pn}" has upper-case letters.`, why: 'PN becomes package and override names, which must be lower case. Rename the file.' });

  // ---- fetch ----
  if (!srcEntries.length) add({ sev: 'warn', check: 'no-src-uri', block: 'fetch', line: 1, source: 'bitbake.conf SRC_URI = ""',
    msg: 'No SRC_URI: nothing is fetched.', why: 'Only a packagegroup or an image has no sources.' });
  for (const { e, stmt } of srcEntries) {
    if (/\$\{PN\}/.test(e)) add({ sev: 'warn', check: 'src-uri-bad', block: 'fetch', line: stmt.line, source: 'insane.bbclass src-uri-bad',
      msg: 'SRC_URI uses ${PN}; use ${BPN} (PN is "<name>-native" in a native build, BPN is the bare name).', why: 'The same recipe fetched as native or nativesdk would look for a different file.',
      fix: stmt.line === stmt.end ? { label: 'Use ${BPN}', ops: [replaceLine(stmt.line, stmt.raw.split('${PN}').join('${BPN}'))] } : undefined });
    if (/git(hu|la)b\.com\/.+\/.+\/archive\/.+/.test(e) || /\/\/codeload\.github\.com\//.test(e)) add({ sev: 'warn', check: 'src-uri-bad', block: 'fetch', line: stmt.line,
      source: 'insane.bbclass src-uri-bad', msg: 'SRC_URI fetches a GitHub/GitLab generated archive: "uses unstable GitHub/GitLab archives, convert recipe to use git protocol".',
      why: 'Those tarballs are generated on request and their checksum can change. Fetch with git:// and a SRCREV, or use a release asset.' });
  }
  for (const { e, stmt } of gitEntries) {
    const host = (/^[a-z]+:\/\/([^/;]+)/.exec(e) || [])[1] || '';
    const params = Object.fromEntries(e.split(';').slice(1).map((p) => p.split('=')));
    const fixEntry = (neu) => stmt.raw.includes(e) ? { ops: [{ at: stmt.line, del: stmt.end - stmt.line + 1, ins: stmt.raw.replace(e, neu).split('\n') }] } : null;
    if (!params.branch && params.nobranch !== '1') {
      const f = fixEntry(`${e};branch=master`);
      add({ sev: 'warn', check: 'git-branch', block: 'fetch', line: stmt.line, source: 'bitbake fetch2/git.py',
        msg: `git URL has no branch=: "does not set any branch parameter" - bitbake assumes master.`,
        why: 'The SRCREV must be on that branch or the fetch fails. Name the branch the commit is on (main, master, a release branch), or nobranch=1 for a tag or detached commit.',
        fix: f ? { label: 'Add ;branch=master (check it)', ...f } : undefined });
    }
    if (!params.protocol) {
      const gh = /github\.com|gitlab\.com/.test(host);
      const f = fixEntry(`${e};protocol=https`);
      add({ sev: gh ? 'warn' : 'info', check: 'git-protocol', block: 'fetch', line: stmt.line, source: 'bitbake fetch2/git.py',
        msg: gh ? 'git:// on github.com without protocol=: "uses git protocol which is no longer supported by github".' : 'git URL without protocol= uses the unauthenticated git:// protocol.',
        why: 'git:// in SRC_URI names the fetcher, not the transport; protocol=https (or ssh) is the transport.',
        fix: f ? { label: 'Add ;protocol=https', ...f } : undefined });
    }
  }
  const srcrevs = assigns.filter((a) => /^SRCREV($|_|:)/.test(a.var) && !a.flag);
  const srcrev = srcrevs.find((a) => a.var === 'SRCREV') || srcrevs[0];
  if (gitEntries.length && !srcrevs.length) {
    add({ sev: 'error', check: 'srcrev-missing', block: 'fetch', line: gitEntries[0].stmt.line, source: 'bitbake.conf SRCREV ??= "INVALID"',
      msg: 'git source without SRCREV: the fetch fails with SRCREV "INVALID".',
      why: 'Pin a full 40-character commit hash for a reproducible build, or SRCREV = "${AUTOREV}" to follow the branch (not in a release).',
      fix: { label: 'Add SRCREV = "${AUTOREV}"', ops: [{ at: gitEntries[0].stmt.end + 1, del: 0, ins: ['SRCREV = "${AUTOREV}"'] }] } });
  }
  const auto = srcrevs.some((a) => /AUTOREV/.test(a.value));
  for (const a of srcrevs) {
    if (!/AUTOREV/.test(a.value) && a.value && !isHex(a.value.trim(), 40) && !/\$\{/.test(a.value)) add({ sev: 'warn', check: 'srcrev-not-hash', block: 'fetch', line: a.line,
      source: 'bitbake fetch2/git.py', msg: `SRCREV "${a.value}" is not a 40-character commit hash.`,
      why: 'A tag or branch name makes bitbake ask the server on every parse (and fails offline); a short hash does not resolve. Use the full commit id.' });
  }
  if (auto) {
    const pvS = firstAssign('PV');
    const pvVal = pvS ? pvS.value : String(pv || '');
    const want = rel.srcpv ? '+git${SRCPV}' : '+git';
    const base = pvVal.replace(/\+git.*$/, '') || '1.0';
    if (!/\+git/.test(pvVal) || (rel.srcpv && !/SRCPV/.test(pvVal))) {
      add({ sev: 'warn', check: 'autorev-pv', block: 'fetch', line: (srcrev || {}).line || 1,
        source: rel.srcpv ? 'bitbake.conf SRCPV (kirkstone)' : 'package.bbclass package_setup_pkgv (scarthgap)',
        msg: `SRCREV = \${AUTOREV} but PV has no "${want}": every new commit builds with the same version.`,
        why: rel.srcpv ? 'On kirkstone PV must carry ${SRCPV} so the package version changes with the commit.'
          : 'From nanbield on, a "+" in PV makes bitbake add the revision to the package version; "1.0+git" is enough.',
        fix: pvS ? { label: `PV = "${base}${want}"`, ops: [replaceLine(pvS.line, pvS.raw.replace(pvS.value, base + want))] }
          : { label: `Add PV = "${base}${want}"`, ops: [{ at: srcrev ? srcrev.end + 1 : afterBlock('fetch'), del: 0, ins: [`PV = "${base}${want}"`] }] } });
    }
  }
  const pvS = firstAssign('PV');
  if (pvS && !rel.srcpv && /\$\{SRCPV\}/.test(pvS.value)) add({ sev: 'info', check: 'srcpv-deprecated', block: 'fetch', line: pvS.line,
    source: 'bitbake.conf SRCPV = "" (scarthgap)', msg: '${SRCPV} in PV is empty from nanbield on; "+git" alone does the job.',
    why: 'Harmless, but the version no longer comes from it.', fix: { label: 'Drop ${SRCPV}', ops: [replaceLine(pvS.line, pvS.raw.replace('${SRCPV}', ''))] } });
  if (tarEntries.length) {
    const sums = assigns.filter((a) => baseName(a.var) === 'SRC_URI' && a.flag && /sum$/.test(a.flag));
    if (!sums.length) add({ sev: 'error', check: 'checksum-missing', block: 'fetch', line: tarEntries[0].stmt.line,
      source: 'fetch2 NoChecksumError; default-distrovars.inc BB_STRICT_CHECKSUM = "1"',
      msg: 'Tarball without SRC_URI[sha256sum]: the fetch stops with "No checksum specified".',
      why: 'sha256sum the downloaded file (or build once and copy the line from the error) and add SRC_URI[sha256sum] = "...".',
      fix: { label: 'Add SRC_URI[sha256sum] line', ops: [{ at: tarEntries[0].stmt.end + 1, del: 0, ins: ['SRC_URI[sha256sum] = "<sha256 of the tarball>"'] }] } });
    for (const s of sums) if (!isHex(s.value.trim(), s.flag === 'md5sum' ? 32 : 64)) add({ sev: 'error', check: 'checksum-bad', block: 'fetch', line: s.line,
      source: 'bitbake fetch2 checksums', msg: `SRC_URI[${s.flag}] "${s.value}" is not a ${s.flag === 'md5sum' ? 32 : 64}-digit hex checksum.`, why: 'Paste the checksum of the downloaded file.' });
  }
  const sS = firstAssign('S');
  const gitDest = gitEntries.some((x) => /;destsuffix=/.test(x.e));
  if (gitEntries.length && !isGo && !gitDest) {
    if (rel.gitS && !sS) add({ sev: 'error', check: 's-git', block: 'fetch', line: gitEntries[0].stmt.line, source: 'bitbake.conf S = "${WORKDIR}/${BP}"; fetch2/git.py destsuffix "git"',
      msg: `git sources unpack into \${WORKDIR}/git but S is left at \${WORKDIR}/\${BP}: "S does not exist" at configure.`,
      why: `On ${rel.name} a git recipe sets S = "\${WORKDIR}/git".`,
      fix: { label: 'Add S = "${WORKDIR}/git"', ops: [{ at: (srcrev || gitEntries[0].stmt).end + 1, del: 0, ins: ['S = "${WORKDIR}/git"'] }] } });
    if (rel.gitS && sS && !/\/git\/?$/.test(sS.value) && !/\/git\//.test(sS.value)) add({ sev: 'warn', check: 's-git', block: 'fetch', line: sS.line,
      source: 'fetch2/git.py default destsuffix "git"', msg: `S = "${sS.value}", but a git fetch unpacks into \${WORKDIR}/git.`,
      why: 'Unless a destsuffix= says otherwise, S for a git recipe is ${WORKDIR}/git (or a subdirectory of it).',
      fix: { label: 'S = "${WORKDIR}/git"', ops: [replaceLine(sS.line, sS.raw.replace(sS.value, '${WORKDIR}/git'))] } });
    if (!rel.gitS && sS && /\$\{WORKDIR\}\/git/.test(sS.value)) add({ sev: 'error', check: 's-git', block: 'fetch', line: sS.line,
      source: 'Yocto 5.2 migration notes (UNPACKDIR, BB_GIT_DEFAULT_DESTSUFFIX)',
      msg: 'S = "${WORKDIR}/git" is wrong from walnascar on: git unpacks into ${UNPACKDIR}/${BP}, which is the default S.',
      why: 'Delete the S line (or point it at a subdirectory of ${UNPACKDIR}/${BP}).', fix: { label: 'Remove the S line', ops: [{ at: sS.line, del: sS.end - sS.line + 1, ins: [] }] } });
  }
  if (tarEntries.length && !gitEntries.length && sS && /\$\{WORKDIR\}\/git/.test(sS.value)) add({ sev: 'error', check: 's-git', block: 'fetch', line: sS.line,
    source: 'bitbake.conf S', msg: 'S = "${WORKDIR}/git" in a tarball recipe: nothing unpacks there.', why: 'A release tarball unpacks to ${WORKDIR}/${BP} by default; drop the S line or name the directory the tarball has.',
    fix: { label: 'Remove the S line', ops: [{ at: sS.line, del: sS.end - sS.line + 1, ins: [] }] } });
  const usesUnpackdir = stmts.some((s) => /\$\{UNPACKDIR\}/.test(s.raw));
  if (rel.unpack === 'WORKDIR' && usesUnpackdir) add({ sev: 'error', check: 'unpackdir', block: 'fetch', line: stmts.find((s) => /\$\{UNPACKDIR\}/.test(s.raw)).line,
    source: 'bitbake.conf (no UNPACKDIR before styhead 5.1)', msg: `\${UNPACKDIR} does not exist on ${rel.name}: it stays unexpanded.`,
    why: 'UNPACKDIR arrived in styhead (5.1). On this release, local files are in ${WORKDIR}.' });
  if (rel.unpack === 'UNPACKDIR') {
    const st = stmts.find((s) => (s.kind === 'func' || s.kind === 'assign') && /\$\{WORKDIR\}\/[\w.-]+/.test(s.raw) && !(s.kind === 'assign' && s.var === 'S'));
    if (st) add({ sev: 'warn', check: 'unpackdir', block: blockOf(st), line: st.line, source: 'Yocto 5.1/5.2 migration notes (UNPACKDIR)',
      msg: 'Files from SRC_URI are unpacked into ${UNPACKDIR}, not ${WORKDIR}, from styhead on.', why: 'Replace ${WORKDIR}/<file> with ${UNPACKDIR}/<file>.' });
    if (sS && /^\$\{WORKDIR\}\/?$/.test(sS.value.trim())) add({ sev: 'error', check: 's-workdir', block: 'fetch', line: sS.line, source: 'Yocto 5.2 migration notes',
      msg: 'S = "${WORKDIR}" is refused from walnascar on.', why: 'For a recipe of local files use S = "${UNPACKDIR}".',
      fix: { label: 'S = "${UNPACKDIR}"', ops: [replaceLine(sS.line, sS.raw.replace(sS.value, '${UNPACKDIR}'))] } });
  }

  // ---- build ----
  const buildCls = classes.filter((c) => BUILD_CLASSES.includes(c));
  const families = new Set(buildCls.map((c) => c.replace(/-brokensep$/, '').replace(/^go-mod$/, 'go')));
  if (families.size > 1) add({ sev: 'error', check: 'two-build-systems', block: 'build', line: inherits[0].line, source: 'class do_configure/do_compile',
    msg: `Inherits ${buildCls.join(' and ')}: two build systems, the last one's tasks win.`, why: 'Keep the one the project uses.' });
  const doCompile = funcs.find((f) => /^do_compile$/.test(f.name));
  const doInstall = funcs.find((f) => /^do_install$/.test(f.name));
  if (!buildCls.length && !doCompile && !doInstall && fetches && !has('packagegroup') && !has('image') && !has('core-image')) add({ sev: 'warn', check: 'nothing-built', block: 'build', line: inherits[0] ? inherits[0].line : 1,
    source: 'base.bbclass base_do_compile (runs make if there is a Makefile)', msg: 'No build class and no do_compile/do_install: only a top-level Makefile would be run, and nothing is installed.',
    why: 'inherit the project\'s build system (cmake, meson, autotools, setuptools3, go-mod, cargo) or write do_compile and do_install.' });
  for (const [v, cls] of [['EXTRA_OECMAKE', 'cmake'], ['EXTRA_OECONF', 'autotools'], ['EXTRA_OEMESON', 'meson']]) {
    const a = allOf(v)[0];
    if (a && !classes.some((c) => c.startsWith(cls))) add({ sev: 'warn', check: 'unused-args', block: 'build', line: a.line, source: `${cls}.bbclass`,
      msg: `${v} is set but ${cls} is not inherited: the arguments are never used.`, why: `${v} is read only by ${cls}.bbclass.` });
  }
  const depPn = assigns.find((a) => /^DEPENDS[:_]\$\{PN\}/.test(a.var));
  if (depPn) add({ sev: 'error', check: 'pkgvarcheck', block: 'build', line: depPn.line, source: 'insane.bbclass pkgvarcheck',
    msg: 'DEPENDS:${PN} - "recipe uses DEPENDS:${PN}, should use DEPENDS".', why: 'DEPENDS is per recipe (build time); per-package run-time needs go in RDEPENDS:${PN}.',
    fix: { label: 'Use DEPENDS', ops: [replaceLine(depPn.line, depPn.raw.replace(/DEPENDS[:_]\$\{PN\}/, 'DEPENDS'))] } });
  for (const f of funcs.filter((f) => /^do_compile/.test(f.name))) {
    f.body.forEach((l, k) => {
      const n = f.bodyStart + k;
      const m = /^(\s*)(gcc|g\+\+|cc|c\+\+|[a-z0-9_]+-linux-[a-z0-9_]+-gcc|make)(\s|$)/.exec(l);
      if (m) {
        const repl = m[2] === 'make' ? 'oe_runmake' : /\+\+/.test(m[2]) ? '${CXX}' : '${CC}';
        add({ sev: 'error', check: 'host-toolchain', block: 'build', line: n, source: 'bitbake.conf CC / oe_runmake; insane.bbclass arch',
          msg: `do_compile runs "${m[2]}" directly: that is the build host's ${m[2] === 'make' ? 'make without the cross flags' : 'compiler, not the cross compiler'}.`,
          why: `Use ${repl}${m[2] === 'make' ? ' (passes EXTRA_OEMAKE and PARALLEL_MAKE)' : ', which carries the target flags and sysroot'}.`,
          fix: { label: `Use ${repl}`, ops: [replaceLine(n, l.replace(m[2], repl))] } });
      } else if (/\$\{CC\}/.test(l) && !/\$\{LDFLAGS\}/.test(l) && /\s-o\s/.test(l) && !/\s-c\s/.test(l)) {
        const cc = allOf('TARGET_CC_ARCH').some((a) => /LDFLAGS/.test(a.value));
        if (!cc) add({ sev: 'error', check: 'ldflags', block: 'build', line: n, source: 'insane.bbclass ldflags (ERROR_QA)',
          msg: 'Links with ${CC} but without ${LDFLAGS}: package QA fails with "doesn\'t have GNU_HASH (didn\'t pass LDFLAGS?)".',
          why: 'Add ${LDFLAGS} to the link line (or TARGET_CC_ARCH += "${LDFLAGS}").', fix: { label: 'Add ${LDFLAGS}', ops: [replaceLine(n, l.replace(/\s*$/, ' ${LDFLAGS}'))] } });
      }
    });
  }

  // ---- install ----
  const installFuncs = funcs.filter((f) => /^do_install/.test(f.name));
  const createdDirs = new Set();
  const installedPaths = [];
  const byClass = buildCls.length > 0;
  for (const f of installFuncs) {
    const appended = /append/.test(f.name);
    f.body.forEach((l, k) => {
      const n = f.bodyStart + k;
      const t = l.trim();
      if (!t || t.startsWith('#')) return;
      const words = t.split(/\s+/);
      const cmd = words[0];
      // paths outside ${D}
      if (/^(install|cp|mkdir|ln|mv|touch|chmod|chown|rm|sed)$/.test(cmd) || cmd === 'oe_runmake' || /^echo|^cat|^printf/.test(cmd)) {
        const args = words.slice(1).filter((w) => !w.startsWith('-') && !/^\d{3,4}$/.test(w));
        const target = /^(install|cp|mv|ln)$/.test(cmd) ? args.slice(-1) : /^(mkdir|touch|chmod|rm)$/.test(cmd) ? args : [];
        const redirect = (/>\s*(\S+)/.exec(t) || [])[1];
        for (const a of [...target, ...(redirect ? [redirect] : [])]) {
          const abs = /^\/(usr|etc|bin|sbin|lib|var|opt|srv|home)(\/|$)/.test(a) || /^\$\{(bindir|sbindir|libdir|sysconfdir|datadir|includedir|base_bindir|base_libdir|systemd_system_unitdir|systemd_unitdir|localstatedir|libexecdir)\}/.test(a);
          if (abs && !/^\$\{?D\}?/.test(a) && !/^\$\{(B|S|WORKDIR|UNPACKDIR)\}/.test(a)) {
            add({ sev: 'error', check: 'install-outside-d', block: 'install', line: n, source: 'the ${D} convention (bitbake.conf D = "${WORKDIR}/image")',
              msg: `do_install writes ${a} on the build machine, not into the package image \${D}.`,
              why: 'Everything do_install creates goes under ${D}; packaging reads only ${D}. Outside it the command fails (permission) or pollutes the host.',
              fix: { label: `Write \${D}${a}`, ops: [replaceLine(n, l.replace(a, '${D}' + a))] } });
          }
        }
      }
      // hard-coded paths under ${D}
      const hm = /\$\{?D\}?(\/(usr\/lib\/systemd\/system|lib\/systemd\/system|usr\/libexec|usr\/include|usr\/share\/doc|usr\/share\/man|usr\/share|usr\/sbin|usr\/bin|usr\/lib|etc|var|sbin|bin|lib))(?=\/|\s|$|"|')/.exec(l);
      if (hm) {
        const [p, v] = PATHS.find(([pp]) => pp === hm[1]);
        add({ sev: 'warn', check: 'hardcoded-path', block: 'install', line: n, source: 'bitbake.conf path variables',
          msg: `Hard-coded ${p}; write ${v}.`,
          why: `${v} follows the distro (usrmerge moves /bin and /lib, multilib changes libdir to lib64, nativesdk moves the prefix).`,
          fix: { label: `Use ${v}`, ops: [replaceLine(n, l.replace(hm[0], hm[0].replace(p, v)))] } });
      }
      // cp -r / -a carries the build user's ownership
      if (/^cp\s/.test(t) && /\s-(\w*[ra]\w*)\s/.test(` ${t} `) && !/--no-preserve=ownership/.test(t)) {
        add({ sev: 'warn', check: 'host-user-contaminated', block: 'install', line: n, source: 'insane.bbclass host-user-contaminated (WARN_QA)',
          msg: `"${t.split(/\s+/).slice(0, 2).join(' ')}" copies files owned by the build user into the image.`,
          why: 'Package QA reports them as "owned by uid ..., which is the same as the user running bitbake". Use install -m, or cp -R --no-preserve=ownership.',
          fix: { label: 'cp -R --no-preserve=ownership', ops: [replaceLine(n, l.replace(/cp\s+-\w+/, 'cp -R --no-preserve=ownership'))] } });
      }
      // directories and installed files
      if (cmd === 'cp' || cmd === 'mv') {
        const args = words.slice(1).filter((w) => !w.startsWith('-'));
        const dest = args[args.length - 1];
        if (args.length >= 2 && /^\$\{?D\}?/.test(dest)) installedPaths.push({ path: expandPath(dest, pn).replace(/\/$/, ''), line: n });
      }
      if (cmd === 'install' || cmd === 'mkdir') {
        const flags = words.filter((w) => w.startsWith('-')).join(' ');
        const args = words.slice(1).filter((w) => !w.startsWith('-') && !/^0?[0-7]{3,4}$/.test(w));
        if (cmd === 'mkdir' || /(^|\s)-\w*d\b/.test(flags) || /(^|\s)--directory\b/.test(flags)) {
          for (const a of args) if (/^\$\{?D\}?/.test(a)) createdDirs.add(expandPath(a, pn).replace(/\/$/, ''));
        } else if (args.length >= 2) {
          const dest = args[args.length - 1];
          if (/^\$\{?D\}?/.test(dest)) {
            const exp = expandPath(dest, pn);
            const lastPart = dest.split('/').pop();
            const destIsDir = dest.endsWith('/') || /^\$\{\w+\}$/.test(lastPart);
            const dir = destIsDir ? exp.replace(/\/$/, '') : exp.replace(/\/[^/]*$/, '');
            const file = destIsDir ? `${dir}/${args[args.length - 2].split('/').pop()}` : exp;
            installedPaths.push({ path: file, line: n });
            const dashD = /(^|\s)-\w*D\b/.test(flags);
            const known = [...createdDirs].some((d) => d === dir || d.startsWith(dir + '/'));
            if (!dashD && !known && !(appended && byClass && /^\/usr\/(bin|lib|include|share)$/.test(dir))) {
              const dirVar = destIsDir ? dest.replace(/\/$/, '') : dest.replace(/\/[^/]*$/, '');
              add({ sev: appended && byClass ? 'info' : 'error', check: 'install-no-dir', block: 'install', line: n, source: 'install(1): the target directory must exist',
                msg: `Installs into ${dirVar} without an "install -d ${dirVar}" before it.`,
                why: appended && byClass ? 'Fine only if the project\'s own install step already created it.' : 'install -m fails with "No such file or directory" when the directory is not there yet.',
                fix: { label: `Add install -d ${dirVar}`, ops: [{ at: n, del: 0, ins: [`${l.match(/^\s*/)[0]}install -d ${dirVar}`] }] } });
              createdDirs.add(dir);
            }
          }
        }
      }
    });
  }
  if (!installFuncs.length && !byClass && fetches) add({ sev: 'warn', check: 'no-install', block: 'install', line: 1, source: 'base.bbclass base_do_install (empty)',
    msg: 'No do_install and no build class that installs: the packages will be empty.', why: 'Write do_install with install -d / install -m into ${D}${bindir} etc.' });

  // ---- packaging ----
  for (const v of PKGVARCHECK) {
    const a = assigns.find((x) => x.var === v && !x.flag);
    if (a) add({ sev: 'error', check: 'pkgvarcheck', block: 'package', line: a.line, source: 'insane.bbclass pkgvarcheck (ERROR_QA)',
      msg: `${v} without a package name: "Variable ${v} is set as not being package specific".`, why: `${v} applies per package: ${v}:\${PN}.`,
      fix: { label: `Use ${v}:\${PN}`, ops: [replaceLine(a.line, a.raw.replace(new RegExp(`^(\\s*)${v}\\b`), `$1${v}:\${PN}`))] } });
  }
  const filesPn = assigns.filter((a) => /^FILES[:_]\$\{PN\}$/.test(a.var) && !a.flag);
  for (const a of filesPn) {
    if (a.op === '=') add({ sev: 'warn', check: 'files-overwrite', block: 'package', line: a.line, source: 'bitbake.conf FILES:${PN} default',
      msg: 'FILES:${PN} = replaces the default list (${bindir}/* ${sysconfdir} ${libdir}/lib*.so.* ...).', why: 'Add to it with += unless you really mean to drop the defaults.',
      fix: { label: 'Use +=', ops: [replaceLine(a.line, a.raw.replace(/\s=\s?/, ' += '))] } });
    if (/\$\{?D\}?\//.test(a.value)) add({ sev: 'error', check: 'expanded-d', block: 'package', line: a.line, source: 'insane.bbclass expanded-d (ERROR_QA)',
      msg: 'FILES contains ${D}: "FILES ... should not contain the ${D} variable".', why: 'FILES paths are target paths (${bindir}/foo), not build paths.',
      fix: { label: 'Remove ${D}', ops: [replaceLine(a.line, a.raw.replace(/\$\{?D\}?(?=\/)/g, ''))] } });
  }
  // hard-coded paths in FILES
  for (const a of allOf('FILES')) {
    const m = /(^|[\s"])(\/(usr\/lib\/systemd\/system|lib\/systemd\/system|usr\/share|usr\/sbin|usr\/bin|usr\/lib|etc)(?=[/\s"*]|$))/.exec(a.value);
    if (m && a.line === a.end) {
      const [p, v] = PATHS.find(([pp]) => pp === m[2]);
      add({ sev: 'warn', check: 'hardcoded-path', block: 'package', line: a.line, source: 'bitbake.conf path variables', msg: `FILES uses ${p}; write ${v}.`,
        why: `${v} follows the distro layout (usrmerge, multilib).`, fix: { label: `Use ${v}`, ops: [replaceLine(a.line, a.raw.replace(p, v))] } });
    }
  }
  const svcA = assigns.filter((a) => baseName(a.var) === 'SYSTEMD_SERVICE' && !a.flag);
  if (svcA.length && !has('systemd')) {
    const inh = inherits[0];
    add({ sev: 'error', check: 'systemd-not-inherited', block: 'package', line: svcA[0].line, source: 'systemd.bbclass',
      msg: 'SYSTEMD_SERVICE is set but systemd is not inherited: the unit is never enabled nor packaged by the systemd class.',
      why: 'Only systemd.bbclass reads SYSTEMD_SERVICE; add it to inherit.',
      fix: inh ? { label: 'inherit ... systemd', ops: [replaceLine(inh.line, inh.raw.replace(/\s*$/, ' systemd'))] }
        : { label: 'Add inherit systemd', ops: [{ at: afterBlock('build'), del: 0, ins: ['inherit systemd'] }] } });
  }
  if (has('systemd') && !svcA.length) add({ sev: 'warn', check: 'systemd-no-service', block: 'package', line: inherits.find((s) => s.classes.includes('systemd')).line,
    source: 'systemd.bbclass SYSTEMD_SERVICE:<pkg>', msg: 'inherit systemd without SYSTEMD_SERVICE:${PN}: no unit is enabled.',
    why: 'Name the unit(s): SYSTEMD_SERVICE:${PN} = "foo.service".' });
  const svcNames = svcA.flatMap((a) => a.value.split(/\s+/).filter(Boolean)).filter((s) => !/\$\{/.test(s));
  if (svcNames.length && has('systemd')) {
    const installed = installFuncs.map((f) => f.raw).join('\n');
    for (const s of svcNames) {
      if (!installed.includes(s)) add({ sev: byClass ? 'info' : 'error', check: 'systemd-unit-missing', block: 'package', line: svcA[0].line, source: 'systemd.bbclass "Didn\'t find service unit"',
        msg: `${s} is named in SYSTEMD_SERVICE but no do_install line installs it.`,
        why: byClass ? 'Fine if the project\'s own install step puts it in ${systemd_system_unitdir}; otherwise the build stops with "Didn\'t find service unit".'
          : 'The build stops with "Didn\'t find service unit". Install it into ${D}${systemd_system_unitdir}.' });
    }
  }
  // installed where no package takes it
  if (installedPaths.length) {
    const filesVals = allOf('FILES').map((a) => a.value).join(' ').split(/\s+/).filter(Boolean).map((p) => expandPath(p, pn).replace(/\*.*$/, '').replace(/\/$/, ''));
    const covered = ['/usr/bin', '/usr/sbin', '/usr/libexec', '/usr/lib', '/etc', '/com', '/var', '/bin', '/sbin', '/lib', `/usr/share/${pn}`,
      '/usr/share/pixmaps', '/usr/share/applications', '/usr/include', '/usr/share/doc', '/usr/share/man', '/usr/share/info', '/usr/share/locale',
      '/usr/share/pkgconfig', '/usr/share/cmake', '/usr/share/aclocal', ...filesVals];
    for (const ip of installedPaths) {
      if (ip.path.startsWith('/lib/systemd/system') && has('systemd')) continue;
      if (!covered.some((c) => c && (ip.path === c || ip.path.startsWith(c + '/')))) {
        add({ sev: 'error', check: 'installed-vs-shipped', block: 'package', line: ip.line, source: 'insane.bbclass installed-vs-shipped (ERROR_QA); bitbake.conf FILES:${PN}',
          msg: `${ip.path} is installed but no package's FILES takes it: "installed but not shipped in any package".`,
          why: 'Add its directory to FILES:${PN} += "..." (or install it under a path the defaults cover).',
          fix: { label: 'FILES:${PN} += that path', ops: [{ at: lastLine, del: 0, ins: [`FILES:\${PN} += "${ip.path.replace(/^\/usr\/share/, '${datadir}').replace(/^\/lib\/systemd\/system/, '${systemd_system_unitdir}')}"`] }] } });
      }
    }
  }

  // ---- syntax across the file ----
  for (const a of assigns) {
    const oldM = /_(append|prepend|remove)\b/.test(a.var) || new RegExp(`^(${PACKAGEVARS.join('|')})_\\$\\{PN\\}`).test(a.var);
    if (oldM) {
      const neu = convertOld(a.var);
      add({ sev: 'error', check: 'old-override-syntax', block: blockOf(a), line: a.line, source: 'bitbake data_smart.py (fatal since bitbake 1.52 / honister)',
        msg: `${a.var} is the old override syntax: bitbake stops with "contains an operation using the old override syntax".`,
        why: 'Since honister (3.4) overrides use a colon: VAR:append, VAR:${PN}. The Override Syntax Migrator tool converts whole files.',
        fix: { label: `Use ${neu}`, ops: [replaceLine(a.line, a.raw.replace(a.var, neu))] } });
    }
    const appendM = /:(append|prepend)(:|$)/.exec(a.var);
    if (appendM && ['+=', '=+', '.=', '=.', '?='].includes(a.op)) add({ sev: 'warn', check: 'append-operator', block: blockOf(a), line: a.line, source: 'bitbake parse/ast.py',
      msg: `${a.var} ${a.op} is "not a recommended operator combination".`, why: ':append already appends; with += it appends to the pending append. Use = with a leading space.',
      fix: { label: `${a.var} = " ..."`, ops: [replaceLine(a.line, a.raw.replace(a.op, '=').replace(/=\s*(["'])(?!\s)/, `= $1 `))] } });
    if (appendM && a.op === '=' && LIST_VARS.has(baseName(a.var)) && a.value.length && !/^\s/.test(a.value)) {
      const kind = appendM[1];
      add({ sev: 'warn', check: 'append-space', block: blockOf(a), line: a.line, source: 'bitbake manual: ":append" adds no space',
        msg: `${a.var} = "${a.value.slice(0, 24)}${a.value.length > 24 ? '…' : ''}" has no leading space: it is glued onto the last word of ${baseName(a.var)}.`,
        why: `:${kind} inserts the text exactly; for a list variable start it with a space ("${kind === 'append' ? ' ' + a.value.trim().slice(0, 16) : a.value.trim().slice(0, 16) + ' '}").`,
        fix: { label: kind === 'append' ? 'Add the leading space' : 'Add a trailing space',
          ops: [replaceLine(a.line, kind === 'append' ? a.raw.replace(/=\s*(["'])/, `= $1 `) : a.raw.replace(new RegExp(`${a.quote}\\s*$`), ` ${a.quote}`))] } });
    }
  }
  for (const f of funcs) {
    if (/_(append|prepend)$/.test(f.name) || /^do_\w+_(append|prepend)/.test(f.name)) {
      const neu = f.name.replace(/_(append|prepend)/, ':$1');
      add({ sev: 'error', check: 'old-override-syntax', block: blockOf(f), line: f.line, source: 'bitbake data_smart.py (fatal since bitbake 1.52)',
        msg: `${f.name}() is the old override syntax.`, why: 'Write it with a colon.', fix: { label: `${neu}()`, ops: [replaceLine(f.line, lines[f.line - 1].replace(f.name, neu))] } });
    }
  }
  F.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.line - b.line);
  return F;

  function blockOf(s) { return stmtBlock(s); }
}

/** RDEPENDS_${PN}_append -> RDEPENDS:${PN}:append (the common cases; convert-overrides.py does the rest). */
export function convertOld(v) {
  let s = v.replace(/_(append|prepend|remove)(?=$|_)/g, ':$1');
  s = s.replace(new RegExp(`^(${PACKAGEVARS.join('|')})_(\\$\\{PN\\}|\\$\\{PN\\}-[a-z0-9-]+)`), '$1:$2');
  s = s.replace(/:(append|prepend|remove)_/g, ':$1:');
  return s;
}

export function stmtBlock(s) {
  if (s.kind === 'assign') return blockOfVar(s.var);
  if (s.kind === 'func') return blockOfFunc(s.name);
  if (s.kind === 'inherit') return 'build';
  if (s.kind === 'include') return 'other';
  return 'other';
}

/** Apply fixes (line splices) to text; later lines first so earlier numbers hold. Overlapping ones are skipped. */
export function applyFixes(text, fixes) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const ops = fixes.flatMap((f) => (f && (f.ops || (f.fix && f.fix.ops))) || []).sort((a, b) => b.at - a.at || b.del - a.del);
  let floor = Infinity;
  let applied = 0;
  for (const op of ops) {
    if (op.at + op.del - 1 >= floor && op.del > 0) continue;
    lines.splice(op.at - 1, op.del, ...op.ins);
    floor = op.at;
    applied++;
  }
  return { text: lines.join('\n'), applied };
}

// ---------------------------------------------------------------- the anatomy

function short(s, n = 48) { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function anatomy(parsed, findings, opt) {
  const { stmts } = parsed;
  const assigns = stmts.filter((s) => s.kind === 'assign');
  const classes = stmts.filter((s) => s.kind === 'inherit').flatMap((s) => s.classes);
  const get = (name) => assigns.find((a) => a.var === name && !a.flag);
  const getBase = (base) => assigns.find((a) => baseName(a.var) === base);
  const srcVal = assigns.filter((a) => baseName(a.var) === 'SRC_URI' && !a.flag).map((a) => a.value).join(' ');
  const isGit = /(^|\s)(git|gitsm):\/\//.test(srcVal);
  const isTar = /(^|\s)(https?|ftp):\/\/\S+\.(tar\.\w+|tgz|zip|tar)/.test(srcVal);
  const buildCls = classes.filter((c) => BUILD_CLASSES.includes(c));
  const installF = stmts.find((s) => s.kind === 'func' && /^do_install/.test(s.name));
  const svc = getBase('SYSTEMD_SERVICE');
  const part = (name, stmt, required, value, autoText) => ({
    name, line: stmt ? stmt.line : 0, state: stmt ? 'set' : autoText ? 'auto' : required ? 'missing' : 'optional',
    value: stmt ? short(value ?? stmt.value ?? '') : (autoText || ''),
  });
  const sha = assigns.find((a) => baseName(a.var) === 'SRC_URI' && a.flag && /sum$/.test(a.flag));
  const srcrev = assigns.find((a) => /^SRCREV/.test(a.var));
  const sS = get('S');
  const inh = stmts.find((s) => s.kind === 'inherit');
  const parts = {
    header: [part('SUMMARY', get('SUMMARY') || get('DESCRIPTION'), true), part('HOMEPAGE', get('HOMEPAGE'), false),
      part('LICENSE', get('LICENSE'), true), part('LIC_FILES_CHKSUM', getBase('LIC_FILES_CHKSUM'), get('LICENSE')?.value !== 'CLOSED',
        getBase('LIC_FILES_CHKSUM')?.value.replace(/^file:\/\//, ''))],
    fetch: [part('SRC_URI', getBase('SRC_URI'), true, srcVal),
      ...(isGit ? [part('SRCREV', srcrev, true)] : []),
      ...(isTar ? [part('SRC_URI[sha256sum]', sha, true)] : []),
      part('S', sS, false, undefined, sS ? '' : 'default ${WORKDIR}/${BP}'),
      part('PV', get('PV'), false, undefined, opt.pv ? `from file name: ${opt.pv}` : '')],
    build: [part('inherit', inh, false, classes.join(' '), inh ? '' : 'base.bbclass only (runs make)'),
      part('DEPENDS', getBase('DEPENDS'), false),
      ...['EXTRA_OECMAKE', 'EXTRA_OECONF', 'EXTRA_OEMESON', 'EXTRA_OEMAKE'].filter((v) => getBase(v)).map((v) => part(v, getBase(v), false)),
      ...(stmts.find((s) => s.kind === 'func' && /^do_compile/.test(s.name)) ? [part('do_compile', stmts.find((s) => s.kind === 'func' && /^do_compile/.test(s.name)), false, '(shell)')] : [])],
    install: [part(installF ? `${installF.name}()` : 'do_install', installF, !buildCls.length, installF ? `${installF.body.filter((l) => l.trim()).length} lines` : undefined,
      !installF && buildCls.length ? `by ${buildCls[0]}.bbclass` : '')],
    package: [part('FILES', getBase('FILES'), false, undefined, 'defaults (bitbake.conf)'), part('RDEPENDS', getBase('RDEPENDS'), false),
      ...(svc || classes.includes('systemd') ? [part('SYSTEMD_SERVICE', svc, true)] : [])],
    other: [],
  };
  return BLOCKS.map((b) => {
    const st = stmts.filter((s) => s.kind !== 'comment' && stmtBlock(s) === b.id);
    const fs = findings.map((f, i) => ({ ...f, i })).filter((f) => f.block === b.id);
    const ps = parts[b.id];
    const missing = ps.filter((p) => p.state === 'missing').length;
    const worst = fs.reduce((w, f) => Math.min(w, SEV_ORDER[f.sev]), 9);
    const state = worst === 0 || missing ? 'bad' : worst === 1 ? 'warn' : st.length || ps.some((p) => p.state === 'auto') ? 'ok' : 'empty';
    return { id: b.id, title: b.title, what: b.what, state, parts: ps, lines: st.map((s) => [s.line, s.end]), findings: fs.map((f) => f.i) };
  }).filter((b) => b.id !== 'other' || b.lines.length || b.findings.length);
}

// ---------------------------------------------------------------- run

export const DEFAULT_LINT = `# gpio-monitor_1.0.bb - watches the door and relay GPIOs
DESCRIPTION = "GPIO monitor daemon for the ACME gateway"
LICENSE = "GPLv2"

SRC_URI = "git://github.com/acme-embedded/gpio-monitor.git \\
           file://gpio-monitor.service \\
           file://gpio-monitor.conf \\
          "
SRCREV = "\${AUTOREV}"

DEPENDS = "libgpiod"
RDEPENDS_\${PN} = "libgpiod-tools"

do_compile() {
    gcc -o gpio-monitor main.c gpio.c -lgpiod
}

do_install() {
    install -m 0755 gpio-monitor \${D}/usr/bin/gpio-monitor
    install -d \${D}\${systemd_system_unitdir}
    install -m 0644 \${WORKDIR}/gpio-monitor.service \${D}\${systemd_system_unitdir}
    install -m 0644 \${WORKDIR}/gpio-monitor.conf /etc/gpio-monitor.conf
    install -d \${D}/opt/gpio-monitor
    cp -r \${S}/scripts \${D}/opt/gpio-monitor/
}

SYSTEMD_SERVICE_\${PN} = "gpio-monitor.service"
CFLAGS:append = "-DUSE_LIBGPIOD_V2"
`;

export function run(input) {
  const mode = input.mode === 'lint' ? 'lint' : 'build';
  const release = RELEASES[input.release] ? input.release : 'scarthgap';
  const rel = RELEASES[release];
  const warnings = [];
  const notes = [];
  let text, pn, pv, fileName;
  if (mode === 'build') {
    text = generate({ ...input, release });
    pn = trimDollar(input.pn) || 'myapp';
    pv = trimDollar(input.pv) || '1.0';
    fileName = `${pn}_${/AUTOREV/.test(input.srcrev || 'AUTOREV') && input.source === 'git' ? 'git' : pv}.bb`;
  } else {
    text = String(input.bb ?? '');
    fileName = trimDollar(input.bbname) || 'recipe_1.0.bb';
    const m = /^([^_/]+?)(?:_([^/]+?))?\.(bb|bbappend|inc)$/.exec(fileName.split('/').pop());
    pn = m ? m[1] : fileName.replace(/\..*$/, '');
    pv = m && m[2] ? m[2] : '';
    if (!m) warnings.push(`File name "${fileName}" is not <name>_<version>.bb, so PN/PV were guessed; name it like myapp_1.2.bb.`);
  }
  const parsed = parseRecipe(text);
  if (!text.trim()) {
    return { values: [{ label: 'Recipe', value: 'empty' }], warnings: ['Nothing to lint: paste a .bb recipe (or switch to Build mode).'], notes: [],
      tables: [], texts: [], anatomy: { blocks: [], lines: [], findings: [], fixed: '' } };
  }
  const findings = lint(parsed, { release, pn, pv, mode });
  const blocks = anatomy(parsed, findings, { pv });
  const fixable = findings.filter((f) => f.fix && f.fix.ops);
  // The fixed recipe: apply every one-click fix, lint again (a fix that
  // touched a line another fix also wanted is picked up on the next pass).
  let fixed = { text, applied: 0 };
  for (let pass = 0, cur = findings; pass < 6; pass++) {
    const fx = cur.filter((f) => f.fix && f.fix.ops && f.fix.ops.length);
    if (!fx.length) break;
    const r = applyFixes(fixed.text, fx.map((f) => f.fix));
    if (!r.applied || r.text === fixed.text) break;
    fixed = { text: r.text, applied: fixed.applied + r.applied };
    cur = lint(parseRecipe(fixed.text), { release, pn, pv, mode });
  }
  const n = (s) => findings.filter((f) => f.sev === s).length;
  const classes = parsed.stmts.filter((s) => s.kind === 'inherit').flatMap((s) => s.classes);
  const cls = classes.filter((c) => BUILD_CLASSES.includes(c));

  for (const u of parsed.unread) warnings.push(`Could not read ${u}`);
  for (const f of findings.filter((x) => x.sev === 'error').slice(0, 6)) warnings.push(`Line ${f.line}: ${f.msg}`);
  notes.push(`Rules read from oe-core ${release === 'walnascar' ? 'scarthgap and the walnascar (5.2) migration notes' : rel.name}: bitbake.conf, insane.bbclass, systemd.bbclass, bitbake fetch2/git.py.`);
  if (release === 'walnascar') notes.push('The walnascar rules (UNPACKDIR, S for git) come from the 5.2 migration notes, not from a source tree checked here.');
  notes.push('A linter reads the text: checksums, whether files exist in the source and what the project\'s own install step does are only known when bitbake runs.');

  const texts = [];
  if (mode === 'build') texts.push({ title: fileName, body: text, lang: 'bitbake' });
  else if (fixed.applied) texts.push({ title: 'Fixed recipe', body: fixed.text, lang: 'bitbake' });

  return {
    values: [
      { label: 'Recipe', value: fileName },
      { label: 'Release rules', value: rel.name },
      { label: 'Build class', value: cls.join(' + ') || 'none' },
      { label: 'Errors', value: n('error'), tone: n('error') ? 'bad' : 'ok' },
      { label: 'Warnings', value: n('warn'), tone: n('warn') ? 'warn' : 'ok' },
      { label: 'One-click fixes', value: fixable.length },
    ],
    tables: [{
      title: 'Findings',
      columns: ['Line', 'Part', 'Severity', 'Check', 'Finding', 'Fix'],
      rows: findings.map((f) => [f.line, BLOCKS.find((b) => b.id === f.block).title, f.sev, f.check, f.msg, f.fix ? f.fix.label : '']),
    }],
    texts,
    warnings,
    notes,
    anatomy: {
      text, fileName, mode, lines: parsed.lines, blocks,
      findings: findings.map((f) => ({ sev: f.sev, check: f.check, block: f.block, line: f.line, msg: f.msg, why: f.why, source: f.source,
        fix: f.fix ? { label: f.fix.label, ops: f.fix.ops || [] } : null })),
      fixed: fixed.text, fixedCount: fixed.applied,
    },
  };
}
