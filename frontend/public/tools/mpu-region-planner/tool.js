// MPU Region Planner: Cortex-M MPU regions laid out on a part's memory map,
// the access that wins at every address, and the register values and CMSIS
// code to program them.
//
// Pure: no DOM. Rules from:
//   Armv7-M ARM (DDI 0403E) B3.5 PMSAv7: MPU_TYPE/CTRL/RNR/RBAR/RASR; region
//     size 2^(SIZE+1) >= 32 B, base aligned to the size, 8 subregions (SRD)
//     only for regions >= 256 B, higher region number wins an overlap,
//     AP encodings (B3.5.9 Table B3-15), TEX/C/B encodings (Table B3-13),
//     PRIVDEFENA / HFNMIENA; B3.1 default memory map
//   Armv8-M ARM (DDI 0553) PMSAv8: RBAR BASE/SH/AP/XN, RLAR LIMIT/AttrIndx/EN
//     with 32-byte granularity, MAIR0/MAIR1 attributes, and an access that
//     hits two enabled regions is a MemManage fault
//   CMSIS-Core mpu_armv7.h / mpu_armv8.h (ARM_MPU_RBAR, ARM_MPU_RASR,
//     ARM_MPU_RLAR, ARM_MPU_ATTR, ARM_MPU_Load) for the generated code
//   Cortex-M7 TRM: Normal memory marked Shareable is not cached unless
//     CACR.SIWT is set; ST AN4838 (MPU on STM32) for the 4 GB background
//     region pattern.

export const DEVICES = {
  stm32f407: {
    name: 'STM32F407 (Cortex-M4, 8 regions)', arch: 'v7m', regions: 8, core: 'm4',
    areas: [
      { name: 'Flash', base: 0x08000000, size: 0x100000, kind: 'flash' },
      { name: 'CCM RAM', base: 0x10000000, size: 0x10000, kind: 'ram' },
      { name: 'SRAM1+2', base: 0x20000000, size: 0x20000, kind: 'ram' },
      { name: 'Peripherals', base: 0x40000000, size: 0x20000000, kind: 'periph' },
      { name: 'Boot alias at 0', base: 0x00000000, size: 0x100000, kind: 'flash' },
    ],
  },
  stm32h743: {
    name: 'STM32H743 (Cortex-M7, 16 regions)', arch: 'v7m', regions: 16, core: 'm7',
    areas: [
      { name: 'ITCM', base: 0x00000000, size: 0x10000, kind: 'ram' },
      { name: 'Flash', base: 0x08000000, size: 0x200000, kind: 'flash' },
      { name: 'DTCM', base: 0x20000000, size: 0x20000, kind: 'ram' },
      { name: 'AXI SRAM', base: 0x24000000, size: 0x80000, kind: 'ram' },
      { name: 'SRAM1-3', base: 0x30000000, size: 0x48000, kind: 'ram' },
      { name: 'SRAM4', base: 0x38000000, size: 0x10000, kind: 'ram' },
      { name: 'Peripherals', base: 0x40000000, size: 0x20000000, kind: 'periph' },
      { name: 'QSPI flash', base: 0x90000000, size: 0x10000000, kind: 'ext' },
      { name: 'FMC SDRAM', base: 0xC0000000, size: 0x10000000, kind: 'ext' },
    ],
  },
  stm32l552: {
    name: 'STM32L552 (Cortex-M33, 8 regions)', arch: 'v8m', regions: 8, core: 'm33',
    areas: [
      { name: 'Flash', base: 0x08000000, size: 0x80000, kind: 'flash' },
      { name: 'SRAM1', base: 0x20000000, size: 0x30000, kind: 'ram' },
      { name: 'SRAM2', base: 0x20030000, size: 0x10000, kind: 'ram' },
      { name: 'Peripherals', base: 0x40000000, size: 0x20000000, kind: 'periph' },
    ],
  },
};

// Typical region sets, loaded by the page's "Load typical regions" button.
export const PRESETS = {
  stm32f407: [
    { name: 'Flash', base: '0x08000000', size: '1M', ap: 'ro', xn: 'no', type: 'normal-wt', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'SRAM', base: '0x20000000', size: '128K', ap: 'rw', xn: 'no', type: 'normal-wbwa', s: 'yes', srd: '0x00', en: 'yes' },
    { name: 'Peripherals', base: '0x40000000', size: '512M', ap: 'rw', xn: 'yes', type: 'device', s: 'yes', srd: '0x00', en: 'yes' },
    { name: 'CCM RAM', base: '0x10000000', size: '64K', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'NULL guard', base: '0x00000000', size: '1K', ap: 'none', xn: 'yes', type: 'strongly-ordered', s: 'yes', srd: '0x00', en: 'yes' },
    { name: 'MSP guard', base: '0x2001F7E0', size: '32', ap: 'none', xn: 'yes', type: 'normal-wbwa', s: 'yes', srd: '0x00', en: 'yes' },
  ],
  stm32h743: [
    { name: 'Background', base: '0x00000000', size: '4G', ap: 'none', xn: 'yes', type: 'strongly-ordered', s: 'yes', srd: '0x87', en: 'yes' },
    { name: 'Flash', base: '0x08000000', size: '2M', ap: 'ro', xn: 'no', type: 'normal-wt', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'DTCM', base: '0x20000000', size: '128K', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'AXI SRAM', base: '0x24000000', size: '512K', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'SRAM1-3 DMA', base: '0x30000000', size: '512K', ap: 'rw', xn: 'yes', type: 'normal-nc', s: 'yes', srd: '0xE0', en: 'yes' },
    { name: 'SRAM4', base: '0x38000000', size: '64K', ap: 'rw', xn: 'yes', type: 'normal-nc', s: 'yes', srd: '0x00', en: 'yes' },
    { name: 'QSPI', base: '0x90000000', size: '16M', ap: 'ro', xn: 'no', type: 'normal-wt', s: 'no', srd: '0x00', en: 'yes' },
    { name: 'SDRAM', base: '0xC0000000', size: '32M', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: '0x00', en: 'yes' },
  ],
  stm32l552: [
    { name: 'Flash', base: '0x08000000', size: '512K', ap: 'ro', xn: 'no', type: 'normal-wt', s: 'no', srd: '', en: 'yes' },
    { name: 'SRAM', base: '0x20000000', size: '256K', ap: 'rw', xn: 'yes', type: 'normal-wbwa', s: 'no', srd: '', en: 'yes' },
    { name: 'Peripherals', base: '0x40000000', size: '512M', ap: 'rw', xn: 'yes', type: 'device', s: 'no', srd: '', en: 'yes' },
  ],
};

// Access permissions. v7: RASR.AP (3 bits). v8: RBAR.AP[2:1] = RO, NP.
export const AP = {
  none: { label: 'No access', v7: 0, cm7: 'ARM_MPU_AP_NONE', priv: '--', user: '--', w: false },
  'priv-rw': { label: 'Privileged RW', v7: 1, cm7: 'ARM_MPU_AP_PRIV', v8: [0, 0], priv: 'RW', user: '--', w: true },
  'priv-rw-user-ro': { label: 'Priv RW, user RO', v7: 2, cm7: 'ARM_MPU_AP_URO', priv: 'RW', user: 'RO', w: true },
  rw: { label: 'Full access', v7: 3, cm7: 'ARM_MPU_AP_FULL', v8: [0, 1], priv: 'RW', user: 'RW', w: true },
  'priv-ro': { label: 'Privileged RO', v7: 5, cm7: 'ARM_MPU_AP_PRO', v8: [1, 0], priv: 'RO', user: '--', w: false },
  ro: { label: 'Read-only', v7: 6, cm7: 'ARM_MPU_AP_RO', v8: [1, 1], priv: 'RO', user: 'RO', w: false },
};
// Memory types. v7: TEX/C/B (Table B3-13); v8: the MAIR attribute byte.
export const TYPES = {
  'normal-wbwa': { label: 'Normal, write-back, write-allocate', tex: 1, c: 1, b: 1, mair: 0xFF, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(1U, 1U, 1U, 1U), ARM_MPU_ATTR_MEMORY_(1U, 1U, 1U, 1U))', normal: true, cached: true },
  'normal-wb': { label: 'Normal, write-back, no write-allocate', tex: 0, c: 1, b: 1, mair: 0xEE, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(1U, 1U, 1U, 0U), ARM_MPU_ATTR_MEMORY_(1U, 1U, 1U, 0U))', normal: true, cached: true },
  'normal-wt': { label: 'Normal, write-through', tex: 0, c: 1, b: 0, mair: 0xAA, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_MEMORY_(1U, 0U, 1U, 0U), ARM_MPU_ATTR_MEMORY_(1U, 0U, 1U, 0U))', normal: true, cached: true },
  'normal-nc': { label: 'Normal, non-cacheable', tex: 1, c: 0, b: 0, mair: 0x44, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_NON_CACHEABLE, ARM_MPU_ATTR_NON_CACHEABLE)', normal: true, cached: false },
  device: { label: 'Device (shareable)', tex: 0, c: 0, b: 1, mair: 0x04, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_DEVICE, ARM_MPU_ATTR_DEVICE_nGnRE)', normal: false, cached: false },
  'strongly-ordered': { label: 'Strongly-ordered / Device-nGnRnE', tex: 0, c: 0, b: 0, mair: 0x00, mairC: 'ARM_MPU_ATTR(ARM_MPU_ATTR_DEVICE, ARM_MPU_ATTR_DEVICE_nGnRnE)', normal: false, cached: false },
};

const GB4 = 0x100000000;
const hex8 = (v) => '0x' + Math.round(v).toString(16).toUpperCase().padStart(8, '0');
const hexs = (v) => '0x' + Math.round(v).toString(16).toUpperCase();
export function sizeName(b) {
  if (b >= 1073741824 && b % 1073741824 === 0) return `${b / 1073741824} GB`;
  if (b >= 1048576 && b % 1048576 === 0) return `${b / 1048576} MB`;
  if (b >= 1024 && b % 1024 === 0) return `${b / 1024} KB`;
  return `${b} B`;
}
const cmsisSize = (b) => `ARM_MPU_REGION_SIZE_${sizeName(b).replace(' ', '').replace('KB', 'KB').replace(/^(\d+)B$/, '$1B')}`;

/** 0x2000_0000, 536870912 -> number; null when unreadable. */
export function readAddr(t) {
  const s = String(t ?? '').trim().replace(/_/g, '');
  if (/^0x[0-9a-f]{1,9}$/i.test(s)) { const v = parseInt(s, 16); return v <= 0xFFFFFFFF ? v : null; }
  if (/^\d+$/.test(s)) { const v = Number(s); return v <= 0xFFFFFFFF ? v : null; }
  return null;
}
/** "32", "1K", "512K", "2M", "4G", "0x8000" -> bytes. */
export function readSize(t) {
  const s = String(t ?? '').trim().replace(/_/g, '').replace(/\s+/g, '');
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  const m = /^(\d+(?:\.\d+)?)(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(s);
  if (!m) return null;
  const u = (m[2] || 'b').toLowerCase()[0];
  const v = Number(m[1]) * (u === 'k' ? 1024 : u === 'm' ? 1048576 : u === 'g' ? 1073741824 : 1);
  return Number.isFinite(v) && v > 0 && v <= GB4 ? Math.round(v) : null;
}
const yes = (v) => /^(y|yes|true|1|on)$/i.test(String(v ?? '').trim());
const pow2up = (n) => { let p = 32; while (p < n && p < GB4) p *= 2; return p; };

export function run(input) {
  const warnings = [];
  const notes = [];
  const devId = DEVICES[input.device] ? input.device : 'custom';
  const dev = DEVICES[devId];
  const arch = dev ? dev.arch : (input.arch === 'v8m' ? 'v8m' : 'v7m');
  const v8 = arch === 'v8m';
  const count = dev ? dev.regions : Math.max(1, Math.min(16, Math.round(Number(input.regionCount) || 8)));
  const core = dev ? dev.core : (v8 ? 'm33' : 'm4');
  const privdef = !!input.privdefena;
  const hfnmi = !!input.hfnmiena;

  // ---- memory areas ----
  let areas = [];
  if (dev) areas = dev.areas.map((a) => ({ ...a }));
  else {
    (Array.isArray(input.areas) ? input.areas : []).forEach((a, i) => {
      const base = readAddr(a.base), size = readSize(a.size);
      if (base == null || size == null) { warnings.push(`Memory area ${i + 1} "${a.name || ''}": base "${a.base}" or size "${a.size}" does not read (use 0x20000000 and 128K).`); return; }
      areas.push({ name: String(a.name || `Area ${i + 1}`), base, size: Math.min(size, GB4 - base), kind: ['flash', 'ram', 'periph', 'ext'].includes(a.kind) ? a.kind : 'ram' });
    });
    if (!areas.length) areas.push({ name: 'Code', base: 0, size: 0x20000000, kind: 'flash' }, { name: 'SRAM', base: 0x20000000, size: 0x20000000, kind: 'ram' });
  }
  areas.sort((a, b) => a.base - b.base);

  // ---- regions ----
  const rowsIn = Array.isArray(input.regions) ? input.regions : [];
  const regions = [];
  rowsIn.forEach((r, i) => {
    const name = String(r.name ?? '').trim() || `Region ${i}`;
    const reqBase = readAddr(r.base);
    const reqSize = readSize(r.size);
    const reg = { n: i, row: i, name, enabled: r.en == null ? true : yes(r.en), problems: [], issues: [] };
    if (reqBase == null || reqSize == null) {
      reg.enabled = false; reg.bad = true;
      warnings.push(`R${i} ${name}: base "${r.base}" or size "${r.size}" does not read - write the base as 0x20000000 and the size as 32, 1K, 128K, 2M or 4G. The region is left out.`);
      regions.push({ ...reg, base: 0, size: 32, end: 32, reqBase: 0, reqSize: 32, ap: 'none', xn: true, type: 'normal-wbwa', s: false, srd: 0 });
      return;
    }
    const ap = AP[r.ap] ? r.ap : 'rw';
    const type = TYPES[r.type] ? r.type : 'normal-wbwa';
    let srd = 0;
    const srdText = String(r.srd ?? '').trim();
    if (srdText) {
      const v = /^0x[0-9a-f]{1,2}$/i.test(srdText) ? parseInt(srdText, 16) : /^0b[01]{1,8}$/i.test(srdText) ? parseInt(srdText.slice(2), 2) : /^\d+$/.test(srdText) ? Number(srdText) : NaN;
      if (Number.isFinite(v) && v <= 255) srd = v;
      else reg.problems.push(`SRD "${srdText}" is not an 8-bit mask (0x00-0xFF)`);
    }
    let base = reqBase, size = reqSize;
    if (!v8) {
      if (size < 32) { reg.problems.push(`size ${size} B is below the 32-byte minimum; programmed as 32 B`); size = 32; }
      const p = pow2up(size);
      if (p !== size) {
        const sub = p / 8;
        const extra = p - size;
        const hint = p >= 256 && extra % sub === 0 && reqBase % p === 0
          ? ` ${sizeName(p)} with SRD ${hexs(((0xFF << (8 - extra / sub)) & 0xFF))} (top ${extra / sub} subregions off) covers exactly ${sizeName(size)}.`
          : ' Split it into two regions, or use a bigger one with subregions disabled.';
        reg.problems.push(`size ${sizeName(size)} is not a power of two: RASR.SIZE can only give ${sizeName(p)}.${hint}`);
        size = p;
      }
      if (base % size !== 0) {
        const eff = base - (base % size);
        reg.problems.push(`base ${hex8(base)} is not aligned to its ${sizeName(size)} size: the MPU ignores the low bits and the region really starts at ${hex8(eff)} (aligned bases: ${hex8(eff)} or ${hex8(Math.min(GB4 - size, eff + size))})`);
        base = eff;
      }
      if (srd && size < 256) { reg.problems.push(`subregions need a region of 256 B or more; SRD ${hexs(srd)} is ignored on a ${sizeName(size)} region (must be 0)`); srd = 0; }
    } else {
      if (base % 32) { reg.problems.push(`base ${hex8(base)} is not 32-byte aligned: RBAR.BASE drops the low 5 bits, so it starts at ${hex8(base - base % 32)}`); base -= base % 32; }
      const endReq = reqBase + reqSize;
      let end = Math.ceil(endReq / 32) * 32;
      if (end !== endReq) reg.problems.push(`the end ${hex8(endReq)} is not on a 32-byte boundary: RLAR.LIMIT covers up to ${hex8(end - 1)}`);
      size = Math.max(32, end - base);
      if (srd) { reg.problems.push('Armv8-M has no subregions; SRD is ignored'); srd = 0; }
      if (ap === 'none') reg.problems.push('Armv8-M has no "no access" permission: this region is programmed Privileged RO + XN. For a stack guard use MSPLIM/PSPLIM, or leave the range uncovered with PRIVDEFENA = 0');
      if (ap === 'priv-rw-user-ro') reg.problems.push('Armv8-M has no "privileged RW, unprivileged RO" permission: programmed as Full access');
    }
    if (base + size > GB4) { reg.problems.push(`${hex8(base)} + ${sizeName(size)} runs past the 4 GB address space`); size = GB4 - base; }
    Object.assign(reg, { base, size, end: base + size, reqBase, reqSize, ap, xn: yes(r.xn), type, s: yes(r.s), srd });
    regions.push(reg);
  });
  if (regions.length > count) warnings.push(`${regions.length} regions but the ${dev ? dev.name.split(' (')[0] : 'core'} MPU has ${count} (MPU_TYPE.DREGION): R${count}..R${regions.length - 1} cannot be programmed. Merge regions or use subregions.`);
  const live = regions.filter((r) => r.enabled && !r.bad && r.n < count);

  // ---- per-region findings ----
  const overlapsArea = (r, kind) => areas.some((a) => a.kind === kind && r.base < a.base + a.size && r.end > a.base);
  for (const r of regions) {
    if (r.bad) continue;
    const t = TYPES[r.type];
    const ap = AP[r.ap];
    if (!r.enabled) continue;
    if (!r.xn && ap.w && (overlapsArea(r, 'ram') || overlapsArea(r, 'ext') && t.normal && r.ap !== 'ro')) r.issues.push('writable and executable RAM: an overflow can plant code there. Set XN unless code runs from RAM (ramfunc) - then give that code its own small RX region');
    if (!r.xn && !t.normal) r.issues.push('Device/Strongly-ordered memory must be execute-never: instruction fetches from it are UNPREDICTABLE. Set XN');
    if (overlapsArea(r, 'periph') && t.normal && t.cached) r.issues.push('peripheral registers marked cacheable Normal memory: reads can come from the cache and writes can merge or reorder. Use Device');
    if (overlapsArea(r, 'periph') && t.normal && !t.cached) r.issues.push('peripheral registers marked Normal: accesses can be merged, repeated or speculated. Use Device');
    if (r.xn && overlapsArea(r, 'flash') && r.size >= 0x4000 && (r.ap === 'ro' || r.ap === 'priv-ro' || r.ap === 'rw') && areas.some((a) => a.kind === 'flash' && r.base <= a.base && r.end >= a.base + a.size)) r.issues.push('the whole flash is execute-never: the core cannot run from it');
    if (ap.w && overlapsArea(r, 'flash') && !overlapsArea(r, 'ram')) notes.push(`R${r.n} ${r.name}: flash marked writable - harmless (writes go through the flash controller), but RO catches stray writes as MemManage faults.`);
    if (core === 'm7' && t.normal && t.cached && r.s && !v8) r.issues.push('Cortex-M7 does not cache Normal memory marked Shareable (unless CACR.SIWT): S = 1 makes this region effectively non-cacheable. Clear S for cached SRAM; use a non-cacheable region for DMA buffers instead');
    if (v8 && r.s && !t.normal) r.issues.push('shareability is ignored for Device memory');
  }
  for (const r of regions) for (const p of r.problems) warnings.push(`R${r.n} ${r.name}: ${p.replace(/\.$/, '')}.`);
  for (const r of regions) for (const p of r.issues) warnings.push(`R${r.n} ${r.name}: ${p}.`);

  // Overlaps.
  const overlaps = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (a.base < b.end && b.base < a.end) overlaps.push([a, b, Math.max(a.base, b.base), Math.min(a.end, b.end)]);
  }
  if (v8) for (const [a, b, lo, hi] of overlaps) warnings.push(`R${a.n} ${a.name} and R${b.n} ${b.name} overlap at ${hex8(lo)}-${hex8(hi - 1)}: on Armv8-M any access that hits two enabled regions is a MemManage fault. Split one of them around the other.`);
  else if (overlaps.length) notes.push(`Overlaps (the higher region number wins on Armv7-M): ${overlaps.slice(0, 6).map(([a, b]) => `R${b.n} ${b.name} over R${a.n} ${a.name}`).join(', ')}.`);

  // Stack guard.
  const guard = live.find((r) => r.ap === 'none' && r.size <= 0x1000 && overlapsArea(r, 'ram'));
  if (!v8 && !guard) warnings.push('No stack guard: no small no-access region sits in RAM, so a stack overflow silently corrupts whatever is below the stack. Add a 32-256 B no-access region just below each stack (the highest region numbers, so they win).');
  if (v8) notes.push('Armv8-M: use MSPLIM/PSPLIM for stack overflow (a UsageFault STKOF, no MPU region needed); in an RTOS the port reloads PSPLIM per task.');

  // ---- effective map: which region wins where ----
  const segs = [];
  for (const a of areas) {
    const aEnd = a.base + a.size;
    const cuts = new Set([a.base, aEnd]);
    for (const r of live) {
      if (r.end <= a.base || r.base >= aEnd) continue;
      if (r.base > a.base) cuts.add(r.base);
      if (r.end < aEnd) cuts.add(r.end);
      if (!v8 && r.srd && r.size >= 256) for (let k = 1; k < 8; k++) { const c = r.base + (r.size / 8) * k; if (c > a.base && c < aEnd) cuts.add(c); }
    }
    const pts = [...cuts].sort((x, y) => x - y);
    const list = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const s0 = pts[i], s1 = pts[i + 1];
      const hits = live.filter((r) => r.base <= s0 && r.end >= s1 && (v8 || !(r.size >= 256 && ((r.srd >> Math.floor((s0 - r.base) / (r.size / 8))) & 1))));
      let win, kind;
      if (!hits.length) { win = null; kind = privdef ? 'default' : 'fault'; }
      else if (v8 && hits.length > 1) { win = null; kind = 'overlap'; }
      else { win = hits.reduce((m, r) => (r.n > m.n ? r : m)); kind = 'region'; }
      const prev = list[list.length - 1];
      const key = kind + (win ? win.n : '');
      if (prev && prev.key === key) prev.end = s1;
      else list.push({ area: a.name, start: s0, end: s1, kind, region: win ? win.n : null, key, hits: hits.map((h) => h.n) });
    }
    segs.push(...list);
  }
  const describe = (sg) => {
    if (sg.kind === 'fault') return 'no region, PRIVDEFENA = 0: every access faults';
    if (sg.kind === 'default') return 'no region: default map for privileged code, unprivileged faults';
    if (sg.kind === 'overlap') return 'two regions overlap: every access faults';
    const r = regions[sg.region];
    const ap = AP[r.ap];
    return `R${r.n} ${r.name}: priv ${ap.priv}, user ${ap.user}${r.xn ? ', XN' : ', exec'} · ${TYPES[r.type].label}`;
  };
  for (const a of areas) {
    const inA = segs.filter((sg) => sg.area === a.name);
    const unc = inA.filter((sg) => sg.kind === 'fault');
    if (unc.length) warnings.push(`${a.name}: ${unc.map((u) => `${hex8(u.start)}-${hex8(u.end - 1)}`).slice(0, 3).join(', ')} is covered by no region and PRIVDEFENA is 0, so even privileged code faults there${a.kind === 'flash' ? ' - including the code itself' : ''}.`);
  }
  for (const r of live) if (!areas.some((a) => r.base < a.base + a.size && r.end > a.base)) notes.push(`R${r.n} ${r.name} (${hex8(r.base)}, ${sizeName(r.size)}) covers no memory of this part.`);
  if (!privdef) notes.push('PRIVDEFENA = 0: privileged code gets no background map; anything no region covers faults (vector table reads excepted).');
  if (hfnmi) notes.push('HFNMIENA = 1: the MPU stays on inside HardFault and NMI handlers, so they must only touch memory their regions allow.');

  // ---- registers and code ----
  const mair = [];
  const attrIdx = (t) => { let i = mair.indexOf(t); if (i < 0) { mair.push(t); i = mair.length - 1; } return i; };
  const regRows = [];
  const table = [];
  for (const r of regions) {
    if (r.bad || r.n >= count) continue;
    const t = TYPES[r.type];
    if (!v8) {
      const sizeField = Math.round(Math.log2(r.size)) - 1;
      const rbar = r.base + 0x10 + r.n;
      const s = r.s ? 1 : 0;   // S is ignored for Device and Strongly-ordered (always shareable)
      const rasr = (r.xn ? 2 ** 28 : 0) + AP[r.ap].v7 * 2 ** 24 + t.tex * 2 ** 19 + (t.normal ? s : 0) * 2 ** 18 + t.c * 2 ** 17 + t.b * 2 ** 16 + r.srd * 256 + sizeField * 2 + (r.enabled ? 1 : 0);
      r.regs = { RBAR: hex8(rbar), RASR: hex8(rasr) };
      regRows.push([`R${r.n}`, r.name, hex8(r.base), sizeName(r.size), AP[r.ap].label, r.xn ? 'yes' : 'no', t.label, r.srd ? hexs(r.srd) : '-', hex8(rbar), hex8(rasr)]);
      table.push(`  /* R${r.n} ${r.name}: ${hex8(r.base)}, ${sizeName(r.size)}, ${AP[r.ap].label}, ${r.xn ? 'XN' : 'exec'}, ${t.label}${r.srd ? `, subregions off ${hexs(r.srd)}` : ''} */\n  { .RBAR = ARM_MPU_RBAR(${r.n}U, ${hex8(r.base)}U), .RASR = ${r.enabled ? `ARM_MPU_RASR(${r.xn ? 1 : 0}U, ${AP[r.ap].cm7}, ${t.tex}U, ${t.normal && r.s ? 1 : 0}U, ${t.c}U, ${t.b}U, ${hexs(r.srd)}U, ${cmsisSize(r.size)})` : '0U /* disabled */'} },   /* ${hex8(rbar)}, ${hex8(rasr)} */`);
    } else {
      const apk = AP[r.ap].v8 || (r.ap === 'none' ? [1, 0] : [0, 1]);
      const sh = t.normal ? (r.s ? 3 : 0) : 0;
      const idx = attrIdx(r.type);
      const limit = r.end - 32;
      const rbar = r.base + sh * 8 + (apk[0] * 2 + apk[1]) * 2 + ((r.xn || r.ap === 'none') ? 1 : 0);
      const rlar = limit + idx * 2 + (r.enabled ? 1 : 0);
      r.regs = { RBAR: hex8(rbar), RLAR: hex8(rlar), attr: idx };
      regRows.push([`R${r.n}`, r.name, hex8(r.base), hex8(r.end - 1), AP[r.ap].label, r.xn || r.ap === 'none' ? 'yes' : 'no', t.label, `Attr${idx}`, hex8(rbar), hex8(rlar)]);
      table.push(`  /* R${r.n} ${r.name}: ${hex8(r.base)}-${hex8(r.end - 1)}, ${AP[r.ap].label}, ${r.xn ? 'XN' : 'exec'}, ${t.label} */\n  { .RBAR = ARM_MPU_RBAR(${hex8(r.base)}U, ${['ARM_MPU_SH_NON', '1U', 'ARM_MPU_SH_OUTER', 'ARM_MPU_SH_INNER'][sh]}, ${apk[0]}U, ${apk[1]}U, ${(r.xn || r.ap === 'none') ? 1 : 0}U), .RLAR = ${r.enabled ? `ARM_MPU_RLAR(${hex8(r.end - 32)}U, ${idx}U)` : '0U /* disabled */'} },   /* ${hex8(rbar)}, ${hex8(rlar)} */`);
    }
  }
  if (v8 && mair.length > 8) warnings.push(`${mair.length} different memory types but MAIR0/MAIR1 hold 8 attributes.`);
  const mairVals = [0, 0];
  mair.forEach((t, i) => { mairVals[i >> 2] += TYPES[t].mair * 2 ** (8 * (i & 3)); });
  const ctrl = 1 + (hfnmi ? 2 : 0) + (privdef ? 4 : 0);
  const n = table.length;
  const code = [];
  code.push(`/* MPU set-up for ${dev ? dev.name : `a custom ${v8 ? 'Armv8-M' : 'Armv7-M'} part`}. CMSIS-Core ${v8 ? 'mpu_armv8.h' : 'mpu_armv7.h'} (pulled in by the core header). */`);
  code.push('#include "cmsis_device.h"   /* your part\'s device header, e.g. stm32f4xx.h */', '');
  code.push(`static const ARM_MPU_Region_t mpu_regions[${n}] = {`, ...table, '};', '');
  code.push('void mpu_init(void)', '{', '  ARM_MPU_Disable();');
  if (v8) {
    mair.forEach((t, i) => code.push(`  ARM_MPU_SetMemAttr(${i}U, ${TYPES[t].mairC});   /* Attr${i} = 0x${TYPES[t].mair.toString(16).toUpperCase().padStart(2, '0')}: ${TYPES[t].label} */`));
    code.push(`  ARM_MPU_Load(0U, mpu_regions, ${n}U);`);
    if (n < count) code.push(`  for (uint32_t i = ${n}U; i < ${count}U; i++) { ARM_MPU_ClrRegion(i); }`);
  } else {
    code.push(`  ARM_MPU_Load(mpu_regions, ${n}U);`);
    if (n < count) code.push(`  for (uint32_t i = ${n}U; i < ${count}U; i++) { ARM_MPU_ClrRegion(i); }`);
  }
  code.push(`  ARM_MPU_Enable(${[privdef ? 'MPU_CTRL_PRIVDEFENA_Msk' : '', hfnmi ? 'MPU_CTRL_HFNMIENA_Msk' : ''].filter(Boolean).join(' | ') || '0U'});   /* MPU_CTRL = ${hexs(ctrl)}; also enables MemManage (SHCSR.MEMFAULTENA) */`);
  code.push('}');
  if (core === 'm7') code.push('', '/* Cortex-M7: call mpu_init() before SCB_EnableICache()/SCB_EnableDCache(), and keep DMA buffers in a non-cacheable region. */');

  const effRows = segs.map((sg) => [sg.area, hex8(sg.start), hex8(sg.end - 1), sizeName(sg.end - sg.start), describe(sg)]);
  const values = [
    { label: 'Architecture', value: v8 ? 'Armv8-M PMSAv8' : 'Armv7-M PMSAv7' },
    { label: 'Regions used', value: `${Math.min(regions.length, count)} of ${count}`, tone: regions.length > count ? 'bad' : undefined },
    { label: 'MPU_CTRL', value: hexs(ctrl), hint: `ENABLE${privdef ? ' | PRIVDEFENA' : ''}${hfnmi ? ' | HFNMIENA' : ''}` },
    { label: 'Stack guard', value: v8 ? 'use PSPLIM/MSPLIM' : guard ? `R${guard.n} ${guard.name}` : 'none', tone: v8 ? undefined : guard ? 'ok' : 'warn' },
  ];
  if (v8) { values.push({ label: 'MAIR0', value: hex8(mairVals[0]) }); values.push({ label: 'MAIR1', value: hex8(mairVals[1]) }); }

  return {
    values,
    tables: [
      { title: 'Regions and register values', columns: v8 ? ['Region', 'Name', 'Base', 'Limit', 'Access', 'XN', 'Type', 'Attr', 'RBAR', 'RLAR'] : ['Region', 'Name', 'Base', 'Size', 'Access', 'XN', 'Type', 'SRD', 'RBAR', 'RASR'], rows: regRows },
      { title: 'Effective map (who wins at each address)', columns: ['Memory', 'From', 'To', 'Size', 'Access'], rows: effRows },
    ],
    texts: [{ title: 'mpu_init.c', body: code.join('\n') + '\n', lang: 'c' }],
    warnings,
    notes,
    view: {
      arch, v8, count, core, device: devId, deviceName: dev ? dev.name : 'Custom', privdef, hfnmi,
      areas, segs: segs.map(({ key, ...x }) => x),
      regions: regions.map((r) => ({ n: r.n, name: r.name, base: r.base, size: r.size, end: r.end, reqBase: r.reqBase, reqSize: r.reqSize, ap: r.ap, xn: r.xn, type: r.type, s: r.s, srd: r.srd, enabled: r.enabled, bad: !!r.bad, over: r.n >= count, problems: r.problems, issues: r.issues, regs: r.regs || null })),
      mair: mair.map((t, i) => ({ idx: i, type: t, value: TYPES[t].mair })),
      presets: PRESETS,
    },
  };
}
