// OTA A/B Update Planner: the storage with its A/B slots, the update's state
// machine step by step with the boot-counting variables each actor writes,
// and the configuration files for RAUC, SWUpdate or Mender on U-Boot, GRUB
// or barebox.
//
// What each combination does, from the projects' documentation (the files
// below are written here from that description, not copied):
//   RAUC       docs "Integration" and "Reference": system.conf [system]
//              compatible/bootloader, [slot.<class>.<n>] device/type/bootname;
//              U-Boot: BOOT_ORDER and BOOT_<name>_LEFT, the boot script picks
//              the first slot with tries left and decrements it; `rauc status
//              mark-good` resets the booted slot's counter. GRUB: ORDER,
//              <name>_OK, <name>_TRY (one try per slot). barebox: bootchooser
//              with the state framework (priority, remaining_attempts).
//   SWUpdate   docs "sw-description" (libconfig, software collections
//              selected with -e, bootenv:) and "Bootloader interface";
//              U-Boot's boot count: doc/README.bootcount / CONFIG_BOOTCOUNT_ENV
//              (bootcount is counted only while upgrade_available=1, and
//              altbootcmd runs once bootcount > bootlimit).
//   Mender     docs "Yocto Project" variables (MENDER_STORAGE_*,
//              MENDER_*_PART_SIZE_MB, MENDER_PARTITION_ALIGNMENT) and the
//              U-Boot/GRUB integration (mender_boot_part, upgrade_available,
//              bootcount, bootlimit=1); `mender commit` confirms.

const MAX_FAIL_STEPS = 10;   // attempts drawn one by one before they are summed

// ---------------- sizes ----------------
/** "8M" "1.5G" "512K" "0x400000" (bytes) "7456" (MiB) -> MiB; "*" / "rest" -> 'rest'; null if unreadable. */
export function mib(v) {
  const t = String(v ?? '').trim().replace(/\s+/g, '').replace(/i?B$/i, '');
  if (!t) return null;
  if (/^(\*|rest|fill|-)$/i.test(t)) return 'rest';
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16) / 1048576;
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  return u === 'K' ? n / 1024 : u === 'G' ? n * 1024 : u === 'T' ? n * 1048576 : n;
}
const fmt = (m) => (m >= 1024 && Math.abs(m / 1024 - Math.round(m / 1024 * 100) / 100) < 1e-9 ? `${Math.round(m / 1024 * 100) / 100} GiB`
  : m >= 1 ? `${Math.round(m * 100) / 100} MiB` : `${Math.round(m * 1024)} KiB`);
const hex = (b) => '0x' + Math.round(b).toString(16).toUpperCase();

const ROLES = ['raw', 'boot', 'rootfs', 'data', 'other'];

// ---------------- the plan ----------------
export function run(input) {
  const F = [];
  const add = (sev, msg, where) => F.push({ sev, msg, where: where || '' });
  const fw = ['rauc', 'swupdate', 'mender'].includes(input.framework) ? input.framework : 'rauc';
  const bl = ['uboot', 'grub', 'barebox'].includes(input.bootloader) ? input.bootloader : 'uboot';
  const dev = String(input.device || '/dev/mmcblk0').trim();
  const pdev = (n) => (/\d$/.test(dev) ? `${dev}p${n}` : `${dev}${n}`);
  const blkIndex = /(\d+)$/.exec(dev)?.[1] ?? '0';
  const total = mib(input.storageSize);
  const align = mib(input.align) || 1;
  const image = mib(input.imageSize);
  const growth = Math.max(0, Number(input.growth) || 0);
  let limit = Math.round(Number(input.bootlimit));
  if (!Number.isFinite(limit)) limit = 0;
  const redundant = !!input.envRedundant;
  const compatible = String(input.compatible || '').trim();
  const version = String(input.version || '1.0.0').trim();
  const envOff = mib(input.envOffset), envSize = mib(input.envSize);

  if (total == null || total === 'rest' || total <= 0) add('error', `Storage size "${input.storageSize}" is not a size like 7456M or 8G.`, 'storage');
  const T = typeof total === 'number' && total > 0 ? total : 0;

  // ---- partitions ----
  const rows = Array.isArray(input.parts) ? input.parts : [];
  const parts = [];
  let cur = 0, num = 0, restAt = -1;
  rows.forEach((r, i) => {
    const role = ROLES.includes(r.role) ? r.role : 'other';
    const slot = r.slot === 'A' || r.slot === 'B' ? r.slot : '';
    const sz = mib(r.size);
    if (sz == null) add('error', `Partition ${i + 1} (${r.name || 'unnamed'}): size "${r.size}" is not readable; use 1536M, 1.5G, 0x400000 or * for the rest.`, `p${i}`);
    parts.push({ i, name: String(r.name || `part${i + 1}`).trim(), role, slot, fs: String(r.fs || (role === 'raw' ? 'raw' : 'ext4')), sizeIn: sz });
    if (sz === 'rest') { if (restAt >= 0) add('error', 'Only one partition can take the rest of the storage (*).', `p${i}`); restAt = i; }
  });
  const fixed = parts.reduce((a, p) => a + (typeof p.sizeIn === 'number' ? p.sizeIn : 0), 0);
  for (const p of parts) {
    const raw = p.role === 'raw';
    const start = raw ? cur : Math.ceil(cur / align - 1e-9) * align;
    let size = typeof p.sizeIn === 'number' ? p.sizeIn : 0;
    if (p.sizeIn === 'rest') {
      // the rest after the partitions that follow (aligned), minus 1 MiB for the backup GPT
      const after = parts.slice(p.i + 1).reduce((a, q) => a + (typeof q.sizeIn === 'number' ? Math.ceil(q.sizeIn / align) * align : 0), 0);
      size = Math.max(0, Math.floor((T - 1 - start - after) / align) * align);
    }
    p.start = start; p.size = size; p.end = start + size;
    p.num = raw ? null : ++num;
    p.path = raw ? `${dev} @ ${fmt(start)}` : pdev(p.num);
    cur = p.end;
  }
  const used = parts.length ? Math.max(...parts.map((p) => p.end)) : 0;
  if (T && used > T + 1e-6) add('error', `The partitions end at ${fmt(used)}, ${fmt(used - T)} past the end of the ${fmt(T)} storage. Shrink the data partition or the slots.`, 'storage');

  const slotOf = (role, s) => parts.find((p) => p.role === role && p.slot === s);
  const rootA = slotOf('rootfs', 'A'), rootB = slotOf('rootfs', 'B');
  const bootA = slotOf('boot', 'A'), bootB = slotOf('boot', 'B');
  const data = parts.find((p) => p.role === 'data');
  const bootShared = parts.find((p) => p.role === 'boot' && !p.slot);
  if (!rootA || !rootB) add('error', 'There must be a rootfs partition for slot A and one for slot B (role rootfs, slot A / B).', 'layout');
  if (rootA && rootB && Math.abs(rootA.size - rootB.size) > 0.01) add('warn', `rootfs A is ${fmt(rootA.size)} and B is ${fmt(rootB.size)}: an image that fits one may not fit the other. Make them the same size.`, `p${rootB.i}`);
  if ((bootA && !bootB) || (!bootA && bootB)) add('error', 'Only one boot slot: give slot A and B a boot partition each, or none (kernel in the rootfs /boot).', 'layout');
  if (bootA && bootB && Math.abs(bootA.size - bootB.size) > 0.01) add('warn', `boot A (${fmt(bootA.size)}) and boot B (${fmt(bootB.size)}) differ in size.`, `p${bootB.i}`);
  if (!data) add('warn', 'No data partition: whatever the device writes (config, logs, keys, the update client\'s own state) lives in the rootfs and is lost with every update. Add a data partition mounted at /data.', 'layout');
  else if (data.size < 128) add('warn', `The data partition is ${fmt(data.size)}; logs, databases and a downloaded bundle usually need more than 128 MiB.`, `p${data.i}`);
  const slot = rootA && rootB ? Math.min(rootA.size, rootB.size) : 0;
  if (image == null || image === 'rest') add('error', `Image size "${input.imageSize}" is not readable.`, 'image');
  else if (slot) {
    if (image > slot) add('error', `The rootfs image (${fmt(image)}) is bigger than a slot (${fmt(slot)}): the install fails. Grow the slots or shrink the image.`, 'image');
    else if (image * (1 + growth / 100) > slot) add('warn', `With ${growth}% growth the image needs ${fmt(image * (1 + growth / 100))}; the slot has ${fmt(slot)}. Slot sizes are fixed for the life of the product - leave room now.`, 'image');
  }
  const firstPart = parts.find((p) => p.role !== 'raw');
  if (firstPart && firstPart.start < 1) add('warn', `${firstPart.name} starts at ${fmt(firstPart.start)}: the partition table and the bootloader need the first MiB(s). Put a raw area first.`, `p${firstPart.i}`);
  const readonly = rootA && /squashfs|erofs/.test(rootA.fs);
  if (readonly && !data) add('warn', `A ${rootA.fs} rootfs is read-only; without a data partition nothing can be stored.`, 'layout');

  // ---- boot counting ----
  if (fw === 'mender') {
    if (limit !== 1) add('note', `Mender's U-Boot and GRUB integration boots a new rootfs once: bootlimit is 1 in its environment, so the ${limit} attempts asked for here do not apply.`, 'limit');
    limit = 1;
  } else if (fw === 'rauc' && bl === 'grub') {
    if (limit !== 1) add('note', `RAUC's GRUB scheme gives each slot one try (<slot>_TRY), so the ${limit} attempts asked for here become 1.`, 'limit');
    limit = 1;
  } else if (limit <= 0) {
    add('error', 'No boot-count limit: an update that panics before userspace reboots into itself forever. Set a limit of 3 or so.', 'limit');
  } else if (limit > 10) add('warn', `A limit of ${limit} attempts keeps a broken update booting for a long time before the rollback; 3 is usual.`, 'limit');
  const L = Math.max(0, limit);

  if (fw === 'mender' && bl === 'barebox') add('error', 'Mender has no barebox integration upstream (it supports U-Boot and GRUB). Use U-Boot or GRUB, or RAUC with barebox.', 'combo');
  if (fw === 'swupdate' && bl === 'barebox') add('warn', 'SWUpdate\'s documented bootloader interfaces are U-Boot, GRUB and EFI Boot Guard. With barebox, set bootchooser\'s state (priority, remaining_attempts) from a postinstall script; the plan below shows those variables.', 'combo');
  if (bl === 'uboot' && !redundant) add('warn', 'The U-Boot environment has one copy: a power cut while the update client or U-Boot writes it leaves a bad CRC, U-Boot falls back to its built-in default environment and the slot choice is lost. Use a redundant environment (CONFIG_SYS_REDUNDAND_ENVIRONMENT).', 'env');
  if (bl === 'uboot' && typeof envOff === 'number' && typeof envSize === 'number') {
    const envEnd = envOff + envSize * (redundant ? 2 : 1);
    const hit = parts.find((p) => p.role !== 'raw' && envOff < p.end && envEnd > p.start);
    if (hit) add('error', `The U-Boot environment (${hex(envOff * 1048576)}..${hex(envEnd * 1048576)}) overlaps ${hit.name}; an update or an fw_setenv would overwrite it.`, 'env');
  }
  if (!compatible) add('warn', 'No compatible / device type: the update client cannot refuse a bundle built for another board.', 'combo');

  // ---- names used by the framework ----
  const V = names(fw, bl);
  const partNo = { A: (bootA || rootA)?.num ?? 1, B: (bootB || rootB)?.num ?? 2 };
  const rootNo = { A: rootA?.num ?? 1, B: rootB?.num ?? 2 };
  const steps = simulate(fw, bl, L, input.scenario || 'ok', rootNo, V, bootA && bootB ? partNo : null);

  // ---- files ----
  const ctx = { fw, bl, dev, pdev, blkIndex, parts, rootA, rootB, bootA, bootB, data, bootShared, L, redundant, compatible, version, envOff, envSize, rootNo, partNo, align, T, image };
  const texts = files(ctx, F);

  // ---- output ----
  const order = { error: 0, warn: 1, note: 2 };
  F.sort((a, b) => order[a.sev] - order[b.sev]);
  const slotHead = slot && typeof image === 'number' ? slot - image : null;
  return {
    values: [
      { label: 'Framework / bootloader', value: `${{ rauc: 'RAUC', swupdate: 'SWUpdate', mender: 'Mender' }[fw]} + ${{ uboot: 'U-Boot', grub: 'GRUB', barebox: 'barebox' }[bl]}` },
      { label: 'Slot size', value: slot ? fmt(slot) : '–' },
      { label: 'Image', value: typeof image === 'number' ? fmt(image) : '–', hint: slotHead != null ? `${fmt(Math.abs(slotHead))} ${slotHead >= 0 ? 'free' : 'short'} in a slot` : undefined, tone: slotHead == null ? undefined : slotHead < 0 ? 'bad' : image * (1 + growth / 100) > slot ? 'warn' : 'ok' },
      { label: 'Boot attempts before rollback', value: L, tone: L > 0 ? 'ok' : 'bad' },
      { label: 'Storage used', value: T ? `${fmt(used)} of ${fmt(T)}` : fmt(used), tone: T && used > T ? 'bad' : 'ok' },
      { label: 'Data partition', value: data ? fmt(data.size) : 'none', tone: data ? 'ok' : 'warn' },
    ],
    tables: [
      { title: 'Layout', columns: ['Partition', 'Role', 'Slot', 'Device', 'Start', 'Size', 'FS'], rows: parts.map((p) => [p.name, p.role, p.slot || '-', p.path, fmt(p.start), fmt(p.size), p.fs]) },
      { title: `Update steps (${{ ok: 'update succeeds', panic: 'new slot panics', health: 'health check fails' }[input.scenario || 'ok'] || 'update succeeds'})`, columns: ['#', 'Who', 'Step', 'Variables after'], rows: steps.map((s, i) => [i + 1, s.lane, s.title, Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')]) },
    ],
    texts,
    warnings: F.filter((f) => f.sev !== 'note').map((f) => f.msg),
    notes: [...F.filter((f) => f.sev === 'note').map((f) => f.msg),
      'The health check decides everything: confirm (mark-good / commit / upgrade_available=0) only after the application is really up, from a systemd unit ordered after it. A hardware watchdog turns a hang into the reboot that the boot counter needs.'],
    draw: { fw, bl, total: T, used, align, image: typeof image === 'number' ? image : null, growth, slot, limit: L,
      parts: parts.map((p) => ({ i: p.i, name: p.name, role: p.role, slot: p.slot, fs: p.fs, start: p.start, size: p.size, num: p.num, path: p.path, rest: p.sizeIn === 'rest' })),
      steps, vars: V.vars, findings: F, scenario: input.scenario || 'ok',
      env: bl === 'uboot' && typeof envOff === 'number' ? { off: envOff, size: envSize || 0, redundant } : null },
  };
}

// ---------------- variables per combination ----------------
function names(fw, bl) {
  if (bl === 'barebox') return { kind: 'bootchooser', vars: ['bootstate.system0.priority', 'bootstate.system0.remaining_attempts', 'bootstate.system1.priority', 'bootstate.system1.remaining_attempts'] };
  if (fw === 'rauc' && bl === 'uboot') return { kind: 'rauc-uboot', vars: ['BOOT_ORDER', 'BOOT_A_LEFT', 'BOOT_B_LEFT'] };
  if (fw === 'rauc' && bl === 'grub') return { kind: 'rauc-grub', vars: ['ORDER', 'A_OK', 'A_TRY', 'B_OK', 'B_TRY'] };
  if (fw === 'mender') return { kind: 'mender', vars: ['mender_boot_part', 'upgrade_available', 'bootcount', 'bootlimit'] };
  return { kind: 'count', vars: ['rootpart', 'bootpart', 'upgrade_available', 'bootcount', 'bootlimit'] };
}

// ---------------- the state machine, step by step ----------------
// Each step: who acts (client = update client, boot = bootloader, user =
// userspace, power = reset), what it does, the variables after it, which
// slot is running and which is being written.
function simulate(fw, bl, L, scenario, rootNo, V, bootNo) {
  const steps = [];
  const client = { rauc: 'rauc', swupdate: 'swupdate', mender: 'mender' }[fw];
  const loader = { uboot: 'U-Boot', grub: 'GRUB', barebox: 'barebox' }[bl];
  const confirm = { rauc: 'rauc status mark-good', swupdate: 'fw_setenv upgrade_available 0', mender: 'mender commit' }[fw];
  let env;
  const snap = (lane, title, detail, patch, run, write, kind = 'ok') => {
    const before = { ...env };
    Object.assign(env, patch || {});
    const changed = Object.keys(env).filter((k) => String(before[k]) !== String(env[k]));
    steps.push({ lane, title, detail, env: { ...env }, changed, run, write, kind });
  };
  const K = V.kind;
  if (K === 'rauc-uboot') env = { BOOT_ORDER: '"A B"', BOOT_A_LEFT: L, BOOT_B_LEFT: L };
  else if (K === 'rauc-grub') env = { ORDER: '"A B"', A_OK: 1, A_TRY: 0, B_OK: 1, B_TRY: 0 };
  else if (K === 'bootchooser') env = { 'bootstate.system0.priority': 20, 'bootstate.system0.remaining_attempts': L, 'bootstate.system1.priority': 10, 'bootstate.system1.remaining_attempts': L };
  else if (K === 'mender') env = { mender_boot_part: rootNo.A, upgrade_available: 0, bootcount: 0, bootlimit: 1 };
  else env = { rootpart: rootNo.A, ...(bootNo ? { bootpart: bootNo.A } : {}), upgrade_available: 0, bootcount: 0, bootlimit: L };

  snap('user', 'Running slot A', 'The device runs A; B is the inactive slot the update goes to.', null, 'A', null);
  snap('client', `${client} installs into slot B`, fw === 'swupdate' ? 'swupdate -e stable,copy2 -i update.swu writes the image to B\'s partition; A keeps running.' : `${client} writes the new image to B's partition while A keeps running.`, null, 'A', 'B');
  // switch
  if (K === 'rauc-uboot') snap('client', 'Mark B active', 'rauc puts B first in the boot order and gives it a full set of tries.', { BOOT_ORDER: '"B A"', BOOT_B_LEFT: L }, 'A', null);
  else if (K === 'rauc-grub') snap('client', 'Mark B active', 'rauc puts B first and marks it OK with no try used.', { ORDER: '"B A"', B_OK: 1, B_TRY: 0 }, 'A', null);
  else if (K === 'bootchooser') snap('client', 'Mark B (system1) active', `${client} raises system1's priority above system0's and resets its attempts.`, { 'bootstate.system1.priority': 30, 'bootstate.system1.remaining_attempts': L }, 'A', null);
  else if (K === 'mender') snap('client', 'Switch to B, arm the counter', 'mender points the bootloader at B and sets upgrade_available.', { mender_boot_part: rootNo.B, upgrade_available: 1, bootcount: 0 }, 'A', null);
  else snap('client', 'Switch to B, arm the counter', 'sw-description\'s bootenv: section sets the new root and upgrade_available=1.', { rootpart: rootNo.B, ...(bootNo ? { bootpart: bootNo.B } : {}), upgrade_available: 1, bootcount: 0 }, 'A', null);
  snap('power', 'Reboot', 'The client (or the user) reboots into the new slot.', null, null, null);

  // one boot attempt of B: returns false when the bootloader falls back instead
  const tryB = (n) => {
    if (K === 'rauc-uboot') {
      if (env.BOOT_B_LEFT <= 0) return false;
      snap('boot', `${loader} boots B (try ${n})`, 'The boot script takes the first slot in BOOT_ORDER with tries left and uses one.', { BOOT_B_LEFT: env.BOOT_B_LEFT - 1 }, 'B', null);
      return true;
    }
    if (K === 'rauc-grub') {
      if (env.B_TRY !== 0 || env.B_OK !== 1) return false;
      snap('boot', `${loader} boots B (its one try)`, 'grub.cfg takes the first slot that is OK and not tried, sets its TRY flag and saves grubenv.', { B_TRY: 1 }, 'B', null);
      return true;
    }
    if (K === 'bootchooser') {
      if (env['bootstate.system1.remaining_attempts'] <= 0) return false;
      snap('boot', `${loader} bootchooser boots B (try ${n})`, 'bootchooser takes the highest-priority target with attempts left and uses one.', { 'bootstate.system1.remaining_attempts': env['bootstate.system1.remaining_attempts'] - 1 }, 'B', null);
      return true;
    }
    // counter schemes: bootcount++ while upgrade_available=1; > bootlimit runs altbootcmd
    const c = env.bootcount + 1;
    if (c > env.bootlimit) {
      snap('boot', `${loader}: bootcount ${c} > bootlimit ${env.bootlimit}`, 'The limit is passed, so the bootloader runs altbootcmd instead of bootcmd.', { bootcount: c }, null, null, 'fail');
      return false;
    }
    snap('boot', `${loader} boots B (try ${n})`, 'upgrade_available=1, so every boot counts; still within bootlimit.', { bootcount: c }, 'B', null);
    return true;
  };
  const rollback = () => {
    if (K === 'rauc-uboot') snap('boot', 'Fall back to A', 'B has no tries left; the script moves on to A in BOOT_ORDER and uses one of its tries.', { BOOT_A_LEFT: Math.max(0, env.BOOT_A_LEFT - 1) }, 'A', null, 'rollback');
    else if (K === 'rauc-grub') snap('boot', 'Fall back to A', 'B was tried and never confirmed; grub.cfg moves on to A.', { A_TRY: 1 }, 'A', null, 'rollback');
    else if (K === 'bootchooser') snap('boot', 'Fall back to A (system0)', 'system1 has no attempts left; bootchooser boots system0.', { 'bootstate.system0.remaining_attempts': Math.max(0, env['bootstate.system0.remaining_attempts'] - 1) }, 'A', null, 'rollback');
    else if (K === 'mender') snap('boot', 'altbootcmd: back to A', 'altbootcmd points mender_boot_part back at A and clears upgrade_available.', { mender_boot_part: rootNo.A, upgrade_available: 0 }, 'A', null, 'rollback');
    else snap('boot', 'altbootcmd: back to A', 'altbootcmd switches rootpart back to A and clears upgrade_available and bootcount.', { rootpart: rootNo.A, ...(bootNo ? { bootpart: bootNo.A } : {}), upgrade_available: 0, bootcount: 0 }, 'A', null, 'rollback');
    // A confirms itself
    if (K === 'rauc-uboot') snap('user', 'A is up: mark-good on A', 'rauc-mark-good resets A\'s tries; B stays at 0, so the next boots skip it.', { BOOT_A_LEFT: L }, 'A', null, 'rollback');
    else if (K === 'rauc-grub') snap('user', 'A is up: mark-good on A', 'A_TRY back to 0; mark-bad B (B_OK=0) so it is not tried again.', { A_TRY: 0, B_OK: 0 }, 'A', null, 'rollback');
    else if (K === 'bootchooser') snap('user', 'A is up: mark-good on A', 'system0\'s attempts are reset; mark system1 bad (priority 0).', { 'bootstate.system0.remaining_attempts': L, 'bootstate.system1.priority': 0 }, 'A', null, 'rollback');
    else if (K === 'mender') snap('user', 'A is up: update reported as failed', 'mender sees it booted the old slot and reports the deployment as failed.', { bootcount: 0 }, 'A', null, 'rollback');
    else snap('user', 'A is up: report the failed update', 'Userspace sees it runs the old slot (upgrade_available=0, rootpart = A) and reports the failure.', null, 'A', null, 'rollback');
  };
  const confirmB = () => {
    if (K === 'rauc-uboot') snap('user', `Health check passes: ${confirm}`, 'The booted slot gets its full tries back; B is the good slot from now on.', { BOOT_B_LEFT: L }, 'B', null);
    else if (K === 'rauc-grub') snap('user', `Health check passes: ${confirm}`, 'B_TRY back to 0 with B_OK=1.', { B_TRY: 0, B_OK: 1 }, 'B', null);
    else if (K === 'bootchooser') snap('user', `Health check passes: ${confirm}`, 'system1\'s attempts are reset; it stays the higher priority.', { 'bootstate.system1.remaining_attempts': L }, 'B', null);
    else if (K === 'mender') snap('user', `Health check passes: ${confirm}`, 'Commit clears upgrade_available; bootcount stops counting.', { upgrade_available: 0, bootcount: 0 }, 'B', null);
    else snap('user', `Health check passes: ${confirm}`, 'Clearing upgrade_available (and bootcount) ends the trial.', { upgrade_available: 0, bootcount: 0 }, 'B', null);
  };

  if (scenario === 'ok') {
    if (tryB(1)) {
      confirmB();
      snap('user', 'Running slot B', 'B is the running slot; the next update goes to A.', null, 'B', null);
      return steps;
    }
    rollback();
    snap('user', 'Running slot A again', 'With no tries allowed the new slot is never booted.', null, 'A', null, 'rollback');
    return steps;
  }
  // failing: a panic before userspace, or a health check that never confirms
  const fail = () => (scenario === 'panic'
    ? snap('power', 'Kernel panic, watchdog reset', 'B never reaches userspace; the watchdog resets the board.', null, null, null, 'fail')
    : snap('power', 'Health check fails: no confirm, reboot', 'B boots, the application is not healthy, and the check reboots without confirming.', null, null, null, 'fail'));
  let n = 1;
  for (let guard = 0; guard < MAX_FAIL_STEPS + 6; guard++) {
    if (L > MAX_FAIL_STEPS && n === 3) {
      // many tries: the middle ones are drawn as one step
      const skip = L - 3;
      const patch = K === 'rauc-uboot' ? { BOOT_B_LEFT: env.BOOT_B_LEFT - skip }
        : K === 'bootchooser' ? { 'bootstate.system1.remaining_attempts': env['bootstate.system1.remaining_attempts'] - skip }
          : K === 'rauc-grub' ? {} : { bootcount: env.bootcount + skip };
      snap('boot', `Tries 3 to ${L - 1} fail the same way`, `${skip} more boots of B, each ending in a reset.`, patch, null, null, 'fail');
      n = L;
    }
    if (!tryB(n)) break;
    fail();
    n++;
  }
  rollback();
  snap('user', 'Running slot A again', 'The device is back on the old software; the bad image stays in B until the next update overwrites it.', null, 'A', null, 'rollback');
  return steps;
}

// ---------------- configuration files ----------------
// RAUC writes a filesystem image into a slot of that type (ext4, vfat, ubifs)
// and anything else (squashfs, erofs images) byte for byte: type=raw.
const raucType = (fs) => (['ext4', 'vfat', 'ubifs'].includes(fs) ? fs : 'raw');
function files(c, F) {
  const out = [];
  const R = c.rootA && c.rootB;
  const fsOf = (p) => (p ? p.fs : 'ext4');
  const mmc = c.blkIndex;
  const kernelPart = { A: (c.bootA || c.rootA)?.num ?? 1, B: (c.bootB || c.rootB)?.num ?? 2 };
  const kpath = c.bootA ? '/Image' : '/boot/Image';
  const fdt = c.bootA ? '/${fdtfile}' : '/boot/${fdtfile}';
  const rootfsType = fsOf(c.rootA);
  if (c.fw === 'rauc') {
    const bootname = (s) => (c.bl === 'barebox' ? (s === 'A' ? 'system0' : 'system1') : s);
    const sc = [
      '# /etc/rauc/system.conf',
      '[system]',
      `compatible=${c.compatible || '<your-board>'}`,
      `bootloader=${c.bl}`,
      ...(c.bl === 'grub' ? ['grubenv=/boot/EFI/BOOT/grubenv'] : []),
      ...(c.bl === 'barebox' ? ['barebox-statename=state'] : []),
      c.data ? '# RAUC 1.9 and later; older releases: statusfile=/data/rauc.status' : '# no data partition: RAUC keeps its status in the rootfs',
      ...(c.data ? ['data-directory=/data/rauc'] : []),
      'bundle-formats=-plain',
      '',
      '[keyring]',
      'path=/etc/rauc/ca.cert.pem',
      '',
    ];
    for (const [i, s] of [[0, 'A'], [1, 'B']]) {
      const root = s === 'A' ? c.rootA : c.rootB;
      sc.push(`[slot.rootfs.${i}]`, `device=${root ? c.pdev(root.num) : '/dev/<rootfs ' + s + '>'}`, `type=${raucType(fsOf(root))}`, `bootname=${bootname(s)}`, '');
    }
    if (c.bootA && c.bootB) {
      for (const [i, s] of [[0, 'A'], [1, 'B']]) {
        const b = s === 'A' ? c.bootA : c.bootB;
        sc.push(`[slot.boot.${i}]`, `device=${c.pdev(b.num)}`, `type=${raucType(b.fs)}`, `parent=rootfs.${i}`, '');
      }
    }
    out.push({ title: 'system.conf', body: sc.join('\n'), lang: 'ini' });
    const mf = ['# manifest.raucm (meta-rauc writes it from the bundle recipe)', '[update]', `compatible=${c.compatible || '<your-board>'}`, `version=${c.version}`, '',
      '[bundle]', 'format=verity', '', '[image.rootfs]', `filename=rootfs.${rootfsType === 'squashfs' ? 'squashfs' : rootfsType}`, ''];
    if (c.bootA) mf.push('[image.boot]', 'filename=boot.vfat', '');
    out.push({ title: 'manifest.raucm', body: mf.join('\n'), lang: 'ini' });
  }
  if (c.fw === 'swupdate') {
    const img = (s) => {
      const root = s === 'A' ? c.rootA : c.rootB;
      const lines = [
        '\t\t\timages: (',
        '\t\t\t\t{',
        `\t\t\t\t\tfilename = "rootfs.${rootfsType}.gz";`,
        `\t\t\t\t\tdevice = "${root ? c.pdev(root.num) : '/dev/<rootfs ' + s + '>'}";`,
        '\t\t\t\t\ttype = "raw";',
        '\t\t\t\t\tcompressed = "zlib";',
        '\t\t\t\t\tinstalled-directly = true;',
        `\t\t\t\t\tsha256 = "$swupdate_get_sha256(rootfs.${rootfsType}.gz)";`,
        '\t\t\t\t}',
      ];
      if (c.bootA) {
        const b = s === 'A' ? c.bootA : c.bootB;
        lines[lines.length - 1] += ',';
        lines.push('\t\t\t\t{', '\t\t\t\t\tfilename = "boot.vfat.gz";', `\t\t\t\t\tdevice = "${c.pdev(b.num)}";`, '\t\t\t\t\ttype = "raw";', '\t\t\t\t\tcompressed = "zlib";', '\t\t\t\t\tsha256 = "$swupdate_get_sha256(boot.vfat.gz)";', '\t\t\t\t}');
      }
      lines.push('\t\t\t);');
      const envs = c.bl === 'barebox'
        ? [['bootstate.system0.priority', s === 'A' ? 30 : 10], ['bootstate.system1.priority', s === 'B' ? 30 : 10], [`bootstate.system${s === 'A' ? 0 : 1}.remaining_attempts`, c.L]]
        : [['rootpart', c.rootNo[s]], ...(c.bootA ? [['bootpart', c.partNo[s]]] : []), ['upgrade_available', 1], ['bootcount', 0]];
      lines.push('\t\t\tbootenv: (', envs.map(([k, v]) => `\t\t\t\t{ name = "${k}"; value = "${v}"; }`).join(',\n'), '\t\t\t);');
      return lines;
    };
    const sw = [
      'software =',
      '{',
      `\tversion = "${c.version}";`,
      '\thardware-compatibility: [ "1.0" ];',
      `\tdescription = "${c.compatible || 'firmware'} ${c.version}";`,
      '',
      '\tstable = {',
      '\t\t/* running from B: swupdate -e stable,copy1 installs into A */',
      '\t\tcopy1: {',
      ...img('A'),
      '\t\t};',
      '\t\t/* running from A: swupdate -e stable,copy2 installs into B */',
      '\t\tcopy2: {',
      ...img('B'),
      '\t\t};',
      '\t};',
      '}',
      '',
      '# pick the collection for the inactive slot, e.g. in the update service:',
      `#   grep -q "root=${c.rootA ? c.pdev(c.rootA.num) : '<A>'} " /proc/cmdline && SEL=stable,copy2 || SEL=stable,copy1`,
      '#   swupdate -e "$SEL" -i /data/update.swu',
      '',
    ];
    out.push({ title: 'sw-description', body: sw.join('\n'), lang: 'text' });
  }
  if (c.fw === 'mender') {
    const bootMB = c.bootShared ? Math.round(c.bootShared.size) : c.bootA ? Math.round(c.bootA.size) : 0;
    const dataMB = c.data ? Math.round(c.data.size) : 0;
    const raw = c.parts.filter((p) => p.role === 'raw').reduce((a, p) => Math.max(a, p.end), 0);
    const alignB = Math.round(c.align * 1048576);
    const reserved = Math.max(raw, 2 * c.align);
    const menderRoot = (c.T - bootMB - dataMB - reserved - c.align * 3) / 2;
    const ml = [
      '# conf/local.conf (meta-mender)',
      'INHERIT += "mender-full"',
      `MENDER_ARTIFACT_NAME = "release-${c.version}"`,
      `MENDER_DEVICE_TYPES_COMPATIBLE = "${c.compatible || '${MACHINE}'}"`,
      `MENDER_FEATURES_ENABLE:append = " ${c.bl === 'grub' ? 'mender-grub mender-image-uefi' : 'mender-uboot mender-image-sd'}"`,
      `MENDER_STORAGE_DEVICE = "${c.dev}"`,
      `MENDER_STORAGE_TOTAL_SIZE_MB = "${Math.floor(c.T)}"`,
      `MENDER_BOOT_PART_SIZE_MB = "${bootMB}"`,
      `MENDER_DATA_PART_SIZE_MB = "${dataMB}"`,
      `MENDER_PARTITION_ALIGNMENT = "${alignB}"`,
      `MENDER_RESERVED_SPACE_BOOTLOADER_DATA = "${Math.round(reserved * 1048576)}"`,
      ...(c.bl === 'uboot' ? [`MENDER_UBOOT_STORAGE_INTERFACE = "mmc"`, `MENDER_UBOOT_STORAGE_DEVICE = "${mmc}"`] : []),
      `# Mender sizes each rootfs slot itself: about ${Math.floor(menderRoot)} MiB here`,
      '',
    ];
    if (c.rootA && Math.abs(menderRoot - c.rootA.size) > Math.max(16, c.align * 2)) {
      F.push({ sev: 'note', msg: `Mender computes the rootfs slots from the total, boot and data sizes: about ${Math.floor(menderRoot)} MiB each here, not the ${Math.round(c.rootA.size)} MiB in the table. Adjust MENDER_DATA_PART_SIZE_MB to get the slot size you planned.`, where: 'layout' });
    }
    out.push({ title: 'local.conf', body: ml.join('\n'), lang: 'text' });
  }

  // bootloader side
  if (c.bl === 'uboot') {
    if (c.fw === 'rauc') {
      const s = [
        '# boot.cmd - A/B choice for RAUC: BOOT_ORDER lists the slots, BOOT_<slot>_LEFT the tries',
        '# mkimage -A arm64 -T script -C none -d boot.cmd boot.scr',
        `test -n "\${BOOT_ORDER}" || setenv BOOT_ORDER "A B"`,
        `test -n "\${BOOT_A_LEFT}" || setenv BOOT_A_LEFT ${c.L}`,
        `test -n "\${BOOT_B_LEFT}" || setenv BOOT_B_LEFT ${c.L}`,
        'setenv slot',
        'for s in ${BOOT_ORDER}; do',
        '  if test -z "${slot}"; then',
        `    if test "\${s}" = "A" && test \${BOOT_A_LEFT} -gt 0; then`,
        `      setexpr BOOT_A_LEFT \${BOOT_A_LEFT} - 1; setenv slot A; setenv kpart ${kernelPart.A}; setenv rpart ${c.rootNo.A}`,
        `    elif test "\${s}" = "B" && test \${BOOT_B_LEFT} -gt 0; then`,
        `      setexpr BOOT_B_LEFT \${BOOT_B_LEFT} - 1; setenv slot B; setenv kpart ${kernelPart.B}; setenv rpart ${c.rootNo.B}`,
        '    fi',
        '  fi',
        'done',
        'if test -z "${slot}"; then',
        `  echo "No slot has tries left: giving both ${c.L} again"`,
        `  setenv BOOT_A_LEFT ${c.L}; setenv BOOT_B_LEFT ${c.L}; saveenv; reset`,
        'fi',
        'saveenv',
        `setenv bootargs "console=\${console} root=${c.pdev('X').replace(/X$/, '')}\${rpart} rootwait ro rauc.slot=\${slot}"`,
        `load mmc ${mmc}:\${kpart} \${kernel_addr_r} ${kpath}`,
        `load mmc ${mmc}:\${kpart} \${fdt_addr_r} ${fdt}`,
        'booti ${kernel_addr_r} - ${fdt_addr_r}',
        '',
      ];
      out.push({ title: 'boot.cmd', body: s.join('\n'), lang: 'sh' });
    } else {
      const partVar = c.fw === 'mender' ? 'mender_boot_part' : 'rootpart';
      const e = c.fw === 'mender' ? [
        '# U-Boot environment that meta-mender\'s U-Boot integration provides (for reference)',
        `mender_boot_part=${c.rootNo.A}`,
        'upgrade_available=0',
        'bootcount=0',
        'bootlimit=1',
        'altbootcmd=run mender_altbootcmd; run bootcmd',
        '',
        '# U-Boot configuration it needs',
        'CONFIG_BOOTCOUNT_LIMIT=y',
        'CONFIG_BOOTCOUNT_ENV=y',
        '',
      ] : [
        '# U-Boot default environment for SWUpdate A/B with boot counting',
        '# (CONFIG_BOOTCOUNT_LIMIT=y and CONFIG_BOOTCOUNT_ENV=y: bootcount is counted',
        '#  only while upgrade_available=1, and altbootcmd runs once bootcount > bootlimit)',
        `${partVar}=${c.rootNo.A}`,
        'upgrade_available=0',
        'bootcount=0',
        `bootlimit=${c.L}`,
        ...(c.bootA ? [`bootpart=${c.partNo.A}`] : []),
        c.bootA
          ? `altbootcmd=if test \${${partVar}} = ${c.rootNo.A}; then setenv ${partVar} ${c.rootNo.B}; setenv bootpart ${c.partNo.B}; else setenv ${partVar} ${c.rootNo.A}; setenv bootpart ${c.partNo.A}; fi; setenv upgrade_available 0; setenv bootcount 0; saveenv; run bootcmd`
          : `altbootcmd=if test \${${partVar}} = ${c.rootNo.A}; then setenv ${partVar} ${c.rootNo.B}; else setenv ${partVar} ${c.rootNo.A}; fi; setenv upgrade_available 0; setenv bootcount 0; saveenv; run bootcmd`,
        `bootcmd=load mmc ${mmc}:\${${c.bootA ? 'bootpart' : partVar}} \${kernel_addr_r} ${kpath}; load mmc ${mmc}:\${${c.bootA ? 'bootpart' : partVar}} \${fdt_addr_r} ${fdt}; setenv bootargs console=\${console} root=${c.pdev('X').replace(/X$/, '')}\${${partVar}} rootwait ro; booti \${kernel_addr_r} - \${fdt_addr_r}`,
        '',
        '# U-Boot configuration',
        'CONFIG_BOOTCOUNT_LIMIT=y',
        'CONFIG_BOOTCOUNT_ENV=y',
        ...(c.redundant ? ['CONFIG_SYS_REDUNDAND_ENVIRONMENT=y'] : []),
        '',
      ];
      out.push({ title: 'u-boot env', body: e.join('\n'), lang: 'sh' });
    }
    if (typeof c.envOff === 'number' && typeof c.envSize === 'number') {
      const b = (m) => hex(m * 1048576);
      const fe = ['# /etc/fw_env.config - where fw_printenv / fw_setenv (and the update client) find the U-Boot environment',
        '# device        offset       env size',
        `${c.dev}\t${b(c.envOff)}\t${b(c.envSize)}`];
      if (c.redundant) fe.push(`${c.dev}\t${b(c.envOff + c.envSize)}\t${b(c.envSize)}`);
      fe.push('', `# must match CONFIG_ENV_OFFSET=${b(c.envOff)}, CONFIG_ENV_SIZE=${b(c.envSize)}${c.redundant ? `, CONFIG_ENV_OFFSET_REDUND=${b(c.envOff + c.envSize)}` : ''}`, '');
      out.push({ title: 'fw_env.config', body: fe.join('\n'), lang: 'text' });
    }
  } else if (c.bl === 'grub') {
    if (c.fw === 'rauc') {
      const g = [
        '# grub.cfg - A/B choice for RAUC: ORDER, <slot>_OK, <slot>_TRY in grubenv',
        'set default=0',
        'set timeout=1',
        'set ORDER="A B"',
        'set A_OK=0', 'set A_TRY=0', 'set B_OK=0', 'set B_TRY=0',
        'load_env ORDER A_OK A_TRY B_OK B_TRY',
        'set slot=""',
        'for s in $ORDER; do',
        '  if [ -z "$slot" ]; then',
        '    if [ "$s" = "A" -a "$A_OK" = "1" -a "$A_TRY" = "0" ]; then set slot=A; set A_TRY=1; fi',
        '    if [ "$s" = "B" -a "$B_OK" = "1" -a "$B_TRY" = "0" ]; then set slot=B; set B_TRY=1; fi',
        '  fi',
        'done',
        'save_env A_TRY B_TRY',
        `if [ "$slot" = "A" ]; then set root=(hd0,gpt${c.rootNo.A}); set rootdev=${c.rootA ? c.pdev(c.rootA.num) : ''}; fi`,
        `if [ "$slot" = "B" ]; then set root=(hd0,gpt${c.rootNo.B}); set rootdev=${c.rootB ? c.pdev(c.rootB.num) : ''}; fi`,
        'if [ -z "$slot" ]; then echo "no bootable slot"; sleep 10; reboot; fi',
        'menuentry "slot $slot" {',
        '  linux /boot/bzImage root=$rootdev rootwait ro rauc.slot=$slot',
        '}',
        '',
      ];
      out.push({ title: 'grub.cfg', body: g.join('\n'), lang: 'sh' });
    } else {
      const pv = c.fw === 'mender' ? 'mender_boot_part' : 'rootpart';
      const lim = c.L;
      const chain = [];
      for (let i = 0; i < Math.min(lim, 9); i++) chain.push(`    ${i ? 'elif' : 'if'} [ "$bootcount" = "${i}" ]; then set bootcount=${i + 1}`);
      const g = [
        `# grub.cfg - boot counting in grubenv (${pv}, upgrade_available, bootcount)`,
        c.fw === 'mender' ? '# meta-mender provides this through grub-mender-grubenv; shown for reference' : '# GRUB script has no arithmetic, so the counter steps through fixed values',
        `set ${pv}=${c.rootNo.A}`, 'set upgrade_available=0', 'set bootcount=0',
        `load_env ${pv} upgrade_available bootcount`,
        'if [ "$upgrade_available" = "1" ]; then',
        ...chain,
        '    else',
        `      # limit passed: back to the other slot`,
        `      if [ "$${pv}" = "${c.rootNo.A}" ]; then set ${pv}=${c.rootNo.B}; else set ${pv}=${c.rootNo.A}; fi`,
        '      set upgrade_available=0', '      set bootcount=0',
        '    fi',
        `  save_env ${pv} upgrade_available bootcount`,
        'fi',
        `set root=(hd0,gpt$${pv})`,
        'menuentry "rootfs $' + pv + '" {',
        `  linux /boot/bzImage root=${c.pdev('X').replace(/X$/, '')}$${pv} rootwait ro`,
        '}',
        '',
      ];
      out.push({ title: 'grub.cfg', body: g.join('\n'), lang: 'sh' });
    }
  } else {
    const bb = [
      '# barebox: bootchooser with the state framework (/env/nv or the environment)',
      'nv boot.default=bootchooser',
      'nv bootchooser.targets="system0 system1"',
      `nv bootchooser.default_attempts=${c.L}`,
      'nv bootchooser.default_priority=10',
      'nv bootchooser.state_prefix=state.bootstate',
      'nv bootchooser.reset_attempts="power-on"',
      `nv bootchooser.system0.boot=mmc${mmc}.${(c.rootA?.num ?? 1) - 1}`,
      `nv bootchooser.system1.boot=mmc${mmc}.${(c.rootB?.num ?? 2) - 1}`,
      '',
      '# the device tree needs a barebox,state node with bootstate.system0/1',
      '# (priority, remaining_attempts) on a non-volatile backend (eMMC or EEPROM)',
      '',
    ];
    out.push({ title: 'barebox env', body: bb.join('\n'), lang: 'sh' });
  }

  // confirm unit
  const confirmCmd = { rauc: '/usr/bin/rauc status mark-good', swupdate: c.bl === 'barebox' ? '/usr/bin/barebox-state -s bootstate.system1.remaining_attempts=' + c.L : '/usr/bin/fw_setenv upgrade_available 0', mender: '/usr/bin/mender commit' }[c.fw];
  const cu = [
    '# /etc/systemd/system/update-confirm.service',
    '# Confirms the running slot only after the application is up and healthy.',
    '[Unit]',
    'Description=Confirm the booted slot after a healthy start',
    'After=multi-user.target my-app.service',
    'Requires=my-app.service',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStartPre=/usr/bin/my-app-healthcheck --timeout 60',
    `ExecStart=${confirmCmd}`,
    ...(c.fw === 'swupdate' && c.bl !== 'barebox' ? ['ExecStart=/usr/bin/fw_setenv bootcount 0'] : []),
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
    c.fw === 'mender' ? '# Mender 4 client: /usr/bin/mender-update commit' : c.fw === 'rauc' ? '# meta-rauc also ships rauc-mark-good.service; keep one of them' : '',
  ].filter((l, i, a) => !(l === '' && i === a.length - 1));
  out.push({ title: 'update-confirm.service', body: cu.join('\n') + '\n', lang: 'ini' });

  // wks for the layout
  const wks = ['# layout.wks - the partition layout for wic', `# bootloader area and environment: first ${fmt(c.parts.filter((p) => p.role === 'raw').reduce((a, p) => Math.max(a, p.end), 0))} are raw (write the bootloader with a rawcopy part at its offset)`];
  for (const p of c.parts) {
    if (p.role === 'raw') { wks.push(`# ${p.name}: raw ${fmt(p.size)} at ${fmt(p.start)}`); continue; }
    const sizeM = Math.round(p.size);
    const src = p.role === 'rootfs' && p.slot === 'A' ? '--source rootfs ' : p.role === 'boot' && p.slot === 'A' ? '--source bootimg-partition ' : '';
    const mnt = p.role === 'data' ? '/data ' : p.role === 'rootfs' && p.slot === 'A' ? '/ ' : '';
    const fsOpt = !src && /squashfs|erofs|raw/.test(p.fs) ? '' : `--fstype=${p.fs === 'raw' ? 'ext4' : p.fs} `;
    wks.push(`part ${mnt}${src}${fsOpt}--label ${p.name} --align ${Math.round(c.align * 1024)} --fixed-size ${sizeM}M${fsOpt ? '' : '   # left empty: the first update writes it'}`);
  }
  wks.push('bootloader --ptable gpt', '');
  out.push({ title: 'layout.wks', body: wks.join('\n'), lang: 'text' });
  return out;
}
