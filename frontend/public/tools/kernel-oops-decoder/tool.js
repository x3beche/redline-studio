// Kernel Oops Decoder: a Linux oops, BUG, WARNING or panic report taken apart.
// Pure: no DOM. Reads the text the kernel prints (dmesg, a serial console, a
// journal or syslog copy) and returns what it found with where it found it,
// so the page can link every decoded piece back to its text.
//
// What it reads, and from where in the kernel the formats come:
//   headline      arch/arm64/mm/fault.c die_kernel_fault(), arch/x86/mm/fault.c
//                 page_fault_oops()/show_fault_oops(), arch/arm/mm/fault.c,
//                 arch/riscv/mm/fault.c, lib/bug.c, kernel/panic.c __warn(),
//                 kernel/watchdog.c, kernel/hung_task.c, kernel/panic.c
//                 __stack_chk_fail(), mm/kasan/report.c
//   CPU/PID/Comm  lib/dump_stack.c dump_stack_print_info()
//   Tainted       kernel/panic.c print_tainted(); letters and bits from
//                 Documentation/admin-guide/tainted-kernels.rst (table below)
//   registers     arch/*/kernel/process.c __show_regs()
//   ESR           arch/arm64/include/asm/esr.h, Arm ARM D24.2.40 ESR_EL1;
//                 class names as arch/arm64/kernel/traps.c esr_class_str[]
//   x86 #PF code  arch/x86/include/asm/trap_pf.h X86_PF_*
//   ARM32 FSR     arch/arm/mm/fsr-2level.c fsr_info[] (short descriptors)
//   RISC-V cause  RISC-V Privileged spec v1.12 Table 4.2 (scause codes)
//   call trace    arch/*/kernel/stacktrace.c, arch/x86/kernel/dumpstack.c
//                 ("? " marks an unreliable x86 frame)
//   BRK immediates arch/arm64/include/asm/brk-imm.h

const HEX = (v) => '0x' + v.toString(16);
const pad = (v, n) => v.toString(16).padStart(n, '0');
const big = (s) => { try { return BigInt('0x' + String(s).replace(/^0x/i, '')); } catch { return null; } };

// ---------------------------------------------------------------- taint
// Documentation/admin-guide/tainted-kernels.rst, "Table for decoding tainted state".
export const TAINTS = [
  [0, 'P', 'proprietary module was loaded (G when only GPL-compatible modules)', 'PROPRIETARY_MODULE'],
  [1, 'F', 'module was force loaded', 'FORCED_MODULE'],
  [2, 'S', 'kernel running on an out of specification system', 'CPU_OUT_OF_SPEC'],
  [3, 'R', 'module was force unloaded', 'FORCED_RMMOD'],
  [4, 'M', 'processor reported a Machine Check Exception (MCE)', 'MACHINE_CHECK'],
  [5, 'B', 'bad page referenced or some unexpected page flags', 'BAD_PAGE'],
  [6, 'U', 'taint requested by userspace application', 'USER'],
  [7, 'D', 'kernel died recently, i.e. there was an OOPS or BUG', 'DIE'],
  [8, 'A', 'ACPI table overridden by user', 'OVERRIDDEN_ACPI_TABLE'],
  [9, 'W', 'kernel issued warning', 'WARN'],
  [10, 'C', 'staging driver was loaded', 'CRAP'],
  [11, 'I', 'workaround for bug in platform firmware applied', 'FIRMWARE_WORKAROUND'],
  [12, 'O', 'externally-built ("out-of-tree") module was loaded', 'OOT_MODULE'],
  [13, 'E', 'unsigned module was loaded', 'UNSIGNED_MODULE'],
  [14, 'L', 'soft lockup occurred', 'SOFTLOCKUP'],
  [15, 'K', 'kernel has been live patched', 'LIVEPATCH'],
  [16, 'X', 'auxiliary taint, defined for and used by distros', 'AUX'],
  [17, 'T', 'kernel was built with the struct randomization plugin', 'RANDSTRUCT'],
  [18, 'N', 'an in-kernel test has been run', 'TEST'],
  [19, 'J', 'userspace used a mutating debug operation in fwctl', 'FWCTL'],
];

// ---------------------------------------------------------------- arm64 ESR
// esr_class_str[] in arch/arm64/kernel/traps.c
const EC = {
  0x00: 'Unknown/Uncategorized', 0x01: 'WFI/WFE', 0x03: 'CP15 MCR/MRC', 0x04: 'CP15 MCRR/MRRC', 0x05: 'CP14 MCR/MRC',
  0x06: 'CP14 LDC/STC', 0x07: 'ASIMD', 0x08: 'CP10 MRC/VMRS', 0x09: 'PAC', 0x0A: 'LD64B/ST64B', 0x0C: 'CP14 MCRR/MRRC',
  0x0D: 'BTI', 0x0E: 'PSTATE.IL', 0x11: 'SVC (AArch32)', 0x12: 'HVC (AArch32)', 0x13: 'SMC (AArch32)',
  0x15: 'SVC (AArch64)', 0x16: 'HVC (AArch64)', 0x17: 'SMC (AArch64)', 0x18: 'MSR/MRS (AArch64)', 0x19: 'SVE',
  0x1A: 'ERET/ERETAA/ERETAB', 0x1C: 'FPAC', 0x1D: 'SME', 0x1F: 'EL3 IMP DEF', 0x20: 'IABT (lower EL)',
  0x21: 'IABT (current EL)', 0x22: 'PC Alignment', 0x24: 'DABT (lower EL)', 0x25: 'DABT (current EL)',
  0x26: 'SP Alignment', 0x27: 'MOPS', 0x28: 'FP (AArch32)', 0x2C: 'FP (AArch64)', 0x2D: 'GCS', 0x2F: 'SError',
  0x30: 'Breakpoint (lower EL)', 0x31: 'Breakpoint (current EL)', 0x32: 'Software Step (lower EL)',
  0x33: 'Software Step (current EL)', 0x34: 'Watchpoint (lower EL)', 0x35: 'Watchpoint (current EL)',
  0x38: 'BKPT (AArch32)', 0x3A: 'Vector catch (AArch32)', 0x3C: 'BRK (AArch64)',
};
const EC_MEANING = {
  0x00: 'an instruction the CPU could not classify (often an undefined instruction)',
  0x07: 'FP/SIMD used while trapped', 0x0D: 'branch target identification violation', 0x0E: 'illegal execution state',
  0x15: 'system call', 0x18: 'trapped system register access', 0x1C: 'pointer authentication failure',
  0x20: 'instruction fetch fault from user space', 0x21: 'instruction fetch fault in the kernel (a bad function pointer or jump)',
  0x22: 'misaligned PC (a corrupted return address or function pointer)', 0x24: 'data access fault from user space',
  0x25: 'data access fault in the kernel', 0x26: 'misaligned stack pointer', 0x2F: 'asynchronous error from the memory system (SError)',
  0x3C: 'BRK instruction: BUG(), WARN() on some kernels, KASAN, UBSAN, CFI or a debugger',
};
// Fault status codes (DFSC / IFSC), ESR_EL1 ISS[5:0].
function fscName(v) {
  const lv = v & 3;
  if (v <= 0x03) return `level ${lv} address size fault`;
  if (v <= 0x07) return `level ${lv} translation fault`;
  if (v <= 0x0B) return `level ${lv} access flag fault`;
  if (v <= 0x0F) return `level ${lv} permission fault`;
  const t = {
    0x10: 'synchronous external abort', 0x11: 'synchronous tag check fault (MTE)',
    0x13: 'level -1 synchronous external abort on table walk', 0x14: 'level 0 synchronous external abort on table walk',
    0x15: 'level 1 synchronous external abort on table walk', 0x16: 'level 2 synchronous external abort on table walk',
    0x17: 'level 3 synchronous external abort on table walk', 0x18: 'synchronous parity or ECC error',
    0x1B: 'level -1 parity/ECC error on table walk', 0x1C: 'level 0 parity/ECC error on table walk',
    0x1D: 'level 1 parity/ECC error on table walk', 0x1E: 'level 2 parity/ECC error on table walk',
    0x1F: 'level 3 parity/ECC error on table walk', 0x21: 'alignment fault', 0x29: 'level -1 address size fault',
    0x2B: 'level -1 translation fault', 0x30: 'TLB conflict abort', 0x31: 'unsupported atomic hardware update fault',
    0x34: 'implementation defined fault (lockdown)', 0x35: 'implementation defined fault (unsupported exclusive or atomic access)',
  };
  return t[v] || `reserved/unknown fault status 0x${pad(v, 2)}`;
}
function fscMeaning(v) {
  if (v >= 0x04 && v <= 0x07) return 'no valid mapping for the address: NULL or garbage pointer, freed/unmapped memory, or an unmapped ioremap';
  if (v >= 0x0C && v <= 0x0F) return 'mapping exists but the access is not allowed: a write to read-only data/code, executing data, or touching user memory without uaccess (PAN)';
  if (v >= 0x08 && v <= 0x0B) return 'access flag not set in the page table entry';
  if (v === 0x21) return 'misaligned access to Device memory or an exclusive/atomic on a misaligned address';
  if (v === 0x10 || (v >= 0x13 && v <= 0x17)) return 'the bus returned an error: a peripheral whose clock or power is off, or an address with nothing behind it';
  if (v === 0x11) return 'MTE tag mismatch: use-after-free or out-of-bounds';
  return '';
}
// arch/arm64/include/asm/brk-imm.h
function brkName(imm) {
  if (imm === 0x004) return 'KPROBES_BRK_IMM (kprobe)';
  if (imm === 0x005) return 'UPROBES_BRK_IMM (uprobe)';
  if (imm === 0x006) return 'KPROBES_BRK_SS_IMM (kprobe single step)';
  if (imm === 0x007) return 'KRETPROBES_BRK_IMM';
  if (imm === 0x100) return 'FAULT_BRK_IMM';
  if (imm === 0x400) return 'KGDB_DYN_DBG_BRK_IMM (kgdb)';
  if (imm === 0x401) return 'KGDB_COMPILED_DBG_BRK_IMM (kgdb)';
  if (imm === 0x800) return 'BUG_BRK_IMM: BUG() / WARN()';
  if ((imm & ~0xff) === 0x900) return 'KASAN_BRK_IMM (KASAN software tag report)';
  if ((imm & ~0xff) === 0x5500) return 'UBSAN_BRK_IMM (UBSAN trap)';
  if (imm >= 0x8000 && imm <= 0x83ff) return 'CFI_BRK_IMM (Control Flow Integrity failure)';
  return 'unrecognised BRK immediate';
}

function decodeEsr(v64) {
  const v = Number(v64 & 0xffffffffn);
  const ec = (v >>> 26) & 0x3f, il = (v >>> 25) & 1, iss = v & 0x1ffffff;
  const iss2 = Number((v64 >> 32n) & 0xffffffn);
  const fields = [
    { name: 'EC', hi: 31, lo: 26, value: ec, meaning: `${EC[ec] || 'reserved'}${EC_MEANING[ec] ? ': ' + EC_MEANING[ec] : ''}` },
    { name: 'IL', hi: 25, lo: 25, value: il, meaning: il ? '32-bit instruction' : '16-bit instruction (or not applicable)' },
  ];
  let summary = `${EC[ec] || 'reserved EC 0x' + pad(ec, 2)}`;
  const isD = ec === 0x24 || ec === 0x25, isI = ec === 0x20 || ec === 0x21;
  let access = null;
  if (isD || isI) {
    const fsc = v & 0x3f;
    if (isD) {
      const isv = (v >>> 24) & 1;
      fields.push({ name: 'ISV', hi: 24, lo: 24, value: isv, meaning: isv ? 'bits 23:14 hold the access size and register' : 'no syndrome: size/register not recorded (decode the instruction)' });
      if (isv) {
        const sas = (v >>> 22) & 3;
        fields.push({ name: 'SAS', hi: 23, lo: 22, value: sas, meaning: `access size ${1 << sas} byte${sas ? 's' : ''}` });
        fields.push({ name: 'SSE', hi: 21, lo: 21, value: (v >>> 21) & 1, meaning: (v >>> 21) & 1 ? 'sign-extended load' : 'no sign extension' });
        fields.push({ name: 'SRT', hi: 20, lo: 16, value: (v >>> 16) & 31, meaning: `transfer register x${(v >>> 16) & 31}` });
        fields.push({ name: 'SF', hi: 15, lo: 15, value: (v >>> 15) & 1, meaning: (v >>> 15) & 1 ? '64-bit register' : '32-bit register' });
        fields.push({ name: 'AR', hi: 14, lo: 14, value: (v >>> 14) & 1, meaning: (v >>> 14) & 1 ? 'acquire/release semantics' : 'plain access' });
      } else {
        fields.push({ name: 'ISS[23:14]', hi: 23, lo: 14, value: (v >>> 14) & 0x3ff, meaning: 'not valid (ISV = 0)' });
      }
      fields.push({ name: 'VNCR', hi: 13, lo: 13, value: (v >>> 13) & 1, meaning: (v >>> 13) & 1 ? 'fault on a VNCR_EL2 access' : 'not a VNCR access' });
    } else {
      fields.push({ name: 'RES0', hi: 24, lo: 13, value: (v >>> 13) & 0xfff, meaning: 'reserved' });
    }
    const set = (v >>> 11) & 3;
    fields.push({ name: 'SET', hi: 12, lo: 11, value: set, meaning: ['recoverable error (UER), meaningful only for external aborts', 'reserved', 'uncontainable error (UC)', 'restartable error (UEO)'][set] });
    fields.push({ name: 'FnV', hi: 10, lo: 10, value: (v >>> 10) & 1, meaning: (v >>> 10) & 1 ? 'FAR is not valid: the reported address cannot be trusted' : 'FAR (the fault address) is valid' });
    fields.push({ name: 'EA', hi: 9, lo: 9, value: (v >>> 9) & 1, meaning: (v >>> 9) & 1 ? 'external abort type: implementation defined class' : 'not an external abort class' });
    if (isD) fields.push({ name: 'CM', hi: 8, lo: 8, value: (v >>> 8) & 1, meaning: (v >>> 8) & 1 ? 'fault on a cache maintenance or address translation instruction' : 'ordinary load or store' });
    else fields.push({ name: 'RES0', hi: 8, lo: 8, value: (v >>> 8) & 1, meaning: 'reserved' });
    fields.push({ name: 'S1PTW', hi: 7, lo: 7, value: (v >>> 7) & 1, meaning: (v >>> 7) & 1 ? 'stage 2 fault during a stage 1 table walk' : 'not a stage 2 fault on a table walk' });
    if (isD) {
      const wnr = (v >>> 6) & 1;
      access = wnr ? 'write' : 'read';
      fields.push({ name: 'WnR', hi: 6, lo: 6, value: wnr, meaning: wnr ? 'caused by a write' : 'caused by a read' });
    } else {
      access = 'instruction fetch';
      fields.push({ name: 'RES0', hi: 6, lo: 6, value: (v >>> 6) & 1, meaning: 'reserved' });
    }
    fields.push({ name: isD ? 'DFSC' : 'IFSC', hi: 5, lo: 0, value: fsc, meaning: `${fscName(fsc)}${fscMeaning(fsc) ? ': ' + fscMeaning(fsc) : ''}` });
    summary = `${isD ? 'data abort' : 'instruction abort'} ${ec & 1 ? 'in the kernel (current EL)' : 'from a lower EL'}, ${fscName(fsc)}, ${access}`;
  } else if (ec === 0x3C) {
    const imm = iss & 0xffff;
    fields.push({ name: 'RES0', hi: 24, lo: 16, value: (iss >>> 16) & 0x1ff, meaning: 'reserved' });
    fields.push({ name: 'Comment', hi: 15, lo: 0, value: imm, meaning: `BRK #0x${pad(imm, 3)}: ${brkName(imm)}` });
    summary = `BRK #0x${pad(imm, 3)}, ${brkName(imm)}`;
  } else if (ec === 0x15 || ec === 0x16 || ec === 0x17) {
    fields.push({ name: 'RES0', hi: 24, lo: 16, value: (iss >>> 16) & 0x1ff, meaning: 'reserved' });
    fields.push({ name: 'imm16', hi: 15, lo: 0, value: iss & 0xffff, meaning: 'immediate of the call instruction' });
  } else if (ec === 0x2F) {
    fields.push({ name: 'IDS', hi: 24, lo: 24, value: (iss >>> 24) & 1, meaning: (iss >>> 24) & 1 ? 'implementation defined syndrome' : 'architected syndrome' });
    fields.push({ name: 'ISS[23:0]', hi: 23, lo: 0, value: iss & 0xffffff, meaning: 'SError syndrome (AET, EA, DFSC when IDS = 0)' });
    summary = 'SError: asynchronous external abort (bus error, ECC, a peripheral that did not answer)';
  } else {
    fields.push({ name: 'ISS', hi: 24, lo: 0, value: iss, meaning: 'instruction specific syndrome (not decoded for this class)' });
  }
  return { reg: 'ESR', width: 32, value: '0x' + pad(v64, 16), fields, summary, access, iss2: iss2 ? '0x' + pad(iss2, 6) : '' };
}

// x86 page fault error code, arch/x86/include/asm/trap_pf.h
function decodePf(code) {
  const b = (n) => (code >>> n) & 1;
  const fields = [
    { name: 'SGX', hi: 15, lo: 15, value: b(15), meaning: b(15) ? 'SGX-specific access control violation' : 'not SGX' },
    { name: 'RES', hi: 14, lo: 7, value: (code >>> 7) & 0xff, meaning: 'reserved' },
    { name: 'SS', hi: 6, lo: 6, value: b(6), meaning: b(6) ? 'shadow stack access' : 'not a shadow stack access' },
    { name: 'PK', hi: 5, lo: 5, value: b(5), meaning: b(5) ? 'protection keys blocked the access' : 'no protection key fault' },
    { name: 'I/D', hi: 4, lo: 4, value: b(4), meaning: b(4) ? 'instruction fetch' : 'data access' },
    { name: 'RSVD', hi: 3, lo: 3, value: b(3), meaning: b(3) ? 'reserved bit set in a page table entry (corrupt page tables)' : 'no reserved bit fault' },
    { name: 'U/S', hi: 2, lo: 2, value: b(2), meaning: b(2) ? 'user-mode access' : 'supervisor (kernel) mode access' },
    { name: 'W/R', hi: 1, lo: 1, value: b(1), meaning: b(1) ? 'write access' : 'read access' },
    { name: 'P', hi: 0, lo: 0, value: b(0), meaning: b(0) ? 'protection violation on a present page' : 'the page was not present' },
  ];
  const access = b(4) ? 'instruction fetch' : b(1) ? 'write' : 'read';
  return { reg: '#PF error code', width: 16, value: '0x' + pad(code, 4), fields, access,
    summary: `${b(2) ? 'user' : 'supervisor'} ${access} access, ${b(0) ? 'protection violation' : 'not-present page'}${b(3) ? ', reserved bit set' : ''}` };
}

// ARM32 short-descriptor FSR, arch/arm/mm/fsr-2level.c fsr_info[] (index = FS[4] << 4 | FS[3:0])
const FSR32 = ['unknown 0', 'alignment exception', 'terminal exception', 'alignment exception', 'external abort on linefetch',
  'section translation fault', 'external abort on linefetch', 'page translation fault', 'external abort on non-linefetch',
  'section domain fault', 'external abort on non-linefetch', 'page domain fault', 'external abort on translation',
  'section permission fault', 'external abort on translation', 'page permission fault'];
function decodeFsr(code) {
  const fs = (code & 15) | ((code >>> 6) & 16);
  const name = fs < 16 ? FSR32[fs] : fs === 22 ? 'imprecise external abort' : `unknown ${fs}`;
  const wnr = (code >>> 11) & 1;
  const fields = [
    { name: 'RES', hi: 15, lo: 13, value: (code >>> 13) & 7, meaning: 'reserved' },
    { name: 'ExT', hi: 12, lo: 12, value: (code >>> 12) & 1, meaning: (code >>> 12) & 1 ? 'external abort type: implementation defined' : 'not classified' },
    { name: 'WnR', hi: 11, lo: 11, value: wnr, meaning: wnr ? 'caused by a write' : 'caused by a read' },
    { name: 'FS[4]', hi: 10, lo: 10, value: (code >>> 10) & 1, meaning: `status bit 4: fault status ${fs}` },
    { name: 'LPAE', hi: 9, lo: 9, value: (code >>> 9) & 1, meaning: (code >>> 9) & 1 ? 'long descriptor format (this table does not apply)' : 'short descriptor format' },
    { name: 'RES', hi: 8, lo: 8, value: (code >>> 8) & 1, meaning: 'reserved' },
    { name: 'Domain', hi: 7, lo: 4, value: (code >>> 4) & 15, meaning: `domain ${(code >>> 4) & 15}` },
    { name: 'FS[3:0]', hi: 3, lo: 0, value: code & 15, meaning: name },
  ];
  return { reg: 'FSR', width: 16, value: '0x' + pad(code, 3), fields, access: wnr ? 'write' : 'read', summary: `${name}, ${wnr ? 'write' : 'read'}` };
}

// RISC-V scause, Privileged spec v1.12 Table 4.2
const RV_EXC = { 0: 'instruction address misaligned', 1: 'instruction access fault', 2: 'illegal instruction', 3: 'breakpoint (ebreak: BUG()/WARN())',
  4: 'load address misaligned', 5: 'load access fault', 6: 'store/AMO address misaligned', 7: 'store/AMO access fault',
  8: 'environment call from U-mode', 9: 'environment call from S-mode', 11: 'environment call from M-mode',
  12: 'instruction page fault', 13: 'load page fault', 15: 'store/AMO page fault', 18: 'software check', 19: 'hardware error' };
function decodeCause(c64) {
  const intr = Number((c64 >> 63n) & 1n), code = Number(c64 & 0xffffn);
  const name = intr ? `interrupt ${code}` : (RV_EXC[code] || `reserved exception ${code}`);
  const access = intr ? null : [5, 13, 4].includes(code) ? 'read' : [7, 15, 6].includes(code) ? 'write' : [1, 12, 0].includes(code) ? 'instruction fetch' : null;
  return { reg: 'scause', width: 16, value: '0x' + pad(c64, 16), shown: 'low 16 bits + bit 63',
    fields: [
      { name: 'Interrupt', hi: 63, lo: 63, value: intr, meaning: intr ? 'asynchronous interrupt' : 'synchronous exception' },
      { name: 'Exception code', hi: 15, lo: 0, value: code, meaning: name },
    ], access, summary: name };
}

// ---------------------------------------------------------------- instructions
const xr = (n, sf) => (n === 31 ? (sf ? 'sp' : 'wsp') : `${sf ? 'x' : 'w'}${n}`);
const sext = (v, bits) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);
/** A64: the loads/stores and moves around a fault. {text, base, off, size, write, dst} or {text}. */
export function decodeA64(w) {
  w >>>= 0;
  const Rt = w & 31, Rn = (w >>> 5) & 31;
  // Load/store register (unsigned immediate): size 111 V 01 opc imm12 Rn Rt
  if ((w & 0x3B000000) === 0x39000000) {
    const size = w >>> 30, V = (w >>> 26) & 1, opc = (w >>> 22) & 3, off = ((w >>> 10) & 0xfff) << size;
    if (V) return { text: `${opc & 1 ? 'ldr' : 'str'} (SIMD&FP) [${xr(Rn, 1)}, #${off}]`, base: Rn, off, size: 1 << size, write: !(opc & 1) };
    return ls(size, opc, Rt, Rn, off, `[${xr(Rn, 1)}${off ? `, #${off}` : ''}]`, off);
  }
  // Load/store register (unscaled / post / pre / unprivileged): size 111 V 00 opc 0 imm9 xx Rn Rt
  if ((w & 0x3B200000) === 0x38000000) {
    const size = w >>> 30, V = (w >>> 26) & 1, opc = (w >>> 22) & 3, imm = sext((w >>> 12) & 0x1ff, 9), mode = (w >>> 10) & 3;
    if (V) return { text: `.inst 0x${pad(w, 8)} (SIMD&FP load/store)` };
    const addr = mode === 1 ? `[${xr(Rn, 1)}], #${imm}` : mode === 3 ? `[${xr(Rn, 1)}, #${imm}]!` : `[${xr(Rn, 1)}${imm ? `, #${imm}` : ''}]`;
    const r = ls(size, opc, Rt, Rn, mode === 1 ? 0 : imm, addr, imm);
    if (mode === 0) r.text = r.text.replace(/^(ld|st)r/, '$1ur');
    if (mode === 2) r.text = r.text.replace(/^(ld|st)r/, '$1tr');
    return r;
  }
  // Load/store pair: opc 101 V type L imm7 Rt2 Rn Rt
  if ((w & 0x3A000000) === 0x28000000) {
    const opc = w >>> 30, V = (w >>> 26) & 1, type = (w >>> 23) & 7, L = (w >>> 22) & 1, Rt2 = (w >>> 10) & 31;
    if (V || opc === 3 || type === 0) return { text: `.inst 0x${pad(w, 8)} (pair load/store)` };
    const sf = opc === 2, sc = opc === 2 ? 3 : 2, imm = sext((w >>> 15) & 0x7f, 7) << sc;
    const m = `${L ? 'ldp' : 'stp'}${opc === 1 && L ? 'sw' : ''}`;
    const addr = type === 1 ? `[${xr(Rn, 1)}], #${imm}` : type === 3 ? `[${xr(Rn, 1)}, #${imm}]!` : `[${xr(Rn, 1)}${imm ? `, #${imm}` : ''}]`;
    return { text: `${m} ${xr(Rt, sf || opc === 1)}, ${xr(Rt2, sf || opc === 1)}, ${addr}`, base: Rn, off: type === 1 ? 0 : imm, size: 2 << sc, write: !L, dst: L ? Rt : null };
  }
  if ((w & 0x7FE0FFE0) === 0x2A0003E0) return { dst: Rt, text: `mov ${xr(Rt, w >>> 31)}, ${xr((w >>> 16) & 31, w >>> 31)}`.replace(/sp\b/g, (m) => m === 'sp' ? 'xzr' : 'wzr') };
  if ((w & 0x7F800000) === 0x52800000) { const hw = (w >>> 21) & 3, imm = (w >>> 5) & 0xffff; return { dst: Rt, text: `mov ${w >>> 31 ? 'x' : 'w'}${Rt}, #0x${(imm * 2 ** (16 * hw)).toString(16)}` }; }
  if ((w & 0xFFE0001F) === 0xD4200000) return { text: `brk #0x${((w >>> 5) & 0xffff).toString(16)}`, brk: (w >>> 5) & 0xffff };
  if ((w & 0xFC000000) === 0x94000000) return { text: `bl pc${sext(w & 0x3ffffff, 26) < 0 ? '-' : '+'}0x${Math.abs(sext(w & 0x3ffffff, 26) * 4).toString(16)}` };
  if (w === 0xD65F03C0) return { text: 'ret' };
  if (w === 0xD503201F) return { text: 'nop' };
  if (w === 0xD503233F) return { text: 'paciasp' };
  if (w === 0xD50323BF) return { text: 'autiasp' };
  if ((w & 0x7F000000) === 0x34000000 || (w & 0x7F000000) === 0x35000000) return { text: `${(w >>> 24) & 1 ? 'cbnz' : 'cbz'} ${xr(Rt, w >>> 31)}, pc${sext((w >>> 5) & 0x7ffff, 19) < 0 ? '-' : '+'}0x${Math.abs(sext((w >>> 5) & 0x7ffff, 19) * 4).toString(16)}` };
  return { text: `.inst 0x${pad(w, 8)}` };
}
function ls(size, opc, Rt, Rn, off, addr) {
  const names = [['strb', 'ldrb', 'ldrsb', 'ldrsb'], ['strh', 'ldrh', 'ldrsh', 'ldrsh'], ['str', 'ldr', 'ldrsw', null], ['str', 'ldr', 'prfm', null]];
  const m = names[size][opc];
  if (!m) return { text: `.inst (unallocated load/store)` };
  if (m === 'prfm') return { text: `prfm ${addr}`, base: Rn, off, size: 8 };
  const sf = size === 3 || (size === 2 && opc === 2) || (size < 2 && opc === 2);
  return { text: `${m} ${xr(Rt, sf).replace(/^([wx])31$/, '$1zr')}, ${addr}`, base: Rn, off, size: 1 << size, write: opc === 0, dst: opc ? Rt : null };
}
/** A32 LDR/STR (immediate) and a few T16 forms. */
function decodeA32(w, thumb) {
  if (thumb) {
    const h = w & 0xffff, Rt = h & 7, Rn = (h >>> 3) & 7, imm5 = (h >>> 6) & 31;
    const f = { 0x6800: ['ldr', 4], 0x6000: ['str', 4], 0x7800: ['ldrb', 1], 0x7000: ['strb', 1], 0x8800: ['ldrh', 2], 0x8000: ['strh', 2] }[h & 0xF800];
    if (f) return { text: `${f[0]} r${Rt}, [r${Rn}, #${imm5 * f[1]}]`, base: Rn, off: imm5 * f[1], size: f[1], write: f[0].startsWith('st'), rname: (n) => `r${n}` };
    return { text: `.short 0x${pad(h, 4)}` };
  }
  if ((w & 0x0E000000) === 0x04000000 && (w >>> 28) !== 0xF) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, B = (w >>> 22) & 1, L = (w >>> 20) & 1, Rn = (w >>> 16) & 15, Rt = (w >>> 12) & 15, imm = w & 0xfff;
    const off = U ? imm : -imm;
    const rn = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'fp', 'ip', 'sp', 'lr', 'pc'];
    return { text: `${L ? 'ldr' : 'str'}${B ? 'b' : ''} ${rn[Rt]}, [${rn[Rn]}${P ? (imm ? `, #${off}` : '') + ']' : `], #${off}`}`, base: Rn, off: P ? off : 0, size: B ? 1 : 4, write: !L, rname: (n) => rn[n] };
  }
  return { text: `.word 0x${pad(w >>> 0, 8)}` };
}

/** x86-64: the MOV forms around a fault (88/89/8A/8B/C6/C7 with a memory operand). */
const X86R = ['RAX', 'RCX', 'RDX', 'RBX', 'RSP', 'RBP', 'RSI', 'RDI', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'];
const X86N = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
export function decodeX86(b) {
  let i = 0, op16 = false, rex = 0;
  while (b[i] === 0x66 || b[i] === 0x65 || b[i] === 0x64 || b[i] === 0xf0) { if (b[i] === 0x66) op16 = true; i++; }
  if (b[i] >= 0x40 && b[i] <= 0x4f) rex = b[i++];
  const op = b[i++];
  if (![0x88, 0x89, 0x8a, 0x8b, 0xc6, 0xc7].includes(op) || b[i] == null) return null;
  const modrm = b[i++], mod = modrm >> 6, reg = ((modrm >> 3) & 7) | (rex & 4 ? 8 : 0);
  let rm = modrm & 7;
  if (mod === 3) return null;
  let base = null, index = null, scale = 1, disp = 0;
  if (rm === 4) {
    const sib = b[i++]; scale = 1 << (sib >> 6);
    const ix = ((sib >> 3) & 7) | (rex & 2 ? 8 : 0); if (ix !== 4) index = ix;
    base = (sib & 7) | (rex & 1 ? 8 : 0);
    if ((sib & 7) === 5 && mod === 0) { base = null; disp = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)); i += 4; }
  } else if (rm === 5 && mod === 0) return { text: 'mov with a RIP-relative operand', size: 0, write: op === 0x88 || op === 0x89 || op >= 0xc6 };
  else base = rm | (rex & 1 ? 8 : 0);
  if (mod === 1) { disp = (b[i] << 24) >> 24; i++; }
  if (mod === 2) { disp = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)); i += 4; }
  if (b.slice(0, i).some((x) => x == null)) return null;
  const size = op === 0x88 || op === 0x8a || op === 0xc6 ? 1 : rex & 8 ? 8 : op16 ? 2 : 4;
  const ptr = { 1: 'BYTE', 2: 'WORD', 4: 'DWORD', 8: 'QWORD' }[size];
  const mem = `${ptr} PTR [${base != null ? X86N[base] : ''}${index != null ? `+${X86N[index]}*${scale}` : ''}${disp ? (disp < 0 ? '-' : '+') + '0x' + Math.abs(disp).toString(16) : ''}]`;
  const r = size === 8 ? X86N[reg] : size === 4 ? (reg < 8 ? 'e' + X86N[reg].slice(1) : X86N[reg] + 'd') : size === 2 ? (reg < 8 ? X86N[reg].slice(1) : X86N[reg] + 'w') : (reg < 8 ? ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil'][reg] : X86N[reg] + 'b');
  const write = op === 0x88 || op === 0x89 || op >= 0xc6;
  const text = op >= 0xc6 ? `mov ${mem}, imm` : write ? `mov ${mem}, ${r}` : `mov ${r}, ${mem}`;
  return { text, xbase: base != null ? X86R[base] : null, index: index != null ? X86R[index] : null, off: disp, size, write, xdst: write ? null : X86R[reg] };
}

/** RISC-V: loads and stores, 32-bit and compressed (RVC). */
const RVN = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
export function decodeRV(w, len) {
  if (len === 16) {
    const f3 = (w >>> 13) & 7, q = w & 3, rs1 = 8 + ((w >>> 7) & 7), rd = 8 + ((w >>> 2) & 7);
    if (q !== 0 || ![2, 3, 6, 7].includes(f3)) return { text: `.2byte 0x${pad(w, 4)}` };
    const hi = ((w >>> 10) & 7) << 3;
    const off = f3 & 1 ? hi | (((w >>> 5) & 3) << 6) : hi | (((w >>> 6) & 1) << 2) | (((w >>> 5) & 1) << 6);
    const m = ['', '', 'c.lw', 'c.ld', '', '', 'c.sw', 'c.sd'][f3];
    return { text: `${m} ${RVN[rd]}, ${off}(${RVN[rs1]})`, base: rs1, off, size: f3 & 1 ? 8 : 4, write: f3 >= 6, dst: f3 < 6 ? rd : null, rname: (n) => RVN[n] };
  }
  const opc = w & 0x7f, f3 = (w >>> 12) & 7, rd = (w >>> 7) & 31, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31;
  if (opc === 0x03 && f3 !== 7) {
    const off = w >> 20, m = ['lb', 'lh', 'lw', 'ld', 'lbu', 'lhu', 'lwu'][f3];
    return { text: `${m} ${RVN[rd]}, ${off}(${RVN[rs1]})`, base: rs1, off, size: 1 << (f3 & 3), write: false, dst: rd, rname: (n) => RVN[n] };
  }
  if (opc === 0x23 && f3 < 4) {
    const off = ((w >> 25) << 5) | ((w >>> 7) & 31), m = ['sb', 'sh', 'sw', 'sd'][f3];
    return { text: `${m} ${RVN[rs2]}, ${off}(${RVN[rs1]})`, base: rs1, off, size: 1 << f3, write: true, rname: (n) => RVN[n] };
  }
  return { text: `.4byte 0x${pad(w >>> 0, 8)}` };
}

// ---------------------------------------------------------------- registers
const REGS = {
  arm64: /^(x(?:[0-9]|[12][0-9]|30)|sp|pc|lr|pstate)$/,
  arm: /^(r(?:[0-9]|1[0-2])|fp|ip|sp|lr|pc|psr|cpsr)$/,
  x86_64: /^(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|R(?:0[89]|1[0-5])|RIP|EFLAGS|ORIG_RAX|FS|GS|knlGS|CS|DS|ES|CR0|CR2|CR3|CR4|EAX|EBX|ECX|EDX|ESI|EDI|EBP|ESP|EIP)$/,
  riscv: /^(epc|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|status|badaddr|cause)$/,
};
const NOT_GPR = /^(sp|pc|lr|pstate|psr|cpsr|RSP|RIP|EFLAGS|ORIG_RAX|FS|GS|knlGS|CS|DS|ES|CR[0-4]|epc|ra|status|badaddr|cause|gp|tp|ESP|EIP)$/;

const KIND = {
  null: ['NULL pointer dereference', 'bad'], paging: ['Bad kernel address (paging request)', 'bad'], gpf: ['General protection fault', 'bad'],
  bug: ['kernel BUG()', 'bad'], warning: ['WARNING (kernel continued)', 'warn'], softlockup: ['Soft lockup', 'bad'],
  hardlockup: ['Hard lockup', 'bad'], hung: ['Hung task', 'warn'], rcu: ['RCU stall', 'warn'], stackprot: ['Stack protector: stack corrupted', 'bad'],
  kasan: ['KASAN memory error report', 'bad'], atomic: ['Sleeping in atomic context', 'warn'], undef: ['Undefined instruction', 'bad'],
  oops: ['Oops', 'bad'], panic: ['Kernel panic', 'bad'], unknown: ['Not recognised', 'warn'],
};

const FAULT_PATH = /^(die|__die|__die_body|die_kernel_fault|die_addr|oops_begin|oops_end|page_fault_oops|kernelmode_fixup_or_oops|no_context|__bad_area_nosemaphore|bad_area_nosemaphore|do_user_addr_fault|exc_page_fault|asm_exc_page_fault|exc_general_protection|asm_exc_general_protection|handle_page_fault|do_kern_addr_fault|__do_kernel_fault|do_page_fault|do_translation_fault|do_mem_abort|el1_abort|el1h_64_sync_handler|el1h_64_sync|el1_da|el1_ia|el1_sync|do_DataAbort|do_PrefetchAbort|__dabt_svc|__pabt_svc|show_stack|dump_stack|dump_stack_lvl|dump_backtrace|show_regs|__warn|report_bug|handle_bug|exc_invalid_op|asm_exc_invalid_op|bug_handler|brk_handler|do_debug_exception|el1_dbg|call_break_hook|do_trap_ebreak|handle_exception|do_trap_load_fault|do_trap_store_fault|panic|nmi_panic|watchdog_timer_fn|__hrtimer_run_queues|hrtimer_interrupt|warn_slowpath_fmt)$/;

// ---------------------------------------------------------------- run
export function run(input) {
  const text = String(input.oops ?? '').replace(/\r\n?/g, '\n');
  const warnings = [], notes = [];
  const rawLines = text.split('\n');
  if (rawLines.length > 3000) warnings.push(`The text has ${rawLines.length} lines; only the first 3000 were read. Paste from the first "cut here" or "Unable to handle" line to "end trace".`);
  const L = rawLines.slice(0, 3000).map((t, i) => {
    let off = 0, ts = null;
    const sys = /^[A-Z][a-z]{2}\s+\d+\s[\d:]+\s\S+\skernel:\s?/.exec(t) || /^\S+T[\d:.]+\S*\s\S+\skernel:\s?/.exec(t);
    if (sys) off = sys[0].length;
    const lv = /^<\d>/.exec(t.slice(off)); if (lv) off += lv[0].length;
    const st = /^\[\s*(\d+\.\d+)\]\s?(?:\[\s*[TC]\d+\]\s?)?/.exec(t.slice(off));
    if (st) { ts = Number(st[1]); off += st[0].length; }
    return { t, off, body: t.slice(off), ts, spans: [] };
  });
  const mark = (li, a, b, id) => { if (li >= 0 && a < b) L[li].spans.push({ a, b, id }); };
  const markRe = (li, m, g, id) => { const ix = m.indices && m.indices[g]; if (ix) mark(li, L[li].off + ix[0], L[li].off + ix[1], id); };
  const bodyAll = L.map((l) => l.body).join('\n');

  // ---- architecture
  let arch = input.arch && input.arch !== 'auto' && REGS[input.arch] ? input.arch : null;
  const detected = /\bx29\s*:|\bpstate:|\bESR = 0x|Mem abort info|Internal error: Oops[^:\n]*: [0-9a-f]{16}\b/.test(bodyAll) ? 'arm64'
    : /\bRIP: [0-9a-f]{4}:|\bRAX: |\bEFLAGS: /.test(bodyAll) ? 'x86_64'
    : /\bepc\s*:|\bbadaddr:/.test(bodyAll) ? 'riscv'
    : /PC is at|\bpsr: [0-9a-f]{8}|\br10\s*:|\bfp\s*:\s*[0-9a-f]{8}\b| from \[<[0-9a-f]{8}>\]/.test(bodyAll) ? 'arm' : null;
  if (!arch) arch = detected || 'unknown';
  else if (detected && detected !== arch) warnings.push(`Architecture set to ${arch}, but the text looks like ${detected} (register names). Set it to auto or ${detected}.`);

  // ---- headline
  const T1 = [
    [/Unable to handle kernel NULL pointer dereference at virtual address (?:0x)?([0-9a-f]+)/d, 'null', 1],
    [/BUG: kernel NULL pointer dereference, address: (?:0x)?([0-9a-f]+)/d, 'null', 1],
    [/Unable to handle kernel paging request at virtual address (?:0x)?([0-9a-f]+)/d, 'paging', 1],
    [/Unable to handle kernel (?:access to user memory|execute from non-executable memory|write to read-only memory|read from unreadable memory)(?: outside uaccess routines)? at virtual address (?:0x)?([0-9a-f]+)/d, 'paging', 1],
    [/BUG: unable to handle (?:page fault for address|kernel paging request at):?\s*(?:0x)?([0-9a-f]+)/d, 'paging', 1],
    [/BUG: unable to handle kernel NULL pointer dereference at (?:0x)?([0-9a-f]+)/d, 'null', 1],
    [/general protection fault(?:, probably for non-canonical address (0x[0-9a-f]+))?/d, 'gpf', 1],
    [/kernel BUG at ([^!]+)!/d, 'bug', 0],
    [/WARNING: CPU: \d+ PID: \d+ at (\S+) (\S+)/d, 'warning', 0],
    [/BUG: soft lockup - CPU#(\d+) stuck for (\d+)s! \[(.+)\]/d, 'softlockup', 0],
    [/Watchdog detected hard LOCKUP on cpu (\d+)/d, 'hardlockup', 0],
    [/INFO: task (.+):(\d+) blocked for more than (\d+) seconds/d, 'hung', 0],
    [/rcu: INFO: (\w+) (?:detected stalls|self-detected stall)/d, 'rcu', 0],
    [/stack-protector: Kernel stack is corrupted in: (\S+)/d, 'stackprot', 0],
    [/BUG: KASAN: ([\w-]+) in (\S+)/d, 'kasan', 0],
    [/BUG: (?:scheduling while atomic|sleeping function called from invalid context)/d, 'atomic', 0],
    [/Internal error: Oops - (?:undefined instruction|Undefined instruction)/di, 'undef', 0],
    [/Unable to handle kernel paging request for unknown fault/d, 'paging', 0],
  ];
  let head = null, faultAddr = null;
  for (let i = 0; i < L.length && !head; i++) {
    for (const [re, kind, ag] of T1) {
      const m = re.exec(L[i].body);
      if (!m) continue;
      head = { kind, line: i, text: L[i].body.trim(), m };
      mark(i, L[i].off + m.indices[0][0], L[i].off + m.indices[0][1], 'head');
      if (ag && m[ag]) { faultAddr = big(m[ag]); markRe(i, m, ag, 'addr'); }
      break;
    }
  }
  // Oops line: arm/arm64 "Internal error: Oops: 96000005 [#1]", x86 "Oops: 0002 [#1]"
  let oopsCode = null, oopsNo = null;
  for (let i = 0; i < L.length; i++) {
    const m = /Internal error: (Oops[^:]*): ([0-9a-f]+) \[#(\d+)\]/d.exec(L[i].body) || /\bOops: ([0-9a-f]{4}) \[#(\d+)\]/d.exec(L[i].body)
      || /general protection fault[^:]*: ([0-9a-f]{4}) \[#(\d+)\]/d.exec(L[i].body) || /^\s*Oops \[#(\d+)\]/d.exec(L[i].body);
    if (!m) continue;
    const g = m.length === 4 ? 2 : m.length === 3 ? 1 : 0;
    if (g) { oopsCode = { text: m[g], line: i, isGpf: /general protection/.test(m[0]), label: m.length === 4 ? m[1] : 'Oops' }; markRe(i, m, g, 'code'); }
    oopsNo = Number(m[m.length - 1]);
    mark(i, L[i].off + m.indices[0][0], L[i].off + (m.indices[g] ? m.indices[g][0] : m.indices[0][1]), 'oops');
    if (!head) {
      head = { kind: /BUG/.test(m[0]) ? 'bug' : 'oops', line: i, text: L[i].body.trim(), m };
      mark(i, L[i].off + m.indices[0][0], L[i].off + m.indices[0][1], 'head');
    }
    break;
  }
  let panic = null;
  for (let i = 0; i < L.length; i++) {
    const m = /Kernel panic - not syncing: (.*?)\s*(?:\]---)?$/d.exec(L[i].body);
    if (m) { panic = { reason: m[1], line: i }; mark(i, L[i].off + m.indices[0][0], L[i].off + m.indices[0][1], 'panic'); if (!head) head = { kind: 'panic', line: i, text: L[i].body.trim(), m }; break; }
  }
  if (!head) head = { kind: 'unknown', line: -1, text: '' };

  // ---- CPU / PID / Comm / taint / version
  let who = null, taint = null;
  for (let i = 0; i < L.length && !who; i++) {
    const m = /CPU: (\d+) (?:UID: \d+ )?PID: (\d+) Comm: (.+?) (Not tainted|Tainted: ([A-Z ]*?))\s+(\d+\.\d+\S*)(?: #(\S+))?/d.exec(L[i].body);
    if (!m) continue;
    who = { cpu: Number(m[1]), pid: Number(m[2]), comm: m[3], version: m[6], build: m[7] || '', line: i };
    markRe(i, m, 1, 'cpu'); markRe(i, m, 2, 'cpu'); markRe(i, m, 3, 'cpu'); markRe(i, m, 6, 'cpu');
    markRe(i, m, 4, 'taint');
    taint = { letters: m[5] ? m[5].replace(/[^A-Z]/g, '').replace(/G/g, '') : '', line: i, raw: m[4] };
  }
  for (let i = 0; i < L.length; i++) {
    // 6.10+: "Tainted: [P]=PROPRIETARY_MODULE, [O]=OOT_MODULE"
    const re = /\[([A-Z])\]=([A-Z_]+)/g; let m, any = false;
    if (!/^Tainted: \[/.test(L[i].body.trim())) continue;
    while ((m = re.exec(L[i].body))) { any = true; if (taint && !taint.letters.includes(m[1])) taint.letters += m[1]; else if (!taint) taint = { letters: m[1], line: i }; }
    if (any) mark(i, L[i].off, L[i].t.length, 'taint');
  }
  const taintSet = new Set((taint?.letters || '').split('').filter(Boolean));
  let taintMask = 0;
  const taintRows = [];
  for (const [bit, letter, meaning, name] of TAINTS) if (taintSet.has(letter)) { taintMask += 2 ** bit; taintRows.push([letter, bit, name, meaning]); }
  const unknownTaint = [...taintSet].filter((c) => !TAINTS.some((t) => t[1] === c));
  if (unknownTaint.length) warnings.push(`Taint letter${unknownTaint.length > 1 ? 's' : ''} ${unknownTaint.join(', ')} not in the table: a newer or vendor kernel. Look it up in that kernel's Documentation/admin-guide/tainted-kernels.rst.`);

  let hw = null, modules = null, workqueue = null;
  for (let i = 0; i < L.length; i++) {
    let m;
    if (!hw && (m = /Hardware name: (.+?)\s*$/d.exec(L[i].body))) { hw = { name: m[1], line: i }; markRe(i, m, 1, 'hw'); }
    if (!modules && (m = /Modules linked in:(.*)$/d.exec(L[i].body))) { modules = { list: m[1].trim().split(/\s+/).filter(Boolean), line: i }; markRe(i, m, 0, 'mods'); }
    if (!workqueue && (m = /Workqueue: (\S+) (\S+)/d.exec(L[i].body))) { workqueue = { wq: m[1], fn: m[2], line: i }; markRe(i, m, 0, 'wq'); }
  }

  // ---- symbolic pc / lr
  const SYM = String.raw`([A-Za-z_.$][\w.$]*)\+(0x[0-9a-f]+)\/(0x[0-9a-f]+)(?:\s+\[([\w-]+)[^\]]*\])?`;
  let pc = null, lr = null;
  for (let i = 0; i < L.length; i++) {
    const b = L[i].body;
    let m;
    if (!pc && (m = new RegExp(String.raw`^\s*(?:pc\s*:|epc\s*:|PC is at|RIP: [0-9a-f]{4}:|EIP: [0-9a-f]{4}:)\s*(?:\[<[0-9a-f]+>\]\s*)?` + SYM, 'd').exec(b))) {
      pc = { fn: m[1], off: m[2], size: m[3], mod: m[4] || '', line: i }; mark(i, L[i].off + m.indices[1][0], L[i].off + m.indices[0][1], 'pc');
    } else if (!lr && (m = new RegExp(String.raw`^\s*(?:lr\s*:|ra\s*:|LR is at)\s*(?:\[<[0-9a-f]+>\]\s*)?` + SYM, 'd').exec(b))) {
      lr = { fn: m[1], off: m[2], size: m[3], mod: m[4] || '', line: i }; mark(i, L[i].off + m.indices[1][0], L[i].off + m.indices[0][1], 'lr');
    }
  }

  // ---- registers
  const regs = new Map();
  const nameOk = (n) => (arch === 'unknown' ? Object.values(REGS).some((r) => r.test(n)) : REGS[arch].test(n));
  for (let i = 0; i < L.length; i++) {
    const b = L[i].body;
    if (/^\s*(?:Code|Call [Tt]race|Modules linked in|CPU|Hardware name|Mem abort|Data abort|Internal error|Workqueue|Instruction dump)/.test(b)) continue;
    const re = /(?:^|[\s,])([A-Za-z][A-Za-z0-9_]{0,7})\s*:\s*(?:\[<)?(?:([0-9a-f]{4}):)?([0-9a-fA-F]{4,16})(?:>\])?(?=[\s,(]|$)/dg;
    let m, hits = [];
    while ((m = re.exec(b))) {
      const n = m[1];
      if (!nameOk(n)) continue;
      if (m[3].length < 8 && !/^(CS|DS|ES)$/.test(n)) continue;
      hits.push(m);
    }
    for (const m of hits) {
      if (regs.has(m[1])) continue;
      regs.set(m[1], { name: m[1], value: big(m[3]), hex: m[3].toLowerCase(), line: i, seg: m[2] || '' });
      mark(i, L[i].off + m.indices[1][0], L[i].off + m.indices[3][1], `reg:${m[1]}`);
    }
  }
  if (!faultAddr) {
    if (regs.has('CR2') && ['null', 'paging', 'oops'].includes(head.kind)) faultAddr = regs.get('CR2').value;
    if (regs.has('badaddr') && ['null', 'paging', 'oops'].includes(head.kind)) faultAddr = regs.get('badaddr').value;
  }

  // ---- fault syndrome
  let lanes = null, codeSrc = '';
  const override = String(input.code ?? '').trim();
  let esrText = null;
  for (let i = 0; i < L.length; i++) {
    const m = /\bESR = (0x[0-9a-f]+)/d.exec(L[i].body);
    if (m) { esrText = m[1]; markRe(i, m, 1, 'esr'); break; }
  }
  const ovr = override ? big(override) : null;
  if (override && ovr == null) warnings.push(`Fault code override "${override}" is not hex. Write it like 0x96000045, or clear it to use the log's own value.`);
  if (arch === 'arm64') {
    let v = ovr ?? (esrText ? big(esrText) : null);
    if (v == null && oopsCode && /^[0-9a-f]{8,16}$/.test(oopsCode.text)) v = big(oopsCode.text);
    if (v != null) { lanes = decodeEsr(v); codeSrc = ovr != null ? 'override' : esrText ? 'ESR line' : 'Internal error line'; }
    if (oopsCode && esrText && ovr == null && big(oopsCode.text) !== big(esrText)) notes.push('The "Internal error" code and the ESR line differ; the ESR line was used.');
  } else if (arch === 'x86_64') {
    let v = ovr != null ? Number(ovr & 0xffffn) : null;
    if (v == null) {
      for (let i = 0; i < L.length && v == null; i++) {
        const m = /#PF: error_code\((0x[0-9a-f]+)\)/d.exec(L[i].body);
        if (m) { v = Number(big(m[1])); markRe(i, m, 1, 'code'); }
      }
    }
    if (v == null && oopsCode && !oopsCode.isGpf && ['null', 'paging', 'oops'].includes(head.kind)) v = Number(big(oopsCode.text));
    if (v != null) { lanes = decodePf(v); codeSrc = ovr != null ? 'override' : 'page fault error code'; }
    if (oopsCode?.isGpf) notes.push('A general protection fault\'s error code is a segment selector (0 for a non-canonical address), not a page fault code.');
  } else if (arch === 'arm') {
    let v = ovr != null ? Number(ovr & 0xffffn) : oopsCode && /^Oops$/.test(oopsCode.label) ? Number(big(oopsCode.text)) : null;
    if (v != null) { lanes = decodeFsr(v); codeSrc = ovr != null ? 'override' : 'Internal error line (FSR)'; }
  } else if (arch === 'riscv') {
    const c = ovr ?? (regs.get('cause')?.value ?? null);
    if (c != null) { lanes = decodeCause(c); codeSrc = ovr != null ? 'override' : 'cause register'; }
  }
  if (lanes) lanes.source = codeSrc;

  // ---- Code: line
  let insn = null, code = null;
  for (let i = 0; i < L.length; i++) {
    const m = /^\s*Code: (.*)$/d.exec(L[i].body);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/);
    const fi = words.findIndex((w) => /^[(<][0-9a-f]+[)>]$/.test(w));
    const bytes = words.every((w) => /^[(<]?[0-9a-f]{2}[)>]?$/.test(w));
    code = { line: i, words: words.map((w) => w.replace(/[()<>]/g, '')), fault: fi, kind: bytes ? 'bytes' : 'words' };
    mark(i, L[i].off + m.indices[0][0], L[i].off + m.indices[0][1], 'insn');
    break;
  }
  if (code && code.fault >= 0 && code.kind === 'words') {
    const w = parseInt(code.words[code.fault], 16);
    const thumb = code.words[code.fault].length === 4;
    if (arch === 'arm64') code.asm = code.words.map((x) => (x.length === 8 ? decodeA64(parseInt(x, 16)).text : '?'));
    if (arch === 'arm') code.asm = code.words.map((x) => decodeA32(parseInt(x, 16), x.length === 4).text);
    let d = arch === 'arm64' ? decodeA64(w) : arch === 'arm' ? decodeA32(w, thumb) : null;
    if (arch === 'riscv' && thumb) {
      // 16-bit parcels: a 32-bit instruction (low bits 11) takes the next parcel as its upper half
      const nx = code.words[code.fault + 1];
      d = (w & 3) === 3 ? (nx && nx.length === 4 ? decodeRV((parseInt(nx, 16) << 16 | w) >>> 0, 32) : null) : decodeRV(w, 16);
    }
    if (d) insn = d;
  }
  if (code && code.fault >= 0 && code.kind === 'bytes' && arch === 'x86_64') {
    const d = decodeX86(code.words.slice(code.fault).map((x) => parseInt(x, 16)));
    if (d) insn = d;
  }
  // effective address check
  const rname = (n) => (arch === 'arm64' ? (n === 31 ? 'sp' : `x${n}`) : insn?.rname ? insn.rname(n) : `r${n}`);
  if (insn && insn.xbase !== undefined) {
    // x86: registers by name; base index kept as a name, rname() maps it back
    insn.rname = (n) => n;
    insn.base = insn.xbase; insn.dst = insn.xdst;
  }
  let eaCheck = null;
  if (insn && insn.base != null) {
    const r = regs.get(rname(insn.base)) || (arch === 'arm' && regs.get(['r11', 'r12', 'r13'][insn.base - 11] || ''));
    if (r) {
      const ix = insn.index ? regs.get(insn.index) : null;
      const ea = BigInt.asUintN(64, r.value + BigInt(insn.off || 0) + (ix ? ix.value * 1n : 0n));
      eaCheck = { reg: r.name, value: r.hex, ea: HEX(ea), matches: faultAddr != null && ea === faultAddr };
    }
  }

  // Where the base register came from: the last earlier instruction in the
  // Code: line that wrote it (arm64 only, straight-line code assumed).
  let origin = null;
  if (arch === 'arm64' && insn && insn.base != null && code && code.fault > 0) {
    for (let k = code.fault - 1; k >= 0; k--) {
      const d = decodeA64(parseInt(code.words[k], 16));
      if (d.dst !== insn.base) continue;
      origin = { text: d.text, back: code.fault - k };
      if (d.base != null && d.dst != null && !d.write) {
        let clobbered = false;
        for (let j = k + 1; j < code.fault; j++) { const e = decodeA64(parseInt(code.words[j], 16)); if (e.dst === d.base) clobbered = true; }
        const br = regs.get(d.base === 31 ? 'sp' : `x${d.base}`);
        if (br && !clobbered && d.base !== d.dst) origin.from = HEX(BigInt.asUintN(64, br.value + BigInt(d.off || 0)));
      }
      break;
    }
  }

  // ---- call trace
  const frames = [];
  let inTrace = false, miss = 0, ctxName = '';
  const FR = new RegExp(String.raw`^\s*(?:\[<([0-9a-f]+)>\]\s*)?(\? )?` + SYM, 'd');
  const FR32 = new RegExp(String.raw`^\s*(?:\[<([0-9a-f]+)>\]\s*\()?` + String.raw`([A-Za-z_.$][\w.$]*)(?:\+(0x[0-9a-f]+)\/(0x[0-9a-f]+))?(?:\s+\[([\w-]+)\])?\)? from (?:\[<([0-9a-f]+)>\]\s*\()?([A-Za-z_.$][\w.$]*)(?:\+(0x[0-9a-f]+)\/(0x[0-9a-f]+))?(?:\s+\[([\w-]+)\])?\)?`, 'd');
  let last32 = null;
  for (let i = 0; i < L.length; i++) {
    const b = L[i].body;
    if (/^\s*(Call [Tt]race|Backtrace|Call trace):?/.test(b)) { inTrace = true; miss = 0; mark(i, L[i].off, L[i].t.length, 'trace'); continue; }
    const cx = /^\s*<(\/?)(IRQ|TASK|NMI|EOI|SOFTIRQ)>/.exec(b);
    if (cx) { ctxName = cx[1] ? '' : cx[2]; if (inTrace && !cx[1]) frames.push({ sep: cx[2], line: i }); continue; }
    let m;
    if ((m = FR32.exec(b))) {
      const f = { fn: m[2], off: m[3] || '', size: m[4] || '', mod: m[5] || '', addr: m[1] || '', reliable: true, line: i, ctx: ctxName };
      mark(i, L[i].off + m.indices[2][0], L[i].off + (m.indices[5] || m.indices[4] || m.indices[2])[1], `frame:${frames.length}`);
      frames.push(f);
      last32 = { fn: m[7], off: m[8] || '', size: m[9] || '', mod: m[10] || '', addr: m[6] || '', reliable: true, line: i, ctx: ctxName, a: m.indices[7][0], b: (m.indices[10] || m.indices[9] || m.indices[7])[1] };
      inTrace = true; miss = 0;
      continue;
    }
    if ((inTrace || /^\s*\[<[0-9a-f]+>\]/.test(b)) && (m = FR.exec(b))) {
      if (!inTrace && regs.size === 0 && !/^\s*\[</.test(b)) continue;
      frames.push({ fn: m[3], off: m[4], size: m[5], mod: m[6] || '', addr: m[1] || '', reliable: !m[2], line: i, ctx: ctxName });
      mark(i, L[i].off + m.indices[3][0], L[i].off + m.indices[0][1], `frame:${frames.length - 1}`);
      inTrace = true; miss = 0;
      continue;
    }
    if (inTrace) {
      if (last32) { const idx = frames.length; frames.push({ ...last32 }); mark(last32.line, L[last32.line].off + last32.a, L[last32.line].off + last32.b, `frame:${idx}`); last32 = null; }
      if (/^\s*(Code:|---\[|Kernel panic|Modules linked|Mem abort|Instruction dump|Kernel Offset|RIP:|CPU:)/.test(b) || ++miss >= 3) inTrace = false;
    }
  }
  if (last32) { const idx = frames.length; frames.push({ ...last32 }); mark(last32.line, L[last32.line].off + last32.a, L[last32.line].off + last32.b, `frame:${idx}`); }

  // The stack drawn: the faulting function on top (from pc / RIP / epc when the
  // trace does not start there, as x86 traces do not), then the callers.
  const real = frames.filter((f) => !f.sep);
  const stack = [];
  if (pc && !(real[0] && real[0].fn === pc.fn)) stack.push({ ...pc, reliable: true, from: 'pc', idx: -1 });
  frames.forEach((f, i) => stack.push({ ...f, idx: i }));
  let seenFault = false;
  for (const f of stack) {
    if (f.sep) continue;
    f.faultPath = FAULT_PATH.test(f.fn);
    if (pc && f.fn === pc.fn && (f.off === pc.off || !f.off)) {
      if (!f.off) { f.off = pc.off; f.size = pc.size; f.mod = f.mod || pc.mod; }
      if (!seenFault) { f.isPc = true; seenFault = true; } else f.dupPc = true;
    }
    if (lr && f.fn === lr.fn && !f.off && !f.isPc) { f.off = lr.off; f.size = lr.size; }
    if (lr && f.fn === lr.fn && f.off === lr.off) f.isLr = true;
    f.offN = f.off ? parseInt(f.off, 16) : null; f.sizeN = f.size ? parseInt(f.size, 16) : null;
  }
  // the function the report is about: pc, else the first reliable frame outside the fault/report path
  const top = stack.find((f) => !f.sep && f.isPc) || stack.find((f) => !f.sep && f.reliable && !f.faultPath) || null;
  if (top) top.isTop = true;
  if (head.kind === 'warning' && head.m && head.m[2]) {
    const s = /([\w.$]+)\+(0x[0-9a-f]+)\/(0x[0-9a-f]+)(?:\s+\[([\w-]+)\])?/.exec(L[head.line].body.slice(head.m.index));
    if (s && !top) stack.unshift({ fn: s[1], off: s[2], size: s[3], mod: s[4] || '', reliable: true, isTop: true, idx: -1, line: head.line });
  }
  const topF = stack.find((f) => f.isTop) || null;

  // ---- register findings
  const regList = [...regs.values()];
  const findings = new Map();
  const add = (n, tag, note) => { const f = findings.get(n) || { tags: [], notes: [] }; if (!f.tags.includes(tag)) f.tags.push(tag); if (note) f.notes.push(note); findings.set(n, f); };
  const zeroGprs = regList.filter((r) => r.value === 0n && !NOT_GPR.test(r.name) && r.name !== 'zero').length;
  for (const r of regList) {
    const v = r.value;
    if (v == null) continue;
    const gpr = !NOT_GPR.test(r.name);
    if (faultAddr != null && gpr) {
      if (v === faultAddr) add(r.name, 'fault', 'equals the fault address');
      else if (faultAddr > v && faultAddr - v <= 0x1000n && (v === 0n ? (insn && insn.base != null ? rname(insn.base) === r.name : zeroGprs === 1) : v >= 0x10000n)) add(r.name, 'base', `fault address = ${r.name} + ${HEX(faultAddr - v)}${v === 0n ? ': a member of a NULL struct pointer' : ''}`);
      else if (v > faultAddr && v - faultAddr <= 0x1000n && v >= 0x10000n) add(r.name, 'near', `${HEX(v - faultAddr)} above the fault address`);
    }
    if (gpr && v === 0n) add(r.name, 'null', 'NULL');
    if (r.name === 'zero') findings.delete(r.name);
    const h = pad(v, 16);
    if (/^(6b){4,}/.test(h.replace(/^0+/, '')) || /6b6b6b6b6b6b6b6b|a5a5a5a5a5a5a5a5|5a5a5a5a5a5a5a5a/.test(h)) add(r.name, 'poison', 'slab poison: memory used after kfree() (6b) or never initialised (5a)');
    if (/^dead0000000001(00|22)$/.test(h) || /^dead000000000(100|122)$/.test(h)) add(r.name, 'poison', 'list poison (LIST_POISON1/2): a list entry used after list_del()');
  }
  if (eaCheck) add(eaCheck.reg, 'insn', `base register of the faulting instruction (${insn.text})`);
  if (insn && insn.dst != null && !insn.write) add(rname(insn.dst), 'dst', `destination of ${insn.text}`);
  const regOut = regList.map((r) => ({ name: r.name, hex: r.hex, line: r.line, seg: r.seg, ...(findings.get(r.name) || { tags: [], notes: [] }) }));

  // ---- the cause sentence
  const kindInfo = KIND[head.kind];
  const where = topF ? `${topF.fn}${topF.off ? '+' + topF.off : ''}${topF.mod ? ` [${topF.mod}]` : ''}` : '';
  const fa = faultAddr != null ? HEX(faultAddr) : '';
  let cause = '';
  const access = lanes?.access || (insn ? (insn.write ? 'write' : 'read') : '');
  if (['null', 'paging', 'oops', 'gpf'].includes(head.kind) || (head.kind === 'unknown' && fa)) {
    cause = `${access ? access[0].toUpperCase() + access.slice(1) : 'Access'}${insn?.size && access !== 'instruction fetch' ? ` of ${insn.size} byte${insn.size > 1 ? 's' : ''}` : ''}${fa ? ` at ${fa}` : ''}${where ? ` in ${where}` : ''}.`;
    if (insn && insn.base != null) cause += ` The instruction is ${insn.text}${eaCheck ? `; ${eaCheck.reg} = 0x${eaCheck.value.replace(/^0+(?=.)/, '')}, so it touched ${eaCheck.ea}${eaCheck.matches ? ', the fault address' : ''}` : ''}.`;
    const base = regOut.find((r) => r.tags.includes('insn') && r.tags.includes('null')) || regOut.find((r) => r.tags.includes('base') && r.tags.includes('null'));
    const zeros = regOut.filter((r) => r.tags.includes('null')).map((r) => r.name);
    if (!base && faultAddr != null && faultAddr < 0x1000n && zeros.length > 1 && !insn) cause += ` ${zeros.length} registers hold NULL (${zeros.slice(0, 6).join(', ')}${zeros.length > 6 ? ', …' : ''}); one of them is the struct pointer, at offset +${HEX(faultAddr)}. The Code: line or faddr2line tells which.`;
    if (base && faultAddr != null) cause += ` ${base.name} is NULL: the code ${access === 'write' ? 'wrote' : 'read'} member +${HEX(faultAddr)} of a struct through a NULL pointer.`;
    if (origin) cause += ` ${eaCheck ? eaCheck.reg : 'The base register'} was loaded ${origin.back} instruction${origin.back > 1 ? 's' : ''} earlier by ${origin.text}${origin.from ? `, from ${origin.from}: the pointer stored there is the bad one` : ''}.`;
    if (head.kind === 'gpf' && head.m && head.m[1]) cause += ' The address is non-canonical (bits 63:47 not all equal): a corrupt or poisoned pointer, not NULL.';
  } else if (head.kind === 'bug') cause = `BUG() hit at ${head.m?.[1] || 'an assertion'}${where ? ` in ${where}` : ''}: a condition the code asserts can never happen did.`;
  else if (head.kind === 'warning') cause = `WARN() at ${head.m?.[1] || '?'} in ${head.m?.[2] || where}: the kernel flagged an unexpected state and carried on (taint W).`;
  else if (head.kind === 'softlockup') cause = `CPU ${head.m[1]} ran kernel code for ${head.m[2]} s without scheduling (task ${head.m[3]})${where ? `, last in ${where}` : ''}.`;
  else if (head.kind === 'hardlockup') cause = `CPU ${head.m[1]} stopped taking interrupts (interrupts disabled too long)${where ? `, in ${where}` : ''}.`;
  else if (head.kind === 'hung') cause = `Task ${head.m[1]} (PID ${head.m[2]}) was in D state (uninterruptible) for more than ${head.m[3]} s${where ? `, waiting in ${where}` : ''}.`;
  else if (head.kind === 'rcu') cause = `An RCU grace period (${head.m[1]}) did not complete: a CPU is looping with preemption or interrupts off${where ? `, in ${where}` : ''}.`;
  else if (head.kind === 'stackprot') cause = `The stack canary of ${head.m[1]} was overwritten before it returned: a local buffer overflowed.`;
  else if (head.kind === 'kasan') cause = `KASAN found a ${head.m[1]} in ${head.m[2]}.`;
  else if (head.kind === 'atomic') cause = `Code that may sleep ran with preemption or interrupts disabled or a spinlock held${where ? `, in ${where}` : ''}.`;
  else if (head.kind === 'undef') cause = `The CPU hit an undefined instruction${where ? ` in ${where}` : ''}: corrupted code, a BUG() on a kernel that uses UDF, or a CPU feature not present.`;
  else if (head.kind === 'panic') cause = `Panic: ${panic?.reason}.`;
  else cause = 'No oops, BUG, WARNING, lockup or panic line was found.';
  if (lanes?.summary && !['warning', 'hung', 'rcu', 'kasan'].includes(head.kind)) cause += ` ${lanes.reg}: ${lanes.summary}.`;

  // ---- address hints
  if (faultAddr != null) {
    const h = pad(faultAddr, 16);
    if (faultAddr === 0x10n) notes.push('0x10 is also ZERO_SIZE_PTR: the pointer may come from kmalloc(0) rather than being NULL + 0x10.');
    if (/^dead0000000001(00|22|08|2a)/.test(h) || /^dead00000000(0100|0122)$/.test(h)) warnings.push('The fault address is list poison (LIST_POISON1/2 + POISON_POINTER_DELTA): a list entry was used after list_del(). Find who still walks or deletes that entry.');
    if (/6b6b6b6b/.test(h)) warnings.push('The fault address is slab poison 0x6b: a pointer read from memory that was already kfree()d. Build with KASAN or slub_debug=FZPU to catch the first bad access.');
    if (faultAddr >= 0x1000n && faultAddr < 0x10000n && head.kind !== 'null') notes.push('A small address (below 64 KiB): most likely a NULL pointer plus a large struct offset or an array index.');
  }

  // ---- next steps per kind
  const next = {
    null: 'Find where the pointer should have been set: probe order (the resource not yet created, -EPROBE_DEFER ignored), a devm_ allocation checked with the wrong macro, or a callback running after remove().',
    paging: 'The pointer is garbage, freed or out of range. Check lifetimes (use-after-free), array indices, and ioremap/regmap mappings; KASAN finds the first bad access.',
    gpf: 'The pointer is corrupt (poison or random bits). Enable KASAN / slub_debug; check use-after-free and list handling around the faulting function.',
    bug: 'Open the file and line in the BUG message: the condition beside BUG_ON() says what state was wrong.',
    warning: 'Open the file and line: the WARN_ON() condition says what was unexpected. Later oopses on the same boot are tainted W and may be consequences.',
    softlockup: 'Look for a loop without cond_resched() or a busy-wait (poll on a register) in the top frames; the stuck CPU\'s trace is the evidence.',
    hardlockup: 'Look for spinlocks taken with irqsave that are never released, or a long loop with interrupts off.',
    hung: 'The task sleeps on a lock, completion or I/O that never finished. sysrq w (echo w > /proc/sysrq-trigger) shows every blocked task; look for who holds the lock (CONFIG_PROVE_LOCKING / lockdep).',
    rcu: 'The stall report names the CPU and task; a loop in the kernel without a scheduling point or a long irq-off region is the usual cause.',
    stackprot: 'Look at the local arrays of that function: a memcpy/sprintf/strcpy that writes more than they hold.',
    kasan: 'The KASAN report below the headline shows the allocation and free stacks: read those as well as the access stack.',
    atomic: 'Something called a sleeping function (mutex_lock, kmalloc(GFP_KERNEL), msleep, i2c/regmap on a sleeping bus) under a spinlock or in an interrupt handler.',
  }[head.kind];
  if (next) notes.unshift(next);

  // ---- warnings on missing pieces
  if (head.kind === 'unknown') warnings.push('No oops headline found. Paste from the "Unable to handle", "BUG:", "WARNING:", "Oops" or "Kernel panic" line through "end trace".');
  if (!real.length && head.kind !== 'unknown') warnings.push('No call trace found. Include the lines after "Call trace:" / "Call Trace:" (with the dmesg timestamps is fine).');
  if (['null', 'paging'].includes(head.kind) && faultAddr == null) warnings.push('The fault address could not be read from the headline.');
  if (!regs.size && ['null', 'paging', 'oops', 'gpf', 'bug'].includes(head.kind)) warnings.push('No registers found. Include the register dump (x0..x29 / RAX.. / r0..r12) so the NULL register can be pointed out.');
  if (eaCheck && faultAddr != null && !eaCheck.matches) warnings.push(`The decoded instruction touches ${eaCheck.ea}, not the fault address ${fa}: the register was overwritten before the dump, or the Code: line is from a different instruction.`);
  if (oopsNo && oopsNo > 1) warnings.push(`This is oops #${oopsNo}: an earlier oops on the same boot may be the real cause. Look for [#1].`);
  if (taintSet.has('D') && head.kind !== 'unknown') notes.push('Taint D: the kernel had already died once before this report; decode the first one.');
  const unrel = real.filter((f) => !f.reliable).length;
  if (unrel) notes.push(`${unrel} frame${unrel > 1 ? 's' : ''} marked "?" are leftovers found on the stack, not proven callers (x86 unwinder); read the others first.`);

  // ---- commands
  const cross = String(input.cross ?? 'auto').trim();
  const cc = cross === 'auto' || cross === '' ? ({ arm64: 'aarch64-linux-gnu-', arm: 'arm-linux-gnueabihf-', riscv: 'riscv64-linux-gnu-' }[arch] || '') : cross === 'none' ? '' : cross;
  const vmlinux = String(input.vmlinux || 'vmlinux').trim();
  const moddir = String(input.moddir || '').trim();
  const env = cc ? `CROSS_COMPILE=${cc} ` : '';
  const karch = { arm64: 'arm64', arm: 'arm', riscv: 'riscv', x86_64: 'x86' }[arch] || '';
  const objFor = (f) => (f.mod ? `${moddir ? moddir.replace(/\/$/, '') + '/' : ''}${f.mod}.ko` : vmlinux);
  const cmd = [
    '# Run in the kernel source tree of the same build (Yocto: bitbake -e virtual/kernel | grep ^B= gives the build dir; vmlinux is there).',
    '# Needs CONFIG_DEBUG_INFO=y for file:line.',
    '',
    '# 1. The whole report with file:line on every frame (save the oops to oops.txt):',
    `${env}./scripts/decode_stacktrace.sh ${vmlinux}${moddir ? ` auto ${moddir}` : ''} < oops.txt`,
  ];
  const tf = topF && topF.off ? topF : null;
  if (tf) {
    cmd.push('', `# 2. The faulting line, with source around it:`, `${env}./scripts/faddr2line --list ${objFor(tf)} ${tf.fn}+${tf.off}${tf.size ? '/' + tf.size : ''}`);
    cmd.push('', '# 3. The same in gdb, and the function disassembled with source:', `${cc ? 'gdb-multiarch' : 'gdb'} -batch -ex 'list *(${tf.fn}+${tf.off})' ${objFor(tf)}`);
    cmd.push(`${cc}objdump -dS --disassemble=${tf.fn} ${objFor(tf)} | less`);
  }
  if (code) cmd.push('', '# 4. The Code: line disassembled (the faulting instruction is marked):', `${karch ? `ARCH=${karch} ` : ''}${env}./scripts/decodecode < oops.txt`);
  const callers = stack.filter((f) => !f.sep && f.reliable && !f.isTop && !f.faultPath && f.off).slice(0, 4);
  if (callers.length) {
    cmd.push('', '# 5. The callers:');
    const byObj = new Map();
    for (const f of callers) { const o = objFor(f); byObj.set(o, [...(byObj.get(o) || []), `${f.fn}+${f.off}${f.size ? '/' + f.size : ''}`]); }
    for (const [o, fs] of byObj) cmd.push(`${env}./scripts/faddr2line ${o} ${fs.join(' ')}`);
  }

  // ---- summary text
  const sum = [
    `${kindInfo[0]}${where ? ` in ${where}` : ''}`,
    cause,
    who ? `CPU ${who.cpu}, PID ${who.pid} (${who.comm}), kernel ${who.version}${hw ? `, ${hw.name}` : ''}` : '',
    taintRows.length ? `Tainted: ${taintRows.map((r) => `${r[0]} (${r[2]})`).join(', ')}` : who ? 'Not tainted' : '',
    real.length ? `Call trace: ${stack.filter((f) => !f.sep && f.reliable && !f.faultPath).slice(0, 8).map((f) => f.fn + (f.mod ? ` [${f.mod}]` : '')).join(' <- ')}` : '',
    ...(next ? [`Next: ${next}`] : []),
  ].filter(Boolean).join('\n');

  // ---- result
  const values = [
    { label: 'Kind', value: kindInfo[0], tone: kindInfo[1] },
    { label: 'Faulting function', value: where || '–', tone: where ? 'bad' : undefined },
    { label: 'Fault address', value: fa || '–' },
    { label: 'Access', value: access || '–' },
    { label: 'Architecture', value: arch },
    { label: 'CPU / PID / Comm', value: who ? `${who.cpu} / ${who.pid} / ${who.comm}` : '–' },
    { label: 'Kernel', value: who ? who.version : '–' },
    { label: 'Tainted', value: taintRows.length ? taintRows.map((r) => r[0]).join('') : who ? 'not tainted' : '–', hint: taintRows.length ? `mask 0x${taintMask.toString(16)}` : undefined, tone: taintRows.length ? 'warn' : undefined },
  ];
  if (lanes) values.push({ label: lanes.reg, value: lanes.value, hint: lanes.summary });
  if (insn) values.push({ label: 'Faulting instruction', value: insn.text });
  if (panic) values.push({ label: 'Panic', value: panic.reason, tone: 'bad' });
  for (const v of values) if (v.tone === undefined) delete v.tone;
  for (const v of values) if (v.hint === undefined) delete v.hint;

  const tables = [];
  if (stack.length) tables.push({ title: 'Call stack (faulting frame first)', columns: ['#', 'Function', 'Offset / size', 'Module', 'Note'],
    rows: stack.filter((f) => !f.sep).map((f, i) => [i, f.fn, f.off ? `${f.off}/${f.size}` : '', f.mod, [f.isPc ? 'pc' : '', f.isLr ? 'lr' : '', f.from === 'pc' ? 'from pc (not in trace)' : '', f.reliable ? '' : 'unreliable (?)', f.faultPath ? 'fault/report path' : '', f.dupPc ? 'same as pc' : '', f.ctx && f.ctx !== 'TASK' ? f.ctx : ''].filter(Boolean).join(', ')]) });
  const noted = regOut.filter((r) => r.tags.some((t) => t !== 'null' && t !== 'dst'));
  if (noted.length) tables.push({ title: 'Registers that matter', columns: ['Register', 'Value', 'Finding'], rows: noted.map((r) => [r.name, '0x' + r.hex, r.notes.join('; ')]) });
  if (lanes) tables.push({ title: `${lanes.reg} ${lanes.value} (${lanes.source})`, columns: ['Field', 'Bits', 'Value', 'Meaning'],
    rows: lanes.fields.filter((f) => !/^RES/.test(f.name)).map((f) => [f.name, f.hi === f.lo ? String(f.hi) : `${f.hi}:${f.lo}`, '0x' + f.value.toString(16), f.meaning]) });
  if (taintRows.length) tables.push({ title: `Taint flags (mask 0x${taintMask.toString(16)})`, columns: ['Letter', 'Bit', 'Name', 'Meaning'], rows: taintRows });

  const texts = [{ title: 'Commands', body: cmd.join('\n') + '\n', lang: 'sh' }, { title: 'Summary', body: sum + '\n' }];
  if (code?.asm) texts.push({ title: 'Code', body: code.words.map((w, i) => `${i === code.fault ? '=> ' : '   '}${w}  ${code.asm[i]}`).join('\n') + '\n' });

  const draw = {
    arch, kind: head.kind, kindLabel: kindInfo[0], tone: kindInfo[1], headline: head.text, headLine: head.line, cause, where, faultAddr: fa,
    who, hw: hw?.name || '', modules: modules?.list || [], workqueue, panic, oopsNo,
    lines: L.map((l) => ({ t: l.t, off: l.off, spans: l.spans.sort((a, b) => a.a - b.a) })),
    stack: stack.map((f) => (f.sep ? { sep: f.sep, line: f.line } : { fn: f.fn, off: f.off, size: f.size, offN: f.offN, sizeN: f.sizeN, mod: f.mod, reliable: f.reliable, line: f.line, idx: f.idx, isPc: !!f.isPc, isLr: !!f.isLr, isTop: !!f.isTop, faultPath: f.faultPath, dupPc: !!f.dupPc, from: f.from || '', ctx: f.ctx || '' })),
    regs: regOut, lanes, insn: insn ? { text: insn.text, base: insn.base != null ? rname(insn.base) : '', dst: insn.dst != null ? rname(insn.dst) : '', size: insn.size || 0, write: !!insn.write } : null,
    eaCheck, origin, code: code ? { line: code.line, words: code.words, fault: code.fault, asm: code.asm || null, kind: code.kind } : null,
    taint: TAINTS.map(([bit, letter, meaning, name]) => ({ bit, letter, meaning, name, set: taintSet.has(letter) })), taintMask, taintLine: taint?.line ?? -1,
    codeOverride: ovr != null,
  };
  return { values, tables, texts, warnings, notes, draw };
}
