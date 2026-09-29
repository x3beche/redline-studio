// U-Boot Env & bootargs Builder.
// Reads a printenv, runs bootcmd the way U-Boot's hush shell would (run,
// setenv, if/then/elif/else/fi, && and ||, test, setexpr, the load and boot
// commands) without any hardware, and reports:
//   - the boot path: which loads happen, from where, to which address, and
//     the boot command with its kernel / initrd / fdt addresses;
//   - the kernel command line that results, argument by argument, where each
//     argument comes from (which variable, which word) and what it means;
//   - variables referenced but never defined, and the run/reference tree;
//   - the load addresses against the image sizes: overlaps, alignment, what
//     booti's relocation and the zImage decompressor will overwrite;
//   - the environment image mkenvimage would write (CRC32 over the data area,
//     0xff padding) and the fw_env.config line for libubootenv / fw_setenv.
// Pure: no DOM. Rules are commented with their source.

import { parseEnv, argSegment } from './envtext.js';

// ---------------- numbers ----------------
const hex = (v) => '0x' + Math.max(0, Math.round(v)).toString(16).toUpperCase();
const hex8 = (v) => '0x' + Math.max(0, Math.round(v)).toString(16).toUpperCase().padStart(8, '0');
const MiB = 1048576;
function human(b) {
  if (!Number.isFinite(b)) return '–';
  if (b >= MiB) return `${Number((b / MiB).toFixed(b % MiB ? 2 : 0))} MiB`;
  if (b >= 1024) return `${Number((b / 1024).toFixed(b % 1024 ? 1 : 0))} KiB`;
  return `${b} B`;
}
/** U-Boot addresses: hex with or without 0x (simple_strtoul(.., 16) in cmd/*.c). */
function addrOf(s) {
  const t = String(s ?? '').trim();
  if (/^(0x)?[0-9a-f]+$/i.test(t)) { const v = parseInt(t.replace(/^0x/i, ''), 16); return Number.isFinite(v) ? v : null; }
  return null;
}
/** Sizes as a person writes them: 28M, 64K, 0x4000, 16384, 1.5G (binary units). */
function sizeOf(s) {
  const t = String(s ?? '').trim().replace(/\s+/g, '').replace(/i?B$/i, '');
  if (!t) return null;
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  const m = /^(\d+(?:\.\d+)?)([KMG]?)$/i.exec(t);
  if (!m) return null;
  const k = { '': 1, K: 1024, M: MiB, G: 1024 * MiB }[m[2].toUpperCase()];
  return Math.round(Number(m[1]) * k);
}

// ---------------- CRC32 (zlib / IEEE 802.3, reflected 0xEDB88320) ----------------
// U-Boot env_crc_update() and mkenvimage use the zlib crc32() over the data area.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function utf8(str) {
  const out = [];
  for (const ch of String(str)) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

// ---------------- what U-Boot sets itself ----------------
// Variables that exist at run time without being in a saved environment:
// set by the net stack (net/), by a load (filesize, fileaddr), by board code
// (board_name, soc, serial#), or by standard boot / distro_bootcmd.
const RUNTIME = new Set(['filesize', 'fileaddr', 'bootfile', 'serverip', 'ipaddr', 'netmask', 'gatewayip', 'dnsip', 'hostname',
  'ethaddr', 'eth1addr', 'eth2addr', 'ethact', 'ethprime', 'stdin', 'stdout', 'stderr', 'ver', 'board', 'board_name', 'board_rev',
  'soc', 'soc_type', 'arch', 'cpu', 'vendor', 'fdtcontroladdr', 'serial#', 'devnum', 'devtype', 'distro_bootpart', 'prefix',
  'boot_syslinux_conf', 'efi_fdtfile', 'bootdev', 'bootpart', 'uuid', 'partuuid', 'rootpart', 'loadaddr', 'fdt_addr_r',
  'kernel_addr_r', 'ramdisk_addr_r', 'scriptaddr', 'pxefile_addr_r', 'fdtfile', 'bootargs']);
// Those last few are compiled-in defaults on most boards (CONFIG_SYS_LOAD_ADDR,
// ENV_MEM_LAYOUT_SETTINGS); only "not defined" in a pasted env if the board has
// no default either, so they are reported softly.
const SOFT = new Set(['loadaddr', 'fdt_addr_r', 'kernel_addr_r', 'ramdisk_addr_r', 'scriptaddr', 'pxefile_addr_r', 'fdtfile', 'bootargs']);

// COMMAND_LINE_SIZE per architecture (arch/*/include/uapi/asm/setup.h).
const CMDLINE_MAX = { arm: 1024, arm64: 2048, riscv: 1024 };

// ---------------- kernel arguments ----------------
// Documentation/admin-guide/kernel-parameters.txt, init/main.c (unknown
// "a=b" goes to init's environment, a bare word to init's argv),
// Documentation/admin-guide/serial-console.rst, RAUC docs (rauc.slot).
const LOGLEVEL = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000, 4000000];
const ARG = {
  console: { cat: 'console', what: (v) => {
    const m = /^([A-Za-z]+)(\d*)(?:,(\d+))?/.exec(v || '');
    return m ? `kernel messages and /dev/console on ${m[1]}${m[2]}${m[3] ? ` at ${m[3]} baud` : ''}; with several console= the last one becomes /dev/console` : 'kernel console device';
  } },
  earlycon: { cat: 'console', what: (v) => (v ? `early console at ${v} before the serial driver probes` : 'early console before the serial driver probes; the device comes from the DT /chosen stdout-path') },
  earlyprintk: { cat: 'console', what: () => 'early printk (older kernels; earlycon on arm64/riscv)' },
  root: { cat: 'root', what: (v) => rootWhat(v) },
  rootwait: { cat: 'root', what: () => 'wait as long as needed for the root device to appear (MMC, USB and NVMe probe asynchronously)' },
  rootdelay: { cat: 'root', what: (v) => `wait ${v || '?'} s before mounting root` },
  rootfstype: { cat: 'root', what: (v) => `filesystem type for root: ${v}` },
  rootflags: { cat: 'root', what: (v) => `mount options for root: ${v}` },
  rw: { cat: 'root', what: () => 'mount root read-write' },
  ro: { cat: 'root', what: () => 'mount root read-only (the kernel default; systemd/fstab may remount rw)' },
  init: { cat: 'init', what: (v) => `run ${v} as PID 1 instead of /sbin/init` },
  rdinit: { cat: 'init', what: (v) => `run ${v} from the initramfs as PID 1 (default /init)` },
  loglevel: { cat: 'log', what: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? `print messages more urgent than level ${n}${n <= 7 ? ` (${LOGLEVEL.slice(0, n).join(', ') || 'none'})` : ''} to the console` : 'console log level'; } },
  quiet: { cat: 'log', what: () => 'console log level 4: only warnings and worse (boot is faster on a slow UART)' },
  debug: { cat: 'log', what: () => 'console log level 10: everything, including debug' },
  ignore_loglevel: { cat: 'log', what: () => 'print every message regardless of level' },
  initcall_debug: { cat: 'log', what: () => 'time every initcall (for boot-time work; slows boot)' },
  'printk.time': { cat: 'log', what: () => 'timestamps on kernel messages' },
  panic: { cat: 'recovery', what: (v) => { const n = Number(v); return n > 0 ? `reboot ${n} s after a panic` : n < 0 ? 'reboot at once after a panic' : 'stay halted after a panic (0: wait forever)'; } },
  oops: { cat: 'recovery', what: (v) => (v === 'panic' ? 'turn every oops into a panic (then panic= reboots)' : 'oops behaviour') },
  crashkernel: { cat: 'memory', what: (v) => `reserve ${v} for a kdump capture kernel` },
  cma: { cat: 'memory', what: (v) => `contiguous memory area of ${v} for DMA buffers (GPU, VPU, camera, display); overrides the DT/Kconfig size` },
  mem: { cat: 'memory', what: (v) => `use only ${v} of RAM` },
  memmap: { cat: 'memory', what: (v) => `memory map override ${v}` },
  coherent_pool: { cat: 'memory', what: (v) => `atomic DMA coherent pool of ${v}` },
  swiotlb: { cat: 'memory', what: (v) => `bounce-buffer size ${v} (in 2 KiB slabs)` },
  'rauc.slot': { cat: 'update', what: (v) => `tells RAUC slot "${v}" booted; must match a bootname= in /etc/rauc/system.conf` },
  'rauc.external': { cat: 'update', what: () => 'RAUC: booted from a slot RAUC does not manage' },
  ip: { cat: 'net', what: (v) => `configure the network in the kernel (${v || 'none'}) before mounting root (needed for NFS root)` },
  nfsroot: { cat: 'net', what: (v) => `NFS export for root=/dev/nfs: ${v}` },
  mtdparts: { cat: 'flash', what: (v) => `MTD partitions on the kernel command line: ${v}` },
  'ubi.mtd': { cat: 'flash', what: (v) => `attach UBI to MTD ${v}` },
  'ubi.block': { cat: 'flash', what: (v) => `read-only block device on UBI volume ${v} (squashfs on UBI)` },
  'systemd.unit': { cat: 'init', what: (v) => `boot into systemd target ${v}` },
  'systemd.log_level': { cat: 'log', what: (v) => `systemd log level ${v}` },
  'systemd.show_status': { cat: 'log', what: (v) => `systemd status lines on the console: ${v}` },
  'systemd.mask': { cat: 'init', what: (v) => `mask unit ${v} for this boot` },
  'fsck.mode': { cat: 'init', what: (v) => `systemd-fsck: ${v}` },
  'fsck.repair': { cat: 'init', what: (v) => `systemd-fsck repair: ${v}` },
  video: { cat: 'display', what: (v) => `display mode ${v}` },
  fbcon: { cat: 'display', what: (v) => `framebuffer console: ${v}` },
  consoleblank: { cat: 'display', what: (v) => `blank the VT after ${v} s (0 = never)` },
  'logo.nologo': { cat: 'display', what: () => 'no penguin logo' },
  'vt.global_cursor_default': { cat: 'display', what: (v) => `VT cursor ${v === '0' ? 'off' : 'on'}` },
  maxcpus: { cat: 'cpu', what: (v) => `bring up at most ${v} CPUs at boot` },
  nosmp: { cat: 'cpu', what: () => 'one CPU only' },
  isolcpus: { cat: 'cpu', what: (v) => `keep the scheduler off CPUs ${v}` },
  nohz_full: { cat: 'cpu', what: (v) => `tickless CPUs ${v}` },
  'cpuidle.off': { cat: 'cpu', what: () => 'disable cpuidle' },
  clk_ignore_unused: { cat: 'debug', what: () => 'keep unused clocks on (hides a missing clock in the DT; for bring-up only)' },
  pd_ignore_unused: { cat: 'debug', what: () => 'keep unused power domains on (bring-up only)' },
  'dm-mod.create': { cat: 'root', what: () => 'device-mapper table created at boot (dm-verity or dm-crypt root without an initramfs)' },
  'dm-mod.waitfor': { cat: 'root', what: (v) => `wait for ${v} before creating the dm table` },
  lsm: { cat: 'security', what: (v) => `security modules: ${v}` },
  security: { cat: 'security', what: (v) => `security module ${v}` },
  selinux: { cat: 'security', what: (v) => `SELinux ${v === '0' ? 'off' : 'on'}` },
  enforcing: { cat: 'security', what: (v) => `SELinux ${v === '1' ? 'enforcing' : 'permissive'}` },
  audit: { cat: 'security', what: (v) => `audit ${v === '0' ? 'off' : 'on'}` },
  'arm64.nopauth': { cat: 'cpu', what: () => 'disable pointer authentication' },
};
function rootWhat(v) {
  if (!v) return 'root device';
  let m;
  if ((m = /^\/dev\/mmcblk(\d+)p(\d+)$/.exec(v))) return `partition ${m[2]} of the kernel's MMC device ${m[1]} (kernel numbering follows DT aliases mmc${m[1]}, not U-Boot's mmc dev)`;
  if ((m = /^\/dev\/(sd[a-z])(\d+)$/.exec(v))) return `partition ${m[2]} of SCSI/USB/SATA disk ${m[1]} (order depends on probe order)`;
  if ((m = /^\/dev\/nvme(\d+)n(\d+)p(\d+)$/.exec(v))) return `NVMe ${m[1]} namespace ${m[2]} partition ${m[3]}`;
  if (/^PARTUUID=/i.test(v)) return 'the partition with this GPT/MBR PARTUUID: independent of probe order';
  if (/^UUID=/i.test(v)) return 'filesystem UUID: needs an initramfs to resolve (the kernel alone only knows PARTUUID)';
  if (/^PARTLABEL=/i.test(v)) return 'the GPT partition with this label (kernel 5.x+)';
  if (v === '/dev/nfs') return 'root over NFS: needs nfsroot= and ip=';
  if (/^ubi\d+[:_]/.test(v)) return `UBIFS volume ${v} (needs ubi.mtd= and rootfstype=ubifs)`;
  if (/^\/dev\/ubiblock/.test(v)) return 'read-only block device on a UBI volume (squashfs; needs ubi.block=)';
  if (/^\/dev\/ram/.test(v)) return 'RAM disk (initrd image as root)';
  if (/^\/dev\/mtdblock/.test(v)) return 'MTD block device (jffs2/squashfs on NOR)';
  if (/^\/dev\/dm-\d+$/.test(v)) return 'device-mapper device (dm-verity / dm-crypt), created by dm-mod.create= or an initramfs';
  if (/^\/dev\/vd[a-z]\d*$/.test(v)) return 'virtio block device (QEMU)';
  return `root device ${v}`;
}
const CAT_ORDER = ['console', 'root', 'init', 'log', 'recovery', 'memory', 'update', 'net', 'flash', 'display', 'cpu', 'security', 'debug', 'other'];

// ---------------- the hush subset: lexer and parser ----------------
function lex(src) {
  const toks = [];
  let i = 0, cur = '', has = false;
  const push = () => { if (has) { toks.push({ t: 'w', v: cur }); cur = ''; has = false; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { cur += c + src[i + 1]; has = true; i += 2; continue; }
    if (c === "'" || c === '"') { const j = src.indexOf(c, i + 1); const end = j < 0 ? src.length : j + 1; cur += src.slice(i, end); has = true; i = end; continue; }
    if (c === '$' && src[i + 1] === '{') { const j = src.indexOf('}', i); const end = j < 0 ? src.length : j + 1; cur += src.slice(i, end); has = true; i = end; continue; }
    if (c === ';' || c === '\n') { push(); toks.push({ t: ';' }); i++; continue; }
    if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) { push(); toks.push({ t: c + c }); i += 2; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    cur += c; has = true; i++;
  }
  push();
  return toks;
}

function parseScript(src, varName, errors) {
  const toks = lex(src);
  let p = 0, ifs = 0;
  const word = () => (toks[p] && toks[p].t === 'w' ? toks[p].v : null);
  function list(stops) {
    const items = [];
    for (let guard = 0; p < toks.length && guard < 2000; guard++) {
      while (toks[p] && toks[p].t === ';') p++;
      if (p >= toks.length) break;
      const w = word();
      if (w != null && stops.includes(w)) break;
      const before = p;
      items.push(andor(stops));
      if (p === before) p++;
    }
    return items;
  }
  function andor(stops) {
    const parts = [{ op: null, cmd: command(stops) }];
    while (toks[p] && (toks[p].t === '&&' || toks[p].t === '||')) { const op = toks[p].t; p++; parts.push({ op, cmd: command(stops) }); }
    return parts;
  }
  function command(stops) {
    if (word() === 'if') {
      p++;
      const node = { type: 'if', id: `${varName}#${++ifs}`, clauses: [], elseBody: null };
      let cond = list(['then']);
      let closed = false;
      for (;;) {
        if (word() !== 'then') { errors.push(`${varName}: "if" without "then"`); break; }
        p++;
        const body = list(['elif', 'else', 'fi']);
        node.clauses.push({ cond, body });
        const w = word();
        if (w === 'elif') { p++; cond = list(['then']); continue; }
        if (w === 'else') { p++; node.elseBody = list(['fi']); }
        if (word() === 'fi') { p++; closed = true; } else errors.push(`${varName}: "if" without "fi"`);
        break;
      }
      if (!closed && !node.clauses.length) node.clauses.push({ cond, body: [] });
      return node;
    }
    const words = [];
    while (p < toks.length && toks[p].t === 'w') {
      if (!words.length && stops.includes(toks[p].v)) break;
      words.push(toks[p].v); p++;
    }
    return { type: 'simple', words };
  }
  return list([]);
}
const srcList = (items) => items.map(srcAndOr).join('; ');
const srcAndOr = (parts) => parts.map((q, i) => (i ? ` ${q.op} ` : '') + srcCmd(q.cmd)).join('');
function srcCmd(c) {
  if (c.type !== 'if') return c.words.join(' ');
  const cl = c.clauses.map((k, i) => `${i ? 'elif' : 'if'} ${srcList(k.cond)}; then ${srcList(k.body)}`).join('; ');
  return `${cl}${c.elseBody ? `; else ${srcList(c.elseBody)}` : ''}; fi`;
}

// ---------------- classification ----------------
const LOAD_FS = new Set(['load', 'fatload', 'ext2load', 'ext4load', 'btrfsload', 'sqfsload', 'erofsload', 'zfsload']);
const NET = new Set(['tftp', 'tftpboot', 'dhcp', 'bootp', 'nfs', 'wget', 'pxe']);
const BOOT = new Set(['bootz', 'booti', 'bootm', 'bootefi']);
function fileKind(file, addrTpl) {
  const f = String(file || '').toLowerCase();
  if (/\.dtbo$/.test(f)) return 'overlay';
  if (/\.dtb$|devicetree/.test(f)) return 'fdt';
  if (/\.scr$|\.cmd$|uenv|\.txt$|extlinux|\.conf$|\.ini$/.test(f)) return 'script';
  if (/initrd|initramfs|ramdisk|cpio|uinitrd|rootfs/.test(f)) return 'initrd';
  if (/image|vmlinu|kernel|\.itb$|fit|\.efi$|\.bin$/.test(f)) return 'kernel';
  const a = String(addrTpl || '').toLowerCase();
  if (/fdt|dtb/.test(a)) return 'fdt';
  if (/ramdisk|initrd/.test(a)) return 'initrd';
  if (/script|pxe/.test(a)) return 'script';
  if (/kernel|loadaddr|image/.test(a)) return 'kernel';
  return 'other';
}
// A load of a kernel, DT, overlay or initrd is assumed to succeed; a boot
// script / uEnv.txt is assumed absent (the usual case on a production
// image). The person flips the "if" that tests it to follow the other path.
const PRESENT = new Set(['kernel', 'fdt', 'initrd', 'overlay']);

// ---------------- the simulator ----------------
function simulate(env, entry, picks, sizes) {
  const vars = new Map(env.vars);
  const S = { vars, steps: 0, nodes: 0, loads: [], boots: [], undef: new Map(), runtime: new Set(), errors: [], notes: [], echoes: [],
    ifs: [], chips: null, argsOwner: null, fdtAddr: null, force: 0, stopped: null, parseCache: new Map(), overlays: [] };
  const newId = () => ++S.nodes;
  const parsed = (name) => {
    if (!S.parseCache.has(name)) { const errs = []; S.parseCache.set(name, { ast: parseScript(vars.get(name) ?? '', name, errs), errs }); for (const e of errs) S.errors.push(e); }
    return S.parseCache.get(name).ast;
  };
  const lookup = (name, where) => {
    if (vars.has(name)) return vars.get(name);
    if (RUNTIME.has(name) && !SOFT.has(name)) { S.runtime.add(name); return `<${name}>`; }
    if (!S.undef.has(name)) S.undef.set(name, new Set());
    S.undef.get(name).add(where);
    return '';
  };
  /** One word, expanded: $name / ${name} (not inside '...'), quotes removed, \x -> x. */
  const expandWord = (w, where) => {
    let out = '', dq = false, quoted = false;
    for (let i = 0; i < w.length;) {
      const c = w[i];
      if (c === '\\' && i + 1 < w.length) { out += w[i + 1]; i += 2; continue; }
      if (!dq && c === "'") { const j = w.indexOf("'", i + 1); const e = j < 0 ? w.length : j; out += w.slice(i + 1, e); i = e + 1; quoted = true; continue; }
      if (c === '"') { dq = !dq; quoted = true; i++; continue; }
      if (c === '$') {
        let name = null, end = i + 1;
        if (w[i + 1] === '{') { const j = w.indexOf('}', i); if (j > 0) { name = w.slice(i + 2, j); end = j + 1; } }
        else { const m = /^[A-Za-z0-9_]+/.exec(w.slice(i + 1)); if (m) { name = m[0]; end = i + 1 + m[0].length; } }
        if (name != null) { out += lookup(name, where); i = end; continue; }
      }
      out += c; i++;
    }
    return { text: out, quoted };
  };
  // Unquoted expansions are split on whitespace, and one that comes out empty
  // disappears (hush does both; that is why `test ${x} = yes` breaks when x
  // is not set).
  const argvOf = (words, where) => {
    const argv = [];
    words.forEach((w) => {
      const e = expandWord(w, where);
      if (e.quoted) argv.push(e.text);
      else for (const part of e.text.split(/\s+/)) if (part) argv.push(part);
    });
    return argv;
  };

  function execScript(name, depth, via) {
    const node = { k: 'run', id: newId(), var: name, st: 'ok', kids: [], depth };
    if (depth > 12) { node.st = 'fail'; S.errors.push(`run nesting deeper than 12 at ${name}: a loop between scripts?`); return node; }
    node.st = execList(parsed(name), { var: name, depth, kids: node.kids });
    return node;
  }
  function execList(items, fr) {
    let st = 'ok';
    for (const ao of items) {
      if (S.stopped) { fr.kids.push({ k: 'rest', id: newId(), src: srcList(items.slice(items.indexOf(ao))) }); return st; }
      st = execAndOr(ao, fr);
      if (st === 'boot' || st === 'stop') { S.stopped ||= st; }
    }
    return st;
  }
  function execAndOr(parts, fr) {
    let st = execCmd(parts[0].cmd, fr);
    for (let k = 1; k < parts.length; k++) {
      const { op, cmd } = parts[k];
      if (st === 'boot' || st === 'stop') return st;
      if ((op === '&&' && st !== 'ok') || (op === '||' && st === 'ok')) {
        fr.kids.push({ k: 'cmd', id: newId(), src: srcCmd(cmd), exp: '', cls: 'skip', st: 'skipped', var: fr.var, op, note: op === '&&' ? 'not run: the command before it failed' : 'not run: the command before it succeeded' });
        continue;
      }
      st = execCmd(cmd, fr, op);
    }
    return st;
  }
  function execIf(c, fr) {
    const node = { k: 'if', id: newId(), ifId: c.id, var: fr.var, pick: picks.get(c.id) || null, taken: null, clauses: [] };
    fr.kids.push(node);
    S.ifs.push(c.id);
    const labels = c.clauses.map((_, i) => (i ? `elif${i}` : 'then'));
    const pickIdx = node.pick == null ? -1 : node.pick === 'else' ? c.clauses.length : labels.indexOf(node.pick);
    let chosen = -1;
    c.clauses.forEach((cl, i) => {
      const view = { label: labels[i], condSrc: srcList(cl.cond), bodySrc: srcList(cl.body), cond: null, body: null, condSt: null, forced: false };
      node.clauses.push(view);
      if (chosen >= 0 || S.stopped) return;
      if (pickIdx >= 0) {
        if (i < pickIdx) { view.condSt = 'fail'; view.forced = true; return; }
        if (i === pickIdx) {
          const kids = [];
          S.force++;
          const st = execList(cl.cond, { ...fr, kids });
          S.force--;
          view.cond = kids; view.condSt = 'ok'; view.forced = st !== 'ok';
          chosen = i;
          return;
        }
        return;
      }
      const kids = [];
      const st = execList(cl.cond, { ...fr, kids });
      view.cond = kids; view.condSt = st === 'ok' ? 'ok' : 'fail';
      if (st === 'ok') chosen = i;
    });
    if (S.stopped && chosen < 0) return 'stop';
    if (chosen < 0 && pickIdx >= 0 && pickIdx < c.clauses.length) chosen = pickIdx;
    const elseView = c.elseBody ? { label: 'else', condSrc: '', bodySrc: srcList(c.elseBody), cond: null, body: null, condSt: null, forced: false } : null;
    if (elseView) node.clauses.push(elseView);
    let st = 'ok';
    if (chosen >= 0) {
      node.taken = labels[chosen];
      const kids = [];
      st = execList(c.clauses[chosen].body, { ...fr, kids });
      node.clauses[chosen].body = kids;
    } else if (c.elseBody) {
      node.taken = 'else';
      const kids = [];
      st = execList(c.elseBody, { ...fr, kids });
      elseView.body = kids;
    } else node.taken = null;
    return st;
  }
  function execCmd(cmd, fr) {
    if (++S.steps > 600) { if (!S.stopped) { S.stopped = 'stop'; S.errors.push('more than 600 commands run: stopped (a loop between scripts?)'); } return 'stop'; }
    if (cmd.type === 'if') return execIf(cmd, fr);
    if (!cmd.words.length) return 'ok';
    const where = fr.var;
    const argv = argvOf(cmd.words, where);
    const node = { k: 'cmd', id: newId(), src: cmd.words.join(' '), exp: argv.join(' '), cls: 'other', st: 'ok', var: fr.var, note: '' };
    fr.kids.push(node);
    const name = argv[0] || '';
    const a = argv.slice(1);
    if (!name) { node.note = 'the command expanded to nothing'; node.st = 'fail'; node.cls = 'bad'; return 'fail'; }

    if (name === 'run') {
      node.cls = 'run';
      node.kids = [];
      let st = 'ok';
      for (const n of a) {
        if (!vars.has(n)) {
          node.st = 'fail'; node.note = `no variable ${n} to run`;
          if (!S.undef.has(n)) S.undef.set(n, new Set());
          S.undef.get(n).add(where);
          return 'fail';
        }
        const sub = execScript(n, fr.depth + 1);
        node.kids.push(sub);
        st = sub.st;
        if (st === 'fail') { node.note = `${n} failed`; break; }
        if (st !== 'ok') break;
      }
      node.st = st;
      return st;
    }
    if (name === 'setenv' || (name === 'env' && a[0] === 'set')) {
      node.cls = 'env';
      const rest = name === 'env' ? a.slice(1) : a;
      const flagless = rest[0] === '-f' ? rest.slice(1) : rest;
      const vname = flagless[0];
      if (!vname) { node.note = 'setenv without a name'; return 'fail'; }
      const value = flagless.slice(1).join(' ');
      if (flagless.length === 1) { vars.delete(vname); node.note = `${vname} deleted`; }
      else { vars.set(vname, value); node.note = `${vname} = ${value.length > 90 ? value.slice(0, 90) + '…' : value}`; }
      S.parseCache.delete(vname);
      if (vname === 'bootargs') {
        // the words as written, so each argument can be traced to its source
        const rawWords = cmd.words.slice(cmd.words.indexOf(cmd.words.find((w, i) => i > 0 && w.replace(/['"]/g, '') === 'bootargs')) + 1);
        S.chips = chipsFrom(rawWords, fr.var, S.chips || [], true);
        S.argsOwner = fr.var;
        node.cls = 'args';
      }
      return 'ok';
    }
    if (name === 'setexpr') {
      node.cls = 'env';
      const [vn, x, op, y] = a;
      if (!vn) return 'fail';
      // cmd/setexpr.c: operands are hex (simple_strtoul base 16), the result is printed in hex without 0x
      const X = addrOf(x), Y = addrOf(y);
      let r = null;
      if (a.length === 2 && X != null) r = X;
      else if (X != null && Y != null) r = { '+': X + Y, '-': X - Y, '*': X * Y, '/': Y ? Math.floor(X / Y) : null, '%': Y ? X % Y : null, '&': X & Y, '|': X | Y, '^': X ^ Y }[op] ?? null;
      const v = r == null ? `<setexpr ${a.slice(1).join(' ')}>` : Math.max(0, r).toString(16);
      vars.set(vn, v);
      node.note = `${vn} = ${v}`;
      return 'ok';
    }
    if (name === 'test' || name === '[') {
      node.cls = 'test';
      const r = evalTest(name === '[' ? a.slice(0, -1) : a, node);
      node.st = r ? 'ok' : 'fail';
      return node.st;
    }
    if (name === 'true') { node.cls = 'test'; return 'ok'; }
    if (name === 'false') { node.cls = 'test'; node.st = 'fail'; return 'fail'; }
    if (name === 'echo') { node.cls = 'echo'; S.echoes.push(a.join(' ')); return 'ok'; }
    if (name === 'reset') { node.cls = 'boot'; node.note = 'the board resets here'; node.st = 'stop'; S.stopped = 'stop'; return 'stop'; }
    if (name === 'boot' || name === 'bootd') {
      node.cls = 'run';
      if (!vars.has('bootcmd')) { node.st = 'fail'; return 'fail'; }
      const sub = execScript('bootcmd', fr.depth + 1);
      node.kids = [sub];
      node.st = sub.st;
      return sub.st;
    }
    if (name === 'source' || name === 'script') {
      node.cls = 'script';
      node.note = 'runs the boot script loaded earlier; what it does is not in the environment';
      S.sourced = true;
      node.st = 'ok';
      S.notes.push(`${fr.var} sources a boot script: what the script does (its own setenv bootargs, loads, boot) is not in this environment - run mkimage -l / dumpimage on boot.scr to read it.`);
      return 'ok';
    }
    if (name === 'fdt') {
      node.cls = 'fdt';
      if (a[0] === 'addr' && a[1]) { S.fdtAddr = addrOf(a[1]); node.note = `working DT at ${a[1]}`; }
      else if (a[0] === 'apply' && a[1]) { S.overlays.push(addrOf(a[1])); node.note = 'overlay applied to the working DT'; }
      else if (a[0] === 'resize') node.note = `DT grown by ${a[1] ? a[1] + ' bytes' : 'a page'} for fixups`;
      return 'ok';
    }
    if (name === 'part' && a[0] === 'uuid' && a[3]) { node.cls = 'env'; vars.set(a[3], '<partuuid>'); node.note = `${a[3]} = the partition's UUID`; return 'ok'; }
    if (name === 'bootflow' || name === 'bootstd' || name === 'distro_bootcmd' || /^bootcmd_/.test(name)) {
      node.cls = 'script';
      node.note = 'standard boot scans the boot devices for extlinux.conf / boot.scr / EFI; the path depends on the media';
      S.notes.push('bootcmd hands over to standard boot (bootflow / distro_bootcmd): the loads and the command line come from extlinux.conf or boot.scr on the media, not from this environment.');
      return 'ok';
    }
    if (name === 'saveenv' || (name === 'env' && a[0] === 'save')) { node.cls = 'env'; node.note = 'writes the environment (as changed so far) back to storage'; return 'ok'; }

    // ------- loads -------
    let load = null;
    if (LOAD_FS.has(name)) {
      // load <interface> [<dev[:part]> [<addr> [<filename> [bytes [pos]]]]] (cmd/fs.c)
      const addrW = cmd.words[3] || '';
      load = { how: name, iface: a[0] || '?', dev: a[1] || '?', addr: addrOf(a[2]) ?? addrOf(vars.get('loadaddr')), file: a[3] || vars.get('bootfile') || '', addrTpl: addrW };
    } else if (name === 'ubifsload') {
      load = { how: name, iface: 'ubifs', dev: vars.get('ubifs_vol') || 'ubifs', addr: addrOf(a[0]), file: a[1] || '', addrTpl: cmd.words[1] || '' };
    } else if (NET.has(name)) {
      // tftpboot [loadAddress] [[hostIPaddr:]bootfilename] (cmd/net.c)
      let addr = null, file = '', addrTpl = '';
      if (a.length >= 2) { addr = addrOf(a[0]); file = a[1]; addrTpl = cmd.words[1] || ''; }
      else if (a.length === 1) { if (addrOf(a[0]) != null && !/\./.test(a[0])) { addr = addrOf(a[0]); addrTpl = cmd.words[1]; } else file = a[0]; }
      if (addr == null) addr = addrOf(vars.get('loadaddr'));
      load = { how: name, iface: 'net', dev: vars.get('serverip') || 'server', addr, file: file || vars.get('bootfile') || '', addrTpl };
    } else if (name === 'ubi' && a[0] === 'read') {
      load = { how: 'ubi read', iface: 'ubi', dev: vars.get('ubi_part') || 'ubi', addr: addrOf(a[1]), file: a[2] || '', addrTpl: cmd.words[2] || '' };
    } else if ((name === 'nand' || name === 'sf' || name === 'mmc') && a[0] === 'read') {
      load = { how: `${name} read`, iface: name, dev: `@${a[2] || '?'}`, addr: addrOf(a[1]), file: '', addrTpl: cmd.words[2] || '', raw: true, len: addrOf(a[3]) };
    }
    if (load) {
      node.cls = 'load';
      load.kind = load.raw ? fileKind('', load.addrTpl) : fileKind(load.file, load.addrTpl);
      load.ok = PRESENT.has(load.kind) || S.force > 0;
      load.forced = !PRESENT.has(load.kind) && S.force > 0;
      load.node = node.id;
      load.var = fr.var;
      load.size = load.raw && load.len ? load.len * (name === 'mmc' ? 512 : 1) : sizes[load.kind] ?? sizes.other;
      S.loads.push(load);
      node.load = S.loads.length - 1;
      if (load.addr == null) node.note = 'no load address (neither given nor loadaddr)';
      if (load.ok) {
        vars.set('filesize', load.size.toString(16));
        vars.set('fileaddr', (load.addr ?? 0).toString(16));
        node.note = `${load.file || load.dev} → ${load.addr != null ? hex(load.addr) : '?'} (${human(load.size)})`;
        return 'ok';
      }
      node.st = 'fail';
      node.note = `${load.file || 'file'} assumed absent: flip the "if" to follow the path where it exists`;
      return 'fail';
    }
    // ------- boot -------
    if (BOOT.has(name)) {
      node.cls = 'boot';
      const kTxt = a[0] || vars.get('loadaddr') || '';
      const kernel = addrOf(String(kTxt).split(/[#:]/)[0]);
      let initrd = null, initrdSize = null, fdt = null;
      if (name === 'bootefi') fdt = addrOf(a[1]);
      else {
        if (a[1] && a[1] !== '-') { const [ia, is] = a[1].split(':'); initrd = addrOf(ia); initrdSize = is ? addrOf(is) : null; }
        if (a[2]) fdt = addrOf(a[2]);
        else if (S.fdtAddr != null) fdt = S.fdtAddr;
      }
      const boot = { cmd: name, kernel, initrd, initrdSize, fdt, fit: name === 'bootm' && /#|:/.test(String(kTxt)), node: node.id, var: fr.var,
        bootargs: vars.get('bootargs') ?? '', argv: a, words: cmd.words.slice(1) };
      S.boots.push(boot);
      node.note = `kernel ${kernel != null ? hex(kernel) : '?'}${initrd != null ? `, initrd ${hex(initrd)}` : ''}${fdt != null ? `, fdt ${hex(fdt)}` : ''}`;
      node.st = 'boot';
      return 'boot';
    }
    // ------- device commands that set up media -------
    if (['mmc', 'usb', 'ubi', 'ubifsmount', 'sf', 'nand', 'scsi', 'nvme', 'sata', 'virtio', 'pci', 'mtd', 'mtdparts', 'gpt', 'part'].includes(name)) {
      node.cls = 'dev';
      if (name === 'mmc' && a[0] === 'dev') node.note = `select MMC ${a[1] ?? 0}${a[2] != null ? ` hw partition ${a[2]}` : ''}`;
      else if (name === 'mmc' && a[0] === 'rescan') node.note = 'probe the card again (fails with no card)';
      else if (name === 'ubi' && a[0] === 'part') node.note = `attach UBI on MTD partition ${a[1]}`;
      return 'ok';
    }
    if (name === 'sleep') { node.cls = 'other'; node.note = `waits ${a[0] || 1} s`; return 'ok'; }
    if (['iminfo', 'imi', 'itest', 'fastboot', 'ums', 'bmode', 'gpio', 'i2c', 'md', 'mw', 'cp', 'cmp', 'crc32', 'hash', 'env', 'printenv', 'loadb', 'loadx', 'loady', 'dfu', 'bootcount', 'unzip', 'gzwrite', 'mmcinfo', 'dm', 'led', 'button', 'pinmux', 'clk', 'power', 'regulator', 'pmic', 'bdinfo', 'version', 'coninfo', 'go', 'bootelf'].includes(name)) {
      node.cls = 'other';
      if (name === 'itest') { node.cls = 'test'; node.note = 'itest: taken as true'; }
      return 'ok';
    }
    node.cls = 'other';
    node.note = vars.has(name) ? `"${name}" is a variable name used as a command - did you mean run ${name}?` : `${name}: not a command this simulator knows; taken as succeeding`;
    if (vars.has(name)) S.errors.push(`${fr.var}: "${name}" is run as a command but it is a variable - write "run ${name}"`);
    return 'ok';
  }

  // test (cmd/test.c): numbers with simple_strtol(.., 10); -e iface dev file
  function evalTest(a, node) {
    let neg = false;
    let args = a;
    if (args[0] === '!') { neg = true; args = args.slice(1); }
    let r = false;
    const n = (s) => { const v = parseInt(s, 10); return Number.isFinite(v) ? v : 0; };
    if (args.length === 0) { r = false; }
    else if (args[0] === '-n') { r = args.length > 1 && args[1] !== ''; if (args.length === 1) node.note = 'test -n got no argument: the variable is empty or unset (quote it: "${x}")'; }
    else if (args[0] === '-z') { r = args.length === 1 || args[1] === ''; }
    else if (args[0] === '-e') { const file = args[3] || ''; r = PRESENT.has(fileKind(file, '')) || S.force > 0; node.note = r ? `${file} ${S.force ? 'picked as' : 'assumed'} present` : `${file} assumed absent`; }
    else if (args.length === 3) {
      const [x, op, y] = args;
      switch (op) {
        case '=': case '==': r = x === y; break;
        case '!=': r = x !== y; break;
        case '<': r = x < y; break;
        case '>': r = x > y; break;
        case '-eq': r = n(x) === n(y); break;
        case '-ne': r = n(x) !== n(y); break;
        case '-lt': r = n(x) < n(y); break;
        case '-le': r = n(x) <= n(y); break;
        case '-gt': r = n(x) > n(y); break;
        case '-ge': r = n(x) >= n(y); break;
        default: r = false; node.note = `test: unknown operator ${op}`;
      }
      if (!node.note) node.note = `${x} ${op} ${y} → ${r !== neg ? 'true' : 'false'}`;
    } else if (args.length === 2 && ['=', '!=', '==', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(args[0])) {
      r = false;
      node.note = 'test with an empty left side: a variable in it is unset - it is false here, and U-Boot prints a usage error';
      S.errors.push(`${node.var}: "${node.src}" - a variable in it is empty, so test gets ${args.length} words; quote it ("\${x}") or define it`);
    } else if (args.length === 1) { r = args[0] !== ''; }
    else { r = false; node.note = `test: ${args.length} words not understood; taken as false`; }
    return neg ? !r : r;
  }

  // bootargs chips: each argument with the variable and word it comes from
  function chipsFrom(tpls, owner, prev, top) {
    const out = [];
    const ownerSeg = argSegment(vars.get(owner) ?? '');
    tpls.forEach((tpl, idx) => {
      const segIdx = top ? idx : idx;
      const whole = /^\$\{([A-Za-z0-9_.#-]+)\}$|^\$([A-Za-z0-9_]+)$/.exec(tpl);
      if (whole) {
        const ref = whole[1] || whole[2];
        if (ref === 'bootargs') { for (const c of prev) out.push(c); return; }
        if (!vars.has(ref)) { lookup(ref, owner); return; }
        const inner = argSegment(vars.get(ref)).words.map((w) => w.text);
        for (const c of chipsFrom(inner, ref, prev, false)) out.push({ ...c, via: [owner, ...(c.via || [])] });
        return;
      }
      const e = expandWord(tpl, owner);
      const parts = e.quoted ? e.text.split(/\s+/).filter(Boolean) : e.text.split(/\s+/).filter(Boolean);
      // key=${x} where x holds several words (root=${mmcroot}, mmcroot =
      // "/dev/mmcblk1p2 rootwait rw"): each part maps back to one word of x.
      const one = /^([^$]*)\$\{([A-Za-z0-9_]+)\}([^$]*)$/.exec(tpl);
      const refWords = one && vars.has(one[2]) ? argSegment(vars.get(one[2])).words.map((w) => w.text) : null;
      parts.forEach((arg, k) => {
        let edit;
        if (one && refWords && refWords.length === parts.length && !/[$"']/.test(vars.get(one[2]))) {
          edit = { var: one[2], word: k, prefix: k === 0 ? one[1] : '', suffix: k === parts.length - 1 ? one[3] : '' };
        } else if (parts.length === 1) edit = { var: owner, word: segIdx, prefix: '', suffix: '', tpl };
        else edit = { var: owner, word: segIdx, whole: true, tpl };
        out.push({ arg, tpl, owner, edit, at: idx, via: [] });
      });
    });
    void ownerSeg;
    return out;
  }

  // ---- run it ----
  const root = vars.has(entry) ? execScript(entry, 0) : null;
  if (!root) S.errors.push(`${entry || '(none)'} is not in the environment: nothing to run`);
  if (!S.chips && vars.has('bootargs')) {
    const inner = argSegment(vars.get('bootargs')).words.map((w) => w.text);
    S.chips = chipsFrom(inner, 'bootargs', [], true);
    S.argsOwner = 'bootargs';
  }
  return { S, root, vars };
}

// ---------------- static analysis: the reference tree ----------------
function analyse(env) {
  const names = env.order;
  const info = new Map();
  const setBy = new Map();
  for (const n of names) {
    const v = env.vars.get(n);
    const runs = [];
    const refs = [];
    const all = lex(v);
    const toks = all.map((t) => (t.t === 'w' ? t.v : '\u0000'));
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === 'run' && (i === 0 || toks[i - 1] === '\u0000' || ['then', 'else', 'if', 'elif', 'do'].includes(toks[i - 1]))) {
        for (let j = i + 1; j < toks.length && /^[A-Za-z0-9_.#-]+$/.test(toks[j]); j++) runs.push(toks[j]);
      }
      if ((toks[i] === 'setenv' || toks[i] === 'setexpr') && toks[i + 1]) { const t = toks[i + 1] === '-f' ? toks[i + 2] : toks[i + 1]; if (t) { if (!setBy.has(t)) setBy.set(t, new Set()); setBy.get(t).add(n); } }
      if (toks[i] === 'env' && toks[i + 1] === 'set' && toks[i + 2]) { if (!setBy.has(toks[i + 2])) setBy.set(toks[i + 2], new Set()); setBy.get(toks[i + 2]).add(n); }
      if (toks[i] === 'part' && toks[i + 1] === 'uuid' && toks[i + 4]) { if (!setBy.has(toks[i + 4])) setBy.set(toks[i + 4], new Set()); setBy.get(toks[i + 4]).add(n); }
    }
    for (const m of v.matchAll(/\$\{([A-Za-z0-9_.#-]+)\}|\$([A-Za-z0-9_]+)/g)) refs.push(m[1] || m[2]);
    // a command-looking value is a script someone can run
    const script = /(^|[;\s])(run|setenv|if|load|fatload|ext4load|tftp|tftpboot|dhcp|booti|bootz|bootm|bootefi|echo|mmc|ubi|fdt|source|test)\b/.test(v) && /[;\s]/.test(v.trim());
    info.set(n, { name: n, runs: [...new Set(runs)], refs: [...new Set(refs)], script, by: [] });
  }
  for (const [n, x] of info) {
    for (const r of x.runs) info.get(r)?.by.push({ name: n, how: 'run' });
    for (const r of x.refs) info.get(r)?.by.push({ name: n, how: 'ref' });
  }
  return { info, setBy };
}

// ---------------- the load map ----------------
function memoryMap(sim, env, input, arch, sizes, warnings, notes) {
  const ramBase = addrOf(input.ram_base) ?? 0;
  const ramSize = sizeOf(input.ram_size) ?? 0;
  const vars = sim.vars;
  const S = sim.S;
  const boot = S.boots[0] || null;
  const items = [];
  const varFor = (tpl) => { const m = /^\$\{?([A-Za-z0-9_]+)\}?$/.exec(String(tpl || '')); return m ? m[1] : null; };
  for (const l of S.loads) {
    if (l.addr == null) continue;
    const used = l.ok && l.kind !== 'script' && l.kind !== 'other';
    items.push({ what: l.kind, label: l.file ? l.file.split('/').pop() : l.how, addr: l.addr, size: l.size, var: varFor(l.addrTpl), used, ok: l.ok, from: `${l.how} ${l.iface} ${l.dev}`, sizeKey: `${l.kind}_size` });
  }
  if (boot) {
    const add = (what, addr, size, tpl) => {
      if (addr == null) return;
      if (items.some((x) => x.addr === addr && x.used)) { const x = items.find((y) => y.addr === addr && y.used); x.what = what; x.boot = true; return; }
      items.push({ what, label: what, addr, size, var: varFor(tpl), used: true, ok: true, from: boot.cmd, boot: true, sizeKey: `${what}_size` });
    };
    add('kernel', boot.kernel, sizes.kernel, boot.words[0]);
    if (boot.initrd != null) add('initrd', boot.initrd, boot.initrdSize ?? sizes.initrd, boot.words[1]);
    if (boot.fdt != null) add('fdt', boot.fdt, sizes.fdt, boot.words[2]);
    for (const x of items) if (x.used && x.addr === boot.kernel) x.boot = true;
  }
  // nothing ran: show the address variables the env defines, dimmed
  if (!items.length) {
    for (const [n, k] of [['kernel_addr_r', 'kernel'], ['loadaddr', 'kernel'], ['fdt_addr_r', 'fdt'], ['fdt_addr', 'fdt'], ['ramdisk_addr_r', 'initrd'], ['initrd_addr', 'initrd'], ['scriptaddr', 'script']]) {
      const a = addrOf(vars.get(n));
      if (a != null && !items.some((x) => x.addr === a)) items.push({ what: k, label: n, addr: a, size: sizes[k] ?? sizes.other, var: n, used: false, ok: true, from: 'env', sizeKey: `${k}_size` });
    }
  }
  const findings = [];
  const derived = [];
  const fdtHigh = vars.get('fdt_high');
  const initrdHigh = vars.get('initrd_high');
  const noReloc = (v) => v != null && /^0x?f{8,16}$/i.test(String(v).trim());
  const kern = items.find((x) => x.used && x.what === 'kernel');
  const fdtItem = items.find((x) => x.used && x.what === 'fdt');
  const bootCmd = boot ? boot.cmd : null;

  if (kern && bootCmd === 'booti') {
    // arch/arm/lib/image.c booti_setup(): an Image not on a 2 MiB boundary is
    // moved to ALIGN(first DRAM bank, 2 MiB) + text_offset before the jump.
    // Documentation/arch/arm64/booting.rst: "The Image must be placed
    // text_offset bytes from a 2MB aligned base address".
    if (kern.addr % (2 * MiB)) {
      const dst = Math.ceil(ramBase / (2 * MiB)) * 2 * MiB;
      derived.push({ what: 'reloc', label: 'Image (relocated)', addr: dst, size: kern.size, used: true, ok: true, derived: true, from: 'booti' });
      findings.push({ tone: 'note', text: `The Image at ${hex(kern.addr)} is not 2 MiB aligned, so booti moves it to ${hex(dst)} before starting it (a memmove of ${human(kern.size)}; image_size in the Image header, 0 in old kernels meaning 16 MiB). Load it at a 2 MiB boundary to skip the copy.` });
    }
  }
  if (kern && bootCmd === 'bootz') {
    // Documentation/arch/arm/booting.rst: the decompressor writes the kernel at
    // PHYS_OFFSET + TEXT_OFFSET (0x8000); a zImage should be loaded above
    // 32 MiB from RAM start to avoid relocating itself; "a safe location [for
    // the DTB] is just above the 128MiB boundary from start of RAM".
    const out = Math.round(kern.size * 4);
    derived.push({ what: 'decomp', label: 'decompressed kernel', addr: ramBase + 0x8000, size: out, used: true, ok: true, derived: true, from: 'zImage decompressor', estimate: true });
    if (kern.addr < ramBase + 32 * MiB) findings.push({ tone: 'note', text: `zImage at ${hex(kern.addr)} is below RAM start + 32 MiB (${hex(ramBase + 32 * MiB)}): its decompressor relocates itself first (works, costs time). Documentation/arch/arm/booting.rst recommends loading it above 32 MiB.` });
  }
  const all = [...items, ...derived];
  // overlaps between things that are in RAM together at the jump to the kernel
  const live = all.filter((x) => x.used);
  const overlaps = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const p = live[i], q = live[j];
      if ((p.what === 'kernel' && q.what === 'reloc') || (q.what === 'kernel' && p.what === 'reloc')) continue; // memmove handles that
      if ((p.what === 'kernel' && q.what === 'decomp') || (q.what === 'kernel' && p.what === 'decomp')) continue; // decompressor relocates itself
      const lo = Math.max(p.addr, q.addr), hi = Math.min(p.addr + p.size, q.addr + q.size);
      if (hi <= lo) continue;
      const pair = [p, q].sort((x, y) => (x.derived ? 1 : 0) - (y.derived ? 1 : 0));
      const [a, b] = pair;
      const reloc = (x) => (x.what === 'fdt' && !noReloc(fdtHigh)) || (x.what === 'initrd' && !noReloc(initrdHigh));
      const moving = b.derived && reloc(a);
      overlaps.push({ lo, hi, a: a.label, b: b.label, tone: moving ? 'warn' : 'bad' });
      if (b.derived) {
        if (moving) findings.push({ tone: 'warn', text: `${a.label} at ${hex(a.addr)} lies where the ${b.label} will be written, but U-Boot copies the ${a.what === 'fdt' ? 'DT' : 'initrd'} elsewhere first because ${a.what === 'fdt' ? 'fdt_high' : 'initrd_high'} is not 0xffffffff. Safer: move it clear (≥ ${hex(b.addr + b.size)}).` });
        else findings.push({ tone: 'bad', text: `${a.label} (${hex(a.addr)}–${hex(a.addr + a.size)}) is inside the ${b.label} (${hex(b.addr)}–${hex(b.addr + b.size)})${a.what === 'fdt' && noReloc(fdtHigh) ? ', and fdt_high=' + fdtHigh + ' keeps it there' : ''}: the kernel overwrites it. Move ${a.var || a.label} to ${hex(Math.ceil((b.addr + b.size) / MiB) * MiB)} or above${bootCmd === 'bootz' ? ' (booting.rst: just above RAM start + 128 MiB is safe for the DTB)' : ''}.` });
      } else {
        findings.push({ tone: 'bad', text: `${a.label} (${hex(a.addr)}–${hex(a.addr + a.size)}) and ${b.label} (${hex(b.addr)}–${hex(b.addr + b.size)}) overlap by ${human(hi - lo)}: the later load overwrites the earlier. Move ${b.var || a.var || b.label} to ${hex(Math.ceil((a.addr + a.size) / 0x10000) * 0x10000)} or above, or shrink the image.` });
      }
    }
  }
  for (const x of all) {
    if (ramSize > 0 && (x.addr < ramBase || x.addr + x.size > ramBase + ramSize) && x.used) {
      findings.push({ tone: 'bad', text: `${x.label} at ${hex(x.addr)}–${hex(x.addr + x.size)} is outside RAM (${hex(ramBase)}–${hex(ramBase + ramSize)}).` });
      x.outside = true;
    }
  }
  if (fdtItem && arch === 'arm64') {
    // booting.rst: "The device tree blob (dtb) must be placed on an 8-byte
    // boundary and must not exceed 2 megabytes in size."
    if (fdtItem.addr % 8) findings.push({ tone: 'bad', text: `The DTB at ${hex(fdtItem.addr)} is not 8-byte aligned (arm64 booting.rst).` });
    if (fdtItem.size > 2 * MiB) findings.push({ tone: 'bad', text: `The DTB is ${human(fdtItem.size)}: arm64 allows at most 2 MiB.` });
  }
  if (fdtItem && noReloc(fdtHigh)) notes.push(`fdt_high=${fdtHigh}: the DT is used where it was loaded (no copy), so its address must stay clear of the kernel and inside the kernel's early mapping.`);
  if (boot && boot.cmd !== 'bootefi' && boot.fdt == null && !boot.fit) findings.push({ tone: arch === 'arm64' ? 'bad' : 'warn', text: `${boot.cmd} is given no DT address: the kernel ${arch === 'arm64' ? 'cannot boot without one on arm64' : 'falls back to ATAGS'}. Pass it as the third argument (${boot.cmd} \${loadaddr} - \${fdt_addr}).` });
  if (boot && boot.fit) notes.push('bootm with a FIT (addr#config): kernel, DT and initrd are copied to the load addresses written in the .its; the map shows only the FIT blob.');
  for (const f of findings) (f.tone === 'note' ? notes : warnings).push(f.text);
  // the part of RAM worth drawing: everything placed, with a margin
  const lo = all.length ? Math.min(...all.map((x) => x.addr)) : ramBase;
  const hi = all.length ? Math.max(...all.map((x) => x.addr + x.size)) : ramBase + Math.min(ramSize || 64 * MiB, 64 * MiB);
  return { ramBase, ramSize, items, derived, overlaps, view: { lo, hi }, bootCmd, fdtHigh: fdtHigh ?? null, initrdHigh: initrdHigh ?? null, bad: findings.filter((f) => f.tone === 'bad').length };
}

// ---------------- the environment image ----------------
function envImage(env, input, warnings, notes) {
  const size = sizeOf(input.env_size) ?? 0;
  const red = !!input.redundant;
  const header = red ? 5 : 4; // include/env.h: env_t {uint32_t crc; [unsigned char flags;] data[]}
  const dataSize = Math.max(0, size - header);
  const segs = [];
  const bytes = [];
  for (const n of env.order) {
    const b = utf8(`${n}=${env.vars.get(n)}`);
    segs.push({ name: n, at: header + bytes.length, len: b.length + 1 });
    for (const x of b) bytes.push(x);
    bytes.push(0);
  }
  bytes.push(0); // the list ends with an empty string (double NUL), as mkenvimage writes it
  const used = bytes.length;
  const fits = used <= dataSize;
  let crc = 0, head = '', stored = '';
  if (size > 0 && fits && size <= 16 * MiB) {
    const data = new Uint8Array(dataSize).fill(0xFF); // mkenvimage pads with 0xff (-p)
    data.set(bytes);
    crc = crc32(data);
    const hdr = [crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24];
    if (red) hdr.push(1); // mkenvimage -r writes flags = 1 (active)
    const first = [...hdr, ...data.slice(0, 64 - hdr.length)];
    stored = hdr.slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
    const lines = [];
    for (let o = 0; o < first.length; o += 16) {
      const row = first.slice(o, o + 16);
      lines.push(`${o.toString(16).padStart(8, '0')}  ${row.map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  |${row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}|`);
    }
    head = lines.join('\n');
  }
  if (!size) warnings.push('Env size is not a size: write it like 0x4000, 16K or 16384 (CONFIG_ENV_SIZE).');
  else if (!fits) warnings.push(`The environment needs ${used} bytes but a ${hex(size)} image holds ${dataSize} after its ${header}-byte header: ${used - dataSize} bytes too many. Raise CONFIG_ENV_SIZE (and the partition) or remove variables; mkenvimage refuses it.`);
  else if (used > dataSize * 0.8) warnings.push(`The environment fills ${Math.round((used / dataSize) * 100)}% of its ${hex(size)} image: fw_setenv and saveenv fail once it is full; leave headroom for update counters and RAUC variables.`);
  if (env.sizeLine) {
    const expectTotal = dataSize;
    if (size && env.sizeLine.total !== expectTotal) {
      const guess = env.sizeLine.total + header;
      warnings.push(`printenv says the environment holds ${env.sizeLine.total} bytes, so CONFIG_ENV_SIZE on the board is ${hex(guess)}${red ? ' (with redundancy)' : ''}, not ${hex(size)}: an image or fw_env.config with the wrong size fails its CRC check. Set Env size to ${hex(guess)}.`);
    }
    const usedNoTail = used - 1;
    if (Math.abs(env.sizeLine.used - usedNoTail) > 1) notes.push(`printenv counted ${env.sizeLine.used} bytes used; this text makes ${usedNoTail}: the paste is not the whole environment, or a value was changed here.`);
  }
  return { size, red, header, dataSize, used, fits, crc, crcHex: crc.toString(16).padStart(8, '0'), stored, head, segs };
}

function fwEnvConfig(input, img, warnings) {
  const dev = String(input.env_dev || '').trim() || '/dev/mmcblk0';
  const off = addrOf(input.env_offset);
  const off2 = addrOf(input.env_offset2);
  const sect = sizeOf(input.env_sector);
  const mtd = /\/dev\/mtd/.test(dev);
  const col = (s, w) => String(s).padEnd(w);
  const line = (o) => `${col(dev, 16)}${col(o == null ? '?' : hex(o), 12)}${col(hex(img.size), 10)}${mtd && sect ? hex(sect) : ''}`.trimEnd();
  const out = ['# /etc/fw_env.config (libubootenv / u-boot-fw-utils)', `# ${col('Device', 14)}${col('Offset', 12)}${col('Size', 10)}${mtd ? 'Sector size' : ''}`.trimEnd(), line(off)];
  if (off == null) warnings.push('Env offset is not a hex number: fw_env.config needs the byte offset of the environment on the device (CONFIG_ENV_OFFSET).');
  if (img.red) {
    out.push(line(off2));
    if (off2 == null) warnings.push('Redundant environment needs the second copy\'s offset (CONFIG_ENV_OFFSET_REDUND).');
    else if (off != null && img.size && off2 < off + img.size && off < off2 + img.size) warnings.push(`The two environment copies overlap (${hex(off)} and ${hex(off2)}, ${hex(img.size)} each): put the second at ${hex(off + Math.max(img.size, sect || 0))} or further.`);
    if (mtd && sect && off != null && off2 != null && Math.floor(off / sect) === Math.floor(off2 / sect)) warnings.push('Both environment copies are in one erase block: erasing one destroys the other - redundancy gone. Give each copy its own sector.');
  }
  if (!mtd && off != null && off % 512) warnings.push(`Env offset ${hex(off)} is not on a 512-byte block boundary; U-Boot's MMC environment is block-addressed.`);
  if (mtd && !sect) warnings.push('An MTD device needs the erase-sector size as the fourth column (mtdinfo shows it).');
  if (mtd && sect && off != null && off % sect) warnings.push(`Env offset ${hex(off)} is not on an erase-sector boundary (${hex(sect)}).`);
  const cfg = ['', '# U-Boot defconfig to match', `CONFIG_ENV_SIZE=${hex(img.size)}`, `CONFIG_ENV_OFFSET=${off == null ? '?' : hex(off)}`];
  if (img.red) cfg.push('CONFIG_SYS_REDUNDAND_ENVIRONMENT=y', `CONFIG_ENV_OFFSET_REDUND=${off2 == null ? '?' : hex(off2)}`);
  if (mtd && sect) cfg.push(`CONFIG_ENV_SECT_SIZE=${hex(sect)}`);
  return out.concat(cfg).join('\n');
}

// ---------------- run ----------------
export function run(input) {
  const warnings = [];
  const notes = [];
  const env = parseEnv(input.env);
  const entry = String(input.entry || 'bootcmd').trim() || 'bootcmd';
  const picks = new Map();
  for (const m of String(input.picks || '').matchAll(/([^\s,=]+#\d+)\s*=\s*(then|else|elif\d+)/g)) picks.set(m[1], m[2]);
  const sizes = {
    kernel: sizeOf(input.kernel_size) ?? 0, fdt: sizeOf(input.fdt_size) ?? 0, initrd: sizeOf(input.initrd_size) ?? 0,
    overlay: 16 * 1024, script: 4096, other: 64 * 1024,
  };
  for (const [k, lbl] of [['kernel_size', 'Kernel size'], ['fdt_size', 'DT size'], ['initrd_size', 'initrd size'], ['ram_size', 'RAM size']]) {
    if (sizeOf(input[k]) == null) warnings.push(`${lbl} "${input[k]}" is not a size: write it like 28M, 64K or 0x4000.`);
  }
  if (addrOf(input.ram_base) == null) warnings.push(`RAM start "${input.ram_base}" is not a hex address.`);
  if (!env.order.length) {
    warnings.push('No variables read: paste the output of printenv (U-Boot) or fw_printenv (Linux), one name=value per line.');
  }
  for (const u of env.unread.slice(0, 5)) warnings.push(`Line ${u.line} is not name=value and was skipped: "${u.text}"`);
  if (env.unread.length > 5) warnings.push(`${env.unread.length - 5} more lines were not name=value.`);
  if (env.dups.length) warnings.push(`Defined twice (the last one counts): ${[...new Set(env.dups)].join(', ')}.`);

  const { info, setBy } = analyse(env);
  const sim = simulate(env, entry, picks, sizes);
  const S = sim.S;
  const boot = S.boots[0] || null;
  let arch = input.arch;
  if (!['arm', 'arm64', 'riscv'].includes(arch)) arch = boot?.cmd === 'bootz' ? 'arm' : 'arm64';

  // undefined: referenced while running, or anywhere in the env statically
  const undef = [];
  const seen = new Set();
  for (const [name, where] of S.undef) {
    seen.add(name);
    const setters = setBy.get(name);
    undef.push({ name, where: [...where], soft: SOFT.has(name), setBy: setters ? [...setters] : [], ran: true });
  }
  for (const [n, x] of info) {
    for (const r of x.refs.concat(x.runs)) {
      if (seen.has(r) || env.vars.has(r) || RUNTIME.has(r)) continue;
      seen.add(r);
      const setters = setBy.get(r);
      if (setters) continue; // set by a script before use
      undef.push({ name: r, where: [n], soft: false, setBy: [], ran: false });
    }
  }
  const offPath = [];
  for (const u of undef) {
    if (u.setBy.length) continue;
    const w = u.where.join(', ');
    if (!u.ran) { offPath.push(`${u.name} (${w})`); continue; }
    if (u.soft) notes.push(`${u.name} is used by ${w} but not in this environment; it must come from the board's compiled-in defaults (CONFIG_SYS_LOAD_ADDR / ENV_MEM_LAYOUT_SETTINGS) or it expands to nothing.`);
    else warnings.push(`\${${u.name}} is used by ${w} but never defined${u.ran ? ' - it expands to nothing on this path' : ''}. Define it (even empty: ${u.name}=) or remove the reference.`);
  }
  if (offPath.length) notes.push(`Also used but never defined, in scripts not on this path: ${offPath.join(', ')}.`);
  for (const e of S.errors) warnings.push(e);

  // the kernel command line
  const chips = (S.chips || []).map((c, i) => {
    const eq = c.arg.indexOf('=');
    const key = eq > 0 ? c.arg.slice(0, eq) : c.arg;
    const val = eq > 0 ? c.arg.slice(eq + 1) : null;
    const def = ARG[key];
    return { i, arg: c.arg, key, val, cat: def ? def.cat : 'other', what: def ? def.what(val ?? '') : (eq > 0 ? 'not a kernel parameter: passed to init as an environment variable' : 'not a kernel parameter: passed to init as an argument'), known: !!def,
      tpl: c.tpl, owner: c.owner, at: c.at, via: c.via, edit: c.edit, flags: [] };
  });
  const cmdline = chips.map((c) => c.arg).join(' ');
  const byKey = new Map();
  for (const c of chips) { if (!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
  const flag = (c, tone, text) => { c.flags.push({ tone, text }); (tone === 'bad' ? warnings : tone === 'warn' ? warnings : notes).push(text); };
  const root = byKey.get('root')?.slice(-1)[0];
  if (chips.length || boot) {
    if (!byKey.has('console') && !byKey.has('earlycon')) notes.push('No console= in the command line: the kernel uses the DT /chosen stdout-path, if there is one; otherwise there is no serial console after boot.');
    for (const c of byKey.get('console') || []) {
      const m = /^(tty[A-Za-z]*\d*|ttyS\d+|hvc\d+|null)(?:,(\d+)(?:[noe][5-8]?)?r?)?$/.exec(c.val || '');
      if (!m) flag(c, 'warn', `console=${c.val}: expected a device like ttymxc1,115200 or ttyS0,115200n8.`);
      else if (m[2] && !BAUDS.includes(Number(m[2]))) flag(c, 'warn', `console=${c.val}: ${m[2]} is not a standard baud rate.`);
      const baud = m && m[2] ? Number(m[2]) : null;
      const ub = Number(sim.vars.get('baudrate'));
      if (baud && ub && baud !== ub) flag(c, 'note', `The kernel console runs at ${baud} baud but U-Boot at ${ub} (baudrate): the terminal has to switch rates mid-boot.`);
      const soc = String(env.vars.get('soc_type') || env.vars.get('soc') || env.vars.get('board_name') || '').toLowerCase();
      const dev = m ? m[1] : '';
      const want = /imx8(ulp|qxp|dx)|imx9|imx93/.test(soc) ? 'ttyLP' : /imx/.test(soc) ? 'ttymxc' : /stm32mp/.test(soc) ? 'ttySTM' : /rpi|bcm2/.test(soc) ? 'ttyAMA/ttyS' : null;
      if (want && dev && !want.split('/').some((w) => dev.startsWith(w)) && dev !== 'null') flag(c, 'warn', `console=${dev} on ${soc}: that SoC's UART driver names its ports ${want}N - check the name.`);
    }
    if (root) {
      const v = root.val || '';
      const block = /^\/dev\/(mmcblk|sd|nvme|vd)|^PARTUUID=|^PARTLABEL=/.test(v);
      if (block && !byKey.has('rootwait') && !byKey.has('rootdelay')) flag(root, 'warn', `root=${v} without rootwait: the kernel may try to mount it before the device has probed and panic with "VFS: Unable to mount root fs". Add rootwait.`);
      if (/^UUID=/.test(v)) flag(root, 'warn', 'root=UUID= needs an initramfs to resolve it; the kernel alone understands PARTUUID=.');
      if (v === '/dev/nfs') {
        if (!byKey.has('nfsroot')) flag(root, 'warn', 'root=/dev/nfs without nfsroot=: the kernel uses the DHCP root-path, if the server sends one.');
        if (!byKey.has('ip')) flag(root, 'warn', 'root=/dev/nfs without ip=: the kernel has no network to mount root over. Add ip=dhcp.');
      }
      if (/^ubi\d/.test(v)) {
        if (!byKey.has('rootfstype')) flag(root, 'warn', 'root on UBI without rootfstype=ubifs: the kernel tries every filesystem and fails on ubi volumes.');
        if (!byKey.has('ubi.mtd')) flag(root, 'warn', 'root on UBI without ubi.mtd=: nothing attaches UBI to the MTD partition before mount.');
      }
      if ((byKey.get('root') || []).length > 1) flag(root, 'warn', `root= given ${byKey.get('root').length} times; the last one (${v}) counts.`);
    } else if (chips.length && !byKey.has('rdinit')) notes.push('No root= in the command line: the kernel boots the built-in or U-Boot-passed initramfs, or the DT /chosen bootargs root.');
    if (byKey.has('ro') && byKey.has('rw')) { const last = chips.filter((c) => c.key === 'ro' || c.key === 'rw').slice(-1)[0]; flag(last, 'warn', `Both ro and rw are given; the last (${last.key}) counts.`); }
    for (const c of byKey.get('loglevel') || []) { const n = Number(c.val); if (!(Number.isInteger(n) && n >= 0 && n <= 15)) flag(c, 'warn', `loglevel=${c.val}: use 0-7 (8+ prints everything).`); }
    if (byKey.has('quiet') && byKey.has('loglevel')) { const q = chips.find((c) => c.key === 'quiet'); flag(q, 'note', 'quiet and loglevel= both set: whichever comes later wins.'); }
    for (const c of byKey.get('panic') || []) { if (!/^-?\d+$/.test(c.val || '')) flag(c, 'warn', `panic=${c.val}: needs a number of seconds.`); else if (Number(c.val) === 0) flag(c, 'note', 'panic=0 leaves a field device hanging after a panic; panic=5 (or a watchdog) reboots it.'); }
    for (const [k, list] of byKey) {
      if (list.length > 1 && !['console', 'root', 'ro', 'rw'].includes(k) && list.every((c) => c.known)) flag(list[list.length - 1], 'warn', `${k} is given ${list.length} times; the last one counts.`);
    }
    for (const c of chips) if (c.arg.includes('<')) flag(c, 'note', `${c.arg}: part of this is only known on the board (${c.arg.match(/<([^>]+)>/)[1]}).`);
    const max = CMDLINE_MAX[arch] || 1024;
    if (cmdline.length >= max) warnings.push(`The command line is ${cmdline.length} characters; ${arch} keeps only ${max - 1} (COMMAND_LINE_SIZE) - the end is cut off.`);
    const empties = (S.chips || []).length === 0 && boot;
    if (empties) warnings.push('The kernel gets an empty command line on this path: nothing sets bootargs. It then relies on CONFIG_CMDLINE or the DT /chosen bootargs.');
  }
  chips.sort((a, b) => a.i - b.i);

  // boot path summary
  if (!boot && S.sourced) notes.push(`${entry} hands over to a boot script on this path; whether and how it boots is decided by that script.`);
  else if (!boot && !S.stopped && sim.root) warnings.push(`${entry} ends without a boot command on this path: U-Boot drops to its prompt${sim.vars.get('bootcmd') ? '' : ' (no bootcmd)'}.`);
  if (S.stopped === 'stop' && !boot) notes.push(`${entry} resets the board on this path.`);
  const bootdelay = env.vars.has('bootdelay') ? Number(env.vars.get('bootdelay')) : null;
  if (bootdelay === -2) notes.push('bootdelay=-2: autoboot without checking for a key press (no way to stop it from the console).');
  else if (bootdelay === -1) warnings.push('bootdelay=-1: autoboot is disabled - the board stops at the U-Boot prompt.');

  const map = memoryMap(sim, env, input, arch, sizes, warnings, notes);
  const img = envImage(env, input, warnings, notes);
  const fwcfg = fwEnvConfig(input, img, warnings);

  // ----- the drawing data -----
  const scripts = [...info.values()].filter((x) => x.script).map((x) => x.name);
  const reach = new Set();
  const walk = (n, d = 0) => { if (reach.has(n) || d > 30) return; reach.add(n); const x = info.get(n); if (!x) return; for (const r of x.runs.concat(x.refs)) walk(r, d + 1); };
  walk(entry);
  const vars = env.order.map((n) => {
    const x = info.get(n);
    return { name: n, value: env.vars.get(n), runs: x.runs, refs: x.refs, by: x.by, script: x.script, reach: reach.has(n),
      undef: x.refs.concat(x.runs).filter((r) => !env.vars.has(r) && !RUNTIME.has(r) && !setBy.has(r)), setBy: setBy.has(n) ? [...setBy.get(n)] : [] };
  });
  const chain = [];
  chain.push({ k: 'rom', label: 'Boot ROM', sub: 'loads SPL from boot media' });
  chain.push({ k: 'spl', label: 'SPL', sub: arch === 'arm64' ? 'DRAM, TF-A, OP-TEE' : 'DRAM init, U-Boot' });
  chain.push({ k: 'uboot', label: 'U-Boot', sub: bootdelay == null ? `autoboot → ${entry}` : bootdelay < 0 ? (bootdelay === -2 ? `no key check → ${entry}` : 'autoboot off') : `${bootdelay} s key wait → ${entry}` });
  for (const l of S.loads) chain.push({ k: 'load', kind: l.kind, label: l.file ? l.file.split('/').pop() : l.how, sub: `${l.how} ${l.iface} ${l.dev}`, where: `${l.iface} ${l.dev}`, addr: l.addr, ok: l.ok, forced: !!l.forced, node: l.node, var: l.var });
  if (boot) {
    chain.push({ k: 'boot', label: boot.cmd, sub: [boot.kernel != null ? hex(boot.kernel) : '?', boot.initrd != null ? hex(boot.initrd) : '-', boot.fdt != null ? hex(boot.fdt) : 'no fdt'].join(' '), node: boot.node, var: boot.var });
    const con = byKey.get('console')?.slice(-1)[0]?.val;
    chain.push({ k: 'kernel', label: 'Linux', sub: [root ? root.val : null, con ? con : null].filter(Boolean).join(' · ') || 'command line empty' });
  } else if (S.sourced) chain.push({ k: 'script', label: 'boot script', sub: 'its own loads and boot' });
  else chain.push({ k: 'prompt', label: S.stopped === 'stop' ? 'reset' : 'U-Boot prompt', sub: 'no boot command reached' });

  // ----- values / tables / texts -----
  const values = [
    { label: 'Boot command', value: boot ? boot.cmd : 'none', hint: boot ? `from ${boot.var}` : `${entry} does not boot on this path`, tone: boot ? 'ok' : 'bad' },
    { label: 'Command line', value: cmdline.length, unit: 'chars', hint: `${chips.length} arguments; limit ${(CMDLINE_MAX[arch] || 1024) - 1}` },
    { label: 'Undefined variables', value: undef.filter((u) => !u.soft && !u.setBy.length).length, tone: undef.some((u) => !u.soft && !u.setBy.length) ? 'warn' : 'ok' },
    { label: 'Load map', value: map.bad ? `${map.bad} problem${map.bad > 1 ? 's' : ''}` : 'clear', tone: map.bad ? 'bad' : 'ok', hint: `${arch}, RAM ${hex(map.ramBase)} + ${human(map.ramSize)}` },
    { label: 'Env used', value: `${img.used} / ${img.dataSize}`, unit: 'bytes', tone: img.fits ? (img.used > img.dataSize * 0.8 ? 'warn' : 'ok') : 'bad', hint: `${hex(img.size)} image${img.red ? ', redundant' : ''}` },
    { label: 'Env CRC32', value: img.fits && img.size ? hex8(img.crc) : '–', hint: img.fits && img.size ? `stored little-endian: ${img.stored}` : 'image does not fit' },
  ];
  const tables = [];
  const steps = [];
  const walkSteps = (nodes, depth) => {
    for (const n of nodes || []) {
      if (n.k === 'run') { walkSteps(n.kids, depth); continue; }
      if (n.k === 'if') {
        const cl = n.clauses.find((c) => c.label === n.taken);
        for (const c of n.clauses) if (c.cond) walkSteps(c.cond, depth);
        steps.push([n.var, `if … → ${n.taken || 'no branch'}${n.pick ? ' (picked)' : ''}`, n.ifId]);
        if (cl && cl.body) walkSteps(cl.body, depth + 1);
        continue;
      }
      if (n.k !== 'cmd' || n.st === 'skipped') continue;
      if (['load', 'boot', 'args', 'fdt', 'script'].includes(n.cls) || n.st === 'fail' || n.cls === 'bad') steps.push([n.var, n.exp.length > 110 ? n.exp.slice(0, 110) + '…' : n.exp, n.st === 'fail' ? `failed: ${n.note}` : n.note || n.st]);
      if (n.kids) walkSteps(n.kids, depth + 1);
    }
  };
  if (sim.root) walkSteps([sim.root], 0);
  tables.push({ title: `Boot path from ${entry}`, columns: ['Variable', 'Command (expanded)', 'Result'], rows: steps.slice(0, 40) });
  if (chips.length) tables.push({ title: 'Kernel command line', columns: ['Argument', 'Meaning', 'From'], rows: chips.map((c) => [c.arg, c.what, [...(c.via || []), c.owner].filter((x, i, a) => a.indexOf(x) === i).join(' → ')]) });
  const mapRows = [...map.items, ...map.derived].map((x) => [x.label, hex8(x.addr), hex8(x.addr + x.size), human(x.size), x.var || x.from, x.used ? (x.derived ? 'derived' : 'loaded') : x.ok ? 'not used' : 'absent']);
  if (mapRows.length) tables.push({ title: 'Load map', columns: ['What', 'Start', 'End', 'Size', 'Address from', 'State'], rows: mapRows });

  const texts = [];
  texts.push({ title: 'Kernel command line', body: cmdline ? cmdline + '\n' : '(empty)\n' });
  const envText = env.order.map((n) => `${n}=${env.vars.get(n)}`).join('\n') + '\n';
  texts.push({ title: 'mkenvimage', body: `# ${img.fits && img.size ? `CRC32 ${hex8(img.crc)}, ${img.used}/${img.dataSize} bytes` : 'does not fit'}\n# mkenvimage -s ${hex(img.size)}${img.red ? ' -r' : ''} -o uboot.env uboot-env.txt   (uboot-env.txt below)\n# first bytes of uboot.env:\n${img.head.split('\n').map((l) => '#   ' + l).join('\n')}\n\n${envText}` });
  texts.push({ title: 'fw_env.config', body: fwcfg + '\n' });

  if (!notes.some((n) => /mkenvimage/.test(n))) notes.push('The image is laid out as mkenvimage writes it: the variables in the order given, NUL-separated, a double NUL at the end, 0xff after. U-Boot\'s saveenv writes them sorted by name, so its CRC differs - both are valid.');
  notes.push('Loads of kernel, DT, overlay and initrd files are assumed to succeed; boot scripts (boot.scr, uEnv.txt) are assumed absent. Pick the other branch of an "if" to follow the other path.');

  return {
    values, tables, texts, warnings: [...new Set(warnings)], notes: [...new Set(notes)],
    uboot: {
      entry, arch, scripts, picks: Object.fromEntries(picks), ifs: S.ifs,
      trace: sim.root, chain, chips, argsOwner: S.argsOwner, cmdline,
      vars, undef, map, image: { size: img.size, red: img.red, header: img.header, dataSize: img.dataSize, used: img.used, fits: img.fits, crc: img.crcHex, stored: img.stored, segs: img.segs },
      sizeLine: env.sizeLine, echoes: S.echoes,
    },
  };
}
