// HardFault Decoder: the Cortex-M fault status registers decoded bit by bit,
// the stacked exception frame read, and the likely cause named.
//
// Pure: no DOM. Bit positions and names are the architecture's:
//   Armv7-M ARM (DDI 0403E) B3.2.15 CFSR (MMFSR/BFSR/UFSR), B3.2.16 HFSR,
//     B3.2.17 MMFAR, B3.2.18 BFAR, C1.6.1 DFSR, B1.5.6-B1.5.8 exception
//     entry/return, frame layout and EXC_RETURN values, B3.1 default memory map
//   Armv8-M ARM (DDI 0553) D1.2 CFSR (adds UFSR.STKOF), SFSR/SFAR,
//     EXC_RETURN bits S, DCRS, FType, Mode, SPSEL, ES
//   Armv6-M ARM (DDI 0419) B1.5: no CFSR/HFSR/MMFAR/BFAR, HardFault only
//   CMSIS-Core core_cm4.h / core_cm33.h SCB_CFSR_*_Pos (same positions)
//   Cortex-M3/M4 TRM: MMFAR and BFAR share one physical register.

const CORES = {
  m0: { name: 'Cortex-M0', arch: 'v6m', fp: false },
  m0plus: { name: 'Cortex-M0+', arch: 'v6m', fp: false },
  m3: { name: 'Cortex-M3', arch: 'v7m', fp: false, sharedFar: true, disdefwbuf: true },
  m4: { name: 'Cortex-M4', arch: 'v7m', fp: true, sharedFar: true, disdefwbuf: true },
  m7: { name: 'Cortex-M7', arch: 'v7m', fp: true },
  m23: { name: 'Cortex-M23', arch: 'v8mb', fp: false },
  m33: { name: 'Cortex-M33', arch: 'v8mm', fp: true },
  m55: { name: 'Cortex-M55', arch: 'v8mm', fp: true },
};

// CFSR bits. `only`: 'fp' needs the FP extension, 'v8' needs Armv8-M Mainline.
const CFSR_BITS = [
  { bit: 0, name: 'IACCVIOL', group: 'MMFSR', kind: 'fault', desc: 'Instruction fetch from a location the MPU forbids or the default map marks execute-never. MMFAR is not written; the stacked PC is the address that could not be fetched.' },
  { bit: 1, name: 'DACCVIOL', group: 'MMFSR', kind: 'fault', desc: 'Load or store to an address the MPU forbids. MMFAR holds the address when MMARVALID is set; the stacked PC is the faulting instruction.' },
  { bit: 3, name: 'MUNSTKERR', group: 'MMFSR', kind: 'fault', desc: 'MemManage fault while unstacking on exception return: the MPU forbids the stack the frame is read back from.' },
  { bit: 4, name: 'MSTKERR', group: 'MMFSR', kind: 'fault', desc: 'MemManage fault while stacking on exception entry: SP points into a forbidden region - usually a stack overflow into an MPU guard. The stacked frame is incomplete.' },
  { bit: 5, name: 'MLSPERR', group: 'MMFSR', kind: 'fault', only: 'fp', desc: 'MemManage fault during lazy floating-point state preservation (the FP space reserved on the stack is forbidden).' },
  { bit: 7, name: 'MMARVALID', group: 'MMFSR', kind: 'valid', desc: 'MMFAR holds the address of the faulting access.' },
  { bit: 8, name: 'IBUSERR', group: 'BFSR', kind: 'fault', desc: 'Bus error on an instruction fetch (prefetch abort), raised only if the instruction is executed. Branch target in unmapped memory or code in a region with no bus behind it.' },
  { bit: 9, name: 'PRECISERR', group: 'BFSR', kind: 'fault', desc: 'Precise data bus error: the stacked PC is the faulting instruction and BFAR holds the address when BFARVALID is set.' },
  { bit: 10, name: 'IMPRECISERR', group: 'BFSR', kind: 'fault', desc: 'Imprecise data bus error: a buffered write failed after the instruction had retired. The stacked PC is some instructions later; BFAR is not valid.' },
  { bit: 11, name: 'UNSTKERR', group: 'BFSR', kind: 'fault', desc: 'Bus error while unstacking on exception return: SP was corrupted in the handler or points to unmapped memory.' },
  { bit: 12, name: 'STKERR', group: 'BFSR', kind: 'fault', desc: 'Bus error while stacking on exception entry: SP ran off the RAM (stack overflow past the start of RAM). The stacked frame is incomplete.' },
  { bit: 13, name: 'LSPERR', group: 'BFSR', kind: 'fault', only: 'fp', desc: 'Bus error during lazy floating-point state preservation.' },
  { bit: 15, name: 'BFARVALID', group: 'BFSR', kind: 'valid', desc: 'BFAR holds the address of the faulting access.' },
  { bit: 16, name: 'UNDEFINSTR', group: 'UFSR', kind: 'fault', desc: 'Undefined instruction: executing data or erased flash (0xFFFF), a corrupted image, or code built for a bigger core (FPU/DSP instructions on a core without them).' },
  { bit: 17, name: 'INVSTATE', group: 'UFSR', kind: 'fault', desc: 'Invalid state: tried to execute with EPSR.T = 0 (Arm state). A branch to an address with bit 0 clear: a corrupt function pointer or a vector-table entry without the Thumb bit.' },
  { bit: 18, name: 'INVPC', group: 'UFSR', kind: 'fault', desc: 'Invalid PC load on exception return: a bad EXC_RETURN value (LR corrupted in the handler, or the handler returned with a mismatched stack).' },
  { bit: 19, name: 'NOCP', group: 'UFSR', kind: 'fault', desc: 'No coprocessor: an FPU instruction while the FPU is disabled (CPACR CP10/CP11 not set), or on a core without an FPU.' },
  { bit: 20, name: 'STKOF', group: 'UFSR', kind: 'fault', only: 'v8', desc: 'Stack overflow: SP went below MSPLIM/PSPLIM (Armv8-M stack limit check).' },
  { bit: 24, name: 'UNALIGNED', group: 'UFSR', kind: 'fault', desc: 'Unaligned access: LDM/STM/LDRD/STRD/exclusive access to an unaligned address (always faults), or any unaligned access while CCR.UNALIGN_TRP is set.' },
  { bit: 25, name: 'DIVBYZERO', group: 'UFSR', kind: 'fault', desc: 'Integer divide by zero (SDIV/UDIV) while CCR.DIV_0_TRP is set.' },
];
const HFSR_BITS = [
  { bit: 1, name: 'VECTTBL', kind: 'fault', desc: 'Bus error on a vector table read during exception processing: VTOR points to unmapped memory or the table is not where the vector fetch looks.' },
  { bit: 30, name: 'FORCED', kind: 'fault', desc: 'A configurable fault escalated to HardFault: its handler is disabled in SHCSR, or it happened at a priority that cannot take it (inside a handler of equal or higher priority, or with FAULTMASK/PRIMASK). The cause is in CFSR.' },
  { bit: 31, name: 'DEBUGEVT', kind: 'fault', desc: 'A debug event escalated to HardFault: a BKPT (or semihosting call) executed with no debugger attached. See DFSR.' },
];
const DFSR_BITS = [
  { bit: 0, name: 'HALTED', kind: 'info', desc: 'Halt request or step.' },
  { bit: 1, name: 'BKPT', kind: 'fault', desc: 'BKPT instruction executed (or a breakpoint unit match). Without a debugger this escalates to HardFault - often a semihosting printf or an assert BKPT.' },
  { bit: 2, name: 'DWTTRAP', kind: 'info', desc: 'DWT watchpoint or trace event.' },
  { bit: 3, name: 'VCATCH', kind: 'info', desc: 'Vector catch triggered.' },
  { bit: 4, name: 'EXTERNAL', kind: 'info', desc: 'External debug request (EDBGRQ).' },
];
const SFSR_BITS = [
  { bit: 0, name: 'INVEP', kind: 'fault', desc: 'Invalid entry point: Non-secure code branched into Secure memory not at an SG instruction in NSC memory.' },
  { bit: 1, name: 'INVIS', kind: 'fault', desc: 'Invalid integrity signature in the exception stack frame on return to Secure state.' },
  { bit: 2, name: 'INVER', kind: 'fault', desc: 'Invalid exception return: EXC_RETURN.DCRS/ES do not match the state being returned to.' },
  { bit: 3, name: 'AUVIOL', kind: 'fault', desc: 'Attribution unit violation: Non-secure access to a Secure address (SAU/IDAU).' },
  { bit: 4, name: 'INVTRAN', kind: 'fault', desc: 'Invalid transition: a branch from Secure to Non-secure not using BXNS/BLXNS.' },
  { bit: 5, name: 'LSPERR', kind: 'fault', desc: 'SAU/IDAU violation during lazy FP state preservation.' },
  { bit: 6, name: 'SFARVALID', kind: 'valid', desc: 'SFAR holds the faulting address.' },
  { bit: 7, name: 'LSERR', kind: 'fault', desc: 'Lazy state error on activation or deactivation of lazy FP state.' },
];

// Armv7-M B3.1 default memory map (Armv6-M and Armv8-M use the same split).
const REGIONS = [
  [0x00000000, 0x1FFFFFFF, 'Code', false],
  [0x20000000, 0x3FFFFFFF, 'SRAM', false],
  [0x40000000, 0x5FFFFFFF, 'Peripheral', true],
  [0x60000000, 0x9FFFFFFF, 'External RAM', false],
  [0xA0000000, 0xDFFFFFFF, 'External device', true],
  [0xE0000000, 0xE00FFFFF, 'Private peripheral bus', true],
  [0xE0100000, 0xFFFFFFFF, 'Vendor system', true],
];
const regionOf = (a) => REGIONS.find(([lo, hi]) => a >= lo && a <= hi) || REGIONS[0];

const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const hexs = (v) => '0x' + (v >>> 0).toString(16).toUpperCase();

/** A register value: hex with or without 0x, underscores allowed. null when empty, NaN-free. */
function readHex(text) {
  const t = String(text ?? '').trim().replace(/_/g, '').replace(/^0x/i, '');
  if (!t) return { v: null };
  if (/^0d\d+$/i.test(t)) { const n = Number(t.slice(2)); return n <= 0xFFFFFFFF ? { v: n >>> 0 } : { bad: true }; }
  if (!/^[0-9a-f]{1,8}$/i.test(t)) return { bad: true };
  return { v: parseInt(t, 16) >>> 0 };
}

const FRAME_NAMES = ['R0', 'R1', 'R2', 'R3', 'R12', 'LR', 'PC', 'xPSR'];
const REG_ALIASES = {
  CFSR: 'cfsr', HFSR: 'hfsr', MMFAR: 'mmfar', MMAR: 'mmfar', BFAR: 'bfar', DFSR: 'dfsr', AFSR: 'afsr', SFSR: 'sfsr', SFAR: 'sfar',
  EXC_RETURN: 'excReturn', EXCRETURN: 'excReturn', EXC: 'excReturn',
  R0: 'R0', R1: 'R1', R2: 'R2', R3: 'R3', R12: 'R12', IP: 'R12', LR: 'LR', R14: 'LR', PC: 'PC', R15: 'PC',
  XPSR: 'xPSR', PSR: 'xPSR', SP: 'SP', MSP: 'MSP', PSP: 'PSP', R13: 'SP',
  MMFSR: 'mmfsr', BFSR: 'bfsr', UFSR: 'ufsr',
};

/**
 * Read a fault printout and/or a memory dump.
 * Named lines ("CFSR = 0x00008200", "pc: 0x0800..", "R0 0x2000..") fill the
 * registers; address-prefixed lines ("0x20001f48: 0x... 0x...", gdb's
 * "0x20001f48 <sym>:\t0x...", OpenOCD's "0x20001f48: 20020000 ...") and bare
 * words are the stacked frame, in order. Byte dumps (two hex digits per
 * token) are grouped four at a time, little-endian.
 */
export function parseDump(text) {
  const named = {};
  const words = [];
  let addr = null;
  const unread = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$|#.*$/, '').trim();
    if (!line) return;
    // Named registers anywhere on the line: NAME [:=]? value
    const re = /\b(EXC_RETURN|EXCRETURN|CFSR|HFSR|MMFAR|MMAR|BFAR|DFSR|AFSR|SFSR|SFAR|MMFSR|BFSR|UFSR|XPSR|PSR|PSP|MSP|SP|R1[0-5]|R[0-9]|IP|LR|PC)\b\s*[:=]?\s*(?:0x)?([0-9a-f]{1,8})\b/gi;
    let m, any = false;
    while ((m = re.exec(line))) {
      const key = REG_ALIASES[m[1].toUpperCase()];
      if (!key) continue;
      any = true;
      let v = parseInt(m[2], 16) >>> 0;
      let k = key;
      // "LR" printed by a handler is EXC_RETURN when it looks like one.
      if (k === 'LR' && v >= 0xFFFFFF00 && named.excReturn == null) k = 'excReturn';
      if (named[k] == null) named[k] = v;
    }
    if (any) return;
    const am = /^(?:0x)?([0-9a-f]{8})\s*(?:<[^>]*>)?\s*:\s*(.*)$/i.exec(line);
    let rest = line;
    if (am) {
      const a = parseInt(am[1], 16) >>> 0;
      if (addr == null) addr = (a - words.length * 4) >>> 0;
      rest = am[2];
    }
    const toks = rest.split(/[\s,;]+/).filter(Boolean).map((t) => t.replace(/^0x/i, ''));
    if (!toks.length) return;
    // A heading or prompt line with no word-sized hex in it ("[HardFault]",
    // "(gdb) x/8wx $psp") is not data.
    if (!am && !toks.some((t) => /^[0-9a-f]{4,8}$/i.test(t))) return;
    if (!toks.every((t) => /^[0-9a-f]+$/i.test(t))) {
      // A trailing ASCII column (hexdump -C) is ignored; anything else is reported.
      const hexOnly = [];
      for (const t of toks) { if (/^[0-9a-f]{2,8}$/i.test(t)) hexOnly.push(t); else break; }
      if (!hexOnly.length) { unread.push(`line ${i + 1}: ${raw.trim().slice(0, 60)}`); return; }
      toks.length = 0; toks.push(...hexOnly);
    }
    if (toks.every((t) => t.length === 2) && toks.length >= 4) {
      for (let j = 0; j + 3 < toks.length; j += 4) {
        words.push((parseInt(toks[j + 3] + toks[j + 2] + toks[j + 1] + toks[j], 16)) >>> 0);
      }
    } else {
      for (const t of toks) {
        if (t.length > 8) { unread.push(`line ${i + 1}: ${t} is longer than a 32-bit word`); continue; }
        words.push(parseInt(t, 16) >>> 0);
      }
    }
  });
  return { named, words, addr, unread };
}

const bitsOf = (v, defs) => defs.map((d) => ({ ...d, set: v != null && ((v >>> d.bit) & 1) === 1 }));

function decodeExc(v, arch) {
  if (v == null) return null;
  const out = { value: v, valid: true, problems: [] };
  const v8 = arch === 'v8mb' || arch === 'v8mm';
  if (!v8) {
    const ok = arch === 'v6m' ? [0xFFFFFFF1, 0xFFFFFFF9, 0xFFFFFFFD] : [0xFFFFFFF1, 0xFFFFFFF9, 0xFFFFFFFD, 0xFFFFFFE1, 0xFFFFFFE9, 0xFFFFFFED];
    if (!ok.includes(v)) { out.valid = false; out.problems.push(`${hex8(v)} is not a valid EXC_RETURN on ${arch === 'v6m' ? 'Armv6-M' : 'Armv7-M'} (${ok.map((x) => hexs(x).slice(-2)).join(', ')} in the low byte)`); }
  } else if ((v >>> 24) !== 0xFF) { out.valid = false; out.problems.push(`${hex8(v)} does not start with 0xFF, so it is not an EXC_RETURN`); }
  out.spsel = (v >>> 2) & 1;
  out.mode = (v >>> 3) & 1;
  out.ftype = (v >>> 4) & 1;
  out.fpFrame = out.ftype === 0 && arch !== 'v6m' && arch !== 'v8mb';
  out.v8 = v8;
  if (v8) { out.es = v & 1; out.dcrs = (v >>> 5) & 1; out.s = (v >>> 6) & 1; }
  out.stack = out.spsel ? 'PSP' : 'MSP';
  out.from = out.mode ? 'Thread mode' : 'Handler mode';
  out.bits = v8
    ? [
      { bit: 6, name: 'S', set: out.s === 1, desc: out.s ? 'Frame on the Secure stack' : 'Frame on the Non-secure stack' },
      { bit: 5, name: 'DCRS', set: out.dcrs === 1, desc: out.dcrs ? 'Default callee stacking: basic frame only' : 'Callee registers R4-R11 and an integrity signature were stacked too (10 extra words below the frame)' },
      { bit: 4, name: 'FType', set: out.ftype === 1, desc: out.ftype ? 'Basic 8-word frame' : 'Extended frame with FP registers (26 words)' },
      { bit: 3, name: 'Mode', set: out.mode === 1, desc: out.mode ? 'Returns to Thread mode' : 'Returns to Handler mode (fault inside an ISR)' },
      { bit: 2, name: 'SPSEL', set: out.spsel === 1, desc: out.spsel ? 'Frame is on the process stack (PSP)' : 'Frame is on the main stack (MSP)' },
      { bit: 0, name: 'ES', set: out.es === 1, desc: out.es ? 'Exception taken to Secure state' : 'Exception taken to Non-secure state' },
    ]
    : [
      { bit: 4, name: 'FType', set: out.ftype === 1, desc: out.ftype ? 'Basic 8-word frame' : 'Extended frame with FP registers (26 words)' },
      { bit: 3, name: 'Mode', set: out.mode === 1, desc: out.mode ? 'Returns to Thread mode' : 'Returns to Handler mode (fault inside an ISR)' },
      { bit: 2, name: 'SPSEL', set: out.spsel === 1, desc: out.spsel ? 'Frame is on the process stack (PSP)' : 'Frame is on the main stack (MSP)' },
    ];
  return out;
}

function exceptionName(n) {
  const names = { 0: 'Thread mode', 1: 'Reset', 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 7: 'SecureFault', 11: 'SVCall', 12: 'DebugMonitor', 14: 'PendSV', 15: 'SysTick' };
  if (n >= 16) return `IRQ ${n - 16} (exception ${n})`;
  return names[n] ? `${names[n]}${n ? ` (exception ${n})` : ''}` : `reserved exception ${n}`;
}

/** Where an address falls, in words a person uses when reading BFAR. */
function describeAddr(a) {
  const [lo, , name, xn] = regionOf(a);
  let s = `${name} region${xn ? ' (execute-never in the default map)' : ''}`;
  if (a < 0x400) s += `; ${a === 0 ? 'address 0' : `${hexs(a)} bytes above address 0`}: a NULL pointer${a ? ' plus a member offset or index' : ''}`;
  else if (lo === 0x20000000 || lo === 0x00000000) {
    // Just past a power-of-two boundary from the region base: a buffer or stack
    // that ran off the end of a RAM (or flash) block of that size.
    const off = a - lo;
    for (let p = 1 << 30; p >= 0x1000; p >>>= 1) {
      if (off >= p && off - p < 0x100) {
        const size = p >= 1048576 ? `${p / 1048576} MiB` : `${p / 1024} KiB`;
        s += `; ${hexs(off - p)} bytes past ${hex8(lo + p)} - if this memory is ${size} long, an access off its end`;
        break;
      }
    }
  }
  if (a >= 0xFFFFFF00) s += '; looks like an EXC_RETURN value used as an address';
  return s;
}

export function run(input) {
  const warnings = [];
  const notes = [];
  const core = CORES[input.core] || CORES.m4;
  const arch = core.arch;
  const hasCfsr = arch === 'v7m' || arch === 'v8mm';
  const fpOk = core.fp;
  const dump = parseDump(input.frame);
  if (dump.unread.length) warnings.push(`Could not read ${dump.unread.length} line(s) of the pasted dump: ${dump.unread.slice(0, 3).join('; ')}. Paste register lines as NAME = 0x... or memory as address: word word ...`);

  // Registers: the field when filled, else the value found in the paste.
  const regs = {};
  const src = {};
  const bad = [];
  for (const k of ['cfsr', 'hfsr', 'mmfar', 'bfar', 'dfsr', 'afsr', 'sfsr', 'sfar', 'excReturn', 'sp']) {
    const r = readHex(input[k]);
    if (r.bad) bad.push(k);
    if (r.v != null) { regs[k] = r.v; src[k] = 'field'; } else if (dump.named[k] != null) { regs[k] = dump.named[k]; src[k] = 'paste'; }
  }
  if (bad.length) warnings.push(`Not a 32-bit hex value: ${bad.join(', ')}. Write registers as hex like 0x00008200 (up to 8 digits).`);
  // Sub-registers printed separately (MMFSR/BFSR/UFSR) compose CFSR.
  if (regs.cfsr == null && (dump.named.mmfsr != null || dump.named.bfsr != null || dump.named.ufsr != null)) {
    regs.cfsr = (((dump.named.mmfsr || 0) & 0xFF) | (((dump.named.bfsr || 0) & 0xFF) << 8) | (((dump.named.ufsr || 0) & 0xFFFF) << 16)) >>> 0;
    src.cfsr = 'paste';
  }
  const exc = decodeExc(regs.excReturn, arch);
  if (exc && !exc.valid) warnings.push(`${exc.problems.join('; ')}. Read LR as the first instruction of the fault handler (before any call) - that is EXC_RETURN.`);

  if (!hasCfsr) {
    const present = ['cfsr', 'hfsr', 'mmfar', 'bfar'].filter((k) => regs[k]);
    if (present.length) warnings.push(`${core.name} (${arch === 'v6m' ? 'Armv6-M' : 'Armv8-M Baseline'}) has no ${present.map((k) => k.toUpperCase()).join('/')}: every fault is a plain HardFault with no status register. The values given are ignored - were they read on a different core?`);
  }
  const sfsrOk = arch === 'v8mm' || arch === 'v8mb';
  if (!sfsrOk && regs.sfsr) warnings.push(`${core.name} has no Security Extension, so there is no SFSR; its value is ignored.`);

  // ---- bits ----
  const avail = (d) => !d.only || (d.only === 'fp' && fpOk) || (d.only === 'v8' && arch === 'v8mm');
  const cfsr = hasCfsr ? (regs.cfsr ?? 0) : null;
  const cfsrBits = hasCfsr ? bitsOf(cfsr, CFSR_BITS).map((b) => ({ ...b, available: avail(b) })) : [];
  const hfsr = hasCfsr ? (regs.hfsr ?? 0) : null;
  const hfsrBits = hasCfsr ? bitsOf(hfsr, HFSR_BITS).map((b) => ({ ...b, available: true })) : [];
  const dfsr = regs.dfsr ?? null;
  const dfsrBits = dfsr != null ? bitsOf(dfsr, DFSR_BITS).map((b) => ({ ...b, available: true })) : [];
  const sfsr = sfsrOk ? (regs.sfsr ?? null) : null;
  const sfsrBits = sfsr != null ? bitsOf(sfsr, SFSR_BITS).map((b) => ({ ...b, available: true })) : [];
  const set = (name) => cfsrBits.some((b) => b.name === name && b.set);
  const hset = (name) => hfsrBits.some((b) => b.name === name && b.set);

  if (hasCfsr) {
    const known = CFSR_BITS.filter(avail).reduce((m, d) => m | (1 << d.bit), 0) >>> 0;
    const stray = (cfsr & ~known) >>> 0;
    if (stray) warnings.push(`CFSR bits ${hexs(stray)} are reserved on ${core.name}${(stray & (1 << 20)) && arch !== 'v8mm' ? ' (STKOF exists only on Armv8-M Mainline)' : ''}${(stray & 0x2020) && !fpOk ? ' (MLSPERR/LSPERR need an FPU)' : ''} - check the core, or whether the value was read correctly.`);
    const hstray = (hfsr & ~0xC0000002) >>> 0;
    if (hstray) warnings.push(`HFSR bits ${hexs(hstray)} are reserved; only VECTTBL (1), FORCED (30) and DEBUGEVT (31) exist.`);
  }

  // ---- the frame ----
  let words = dump.words.slice();
  let frameAddr = regs.sp ?? null;
  if (frameAddr == null && exc) {
    const k = exc.spsel ? 'PSP' : 'MSP';
    if (dump.named[k] != null) { frameAddr = dump.named[k]; src.sp = 'paste'; }
  }
  if (frameAddr == null && dump.named.SP != null) { frameAddr = dump.named.SP; src.sp = 'paste'; }
  if (frameAddr == null && dump.addr != null) { frameAddr = dump.addr; src.sp = 'dump'; }
  if (regs.sp == null && frameAddr != null) regs.sp = frameAddr;
  // Armv8-M with DCRS = 0: 10 words of callee context (integrity signature,
  // reserved, R4-R11) sit below the basic frame.
  let extra = null;
  if (exc && exc.v8 && exc.dcrs === 0 && words.length >= 18 && (words[0] & 0xFFFFFFFE) === 0xFEFA125A) {
    extra = words.slice(0, 10);
    words = words.slice(10);
    if (frameAddr != null) frameAddr = (frameAddr + 40) >>> 0;
  }
  const regsNamed = FRAME_NAMES.some((n) => dump.named[n] != null);
  const frameVals = FRAME_NAMES.map((n, i) => dump.named[n] ?? words[i] ?? null);
  const haveFrame = frameVals.some((v) => v != null);
  if (!haveFrame) notes.push('No stacked frame given: paste the 8 words at the faulting SP (MSP or PSP as EXC_RETURN says), or the R0..xPSR lines of a fault printout, to locate the faulting instruction.');
  else if (frameVals.some((v) => v == null)) warnings.push(`Only ${frameVals.filter((v) => v != null).length} of the 8 stacked words were found (need R0, R1, R2, R3, R12, LR, PC, xPSR in that order).`);
  const fpWords = exc && exc.fpFrame && !regsNamed ? words.slice(8, 26) : [];
  if (exc && exc.fpFrame && !regsNamed && haveFrame && words.length < 26) notes.push(`EXC_RETURN says an extended FP frame (26 words); only ${words.length} word(s) were pasted, so S0-S15 and FPSCR are not shown.`);

  const [R0, R1, R2, R3, R12, LR, PC, XPSR] = frameVals;
  const frame = FRAME_NAMES.map((n, i) => ({ off: i * 4, name: n, value: frameVals[i] }));
  fpWords.forEach((v, i) => frame.push({ off: 32 + i * 4, name: i < 16 ? `S${i}` : i === 16 ? 'FPSCR' : '(reserved)', value: v, fp: true }));

  let xpsr = null;
  if (XPSR != null) {
    xpsr = {
      n: (XPSR >>> 31) & 1, z: (XPSR >>> 30) & 1, c: (XPSR >>> 29) & 1, v: (XPSR >>> 28) & 1, q: (XPSR >>> 27) & 1,
      t: (XPSR >>> 24) & 1, align: (XPSR >>> 9) & 1, ipsr: XPSR & 0x1FF,
    };
    xpsr.where = exceptionName(xpsr.ipsr);
  }
  const frameBytes = exc && exc.fpFrame ? 0x68 : 0x20;
  const origSp = frameAddr != null && xpsr ? (frameAddr + frameBytes + (xpsr.align ? 4 : 0) + (extra ? 0 : 0)) >>> 0 : null;

  // ---- trust ----
  const frameCorrupt = set('STKERR') || set('MSTKERR');
  let pcTrust = 'unknown';
  let pcWhy = 'No frame given.';
  if (PC != null) {
    if (frameCorrupt) { pcTrust = 'no'; pcWhy = 'Stacking itself failed (STKERR/MSTKERR): the frame was not fully written, so the words read there are stale memory.'; }
    else if (set('IMPRECISERR') && !set('PRECISERR')) { pcTrust = 'late'; pcWhy = 'Imprecise bus fault: the failing write was buffered, so the stacked PC is a few instructions after the store. Look at the stores just before it.'; }
    else if (set('IACCVIOL') || set('IBUSERR')) { pcTrust = 'target'; pcWhy = 'Instruction fetch fault: the stacked PC is the address that could not be fetched (the bad branch target). The caller is in LR.'; }
    else if (set('INVSTATE')) { pcTrust = 'target'; pcWhy = 'INVSTATE: the stacked PC is where execution went with the Thumb bit clear; the code that branched there is usually at LR.'; }
    else if (set('INVPC')) { pcTrust = 'yes'; pcWhy = 'INVPC: the stacked PC is the exception-return instruction in the handler (BX LR / POP {PC}).'; }
    else if (hasCfsr && cfsr) { pcTrust = 'yes'; pcWhy = 'A precise fault: the stacked PC is the instruction that faulted.'; }
    else { pcTrust = hasCfsr ? 'likely' : 'likely'; pcWhy = hasCfsr ? 'No CFSR bit is set, so the kind of fault is unknown; the stacked PC is most likely the faulting instruction.' : 'Armv6-M reports no fault kind; for synchronous faults the stacked PC is the faulting instruction.'; }
    if (PC & 1) { warnings.push(`The stacked PC ${hex8(PC)} is odd. A stacked PC is always halfword aligned, so these words are probably not the frame - check SP and the offset of the paste.`); pcTrust = 'no'; pcWhy = 'The stacked PC is odd, so this is probably not a real exception frame.'; }
  }
  const mmfarValid = hasCfsr && set('MMARVALID');
  const bfarValid = hasCfsr && set('BFARVALID');

  // ---- findings: the likely cause, most specific first ----
  const causes = [];
  const add = (title, why, next) => causes.push({ title, why, next });
  const nearReg = (addr) => {
    const cands = [['R0', R0], ['R1', R1], ['R2', R2], ['R3', R3], ['R12', R12]].filter(([, v]) => v != null && addr >= v && addr - v < 0x1000);
    if (!cands.length) return '';
    cands.sort((a, b) => (addr - a[1]) - (addr - b[1]));
    const [n, v] = cands[0];
    return addr === v ? ` ${n} holds exactly this address.` : ` ${n} = ${hex8(v)} and the address is ${n} + ${hexs(addr - v)}: a member at offset ${addr - v} or index ${(addr - v) / 4 | 0} of a word array through ${n}.`;
  };
  if (hasCfsr) {
    if (set('STKOF')) add('Stack overflow (stack limit register)', `SP went below ${exc && exc.spsel ? 'PSPLIM' : 'MSPLIM'}. The task or main stack is too small, or a deep recursion / large local array ran it over.`, 'Increase that stack, or find the large frame with -fstack-usage.');
    if (set('MSTKERR') || set('STKERR')) add('Stack overflow on exception entry', `Pushing the exception frame failed (${set('MSTKERR') ? 'MSTKERR: into an MPU-protected region' : 'STKERR: off the end of RAM'}). SP was out of its stack when the exception came. The frame words are not reliable.`, `Read ${exc ? exc.stack : 'the active SP'} and compare it with the stack's bounds; enlarge the stack or find the overflowing call path.`);
    if (set('MUNSTKERR') || set('UNSTKERR')) add('Corrupt SP on exception return', 'Unstacking the frame on return failed: the handler left SP pointing outside valid memory (unbalanced push/pop in assembly, a context switch that restored a bad PSP).', 'Check the handler\'s stack balance and the saved PSP of the task being switched in.');
    if (set('MLSPERR') || set('LSPERR')) add('Fault during lazy FP stacking', 'The FP state could not be written to the space reserved in the frame: the stack of the context that used the FPU overflowed or is forbidden.', 'Give FPU-using tasks more stack (an FP frame is 26 words plus 16 for S16-S31 in an RTOS context switch).');
    if (set('DACCVIOL')) add('MPU data access violation', mmfarValid ? `A load/store to ${hex8(regs.mmfar ?? 0)} is forbidden by the MPU (${describeAddr(regs.mmfar ?? 0)}).${nearReg(regs.mmfar ?? 0)}` : 'A load/store the MPU forbids; MMFAR is not valid, so read the address from the registers of the faulting instruction.', 'Disassemble at the stacked PC to see which register held the address; check the MPU region for it.');
    if (set('IACCVIOL')) add('Executing from a forbidden address', PC != null ? `Fetch from ${hex8(PC)} (${describeAddr(PC)}): ${PC < 0x400 ? 'a call through a NULL function pointer' : regionOf(PC)[3] ? 'the default memory map makes this region execute-never' : 'the MPU marks it execute-never'}.` : 'An instruction fetch from an execute-never region or a NULL function pointer.', 'Look at LR: it is the return address in the function that made the bad call.');
    if (set('PRECISERR')) add('Precise bus fault on a data access', bfarValid ? `The access to ${hex8(regs.bfar ?? 0)} got a bus error: ${describeAddr(regs.bfar ?? 0)}.${nearReg(regs.bfar ?? 0)}` : 'A load/store got a bus error; BFAR is not valid (a later fault may have overwritten it).', 'Disassemble at the stacked PC; the address register of that load/store is the bad pointer.');
    const periph = [['R0', R0], ['R1', R1], ['R2', R2], ['R3', R3], ['R12', R12]].filter(([, v]) => v != null && regionOf(v)[2] === 'Peripheral');
    if (set('IMPRECISERR')) add('Imprecise bus fault (buffered write)', `A write to an invalid or unclocked address failed after the store retired, so the stacked PC is past it${bfarValid ? '' : ' and BFAR is not valid'}.${periph.length ? ` ${periph.map(([n, v]) => `${n} = ${hex8(v)}`).join(' and ')} point${periph.length > 1 ? '' : 's'} into the Peripheral region: a write to a peripheral whose bus clock is off, or that does not exist on this part, is the usual cause.` : ''}`, core.disdefwbuf ? 'Temporarily set SCnSCB->ACTLR |= SCnSCB_ACTLR_DISDEFWBUF_Msk (bit 1) so the fault becomes precise and the stacked PC lands on the store; remove it afterwards (slower).' : `Walk back from the stacked PC over the preceding stores; on ${core.name} a __DSB() after each suspicious store makes the fault land right after it.`);
    if (set('IBUSERR')) add('Bus error on an instruction fetch', PC != null ? `Fetching ${hex8(PC)} (${describeAddr(PC)}) failed: a branch into unmapped memory or a corrupt return address.` : 'A branch into unmapped memory or a corrupt return address.', 'LR shows where the bad branch came from; check for a stack overwrite of a saved return address.');
    if (set('INVSTATE')) add('Branch with the Thumb bit clear', `Execution continued in Arm state (EPSR.T = 0)${xpsr && xpsr.t === 0 ? ', and the stacked xPSR confirms T = 0' : ''}: a function pointer with bit 0 clear, a corrupt return address, or a vector table entry without +1.`, 'Check the pointer called at the site in LR; vector entries and function pointers must be odd.');
    if (set('INVPC')) add('Bad EXC_RETURN on exception return', 'The handler returned with an LR that is not a valid EXC_RETURN - LR was overwritten (called a function without saving LR) or popped from a corrupt stack.', 'Check the handler at the stacked PC: it must return with the LR it was entered with.');
    if (set('UNDEFINSTR')) add('Undefined instruction', PC != null ? `The word at ${hex8(PC)} is not an instruction ${core.name} can execute: erased flash, data executed as code, or an instruction for a bigger core (-mcpu mismatch).` : 'Erased flash, data executed as code, or an instruction for a bigger core.', 'Dump the halfwords at PC (x/4xh) - 0xFFFF means erased flash; check -mcpu/-mfpu.');
    if (set('NOCP')) add('FPU used while disabled', fpOk ? 'An FPU instruction ran before SystemInit enabled CP10/CP11 in CPACR, or in a context that turned it off.' : `${core.name} has no FPU: the code was built with -mfloat-abi=hard/softfp for a core with an FPU.`, fpOk ? 'Enable the FPU first thing in Reset_Handler: SCB->CPACR |= (0xF << 20); __DSB(); __ISB();' : 'Rebuild with -mfloat-abi=soft for this core.');
    if (set('UNALIGNED')) add('Unaligned access', 'An LDM/STM/LDRD/STRD or exclusive access to an unaligned address (these always fault), or any unaligned access with CCR.UNALIGN_TRP set - often a packed struct or a byte buffer cast to a wider type.', 'Look at the address registers of the instruction at PC; use memcpy for packed data.');
    if (set('DIVBYZERO')) add('Integer division by zero', 'An SDIV/UDIV with a zero divisor while CCR.DIV_0_TRP is set.', 'The divisor register of the instruction at PC is 0; guard the division.');
  }
  if (hasCfsr && hset('VECTTBL')) add('Vector table read failed', 'Taking an exception needed a vector that could not be read: VTOR is wrong (not set after a bootloader jump) or the table is in memory that is off or unmapped.', 'Check SCB->VTOR against the application\'s vector table address and its alignment.');
  if (hasCfsr && hset('DEBUGEVT') || (dfsr != null && (dfsr & 2))) add('Breakpoint without a debugger', 'A BKPT instruction ran with no debugger attached - a semihosting call (printf with rdimon), or an assert that uses __BKPT.', 'Build without semihosting (--specs=nosys.specs) or guard BKPT with CoreDebug->DHCSR & C_DEBUGEN.');
  if (sfsrBits.some((b) => b.set && b.kind === 'fault')) {
    const f = sfsrBits.filter((b) => b.set && b.kind === 'fault').map((b) => b.name).join(', ');
    add(`SecureFault (${f})`, `A TrustZone boundary rule was broken${sfsrBits.find((b) => b.name === 'SFARVALID' && b.set) && regs.sfar != null ? ` at ${hex8(regs.sfar)}` : ''}: ${sfsrBits.filter((b) => b.set && b.kind === 'fault').map((b) => b.desc).join(' ')}`, 'Check the SAU/IDAU layout and that Non-secure calls enter through NSC veneers.');
  }
  if (hasCfsr && hset('FORCED') && !causes.length) add('Escalated fault with no cause recorded', 'HFSR.FORCED is set but CFSR is 0: the CFSR was cleared before it was read, or read on the wrong core.', 'Read CFSR first thing in the HardFault handler, before anything else runs.');
  if (!causes.length && PC != null) {
    // Armv6-M or no status: infer from the frame.
    if (xpsr && xpsr.t === 0) add('Branch with the Thumb bit clear', 'The stacked xPSR has T = 0: execution went to an address with bit 0 clear (a corrupt function pointer or return address).', 'Check the call site at LR.');
    else if (PC < 0x400) add('Call through a NULL function pointer', `The stacked PC ${hex8(PC)} is near address 0.`, 'LR is the return address in the function that made the call.');
    else if (regionOf(PC)[3]) add('Executing from an execute-never region', `The stacked PC ${hex8(PC)} is in the ${regionOf(PC)[2]} region, which the default map makes execute-never.`, 'LR shows the call site of the bad branch.');
    else if (PC >= 0xFFFFFF00) add('EXC_RETURN value loaded into PC', 'The PC looks like an EXC_RETURN: a handler return path popped LR into PC in Thread mode, or a stack was corrupted.', 'Check the handler the task switched from.');
    else if (arch === 'v6m' || arch === 'v8mb') add('HardFault (no fault status on this core)', `${core.name} has no fault status registers. Most HardFaults here are an unaligned LDR/STR/LDRH/STRH (never allowed on Armv6-M), a bus error, an SVC with interrupts masked, or a BKPT without a debugger.`, 'Disassemble the instruction at the stacked PC and check the alignment of its address register (R0-R3 are in the frame).');
  }
  if (!causes.length) add('Nothing decoded', hasCfsr ? 'No fault bit is set in CFSR or HFSR.' : 'No frame and no fault status.', 'Read CFSR, HFSR and the stacked frame in the HardFault handler before anything else runs.');

  // ---- where ----
  let where = '–';
  if (exc) where = `${exc.from}, ${exc.stack}`;
  if (xpsr) {
    where = xpsr.ipsr === 0 ? `Thread mode (task/main)${exc ? `, ${exc.stack}` : ''}` : `inside ${xpsr.where}${exc ? `, ${exc.stack}` : ''}`;
    if (exc && ((xpsr.ipsr === 0) !== (exc.mode === 1))) warnings.push(`EXC_RETURN says ${exc.from} but the stacked xPSR exception number is ${xpsr.ipsr} (${xpsr.where}). One of them is not from this fault - check which SP the frame was read from.`);
    if (xpsr.t === 0 && !set('INVSTATE') && hasCfsr) notes.push('The stacked xPSR has T = 0, which normally comes with INVSTATE.');
  }

  // ---- commands ----
  const elf = String(input.elf || 'firmware.elf').trim() || 'firmware.elf';
  const addrs = [];
  if (PC != null && pcTrust !== 'no') addrs.push(PC & ~1);
  if (LR != null && LR < 0xFFFFFF00) addrs.push((LR & ~1) >>> 0);
  const cmds = [];
  if (addrs.length) {
    cmds.push(`# Faulting PC${LR != null && LR < 0xFFFFFF00 ? ' and the return address in LR (bit 0 cleared)' : ''} -> function, file:line (with inlining)`);
    cmds.push(`arm-none-eabi-addr2line -e ${elf} -a -f -C -i ${addrs.map(hex8).join(' ')}`);
    cmds.push('');
    cmds.push('# The instructions around the PC');
    const p = (PC ?? addrs[0]) & ~1;
    cmds.push(`arm-none-eabi-objdump -d -C --start-address=${hexs(Math.max(0, p - 16))} --stop-address=${hexs(p + 8)} ${elf}`);
    cmds.push('');
    cmds.push('# In gdb (attached, same ELF)');
    cmds.push(`info symbol ${hexs(p)}`);
    cmds.push(`list *${hexs(p)}`);
    cmds.push(`x/6i ${hexs(Math.max(0, p - 12))}`);
  } else {
    cmds.push('# No usable PC yet. In the HardFault handler, read the frame from the stack EXC_RETURN names:');
    cmds.push('#   tst lr, #4 ; ite eq ; mrseq r0, msp ; mrsne r0, psp ; b fault_c   (r0 -> uint32_t frame[8])');
    cmds.push('# In gdb after the fault:');
    cmds.push('p/x *(uint32_t(*)[8])$psp     # or $msp; then p/x *(uint32_t*)0xE000ED28 for CFSR');
  }
  if (hasCfsr) {
    cmds.push('');
    cmds.push('# Registers to read in gdb');
    cmds.push('x/wx 0xE000ED28   # CFSR');
    cmds.push('x/wx 0xE000ED2C   # HFSR');
    cmds.push('x/wx 0xE000ED34   # MMFAR');
    cmds.push('x/wx 0xE000ED38   # BFAR');
    if (sfsrOk) cmds.push('x/wx 0xE000EDE4   # SFSR (Secure state)');
  }

  // ---- values ----
  const top = causes[0];
  const trustText = { yes: 'yes, faulting instruction', late: 'no, a few instructions late (imprecise)', target: 'it is the bad branch target', no: 'no', likely: 'probably', unknown: '–' }[pcTrust];
  const values = [
    { label: 'Likely cause', value: top.title, tone: 'bad' },
    { label: 'Where', value: where },
    { label: 'Stacked PC', value: PC != null ? hex8(PC) : '–', hint: trustText, tone: pcTrust === 'yes' ? 'ok' : pcTrust === 'no' ? 'bad' : 'warn' },
    { label: 'Stacked LR', value: LR != null ? hex8(LR) : '–' },
  ];
  if (hasCfsr) {
    values.push({ label: 'CFSR', value: hex8(cfsr) });
    values.push({ label: 'HFSR', value: hex8(hfsr) });
    values.push({ label: 'MMFAR', value: regs.mmfar != null ? hex8(regs.mmfar) : '–', hint: mmfarValid ? 'valid (MMARVALID)' : 'not valid', tone: mmfarValid ? 'ok' : undefined });
    values.push({ label: 'BFAR', value: regs.bfar != null ? hex8(regs.bfar) : '–', hint: bfarValid ? 'valid (BFARVALID)' : 'not valid', tone: bfarValid ? 'ok' : undefined });
  }
  if (exc) values.push({ label: 'EXC_RETURN', value: hex8(exc.value), hint: `${exc.from}, ${exc.stack}, ${exc.fpFrame ? 'FP frame' : 'basic frame'}`, tone: exc.valid ? undefined : 'bad' });
  if (origSp != null) values.push({ label: 'SP before the fault', value: hex8(origSp), hint: `frame at ${hex8(frameAddr)} + ${hexs(frameBytes)}${xpsr && xpsr.align ? ' + 4 alignment pad' : ''}` });

  if (hasCfsr && core.sharedFar && regs.mmfar != null && regs.bfar != null && regs.mmfar !== regs.bfar) notes.push(`On ${core.name} MMFAR and BFAR are one physical register, so they should read the same - these differ, so they were not read at the same moment.`);
  if (hasCfsr && core.sharedFar && (mmfarValid || bfarValid)) notes.push(`On ${core.name} MMFAR and BFAR share one register: only the address whose VALID bit is set means anything.`);
  if (regs.afsr) notes.push(`AFSR ${hex8(regs.afsr)} is implementation defined: look its bits up in the ${core.name} TRM${input.core === 'm7' ? ' (on Cortex-M7 it reports AXIM, ITCM and DTCM ECC/bus errors)' : ''}.`);
  if (hasCfsr && hset('FORCED')) notes.push('FORCED: enable the MemManage, BusFault and UsageFault handlers (SCB->SHCSR |= MEMFAULTENA | BUSFAULTENA | USGFAULTENA, bits 16-18) to get the specific handler next time.');
  if (hasCfsr && cfsr) notes.push('CFSR bits are sticky: write the value back (SCB->CFSR = cfsr) to clear them, or the next fault will show old bits too.');

  const bitRows = [];
  const pushRows = (reg, bits) => bits.filter((b) => b.set).forEach((b) => bitRows.push([reg, b.bit, b.name, b.desc]));
  pushRows('CFSR', cfsrBits); pushRows('HFSR', hfsrBits); pushRows('DFSR', dfsrBits); pushRows('SFSR', sfsrBits);
  if (exc) exc.bits.forEach((b) => bitRows.push(['EXC_RETURN', b.bit, `${b.name}=${b.set ? 1 : 0}`, b.desc]));

  const frameRows = frame.filter((f) => !f.fp).map((f) => [
    frameAddr != null ? hex8(frameAddr + f.off) : `SP+${hexs(f.off)}`, f.name, f.value != null ? hex8(f.value) : '–',
    f.name === 'PC' ? `faulting PC - ${trustText}` : f.name === 'LR' ? (f.value != null && f.value >= 0xFFFFFF00 ? 'EXC_RETURN: the fault was in a handler before it saved LR' : 'return address of the faulting function') : f.name === 'xPSR' && xpsr ? `T=${xpsr.t} ${xpsr.where}${xpsr.align ? ', 4-byte pad above frame' : ''}` : '',
  ]);

  const tables = [
    { title: 'Likely causes, most specific first', columns: ['Cause', 'Why', 'Next step'], rows: causes.map((c) => [c.title, c.why, c.next]) },
    { title: 'Set bits', columns: ['Register', 'Bit', 'Name', 'Meaning'], rows: bitRows.length ? bitRows : [['–', '', '', 'no bit set']] },
    { title: 'Stacked frame', columns: ['Address', 'Register', 'Value', 'Note'], rows: frameRows },
  ];

  const report = [
    `${core.name} fault`,
    `Likely cause: ${top.title}`,
    `  ${top.why}`,
    `  Next: ${top.next}`,
    `Where: ${where}`,
    PC != null ? `PC ${hex8(PC)} (${trustText}), LR ${LR != null ? hex8(LR) : '-'}` : 'No stacked frame.',
    hasCfsr ? `CFSR ${hex8(cfsr)} [${cfsrBits.filter((b) => b.set).map((b) => b.name).join(' ') || '-'}], HFSR ${hex8(hfsr)} [${hfsrBits.filter((b) => b.set).map((b) => b.name).join(' ') || '-'}]` : `${core.name}: no CFSR/HFSR on this architecture.`,
    hasCfsr ? `MMFAR ${regs.mmfar != null ? hex8(regs.mmfar) : '-'} ${mmfarValid ? 'valid' : 'not valid'}, BFAR ${regs.bfar != null ? hex8(regs.bfar) : '-'} ${bfarValid ? 'valid' : 'not valid'}` : '',
    exc ? `EXC_RETURN ${hex8(exc.value)}: ${exc.from}, ${exc.stack}, ${exc.fpFrame ? 'extended FP frame' : 'basic frame'}` : '',
  ].filter(Boolean).join('\n');

  return {
    values,
    tables,
    texts: [
      { title: 'Next steps', body: cmds.join('\n') + '\n', lang: 'sh' },
      { title: 'Summary', body: report + '\n' },
    ],
    warnings,
    notes,
    view: {
      core: { id: input.core in CORES ? input.core : 'm4', name: core.name, arch, fp: fpOk, hasCfsr, sfsr: sfsrOk },
      regs: Object.fromEntries(Object.entries(regs).map(([k, v]) => [k, v >>> 0])),
      src,
      cfsrBits, hfsrBits, dfsrBits, sfsrBits,
      mmfarValid, bfarValid,
      mmfarWhere: regs.mmfar != null ? describeAddr(regs.mmfar) : '',
      bfarWhere: regs.bfar != null ? describeAddr(regs.bfar) : '',
      exc, xpsr, frame, frameAddr, frameBytes, origSp, extra,
      pcTrust, pcWhy, causes,
      pcWhere: PC != null ? describeAddr(PC) : '',
    },
  };
}
