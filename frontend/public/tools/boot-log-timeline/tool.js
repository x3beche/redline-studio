// Boot Log Timeline: a boot log split into stages and laid on one time axis.
//
// What it reads (any mix, one paste):
//   - a serial console log: U-Boot SPL / U-Boot text, the U-Boot bootstage
//     report (CONFIG_BOOTSTAGE_REPORT, common/bootstage.c: "Timer summary in
//     microseconds", Mark / Elapsed / Stage in µs from reset), then the kernel
//     with printk times "[    1.234567]" (CONFIG_PRINTK_TIME / printk.time=1)
//   - host timestamps put on by the capture tool: grabserial "[1.234567 0.000100]"
//     or "HH:MM:SS.mmm " / "[HH:MM:SS.mmm]" - they time the bootloader too
//   - kernel initcall_debug lines (init/main.c do_one_initcall_debug):
//       "calling  fn+0x0/0x24 [mod] @ 1"
//       "initcall fn+0x0/0x24 [mod] returned 0 after 58 usecs"
//     and probe times (drivers/base/dd.c really_probe_debug):
//       "<dev>: probe with driver <drv> returned 0 after 211 usecs"  (5.9+)
//       "probe of <dev> returned 0 after 211 usecs"                  (older)
//   - systemd's own lines in the kernel log (systemd.log_target=kmsg) or in
//     `journalctl -b -o short-monotonic`: "Starting X..." / "Started X." /
//     "Finished X." / "Mounting X..." / "Mounted X." / "Reached target X."
//   - systemd-analyze time / critical-chain / blame output
//     (src/analyze: "@" = activating - userspace start, "+" = activation time)
//
// Time axis: milliseconds, 0 = the kernel's clock start (as dmesg counts);
// the bootloader and firmware sit before 0, as `systemd-analyze plot` draws.

const UNIT_RE = /\.(service|socket|target|mount|automount|device|swap|timer|path|slice|scope)$/;
const ERRNO = { '-1': 'EPERM', '-2': 'ENOENT', '-5': 'EIO', '-6': 'ENXIO', '-11': 'EAGAIN', '-12': 'ENOMEM', '-16': 'EBUSY',
  '-19': 'ENODEV', '-22': 'EINVAL', '-71': 'EPROTO', '-95': 'EOPNOTSUPP', '-110': 'ETIMEDOUT', '-121': 'EREMOTEIO', '-517': 'EPROBE_DEFER' };
// A driver that declines a device is not an error (dd.c treats -ENODEV and -ENXIO quietly).
const QUIET_ERR = new Set(['-19', '-6']);

// U-Boot bootstage record names (include/bootstage.h, common/board_f.c, board_r.c).
// Each segment ends at the named record, so it is "the time until X".
const BOOTSTAGE = {
  reset: 'Timer start',
  SPL: 'Boot ROM hands over, SPL starts',
  'end phase': 'SPL: DRAM training, loading U-Boot proper',
  'end SPL': 'SPL: DRAM training, loading U-Boot proper',
  board_init_f: 'U-Boot early init before relocation',
  board_init_r: 'U-Boot init after relocation: driver model, MMC, environment',
  eth_start: 'Network (Ethernet PHY) init',
  eth_init: 'Network (Ethernet PHY) init',
  main_loop: 'Reached the command loop',
  bootm_start: 'Autoboot delay, then bootcmd loading kernel and device tree',
  start_kernel: 'bootm: image checks, device-tree fix-ups, jump to the kernel',
  'id=15': 'bootm: checking the kernel image',
  'id=16': 'bootm: device tree',
};

const LANES = [
  ['loader', 'Bootloader'], ['kernel', 'Kernel'], ['initcall', 'Initcalls'],
  ['probe', 'Driver probes'], ['unit', 'Userspace'], ['mark', 'Milestones'],
];

const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const a = Math.abs(ms);
  if (a >= 60000) return `${Math.floor(ms / 60000)}min ${((a % 60000) / 1000).toFixed(1)}s`;
  if (a >= 1000) return `${(ms / 1000).toFixed(3)} s`;
  if (a >= 10) return `${Number(ms.toFixed(1))} ms`;
  return `${ms.toFixed(2)} ms`;
}

/** systemd timespan: "1min 2.345s", "345ms", "12us" -> ms, null when none. */
export function span(text) {
  const re = /(\d+(?:\.\d+)?)\s*(h|min|ms|us|µs|s)(?![A-Za-z])/g;
  let m, total = 0, any = false;
  const k = { h: 3600000, min: 60000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001 };
  while ((m = re.exec(String(text)))) { total += Number(m[1]) * k[m[2]]; any = true; }
  return any ? total : null;
}

function clean(s) {
  let t = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  for (let i = 0; i < 8 && /[^\x08]\x08/.test(t); i++) t = t.replace(/[^\x08]\x08/g, '');
  return t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

const HOST_GRAB = /^\[\s*(\d+\.\d+)\s+(\d+\.\d+)\]\s?/;
const HOST_CLOCK = /^\[?(\d{2}):(\d{2}):(\d{2})[.,](\d{3,6})\]?\s+/;
const KSTAMP = /^(?:<\d>)?\[\s*(\d+\.\d{3,9})\]\s?(?:\[\s*[TC]\d+\]\s?)?/;
const DMESG_X = /^\w+\s*:\s*\w+\s*:\s*/;

function explainErr(ret) {
  const n = ERRNO[String(ret)];
  if (ret === 0) return 'bound';
  if (ret === -517) return 'deferred: a resource it needs (clock, regulator, GPIO, PHY, panel) was not ready; it is retried later';
  if (QUIET_ERR.has(String(ret))) return `${n}: the driver declined the device (normal when hardware is absent)`;
  return `${n || 'error'} (${ret}): the probe failed`;
}

function gapCause(before, after) {
  const b = before || '', a = after || '';
  if (/Waiting for root device/.test(b)) return 'rootwait: the kernel waited for the root device to appear (storage probing or a slow card)';
  if (/link never came up|link.*(timeout|down)|Link up timeout/i.test(a)) return 'PCIe link training timed out: no card, or the link failed. Disable the PCIe node in the device tree if nothing is fitted';
  if (/crng init done/.test(a)) return 'the random pool was not ready (crng init): something waited for entropy';
  if (/Starting kernel/.test(b)) return 'from the handoff until the kernel\'s first line (decompression, early setup before the console)';
  if (/Hit any key to stop autoboot/.test(b)) return 'the U-Boot autoboot delay (bootdelay)';
  if (/bytes read|Loading|TFTP|tftp/.test(a)) return 'loading an image';
  if (/Link is Up/.test(a)) return 'waiting for the Ethernet link to come up (autonegotiation takes 1-3 s)';
  const dev = /^(?:\S+\s+)?([0-9a-f]{3,}\.[\w-]+|mmc\d|mmcblk\d|eth\d|i2c-\d+|\d+-00[0-9a-f]{2}):/.exec(a);
  if (dev) return `inside ${dev[1]}: nothing was logged until it finished`;
  if (/Hostname set to|Detected architecture|running in system mode/.test(b)) return 'systemd starting up: running generators and loading unit files';
  const u = /systemd\[1\]: (?:Started|Finished|Mounted) (.+?)\.$/.exec(a);
  if (u) return `userspace was waiting for "${u[1]}" to finish`;
  if (/systemd\[1\]: Reached target/.test(a)) return 'userspace was waiting for the units of the next target';
  return 'look at what the line after the gap finished';
}

export function run(input) {
  const text = String(input.log ?? '');
  const gapMs = num(input.gap, 250, 1, 600000);
  const topN = Math.round(num(input.top, 12, 1, 100));
  const warnings = [], notes = [];
  let rawLines = text.split('\n');
  if (rawLines.length > 30000) {
    warnings.push(`The log has ${rawLines.length} lines; only the first 30000 were read. Paste one boot at a time.`);
    rawLines = rawLines.slice(0, 30000);
  }
  // ---------- pass 1: stamps ----------
  const L = rawLines.map((raw, i) => {
    let body = clean(raw);
    let host = null, k = null;
    let m = HOST_GRAB.exec(body);
    if (m) { host = Number(m[1]); body = body.slice(m[0].length); } else if ((m = HOST_CLOCK.exec(body))) {
      host = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]);
      body = body.slice(m[0].length);
    }
    const dx = DMESG_X.exec(body);
    if (dx && KSTAMP.test(body.slice(dx[0].length))) body = body.slice(dx[0].length);
    m = KSTAMP.exec(body);
    if (m) { k = Number(m[1]); body = body.slice(m[0].length); }
    return { i, text: clean(raw), body, host, k, t: null };
  });
  const nonEmpty = L.filter((l) => l.text.trim()).length;
  const hostCount = L.filter((l) => l.host != null).length;
  const hostMode = hostCount >= 3 && hostCount >= nonEmpty * 0.5;
  if (!hostMode) for (const l of L) l.host = null;
  if (hostMode && L.some((l) => /^\d{2}:\d{2}:\d{2}/.test(l.text))) {
    // Clock-of-day stamps: count from the first one, across midnight.
    let base = null, prev = null, day = 0;
    for (const l of L) {
      if (l.host == null) continue;
      if (prev != null && l.host + day < prev - 43200) day += 86400;
      l.host += day; prev = l.host;
      if (base == null) base = l.host;
      l.host -= base;
    }
  }

  // A second boot in the same paste: stop at it.
  let firstK = L.findIndex((l) => l.k != null);
  let end = L.length;
  {
    let seenKernel = false, seenSpl = false, lastK = -1;
    for (const l of L) {
      if (/^U-Boot SPL \d/.test(l.body)) { if (seenSpl || seenKernel) { end = l.i; break; } seenSpl = true; }
      if (l.k != null) {
        if (seenKernel && l.k + 1 < lastK && /Booting Linux|Linux version \d/.test(l.body)) { end = l.i; break; }
        seenKernel = true; lastK = Math.max(lastK, l.k);
      }
    }
    if (end < L.length) warnings.push(`A second boot starts at line ${end + 1}; only the first one was read. Paste one boot at a time.`);
  }
  const lines = L.slice(0, end);
  firstK = lines.findIndex((l) => l.k != null);
  const handoffIdx = lines.findIndex((l) => /Starting kernel \.\.\./.test(l.body));
  const kernelIdx = firstK >= 0 ? firstK : handoffIdx >= 0 ? handoffIdx + 1 : lines.length;

  // host time of the kernel's clock zero: the least lag over all kernel lines
  // (early lines are buffered until the console registers, so they lag most).
  let K0 = null;
  if (hostMode) {
    for (const l of lines) if (l.host != null && l.k != null) K0 = K0 == null ? l.host - l.k : Math.min(K0, l.host - l.k);
    if (K0 == null && handoffIdx >= 0) K0 = lines[handoffIdx].host;
  }
  for (const l of lines) {
    if (l.k != null) l.t = l.k * 1000;
    else if (hostMode && l.host != null && K0 != null) l.t = (l.host - K0) * 1000;
  }

  const items = [];
  let nid = 0;
  const add = (it) => { it.id = `i${nid++}`; items.push(it); return it; };
  const sources = [];

  // ---------- bootloader ----------
  const findLine = (re, from = 0, to = kernelIdx) => { for (let i = from; i < Math.min(to, lines.length); i++) if (re.test(lines[i].body)) return i; return -1; };
  const splIdx = findLine(/^U-Boot SPL \d/);
  const ubootIdx = findLine(/^U-Boot 20\d\d/);
  const hitIdx = findLine(/Hit any key to stop autoboot/);
  const tableIdx = findLine(/Timer summary in microseconds/);
  let bootdelay = null;
  if (hitIdx >= 0) { const m = /autoboot:\s*(\d+)/.exec(lines[hitIdx].body); if (m) bootdelay = Number(m[1]); }
  let loaderMs = null, loaderSrc = null;
  const bootstage = [];
  const accumulated = [];
  if (tableIdx >= 0) {
    let i = tableIdx + 1;
    for (; i < lines.length; i++) {
      const b = lines[i].body;
      if (/^\s*Mark\s+Elapsed\s+Stage/.test(b)) continue;
      const m = /^\s*([\d,]+)\s+([\d,]+)\s+(\S.*?)\s*$/.exec(b);
      if (!m) break;
      bootstage.push({ mark: Number(m[1].replace(/,/g, '')), elapsed: Number(m[2].replace(/,/g, '')), name: m[3], line: i });
    }
    for (; i < lines.length && i < tableIdx + 80; i++) {
      if (/Accumulated time/.test(lines[i].body)) {
        for (let j = i + 1; j < lines.length; j++) {
          const m = /^\s+([\d,]+)\s+(\S.*?)\s*$/.exec(lines[j].body);
          if (!m) break;
          accumulated.push({ us: Number(m[1].replace(/,/g, '')), name: m[2] });
        }
        break;
      }
    }
  }
  const region = (name) => {
    // Which console lines a bootstage segment covers, roughly.
    const at = (a, b) => (a >= 0 ? [a, Math.max(a, (b >= 0 ? b : kernelIdx) - 1)] : null);
    if (/SPL|end phase/.test(name)) return at(splIdx, ubootIdx);
    if (/bootm|id=|start_kernel/.test(name)) return at(hitIdx >= 0 ? hitIdx : tableIdx, tableIdx);
    return at(ubootIdx, hitIdx >= 0 ? hitIdx : tableIdx);
  };
  if (bootstage.length >= 2) {
    const total = (bootstage.find((b) => b.name === 'start_kernel') || bootstage[bootstage.length - 1]).mark;
    loaderMs = total / 1000; loaderSrc = 'U-Boot bootstage report';
    sources.push('U-Boot bootstage report');
    let prev = 0;
    for (const b of bootstage) {
      if (b.mark <= prev && b.name === 'reset') continue;
      const dur = (b.mark - prev) / 1000;
      if (b.mark > total) break;
      const rg = region(b.name);
      const ls = [b.line];
      if (rg) for (let j = rg[0]; j <= rg[1] && ls.length < 60; j++) ls.push(j);
      let info = BOOTSTAGE[b.name] || (/^id=/.test(b.name) ? 'A numbered bootstage mark (include/bootstage.h)' : 'A bootstage mark');
      if (b.name === 'bootm_start' && bootdelay) info += `; includes the ${bootdelay} s autoboot delay`;
      add({ lane: 'loader', kind: 'stage', name: b.name, start: (prev - total) / 1000, dur, lines: [...new Set(ls)].sort((x, y) => x - y), focus: b.line, info });
      prev = b.mark;
    }
  } else if (hostMode && K0 != null) {
    const pts = [
      [splIdx, 'SPL', 'SPL: DRAM init, loading U-Boot proper'],
      [ubootIdx, 'U-Boot', 'U-Boot init: driver model, storage, environment, network'],
      [hitIdx, 'autoboot', 'Autoboot delay (bootdelay)'],
      [findLine(/bytes read in|## Loading|TFTP from server|Loading Kernel|Booting from (mmc|nand|spi)|reading \S+/), 'load', 'bootcmd: loading kernel, device tree, initramfs'],
      [findLine(/## Flattened Device Tree|Booting using the fdt/), 'bootm', 'bootm: image checks, device-tree fix-ups'],
      [handoffIdx, 'handoff', 'From "Starting kernel" to the kernel clock start (decompression, early setup)'],
    ].filter(([i]) => i >= 0 && lines[i].t != null).sort((a, b) => a[0] - b[0]);
    const first = pts.length ? pts[0][0] : -1;
    if (first >= 0) {
      loaderMs = -lines[first].t; loaderSrc = 'host timestamps';
      sources.push('host timestamps (capture tool)');
      pts.forEach(([i, name, info], n) => {
        const nextI = n + 1 < pts.length ? pts[n + 1][0] : kernelIdx;
        const t1 = n + 1 < pts.length ? lines[nextI].t : 0;
        const ls = []; for (let j = i; j < nextI && ls.length < 60; j++) ls.push(j);
        add({ lane: 'loader', kind: 'stage', name, start: lines[i].t, dur: Math.max(0, t1 - lines[i].t), lines: ls, focus: i, info });
      });
    }
  }
  const hasLoaderText = splIdx >= 0 || ubootIdx >= 0 || handoffIdx >= 0;
  if (hasLoaderText) sources.unshift('U-Boot console');
  if (hasLoaderText && loaderMs == null) {
    notes.push('The bootloader has no times in this log. Build U-Boot with CONFIG_BOOTSTAGE=y and CONFIG_BOOTSTAGE_REPORT=y, or capture the console with host timestamps (grabserial -t), to time it.');
  }
  if (bootdelay) {
    warnings.push(`U-Boot waits ${bootdelay} s for a key before booting (bootdelay=${bootdelay}). For production set bootdelay=0 (keys are still checked once) or CONFIG_BOOTDELAY=-2 (no check at all).`);
  }

  // ---------- kernel ----------
  const timed = (i) => lines[i] && lines[i].t != null;
  const kLines = lines.filter((l) => l.k != null);
  if (kLines.length) sources.push('kernel log');
  const kfind = (re) => { for (let i = kernelIdx; i < lines.length; i++) if (timed(i) && re.test(lines[i].body)) return i; return -1; };
  const cmdIdx = kfind(/Kernel command line:/);
  const cmdline = cmdIdx >= 0 ? lines[cmdIdx].body.replace(/^.*Kernel command line:\s*/, '') : '';
  const pSmp = kfind(/smp: Brought up|SMP: Total of \d+ processors/);
  const pWait = kfind(/Waiting for root device|Waiting \d+ ?sec before mounting root/);
  const pRoot = kfind(/VFS: Mounted root|Mounted root \(/);
  let pInit = kfind(/Run \S+ as init process/);
  if (pInit < 0) pInit = kfind(/Freeing unused kernel (memory|image)/);
  const pSystemd = kfind(/systemd\[1\]: systemd \d+/);
  const kernelStartIdx = kLines.length ? kLines[0].i : -1;
  if (kernelStartIdx >= 0) {
    const pts = [[kernelStartIdx, 'early setup', 'setup_arch, memory, interrupts, timers, bringing up the other CPUs']];
    if (pSmp >= 0) pts.push([pSmp, 'initcalls', 'do_initcalls: built-in drivers and subsystems initialise and probe']);
    if (pWait >= 0) pts.push([pWait, 'rootwait', 'Waiting for the root device to appear (rootwait)']);
    if (pRoot >= 0) pts.push([pRoot, 'root mounted', 'Root file system mounted; freeing init memory and starting init']);
    if (pInit >= 0) pts.push([pInit, 'init', '']);
    pts.sort((a, b) => a[0] - b[0]);
    for (let n = 0; n + 1 < pts.length; n++) {
      const [i, name, info] = pts[n], j = pts[n + 1][0];
      const t0 = n === 0 ? 0 : lines[i].t;
      const ls = [i, j];
      add({ lane: 'kernel', kind: 'phase', name, start: t0, dur: Math.max(0, lines[j].t - t0), lines: ls, focus: i, info });
    }
    add({ lane: 'mark', kind: 'mark', name: 'kernel start', start: 0, dur: 0, lines: [kernelStartIdx], focus: kernelStartIdx, info: 'The kernel clock starts; dmesg times count from here.' });
    if (pSmp >= 0) add({ lane: 'mark', kind: 'mark', name: 'CPUs up', start: lines[pSmp].t, dur: 0, lines: [pSmp], focus: pSmp, info: lines[pSmp].body });
    if (pRoot >= 0) add({ lane: 'mark', kind: 'mark', name: 'root mounted', start: lines[pRoot].t, dur: 0, lines: [pRoot], focus: pRoot, info: lines[pRoot].body });
    if (pInit >= 0) add({ lane: 'mark', kind: 'mark', name: 'init', start: lines[pInit].t, dur: 0, lines: [pInit], focus: pInit, info: 'The kernel runs the first userspace program.' });
  }

  // initcalls and probes
  const CALL = /calling\s+([\w.$]+?)(?:\+0x[0-9a-f]+\/0x[0-9a-f]+)?(?:\s+\[([\w-]+)\])?\s+@\s+(\d+)/;
  const RET = /initcall\s+([\w.$]+?)(?:\+0x[0-9a-f]+\/0x[0-9a-f]+)?(?:\s+\[([\w-]+)\])?\s+returned\s+(-?\d+)\s+after\s+(\d+)\s+(usecs|msecs)/;
  const PROBE_NEW = /^(?:(\S+)\s+)?(\S+?):\s+probe with driver (\S+) returned (-?\d+) after (\d+) usecs/;
  const PROBE_OLD = /probe of (\S+) returned (-?\d+) after (\d+) usecs/;
  const pending = new Map();
  let nInit = 0, nProbe = 0, nDeferred = 0;
  const failed = [];
  for (let i = kernelIdx; i < lines.length; i++) {
    const l = lines[i];
    if (l.t == null) continue;
    let m = CALL.exec(l.body);
    if (m && !/^initcall/.test(l.body.trim())) { pending.set(m[1] + '|' + (m[2] || ''), i); continue; }
    if ((m = RET.exec(l.body))) {
      const key = m[1] + '|' + (m[2] || '');
      const dur = Number(m[4]) / (m[5] === 'msecs' ? 1 : 1000);
      const ci = pending.has(key) ? pending.get(key) : -1;
      pending.delete(key);
      const start = ci >= 0 ? lines[ci].t : l.t - dur;
      const ls = []; if (ci >= 0) for (let j = ci; j <= i && ls.length < 120; j++) ls.push(j); else ls.push(i);
      const ret = Number(m[3]);
      nInit++;
      add({ lane: 'initcall', kind: 'initcall', name: m[1] + (m[2] ? ` [${m[2]}]` : ''), start, dur, lines: ls, focus: i, ret,
        tone: ret !== 0 && !QUIET_ERR.has(String(ret)) ? 'bad' : null,
        info: `${m[1]}()${m[2] ? ` in module ${m[2]}` : ' (built in)'}, run by do_initcalls with initcall_debug; returned ${ret}${ret ? ` (${ERRNO[String(ret)] || 'error'})` : ''}.${dur > 100 ? ' A slow initcall is usually a driver probing hardware synchronously: see the probes inside it.' : ''}` });
      if (ret !== 0 && !QUIET_ERR.has(String(ret))) failed.push(`initcall ${m[1]} returned ${ret}`);
      continue;
    }
    let dev = null, drv = null, ret = null, us = null;
    if ((m = PROBE_NEW.exec(l.body))) { dev = m[2]; drv = m[3]; ret = Number(m[4]); us = Number(m[5]); } else if ((m = PROBE_OLD.exec(l.body))) { dev = m[1]; ret = Number(m[2]); us = Number(m[3]); }
    if (dev != null) {
      const dur = us / 1000, start = l.t - dur;
      const ls = [];
      for (let j = i - 1; j >= kernelIdx && ls.length < 60; j--) {
        const lj = lines[j];
        if (lj.t != null && lj.t < start - 0.5) break;
        if (lj.body.includes(dev + ':') || lj.body.includes(dev + ' ')) ls.push(j);
      }
      ls.reverse(); ls.push(i);
      nProbe++;
      if (ret === -517) nDeferred++;
      const bad = ret !== 0 && ret !== -517 && !QUIET_ERR.has(String(ret));
      if (bad) failed.push(`${drv || 'driver'} on ${dev} returned ${ret} (${ERRNO[String(ret)] || 'error'})`);
      add({ lane: 'probe', kind: 'probe', name: `${dev}${drv ? ` (${drv})` : ''}`, start, dur, lines: ls, focus: i, ret,
        tone: bad ? 'bad' : ret === -517 ? 'warn' : null, info: `${drv ? `Driver ${drv} probing ${dev}` : `Probe of ${dev}`}: ${explainErr(ret)}.` });
    }
  }
  for (const [key, ci] of pending) {
    const name = key.split('|')[0];
    notes.push(`initcall ${name} (line ${ci + 1}) has no "returned" line: it was still running when the log ends, or its line was lost.`);
  }
  const deferredPending = lines.filter((l) => /deferred probe pending/.test(l.body));
  if (deferredPending.length) warnings.push(`${deferredPending.length} device(s) never probed ("deferred probe pending"), e.g. ${cut(deferredPending[0].body.trim(), 90)}. A resource they need never appeared: check the device tree references and that the supplier's driver is built.`);
  if (kLines.length && !nInit && !/initcall_debug/.test(cmdline)) notes.push('No initcall_debug lines: add initcall_debug to the kernel command line (with loglevel=8, or ignore_loglevel) to time every initcall and driver probe.');

  // ---------- userspace ----------
  const OPEN = /^(Starting|Mounting|Activating|Loading) (.+?)\.\.\.$/;
  const CLOSE = /^(Started|Finished|Mounted|Activated|Loaded) (.+?)\.$/;
  const FAIL = /^Failed to (?:start|mount|activate) (.+?)\.$/;
  const unitName = (desc) => { const m = /^(\S+?\.(?:service|socket|target|mount|automount|device|swap|timer|path|slice|scope)) - (.+)$/.exec(desc); return m ? { unit: m[1], desc: m[2] } : { unit: null, desc }; };
  const opened = new Map();
  let nUnits = 0, userStart = null, targetEnd = null, lastUnitEnd = null, finished = null;
  const failedUnits = [];
  const unitItems = [];
  const sysLines = new Set();
  for (let i = kernelIdx; i < lines.length; i++) {
    const l = lines[i];
    let body = null;
    const sm = /systemd\[1\]:\s?(.*)$/.exec(l.body);
    if (sm) body = sm[1].trim();
    else {
      const st = /^\[\s*(OK|FAILED|DEPEND|TIME|\*+)\s*\]\s+(.*)$/.exec(l.body.trim());
      if (st) body = (st[1] === 'FAILED' ? st[2] : st[2]).trim();
      else if (/^\s+Starting .+\.\.\.$|^\s+Mounting .+\.\.\.$/.test(l.body)) body = l.body.trim();
    }
    if (body == null) continue;
    sysLines.add(i);
    if (l.t == null) continue;
    let m;
    if (/^systemd \d+/.test(body) && userStart == null) {
      userStart = l.t;
      add({ lane: 'mark', kind: 'mark', name: 'systemd', start: l.t, dur: 0, lines: [i], focus: i, info: cut(body, 120) });
      continue;
    }
    if ((m = /Startup finished in (.+?) = (.+?)\.?\s*$/.exec(body))) { finished = { i, parts: m[1], total: span(m[2]) }; continue; }
    if ((m = OPEN.exec(body))) { opened.set(m[2], { i, t: l.t, verb: m[1] }); continue; }
    if ((m = CLOSE.exec(body)) || (m = FAIL.exec(body))) {
      const isFail = FAIL.test(body);
      const desc = isFail ? m[1] : m[2];
      const o = opened.get(desc);
      opened.delete(desc);
      const { unit, desc: d } = unitName(desc);
      const start = o ? o.t : l.t;
      const ls = o ? [o.i, i] : [i];
      nUnits++;
      const it = add({ lane: 'unit', kind: 'unit', name: unit || d, start, dur: Math.max(0, l.t - start), lines: ls, focus: i, point: !o,
        tone: isFail ? 'bad' : null,
        info: isFail ? `${unit || d} failed to start. See journalctl -b -u <unit> for why.`
          : o ? `${unit ? unit + ': ' : ''}${d}. From "${o.verb}" to "${m[1]}".` : `${unit ? unit + ': ' : ''}${d}. Only its "${m[1]}" line is in the log, so it is drawn as a point.` });
      unitItems.push(it);
      if (isFail) failedUnits.push(unit || d);
      lastUnitEnd = Math.max(lastUnitEnd ?? -Infinity, l.t);
      continue;
    }
    if ((m = /^Reached target (.+?)\.$/.exec(body))) {
      const { unit, desc: d } = unitName(m[1]);
      const name = unit || d;
      add({ lane: 'mark', kind: 'target', name, start: l.t, dur: 0, lines: [i], focus: i, info: `Target reached: ${d}.` });
      if (/Multi-User|Graphical|multi-user\.target|graphical\.target/.test(m[1])) targetEnd = l.t;
      continue;
    }
    if (/Timed out waiting for device|Dependency failed for|start operation timed out|Failed with result/i.test(body)) {
      warnings.push(`systemd, line ${i + 1}: ${cut(body, 110)}`);
    }
  }
  if (unitItems.length || userStart != null) sources.push('systemd');
  let lastT = null;
  for (const l of lines) if (l.t != null) lastT = Math.max(lastT ?? -Infinity, l.t);
  for (const [desc, o] of opened) {
    const { unit, desc: d } = unitName(desc);
    const endT = Math.max(o.t, lastT ?? o.t);
    const it = add({ lane: 'unit', kind: 'unit', name: unit || d, start: o.t, dur: endT - o.t, lines: [o.i], focus: o.i, open: true, tone: 'warn',
      info: `${unit ? unit + ': ' : ''}${d}. "${o.verb}" with no end in the log: still running when the log ends (drawn to the last line).` });
    unitItems.push(it);
  }
  if (failedUnits.length) warnings.push(`Failed unit(s): ${failedUnits.slice(0, 5).join(', ')}. Run journalctl -b -u <unit> on the target to see why.`);

  // login prompt
  const loginIdx = lines.findIndex((l, i) => i >= kernelIdx && /\blogin:\s*$/.test(l.body));
  if (loginIdx >= 0) {
    let t = lines[loginIdx].t, approx = false;
    if (t == null) { for (let j = loginIdx; j >= 0; j--) if (lines[j].t != null) { t = lines[j].t; break; } approx = true; }
    if (t != null) add({ lane: 'mark', kind: 'mark', name: 'login prompt', start: t, dur: 0, lines: [loginIdx], focus: loginIdx, approx,
      info: approx ? 'The getty writes to the console directly, without a kernel time; placed at the last timed line before it.' : 'The login prompt appeared.' });
  }

  // ---------- systemd-analyze output ----------
  let analyze = null;
  const chain = [], blame = [];
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].body;
    let m;
    if ((m = /Startup finished in (.+?) = (.+?)\.?\s*$/.exec(b)) && !finished) finished = { i, parts: m[1], total: span(m[2]) };
    if ((m = /^(\S+\.target) reached after (.+?) in userspace/.exec(b.trim()))) analyze = { ...(analyze || {}), reached: { name: m[1], ms: span(m[2]), i } };
    const s = b.replace(/^[\s│├└─|]+/, '').replace(/^`-/, '');
    if (lines[i].k == null && (m = /^(\S+) @(\d[^+]*?)(?: \+(\d.*?))?\s*$/.exec(s)) && UNIT_RE.test(m[1])) {
      const at = span(m[2]), dur = m[3] ? span(m[3]) : null;
      if (at != null) chain.push({ name: m[1], at, dur, i });
      continue;
    }
    if (lines[i].k == null && (m = /^\s*((?:\d+(?:\.\d+)?(?:h|min|ms|us|µs|s)\s?)+)\s+(\S+)\s*$/.exec(b)) && UNIT_RE.test(m[2])) {
      const d = span(m[1]); if (d != null) blame.push({ name: m[2], dur: d, i });
    }
  }
  const stageTimes = {};
  if (finished) {
    for (const part of finished.parts.split(/\s\+\s/)) {
      const m = /^(.+?)\s*\((\w+)\)$/.exec(part.trim());
      if (m) { const v = span(m[1]); if (v != null) stageTimes[m[2]] = v; }
    }
    if (!sources.includes('systemd')) sources.push('systemd-analyze time');
  }
  const kernelDur = stageTimes.kernel ?? (pInit >= 0 ? lines[pInit].t : userStart);
  const initrdDur = stageTimes.initrd ?? 0;
  const U0 = kernelDur != null ? kernelDur + initrdDur : null;
  if ((chain.length || blame.length) && unitItems.length === 0) {
    sources.push(chain.length ? 'systemd-analyze critical-chain' : 'systemd-analyze blame');
    const base = U0 ?? 0;
    if (U0 == null) notes.push('No kernel time given: the units are placed from userspace start = 0. Paste `systemd-analyze time` too.');
    const byName = new Map();
    for (const c of chain) {
      if (/\.target$/.test(c.name) || c.dur == null) {
        add({ lane: 'mark', kind: 'target', name: c.name, start: base + c.at, dur: 0, lines: [c.i], focus: c.i, info: `${c.name} active at @${fmtMs(c.at)} in userspace (critical-chain).` });
        continue;
      }
      byName.set(c.name, c);
    }
    for (const c of byName.values()) {
      const bl = blame.find((b) => b.name === c.name);
      const ls = bl ? [c.i, bl.i] : [c.i];
      unitItems.push(add({ lane: 'unit', kind: 'unit', name: c.name, start: base + c.at, dur: c.dur, lines: ls, focus: c.i, critical: true,
        info: `${c.name}: on the critical chain, started at @${fmtMs(c.at)} after userspace start and took ${fmtMs(c.dur)} to activate.` }));
    }
    let approxN = 0;
    for (const b of blame) {
      if (byName.has(b.name)) continue;
      approxN++;
      unitItems.push(add({ lane: 'unit', kind: 'unit', name: b.name, start: base, dur: b.dur, lines: [b.i], focus: b.i, approx: true,
        info: `${b.name}: took ${fmtMs(b.dur)} (blame). blame gives no start time, so it is drawn from userspace start.` }));
    }
    if (approxN) notes.push(`${approxN} unit(s) from blame have no start time and are drawn from userspace start (hatched). \`systemd-analyze plot > boot.svg\` or critical-chain gives start times.`);
    if (analyze && analyze.reached && U0 != null) {
      const r = analyze.reached;
      add({ lane: 'mark', kind: 'target', name: r.name, start: U0 + r.ms, dur: 0, lines: [r.i], focus: r.i, info: `${r.name} reached ${fmtMs(r.ms)} after userspace start.` });
      targetEnd = U0 + r.ms;
    }
    for (const u of unitItems) lastUnitEnd = Math.max(lastUnitEnd ?? -Infinity, u.start + u.dur);
  } else if (chain.length || blame.length) {
    notes.push('systemd-analyze critical-chain / blame were ignored: the log already has the units with their times.');
  }

  // Known slow units (the usual suspects on embedded boots).
  const SUSPECTS = [
    [/wait-online|Wait for Network/i, 'This unit only waits for a network to be configured. Only units that really need the network should pull in network-online.target; otherwise limit it (--any, --interface=, --timeout=) or disable it.'],
    [/udev-settle|Wait for udev To Complete/i, 'systemd-udev-settle is deprecated and holds the boot until every device event is done. Find what pulls it in (systemctl list-dependencies --reverse systemd-udev-settle.service) and drop it.'],
    [/ssh.*keygen|Key Generation/i, 'Host keys are generated on the first boot only. Bake keys into the image, or ignore it after the first boot.'],
    [/plymouth/i, 'A boot splash. Remove it if there is no display.'],
    [/fsck/i, 'A file-system check. A journalled ext4 or read-only root rarely needs it at every boot.'],
  ];
  for (const u of unitItems) {
    if (u.dur < 500) continue;
    const s = SUSPECTS.find(([re]) => re.test(u.name));
    if (s) warnings.push(`${u.name} took ${fmtMs(u.dur)}. ${s[1]}`);
  }

  // ---------- stages ----------
  const userEnd = stageTimes.userspace != null && U0 != null ? U0 + stageTimes.userspace
    : targetEnd ?? lastUnitEnd ?? (loginIdx >= 0 ? items.find((x) => x.name === 'login prompt')?.start : null) ?? null;
  const stages = [];
  const loaderFinal = stageTimes.loader ?? loaderMs;
  if (stageTimes.firmware != null) stages.push({ id: 'firmware', name: 'Firmware', from: -(loaderFinal ?? 0) - stageTimes.firmware, dur: stageTimes.firmware, src: 'systemd-analyze time' });
  if (loaderFinal != null) stages.push({ id: 'loader', name: 'Bootloader', from: -loaderFinal, dur: loaderFinal, src: stageTimes.loader != null ? 'systemd-analyze time' : loaderSrc });
  if (kernelDur != null) stages.push({ id: 'kernel', name: 'Kernel', from: 0, dur: kernelDur, src: stageTimes.kernel != null ? 'systemd "Startup finished"' : pInit >= 0 ? 'kernel log (until init runs)' : 'kernel log' });
  else if (kLines.length) {
    const last = kLines[kLines.length - 1].t;
    stages.push({ id: 'kernel', name: 'Kernel', from: 0, dur: last, src: 'kernel log (no init line: until the last kernel line)', partial: true });
  }
  if (initrdDur) stages.push({ id: 'initrd', name: 'initrd', from: kernelDur, dur: initrdDur, src: 'systemd-analyze time' });
  if (U0 != null && userEnd != null && userEnd > U0) stages.push({ id: 'userspace', name: 'Userspace', from: U0, dur: userEnd - U0, src: stageTimes.userspace != null ? 'systemd "Startup finished"' : targetEnd != null ? 'until multi-user/graphical target' : 'until the last unit' });
  for (const s of stages) { s.from = r3(s.from); s.dur = r3(s.dur); }
  const sum = stages.reduce((a, s) => a + s.dur, 0);
  // systemd prints its own rounded total; use it when every stage came from that line.
  const total = finished && finished.total != null && stages.every((s) => /systemd/.test(s.src)) ? finished.total : sum;

  // ---------- gaps ----------
  const deltas = [];
  const gaps = [];
  // Measured from the latest time seen so far: early kernel lines are printed
  // late (buffered until the console registers), so the log is not monotonic.
  let prevI = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t == null) continue;
    if (prevI >= 0) {
      const dt = lines[i].t - lines[prevI].t;
      if (dt <= 0) continue;
      if (dt >= 0.5) deltas.push([r3(lines[prevI].t), r3(dt), prevI, i]);
      if (dt >= gapMs) gaps.push({ id: `g${gaps.length}`, from: lines[prevI].t, to: lines[i].t, dur: dt, before: prevI, after: i, cause: gapCause(lines[prevI].body, lines[i].body) });
    }
    prevI = i;
  }
  gaps.sort((a, b) => b.dur - a.dur);
  for (const g of gaps.slice(0, 3)) {
    warnings.push(`${fmtMs(g.dur)} with nothing logged at ${fmtMs(g.from)} (lines ${g.before + 1}-${g.after + 1}): ${g.cause}.`);
  }
  const failedProbes = failed.filter((f) => !/^initcall/.test(f));
  if (failedProbes.length) warnings.push(`Failed probe(s): ${failedProbes.slice(0, 4).join('; ')}. Check the device tree node and the hardware; disable nodes for parts that are not fitted.`);

  // console printing cost
  const quiet = /(^|\s)quiet(\s|$)|loglevel=[0-4]\b/.test(cmdline);
  const baud = Number((/console=tty\w+,(\d+)/.exec(cmdline) || [])[1]) || null;
  if (baud && !quiet && pInit >= 0) {
    let chars = 0;
    for (let i = kernelStartIdx; i <= pInit; i++) chars += lines[i].body.length + (lines[i].k != null ? 15 : 0) + 2; // "[    1.234567] " + CR LF
    const ms = (chars * 10 / baud) * 1000;
    if (ms > 50) notes.push(`The kernel wrote about ${chars} characters to a ${baud} baud console before init: up to ${fmtMs(ms)} if every line reached it (printk to a serial console waits for the UART). \`quiet\` or loglevel=3 on the command line removes most of it.`);
  }

  // ---------- lanes, rows ----------
  const laneRows = {};
  const laneOf = LANES.map(([id]) => id);
  for (const id of laneOf) {
    const its = items.filter((x) => x.lane === id).sort((a, b) => a.start - b.start || b.dur - a.dur);
    const ends = [];
    for (const it of its) {
      if (id === 'mark' || id === 'loader' || id === 'kernel') { it.row = 0; continue; }
      const e = it.start + Math.max(it.dur, 0.001);
      let r = ends.findIndex((x) => x <= it.start + 1e-6);
      if (r < 0) { r = ends.length; ends.push(e); } else ends[r] = e;
      it.row = r;
    }
    laneRows[id] = id === 'mark' || id === 'loader' || id === 'kernel' ? (its.length ? 1 : 0) : ends.length;
  }
  const lanes = LANES.filter(([id]) => laneRows[id] > 0).map(([id, label]) => ({ id, label, rows: laneRows[id] }));

  // which item owns a line (the most specific one) and which lane a line is in
  const lineItem = new Array(lines.length).fill(null);
  const order = ['kernel', 'loader', 'mark', 'unit', 'initcall', 'probe'];
  for (const lane of order) for (const it of items) if (it.lane === lane) for (const j of it.lines) lineItem[j] = it.id;
  const lineLane = lines.map((l, i) => {
    if (i < kernelIdx) return /^(Timer summary|\s+Mark|\s*[\d,]+\s+[\d,]+\s+\S)/.test(l.body) && tableIdx >= 0 && i >= tableIdx ? 'loader' : l.body.trim() ? 'loader' : '';
    if (sysLines.has(i)) return 'unit';
    if (l.k != null) return 'kernel';
    return '';
  });

  // ---------- range ----------
  let lo = Infinity, hi = -Infinity;
  for (const it of items) { lo = Math.min(lo, it.start); hi = Math.max(hi, it.start + it.dur); }
  for (const s of stages) { lo = Math.min(lo, s.from); hi = Math.max(hi, s.from + s.dur); }
  if (lastT != null) hi = Math.max(hi, lastT);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1000; }
  if (!(hi > lo)) hi = lo + 1000;

  // ---------- result ----------
  const slow = items.filter((x) => ['stage', 'initcall', 'probe', 'unit'].includes(x.kind) && x.dur > 0 && !x.point)
    .sort((a, b) => b.dur - a.dur).slice(0, topN);
  const laneLabel = Object.fromEntries(LANES);
  const timedN = lines.filter((l) => l.t != null).length;
  if (!items.length && !stages.length) {
    warnings.unshift('Nothing with a time was found. Paste a console or dmesg log with printk times ("[    1.234567]"), journalctl -o short-monotonic output, or systemd-analyze time / blame / critical-chain.');
  }
  if (!sources.length) sources.push('nothing recognised');
  const stageVal = (id) => stages.find((s) => s.id === id);
  const values = [
    { label: 'Total boot', value: total > 0 ? fmtMs(total) : '–', hint: stages.map((s) => s.name.toLowerCase()).join(' + ') || 'no stages found' },
  ];
  for (const id of ['firmware', 'loader', 'kernel', 'initrd', 'userspace']) {
    const s = stageVal(id);
    if (s) values.push({ label: s.name, value: fmtMs(s.dur), hint: s.src });
  }
  if (slow[0]) values.push({ label: 'Slowest item', value: fmtMs(slow[0].dur), hint: `${cut(slow[0].name, 48)} (${laneLabel[slow[0].lane]})`, tone: slow[0].dur >= 1000 ? 'warn' : null });
  values.push({ label: `Gaps ≥ ${fmtMs(gapMs)}`, value: gaps.length, hint: gaps[0] ? `largest ${fmtMs(gaps[0].dur)} at ${fmtMs(gaps[0].from)}` : 'no silent stretch that long', tone: gaps.length ? 'warn' : 'ok' });
  values.push({ label: 'Read', value: `${lines.length} lines`, hint: `${timedN} with a time; ${nInit} initcalls, ${nProbe} probes${nDeferred ? ` (${nDeferred} deferred)` : ''}, ${nUnits + (chain.length || blame.length ? unitItems.length - nUnits : 0)} units` });

  const tables = [
    { title: `Slowest ${slow.length}`, columns: ['#', 'Item', 'Lane', 'Start (s)', 'Duration (ms)', 'Note'],
      rows: slow.map((x, n) => [n + 1, cut(x.name, 60), laneLabel[x.lane], r3(x.start / 1000), r1(x.dur),
        x.tone === 'bad' ? 'failed' : x.ret === -517 ? 'deferred' : x.approx ? 'start unknown' : x.open ? 'no end in log' : '']) },
  ];
  if (gaps.length) tables.push({ title: `Silent gaps ≥ ${fmtMs(gapMs)}`, columns: ['From (s)', 'Gap (ms)', 'Last line before', 'First line after', 'Likely cause'],
    rows: gaps.slice(0, 10).map((g) => [r3(g.from / 1000), r1(g.dur), cut(lines[g.before].body.trim(), 70), cut(lines[g.after].body.trim(), 70), g.cause]) });
  if (stages.length) tables.push({ title: 'Stages', columns: ['Stage', 'From (s)', 'Duration (ms)', 'Share', 'From what'],
    rows: stages.map((s) => [s.name, r3(s.from / 1000), r1(s.dur), total > 0 ? `${Math.round((s.dur / total) * 100)}%` : '–', s.src]) });

  const summary = [];
  if (stages.length) {
    summary.push(`Boot: ${stages.map((s) => `${fmtMs(s.dur)} (${s.name.toLowerCase()})`).join(' + ')} = ${fmtMs(total)}`);
  }
  if (cmdline) summary.push(`Kernel command line: ${cmdline}`);
  summary.push(`Read as: ${sources.join(', ')}`, '');
  if (slow.length) {
    summary.push('Slowest:');
    for (const x of slow) summary.push(`  ${fmtMs(x.dur).padStart(11)}  ${laneLabel[x.lane].padEnd(13)} ${x.name}${x.tone === 'bad' ? '  [failed]' : ''}`);
    summary.push('');
  }
  if (gaps.length) {
    summary.push(`Silent gaps ≥ ${fmtMs(gapMs)}:`);
    for (const g of gaps.slice(0, 10)) summary.push(`  ${fmtMs(g.dur).padStart(11)}  at ${fmtMs(g.from)}: ${g.cause}`);
  }
  const next = [
    '# Kernel: time every initcall and driver probe',
    '#   bootargs: initcall_debug printk.time=1 loglevel=8   (or ignore_loglevel)',
    '#   or, on the target:  dmesg | grep -E "initcall|probe with driver" | sort -t" " -k8 -n',
    '#   scripts/bootgraph.pl < dmesg.txt > boot.svg   (in the kernel tree)',
    '',
    '# Userspace (systemd)',
    'systemd-analyze time',
    'systemd-analyze blame',
    'systemd-analyze critical-chain',
    'systemd-analyze plot > boot.svg',
    'journalctl -b -o short-monotonic --no-pager > boot.txt   # paste this here',
    '',
    '# Bootloader (U-Boot)',
    '#   CONFIG_BOOTSTAGE=y CONFIG_BOOTSTAGE_REPORT=y  -> the report prints before "Starting kernel"',
    '#   or time the whole console from the host:',
    'grabserial -d /dev/ttyUSB0 -b 115200 -t -m "U-Boot SPL" -q "login:" -o boot.txt',
  ];

  return {
    values,
    tables,
    texts: [{ title: 'Summary', body: summary.join('\n').trim() + '\n' }, { title: 'Next steps', body: next.join('\n') + '\n', lang: 'sh' }],
    warnings,
    notes,
    timeline: {
      lanes,
      items: items.map((x) => ({ id: x.id, lane: x.lane, row: x.row ?? 0, kind: x.kind, name: x.name, start: r3(x.start), dur: r3(x.dur),
        lines: x.lines, focus: x.focus, info: x.info, tone: x.tone || null, point: !!x.point, approx: !!x.approx, open: !!x.open, critical: !!x.critical })),
      gaps: gaps.map((g) => ({ ...g, from: r3(g.from), to: r3(g.to), dur: r3(g.dur) })),
      deltas,
      stages,
      total: r3(total),
      range: [r3(lo), r3(hi)],
      lines: lines.map((l) => l.text),
      times: lines.map((l) => (l.t == null ? null : r3(l.t))),
      lineItem,
      lineLane,
      slow: slow.map((x) => x.id),
      gapMs,
      sources,
    },
  };
}
