// The rule table of the Build Error & QA Explainer: which lines of a BitBake
// log decide a failure, and what each one means and how it is fixed.
//
// Message texts are the ones BitBake and OE-Core print, read from the sources:
//   bitbake/lib/bb/fetch2/__init__.py   Checksum mismatch!, Fetcher failure...,
//                                       Network access disabled through BB_NO_NETWORK
//   bitbake/lib/bb/fetch2/git.py        Unable to find revision X in branch Y even from upstream
//   bitbake/lib/bb/taskdata.py          Nothing PROVIDES / RPROVIDES, "was skipped:"
//   bitbake/lib/bb/siggen.py            Taskhash mismatch, basehash value changed
//   meta/lib/oe/qa.py handle_error()    "QA Issue: <message> [<check>]" (ERROR or WARNING
//                                       per ERROR_QA / WARN_QA in insane.bbclass)
//   meta/classes-global/insane.bbclass  the QA message texts and their check names
//   meta/lib/oe/package.py              installed-vs-shipped, already-stripped
//   meta/classes-global/sstate.bbclass  "is trying to install files into a shared area"
// Explanations follow the Yocto Project Reference Manual, "QA Error and
// Warning Messages" (ref-manual/qa-checks) and the insane class section.
//
// Pure: no DOM. Each rule: {id, cat, re, take?(m, ctx) -> {key?, item?, span?}}.
// explain(f, O) returns {title, what, why, fix, doc, url}. O(var, pkg) writes
// an override in the syntax of the release in the log (FILES:${PN} or FILES_${PN}).

export const DOCS = 'https://docs.yoctoproject.org';
const QA_URL = (c) => `${DOCS}/ref-manual/qa-checks.html#qa-check-${c}`;
const INSANE_URL = `${DOCS}/ref-manual/classes.html#ref-classes-insane`;

export const CATS = {
  fetch: 'Fetch',
  deps: 'Missing dependency',
  host: 'Host contamination',
  qa: 'QA (insane.bbclass)',
  rootfs: 'Image / do_rootfs',
  sstate: 'sstate / signatures',
  resources: 'Memory / disk',
  config: 'Metadata / layer',
  compile: 'Compile error',
  other: 'Unclassified',
};

// ---------------- what provides what ----------------
// Header (as #included) -> the recipe to add to DEPENDS. OE-Core / meta-oe names.
export const HEADERS = [
  [/^openssl\//, 'openssl'], [/^zlib\.h$/, 'zlib'], [/^curl\//, 'curl'], [/^libusb-1\.0\/|^libusb\.h$/, 'libusb1'],
  [/^systemd\//, 'systemd'], [/^glib\.h$|^glib\/|^gio\//, 'glib-2.0'], [/^n?curses\.h$/, 'ncurses'],
  [/^readline\//, 'readline'], [/^expat\.h$/, 'expat'], [/^libxml\//, 'libxml2'], [/^jpeglib\.h$/, 'jpeg'],
  [/^png\.h$/, 'libpng'], [/^ffi\.h$/, 'libffi'], [/^uuid\/uuid\.h$|^blkid\/|^libmount\//, 'util-linux'],
  [/^sqlite3\.h$/, 'sqlite3'], [/^json-c\//, 'json-c'], [/^dbus\//, 'dbus'], [/^lzma\.h$/, 'xz'],
  [/^bzlib\.h$/, 'bzip2'], [/^zstd\.h$/, 'zstd'], [/^gnutls\//, 'gnutls'], [/^mbedtls\//, 'mbedtls'],
  [/^libudev\.h$/, 'udev'], [/^gpiod\.h$/, 'libgpiod'], [/^modbus\//, 'libmodbus'], [/^mosquitto\.h$/, 'mosquitto'],
  [/^yaml\.h$/, 'libyaml'], [/^pcap\.h$|^pcap\//, 'libpcap'], [/^security\/pam_/, 'libpam'],
  [/^sys\/capability\.h$/, 'libcap'], [/^attr\//, 'attr'], [/^selinux\//, 'libselinux'], [/^xf86drm\.h$|^drm\.h$/, 'libdrm'],
  [/^EGL\//, 'virtual/egl'], [/^GLES2\//, 'virtual/libgles2'], [/^wayland-/, 'wayland'], [/^Python\.h$/, 'python3'],
  [/^boost\//, 'boost'], [/^gtest\//, 'googletest'], [/^gmock\//, 'googletest'], [/^protobuf|^google\/protobuf\//, 'protobuf'],
  [/^libnl3?\/|^netlink\/genl/, 'libnl'], [/^alsa\/|^asoundlib\.h$/, 'alsa-lib'], [/^pulse\//, 'pulseaudio'],
  [/^gst\//, 'gstreamer1.0'], [/^libevdev\//, 'libevdev'], [/^libinput\.h$/, 'libinput'], [/^xkbcommon\//, 'libxkbcommon'],
  [/^pcre2?\.h$/, 'libpcre2'], [/^libssh2\.h$/, 'libssh2'], [/^libssh\//, 'libssh'], [/^mtd\//, 'mtd-utils'],
  [/^linux\/|^asm\//, 'linux-libc-headers'], [/^fmt\//, 'fmt'], [/^spdlog\//, 'spdlog'], [/^nlohmann\//, 'nlohmann-json'],
  [/^ev\.h$/, 'libev'], [/^event2?\//, 'libevent'], [/^uv\.h$/, 'libuv'], [/^archive\.h$/, 'libarchive'],
  [/^tss2\//, 'tpm2-tss'], [/^libfdt\.h$/, 'dtc'], [/^i2c\/smbus\.h$/, 'i2c-tools'], [/^bluetooth\//, 'bluez5'],
];
// pkg-config module / CMake package -> recipe.
export const PKGS = {
  openssl: 'openssl', libssl: 'openssl', libcrypto: 'openssl', OpenSSL: 'openssl', libcurl: 'curl', CURL: 'curl',
  'glib-2.0': 'glib-2.0', 'gio-2.0': 'glib-2.0', 'gobject-2.0': 'glib-2.0', libsystemd: 'systemd', systemd: 'systemd',
  'dbus-1': 'dbus', 'libusb-1.0': 'libusb1', zlib: 'zlib', ZLIB: 'zlib', 'libxml-2.0': 'libxml2', LibXml2: 'libxml2',
  'json-c': 'json-c', libudev: 'udev', sqlite3: 'sqlite3', SQLite3: 'sqlite3', 'gstreamer-1.0': 'gstreamer1.0',
  libgpiod: 'libgpiod', libdrm: 'libdrm', 'wayland-client': 'wayland', 'wayland-server': 'wayland', egl: 'virtual/egl',
  glesv2: 'virtual/libgles2', uuid: 'util-linux', blkid: 'util-linux', mount: 'util-linux', ncurses: 'ncurses',
  ncursesw: 'ncurses', libcap: 'libcap', libffi: 'libffi', expat: 'expat', EXPAT: 'expat', protobuf: 'protobuf', Protobuf: 'protobuf',
  libmodbus: 'libmodbus', 'libnl-3.0': 'libnl', 'libnl-genl-3.0': 'libnl', 'yaml-0.1': 'libyaml', libpcre2: 'libpcre2',
  'libpcre2-8': 'libpcre2', alsa: 'alsa-lib', libevdev: 'libevdev', libinput: 'libinput', xkbcommon: 'libxkbcommon',
  Boost: 'boost', GTest: 'googletest', fmt: 'fmt', spdlog: 'spdlog', nlohmann_json: 'nlohmann-json', libmosquitto: 'mosquitto',
  'tss2-esys': 'tpm2-tss', libarchive: 'libarchive', LibArchive: 'libarchive', bluez: 'bluez5', PNG: 'libpng', libpng: 'libpng', JPEG: 'jpeg',
  Threads: '', PkgConfig: '',
};
// -l<name> -> recipe.
export const LIBS = {
  ssl: 'openssl', crypto: 'openssl', z: 'zlib', 'usb-1.0': 'libusb1', curl: 'curl', systemd: 'systemd', dbus: 'dbus',
  'dbus-1': 'dbus', xml2: 'libxml2', 'json-c': 'json-c', udev: 'udev', sqlite3: 'sqlite3', gpiod: 'libgpiod', modbus: 'libmodbus',
  mosquitto: 'mosquitto', yaml: 'libyaml', pcap: 'libpcap', cap: 'libcap', ffi: 'libffi', expat: 'expat', ncurses: 'ncurses',
  ncursesw: 'ncurses', tinfo: 'ncurses', readline: 'readline', uuid: 'util-linux', blkid: 'util-linux', png: 'libpng',
  jpeg: 'jpeg', lzma: 'xz', bz2: 'bzip2', zstd: 'zstd', drm: 'libdrm', EGL: 'virtual/egl', GLESv2: 'virtual/libgles2',
  asound: 'alsa-lib', protobuf: 'protobuf', 'nl-3': 'libnl', 'nl-genl-3': 'libnl', archive: 'libarchive', gtest: 'googletest',
  'boost_system': 'boost', 'boost_filesystem': 'boost', 'boost_thread': 'boost', fmt: 'fmt', ev: 'libev', event: 'libevent',
};
// Build-time program -> what to add (a -native recipe to DEPENDS, or a class to inherit).
export const TOOLS = {
  'pkg-config': ['inherit', 'pkgconfig'], cmake: ['inherit', 'cmake'], autoreconf: ['inherit', 'autotools'],
  aclocal: ['inherit', 'autotools'], automake: ['inherit', 'autotools'], libtoolize: ['inherit', 'autotools'],
  meson: ['inherit', 'meson'], ninja: ['inherit', 'meson'], cargo: ['inherit', 'cargo'], rustc: ['inherit', 'cargo'],
  go: ['inherit', 'go'], python3: ['inherit', 'python3native'], python: ['inherit', 'python3native'],
  bison: ['DEPENDS', 'bison-native'], flex: ['DEPENDS', 'flex-native'], gperf: ['DEPENDS', 'gperf-native'],
  swig: ['DEPENDS', 'swig-native'], xxd: ['DEPENDS', 'vim-native'], protoc: ['DEPENDS', 'protobuf-native'],
  'glib-compile-resources': ['DEPENDS', 'glib-2.0-native'], 'glib-compile-schemas': ['DEPENDS', 'glib-2.0-native'],
  'glib-mkenums': ['DEPENDS', 'glib-2.0-native'], 'wayland-scanner': ['DEPENDS', 'wayland-native'],
  bc: ['DEPENDS', 'bc-native'], openssl: ['DEPENDS', 'openssl-native'], dtc: ['DEPENDS', 'dtc-native'],
  mkimage: ['DEPENDS', 'u-boot-tools-native'], lzop: ['DEPENDS', 'lzop-native'], lz4: ['DEPENDS', 'lz4-native'],
  xmlto: ['DEPENDS', 'xmlto-native'], xsltproc: ['DEPENDS', 'libxslt-native'], doxygen: ['DEPENDS', 'doxygen-native'],
  gettext: ['inherit', 'gettext'], msgfmt: ['inherit', 'gettext'], intltool: ['DEPENDS', 'intltool-native'],
  help2man: ['DEPENDS', 'help2man-native'], makeinfo: ['DEPENDS', 'texinfo-native'], perl: ['inherit', 'perlnative'],
  git: ['DEPENDS', 'git-native'], rsync: ['DEPENDS', 'rsync-native'], unzip: ['DEPENDS', 'unzip-native'],
  zip: ['DEPENDS', 'zip-native'], nasm: ['DEPENDS', 'nasm-native'], 'qmake': ['inherit', 'qt6-qmake (meta-qt6) or qmake5 (meta-qt5)'],
};
// file-rdeps: what a script's interpreter or a library needs at run time.
export const INTERP = {
  '/bin/bash': 'bash', '/usr/bin/bash': 'bash', '/usr/bin/perl': 'perl', '/usr/bin/python3': 'python3-core',
  '/usr/bin/env': 'coreutils', '/bin/ksh': 'mksh', '/usr/bin/tclsh': 'tcl', '/usr/bin/lua': 'lua',
  '/usr/bin/awk': 'gawk', '/usr/bin/gawk': 'gawk', '/usr/bin/expect': 'expect', '/usr/bin/node': 'nodejs',
  '/bin/zsh': 'zsh', '/usr/bin/ruby': 'ruby', '/bin/busybox': 'busybox',
};

// Which task a rule usually decides: shown in the card.
const q = (s) => s.replace(/'/g, "\\'");
const recipeOf = (f) => f.recipe || '<recipe>';
const pkgOf = (f, pkg) => (!pkg || pkg === f.recipe ? '${PN}' : pkg.startsWith(f.recipe + '-') ? '${PN}' + pkg.slice(f.recipe.length) : pkg);

// /usr/share/foo -> ${datadir}/foo: the variables a FILES line should use (bitbake.conf).
const DIRS = [
  ['/usr/lib/systemd/system', '${systemd_system_unitdir}'], ['/lib/systemd/system', '${systemd_system_unitdir}'],
  ['/usr/lib/systemd/user', '${systemd_user_unitdir}'], ['/lib/firmware', '${nonarch_base_libdir}/firmware'],
  ['/usr/lib/firmware', '${nonarch_base_libdir}/firmware'], ['/lib/udev/rules.d', '${nonarch_base_libdir}/udev/rules.d'],
  ['/usr/lib/udev/rules.d', '${nonarch_base_libdir}/udev/rules.d'], ['/usr/share/doc', '${docdir}'], ['/usr/share/man', '${mandir}'],
  ['/usr/share', '${datadir}'], ['/usr/libexec', '${libexecdir}'], ['/usr/lib64', '${libdir}'], ['/usr/lib', '${libdir}'],
  ['/usr/bin', '${bindir}'], ['/usr/sbin', '${sbindir}'], ['/usr/include', '${includedir}'], ['/etc', '${sysconfdir}'],
  ['/var/lib', '${localstatedir}/lib'], ['/var', '${localstatedir}'], ['/lib', '${base_libdir}'], ['/bin', '${base_bindir}'],
  ['/sbin', '${base_sbindir}'], ['/opt', '/opt'],
];
export function toVar(path) {
  for (const [p, v] of DIRS) if (path === p || path.startsWith(p + '/')) return v + path.slice(p.length);
  return path;
}
// The shortest set of paths that covers every unshipped path: a directory
// whose children are all listed stands for them.
function roots(paths) {
  const sorted = [...new Set(paths)].sort();
  const out = [];
  for (const p of sorted) if (!out.some((r) => p === r || p.startsWith(r + '/'))) out.push(p);
  return out;
}

// ---------------- the rules ----------------
// First matching rule wins for a line. `take` may read further lines through
// ctx.peek(k) (the k-th line after this one, prefix stripped) and return
// span: [k...] to mark them as part of the same finding.
export const RULES = [
  // ---- fetch ----
  { id: 'checksum-mismatch', cat: 'fetch', re: /Checksum mismatch!/,
    take(m, c) {
      const item = {}; const span = [];
      for (let k = 1; k <= 8; k++) {
        const t = c.peek(k); if (t == null || /^(ERROR|WARNING|NOTE):/.test(t)) break;
        const f = /^File: '([^']+)' has (\w+) checksum '([0-9a-f]+)' when '([0-9a-f]+)' was expected/.exec(t);
        if (f) { Object.assign(item, { file: f[1], algo: f[2], got: f[3], want: f[4] }); span.push(k); }
        const s = /^SRC_URI\[([\w.]+)\] = "([0-9a-f]+)"/.exec(t);
        if (s) { (item.lines ||= []).push(t.trim()); span.push(k); }
      }
      return { item, span };
    } },
  { id: 'missing-checksum', cat: 'fetch', re: /Missing (?:SRC_URI )?checksum(?: for '([^']+)')?|No checksum specified for '([^']+)'/,
    take(m, c) {
      const item = { file: m[1] || m[2] || '' }; const span = [];
      for (let k = 1; k <= 4; k++) { const t = c.peek(k); if (t && /^SRC_URI\[/.test(t)) { (item.lines ||= []).push(t.trim()); span.push(k); } }
      return { item, span };
    } },
  { id: 'srcrev-not-found', cat: 'fetch', re: /Unable to find revision (\w+)(?: in branch (\S+))? even from upstream/,
    take: (m) => ({ item: { rev: m[1], branch: m[2] || '' } }) },
  { id: 'git-no-branch', cat: 'fetch', re: /URL: (\S+) does not set any branch parameter|does not set any branch parameter/,
    take: (m) => ({ item: { url: m[1] || '' } }) },
  { id: 'no-network', cat: 'fetch', re: /Network access disabled through BB_NO_NETWORK/,
    take: (m, c) => ({ item: { url: (/for url (\S+?)\)?$/.exec(c.line) || [])[1] || '' } }) },
  { id: 'http-404', cat: 'fetch', re: /(ERROR 404: Not Found|The requested URL returned error: 404|HTTP request sent, awaiting response\.\.\. 404|404 Not Found)/, take: () => ({ item: {} }) },
  { id: 'network', cat: 'fetch', re: /(Could not resolve host|Temporary failure in name resolution|unable to resolve host address|Connection timed out|Connection refused|Network is unreachable|Failed to connect to|SSL certificate problem|server certificate verification failed|Unable to establish SSL connection|gnutls_handshake\(\) failed)/,
    take: (m) => ({ item: { why: m[1] } }) },
  { id: 'fetch-failed', cat: 'fetch', re: /Fetcher failure for URL: '([^']+)'\.?\s*(.*)|Unable to fetch URL from any source|Fetcher failure: (.*)/,
    take: (m) => ({ item: { url: m[1] || '', why: (m[2] || m[3] || '').slice(0, 160) } }) },

  // ---- QA (insane.bbclass); must come before the generic compile rules ----
  { id: 'qa', cat: 'qa', re: /QA Issue: (.*)/,
    take(m, c) {
      let msg = m[1]; const span = [];
      // oe.qa.handle_error prints "QA Issue: <msg> [<check>]"; the message may run over lines.
      for (let k = 1; !/\[[\w-]+\]\s*$/.test(msg) && k <= 60; k++) {
        const t = c.peek(k); if (t == null || /^(ERROR|WARNING|NOTE):/.test(t)) break;
        msg += '\n' + t; span.push(k);
      }
      const ck = /\[([\w-]+)\]\s*$/.exec(msg);
      const check = ck ? ck[1] : 'unknown';
      return { check, key: check, item: { msg: msg.replace(/\s*\[[\w-]+\]\s*$/, '') }, span };
    } },
  // Old releases (before the QA messages carried "QA Issue:") and the
  // host-path poisoning of the compiler.
  { id: 'host-include', cat: 'host', re: /(?:include location|library search path) "([^"]+)" is unsafe for cross-compilation|CROSS COMPILE Badness: (\S+) in (\w+)/,
    take: (m) => ({ item: { path: m[1] || m[2] || '' } }) },

  // ---- dependencies ----
  { id: 'missing-header', cat: 'deps', re: /fatal error: ([\w./+-]+\.(?:h|hpp|hh|hxx)|[\w./+-]+): No such file or directory/,
    take: (m) => ({ item: { header: m[1] } }) },
  { id: 'pkgconfig-missing', cat: 'deps', re: /No package '([\w.+-]+)' found|Package '([\w.+-]+)',? required by '[^']*', not found|Dependency "([\w.+-]+)" not found|Could NOT find (\w+)|Could not find a package configuration file provided by "([\w.+-]+)"|Package ([\w.+-]+) was not found in the pkg-config search path/,
    take: (m) => ({ item: { pkg: m[1] || m[2] || m[3] || m[4] || m[5] || m[6] } }) },
  { id: 'missing-lib', cat: 'deps', re: /cannot find -l([\w.+-]+)/, take: (m) => ({ item: { lib: m[1] } }) },
  { id: 'missing-tool', cat: 'deps', re: /(?:^|\s|\/bin\/sh: (?:\d+: )?)([\w.+-]+): (?:command )?not found\s*$|Program '([\w.+-]+)' not found|Program ([\w.+-]+) found: NO|Can't exec "([\w.+-]+)": No such file/,
    take: (m) => ({ item: { tool: m[1] || m[2] || m[3] || m[4] } }) },
  { id: 'py-module', cat: 'deps', re: /ModuleNotFoundError: No module named '([\w.]+)'/, take: (m) => ({ item: { mod: m[1] } }) },
  { id: 'nothing-provides', cat: 'config', re: /Nothing (R?)PROVIDES '([^']+)'(?: \(but ([^)]*)\))?/,
    take(m, c) {
      const item = { r: m[1] === 'R', what: m[2], by: m[3] || '', close: '', skipped: [] }; const span = [];
      let listing = /Close matches:\s*$/.test(c.line);
      for (let k = 1; k <= 10; k++) {
        const t = c.peek(k); if (t == null || /^(ERROR|WARNING|NOTE|Summary):/.test(t)) break;
        const cm = /Close matches:\s*(.*)/.exec(t);
        if (cm) { item.close = cm[1]; span.push(k); continue; }
        const sk = /(\S+) (?:R?PROVIDES \S+ but )?was skipped: (.*)/.exec(t);
        if (sk) { item.skipped.push(`${sk[1]}: ${sk[2]}`); span.push(k); continue; }
        if (/^\s+\S/.test(t) && (listing || /Close matches:\s*$/.test(c.peek(k - 1) || ''))) { span.push(k); item.close += t.trim() + ' '; continue; }
        listing = false;
      }
      const req = /(\S+\.bb)\b/.exec(item.by);
      const recipe = req ? req[1].split('/').pop().replace(/\.bb$/, '').replace(/_[^_]*$/, '') : '';
      return { key: item.what, item, span, recipe };
    } },
  { id: 'skipped', cat: 'config', re: /(?:^|ERROR: )(\S+?) was skipped: (.*)/, take: (m) => ({ key: m[1], item: { what: m[1], why: m[2] } }) },

  // ---- image ----
  { id: 'rootfs-conflict', cat: 'rootfs', re: /file (\S+) conflicts between attempted installs of (\S+) and (\S+)|check_data_file_clashes: Package (\S+) wants to install file (\S+)|trying to overwrite '([^']+)', which is also in package (\S+)/,
    take(m, c) {
      const item = { file: m[1] || m[5] || m[6], a: m[2] || m[4] || '', b: m[3] || m[7] || '' };
      const span = [];
      if (m[4]) for (let k = 1; k <= 3; k++) { const t = c.peek(k); const b = t && /already provided by package \*?\s*(\S+)/.exec(t); if (b) { item.b = b[1]; span.push(k); break; } if (t && /But that file/.test(t)) span.push(k); }
      return { key: 'conflict', item, span };
    } },
  { id: 'rootfs-unresolved', cat: 'rootfs', re: /nothing provides ([^\s]+(?: [<>=]+ \S+)?) needed by (\S+)|Unable to install package|cannot find package (\S+)|Couldn't find anything to satisfy '([^']+)'|unsatisfiable dependencies|The following packages have unmet dependencies/,
    take: (m) => ({ key: 'unresolved', item: { what: m[1] || m[3] || m[4] || '', by: m[2] || '' } }) },
  { id: 'rootfs-pm', cat: 'rootfs', re: /Could not invoke (dnf|rpm|opkg|apt-get)\. Command/, take: (m) => ({ key: 'pm', item: { pm: m[1] } }) },
  { id: 'image-too-big', cat: 'rootfs', re: /The (?:rootfs|image) size \S+ ?\(K\) exceeds IMAGE_ROOTFS_MAXSIZE: (\d+)|exceeds IMAGE_ROOTFS_MAXSIZE/,
    take: (m) => ({ item: { max: m[1] || '' } }) },

  // ---- sstate / signatures ----
  { id: 'shared-area', cat: 'sstate', re: /is trying to install files into a shared area when those files already exist/,
    take(m, c) {
      const item = { files: [] }; const span = [];
      for (let k = 1; k <= 16; k++) { const t = c.peek(k); if (t == null || /^(ERROR|WARNING|NOTE):/.test(t)) break; span.push(k); if (/^\s+\//.test(t)) item.files.push(t.trim()); }
      return { item, span };
    } },
  { id: 'taskhash', cat: 'sstate', re: /Taskhash mismatch (\w+) versus (\w+) for (\S+)|the basehash value changed from (\w+) to (\w+)/,
    take: (m) => ({ item: { tid: m[3] || '' } }) },
  { id: 'layer-compat', cat: 'config', re: /Layer (\S+) is not compatible with the core layer which only supports these series: ([\w ]+) \(layer is compatible with ([\w ]+)\)/,
    take: (m) => ({ key: m[1], item: { layer: m[1], core: m[2].trim(), has: m[3].trim() } }) },
  { id: 'old-override', cat: 'config', re: /contains an operation using the old override syntax/, take: () => ({ key: 'syntax', item: {} }) },
  { id: 'parse-error', cat: 'config', re: /ParseError at ([^:]+):(\d+): (.*)|ExpansionError during parsing (\S+)|Failure expanding variable (\S+)/,
    take: (m) => ({ key: m[1] || m[4] || m[5] || 'parse', item: { file: m[1] || '', line: m[2] || '', why: (m[3] || m[5] || '').slice(0, 160) } }) },
  { id: 'license-flags', cat: 'config', re: /has a restricted license '([^']+)' which is not listed in your LICENSE_FLAGS_ACCEPTED|because it has a restricted license '([^']+)'/,
    take: (m) => ({ key: m[1] || m[2], item: { flag: m[1] || m[2] } }) },
  { id: 'incompatible-license', cat: 'config', re: /(?:has an incompatible license|was skipped: it has incompatible license\(s\)): ?(.*)/, take: (m) => ({ item: { lic: m[1] || '' } }) },
  { id: 'pseudo', cat: 'sstate', re: /pseudo: path mismatch|pseudo abort|Pseudo log:|path mismatch \[\d+ links?\]/, take: () => ({ item: {} }) },

  // ---- resources ----
  { id: 'oom', cat: 'resources', re: /(Killed signal terminated program (\S+)|virtual memory exhausted|out of memory allocating|internal compiler error: Killed|terminated with signal 9|g\+\+: fatal error: Killed|cc1plus: out of memory|Cannot allocate memory|JavaScript heap out of memory|ld(?:\.\w+)?: final link failed: memory exhausted)/,
    take: (m, c) => ({ item: { prog: (/terminated program (\S+)|(cc1plus|cc1|ld|node): out of memory/.exec(c.line) || [])[1] || '' } }) },
  { id: 'disk', cat: 'resources', re: /No space left on device|disk space monitor action is "STOPTASKS"|The free space of .* is running low|ABORT: Immediately shutdown/, take: () => ({ key: 'disk', item: {} }) },

  // ---- compile ----
  { id: 'multiple-definition', cat: 'compile', re: /multiple definition of [`'‘]([^'’`]+)['’]/, take: (m) => ({ item: { sym: m[1] } }) },
  { id: 'implicit-decl', cat: 'compile', re: /error: implicit declaration of function [`'‘]([^'’`]+)['’]/, take: (m) => ({ item: { sym: m[1] } }) },
  { id: 'werror', cat: 'compile', re: /error: .*\[-Werror=([\w-]+(?:=\w+)?)\]/, take: (m) => ({ item: { flag: m[1] } }) },
  { id: 'undefined-ref', cat: 'compile', re: /undefined reference to [`'‘]([^'’`]+)['’]/, take: (m) => ({ item: { sym: m[1] } }) },
  { id: 'compile-error', cat: 'compile', re: /^\S+\.(?:c|cc|cpp|cxx|h|hpp|rs|go):\d+(?::\d+)?: (?:fatal )?error: (.*)|^error(?:\[E\d+\])?: (.*)|^CMake Error at (\S+)|^configure: error: (.*)|^meson\.build:\d+:\d+: ERROR: (.*)/,
    take: (m) => ({ item: { msg: (m[1] || m[2] || m[3] || m[4] || m[5] || '').slice(0, 200) } }) },
];

// Lines that follow from a failure but do not say why: shown as context of
// the finding in the same recipe and task, never a finding of their own.
export const CONSEQUENCE = /Logfile of failure stored in|Task \(.*\) failed with exit code|Fatal QA errors were found|ExecutionError\(|oe_runmake failed|Bitbake Fetcher Error|exit code \d+ from a shell command|^Summary: |Log data follows|Execution of '.*' failed with exit code|Function failed:|Command .* failed with exit code|^make(?:\[\d+\])?: \*\*\* |compilation terminated\.|collect2: error: ld returned|ninja: build stopped|Failed to fetch URL .* attempting MIRRORS|ERROR: Build of .* failed|Error executing a python function|meson setup failed|cmake failed|configure failed|autoreconf execution failed|has no buildable providers|is unbuildable, removing|Missing or unbuildable dependency chain/;

// ---------------- the explanations ----------------
const block = (...ls) => ls.filter((l) => l != null && l !== false).join('\n');
const skip = (O, f, check) => `# last resort, only if the check is wrong for this package:\n${O('INSANE_SKIP', '${PN}')} += "${check}"`;

const QA = {
  'installed-vs-shipped': (f, O) => {
    const files = f.items.flatMap((i) => (i.msg.match(/^\s+\/\S+/gm) || []).map((s) => s.trim()));
    const top = roots(files);
    const dev = top.filter((p) => /\/include\/|\.a$|\/pkgconfig\/|\/cmake\//.test(p));
    const docs = top.filter((p) => /\/share\/(doc|man|info)\b/.test(p));
    const unit = top.find((p) => /systemd\/system\/[^/]+\.service$/.test(p));
    const rest = top.filter((p) => !dev.includes(p) && !docs.includes(p) && p !== unit);
    return {
      title: `${files.length || 'Some'} installed file${files.length === 1 ? '' : 's'} not in any package`,
      what: `do_install put ${files.length ? `${files.length} path${files.length === 1 ? '' : 's'}` : 'files'} into \${D} that no FILES:<pkg> pattern picks up, so no package would ship them.`,
      why: 'FILES of the default packages (${PN}, -dev, -dbg, -doc, -staticdev, -locale) cover the standard directories; a file under a private path (/usr/share/<name>, /opt, a unit dir without inherit systemd) matches none of them.',
      fix: block(`# ${recipeOf(f)} recipe (the .bb, or a ${recipeOf(f)}_%.bbappend in your layer)`,
        rest.length ? `${O('FILES', '${PN}')} += "${rest.map(toVar).join(' \\\n    ')}"` : null,
        dev.length ? `${O('FILES', '${PN}-dev')} += "${dev.map(toVar).join(' ')}"` : null,
        docs.length ? `${O('FILES', '${PN}-doc')} += "${docs.map(toVar).join(' ')}"` : null,
        unit ? `# the unit file: the systemd class packages and enables it\ninherit systemd\n${O('SYSTEMD_SERVICE', '${PN}')} = "${unit.split('/').pop()}"` : null,
        '', '# or, if they are not wanted on the target, delete them after install:',
        `do_install:append() {\n${top.slice(0, 4).map((p) => `    rm -rf \${D}${toVar(p)}`).join('\n')}\n}`.replace('do_install:append', O('do_install', 'append'))),
      qa: true,
    };
  },
  ldflags: (f, O) => ({
    title: 'Binary linked without the build\'s LDFLAGS',
    what: `${f.items.length === 1 ? 'An ELF file has' : `${f.items.length} ELF files have`} no GNU_HASH section: the link step did not use \${LDFLAGS} (which carries --hash-style=gnu and the security flags).`,
    why: 'A hand-written Makefile that calls $(CC) -o without $(LDFLAGS), or overrides LDFLAGS itself. The same binary misses -Wl,-O1, --as-needed and -z relro/now.',
    fix: block(`# ${recipeOf(f)} recipe: hand the flags to make (plain Makefiles)`,
      'EXTRA_OEMAKE += "LDFLAGS=\'${LDFLAGS}\'"',
      '# or when the Makefile ignores LDFLAGS but uses CC:',
      'TARGET_CC_ARCH += "${LDFLAGS}"', '# best: patch the Makefile link rule to use $(LDFLAGS) and send it upstream', '', skip(O, f, 'ldflags')),
    qa: true,
  }),
  'already-stripped': (f, O) => ({
    title: 'Binary already stripped by the build',
    what: 'The package step found an ELF file with no symbols before it split out the debug info.',
    why: 'The upstream build strips (install -s, -s in LDFLAGS, a strip call in the Makefile), so no -dbg package can be made and crashes cannot be symbolised.',
    fix: block(`# ${recipeOf(f)} recipe: keep the build from stripping`,
      'EXTRA_OEMAKE += "STRIP=true INSTALL_STRIP="', '# or remove -s from install/LDFLAGS with a patch or in do_install', '', skip(O, f, 'already-stripped')),
    qa: true,
  }),
  'dev-so': (f, O) => ({
    title: 'Unversioned .so symlink in a runtime package',
    what: 'A lib*.so development symlink landed in a non -dev package.',
    why: 'The .so link is for the linker at build time and belongs in -dev; a runtime package pulling it in usually means FILES:${PN} includes ${libdir}/*.so, or the library is a dlopen()ed plugin that has no version.',
    fix: block(`# normal library: remove the broad pattern from FILES:\${PN}`.replace('FILES:${PN}', O('FILES', '${PN}')),
      `# a dlopen() plugin with no soname version: ship the .so in \${PN}`,
      'FILES_SOLIBSDEV = ""', `${O('FILES', '${PN}')} += "\${libdir}/*.so"`, `${O('INSANE_SKIP', '${PN}')} += "dev-so"`),
    qa: true,
  }),
  'dev-elf': (f, O) => ({
    title: 'Real library (not a symlink) in the -dev package',
    what: 'The -dev package contains a .so that is a real ELF file rather than a symlink.',
    why: 'The library was installed without a version (libfoo.so only), so the default -dev pattern ${libdir}/*.so picked the library itself.',
    fix: block('# give the library a soname version upstream, or ship it in ${PN}:', 'FILES_SOLIBSDEV = ""', `${O('FILES', '${PN}')} += "\${libdir}/lib*.so"`, `${O('INSANE_SKIP', '${PN}')} += "dev-so"`),
    qa: true,
  }),
  'file-rdeps': (f, O) => {
    const needs = f.items.map((i) => /(\S+) contained in package (\S+) requires (\S+), but no providers found in RDEPENDS[:_](\S+?)\??$/m.exec(i.msg)).filter(Boolean);
    const byPkg = {};
    for (const n of needs) {
      const prov = INTERP[n[3]] || (/^lib([\w+-]+)\.so/.test(n[3]) ? `<package with ${n[3]}>` : `<package providing ${n[3]}>`);
      (byPkg[n[2]] ||= new Set()).add(prov);
    }
    const lines = Object.entries(byPkg).map(([p, s]) => `${O('RDEPENDS', pkgOf(f, p))} += "${[...s].join(' ')}"`);
    return {
      title: 'A file needs something no runtime dependency provides',
      what: needs.length ? needs.map((n) => `${n[1]} (in ${n[2]}) needs ${n[3]}`).join('; ') + '.' : 'A packaged file needs an interpreter or library that is not in its RDEPENDS.',
      why: 'The package step reads each script\'s #! line and each ELF\'s NEEDED entries; nothing in RDEPENDS of that package provides one of them, so the file would fail on the target.',
      fix: block(`# ${recipeOf(f)} recipe`, ...(lines.length ? lines : [`${O('RDEPENDS', '${PN}')} += "bash"`]),
        '# or change the #! to /bin/sh if the script is POSIX sh', '# find a provider: oe-pkgdata-util find-path <file>'),
      qa: true,
    };
  },
  textrel: (f, O) => ({
    title: 'Relocations in .text (code not built position-independent)',
    what: 'A shared object or PIE has text relocations: some objects were compiled without -fPIC.',
    why: 'Usually CFLAGS replaced instead of extended, or hand-written assembly that is not PIC. The loader must write to the code pages, which breaks with hardened (W^X) kernels and wastes memory.',
    fix: block('# keep the build\'s flags and add PIC if the build drops them', 'CFLAGS += "-fPIC"', '# assembly: fix the code or disable the asm path (e.g. --disable-asm)', '', skip(O, f, 'textrel')),
    qa: true,
  }),
  buildpaths: (f, O) => ({
    title: 'Build host paths left in a packaged file',
    what: 'A packaged file contains the TMPDIR path of this build.',
    why: 'The path leaks the build machine into the image and breaks reproducible builds: a config header with the compiler path, a script with an absolute #!, a .pc/.cmake file with the sysroot, or debug info without prefix mapping.',
    fix: block('do_install:append() {'.replace('do_install:append', O('do_install', 'append')),
      '    # strip the build paths from the text file named in the message', '    sed -i -e \'s#${RECIPE_SYSROOT}##g\' -e \'s#${WORKDIR}##g\' ${D}<path/of/file>', '}',
      '# debug info: make sure the build does not override DEBUG_PREFIX_MAP / -ffile-prefix-map', '', skip(O, f, 'buildpaths')),
    qa: true,
  }),
  'license-checksum': (f, O) => {
    const md5 = f.items.map((i) => /new md5 checksum is (\w+)|The md5 checksum is (\w+)/.exec(i.msg)).find(Boolean);
    const url = f.items.map((i) => /for (file:\/\/\S+)/.exec(i.msg)).find(Boolean);
    const sum = md5 ? md5[1] || md5[2] : '<md5>';
    const file = url ? url[1].replace(/;.*$/, '') : 'file://LICENSE';
    return {
      title: 'LIC_FILES_CHKSUM does not match the license file',
      what: `The license text in the source changed (or is not listed): ${file} now has md5 ${sum}.`,
      why: 'A version bump brought a new LICENSE/COPYING (a year, a clause, a new license). The build stops so a person reads what changed before shipping it.',
      fix: block('# read the diff of the license file first; update LICENSE if the license itself changed', `LIC_FILES_CHKSUM = "${file};md5=${sum}"`),
      qa: true,
    };
  },
  arch: (f, O) => ({
    title: 'Binary built for another architecture',
    what: (f.items[0]?.msg || '').split('\n')[0],
    why: 'The binary was built with the host compiler (gcc instead of ${CC}) or is a prebuilt blob for another CPU. On a firmware blob for a co-processor this is expected.',
    fix: block('# built from source: make the build use the cross compiler', 'EXTRA_OEMAKE += "CC=\'${CC}\' CXX=\'${CXX}\' LD=\'${LD}\'"',
      '# a firmware blob for another CPU (M4 core, Wi-Fi chip): install it under ${nonarch_base_libdir}/firmware and', `${O('INSANE_SKIP', '${PN}')} += "arch"`),
    qa: true,
  }),
  'host-user-contaminated': (f, O) => ({
    title: 'Files owned by the build user',
    what: 'Installed files keep the uid/gid of the user running bitbake.',
    why: 'cp -a, tar x or install without owner options copied the ownership from the build tree; on the target they would belong to a random uid.',
    fix: block('do_install:append() {'.replace('do_install:append', O('do_install', 'append')), '    chown -R root:root ${D}${datadir}/<dir>', '}',
      '# or copy without ownership: cp -R --no-preserve=ownership, tar --no-same-owner, install -o root -g root'),
    qa: true,
  }),
  pkgconfig: (f, O) => ({
    title: '.pc file points into the build tree', what: 'A pkg-config file contains the TMPDIR path.',
    why: 'The upstream build wrote absolute sysroot paths into prefix/libdir; other recipes would link against this build\'s tree.',
    fix: block('do_install:append() {'.replace('do_install:append', O('do_install', 'append')), '    sed -i -e \'s#${STAGING_DIR_HOST}##g\' ${D}${libdir}/pkgconfig/*.pc', '}'), qa: true,
  }),
  la: (f, O) => ({
    title: 'libtool .la file points into WORKDIR', what: 'A libtool archive references this recipe\'s WORKDIR.', why: 'libtool recorded build-tree paths.',
    fix: block('do_install:append() {'.replace('do_install:append', O('do_install', 'append')), '    rm -f ${D}${libdir}/*.la', '}'), qa: true,
  }),
  staticdev: (f, O) => ({
    title: 'Static library in a runtime package', what: 'A .a archive is in a package other than -staticdev.', why: 'A broad FILES pattern, or an install into a private dir.',
    fix: block(`${O('FILES', '${PN}-staticdev')} += "\${libdir}/<dir>/*.a"`, '# or do not build it: DISABLE_STATIC / EXTRA_OECONF += "--disable-static"'), qa: true,
  }),
  rpaths: (f, O) => ({
    title: 'Bad RPATH into the build tree', what: 'An ELF file carries an RPATH pointing into the build directory.', why: 'The build (often CMake or libtool) set an RPATH for running from the build tree.',
    fix: block('EXTRA_OECMAKE += "-DCMAKE_SKIP_RPATH=ON"', '# or remove it after install:', 'DEPENDS += "chrpath-native"', 'do_install:append() {'.replace('do_install:append', O('do_install', 'append')), '    chrpath -d ${D}${bindir}/<binary>', '}'), qa: true,
  }),
  'useless-rpaths': (f, O) => ({
    title: 'Redundant RPATH', what: 'An RPATH names a default library directory.', why: 'Harmless at run time but a sign of a build that hard-codes paths.',
    fix: block('DEPENDS += "chrpath-native"', 'do_install:append() {'.replace('do_install:append', O('do_install', 'append')), '    chrpath -d ${D}${bindir}/<binary>', '}'), qa: true,
  }),
  'dev-deps': (f, O) => ({
    title: 'Runtime package depends on a -dev package', what: (f.items[0]?.msg || '').split('\n')[0], why: 'An RDEPENDS names X-dev; the image would pull headers and .so links onto the target.',
    fix: block('# name the runtime package instead of the -dev one', `${O(O('RDEPENDS', '${PN}'), 'remove')} = "<name>-dev"`, `${O('RDEPENDS', '${PN}')} += "<name>"`), qa: true,
  }),
  'debug-deps': (f, O) => ({
    title: 'Package depends on a -dbg package', what: (f.items[0]?.msg || '').split('\n')[0], why: 'An RDEPENDS names X-dbg.', fix: '# remove the -dbg package from RDEPENDS; use IMAGE_FEATURES += "dbg-pkgs" for debug images', qa: true,
  }),
  'build-deps': (f, O) => {
    const m = /(\S+) rdepends on (\S+), but it isn't a build dependency/.exec(f.items[0]?.msg || '');
    return { title: 'Runtime dependency that is not a build dependency', what: m ? `${m[1]} needs ${m[2]} at run time but ${recipeOf(f)} does not DEPEND on the recipe that builds it.` : 'A runtime dependency is not in DEPENDS.',
      why: 'Shared-library detection found a NEEDED library whose provider is not in DEPENDS: the build picked it up from the sysroot by luck (task ordering).',
      fix: `DEPENDS += "${m ? m[2].replace(/-(dev|dbg)$/, '').replace(/^lib(\w+?)\d+$/, 'lib$1') : '<recipe>'}"   # the recipe that builds ${m ? m[2] : 'it'}`, qa: true };
  },
  libdir: (f, O) => ({ title: 'Library in the wrong directory', what: 'A library is installed outside ${libdir}/${base_libdir}.', why: 'A hard-coded /usr/lib or lib64 in the build.', fix: 'EXTRA_OECONF += "--libdir=${libdir}"   # autotools\nEXTRA_OECMAKE += "-DCMAKE_INSTALL_LIBDIR=${baselib}"   # cmake', qa: true }),
  'debug-files': (f, O) => ({ title: '.debug directory in a non -dbg package', what: 'A runtime package contains a .debug directory.', why: 'A broad FILES pattern like ${libdir}/<dir>/* also matches .debug.', fix: `${O('FILES', '${PN}-dbg')} += "\${libdir}/<dir>/.debug"`, qa: true }),
  'patch-fuzz': (f, O) => ({ title: 'Patch applies with fuzz', what: 'A patch in SRC_URI only applied by fuzzing its context lines.', why: 'The source moved under the patch (a version bump); a fuzzy patch can land in the wrong place.',
    fix: `devtool modify ${recipeOf(f)}\ndevtool finish --force-patch-refresh ${recipeOf(f)} <layer_path>\n# review the refreshed patch before committing`, qa: true }),
  'patch-status': (f, O) => ({ title: 'Patch lacks a valid Upstream-Status', what: 'A patch has no or a misspelt Upstream-Status line.', why: 'OE-Core layers require every patch to say where it stands upstream.',
    fix: '# in the patch header, one of:\nUpstream-Status: Pending\nUpstream-Status: Submitted [https://github.com/org/proj/pull/123]\nUpstream-Status: Backport [https://github.com/org/proj/commit/<sha>]\nUpstream-Status: Inappropriate [oe specific]', qa: true }),
  'src-uri-bad': (f, O) => ({ title: 'SRC_URI uses ${PN}', what: 'SRC_URI contains ${PN} rather than ${BPN}.', why: '${PN} changes for -native/nativesdk/multilib variants, so the URL breaks for them.', fix: 'SRC_URI = "https://example.org/${BPN}/${BPN}-${PV}.tar.gz"', qa: true }),
  'unknown-configure-option': (f, O) => ({ title: 'configure was passed options it does not know', what: (f.items[0]?.msg || '').split('\n')[0], why: 'The option was renamed or dropped upstream (a version bump), so it silently does nothing.',
    fix: '# remove or rename the option in EXTRA_OECONF / PACKAGECONFIG[...]\nEXTRA_OECONF:remove = "--enable-old-option"'.replace('EXTRA_OECONF:remove', O('EXTRA_OECONF', 'remove')), qa: true }),
  'compile-host-path': (f, O) => ({ title: 'Compile used host include or library paths', what: 'The compile log shows -I/usr/include or -L/usr/lib.', why: 'The build found headers on the build host instead of the target sysroot: binaries may be wrong or not link on the target.', fix: '# find the -I/usr/include in log.do_compile and remove it from the Makefile/CFLAGS (patch)', qa: true }),
  'install-host-path': (f, O) => ({ title: 'Install used host paths', what: 'The install log shows host include or library paths.', why: 'The install step relinks against the host.', fix: '# see log.do_install; make install must not relink against /usr/lib', qa: true }),
  'configure-unsafe': (f, O) => ({ title: 'configure looked at host paths', what: 'The autoconf log shows host include or library paths.', why: 'configure checks ran against the build host.', fix: '# pass --with-sysroot / fix the configure.ac path checks; rerun: bitbake -c cleansstate ' + recipeOf(f), qa: true }),
  '32bit-time': (f, O) => ({ title: '32-bit time_t API use (Y2038)', what: 'A 32-bit binary uses time functions without 64-bit time.', why: 'Built without -D_TIME_BITS=64 or with its own time_t handling.', fix: 'CFLAGS += "-D_TIME_BITS=64 -D_FILE_OFFSET_BITS=64"', qa: true }),
  usrmerge: (f, O) => ({ title: 'Files in /bin, /sbin or /lib with usrmerge', what: 'DISTRO_FEATURES has usrmerge but the recipe installs into the root directories.', why: 'Hard-coded /bin or /lib paths.', fix: '# use ${base_bindir}, ${base_libdir} etc. in do_install instead of /bin, /lib', qa: true }),
  'empty-dirs': (f, O) => ({ title: 'Files in a directory that must stay empty', what: (f.items[0]?.msg || '').split('\n')[0], why: '/var/run, /tmp and similar are tmpfs or volatile on the target; files installed there vanish.', fix: '# create them at boot instead: a tmpfiles.d entry or a volatiles file', qa: true }),
  'infodir': (f, O) => ({ title: 'info/dir shipped', what: '/usr/share/info/dir is in a package.', why: 'The index is generated on the target.', fix: 'do_install:append() {\n    rm -f ${D}${infodir}/dir\n}'.replace('do_install:append', O('do_install', 'append')), qa: true }),
  'missing-update-alternatives': (f, O) => ({ title: 'ALTERNATIVE without the class', what: 'ALTERNATIVE is set but update-alternatives is not inherited.', why: 'The alternatives would silently not be created; do_rootfs may fail on file clashes.', fix: 'inherit update-alternatives', qa: true }),
  libexec: (f, O) => ({ title: 'Files in /usr/libexec with a libexecdir elsewhere', what: (f.items[0]?.msg || '').split('\n')[0], why: 'The build hard-codes /usr/libexec while the distro sets libexecdir to another path.', fix: 'EXTRA_OECONF += "--libexecdir=${libexecdir}"   # autotools\nEXTRA_OECMAKE += "-DCMAKE_INSTALL_LIBEXECDIR=${libexecdir}"   # cmake', qa: true }),
  'shebang-size': (f, O) => ({ title: '#! line longer than 128 bytes', what: 'A script\'s interpreter line is too long for the kernel.', why: 'Usually a native sysroot path.', fix: '# use #!/usr/bin/env <interp> or fix the path in do_install', qa: true }),
};

export function explain(f, O) {
  const it = f.items[0] || {};
  const r = recipeOf(f);
  const one = (x) => x;
  switch (f.rule) {
    case 'qa': {
      const make = QA[f.check];
      const doc = `QA Error and Warning Messages: ${f.check}`;
      if (make) return { ...make(f, O), doc, url: /^(host-user-contaminated|license-checksum|32bit-time|usrmerge)$/.test(f.check) ? INSANE_URL : QA_URL(f.check) };
      return { title: `QA check "${f.check}"`, what: it.msg?.split('\n')[0] || '', why: 'See the check in the insane class documentation.',
        fix: `# fix what the message names; only if the check is wrong for this recipe:\n${O('INSANE_SKIP', '${PN}')} += "${f.check}"`, doc, url: QA_URL(f.check) };
    }
    case 'checksum-mismatch': return {
      title: 'Downloaded file has a different checksum',
      what: it.file ? `${it.file.split('/').pop()}: ${it.algo} is ${it.got.slice(0, 12)}…, the recipe expects ${it.want.slice(0, 12)}….` : 'The downloaded file does not match SRC_URI[sha256sum].',
      why: 'Either the version was bumped without new checksums, upstream re-rolled the tarball under the same name (GitHub archive links do this), or the download is broken (a proxy or login HTML page saved as the tarball).',
      fix: block('# 1. check what was downloaded (a small file may be an HTML error page)', it.file ? `file ${it.file}` : 'file ${DL_DIR}/<tarball>',
        '# 2. if the new file is right, update the recipe:', ...(it.lines || (it.got ? [`SRC_URI[${it.algo}sum] = "${it.got}"`] : ['SRC_URI[sha256sum] = "<new sum>"'])),
        '# 3. if it is broken, delete it and fetch again:', `rm ${it.file || '${DL_DIR}/<tarball>'}*; bitbake -c cleanall ${r}; bitbake ${r}`),
      doc: 'BitBake manual: Fetching / checksums (SRC_URI[sha256sum])', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-fetching.html`,
    };
    case 'missing-checksum': return {
      title: 'SRC_URI entry has no checksum', what: `No sha256sum for ${it.file ? it.file.split('/').pop() : 'a remote file'}.`,
      why: 'Remote (non-git) SRC_URI files need a checksum so a changed or tampered download is caught; with BB_STRICT_CHECKSUM = "1" this stops the build.',
      fix: block(...(it.lines || ['SRC_URI[sha256sum] = "<sum printed by bitbake>"'])), doc: 'BitBake manual: Fetching', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-fetching.html`,
    };
    case 'srcrev-not-found': return {
      title: 'SRCREV is not on the branch the recipe names',
      what: `Commit ${it.rev.slice(0, 12)} is not reachable from branch ${it.branch || '(default)'} of the git repository.`,
      why: 'The commit was on another branch, the branch was renamed (master to main), or upstream force-pushed and the commit is gone.',
      fix: block(`git ls-remote <repo-url> | head   # which branches exist`, `git branch -r --contains ${it.rev.slice(0, 12)}   # in a clone: which branch has it`,
        `SRC_URI = "git://<host>/<repo>.git;protocol=https;branch=<branch that has it>"`, `SRCREV = "${it.rev}"`, '# a commit on no branch: ;nobranch=1'),
      doc: 'BitBake manual: Git fetcher (branch, nobranch)', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-fetching.html#git-fetcher-git`,
    };
    case 'git-no-branch': return { title: 'git SRC_URI without branch=', what: `${it.url || 'A git URL'} has no branch parameter.`, why: 'Newer BitBake requires the branch so SRCREV can be checked against it.',
      fix: 'SRC_URI = "git://<host>/<repo>.git;protocol=https;branch=main"', doc: 'BitBake manual: Git fetcher', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-fetching.html#git-fetcher-git` };
    case 'no-network': return { title: 'Fetch needed but the network is off', what: `BB_NO_NETWORK (or BB_FETCH_PREMIRRORONLY) is set and ${it.url || 'a URL'} is not in DL_DIR or a mirror.`,
      why: 'An offline build met a source not yet downloaded: a new recipe, a changed SRCREV or a version bump.',
      fix: block('# fetch once with the network on:', `bitbake ${r} -c fetch`, '# or add the file to your PREMIRRORS / own-mirrors source', 'SOURCE_MIRROR_URL = "file:///srv/yocto-mirror/"', 'INHERIT += "own-mirrors"'),
      doc: 'BitBake variables: BB_NO_NETWORK', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-ref-variables.html#term-BB_NO_NETWORK` };
    case 'http-404': return { title: 'Source URL gives 404', what: 'The server has no file at the SRC_URI address.', why: 'Upstream moved or deleted the release (old versions often move to an /archive/ path).',
      fix: block('# point SRC_URI at the new location, or add a mirror:', 'MIRRORS:append = " https://old.example.org/.* https://archive.example.org/ "'.replace('MIRRORS:append', O('MIRRORS', 'append')), `bitbake ${r} -c fetch`),
      doc: 'Reference manual: MIRRORS / PREMIRRORS', url: `${DOCS}/ref-manual/variables.html#term-MIRRORS` };
    case 'network': return { title: 'Network failure while fetching', what: it.why, why: 'DNS, proxy, firewall or TLS inspection between the build host and the server.',
      fix: block('# in the shell that runs bitbake (and in local.conf for git):', 'export https_proxy=http://proxy:3128', 'BB_ENV_PASSTHROUGH_ADDITIONS += "https_proxy http_proxy no_proxy"', '# TLS inspection: add the proxy CA to the host trust store', `bitbake ${r} -c fetch`),
      doc: 'Yocto FAQ: working behind a proxy', url: `${DOCS}/ref-manual/faq.html` };
    case 'fetch-failed': return { title: 'Fetch failed', what: it.url ? `${it.url}${it.why ? ': ' + it.why : ''}` : 'No source (upstream, PREMIRRORS, MIRRORS) gave the file.', why: 'See the decisive lines above it in log.do_fetch (network, 404, auth, wrong branch).',
      fix: block(`bitbake ${r} -c fetch -f -v   # verbose, to see each mirror tried`, `less \${WORKDIR}/temp/log.do_fetch`), doc: 'BitBake manual: Fetching', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-fetching.html` };
    case 'missing-header': {
      const hs = [...new Set(f.items.map((i) => i.header))];
      const provs = [...new Set(hs.map((h) => (HEADERS.find(([re]) => re.test(h)) || [])[1]).filter(Boolean))];
      const kernel = hs.some((h) => /^(linux|asm)\//.test(h));
      return { title: `Header not found: ${hs.join(', ')}`,
        what: `The compiler could not find ${hs.join(', ')} in the recipe sysroot.`,
        why: kernel ? 'linux/ and asm/ headers come from linux-libc-headers, which may be older than the kernel that has the header; for a new kernel UAPI header, depend on the kernel (virtual/kernel) or carry a copy.'
          : 'Each recipe builds against its own sysroot that holds only what DEPENDS lists; the header\'s recipe is not in DEPENDS (it may be on the host, which is why it built there).',
        fix: block(`# ${r} recipe`, provs.length && !kernel ? `DEPENDS += "${provs.join(' ')}"` : null,
          kernel ? '# a header of your kernel:\nDEPENDS += "virtual/kernel"\ndo_configure[depends] += "virtual/kernel:do_shared_workdir"' : null,
          !provs.length ? `DEPENDS += "<recipe that installs ${hs[0]}>"` : null, `# find the provider: oe-pkgdata-util find-path '*/${hs[0]}'`),
        doc: 'Reference manual: DEPENDS', url: `${DOCS}/ref-manual/variables.html#term-DEPENDS` };
    }
    case 'pkgconfig-missing': {
      const ps = [...new Set(f.items.map((i) => i.pkg))];
      const provs = [...new Set(ps.map((p) => PKGS[p] ?? PKGS[p.toLowerCase()]).filter(Boolean))];
      const nopc = ps.every((p) => p === 'PkgConfig');
      return { title: nopc ? 'pkg-config itself not found' : `Build dependency not found: ${ps.join(', ')}`,
        what: nopc ? 'CMake could not find pkg-config.' : `The configure step (pkg-config, CMake find_package or meson dependency()) did not find ${ps.join(', ')} in the recipe sysroot.`,
        why: 'The library\'s recipe is not in DEPENDS, or pkgconfig is not inherited so pkg-config looks nowhere.',
        fix: block(`# ${r} recipe`, 'inherit pkgconfig', provs.length ? `DEPENDS += "${provs.join(' ')}"` : `DEPENDS += "<recipe that provides ${ps[0]}>"`,
          '# optional features: PACKAGECONFIG[feature] = "--enable-x,--disable-x,<build dep>"'),
        doc: 'Reference manual: DEPENDS, pkgconfig class', url: `${DOCS}/ref-manual/classes.html#ref-classes-pkgconfig` };
    }
    case 'missing-lib': {
      const ls = [...new Set(f.items.map((i) => i.lib))];
      const provs = [...new Set(ls.map((l) => LIBS[l]).filter(Boolean))];
      return { title: `Linker cannot find -l${ls.join(', -l')}`, what: `lib${ls[0]}.so is not in the recipe sysroot.`, why: 'The library\'s recipe is not in DEPENDS.',
        fix: block(`# ${r} recipe`, provs.length ? `DEPENDS += "${provs.join(' ')}"` : `DEPENDS += "<recipe that builds lib${ls[0]}>"`, `# find it: oe-pkgdata-util find-path '*/lib${ls[0]}.so*'`),
        doc: 'Reference manual: DEPENDS', url: `${DOCS}/ref-manual/variables.html#term-DEPENDS` };
    }
    case 'missing-tool': {
      const ts = [...new Set(f.items.map((i) => i.tool))];
      const fx = ts.map((t) => TOOLS[t]).filter(Boolean);
      const inh = [...new Set(fx.filter(([k]) => k === 'inherit').map(([, v]) => v))];
      const dep = [...new Set(fx.filter(([k]) => k === 'DEPENDS').map(([, v]) => v))];
      return { title: `Build tool not found: ${ts.join(', ')}`, what: `The build ran ${ts.join(', ')}, which is not in the native sysroot or HOSTTOOLS.`,
        why: 'BitBake only exposes the host programs in HOSTTOOLS; everything else must come from a -native recipe in DEPENDS or a class.',
        fix: block(`# ${r} recipe`, inh.length ? `inherit ${inh.join(' ')}` : null, dep.length ? `DEPENDS += "${dep.join(' ')}"` : null,
          !fx.length ? `DEPENDS += "${ts[0]}-native"   # if a recipe of that name exists` : null),
        doc: 'Reference manual: HOSTTOOLS, DEPENDS', url: `${DOCS}/ref-manual/variables.html#term-HOSTTOOLS` };
    }
    case 'py-module': return { title: `Python module missing: ${it.mod}`, what: `import ${it.mod} failed.`, why: 'At build time python3-native has only what DEPENDS brings; on the target only what RDEPENDS brings.',
      fix: block(`# at build time:\nDEPENDS += "python3-${it.mod.split('.')[0].toLowerCase()}-native"`, `# at run time:\n${O('RDEPENDS', '${PN}')} += "python3-${it.mod.split('.')[0].toLowerCase()}"`), doc: 'Reference manual: python3native class', url: `${DOCS}/ref-manual/classes.html#ref-classes-python3native` };
    case 'nothing-provides': return {
      title: `Nothing ${it.r ? 'RPROVIDES' : 'PROVIDES'} ${it.what}`,
      what: `No recipe in the enabled layers ${it.r ? 'produces a package' : 'is'} named ${it.what}${it.by ? ` (${it.by})` : ''}.`,
      why: it.skipped.length ? `A recipe exists but was skipped: ${it.skipped.join('; ')}.` : 'The layer with that recipe is not in bblayers.conf, the name is misspelt, or it is a package name used where a recipe name belongs (DEPENDS takes recipes, RDEPENDS/IMAGE_INSTALL take packages).',
      fix: block(it.close ? `# close matches: ${it.close.trim()}` : null, `bitbake-layers show-recipes '*${it.what.replace(/^virtual\//, '').replace(/-native$/, '')}*'`,
        `bitbake-layers layerindex-show-depends ${it.what}   # which layer has it`, 'bitbake-layers add-layer ../meta-<layer>',
        it.skipped.some((s) => /COMPATIBLE_MACHINE|incompatible with machine/.test(s)) ? `COMPATIBLE_MACHINE:<machine> = "<machine>"   # in a bbappend, only if it really works on this machine` : null,
        it.skipped.some((s) => /LICENSE_FLAGS|restricted license/.test(s)) ? 'LICENSE_FLAGS_ACCEPTED += "commercial"   # local.conf, after checking the license' : null),
      doc: 'Reference manual: DEPENDS / RDEPENDS, bitbake-layers', url: `${DOCS}/dev-manual/layers.html` };
    case 'skipped': return { title: `${it.what} was skipped`, what: it.why, why: 'The recipe exists but a condition removes it for this configuration (machine, distro feature, license).',
      fix: /DISTRO_FEATURES/.test(it.why) ? `DISTRO_FEATURES:append = " ${(/'([\w-]+)'/.exec(it.why) || [])[1] || '<feature>'}"   # local.conf / distro .conf`.replace('DISTRO_FEATURES:append', O('DISTRO_FEATURES', 'append'))
        : /restricted license/.test(it.why) ? 'LICENSE_FLAGS_ACCEPTED += "commercial"   # local.conf'
          : /machine/.test(it.why) ? `# a bbappend, only if it really works on this machine\nCOMPATIBLE_MACHINE:<machine> = "<machine>"` : `bitbake -e ${it.what} | grep -e ^COMPATIBLE -e ^LICENSE`,
      doc: 'Reference manual: COMPATIBLE_MACHINE, LICENSE_FLAGS', url: `${DOCS}/ref-manual/variables.html#term-COMPATIBLE_MACHINE` };
    case 'rootfs-conflict': return { title: `Two packages ship ${it.file}`, what: `${it.a || 'One package'} and ${it.b || 'another'} both install ${it.file}.`,
      why: 'Two recipes install the same path (a config file both write, a tool both build, busybox vs coreutils applets). The package manager refuses to overwrite.',
      fix: block('# pick one: remove it from the recipe that should not own it', `do_install:append() {\n    rm \${D}${toVar(it.file || '/etc/<file>')}\n}`.replace('do_install:append', O('do_install', 'append')),
        '# or, if both are real alternatives:', 'inherit update-alternatives', `ALTERNATIVE:\${PN} = "${(it.file || '').split('/').pop()}"`.replace('ALTERNATIVE:${PN}', O('ALTERNATIVE', '${PN}')),
        '# or keep only one of the two packages in IMAGE_INSTALL'),
      doc: 'Reference manual: update-alternatives class', url: `${DOCS}/ref-manual/classes.html#ref-classes-update-alternatives` };
    case 'rootfs-unresolved': return { title: `Image needs ${it.what || 'a package'} that was not built`, what: it.by ? `${it.by} needs ${it.what}.` : 'The package manager could not satisfy a dependency.',
      why: 'An RDEPENDS or IMAGE_INSTALL entry names a package no recipe produced: a -dev/-ptest name, a package removed by PACKAGE_EXCLUDE or BAD_RECOMMENDATIONS, a shlib from a recipe that was skipped.',
      fix: block(`oe-pkgdata-util lookup-recipe ${it.what.split(' ')[0] || '<pkg>'}`, `oe-pkgdata-util find-path '*/${(it.what.split(' ')[0] || '').replace(/\(.*$/, '')}'`, '# then add the providing package to IMAGE_INSTALL or fix the RDEPENDS name'),
      doc: 'Reference manual: IMAGE_INSTALL, PACKAGE_EXCLUDE', url: `${DOCS}/ref-manual/variables.html#term-IMAGE_INSTALL` };
    case 'rootfs-pm': return { title: `Package manager (${it.pm}) failed in do_rootfs`, what: 'The package manager call failed; the reason is in the lines after it.', why: 'Usually an unresolved dependency or a file conflict (see the other findings of this task).',
      fix: block(`less tmp/work/<machine>/<image>/<ver>/temp/log.do_rootfs`, '# search the log for "nothing provides", "conflicts" or "Collected errors"'), doc: 'Reference manual: do_rootfs', url: `${DOCS}/ref-manual/tasks.html#do-rootfs` };
    case 'image-too-big': return { title: 'Root filesystem exceeds IMAGE_ROOTFS_MAXSIZE', what: `The image is larger than IMAGE_ROOTFS_MAXSIZE${it.max ? ` (${it.max} KiB)` : ''}.`, why: 'Packages were added or grew; the limit protects the partition size.',
      fix: block('# see what grew: buildhistory (INHERIT += "buildhistory") and buildhistory-diff', 'IMAGE_ROOTFS_MAXSIZE = "<KiB that fits the partition>"'), doc: 'Reference manual: IMAGE_ROOTFS_MAXSIZE', url: `${DOCS}/ref-manual/variables.html#term-IMAGE_ROOTFS_MAXSIZE` };
    case 'shared-area': return { title: 'Two recipes install the same file into a shared area', what: `${r} would overwrite ${it.files.length ? it.files.length + ' file(s)' : 'files'} another recipe already put in the sysroot or deploy directory.`,
      why: 'Two recipes provide the same file (two providers of one library, a renamed recipe with stale output, a deploy file both write).',
      fix: block(it.files.length ? `# files: ${it.files.slice(0, 3).join(', ')}` : null, '# keep one provider: PREFERRED_PROVIDER_virtual/<x> = "<recipe>" or drop the other from DEPENDS', '# stale output of a renamed or removed recipe:', 'bitbake -c cleansstate <old-recipe>'),
      doc: 'Reference manual: sstate', url: `${DOCS}/overview-manual/concepts.html#shared-state-cache` };
    case 'taskhash': return { title: 'Metadata is not deterministic (task hash changed)', what: it.tid ? `The signature of ${it.tid} changed between two parses.` : 'A task signature changed while BitBake was running.',
      why: 'A variable reads something that changes each parse: the date/time, a random value, a file outside the metadata, the output of a shell command.',
      fix: block(`bitbake-diffsigs -t ${r} <task>   # which variable differs`, '# exclude it from the signature:', 'do_compile[vardepsexclude] += "DATETIME"', '# or make the value fixed (SOURCE_DATE_EPOCH)'),
      doc: 'Dev manual: viewing task variable dependencies', url: `${DOCS}/dev-manual/debugging.html#viewing-task-variable-dependencies` };
    case 'pseudo': return { title: 'pseudo path mismatch', what: 'The fakeroot database (pseudo) disagrees with the files on disk.', why: 'Files in ${D} or the image were changed outside a pseudo task (by hand, by another tool, or by moving TMPDIR).',
      fix: block(`bitbake -c clean ${r}`, `bitbake ${r}`, '# never edit ${D} or the rootfs from outside bitbake tasks'), doc: 'Reference manual: pseudo / fakeroot', url: `${DOCS}/ref-manual/faq.html` };
    case 'layer-compat': return { title: `Layer ${it.layer} does not declare ${it.core}`, what: `${it.layer} is compatible with ${it.has}; the core is ${it.core}.`, why: 'LAYERSERIES_COMPAT lists the releases the layer was tested with; the layer may use syntax or variables of an older release.',
      fix: block('# use the layer branch made for this release, or (after testing) in its conf/layer.conf:', `LAYERSERIES_COMPAT_${it.layer.replace(/^meta-/, '')} = "${it.has} ${it.core}"`), doc: 'Reference manual: LAYERSERIES_COMPAT', url: `${DOCS}/ref-manual/variables.html#term-LAYERSERIES_COMPAT` };
    case 'old-override': return { title: 'Old override syntax (_append, RDEPENDS_${PN})', what: 'A layer still uses the pre-honister override syntax.', why: 'Since Yocto 3.4 overrides are written with ":" (RDEPENDS:${PN}, :append); BitBake refuses the old form.',
      fix: 'scripts/contrib/convert-overrides.py ../meta-<your-layer>   # from poky, then review the diff', doc: 'Migration guide 3.4: override syntax', url: `${DOCS}/migration-guides/migration-3.4.html#override-syntax-changes` };
    case 'parse-error': return { title: 'Recipe or config does not parse', what: it.file ? `${it.file}:${it.line}: ${it.why}` : it.why || 'A variable could not be expanded.', why: 'A syntax error (missing quote, stray character, python in ${@...} raising) in the named file.',
      fix: block(it.file ? `sed -n '${Math.max(1, Number(it.line) - 2)},${Number(it.line) + 2}p' ${it.file}` : null, 'bitbake -e <recipe> | less   # shows the expansion that fails'), doc: 'BitBake manual: syntax', url: `${DOCS}/bitbake/bitbake-user-manual/bitbake-user-manual-metadata.html` };
    case 'license-flags': return { title: `Restricted license flag "${it.flag}"`, what: `A recipe has LICENSE_FLAGS = "${it.flag}" and it is not accepted.`, why: 'Recipes with commercial or patent-encumbered code are off until you accept them.',
      fix: `LICENSE_FLAGS_ACCEPTED += "${it.flag}"   # local.conf, after checking the terms`, doc: 'Reference manual: LICENSE_FLAGS_ACCEPTED', url: `${DOCS}/ref-manual/variables.html#term-LICENSE_FLAGS_ACCEPTED` };
    case 'incompatible-license': return { title: 'Incompatible license', what: it.lic, why: 'INCOMPATIBLE_LICENSE (e.g. GPL-3.0*) excludes the recipe.', fix: '# replace the package, or for one image:\nINCOMPATIBLE_LICENSE_EXCEPTIONS:pn-<image> = "<pkg>:<license>"', doc: 'Reference manual: INCOMPATIBLE_LICENSE', url: `${DOCS}/ref-manual/variables.html#term-INCOMPATIBLE_LICENSE` };
    case 'host-include': return { title: 'Host include/library path in the cross build', what: `The compiler was given ${it.path || 'a host path'}.`, why: 'A Makefile or configure hard-codes -I/usr/include or -L/usr/lib; the cross compiler refuses host headers.',
      fix: '# remove the -I/usr/include / -L/usr/lib from the build (patch), headers come from ${STAGING_INCDIR}', doc: 'QA Error and Warning Messages: compile-host-path', url: QA_URL('compile-host-path') };
    case 'oom': return { title: 'Compiler killed: out of memory', what: `${it.prog || 'The compiler'} was killed (signal 9) or ran out of memory.`,
      why: 'Parallel C++ compiles (cc1plus often needs 1-2 GB each) times BB_NUMBER_THREADS x PARALLEL_MAKE exceeded RAM and swap; the kernel OOM killer picked the compiler.',
      fix: block('# local.conf: fewer jobs for this recipe only', `PARALLEL_MAKE:pn-${r} = "-j 4"`, '# or overall', 'BB_NUMBER_THREADS = "8"', 'PARALLEL_MAKE = "-j 8"', '# scarthgap+: back off when memory is tight', 'BB_PRESSURE_MAX_MEMORY = "10000"'),
      doc: 'Reference manual: PARALLEL_MAKE, BB_NUMBER_THREADS', url: `${DOCS}/ref-manual/variables.html#term-PARALLEL_MAKE` };
    case 'disk': return { title: 'Build disk is full (or nearly)', what: 'A write failed or the disk monitor stopped the build.', why: 'TMPDIR grows to 50-100+ GB for an image; sstate and downloads add more.',
      fix: block('INHERIT += "rm_work"   # local.conf: remove work dirs after each recipe', 'BB_DISKMON_DIRS = "STOPTASKS,${TMPDIR},1G,100K ABORT,${TMPDIR},100M,1K"', '# free space: rm -rf tmp/ (sstate rebuilds it), clean old sstate with sstate-cache-management.py'),
      doc: 'Reference manual: rm_work class, BB_DISKMON_DIRS', url: `${DOCS}/ref-manual/classes.html#ref-classes-rm-work` };
    case 'multiple-definition': return { title: `Multiple definition of ${it.sym}`, what: `${it.sym} is defined in more than one object.`, why: 'GCC 10 made -fno-common the default: a global declared without extern in a header is now a definition in each file that includes it.',
      fix: block('# proper fix: extern in the header, one definition in a .c (patch)', '# quick workaround:', 'CFLAGS += "-fcommon"'), doc: 'GCC 10 porting notes (-fno-common)', url: 'https://gcc.gnu.org/gcc-10/porting_to.html' };
    case 'implicit-decl': return { title: `Implicit declaration of ${it.sym}`, what: `${it.sym} is called without a prototype.`, why: 'GCC 14 turned implicit function declarations into errors; older code or configure tests that relied on them now fail.',
      fix: block('# fix: add the missing #include (patch)', '# workaround while the patch goes upstream:', 'CFLAGS += "-Wno-error=implicit-function-declaration"'), doc: 'GCC 14 porting notes', url: 'https://gcc.gnu.org/gcc-14/porting_to.html' };
    case 'werror': return { title: `Warning turned into an error: -W${it.flag}`, what: `The build uses -Werror and the newer compiler warns about ${it.flag}.`, why: 'A toolchain upgrade adds warnings; upstream builds with -Werror.',
      fix: block('# fix the code (patch), or relax just this warning:', `CFLAGS += "-Wno-error=${it.flag.replace(/=.*/, '')}"`, '# or turn off upstream -Werror (e.g. EXTRA_OECONF += "--disable-werror")'), doc: 'GCC warning options', url: 'https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html' };
    case 'undefined-ref': return { title: `Undefined reference to ${it.sym}`, what: `The link could not resolve ${it.sym}.`, why: 'A library missing from the link line (order matters with --as-needed), or a symbol that a newer library version removed.',
      fix: block('# add the library to the link (LDADD / target_link_libraries / LIBS) and to DEPENDS', `LDFLAGS += "-l<lib>"   # quick test only`), doc: 'Reference manual: LDFLAGS', url: `${DOCS}/ref-manual/variables.html#term-LDFLAGS` };
    case 'compile-error': return { title: 'Compile / configure error', what: f.items.map((i) => i.msg).filter(Boolean).slice(0, 2).join(' | ') || 'The build reported an error.',
      why: 'An error in the upstream build itself: often a newer compiler or library than the code was written for, or a missing configure option.',
      fix: block(`bitbake -c devshell ${r}   # reproduce by hand in the recipe environment`, `devtool modify ${r}        # patch the source, then devtool finish`), doc: 'Dev manual: devshell', url: `${DOCS}/dev-manual/development-shell.html` };
    default: return { title: f.task ? `${f.task} failed` : 'Error not recognised', what: f.recipe || f.task ? `${r} ${f.task || ''} failed and no rule here recognised why${f.sample ? `: "${f.sample.slice(0, 160)}"` : ''}.` : `An ERROR line no rule recognises: "${(f.sample || '').slice(0, 160)}".`, why: 'Read the task log: the first error line above "ERROR: Task ... failed" is usually the cause.',
      fix: block(`less \${WORKDIR}/temp/log.${f.task || 'do_<task>'}`, `bitbake -c devshell ${r}`, `bitbake -e ${r} | less`), doc: 'Dev manual: debugging', url: `${DOCS}/dev-manual/debugging.html` };
  }
}
